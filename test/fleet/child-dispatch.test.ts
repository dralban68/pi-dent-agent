import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  getApiProvider,
  registerFauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot, type ToolResult } from "../../lib/engine.ts";
import { FleetCoordinator, type FleetEndpoint } from "../../lib/fleet.ts";
import type { HostSession } from "../../lib/host.ts";
import { makeFleetTool } from "../../lib/tools.ts";
import { engineDeps } from "../support/engine-deps.ts";
import { at, must } from "../support/must.ts";

/**
 * specs/agent-tool.md#child-session and specs/session-store.md#membership-lifecycle: a
 * dispatch's child session is a child session record from before its first
 * prompt until the dispatch settles; a Fleet `query` child registers none; a
 * store that refuses the record warns and the dispatch still answers. Child
 * sessions run on a scripted faux provider; the fleet is the real coordinator
 * over a temporary store (specs/fleet-tool.md#list, specs/fleet-tool.md#send, specs/fleet-tool.md#query).
 */

// --- Runtime harness: the same faux wiring as test/agent/engine-runtime.test.ts ---

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "pi-dent-child-dispatch-"));
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
    streamSimple: (model, context, requestOptions) =>
      must(getApiProvider(faux.api as never)).streamSimple(model, context, requestOptions),
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

const runModel = faux.getModel();

function bootSnapshot(): BootSnapshot {
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 } }),
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
    agents: [],
    agentIndex: new Map(),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: 0,
    sessionTtlDays: 30,
  };
}

/** A fresh temp root holding the main session at `<root>/main/main.jsonl`. */
function newRoot(): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-child-dispatch-"));
  roots.push(root);
  const dir = join(root, "main");
  mkdirSync(dir, { recursive: true });
  return { root, sessionFile: join(dir, "main.jsonl") };
}

/** The main session's host: it has the `Agent` and `Fleet` tools and reports notices. */
function mainHost(root: string, sessionFile: string, notices: string[] = []): HostSession {
  return {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => sessionFile,
    sessionDir: () => root,
    model: () => ({ provider: runModel.provider, id: runModel.id }),
    thinking: () => undefined,
    activeTools: () => ["Agent", "Fleet"],
    inventory: () => [runModel as never],
    configuredModels: () => [runModel as never],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: (message: string) => {
      notices.push(message);
    },
  };
}

/** The main session's Fleet endpoint: it is a live session of this boot window. */
function registerMain(fleet: FleetCoordinator, root: string): void {
  fleet.registerEndpoint(
    {
      sessionId: "main-id",
      cwd: () => root,
      isIdle: () => true,
      abortTurn: () => {},
      deliverTurn: () => {},
    },
    "idle",
  );
}

function openFleet(root: string): FleetCoordinator {
  return new FleetCoordinator(bootSnapshot(), {
    dbPath: join(root, "fleet.sqlite"),
    bootId: "boot-main",
  });
}

function newEngine(fleet: FleetCoordinator, boot: Partial<BootSnapshot> = {}): DispatchEngine {
  return new DispatchEngine(
    { ...bootSnapshot(), ...boot },
    () => undefined,
    fleet,
    undefined,
    undefined,
    engineDeps(),
  );
}

// --- Helpers ---------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function textOf(result: ToolResult): string {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
}

/** Poll a condition driven by the code under test; fails when it never holds. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

interface AttemptLike {
  sessionPath?: string | undefined;
}
const resultsOf = (result: ToolResult) =>
  (result.details as { results?: AttemptLike[] | undefined }).results ?? [];

interface UsageLike {
  turns: number;
}
interface RecordLike extends AttemptLike {
  usage: UsageLike;
  status: string;
  stopReason: string;
  failureCode?: string | undefined;
}
const recordsOf = (result: ToolResult): RecordLike[] =>
  (result.details as { results?: RecordLike[] | undefined }).results ?? [];

/** A session record's stored state, read straight from the store (specs/session-store.md#session-records). */
function storedState(dbPath: string, sessionId: string): { state: string; turns: string } {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT state, turns_json FROM fleet_sessions WHERE session_id = ?")
      .get(sessionId);
    return {
      state: typeof row?.state === "string" ? row.state : "",
      turns: typeof row?.turns_json === "string" ? row.turns_json : "",
    };
  } finally {
    db.close();
  }
}

/** Await a promise within `ms`, failing the test instead of hanging. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The session ID a session file records on its first line. */
function sessionIdOf(path: string): string {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const entry: unknown = JSON.parse(line);
    if (typeof entry !== "object" || entry === null) continue;
    if (
      "type" in entry &&
      entry.type === "session" &&
      "id" in entry &&
      typeof entry.id === "string"
    ) {
      return entry.id;
    }
  }
  throw new Error(`no session entry in ${path}`);
}

/** The assistant messages a session file holds, in order. */
function assistantTexts(path: string): string[] {
  const texts: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const entry: unknown = JSON.parse(line);
    if (typeof entry !== "object" || entry === null) continue;
    if (!("type" in entry) || entry.type !== "message" || !("message" in entry)) continue;
    const message: unknown = entry.message;
    if (typeof message !== "object" || message === null) continue;
    if (!("role" in message) || message.role !== "assistant") continue;
    if (!("content" in message)) continue;
    texts.push(contentText(message.content));
  }
  return texts;
}

