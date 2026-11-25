import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
  agentsDirFor,
  DispatchEngine,
  type BootSnapshot,
  type ToolResult,
} from "../../lib/engine.ts";
import type { HostSession } from "../../lib/host.ts";
import { AgentTaskRow, TaskRegistry, type TaskRow } from "../../lib/registry.ts";
import type { TaskLedger } from "../../lib/task-ledger.ts";
import { LedgerHolder, NestedCalls, type LedgerScope } from "../../lib/task-ledger-wiring.ts";
import { rebuildInterruptedTasks } from "../../lib/task-rebuild.ts";
import { engineDeps } from "../support/engine-deps.ts";
import { must } from "../support/must.ts";
import { makeBashTool } from "../../lib/bash-tool.ts";
import { FleetCoordinator } from "../../lib/fleet.ts";
import { makeFleetTool, makeTaskTool } from "../../lib/tools.ts";
import { openLedger, raw, tempDir } from "./support.ts";

/**
 * specs/task-ledger.md Sections 3.1, 3.2 and 4.2 through real dispatches: every task row of every
 * depth gets its ledger row, written as the task runs. Child sessions run on a scripted faux
 * provider.
 */

const agentDir = tempDir();
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 } }),
);
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
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
  });
  return runtime;
};
const model = faux.getModel();

const boot = {
  cwd: "/tmp",
  config: {
    merged: {},
    layers: {},
    projectRoot: "/tmp",
    diagnostics: [],
    liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
  },
  agents: [],
  agentIndex: new Map(),
  skills: [],
  skillIndex: new Map(),
  plugins: [],
  pluginIndex: new Map(),
  diagnostics: [],
  maxRecoveryRetries: 0,
  sessionTtlDays: 30,
} as unknown as BootSnapshot;

interface Main {
  root: string;
  sessionFile: string;
  host: HostSession;
  scope: LedgerScope;
  engine: DispatchEngine;
}

