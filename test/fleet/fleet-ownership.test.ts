/**
 * Session ownership (specs/session-store.md#membership-lifecycle): one live boot window
 * owns a session, so a refused registration leaves the owner's record, its
 * ownership and its queued messages alone.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BootSnapshot } from "../../lib/engine.ts";
import { FleetCoordinator } from "../../lib/fleet.ts";
import type { HostSession } from "../../lib/host.ts";
import { makeFleetTool } from "../../lib/tools.ts";
import { must } from "../support/must.ts";

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

function rawDb(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

/** A live sender endpoint: `send` and `query` require one (specs/fleet-tool.md#parameter-schema). */
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

test("a refused session's shutdown leaves the owner's record and its pending messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-refused-shutdown-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleetA = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "aaaaaaaa" });
    const fleetB = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bbbbbbbb" });
    let targetIdle = false;
    const inbox: string[] = [];
    const registeredA = fleetA.registerEndpoint(
      {
        sessionId: "sess-s",
        cwd: () => dir,
        isIdle: () => targetIdle,
        abortTurn: () => {},
        deliverTurn: (text) => {
          inbox.push(text);
        },
      },
      "running",
    );
    assert.equal(registeredA, true);
    registerSender(fleetA, "sender-a", dir);
    const sent = fleetA.enqueueSend({
      senderSessionId: "sender-a",
      target: must(fleetA.getSession("sess-s")),
      body: "work for S",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(sent.status, "pending");

    // The same session ID open in boot window B: its registration is refused
    // (specs/session-store.md#membership-lifecycle: one live owner).
    const registeredB = fleetB.registerEndpoint(
      {
        sessionId: "sess-s",
        cwd: () => dir,
        isIdle: () => false,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "running",
    );
    assert.equal(registeredB, false, "boot window B must be refused");

    // B's window shuts the session down anyway (the session_shutdown path).
    fleetB.unregisterEndpoint("sess-s");

    const row = must(
      rawDb(db)
        .prepare("SELECT owner_boot, state FROM fleet_sessions WHERE session_id = ?")
        .get("sess-s"),
    );
    assert.equal(row.owner_boot, "aaaaaaaa", "the owner keeps the record");
    const message = must(
      rawDb(db)
        .prepare("SELECT status FROM fleet_messages WHERE message_id = ?")
        .get(sent.messageId),
    );
    assert.equal(message.status, "pending", "the owner's pending message is untouched");
    assert.ok(fleetA.getSession("sess-s"), "the record stays resolvable for its owner");

    // The owner still delivers: the session is alive and owned.
    targetIdle = true;
    fleetA.drainForTarget("sess-s");
    assert.equal(inbox.length, 1, "the owned session still receives its messages");
    fleetA.close();
    fleetB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused session's reload release leaves the owner's ownership", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-refused-reload-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleetA = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "aaaaaaaa" });
    const fleetB = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bbbbbbbb" });
    let targetIdle = false;
    const registeredA = fleetA.registerEndpoint(
      {
        sessionId: "sess-s",
        cwd: () => dir,
        isIdle: () => targetIdle,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "running",
    );
    assert.equal(registeredA, true);
    registerSender(fleetA, "sender-a", dir);
    const sent = fleetA.enqueueSend({
      senderSessionId: "sender-a",
      target: must(fleetA.getSession("sess-s")),
      body: "work for S",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(sent.status, "pending");
    const registeredB = fleetB.registerEndpoint(
      {
        sessionId: "sess-s",
        cwd: () => dir,
        isIdle: () => false,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "running",
    );
    assert.equal(registeredB, false, "boot window B must be refused");

    // B's window reloads the session anyway (the session_shutdown path).
    fleetB.releaseEndpointForReload("sess-s");

    const row = must(
      rawDb(db)
        .prepare("SELECT owner_boot, state FROM fleet_sessions WHERE session_id = ?")
        .get("sess-s"),
    );
    assert.equal(row.owner_boot, "aaaaaaaa", "the owner keeps ownership");
    const message = must(
      rawDb(db)
        .prepare("SELECT status FROM fleet_messages WHERE message_id = ?")
        .get(sent.messageId),
    );
    assert.equal(message.status, "pending", "the owner's pending message is untouched");

    // A third boot window must not slip in while A is alive.
    const fleetC = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "cccccccc" });
    const registeredC = fleetC.registerEndpoint(
      {
        sessionId: "sess-s",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );
    assert.equal(registeredC, false, "the live owner keeps the session exclusively");
    fleetC.close();
    fleetA.close();
    fleetB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second live boot window is refused the session and delivers nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-one-owner-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleetA = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootA" });
    const fleetB = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootB" });
    let idle = false;
    const deliveries: string[] = [];
    const endpoint = (label: string) => ({
      sessionId: "shared-sess",
      cwd: () => dir,
      isIdle: () => idle,
      abortTurn: () => {},
      deliverTurn: (text: string) => {
        deliveries.push(`${label}:${text}`);
      },
    });
    assert.equal(fleetA.registerEndpoint(endpoint("A"), "running"), true);
    assert.equal(
      fleetB.registerEndpoint(endpoint("B"), "running"),
      false,
      "a second live boot window must not take over a live session",
    );

    registerSender(fleetA, "sender-1", dir);
    const tool = makeFleetTool({ fleet: fleetA, hostProvider: () => stubHost("sender-1", dir) });
    void tool.execute(
      "tc-1",
      { action: "send", target: "shared-sess", body: "hello" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    idle = true;
    fleetA.drainForTarget("shared-sess");
    fleetB.drainForTarget("shared-sess");
    assert.equal(deliveries.length, 1, "the message must be delivered exactly once");
    fleetA.close();
    fleetB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