/** The text of a message content value: a string or a list of text blocks. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type?: string | undefined; text?: string | undefined } =>
        typeof block === "object" && block !== null,
    )
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

/** The user messages of a child session file, in order. */
function userPrompts(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message)
    .filter(
      (message): message is { role?: string | undefined; content?: unknown } =>
        typeof message === "object" && message !== null,
    )
    .filter((message) => message.role === "user")
    .map((message) => contentText(message.content));
}

/** A `Fleet` tool call made by the session whose host is `host`. */
function fleetCaller(fleet: FleetCoordinator, host: HostSession) {
  const tool = makeFleetTool({ fleet, hostProvider: () => host });
  return (params: Record<string, unknown>, signal?: AbortSignal) =>
    tool.execute("tc", params as never, signal, undefined, undefined as never);
}

interface ListedSession {
  sessionId: string;
  state: string;
  parent?: string | undefined;
  turns: Array<{ command: string }>;
}

/** The sessions a `list` of `scope` shows the invoking session `main-id`. */
async function listedBy(
  fleet: FleetCoordinator,
  host: HostSession,
  scope: "children" | "machine",
): Promise<ListedSession[]> {
  const call = fleetCaller(fleet, host);
  const listed = await call({ action: "list", scope, format: "json" });
  return (listed.details as { sessions: ListedSession[] }).sessions;
}

interface StoredRow {
  sessionId: string;
  parentSessionId: string | null;
}

/** Every session record in the store, read directly (specs/session-store.md#session-records). */
function storedRows(dbPath: string): StoredRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare("SELECT session_id, parent_session_id FROM fleet_sessions ORDER BY session_id")
      .all()
      .map((row) => ({
        sessionId: typeof row.session_id === "string" ? row.session_id : "",
        parentSessionId: typeof row.parent_session_id === "string" ? row.parent_session_id : null,
      }));
  } finally {
    db.close();
  }
}

/** The message rows addressed to `targetSessionId`, read directly (specs/session-store.md#messages). */
function storedMessageRows(
  dbPath: string,
  targetSessionId: string,
): Array<{ status: string; body: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare("SELECT status, body FROM fleet_messages WHERE target_session_id = ?")
      .all(targetSessionId)
      .map((row) => ({
        status: typeof row.status === "string" ? row.status : "",
        body: typeof row.body === "string" ? row.body : "",
      }));
  } finally {
    db.close();
  }
}

/** An endpoint of a session this boot window does not run, as a registration sees it. */
function refusedEndpoint(sessionId: string, cwd: string): FleetEndpoint {
  return {
    sessionId,
    cwd: () => cwd,
    isIdle: () => true,
    abortTurn: () => {},
    deliverTurn: () => {},
  };
}

// --- Tests -----------------------------------------------------------------

test("a dispatch's child is listed to its parent while its model is blocked, and steer reaches it", async () => {
  const { root, sessionFile } = newRoot();
  const dbPath = join(root, "fleet.sqlite");
  const fleet = openFleet(root);
  try {
    registerMain(fleet, root);
    const host = mainHost(root, sessionFile);
    const modelStarted = deferred<void>();
    const gate = deferred<void>();
    faux.setResponses([
      async () => {
        modelStarted.resolve();
        await gate.promise;
        return fauxAssistantMessage("first answer");
      },
      () => fauxAssistantMessage("steered answer"),
    ]);

    const dispatched = newEngine(fleet).dispatch({
      toolCallId: "call-child",
      params: { prompt: "P", task: "Review the diff\nsecond line of the task" },
      host,
      cohortId: "cohort-child",
    });
    await modelStarted.promise;

    const [child, ...others] = await listedBy(fleet, host, "children");
    assert.equal(others.length, 0, "the parent sees exactly its one child");
    assert.ok(child);
    assert.equal(child.parent, "main-id");
    assert.equal(child.state, "running");
    assert.equal(
      at(child.turns, 0).command,
      "Review the diff",
      "the child shows its task's first line",
    );
    const rows = storedRows(dbPath);
    assert.equal(rows.length, 2, "the child's record exists while its model is blocked");
    assert.deepEqual(
      rows.find((row) => row.sessionId === child.sessionId)?.parentSessionId,
      "main-id",
    );

    const steered = await fleetCaller(
      fleet,
      host,
    )({
      action: "send",
      target: child.sessionId,
      body: "Change of plan.",
      deliver: "steer",
    });
    assert.equal(steered.isError, undefined, textOf(steered));
    const steer = steered.details as { messageId: number; status: string };
    assert.ok(["pending", "delivered"].includes(steer.status), steer.status);

    gate.resolve();
    const result = await dispatched;
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(textOf(result), "steered answer", "the steer started a further model turn");
    const status = await fleetCaller(fleet, host)({ action: "status", messageId: steer.messageId });
    assert.equal((status.details as { status: string }).status, "delivered");
    const sessionPath = must(at(resultsOf(result), 0).sessionPath);
    assert.deepEqual(userPrompts(sessionPath), [
      "Review the diff\nsecond line of the task",
      "[Fleet from main-id]\nChange of plan.",
    ]);

    // Settled: the child's record is gone with its dispatch.
    assert.deepEqual(await listedBy(fleet, host, "children"), []);
    assert.deepEqual(
      storedRows(dbPath).map((row) => row.sessionId),
      ["main-id"],
    );
  } finally {
    fleet.close();
  }
});

