import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentLineage,
  leafEntry,
  readSessionText,
  type LineageEntry,
  type SessionEntry,
} from "../../lib/session-transcript.ts";
import { entryLine, fileText, headerLine, messageLine } from "./support.ts";

/** specs/session-transcript.md#current-lineage: the leaf and the current lineage. */

function entry(entryId: string, parentId: string | null, line: number): SessionEntry {
  return {
    line,
    entryId,
    time: line,
    value: { type: "message", id: entryId, parentId },
    type: "message",
    parentId,
    offset: 0,
    bytes: 0,
  };
}

function ids(entries: SessionEntry[]): string[] {
  return currentLineage(entries).map((member) => member.entryId);
}

test("the leaf is the entry with the highest line number", () => {
  const entries = [entry("a", null, 1), entry("b", "a", 2), entry("c", "a", 3)];
  assert.equal(leafEntry(entries)?.entryId, "c");
  assert.equal(leafEntry([]), undefined);
  // The line number decides, not the position in the list.
  assert.equal(leafEntry([entry("c", "a", 3), entry("a", null, 1)])?.entryId, "c");
});

test("the current lineage runs from the leaf's first ancestor to the leaf", () => {
  const entries = [entry("a", null, 1), entry("b", "a", 2), entry("c", "b", 3)];
  assert.deepEqual(ids(entries), ["a", "b", "c"]);
});

test("a branch off the leaf's path is not on the current lineage", () => {
  const entries = [entry("a", null, 1), entry("b", "a", 2), entry("c", "a", 3), entry("d", "c", 4)];
  assert.deepEqual(ids(entries), ["a", "c", "d"]);
});

test("the lineage ends at an entry whose parentId is null, absent, or the ID of no entry", () => {
  assert.deepEqual(ids([entry("a", null, 1), entry("b", "a", 2)]), ["a", "b"]);
  assert.deepEqual(ids([entry("b", "zzz", 1)]), ["b"]);
  assert.deepEqual(ids([entry("b", null, 1), entry("c", "missing", 2)]), ["c"]);
});

test("the lineage ends at the ID of an entry already on the path", () => {
  // A cycle: b's parent is a, and a's parent is b.
  assert.deepEqual(ids([entry("a", "b", 1), entry("b", "a", 2)]), ["a", "b"]);
  // A longer cycle.
  assert.deepEqual(ids([entry("a", "c", 1), entry("b", "a", 2), entry("c", "b", 3)]), [
    "a",
    "b",
    "c",
  ]);
  // An entry that is its own parent.
  assert.deepEqual(ids([entry("a", "a", 1)]), ["a"]);
});

test("an entry a compaction summarized stays on the current lineage", () => {
  const read = readSessionText(
    fileText(
      headerLine(),
      messageLine("a1", "session-one", { role: "user", content: "before" }),
      messageLine("a2", "a1", { role: "assistant", content: [{ type: "text", text: "before" }] }),
      entryLine({ type: "compaction", id: "k1", parentId: "a2", summary: "summary" }),
      messageLine("a3", "k1", { role: "user", content: "after" }),
    ),
  );
  assert.deepEqual(
    currentLineage(read.entries).map((member) => member.entryId),
    ["a1", "a2", "k1", "a3"],
  );
});

test("an entry with an unusable or duplicate ID is no member of a lineage", () => {
  const read = readSessionText(
    fileText(
      headerLine(),
      messageLine("a1", null, { role: "user", content: "one" }),
      messageLine("a1", "a1", { role: "user", content: "duplicate" }),
      messageLine("a.b", "a1", { role: "user", content: "unusable" }),
    ),
  );
  assert.deepEqual(
    currentLineage(read.entries).map((member) => member.entryId),
    ["a1"],
  );
});

test("a session file with no entry has no leaf and an empty lineage", () => {
  const read = readSessionText(fileText(headerLine()));
  assert.equal(leafEntry(read.entries), undefined);
  assert.deepEqual(currentLineage(read.entries), []);
});

test("the leaf and the lineage are computed from the line, the ID, and the parent ID alone", () => {
  const minimal: LineageEntry[] = [
    { line: 1, entryId: "a", parentId: null },
    { line: 2, entryId: "b", parentId: "a" },
    { line: 3, entryId: "c", parentId: "b" },
  ];
  assert.equal(leafEntry(minimal)?.entryId, "c");
  assert.deepEqual(
    currentLineage(minimal).map((member) => member.entryId),
    ["a", "b", "c"],
  );
  // The caller's own shape comes back unchanged.
  const withExtra = [{ line: 1, entryId: "x", parentId: null, extra: 7 }];
  assert.equal(leafEntry(withExtra)?.extra, 7);
  assert.equal(currentLineage(withExtra)[0]?.extra, 7);
});
