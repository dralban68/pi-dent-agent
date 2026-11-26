import { test, after } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  getApiProvider,
  registerFauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot, type ToolResult } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { AgentDefinition } from "../../lib/catalogs.ts";
import type { HostSession } from "../../lib/host.ts";
import { AgentTaskRow, type TaskRow } from "../../lib/task-row.ts";
import { TaskRegistry, killTask } from "../../lib/registry.ts";
import { readRecord, recordFileName, writeRunningRecord } from "../../lib/task-record.ts";
import { rebuildInterruptedTasks } from "../../lib/task-rebuild.ts";
import { must } from "../support/must.ts";

/**
 * specs/task-record.md#lifecycle wired into the Agent dispatch engine
 * (specs/agent-tool.md#background-contract and specs/agent-tool.md#resume): the background start message names a
 * deterministic session file, a background task writes one running record and
 * rewrites it at settlement, and `resume` by task ID continues the recorded
 * session file in place, consuming a settled or interrupted row.
 *
 * Real child sessions run on a scripted faux provider.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// An isolated pi agent dir whose auth holds a key for the faux provider.
const home = mkdtempSync(join(tmpdir(), "pi-dent-task-record-"));
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
const weirdAgent: AgentDefinition = {
  name: "weird/agent name",
  description: "does things",
  prompt: "SYSTEM",
  source: "test",
};

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
  const root = mkdtempSync(join(tmpdir(), "pi-dent-task-record-case-"));
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
    activeTools: () => ["Agent", "bash"],
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

function textOf(result: ToolResult): string {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
}

/** A host that records the notifications a rebuilt registry sends. */
function recordingHost(notify: string[]): HostSession {
  return { notify: (message: string) => notify.push(message) } as unknown as HostSession;
}

/** A background dispatch whose running record is on disk; the settled engine and task ID. */
async function runningBackgroundTask(): Promise<{
  engine: DispatchEngine;
  taskId: string;
  recordPath: string;
  agentsDir: string;
}> {
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
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", background: true },
    host: makeHost(sessionFile, "main-id", root),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined);
  const taskId = must(detailsOf(result).taskId);
  const recordPath = join(agentsDir, recordFileName(taskId));
  await waitFor(
    () => (readRecord(recordPath)?.status === "running" ? true : undefined),
    "running record",
  );
  return { engine, taskId, recordPath, agentsDir };
}