test("a dispatch cancelled while its model is blocked removes the child record", async () => {
  const { root, sessionFile } = newRoot();
  const dbPath = join(root, "fleet.sqlite");
  const fleet = openFleet(root);
  try {
    registerMain(fleet, root);
    const host = mainHost(root, sessionFile);
    const modelStarted = deferred<void>();
    const gate = deferred<void>();
    faux.setResponses([
      async () => {
        modelStarted.resolve();
        await gate.promise;
        return fauxAssistantMessage("too late");
      },
    ]);

    const controller = new AbortController();
    const dispatched = newEngine(fleet).dispatch({
      toolCallId: "call-cancel",
      params: { prompt: "P", task: "go" },
      host,
      cohortId: "cohort-cancel",
      signal: controller.signal,
    });
    await modelStarted.promise;
    assert.equal((await listedBy(fleet, host, "children")).length, 1, "registered before settling");

    controller.abort();
    gate.resolve();
    const result = await dispatched;
    assert.equal(result.isError, true);
    assert.equal(
      storedRows(dbPath).some((row) => row.parentSessionId !== null),
      false,
      "no child record survives a cancelled dispatch",
    );
    assert.deepEqual(await listedBy(fleet, host, "children"), []);
  } finally {
    fleet.close();
  }
});

test("a Fleet query child registers no record of its own", async () => {
  const { root, sessionFile } = newRoot();
  const dbPath = join(root, "fleet.sqlite");
  const fleet = openFleet(root);
  try {
    registerMain(fleet, root);
    const host = mainHost(root, sessionFile);
    const modelStarted = deferred<void>();
    const gate = deferred<void>();
    faux.setResponses([
      async () => {
        modelStarted.resolve();
        await gate.promise;
        return fauxAssistantMessage("query answer");
      },
    ]);

    const answered = newEngine(fleet).runIsolatedQuery(host, {
      correlationId: "q-00000001",
      senderSessionId: "sibling-id",
      body: "What is open?",
    });
    await modelStarted.promise;

    assert.deepEqual(
      storedRows(dbPath).map((row) => row.sessionId),
      ["main-id"],
      "while the query child runs, the store holds no record for it",
    );
    assert.deepEqual(await listedBy(fleet, host, "children"), []);
    assert.deepEqual(
      (await listedBy(fleet, host, "machine")).map((session) => session.sessionId),
      ["main-id"],
    );

    gate.resolve();
    const reply = await answered;
    assert.deepEqual(reply, { text: "query answer", isError: false });
    assert.deepEqual(
      storedRows(dbPath).map((row) => row.sessionId),
      ["main-id"],
      "settling leaves the store as it was",
    );
  } finally {
    fleet.close();
  }
});

