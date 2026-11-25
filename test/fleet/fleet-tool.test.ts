import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BootSnapshot } from "../../lib/engine.ts";
import {
  extractChangedFiles,
  FleetCoordinator,
  type FleetSessionRecord,
  formatFleetList,
  resolveRepoRoot,
} from "../../lib/fleet.ts";
import type { HostSession } from "../../lib/host.ts";
import { fleetParameterSchema, makeFleetTool } from "../../lib/tools.ts";
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

test("Fleet schema: flat object schema with required action and additionalProperties false", () => {
  assert.equal(fleetParameterSchema.type, "object");
  assert.equal(Reflect.get(fleetParameterSchema, "additionalProperties"), false);
  assert.deepEqual(fleetParameterSchema.required, ["action"]);
});

test("Fleet parameter validation: rejects invalid actions and action/field combinations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-val-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    registerSender(fleet, "sess-a", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sess-a", dir) });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc-1", params as never, undefined, undefined, undefined as never);

    const badAction = await call({ action: "unknown" });
    assert.equal(badAction.isError, true);

    const listWithBody = await call({ action: "list", body: "nope" });
    assert.equal(listWithBody.isError, true);

    const sendWithScope = await call({
      action: "send",
      target: "sess-b",
      body: "hi",
      scope: "repo",
    });
    assert.equal(sendWithScope.isError, true);

    const sendAbortOnFollowUp = await call({
      action: "send",
      target: "sess-b",
      body: "hi",
      deliver: "followUp",
      abort: true,
    });
    assert.equal(sendAbortOnFollowUp.isError, true);

    const sendMultipleModes = await call({
      action: "send",
      target: "sess-b",
      broadcast: "machine",
      body: "hi",
    });
    assert.equal(sendMultipleModes.isError, true);

    const queryWithTargets = await call({
      action: "query",
      target: "sess-b",
      targets: ["sess-b"],
      body: "question?",
    });
    assert.equal(queryWithTargets.isError, true);

    const statusWithBody = await call({ action: "status", messageId: 1, body: "nope" });
    assert.equal(statusWithBody.isError, true);

    // fleet-tool.md Section 1: `status` carries an integer `messageId`, nothing else.
    const statusWithoutId = await call({ action: "status" });
    assert.equal(statusWithoutId.isError, true);
    assert.equal(
      textOf(statusWithoutId),
      'messageId is required and must be an integer for action "status"',
    );
    const statusWithFraction = await call({ action: "status", messageId: 1.5 });
    assert.equal(statusWithFraction.isError, true);
    assert.equal(
      textOf(statusWithFraction),
      'messageId is required and must be an integer for action "status"',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet list: running-first ordering, repo/worktree vs machine scope, and formats", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-list-"));
  try {
    // Create repo1 (main checkout) and a linked worktree of repo1, plus repo2.
    const repo1 = join(dir, "repo1");
    const repo1Git = join(repo1, ".git");
    const repo1WorktreeGit = join(repo1Git, "worktrees", "wt1");
    mkdirSync(repo1WorktreeGit, { recursive: true });
    writeFileSync(join(repo1WorktreeGit, "commondir"), "../..");

    const wt1 = join(dir, "repo1-wt1");
    mkdirSync(wt1, { recursive: true });
    writeFileSync(join(wt1, ".git"), `gitdir: ${repo1WorktreeGit}\n`);

    const repo2 = join(dir, "repo2");
    mkdirSync(join(repo2, ".git"), { recursive: true });

    assert.equal(resolveRepoRoot(repo1), resolveRepoRoot(wt1));
    assert.notEqual(resolveRepoRoot(repo1), resolveRepoRoot(repo2));

    const fleet = new FleetCoordinator(emptyBoot(repo1), { dbPath: join(dir, "fleet.sqlite") });
    fleet.upsertSession({
      sessionId: "sess-idle-repo1",
      cwd: repo1,
      state: "idle",
      turns: [{ command: "check status", goal: "Checking repo status", files: [], startedAt: 1 }],
    });
    fleet.upsertSession({
      sessionId: "sess-running-wt1",
      cwd: wt1,
      state: "running",
      turns: [
        { command: "edit files", goal: "Updating index.ts", files: ["index.ts"], startedAt: 2 },
      ],
    });
    fleet.upsertSession({
      sessionId: "sess-running-repo2",
      cwd: repo2,
      state: "running",
      turns: [
        { command: "other repo work", goal: "Building repo2", files: ["pkg.json"], startedAt: 3 },
      ],
    });

    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sess-idle-repo1", repo1) });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc-1", params as never, undefined, undefined, undefined as never);

    // Machine scope: all 3 sessions, running sessions first.
    const machineRes = await call({ action: "list", scope: "machine" });
    const machineSessions = machineRes.details.sessions as Array<{
      sessionId: string;
      state: string;
    }>;
    assert.equal(machineSessions.length, 3);
    assert.equal(machineSessions[0]?.state, "running");
    assert.equal(machineSessions[1]?.state, "running");
    assert.equal(machineSessions[2]?.sessionId, "sess-idle-repo1");

    // Repo scope: shares repo1 and wt1, excludes repo2.
    const repoRes = await call({ action: "list", scope: "repo" });
    const repoSessions = repoRes.details.sessions as Array<{
      sessionId: string;
      state: string;
    }>;
    assert.deepEqual(
      repoSessions.map((s) => s.sessionId),
      ["sess-running-wt1", "sess-idle-repo1"],
    );

    // Default format (omitted) is compact
    const defaultRes = await call({ action: "list", scope: "repo" });
    assert.equal(defaultRes.details.format, "compact");
    const defaultText = defaultRes.content[0]?.type === "text" ? defaultRes.content[0].text : "";
    assert.match(defaultText, /^sess-running-wt1 · instance · running · /m);

    for (const format of ["compact", "full", "json"] as const) {
      const res = await call({ action: "list", scope: "repo", format });
      assert.equal(res.isError, undefined);
      assert.equal(res.details.format, format);
      const text = res.content[0]?.type === "text" ? res.content[0].text : "";
      assert.equal(text.includes("sess-running-wt1"), true);
    }

    // targets format was removed and must be rejected
    const badFormat = await call({ action: "list", scope: "repo", format: "targets" });
    assert.equal(badFormat.isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet send & status: steer, followUp queueing behind running target, fan-out deduplication, slash commands, and boot-window lifetime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-send-"));
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
    let targetIdle = false;
    let abortedCount = 0;
    const delivered: Array<{ text: string; mode: string }> = [];

    fleet.registerEndpoint(
      {
        sessionId: "target-session-1234",
        cwd: () => dir,
        isIdle: () => targetIdle,
        abortTurn: () => {
          abortedCount += 1;
        },
        deliverTurn: (text, mode) => {
          delivered.push({ text, mode });
        },
      },
      "running",
    );

    registerSender(fleet, "sender-session-0001", dir);
    const senderTool = makeFleetTool({
      fleet,
      hostProvider: () => stubHost("sender-session-0001", dir),
    });
    const otherTool = makeFleetTool({
      fleet,
      hostProvider: () => stubHost("other-session-0002", dir),
    });
    const call = (params: Record<string, unknown>) =>
      senderTool.execute("tc-1", params as never, undefined, undefined, undefined as never);

    // 1. followUp while target is running stays pending until target becomes idle.
    const followUpSend = await call({
      action: "send",
      target: "target-session", // unique prefix resolution
      subject: "sync",
      body: "Wait until idle",
    });
    const followUpId = followUpSend.details.messageId as number;
    assert.equal(followUpSend.details.state, "running");
    assert.match(
      followUpSend.content[0]?.type === "text" ? followUpSend.content[0].text : "",
      /target state: running/,
    );
    assert.equal(followUpSend.details.status, "pending");
    assert.equal(delivered.length, 0);

    const pendingStatus = await call({ action: "status", messageId: followUpId });
    assert.equal(pendingStatus.details.status, "pending");

    // Another session cannot see sender's messageId.
    const otherStatus = await otherTool.execute(
      "tc-2",
      { action: "status", messageId: followUpId } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(otherStatus.details.status, "unknown");

    // 2. steer with abort: true aborts the active turn; the message stays
    // pending and starts a new turn once the target is idle (spec 3.2).
    const steerSend = await call({
      action: "send",
      target: "target-session-1234",
      body: "Urgent steer",
      deliver: "steer",
      abort: true,
    });
    const steerId = steerSend.details.messageId as number;
    assert.equal(abortedCount, 1);
    assert.equal(steerSend.details.status, "pending");
    assert.equal(delivered.length, 0);

    // 3. Queue a second followUp while still running, then transition to idle:
    // the first followUp and the post-abort steer deliver on the first idle
    // transition; the second followUp stays pending until the next turn ends.
    const followUpSend2 = await call({
      action: "send",
      target: "target-session-1234",
      body: "Second followUp",
    });
    const followUpId2 = followUpSend2.details.messageId as number;

    targetIdle = true;
    fleet.recordTurnEnd("target-session-1234");
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0]?.mode, "followUp");
    assert.equal(delivered[1]?.mode, "steer");
    const steerStatus = await call({ action: "status", messageId: steerId });
    assert.equal(steerStatus.details.status, "delivered");

    const deliveredStatus = await call({ action: "status", messageId: followUpId });
    assert.equal(deliveredStatus.details.status, "delivered");
    const stillPendingStatus2 = await call({ action: "status", messageId: followUpId2 });
    assert.equal(stillPendingStatus2.details.status, "pending");

    // Second turn completes -> second followUp delivers.
    fleet.recordTurnEnd("target-session-1234");
    assert.equal(delivered.length, 3);
    const deliveredStatus2 = await call({ action: "status", messageId: followUpId2 });
    assert.equal(deliveredStatus2.details.status, "delivered");

    // Next turn completes so target is idle for subsequent tests.
    fleet.recordTurnEnd("target-session-1234");

    // 4. Plugin slash command body renders and delivers; unknown slash command rejects.
    const pluginCmdSend = await call({
      action: "send",
      target: "target-session-1234",
      body: "/rx:ping world",
    });
    assert.equal(pluginCmdSend.details.status, "delivered");
    assert.equal(delivered[3]?.text, "Pong: world");
    fleet.recordTurnEnd("target-session-1234");

    const badCmdSend = await call({
      action: "send",
      target: "target-session-1234",
      body: "/unknown:cmd",
    });
    assert.equal(badCmdSend.isError, true);
    assert.equal(badCmdSend.details.status, "rejected");

    // 5. Fan-out deduplicates targets and isolates failures.
    const fanoutRes = await call({
      action: "send",
      targets: ["target-session-1234", "target-session", "nonexistent-target"],
      body: "Fanout hello",
    });
    const fanoutDetails = fanoutRes.details as {
      recipients: Array<{ state: string }>;
      failed: unknown[];
    };
    assert.equal(fanoutDetails.recipients.length, 1);
    assert.equal(at(fanoutDetails.recipients, 0).state, "idle");
    assert.match(
      fanoutRes.content[0]?.type === "text" ? fanoutRes.content[0].text : "",
      /state=idle/,
    );
    assert.equal(fanoutDetails.failed.length, 1);

    // 6. Boot-window boundary clears sent-message rows -> status returns unknown.
    fleet.close();
    const fleetAfterReload = new FleetCoordinator(boot, { dbPath: join(dir, "fleet.sqlite") });
    const clearedStatus = fleetAfterReload.getMessageStatus("sender-session-0001", followUpId);
    assert.equal(clearedStatus.status, "unknown");
    fleetAfterReload.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet recipient resolution: exact ID wins over prefix matches and SQL wildcards are escaped", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-resolve-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    fleet.upsertSession({ sessionId: "abc", cwd: dir, state: "idle" });
    fleet.upsertSession({ sessionId: "abc-2", cwd: dir, state: "idle" });

    const resolved = fleet.resolveRecipient("abc");
    assert.equal("session" in resolved && resolved.session.sessionId, "abc");

    const ambiguous = fleet.resolveRecipient("ab");
    assert.match("error" in ambiguous ? ambiguous.error : "", /ambiguous target prefix/);

    // SQL wildcard % does not match arbitrary sessions.
    const wildcard = fleet.resolveRecipient("%");
    assert.equal("error" in wildcard, true);

    // The ambiguous list is in the host's locale-sensitive order, as fleet-tool.md
    // Section 1 requires; code-unit order would put "pB-x" first.
    fleet.upsertSession({ sessionId: "pB-x", cwd: dir, state: "idle" });
    fleet.upsertSession({ sessionId: "pa-x", cwd: dir, state: "idle" });
    const localeAmbiguous = fleet.resolveRecipient("p");
    assert.equal(
      "error" in localeAmbiguous ? localeAmbiguous.error : "",
      'ambiguous target prefix "p" matches pa-x, pB-x',
    );

    assert.deepEqual(
      extractChangedFiles("apply_patch", {}, { files: [{ path: "a.ts", moveTo: "b.ts" }] }, false),
      ["a.ts", "b.ts"],
    );
    assert.deepEqual(
      extractChangedFiles("Apply_Patch", {}, { files: [{ path: "c.ts" }] }, false),
      ["c.ts"],
      "tool names are compared in lowercase (session-store.md Section 2)",
    );
    assert.deepEqual(
      extractChangedFiles("applypatch", {}, { files: [{ path: "d.ts" }] }, false),
      [],
      "only the tool the spec names records files; no other spelling does",
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet query: runs isolated background query on target and delivers one followUp reply quoting correlationId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-query-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const senderInbox: Array<{ text: string; mode: string }> = [];

    fleet.registerEndpoint(
      {
        sessionId: "sender-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: (text, mode) => {
          senderInbox.push({ text, mode });
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
        runQuery: async (query) => ({
          text: `Answered: ${query.body}`,
          isError: false,
        }),
      },
      "idle",
    );

    const senderTool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-sess", dir) });
    const res = await senderTool.execute(
      "tc-q",
      { action: "query", target: "target-sess", body: "What branch are you on?" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    const details = res.details as {
      messageId: number;
      correlationId: string;
      target: string;
      state: string;
    };
    assert.equal(details.target, "target-sess");
    assert.equal(details.state, "idle");
    assert.equal(typeof details.correlationId, "string");
    assert.match(res.content[0]?.type === "text" ? res.content[0].text : "", /target state: idle/);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(senderInbox.length, 1);
    assert.equal(senderInbox[0]?.mode, "followUp");
    assert.equal(senderInbox[0]?.text.includes(details.correlationId), true);
    assert.equal(senderInbox[0]?.text.includes("Answered: What branch are you on?"), true);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet query: query body starting with / is delivered verbatim and never parsed as slash command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-query-slash-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    let receivedTask: string | undefined;

    fleet.registerEndpoint(
      {
        sessionId: "sender-sess",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
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
        runQuery: async (query) => {
          receivedTask = query.body;
          return { text: `Processed: ${query.body}`, isError: false };
        },
      },
      "idle",
    );

    const senderTool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-sess", dir) });

    // A body starting with /unknown command
    const res = await senderTool.execute(
      "tc-q-slash",
      { action: "query", target: "target-sess", body: "/unknown command with args" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(res.isError, undefined);
    assert.equal(receivedTask, "/unknown command with args", "query body is delivered verbatim");

    // A body starting with built-in command like /compact
    const res2 = await senderTool.execute(
      "tc-q-compact",
      { action: "query", target: "target-sess", body: "/compact" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(res2.isError, undefined);
    assert.equal(receivedTask, "/compact", "query body /compact is delivered verbatim");

    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet send: body with /unknown ends with message status rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-send-unknown-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
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

    registerSender(fleet, "sender-sess", dir);
    const senderTool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-sess", dir) });
    const res = await senderTool.execute(
      "tc-send-unknown",
      { action: "send", target: "target-sess", body: "/unknown" } as never,
      undefined,
      undefined,
      undefined as never,
    );

    assert.equal(res.isError, true);
    assert.equal(res.details.status, "rejected");
    assert.match(
      res.content[0]?.type === "text" ? res.content[0].text : "",
      /Fleet send to target-sess rejected/,
    );

    const msgId = res.details.messageId;
    const statusRes = await senderTool.execute(
      "tc-status-unknown",
      { action: "status", messageId: msgId } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(statusRes.details.status, "rejected");

    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The text of a tool result (single text block). */
function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  const first = res.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

test("Fleet send/query need an endpoint in this boot window: a session with a record elsewhere is a tool error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-child-sender-"));
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

    // A session with a record in the store that this boot window holds no
    // endpoint for belongs to another live boot window (or to no window after a
    // reload), which alone delivers to it (specs/fleet-tool.md Section 1 and
    // Section 4.1). A session with no visible record — a child — may send, and
    // its query waits for the reply instead (test/fleet/fleet-waited-query.test.ts).
    fleet.upsertSession({ sessionId: "child-session-0001", cwd: dir, state: "idle" });
    const childTool = makeFleetTool({
      fleet,
      hostProvider: () => stubHost("child-session-0001", dir),
    });
    const call = (params: Record<string, unknown>) =>
      childTool.execute("tc", params as never, undefined, undefined, undefined as never);

    const query = await call({ action: "query", target: "target-sess", body: "what is left?" });
    assert.equal(query.isError, true);
    assert.equal(textOf(query), 'no live session identity for Fleet action "query"');

    const send = await call({ action: "send", target: "target-sess", body: "hello" });
    assert.equal(send.isError, true);
    assert.equal(textOf(send), 'no live session identity for Fleet action "send"');

    const queued = new DatabaseSync(dbPath)
      .prepare("SELECT COUNT(*) AS n FROM fleet_messages")
      .get();
    assert.equal(queued?.n, 0, "nothing is queued that could never be answered");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet send/query: a main session with no record of its own has no live session identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-refused-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    // One boot window owns the session; a second one that tries to register the
    // same session ID is refused (specs/session-store.md, Section 4).
    const owner = new FleetCoordinator(emptyBoot(dir), { dbPath });
    registerSender(owner, "sess-owned", dir);
    const second = new FleetCoordinator(emptyBoot(dir), { dbPath });
    const refused = second.registerEndpoint(
      {
        sessionId: "sess-owned",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );
    assert.equal(refused, false, "the registration is refused");
    // The owning window ends and deletes the record: the second window is left
    // with a main session it never registered and no record of it either. It has
    // no live session identity there, so every action but `list` is refused.
    owner.unregisterEndpoint("sess-owned");
    owner.close();
    registerSender(second, "sess-b", dir);
    const tool = makeFleetTool({ fleet: second, hostProvider: () => stubHost("sess-owned", dir) });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const send = await call({ action: "send", target: "sess-b", body: "hello" });
    assert.equal(send.isError, true);
    assert.equal(textOf(send), 'no live session identity for Fleet action "send"');

    const query = await call({ action: "query", target: "sess-b", body: "hello" });
    assert.equal(query.isError, true);
    assert.equal(textOf(query), 'no live session identity for Fleet action "query"');

    // A child session registers no endpoint, so a session ID with no record that
    // this window never tried to register is still a child (Section 1).
    const childTool = makeFleetTool({
      fleet: second,
      hostProvider: () => stubHost("child-0001", dir),
    });
    const childSend = await childTool.execute(
      "tc",
      { action: "send", target: "sess-b", body: "hello" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(childSend.isError, undefined);

    // A main session whose start failed before it registered is still no child.
    second.markMainSession("sess-unstarted");
    const unstarted = makeFleetTool({
      fleet: second,
      hostProvider: () => stubHost("sess-unstarted", dir),
    });
    const refusedSend = await unstarted.execute(
      "tc",
      { action: "send", target: "sess-b", body: "hello" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(textOf(refusedSend), 'no live session identity for Fleet action "send"');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet accepts the calling session as a target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-self-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const delivered: Array<{ sessionId: string; text: string }> = [];
    const registerEcho = (sessionId: string) =>
      fleet.registerEndpoint(
        {
          sessionId,
          cwd: () => dir,
          isIdle: () => true,
          abortTurn: () => {},
          deliverTurn: (text) => {
            delivered.push({ sessionId, text });
          },
        },
        "idle",
      );
    assert.equal(registerEcho("sess-me"), true);
    assert.equal(registerEcho("sess-other"), true);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sess-me", dir) });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const send = await call({ action: "send", target: "sess-me", body: "hello me" });
    assert.equal(send.isError, undefined);

    // Resolution is by session ID: a prefix that resolves to the caller is the caller.
    const prefix = await call({ action: "send", target: "sess-m", body: "hello again" });
    assert.equal(prefix.isError, undefined);

    const query = await call({ action: "query", target: "sess-me", body: "hello me?" });
    assert.equal(query.isError, undefined);

    const fanout = await call({
      action: "send",
      targets: ["sess-me", "sess-other"],
      subject: "fan",
      body: "hello all",
    });
    assert.equal(fanout.isError, undefined);
    const fanoutDetails = fanout.details as {
      recipients: Array<{ target: string }>;
      failed: Array<{ target: string; error: string }>;
    };
    assert.deepEqual(
      fanoutDetails.recipients.map((r) => r.target),
      ["sess-me", "sess-other"],
    );
    assert.deepEqual(fanoutDetails.failed, []);
    const queued = new DatabaseSync(join(dir, "fleet.sqlite"))
      .prepare("SELECT COUNT(*) AS n FROM fleet_messages WHERE target_session_id = 'sess-me'")
      .get();
    assert.equal(queued?.n, 4, "two sends, one query and one fan-out row target the caller");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet fan-out is a tool error only when every recipient failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-fanout-error-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    fleet.registerEndpoint(
      {
        sessionId: "target-ok",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );
    registerSender(fleet, "sess-me", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sess-me", dir) });
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const none = await call({
      action: "send",
      targets: ["missing-one", "missing-two"],
      body: "hello",
    });
    assert.equal(none.isError, true, "no recipient succeeded, so the call is a tool error");
    const noneDetails = none.details as { recipients: unknown[]; failed: unknown[] };
    assert.deepEqual(noneDetails.recipients, []);
    assert.equal(noneDetails.failed.length, 2);
    assert.match(textOf(none), /failed target=missing-one: unknown target session "missing-one"/);

    const partial = await call({
      action: "send",
      targets: ["missing-one", "target-ok"],
      body: "hello",
    });
    assert.equal(partial.isError, undefined, "a partial success is not a tool error");
    assert.equal((partial.details as { recipients: unknown[] }).recipients.length, 1);

    // An empty broadcast has no failed recipient, only no recipients.
    const alone = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "alone.sqlite") });
    registerSender(alone, "sess-me", dir);
    const empty = await makeFleetTool({
      fleet: alone,
      hostProvider: () => stubHost("sess-me", dir),
    }).execute(
      "tc",
      { action: "send", broadcast: "machine", body: "hello" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(empty.isError, undefined);
    assert.match(textOf(empty), /\(no recipients matched\)/);
    alone.close();
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet turn startedAt: recorded at turn start, emitted in json, compact/full unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-started-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    registerSender(fleet, "sess-timed", dir);
    const before = Date.now();
    fleet.recordTurnStart("sess-timed", dir, "first line\nsecond", "");
    const after = Date.now();
    const started = must(must(fleet.getSession("sess-timed")).turns[0]).startedAt;
    assert.equal(started >= before && started <= after, true);

    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sess-timed", dir) });
    const res = await tool.execute(
      "tc-s",
      { action: "list", scope: "machine", format: "json" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    const text = res.content[0]?.type === "text" ? res.content[0].text : "";
    const payload = JSON.parse(text) as {
      sessions: Array<{ sessionId: string; turns: Array<Record<string, unknown>> }>;
    };
    const timed = must(payload.sessions.find((s) => s.sessionId === "sess-timed"));
    assert.equal(timed.turns[0]?.startedAt, started);

    // compact and full do not show startedAt: same text whatever its value.
    const withStart = must(fleet.getSession("sess-timed"));
    const otherStart: FleetSessionRecord = {
      ...withStart,
      turns: withStart.turns.map((turn) => ({ ...turn, startedAt: turn.startedAt + 1 })),
    };
    for (const format of ["compact", "full"] as const) {
      assert.equal(
        formatFleetList([withStart], "machine", format),
        formatFleetList([otherStart], "machine", format),
      );
    }
    assert.equal(formatFleetList([withStart], "machine", "full").includes("startedAt"), false);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet registers with renderShell `self` (specs/fleet-tool.md, registration)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-shell-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sess-me", dir) });
    assert.equal(tool.name, "Fleet");
    assert.equal(tool.label, "Fleet");
    assert.equal("renderShell" in tool, true, "the specification states renderShell is `self`");
    assert.equal(tool.renderShell, "self");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository root is derived when the record is written, never from an earlier answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-repo-root-"));
  try {
    const workdir = join(dir, "work");
    mkdirSync(workdir, { recursive: true });
    assert.equal(resolveRepoRoot(workdir), undefined, "no .git ancestor means no repository");
    mkdirSync(join(workdir, ".git"));
    assert.equal(
      resolveRepoRoot(workdir),
      realpathSync(workdir),
      "a git init after the earlier answer is picked up (fleet-tool.md Section 2)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .git file that does not name a gitdir still marks the repository root", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-repo-gitfile-"));
  try {
    const workdir = join(dir, "work");
    const nested = join(workdir, "nested", "deeper");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(workdir, ".git"), "this is not a gitdir line\n");
    assert.equal(
      resolveRepoRoot(nested),
      realpathSync(workdir),
      "the nearest .git file is the root, whatever it holds (fleet-tool.md Section 2)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recipient resolution of an empty target reports an unknown session, not a second dialect", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-empty-target-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    assert.deepEqual(fleet.resolveRecipient("   "), { error: 'unknown target session ""' });
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fan-out lists a rejected recipient under failed, never as sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-fanout-reject-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
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
    registerSender(fleet, "sender-1", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-1", dir) });
    const res = await tool.execute(
      "tc-1",
      { action: "send", targets: ["target-sess"], body: "/unknown:cmd" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    const details = res.details as { recipients: unknown[]; failed: unknown[] };
    assert.equal(details.recipients.length, 0, "a rejected recipient must not be listed as sent");
    assert.equal(details.failed.length, 1);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fleet refuses every action but list without a session identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-no-identity-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    fleet.upsertSession({ sessionId: "target-sess", cwd: dir, state: "idle" });
    const tool = makeFleetTool({ fleet, hostProvider: () => undefined });
    const res = await tool.execute(
      "tc-1",
      { action: "send", target: "target-sess", body: "hi" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(res.isError, true, "no ephemeral sender identity may be invented");
    const rows = rawDb(join(dir, "fleet.sqlite"))
      .prepare("SELECT COUNT(*) AS n FROM fleet_messages WHERE sender_session_id = 'ephemeral'")
      .get() as { n: number };
    assert.equal(rows.n, 0, "no message row may be written under an ephemeral sender id");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a query without a target is rejected with the spec's error text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-query-target-"));
  try {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
    registerSender(fleet, "sender-5", dir);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost("sender-5", dir) });
    const text = (result: Awaited<ReturnType<typeof tool.execute>>) =>
      result.content[0]?.type === "text" ? result.content[0].text : "";
    const call = (params: Record<string, unknown>) =>
      tool.execute("tc", params as never, undefined, undefined, undefined as never);

    const missing = await call({ action: "query", body: "q?" });
    assert.equal(
      text(missing),
      "target must be a non-empty string",
      "fleet-tool.md Section 1 applies to the query target too",
    );
    const blank = await call({ action: "query", body: "q?", target: "   " });
    assert.equal(
      text(blank),
      "target must be a non-empty string",
      "a target empty after trimming carries the same error text",
    );
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
