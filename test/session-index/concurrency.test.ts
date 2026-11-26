import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  appendLine,
  fileOf,
  headerLine,
  indexPath,
  ok,
  openIndex,
  tempDir,
  userLine,
  writeSession,
} from "./support.ts";

/** specs/session-index.md#concurrent-access: concurrent access; specs/session-index.md#failures: failed writes and an unusable index. */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const path = tempDir("session-index-concurrency-");
  roots.push(path);
  return path;
}

test("a write transaction that cannot begin is attempted again until it begins", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const path = indexPath(root);
  const index = openIndex(path, { busyTimeoutMs: 20 });
  const other = new DatabaseSync(path);
  other.exec("PRAGMA busy_timeout = 20;");
  other.exec("BEGIN IMMEDIATE");
  let calls = 0;
  const outcome = await index.catchUp(session, {
    deadline: Date.now() + 60_000,
    now: () => {
      calls += 1;
      // The other process commits while this one waits for the write lock.
      if (calls === 2) other.exec("COMMIT");
      return Date.now();
    },
  });
  other.close();
  assert.equal(outcome.status, "complete");
  assert.equal(calls > 1, true);
  assert.equal(index.failedWriteReason(), undefined);
  assert.equal(ok(index.files()).length, 1);
  index.close();
});

test("a busy write that the deadline stops is not a failed write", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const path = indexPath(root);
  const index = openIndex(path, { busyTimeoutMs: 20 });
  const other = new DatabaseSync(path);
  other.exec("PRAGMA busy_timeout = 20;");
  other.exec("BEGIN IMMEDIATE");
  const start = Date.now();
  let calls = 0;
  const outcome = await index.catchUp(session, {
    deadline: start + 1000,
    now: () => {
      calls += 1;
      return calls === 1 ? start : start + 5000;
    },
  });
  other.exec("ROLLBACK");
  other.close();
  assert.equal(outcome.status, "incomplete");
  assert.equal(outcome.transactions, 0);
  assert.equal(index.failedWriteReason(), undefined);
  assert.deepEqual(index.files(), { ok: true, value: [] });
  assert.equal((await index.catchUp(session)).status, "complete");
  index.close();
});

test("an abort is observed within a tenth of a second while another process holds the write lock", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const path = indexPath(root);
  const index = openIndex(path, { busyTimeoutMs: 1000 });
  const other = new DatabaseSync(path);
  other.exec("BEGIN IMMEDIATE");
  let aborted = false;
  setTimeout(() => {
    aborted = true;
  }, 100);
  const started = Date.now();
  const outcome = await index.catchUp(session, { aborted: () => aborted });
  const elapsed = Date.now() - started;
  other.exec("ROLLBACK");
  other.close();
  assert.equal(outcome.status, "incomplete");
  assert.equal(elapsed < 400, true, `abort took ${elapsed} ms`);
  index.close();
});

test("a deadline is observed within one transaction while another process holds the write lock", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const path = indexPath(root);
  const index = openIndex(path, { busyTimeoutMs: 1000 });
  const other = new DatabaseSync(path);
  other.exec("BEGIN IMMEDIATE");
  const started = Date.now();
  const outcome = await index.catchUp(session, { deadline: started + 200 });
  const elapsed = Date.now() - started;
  other.exec("ROLLBACK");
  other.close();
  assert.equal(outcome.status, "incomplete");
  assert.equal(elapsed < 700, true, `deadline took ${elapsed} ms`);
  index.close();
});

test("a read-only database gives a failed write with its reason, and reading continues", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const path = indexPath(root);
  const first = openIndex(path);
  first.close();
  chmodSync(path, 0o444);
  try {
    const index = openIndex(path);
    const outcome = await index.catchUp(session);
    assert.equal(outcome.status, "failed-write");
    assert.equal(outcome.reason, "attempt to write a readonly database");
    assert.equal(index.failedWriteReason(), "attempt to write a readonly database");
    assert.equal(index.unusableReason(), undefined);
    // Reading the index continues.
    assert.deepEqual(index.files(), { ok: true, value: [] });
    // Writing the file back does not let the call write again: the first failed write stands.
    chmodSync(path, 0o644);
    const again = await index.catchUp(session);
    assert.equal(again.status, "failed-write");
    assert.equal(again.reason, "attempt to write a readonly database");
    index.close();
  } finally {
    chmodSync(path, 0o644);
  }
});