test("a followUp to a waiting child is accepted at once, and the dispatch waits for that turn", async () => {
  const { root, sessionFile } = newRoot();
  const fleet = openFleet(root);
  try {
    registerMain(fleet, root);
    const host = mainHost(root, sessionFile);
    const innerStarted = deferred<void>();
    const innerGate = deferred<void>();
    const fleetStarted = deferred<void>();
    const fleetGate = deferred<void>();
    const step: FauxResponseStep = async (context) => {
      if (JSON.stringify(context.messages[0]).includes("INNER")) {
        innerStarted.resolve();
        await innerGate.promise;
        return fauxAssistantMessage("inner done");
      }
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("[Fleet from main-id]")) {
        // The Fleet-delivered turn: it stays in flight until the test opens the gate.
        fleetStarted.resolve();
        await fleetGate.promise;
        return fauxAssistantMessage("fleet answer");
      }
      if (last.includes("Background tasks settled")) return fauxAssistantMessage("notified");
      if (last.includes('"toolResult"')) return fauxAssistantMessage("started");
      return fauxAssistantMessage(
        [fauxToolCall("Agent", { prompt: "INNER", task: "wait", background: true })],
        { stopReason: "toolUse" },
      );
    };
    faux.setResponses(Array.from({ length: 12 }, () => step));

    const dispatched = newEngine(fleet).dispatch({
      toolCallId: "call-fleet-turn",
      params: { prompt: "P", task: "Review the diff" },
      host,
      cohortId: "cohort-fleet-turn",
    });
    await waitFor(
      () => fleet.listSessions("children", root, "main-id").length === 1,
      "the child's record",
    );
    const child = must(at(fleet.listSessions("children", root, "main-id"), 0));
    const call = fleetCaller(fleet, host);

    // `/abort` starts no turn and a followUp host command applies only when the
    // target is idle (specs/fleet-tool.md#delivery-modes): its delivery is the proof that
    // the child has finished its own turn and is waiting on its background task.
    const probe = await call({ action: "send", target: child.sessionId, body: "/abort" });
    const probeId = (probe.details as { messageId: number }).messageId;
    await waitFor(
      () => fleet.getMessageStatus("main-id", probeId).status === "delivered",
      "the child to report idle",
    );

    const sent = await call({ action: "send", target: child.sessionId, body: "look again" });
    assert.equal(sent.isError, undefined, textOf(sent));
    const details = sent.details as { messageId: number; status: string };

    // The Fleet turn is under way and its model call is blocked on the gate, so
    // the delivery above was reported before that turn ended.
    await fleetStarted.promise;
    await waitFor(
      () => fleet.getMessageStatus("main-id", details.messageId).status === "delivered",
      "the child to accept the followUp for its turn",
    );
    assert.notEqual(
      fleet.getSession(child.sessionId),
      undefined,
      "the dispatch has not settled while the Fleet turn runs",
    );

    // The child's own background task settles during the Fleet turn; then the
    // Fleet turn ends. The dispatch settles only after both.
    innerGate.resolve();
    fleetGate.resolve();
    const result = await dispatched;
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(textOf(result), "notified", "the dispatch answers from the notification turn");
    assert.equal(fleet.getMessageStatus("main-id", details.messageId).status, "delivered");
    const sessionPath = must(at(resultsOf(result), 0).sessionPath);
    assert.deepEqual(userPrompts(sessionPath), [
      "Review the diff",
      "[Fleet from main-id]\nlook again",
    ]);
    assert.match(readFileSync(sessionPath, "utf8"), /fleet answer/);
    assert.equal(
      fleet.getSession(child.sessionId),
      undefined,
      "the child record goes with the settled dispatch",
    );
  } finally {
    fleet.close();
  }
});

test("a Fleet turn starting as the child's own turn ends keeps the dispatch alive", async () => {
  const { root, sessionFile } = newRoot();
  const fleet = openFleet(root);
  try {
    registerMain(fleet, root);
    const host = mainHost(root, sessionFile);
    const fleetStarted = deferred<void>();
    const fleetGate = deferred<void>();
    const taskGate = deferred<void>();
    const step: FauxResponseStep = async (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("[Fleet from main-id]")) {
        fleetStarted.resolve();
        await fleetGate.promise;
        return fauxAssistantMessage("fleet answer");
      }
      await taskGate.promise;
      return fauxAssistantMessage("own work");
    };
    faux.setResponses(Array.from({ length: 8 }, () => step));

    const dispatched = newEngine(fleet).dispatch({
      toolCallId: "call-fleet-handover",
      params: { prompt: "P", task: "Say something" },
      host,
      cohortId: "cohort-fleet-handover",
    });
    await waitFor(
      () => fleet.listSessions("children", root, "main-id").length === 1,
      "the child's record",
    );
    const child = must(at(fleet.listSessions("children", root, "main-id"), 0));
    // Queued while the child runs its own turn; it is delivered the moment that
    // turn ends, and the turn it starts is not this attempt's to end (specs/fleet-tool.md#delivery-modes).
    const sent = await fleetCaller(
      fleet,
      host,
    )({ action: "send", target: child.sessionId, body: "one more thing" });
    const messageId = (sent.details as { messageId: number }).messageId;
    taskGate.resolve();

    await fleetStarted.promise;
    assert.notEqual(
      fleet.getSession(child.sessionId),
      undefined,
      "the dispatch has not settled while the Fleet turn runs",
    );

    fleetGate.resolve();
    const result = await dispatched;
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(textOf(result), "fleet answer");
    assert.equal(fleet.getMessageStatus("main-id", messageId).status, "delivered");
    const sessionPath = must(at(resultsOf(result), 0).sessionPath);
    assert.deepEqual(userPrompts(sessionPath), [
      "Say something",
      "[Fleet from main-id]\none more thing",
    ]);
  } finally {
    fleet.close();
  }
});

test("a child registration the closed store skips warns about the store, not another owner", async () => {
  const { root, sessionFile } = newRoot();
  const fleet = openFleet(root);
  registerMain(fleet, root);
  const notices: string[] = [];
  const host = mainHost(root, sessionFile, notices);
  fleet.close();
  faux.setResponses([() => fauxAssistantMessage("done without a record")]);

  const result = await newEngine(fleet).dispatch({
    toolCallId: "call-closed",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-closed",
  });

  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done without a record");
  assert.ok(
    notices.some((notice) => notice.endsWith("skipped: the local session store is closed")),
    `expected a closed-store warning, got ${JSON.stringify(notices)}`,
  );
  assert.equal(
    notices.some((notice) => notice.includes("already owned")),
    false,
    "a closed store is not another live boot window",
  );
});

