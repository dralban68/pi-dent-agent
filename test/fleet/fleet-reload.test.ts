/**
 * Reload conformance for specs/fleet-tool.md Section 5: a `/reload` neither
 * ends a session nor cancels a pending message; `status` covers only the
 * caller's current boot window.
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

/** The Fleet tool params these tests drive; `FleetToolParams`'s Static type is all-`unknown`, so a local shape is used. */
type FleetCallParams = {
  action: "send" | "status";
  target?: string;
  body?: string;
  messageId?: number;
};

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

test("reload: session stays live, pending queues survive, new boot window delivers and reports old messages unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-reload-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleetOld = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "boot-old" });

    const oldSInbox: string[] = [];
    const oldTInbox: string[] = [];
    // Both sessions are mid-turn so followUp rows stay pending across the reload.
    fleetOld.registerEndpoint(
      {
        sessionId: "sess-s",
        cwd: () => dir,
        isIdle: () => false,
        abortTurn: () => {},
        deliverTurn: (text) => {
          oldSInbox.push(text);
        },
      },
      "running",
    );
    fleetOld.registerEndpoint(
      {
        sessionId: "sess-t",
        cwd: () => dir,
        isIdle: () => false,
        abortTurn: () => {},
        deliverTurn: (text) => {
          oldTInbox.push(text);
        },
      },
      "running",
    );

    const toolS = makeFleetTool({ fleet: fleetOld, hostProvider: () => stubHost("sess-s", dir) });
    const toolT = makeFleetTool({ fleet: fleetOld, hostProvider: () => stubHost("sess-t", dir) });
    const call = (tool: ReturnType<typeof makeFleetTool>, params: FleetCallParams) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    // A peer message pending to S, and S's own pending outbound to T.
    const inbound = await call(toolT, { action: "send", target: "sess-s", body: "work for S" });
    const inboundId = inbound.details.messageId as number;
    assert.equal(inbound.details.status, "pending");
    const outbound = await call(toolS, { action: "send", target: "sess-t", body: "work for T" });
    const outboundId = outbound.details.messageId as number;
    assert.equal(outbound.details.status, "pending");
    assert.equal(oldSInbox.length, 0);
    assert.equal(oldTInbox.length, 0);

    // Reload both sessions: ownership released, sessions stay live.
    fleetOld.releaseEndpointForReload("sess-s");
    fleetOld.releaseEndpointForReload("sess-t");
    assert.ok(fleetOld.getSession("sess-s"), "reload must not end the session");
    assert.ok(
      fleetOld.listSessions("machine", dir).some((s) => s.sessionId === "sess-s"),
      "a reloaded session stays listed",
    );
    fleetOld.close({ keepPending: true });

    const rows = (
      rawDb(db)
        .prepare("SELECT message_id, status FROM fleet_messages ORDER BY message_id")
        .all() as Array<{ message_id: number; status: string }>
    ).map((row) => ({ message_id: row.message_id, status: row.status }));
    assert.deepEqual(
      rows,
      [
        { message_id: inboundId, status: "pending" },
        { message_id: outboundId, status: "pending" },
      ],
      "a reload must not clear or dead-letter pending rows",
    );

    // The new boot window re-registers the same session IDs and delivers.
    const fleetNew = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "boot-new" });
    const newSInbox: string[] = [];
    const newTInbox: string[] = [];
    assert.equal(
      fleetNew.registerEndpoint(
        {
          sessionId: "sess-s",
          cwd: () => dir,
          isIdle: () => true,
          abortTurn: () => {},
          deliverTurn: (text) => {
            newSInbox.push(text);
          },
        },
        "idle",
      ),
      true,
      "re-registration after reload must succeed",
    );
    assert.equal(
      fleetNew.registerEndpoint(
        {
          sessionId: "sess-t",
          cwd: () => dir,
          isIdle: () => true,
          abortTurn: () => {},
          deliverTurn: (text) => {
            newTInbox.push(text);
          },
        },
        "idle",
      ),
      true,
    );
    assert.deepEqual(newSInbox, ["[Fleet from sess-t]\nwork for S"]);
    assert.deepEqual(newTInbox, ["[Fleet from sess-s]\nwork for T"]);

    // status from the new boot window: pre-reload messages are unknown.
    const toolNewS = makeFleetTool({
      fleet: fleetNew,
      hostProvider: () => stubHost("sess-s", dir),
    });
    const toolNewT = makeFleetTool({
      fleet: fleetNew,
      hostProvider: () => stubHost("sess-t", dir),
    });
    const stOut = await call(toolNewS, { action: "status", messageId: outboundId });
    assert.equal(stOut.details.status, "unknown");
    const stIn = await call(toolNewT, { action: "status", messageId: inboundId });
    assert.equal(stIn.details.status, "unknown");

    fleetNew.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("quit: pending inbound messages are dead-lettered as rejected and the boot window is cleared", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-quit-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "boot-quit" });
    fleet.registerEndpoint(
      {
        sessionId: "sess-q",
        cwd: () => dir,
        isIdle: () => false,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "running",
    );
    registerSender(fleet, "sender-q", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-q", dir) });
    const call = (params: FleetCallParams) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const sent = await call({ action: "send", target: "sess-q", body: "hello" });
    const messageId = sent.details.messageId as number;
    assert.equal(sent.details.status, "pending");

    // Quit path: unregister + full boot-window clear keep today's behavior.
    fleet.unregisterEndpoint("sess-q");
    assert.equal(fleet.getSession("sess-q"), undefined, "quit ends the session");
    const status = await call({ action: "status", messageId });
    assert.equal(status.details.status, "rejected");

    fleet.close();
    const rows = rawDb(db)
      .prepare("SELECT COUNT(*) AS n FROM fleet_messages WHERE boot_id = 'boot-quit'")
      .get() as { n: number };
    assert.equal(rows.n, 0, "quit clears the boot window's rows as before");
    const next = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "boot-after" });
    assert.equal(next.getMessageStatus("sender-q", messageId).status, "unknown");
    next.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
