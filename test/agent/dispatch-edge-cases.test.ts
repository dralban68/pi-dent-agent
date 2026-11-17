import { test, after } from "node:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  DispatchEngine,
  classifyAttempt,
  type BootSnapshot,
  type ToolResult,
} from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { AgentDefinition } from "../../lib/catalogs.ts";
import type { BillingService } from "../../lib/billing.ts";
import type { HostSession } from "../../lib/host.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import { AgentTaskRow } from "../../lib/task-row.ts";
import { writeRunningRecord, rewriteSettledRecord } from "../../lib/task-record.ts";
import { rebuildInterruptedTasks } from "../../lib/task-rebuild.ts";
import { collectTaskTree, renderTaskTree } from "../../lib/task-widget.ts";
import { must } from "../support/must.ts";

/**
 * Reviewed defects of the dispatch engine (specs/agent-tool.md Sections 8, 9
 * and 11): cancellation requested during startup, a `resume` of a running
 * dispatch, consumption order of a resumed row by task ID and by path,
 * transient-error classification, and settlement after adoption.
 *
 * Real child sessions run on a scripted faux provider.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// An isolated pi agent dir whose auth holds a key for the faux provider.
const home = mkdtempSync(join(tmpdir(), "pi-dent-edge-cases-"));
roots.push(home);
const agentDir = join(home, "pi-agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const faux = registerFauxProvider({ models: [{ id: "m" }], tokensPerSecond: 60 });
after(() => faux.unregister());
const realCreate = ModelRuntime.create.bind(ModelRuntime);
ModelRuntime.create = async (options) => {
  const runtime = await realCreate(options);
  runtime.registerProvider(faux.models[0].provider, {
    apiKey: "k",
    baseUrl: "http://faux.invalid",
    api: faux.api as never,
    streamSimple: must(getApiProvider(faux.api as never)).streamSimple as never,
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
  });
  return runtime;
};

const model = faux.getModel();
const modelLabel = `${model.provider}/${model.id}`;

function bootWith(agents: AgentDefinition[] = []): BootSnapshot {
  return {
    cwd: "/tmp",
    config: {
      merged: {},
      layers: {},
      projectRoot: "/tmp",
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    },
    agents,
    agentIndex: new Map(agents.map((agent) => [agent.name, agent])),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: 0,
    sessionTtlDays: 30,
  } as unknown as BootSnapshot;
}

/** A fresh temp root holding a main session at `<root>/main/main.jsonl`. */
function newRoot(): { root: string; sessionFile: string; agentsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-edge-case-"));
  roots.push(root);
  const dir = join(root, "main");
  mkdirSync(dir, { recursive: true });
  return { root, sessionFile: join(dir, "main.jsonl"), agentsDir: join(dir, "main.agents") };
}

