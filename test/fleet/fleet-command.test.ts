import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { at } from "../support/must.ts";
import type { BootSnapshot } from "../../lib/engine.ts";
import { FleetCoordinator, type FleetSessionRecord } from "../../lib/fleet.ts";
import {
  type FleetCommandDeps,
  type FleetCommandUI,
  runFleetCommand,
} from "../../lib/fleet-command.ts";
import type { HostSession } from "../../lib/host.ts";
import { makeFleetTool } from "../../lib/tools.ts";

/**
 * `/fleet` (specs/slash-commands.md Section 4): sibling sessions are the
 * machine `list` without the current session; no arguments opens
 * select + input; `<target> <query>` resolves the target; a query is
 * enqueued exactly as the Fleet tool's `query` action does, with no subject.
 */

const CURRENT = "sess-curr";

/** A second connection on the store: what another pi-dent process sees and writes. */
function rawDb(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

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
    maxRecoveryRetries: 0,
    sessionTtlDays: 30,
  };
}

interface Recorder {
  selects: Array<{ title: string; options: string[] }>;
  inputs: string[];
  notifications: Array<{ message: string; level: string }>;
}

interface StubUI extends FleetCommandUI {
  recorder: Recorder;
}

function stubUI(answers: {
  interactive?: boolean;
  choice?: string | undefined;
  entry?: string | undefined;
}): StubUI {
  const recorder: Recorder = { selects: [], inputs: [], notifications: [] };
  return {
    interactive: answers.interactive ?? true,
    recorder,
    select: async (title, options) => {
      recorder.selects.push({ title, options });
      return answers.choice;
    },
    input: async (title) => {
      recorder.inputs.push(title);
      return answers.entry;
    },
    notify: (message, level) => recorder.notifications.push({ message, level }),
  };
}

