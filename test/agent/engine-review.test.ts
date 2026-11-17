import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  DispatchEngine,
  agentsDirFor,
  type AttemptRecord,
  type BootSnapshot,
  type ToolResult,
} from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { AgentDefinition } from "../../lib/catalogs.ts";
import type { HostSession } from "../../lib/host.ts";
import { writeRunningRecord } from "../../lib/task-record.ts";
import { rebuildInterruptedTasks } from "../../lib/task-rebuild.ts";
import { must } from "../support/must.ts";

/**
 * Reproductions of reviewed dispatch-engine defects (specs/agent-tool.md
 * Sections 1.1, 3.3, 4.2, 4.3, 7 and 8).
 *
 * Real child sessions run on a scripted faux provider.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// An isolated pi agent dir whose auth holds a key for the faux provider and
// whose retry settings are set per scenario.
const home = mkdtempSync(join(tmpdir(), "pi-dent-engine-review-"));
roots.push(home);
const agentDir = join(home, "pi-agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const faux = registerFauxProvider({ models: [{ id: "m" }], tokensPerSecond: 1000 });
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

function bootWith(
  agents: AgentDefinition[] = [],
  maxRecoveryRetries = 0,
  retry: Record<string, unknown> | undefined = undefined,
): BootSnapshot {
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ retry: retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 10 } }),
  );
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
    maxRecoveryRetries,
    sessionTtlDays: 30,
  } as unknown as BootSnapshot;
}

/** A fresh temp root holding a main session at `<root>/main/main.jsonl`. */
function newRoot(name = "main"): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-engine-review-"));
  roots.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return { root, sessionFile: join(dir, "main.jsonl") };
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

function textOf(result: ToolResult): string {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
}

interface AttemptLike {
  status?: string | undefined;
  failureCode?: string | undefined;
  failurePhase?: string | undefined;
  stopReason?: string | undefined;
  model?: string | undefined;
  modelSource?: string | undefined;
  sessionPath?: string | undefined;
  usage?: {
    input?: number | undefined;
    output?: number | undefined;
    turns?: number | undefined;
  };
  trace?: unknown[] | undefined;
}
interface DetailsLike {
  taskId?: string | undefined;
  results?: AttemptLike[] | undefined;
}
const detailsOf = (result: ToolResult) => result.details as DetailsLike;

// --- Section 4.3: the last assistant message commits the error ----------------

test("an attempt pi itself retried past an error completes instead of failing", async () => {
  // pi's default retry: an error answer is followed by a normal stop answer.
  let calls = 0;
  faux.setResponses([
    async () => {
      calls += 1;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" });
    },
    async () => {
      calls += 1;
      return fauxAssistantMessage("final answer");
    },
  ]);
  // Recovery bound 0: with the committed error never cleared, the engine itself
  // re-prompts or reports `Agent error: 429 …` although the attempt succeeded.
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    bootWith([], 0, { enabled: true, maxRetries: 3, baseDelayMs: 10 }),
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
  const text = textOf(result);
  assert.equal(result.isError, undefined, text);
  assert.equal(text, "final answer");
  const records = must(detailsOf(result).results);
  assert.equal(records.length, 1, `one attempt, records: ${JSON.stringify(records)}`);
  assert.equal(records[0]?.status, "completed");
  assert.equal(records[0]?.stopReason, "stop");
  assert.equal(calls, 2, "only pi's internal retry ran");
});

test("a successful attempt is not re-prompted by the engine after pi recovered", async () => {
  let calls = 0;
  faux.setResponses([
    async () => {
      calls += 1;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" });
    },
    async () => {
      calls += 1;
      return fauxAssistantMessage("final answer");
    },
  ]);
  // Recovery bound 2: with the stale committed error, attempt 1 classifies
  // auto-resume and the whole task is prompted again in the same session.
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    bootWith([], 2, { enabled: true, maxRetries: 3, baseDelayMs: 10 }),
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
  const text = textOf(result);
  assert.equal(result.isError, undefined, text);
  assert.equal(text, "final answer");
  const records = must(detailsOf(result).results) as unknown as AttemptRecord[];
  assert.equal(records.length, 1, `no engine re-prompt, records: ${JSON.stringify(records)}`);
  assert.equal(records[0]?.status, "completed");
  assert.equal(calls, 2, "work that already succeeded is not done again");
});

