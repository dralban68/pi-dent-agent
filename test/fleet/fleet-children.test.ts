import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BootSnapshot } from "../../lib/engine.ts";
import {
  FleetCoordinator,
  type FleetDeliverMode,
  type FleetEndpoint,
  type FleetSessionRecord,
} from "../../lib/fleet.ts";
import type { HostSession } from "../../lib/host.ts";
import { makeFleetTool } from "../../lib/tools.ts";
import { at, must } from "../support/must.ts";

/**
 * specs/fleet-tool.md#parameter-schema, specs/fleet-tool.md#list and specs/fleet-tool.md#query over the child session of
 * specs/session-store.md#membership-lifecycle: the boot window that runs a dispatch writes
 * a child session record, only the dispatching session may reach it, `list` of
 * scope `children` shows it, and a waited query keeps that record as its address
 * (a hidden record is only the fallback).
 */

function emptyBoot(cwd: string): BootSnapshot {
  return {
    cwd,
    config: {
      merged: {},
      layers: {},
      projectRoot: cwd,
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
    maxRecoveryRetries: 2,
    sessionTtlDays: 30,
  };
}

function stubHost(sessionId: string, cwd: string): HostSession {
  return {
    cwd: () => cwd,
    sessionId: () => sessionId,
    sessionFile: () => undefined,
    sessionDir: () => cwd,
    model: () => undefined,
    thinking: () => undefined,
    activeTools: () => ["Agent", "Task", "Plugin", "Fleet"],
    inventory: () => [],
    configuredModels: () => [],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
}

interface ToolResultLike {
  content: Array<{ type: string; text?: string }>;
  details: unknown;
  isError?: boolean;
}

/** The text of a tool result (single text block). */
function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  const first = res.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

/** A `Fleet` tool call issued by `sessionId` in this boot window. */
function toolCaller(
  fleet: FleetCoordinator,
  sessionId: string,
  cwd: string,
): (params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResultLike> {
  const tool = makeFleetTool({ fleet, hostProvider: () => stubHost(sessionId, cwd) });
  return (params, signal) =>
    tool.execute("tc", params as never, signal, undefined, undefined as never);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    settle = res;
  });
  return { promise, resolve: settle };
}

interface FakeEndpoint {
  inbox: Array<{ text: string; mode: FleetDeliverMode }>;
  builtins: string[];
  aborts(): number;
  setRunning(running: boolean): void;
  endpoint: FleetEndpoint;
}

/** A session endpoint whose idleness the test drives. */
function fakeEndpoint(
  sessionId: string,
  cwd: string,
  opts: { runQuery?: FleetEndpoint["runQuery"]; agentsDir?: string } = {},
): FakeEndpoint {
  const inbox: Array<{ text: string; mode: FleetDeliverMode }> = [];
  const builtins: string[] = [];
  let aborts = 0;
  let running = false;
  const endpoint: FleetEndpoint = {
    sessionId,
    ...(opts.agentsDir === undefined ? {} : { agentsDir: opts.agentsDir }),
    cwd: () => cwd,
    isIdle: () => !running,
    abortTurn: () => {
      aborts += 1;
    },
    deliverTurn: (text, mode) => {
      inbox.push({ text, mode });
    },
    runBuiltinCommand: (name) => {
      if (name !== "compact" && name !== "abort") return false;
      builtins.push(name);
      return true;
    },
    ...(opts.runQuery === undefined ? {} : { runQuery: opts.runQuery }),
  };
  return {
    inbox,
    builtins,
    aborts: () => aborts,
    setRunning: (value) => {
      running = value;
    },
    endpoint,
  };
}

/** A directory with a `.git` entry: a repository root for the listing scopes. */
function repositoryAt(path: string): string {
  mkdirSync(join(path, ".git"), { recursive: true });
  return path;
}

interface RawSessionRow {
  hidden: number;
  parentSessionId: string | null;
  state: string;
  cwd: string;
}

function rawSession(dbPath: string, sessionId: string): RawSessionRow | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        "SELECT hidden, parent_session_id, state, cwd FROM fleet_sessions WHERE session_id = ?",
      )
      .get(sessionId);
    if (row === undefined) return undefined;
    return {
      hidden: typeof row.hidden === "number" ? row.hidden : 0,
      parentSessionId: typeof row.parent_session_id === "string" ? row.parent_session_id : null,
      state: typeof row.state === "string" ? row.state : "",
      cwd: typeof row.cwd === "string" ? row.cwd : "",
    };
  } finally {
    db.close();
  }
}

function sessionCount(dbPath: string, sessionId: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM fleet_sessions WHERE session_id = ?")
      .get(sessionId);
    return typeof row?.n === "number" ? row.n : 0;
  } finally {
    db.close();
  }
}

interface RawMessageRow {
  status: string;
  rejection_reason: string | null;
  body: string;
}

