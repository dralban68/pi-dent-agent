/**
 * The local session store's own rules (specs/session-store.md): where it lives
 * and how a record leaves it when its owner process is gone.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BootSnapshot } from "../../lib/engine.ts";
import { FleetCoordinator } from "../../lib/fleet.ts";
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

function rawDb(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

/** A pid that is verifiably dead: the pid of a shell that already exited. */
function deadPid(): number {
  const out = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
  assert.equal(out.status, 0);
  const pid = Number.parseInt((out.stdout ?? "").trim(), 10);
  assert.ok(Number.isInteger(pid) && pid > 0, `shell pid expected, got ${out.stdout}`);
  return pid;
}

function messageStatus(dbPath: string, messageId: number): string {
  const db = rawDb(dbPath);
  try {
    const row = db.prepare("SELECT status FROM fleet_messages WHERE message_id = ?").get(messageId);
    return typeof row?.status === "string" ? row.status : "";
  } finally {
    db.close();
  }
}

/** Write the record of a session whose owning process has crashed. */
function plantCrashedRecord(dbPath: string, sessionId: string, cwd: string): void {
  const db = rawDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO fleet_sessions
         (session_id, cwd, repo_root, state, alive, updated_at, turns_json, owner_pid, owner_boot, owner_started, agents_dir, hidden)
         VALUES (?, ?, NULL, 'running', 1, ?, '[]', ?, 'bootCrashed', 1, NULL, 0)`,
    ).run(sessionId, cwd, Date.now(), deadPid());
  } finally {
    db.close();
  }
}

test("a listing is read-only and leaves a live quiet session in the fleet", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-readonly-list-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleetA = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootA" });
    const fleetB = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootB" });
    fleetB.upsertSession({ sessionId: "peer-idle", cwd: dir, state: "idle" });
    // Peer is alive but quiet: its row has not been touched for 10 minutes.
    rawDb(db)
      .prepare("UPDATE fleet_sessions SET updated_at = ? WHERE session_id = ?")
      .run(Date.now() - 10 * 60_000, "peer-idle");

    const snap = rawDb(db).prepare("SELECT * FROM fleet_sessions ORDER BY session_id").all();
    fleetA.listSessions("machine", dir); // read-only call
    const after = rawDb(db).prepare("SELECT * FROM fleet_sessions ORDER BY session_id").all();
    assert.deepEqual(after, snap, "list must not write any fleet_sessions row");

    const listed = fleetB.listSessions("machine", dir);
    assert.equal(
      listed.some((s) => s.sessionId === "peer-idle"),
      true,
      "a live idle session in a peer process must stay discoverable",
    );
    fleetA.close();
    fleetB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening the store deletes a record whose owner process is gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-open-reap-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootA" });
    // Session owned by a dead process (crash, no unregister).
    fleet.upsertSession({ sessionId: "crashed", cwd: dir, state: "idle" });
    const gone = deadPid();
    rawDb(db)
      .prepare("UPDATE fleet_sessions SET owner_pid = ?, owner_boot = ? WHERE session_id = ?")
      .run(gone, "bootCrashed", "crashed");
    fleet.close();

    const fleetNext = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootNext" });
    const listed = fleetNext.listSessions("machine", dir);
    assert.equal(
      listed.some((s) => s.sessionId === "crashed"),
      false,
      "a session whose owner process is gone must not be listed",
    );
    fleetNext.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ancient message rows and legacy dead session rows are purged when the store opens", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-purge-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const seed = rawDb(db);
    seed.exec(`
			CREATE TABLE IF NOT EXISTS fleet_sessions (
				session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, repo_root TEXT, state TEXT NOT NULL,
				alive INTEGER NOT NULL, updated_at INTEGER NOT NULL, turns_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS fleet_messages (
				message_id INTEGER PRIMARY KEY AUTOINCREMENT, sender_session_id TEXT NOT NULL,
				target_session_id TEXT NOT NULL, boot_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT,
				body TEXT NOT NULL, deliver TEXT NOT NULL, abort INTEGER NOT NULL, correlation_id TEXT,
				status TEXT NOT NULL, rejection_reason TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER
			);
			INSERT INTO fleet_sessions VALUES ('dead-old', '${dir}', NULL, 'idle', 0, ${Date.now() - 30 * 86400_000}, '[]');
			INSERT INTO fleet_messages (sender_session_id, target_session_id, boot_id, kind, subject, body, deliver, abort, correlation_id, status, rejection_reason, created_at, delivered_at)
				VALUES ('s', 't', 'old-boot', 'send', NULL, 'x', 'followUp', 0, NULL, 'delivered', NULL, ${Date.now() - 30 * 86400_000}, ${Date.now() - 30 * 86400_000});
		`);
    seed.close();

    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootNew" });
    const check = rawDb(db);
    const sessions = check.prepare("SELECT COUNT(*) AS n FROM fleet_sessions").get() as {
      n: number;
    };
    const messages = check.prepare("SELECT COUNT(*) AS n FROM fleet_messages").get() as {
      n: number;
    };
    check.close();
    assert.equal(sessions.n, 0, "long-dead session rows must be purged");
    assert.equal(messages.n, 0, "ancient message rows from dead boot windows must be purged");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening a store deletes legacy alive = 0 rows, keeps live rows, and rejects their pending messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-legacy-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const now = Date.now();
    const seed = rawDb(db);
    seed.exec(`
			CREATE TABLE IF NOT EXISTS fleet_sessions (
				session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, repo_root TEXT, state TEXT NOT NULL,
				alive INTEGER NOT NULL, updated_at INTEGER NOT NULL, turns_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS fleet_messages (
				message_id INTEGER PRIMARY KEY AUTOINCREMENT, sender_session_id TEXT NOT NULL,
				target_session_id TEXT NOT NULL, boot_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT,
				body TEXT NOT NULL, deliver TEXT NOT NULL, abort INTEGER NOT NULL, correlation_id TEXT,
				status TEXT NOT NULL, rejection_reason TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER
			);
		`);
    const insertSession = seed.prepare(
      "INSERT INTO fleet_sessions VALUES (?, ?, NULL, 'idle', ?, ?, '[]')",
    );
    // Recent updated_at: deletion is for ended sessions, not retention.
    insertSession.run("legacy-dead", dir, 0, now);
    insertSession.run("legacy-live", dir, 1, now);
    const insertMessage = seed.prepare(
      "INSERT INTO fleet_messages (sender_session_id, target_session_id, boot_id, kind, subject, body, deliver, abort, correlation_id, status, rejection_reason, created_at, delivered_at) VALUES (?, ?, 'bootOld', 'send', NULL, 'x', 'followUp', 0, NULL, 'pending', NULL, ?, NULL)",
    );
    insertMessage.run("s", "legacy-dead", now);
    insertMessage.run("s", "legacy-live", now);
    seed.close();

    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootNew" });
    assert.equal(fleet.getSession("legacy-dead"), undefined, "an alive = 0 row is deleted at open");
    assert.ok(fleet.getSession("legacy-live"), "a live row is kept");

    const check = rawDb(db);
    const statuses = check
      .prepare("SELECT target_session_id, status FROM fleet_messages ORDER BY message_id")
      .all()
      .map((row) => ({ target_session_id: row.target_session_id, status: row.status }));
    check.close();
    assert.deepEqual(statuses, [
      { target_session_id: "legacy-dead", status: "rejected" },
      { target_session_id: "legacy-live", status: "pending" },
    ]);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the store path is PI_DENT_FLEET_DB when set and non-empty, else the home directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-path-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const previousHome = process.env.HOME;
  const previousDb = process.env.PI_DENT_FLEET_DB;
  try {
    process.env.HOME = home;
    // The default-store case must never touch the real home: the host's home
    // lookup follows HOME, and this test asserts that premise before it opens a store.
    assert.equal(homedir(), home, "the host's home lookup follows HOME here");
    process.env.PI_DENT_FLEET_DB = join(dir, "own.sqlite");
    const configured = new FleetCoordinator(emptyBoot(dir));
    assert.equal(configured.dbPath, join(dir, "own.sqlite"));
    assert.ok(existsSync(join(dir, "own.sqlite")), "the configured store is a file");
    configured.close();

    // An empty value is unset, never a private in-memory store (session-store.md Section 1).
    process.env.PI_DENT_FLEET_DB = "";
    const fallback = new FleetCoordinator(emptyBoot(dir));
    assert.equal(fallback.dbPath, join(home, ".pi", "pi-dent", "fleet.sqlite"));
    assert.ok(existsSync(fallback.dbPath), "the default store is a file in the home directory");
    fallback.close();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDb === undefined) delete process.env.PI_DENT_FLEET_DB;
    else process.env.PI_DENT_FLEET_DB = previousDb;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gone-owner reap leaves a session that re-registered since the read, with its messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-reap-race-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleetA = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "bootAaaa" });
    const fleetC = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "bootCccc" });

    // The prefix lookup hydrates every candidate before it reaps any of them, and
    // hydration reports the idle state of a local session. The resumed session is
    // registered there: exactly the crash-then-resume step that can fall between
    // another process's read of a record and its delete.
    let resumed = false;
    fleetA.registerEndpoint(
      {
        sessionId: "a-hook",
        cwd: () => dir,
        isIdle: () => {
          if (resumed) return true;
          resumed = true;
          assert.equal(
            fleetC.registerEndpoint(
              {
                sessionId: "a-resumed",
                cwd: () => dir,
                isIdle: () => false,
                abortTurn: () => {},
                deliverTurn: () => {},
              },
              "running",
            ),
            true,
            "the resumed session takes its record over from its crashed owner",
          );
          return true;
        },
        abortTurn: () => {},
        deliverTurn: () => {},
      },
      "idle",
    );
    plantCrashedRecord(dbPath, "a-resumed", dir);
    const seed = rawDb(dbPath);
    const queued = seed
      .prepare(
        `INSERT INTO fleet_messages
           (sender_session_id, target_session_id, boot_id, kind, subject, body, deliver, abort, correlation_id, status, rejection_reason, created_at, delivered_at, deliver_text)
           VALUES ('a-peer', 'a-resumed', 'bootPeer', 'send', NULL, 'work', 'followUp', 0, NULL, 'pending', NULL, ?, NULL, NULL)`,
      )
      .run(Date.now());
    const messageId = Number(queued.lastInsertRowid);
    seed.close();

    const resolved = fleetA.resolveRecipient("a-");
    assert.equal(resumed, true, "the connection point of the race was reached");
    assert.equal(
      "error" in resolved ? resolved.error : "",
      'ambiguous target prefix "a-" matches a-hook, a-resumed',
      "the resumed session is a live target again, not a record a stale read deleted",
    );
    assert.ok(
      fleetA.listSessions("machine", dir).some((s) => s.sessionId === "a-resumed"),
      "the resumed session stays in the fleet",
    );
    assert.equal(
      messageStatus(dbPath, messageId),
      "pending",
      "the live session's queued message is not dead-lettered",
    );

    // A record that is still the crashed one is reaped, with its messages.
    plantCrashedRecord(dbPath, "a-crashed", dir);
    assert.deepEqual(fleetA.resolveRecipient("a-crashed"), {
      error: 'unknown target session "a-crashed"',
    });
    assert.equal(
      messageStatus(dbPath, messageId),
      "pending",
      "another session's reap leaves this message alone",
    );
    fleetC.close();
    fleetA.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reaping a crashed session deletes only that record and rejects its own pending messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-reap-one-"));
  try {
    const dbPath = join(dir, "fleet.sqlite");
    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath, bootId: "bootAaaa" });
    plantCrashedRecord(dbPath, "gone-sess", dir);
    const seed = rawDb(dbPath);
    seed
      .prepare(
        `INSERT INTO fleet_messages
           (sender_session_id, target_session_id, boot_id, kind, subject, body, deliver, abort, correlation_id, status, rejection_reason, created_at, delivered_at, deliver_text)
           VALUES ('peer', 'gone-sess', 'bootPeer', 'send', NULL, 'work', 'followUp', 0, NULL, 'pending', NULL, ?, NULL, NULL)`,
      )
      .run(Date.now());
    seed.close();

    assert.deepEqual(fleet.resolveRecipient("gone-sess"), {
      error: 'unknown target session "gone-sess"',
    });
    const check = rawDb(dbPath);
    const status = must(
      check
        .prepare("SELECT status FROM fleet_messages WHERE target_session_id = ?")
        .get("gone-sess"),
    ).status;
    check.close();
    assert.equal(status, "rejected", "the deleted session's queued message is rejected");
    const record = rawDb(dbPath);
    const remaining = record.prepare("SELECT COUNT(*) AS n FROM fleet_sessions").get();
    record.close();
    assert.equal(remaining?.n, 0, "the crashed record is deleted");
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening an older store adds the parent column, and an absent parent reads as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-parent-column-"));
  try {
    const db = join(dir, "fleet.sqlite");
    const now = Date.now();
    const seed = rawDb(db);
    // A store an older pi-dent wrote: no parent_session_id column (session-store.md Section 1).
    seed.exec(`
			CREATE TABLE IF NOT EXISTS fleet_sessions (
				session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, repo_root TEXT, state TEXT NOT NULL,
				alive INTEGER NOT NULL, updated_at INTEGER NOT NULL, turns_json TEXT NOT NULL,
				owner_pid INTEGER, owner_boot TEXT, owner_started INTEGER, agents_dir TEXT,
				hidden INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS fleet_messages (
				message_id INTEGER PRIMARY KEY AUTOINCREMENT, sender_session_id TEXT NOT NULL,
				target_session_id TEXT NOT NULL, boot_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT,
				body TEXT NOT NULL, deliver TEXT NOT NULL, abort INTEGER NOT NULL, correlation_id TEXT,
				status TEXT NOT NULL, rejection_reason TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER,
				deliver_text TEXT
			);
			INSERT INTO fleet_sessions (session_id, cwd, repo_root, state, alive, updated_at, turns_json, owner_pid, owner_boot, owner_started, agents_dir, hidden)
				VALUES ('old-session', '${dir}', NULL, 'idle', 1, ${now}, '[]', NULL, NULL, NULL, NULL, 0);
		`);
    seed.close();

    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootNew" });
    const check = rawDb(db);
    const columns = check.prepare("PRAGMA table_info(fleet_sessions)").all();
    check.close();
    assert.equal(
      columns.some((column) => column.name === "parent_session_id"),
      true,
      "opening the store adds the parent column",
    );
    assert.equal(
      must(fleet.getSession("old-session")).parentSessionId,
      undefined,
      "a record written before the column has no parent",
    );
    fleet.upsertSession({ sessionId: "old-session", cwd: dir, state: "idle" });
    assert.equal(must(fleet.getSession("old-session")).parentSessionId, undefined);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
