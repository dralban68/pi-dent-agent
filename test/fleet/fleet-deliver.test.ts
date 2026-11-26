/**
 * Delivery-contract tests for Fleet `send` (specs/fleet-tool.md#parameter-schema and specs/fleet-tool.md#send):
 * idle-gated followUp built-ins, target-side slash-command rendering, live-only
 * recipient resolution, steer abort settling before delivery, and abort validation.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Create a plugin command on disk and return its catalog entry. */
function pluginEntry(
  dir: string,
  name: string,
  command: string,
  template: string,
): { name: string; root: string; commands: Array<{ name: string; file: string }> } {
  const pluginDir = join(dir, `plugin-${name}`);
  mkdirSync(join(pluginDir, "commands"), { recursive: true });
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name }));
  writeFileSync(join(pluginDir, "commands", `${command}.md`), template);
  return {
    name,
    root: pluginDir,
    commands: [{ name: command, file: join(pluginDir, "commands", `${command}.md`) }],
  };
}

test("built-ins: followUp /compact waits for idle, steer /abort applies at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-deliver-builtin-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    let targetIdle = false;
    const applied: string[] = [];
    const turns: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "target-builtin",
        cwd: () => dir,
        isIdle: () => targetIdle,
        abortTurn: () => {},
        deliverTurn: (text, mode) => {
          turns.push(`${mode}:${text}`);
        },
        runBuiltinCommand: (name) => {
          applied.push(name);
          return true;
        },
      },
      "running",
    );
    registerSender(fleet, "sender-builtin", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-builtin", dir) });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const compact = await call({ action: "send", target: "target-builtin", body: "/compact" });
    assert.equal(
      compact.details.status,
      "pending",
      "a followUp built-in to a busy target must stay pending",
    );
    assert.deepEqual(applied, [], "nothing may apply while the target is busy");

    const abortCmd = await call({
      action: "send",
      target: "target-builtin",
      body: "/abort",
      deliver: "steer",
    });
    assert.equal(abortCmd.details.status, "delivered", "a steer built-in applies at once");
    assert.deepEqual(applied, ["abort"]);
    assert.deepEqual(turns, [], "built-ins never start a turn");

    targetIdle = true;
    fleet.recordTurnEnd("target-builtin");
    assert.deepEqual(applied, ["abort", "compact"], "the followUp built-in applies once idle");
    const status = await call({
      action: "status",
      messageId: compact.details.messageId,
    });
    assert.equal(status.details.status, "delivered");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slash commands render at delivery against the target coordinator's catalog; unknown rejects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-deliver-render-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const bootSender = emptyBoot(dir);
    bootSender.pluginIndex.set("rx", pluginEntry(dir, "rx", "ping", "Pong from sender: $1"));
    const bootTarget = emptyBoot(dir);
    bootTarget.pluginIndex.set("tx", pluginEntry(dir, "tx", "hello", "Hello from target: $1"));

    const fleetSender = new FleetCoordinator(bootSender, { dbPath, bootId: "bootSender" });
    const fleetTarget = new FleetCoordinator(bootTarget, { dbPath, bootId: "bootTarget" });
    const delivered: Array<{ text: string; mode: string }> = [];
    fleetTarget.registerEndpoint(
      {
        sessionId: "target-render",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text, mode) => {
          delivered.push({ text, mode });
        },
      },
      "idle",
    );
    registerSender(fleetSender, "sender-render", dir);
    const tool = makeFleetTool({
      fleet: fleetSender,
      hostProvider: () => stubHost("sender-render", dir),
    });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);
    const rawRow = (id: number) =>
      new DatabaseSync(dbPath)
        .prepare("SELECT body, deliver_text FROM fleet_messages WHERE message_id = ?")
        .get(id) as { body: string; deliver_text: string | null };
    const status = (messageId: number) =>
      call({ action: "status", messageId }).then((res) => res.details);

    // Target-only command: the sender's catalog cannot render it; the target's does.
    const targetCmd = await call({
      action: "send",
      target: "target-render",
      body: "/tx:hello world",
    });
    const targetId = targetCmd.details.messageId as number;
    assert.equal(
      targetCmd.details.status,
      "pending",
      "slash bodies are not rendered by the sender",
    );
    const stored = rawRow(targetId);
    assert.equal(stored.body, "/tx:hello world", "the raw body is stored");
    assert.equal(stored.deliver_text, null, "no sender-side rendering is persisted");
    fleetTarget.drainForTarget("target-render");
    assert.deepEqual(delivered, [{ text: "Hello from target: world", mode: "followUp" }]);

    // Sender-only command: unknown to the target catalog -> rejected at delivery.
    const senderCmd = await call({
      action: "send",
      target: "target-render",
      body: "/rx:ping world",
    });
    fleetTarget.drainForTarget("target-render");
    const senderStatus = await status(senderCmd.details.messageId as number);
    assert.equal(senderStatus.status, "rejected");
    assert.match(String(senderStatus.rejectionReason), /unknown plugin slash command/);

    // Unknown everywhere: still rejected at delivery, with a reason.
    const unknownCmd = await call({ action: "send", target: "target-render", body: "/bogus" });
    fleetTarget.drainForTarget("target-render");
    const unknownStatus = await status(unknownCmd.details.messageId as number);
    assert.equal(unknownStatus.status, "rejected");
    assert.match(String(unknownStatus.rejectionReason), /unsupported slash command/);

    // Plain text is still enveloped at enqueue.
    fleetTarget.recordTurnEnd("target-render"); // release the followUp lock from the delivered turn
    const plain = await call({
      action: "send",
      target: "target-render",
      subject: "note",
      body: "hello plain",
    });
    fleetTarget.drainForTarget("target-render");
    assert.deepEqual(
      rawRow(plain.details.messageId as number).deliver_text,
      "[Fleet from sender-render — note]\nhello plain",
    );
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1]?.text, "[Fleet from sender-render — note]\nhello plain");
    fleetSender.close();
    fleetTarget.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command token ends at the first U+0020 space, so a line break stays inside it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-deliver-token-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const boot = emptyBoot(dir);
    boot.pluginIndex.set("alpha", pluginEntry(dir, "alpha", "greet", "Hello $1"));
    const fleet = new FleetCoordinator(boot, { dbPath, bootId: "bootToken" });
    const delivered: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "target-token",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          delivered.push(text);
        },
      },
      "idle",
    );
    registerSender(fleet, "sender-token", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-token", dir) });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    // No U+0020 space: the line break belongs to the token (specs/slash-commands.md#registration).
    const sent = await call({
      action: "send",
      target: "target-token",
      body: "/alpha:greet\nWorld",
    });
    fleet.drainForTarget("target-token");
    const status = await call({ action: "status", messageId: sent.details.messageId });
    assert.equal(status.details.status, "rejected");
    assert.equal(
      status.details.rejectionReason,
      'unknown plugin slash command "/alpha:greet\nWorld"',
    );
    assert.deepEqual(delivered, [], "the line break does not end the command token");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ended sessions are unknown targets, by exact ID and by prefix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-deliver-resolve-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const endpoint = (sessionId: string) => ({
      sessionId,
      cwd: () => dir,
      isIdle: () => true,
      abortTurn: () => {},
      deliverTurn: () => {},
    });
    fleet.registerEndpoint(endpoint("live-target-1"), "idle");
    fleet.registerEndpoint(endpoint("ended-target-9999"), "idle");
    fleet.unregisterEndpoint("ended-target-9999"); // session ends; its row is deleted

    const exact = fleet.resolveRecipient("ended-target-9999");
    assert.equal(
      "error" in exact && exact.error,
      'unknown target session "ended-target-9999"',
      "an ended session must not resolve by exact ID",
    );
    const prefix = fleet.resolveRecipient("ended-target");
    assert.equal(
      "error" in prefix && prefix.error,
      'unknown target session "ended-target"',
      "an ended session must not resolve through the prefix fallback",
    );
    const live = fleet.resolveRecipient("live-target-1");
    assert.equal("session" in live && live.session.sessionId, "live-target-1");

    registerSender(fleet, "sender-resolve", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-resolve", dir) });
    const res = await tool.execute(
      "tc",
      { action: "send", target: "ended-target-9999", body: "hi" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(res.isError, true, "sending to an ended session must be a tool error");
    const text = res.content[0]?.type === "text" ? res.content[0].text : "";
    assert.match(text, /unknown target session "ended-target-9999"/);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session that ends loses its row and its pending inbound messages are rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-end-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db });
    fleet.registerEndpoint(
      {
        sessionId: "ended-target",
        cwd: () => dir,
        isIdle: () => false,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "running",
    );
    registerSender(fleet, "sender-end", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-end", dir) });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const sent = await call({ action: "send", target: "ended-target", body: "hello" });
    const messageId = sent.details.messageId as number;
    assert.equal(sent.details.status, "pending");

    fleet.unregisterEndpoint("ended-target");
    const check = new DatabaseSync(db);
    const row = check
      .prepare("SELECT COUNT(*) AS n FROM fleet_sessions WHERE session_id = ?")
      .get("ended-target") as { n: number };
    check.close();
    assert.equal(row.n, 0, "an ended session's row must be deleted, not marked");

    const status = await call({ action: "status", messageId });
    assert.equal(status.details.status, "rejected");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("steer with abort: true aborts once, then delivers only after the target is idle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-deliver-abort-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    let targetIdle = false;
    let aborts = 0;
    const turns: Array<{ text: string; idleAtDelivery: boolean }> = [];
    fleet.registerEndpoint(
      {
        sessionId: "target-abort",
        cwd: () => dir,
        isIdle: () => targetIdle,
        abortTurn: () => {
          aborts += 1;
        },
        deliverTurn: (text) => {
          turns.push({ text, idleAtDelivery: targetIdle });
        },
      },
      "running",
    );
    registerSender(fleet, "sender-abort", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-abort", dir) });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const sent = await call({
      action: "send",
      target: "target-abort",
      body: "take over",
      deliver: "steer",
      abort: true,
    });
    assert.equal(aborts, 1, "the active turn is aborted first");
    assert.equal(
      sent.details.status,
      "pending",
      "the message stays pending while the aborted turn settles",
    );
    assert.equal(turns.length, 0, "nothing is injected back to back with the abort");

    // Poll ticks while the aborted turn is still settling: no re-abort, no delivery.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(aborts, 1, "the abort is requested once, not on every poll tick");
    assert.equal(turns.length, 0);

    targetIdle = true;
    fleet.recordTurnEnd("target-abort");
    assert.equal(turns.length, 1, "delivery happens once the target is idle");
    assert.equal(turns[0]?.idleAtDelivery, true, "the message starts a new turn only after idle");
    assert.equal(turns[0]?.text.includes("take over"), true);
    const status = await call({ action: "status", messageId: sent.details.messageId });
    assert.equal(status.details.status, "delivered");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abort: false is a no-op with any delivery mode; abort: true with followUp stays an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-deliver-abortflag-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    fleet.registerEndpoint(
      {
        sessionId: "target-flag",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );
    registerSender(fleet, "sender-flag", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-flag", dir) });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const followUp = await call({
      action: "send",
      target: "target-flag",
      body: "plain followUp",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(followUp.isError, undefined, "abort: false is accepted with followUp");
    assert.equal(followUp.details.status, "delivered");

    const steer = await call({
      action: "send",
      target: "target-flag",
      body: "plain steer",
      deliver: "steer",
      abort: false,
    });
    assert.equal(steer.isError, undefined, "abort: false is accepted with steer");
    assert.equal(steer.details.status, "delivered");

    const rejected = await call({
      action: "send",
      target: "target-flag",
      body: "bad combo",
      deliver: "followUp",
      abort: true,
    });
    assert.equal(rejected.isError, true, "abort: true with followUp stays a tool error");
    const text = rejected.content[0]?.type === "text" ? rejected.content[0].text : "";
    assert.match(text, /abort: true is valid only with deliver: "steer"/);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plugin slash command is rendered once per delivery attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-deliver-render-once-"));
  try {
    const entry = pluginEntry(dir, "tx", "hello", "First render: $1");
    const templateFile = at(entry.commands, 0).file;
    const boot = emptyBoot(dir);
    boot.pluginIndex.set("tx", entry);
    const fleet = new FleetCoordinator(boot, { dbPath: join(dir, "fleet.sqlite") });
    const delivered: string[] = [];
    let armed = false;
    let idleCalls = 0;
    fleet.registerEndpoint(
      {
        sessionId: "target-render-once",
        cwd: () => dir,
        isIdle: () => {
          if (armed) {
            idleCalls += 1;
            // The idle check of the delivery flow runs between its preparations: a
            // second render would read the rewritten template.
            if (idleCalls === 3) writeFileSync(templateFile, "Second render: $1");
          }
          return true;
        },
        abortTurn: () => {},
        deliverTurn: (text) => {
          delivered.push(text);
        },
      },
      "idle",
    );
    registerSender(fleet, "sender-render-once", dir);
    const tool = makeFleetTool({
      fleet,
      hostProvider: () => stubHost("sender-render-once", dir),
    });
    armed = true;
    const res = await tool.execute(
      "tc",
      { action: "send", target: "target-render-once", body: "/tx:hello world" } as never,
      undefined,
      undefined,
      undefined as never,
    );

    assert.equal(res.details.status, "delivered");
    assert.ok(idleCalls >= 2, "the delivery consults the target's idle report");
    assert.deepEqual(delivered, ["First render: world"], "the delivered text is that one render");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a delivered followUp stops gating later deliveries once its turn starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-deliver-turn-start-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const delivered: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "target-turn-flag",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          delivered.push(text);
        },
      },
      "idle",
    );
    registerSender(fleet, "sender-turn-flag", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-turn-flag", dir) });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const first = await call({ action: "send", target: "target-turn-flag", body: "first" });
    assert.equal(first.details.status, "delivered");
    assert.equal(delivered.length, 1, "a followUp awaits the turn start of the delivered message");

    // The injected turn starts; its `agent_end` never arrives.
    fleet.recordTurnStart("target-turn-flag", dir, "first");
    assert.equal(must(fleet.getSession("target-turn-flag")).turns.length, 1);

    const second = await call({ action: "send", target: "target-turn-flag", body: "second" });
    assert.equal(
      second.details.status,
      "delivered",
      "the followUp whose turn started no longer gates delivery",
    );
    assert.deepEqual(delivered.length, 2);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * specs/session-store.md#session-records and specs/session-store.md#delivery scope the `followUp` rules to `kind`
 * `send`: a delivered `query` neither makes the target `running` nor holds back
 * a later `followUp` message of the same session.
 */
test("a delivered query leaves the target idle and holds back no later followUp", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-deliver-query-state-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const turns: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "target-query-state",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text, mode) => {
          turns.push(`${mode}:${text}`);
        },
        runQuery: (query) => Promise.resolve({ text: `answer to ${query.body}`, isError: false }),
      },
      "idle",
    );
    registerSender(fleet, "sender-query-state", dir);
    const tool = makeFleetTool({
      fleet,
      hostProvider: () => stubHost("sender-query-state", dir),
    });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const queried = await call({ action: "query", target: "target-query-state", body: "status?" });
    assert.equal(queried.isError, undefined);
    assert.equal(
      must(fleet.getSession("target-query-state")).state,
      "idle",
      "a delivered query never marks the target running",
    );

    const sent = await call({ action: "send", target: "target-query-state", body: "next step" });
    assert.equal(
      sent.details.status,
      "delivered",
      "a later followUp message is not held back by the delivered query",
    );
    assert.equal(turns.length, 1, "the later followUp message delivers at once");
    assert.match(at(turns, 0), /\nnext step$/);
    assert.equal(
      must(fleet.getSession("target-query-state")).state,
      "running",
      "the followUp turn marks the target running",
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Let a resolved dispatch settle and deliver its reply. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test("a send to a target that ended before its row was written is rejected, never left pending", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-deliver-vanished-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    fleet.registerEndpoint(
      {
        sessionId: "target-vanished",
        cwd: () => dir,
        isIdle: () => false,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "running",
    );
    registerSender(fleet, "sender-vanished", dir);
    // The resolution a `send` does first, then the target ends before the write
    // (specs/session-store.md#membership-lifecycle: no message waits for an ended session).
    const resolved = fleet.resolveRecipient("target-vanished");
    assert.ok("session" in resolved, "the target resolves before it ends");
    fleet.unregisterEndpoint("target-vanished");

    const sent = fleet.enqueueSend({
      senderSessionId: "sender-vanished",
      target: resolved.session,
      body: "too late",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(sent.status, "rejected");
    assert.equal(sent.rejectionReason, "target session ended before delivery");
    assert.equal(
      fleet.getMessageStatus("sender-vanished", sent.messageId).status,
      "rejected",
      "the sender's poll of the message ends instead of waiting for a reply that cannot come",
    );

    const queued = fleet.enqueueQuery({
      senderSessionId: "sender-vanished",
      target: resolved.session,
      body: "anyone?",
    });
    assert.equal(
      fleet.getMessageStatus("sender-vanished", queued.messageId).status,
      "rejected",
      "a query to the same ended target is rejected as well",
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a waited query to a target that ended before the row was written fails at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-wait-vanished-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    fleet.registerEndpoint(
      {
        sessionId: "target-vanished",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        runQuery: () => Promise.resolve({ text: "never asked", isError: false }),
      },
      "idle",
    );
    const resolved = fleet.resolveRecipient("target-vanished");
    assert.ok("session" in resolved, "the target resolves before it ends");
    fleet.unregisterEndpoint("target-vanished");

    const waited = fleet.queryAndWait({
      senderSessionId: "child-session-0002",
      cwd: dir,
      target: resolved.session,
      body: "report?",
    });
    await assert.rejects(waited.reply, /target session ended before delivery/);
    assert.equal(
      fleet.getSession("child-session-0002"),
      undefined,
      "the failed wait leaves no hidden record behind",
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a delivered followUp whose turn has not started still reports the target as running", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-deliver-state-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const turns: string[] = [];
    fleet.registerEndpoint(
      {
        sessionId: "target-state",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          turns.push(text);
        },
      },
      "idle",
    );
    registerSender(fleet, "sender-state", dir);
    const target = must(fleet.getSession("target-state"));

    const first = fleet.enqueueSend({
      senderSessionId: "sender-state",
      target,
      body: "one",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(first.status, "delivered", "the idle target accepts the first turn");
    assert.equal(
      must(fleet.getSession("target-state")).state,
      "running",
      "the delivered turn makes the target running until that turn starts",
    );

    const second = fleet.enqueueSend({
      senderSessionId: "sender-state",
      target,
      body: "two",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(
      second.state,
      "running",
      "a send reports the state its message queues behind, not the idle host report",
    );
    assert.equal(second.status, "pending");
    assert.deepEqual(turns.length, 1);

    // The turn starts and ends: the queue moves, and the target reads idle again.
    fleet.recordTurnStart("target-state", dir, "one");
    fleet.recordTurnEnd("target-state");
    assert.equal(
      fleet.getMessageStatus("sender-state", second.messageId).status,
      "delivered",
      "the queued followUp is delivered when the earlier turn ends",
    );
    fleet.recordTurnStart("target-state", dir, "two");
    fleet.recordTurnEnd("target-state");
    const third = fleet.enqueueSend({
      senderSessionId: "sender-state",
      target: must(fleet.getSession("target-state")),
      body: "three",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(third.state, "idle");
    assert.equal(third.status, "delivered");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reply the store refuses is reported to the target's user and never resent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-deliver-reply-fail-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath });
    const inbox: string[] = [];
    const notified: string[] = [];
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
    let neverSettles = false;
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
        runQuery: () =>
          neverSettles
            ? new Promise(() => {})
            : Promise.resolve({ text: "answer", isError: false }),
      },
      "idle",
    );
    refuseReplyInserts(dbPath);

    fleet.enqueueQuery({
      senderSessionId: "querier-sess",
      target: must(fleet.getSession("target-sess")),
      body: "what changed?",
    });
    await flush();
    assert.deepEqual(inbox, [], "a reply the store refused is not delivered");
    assert.equal(notified.length, 1, "the target's user is told the reply failed");
    assert.match(
      at(notified, 0),
      /^pi-dent: Fleet query reply to querier-sess failed: reply transport refused$/,
    );

    // The cancellation reply takes the same path.
    neverSettles = true;
    fleet.enqueueQuery({
      senderSessionId: "querier-sess",
      target: must(fleet.getSession("target-sess")),
      body: "and now?",
    });
    fleet.unregisterEndpoint("target-sess");
    assert.equal(notified.length, 2, "the cancelled query's failed reply is reported too");
    assert.match(at(notified, 1), /pi-dent: Fleet query reply to querier-sess failed: /);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A store that refuses every query reply: the trigger stands for a store write failure. */
function refuseReplyInserts(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TRIGGER refuse_reply_insert BEFORE INSERT ON fleet_messages WHEN NEW.body LIKE '[Fleet query reply%' BEGIN SELECT RAISE(ABORT, 'reply transport refused'); END",
    );
  } finally {
    db.close();
  }
}

test("a failed followUp delivery rejects the message and frees the queue for later ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-delivery-fail-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const calls: string[] = [];
    let failNext = true;
    fleet.registerEndpoint(
      {
        sessionId: "target-1",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text) => {
          calls.push(text);
          if (failNext) {
            failNext = false;
            const p = Promise.reject(new Error("injection failed"));
            p.catch(() => {}); // keep the test process alive; the coordinator must handle it
            return p;
          }
        },
      },
      "idle",
    );
    registerSender(fleet, "sender-1", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-1", dir) });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const first = await call({ action: "send", target: "target-1", body: "one" });
    const firstId = first.details.messageId as number;
    await new Promise((r) => setTimeout(r, 10));
    const firstStatus = await call({ action: "status", messageId: firstId });
    assert.equal(
      firstStatus.details.status,
      "rejected",
      "a failed injection must not be reported as delivered",
    );

    const second = await call({ action: "send", target: "target-1", body: "two" });
    assert.equal(
      second.details.status,
      "delivered",
      "a failed delivery must not wedge the followUp queue for later messages",
    );
    assert.deepEqual(calls.filter((c) => c.endsWith("two")).length, 1);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a built-in the host cannot apply is rejected, never reported delivered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-builtin-unsupported-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    fleet.registerEndpoint(
      {
        sessionId: "target-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
        // no runBuiltinCommand
      },
      "idle",
    );
    registerSender(fleet, "sender-1", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-1", dir) });
    const res = await tool.execute(
      "tc-1",
      { action: "send", target: "target-sess", body: "/compact" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(res.isError, true, "an unapplicable built-in must be an error, not delivered");
    assert.equal(res.details.status, "rejected");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a followUp host command holds back later followUp rows of the same delivery pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-host-command-pass-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    let targetIdle = false;
    const turns: string[] = [];
    const builtins: string[] = [];
    let aborts = 0;
    fleet.registerEndpoint(
      {
        sessionId: "target-3",
        cwd: () => dir,
        isIdle: () => targetIdle,
        abortTurn: () => {
          aborts += 1;
        },
        deliverTurn: (text) => {
          turns.push(text);
        },
        runBuiltinCommand: (name) => {
          builtins.push(name);
          return true;
        },
      },
      "running",
    );
    registerSender(fleet, "sender-3", dir);
    const target = must(fleet.getSession("target-3"));

    // All three rows queue while the target is busy.
    const compact = fleet.enqueueSend({
      senderSessionId: "sender-3",
      target,
      body: "/compact",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(compact.status, "pending");
    const steer = fleet.enqueueSend({
      senderSessionId: "sender-3",
      target,
      body: "urgent note",
      deliver: "steer",
      abort: true,
    });
    assert.equal(steer.status, "pending", "the steer abort request stays pending while busy");
    assert.equal(aborts, 1, "the steer abort is requested once");
    const next = fleet.enqueueSend({
      senderSessionId: "sender-3",
      target,
      body: "do X",
      deliver: "followUp",
      abort: false,
    });
    assert.equal(next.status, "pending");

    // One pass over the three rows.
    targetIdle = true;
    fleet.drainForTarget("target-3");

    assert.deepEqual(builtins, ["compact"], "the host command is applied");
    assert.equal(turns.length, 1, "the steer row of the same pass is still handled");
    const status = fleet.getMessageStatus("sender-3", next.messageId);
    assert.equal(
      status.status,
      "pending",
      "the followUp after a host command waits for the next pass",
    );

    // The next pass delivers it; nothing is lost.
    fleet.drainForTarget("target-3");
    assert.equal(turns.length, 2, "the deferred followUp is delivered in the next pass");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