function messageRows(dbPath: string, targetSessionId: string): RawMessageRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        "SELECT status, rejection_reason, body FROM fleet_messages WHERE target_session_id = ? ORDER BY message_id ASC",
      )
      .all(targetSessionId)
      .map((row) => ({
        status: typeof row.status === "string" ? row.status : "",
        rejection_reason: typeof row.rejection_reason === "string" ? row.rejection_reason : null,
        body: typeof row.body === "string" ? row.body : "",
      }));
  } finally {
    db.close();
  }
}

/**
 * A child session record as another boot window left it: read after this
 * coordinator opened the store, so only a listing or a resolution touches it.
 */
function plantChildRecord(
  dbPath: string,
  sessionId: string,
  parentSessionId: string,
  cwd: string,
  ownerBoot: string,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO fleet_sessions
				 (session_id, cwd, repo_root, state, updated_at, turns_json, owner_pid, owner_boot, owner_started, agents_dir, hidden, parent_session_id)
				 VALUES (?, ?, NULL, 'running', ?, '[]', ?, ?, 1, NULL, 0, ?)`,
    ).run(sessionId, cwd, Date.now(), process.pid, ownerBoot, parentSessionId);
  } finally {
    db.close();
  }
}

function idsOf(sessions: readonly FleetSessionRecord[]): string[] {
  return sessions.map((session) => session.sessionId);
}

/** The resolved session ID, failing with the resolution error otherwise. */
function targetOf(result: { session: FleetSessionRecord } | { error: string }): string {
  if ("error" in result) assert.fail(result.error);
  return result.session.sessionId;
}

function errorOf(result: { session: FleetSessionRecord } | { error: string }): string {
  if ("session" in result) assert.fail(`expected no target, resolved ${result.session.sessionId}`);
  return result.error;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

test("a child record carries its parent, its dispatch task and a running state", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-record-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const child = fakeEndpoint("child-1", dir);

    assert.equal(
      fleet.registerChild("parent-sess", child.endpoint, "Fix the bug\nand say why"),
      "registered",
    );

    const record = must(fleet.getSession("child-1"));
    assert.equal(record.parentSessionId, "parent-sess");
    assert.equal(record.hidden, false, "a child record is not a hidden record");
    assert.equal(record.state, "running");
    assert.equal(record.cwd, resolve(dir));
    assert.equal(record.turns.length, 1, "the dispatch task is the record's one turn");
    assert.equal(must(at(record.turns, 0)).command, "Fix the bug");
    assert.equal(must(at(record.turns, 0)).goal, "");
    assert.deepEqual(idsOf(fleet.listSessions("children", dir, "parent-sess")), ["child-1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repeated dispatch of the same child keeps one turn: the dispatch task", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-recover-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const child = fakeEndpoint("child-1", dir);

    fleet.registerChild("parent-sess", child.endpoint, "Fix the bug");
    // A recovery attempt continues the same child session and rewrites the same
    // one turn record (specs/session-store.md#membership-lifecycle).
    fleet.registerChild("parent-sess", child.endpoint, "Fix the bug again\nand why");

    const record = must(fleet.getSession("child-1"));
    assert.equal(record.parentSessionId, "parent-sess");
    assert.equal(record.turns.length, 1, "exactly one turn record");
    assert.equal(must(at(record.turns, 0)).command, "Fix the bug again");
    assert.equal(sessionCount(dbPath, "child-1"), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child session another live boot window owns is refused, and still a child", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-owner-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const owner = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-owner" });
    t.after(() => owner.close());
    owner.registerEndpoint(fakeEndpoint("child-1", dir).endpoint, "idle");

    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-other" });
    t.after(() => fleet.close());
    const parent = fakeEndpoint("parent-sess", dir);
    fleet.registerEndpoint(parent.endpoint, "idle");
    const refused = fakeEndpoint("child-1", join(dir, "child-cwd"));

    assert.equal(
      fleet.registerChild("parent-sess", refused.endpoint, "task"),
      "refused",
      "another live boot window owns the record",
    );

    const record = must(fleet.getSession("child-1"));
    assert.equal(record.parentSessionId, undefined, "the refused registration writes nothing");
    assert.equal(record.cwd, resolve(dir));
    assert.deepEqual(record.turns, []);
    assert.equal(refused.inbox.length, 0, "the refusing window delivers nothing");

    // Refused the record, but the session is a child session all the same: it is
    // never refused send or query (specs/fleet-tool.md#parameter-schema).
    const sent = await toolCaller(
      fleet,
      "child-1",
      dir,
    )({ action: "send", target: "parent-sess", body: "still here" });
    assert.equal(sent.isError, undefined, textOf(sent));
    assert.equal((sent.details as { status: string }).status, "delivered");
    assert.deepEqual(parent.inbox, [
      { text: "[Fleet from child-1]\nstill here", mode: "followUp" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child session is not a fleet session: absent from the machine and repo scopes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-scopes-"));
  try {
    const repoDir = repositoryAt(join(dir, "repo"));
    const looseDir = join(dir, "loose");
    mkdirSync(looseDir, { recursive: true });
    const fleet = new FleetCoordinator(emptyBoot(repoDir), {
      dbPath: join(dir, "fleet.sqlite"),
    });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", repoDir).endpoint, "idle");
    fleet.registerChild("parent-sess", fakeEndpoint("child-1", looseDir).endpoint, "task");

    assert.deepEqual(idsOf(fleet.listSessions("machine", repoDir)), ["parent-sess"]);
    assert.deepEqual(idsOf(fleet.listSessions("repo", repoDir)), ["parent-sess"]);
    assert.deepEqual(idsOf(fleet.listSessions("children", repoDir, "parent-sess")), ["child-1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the children scope lists the calling session's direct children, whatever their repository", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-anyrepo-"));
  try {
    const repoDir = repositoryAt(join(dir, "repo"));
    const otherRepo = repositoryAt(join(dir, "other"));
    const looseDir = join(dir, "loose");
    mkdirSync(looseDir, { recursive: true });
    const fleet = new FleetCoordinator(emptyBoot(repoDir), {
      dbPath: join(dir, "fleet.sqlite"),
    });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", repoDir).endpoint, "idle");
    fleet.registerChild("parent-sess", fakeEndpoint("child-alpha", otherRepo).endpoint, "alpha");
    fleet.registerChild("parent-sess", fakeEndpoint("child-beta", looseDir).endpoint, "beta");

    const children = fleet.listSessions("children", repoDir, "parent-sess");
    assert.deepEqual(idsOf(children), ["child-alpha", "child-beta"]);
    assert.deepEqual(
      children.map((child) => child.state),
      ["running", "running"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the children scope lists no grandchildren and no other session's children", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-direct-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    fleet.registerEndpoint(fakeEndpoint("other-parent", dir).endpoint, "idle");
    fleet.registerChild("parent-sess", fakeEndpoint("child-alpha", dir).endpoint, "alpha");
    fleet.registerChild("parent-sess", fakeEndpoint("child-beta", dir).endpoint, "beta");
    fleet.registerChild("child-alpha", fakeEndpoint("grand-gamma", dir).endpoint, "gamma");
    fleet.registerChild("other-parent", fakeEndpoint("child-zulu", dir).endpoint, "zulu");

    assert.deepEqual(idsOf(fleet.listSessions("children", dir, "parent-sess")), [
      "child-alpha",
      "child-beta",
    ]);
    assert.deepEqual(idsOf(fleet.listSessions("children", dir, "child-alpha")), ["grand-gamma"]);
    assert.deepEqual(idsOf(fleet.listSessions("children", dir, "other-parent")), ["child-zulu"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the children scope omits a child whose owner boot window is gone, without deleting it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-gone-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    t.after(() => fleet.close());
    plantChildRecord(dbPath, "child-live", "parent-sess", dir, fleet.bootId);
    plantChildRecord(dbPath, "child-gone", "parent-sess", dir, "boot-window-that-is-gone");

    assert.deepEqual(idsOf(fleet.listSessions("children", dir, "parent-sess")), ["child-live"]);
    assert.equal(sessionCount(dbPath, "child-live"), 1);
    assert.equal(
      sessionCount(dbPath, "child-gone"),
      1,
      "a listing omits a gone record, it does not delete it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a parent resolves its child by exact session ID and by unique prefix", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-resolve-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    fleet.registerChild("parent-sess", fakeEndpoint("child-alpha", dir).endpoint, "alpha");
    fleet.registerChild("parent-sess", fakeEndpoint("child-beta", dir).endpoint, "beta");

    assert.equal(targetOf(fleet.resolveRecipient("child-alpha", "parent-sess")), "child-alpha");
    assert.equal(targetOf(fleet.resolveRecipient("child-b", "parent-sess")), "child-beta");
    assert.equal(targetOf(fleet.resolveRecipient("  child-a  ", "parent-sess")), "child-alpha");
    assert.equal(
      errorOf(fleet.resolveRecipient("child-", "parent-sess")),
      'ambiguous target prefix "child-" matches child-alpha, child-beta',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child is an unknown target for every session but its parent", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-foreign-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    fleet.registerEndpoint(fakeEndpoint("other-sess", dir).endpoint, "idle");
    fleet.registerChild("parent-sess", fakeEndpoint("child-alpha", dir).endpoint, "alpha");

    assert.equal(
      errorOf(fleet.resolveRecipient("child-alpha", "other-sess")),
      'unknown target session "child-alpha"',
    );
    assert.equal(
      errorOf(fleet.resolveRecipient("child-a", "other-sess")),
      'unknown target session "child-a"',
    );
    assert.equal(
      errorOf(fleet.resolveRecipient("child-alpha")),
      'unknown target session "child-alpha"',
      "a caller with no session ID is not the parent",
    );
    assert.equal(targetOf(fleet.resolveRecipient("child-alpha", "parent-sess")), "child-alpha");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child of another session neither resolves nor makes a prefix ambiguous", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-ambiguity-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    fleet.registerEndpoint(fakeEndpoint("other-parent", dir).endpoint, "idle");
    fleet.registerEndpoint(fakeEndpoint("shared-alpha-fleet", dir).endpoint, "idle");
    fleet.registerChild("parent-sess", fakeEndpoint("shared-alpha-mine", dir).endpoint, "mine");
    fleet.registerChild(
      "other-parent",
      fakeEndpoint("shared-alpha-theirs", dir).endpoint,
      "theirs",
    );

    // Filtered out before resolution: the other parent's child is no target at all.
    assert.equal(
      errorOf(fleet.resolveRecipient("shared-alpha-theirs", "parent-sess")),
      'unknown target session "shared-alpha-theirs"',
    );
    // Filtered out before ambiguity: it is not among the matches reported.
    assert.equal(
      errorOf(fleet.resolveRecipient("shared-alpha", "parent-sess")),
      'ambiguous target prefix "shared-alpha" matches shared-alpha-fleet, shared-alpha-mine',
    );
    assert.equal(
      errorOf(fleet.resolveRecipient("shared-alpha", "other-parent")),
      'ambiguous target prefix "shared-alpha" matches shared-alpha-fleet, shared-alpha-theirs',
    );
    // A prefix only one's own child carries resolves for that parent alone.
    assert.equal(
      targetOf(fleet.resolveRecipient("shared-alpha-m", "parent-sess")),
      "shared-alpha-mine",
    );
    assert.equal(
      errorOf(fleet.resolveRecipient("shared-alpha-m", "other-parent")),
      'unknown target session "shared-alpha-m"',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("steer reaches a running child's turn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-steer-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const child = fakeEndpoint("child-1", dir);
    child.setRunning(true);
    fleet.registerChild("parent-sess", child.endpoint, "task");
    const call = toolCaller(fleet, "parent-sess", dir);

    const sent = await call({
      action: "send",
      target: "child-1",
      body: "look here",
      deliver: "steer",
    });

    assert.equal(sent.isError, undefined);
    const details = sent.details as { target: string; status: string; deliver: string };
    assert.equal(details.target, "child-1");
    assert.equal(details.deliver, "steer");
    assert.equal(details.status, "delivered");
    assert.deepEqual(child.inbox, [{ text: "[Fleet from parent-sess]\nlook here", mode: "steer" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("followUp to a running child waits until the child is idle", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-followup-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const child = fakeEndpoint("child-1", dir);
    child.setRunning(true);
    fleet.registerChild("parent-sess", child.endpoint, "task");
    const call = toolCaller(fleet, "parent-sess", dir);

    const sent = await call({ action: "send", target: "child-1", body: "later" });
    assert.equal(sent.isError, undefined);
    const details = sent.details as { messageId: number; status: string };
    assert.equal(details.status, "pending", "a running child keeps a followUp queued");
    assert.deepEqual(child.inbox, []);

    child.setRunning(false);
    fleet.recordTurnEnd("child-1");
    assert.deepEqual(child.inbox, [{ text: "[Fleet from parent-sess]\nlater", mode: "followUp" }]);
    const status = await call({ action: "status", messageId: details.messageId });
    assert.match(
      textOf(status),
      new RegExp(
        `^messageId=${details.messageId} status=delivered target=child-1 deliveredAt=\\d+$`,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child record keeps its one turn record across turns", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-record-turns-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const child = fakeEndpoint("child-1", dir);
    child.setRunning(true);
    fleet.registerChild("parent-sess", child.endpoint, "task");
    const call = toolCaller(fleet, "parent-sess", dir);

    await call({ action: "send", target: "child-1", body: "later" });
    child.setRunning(false);
    fleet.recordTurnEnd("child-1");

    // A second turn of the child session: the record keeps the dispatch task as
    // its one turn (specs/fleet-tool.md#gaps: no later turn is recorded).
    child.setRunning(true);
    fleet.recordTurnStart("child-1", dir, "later");
    const next = await call({ action: "send", target: "child-1", body: "after that" });
    assert.equal((next.details as { status: string }).status, "pending");
    child.setRunning(false);
    fleet.recordTurnEnd("child-1");
    assert.deepEqual(child.inbox[1], {
      text: "[Fleet from parent-sess]\nafter that",
      mode: "followUp",
    });
    const record = must(fleet.getSession("child-1"));
    assert.equal(record.state, "running");
    assert.equal(record.turns.length, 1);
    assert.equal(record.turns[0]?.command, "task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("query to a child runs its dispatch and replies to the caller", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-query-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    const parent = fakeEndpoint("parent-sess", dir);
    fleet.registerEndpoint(parent.endpoint, "idle");
    const asked: string[] = [];
    const child = fakeEndpoint("child-1", dir, {
      runQuery: (query) => {
        asked.push(query.body);
        return Promise.resolve({ text: `child says ${query.body}`, isError: false });
      },
    });
    fleet.registerChild("parent-sess", child.endpoint, "task");
    const call = toolCaller(fleet, "parent-sess", dir);

    const queued = await call({ action: "query", target: "child-1", body: "who are you?" });
    assert.equal(queued.isError, undefined);
    const details = queued.details as { target: string; correlationId: string };
    assert.equal(details.target, "child-1");
    assert.deepEqual(asked, ["who are you?"]);
    assert.match(
      textOf(queued),
      new RegExp(
        `^Fleet query \\d+ enqueued to child-1 \\(correlationId: ${details.correlationId}, target state: running\\)`,
      ),
    );

    await waitFor(() => parent.inbox.length === 1, "the query reply to reach the caller");
    assert.deepEqual(parent.inbox, [
      {
        text: `[Fleet from child-1 — Query reply ${details.correlationId}]\n[Fleet query reply correlationId=${details.correlationId}]\nchild says who are you?`,
        mode: "followUp",
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a waited query keeps the child record, and ordinary messages still reach the child", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-wait-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const pending = deferred<{ text: string; isError: boolean }>();
    const asked: string[] = [];
    fleet.registerEndpoint(
      fakeEndpoint("target-sess", dir, {
        runQuery: (query) => {
          asked.push(query.body);
          return pending.promise;
        },
      }).endpoint,
      "idle",
    );
    const child = fakeEndpoint("child-1", dir);
    fleet.registerChild("parent-sess", child.endpoint, "answer questions");
    const call = toolCaller(fleet, "child-1", dir);

    const queryCall = call({ action: "query", target: "target-sess", body: "what now?" });
    await waitFor(() => asked.length === 1, "the query to reach the target");

    const waiting = rawSession(dbPath, "child-1");
    assert.equal(waiting?.hidden, 0, "the child record is the wait's address");
    assert.equal(waiting?.parentSessionId, "parent-sess");
    assert.equal(must(fleet.getSession("child-1")).parentSessionId, "parent-sess");

    const ordinary = fleet.enqueueSend({
      senderSessionId: "parent-sess",
      target: must(fleet.getSession("child-1")),
      body: "ping",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(ordinary.status, "delivered", "a child record takes ordinary messages");
    assert.deepEqual(child.inbox, [{ text: "[Fleet from parent-sess]\nping", mode: "followUp" }]);
    assert.equal(fleet.getMessageStatus("parent-sess", ordinary.messageId).status, "delivered");

    pending.resolve({ text: "the answer", isError: false });
    const answered = await queryCall;
    assert.equal(answered.isError, undefined);
    assert.equal((answered.details as { reply: string }).reply, "the answer");
    assert.equal(child.inbox.length, 1, "the reply settles the wait, it starts no turn");
    assert.equal(sessionCount(dbPath, "child-1"), 1, "the wait does not delete the child record");
    assert.equal(must(fleet.getSession("child-1")).parentSessionId, "parent-sess");

    fleet.unregisterChild("child-1");
    assert.equal(sessionCount(dbPath, "child-1"), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unregistering a child deletes its record and rejects its pending messages", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-unregister-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const child = fakeEndpoint("child-1", dir);
    child.setRunning(true);
    fleet.registerChild("parent-sess", child.endpoint, "task");
    const call = toolCaller(fleet, "parent-sess", dir);

    const sent = await call({ action: "send", target: "child-1", body: "later" });
    const messageId = (sent.details as { messageId: number }).messageId;
    assert.deepEqual(
      messageRows(dbPath, "child-1").map((row) => row.status),
      ["pending"],
      "the running child has not taken the message",
    );

    fleet.unregisterChild("child-1");

    assert.equal(sessionCount(dbPath, "child-1"), 0);
    assert.deepEqual(
      messageRows(dbPath, "child-1").map((row) => ({
        status: row.status,
        reason: row.rejection_reason,
      })),
      [{ status: "rejected", reason: "target session ended before delivery" }],
    );
    assert.equal(fleet.getMessageStatus("parent-sess", messageId).status, "rejected");
    assert.equal(
      errorOf(fleet.resolveRecipient("child-1", "parent-sess")),
      'unknown target session "child-1"',
    );
    fleet.unregisterChild("child-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a boot window that closes deletes the child records whose dispatch it ran", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-close-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const first = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-first" });
    t.after(() => first.close());
    first.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    first.registerChild("parent-sess", fakeEndpoint("child-1", dir).endpoint, "task");
    assert.equal(sessionCount(dbPath, "child-1"), 1);
    first.close();

    assert.equal(sessionCount(dbPath, "child-1"), 0, "the dispatch cannot outlive its window");
    const next = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-next" });
    t.after(() => next.close());
    assert.deepEqual(idsOf(next.listSessions("children", dir, "parent-sess")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet list of scope children needs the calling session's ID", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-identity-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const tool = makeFleetTool({ fleet, hostProvider: () => undefined });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const children = await call({ action: "list", scope: "children" });
    assert.equal(children.isError, true);
    assert.equal(textOf(children), 'no live session identity for Fleet action "list"');

    // Any other scope needs no identity of its own (specs/fleet-tool.md#parameter-schema).
    const machine = await call({ action: "list", scope: "machine" });
    assert.equal(machine.isError, undefined);
    assert.match(textOf(machine), /parent-sess · instance · idle · /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet list of scope children shows each child's parent and dispatch task", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-list-"));
  try {
    const repoDir = repositoryAt(join(dir, "repo"));
    const looseDir = join(dir, "loose");
    mkdirSync(looseDir, { recursive: true });
    const fleet = new FleetCoordinator(emptyBoot(repoDir), {
      dbPath: join(dir, "fleet.sqlite"),
    });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", repoDir).endpoint, "idle");
    fleet.registerChild(
      "parent-sess",
      fakeEndpoint("child-1", looseDir).endpoint,
      "Review the diff\nsecond line",
    );
    const call = toolCaller(fleet, "parent-sess", repoDir);

    const listed = await call({ action: "list", scope: "children", format: "json" });
    assert.equal(listed.isError, undefined);
    const details = listed.details as {
      action: string;
      scope: string;
      format: string;
      snapshot: boolean;
      sessions: Array<{
        sessionId: string;
        kind: string;
        state: string;
        cwd: string;
        parent?: string;
        turns: Array<{ command: string; goal: string; files: string[] }>;
      }>;
    };
    assert.equal(details.action, "list");
    assert.equal(details.scope, "children");
    assert.equal(details.format, "json");
    assert.equal(details.snapshot, true);
    const session = must(at(details.sessions, 0));
    assert.equal(session.sessionId, "child-1");
    assert.equal(session.kind, "instance");
    assert.equal(session.state, "running");
    assert.equal(session.cwd, resolve(looseDir));
    assert.equal(session.parent, "parent-sess");
    assert.equal("repoRoot" in session, false, "the child is in no repository");
    assert.equal(must(at(session.turns, 0)).command, "Review the diff");
    assert.equal(must(at(session.turns, 0)).goal, "");
    assert.deepEqual(must(at(session.turns, 0)).files, []);

    const compact = await call({ action: "list", scope: "children" });
    assert.equal(
      textOf(compact),
      `child-1 · instance · running · ${resolve(looseDir)} · Review the diff\n(Discovery snapshot — local machine only; carries no authoritative session age.)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet list of scope children with no children says so", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-empty-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const call = toolCaller(fleet, "parent-sess", dir);

    const listed = await call({ action: "list", scope: "children" });
    assert.equal(listed.isError, undefined);
    assert.equal(
      textOf(listed),
      "(no active sessions in children scope)\n(Discovery snapshot — local machine only; carries no authoritative session age.)",
    );
    assert.deepEqual((listed.details as { sessions: unknown[] }).sessions, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Fleet broadcast never reaches a child session", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-broadcast-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const peer = fakeEndpoint("sess-peer", dir);
    fleet.registerEndpoint(peer.endpoint, "idle");
    const child = fakeEndpoint("child-1", dir);
    fleet.registerChild("parent-sess", child.endpoint, "task");
    const call = toolCaller(fleet, "parent-sess", dir);

    const sent = await call({ action: "send", broadcast: "machine", body: "hello" });

    assert.equal(sent.isError, undefined);
    const details = sent.details as { recipients: Array<{ target: string }> };
    assert.deepEqual(
      details.recipients.map((recipient) => recipient.target),
      ["sess-peer"],
    );
    assert.deepEqual(peer.inbox, [{ text: "[Fleet from parent-sess]\nhello", mode: "followUp" }]);
    assert.deepEqual(child.inbox, [], "no broadcast scope lists a child session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("followUp reaches an idle child's conversation at once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-idle-followup-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const child = fakeEndpoint("child-1", dir);
    fleet.registerChild("parent-sess", child.endpoint, "task");
    const call = toolCaller(fleet, "parent-sess", dir);

    const sent = await call({ action: "send", target: "child-1", body: "look again" });

    assert.equal(sent.isError, undefined, textOf(sent));
    const details = sent.details as { messageId: number; status: string };
    assert.equal(details.status, "delivered", "an idle child takes the followUp at once");
    assert.deepEqual(child.inbox, [
      { text: "[Fleet from parent-sess]\nlook again", mode: "followUp" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compact and abort are host commands on a child session, wherever the child is", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-builtin-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const child = fakeEndpoint("child-1", dir);
    fleet.registerChild("parent-sess", child.endpoint, "task");
    const call = toolCaller(fleet, "parent-sess", dir);

    const compact = await call({ action: "send", target: "child-1", body: "/compact" });
    assert.equal(compact.isError, undefined, textOf(compact));
    assert.equal((compact.details as { status: string }).status, "delivered");
    assert.deepEqual(child.builtins, ["compact"], "the idle child compacts at once");
    assert.deepEqual(child.inbox, [], "a host command starts no turn");

    child.setRunning(true);
    const abort = await call({
      action: "send",
      target: "child-1",
      body: "/abort",
      deliver: "steer",
    });
    assert.equal(abort.isError, undefined, textOf(abort));
    assert.equal((abort.details as { status: string }).status, "delivered");
    assert.deepEqual(child.builtins, ["compact", "abort"], "a steer host command applies at once");
    assert.deepEqual(child.inbox, [], "aborting the child's turn injects no message");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("steer with abort: true aborts a running child's turn, then delivers into the child", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-steer-abort-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const child = fakeEndpoint("child-1", dir);
    child.setRunning(true);
    fleet.registerChild("parent-sess", child.endpoint, "task");
    const call = toolCaller(fleet, "parent-sess", dir);

    const sent = await call({
      action: "send",
      target: "child-1",
      body: "take over",
      deliver: "steer",
      abort: true,
    });

    assert.equal(sent.isError, undefined, textOf(sent));
    const details = sent.details as { messageId: number; status: string };
    assert.equal(child.aborts(), 1, "the child's active turn is aborted first");
    assert.equal(details.status, "pending", "the message waits for the aborted turn to settle");
    assert.deepEqual(child.inbox, [], "nothing is injected back to back with the abort");

    child.setRunning(false);
    fleet.recordTurnEnd("child-1");
    assert.deepEqual(child.inbox, [{ text: "[Fleet from parent-sess]\ntake over", mode: "steer" }]);
    assert.equal(fleet.getMessageStatus("parent-sess", details.messageId).status, "delivered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the poll loop delivers and sweeps while only a child record exists here", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-pollonly-"));
  try {
    t.mock.timers.enable({ apis: ["Date", "setInterval"] });
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-child-only" });
    t.after(() => fleet.close());
    const child = fakeEndpoint("child-1", dir);
    // No endpoint of its own: the child session's record is this boot window's only record.
    assert.equal(fleet.registerChild("parent-sess", child.endpoint, "task"), "registered");
    plantChildRecord(dbPath, "child-gone", "parent-sess", dir, "boot-window-that-is-gone");
    // A message another boot window enqueued: only a poll tick can bring it here.
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare(
          `INSERT INTO fleet_messages
				 (sender_session_id, target_session_id, boot_id, kind, subject, body, deliver, abort, correlation_id, status, rejection_reason, created_at, delivered_at, deliver_text)
				 VALUES (?, ?, ?, 'send', NULL, ?, 'followUp', 0, NULL, 'pending', NULL, ?, NULL, ?)`,
        )
        .run(
          "parent-sess",
          "child-1",
          "boot-elsewhere",
          "hello child",
          Date.now(),
          "[Fleet from parent-sess]\nhello child",
        );
    } finally {
      raw.close();
    }

    // Past the 250 ms poll interval many times and one 2000 ms sweep.
    t.mock.timers.tick(2600);
    assert.deepEqual(child.inbox, [
      { text: "[Fleet from parent-sess]\nhello child", mode: "followUp" },
    ]);
    assert.equal(
      sessionCount(dbPath, "child-gone"),
      0,
      "a periodic pass swept the gone owner's record",
    );
    assert.equal(sessionCount(dbPath, "child-1"), 1, "the child record stays");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live child record protects its agent directory from the sweep", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-agentdirs-"));
  try {
    const childDir = join(dir, "child-agents");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerChild(
      "parent-sess",
      fakeEndpoint("child-1", dir, { agentsDir: childDir }).endpoint,
      "task",
    );

    assert.deepEqual(fleet.liveAgentDirs(), [childDir]);
    fleet.unregisterChild("child-1");
    assert.deepEqual(fleet.liveAgentDirs(), [], "the directory goes with the child's record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child's waited query ends cancelled when its dispatch settles", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-wait-cancel-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const pending = deferred<{ text: string; isError: boolean }>();
    let asked = 0;
    fleet.registerEndpoint(
      fakeEndpoint("target-sess", dir, {
        runQuery: () => {
          asked += 1;
          return pending.promise;
        },
      }).endpoint,
      "idle",
    );
    fleet.registerChild("parent-sess", fakeEndpoint("child-1", dir).endpoint, "task");
    const queryCall = toolCaller(
      fleet,
      "child-1",
      dir,
    )({ action: "query", target: "target-sess", body: "who now?" });
    await waitFor(() => asked === 1, "the query to reach the target");

    // The child's record — and with it the only address its reply could reach —
    // goes with its dispatch, so the wait ends (specs/fleet-tool.md#waited-query).
    fleet.unregisterChild("child-1");
    const failed = await queryCall;
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /^Fleet query \d+ to target-sess failed: cancelled$/);

    pending.resolve({ text: "too late", isError: false });
    // The target's reply runs a microtask later, after the wait is gone.
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(
      messageRows(dbPath, "child-1"),
      [],
      "no reply is addressed to a child that is gone",
    );
    assert.deepEqual(
      messageRows(dbPath, "target-sess").map((row) => row.status),
      ["delivered"],
      "the query was already delivered to the target; it is never re-enqueued",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a query to a child target still running when the dispatch settles replies that it was cancelled", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-query-cancel-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const pending = deferred<{ text: string; isError: boolean }>();
    let asked = 0;
    const child = fakeEndpoint("child-1", dir, {
      runQuery: () => {
        asked += 1;
        return pending.promise;
      },
    });
    fleet.registerChild("parent-sess", child.endpoint, "task");
    const call = toolCaller(fleet, "parent-sess", dir);

    const queued = await call({ action: "query", target: "child-1", body: "are you done?" });
    assert.equal(queued.isError, undefined, textOf(queued));
    assert.equal(asked, 1, "the child's dispatch runs the query while its record is live");

    // The dispatch settles while the query still runs: its one reply is the
    // cancellation (specs/fleet-tool.md#query).
    fleet.unregisterChild("child-1");
    pending.resolve({ text: "a late answer", isError: false });
    await new Promise((done) => setImmediate(done));

    const replies = messageRows(dbPath, "parent-sess");
    assert.equal(replies.length, 1, "exactly one reply");
    assert.match(
      must(at(replies, 0)).body,
      /Query cancelled: the target session ended or reloaded\.$/,
    );
    assert.equal(must(at(replies, 0)).status, "delivered", "the caller takes the reply");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a query still pending for a child target becomes rejected when its dispatch settles", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-query-pending-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    fleet.registerChild("parent-sess", fakeEndpoint("child-1", dir).endpoint, "task");
    // A query another process enqueued, which the child has not taken yet: it is
    // still pending when its dispatch settles.
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare(
          `INSERT INTO fleet_messages
				 (sender_session_id, target_session_id, boot_id, kind, subject, body, deliver, abort, correlation_id, status, rejection_reason, created_at, delivered_at, deliver_text)
				 VALUES ('parent-sess', 'child-1', 'boot-elsewhere', 'query', NULL, 'anyone?', 'followUp', 0, 'q-0000ab12', 'pending', NULL, ?, NULL, NULL)`,
        )
        .run(Date.now());
    } finally {
      raw.close();
    }
    assert.deepEqual(
      messageRows(dbPath, "child-1").map((row) => row.status),
      ["pending"],
      "the child has not taken the query",
    );

    fleet.unregisterChild("child-1");

    assert.deepEqual(
      messageRows(dbPath, "child-1").map((row) => ({
        status: row.status,
        reason: row.rejection_reason,
      })),
      [{ status: "rejected", reason: "target session ended before delivery" }],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plugin command sent to a child renders against the dispatching boot window's catalog", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-plugin-"));
  try {
    const pluginDir = join(dir, "plugin-rx");
    mkdirSync(join(pluginDir, "commands"), { recursive: true });
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "rx" }));
    writeFileSync(join(pluginDir, "commands", "ping.md"), "Pong: $1");
    const boot = emptyBoot(dir);
    boot.pluginIndex.set("rx", {
      name: "rx",
      root: pluginDir,
      commands: [{ name: "ping", file: join(pluginDir, "commands", "ping.md") }],
    });
    const fleet = new FleetCoordinator(boot, { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    const child = fakeEndpoint("child-1", dir);
    fleet.registerChild("parent-sess", child.endpoint, "task");
    const call = toolCaller(fleet, "parent-sess", dir);

    const sent = await call({ action: "send", target: "child-1", body: "/rx:ping hello" });
    assert.equal(sent.isError, undefined, textOf(sent));
    assert.equal((sent.details as { status: string }).status, "delivered");
    assert.deepEqual(
      child.inbox,
      [{ text: "Pong: hello", mode: "followUp" }],
      "the rendered body is the message, with no envelope",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the json listing omits parent for a fleet session", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-json-parent-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("parent-sess", dir).endpoint, "idle");
    fleet.registerChild("parent-sess", fakeEndpoint("child-1", dir).endpoint, "task");
    const call = toolCaller(fleet, "parent-sess", dir);
    interface ListedSession {
      sessionId: string;
      parent?: string;
    }

    const machine = await call({ action: "list", scope: "machine", format: "json" });
    const fleetSession = must(at((machine.details as { sessions: ListedSession[] }).sessions, 0));
    assert.equal(fleetSession.sessionId, "parent-sess");
    assert.equal("parent" in fleetSession, false, "a fleet session names no parent");

    const children = await call({ action: "list", scope: "children", format: "json" });
    const childSession = must(at((children.details as { sessions: ListedSession[] }).sessions, 0));
    assert.equal(childSession.parent, "parent-sess", "a child names the session that spawned it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child session ID that is this window's own endpoint is refused as own", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-own-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    t.after(() => fleet.close());
    fleet.registerEndpoint(fakeEndpoint("sess-own", dir).endpoint, "idle");

    assert.equal(
      fleet.registerChild("parent-sess", fakeEndpoint("sess-own", dir).endpoint, "task"),
      "own",
      "a session this window registered is no child session",
    );
    assert.equal(fleet.getSession("sess-own")?.parentSessionId, undefined);
    assert.equal(rawSession(dbPath, "sess-own")?.parentSessionId, null);
    assert.deepEqual(idsOf(fleet.listSessions("children", dir, "parent-sess")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session registered over a leftover child record keeps no parent", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-leftover-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    t.after(() => fleet.close());
    fleet.registerChild("parent-sess", fakeEndpoint("child-x", dir).endpoint, "task");

    // The same session ID now starts as a fleet session of this window.
    assert.equal(fleet.registerEndpoint(fakeEndpoint("child-x", dir).endpoint, "idle"), true);
    assert.equal(fleet.getSession("child-x")?.parentSessionId, undefined);
    assert.deepEqual(idsOf(fleet.listSessions("machine", dir)), ["child-x"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
