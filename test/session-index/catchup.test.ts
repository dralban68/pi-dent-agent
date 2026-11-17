import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { must } from "../support/must.ts";
import {
  appendLine,
  entryLine,
  fileOf,
  fileText,
  headerLine,
  indexPath,
  itemsOf,
  ok,
  openIndex,
  rawIndex,
  setMtime,
  tempDir,
  userLine,
  writeSession,
} from "./support.ts";

/** specs/session-index.md Section 3: catch-up, and Section 4: two catch-ups of one file. */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const path = tempDir("session-index-catchup-");
  roots.push(path);
  return path;
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function mtimeOf(path: string): number {
  return Math.floor(statSync(path).mtimeMs);
}

/** The lineage column of every entry of one file, by entry ID. */
function lineageOf(indexPathName: string, fileId: number): Record<string, boolean> {
  const db = new DatabaseSync(indexPathName);
  try {
    const rows = db
      .prepare("SELECT entry_id, lineage FROM entries WHERE file_id = ? ORDER BY line")
      .all(fileId);
    return Object.fromEntries(rows.map((row) => [String(row.entry_id), Number(row.lineage) === 1]));
  } finally {
    db.close();
  }
}

test("the first catch-up inserts the header's line and the entries after it", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine("session-one");
  const one = userLine("a1", "session-one", "first message");
  const two = userLine("a2", "a1", "second message");
  writeSession(session, header, one, two);
  const index = openIndex(indexPath(root));
  const outcome = await index.catchUp(session);
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.transactions, 1);
  assert.equal(outcome.bytesRead, fileText(header, one, two).length);
  const file = fileOf(index, session);
  assert.equal(file.sessionId, "session-one");
  assert.equal(file.started, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(file.consumed, fileText(header, one, two).length);
  assert.equal(file.lines, 3);
  assert.equal(file.lastTime, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(file.mtime, mtimeOf(session));
  assert.equal(file.tailOffset, fileText(header, one).length);
  assert.equal(file.tailHash, sha256(fileText(two)));
  const db = rawIndex(index.path);
  try {
    const entries = db
      .prepare(
        "SELECT line, offset, bytes, entry_id, parent_id, time, lineage FROM entries ORDER BY line",
      )
      .all();
    assert.deepEqual(
      entries.map((row) => ({ ...row })),
      [
        {
          line: 2,
          offset: fileText(header).length,
          bytes: one.length,
          entry_id: "a1",
          parent_id: "session-one",
          time: Date.parse("2026-01-01T00:00:00.000Z"),
          lineage: 1,
        },
        {
          line: 3,
          offset: fileText(header, one).length,
          bytes: two.length,
          entry_id: "a2",
          parent_id: "a1",
          time: Date.parse("2026-01-01T00:00:00.000Z"),
          lineage: 1,
        },
      ],
    );
  } finally {
    db.close();
  }
  index.close();
});

test("an unchanged file costs no read and changes nothing", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const before = fileOf(index, session);
  const again = await index.catchUp(session);
  assert.equal(again.status, "complete");
  assert.equal(again.bytesRead, 0);
  assert.equal(again.transactions, 0);
  assert.deepEqual(fileOf(index, session), before);
  index.close();
});

test("an append reads the tail line for its digest and the appended bytes only", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine();
  const one = userLine("a1", "session-one", "hello");
  writeSession(session, header, one);
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const two = userLine("a2", "a1", "appended message");
  appendLine(session, two);
  const outcome = await index.catchUp(session);
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.bytesRead, fileText(one).length + fileText(two).length);
  const file = fileOf(index, session);
  assert.equal(file.consumed, fileText(header, one, two).length);
  assert.equal(file.lines, 3);
  assert.equal(file.tailOffset, fileText(header, one).length);
  assert.equal(file.tailHash, sha256(fileText(two)));
  assert.deepEqual(
    itemsOf(index, session).map((row) => row.entryId),
    ["a1", "a2"],
  );
  index.close();
});

test("a modification time that moved alone is recorded without reading the entries", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine();
  const one = userLine("a1", "session-one", "hello");
  writeSession(session, header, one);
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  setMtime(session, Date.parse("2026-02-01T00:00:00.000Z"));
  const outcome = await index.catchUp(session);
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.transactions, 1);
  assert.equal(outcome.bytesRead, fileText(one).length);
  assert.equal(fileOf(index, session).mtime, mtimeOf(session));
  index.close();
});