// --- Section 4.3 / 7: empty error message falls back --------------------------

test("an empty error message falls back to the model error text", async () => {
  faux.setResponses([() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "" })]);
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    bootWith([], 0),
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
  const text = textOf(result);
  assert.equal(result.isError, true);
  assert.match(text, /^Agent error: model error \(stopReason error\)/, text);
  assert.ok(!text.startsWith("Agent error: \n"), text);
});

// --- Section 3.3: persisted thinking is not checked against the model ---------

test("a persisted thinking level is applied to the persisted model without a support check", async () => {
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, "main-id", root);
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  faux.setResponses([() => fauxAssistantMessage("first")]);
  const first = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  const source = must(detailsOf(first).results?.[0]?.sessionPath);
  // The resumed source carries a thinking level the model does not support:
  // the faux model declares reasoning: false, so `high` has no support entry.
  appendFileSync(
    source,
    `${JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" })}\n`,
  );

  faux.setResponses([() => fauxAssistantMessage("continued")]);
  const resumed = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P", task: "go", resume: source },
    host,
    cohortId: "cohort-2",
  });
  const record = must(detailsOf(resumed).results?.[0]);
  assert.equal(resumed.isError, undefined, textOf(resumed));
  assert.equal(record.model, `${modelLabel}:high`, textOf(resumed));
  assert.equal(record.modelSource, "persisted");
  assert.notEqual(record.failureCode, "unsupported-thinking", textOf(resumed));
});

test("a blank cwd is absent: the dispatching session's working directory applies", async () => {
  for (const blank of ["", " \n"]) {
    const { root, sessionFile } = newRoot();
    const host = makeHost(sessionFile, "main-id", root);
    const engine = new DispatchEngine(
      bootWith(),
      () => undefined,
      undefined,
      undefined,
      undefined,
      engineDeps(),
    );
    faux.setResponses([() => fauxAssistantMessage("done")]);

    const result = await engine.dispatch({
      toolCallId: "call-1",
      params: { prompt: "P", task: "go", cwd: blank },
      host,
      cohortId: "cohort-1",
    });
    assert.equal(result.isError, undefined, textOf(result));
    const childSession = must(detailsOf(result).results?.[0]?.sessionPath);
    const header = JSON.parse(readFileSync(childSession, "utf8").split("\n")[0] ?? "{}") as {
      cwd?: string;
    };
    assert.equal(header.cwd, root, `the child runs in the dispatching session's directory`);
  }
});

// --- Section 7: a failed permission check on a recovery attempt ---------------

test("a missing-tool-authority record on a recovery attempt carries no previous usage", async () => {
  let ran = false;
  faux.setResponses([
    () => {
      ran = true;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" });
    },
  ]);
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, "main-id", root);
  // The cap is withdrawn only after the first attempt actually ran, so the
  // recovery attempt is rejected by the missing-tool-authority check.
  const capped: HostSession = {
    ...host,
    activeTools: () => (ran ? ["bash"] : ["Agent", "bash"]),
  };
  const engine = new DispatchEngine(
    bootWith([], 1),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: capped,
    cohortId: "cohort-1",
  });
  const records = must(detailsOf(result).results);
  assert.equal(records.length, 2, JSON.stringify(records));
  assert.equal(records[0]?.failureCode, "execution-error");
  assert.equal(records[1]?.failureCode, "missing-tool-authority");
  assert.equal(records[1]?.usage?.turns, 0, "no attempt ran for the extra record");
  assert.equal(records[1]?.usage?.input, 0, "the extra record repeats no usage");
  assert.equal((records[1]?.trace ?? []).length, 0);
});