interface AttemptLike {
  sessionPath?: string | undefined;
  failureCode?: string | undefined;
  failurePhase?: string | undefined;
}
interface DetailsLike {
  background?: boolean | undefined;
  taskId?: string | undefined;
  agent?: string | undefined;
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

/** Wait until the row with `taskId` leaves `running`, and its attempt has ended. */
async function waitSettled(engine: DispatchEngine, taskId: string): Promise<TaskRow> {
  const row = await waitFor(() => {
    const found = engine.registry.get(taskId);
    return found !== undefined && found.status !== "running" ? found : undefined;
  }, `settlement of ${taskId}`);
  // Let the attempt's `finally` (session disposal) run before a test cleans up.
  await new Promise((done) => setTimeout(done, 20));
  return row;
}

const sessionLines = (path: string): number => readFileSync(path, "utf8").trim().split("\n").length;

test("background dispatch: the start text and details name the deterministic session file", async () => {
  answerDone();
  const { root, sessionFile, agentsDir } = newRoot();
  const engine = new DispatchEngine(
    bootWith([weirdAgent]),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { agent: weirdAgent.name, task: "go", background: true },
    host: makeHost(sessionFile, "main-id", root),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined);
  const text = textOf(result);
  const match =
    /^Agent weird\/agent name started in background \(taskId ([0-9a-f]{8})\)\.\nSession: (.+)$/.exec(
      text,
    );
  assert.ok(match, `unexpected start text: ${JSON.stringify(text)}`);
  const taskId = must(match[1]);
  const sessionPath = must(match[2]);
  const expected = join(agentsDir, `weird_agent_name-${taskId}.jsonl`);
  assert.equal(
    sessionPath,
    expected,
    "persistent child session file is <safeAgent>-<taskId>.jsonl",
  );
  assert.equal(basename(sessionPath), `weird_agent_name-${taskId}.jsonl`);

  const details = detailsOf(result);
  assert.equal(details.background, true);
  assert.equal(details.taskId, taskId);
  assert.equal(details.agent, "weird/agent name");
  assert.equal(details.sessionPath, sessionPath);

  const row = await waitSettled(engine, taskId);
  assert.equal((row as AgentTaskRow).sessionPath, sessionPath, "runDispatch opened the same file");
  assert.equal(existsSync(sessionPath), true);
});

test("background task: one running record, rewritten with the terminal status at settlement", async () => {
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
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", background: true },
    host: makeHost(sessionFile, "main-id", root),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined);
  const details = detailsOf(result);
  const taskId = must(details.taskId);
  const sessionPath = must(details.sessionPath);
  const recordPath = join(agentsDir, recordFileName(taskId));
  assert.equal(recordPath, join(agentsDir, `${taskId}.task.json`));

  const running = await waitFor(() => {
    const record = readRecord(recordPath);
    return record?.status === "running" ? record : undefined;
  }, "running record");
  assert.equal(running.taskId, taskId);
  assert.equal(running.agent, "dynamic");
  assert.equal(running.label, "go");
  assert.equal(running.model, modelLabel);
  assert.equal(running.cohort, "cohort-1");
  assert.equal(running.sessionPath, sessionPath);
  assert.equal(typeof running.startedAt, "number");
  assert.equal(running.settledAt, undefined, "a running record carries no settledAt");
  assert.equal(running.resultPath, undefined);
  assert.equal((engine.registry.get(taskId) as AgentTaskRow).recordPath, recordPath);

  await waitSettled(engine, taskId);
  const settled = await waitFor(() => {
    const record = readRecord(recordPath);
    return record !== undefined && record.status !== "running" ? record : undefined;
  }, "rewritten record");
  assert.equal(settled.status, "completed");
  assert.equal(typeof settled.settledAt, "number");
  assert.equal(settled.resultPath, undefined, "a short result does not spill");
  assert.equal(settled.startedAt, running.startedAt, "the rewrite keeps the running fields");
  assert.equal(settled.sessionPath, sessionPath);
  assert.deepEqual(
    readdirSync(agentsDir).filter((name) => name.endsWith(".task.json")),
    [`${taskId}.task.json`],
  );
});

test("foreground dispatch: no task record is written", async () => {
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
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", background: false },
    host: makeHost(sessionFile, "main-id", root),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined);
  const row = engine.registry.list()[0] as AgentTaskRow;
  assert.ok(row.sessionPath !== undefined);
  assert.equal(row.recordPath, undefined);
  assert.deepEqual(
    readdirSync(agentsDir).filter((name) => name.endsWith(".task.json")),
    [],
  );
});

test("resume by task ID: continues the recorded session file in place and consumes the settled row", async () => {
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
    params: { prompt: "P", task: "go", background: true },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined);
  const taskId = must(detailsOf(first).taskId);
  const sessionPath = must(detailsOf(first).sessionPath);
  const recordPath = join(agentsDir, recordFileName(taskId));
  await waitFor(
    () => (readRecord(recordPath)?.status === "completed" ? true : undefined),
    "completed record",
  );
  const parentRow = engine.registry.get(taskId) as AgentTaskRow;
  assert.equal(
    existsSync(recordPath),
    true,
    "the settled record outlives the completion notification",
  );
  assert.equal(parentRow.status, "completed");
  const beforeText = readFileSync(sessionPath, "utf8");
  const before = sessionLines(sessionPath);

  const second = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: taskId },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(second.isError, undefined, textOf(second));
  const resumed = detailsOf(second);
  assert.equal(resumed.results?.[0]?.sessionPath, sessionPath, "resumed in place");
  assert.equal(resumed.taskId === taskId, false, "the resume registers a new row");
  assert.equal(parentRow.status, "completed", "the resumed-from row keeps its status");
  assert.equal(existsSync(recordPath), false, "consuming the row deletes its record");
  assert.equal(sessionLines(sessionPath) > before, true, "turns appended to the same file");
  assert.equal(
    readFileSync(sessionPath, "utf8").startsWith(beforeText),
    true,
    "the earlier history is untouched",
  );
  assert.equal(existsSync(sessionPath), true);
});