/** The current session as a live member: this boot window holds its endpoint. */
function registerCurrent(fleet: FleetCoordinator, cwd: string): void {
  fleet.registerEndpoint(
    {
      sessionId: CURRENT,
      cwd: () => cwd,
      isIdle: () => true,
      abortTurn: () => {},
      deliverTurn: () => {},
    },
    "idle",
  );
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

function seed(fleet: FleetCoordinator, cwd: string): void {
  fleet.upsertSession({
    sessionId: CURRENT,
    cwd,
    state: "idle",
    turns: [{ command: "self", goal: "Current work", files: [], startedAt: 0 }],
  });
  registerCurrent(fleet, cwd);
  fleet.upsertSession({ sessionId: "sess-alpha", cwd, state: "running" });
  fleet.upsertSession({
    sessionId: "sess-bravo",
    cwd,
    state: "idle",
    turns: [{ command: "inspect", goal: "Bravo work", files: [], startedAt: 0 }],
  });
  fleet.upsertSession({ sessionId: "sess-charlie", cwd, state: "idle" });
}

function compact(cwd: string, sessionId: string, state: string, summary: string): string {
  return `${sessionId} · instance · ${state} · ${cwd} · ${summary}`;
}

interface QueryCall {
  senderSessionId: string;
  target: FleetSessionRecord;
  subject?: string | undefined;
  body: string;
}

/** Record every enqueue exactly as the Fleet tool's query action would issue it. */
function spyQueries(fleet: FleetCoordinator): QueryCall[] {
  const calls: QueryCall[] = [];
  const original = fleet.enqueueQuery.bind(fleet);
  fleet.enqueueQuery = (input) => {
    calls.push(input);
    return original(input);
  };
  return calls;
}

async function withFleet(
  run: (fleet: FleetCoordinator, dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-command-"));
  const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: join(dir, "fleet.sqlite") });
  try {
    await run(fleet, dir);
  } finally {
    fleet.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function deps(fleet: FleetCoordinator, dir: string, ui: FleetCommandUI): FleetCommandDeps {
  return { fleet, sessionId: CURRENT, cwd: dir, ui };
}

// specs/slash-commands.md Section 4.1: without an interactive terminal UI the command is a no-op.
test("fleet command: no interactive terminal UI is a no-op", async () => {
  await withFleet(async (fleet, dir) => {
    seed(fleet, dir);
    const calls = spyQueries(fleet);
    const ui = stubUI({ interactive: false });
    await runFleetCommand("", deps(fleet, dir, ui));
    assert.deepEqual(ui.recorder.selects, []);
    assert.deepEqual(ui.recorder.inputs, []);
    assert.deepEqual(ui.recorder.notifications, []);
    assert.deepEqual(calls, []);
  });
});

test("fleet command: no siblings notifies and opens no dialog", async () => {
  await withFleet(async (fleet, dir) => {
    fleet.upsertSession({ sessionId: CURRENT, cwd: dir, state: "idle" });
    registerCurrent(fleet, dir);
    const ui = stubUI({});
    await runFleetCommand("", deps(fleet, dir, ui));
    assert.deepEqual(ui.recorder.notifications, [
      { message: "No sibling sessions.", level: "info" },
    ]);
    assert.deepEqual(ui.recorder.selects, []);
    assert.deepEqual(ui.recorder.inputs, []);
  });
});

test("fleet command: select lists siblings in fleet order, without the current session", async () => {
  await withFleet(async (fleet, dir) => {
    seed(fleet, dir);
    const ui = stubUI({ choice: undefined });
    await runFleetCommand("", deps(fleet, dir, ui));
    const expected = [
      compact(dir, "sess-alpha", "running", "(no turns yet)"),
      compact(dir, "sess-bravo", "idle", "Bravo work"),
      compact(dir, "sess-charlie", "idle", "(no turns yet)"),
    ];
    assert.deepEqual(ui.recorder.selects, [{ title: "Fleet · 3 sessions", options: expected }]);
    assert.deepEqual(ui.recorder.inputs, [], "a dismissed select ends the command");
    assert.deepEqual(ui.recorder.notifications, []);
  });
});

test("fleet command: dismissed input ends the command", async () => {
  await withFleet(async (fleet, dir) => {
    seed(fleet, dir);
    const calls = spyQueries(fleet);
    const ui = stubUI({ choice: compact(dir, "sess-bravo", "idle", "Bravo work") });
    await runFleetCommand("", deps(fleet, dir, ui));
    assert.deepEqual(ui.recorder.inputs, ["Query sess-bravo"]);
    assert.deepEqual(calls, []);
    assert.deepEqual(ui.recorder.notifications, []);
  });
});

test("fleet command: whitespace-only input ends the command", async () => {
  await withFleet(async (fleet, dir) => {
    seed(fleet, dir);
    const calls = spyQueries(fleet);
    const ui = stubUI({
      choice: compact(dir, "sess-bravo", "idle", "Bravo work"),
      entry: "   \n\t ",
    });
    await runFleetCommand("", deps(fleet, dir, ui));
    assert.deepEqual(calls, []);
    assert.deepEqual(ui.recorder.notifications, []);
  });
});

test("fleet command: a chosen session and query enqueues with no subject and notifies", async () => {
  await withFleet(async (fleet, dir) => {
    seed(fleet, dir);
    const calls = spyQueries(fleet);
    const ui = stubUI({
      choice: compact(dir, "sess-bravo", "idle", "Bravo work"),
      entry: "  what branch are you on?  ",
    });
    await runFleetCommand("", deps(fleet, dir, ui));
    assert.equal(calls.length, 1);
    assert.equal(at(calls, 0).senderSessionId, CURRENT);
    assert.equal(at(calls, 0).target.sessionId, "sess-bravo");
    assert.equal(at(calls, 0).subject, undefined);
    assert.equal(at(calls, 0).body, "what branch are you on?");
    assert.deepEqual(ui.recorder.notifications, [
      { message: "Fleet query 1 enqueued to sess-bravo.", level: "info" },
    ]);
    assert.equal(fleet.getMessageStatus(CURRENT, 1).target, "sess-bravo");
  });
});

test("fleet command: <target> <query> enqueues to the resolved session", async () => {
  await withFleet(async (fleet, dir) => {
    seed(fleet, dir);
    const calls = spyQueries(fleet);
    const ui = stubUI({});
    await runFleetCommand("  sess-bravo   what  now ", deps(fleet, dir, ui));
    assert.equal(calls.length, 1);
    assert.equal(at(calls, 0).target.sessionId, "sess-bravo");
    assert.equal(at(calls, 0).subject, undefined);
    assert.equal(at(calls, 0).body, "what  now");
    assert.deepEqual(ui.recorder.notifications, [
      { message: "Fleet query 1 enqueued to sess-bravo.", level: "info" },
    ]);
  });
});

test("fleet command: an empty query is a usage error", async () => {
  await withFleet(async (fleet, dir) => {
    seed(fleet, dir);
    const calls = spyQueries(fleet);
    for (const args of ["sess-bravo", "sess-bravo   ", "  sess-bravo \n "]) {
      const ui = stubUI({});
      await runFleetCommand(args, deps(fleet, dir, ui));
      assert.deepEqual(ui.recorder.notifications, [
        { message: "Usage: /fleet [<target> <query>]", level: "error" },
      ]);
    }
    assert.deepEqual(calls, []);
  });
});

test("fleet command: an unknown target shows the resolution error", async () => {
  await withFleet(async (fleet, dir) => {
    seed(fleet, dir);
    const calls = spyQueries(fleet);
    const ui = stubUI({});
    await runFleetCommand("nope hello", deps(fleet, dir, ui));
    assert.deepEqual(ui.recorder.notifications, [
      { message: 'unknown target session "nope"', level: "error" },
    ]);
    assert.deepEqual(calls, []);
  });
});

test("fleet command: a target resolving to the current session is queried", async () => {
  await withFleet(async (fleet, dir) => {
    seed(fleet, dir);
    const calls = spyQueries(fleet);
    const ui = stubUI({});
    await runFleetCommand(`${CURRENT} hello`, deps(fleet, dir, ui));
    assert.equal(calls.length, 1);
    assert.equal(at(calls, 0).senderSessionId, CURRENT);
    assert.equal(at(calls, 0).target.sessionId, CURRENT);
    assert.equal(at(calls, 0).body, "hello");
  });
});

test("fleet command: a unique session-ID prefix resolves the target", async () => {
  await withFleet(async (fleet, dir) => {
    seed(fleet, dir);
    const calls = spyQueries(fleet);
    const ui = stubUI({});
    await runFleetCommand("sess-br hello there", deps(fleet, dir, ui));
    assert.equal(calls.length, 1);
    assert.equal(at(calls, 0).target.sessionId, "sess-bravo");
    assert.equal(at(calls, 0).body, "hello there");
  });
});

/**
 * specs/slash-commands.md Section 4: the command refuses exactly the caller a
 * `Fleet` query from it fails on — a session whose record this boot window does
 * not own, here one released for a reload (owner_boot NULL).
 */
test("fleet command: a caller the Fleet tool refuses is a no-op", async () => {
  await withFleet(async (fleet, dir) => {
    seed(fleet, dir);
    fleet.releaseEndpointForReload(CURRENT);
    const tool = makeFleetTool({ fleet, hostProvider: () => stubHost(CURRENT, dir) });
    const refused = await tool.execute(
      "tc-1",
      { action: "query", target: "sess-bravo", body: "hello" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(refused.isError, true, "the Fleet tool refuses the query");
    const refusedText = refused.content[0]?.type === "text" ? refused.content[0].text : "";
    assert.equal(refusedText, 'no live session identity for Fleet action "query"');

    // Every action but `list` refuses the same caller, `status` included
    // (specs/fleet-tool.md Section 1).
    for (const params of [
      { action: "send", target: "sess-bravo", body: "hello" },
      { action: "status", messageId: 1 },
    ]) {
      const other = await tool.execute(
        "tc-2",
        params as never,
        undefined,
        undefined,
        undefined as never,
      );
      assert.equal(other.isError, true, `the Fleet tool refuses ${params.action}`);
      const text = other.content[0]?.type === "text" ? other.content[0].text : "";
      assert.equal(text, `no live session identity for Fleet action "${params.action}"`);
    }

    const calls = spyQueries(fleet);
    const ui = stubUI({
      choice: compact(dir, "sess-bravo", "idle", "Bravo work"),
      entry: "hello",
    });
    await runFleetCommand("", deps(fleet, dir, ui));
    await runFleetCommand("sess-bravo hello", deps(fleet, dir, ui));
    assert.deepEqual(calls, [], "the command enqueues nothing the tool refuses");
    assert.deepEqual(ui.recorder.selects, []);
    assert.deepEqual(ui.recorder.notifications, []);
  });
});

test("the fleet command enqueues nothing for a session another boot window owns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-command-foreign-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleetA = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "aaaaaaaa" });
    const fleetB = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bbbbbbbb" });
    fleetA.registerEndpoint(
      {
        sessionId: "sess-refused",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );
    fleetA.registerEndpoint(
      {
        sessionId: "sess-owned",
        cwd: () => dir,
        isIdle: () => true,
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );

    // The caller session's record exists but boot window B holds no endpoint
    // for it (its registration was refused): the command is a no-op.
    const notifications: string[] = [];
    await runFleetCommand("sess-owned hello there", {
      fleet: fleetB,
      sessionId: "sess-refused",
      cwd: dir,
      ui: {
        interactive: false,
        select: async () => undefined,
        input: async () => undefined,
        notify: (message) => {
          notifications.push(message);
        },
      },
    });
    assert.deepEqual(notifications, [], "a refused session enqueues nothing");
    const rows = rawDb(db).prepare("SELECT COUNT(*) AS n FROM fleet_messages").get();
    assert.equal(Number(rows?.n), 0, "no message row is written");
    fleetA.close();
    fleetB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