// --- Section 4.1 / 4.2: agent-directory creation is a pre-start rejection -----

function resumeFixture(root: string): { source: string; recordPath: string; blocked: string } {
  const dir = join(root, "child");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, "main.agents"), { recursive: true });
  const source = join(dir, "src.jsonl");
  writeFileSync(source, `${JSON.stringify({ type: "session", cwd: root })}\n`);
  // A regular file occupies the child's would-be agent directory.
  const blocked = agentsDirFor(source, "unused");
  writeFileSync(blocked, "not a directory\n");
  const recordPath = writeRunningRecord(join(root, "main.agents"), {
    taskId: "cafe0007",
    agent: "dynamic",
    label: "dynamic — old",
    model: modelLabel,
    cohort: "cohort-0",
    startedAt: 1,
    sessionPath: source,
  });
  return { source, recordPath, blocked };
}

test("a child agent directory that cannot be created rejects the dispatch as pre-start", async () => {
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
  const { recordPath } = resumeFixture(root);
  assert.equal(rebuildInterruptedTasks(engine.registry, join(root, "main.agents")), 1);
  const resumed = must(engine.registry.get("cafe0007"));

  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", resume: "cafe0007" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, true, textOf(result));
  assert.equal(detailsOf(result).results?.[0]?.failureCode, "invalid-plan");
  assert.equal(
    detailsOf(result).results?.[0]?.status === undefined
      ? ""
      : detailsOf(result).results?.[0]?.status,
    "failed",
  );
  assert.equal(resumed.consumed, false, "the resumed row is not consumed by a pre-start rejection");
  assert.equal(existsSync(recordPath), true, "the resumed row's record survives");
});

test("a child agent directory that cannot be created fails a background call instead of lying about startup", async () => {
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
  const { recordPath } = resumeFixture(root);
  assert.equal(rebuildInterruptedTasks(engine.registry, join(root, "main.agents")), 1);
  const resumed = must(engine.registry.get("cafe0007"));

  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", resume: "cafe0007", background: true },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, true, textOf(result));
  assert.ok(!textOf(result).includes("started in background"), textOf(result));
  assert.equal(resumed.consumed, false, "the resumed row is not consumed");
  assert.equal(existsSync(recordPath), true, "the resumed row's record survives");
});

// --- Section 3.1 / 4.1: a plan-resolution failure after delivery began -------

