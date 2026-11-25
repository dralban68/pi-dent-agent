import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  FORMAT_VERSION,
  INDEX_FILE_NAME,
  openSessionIndex,
  searchIndexPath,
  SEARCH_DB_ENV,
  sessionStorePath,
  SessionIndex,
} from "../../lib/session-index.ts";
import { must } from "../support/must.ts";
import {
  headerLine,
  indexPath,
  ok,
  openIndex,
  rawIndex,
  tempDir,
  userVersionOf,
  writeSession,
} from "./support.ts";

/** specs/session-index.md Sections 1 and 5: the index file, opening it, and an unusable index. */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const path = tempDir("session-index-open-");
  roots.push(path);
  return path;
}

test("the index path is PI_DENT_SEARCH_DB when set and non-empty, else ~/.pi/pi-dent/search-v2.sqlite", () => {
  assert.equal(SEARCH_DB_ENV, "PI_DENT_SEARCH_DB");
  assert.equal(INDEX_FILE_NAME, "search-v2.sqlite");
  assert.equal(
    searchIndexPath({ PI_DENT_SEARCH_DB: "/tmp/index.sqlite" }, "/home/user"),
    "/tmp/index.sqlite",
  );
  assert.equal(
    searchIndexPath({ PI_DENT_SEARCH_DB: "" }, "/home/user"),
    "/home/user/.pi/pi-dent/search-v2.sqlite",
  );
  assert.equal(searchIndexPath({}, "/home/user"), "/home/user/.pi/pi-dent/search-v2.sqlite");
  assert.equal(searchIndexPath({ PI_DENT_SEARCH_DB: "/a", OTHER: "b" }, "/home/user"), "/a");
});

test("the index path and the session store path are different files by default", () => {
  assert.equal(sessionStorePath({}, "/home/user"), "/home/user/.pi/pi-dent/fleet-v2.sqlite");
  assert.equal(
    sessionStorePath({ PI_DENT_FLEET_DB: "/tmp/store.sqlite" }, "/home/user"),
    "/tmp/store.sqlite",
  );
  assert.notEqual(searchIndexPath({}, "/home/user"), sessionStorePath({}, "/home/user"));
});

test("the index does not open a file that is the session store's file", () => {
  const root = dir();
  const path = indexPath(root);
  writeFileSync(path, "a session store's bytes");
  const before = readFileSync(path);
  const opened = openSessionIndex({ path, storePath: path });
  assert.deepEqual(opened, { ok: false, reason: "the index file is the session store file" });
  assert.equal(readFileSync(path).equals(before), true);
});

test("the index does not open a hard link to the session store's file", () => {
  const root = dir();
  const store = join(root, "fleet.sqlite");
  writeFileSync(store, "a session store's bytes");
  const link = join(root, "linked.sqlite");
  linkSync(store, link);
  const opened = openSessionIndex({ path: link, storePath: store });
  assert.deepEqual(opened, { ok: false, reason: "the index file is the session store file" });
  assert.equal(readFileSync(store).equals(Buffer.from("a session store's bytes")), true);
});

test("the index does not open another name of the session store's file on a case-insensitive volume", () => {
  const root = dir();
  const store = join(root, "fleet.sqlite");
  writeFileSync(store, "a session store's bytes");
  const otherCase = join(root, "FLEET.sqlite");
  // A case-insensitive volume resolves the other case to the same file; a sensitive one does not.
  const same = statSync(otherCase, { throwIfNoEntry: false }) !== undefined;
  const opened = openSessionIndex({ path: otherCase, storePath: store });
  if (same) {
    assert.deepEqual(opened, { ok: false, reason: "the index file is the session store file" });
    assert.equal(readFileSync(store).equals(Buffer.from("a session store's bytes")), true);
    return;
  }
  assert.equal(opened.ok, true);
  if (opened.ok) opened.index.close();
});

test("the first open creates the directory, the file, and the schema of version 1 in WAL mode", () => {
  const root = dir();
  const path = indexPath(join(root, "nested", "deeper"));
  const index = openIndex(path);
  assert.equal(index.path, path);
  assert.equal(index.busyTimeoutMs, 1000);
  assert.equal(existsSync(path), true);
  assert.equal(userVersionOf(path), FORMAT_VERSION);
  const db = rawIndex(path);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    for (const name of ["files", "entries", "items", "item_text"]) {
      assert.ok(tables.includes(name), `missing table ${name}`);
    }
    const mode = must(db.prepare("PRAGMA journal_mode").get()).journal_mode;
    assert.equal(mode, "wal");
  } finally {
    db.close();
  }
  index.close();
});

test("a second opener of the same file uses it and indexes nothing twice", async () => {
  const root = dir();
  const path = indexPath(root);
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine());
  const first = openIndex(path);
  assert.equal((await first.catchUp(session)).status, "complete");
  first.close();
  const second = openIndex(path);
  assert.equal(second.generation, 1);
  const outcome = await second.catchUp(session);
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.bytesRead, 0);
  assert.equal(ok(second.files()).length, 1);
  second.close();
});

test("a user_version other than 0 or 2 leaves the file untouched and reports the index unusable", () => {
  const root = dir();
  const path = indexPath(root);
  const db = rawIndex(path);
  db.exec("CREATE TABLE other (a INTEGER); PRAGMA user_version = 1;");
  db.close();
  const before = readFileSync(path);
  const opened = openSessionIndex({ path });
  assert.equal(opened.ok, false);
  assert.deepEqual(opened, { ok: false, reason: "unsupported index version 1" });
  assert.equal(readFileSync(path).equals(before), true);
});