function makeHost(sessionFile: string, sessionId: string, root: string): HostSession {
  return {
    cwd: () => root,
    sessionId: () => sessionId,
    sessionFile: () => sessionFile,
    sessionDir: () => root,
    model: () => ({ provider: model.provider, id: model.id }),
    thinking: () => undefined,
    activeTools: () => ["Agent", "Bash"],
    inventory: () => [model as never],
    configuredModels: () => [model as never],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
}

/** A child that answers "done" on every turn. */
function answerDone(): void {
  faux.setResponses(Array.from({ length: 6 }, () => () => fauxAssistantMessage("done")));
}

/** A billing service whose cached query fails; the dispatch reports the failure. */
function failingBilling(): BillingService {
  return {
    cachedQueryWait: () => Promise.reject(new Error("billing unavailable")),
    view: () => undefined,
  } as unknown as BillingService;
}

function textOf(result: ToolResult): string {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
}

interface AttemptLike {
  status?: string | undefined;
  sessionPath?: string | undefined;
  failureCode?: string | undefined;
  usage?: { turns?: number | undefined } | undefined;
}
interface DetailsLike {
  taskId?: string | undefined;
  sessionPath?: string | undefined;
  results?: AttemptLike[] | undefined;
}
const detailsOf = (result: ToolResult) => result.details as DetailsLike;

/** Poll `probe` every few milliseconds until it returns a value. */
async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

/** The `pi-dent-tasks` widget content of the engine's registry (task.md Section 4). */
function widgetLines(engine: DispatchEngine): string[] {
  return renderTaskTree(collectTaskTree(engine.registry), Date.now(), 200) ?? [];
}

/**
 * A task that died while running: its `running` record is rebuilt into an
 * `interrupted` row of the engine's registry (task-record.md Section 3).
 */
function rebuiltInterrupted(
  engine: DispatchEngine,
  agentsDir: string,
  sessionPath: string,
  taskId: string,
): { row: AgentTaskRow; recordPath: string } {
  const recordPath = writeRunningRecord(agentsDir, {
    taskId,
    agent: "dynamic",
    label: "dynamic — old",
    model: modelLabel,
    cohort: "cohort-1",
    startedAt: 1,
    sessionPath,
  });
  assert.equal(rebuildInterruptedTasks(engine.registry, agentsDir), 1);
  const row = must(engine.registry.get(taskId)) as AgentTaskRow;
  assert.equal(row.status, "interrupted");
  assert.equal(row.consumed, false);
  return { row, recordPath };
}

// --- Section 11: cancellation -------------------------------------------------

test("a signal aborted before dispatch settles the task cancelled without prompting", async () => {
  answerDone();
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const controller = new AbortController();
  controller.abort();
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: makeHost(sessionFile, "main-id", root),
    cohortId: "cohort-1",
    signal: controller.signal,
  });
  assert.equal(result.isError, true);
  const record = detailsOf(result).results?.[0];
  assert.equal(record?.status, "cancelled");
  assert.equal(record?.usage?.turns, 0, "the attempt is never prompted");
  const row = must(engine.registry.list()[0]) as AgentTaskRow;
  assert.equal(row.status, "cancelled", "the row settles cancelled");
});

test("a cancel() during startup settles the task cancelled instead of being forgotten", async () => {
  answerDone();
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const pending = engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: makeHost(sessionFile, "main-id", root),
    cohortId: "cohort-1",
  });
  // dispatch() runs synchronously to the startup awaits, so the row exists and
  // its cancellation handler is armed before the first await resolves.
  const row = must(engine.registry.list()[0]) as AgentTaskRow;
  assert.equal(row.status, "running");
  engine.registry.cancel(row);
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(detailsOf(result).results?.[0]?.status, "cancelled");
  assert.equal(row.status, "cancelled", "the row settles cancelled");
});

// --- Section 9: resume --------------------------------------------------------

test("resume: a running dispatch's session file rejects a concurrent resume", async () => {
  // The first run keeps its child in a shell turn; the resume must not open a
  // second session on the same file.
  faux.setResponses([
    () =>
      fauxAssistantMessage([fauxToolCall("Bash", { command: "sleep 0.6" })], {
        stopReason: "toolUse",
      }),
    ...Array.from({ length: 6 }, () => () => fauxAssistantMessage("done")),
  ]);
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(sessionFile, "main-id", root);
  const first = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", background: true },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined, textOf(first));
  const taskId = must(detailsOf(first).taskId);
  const sessionPath = must(detailsOf(first).sessionPath);
  const row = must(engine.registry.get(taskId)) as AgentTaskRow;
  await waitFor(() => (row.sessionPath === undefined ? undefined : true), "the running row");
  assert.equal(row.status, "running");
  const inFlight = `Agent error: session already has an in-flight dispatch: ${resolve(sessionPath)}`;

  const byId = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: taskId },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(byId.isError, true, "a running dispatch is not a resume source");
  assert.equal(textOf(byId), inFlight);
  assert.equal(detailsOf(byId).results?.[0]?.failureCode, "invalid-plan");

  const byPath = await engine.dispatch({
    toolCallId: "call-3",
    params: { prompt: "P3", task: "again", resume: sessionPath },
    host,
    cohortId: "cohort-3",
  });
  assert.equal(byPath.isError, true, "neither is its session file");
  assert.equal(textOf(byPath), inFlight);

  const settled = await waitFor(() => {
    const found = engine.registry.get(taskId);
    return found !== undefined && found.status !== "running" ? found : undefined;
  }, "settlement of the first run");
  assert.equal(settled.status, "completed");
  await new Promise((done) => setTimeout(done, 20));

  const later = await engine.dispatch({
    toolCallId: "call-4",
    params: { prompt: "P4", task: "again", resume: sessionPath },
    host,
    cohortId: "cohort-4",
  });
  assert.equal(later.isError, undefined, "a settled session file resumes again");
  assert.equal(detailsOf(later).results?.[0]?.sessionPath, sessionPath);
});

