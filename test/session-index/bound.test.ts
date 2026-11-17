import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { must } from "../support/must.ts";
import {
  entryLine,
  fileOf,
  fileText,
  headerLine,
  indexPath,
  itemsOf,
  ok,
  openIndex,
  tempDir,
  userLine,
  writeSession,
} from "./support.ts";

/** specs/session-index.md Section 3: the bound on one transaction, and a catch-up stopped by a deadline or an abort. */

const TRANSACTION_BYTE_LIMIT = 8388608;

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const path = tempDir("session-index-bound-");
  roots.push(path);
  return path;
}

/** An entry of no transcript kind, so that a large fixture costs no item text. */
function bulkLine(id: string, parentId: string | null, size: number): string {
  return entryLine({
    type: "other",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: "x".repeat(size),
  });
}

test("a file of more than 8388608 bytes is consumed by further transactions", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine();
  const lines: string[] = [];
  let parent = "session-one";
  for (let index = 0; index < 900; index += 1) {
    const id = `e${index}`;
    lines.push(bulkLine(id, parent, 10000));
    parent = id;
  }
  writeSession(session, header, ...lines);
  const index = openIndex(indexPath(root));
  const outcome = await index.catchUp(session);
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.transactions > 1, true);
  assert.equal(fileOf(index, session).consumed, fileText(header, ...lines).length);
  assert.equal(fileOf(index, session).lines, 901);
  assert.equal(itemsOf(index, session).length, 0);
  index.close();
});

test("a line longer than the bound followed by short lines is consumed whole and the catch-up is complete", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine();
  const long = bulkLine("big", "session-one", 9000000);
  const lines = [long];
  let parent = "big";
  for (let count = 0; count < 100; count += 1) {
    const id = `s${count}`;
    lines.push(userLine(id, parent, `short ${count}`));
    parent = id;
  }
  writeSession(session, header, ...lines);
  const size = fileText(header, ...lines).length;
  const index = openIndex(indexPath(root));
  // One transaction at a time, so each transaction's own read is measured.
  let steps = 0;
  for (;;) {
    let calls = 0;
    const outcome = await index.catchUp(session, {
      deadline: Date.now() + 60_000,
      now: () => {
        calls += 1;
        return calls <= 2 ? Date.now() : Number.MAX_SAFE_INTEGER;
      },
    });
    steps += 1;
    // The long line is read once in a transaction, not twice: no transaction reads twice the file.
    assert.equal(outcome.bytesRead < size * 1.2, true, `read ${outcome.bytesRead} of ${size}`);
    if (outcome.status === "complete") break;
  }
  assert.equal(steps, 2);
  const file = fileOf(index, session);
  assert.equal(file.consumed, size);
  assert.equal(file.lines, 102);
  assert.equal(itemsOf(index, session).length, 100);
  index.close();
});

test("a deadline that has passed stops the catch-up before any transaction, and a later call completes it", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const index = openIndex(indexPath(root));
  const stopped = await index.catchUp(session, { deadline: 1 });
  assert.equal(stopped.status, "incomplete");
  assert.equal(stopped.transactions, 0);
  assert.deepEqual(index.files(), { ok: true, value: [] });
  const complete = await index.catchUp(session);
  assert.equal(complete.status, "complete");
  assert.equal(must(ok(index.files())[0]).fileId > 0, true);
  index.close();
});

test("a deadline that passes between transactions leaves the committed one in place", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine();
  const lines: string[] = [];
  for (let index = 0; index < 900; index += 1) {
    lines.push(bulkLine(`e${index}`, "session-one", 10000));
  }
  writeSession(session, header, ...lines);
  const index = openIndex(indexPath(root));
  const start = Date.now();
  let calls = 0;
  const stopped = await index.catchUp(session, {
    deadline: start + 1000,
    now: () => {
      calls += 1;
      // The first two checks run before the first transaction; the third one stops the loop.
      return calls <= 2 ? start : start + 5000;
    },
  });
  assert.equal(stopped.status, "incomplete");
  assert.equal(stopped.transactions, 1);
  const headerConsumed = Buffer.byteLength(header) + 1;
  const consumed = fileOf(index, session).consumed;
  assert.equal(consumed > headerConsumed, true);
  assert.equal(consumed - headerConsumed <= TRANSACTION_BYTE_LIMIT, true);
  const complete = await index.catchUp(session);
  assert.equal(complete.status, "complete");
  assert.equal(fileOf(index, session).consumed, fileText(header, ...lines).length);
  index.close();
});

test("an abort stops the catch-up before any transaction", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine());
  const index = openIndex(indexPath(root));
  const stopped = await index.catchUp(session, { aborted: () => true });
  assert.equal(stopped.status, "incomplete");
  assert.equal(stopped.transactions, 0);
  assert.deepEqual(index.files(), { ok: true, value: [] });
  assert.equal((await index.catchUp(session)).status, "complete");
  index.close();
});