test("a child record the store refuses warns, and the dispatch still answers", async () => {
  const { root, sessionFile } = newRoot();
  const dbPath = join(root, "fleet.sqlite");
  const fleet = openFleet(root);
  try {
    registerMain(fleet, root);
    const notices: string[] = [];
    const host = mainHost(root, sessionFile, notices);

    // The store refuses only the child's record: the main session's is already written.
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "CREATE TRIGGER refuse_child_record BEFORE INSERT ON fleet_sessions WHEN NEW.parent_session_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'store refused the child record'); END",
      );
    } finally {
      db.close();
    }
    faux.setResponses([() => fauxAssistantMessage("done without a record")]);

    const result = await newEngine(fleet).dispatch({
      toolCallId: "call-refused",
      params: { prompt: "P", task: "go" },
      host,
      cohortId: "cohort-refused",
    });
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(textOf(result), "done without a record");
    assert.ok(
      notices.some((notice) =>
        /Fleet child registration failed: .*store refused the child record$/.test(notice),
      ),
      `expected a registration warning, got ${JSON.stringify(notices)}`,
    );
    assert.deepEqual(await listedBy(fleet, host, "children"), []);
    assert.deepEqual(
      storedRows(dbPath).map((row) => row.sessionId),
      ["main-id"],
    );
  } finally {
    fleet.close();
  }
});

test("a Fleet turn that starts as the task turn fails supplies the dispatch's result", async () => {
  const { root, sessionFile } = newRoot();
  const fleet = openFleet(root);
  let fleetGate: Deferred<void> | undefined;
  try {
    registerMain(fleet, root);
    const host = mainHost(root, sessionFile);
    const taskStarted = deferred<void>();
    const taskGate = deferred<void>();
    const fleetStarted = deferred<void>();
    const fleetTurn = deferred<void>();
    fleetGate = fleetTurn;
    const step: FauxResponseStep = async (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("[Fleet from main-id]")) {
        fleetStarted.resolve();
        await fleetTurn.promise;
        return fauxAssistantMessage("fleet answer");
      }
      taskStarted.resolve();
      await taskGate.promise;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" });
    };
    faux.setResponses(Array.from({ length: 6 }, () => step));

    const dispatched = newEngine(fleet).dispatch({
      toolCallId: "call-fleet-error",
      params: { prompt: "P", task: "Say something" },
      host,
      cohortId: "cohort-fleet-error",
    });
    await taskStarted.promise;
    await waitFor(
      () => fleet.listSessions("children", root, "main-id").length === 1,
      "the child's record",
    );
    const child = must(at(fleet.listSessions("children", root, "main-id"), 0));

    // Queued behind the child's own turn: it starts a turn the moment that turn ends.
    const sent = await fleetCaller(
      fleet,
      host,
    )({ action: "send", target: child.sessionId, body: "one more thing" });
    assert.equal(sent.isError, undefined, textOf(sent));
    taskGate.resolve();
    await within(fleetStarted.promise, 1000);

    // specs/agent-tool.md#child-session: the attempt MUST NOT settle while that turn runs, and
    // the dispatch's result is the last assistant message of the child's last turn.
    const settledEarly = deferred<void>();
    void dispatched.then(() => {
      settledEarly.resolve();
    });
    await new Promise((done) => setImmediate(done));
    assert.equal(
      fleet.getSession(child.sessionId)?.state,
      "running",
      "the dispatch has not settled",
    );

    fleetTurn.resolve();
    const result = await within(dispatched, 2000);
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(textOf(result), "fleet answer", "the Fleet turn's message is the result");
    assert.equal(
      fleet.getSession(child.sessionId),
      undefined,
      "the child record goes with the settled dispatch",
    );
  } finally {
    fleetGate?.resolve();
    fleet.close();
  }
});

test("a Fleet turn delivered at registration counts toward no attempt's usage", async () => {
  const { root, sessionFile } = newRoot();
  const dbPath = join(root, "fleet.sqlite");
  const fleet = openFleet(root);
  let gapGate: Deferred<void> | undefined;
  try {
    registerMain(fleet, root);
    const host = mainHost(root, sessionFile);
    // A session file to continue, whose ID the store can address before it starts.
    faux.setResponses([() => fauxAssistantMessage("first answer")]);
    const first = await newEngine(fleet).dispatch({
      toolCallId: "call-seed",
      params: { prompt: "P", task: "go" },
      host,
      cohortId: "cohort-seed",
    });
    assert.equal(first.isError, undefined, textOf(first));
    const childFile = must(at(resultsOf(first), 0).sessionPath);
    const childId = sessionIdOf(childFile);

    // A record no boot window owns (a live process, released), so the resumed registration
    // may claim it, and a followUp
    // waiting in the store: registration drains it into a turn before the first prompt.
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare(
          `INSERT OR REPLACE INTO fleet_sessions
				 (session_id, cwd, repo_root, state, updated_at, turns_json, owner_pid, owner_boot, owner_started, agents_dir, hidden, parent_session_id)
				 VALUES (?, ?, NULL, 'idle', ?, '[]', ?, NULL, ?, NULL, 0, NULL)`,
        )
        .run(childId, root, Date.now(), process.ppid, Date.now());
    } finally {
      raw.close();
    }
    const queued = fleet.enqueueSend({
      senderSessionId: "main-id",
      target: must(fleet.getSession(childId)),
      body: "in the gap",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(queued.status, "pending", "the message waits for the child to exist");

    const gapStarted = deferred<void>();
    const gapTurn = deferred<void>();
    gapGate = gapTurn;
    let ownCalls = 0;
    const step: FauxResponseStep = async (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("[Fleet from main-id]")) {
        gapStarted.resolve();
        await gapTurn.promise;
        return fauxAssistantMessage("gap answer");
      }
      ownCalls += 1;
      return fauxAssistantMessage("resumed answer");
    };
    faux.setResponses(Array.from({ length: 8 }, () => step));

    const dispatched = newEngine(fleet).dispatch({
      toolCallId: "call-registration-gap",
      params: { prompt: "P", task: "again", resume: childFile },
      host,
      cohortId: "cohort-registration-gap",
    });
    await within(gapStarted.promise, 1000);
    gapTurn.resolve();
    const result = await within(dispatched, 2000);
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(textOf(result), "resumed answer");
    const records = recordsOf(result);
    assert.equal(must(at(records, 0)).usage.turns, 1, "the attempt counts only its own model turn");
  } finally {
    gapGate?.resolve();
    fleet.close();
  }
});