/** Wait until the row with `taskId` leaves `running`. */
async function waitForSettled(engine: DispatchEngine, taskId: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const row = engine.registry.get(taskId);
    if (row !== undefined && row.status !== "running") return row;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${taskId} to settle`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

test("a plan-resolution failure on a later attempt settles like an execution failure", async () => {
  let ran = false;
  faux.setResponses([
    () => {
      ran = true;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" });
    },
  ]);
  const { root, sessionFile } = newRoot();
  const base = makeHost(sessionFile, "main-id", root);
  const notified: string[] = [];
  const host: HostSession = {
    ...base,
    // The cap is withdrawn only after the first attempt actually ran, so the
    // dispatch-authority check fails inside the recovery attempt, after
    // delivery has begun.
    activeTools: () => (ran ? ["bash"] : ["Agent", "bash"]),
    notify: (message: string) => {
      notified.push(message);
    },
  };
  const engine = new DispatchEngine(
    bootWith([], 1),
    () => host,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", background: true },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined, textOf(result));
  const taskId = must(detailsOf(result).taskId);
  const row = await waitForSettled(engine, taskId);
  assert.equal(row.status, "failed");
  assert.match(
    row.result ?? "",
    /Agent error: the main session's tool cap no longer includes Agent/,
  );
  // A row consumed before it settles is never listed by a completion
  // notification (task-registry.md Section 5). This one is listed, so the late
  // plan-resolution failure settles like an execution failure.
  assert.deepEqual(notified, [`Background tasks settled:\n${taskId} · failed · dynamic — go`]);
});

test("a plan-resolution failure during delivery records its own phase and code", async () => {
  let ran = false;
  faux.setResponses([
    () => {
      ran = true;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" });
    },
  ]);
  const { root, sessionFile } = newRoot();
  const base = makeHost(sessionFile, "main-id", root);
  const host: HostSession = {
    ...base,
    activeTools: () => (ran ? ["bash"] : ["Agent", "bash"]),
  };
  const engine = new DispatchEngine(
    bootWith([], 1),
    () => host,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-2",
  });
  assert.equal(result.isError, true, textOf(result));
  const last = must(detailsOf(result).results?.at(-1));
  assert.equal(last.status, "failed");
  assert.equal(last.stopReason, "error");
  assert.equal(last.failurePhase, "plan-resolution");
  assert.equal(last.failureCode, "missing-tool-authority");
});

// --- Section 4.1: the row label is `<agent> — <summary>` --------------------

test("the initial label falls back to the literal `task` when the first line of task is empty", async () => {
  faux.setResponses([]);
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
    params: { prompt: "P", task: "\nsecond line" },
    host: undefined,
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, true, textOf(result));
  const row = must(engine.registry.list()[0]);
  assert.equal(row.label, "dynamic — task");
});

test("the label takes the whole first line of task, never a cut one", async () => {
  faux.setResponses([fauxAssistantMessage("done")]);
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, "main-id", root);
  const engine = new DispatchEngine(
    bootWith(),
    () => host,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const firstLine = "y".repeat(200);
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: `${firstLine}\nsecond line`, background: true },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined, textOf(result));
  const row = must(engine.registry.get(must(detailsOf(result).taskId)));
  assert.equal(row.label, `dynamic — ${firstLine}`);
  await waitForSettled(engine, row.taskId);
});

test("the amended label uses the literal `task` when the first line of task is empty", async () => {
  faux.setResponses([fauxAssistantMessage("done")]);
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, "main-id", root);
  const engine = new DispatchEngine(
    bootWith(),
    () => host,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "\nsecond line", background: true },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined, textOf(result));
  const row = must(engine.registry.get(must(detailsOf(result).taskId)));
  assert.equal(row.label, "dynamic — task");
  await waitForSettled(engine, row.taskId);
});

// --- Section 1.1 / task.md 1.1: the `cwd` check is a parameter check --------

test("a cwd failure is reported before the dispatch-authority failure", async () => {
  faux.setResponses([]);
  const { root, sessionFile } = newRoot();
  const base = makeHost(sessionFile, "main-id", root);
  // The cap excludes Agent, so plan resolution would also fail; the `cwd`
  // check is a parameter check and comes first (agent-tool.md Section 1.1).
  const host: HostSession = { ...base, activeTools: () => ["bash"] };
  const engine = new DispatchEngine(
    bootWith(),
    () => host,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", cwd: "missing" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, true);
  assert.ok(
    textOf(result).includes(`cwd is not an existing directory: ${join(root, "missing")}`),
    textOf(result),
  );
  assert.equal(detailsOf(result).results?.[0]?.failureCode, "invalid-plan");
});

// --- Section 1.1: an empty agent name lists the catalog ------------------------

test("an empty agent name is rejected with the list of available agents", async () => {
  const alpha: AgentDefinition = { name: "alpha", description: "a", prompt: "A", source: "test" };
  const beta: AgentDefinition = { name: "beta", description: "b", prompt: "B", source: "test" };
  faux.setResponses([]);
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, "main-id", root);
  const engine = new DispatchEngine(
    bootWith([alpha, beta]),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { agent: "", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, true);
  assert.ok(
    textOf(result).includes('unknown agent ""') &&
      textOf(result).includes("Available agents: alpha, beta"),
    textOf(result),
  );
});

test("an empty agent name over an empty catalog reports (none)", async () => {
  faux.setResponses([]);
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, "main-id", root);
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
    params: { agent: "", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, true);
  assert.ok(textOf(result).includes("Available agents: (none)"), textOf(result));
});
