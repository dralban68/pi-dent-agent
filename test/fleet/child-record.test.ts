import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  DispatchEngine,
  agentsDirFor,
  type BootSnapshot,
  type ToolResult,
} from "../../lib/engine.ts";
import { FleetCoordinator } from "../../lib/fleet.ts";
import type { HostSession } from "../../lib/host.ts";
import { makeFleetTool } from "../../lib/tools.ts";
import { engineDeps } from "../support/engine-deps.ts";
import { at, must } from "../support/must.ts";

/**
 * specs/session-store.md Section 4 and specs/agent-tool.md Sections 4.2 and 10:
 * the boot window that runs a dispatch writes the child session record once the
 * child session exists and before its first prompt — with `parent_session_id`,
 * `state` `running` and the child's agent directory — keeps it across recovery
 * attempts, and deletes it when the dispatch settles, in both delivery modes.
 * Child sessions run on a scripted faux provider; the fleet is the real
 * coordinator over a temporary store (specs/fleet-tool.md Section 2).
 */

// --- Runtime harness: the same faux wiring as test/fleet/child-dispatch.test.ts ---

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "pi-dent-child-record-"));
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

function bootSnapshot(maxRecoveryRetries = 0): BootSnapshot {
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
    maxRecoveryRetries,
    sessionTtlDays: 30,
  } as unknown as BootSnapshot;
}

/** A fresh temp root holding the main session at `<root>/main/main.jsonl`. */
function newRoot(): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-child-record-"));
  roots.push(root);
  const dir = join(root, "main");
  mkdirSync(dir, { recursive: true });
  return { root, sessionFile: join(dir, "main.jsonl") };
}

/** The main session's host: it has the `Agent` and `Fleet` tools. */
function mainHost(root: string, sessionFile: string): HostSession {
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
    notify: () => {},
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

function newEngine(fleet: FleetCoordinator, maxRecoveryRetries = 0): DispatchEngine {
  return new DispatchEngine(
    bootSnapshot(maxRecoveryRetries),
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

/** A `Fleet` tool call made by the session whose host is `host`. */
function fleetCaller(fleet: FleetCoordinator, host: HostSession) {
  const tool = makeFleetTool({ fleet, hostProvider: () => host });
  return (params: Record<string, unknown>) =>
    tool.execute("tc", params as never, undefined, undefined, undefined as never);
}

interface ListedSession {
  sessionId: string;
  state: string;
  parent?: string | undefined;
}

/** The sessions a `list` of `scope` shows the calling session `main-id`. */
async function listedBy(
  fleet: FleetCoordinator,
  host: HostSession,
  scope: "children" | "machine",
): Promise<ListedSession[]> {
  const listed = await fleetCaller(fleet, host)({ action: "list", scope, format: "json" });
  return (listed.details as { sessions: ListedSession[] }).sessions;
}

interface StoredRow {
  sessionId: string;
  state: string;
  parentSessionId: string | null;
  agentsDir: string | null;
}

/** Every session record in the store, read directly (session-store.md Section 2). */
function storedRows(dbPath: string): StoredRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        "SELECT session_id, state, parent_session_id, agents_dir FROM fleet_sessions ORDER BY session_id",
      )
      .all()
      .map((row) => ({
        sessionId: typeof row.session_id === "string" ? row.session_id : "",
        state: typeof row.state === "string" ? row.state : "",
        parentSessionId: typeof row.parent_session_id === "string" ? row.parent_session_id : null,
        agentsDir: typeof row.agents_dir === "string" ? row.agents_dir : null,
      }));
  } finally {
    db.close();
  }
}

/** The child session records of the store (session-store.md Section 4). */
function childRows(dbPath: string): StoredRow[] {
  return storedRows(dbPath).filter((row) => row.parentSessionId !== null);
}

// --- Tests -----------------------------------------------------------------