test("user_version 0 with a table is unusable and the file is untouched", () => {
  const root = dir();
  const path = indexPath(root);
  const db = rawIndex(path);
  db.exec("CREATE TABLE other (a INTEGER); PRAGMA user_version = 0;");
  db.close();
  const before = readFileSync(path);
  const opened = openSessionIndex({ path });
  assert.deepEqual(opened, { ok: false, reason: "unsupported index version 0" });
  assert.equal(readFileSync(path).equals(before), true);
});

test("an unsupported-version file with a leftover -wal is not changed by opening it", () => {
  const root = dir();
  const path = indexPath(root);
  const db = rawIndex(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  db.exec("CREATE TABLE other (a INTEGER); INSERT INTO other VALUES (1); PRAGMA user_version = 7;");
  // The connection stays open, so the write-ahead log is on disk and no close checkpoints it.
  const before = {
    main: readFileSync(path),
    wal: readFileSync(`${path}-wal`),
  };
  const opened = openSessionIndex({ path });
  assert.deepEqual(opened, { ok: false, reason: "unsupported index version 7" });
  assert.equal(readFileSync(path).equals(before.main), true);
  // The write-ahead log is still there, with its bytes: opening did not checkpoint it away.
  assert.equal(existsSync(`${path}-wal`), true);
  assert.equal(readFileSync(`${path}-wal`).equals(before.wal), true);
  db.close();
});

test("a corrupt file is deleted with its companions and rebuilt once", () => {
  const root = dir();
  const path = indexPath(root);
  writeFileSync(path, "this file is not a database");
  writeFileSync(`${path}-wal`, "companion");
  writeFileSync(`${path}-shm`, "companion");
  const opened = openSessionIndex({ path });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.index.generation, 1);
  assert.equal(userVersionOf(path), FORMAT_VERSION);
  assert.equal(readFileSync(path).subarray(0, 16).toString("utf8"), "SQLite format 3\u0000");
  const db = rawIndex(path);
  try {
    const count = must(db.prepare("SELECT count(*) AS n FROM files").get()).n;
    assert.equal(count, 0);
  } finally {
    db.close();
  }
  opened.index.close();
});

test("a second corruption report in one call makes the index unusable with the reason", async () => {
  const root = dir();
  const path = indexPath(root);
  writeFileSync(path, "not a database at all");
  const opened = openSessionIndex({ path });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine());
  // Replace the recovered file with garbage under a new inode, so the call must open it anew.
  const garbage = join(root, "garbage");
  writeFileSync(garbage, "still not a database");
  renameSync(garbage, path);
  const outcome = await opened.index.catchUp(session);
  assert.equal(outcome.status, "unusable");
  assert.equal(outcome.reason, "index file is corrupt: file is not a database");
  assert.equal(opened.index.unusableReason(), "index file is corrupt: file is not a database");
  // A second call reports the same reason without touching the file.
  assert.equal((await opened.index.catchUp(session)).status, "unusable");
  opened.index.close();
});

test("a file that cannot be opened is unusable with the error's message", () => {
  const root = dir();
  const path = indexPath(root);
  mkdirSync(path);
  const opened = openSessionIndex({ path });
  assert.equal(opened.ok, false);
  if (opened.ok) return;
  assert.match(opened.reason, /unable to open database file/);
});

test("a failed creation is rolled back whole and the index is unusable", () => {
  const root = dir();
  const path = indexPath(root);
  writeFileSync(path, "");
  chmodSync(path, 0o444);
  try {
    const opened = openSessionIndex({ path });
    assert.equal(opened.ok, false);
    if (opened.ok) return;
    assert.match(opened.reason, /readonly|read-only/i);
    assert.equal(userVersionOf(path), 0);
    const db = rawIndex(path);
    try {
      const tables = db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
        .get();
      assert.equal(must(tables).n, 0);
    } finally {
      db.close();
    }
  } finally {
    chmodSync(path, 0o644);
  }
});

test("a valid database of another application with user_version 2 is used as an index until a statement fails", () => {
  const root = dir();
  const path = indexPath(root);
  const db = rawIndex(path);
  db.exec("CREATE TABLE other (a INTEGER); PRAGMA user_version = 2;");
  db.close();
  const opened = openSessionIndex({ path });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.deepEqual(opened.index.files(), { ok: false, reason: "no such table: files" });
  assert.match(must(opened.index.unusableReason()), /no such table/);
  const snapshot = opened.index.snapshot((view) => view.files());
  assert.equal(snapshot.ok, false);
  opened.index.close();
});

test("a file deleted or replaced since the last use is opened anew and the old one is not used again", async () => {
  const root = dir();
  const path = indexPath(root);
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine());
  const index = openIndex(path);
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.equal(index.generation, 1);
  rmSync(path);
  const replacement = openIndex(path);
  replacement.close();
  assert.equal(statSync(path).size > 0, true);
  const outcome = await index.catchUp(session);
  assert.equal(outcome.status, "complete");
  assert.equal(index.generation, 2);
  assert.equal(ok(index.files()).length, 1);
  index.close();
});

test("the prune opener never creates the index file", () => {
  const root = dir();
  const path = indexPath(join(root, "absent"));
  const index = new SessionIndex({ path, mode: "prune" });
  assert.notEqual(index.start(), undefined);
  assert.equal(existsSync(path), false);
  index.close();
});
