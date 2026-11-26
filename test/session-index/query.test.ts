import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { must } from "../support/must.ts";
import { printableTrigrams } from "../../lib/session-index.ts";
import {
  assistantLine,
  entryLine,
  fileOf,
  headerLine,
  indexPath,
  ok,
  openIndex,
  tempDir,
  toolResultLine,
  userLine,
  writeSession,
} from "./support.ts";

/** specs/search-tool.md#evaluation and specs/search-tool.md#get: the reads the tool asks of the index. */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const path = tempDir("session-index-query-");
  roots.push(path);
  return path;
}

async function fixture(): Promise<{ index: ReturnType<typeof openIndex>; fileId: number }> {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(
    session,
    headerLine(),
    userLine("a1", "session-one", "hello world", "2026-01-01T00:00:00.000Z"),
    assistantLine(
      "a2",
      "a1",
      [
        { type: "text", text: "alpha text" },
        { type: "thinking", thinking: "beta thought" },
        { type: "toolCall", id: "c1", name: "Bash", arguments: { command: "echo hello" } },
      ],
      "2026-01-02T00:00:00.000Z",
    ),
    toolResultLine("a3", "a2", "Bash", "c1", "boom happened", true, "2026-01-03T00:00:00.000Z"),
    entryLine({
      type: "custom_message",
      id: "a4",
      parentId: "a3",
      timestamp: "2026-01-04T00:00:00.000Z",
      customType: "note",
      content: "injected text",
    }),
    entryLine({
      type: "compaction",
      id: "a5",
      parentId: "a4",
      timestamp: "2026-01-05T00:00:00.000Z",
      summary: "a summary",
    }),
    userLine("a6", "a1", "abandoned branch", "2026-01-06T00:00:00.000Z"),
  );
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  return { index, fileId: fileOf(index, session).fileId };
}

test("the items of a session are listed in file order, parts as numbers with error last", async () => {
  const { index, fileId } = await fixture();
  const rows = ok(index.listItems(fileId));
  assert.deepEqual(
    rows.map((row) => [row.line, row.part, row.kind]),
    [
      [2, "", "user"],
      [3, "0", "assistant"],
      [3, "1", "thinking"],
      [3, "2", "tool_call"],
      [4, "", "tool_result"],
      [5, "", "injected"],
      [6, "", "summary"],
      [7, "", "user"],
    ],
  );
  // The leaf of the file is a6, so the a2 to a5 chain is off the current lineage.
  assert.deepEqual(
    rows.map((row) => row.lineage),
    [true, false, false, false, false, false, false, true],
  );
  index.close();
});

test("the item filters narrow kinds, tool, error results, times, and lineage", async () => {
  const { index, fileId } = await fixture();
  const kinds = (filter: Parameters<typeof index.listItems>[1]) =>
    ok(index.listItems(fileId, filter)).map((row) => `${row.line}:${row.part}`);
  assert.deepEqual(kinds({ kinds: ["tool_call", "tool_result"] }), ["3:2", "4:"]);
  assert.deepEqual(kinds({ tool: "BASH" }), ["3:2", "4:"]);
  assert.deepEqual(kinds({ tool: "bash", isError: true }), ["4:"]);
  assert.deepEqual(kinds({ isError: false }), []);
  assert.deepEqual(kinds({ lineage: true }), ["2:", "7:"]);
  assert.deepEqual(kinds({ since: Date.parse("2026-01-04T00:00:00.000Z") }), ["5:", "6:", "7:"]);
  assert.deepEqual(kinds({ until: Date.parse("2026-01-03T00:00:00.000Z") }), [
    "2:",
    "3:0",
    "3:1",
    "3:2",
  ]);
  assert.deepEqual(kinds({ entryId: "a2", part: "1" }), ["3:1"]);
  assert.deepEqual(kinds({ limit: 2 }), ["2:", "3:0"]);
  assert.deepEqual(kinds({ kinds: ["user"], tool: "Bash" }), []);
  index.close();
});