test("a background dispatch's child record is deleted when the dispatch settles", async () => {
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
        return fauxAssistantMessage("background answer");
      },
    ]);

    const started = await newEngine(fleet).dispatch({
      toolCallId: "call-background",
      params: { prompt: "P", task: "go", background: true },
      host,
      cohortId: "cohort-background",
    });
    assert.equal(started.isError, undefined, textOf(started));
    assert.match(textOf(started), /started in background/, "the call reported the started task");
    assert.equal(
      (started.details as { background?: boolean }).background,
      true,
      "the call returned before the dispatch settled",
    );

    await modelStarted.promise;
    const [child, ...others] = await listedBy(fleet, host, "children");
    assert.equal(others.length, 0, "the parent sees exactly its one child");
    assert.equal(must(child).parent, "main-id");
    const live = childRows(dbPath);
    assert.equal(live.length, 1, "the child's record exists while its model is blocked");
    const record = must(at(live, 0));
    assert.equal(record.sessionId, must(child).sessionId);
    assert.equal(record.parentSessionId, "main-id");
    assert.equal(record.state, "running", "the child record's state stays running");

    gate.resolve();
    await waitFor(() => childRows(dbPath).length === 0, "the settled dispatch's child record");
    assert.deepEqual(
      storedRows(dbPath).map((row) => row.sessionId),
      ["main-id"],
      "the settled dispatch leaves no child record",
    );
  } finally {
    fleet.close();
  }
});

test("a recovery attempt keeps the child session record", async () => {
  const { root, sessionFile } = newRoot();
  const dbPath = join(root, "fleet.sqlite");
  const fleet = openFleet(root);
  try {
    registerMain(fleet, root);
    const host = mainHost(root, sessionFile);
    const secondStarted = deferred<void>();
    const gate = deferred<void>();
    let firstAttemptIds: string[] = [];
    faux.setResponses([
      () => {
        firstAttemptIds = childRows(dbPath).map((row) => row.sessionId);
        // The auto-resume class of Section 8: transient, not on the non-transient list.
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "429 rate limit exceeded",
        });
      },
      async () => {
        secondStarted.resolve();
        await gate.promise;
        return fauxAssistantMessage("recovered answer");
      },
    ]);

    const dispatched = newEngine(fleet, 1).dispatch({
      toolCallId: "call-recovery",
      params: { prompt: "P", task: "go" },
      host,
      cohortId: "cohort-recovery",
    });
    await secondStarted.promise;

    const duringRetry = childRows(dbPath);
    assert.equal(duringRetry.length, 1, "the recovery attempt keeps the child session record");
    const child = must(at(duringRetry, 0));
    assert.equal(child.parentSessionId, "main-id");
    assert.deepEqual(
      firstAttemptIds,
      [child.sessionId],
      "the recovery attempt continues the same child session",
    );

    gate.resolve();
    const result = await dispatched;
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(textOf(result), "recovered answer", "the recovery attempt answered");
    assert.deepEqual(
      storedRows(dbPath).map((row) => row.sessionId),
      ["main-id"],
      "the settled dispatch leaves no child record",
    );
  } finally {
    fleet.close();
  }
});

test("a live child record carries the child's agent directory", async () => {
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
        return fauxAssistantMessage("done");
      },
    ]);

    const dispatched = newEngine(fleet).dispatch({
      toolCallId: "call-agents-dir",
      params: { prompt: "P", task: "go" },
      host,
      cohortId: "cohort-agents-dir",
    });
    await modelStarted.promise;

    const child = must(at(childRows(dbPath), 0));
    const childAgentsDir = must(child.agentsDir);
    const mainAgentsDir = agentsDirFor(sessionFile, "main-id");
    assert.ok(isAbsolute(childAgentsDir), `${childAgentsDir} is absolute`);
    assert.ok(existsSync(childAgentsDir), `${childAgentsDir} exists`);
    assert.ok(
      childAgentsDir.startsWith(`${mainAgentsDir}${sep}`),
      `${childAgentsDir} lies inside the main session's agent directory ${mainAgentsDir}`,
    );

    gate.resolve();
    const result = await dispatched;
    assert.equal(result.isError, undefined, textOf(result));
  } finally {
    fleet.close();
  }
});