test("resume: a symbolic link to an in-flight session file does not hide it", async () => {
  faux.setResponses([
    () =>
      fauxAssistantMessage([fauxToolCall("Bash", { command: "sleep 0.6" })], {
        stopReason: "toolUse",
      }),
    ...Array.from({ length: 6 }, () => () => fauxAssistantMessage("done")),
  ]);
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(sessionFile, "main-id", root);
  const first = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", background: true },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined, textOf(first));
  const taskId = must(detailsOf(first).taskId);
  const sessionPath = must(detailsOf(first).sessionPath);
  const row = must(engine.registry.get(taskId)) as AgentTaskRow;
  await waitFor(() => (row.sessionPath === undefined ? undefined : true), "the running row");

  const link = join(root, "linked.jsonl");
  symlinkSync(sessionPath, link);
  const byLink = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: link },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(byLink.isError, true, "the link names the held file");
  assert.equal(
    textOf(byLink),
    `Agent error: session already has an in-flight dispatch: ${resolve(link)}`,
  );
  assert.equal(detailsOf(byLink).results?.[0]?.failureCode, "invalid-plan");

  await waitFor(() => {
    const found = engine.registry.get(taskId);
    return found !== undefined && found.status !== "running" ? found : undefined;
  }, "settlement of the first run");
});

test("resume: a missing source names PI_DENT_SESSION_TTL_DAYS and its effective value", async () => {
  answerDone();
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    { ...bootWith(), sessionTtlDays: 7 },
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const missing = join(root, "gone.jsonl");
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", resume: missing },
    host: makeHost(sessionFile, "main-id", root),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, true);
  assert.equal(
    textOf(result),
    `Agent error: resume source not found: ${missing}. The retention sweep may have deleted it (PI_DENT_SESSION_TTL_DAYS=7).`,
  );
  assert.equal(detailsOf(result).results?.[0]?.failureCode, "invalid-plan");
});

test("resume: a directory is not an existing session file and does not name the sweep", async () => {
  answerDone();
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const directory = join(root, "a-directory");
  mkdirSync(directory, { recursive: true });
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", resume: directory },
    host: makeHost(sessionFile, "main-id", root),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), new RegExp(`not a regular file: ${directory}$`));
  assert.doesNotMatch(textOf(result), /PI_DENT_SESSION_TTL_DAYS/);
  assert.equal(detailsOf(result).results?.[0]?.failureCode, "invalid-plan");
});

test("resume by task ID: a rejected dispatch leaves the row and its record in place", async () => {
  answerDone();
  const { root, sessionFile, agentsDir } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(sessionFile, "main-id", root);
  const first = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined, textOf(first));
  const sessionPath = must(detailsOf(first).results?.[0]?.sessionPath);
  // A process died while this background task was running: its record still says "running".
  const recordPath = writeRunningRecord(agentsDir, {
    taskId: "cafe0003",
    agent: "dynamic",
    label: "dynamic — old",
    model: modelLabel,
    cohort: "cohort-1",
    startedAt: 1,
    sessionPath,
  });
  assert.equal(rebuildInterruptedTasks(engine.registry, agentsDir), 1);
  const rebuilt = must(engine.registry.get("cafe0003")) as AgentTaskRow;
  assert.equal(rebuilt.status, "interrupted");

  const rejected = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: "cafe0003", cwd: join(root, "missing") },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(rejected.isError, true);
  assert.equal(detailsOf(rejected).results?.[0]?.failureCode, "invalid-plan");
  assert.equal(rebuilt.consumed, false, "a pre-start rejection consumes no other row");
  assert.equal(existsSync(recordPath), true, "the record survives the rejected resume");

  const retried = await engine.dispatch({
    toolCallId: "call-3",
    params: { prompt: "P2", task: "again", resume: "cafe0003" },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(retried.isError, undefined, "the same task ID resumes in a later attempt");
  assert.equal(detailsOf(retried).results?.[0]?.sessionPath, sessionPath);
  assert.equal(rebuilt.consumed, true);
  assert.equal(existsSync(recordPath), false);
});

