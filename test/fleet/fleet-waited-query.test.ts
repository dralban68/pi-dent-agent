import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { BootSnapshot } from "../../lib/engine.ts";
import { FleetCoordinator } from "../../lib/fleet.ts";
import type { HostSession } from "../../lib/host.ts";
import { makeFleetTool } from "../../lib/tools.ts";
import { at, must } from "../support/must.ts";

/**
 * specs/fleet-tool.md Section 4.1: a child session — no endpoint in this boot
 * window and no record in the store — may `send`, and its `query` is a waited
 * query. The wait is addressed by a hidden record (specs/session-store.md
 * Section 4), which the boot window deletes when the session's last wait ends.
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

/** The text of a tool result (single text block). */
function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  const first = res.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A tool call issued by the child session of the given coordinator. */
function childCaller(
  fleet: FleetCoordinator,
  sessionId: string,
  dir: string,
): (
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{
  content: Array<{ type: string; text?: string }>;
  details: unknown;
  isError?: boolean;
}> {
  const tool = makeFleetTool({ fleet, hostProvider: () => stubHost(sessionId, dir) });
  return (params, signal) =>
    tool.execute("tc", params as never, signal, undefined, undefined as never);
}

function sessionRowCount(dbPath: string, sessionId: string): number {
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

/** A record's `parent_session_id`, read straight from the store. */
function parentOf(dbPath: string, sessionId: string): string | null {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT parent_session_id FROM fleet_sessions WHERE session_id = ?")
      .get(sessionId);
    return typeof row?.parent_session_id === "string" ? row.parent_session_id : null;
  } finally {
    db.close();
  }
}

/** A record's `owner_boot`, read straight from the store. */
function ownerBootOf(dbPath: string, sessionId: string): string | null {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT owner_boot FROM fleet_sessions WHERE session_id = ?")
      .get(sessionId);
    return typeof row?.owner_boot === "string" ? row.owner_boot : null;
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

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

test("waited query: a child session's send is one-way and leaves no record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-send-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    const inbox: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          inbox.push(text);
        },
      },
      "idle",
    );
    const call = childCaller(fleet, "child-session-0001", dir);

    const sent = await call({ action: "send", target: "target-sess", body: "hello target" });
    assert.equal(sent.isError, undefined);
    const details = sent.details as { action: string; target: string; status: string };
    assert.equal(details.action, "send");
    assert.equal(details.target, "target-sess");
    assert.equal(details.status, "delivered", "the target accepts the turn");
    assert.equal(inbox.length, 1);
    assert.match(at(inbox, 0), /^\[Fleet from child-session-0001\]\nhello target$/);
    assert.equal(
      sessionRowCount(dbPath, "child-session-0001"),
      0,
      "a plain send needs no address for a reply",
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: the call returns the reply and leaves no hidden record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-reply-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: (query) => Promise.resolve({ text: `answer to ${query.body}`, isError: false }),
      },
      "idle",
    );
    const call = childCaller(fleet, "child-session-0001", dir);

    const answered = await call({ action: "query", target: "target-sess", body: "what is left?" });
    assert.equal(answered.isError, undefined);
    const details = answered.details as {
      action: string;
      messageId: number;
      correlationId: string;
      target: string;
      state: string;
      reply: string;
    };
    assert.equal(details.action, "query");
    assert.equal(details.target, "target-sess");
    assert.equal(details.state, "idle");
    assert.match(details.correlationId, /^q-[0-9a-f]{8}$/);
    assert.equal(details.reply, "answer to what is left?");
    assert.equal(
      textOf(answered),
      `Fleet query ${details.messageId} to target-sess answered (correlationId: ${details.correlationId}).\nanswer to what is left?`,
    );
    assert.equal(
      sessionRowCount(dbPath, "child-session-0001"),
      0,
      "the hidden record is deleted when the last wait ends",
    );
    const replyRows = messageRows(dbPath, "child-session-0001");
    assert.equal(replyRows.length, 1);
    assert.equal(at(replyRows, 0).status, "delivered", "this boot window consumed the reply");
    assert.equal(
      at(replyRows, 0).body,
      `[Fleet query reply correlationId=${details.correlationId}]\nanswer to what is left?`,
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: the hidden record is not a fleet session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-hidden-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    const agentsDir = join(dir, "agents", "target-sess");
    mkdirSync(agentsDir, { recursive: true });
    const pending = deferred<{ text: string; isError: boolean }>();
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        agentsDir,
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: () => pending.promise,
      },
      "idle",
    );
    const call = childCaller(fleet, "child-session-0001", dir);

    const queryCall = call({ action: "query", target: "target-sess", body: "hold on" });
    await waitFor(
      () => sessionRowCount(dbPath, "child-session-0001") === 1,
      "the hidden record of the waiting session",
    );
    assert.equal(
      fleet.getSession("child-session-0001"),
      undefined,
      "a hidden record is not a session",
    );
    assert.equal(parentOf(dbPath, "child-session-0001"), null, "a hidden record names no parent");
    assert.deepEqual(
      fleet.listSessions("children", dir, "parent-sess"),
      [],
      "a hidden record is no child of a listing",
    );

    const listed = await call({ action: "list", format: "json" });
    const sessions = (listed.details as { sessions: Array<{ sessionId: string }> }).sessions;
    assert.deepEqual(
      sessions.map((s) => s.sessionId),
      ["target-sess"],
      "a hidden record is never listed",
    );
    assert.deepEqual(fleet.resolveRecipient("child-session-0001"), {
      error: 'unknown target session "child-session-0001"',
    });
    assert.deepEqual(fleet.resolveRecipient("child"), {
      error: 'unknown target session "child"',
    });
    assert.deepEqual(
      fleet.liveAgentDirs(),
      [agentsDir],
      "a hidden record has no agent directory and does not disable the sweep",
    );

    pending.resolve({ text: "done", isError: false });
    const answered = await queryCall;
    assert.equal((answered.details as { reply: string }).reply, "done");
    assert.equal(sessionRowCount(dbPath, "child-session-0001"), 0);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hidden record this window did not write becomes its own wait address", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-hidden-foreign-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    const pending = deferred<{ text: string; isError: boolean }>();
    let asked = 0;
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: () => {
          asked += 1;
          return pending.promise;
        },
      },
      "idle",
    );
    // A hidden record another boot window left behind; a record whose owner
    // process is live is never gone, so only the wait may claim and delete it.
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare(
          `INSERT INTO fleet_sessions
				 (session_id, cwd, repo_root, state, updated_at, turns_json, owner_pid, owner_boot, owner_started, agents_dir, hidden, parent_session_id)
				 VALUES (?, ?, NULL, 'running', ?, '[]', ?, NULL, ?, NULL, 1, NULL)`,
        )
        .run("child-fallback", dir, Date.now(), process.ppid, Date.now());
    } finally {
      raw.close();
    }

    const queryCall = childCaller(
      fleet,
      "child-fallback",
      dir,
    )({
      action: "query",
      target: "target-sess",
      body: "anyone?",
    });
    await waitFor(() => asked === 1, "the query to reach the target");
    assert.equal(
      ownerBootOf(dbPath, "child-fallback"),
      fleet.bootId,
      "the wait owns the address it rewrote",
    );

    pending.resolve({ text: "the answer", isError: false });
    const answered = await queryCall;
    assert.equal((answered.details as { reply: string }).reply, "the answer");
    assert.equal(
      sessionRowCount(dbPath, "child-fallback"),
      0,
      "the hidden record goes with the session's last wait",
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: a target without query support fails the wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-noquery-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );
    const call = childCaller(fleet, "child-session-0001", dir);

    const failed = await call({ action: "query", target: "target-sess", body: "anyone?" });
    assert.equal(failed.isError, true);
    assert.match(
      textOf(failed),
      /^Fleet query \d+ to target-sess failed: target session does not support queries$/,
    );
    assert.equal(sessionRowCount(dbPath, "child-session-0001"), 0);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: a target record deleted while waiting fails the wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-ended-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    fleet.upsertSession({ sessionId: "ghost-sess", cwd: dir, state: "idle" });
    const call = childCaller(fleet, "child-session-0001", dir);

    const queryCall = call({ action: "query", target: "ghost-sess", body: "anyone there?" });
    await waitFor(
      () => sessionRowCount(dbPath, "child-session-0001") === 1,
      "the hidden record of the waiting session",
    );
    const raw = new DatabaseSync(dbPath);
    raw.prepare("DELETE FROM fleet_sessions WHERE session_id = ?").run("ghost-sess");
    raw.close();

    const failed = await queryCall;
    assert.equal(failed.isError, true);
    assert.match(
      textOf(failed),
      /^Fleet query \d+ to ghost-sess failed: target session ended before replying$/,
    );
    assert.equal(sessionRowCount(dbPath, "child-session-0001"), 0);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: aborting the tool call fails the wait with cancelled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-abort-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    const pending = deferred<{ text: string; isError: boolean }>();
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: () => pending.promise,
      },
      "idle",
    );
    const call = childCaller(fleet, "child-session-0001", dir);

    const controller = new AbortController();
    const queryCall = call(
      { action: "query", target: "target-sess", body: "slow one" },
      controller.signal,
    );
    await waitFor(
      () => sessionRowCount(dbPath, "child-session-0001") === 1,
      "the hidden record of the waiting session",
    );
    controller.abort();
    const failed = await queryCall;
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /^Fleet query \d+ to target-sess failed: cancelled$/);
    assert.equal(
      sessionRowCount(dbPath, "child-session-0001"),
      0,
      "the hidden record is removed when the wait ends",
    );

    const aborted = call(
      { action: "query", target: "target-sess", body: "never" },
      AbortSignal.abort(),
    );
    const alreadyFailed = await aborted;
    assert.equal(alreadyFailed.isError, true);
    assert.match(textOf(alreadyFailed), /^Fleet query \d+ to target-sess failed: cancelled$/);
    assert.equal(sessionRowCount(dbPath, "child-session-0001"), 0);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: any other message pending for the hidden record is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-stray-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    const pending = deferred<{ text: string; isError: boolean }>();
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: () => pending.promise,
      },
      "idle",
    );
    const call = childCaller(fleet, "child-session-0001", dir);

    const queryCall = call({ action: "query", target: "target-sess", body: "wait for me" });
    await waitFor(
      () => sessionRowCount(dbPath, "child-session-0001") === 1,
      "the hidden record of the waiting session",
    );
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare(
        `INSERT INTO fleet_messages
				 (sender_session_id, target_session_id, boot_id, kind, subject, body, deliver, abort, correlation_id, status, rejection_reason, created_at, delivered_at, deliver_text)
				 VALUES ('target-sess', ?, 'other-boot', 'send', NULL, 'a plain message', 'followUp', 0, NULL, 'pending', NULL, ?, NULL, '[Fleet from target-sess]' || char(10) || 'a plain message')`,
      )
      .run("child-session-0001", Date.now());
    raw.close();

    await waitFor(
      () =>
        messageRows(dbPath, "child-session-0001").some(
          (row) => row.body === "a plain message" && row.status === "rejected",
        ),
      "the stray message to be rejected",
    );
    const stray = messageRows(dbPath, "child-session-0001").find(
      (row) => row.body === "a plain message",
    );
    assert.equal(stray?.rejection_reason, "session takes query replies only");

    // The stray rejection does not end the outstanding wait.
    pending.resolve({ text: "kept the wait", isError: false });
    const answered = await queryCall;
    assert.equal((answered.details as { reply: string }).reply, "kept the wait");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: concurrent queries from one child share one hidden record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-shared-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    const replies = new Map<string, Deferred<{ text: string; isError: boolean }>>();
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: (query) => {
          const pending = deferred<{ text: string; isError: boolean }>();
          replies.set(query.correlationId, pending);
          return pending.promise;
        },
      },
      "idle",
    );
    const call = childCaller(fleet, "child-session-0001", dir);

    const first = call({ action: "query", target: "target-sess", body: "first" });
    const second = call({ action: "query", target: "target-sess", body: "second" });
    await waitFor(() => replies.size === 2, "both queries to be delivered");
    assert.equal(
      sessionRowCount(dbPath, "child-session-0001"),
      1,
      "one hidden record serves both waits",
    );

    // Reply out of order: the correlation ID, not arrival order, matches a wait.
    const correlations = [...replies.keys()];
    const firstId = at(correlations, 0);
    const secondId = at(correlations, 1);
    at([...replies.values()], 1).resolve({ text: "answer second", isError: false });
    const secondAnswered = await second;
    assert.equal((secondAnswered.details as { reply: string }).reply, "answer second");
    assert.equal((secondAnswered.details as { correlationId: string }).correlationId, secondId);
    assert.equal(
      sessionRowCount(dbPath, "child-session-0001"),
      1,
      "the hidden record outlives the first of two waits",
    );

    replies.get(firstId)?.resolve({ text: "answer first", isError: false });
    const firstAnswered = await first;
    assert.equal((firstAnswered.details as { reply: string }).reply, "answer first");
    assert.equal((firstAnswered.details as { correlationId: string }).correlationId, firstId);
    assert.equal(sessionRowCount(dbPath, "child-session-0001"), 0);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: a child in one boot window queries a target in another through polling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-cross-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleetA = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-a" });
    const fleetB = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-b" });
    fleetB.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: (query) => Promise.resolve({ text: `B says ${query.body}`, isError: false }),
      },
      "idle",
    );
    const call = childCaller(fleetA, "child-session-0001", dir);

    const answered = await call({ action: "query", target: "target-sess", body: "are you there?" });
    assert.equal(answered.isError, undefined);
    const details = answered.details as { reply: string; correlationId: string };
    assert.equal(details.reply, "B says are you there?");
    assert.match(
      textOf(answered),
      new RegExp(
        `^Fleet query \\d+ to target-sess answered \\(correlationId: ${details.correlationId}\\)\\.\\nB says are you there\\?$`,
      ),
    );
    assert.equal(
      sessionRowCount(dbPath, "child-session-0001"),
      0,
      "the waiting boot window removes its hidden record",
    );
    fleetA.close();
    fleetB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A store that refuses to write the query row: the trigger stands for a store
 * write failure, which the coordinator cannot paper over.
 */