test("a refused Fleet query reply warns on the dispatching session's warning channel, starting no turn", async () => {
  const { root, sessionFile } = newRoot();
  const dbPath = join(root, "fleet.sqlite");
  const fleet = openFleet(root);
  let childGate: Deferred<void> | undefined;
  try {
    registerMain(fleet, root);
    const notices: string[] = [];
    const warnings: string[] = [];
    const base = mainHost(root, sessionFile, notices);
    const host: HostSession = {
      ...base,
      warn: (message: string) => {
        warnings.push(message);
      },
    };
    // The store refuses the child's reply to its parent (specs/fleet-tool.md#query).
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "CREATE TRIGGER refuse_reply BEFORE INSERT ON fleet_messages WHEN NEW.body LIKE '[Fleet query reply%' BEGIN SELECT RAISE(ABORT, 'store refused the reply'); END",
      );
    } finally {
      db.close();
    }

    const childStarted = deferred<void>();
    const task = deferred<void>();
    childGate = task;
    const step: FauxResponseStep = async (context) => {
      if (JSON.stringify(context.messages.at(0)).includes("Fleet query")) {
        return fauxAssistantMessage("query answer");
      }
      childStarted.resolve();
      await task.promise;
      return fauxAssistantMessage("task answer");
    };
    faux.setResponses(Array.from({ length: 8 }, () => step));

    const dispatched = newEngine(fleet).dispatch({
      toolCallId: "call-reply-failure",
      params: { prompt: "P", task: "Say something" },
      host,
      cohortId: "cohort-reply-failure",
    });
    await childStarted.promise;
    await waitFor(
      () => fleet.listSessions("children", root, "main-id").length === 1,
      "the child's record",
    );
    const child = must(at(fleet.listSessions("children", root, "main-id"), 0));

    const asked = await fleetCaller(
      fleet,
      host,
    )({ action: "query", target: child.sessionId, body: "what now?" });
    assert.equal(asked.isError, undefined, textOf(asked));

    await waitFor(
      () => warnings.some((warning) => warning.includes("Fleet query reply to main-id failed")),
      "the reply failure warning",
    );
    assert.match(
      must(warnings.find((warning) => warning.includes("Fleet query reply to main-id failed"))),
      /^pi-dent: Fleet query reply to main-id failed: .*store refused the reply/,
    );

    // The failure warns; it never injects a turn into the child's conversation.
    task.resolve();
    const result = await within(dispatched, 2000);
    assert.equal(result.isError, undefined, textOf(result));
    const sessionPath = must(at(resultsOf(result), 0).sessionPath);
    assert.deepEqual(assistantTexts(sessionPath), ["task answer"]);
  } finally {
    childGate?.resolve();
    fleet.close();
  }
});