test("resume by task ID: an interrupted rebuilt row is consumed and its record deleted", async () => {
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
    params: { prompt: "P", task: "go", background: false },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined);
  const sessionPath = must((engine.registry.list()[0] as AgentTaskRow).sessionPath);
  // A process died while this background task was running: its record still says "running".
  const recordPath = writeRunningRecord(agentsDir, {
    taskId: "cafe0001",
    agent: "dynamic",
    label: "dynamic — old",
    model: modelLabel,
    cohort: "cohort-1",
    startedAt: 1,
    sessionPath,
  });
  assert.equal(rebuildInterruptedTasks(engine.registry, agentsDir), 1);
  const rebuilt = engine.registry.get("cafe0001") as AgentTaskRow;
  assert.equal(rebuilt.status, "interrupted");
  assert.equal(rebuilt.sessionPath, sessionPath);
  assert.equal(rebuilt.recordPath, recordPath);

  const resumed = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: "cafe0001" },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(resumed.isError, undefined, textOf(resumed));
  assert.equal(detailsOf(resumed).results?.[0]?.sessionPath, sessionPath, "resumed in place");
  assert.equal(rebuilt.consumed, true);
  assert.equal(existsSync(recordPath), false, "consuming the interrupted row deletes its record");
});

test("resume by task ID: a running row is left unchanged and rejected as an in-flight dispatch", async () => {
  // The first dispatch settles at once; the background resume keeps its child in a bash turn.
  let turn = 0;
  const step: FauxResponseStep = () =>
    turn++ === 0
      ? fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.5" })], {
          stopReason: "toolUse",
        })
      : fauxAssistantMessage("done");
  faux.setResponses([() => fauxAssistantMessage("done"), ...Array.from({ length: 6 }, () => step)]);
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
    params: { prompt: "P", task: "go", background: false },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(first.isError, undefined);
  const sessionPath = detailsOf(first).results?.[0]?.sessionPath;
  assert.ok(sessionPath, "the foreground attempt records its session file");

  const background = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P2", task: "again", resume: sessionPath, background: true },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(background.isError, undefined);
  const taskId = must(detailsOf(background).taskId);
  assert.equal(detailsOf(background).sessionPath, sessionPath);
  const row = engine.registry.get(taskId) as AgentTaskRow;
  assert.equal(row.status, "running", "the resumed child is still in its bash turn");
  // The row must have opened its session file before a task ID can resolve to it.
  await waitFor(
    () => (row.sessionPath === undefined ? undefined : row.sessionPath),
    "the running row's session file",
  );
  assert.equal(row.status, "running");

  const again = await engine.dispatch({
    toolCallId: "call-3",
    params: { prompt: "P3", task: "again", resume: taskId },
    host,
    cohortId: "cohort-3",
  });
  assert.equal(again.isError, true);
  assert.equal(
    textOf(again),
    `Agent error: session already has an in-flight dispatch: ${resolve(sessionPath)}`,
  );
  assert.equal(row.consumed, false, "a running row is not consumed");
  assert.equal(row.status, "running");
  await waitSettled(engine, taskId);
});