function refuseQueryRows(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TRIGGER refuse_query_insert BEFORE INSERT ON fleet_messages BEGIN SELECT RAISE(ABORT, 'store refused the row'); END",
    );
  } finally {
    db.close();
  }
}

/**
 * A record whose owner boot window is gone: only a poll loop deletes it, so it
 * survives exactly when the boot window under test has stopped polling
 * (session-store.md Section 4: the sweep runs while a hidden record exists).
 */
function plantGoneSession(dbPath: string, sessionId: string, cwd: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO fleet_sessions
				 (session_id, cwd, repo_root, state, updated_at, turns_json, owner_pid, owner_boot, owner_started, agents_dir, hidden)
				 VALUES (?, ?, NULL, 'idle', ?, '[]', ?, 'boot-window-that-is-gone', 1, NULL, 0)`,
    ).run(sessionId, cwd, Date.now(), process.pid);
  } finally {
    db.close();
  }
}

/** Run the poll loop forward; a boot window still polling sweeps in this window. */
function tickPastSweep(t: TestContext): void {
  t.mock.timers.tick(2600);
}

test("waited query: a boot window that still polls deletes a planted gone-owner record", async (t) => {
  // Control for the stopped-polling tests below: a live loop sweeps the record.
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-control-"));
  try {
    t.mock.timers.enable({ apis: ["Date", "setInterval"] });
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    fleet.registerEndpoint(
      {
        sessionId: "live-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: () => Promise.resolve({ text: "", isError: false }),
      },
      "idle",
    );
    plantGoneSession(dbPath, "ghost-sess", dir);
    tickPastSweep(t);
    assert.equal(sessionRowCount(dbPath, "ghost-sess"), 0, "the live poll loop swept the record");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: a query the store refuses to enqueue leaves no hidden record or poll loop", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-throw-"));
  try {
    t.mock.timers.enable({ apis: ["Date", "setInterval"] });
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    fleet.upsertSession({ sessionId: "target-sess", cwd: dir, state: "idle" });
    refuseQueryRows(dbPath);
    const call = childCaller(fleet, "child-session-0001", dir);

    const failed = await call({ action: "query", target: "target-sess", body: "never enqueued" });
    assert.equal(failed.isError, true);
    assert.equal(textOf(failed), "Fleet query failed: store refused the row");
    assert.equal(
      sessionRowCount(dbPath, "child-session-0001"),
      0,
      "the hidden record of the failed wait is deleted",
    );
    assert.equal(
      fleet.getSession("child-session-0001"),
      undefined,
      "the failed wait leaves no session behind",
    );
    assert.deepEqual(fleet.resolveRecipient("child-session-0001"), {
      error: 'unknown target session "child-session-0001"',
    });

    // Nothing of the wait is left to poll for: a record only a poll loop would
    // delete survives the window in which the loop would have run.
    plantGoneSession(dbPath, "ghost-sess", dir);
    tickPastSweep(t);
    assert.equal(
      sessionRowCount(dbPath, "ghost-sess"),
      1,
      "the failed wait stopped the boot window's poll loop",
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: the boot window stops polling the store when its last wait ends with no endpoints", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-timer-"));
  try {
    t.mock.timers.enable({ apis: ["Date", "setInterval"] });
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    fleet.upsertSession({ sessionId: "target-sess", cwd: dir, state: "running" });
    const target = must(fleet.getSession("target-sess"));

    const controller = new AbortController();
    const waited = fleet.queryAndWait({
      senderSessionId: "child-session-0001",
      cwd: dir,
      target,
      body: "hold the timer",
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(waited.reply, /cancelled/);
    assert.equal(
      sessionRowCount(dbPath, "child-session-0001"),
      0,
      "the last wait ended, so its hidden record is gone",
    );

    // A record only a poll loop deletes survives the window in which the loop
    // would have run: no endpoint and no wait left, so nothing may poll.
    plantGoneSession(dbPath, "ghost-sess", dir);
    tickPastSweep(t);
    assert.equal(
      sessionRowCount(dbPath, "ghost-sess"),
      1,
      "the boot window stopped polling the store",
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: a boot window stops polling once a poll tick consumed its wait's reply", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-timer-tick-"));
  try {
    t.mock.timers.enable({ apis: ["Date", "setInterval"] });
    const dbPath = join(dir, "fleet.sqlite");
    const fleetA = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-a" });
    const fleetB = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-b" });
    fleetB.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: () => Promise.resolve({ text: "later", isError: false }),
      },
      "idle",
    );
    const target = must(fleetA.getSession("target-sess"));

    const waited = fleetA.queryAndWait({
      senderSessionId: "child-session-0001",
      cwd: dir,
      target,
      body: "over there",
    });
    let answered: string | undefined;
    void waited.reply.then(
      (text) => {
        answered = text;
      },
      () => {},
    );
    for (let tick = 0; tick < 40 && answered === undefined; tick += 1) {
      t.mock.timers.tick(250);
      await new Promise((done) => setTimeout(done, 1));
    }
    assert.equal(answered, "later", "a poll tick consumed the reply");
    assert.equal(sessionRowCount(dbPath, "child-session-0001"), 0);

    // Only fleetA's poll loop could run now: fleetB is closed and holds no
    // endpoint, so a record only a poll loop deletes stays where it is.
    fleetB.close();
    plantGoneSession(dbPath, "ghost-sess", dir);
    tickPastSweep(t);
    assert.equal(
      sessionRowCount(dbPath, "ghost-sess"),
      1,
      "the answered wait stopped fleetA's poll loop",
    );
    fleetA.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: a cancelled wait rejects the still-pending query", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-cancel-row-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    fleet.upsertSession({ sessionId: "target-sess", cwd: dir, state: "running" });
    const target = must(fleet.getSession("target-sess"));

    const controller = new AbortController();
    const waited = fleet.queryAndWait({
      senderSessionId: "child-session-0001",
      cwd: dir,
      target,
      body: "too late",
      signal: controller.signal,
    });
    assert.equal(
      at(messageRows(dbPath, "target-sess"), 0).status,
      "pending",
      "no endpoint took the query yet",
    );
    const failed = assert.rejects(waited.reply, /cancelled/);
    controller.abort();
    await failed;
    const cancelled = at(messageRows(dbPath, "target-sess"), 0);
    assert.equal(cancelled.status, "rejected", "a cancelled pending query is rejected");
    assert.equal(cancelled.rejection_reason, "cancelled");

    // The target registers later and drains: a cancelled query is never run.
    let runs = 0;
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: () => {
          runs += 1;
          return Promise.resolve({ text: "ran", isError: false });
        },
      },
      "idle",
    );
    await new Promise((done) => setTimeout(done, 60));
    assert.equal(runs, 0, "the target never runs a cancelled query");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited query: a cancelled wait leaves an already-delivered query alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-cancel-delivered-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    const pending = deferred<{ text: string; isError: boolean }>();
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: () => pending.promise,
      },
      "idle",
    );
    const target = must(fleet.getSession("target-sess"));

    const controller = new AbortController();
    const waited = fleet.queryAndWait({
      senderSessionId: "child-session-0001",
      cwd: dir,
      target,
      body: "already taken",
      signal: controller.signal,
    });
    await waitFor(
      () => messageRows(dbPath, "target-sess")[0]?.status === "delivered",
      "the query delivery",
    );
    const failed = assert.rejects(waited.reply, /cancelled/);
    controller.abort();
    await failed;
    const row = at(messageRows(dbPath, "target-sess"), 0);
    assert.equal(row.status, "delivered", "a delivered query keeps its status");
    assert.equal(row.rejection_reason, null);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A pending send for `targetSessionId`, written by another process: the next poll tick delivers it. */
function plantPendingSend(dbPath: string, targetSessionId: string, body: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO fleet_messages
         (sender_session_id, target_session_id, boot_id, kind, subject, body, deliver, abort, correlation_id, status, rejection_reason, created_at, delivered_at, deliver_text)
         VALUES ('other-sess', ?, 'boot-other', 'send', NULL, ?, 'followUp', 0, NULL, 'pending', NULL, 0, NULL, '[Fleet from other-sess]' || char(10) || ?)`,
    ).run(targetSessionId, body, body);
  } finally {
    db.close();
  }
}

