/**
 * The local session store's own rules (specs/session-store.md): where it lives
 * and how a record leaves it when its owner process is gone.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
         (session_id, cwd, repo_root, state, updated_at, turns_json, owner_pid, owner_boot, owner_started, agents_dir, hidden)
         VALUES (?, ?, NULL, 'running', ?, '[]', ?, 'bootCrashed', 1, NULL, 0)`,
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

test("message rows created more than 7 days earlier are deleted when the store opens", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-purge-"));
  try {
    const db = join(dir, "fleet.sqlite");
    new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootOld" }).close();
    const day = 86_400_000;
    const seed = rawDb(db);
    const insert = seed.prepare(
      `INSERT INTO fleet_messages
         (sender_session_id, target_session_id, boot_id, kind, subject, body, deliver, abort, correlation_id, status, rejection_reason, created_at, delivered_at, deliver_text)
         VALUES ('s', 't', 'old-boot', 'send', NULL, ?, 'followUp', 0, NULL, 'delivered', NULL, ?, NULL, NULL)`,
    );
    insert.run("ancient", Date.now() - 8 * day);
    insert.run("recent", Date.now() - 6 * day);
    seed.close();

    const fleet = new FleetCoordinator(emptyBoot(dir), { dbPath: db, bootId: "bootNew" });
    const check = rawDb(db);
    const bodies = check
      .prepare("SELECT body FROM fleet_messages")
      .all()
      .map((row) => row.body);
    check.close();
    assert.deepEqual(bodies, ["recent"]);
    fleet.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new store file records format version 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-version-"));
  try {
    const db = join(dir, "fleet.sqlite");
    new FleetCoordinator(emptyBoot(dir), { dbPath: db }).close();
    const check = rawDb(db);
    const version = check.prepare("PRAGMA user_version").get()?.user_version;
    check.close();
    assert.equal(version, 2);
    // A second opening uses the file as it is.
    const again = new FleetCoordinator(emptyBoot(dir), { dbPath: db });
    again.upsertSession({ sessionId: "s", cwd: dir, state: "idle" });
    assert.ok(again.getSession("s"));
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file of another format version fails the opening and is left unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-other-version-"));
  try {
    const cases = [
      { name: "version-1", setup: "CREATE TABLE t (x); PRAGMA user_version = 1;", version: 1 },
      { name: "version-3", setup: "PRAGMA user_version = 3;", version: 3 },
      {
        name: "unversioned-with-table",
        setup: "CREATE TABLE fleet_sessions (session_id TEXT);",
        version: 0,
      },
    ];
    for (const { name, setup, version } of cases) {
      const db = join(dir, `${name}.sqlite`);
      const seed = rawDb(db);
      seed.exec(setup);
      seed.close();
      const before = readFileSync(db);
      assert.throws(
        () => new FleetCoordinator(emptyBoot(dir), { dbPath: db }),
        { message: `unsupported session store version ${version}` },
        name,
      );
      assert.deepEqual(readFileSync(db), before, `${name}: the file is unchanged`);
      assert.equal(existsSync(`${db}-wal`), false, `${name}: no write-ahead log is started`);
    }
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
    // A file of another format version beside it is neither read nor changed.
    const other = join(home, ".pi", "pi-dent", "fleet.sqlite");
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, "not this format");
    const fallback = new FleetCoordinator(emptyBoot(dir));
    assert.equal(fallback.dbPath, join(home, ".pi", "pi-dent", "fleet-v2.sqlite"));
    assert.ok(existsSync(fallback.dbPath), "the default store is a file in the home directory");
    fallback.close();
    assert.equal(readFileSync(other, "utf8"), "not this format");
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
           VALUES ('a-peer', 'a-resumed', 'bootPeer', 'send', NULL, 'work', 'followUp', 0, NULL, 'pending', NULL, ?, NULL, '[Fleet from a-peer]' || char(10) || 'work')`,
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
           VALUES ('peer', 'gone-sess', 'bootPeer', 'send', NULL, 'work', 'followUp', 0, NULL, 'pending', NULL, ?, NULL, '[Fleet from peer]' || char(10) || 'work')`,
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
