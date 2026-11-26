import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSessionIndex, type SessionIndex } from "../../lib/session-index.ts";
import {
  appendLine,
  entryLine,
  fileOf,
  headerLine,
  indexPath,
  messageLine,
  ok,
  openIndex,
  rawIndex,
  setMtime,
  STAMP,
  tempDir,
  userLine,
  writeSession,
} from "./support.ts";

/** specs/session-index.md#schema: `session_name` and `first_user_message`, kept by catch-up (specs/session-index.md#catch-up), and the session titles read (specs/session-index.md#session-titles). */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const path = tempDir("session-index-titles-");
  roots.push(path);
  return path;
}

function infoLine(id: string, name: unknown): string {
  return entryLine({ type: "session_info", id, parentId: null, timestamp: STAMP, name });
}

/** An entry of no transcript kind, so that a large fixture costs no item text. */
function bulkLine(id: string, size: number): string {
  return entryLine({
    type: "other",
    id,
    parentId: null,
    timestamp: STAMP,
    payload: "x".repeat(size),
  });
}

function titlesOf(
  index: SessionIndex,
  session: string,
): { name: string | null; first: string | null } {
  const file = fileOf(index, session);
  return { name: file.sessionName, first: file.firstUserMessage };
}

test("the last session_info entry names the session, across appends and past 64 KB", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), infoLine("i1", "  first name  "), bulkLine("b1", 100_000));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.equal(fileOf(index, session).sessionName, "first name");
  appendLine(session, infoLine("i2", "second name"));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.equal(fileOf(index, session).sessionName, "second name");
  // An entry whose id repeats an earlier one, or is absent, still names the session.
  appendLine(session, infoLine("i1", "third name"));
  appendLine(session, entryLine({ type: "session_info", name: "fourth name" }));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.equal(fileOf(index, session).sessionName, "fourth name");
  index.close();
});

test("the last session_info entry wins across the transactions of one catch-up", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  const lines = [infoLine("i1", "early"), userLine("u1", null, "first question")];
  for (let count = 0; count < 900; count += 1) lines.push(bulkLine(`b${count}`, 10000));
  lines.push(infoLine("i2", "late"), userLine("u2", null, "later question"));
  writeSession(session, headerLine(), ...lines);
  const index = openIndex(indexPath(root));
  let calls = 0;
  const start = Date.now();
  const stopped = await index.catchUp(session, {
    deadline: start + 1000,
    // The first two checks run before the first transaction; the third one stops the loop.
    now: () => ((calls += 1) <= 2 ? start : start + 5000),
  });
  assert.equal(stopped.status, "incomplete");
  assert.deepEqual(titlesOf(index, session), { name: "early", first: "first question" });
  const complete = await index.catchUp(session);
  assert.equal(complete.status, "complete");
  assert.equal(complete.transactions >= 1, true);
  assert.deepEqual(titlesOf(index, session), { name: "late", first: "first question" });
  index.close();
});

test("a session_info entry with an empty, white-space, absent or non-string name clears the name", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), infoLine("i1", "named"));
  const index = openIndex(indexPath(root));
  for (const [id, name] of [
    ["c1", ""],
    ["c2", " \t\u00a0 "],
    ["c3", undefined],
    ["c4", 42],
  ] as const) {
    appendLine(session, infoLine("n" + id, "named again"));
    assert.equal((await index.catchUp(session)).status, "complete");
    assert.equal(fileOf(index, session).sessionName, "named again");
    appendLine(session, infoLine(id, name));
    assert.equal((await index.catchUp(session)).status, "complete");
    assert.equal(fileOf(index, session).sessionName, null, `name ${JSON.stringify(name)}`);
  }
  index.close();
});

