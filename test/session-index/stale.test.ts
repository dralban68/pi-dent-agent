import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pruneSessionIndex } from "../../lib/session-index.ts";
import { must } from "../support/must.ts";
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

/** specs/session-index.md#catch-up: a stale row, and the conditional reset. */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const path = tempDir("session-index-stale-");
  roots.push(path);
  return path;
}

/** Rewrite one line of a session file in place, keeping every byte count. */
function replaceInFile(path: string, from: string, to: string): void {
  const text = readFileSync(path, "utf8");
  assert.equal(from.length, to.length);
  assert.equal(text.includes(from), true);
  writeFileSync(path, text.split(from).join(to));
}

test("the text of an item is read back from the session file by its offset and bytes", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const long = "y".repeat(120000);
  writeSession(session, headerLine(), userLine("a1", "session-one", long));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const row = must(ok(index.listItems(fileOf(index, session).fileId))[0]);
  assert.equal(row.offset, Buffer.byteLength(`${headerLine()}\n`));
  const read = index.readItem(row);
  assert.equal(read.status, "item");
  if (read.status !== "item") return;
  assert.equal(read.item.text.length, 120000);
  assert.equal(read.item.matchText.length, 100000);
  assert.equal(read.item.text, long);
  index.close();
});

test("a stale row is detected when the line no longer carries the entry ID", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(
    session,
    headerLine(),
    userLine("a1", "session-one", "first"),
    userLine("a2", "a1", "second"),
  );
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const rows = ok(index.listItems(fileOf(index, session).fileId));
  const first = must(rows[0]);
  assert.equal(index.readItem(first).status, "item");
  replaceInFile(session, '"id":"a1"', '"id":"z1"');
  assert.deepEqual(index.readItem(first), { status: "stale" });
  // A row whose entry is intact but whose part the line does not yield is stale too
  // (specs/session-index.md#catch-up), as is one whose kind differs.
  assert.deepEqual(index.readItem({ ...must(rows[1]), part: "7" }), { status: "stale" });
  assert.deepEqual(index.readItem({ ...must(rows[1]), kind: "tool_result" }), { status: "stale" });
  index.close();
});

test("a stale row resets its file in one transaction while consumed and tail_hash are unchanged", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(
    session,
    headerLine(),
    userLine("a1", "session-one", "first"),
    userLine("a2", "a1", "second"),
  );
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const fileId = fileOf(index, session).fileId;
  const first = must(ok(index.listItems(fileId))[0]);
  replaceInFile(session, '"id":"a1"', '"id":"z1"');
  assert.equal(index.readItem(first).status, "stale");
  assert.deepEqual(await index.resetStale(first), { status: "reset" });
  assert.deepEqual(ok(index.fileFor(session)), undefined);
  assert.deepEqual(ok(index.listItems(fileId)), []);
  assert.equal(ok(index.matchingItemIds(["fir"]))?.size, 0);
  // The next catch-up rebuilds the file from its bytes.
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.deepEqual(
    ok(index.listItems(fileOf(index, session).fileId)).map((row) => row.entryId),
    ["z1", "a2"],
  );
  index.close();
});

test("a stale row changes nothing when the files row moved since the reader's snapshot", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(
    session,
    headerLine(),
    userLine("a1", "session-one", "first"),
    userLine("a2", "a1", "second"),
  );
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const fileId = fileOf(index, session).fileId;
  const first = must(ok(index.listItems(fileId))[0]);
  replaceInFile(session, '"id":"a1"', '"id":"z1"');
  appendLine(session, userLine("a3", "a2", "third"));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.deepEqual(await index.resetStale(first), { status: "unchanged" });
  assert.equal(ok(index.listItems(fileId)).length, 3);
  index.close();
});

test("a stale row changes nothing when its files row is gone", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "first"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const first = must(ok(index.listItems(fileOf(index, session).fileId))[0]);
  rmSync(session);
  assert.equal((await pruneSessionIndex({ path: index.path })).files, 1);
  assert.deepEqual(await index.resetStale(first), { status: "unchanged" });
  assert.deepEqual(index.files(), { ok: true, value: [] });
  index.close();
});

test("a reset stopped by its deadline reports stopped and leaves the rows", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "first"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const fileId = fileOf(index, session).fileId;
  const first = must(ok(index.listItems(fileId))[0]);
  assert.deepEqual(await index.resetStale(first, { deadline: 1 }), { status: "stopped" });
  assert.equal(ok(index.listItems(fileId)).length, 1);
  index.close();
});

test("a reset waits for the write lock, then resets", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "first"));
  const path = indexPath(root);
  const index = openIndex(path, { busyTimeoutMs: 20 });
  assert.equal((await index.catchUp(session)).status, "complete");
  const first = must(ok(index.listItems(fileOf(index, session).fileId))[0]);
  const other = new DatabaseSync(path);
  other.exec("PRAGMA busy_timeout = 20;");
  other.exec("BEGIN IMMEDIATE");
  let calls = 0;
  const outcome = await index.resetStale(first, {
    deadline: Date.now() + 60_000,
    now: () => {
      calls += 1;
      if (calls === 3) other.exec("COMMIT");
      return Date.now();
    },
  });
  other.close();
  assert.deepEqual(outcome, { status: "reset" });
  assert.deepEqual(index.files(), { ok: true, value: [] });
  index.close();
});