/** A main session `main-id` whose engine writes into `ledger`. */
function mainSession(
  ledger: TaskLedger | undefined,
  tools = ["Agent"],
  fleet?: FleetCoordinator,
): Main {
  const root = tempDir();
  mkdirSync(join(root, "main"), { recursive: true });
  const sessionFile = join(root, "main", "main.jsonl");
  const host: HostSession = {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => sessionFile,
    sessionDir: () => root,
    model: () => ({ provider: model.provider, id: model.id }),
    thinking: () => undefined,
    activeTools: () => tools,
    inventory: () => [model as never],
    configuredModels: () => [model as never],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
  const holder = new LedgerHolder();
  holder.ledger = ledger;
  const scope: LedgerScope = {
    holder,
    sessionId: () => "main-id",
    cwd: () => root,
    calls: new NestedCalls(),
  };
  const engine = new DispatchEngine(
    boot,
    () => host,
    fleet,
    undefined,
    undefined,
    engineDeps({ ledger: scope }),
  );
  return { root, sessionFile, host, scope, engine };
}

let calls = 0;
function dispatch(main: Main, params: Record<string, unknown>): Promise<ToolResult> {
  calls += 1;
  return main.engine.dispatch({
    toolCallId: `call-${calls}`,
    params: { prompt: "P", ...params } as never,
    host: main.host,
    cohortId: `cohort-${calls}`,
  });
}

/** Answers by the task of the conversation: `steps[task]` gives the reply of each of its turns. */
type Reply = ReturnType<typeof fauxAssistantMessage>;
function script(steps: Record<string, Array<() => Reply | Promise<Reply>>>): void {
  const turns = new Map<string, number>();
  const step: FauxResponseStep = async (context) => {
    const first = JSON.stringify(context.messages.find((message) => message.role === "user"));
    const task = Object.keys(steps).find((name) => first.includes(name));
    if (task === undefined) return fauxAssistantMessage("unscripted");
    const turn = turns.get(task) ?? 0;
    turns.set(task, turn + 1);
    const reply = steps[task]?.[turn];
    return reply === undefined ? fauxAssistantMessage("done") : reply();
  };
  faux.setResponses(Array.from({ length: 20 }, () => step));
}

const textOf = (result: ToolResult): string =>
  result.content[0]?.type === "text" ? result.content[0].text : "";

/** The ledger row of a task row, found by its task ID and start time. */
function ledgerRowOf(path: string, row: TaskRow | undefined): Record<string, unknown> {
  const db = raw(path);
  try {
    const found = db
      .prepare("SELECT * FROM tasks WHERE task_id = ? AND started_at = ?")
      .all(row?.taskId ?? "", row?.startedAt ?? -1);
    assert.equal(found.length, 1, `one ledger row for task ${row?.taskId}`);
    return { ...must(found[0]) };
  } finally {
    db.close();
  }
}

const rowIdOf = (path: string, row: TaskRow | undefined): string =>
  String(ledgerRowOf(path, row).row_id);

/** The `Task` `list` text of a registry, read from `ledger`. */
async function listText(registry: TaskRegistry, ledger: TaskLedger): Promise<string> {
  const tool = makeTaskTool({ registry: () => registry, ledger: () => ledger });
  return textOf(
    await tool.execute("tc", { action: "list" } as never, undefined, undefined, undefined as never),
  );
}

/** Every ledger row, keyed by task ID. */
function ledgerRows(path: string): Map<string, Record<string, unknown>> {
  const db = raw(path);
  try {
    const rows = db.prepare("SELECT * FROM tasks").all();
    return new Map(rows.map((row) => [String(row.task_id), { ...row }]));
  } finally {
    db.close();
  }
}

/** Resolves once `row` is no longer running. */
function settled(registry: TaskRegistry, row: TaskRow): Promise<void> {
  return new Promise((resolve) => {
    if (row.status !== "running") return resolve();
    const stop = registry.subscribe(() => {
      if (row.status === "running") return;
      stop();
      resolve();
    });
  });
}

test("a foreground agent task's ledger row follows it from register to settle", async () => {
  script({ FOREGROUND: [() => fauxAssistantMessage("answer")] });
  const { ledger, path } = openLedger();
  const main = mainSession(ledger);
  const result = await dispatch(main, { task: "FOREGROUND" });
  assert.equal(textOf(result), "answer");
  assert.equal("usage" in result, false, "a pi-dent tool result carries no host usage (2.1)");
  const row = main.engine.registry.rows[0];
  assert.ok(row instanceof AgentTaskRow);
  await ledger.flushed();
  const written = ledgerRowOf(path, row);
  const usage = must(row.usage);
  assert.deepEqual(
    {
      session_id: written.session_id,
      task_id: written.task_id,
      parent_id: written.parent_id,
      resumes_id: written.resumes_id,
      fleet_query: written.fleet_query,
      kind: written.kind,
      background: written.background,
      cwd: written.cwd,
      agent: written.agent,
      label: written.label,
      model: written.model,
      status: written.status,
      dispatched: written.dispatched,
      started_at: written.started_at,
      settled_at: written.settled_at,
      owner_pid: written.owner_pid,
      session_path: written.session_path,
      usage: [written.input, written.output, written.cache_read, written.cache_write],
      cost: written.cost,
      turns: written.turns,
    },
    {
      session_id: "main-id",
      task_id: row.taskId,
      parent_id: null,
      resumes_id: null,
      fleet_query: 0,
      kind: "agent",
      background: 0,
      cwd: main.root,
      agent: row.agent ?? null,
      label: row.label,
      model: row.model ?? null,
      status: "completed",
      dispatched: 1,
      started_at: row.startedAt,
      settled_at: row.settledAt,
      owner_pid: process.pid,
      session_path: row.sessionPath ?? null,
      usage: [usage.input, usage.output, usage.cacheRead, usage.cacheWrite],
      cost: usage.cost,
      turns: 1,
    },
  );
  assert.notEqual(written.session_path, null, "the child session's file is recorded");
  ledger.close();
});

test("a background agent task and an agent its child session dispatches: the nested row's parent is the dispatch", async () => {
  script({
    BACKGROUND: [
      () =>
        fauxAssistantMessage([fauxToolCall("Agent", { prompt: "I", task: "NESTED" })], {
          stopReason: "toolUse",
        }),
      () => fauxAssistantMessage("outer done"),
    ],
    NESTED: [() => fauxAssistantMessage("inner done")],
  });
  const { ledger, path } = openLedger();
  const main = mainSession(ledger);
  const started = await dispatch(main, { task: "BACKGROUND", background: true });
  assert.match(textOf(started), /started in background/);
  const outer = must(main.engine.registry.rows[0]);
  await settled(main.engine.registry, outer);
  assert.equal(outer.status, "completed");
  await ledger.flushed();
  const rows = ledgerRows(path);
  assert.equal(rows.size, 2, "one ledger row per task row, the nested one included");
  const outerRow = must(rows.get(outer.taskId));
  assert.deepEqual(
    [outerRow.background, outerRow.status, outerRow.dispatched],
    [1, "completed", 1],
  );
  const inner = must([...rows.values()].find((row) => row.task_id !== outer.taskId));
  assert.equal(inner.parent_id, rowIdOf(path, outer));
  assert.equal(inner.session_id, "main-id", "a child session's rows file under the main session");
  assert.deepEqual([inner.background, inner.status, inner.dispatched], [0, "completed", 1]);
  assert.equal(inner.turns, 1);
  ledger.close();
});

test("an agent a script run of a child session dispatches has the script's row as its parent", async () => {
  const code =
    'await tools.Agent({ prompt: "I", task: "VIA-SCRIPT" }); await tools.Agent({ prompt: "I", task: "SECOND-NESTED" }); "ok"';
  script({
    SCRIPTED: [
      () =>
        fauxAssistantMessage([fauxToolCall("Script", { code })], {
          stopReason: "toolUse",
        }),
      () => fauxAssistantMessage("outer done"),
    ],
    "VIA-SCRIPT": [() => fauxAssistantMessage("inner done")],
    "SECOND-NESTED": [() => fauxAssistantMessage("inner done")],
  });
  const { ledger, path } = openLedger();
  const main = mainSession(ledger, ["Agent", "Script"]);
  const result = await dispatch(main, { task: "SCRIPTED" });
  assert.equal(textOf(result), "outer done");
  const outer = must(main.engine.registry.rows[0]);
  await ledger.flushed();
  const rows = [...ledgerRows(path).values()];
  const scriptRow = must(rows.find((row) => row.kind === "script"));
  const nested = must(rows.find((row) => row.kind === "agent" && row.task_id !== outer.taskId));
  // The tool-call counts: the outer child's one Script call; the run's two nested calls; none in
  // the nested agents' answers.
  assert.equal(must(ledgerRows(path).get(outer.taskId)).tool_calls, 1);
  assert.equal(scriptRow.tool_calls, 2, "one per nested call the run started");
  assert.equal(nested.tool_calls, 0);
  assert.equal(
    scriptRow.parent_id,
    rowIdOf(path, outer),
    "rule 2: the script ran in the child session",
  );
  assert.equal(nested.parent_id, scriptRow.row_id, "rule 1: the run's nested call registered it");
  assert.deepEqual([scriptRow.dispatched, scriptRow.status], [1, "completed"]);
  assert.match(String(scriptRow.session_path), /\.jsonl$/, "the run's tool log");
  assert.equal(nested.status, "completed");
  ledger.close();
});

test("a Fleet query dispatch's row is the target session's, marked as a query", async () => {
  script({ QUESTION: [() => fauxAssistantMessage("answer")] });
  const { ledger, path } = openLedger();
  const main = mainSession(ledger);
  const result = await main.engine.runIsolatedQuery(main.host, {
    correlationId: "q1",
    senderSessionId: "sibling",
    body: "QUESTION",
  });
  assert.equal(result.text, "answer");
  await ledger.flushed();
  const rows = [...ledgerRows(path).values()];
  assert.equal(rows.length, 1);
  const row = must(rows[0]);
  assert.deepEqual(
    [row.session_id, row.fleet_query, row.parent_id, row.dispatched, row.status],
    ["main-id", 1, null, 1, "completed"],
  );
  ledger.close();
});

test("a resume by task ID links its row to the row it continues", async () => {
  script({ FIRST: [() => fauxAssistantMessage("one"), () => fauxAssistantMessage("two")] });
  const { ledger, path } = openLedger();
  const main = mainSession(ledger);
  await dispatch(main, { task: "FIRST" });
  const first = must(main.engine.registry.rows[0]);
  const resumed = await dispatch(main, { task: "again", resume: first.taskId });
  assert.equal(resumed.isError, undefined, textOf(resumed));
  const second = must(main.engine.registry.rows[1]);
  await ledger.flushed();
  assert.equal(ledgerRowOf(path, second).resumes_id, rowIdOf(path, first));
  ledger.close();
});

test("a pre-start rejection has a ledger row that never became dispatched", async () => {
  const { ledger, path } = openLedger();
  const main = mainSession(ledger);
  const result = await dispatch(main, { task: "x", cwd: join(main.root, "missing") });
  assert.equal(result.isError, true);
  const row = must(main.engine.registry.rows[0]);
  await ledger.flushed();
  const written = ledgerRowOf(path, row);
  assert.deepEqual(
    [written.dispatched, written.status, written.settled_at, written.turns],
    [0, "failed", row.settledAt, 0],
  );
  ledger.close();
});

test("a reload settles a running background task cancelled; the next rebuild makes its ledger row interrupted", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  script({
    LONG: [
      async () => {
        await gate;
        return fauxAssistantMessage("late");
      },
    ],
  });
  const { ledger, path } = openLedger();
  const main = mainSession(ledger);
  await dispatch(main, { task: "LONG", background: true });
  const row = must(main.engine.registry.rows[0]);
  // The shutdown of a reload: the registry ends, its running rows settle `cancelled`.
  const registry = main.engine.registry;
  registry.end();
  await settled(registry, row);
  release();
  assert.equal(row.status, "cancelled");
  await ledger.flushed();
  assert.equal(ledgerRowOf(path, row).status, "cancelled");

  // The next extension instance opens the ledger anew and rebuilds from the task record.
  const next = openLedger({ path });
  const rebuilt = new TaskRegistry(() => undefined);
  const agentsDir = agentsDirFor(main.sessionFile, "main-id");
  const inserted = rebuildInterruptedTasks(rebuilt, agentsDir, undefined, undefined, {
    ledger: next.ledger,
    sessionId: "main-id",
  });
  assert.equal(inserted, 1);
  await next.ledger.flushed();
  const written = ledgerRowOf(path, row);
  assert.deepEqual([written.status, written.settled_at], ["interrupted", row.settledAt]);
  // The rebuilt row shows its ledger row's figures, found by the key of Section 4.2.
  const listed = await listText(rebuilt, next.ledger);
  assert.match(
    listed,
    new RegExp(`^${row.taskId} · interrupted · \\d+s · 0 turns · \\$0\\.000 · `),
  );
  ledger.close();
  next.ledger.close();
});

