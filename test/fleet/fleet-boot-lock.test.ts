/**
 * A boot lock that cannot be held or checked is reported, and no record is lost for it
 * (specs/session-store.md#membership-lifecycle).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { BootSnapshot } from "../../lib/engine.ts";
import { FleetCoordinator, type FleetEndpoint } from "../../lib/fleet.ts";

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

function endpoint(sessionId: string, dir: string, notes: string[]): FleetEndpoint {
  return {
    sessionId,
    agentsDir: dir,
    cwd: () => dir,
    isIdle: () => true,
    abortTurn: () => {},
    deliverTurn: () => {},
    notify: (message) => notes.push(message),
    runBuiltinCommand: () => false,
    runQuery: async () => ({ text: "", isError: false }),
  };
}

/** Make lock requests for `name` reject, as a failing lock manager would. */
function failLock(t: TestContext, name: string): void {
  const request = navigator.locks.request.bind(navigator.locks);
  t.mock.method(navigator.locks, "request", (lockName: string, ...rest: unknown[]) =>
    lockName === name
      ? Promise.reject(new Error("lock manager unavailable"))
      : Reflect.apply(request, navigator.locks, [lockName, ...rest]),
  );
}

/** A record of a boot window of another thread of this process, which holds no boot lock. */
function plantOtherThreadRecord(db: string, sessionId: string, bootId: string, dir: string): void {
  const raw = new DatabaseSync(db);
  try {
    raw
      .prepare(
        `INSERT INTO fleet_sessions
         (session_id, cwd, repo_root, state, updated_at, turns_json, owner_pid, owner_boot, owner_started, agents_dir, hidden)
         VALUES (?, ?, NULL, 'idle', ?, '[]', ?, ?, ?, ?, 0)`,
      )
      .run(
        sessionId,
        dir,
        Date.now(),
        process.pid,
        bootId,
        Date.now() - Math.round(process.uptime() * 1000),
        dir,
      );
  } finally {
    raw.close();
  }
}

function sessionIds(db: string): string[] {
  const raw = new DatabaseSync(db, { readOnly: true });
  try {
    return raw
      .prepare("SELECT session_id FROM fleet_sessions ORDER BY session_id")
      .all()
      .map((row) => String(row.session_id));
  } finally {
    raw.close();
  }
}

async function withStore(run: (db: string, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-boot-lock-"));
  try {
    await run(join(dir, "fleet.sqlite"), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a boot lock that cannot be held warns each session of the boot window", async (t) => {
  await withStore(async (db, dir) => {
    failLock(t, "pi-dent-fleet-boot:aaaaaaaa");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "aaaaaaaa" });
    try {
      const first: string[] = [];
      assert.equal(fleet.registerEndpoint(endpoint("session-1", dir, first)), true);
      await settle();
      const second: string[] = [];
      assert.equal(fleet.registerEndpoint(endpoint("session-2", dir, second)), true);
      const warning =
        "pi-dent: Fleet boot lock pi-dent-fleet-boot:aaaaaaaa could not be held: lock manager unavailable; this session may vanish from the fleet";
      assert.deepEqual(first, [warning]);
      assert.deepEqual(second, [warning]);
      assert.deepEqual(sessionIds(db), ["session-1", "session-2"]);
    } finally {
      fleet.close();
    }
  });
});

test("a failed boot lock check keeps the record and warns once per boot window", async (t) => {
  await withStore(async (db, dir) => {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "aaaaaaaa" });
    try {
      const notes: string[] = [];
      fleet.registerEndpoint(endpoint("session-a", dir, notes));
      plantOtherThreadRecord(db, "session-b", "bbbbbbbb", dir);
      failLock(t, "pi-dent-fleet-boot:bbbbbbbb");
      await fleet.reapGoneOwners();
      await fleet.reapGoneOwners();
      assert.deepEqual(notes, [
        "pi-dent: Fleet boot lock pi-dent-fleet-boot:bbbbbbbb could not be checked: lock manager unavailable; records of other threads' boot windows are kept until a check succeeds",
      ]);
      assert.deepEqual(sessionIds(db), ["session-a", "session-b"]);
      t.mock.restoreAll();
      await fleet.reapGoneOwners();
      assert.deepEqual(sessionIds(db), ["session-a"], "a check that succeeds finds it gone");
    } finally {
      fleet.close();
    }
  });
});

test("a boot lock check that fails before registration does not block it and warns the session", async (t) => {
  await withStore(async (db, dir) => {
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "aaaaaaaa" });
    try {
      plantOtherThreadRecord(db, "session-b", "bbbbbbbb", dir);
      failLock(t, "pi-dent-fleet-boot:bbbbbbbb");
      await fleet.reapGoneOwners();
      const notes: string[] = [];
      assert.equal(fleet.registerEndpoint(endpoint("session-a", dir, notes)), true);
      assert.deepEqual(notes, [
        "pi-dent: Fleet boot lock pi-dent-fleet-boot:bbbbbbbb could not be checked: lock manager unavailable; records of other threads' boot windows are kept until a check succeeds",
      ]);
      assert.deepEqual(sessionIds(db), ["session-a", "session-b"]);
    } finally {
      fleet.close();
    }
  });
});
