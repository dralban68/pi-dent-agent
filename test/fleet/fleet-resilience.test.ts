/**
 * What a host call that fails inside the fleet must not cost: a throwing
 * endpoint never escapes a poll tick or a read/enqueue path (specs/session-store.md
 * Sections 2 and 5), a slash-command rejection carries the bare reason of
 * specs/fleet-tool.md Section 3.2 in both delivery modes, a cancelled query's
 * reply lives as long as the querying boot window (specs/fleet-tool.md Section 4,
 * specs/session-store.md Section 3), and a re-entrant drain never injects one
 * row twice (specs/session-store.md Section 5).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BootSnapshot } from "../../lib/engine.ts";
import { FleetCoordinator } from "../../lib/fleet.ts";
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

/** Run `run`, failing the test with the thrown error instead of letting it escape. */
function attempt<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    assert.fail(
      `expected no throw, got: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function messageRowsOf(
  dbPath: string,
): Array<{ boot_id: string; status: string; body: string; target_session_id: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        "SELECT boot_id, status, body, target_session_id FROM fleet_messages ORDER BY message_id ASC",
      )
      .all()
      .map((row) => ({
        boot_id: typeof row.boot_id === "string" ? row.boot_id : "",
        status: typeof row.status === "string" ? row.status : "",
        body: typeof row.body === "string" ? row.body : "",
        target_session_id: typeof row.target_session_id === "string" ? row.target_session_id : "",
      }));
  } finally {
    db.close();
  }
}

/** Reject after `ms` so a defect that never settles fails the test instead of hanging it. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** Let a resolved dispatch promise settle and deliver its reply. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test("a throwing isIdle never escapes the read and enqueue paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-resilience-idle-read-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    fleet.registerEndpoint(
      {
        sessionId: "throwing-sess",
        cwd: () => dir,
        isIdle: () => {
          throw new Error("stale host context");
        },
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );

    const listed = attempt(() => fleet.listSessions("machine", dir));
    assert.equal(listed.length, 1);
    assert.equal(
      at(listed, 0).state,
      "running",
      "an endpoint whose idle state is unknown reads as running",
    );
    const resolved = attempt(() => fleet.resolveRecipient("throwing-sess"));
    assert.equal("session" in resolved && resolved.session.sessionId, "throwing-sess");

    const target = must(attempt(() => fleet.getSession("throwing-sess")));
    const queued = attempt(() =>
      fleet.enqueueSend({
        senderSessionId: "sender-1",
        target,
        body: "hello",
        deliver: "followUp",
        abort: false,
      }),
    );
    assert.equal(queued.state, "running");
    assert.equal(queued.status, "pending", "a running target keeps a followUp queued");
    attempt(() => fleet.drainForTarget("throwing-sess"));
    assert.equal(fleet.getMessageStatus("sender-1", queued.messageId).status, "pending");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a poll tick never throws and keeps draining the other endpoints", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-resilience-idle-tick-"));
  try {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const inbox: string[] = [];
    let throwing = false;
    let healthyIdle = false;
    fleet.registerEndpoint(
      {
        sessionId: "throwing-sess",
        cwd: () => dir,
        isIdle: () => {
          if (throwing) throw new Error("stale host context");
          return false;
        },
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );
    fleet.registerEndpoint(
      {
        sessionId: "healthy-sess",
        cwd: () => dir,
        isIdle: () => healthyIdle,
        abortTurn: () => {},
        deliverTurn: (text) => {
          inbox.push(text);
        },
      },
      "idle",
    );
    const queuedThrowing = fleet.enqueueSend({
      senderSessionId: "sender-1",
      target: must(fleet.getSession("throwing-sess")),
      body: "for the stale session",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(queuedThrowing.status, "pending");
    const queuedHealthy = fleet.enqueueSend({
      senderSessionId: "sender-1",
      target: must(fleet.getSession("healthy-sess")),
      body: "for the healthy session",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(queuedHealthy.status, "pending");

    throwing = true;
    healthyIdle = true;
    attempt(() => t.mock.timers.tick(250));

    assert.equal(inbox.length, 1, "the healthy endpoint is still drained by the same tick");
    assert.match(at(inbox, 0), /for the healthy session$/);
    assert.equal(
      fleet.getMessageStatus("sender-1", queuedThrowing.messageId).status,
      "pending",
      "the stale session's message stays queued",
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("steer and followUp reject a slash command with the same bare reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-resilience-steer-reason-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const turns: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          turns.push(text);
        },
      },
      "idle",
    );
    const send = (body: string, deliver: "steer" | "followUp") =>
      fleet.enqueueSend({
        senderSessionId: "sender-1",
        target: must(fleet.getSession("target-sess")),
        body,
        deliver,
        abort: false,
      });

    const steerUnknown = send("/nope", "steer");
    assert.equal(steerUnknown.status, "rejected");
    assert.equal(steerUnknown.rejectionReason, 'unsupported slash command "/nope"');
    assert.equal(
      fleet.getMessageStatus("sender-1", steerUnknown.messageId).rejectionReason,
      'unsupported slash command "/nope"',
      "the stored reason carries no delivery-failed prefix",
    );

    const steerBuiltin = send("/compact", "steer");
    assert.equal(steerBuiltin.status, "rejected");
    assert.equal(steerBuiltin.rejectionReason, "target session does not support built-in commands");

    assert.equal(send("/nope", "followUp").rejectionReason, steerUnknown.rejectionReason);
    assert.equal(send("/compact", "followUp").rejectionReason, steerBuiltin.rejectionReason);
    assert.deepEqual(turns, [], "a rejected body is never injected");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cancelled query's reply reaches a querier in another boot window", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-resilience-cancel-endpoint-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleetA = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "bootAaaa" });
    const fleetB = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "bootBbbb" });
    try {
      const inbox: string[] = [];
      fleetA.registerEndpoint(
        {
          sessionId: "querier-sess",
          cwd: () => dir,
          isIdle: () => true,
          abortTurn: () => {},
          deliverTurn: (text) => {
            inbox.push(text);
          },
        },
        "idle",
      );
      let queried = false;
      fleetB.registerEndpoint(
        {
          sessionId: "target-sess",
          cwd: () => dir,
          isIdle: () => true,
          abortTurn: () => {},
          deliverTurn: () => {},
          runQuery: () => {
            queried = true;
            return new Promise(() => {});
          },
        },
        "idle",
      );

      const queued = fleetA.enqueueQuery({
        senderSessionId: "querier-sess",
        target: must(fleetA.getSession("target-sess")),
        body: "what changed?",
      });
      fleetB.drainForTarget("target-sess");
      assert.equal(queried, true, "the target starts the dispatch");

      fleetB.close(); // the target's host quits
      fleetA.drainForTarget("querier-sess");

      assert.equal(inbox.length, 1, "the querier receives exactly one reply");
      const reply = at(inbox, 0);
      assert.match(reply, /^\[Fleet from target-sess /);
      assert.match(
        reply,
        /\[Fleet query reply correlationId=([^\]]+)\]\nQuery cancelled: the target session ended or reloaded\.$/,
      );
      const rows = messageRowsOf(dbPath);
      const replyRow = rows.find((row) => row.target_session_id === "querier-sess");
      assert.equal(must(replyRow).boot_id, "bootAaaa", "the reply carries its query's boot id");
      assert.equal(queued.target, "target-sess");
    } finally {
      fleetA.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a waited query resolves with the cancellation text when the target quits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-resilience-cancel-wait-"));
  const dbPath = join(dir, "fleet.sqlite");
  const fleetA = new FleetCoordinator(emptyBoot(dir), { dbPath });
  try {
    const fleetB = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "bootBbbb" });
    try {
      let queried = false;
      fleetB.registerEndpoint(
        {
          sessionId: "target-sess",
          cwd: () => dir,
          isIdle: () => true,
          abortTurn: () => {},
          deliverTurn: () => {},
          runQuery: () => {
            queried = true;
            return new Promise(() => {});
          },
        },
        "idle",
      );

      const waited = fleetA.queryAndWait({
        senderSessionId: "child-session-0001",
        cwd: dir,
        target: must(fleetA.getSession("target-sess")),
        body: "report please",
      });
      // A rejection after the test's own assertions must never surface as unhandled.
      void waited.reply.catch(() => {});
      fleetB.drainForTarget("target-sess");
      assert.equal(queried, true, "the target starts the dispatch");

      fleetB.close(); // the target's host quits
      fleetA.drainForTarget("child-session-0001");
      const reply = await withTimeout(waited.reply, 10_000, "the cancellation reply");
      assert.equal(reply, "Query cancelled: the target session ended or reloaded.");
    } finally {
      fleetB.close();
    }
  } finally {
    fleetA.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a re-entrant drain while delivering injects the row once", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-resilience-reentrant-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const turns: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "steer-target",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          turns.push(text);
          // A host that pumps its own queue synchronously from inside the injection.
          if (turns.length === 1) fleet.drainForTarget("steer-target");
        },
      },
      "idle",
    );
    fleet.enqueueSend({
      senderSessionId: "sender-1",
      target: must(fleet.getSession("steer-target")),
      body: "once",
      deliver: "steer",
      abort: false,
    });
    assert.deepEqual(turns, ["[Fleet from sender-1]\nonce"], "the row is injected exactly once");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a re-entrant drain delivers a later row of the outer snapshot once", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-resilience-reentrant2-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const turns: string[] = [];
    let idle = false;
    fleet.registerEndpoint(
      {
        sessionId: "steer-target",
        cwd: () => dir,
        isIdle: () => idle,
        abortTurn: () => {},
        deliverTurn: (text) => {
          turns.push(text);
          if (turns.length === 1) fleet.drainForTarget("steer-target");
        },
      },
      "running",
    );
    // Both stay pending behind the abort gate while the target runs.
    for (const body of ["one", "two"]) {
      fleet.enqueueSend({
        senderSessionId: "sender-1",
        target: must(fleet.getSession("steer-target")),
        body,
        deliver: "steer",
        abort: true,
      });
    }
    assert.deepEqual(turns, []);
    idle = true;
    fleet.drainForTarget("steer-target");
    assert.deepEqual(turns, ["[Fleet from sender-1]\none", "[Fleet from sender-1]\ntwo"]);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing runBuiltinCommand rejects the steer built-in and keeps draining", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-resilience-builtin-steer-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    let idle = false;
    let builtinCalls = 0;
    fleet.registerEndpoint(
      {
        sessionId: "builtin-target",
        cwd: () => dir,
        isIdle: () => idle,
        abortTurn: () => {},
        deliverTurn: () => {},
        runBuiltinCommand: () => {
          builtinCalls += 1;
          if (builtinCalls === 1) throw new Error("stale host context");
          return true;
        },
      },
      "running",
    );
    const send = (body: string) =>
      fleet.enqueueSend({
        senderSessionId: "sender-1",
        target: must(fleet.getSession("builtin-target")),
        body,
        deliver: "steer",
        abort: true,
      });

    // Both stay pending behind the abort gate while the target runs.
    const first = attempt(() => send("/compact"));
    const second = attempt(() => send("/abort"));
    assert.equal(first.status, "pending");
    assert.equal(second.status, "pending");

    idle = true;
    attempt(() => fleet.drainForTarget("builtin-target"));

    const rejected = fleet.getMessageStatus("sender-1", first.messageId);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rejectionReason, "delivery failed: stale host context");
    assert.equal(
      fleet.getMessageStatus("sender-1", second.messageId).status,
      "delivered",
      "the later row of the same drain is still processed",
    );
    assert.equal(builtinCalls, 2, "the failed row is not retried by the same drain");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing runBuiltinCommand rejects the followUp built-in and keeps draining", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-resilience-builtin-followup-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    let idle = false;
    let builtinCalls = 0;
    fleet.registerEndpoint(
      {
        sessionId: "builtin-target",
        cwd: () => dir,
        isIdle: () => idle,
        abortTurn: () => {},
        deliverTurn: () => {},
        runBuiltinCommand: () => {
          builtinCalls += 1;
          if (builtinCalls === 1) throw new Error("stale host context");
          return true;
        },
      },
      "running",
    );
    const send = (body: string) =>
      fleet.enqueueSend({
        senderSessionId: "sender-1",
        target: must(fleet.getSession("builtin-target")),
        body,
        deliver: "followUp",
        abort: false,
      });

    // followUp built-ins wait for idle: both stay queued while the target runs.
    const first = attempt(() => send("/compact"));
    const second = attempt(() => send("/abort"));
    assert.equal(first.status, "pending");
    assert.equal(second.status, "pending");

    idle = true;
    attempt(() => fleet.drainForTarget("builtin-target"));

    const rejected = fleet.getMessageStatus("sender-1", first.messageId);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.rejectionReason, "delivery failed: stale host context");
    assert.equal(
      fleet.getMessageStatus("sender-1", second.messageId).status,
      "delivered",
      "the later row of the same drain is still processed",
    );
    assert.equal(builtinCalls, 2);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing abortTurn rejects the steer row and asks for no second abort", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-resilience-abort-throw-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const turns: string[] = [];
    let idle = false;
    let throwing = true;
    let aborts = 0;
    fleet.registerEndpoint(
      {
        sessionId: "steer-target",
        cwd: () => dir,
        isIdle: () => idle,
        abortTurn: () => {
          aborts += 1;
          if (throwing) throw new Error("stale host context");
        },
        deliverTurn: (text) => {
          turns.push(text);
        },
      },
      "running",
    );
    const send = () =>
      fleet.enqueueSend({
        senderSessionId: "sender-1",
        target: must(fleet.getSession("steer-target")),
        body: "steer now",
        deliver: "steer",
        abort: true,
      });

    const failed = attempt(send);
    assert.equal(failed.status, "rejected");
    assert.equal(failed.rejectionReason, "delivery failed: stale host context");
    assert.equal(
      fleet.getMessageStatus("sender-1", failed.messageId).status,
      "rejected",
      "the row is rejected once, not left retrying forever",
    );
    assert.equal(aborts, 1, "the failing abort is attempted once");
    assert.equal(
      attempt(() => fleet.drainForTarget("steer-target")) === undefined,
      true,
      "a later drain does not throw on the rejected row",
    );
    assert.equal(aborts, 1, "the rejected row is not retried by a later drain");
    assert.equal(
      fleet.getMessageStatus("sender-1", failed.messageId).status,
      "rejected",
      "the rejected row stays rejected",
    );

    // Later rows for the same target are still drained.
    throwing = false;
    const later = attempt(send);
    assert.equal(later.status, "pending", "the abort is requested and the row waits for idle");
    idle = true;
    attempt(() => fleet.drainForTarget("steer-target"));
    assert.equal(fleet.getMessageStatus("sender-1", later.messageId).status, "delivered");
    assert.deepEqual(turns, ["[Fleet from sender-1]\nsteer now"]);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dispatch that throws at once still replies once with Query error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-resilience-runquery-throw-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const inbox: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "querier-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          inbox.push(text);
        },
      },
      "idle",
    );
    let queriesRun = 0;
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: () => {
          queriesRun += 1;
          if (queriesRun === 1) throw new Error("stale host context");
          return Promise.resolve({ text: "second answer", isError: false });
        },
      },
      "idle",
    );

    const queued = attempt(() =>
      fleet.enqueueQuery({
        senderSessionId: "querier-sess",
        target: must(fleet.getSession("target-sess")),
        body: "what changed?",
      }),
    );
    assert.equal(queriesRun, 1, "the dispatch is attempted once");
    assert.equal(inbox.length, 1, "the querier receives exactly one reply");
    assert.match(
      at(inbox, 0),
      /\[Fleet query reply correlationId=q-[0-9a-f]{8}\]\nQuery error: stale host context$/,
    );
    assert.equal(
      fleet.getMessageStatus("querier-sess", queued.messageId).status,
      "delivered",
      "the query itself was delivered to the target",
    );

    // A later query still gets its own single reply (the querier reports idle again).
    fleet.upsertSession({ sessionId: "querier-sess", cwd: dir, state: "idle" });
    const again = attempt(() =>
      fleet.enqueueQuery({
        senderSessionId: "querier-sess",
        target: must(fleet.getSession("target-sess")),
        body: "and now?",
      }),
    );
    assert.equal(queriesRun, 2);
    await flush();
    assert.equal(inbox.length, 2, "the second query replies once too");
    assert.match(at(inbox, 1), /\nsecond answer$/);
    assert.equal(fleet.getMessageStatus("querier-sess", again.messageId).status, "delivered");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