test("resume by path consumes an interrupted row, which leaves the task tree widget", async () => {
  answerDone();
  const { root, sessionFile, agentsDir } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(sessionFile, "main-id", root);
  const first = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined, textOf(first));
  const sessionPath = must(detailsOf(first).results?.[0]?.sessionPath);
  const { row, recordPath } = rebuiltInterrupted(engine, agentsDir, sessionPath, "cafe0010");
  assert.equal(widgetLines(engine).length, 1, "the interrupted row is widget content");
  assert.match(must(widgetLines(engine)[0]), /^cafe0010 · agent · bg · interrupted · /);

  const resumed = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: sessionPath },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(resumed.isError, undefined, textOf(resumed));
  assert.equal(detailsOf(resumed).results?.[0]?.sessionPath, sessionPath);
  assert.equal(row.consumed, true, "the settled row naming that file is consumed");
  assert.equal(existsSync(recordPath), false, "its task record is deleted");
  assert.deepEqual(widgetLines(engine), [], "the widget no longer shows the interrupted task");
});

test("resume by task ID consumes an interrupted row as before", async () => {
  answerDone();
  const { root, sessionFile, agentsDir } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(sessionFile, "main-id", root);
  const first = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined, textOf(first));
  const sessionPath = must(detailsOf(first).results?.[0]?.sessionPath);
  const { row, recordPath } = rebuiltInterrupted(engine, agentsDir, sessionPath, "cafe0011");

  const resumed = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: "cafe0011" },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(resumed.isError, undefined, textOf(resumed));
  assert.equal(detailsOf(resumed).results?.[0]?.sessionPath, sessionPath);
  assert.equal(row.consumed, true);
  assert.equal(existsSync(recordPath), false);
  assert.deepEqual(widgetLines(engine), []);
});

test("resume by path consumes a completed row that a rebuild left unconsumed", async () => {
  answerDone();
  const { root, sessionFile, agentsDir } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(sessionFile, "main-id", root);
  const first = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined, textOf(first));
  const sessionPath = must(detailsOf(first).results?.[0]?.sessionPath);
  const recordPath = writeRunningRecord(agentsDir, {
    taskId: "cafe0012",
    agent: "dynamic",
    label: "dynamic — old",
    cohort: "cohort-1",
    startedAt: 1,
    sessionPath,
  });
  rewriteSettledRecord(recordPath, { status: "completed", settledAt: 2 });
  assert.equal(rebuildInterruptedTasks(engine.registry, agentsDir), 1);
  const row = must(engine.registry.get("cafe0012")) as AgentTaskRow;
  assert.equal(row.status, "completed");
  assert.equal(row.consumed, false);

  const resumed = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: sessionPath },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(resumed.isError, undefined, textOf(resumed));
  assert.equal(row.consumed, true, "a settled unconsumed row is consumed by the path form");
  assert.equal(existsSync(recordPath), false);
});

test("resume by path of a file no row names consumes no row", async () => {
  answerDone();
  const { root, sessionFile, agentsDir } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(sessionFile, "main-id", root);
  const first = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined, textOf(first));
  const sessionPath = must(detailsOf(first).results?.[0]?.sessionPath);
  const { row, recordPath } = rebuiltInterrupted(engine, agentsDir, sessionPath, "cafe0013");
  // A second session file no row names, beside the one the interrupted row names.
  const unnamed = join(agentsDir, "unnamed-session.jsonl");
  copyFileSync(sessionPath, unnamed);

  const resumed = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: unnamed },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(resumed.isError, undefined, textOf(resumed));
  assert.equal(row.consumed, false, "a row naming another file is untouched");
  assert.equal(existsSync(recordPath), true);
  assert.equal(widgetLines(engine).length, 1, "the interrupted row still shows");
});

test("resume by path rejected before start consumes no row", async () => {
  answerDone();
  const { root, sessionFile, agentsDir } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(sessionFile, "main-id", root);
  const first = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined, textOf(first));
  const sessionPath = must(detailsOf(first).results?.[0]?.sessionPath);
  const { row, recordPath } = rebuiltInterrupted(engine, agentsDir, sessionPath, "cafe0014");

  const rejected = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: sessionPath, cwd: join(root, "missing") },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(rejected.isError, true);
  assert.equal(detailsOf(rejected).results?.[0]?.failureCode, "invalid-plan");
  assert.equal(row.consumed, false, "a pre-start rejection consumes no other row");
  assert.equal(existsSync(recordPath), true, "the record survives the rejected resume");
  assert.equal(widgetLines(engine).length, 1, "the interrupted row still shows");
});