test("an item is found by its entry ID and part, and the empty part is the item without one", async () => {
  const { index, fileId } = await fixture();
  assert.equal(ok(index.findItem(fileId, "a1", undefined))?.kind, "user");
  assert.equal(ok(index.findItem(fileId, "a1", ""))?.kind, "user");
  assert.equal(ok(index.findItem(fileId, "a2", "2"))?.kind, "tool_call");
  assert.equal(ok(index.findItem(fileId, "a2", "2"))?.tool, "bash");
  assert.deepEqual(ok(index.findItem(fileId, "a2", "3")), undefined);
  assert.deepEqual(ok(index.findItem(fileId, "nope", undefined)), undefined);
  index.close();
});

test("the paired item of a tool call or result is found by its tool-call ID in file order", async () => {
  const { index, fileId } = await fixture();
  assert.deepEqual(ok(index.pairedItem(fileId, "c1", "tool_result"))?.entryId, "a3");
  assert.deepEqual(ok(index.pairedItem(fileId, "c1", "tool_call"))?.entryId, "a2");
  assert.deepEqual(ok(index.pairedItem(fileId, "nope", "tool_result")), undefined);
  index.close();
});

test("the trigram narrowing matches every trigram and can be limited to files", async () => {
  const { index, fileId } = await fixture();
  const ids = (trigrams: string[], fileIds?: number[]) =>
    ok(index.matchingItemIds(trigrams, fileIds));
  const hello = must(ids(["hel"]));
  assert.equal(hello.size, 2);
  assert.equal(must(ids(["hel", "wor"])).size, 1);
  assert.equal(must(ids(["hel", "xyz"])).size, 0);
  assert.equal(must(ids(["hel", "ell"])).size, 2);
  assert.equal(ids([]), undefined);
  assert.equal(must(ids(["hel"], [fileId])).size, 2);
  assert.equal(must(ids(["hel"], [fileId + 1])).size, 0);
  assert.equal(must(ids(["hel"], [])).size, 0);
  // A trigram matches across the space of the item text.
  assert.equal(must(ids(["o w"])).size, 1);
  index.close();
});

test("the trigram narrowing of a large searched set finds the same rows as the small one", async () => {
  const root = dir();
  const index = openIndex(indexPath(root));
  const files: number[] = [];
  for (let count = 0; count < 40; count += 1) {
    const session = join(root, `s${count}.jsonl`);
    writeSession(
      session,
      headerLine(`session-${count}`),
      userLine("a1", `session-${count}`, `needle ${count % 3 === 0 ? "yes" : "no"} haystack`),
    );
    assert.equal((await index.catchUp(session)).status, "complete");
    files.push(fileOf(index, session).fileId);
  }
  const all = must(ok(index.matchingItemIds(["nee", "hay"], files)));
  assert.equal(all.size, 40);
  const one = must(ok(index.matchingItemIds(["nee", "hay"], [must(files[0])])));
  assert.equal(one.size, 1);
  const yes = must(ok(index.matchingItemIds(["nee", "yes"], files)));
  assert.equal(yes.size, 14);
  index.close();
});

/** A session file of `count` entries whose text carries `needle` for every even entry number. */
function needleSession(path: string, id: string, count: number): void {
  const lines = [headerLine(id)];
  for (let entry = 0; entry < count; entry += 1) {
    const text = entry % 2 === 0 ? `needle at ${entry}` : `haystack at ${entry}`;
    lines.push(userLine(`n${entry}`, entry === 0 ? id : `n${entry - 1}`, text));
  }
  writeSession(path, ...lines);
}

test("the trigram narrowing of more than 2000 searched items answers only the searched files", async () => {
  const root = dir();
  const index = openIndex(indexPath(root));
  const all: number[] = [];
  const half: number[] = [];
  // 24 files of 100 items are 2400 searched items, more than the narrowing probes one
  // by one (specs/search-tool.md#evaluation): one file is not searched.
  for (let count = 0; count < 24; count += 1) {
    const session = join(root, `s${count}.jsonl`);
    needleSession(session, `session-${count}`, 100);
    assert.equal((await index.catchUp(session)).status, "complete");
    const fileId = fileOf(index, session).fileId;
    if (count < 23) half.push(fileId);
    all.push(fileId);
  }
  const every = must(ok(index.matchingItemIds(["nee"], all)));
  assert.equal(every.size, 24 * 50);
  // The items of the file left out of the search match the trigram and are no answer.
  const searched = must(ok(index.matchingItemIds(["nee"], half)));
  assert.equal(searched.size, 23 * 50);
  assert.equal(every.size - searched.size, 50);
  const expected = new Set<number>();
  for (const fileId of half) {
    for (const row of ok(index.listItems(fileId))) {
      if (row.line % 2 === 0) expected.add(row.itemId);
    }
  }
  assert.deepEqual(searched, expected);
  index.close();
});