test("a child record another live boot window owns is named to the dispatching session", async () => {
  const { root, sessionFile } = newRoot();
  const dbPath = join(root, "fleet.sqlite");
  const fleet = openFleet(root);
  const other = new FleetCoordinator(bootSnapshot(), { dbPath, bootId: "boot-other" });
  try {
    registerMain(fleet, root);
    const notices: string[] = [];
    const host = mainHost(root, sessionFile, notices);
    faux.setResponses([() => fauxAssistantMessage("first answer")]);
    const first = await newEngine(fleet).dispatch({
      toolCallId: "call-first",
      params: { prompt: "P", task: "go" },
      host,
      cohortId: "cohort-first",
    });
    assert.equal(first.isError, undefined, textOf(first));
    const childFile = must(at(resultsOf(first), 0).sessionPath);
    const childId = sessionIdOf(childFile);

    // Another live boot window owns the session the continuation ends up in.
    other.registerEndpoint(
      {
        sessionId: childId,
        cwd: () => root,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );

    faux.setResponses([() => fauxAssistantMessage("resumed answer")]);
    const resumed = await newEngine(fleet).dispatch({
      toolCallId: "call-resumed",
      params: { prompt: "P", task: "again", resume: childFile },
      host,
      cohortId: "cohort-resumed",
    });
    assert.equal(resumed.isError, undefined, textOf(resumed));
    assert.equal(textOf(resumed), "resumed answer", "a refused record does not fail the dispatch");
    assert.ok(
      notices.some((notice) =>
        notice.includes(
          `session ${childId} is already owned by another live boot window; Fleet delivery to this session is disabled`,
        ),
      ),
      `expected the owned-record warning, got ${JSON.stringify(notices)}`,
    );
    assert.deepEqual(await listedBy(fleet, host, "children"), []);
  } finally {
    other.close();
    fleet.close();
  }
});

test("a refused child's waited query fails instead of waiting for a reply", async () => {
  const { root, sessionFile } = newRoot();
  const dbPath = join(root, "fleet.sqlite");
  const fleet = openFleet(root);
  const other = new FleetCoordinator(bootSnapshot(), { dbPath, bootId: "boot-other" });
  try {
    registerMain(fleet, root);
    const host = mainHost(root, sessionFile);
    other.registerEndpoint(
      {
        sessionId: "child-1",
        cwd: () => root,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );
    assert.equal(
      fleet.registerChild("main-id", refusedEndpoint("child-1", root), "task"),
      "refused",
      "another live boot window owns the child's record",
    );

    const childHost: HostSession = { ...host, sessionId: () => "child-1" };
    const queried = await fleetCaller(
      fleet,
      childHost,
    )({ action: "query", target: "main-id", body: "anyone?" });
    assert.equal(queried.isError, true);
    assert.match(
      textOf(queried),
      /^Fleet query failed: session child-1 is owned by another live boot window$/,
    );
    assert.deepEqual(storedMessageRows(dbPath, "main-id"), [], "no query was enqueued");
  } finally {
    other.close();
    fleet.close();
  }
});

test("a liveness expiry during the wait for a Fleet turn fails the dispatch with timeout", async () => {
  const { root, sessionFile } = newRoot();
  const dbPath = join(root, "fleet.sqlite");
  const fleet = openFleet(root);
  let gapGate: Deferred<void> | undefined;
  try {
    registerMain(fleet, root);
    const host = mainHost(root, sessionFile);
    // A session file to continue, whose ID the store can address before it starts.
    faux.setResponses([() => fauxAssistantMessage("first answer")]);
    const first = await newEngine(fleet).dispatch({
      toolCallId: "call-timeout-seed",
      params: { prompt: "P", task: "go" },
      host,
      cohortId: "cohort-timeout-seed",
    });
    assert.equal(first.isError, undefined, textOf(first));
    const childFile = must(at(resultsOf(first), 0).sessionPath);
    const childId = sessionIdOf(childFile);

    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare(
          `INSERT OR REPLACE INTO fleet_sessions
				 (session_id, cwd, repo_root, state, updated_at, turns_json, owner_pid, owner_boot, owner_started, agents_dir, hidden, parent_session_id)
				 VALUES (?, ?, NULL, 'idle', ?, '[]', ?, NULL, ?, NULL, 0, NULL)`,
        )
        .run(childId, root, Date.now(), process.ppid, Date.now());
    } finally {
      raw.close();
    }
    fleet.enqueueSend({
      senderSessionId: "main-id",
      target: must(fleet.getSession(childId)),
      body: "in the gap",
      deliver: "followUp",
      abort: false,
    });

    // The followUp drained at registration starts a turn that never answers, so the
    // idle deadline expires while the dispatch waits for it (specs/agent-tool.md#child-session).
    const gapStarted = deferred<void>();
    const gapTurn = deferred<void>();
    gapGate = gapTurn;
    const step: FauxResponseStep = async () => {
      gapStarted.resolve();
      await gapTurn.promise;
      return fauxAssistantMessage("too late");
    };
    faux.setResponses(Array.from({ length: 4 }, () => step));

    const base = bootSnapshot();
    const dispatched = newEngine(fleet, {
      config: { ...base.config, liveness: { idleTimeoutMs: 50, absoluteTimeoutMs: 0 } },
    }).dispatch({
      toolCallId: "call-timeout-gap",
      params: { prompt: "P", task: "again", resume: childFile },
      host,
      cohortId: "cohort-timeout-gap",
    });
    await within(gapStarted.promise, 1000);
    const result = await within(dispatched, 2000);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Agent timeout: idle timeout after 50ms/);
    const record = must(at(recordsOf(result), 0));
    assert.equal(record.status, "failed", "a liveness expiry is a failure, not a cancellation");
    assert.equal(record.failureCode, "timeout");
    assert.equal(record.stopReason, "timeout");
  } finally {
    gapGate?.resolve();
    fleet.close();
  }
});

