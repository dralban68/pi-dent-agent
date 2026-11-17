import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  currentLineage,
  isSessionHeader,
  isUsableEntryId,
  leafEntry,
  parseSessionLine,
  readSessionBytes,
  readSessionFile,
  readSessionHeaderFile,
  readSessionLineAt,
  readSessionText,
  realPath,
  sessionItems,
} from "../../lib/session-transcript.ts";
import { at, must } from "../support/must.ts";
import {
  STAMP,
  entryLine,
  fileText,
  headerLine,
  messageLine,
  tempDir,
  userLine,
  writeSession,
} from "./support.ts";

/** specs/session-transcript.md Section 1: reading a session file into session entries. */

const LINE_BYTE_LIMIT = 16777216;

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const path = tempDir("session-transcript-read-");
  roots.push(path);
  return path;
}

test("the first line as a session header is read as the header and not as an entry", () => {
  const header = headerLine("session-one", "2026-01-01T00:00:00Z");
  const read = readSessionText(fileText(header, userLine("a1", "session-one", "hello")));
  assert.deepEqual(read.header?.sessionId, "session-one");
  assert.equal(read.header?.time, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(read.header?.bytes, Buffer.byteLength(header));
  assert.deepEqual(
    read.entries.map((entry) => entry.entryId),
    ["a1"],
  );
});

test("a file whose first line is not a session header has no header", () => {
  const read = readSessionText(fileText(userLine("a1", null, "hello")));
  assert.equal(read.header, undefined);
  // Section 1 makes only the header decide readability; the entries of the lines are still entries.
  assert.deepEqual(
    read.entries.map((entry) => entry.entryId),
    ["a1"],
  );
});

test("a session header needs type session and a string id", () => {
  assert.equal(isSessionHeader({ type: "session", id: "x" }), true);
  assert.equal(isSessionHeader({ type: "session", id: "" }), true);
  assert.equal(isSessionHeader({ type: "session", id: 5 }), false);
  assert.equal(isSessionHeader({ type: "message", id: "x" }), false);
  const notAHeader = readSessionText(fileText(entryLine({ type: "session", id: 5 })));
  assert.equal(notAHeader.header, undefined);
});

test("a header with an empty string id is still the session header", () => {
  const read = readSessionText(fileText(headerLine("")));
  assert.deepEqual(read.header?.sessionId, "");
});

test("empty, non-JSON, array, and non-object lines are skipped without failure", () => {
  const read = readSessionText(
    fileText(
      headerLine(),
      "",
      "not json",
      "[1,2]",
      "null",
      "42",
      '"text"',
      "true",
      userLine("a1", null, "kept"),
    ),
  );
  assert.deepEqual(
    read.entries.map((entry) => entry.entryId),
    ["a1"],
  );
  assert.equal(read.lines, 9);
  assert.equal(at(read.entries, 0).line, 9);
});

test("a last line no line feed terminates is not used", () => {
  const header = headerLine();
  const text = `${header}\n${userLine("a1", null, "unterminated")}`;
  const read = readSessionText(text);
  assert.equal(read.entries.length, 0);
  assert.equal(read.lines, 1);
  assert.equal(read.consumed, Buffer.byteLength(header) + 1);
});

test("an unterminated last line that is a partial JSON object is not parsed", () => {
  const text = `${headerLine()}\n{"type":"message","id":"a1"`;
  const read = readSessionText(text);
  assert.equal(read.entries.length, 0);
});

test("a line of exactly the byte limit is parsed and one byte more is not", () => {
  const head =
    '{"type":"custom","id":"pad-1","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","pad":"';
  const tail = '"}';
  const padded = (total: number) => head + "x".repeat(total - head.length - tail.length) + tail;
  const exact = padded(LINE_BYTE_LIMIT);
  const over = padded(LINE_BYTE_LIMIT + 1);
  assert.equal(Buffer.byteLength(exact), LINE_BYTE_LIMIT);
  assert.equal(Buffer.byteLength(over), LINE_BYTE_LIMIT + 1);
  assert.notEqual(parseSessionLine(exact), undefined);
  assert.equal(parseSessionLine(over), undefined);
  // Both lines are valid JSON, so the over-long one is absent because it is not parsed.
  assert.notEqual(JSON.parse(over), undefined);
  const kept = readSessionText(fileText(headerLine(), exact));
  assert.deepEqual(
    kept.entries.map((entry) => entry.entryId),
    ["pad-1"],
  );
  const skipped = readSessionText(fileText(headerLine(), over));
  assert.equal(skipped.entries.length, 0);
  assert.equal(skipped.lines, 2);
});

test("a usable entry ID is a non-empty string of A-Z, a-z, 0-9, _ and -", () => {
  assert.equal(isUsableEntryId("abc-DEF_123"), true);
  assert.equal(isUsableEntryId("0"), true);
  assert.equal(isUsableEntryId(""), false);
  assert.equal(isUsableEntryId("a.b"), false);
  assert.equal(isUsableEntryId("a b"), false);
  assert.equal(isUsableEntryId("ä"), false);
  assert.equal(isUsableEntryId("a/b"), false);
  assert.equal(isUsableEntryId("a:b"), false);
});

test("an entry whose ID is not usable is no entry, yields nothing, and is no lineage member", () => {
  const read = readSessionText(
    fileText(
      headerLine(),
      messageLine("a.b", null, { role: "user", content: "dot" }),
      messageLine("", null, { role: "user", content: "empty" }),
      messageLine("ok-1", null, { role: "user", content: "kept" }),
    ),
  );
  assert.deepEqual(
    read.entries.map((entry) => entry.entryId),
    ["ok-1"],
  );
});

test("an entry whose ID the header or a lower line carries yields nothing", () => {
  const read = readSessionText(
    fileText(
      headerLine("dup"),
      messageLine("x", null, { role: "user", content: "first" }),
      messageLine("x", "x", { role: "user", content: "second" }),
      messageLine("dup", null, { role: "user", content: "as the header" }),
    ),
  );
  assert.deepEqual(
    read.entries.map((entry) => [entry.entryId, entry.line]),
    [["x", 2]],
  );
  assert.equal(
    read.entries.some((entry) => entry.entryId === "dup"),
    false,
  );
});

test("a line's line number, byte offset and byte length are read", () => {
  const header = headerLine();
  const first = userLine("a1", "session-one", "héllo");
  const second = userLine("a2", "a1", "bye");
  const read = readSessionText(fileText(header, first, "", second));
  assert.equal(read.lines, 4);
  assert.equal(read.consumed, Buffer.byteLength(fileText(header, first, "", second)));
  assert.equal(at(read.entries, 0).line, 2);
  assert.equal(at(read.entries, 0).offset, Buffer.byteLength(header) + 1);
  assert.equal(at(read.entries, 0).bytes, Buffer.byteLength(first));
  assert.equal(at(read.entries, 1).line, 4);
  assert.equal(
    at(read.entries, 1).offset,
    Buffer.byteLength(header) + 1 + Buffer.byteLength(first) + 1 + 1,
  );
  assert.equal(at(read.entries, 1).bytes, Buffer.byteLength(second));
  assert.equal(read.tailOffset, at(read.entries, 1).offset);
  assert.equal(at(read.entries, 1).parentId, "a1");
});

test("a parentId that is not a string reads as null", () => {
  const read = readSessionText(
    fileText(headerLine(), entryLine({ type: "message", id: "a1", parentId: 7, message: {} })),
  );
  assert.equal(at(read.entries, 0).parentId, null);
});

test("the entry time falls back to the nearest earlier date-time, else the Unix epoch", () => {
  const read = readSessionText(
    fileText(
      headerLine("s1", "2026-01-01T00:00:00Z"),
      messageLine("a1", null, { role: "user", content: "x" }, "not a date-time"),
      messageLine("a2", "a1", { role: "user", content: "y" }, "2026-01-02T00:00:00Z"),
      entryLine({
        type: "message",
        id: "a3",
        parentId: "a2",
        message: { role: "user", content: "z" },
      }),
    ),
  );
  const first = Date.parse("2026-01-01T00:00:00Z");
  const second = Date.parse("2026-01-02T00:00:00Z");
  assert.equal(read.header?.time, first);
  assert.equal(at(read.entries, 0).time, first);
  assert.equal(at(read.entries, 1).time, second);
  assert.equal(at(read.entries, 2).time, second);
  assert.equal(read.lastTime, second);
});

test("with no date-time anywhere the time is the Unix epoch", () => {
  const read = readSessionText(
    fileText(
      entryLine({ type: "session", id: "s1", timestamp: "yesterday" }),
      messageLine("a1", null, { role: "user", content: "x" }, "later"),
    ),
  );
  assert.equal(read.header?.time, 0);
  assert.equal(at(read.entries, 0).time, 0);
  assert.equal(read.lastTime, 0);
});

test("a read with no lines has no entries, no header, and consumed at its start", () => {
  const read = readSessionText("");
  assert.equal(read.header, undefined);
  assert.deepEqual(read.entries, []);
  assert.equal(read.lines, 0);
  assert.equal(read.consumed, 0);
  assert.equal(read.tailOffset, 0);
  assert.equal(read.lastTime, undefined);
});

test("a read continues from the consumed offset with line numbers, times, and seen IDs", () => {
  const header = headerLine();
  const firstLine = userLine("a1", "session-one", "one");
  const restLines = [
    userLine("a2", "a1", "two", "not a date-time"),
    userLine("a1", "a2", "duplicate"),
    messageLine("session-one", "a2", { role: "user", content: "as the header" }),
    userLine("a3", "a2", "three"),
  ];
  const part1 = fileText(header, firstLine);
  const part2 = fileText(...restLines);
  const first = readSessionText(part1);
  const continuation = (seenIds: string[]) =>
    readSessionBytes(Buffer.from(part2, "utf8"), {
      from: first.consumed,
      line: 3,
      previousTime: first.lastTime,
      seenIds,
    });
  const entryIds = first.entries.map((entry) => entry.entryId);
  const rest = continuation([...entryIds, "session-one"]);
  assert.equal(rest.header, undefined);
  assert.deepEqual(
    rest.entries.map((entry) => [entry.entryId, entry.line]),
    [
      ["a2", 3],
      ["a3", 6],
    ],
  );
  // The header's ID counts as an entry with a lower line number, so a caller that leaves it out
  // of `seenIds` reads the line that carries it as an entry.
  assert.deepEqual(
    continuation(entryIds).entries.map((entry) => [entry.entryId, entry.line]),
    [
      ["a2", 3],
      ["session-one", 5],
      ["a3", 6],
    ],
  );
  assert.equal(rest.consumed, Buffer.byteLength(part1) + Buffer.byteLength(part2));
  // The first entry's timestamp is not a date-time, so its time is the earlier read's last time.
  assert.equal(at(rest.entries, 0).time, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(rest.lastTime, Date.parse("2026-01-01T00:00:00Z"));
});

test("a file read does not change the file", () => {
  const root = dir();
  const path = join(root, "s.jsonl");
  writeSession(path, headerLine(), userLine("a1", "session-one", "hi"));
  const before = readFileSync(path);
  utimesSync(path, new Date(1000000), new Date(1000000));
  const read = readSessionFile(path);
  assert.equal(read?.header?.sessionId, "session-one");
  assert.equal(statSync(path).mtimeMs, 1000000);
  assert.deepEqual(readFileSync(path), before);
});

test("a file that cannot be read has no read", () => {
  const root = dir();
  assert.equal(readSessionFile(join(root, "missing.jsonl")), undefined);
  assert.equal(readSessionFile(root), undefined);
  mkdirSync(join(root, "sub"));
  assert.equal(readSessionFile(join(root, "sub")), undefined);
});

test("a session header is read from a file's first line alone", () => {
  const root = dir();
  const path = join(root, "s.jsonl");
  writeSession(path, headerLine("s1", "2026-01-01T00:00:00Z"), userLine("a1", "s1", "hi"));
  const header = readSessionHeaderFile(path);
  assert.equal(header?.sessionId, "s1");
  assert.equal(header?.time, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(header?.bytes, Buffer.byteLength(headerLine("s1", "2026-01-01T00:00:00Z")));
});

test("a file whose first line is not a session header has no session header", () => {
  const root = dir();
  const notHeader = join(root, "a.jsonl");
  writeFileSync(notHeader, '{"not":"a header"}\n');
  assert.equal(readSessionHeaderFile(notHeader), undefined);
  const empty = join(root, "b.jsonl");
  writeFileSync(empty, "");
  assert.equal(readSessionHeaderFile(empty), undefined);
  const missing = join(root, "c.jsonl");
  assert.equal(readSessionHeaderFile(missing), undefined);
});

test("a first line no line feed terminates is not a session header", () => {
  const root = dir();
  const path = join(root, "s.jsonl");
  writeFileSync(path, headerLine("s1"));
  assert.equal(readSessionHeaderFile(path), undefined);
});

test("readSessionBytes reads the bytes it is given", () => {
  const text = fileText(headerLine(), userLine("a1", "session-one", "hi"));
  const read = readSessionBytes(new Uint8Array(Buffer.from(text, "utf8")));
  assert.equal(read.header?.sessionId, "session-one");
  assert.equal(read.entries.length, 1);
});

test("a file read from a byte offset keeps absolute positions and line numbers", () => {
  const root = dir();
  const path = join(root, "s.jsonl");
  writeSession(
    path,
    headerLine(),
    userLine("a1", "session-one", "one"),
    userLine("a2", "a1", "two"),
  );
  const size = statSync(path).size;
  const whole = must(readSessionFile(path));
  const first = at(whole.entries, 0);
  const read = must(readSessionFile(path, { from: first.offset, line: 2 }));
  assert.equal(read.header, undefined);
  assert.equal(read.consumed, size);
  assert.equal(read.lines, 2);
  assert.deepEqual(
    read.entries.map((entry) => [entry.entryId, entry.line, entry.offset, entry.bytes]),
    whole.entries.map((entry) => [entry.entryId, entry.line, entry.offset, entry.bytes]),
  );
  // The header is not read again as an entry at the first line of the read.
  assert.equal(
    read.entries.some((entry) => entry.entryId === "session-one"),
    false,
  );
});

test("a file read stops at the file position it is given", () => {
  const root = dir();
  const path = join(root, "s.jsonl");
  writeSession(
    path,
    headerLine(),
    userLine("a1", "session-one", "one"),
    userLine("a2", "a1", "two"),
  );
  const whole = must(readSessionFile(path));
  const first = at(whole.entries, 0);
  const second = at(whole.entries, 1);
  const afterFirst = first.offset + first.bytes + 1;
  const read = must(readSessionFile(path, { to: afterFirst }));
  assert.equal(read.consumed, afterFirst);
  assert.equal(read.lines, 2);
  assert.deepEqual(
    read.entries.map((entry) => entry.entryId),
    ["a1"],
  );
  // A bound inside a line leaves that line out, its line feed not reached.
  const cut = must(readSessionFile(path, { to: second.offset + 5 }));
  assert.equal(cut.consumed, afterFirst);
  assert.deepEqual(
    cut.entries.map((entry) => entry.entryId),
    ["a1"],
  );
  assert.equal(cut.tailOffset, first.offset);
});

test("a file read consumes at most the bytes it is given, or one longer line", () => {
  const root = dir();
  const path = join(root, "s.jsonl");
  writeSession(
    path,
    headerLine(),
    userLine("a1", "session-one", "one"),
    userLine("a2", "a1", "two"),
  );
  const whole = must(readSessionFile(path));
  const first = at(whole.entries, 0);
  const afterFirst = first.offset + first.bytes + 1;
  const bounded = must(readSessionFile(path, { maxBytes: afterFirst }));
  assert.equal(bounded.consumed, afterFirst);
  assert.equal(bounded.lines, 2);
  assert.deepEqual(
    bounded.entries.map((entry) => entry.entryId),
    ["a1"],
  );
  // A maximum shorter than the header consumes that line whole, and no other.
  const short = must(readSessionFile(path, { maxBytes: 1 }));
  assert.equal(short.consumed, first.offset);
  assert.equal(short.lines, 1);
  assert.deepEqual(short.entries, []);
  assert.equal(short.lastTime, whole.header?.time);
});

test("a read from a byte offset with a maximum ends on a whole line", () => {
  const root = dir();
  const path = join(root, "s.jsonl");
  writeSession(
    path,
    headerLine(),
    userLine("a1", "session-one", "one"),
    userLine("a2", "a1", "two"),
    userLine("a3", "a2", "three"),
  );
  const whole = must(readSessionFile(path));
  const first = at(whole.entries, 0);
  const second = at(whole.entries, 1);
  const endOfSecond = second.offset + second.bytes + 1;
  const read = must(
    readSessionFile(path, { from: first.offset, line: 2, maxBytes: endOfSecond - first.offset }),
  );
  // The line whose end is exactly the maximum is consumed; the next one is not.
  assert.equal(read.consumed, endOfSecond);
  assert.deepEqual(
    read.entries.map((entry) => [entry.entryId, entry.line]),
    [
      ["a1", 2],
      ["a2", 3],
    ],
  );
});

test("a line that starts with a byte-order mark is not JSON and is skipped", () => {
  const read = readSessionText(`\uFEFF${headerLine()}\n${userLine("a1", null, "x")}\n`);
  assert.equal(read.header, undefined);
  assert.deepEqual(
    read.entries.map((entry) => entry.entryId),
    ["a1"],
  );
  const middle = readSessionText(
    fileText(headerLine(), `\uFEFF${userLine("a2", null, "y")}`, userLine("a3", null, "z")),
  );
  assert.deepEqual(
    middle.entries.map((entry) => entry.entryId),
    ["a3"],
  );
});

test("a first line that starts with a byte-order mark is no session header", () => {
  const root = dir();
  const path = join(root, "s.jsonl");
  writeFileSync(path, `\uFEFF${headerLine()}\n`);
  assert.equal(readSessionHeaderFile(path), undefined);
});

test("a first line longer than the byte limit is no session header", () => {
  const head = '{"type":"session","id":"big","pad":"';
  const tail = '"}';
  const padded = (total: number) => head + "x".repeat(total - head.length - tail.length) + tail;
  const root = dir();
  const over = join(root, "over.jsonl");
  writeFileSync(over, `${padded(LINE_BYTE_LIMIT + 1)}\n`);
  assert.equal(Buffer.byteLength(padded(LINE_BYTE_LIMIT + 1)), LINE_BYTE_LIMIT + 1);
  assert.equal(readSessionHeaderFile(over), undefined);
  const exact = join(root, "exact.jsonl");
  writeFileSync(exact, `${padded(LINE_BYTE_LIMIT)}\n`);
  assert.equal(readSessionHeaderFile(exact)?.sessionId, "big");
});

test("a later line with type session is an entry of an unused type", () => {
  const read = readSessionText(
    fileText(
      headerLine("s1"),
      userLine("a1", "s1", "hello"),
      entryLine({ type: "session", id: "late", parentId: "a1", timestamp: STAMP }),
    ),
  );
  assert.equal(read.header?.sessionId, "s1");
  assert.deepEqual(
    read.entries.map((entry) => entry.entryId),
    ["a1", "late"],
  );
  assert.deepEqual(
    sessionItems(read.entries).map((item) => item.kind),
    ["user"],
  );
  assert.equal(leafEntry(read.entries)?.entryId, "late");
  assert.deepEqual(
    currentLineage(read.entries).map((entry) => entry.entryId),
    ["a1", "late"],
  );
});

test("an entry whose type is not a string is an entry of an unused type", () => {
  const read = readSessionText(
    fileText(
      headerLine(),
      entryLine({ type: 7, id: "odd", parentId: null, message: { role: "user", content: "x" } }),
    ),
  );
  assert.deepEqual(
    read.entries.map((entry) => [entry.entryId, entry.type]),
    [["odd", ""]],
  );
  assert.deepEqual(sessionItems(read.entries), []);
  assert.equal(leafEntry(read.entries)?.entryId, "odd");
});

test("one line is read back by byte offset and length", () => {
  const root = dir();
  const path = join(root, "s.jsonl");
  writeSession(path, headerLine(), userLine("a1", "session-one", "one"));
  const whole = must(readSessionFile(path));
  const entry = at(whole.entries, 0);
  assert.equal(readSessionLineAt(path, entry.offset, entry.bytes)?.id, "a1");
  assert.equal(readSessionLineAt(path, entry.offset, entry.bytes - 1), undefined);
  assert.equal(readSessionLineAt(path, entry.offset + 1, entry.bytes - 1), undefined);
  assert.equal(readSessionLineAt(path, 0, 0), undefined);
  assert.equal(readSessionLineAt(join(root, "missing.jsonl"), 0, 10), undefined);
});

test("a session file path is resolved through symbolic links", () => {
  const root = dir();
  const target = join(root, "target.jsonl");
  writeSession(target, headerLine());
  const link = join(root, "link.jsonl");
  symlinkSync(target, link);
  assert.equal(realPath(link), realPath(target));
  assert.notEqual(realPath(link), link);
  const missing = join(root, "missing.jsonl");
  assert.equal(realPath(missing), missing);
});