test("an unusable or busy ledger does not disturb a dispatch", async () => {
  script({
    UNUSABLE: [() => fauxAssistantMessage("fine")],
    BUSY: [() => fauxAssistantMessage("ok")],
  });
  const dir = tempDir();
  // A directory where the file should be cannot be opened as a database.
  mkdirSync(join(dir, "tasks-v1.sqlite"));
  const unusable = openLedger({ path: join(dir, "tasks-v1.sqlite") });
  await unusable.ledger.flushed();
  const main = mainSession(unusable.ledger);
  const result = await dispatch(main, { task: "UNUSABLE" });
  assert.equal(textOf(result), "fine");
  assert.equal(unusable.notices.length, 1);
  // Task list says so instead of showing figures (task-tool.md Section 2.3).
  assert.match(await listText(main.engine.registry, unusable.ledger), / · ledger unavailable · /);

  const busy = openLedger();
  await busy.ledger.flushed();
  const lock = raw(busy.path);
  lock.exec("BEGIN IMMEDIATE");
  const held = mainSession(busy.ledger);
  try {
    assert.equal(textOf(await dispatch(held, { task: "BUSY" })), "ok");
  } finally {
    lock.exec("COMMIT");
    lock.close();
  }
  await busy.ledger.flushed();
  const row = must(held.engine.registry.rows[0]);
  assert.equal(ledgerRowOf(busy.path, row).status, "completed", "written once the lock went");
  busy.ledger.close();
});