test("a page of more than 1000 items is matched by its own rows, whatever its items' IDs", async () => {
  const root = dir();
  const index = openIndex(indexPath(root));
  const session = join(root, "s.jsonl");
  needleSession(session, "session-one", 1200);
  assert.equal((await index.catchUp(session)).status, "complete");
  const fileId = fileOf(index, session).fileId;
  const rows = ok(index.listItems(fileId));
  assert.equal(rows.length, 1200);
  const probe = ok(index.probeRows(rows, ["nee"], fileId));
  assert.equal(probe.intact, true);
  // Every even entry yields the item that matches; the odd ones do not.
  const expected = new Set(rows.filter((row) => row.line % 2 === 0).map((row) => row.itemId));
  assert.equal(probe.matched.size, 600);
  assert.deepEqual(probe.matched, expected);
  index.close();
});

test("a trigram that carries a double quote matches its item rather than a query term", async () => {
  const root = dir();
  const index = openIndex(indexPath(root));
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", 'a "quoted" word and plain'));
  assert.equal((await index.catchUp(session)).status, "complete");
  const ids = (trigrams: string[]) => must(ok(index.matchingItemIds(trigrams)));
  assert.equal(ids(['a "']).size, 1);
  assert.equal(ids(['" w']).size, 1);
  assert.equal(ids(['"qu']).size, 1);
  assert.equal(ids(['"zz']).size, 0);
  // A quote is part of the matched text, not a boundary of the query.
  assert.equal(ids(["d a"]).size, 1);
  index.close();
});

test("the trigrams of a literal query are its runs of three printable characters", () => {
  assert.deepEqual(printableTrigrams("abcd"), ["abc", "bcd"]);
  assert.deepEqual(printableTrigrams("ab"), []);
  assert.deepEqual(printableTrigrams("ab\u00e9cd"), []);
  assert.deepEqual(printableTrigrams("a b\tcd"), ["a b"]);
});

test("the files of the index are listed in ascending path order", async () => {
  const root = dir();
  const index = openIndex(indexPath(root));
  const first = join(root, "a.jsonl");
  const second = join(root, "b.jsonl");
  writeSession(first, headerLine("session-a"));
  writeSession(second, headerLine("session-b"));
  assert.equal((await index.catchUp(second)).status, "complete");
  assert.equal((await index.catchUp(first)).status, "complete");
  const paths = ok(index.files()).map((row) => row.path);
  assert.deepEqual(paths, paths.toSorted());
  assert.equal(ok(index.fileFor(first))?.sessionId, "session-a");
  index.close();
});

test("a read reports its failure instead of an empty answer", async () => {
  const root = dir();
  const index = openIndex(indexPath(root));
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "hello"));
  assert.equal((await index.catchUp(session)).status, "complete");
  index.close();
  // The index is closed: every read says so, and none looks like an empty answer.
  assert.deepEqual(index.files(), { ok: false, reason: "the index is not open" });
  assert.deepEqual(index.listItems(1), { ok: false, reason: "the index is not open" });
  assert.deepEqual(index.matchingItemIds(["hel"]), {
    ok: false,
    reason: "the index is not open",
  });
  assert.deepEqual(index.fileFor(session), { ok: false, reason: "the index is not open" });
  assert.deepEqual(index.pairedItem(1, "c1", "tool_call"), {
    ok: false,
    reason: "the index is not open",
  });
});

test("items of a file keep the columns the tool's hit line needs", async () => {
  const { index, fileId } = await fixture();
  const call = must(ok(index.findItem(fileId, "a2", "2")));
  assert.deepEqual(
    [call.kind, call.tool, call.callId, call.isError, call.entryId, call.part],
    ["tool_call", "bash", "c1", false, "a2", "2"],
  );
  assert.equal(call.offset > 0, true);
  assert.equal(call.bytes > 0, true);
  index.close();
});