test("resume by path compares real paths, so a symbolic link to the session file consumes the row", async () => {
  answerDone();
  const { root, sessionFile, agentsDir } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(sessionFile, "main-id", root);
  const first = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined, textOf(first));
  const sessionPath = must(detailsOf(first).results?.[0]?.sessionPath);
  const { row, recordPath } = rebuiltInterrupted(engine, agentsDir, sessionPath, "cafe0015");
  const alias = join(root, "alias");
  symlinkSync(agentsDir, alias, "dir");

  const resumed = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: join(alias, basename(sessionPath)) },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(resumed.isError, undefined, textOf(resumed));
  assert.equal(row.consumed, true, "the row names the same file through another path");
  assert.equal(existsSync(recordPath), false);
});

test("resume by path consumes every settled row naming that file", async () => {
  answerDone();
  const { root, sessionFile, agentsDir } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(sessionFile, "main-id", root);
  const first = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined, textOf(first));
  const sessionPath = must(detailsOf(first).results?.[0]?.sessionPath);
  const earlier = rebuiltInterrupted(engine, agentsDir, sessionPath, "cafe0016");
  const later = rebuiltInterrupted(engine, agentsDir, sessionPath, "cafe0017");
  assert.equal(widgetLines(engine).length, 2, "both interrupted rows are widget content");

  const resumed = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: sessionPath },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(resumed.isError, undefined, textOf(resumed));
  assert.equal(earlier.row.consumed, true);
  assert.equal(later.row.consumed, true);
  assert.equal(existsSync(earlier.recordPath), false);
  assert.equal(existsSync(later.recordPath), false);
  assert.deepEqual(widgetLines(engine), [], "no interrupted row is left in the widget");
});

test("resume by task ID consumes every settled row naming that file", async () => {
  answerDone();
  const { root, sessionFile, agentsDir } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(sessionFile, "main-id", root);
  const first = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined, textOf(first));
  const sessionPath = must(detailsOf(first).results?.[0]?.sessionPath);
  const named = rebuiltInterrupted(engine, agentsDir, sessionPath, "cafe0018");
  const sibling = rebuiltInterrupted(engine, agentsDir, sessionPath, "cafe0019");
  assert.equal(widgetLines(engine).length, 2, "both interrupted rows are widget content");

  const resumed = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: "cafe0018" },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(resumed.isError, undefined, textOf(resumed));
  assert.equal(detailsOf(resumed).results?.[0]?.sessionPath, sessionPath);
  assert.equal(named.row.consumed, true, "the row the task ID named is consumed");
  assert.equal(sibling.row.consumed, true, "so is every other settled row naming that file");
  assert.equal(existsSync(named.recordPath), false);
  assert.equal(existsSync(sibling.recordPath), false);
  assert.deepEqual(widgetLines(engine), [], "no interrupted row is left in the widget");
});

// --- Section 8: transient-error classification --------------------------------

test("transient classification: only status-like numbers count as HTTP statuses", () => {
  const table: Array<[string, boolean]> = [
    ["at line 512 of the file", false],
    ["512 tokens exceeded the budget", false],
    ["error 501 from the provider", false],
    ["error 511", false],
    ["request 14013 timeout", true],
    ["401 Unauthorized", false],
    ["403 forbidden", false],
    ["HTTP 500 internal server error", true],
    ["upstream 502 bad gateway", true],
    ["503 service unavailable", true],
    ["504 gateway timeout", true],
    ["522 connect timeout", true],
    ["status 429", true],
    ["rate limit exceeded", true],
    ["ECONNRESET", true],
    ["fetch failed", true],
  ];
  for (const [message, retryable] of table) {
    const outcome = classifyAttempt(null, message, true, false, undefined);
    assert.equal(outcome.retry, retryable ? "auto-resume" : undefined, message);
  }
});

// --- Section 8 item 3: a refusal's own text is the error text -----------------