test("a Fleet query to a child session files its row under the child's dispatch, in the child's cwd", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let childStarted = (): void => {};
  const started = new Promise<void>((resolve) => (childStarted = resolve));
  script({
    "CHILD-TASK": [
      async () => {
        childStarted();
        await gate;
        return fauxAssistantMessage("child done");
      },
    ],
    "QUESTION-TO-CHILD": [() => fauxAssistantMessage("child answer")],
  });
  const { ledger, path } = openLedger();
  const root = tempDir();
  const fleet = new FleetCoordinator(boot, { dbPath: join(root, "fleet.sqlite"), bootId: "boot" });
  const main = mainSession(ledger, ["Agent", "Fleet"], fleet);
  fleet.registerEndpoint(
    {
      sessionId: "main-id",
      cwd: () => main.root,
      isIdle: () => true,
      abortTurn: () => {},
      deliverTurn: () => {},
    },
    "idle",
  );
  const childCwd = join(main.root, "child-cwd");
  mkdirSync(childCwd);
  let dispatched: Promise<ToolResult> | undefined;
  try {
    dispatched = dispatch(main, { task: "CHILD-TASK", cwd: childCwd });
    await started;
    const child = must(fleet.listSessions("children", main.root, "main-id")[0]);
    const fleetTool = makeFleetTool({ fleet, hostProvider: () => main.host });
    const asked = await fleetTool.execute(
      "fq",
      { action: "query", target: child.sessionId, body: "QUESTION-TO-CHILD" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(asked.isError, undefined, textOf(asked));
    let query: Record<string, unknown> | undefined;
    const deadline = Date.now() + 10_000;
    while (query?.status !== "completed") {
      if (Date.now() > deadline) throw new Error("the query's ledger row never completed");
      await ledger.flushed();
      query = [...ledgerRows(path).values()].find((row) => row.fleet_query === 1);
      if (query?.status !== "completed") await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const outer = must(main.engine.registry.rows[0]);
    assert.deepEqual(
      [query.session_id, query.parent_id, query.cwd],
      ["main-id", rowIdOf(path, outer), childCwd],
    );
  } finally {
    release();
    await dispatched;
    fleet.close();
    ledger.close();
  }
});

test("a bash task's ledger row: dispatched once its checks pass, its output file, no usage", async () => {
  const { ledger, path } = openLedger();
  const main = mainSession(ledger);
  const bash = makeBashTool({
    registry: () => main.engine.registry,
    hostProvider: () => main.host,
    cohortFor: (toolCallId) => toolCallId,
    agentDir: () => join(main.root, "agent"),
    settings: () => ({}),
  });
  const result = await bash.execute(
    "bash-1",
    { command: "echo hi" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(result.isError, undefined, textOf(result));
  const outputPath = (result.details as { outputPath: string }).outputPath;
  const rejected = await bash.execute(
    "bash-2",
    { command: "echo no", cwd: join(main.root, "missing") } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(rejected.isError, true);
  await ledger.flushed();
  const [ran, refused] = main.engine.registry.rows;
  const written = ledgerRowOf(path, ran);
  assert.deepEqual(
    [written.kind, written.dispatched, written.cwd, written.status, written.result_path],
    ["bash", 1, main.root, "completed", outputPath],
  );
  assert.deepEqual(
    [written.input, written.output, written.cache_read, written.cache_write, written.cost],
    [null, null, null, null, null],
  );
  assert.equal(written.turns, null);
  assert.equal(written.tool_calls, null, "a bash row has no tool-call count");
  const refusedRow = ledgerRowOf(path, refused);
  assert.deepEqual([refusedRow.dispatched, refusedRow.status], [0, "failed"]);
  ledger.close();
});

test("a resume by path links its row to the latest row of that session file", async () => {
  script({ PATHED: [() => fauxAssistantMessage("one"), () => fauxAssistantMessage("two")] });
  const { ledger, path } = openLedger();
  const main = mainSession(ledger);
  await dispatch(main, { task: "PATHED" });
  const first = must(main.engine.registry.rows[0]);
  assert.ok(first instanceof AgentTaskRow);
  const resumed = await dispatch(main, { task: "again", resume: must(first.sessionPath) });
  assert.equal(resumed.isError, undefined, textOf(resumed));
  const second = must(main.engine.registry.rows[1]);
  await ledger.flushed();
  assert.equal(ledgerRowOf(path, second).resumes_id, rowIdOf(path, first));
  ledger.close();
});