test("resume by task ID: an unknown, script, or session-less task ID is rejected with the value", async () => {
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
  const host = makeHost(sessionFile, "main-id", root);
  const scriptRow = engine.registry.register({
    kind: "script",
    cohort: "cohort-1",
    label: "build",
    background: false,
  });
  const sessionless = engine.registry.register({
    kind: "agent",
    cohort: "cohort-1",
    label: "pre-start",
    background: false,
  });
  for (const value of ["abcdef01", scriptRow.taskId, sessionless.taskId]) {
    const result = await engine.dispatch({
      toolCallId: `call-${value}`,
      params: { prompt: "P", task: "go", resume: value },
      host,
      cohortId: "cohort-1",
    });
    assert.equal(result.isError, true);
    assert.equal(
      textOf(result),
      `Agent error: resume must name an agent task with a session file; received ${JSON.stringify(value)}`,
    );
    const attempt = detailsOf(result).results?.[0];
    assert.equal(attempt?.failureCode, "invalid-plan");
    assert.equal(attempt?.failurePhase, "plan-resolution");
  }
  assert.equal(engine.registry.get("abcdef01"), undefined);
});

test("a Task kill that settles after a reload rewrites the record as cancelled", async () => {
  // A long child turn keeps the task running while the test kills it and then
  // reloads, so the settlement lands after the registry ended.
  const streaming = Array.from({ length: 90 }, (_, i) => `w${i}`).join(" ");
  faux.setResponses(Array.from({ length: 6 }, () => () => fauxAssistantMessage(streaming)));
  const { root, sessionFile, agentsDir } = newRoot();
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
    params: { prompt: "P", task: "go", background: true },
    host: makeHost(sessionFile, "main-id", root),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined, textOf(result));
  const taskId = must(detailsOf(result).taskId);
  const recordPath = join(agentsDir, recordFileName(taskId));
  await waitFor(
    () => (readRecord(recordPath)?.status === "running" ? true : undefined),
    "running record",
  );
  const row = must(engine.registry.get(taskId)) as AgentTaskRow;

  killTask(engine.registry, row);
  engine.resetRegistry();
  await waitFor(
    () => (row.status === "running" ? undefined : true),
    "settlement of the killed task",
  );
  await waitFor(
    () => (readRecord(recordPath)?.status === "cancelled" ? true : undefined),
    "the cancelled record",
  );

  assert.equal(row.status, "cancelled");
  assert.equal(
    readRecord(recordPath)?.status,
    "cancelled",
    "a cancellation a kill requested is rewritten, not left running for the rebuild",
  );
});

/**
 * A reload (specs/task-record.md#lifecycle): the session's task registry ends with no
 * live attaching task registry to adopt the row, so the running task is
 * cancelled; its record MUST keep `running`, so the rebuild reports
 * `interrupted` whatever the order of the two.
 */
test("reload: a cancellation settles before the rebuild and the record still says running", async () => {
  const { engine, taskId, recordPath, agentsDir } = await runningBackgroundTask();
  engine.registry.end();
  const row = await waitSettled(engine, taskId);
  assert.equal(row.status, "cancelled", "the ending registry cancelled the task");
  assert.equal(
    readRecord(recordPath)?.status,
    "running",
    "a settlement the registry's end caused leaves the record running",
  );

  const notify: string[] = [];
  const rebuilt = new TaskRegistry(() => recordingHost(notify));
  assert.equal(rebuildInterruptedTasks(rebuilt, agentsDir), 1);
  assert.equal(rebuilt.get(taskId)?.status, "interrupted");
  assert.match(must(notify[0]), /^Interrupted tasks \(resume with Agent resume=<taskId>\):/);
});

test("reload: the rebuild before the cancellation settles reports the same interrupted row", async () => {
  const { engine, taskId, recordPath, agentsDir } = await runningBackgroundTask();
  engine.registry.end();
  assert.equal(
    engine.registry.get(taskId)?.status,
    "running",
    "the cancellation has not settled yet",
  );

  const notify: string[] = [];
  const rebuilt = new TaskRegistry(() => recordingHost(notify));
  assert.equal(rebuildInterruptedTasks(rebuilt, agentsDir), 1);
  assert.equal(rebuilt.get(taskId)?.status, "interrupted");

  const settled = await waitSettled(engine, taskId);
  assert.equal(settled.status, "cancelled");
  assert.equal(
    readRecord(recordPath)?.status,
    "running",
    "the late settlement rewrites neither the record nor the rebuilt row",
  );
  assert.equal(rebuilt.get(taskId)?.status, "interrupted");
});