test("an unterminated last line stores the modification time of the catch-up that saw it", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine();
  const one = userLine("a1", "session-one", "first");
  const two = userLine("a2", "a1", "second");
  writeFileSync(session, fileText(header, one) + two);
  const index = openIndex(indexPath(root));
  const first = await index.catchUp(session);
  assert.equal(first.status, "complete");
  const file = fileOf(index, session);
  assert.equal(file.consumed, fileText(header, one).length);
  assert.equal(file.mtime, mtimeOf(session));
  // A from-scratch index of the same bytes stores the same row.
  const fresh = openIndex(indexPath(root, "fresh.sqlite"));
  assert.equal((await fresh.catchUp(session)).status, "complete");
  assert.deepEqual(fileOf(fresh, session), { ...file, fileId: fileOf(fresh, session).fileId });
  fresh.close();
  // The next catch-up finds the row up to date and changes nothing.
  const again = await index.catchUp(session);
  assert.equal(again.status, "complete");
  assert.deepEqual(fileOf(index, session), file);
  appendLine(session, "");
  const second = await index.catchUp(session);
  assert.equal(second.status, "complete");
  assert.equal(fileOf(index, session).consumed, fileText(header, one, two).length);
  assert.deepEqual(
    itemsOf(index, session).map((row) => row.entryId),
    ["a1", "a2"],
  );
  index.close();
});

test("a truncated file is reset and rebuilt from its new bytes", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine();
  writeSession(
    session,
    header,
    userLine("a1", "session-one", "first"),
    userLine("a2", "a1", "second"),
  );
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const fileId = fileOf(index, session).fileId;
  assert.equal(ok(index.listItems(fileId)).length, 2);
  writeSession(session, header);
  const outcome = await index.catchUp(session);
  assert.equal(outcome.status, "complete");
  const file = fileOf(index, session);
  assert.equal(file.fileId, fileId);
  assert.equal(file.consumed, fileText(header).length);
  assert.equal(file.lines, 1);
  assert.deepEqual(ok(index.listItems(file.fileId)), []);
  assert.deepEqual(ok(index.matchingItemIds(["fir"])), new Set());
  index.close();
});

test("a replaced file whose tail line changed is reset", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine();
  writeSession(
    session,
    header,
    userLine("a1", "session-one", "aaaa"),
    userLine("a2", "a1", "bbbb"),
  );
  setMtime(session, Date.parse("2026-01-02T00:00:00.000Z"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  writeSession(
    session,
    header,
    userLine("z1", "session-one", "cccc"),
    userLine("z2", "z1", "dddd"),
  );
  setMtime(session, Date.parse("2026-01-03T00:00:00.000Z"));
  const outcome = await index.catchUp(session);
  assert.equal(outcome.status, "complete");
  assert.deepEqual(
    itemsOf(index, session).map((row) => row.entryId),
    ["z1", "z2"],
  );
  assert.deepEqual(ok(index.matchingItemIds(["aaa"])), new Set());
  assert.equal(ok(index.matchingItemIds(["ccc"]))?.size, 1);
  index.close();
});

test("a skipped line is consumed and yields no row", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine();
  writeSession(session, header, "", "not json at all", "[]", userLine("a1", "session-one", "real"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const file = fileOf(index, session);
  assert.equal(file.lines, 5);
  assert.equal(file.consumed, statSync(session).size);
  assert.deepEqual(
    itemsOf(index, session).map((row) => row.entryId),
    ["a1"],
  );
  index.close();
});

test("an entry with no date-time timestamp takes the time of the nearest earlier one", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine("session-one", "2026-01-01T00:00:00.000Z");
  const untimed = entryLine({
    type: "message",
    id: "a1",
    parentId: "session-one",
    timestamp: "not a date",
    message: { role: "user", content: [{ type: "text", text: "no time" }] },
  });
  const timed = userLine("a2", "a1", "has a time", "2026-01-02T00:00:00.000Z");
  writeSession(session, header, untimed);
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const firstTime = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(fileOf(index, session).lastTime, firstTime);
  assert.equal(must(itemsOf(index, session)[0]).time, firstTime);
  appendLine(
    session,
    entryLine({
      type: "message",
      id: "a3",
      parentId: "a1",
      timestamp: "also not a date",
      message: { role: "user", content: [{ type: "text", text: "no time 2" }] },
    }),
  );
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.equal(fileOf(index, session).lastTime, firstTime);
  appendLine(session, timed);
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.equal(fileOf(index, session).lastTime, Date.parse("2026-01-02T00:00:00.000Z"));
  index.close();
});

test("the lineage column marks the current lineage of the consumed bytes as a whole file", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine();
  writeSession(
    session,
    header,
    userLine("a1", "session-one", "root"),
    userLine("a2", "a1", "abandoned branch"),
    userLine("a3", "a1", "leaf of the first catch-up"),
  );
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const fileId = fileOf(index, session).fileId;
  assert.deepEqual(lineageOf(index.path, fileId), { a1: true, a2: false, a3: true });
  appendLine(session, userLine("a4", "a2", "the branch continues"));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.deepEqual(lineageOf(index.path, fileId), {
    a1: true,
    a2: true,
    a3: false,
    a4: true,
  });
  index.close();
});

