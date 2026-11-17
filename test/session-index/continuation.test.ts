import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  fileOf,
  headerLine,
  indexPath,
  ok,
  openIndex,
  tempDir,
  userLine,
  writeSession,
} from "./support.ts";

/** specs/search-tool.md Section 2.2: the continuation of catch-up after a call returns. */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const path = tempDir("session-index-continuation-");
  roots.push(path);
  return path;
}

test("the continuation indexes every session it is given, in the order given", async () => {
  const root = dir();
  const first = join(root, "a.jsonl");
  const second = join(root, "b.jsonl");
  writeSession(first, headerLine("session-a"), userLine("a1", "session-a", "first text"));
  writeSession(second, headerLine("session-b"), userLine("b1", "session-b", "second text"));
  const index = openIndex(indexPath(root));
  const continuation = index.continueCatchUp([first, second]);
  let settled = false;
  void continuation.done.then(() => {
    settled = true;
  });
  // The continuation yields to the event loop, so it has not finished synchronously.
  assert.equal(settled, false);
  const outcome = await continuation.done;
  assert.deepEqual(outcome, { status: "complete", reason: undefined });
  assert.equal(ok(index.files()).length, 2);
  assert.deepEqual(
    ok(index.listItems(fileOf(index, first).fileId)).map((row) => row.entryId),
    ["a1"],
  );
  assert.deepEqual(
    ok(index.listItems(fileOf(index, second).fileId)).map((row) => row.entryId),
    ["b1"],
  );
  index.close();
});

test("a continuation of unchanged sessions reads nothing", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const outcome = await index.continueCatchUp([session]).done;
  assert.deepEqual(outcome, { status: "complete", reason: undefined });
  index.close();
});

test("the continuation stops at a failed write with its reason", async () => {
  const root = dir();
  const first = join(root, "a.jsonl");
  const second = join(root, "b.jsonl");
  writeSession(first, headerLine("session-a"), userLine("a1", "session-a", "first text"));
  writeSession(second, headerLine("session-b"), userLine("b1", "session-b", "second text"));
  const path = indexPath(root);
  const seed = openIndex(path);
  seed.close();
  chmodSync(path, 0o444);
  try {
    const index = openIndex(path);
    const outcome = await index.continueCatchUp([first, second]).done;
    assert.equal(outcome.status, "failed-write");
    assert.equal(outcome.reason, "attempt to write a readonly database");
    assert.deepEqual(index.files(), { ok: true, value: [] });
    index.close();
  } finally {
    chmodSync(path, 0o644);
  }
});

test("a continuation can be stopped by its caller", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const index = openIndex(indexPath(root));
  const continuation = index.continueCatchUp([session]);
  continuation.stop();
  assert.deepEqual(await continuation.done, { status: "stopped", reason: undefined });
  assert.deepEqual(index.files(), { ok: true, value: [] });
  index.close();
});

test("a stop during a catch-up waiting for a write lock ends the continuation promptly", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const path = indexPath(root);
  const index = openIndex(path, { busyTimeoutMs: 1000 });
  const other = new DatabaseSync(path);
  other.exec("BEGIN IMMEDIATE");
  const continuation = index.continueCatchUp([session]);
  setTimeout(() => continuation.stop(), 100);
  const started = Date.now();
  const outcome = await continuation.done;
  const elapsed = Date.now() - started;
  other.exec("ROLLBACK");
  other.close();
  assert.equal(outcome.status, "stopped");
  assert.equal(elapsed < 500, true, `stop took ${elapsed} ms`);
  index.close();
});

test("a continuation whose session file is gone drops its rows and completes", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  rmSync(session);
  const outcome = await index.continueCatchUp([session]).done;
  assert.deepEqual(outcome, { status: "complete", reason: undefined });
  assert.deepEqual(index.files(), { ok: true, value: [] });
  index.close();
});

test("a continuation stopped by its deadline reports stopped", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const index = openIndex(indexPath(root));
  const outcome = await index.continueCatchUp([session], { deadline: 1 }).done;
  assert.deepEqual(outcome, { status: "stopped", reason: undefined });
  index.close();
});