test("the first user line is the first non-blank line of the text parts, trimmed and cut at 80 code points", async () => {
  const root = dir();
  const index = openIndex(indexPath(root));
  const cases: { content: unknown; expected: string | null }[] = [
    { content: "\n   \n  hello world  \nsecond line", expected: "hello world" },
    // 100 emoji are 200 UTF-16 code units; the cut keeps 80 code points whole.
    { content: [{ type: "text", text: "😀".repeat(100) }], expected: "😀".repeat(80) },
    { content: [{ type: "text", text: `${"é".repeat(79)}日本` }], expected: `${"é".repeat(79)}日` },
    {
      content: [
        { type: "image", mimeType: "image/png", data: "AAAA" },
        { type: "text", text: "\n" },
        { type: "other", text: "not a text part" },
        { type: "text", text: "  title  " },
      ],
      expected: "title",
    },
    { content: [{ type: "image", mimeType: "image/png", data: "AAAA" }], expected: null },
    { content: { text: "not an array" }, expected: null },
  ];
  for (const [position, { content, expected }] of cases.entries()) {
    const session = join(root, `s${position}.jsonl`);
    writeSession(
      session,
      headerLine(),
      messageLine("a1", null, { role: "assistant", content: [{ type: "text", text: "hi" }] }),
      messageLine("u1", null, { role: "user", content }),
    );
    assert.equal((await index.catchUp(session)).status, "complete");
    assert.equal(fileOf(index, session).firstUserMessage, expected, `case ${position}`);
  }
  index.close();
});

test("a later user message never changes the first user line, and fills it while there is none", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(
    session,
    headerLine(),
    messageLine("u0", null, { role: "user", content: [{ type: "image", mimeType: "image/png" }] }),
  );
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.equal(fileOf(index, session).firstUserMessage, null);
  appendLine(session, userLine("u1", "u0", "the question"));
  appendLine(session, userLine("u2", "u1", "another question"));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.equal(fileOf(index, session).firstUserMessage, "the question");
  appendLine(session, userLine("u3", "u2", "a third question"));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.equal(fileOf(index, session).firstUserMessage, "the question");
  index.close();
});

test("a reset rebuilds both columns from the start of the file", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("u1", null, "old question"), infoLine("i1", "old"));
  setMtime(session, Date.parse("2026-01-02T00:00:00.000Z"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.deepEqual(titlesOf(index, session), { name: "old", first: "old question" });
  writeSession(session, headerLine(), userLine("u9", null, "new"));
  setMtime(session, Date.parse("2026-01-03T00:00:00.000Z"));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.deepEqual(titlesOf(index, session), { name: null, first: "new" });
  index.close();
});

test("titles are keyed by the paths as given, once each, with completeness, and never catch up", async () => {
  const root = dir();
  const done = join(root, "done.jsonl");
  const behind = join(root, "behind.jsonl");
  const unindexed = join(root, "unindexed.jsonl");
  const link = join(root, "link.jsonl");
  writeSession(
    done,
    headerLine("one"),
    userLine("u1", null, "done question"),
    infoLine("i1", "Done"),
  );
  writeSession(behind, headerLine("two"), userLine("u1", null, "behind question"));
  writeSession(unindexed, headerLine("three"), userLine("u1", null, "unindexed"));
  symlinkSync(done, link);
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(done)).status, "complete");
  assert.equal((await index.catchUp(behind)).status, "complete");
  appendLine(behind, infoLine("i2", "not yet indexed"));
  const missing = join(root, "missing.jsonl");
  const titles = ok(index.titles([link, missing, behind, done, unindexed, link]));
  assert.deepEqual(
    [...titles.entries()],
    [
      [link, { sessionName: "Done", firstUserMessage: "done question", complete: true }],
      [behind, { sessionName: null, firstUserMessage: "behind question", complete: false }],
      [done, { sessionName: "Done", firstUserMessage: "done question", complete: true }],
    ],
  );
  // A changed modification time alone makes the row incomplete.
  setMtime(done, Date.parse("2026-02-01T00:00:00.000Z"));
  assert.equal(ok(index.titles([done])).get(done)?.complete, false);
  assert.deepEqual(ok(index.titles([])), new Map());
  assert.equal(ok(index.files()).length, 2);
  index.close();
});

test("a file indexed and then removed has no complete title", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("u1", null, "question"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  rmSync(session);
  // A path that no longer resolves has no key; the row stays until the next prune.
  assert.deepEqual(ok(index.titles([session])), new Map());
  assert.equal(ok(index.files()).length, 1);
  index.close();
});

test("a failure of the index is returned by titles, not thrown", () => {
  const root = dir();
  const path = indexPath(root);
  const db = rawIndex(path);
  db.exec("CREATE TABLE other (a INTEGER); PRAGMA user_version = 3;");
  db.close();
  const session = join(root, "s.jsonl");
  writeFileSync(session, `${headerLine()}\n`);
  const opened = openSessionIndex({ path });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.deepEqual(opened.index.titles([session]), { ok: false, reason: "no such table: files" });
  opened.index.close();
});