test("a refusal whose message also carries an error reports the refusal, not the error", async () => {
  const refusal = "I cannot assist with that request.";
  faux.setResponses([
    () =>
      fauxAssistantMessage(refusal, {
        stopReason: "error",
        errorMessage: "provider: content filtered",
      }),
  ]);
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: makeHost(sessionFile, "main-id", root),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), /^Agent error: I cannot assist with that request\./);
  assert.equal(detailsOf(result).results?.[0]?.failureCode, "execution-error");
});

// --- Section 4.2: agent directory --------------------------------------------

test("a dispatch keeps the session file's whole stem in its agent directory's name", async () => {
  // A stem with dots keeps all of them: `main.session.jsonl` → `main.session.agents`.
  const root = mkdtempSync(join(tmpdir(), "pi-dent-edge-case-"));
  roots.push(root);
  const dir = join(root, "s");
  mkdirSync(dir, { recursive: true });
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  answerDone();
  const dotted = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: makeHost(join(dir, "main.session.jsonl"), "main-id", root),
    cohortId: "cohort-1",
  });
  assert.equal(dotted.isError, undefined, textOf(dotted));
  const dottedChild = must(detailsOf(dotted).results?.[0]?.sessionPath);
  assert.equal(dirname(dottedChild), join(dir, "main.session.agents"));
  assert.equal(existsSync(dottedChild), true, "the child session file lies in its agent directory");

  // A bare relative session file name keeps its whole stem too, in the
  // working directory the dispatch runs in.
  const bare = mkdtempSync(join(tmpdir(), "pi-dent-edge-case-bare-"));
  roots.push(bare);
  const previousCwd = process.cwd();
  process.chdir(bare);
  try {
    answerDone();
    const result = await new DispatchEngine(
      bootWith(),
      () => undefined,
      undefined,
      undefined,
      undefined,
      engineDeps(),
    ).dispatch({
      toolCallId: "call-2",
      params: { prompt: "P", task: "go" },
      host: makeHost("abc.jsonl", "main-id", bare),
      cohortId: "cohort-2",
    });
    assert.equal(result.isError, undefined, textOf(result));
    const child = must(detailsOf(result).results?.[0]?.sessionPath);
    assert.equal(
      realpathSync(dirname(resolve(child))),
      realpathSync(join(bare, "abc.agents")),
      "the bare name's whole stem names the agent directory",
    );
    assert.equal(existsSync(join(bare, "abc.agents", basename(child))), true);
  } finally {
    process.chdir(previousCwd);
  }
});

// --- Section 3.3: model tiers -------------------------------------------------

test("an unresolvable agent model fails the plan instead of falling through", async () => {
  const stale: AgentDefinition = {
    name: "stale",
    description: "d",
    prompt: "S",
    source: "test",
    model: "faux/gone",
  };
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    bootWith([stale]),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { agent: stale.name, task: "go" },
    host: makeHost(sessionFile, "main-id", root),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, true);
  assert.equal(detailsOf(result).results?.[0]?.failureCode, "missing-model");
});

// --- Section 4 / adoption: settlement after the row's registry ended ----------

test("a dispatch that fails after its registry ended settles the adopted row", async () => {
  // A billing failure inside the dispatch fails it; by then the reload below has
  // moved the row into another registry, which must still settle it.
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    failingBilling(),
    undefined,
    engineDeps(),
  );
  const parent = new TaskRegistry(() => undefined);
  const parentRow = parent.register({
    kind: "agent",
    cohort: "cohort-0",
    label: "parent",
    background: false,
  });
  parent.attach(parentRow, engine.registry);
  answerDone();
  const { root, sessionFile } = newRoot();

  const pending = engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: makeHost(sessionFile, "main-id", root),
    cohortId: "cohort-1",
  });
  // dispatch() runs synchronously to its first await, so the row exists now.
  const row = must(engine.registry.list()[0]) as AgentTaskRow;
  assert.equal(row.status, "running");
  engine.registry.end();
  assert.equal(parent.get(row.taskId), row, "the row was adopted into the parent registry");

  const result = await pending;
  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), /billing unavailable/);
  assert.equal(parent.get(row.taskId), row);
  assert.equal(row.status, "failed", "the adopted row is settled, not left running");
});
