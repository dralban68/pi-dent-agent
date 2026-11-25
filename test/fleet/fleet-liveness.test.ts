/**
 * Spec-gap tests for specs/session-store.md Section 4 (a record whose owner
 * process is gone is no target, is deleted when detected, and has its pending
 * messages rejected) and specs/fleet-tool.md Section 4's
 * exactly-one query reply (a failed reply is never retried as a second reply).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BootSnapshot } from "../../lib/engine.ts";
import { FleetCoordinator } from "../../lib/fleet.ts";
import type { HostSession } from "../../lib/host.ts";
import { makeFleetTool } from "../../lib/tools.ts";
import { at, must } from "../support/must.ts";

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

/** A pid that is verifiably dead: a node process that already exited. */
function deadPid(): number {
  const out = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(out.status, 0);
  const pid = Number.parseInt(String(out.pid), 10);
  assert.ok(Number.isInteger(pid) && pid > 0, `node pid expected, got ${out.pid}`);
  return pid;
}

/** A second connection on the store: what another pi-dent process sees and writes. */
function rawDb(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

/** A live sender endpoint: `send` and `query` require one (specs/fleet-tool.md Section 1). */
function registerSender(fleet: FleetCoordinator, sessionId: string, cwd: string): void {
  fleet.registerEndpoint(
    {
      sessionId,
      cwd: () => cwd,
      isIdle: () => true,
      abortTurn: () => {},
      deliverTurn: () => {},
    },
    "idle",
  );
}

test("a session whose owner process is gone is an unknown target: resolution deletes its record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-gone-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootHere" });
    // Sibling row still in the store, with a message queued while its owner was alive.
    fleet.upsertSession({ sessionId: "orphan-target", cwd: dir, state: "idle" });
    const queued = fleet.enqueueSend({
      senderSessionId: "sender-1",
      target: must(fleet.getSession("orphan-target")),
      body: "queued before the crash",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(queued.status, "pending");
    // The owner is a different, now-exited process.
    const raw = new DatabaseSync(db);
    raw
      .prepare("UPDATE fleet_sessions SET owner_pid = ?, owner_boot = ? WHERE session_id = ?")
      .run(deadPid(), "bootCrashed", "orphan-target");
    // Control: an identical row whose owner is this live boot window stays a target.
    fleet.upsertSession({ sessionId: "owned-target", cwd: dir, state: "idle" });

    registerSender(fleet, "sender-1", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-1", dir) });
    const control = await tool.execute(
      "tc-0",
      { action: "send", target: "owned-target", body: "control" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(control.details.state, "idle", "control row of a live owner is idle");

    // `list` omits the record and, being read-only, leaves it in the store.
    const listed = await tool.execute(
      "tc-l",
      { action: "list", format: "json" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    const ids = (listed.details as { sessions: { sessionId: string }[] }).sessions.map(
      (session) => session.sessionId,
    );
    assert.deepEqual(ids, ["owned-target", "sender-1"]);
    const count = (): unknown =>
      raw
        .prepare("SELECT COUNT(*) AS n FROM fleet_sessions WHERE session_id = ?")
        .get("orphan-target")?.n;
    assert.equal(count(), 1, "a list deletes nothing");

    for (const [target, action] of [
      ["orphan-target", "send"],
      ["orphan", "send"],
      ["orphan-target", "query"],
    ] as const) {
      const res = await tool.execute(
        `tc-${action}-${target}`,
        { action, target, body: "hello orphan" } as never,
        undefined,
        undefined,
        undefined as never,
      );
      assert.equal(
        res.content[0]?.type === "text" ? res.content[0].text : "",
        `unknown target session "${target}"`,
      );
    }
    assert.equal(count(), 0, "target resolution deletes the record");
    const status = fleet.getMessageStatus("sender-1", queued.messageId);
    assert.equal(status.status, "rejected");
    assert.equal(status.rejectionReason, "target session ended before delivery");
    raw.close();
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the sweep deletes a session whose owner process is gone and rejects its pending message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-sweep-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootHere" });
    // A registered endpoint starts the poll loop that runs the sweep.
    fleet.registerEndpoint(
      {
        sessionId: "booter",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );
    fleet.upsertSession({ sessionId: "crashed", cwd: dir, state: "idle" });
    const target = fleet.getSession("crashed");
    assert.ok(target);
    const sent = fleet.enqueueSend({
      senderSessionId: "sender-sweep",
      target,
      body: "hello crashed",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(sent.status, "pending");

    const raw = new DatabaseSync(db);
    raw
      .prepare("UPDATE fleet_sessions SET owner_pid = ?, owner_boot = ? WHERE session_id = ?")
      .run(deadPid(), "bootCrashed", "crashed");
    raw.close();

    const deadline = Date.now() + 3000;
    while (fleet.getSession("crashed") !== undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(
      fleet.getSession("crashed"),
      undefined,
      "the sweep must delete the dead-owner row",
    );
    assert.equal(
      fleet.getMessageStatus("sender-sweep", sent.messageId).status,
      "rejected",
      "its pending message must be rejected",
    );
    assert.ok(fleet.getSession("booter"), "a live row stays");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reply the store refuses is spent, never resent as a second reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-once-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    const senderInbox: string[] = [];
    const notified: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "sender-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          senderInbox.push(text);
        },
      },
      "idle",
    );
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        notify: (message) => {
          notified.push(message);
        },
        runQuery: async (q) => ({ text: `Answered: ${q.body}`, isError: false }),
      },
      "idle",
    );
    // The store refuses the reply the target sends back (fleet-tool.md Section 4).
    const refusing = rawDb(dbPath);
    refusing.exec(
      "CREATE TRIGGER refuse_reply_insert BEFORE INSERT ON fleet_messages WHEN NEW.body LIKE '[Fleet query reply%' BEGIN SELECT RAISE(ABORT, 'reply transport refused'); END",
    );
    refusing.close();

    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-sess", dir) });
    await tool.execute(
      "tc-1",
      { action: "query", target: "target-sess", body: "q?" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(senderInbox, [], "a reply the store refused is not delivered");
    assert.equal(notified.length, 1, "the target's user is told once, not once per retry");

    // The store accepts replies again: the refused reply is not resent, and a
    // new query gets its own single reply.
    const accepting = rawDb(dbPath);
    accepting.exec("DROP TRIGGER refuse_reply_insert");
    accepting.close();
    await tool.execute(
      "tc-2",
      { action: "query", target: "target-sess", body: "and now?" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(senderInbox.length, 1, "exactly one reply reaches the querier's inbox");
    assert.match(at(senderInbox, 0), /\nAnswered: and now\?$/);
    assert.equal(notified.length, 1, "the delivered reply is reported to no one");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed query dispatch yields exactly one error reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-qerr-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const senderInbox: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "sender-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          senderInbox.push(text);
        },
      },
      "idle",
    );
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: async () => {
          throw new Error("dispatch exploded");
        },
      },
      "idle",
    );
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-sess", dir) });
    await tool.execute(
      "tc-1",
      { action: "query", target: "target-sess", body: "q?" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(senderInbox.length, 1, `exactly one reply: ${JSON.stringify(senderInbox)}`);
    assert.match(at(senderInbox, 0), /Query error: dispatch exploded/);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in-flight query is cancelled when target session ends (unregisterEndpoint)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-qcancel-end-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const senderInbox: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "sender-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          senderInbox.push(text);
        },
      },
      "idle",
    );

    let resolveQuery: (res: { text: string; isError: boolean }) => void = () => {};
    const queryPromise = new Promise<{ text: string; isError: boolean }>((resolve) => {
      resolveQuery = resolve;
    });

    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: async () => queryPromise,
      },
      "idle",
    );

    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-sess", dir) });
    await tool.execute(
      "tc-1",
      { action: "query", target: "target-sess", body: "hello?" } as never,
      undefined,
      undefined,
      undefined as never,
    );

    // Target session ends while query is in-flight
    fleet.unregisterEndpoint("target-sess");

    assert.equal(senderInbox.length, 1, "querier receives exactly one cancellation reply");
    assert.match(at(senderInbox, 0), /Query cancelled: the target session ended or reloaded\./);

    // Later settlement sends nothing
    resolveQuery({ text: "late answer", isError: false });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(senderInbox.length, 1, "no second reply after late resolution");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in-flight query is cancelled when target session reloads (releaseEndpointForReload)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-qcancel-reload-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const senderInbox: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "sender-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          senderInbox.push(text);
        },
      },
      "idle",
    );

    let resolveQuery: (res: { text: string; isError: boolean }) => void = () => {};
    const queryPromise = new Promise<{ text: string; isError: boolean }>((resolve) => {
      resolveQuery = resolve;
    });

    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: async () => queryPromise,
      },
      "idle",
    );

    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-sess", dir) });
    await tool.execute(
      "tc-1",
      { action: "query", target: "target-sess", body: "hello?" } as never,
      undefined,
      undefined,
      undefined as never,
    );

    // Target session reloads while query is in-flight
    fleet.releaseEndpointForReload("target-sess");

    assert.equal(senderInbox.length, 1, "querier receives exactly one cancellation reply");
    assert.match(at(senderInbox, 0), /Query cancelled: the target session ended or reloaded\./);

    // Later settlement sends nothing
    resolveQuery({ text: "late answer", isError: false });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(senderInbox.length, 1, "no second reply after late resolution");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a user message starts a turn although the host already reports a run", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-turn-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    // The host counts the session busy before the user message of a prompt arrives.
    fleet.registerEndpoint(
      {
        sessionId: "typed",
        cwd: () => dir,
        isIdle: () => false,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );
    fleet.recordTurnStart("typed", dir, "first prompt");
    fleet.recordTurnStart("typed", dir, "a steer joins the turn");
    assert.deepEqual(
      fleet.getSession("typed")?.turns.map((turn) => turn.command),
      ["first prompt"],
    );
    fleet.recordTurnEnd("typed");
    fleet.recordTurnStart("typed", dir, "second prompt");
    assert.deepEqual(
      fleet.getSession("typed")?.turns.map((turn) => turn.command),
      ["first prompt", "second prompt"],
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the stored state follows the host's idle report without a user message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-state-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db });
    let idle = true;
    fleet.registerEndpoint(
      {
        sessionId: "busy",
        cwd: () => dir,
        isIdle: () => idle,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );
    // What another boot window reads: the stored column, not this window's endpoint.
    const raw = new DatabaseSync(db);
    const stored = (): unknown =>
      raw.prepare("SELECT state FROM fleet_sessions WHERE session_id = ?").get("busy")?.state;
    assert.equal(stored(), "idle");
    idle = false; // a run started by a completion notification, or a compaction
    await new Promise((done) => setTimeout(done, 400));
    assert.equal(stored(), "running");
    assert.equal(fleet.getSession("busy")?.turns.length, 0, "no turn is recorded for it");
    idle = true;
    await new Promise((done) => setTimeout(done, 400));
    assert.equal(stored(), "idle");
    raw.close();
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused session's turn events leave the live owner's record and delivery alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-refused-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const delivered: string[] = [];
    const fleetA = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "bootA" });
    const fleetB = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "bootB" });
    const endpoint = (sessionId: string, tag: string) => ({
      sessionId,
      cwd: () => dir,
      isIdle: () => true,
      abortTurn: () => {},
      deliverTurn: (text: string) => {
        delivered.push(`${tag}:${text}`);
      },
    });
    assert.equal(fleetA.registerEndpoint(endpoint("shared-owner", "A"), "idle"), true);
    assert.equal(
      fleetB.registerEndpoint(endpoint("shared-owner", "B"), "idle"),
      false,
      "B is refused: another live boot window owns the record",
    );

    // index.ts reports every session event, including those of a refused session.
    fleetB.recordTurnStart("shared-owner", dir, "user message in B");
    fleetB.recordTurnGoal("shared-owner", "goal from B");
    fleetB.recordTurnFile("shared-owner", "b-file.ts");
    fleetB.recordTurnEnd("shared-owner");

    const record = must(fleetA.getSession("shared-owner"));
    assert.equal(record.ownerBoot, "bootA", "the record still names the live owner's boot window");
    assert.equal(record.state, "idle", "B's turn events do not rewrite the state");
    assert.deepEqual(record.turns, [], "B's turn events do not append turn history");

    fleetB.recordTurnStart("never-registered", dir, "orphan turn");
    assert.equal(
      fleetB.getSession("never-registered"),
      undefined,
      "a session B has no endpoint for gets no record",
    );

    // A still owns delivery: the message reaches the session through A's endpoint.
    registerSender(fleetA, "sender-a", dir);
    const tool = makeFleetTool({ fleet: fleetA, hostProvider: () => stubHost("sender-a", dir) });
    const res = await tool.execute(
      "tc",
      { action: "send", target: "shared-owner", body: "hello" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(res.details.status, "delivered");
    assert.equal(delivered.length, 1);
    assert.match(must(at(delivered, 0)), /^A:[\s\S]*hello/);
    fleetA.close();
    fleetB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a same-pid owner whose boot window ended without session_shutdown is gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-stale-window-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const endpoint = (sessionId: string) => ({
      sessionId,
      cwd: () => dir,
      isIdle: () => true,
      abortTurn: () => {},
      deliverTurn: () => {},
    });

    // This process owned the session in an earlier window that ended without a
    // session_shutdown, so the record still names this pid.
    const fleetOld = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-ended" });
    assert.equal(fleetOld.registerEndpoint(endpoint("stale-session"), "idle"), true);
    fleetOld.close();

    const stale = new DatabaseSync(dbPath)
      .prepare("SELECT owner_pid, owner_boot FROM fleet_sessions WHERE session_id = ?")
      .get("stale-session");
    assert.equal(stale?.owner_pid, process.pid, "the record still names this process");
    assert.equal(stale?.owner_boot, "boot-ended", "and the window that ended");

    const fleetNew = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-live" });
    assert.equal(
      fleetNew.registerEndpoint(endpoint("stale-session"), "idle"),
      true,
      "a stale same-pid window must not keep refusing the registration",
    );
    assert.equal(must(fleetNew.getSession("stale-session")).ownerBoot, "boot-live");

    // A boot window still live in this process keeps owning its records.
    const fleetSibling = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-sibling" });
    assert.equal(fleetSibling.registerEndpoint(endpoint("sibling-session"), "idle"), true);
    const fleetOther = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "boot-other" });
    assert.equal(
      fleetOther.registerEndpoint(endpoint("sibling-session"), "idle"),
      false,
      "a live sibling window still owns its record",
    );
    fleetNew.close();
    fleetSibling.close();
    fleetOther.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list reports each session's kind: instance for this process, machine for another", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-kind-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootHere" });
    registerSender(fleet, "sess-here", dir);
    fleet.upsertSession({ sessionId: "sess-there", cwd: dir, state: "idle" });
    // Another live process owns the second session.
    new DatabaseSync(db)
      .prepare("UPDATE fleet_sessions SET owner_pid = ?, owner_boot = ? WHERE session_id = ?")
      .run(process.ppid, "bootThere", "sess-there");
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sess-here", dir) });
    const list = async (format: string) =>
      tool.execute(
        "tc",
        { action: "list", format } as never,
        undefined,
        undefined,
        undefined as never,
      );

    const json = await list("json");
    const kinds = (
      json.details as { sessions: { sessionId: string; kind: string }[] }
    ).sessions.map((session) => [session.sessionId, session.kind]);
    assert.deepEqual(kinds, [
      ["sess-here", "instance"],
      ["sess-there", "machine"],
    ]);
    const textOf = (result: Awaited<ReturnType<typeof list>>): string =>
      result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(textOf(json), /"kind": "machine"/);
    const compact = textOf(await list("compact"));
    assert.match(compact, /^sess-here · instance · idle · /m);
    assert.match(compact, /^sess-there · machine · idle · /m);
    const full = textOf(await list("full"));
    assert.match(full, /^sess-here \[idle\] kind=instance cwd=/m);
    assert.match(full, /^sess-there \[idle\] kind=machine cwd=/m);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a query reply reaches a sender that has been idle for a long time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-quiet-sender-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleetB = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootB" });
    const fleetA = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootA" });
    const senderInbox: string[] = [];
    fleetB.registerEndpoint(
      {
        sessionId: "sender-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          senderInbox.push(text);
        },
        runQuery: undefined,
      },
      "idle",
    );
    fleetB.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: async (q) => {
          await new Promise((r) => setTimeout(r, 25));
          return { text: `Answered: ${q.body}`, isError: false };
        },
      },
      "idle",
    );
    const tool = makeFleetTool({ fleet: fleetB, hostProvider: () => stubHost("sender-sess", dir) });
    await tool.execute(
      "tc-1",
      { action: "query", target: "target-sess", body: "q?" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    // While the query is in flight, the sender goes quiet and a peer lists
    // (which used to falsely reap the sender as stale and drop the reply).
    rawDb(db)
      .prepare("UPDATE fleet_sessions SET updated_at = ? WHERE session_id = ?")
      .run(Date.now() - 10 * 60_000, "sender-sess");
    fleetA.listSessions("machine", dir);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(senderInbox.length, 1, "the query reply must still be delivered");
    fleetA.close();
    fleetB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a steered message mid-turn joins the running turn instead of forking a new one", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-mid-turn-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    fleet.registerEndpoint(
      {
        sessionId: "sess-1",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          fleet.recordTurnStart("sess-1", dir, text);
        },
      },
      "idle",
    );
    fleet.recordTurnStart("sess-1", dir, "first user command");
    fleet.recordTurnStart("sess-1", dir, "[Fleet from peer] steer mid-turn");
    const session = fleet.getSession("sess-1");
    assert.equal(
      session?.turns.length,
      1,
      "a mid-turn steer joins the running turn, not a new one",
    );
    fleet.recordTurnEnd("sess-1");

    // A delivered followUp claims the idle session, then recordTurnStart fires for that turn.
    fleet.enqueueSend({
      senderSessionId: "peer-1",
      target: must(fleet.getSession("sess-1")),
      body: "follow-up work",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(fleet.getSession("sess-1")?.turns.length, 2, "injected followUp turn is recorded");
    fleet.recordTurnStart("sess-1", dir, "[Fleet from peer-1] another steer");
    assert.equal(
      fleet.getSession("sess-1")?.turns.length,
      2,
      "steer during followUp turn joins it",
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