test("the incremental lineage matches an index built from scratch, branch by branch", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const header = headerLine();
  const steps = [
    [userLine("a1", "session-one", "root")],
    [userLine("a2", "a1", "left")],
    [userLine("a3", "a1", "right")],
    [userLine("a4", "a2", "left again")],
    [userLine("a5", "a4", "deeper left")],
    [userLine("a6", "a3", "back to the right branch")],
    [userLine("a7", "a6", "and further")],
    [userLine("a8", "a1", "a third branch")],
    [userLine("a9", "a8", "on the third")],
    [userLine("a10", "a7", "the right branch again")],
  ];
  writeSession(session, header, ...must(steps[0]));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  for (const step of steps.slice(1)) {
    for (const line of step) appendLine(session, line);
    assert.equal((await index.catchUp(session)).status, "complete");
  }
  const fileId = fileOf(index, session).fileId;
  const incremental = lineageOf(index.path, fileId);
  // The same file indexed from nothing gives the same lineage column.
  const fresh = openIndex(indexPath(root, "fresh.sqlite"));
  assert.equal((await fresh.catchUp(session)).status, "complete");
  const scratch = lineageOf(fresh.path, fileOf(fresh, session).fileId);
  assert.deepEqual(incremental, scratch);
  // Every entry's items agree on the lineage too.
  assert.deepEqual(
    itemsOf(index, session).map((row) => [row.entryId, row.lineage]),
    itemsOf(fresh, session).map((row) => [row.entryId, row.lineage]),
  );
  fresh.close();
  index.close();
});

test("an entry appended after the entry whose parent it is joins the lineage", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const first = userLine("a1", "later", "its parent is not in the file yet");
  const leaf = userLine("a2", "a1", "the leaf of the first catch-up");
  writeSession(session, headerLine(), first, leaf);
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.deepEqual(lineageOf(index.path, fileOf(index, session).fileId), {
    a1: true,
    a2: true,
  });
  // The lineage ended at the ID of no entry; the entry carrying it arrives now, with a new leaf.
  appendLine(session, userLine("later", "root", "the entry the lineage ended at"));
  appendLine(session, userLine("root", null, "its own parent"));
  appendLine(session, userLine("a3", "a2", "the new leaf"));
  assert.equal((await index.catchUp(session)).status, "complete");
  const fileId = fileOf(index, session).fileId;
  assert.deepEqual(lineageOf(index.path, fileId), {
    a1: true,
    a2: true,
    later: true,
    root: true,
    a3: true,
  });
  // The same file indexed from nothing has the same column, and the same item rows.
  const fresh = openIndex(indexPath(root, "fresh.sqlite"));
  assert.equal((await fresh.catchUp(session)).status, "complete");
  const scratchId = fileOf(fresh, session).fileId;
  assert.deepEqual(lineageOf(index.path, fileId), lineageOf(fresh.path, scratchId));
  assert.deepEqual(
    ok(index.listItems(fileId)).map((row) => [row.entryId, row.lineage]),
    ok(fresh.listItems(scratchId)).map((row) => [row.entryId, row.lineage]),
  );
  fresh.close();
  index.close();
});

test("a lineage that continues into an entry already on it ends there, appended or from scratch", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(
    session,
    headerLine(),
    userLine("a1", "a2", "its parent is the entry after it"),
    userLine("a2", "a1", "which continues a1 again"),
  );
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  appendLine(session, userLine("a3", "a1", "the new leaf"));
  assert.equal((await index.catchUp(session)).status, "complete");
  const fileId = fileOf(index, session).fileId;
  // From a3 the path runs a3, a1, a2, and then a1 again, which is already on it.
  assert.deepEqual(lineageOf(index.path, fileId), { a1: true, a2: true, a3: true });
  const fresh = openIndex(indexPath(root, "fresh.sqlite"));
  assert.equal((await fresh.catchUp(session)).status, "complete");
  assert.deepEqual(
    lineageOf(index.path, fileId),
    lineageOf(fresh.path, fileOf(fresh, session).fileId),
  );
  fresh.close();
  index.close();
});

