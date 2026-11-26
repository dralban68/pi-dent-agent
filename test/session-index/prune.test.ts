import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pruneSessionIndex } from "../../lib/session-index.ts";
import { must } from "../support/must.ts";
import {
  fileOf,
  headerLine,
  indexPath,
  ok,
  openIndex,
  rawIndex,
  tempDir,
  userLine,
  writeSession,
} from "./support.ts";

/** specs/session-index.md#index-prune: the index prune. */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const path = tempDir("session-index-prune-");
  roots.push(path);
  return path;
}

test("the prune deletes the rows of a file that no longer exists and keeps the others", async () => {
  const root = dir();
  const path = indexPath(root);
  const kept = join(root, "kept.jsonl");
  const gone = join(root, "gone.jsonl");
  writeSession(kept, headerLine("session-kept"), userLine("a1", "session-kept", "kept text"));
  writeSession(gone, headerLine("session-gone"), userLine("b1", "session-gone", "gone text"));
  const index = openIndex(path);
  assert.equal((await index.catchUp(kept)).status, "complete");
  assert.equal((await index.catchUp(gone)).status, "complete");
  const goneId = fileOf(index, gone).fileId;
  rmSync(gone);
  const pruned = await pruneSessionIndex({ path });
  assert.equal(pruned.files, 1);
  assert.deepEqual(ok(index.fileFor(gone)), undefined);
  assert.deepEqual(ok(index.listItems(goneId)), []);
  assert.notEqual(ok(index.fileFor(kept)), undefined);
  assert.deepEqual(ok(index.matchingItemIds(["gon"])), new Set());
  assert.equal(ok(index.matchingItemIds(["kep"]))?.size, 1);
  assert.equal(existsSync(path), true);
  index.close();
  const db = rawIndex(path);
  try {
    assert.equal(must(db.prepare("SELECT count(*) AS n FROM item_text").get()).n, 1);
    assert.equal(must(db.prepare("SELECT count(*) AS n FROM entries").get()).n, 1);
  } finally {
    db.close();
  }
});

test("the prune treats a session file replaced by a directory as gone", async () => {
  const root = dir();
  const path = indexPath(root);
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "text"));
  const index = openIndex(path);
  assert.equal((await index.catchUp(session)).status, "complete");
  rmSync(session);
  mkdirSync(session);
  assert.equal((await pruneSessionIndex({ path })).files, 1);
  assert.deepEqual(index.files(), { ok: true, value: [] });
  index.close();
});

test("the prune does not create the index file when it is absent", async () => {
  const root = dir();
  const path = indexPath(join(root, "absent"));
  const pruned = await pruneSessionIndex({ path });
  assert.deepEqual(pruned, { files: 0, transactions: 0 });
  assert.equal(existsSync(path), false);
});

test("the prune stops without deleting a corrupt index file", async () => {
  const root = dir();
  const path = indexPath(root);
  writeFileSync(path, "not a database at all");
  const before = readFileSync(path);
  const pruned = await pruneSessionIndex({ path });
  assert.deepEqual(pruned, { files: 0, transactions: 0 });
  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(path).equals(before), true);
});

test("the prune stops on an index of an unsupported version and leaves it as it was", async () => {
  const root = dir();
  const path = indexPath(root);
  const db = rawIndex(path);
  db.exec("CREATE TABLE other (a INTEGER); PRAGMA user_version = 9;");
  db.close();
  const before = readFileSync(path);
  assert.deepEqual(await pruneSessionIndex({ path }), { files: 0, transactions: 0 });
  assert.equal(readFileSync(path).equals(before), true);
});

test("the prune stops on a file that is the session store's file", async () => {
  const root = dir();
  const path = indexPath(root);
  writeFileSync(path, "a session store's bytes");
  const before = readFileSync(path);
  assert.deepEqual(await pruneSessionIndex({ path, storePath: path }), {
    files: 0,
    transactions: 0,
  });
  assert.equal(readFileSync(path).equals(before), true);
});

test("a prune waits for the write lock within the busy timeout and then deletes the rows", async () => {
  const root = dir();
  const path = indexPath(root);
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "text"));
  const index = openIndex(path);
  assert.equal((await index.catchUp(session)).status, "complete");
  rmSync(session);
  const other = new DatabaseSync(path);
  other.exec("PRAGMA busy_timeout = 20;");
  other.exec("BEGIN IMMEDIATE");
  // Another session's write ends well inside the default busy timeout of 1000 ms (specs/session-index.md#location).
  const release = setTimeout(() => {
    other.exec("COMMIT");
  }, 250);
  const pruned = await pruneSessionIndex({ path });
  clearTimeout(release);
  other.close();
  assert.deepEqual(pruned, { files: 1, transactions: 1 });
  assert.deepEqual(index.files(), { ok: true, value: [] });
  index.close();
});

test("a prune that cannot begin a transaction within the busy timeout stops without deleting rows", async () => {
  const root = dir();
  const path = indexPath(root);
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "text"));
  const index = openIndex(path);
  assert.equal((await index.catchUp(session)).status, "complete");
  rmSync(session);
  const other = new DatabaseSync(path);
  other.exec("PRAGMA busy_timeout = 20;");
  other.exec("BEGIN IMMEDIATE");
  const busy = await pruneSessionIndex({ path, busyTimeoutMs: 20 });
  other.exec("ROLLBACK");
  other.close();
  assert.deepEqual(busy, { files: 0, transactions: 0 });
  assert.equal(ok(index.files()).length, 1);
  assert.equal((await pruneSessionIndex({ path })).files, 1);
  index.close();
});

test("the prune covers at most 100 files rows per transaction", async () => {
  const root = dir();
  const path = indexPath(root);
  const index = openIndex(path);
  const sessions: string[] = [];
  for (let count = 0; count < 120; count += 1) {
    const session = join(root, `s${count}.jsonl`);
    writeSession(session, headerLine(`session-${count}`));
    assert.equal((await index.catchUp(session)).status, "complete");
    sessions.push(session);
  }
  assert.equal(ok(index.files()).length, 120);
  for (const session of sessions) rmSync(session);
  const pruned = await pruneSessionIndex({ path });
  assert.equal(pruned.files, 120);
  assert.equal(pruned.transactions, 2);
  assert.deepEqual(index.files(), { ok: true, value: [] });
  index.close();
});