test("a Fleet send with abort starts the turn that supplies the dispatch's result", async () => {
  const { root, sessionFile } = newRoot();
  const fleet = openFleet(root);
  let taskGate: Deferred<void> | undefined;
  try {
    registerMain(fleet, root);
    const host = mainHost(root, sessionFile);
    const taskStarted = deferred<void>();
    const taskTurn = deferred<void>();
    taskGate = taskTurn;
    const step: FauxResponseStep = async (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("[Fleet from main-id]")) {
        return fauxAssistantMessage("steered answer");
      }
      taskStarted.resolve();
      await taskTurn.promise;
      return fauxAssistantMessage("own work");
    };
    faux.setResponses(Array.from({ length: 6 }, () => step));

    const dispatched = newEngine(fleet).dispatch({
      toolCallId: "call-abort-send",
      params: { prompt: "P", task: "Say something" },
      host,
      cohortId: "cohort-abort-send",
    });
    await taskStarted.promise;
    await waitFor(
      () => fleet.listSessions("children", root, "main-id").length === 1,
      "the child's record",
    );
    const child = must(at(fleet.listSessions("children", root, "main-id"), 0));

    const sent = await fleetCaller(
      fleet,
      host,
    )({
      action: "send",
      target: child.sessionId,
      body: "take over",
      deliver: "steer",
      abort: true,
    });
    assert.equal(sent.isError, undefined, textOf(sent));
    const messageId = (sent.details as { messageId: number }).messageId;
    taskTurn.resolve();

    // specs/agent-tool.md#child-session: the steer's turn starts after the abort and supplies
    // the dispatch's result like any last turn.
    const result = await within(dispatched, 2000);
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(textOf(result), "steered answer");
    await waitFor(
      () => fleet.getMessageStatus("main-id", messageId).status === "delivered",
      "the steered message to be delivered",
    );
  } finally {
    taskGate?.resolve();
    fleet.close();
  }
});

test("a Fleet abort host command on the child settles the dispatch cancelled", async () => {
  const { root, sessionFile } = newRoot();
  const fleet = openFleet(root);
  let taskGate: Deferred<void> | undefined;
  try {
    registerMain(fleet, root);
    const host = mainHost(root, sessionFile);
    const taskStarted = deferred<void>();
    const taskTurn = deferred<void>();
    taskGate = taskTurn;
    const step: FauxResponseStep = async () => {
      taskStarted.resolve();
      await taskTurn.promise;
      return fauxAssistantMessage("own work");
    };
    faux.setResponses(Array.from({ length: 4 }, () => step));

    const dispatched = newEngine(fleet).dispatch({
      toolCallId: "call-abort-command",
      params: { prompt: "P", task: "Say something" },
      host,
      cohortId: "cohort-abort-command",
    });
    await taskStarted.promise;
    await waitFor(
      () => fleet.listSessions("children", root, "main-id").length === 1,
      "the child's record",
    );
    const child = must(at(fleet.listSessions("children", root, "main-id"), 0));

    const sent = await fleetCaller(
      fleet,
      host,
    )({ action: "send", target: child.sessionId, body: "/abort", deliver: "steer" });
    assert.equal(sent.isError, undefined, textOf(sent));
    taskTurn.resolve();

    // The abort command carries no message, so the attempt ends on the aborted turn
    // (specs/agent-tool.md#child-session): its error message is no execution error.
    const result = await within(dispatched, 2000);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Agent aborted: /);
    const record = must(at(recordsOf(result), 0));
    assert.equal(record.status, "cancelled");
    assert.equal(record.failureCode, "aborted");
  } finally {
    taskGate?.resolve();
    fleet.close();
  }
});

test("a dispatch that resumes this window's own session leaves its record untouched", async () => {
  const { root, sessionFile } = newRoot();
  const dbPath = join(root, "fleet.sqlite");
  const fleet = openFleet(root);
  try {
    // The main session's own file, carrying the main session's ID, as a resume source.
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: "session", id: "main-id", version: 3, cwd: root, timestamp: Date.now() })}\n`,
    );
    fleet.registerEndpoint(
      {
        sessionId: "main-id",
        cwd: () => root,
        isIdle: () => false,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "running",
    );
    const before = storedState(dbPath, "main-id");
    const notices: string[] = [];
    const host = mainHost(root, sessionFile, notices);
    faux.setResponses([() => fauxAssistantMessage("resumed answer")]);

    const result = await newEngine(fleet).dispatch({
      toolCallId: "call-own",
      params: { prompt: "P", task: "again", resume: sessionFile },
      host,
      cohortId: "cohort-own",
    });
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(textOf(result), "resumed answer");
    assert.ok(
      notices.some((notice) => notice.includes("is this boot window's own session")),
      `expected the own-session warning, got ${JSON.stringify(notices)}`,
    );
    assert.equal(
      must(fleet.getSession("main-id")).parentSessionId,
      undefined,
      "the main session is no child session",
    );
    assert.deepEqual(
      storedState(dbPath, "main-id"),
      before,
      "the main session's record is not written by the child dispatch's turns",
    );
  } finally {
    fleet.close();
  }
});