test("a file whose header is past the read bound is not a session file", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  // The first line is unterminated when the catch-up reads the file's size, and complete
  // by the time the header is read: the read bound does not hold the header's line
  // ([session-transcript.md](session-transcript.md), Section 1).
  writeFileSync(session, headerLine());
  const index = openIndex(indexPath(root));
  const pending = index.catchUp(session);
  appendLine(session, "");
  const outcome = await pending;
  assert.equal(outcome.status, "not-session");
  assert.deepEqual(index.files(), { ok: true, value: [] });
  assert.deepEqual(ok(index.matchingItemIds(["ses"])), new Set());
  // The catch-up whose bound holds the header's line indexes the file.
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.equal(fileOf(index, session).sessionId, "session-one");
  index.close();
});

test("a file that is not readable as a session file is not indexed and loses its rows", async () => {
  const root = dir();
  const index = openIndex(indexPath(root));
  const plain = join(root, "plain.jsonl");
  writeSession(plain, entryLine({ type: "message", id: "a1", parentId: null, timestamp: "" }));
  assert.equal((await index.catchUp(plain)).status, "not-session");
  assert.deepEqual(index.files(), { ok: true, value: [] });
  const unterminatedHeader = join(root, "unterminated.jsonl");
  writeFileSync(unterminatedHeader, headerLine());
  assert.equal((await index.catchUp(unterminatedHeader)).status, "not-session");
  assert.deepEqual(index.files(), { ok: true, value: [] });
  const missing = join(root, "missing.jsonl");
  assert.equal((await index.catchUp(missing)).status, "not-session");
  const directory = join(root, "directory.jsonl");
  mkdirSync(directory);
  assert.equal((await index.catchUp(directory)).status, "not-session");
  assert.deepEqual(index.files(), { ok: true, value: [] });
  index.close();
});

test("a file that stops being a session file loses its rows", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "text"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.equal(ok(index.files()).length, 1);
  const fileId = fileOf(index, session).fileId;
  writeFileSync(session, "this is no longer a session file at all\n");
  setMtime(session, Date.parse("2026-03-01T00:00:00.000Z"));
  const outcome = await index.catchUp(session);
  assert.equal(outcome.status, "not-session");
  assert.deepEqual(index.files(), { ok: true, value: [] });
  assert.deepEqual(ok(index.listItems(fileId)), []);
  assert.deepEqual(ok(index.matchingItemIds(["tex"])), new Set());
  index.close();
});

test("an absent file that has rows loses them", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "text"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const fileId = fileOf(index, session).fileId;
  rmSync(session);
  assert.equal((await index.catchUp(session)).status, "not-session");
  assert.deepEqual(index.files(), { ok: true, value: [] });
  assert.deepEqual(ok(index.listItems(fileId)), []);
  index.close();
});

test("two catch-ups of one file from two connections never index a line twice", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const path = indexPath(root);
  writeSession(session, headerLine(), userLine("a1", "session-one", "first"));
  const first = openIndex(path);
  const second = openIndex(path);
  assert.equal((await first.catchUp(session)).status, "complete");
  appendLine(session, userLine("a2", "a1", "second"));
  const outcome = await second.catchUp(session);
  assert.equal(outcome.status, "complete");
  assert.equal(outcome.bytesRead > 0, true);
  // The first connection finds the second's rows and reads nothing.
  const again = await first.catchUp(session);
  assert.equal(again.status, "complete");
  assert.equal(again.bytesRead, 0);
  const file = fileOf(first, session);
  assert.equal(ok(first.files()).length, 1);
  assert.deepEqual(
    ok(first.listItems(file.fileId)).map((row) => [row.line, row.entryId]),
    [
      [2, "a1"],
      [3, "a2"],
    ],
  );
  first.close();
  second.close();
});

test("two catch-ups of one file run at once without indexing a line twice", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const path = indexPath(root);
  writeSession(session, headerLine(), userLine("a1", "session-one", "first"));
  const early = openIndex(path);
  const late = openIndex(path);
  const outcomes = await Promise.all([early.catchUp(session), late.catchUp(session)]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["complete", "complete"],
  );
  // One transaction ran first; the other re-read the row inside its own transaction and added nothing.
  assert.deepEqual(outcomes.map((outcome) => outcome.bytesRead === 0).toSorted(), [false, true]);
  assert.equal(ok(late.files()).length, 1);
  assert.deepEqual(
    ok(late.listItems(fileOf(late, session).fileId)).map((row) => row.line),
    [2],
  );
  early.close();
  late.close();
});