/**
 * The other process's write, placed at the interleaving the waiter cannot see:
 * when it rejects a reply that matches no wait, it writes the wait's own reply
 * and deletes the target's record together (specs/fleet-tool.md Section 4: the
 * reply and the cancellation are written back to back).
 */
function writeReplyWhileRejecting(
  dbPath: string,
  correlationId: string,
  senderSessionId: string,
  targetSessionId: string,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TRIGGER write_reply_while_rejecting AFTER UPDATE OF status ON fleet_messages
      WHEN NEW.status = 'rejected' AND NEW.rejection_reason = 'session takes query replies only'
      BEGIN
        INSERT INTO fleet_messages
          (sender_session_id, target_session_id, boot_id, kind, subject, body, deliver, abort, correlation_id, status, rejection_reason, created_at, delivered_at, deliver_text)
          VALUES ('${targetSessionId}', '${senderSessionId}', 'boot-t', 'send', NULL,
            '[Fleet query reply correlationId=${correlationId}]' || char(10) || 'Query cancelled: the target session ended or reloaded.',
            'followUp', 0, NULL, 'pending', NULL, 0, NULL,
            '[Fleet from ${targetSessionId}]' || char(10) || '[Fleet query reply correlationId=${correlationId}]' || char(10) || 'Query cancelled: the target session ended or reloaded.');
        DELETE FROM fleet_sessions WHERE session_id = '${targetSessionId}';
      END
    `);
  } finally {
    db.close();
  }
}

test("waited query: a reply written as the target's record disappears still settles the wait", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wq-reply-race-"));
  try {
    t.mock.timers.enable({ apis: ["Date", "setInterval"] });
    const dbPath = join(dir, "fleet.sqlite");
    const fleetQ = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-q" });
    const fleetT = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-t" });
    fleetT.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: () => new Promise(() => {}),
      },
      "idle",
    );

    // A session of the querying window whose delivery places the other
    // process's write: the target answers a reply that matches no wait while a
    // wait is being checked.
    let strangerWritten = false;
    fleetQ.registerEndpoint(
      {
        sessionId: "hook-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {
          if (strangerWritten) return;
          strangerWritten = true;
          plantPendingSend(
            dbPath,
            "child-session-0003",
            "[Fleet query reply correlationId=q-0badf00d]\nstranger reply",
          );
        },
      },
      "idle",
    );
    plantPendingSend(dbPath, "hook-sess", "wake the tick");

    const waited = fleetQ.queryAndWait({
      senderSessionId: "child-session-0003",
      cwd: dir,
      target: must(fleetQ.getSession("target-sess")),
      body: "what changed?",
    });
    // A rejection after the test's own assertions must never surface as unhandled.
    void waited.reply.catch(() => {});
    writeReplyWhileRejecting(dbPath, waited.correlationId, "child-session-0003", "target-sess");

    // The pass that rejects the stranger reply also takes the target's record
    // away; the reply it wrote then must still settle the wait, not lose to the
    // deletion (specs/fleet-tool.md Section 4.1: no reply can arrive is the only failure).
    t.mock.timers.tick(250);
    assert.equal(strangerWritten, true, "the other process's write was placed");
    t.mock.timers.tick(250);
    const reply = await waited.reply;
    assert.equal(reply, "Query cancelled: the target session ended or reloaded.");
    const rows = messageRows(dbPath, "child-session-0003");
    assert.deepEqual(
      rows.map((row) => row.status),
      ["rejected", "delivered"],
      "the stranger reply is rejected and the real reply is consumed",
    );
    fleetQ.close();
    fleetT.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