test("a snapshot reads the rows of one evaluation in one transaction and leaves none open", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(
    session,
    headerLine(),
    userLine("a1", "session-one", "hello"),
    userLine("a2", "a1", "again"),
  );
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const fileId = fileOf(index, session).fileId;
  const snapshot = index.snapshot((view) => {
    const files = view.files();
    const items = view.listItems(fileId);
    const found = view.findItem(fileId, "a2", undefined);
    const matched = view.matchingItemIds(["hel"]);
    // Reading again inside the same snapshot is part of the same read transaction.
    return {
      files: ok(files).length,
      items: ok(items).length,
      found: ok(found)?.entryId,
      matched: ok(matched)?.size,
    };
  });
  assert.deepEqual(snapshot, {
    ok: true,
    value: { files: 1, items: 2, found: "a2", matched: 1 },
  });
  // No read transaction is left open: a write transaction on the same connection begins.
  appendLine(session, userLine("a3", "a2", "third"));
  assert.equal((await index.catchUp(session)).status, "complete");
  index.close();
});

test("a caller's error in a snapshot propagates unchanged and leaves the index usable", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const failure = new TypeError("caller bug");
  assert.throws(
    () =>
      index.snapshot(() => {
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.equal(index.unusableReason(), undefined);
  // The read transaction ended: reads still work and a write transaction begins.
  assert.equal(ok(index.files()).length, 1);
  appendLine(session, userLine("a2", "a1", "second"));
  assert.equal((await index.catchUp(session)).status, "complete");
  // A nested snapshot is guarded the same way.
  assert.throws(
    () =>
      index.snapshot(() =>
        index.snapshot(() => {
          throw failure;
        }),
      ),
    (error) => error === failure,
  );
  assert.equal(index.unusableReason(), undefined);
  assert.equal(ok(index.listItems(fileOf(index, session).fileId)).length, 2);
  index.close();
});

test("a corruption found by a read is repaired, and the rebuilt index stays usable", async () => {
  const root = dir();
  const path = indexPath(root);
  const session = join(root, "s.jsonl");
  const lines = [headerLine()];
  let parent = "session-one";
  for (let count = 0; count < 1500; count += 1) {
    const id = `a${count}`;
    lines.push(userLine(id, parent, `text of entry ${count}`));
    parent = id;
  }
  writeSession(session, ...lines);
  const seed = openIndex(path);
  assert.equal((await seed.catchUp(session)).status, "complete");
  seed.close();
  const index = openIndex(path);
  const fileId = fileOf(index, session).fileId;
  // Overwrite the file's pages under the live connection, so the next statement reports it.
  writeFileSync(path, "corrupted pages, not a database");
  const outcome = index.listItems(fileId);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ok ? outcome.value : [], []);
  assert.equal(index.generation, 2);
  assert.equal(index.unusableReason(), undefined);
  assert.deepEqual(index.files(), { ok: true, value: [] });
  index.close();
});

test("a snapshot of an unusable index reports its reason", async () => {
  const root = dir();
  const path = indexPath(root);
  writeFileSync(path, "not a database");
  const index = openIndex(path);
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine());
  const garbage = join(root, "garbage");
  writeFileSync(garbage, "not a database either");
  renameSync(garbage, path);
  assert.equal((await index.catchUp(session)).status, "unusable");
  const snapshot = index.snapshot((view) => view.files());
  assert.deepEqual(snapshot, {
    ok: false,
    reason: "index file is corrupt: file is not a database",
  });
  assert.deepEqual(index.listItems(1), {
    ok: false,
    reason: "index file is corrupt: file is not a database",
  });
  index.close();
});

test("a closed index reports the failure rather than a caller error", () => {
  const root = dir();
  const index = openIndex(indexPath(root));
  index.close();
  assert.deepEqual(index.files(), { ok: false, reason: "the index is not open" });
});
