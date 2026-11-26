import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  assistantLine,
  cleanupRoots,
  fixture,
  harness,
  headerLine,
  instant,
  setMtime,
  toolCall,
  toolResultLine,
  userLine,
  writeSession,
  type Fixture,
} from "./support.ts";
import type { SearchHost } from "../../lib/search-tool.ts";

/**
 * specs/search-tool.md Section 4: `get` with paging, `context`, the call–result
 * link, an address that does not resolve, and the same answer from a direct read.
 */

after(cleanupRoots);

interface Addressed extends Fixture {
  host: SearchHost;
}

/** A session with a paired call and result, an unpaired call, and an off-lineage item. */
function addressed(prefix = "search-tool-get-"): Addressed {
  const made = fixture(prefix);
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    userLine("u1", null, "first message", 1),
    assistantLine("a1", "u1", [toolCall("c1", "Bash", { command: "ls" })], 2),
    toolResultLine("r1", "a1", "Bash", "c1", "the result text", false, 3),
    userLine("b1", "a1", "off branch", 4),
    userLine("u2", "r1", "second message", 5),
    assistantLine("a2", "u2", [toolCall("c9", "Read", { path: "x" })], 6),
  );
  return {
    ...made,
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
  };
}

test("get returns the hit line, the paired address, the text, and the end marker", async () => {
  const made = addressed();
  const h = harness({ db: made.db });
  const outcome = await h.call(made.host, { action: "get", address: "self:r1" });
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.lines, [
    "self:r1 \u00b7 2026-01-01T00:00:03+00:00 \u00b7 tool_result Bash \u00b7 15 chars",
    "call: self:a1.0",
    "--- text 0..15 of 15 ---",
    "the result text",
    "--- end of text ---",
  ]);
  assert.deepEqual(outcome.details, {
    action: "get",
    address: "self:r1",
    session: "self",
    kind: "tool_result",
    label: "Bash",
    isError: false,
    offLineage: false,
    time: Date.UTC(2026, 0, 1, 0, 0, 3),
    length: 15,
    offset: 0,
    end: 15,
    paired: "self:a1.0",
    before: [],
    after: [],
  });
  // A tool_call names its result, and an unpaired one says so.
  const call = await h.call(made.host, { action: "get", address: "self:a1.0" });
  assert.equal(call.lines[1], "result: self:r1");
  const unpaired = await h.call(made.host, { action: "get", address: "self:a2.0" });
  assert.equal(unpaired.lines[1], "result: (none)");
  assert.equal(unpaired.details.paired, undefined);
  // A user item has no call line and no pair.
  const user = await h.call(made.host, { action: "get", address: "self:u1" });
  assert.equal(
    user.lines.some((line) => line.startsWith("result:")),
    false,
  );
  assert.equal(
    user.lines.some((line) => line.startsWith("call:")),
    false,
  );
  assert.equal(user.details.paired, undefined);
});

test("get pages the text with offset and limit", async () => {
  const made = addressed();
  const h = harness({ db: made.db });
  const outcome = await h.call(made.host, {
    action: "get",
    address: "self:r1",
    offset: 4,
    limit: 6,
  });
  assert.deepEqual(outcome.lines, [
    "self:r1 \u00b7 2026-01-01T00:00:03+00:00 \u00b7 tool_result Bash \u00b7 15 chars",
    "call: self:a1.0",
    "--- text 4..10 of 15 ---",
    "result",
    "--- cut: continue with offset 10 ---",
  ]);
  assert.equal(outcome.details.offset, 4);
  assert.equal(outcome.details.end, 10);
  // A limit past the end stops at the end.
  const whole = await h.call(made.host, {
    action: "get",
    address: "self:r1",
    offset: 4,
    limit: 50000,
  });
  assert.equal(whole.details.end, 15);
  assert.equal(whole.lines.includes("the result text".slice(4)), true, whole.text);
  assert.equal(whole.lines.at(-1), "--- end of text ---");
});

test("context lists the neighbours in file order, off-lineage ones included", async () => {
  const made = addressed();
  const h = harness({ db: made.db });
  const outcome = await h.call(made.host, { action: "get", address: "self:r1", context: 1 });
  const before = outcome.lines.indexOf("Before:");
  const afterIndex = outcome.lines.indexOf("After:");
  assert.equal(before > 0, true, outcome.text);
  assert.equal(afterIndex > before, true, outcome.text);
  assert.equal(
    outcome.lines[before + 1],
    "self:a1.0 \u00b7 2026-01-01T00:00:02+00:00 \u00b7 tool_call Bash \u00b7 11 chars \u00b7 command: ls",
  );
  // The item directly after r1 in file order is the off-lineage branch entry.
  assert.equal(
    outcome.lines[afterIndex + 1],
    "self:b1 \u00b7 2026-01-01T00:00:04+00:00 \u00b7 user off-lineage \u00b7 10 chars \u00b7 off branch",
  );
  const details = outcome.details.before;
  assert.ok(Array.isArray(details));
  assert.deepEqual(details, [
    {
      address: "self:a1.0",
      session: "self",
      kind: "tool_call",
      label: "Bash",
      offLineage: false,
      time: Date.UTC(2026, 0, 1, 0, 0, 2),
      length: 11,
      snippet: "command: ls",
    },
  ]);
  const afterDetails = outcome.details.after;
  assert.ok(Array.isArray(afterDetails));
  assert.equal((afterDetails[0] as { offLineage: boolean }).offLineage, true);
  // Two neighbours on each side, in file order.
  const wide = await h.call(made.host, { action: "get", address: "self:r1", context: 2 });
  const wideBefore = wide.lines.indexOf("Before:");
  const addressOfLine = (line: string | undefined): string =>
    (line ?? "").slice(0, (line ?? "").indexOf(" \u00b7 "));
  assert.deepEqual(
    [addressOfLine(wide.lines[wideBefore + 1]), addressOfLine(wide.lines[wideBefore + 2])],
    ["self:u1", "self:a1.0"],
  );
});

test("Search's own items are neighbours like any other", async () => {
  const made = fixture("search-tool-get-own-");
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    userLine("u1", null, "ask", 1),
    assistantLine("a1", "u1", [toolCall("c1", "Search", { query: "x" })], 2),
    toolResultLine("r1", "a1", "Search", "c1", "1 hits", false, 3),
  );
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const h = harness({ db: made.db });
  const outcome = await h.call(host, { action: "get", address: "self:r1", context: 1 });
  const before = outcome.lines.indexOf("Before:");
  assert.equal(
    outcome.lines[before + 1],
    "self:a1.0 \u00b7 2026-01-01T00:00:02+00:00 \u00b7 tool_call Search \u00b7 8 chars \u00b7 query: x",
  );
  assert.equal(outcome.lines[1], "call: self:a1.0");
});

test("an address that does not resolve is a tool error", async () => {
  const made = addressed();
  const h = harness({ db: made.db });
  assert.equal(
    (await h.call(made.host, { action: "get", address: "self:nope" })).text,
    "no item self:nope",
  );
  assert.equal(
    (await h.call(made.host, { action: "get", address: "self:a1.9" })).text,
    "no item self:a1.9",
  );
  // An off-lineage item is still fetched.
  const off = await h.call(made.host, { action: "get", address: "self:b1" });
  assert.equal(off.isError, false);
  assert.equal(off.details.offLineage, true);
  assert.equal(
    off.lines[0],
    "self:b1 \u00b7 2026-01-01T00:00:04+00:00 \u00b7 user off-lineage \u00b7 10 chars",
  );
});

test("get answers the same from the index and from a direct read", async () => {
  const made = addressed();
  const fromIndex = await harness({ db: made.db }).call(made.host, {
    action: "get",
    address: "self:r1",
    context: 2,
    offset: 2,
    limit: 5,
  });
  const unusableDb = made.db.replace("search-v3.sqlite", "unusable.sqlite");
  const handle = new DatabaseSync(unusableDb);
  handle.exec("PRAGMA user_version = 9;");
  handle.close();
  const fromFiles = await harness({ db: unusableDb }).call(made.host, {
    action: "get",
    address: "self:r1",
    context: 2,
    offset: 2,
    limit: 5,
  });
  assert.deepEqual(fromFiles.lines, fromIndex.lines);
  assert.deepEqual(fromFiles.details, fromIndex.details);
});

test("a stale row makes get answer from a direct read", async () => {
  const made = addressed();
  const seed = await harness({ db: made.db }).call(made.host, { action: "find" });
  assert.equal(seed.isError, false);
  // Rewrite the file with two entries swapped: the index row of `r1` now names a
  // line that carries another entry, so reading it back finds a stale row, while
  // a direct read still finds `r1` (at another line). The last line is unchanged,
  // so the catch-up does not reset the file.
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    userLine("u1", null, "first message", 1),
    assistantLine("a1", "u1", [toolCall("c1", "Bash", { command: "ls" })], 2),
    userLine("b1", "a1", "off branch", 4),
    toolResultLine("r1", "a1", "Bash", "c1", "the result text", false, 3),
    userLine("u2", "r1", "second message", 5),
    assistantLine("a2", "u2", [toolCall("c9", "Read", { path: "x" })], 6),
  );
  const outcome = await harness({ db: made.db }).call(made.host, {
    action: "get",
    address: "self:r1",
  });
  assert.equal(outcome.isError, false, outcome.text);
  assert.equal(
    outcome.lines[0],
    "self:r1 \u00b7 2026-01-01T00:00:03+00:00 \u00b7 tool_result Bash \u00b7 15 chars",
  );
  assert.equal(outcome.lines[3], "the result text");
  // The reset left no rows for the file; the next call indexes it again.
  const files = new DatabaseSync(made.db).prepare("SELECT count(*) AS n FROM files").get();
  assert.equal(typeof files === "object" && files !== null && "n" in files ? files.n : -1, 0);
});

/** The `file_id` of the fixture's session file in the index. */
function fileIdOf(db: string, name = "m1.jsonl"): number {
  const handle = new DatabaseSync(db);
  try {
    const row = handle.prepare("SELECT file_id FROM files WHERE path LIKE ?").get(`%/${name}`);
    return typeof row === "object" &&
      row !== null &&
      "file_id" in row &&
      typeof row.file_id === "number"
      ? row.file_id
      : -1;
  } finally {
    handle.close();
  }
}

/** The same call on an index that cannot be used, so that a direct read answers it. */
async function directRead(
  made: Addressed,
  params: Record<string, unknown>,
): Promise<{ lines: string[]; details: Record<string, unknown>; text: string }> {
  const unavailable = made.db.replace("search-v3.sqlite", "unavailable.sqlite");
  const handle = new DatabaseSync(unavailable);
  handle.exec("PRAGMA user_version = 9;");
  handle.close();
  return harness({ db: unavailable }).call(made.host, params);
}

test("a reset below the call's own catch-up answers from a direct read", async () => {
  const made = addressed();
  const warm = await harness({ db: made.db }).call(made.host, { action: "find" });
  assert.equal(warm.isError, false, warm.text);
  const h = harness({ db: made.db });
  let reset = false;
  h.hook((event) => {
    if (reset || event.phase !== "cover" || event.key !== "self") return;
    reset = true;
    // Another process resets the file and catches it up to its first tool result only:
    // `consumed` is now smaller than the reader's own catch-up of the file left, and the
    // later rows are gone (session-index.md Section 4).
    const fileId = fileIdOf(made.db);
    const db = new DatabaseSync(made.db);
    try {
      const cut = db
        .prepare(
          "SELECT e.offset + e.bytes + 1 AS end, e.line AS line FROM entries e WHERE e.file_id = ? AND e.entry_id = 'r1'",
        )
        .get(fileId);
      assert.ok(typeof cut === "object" && cut !== null, "the addressed entry is indexed");
      const end = "end" in cut && typeof cut.end === "number" ? cut.end : -1;
      const line = "line" in cut && typeof cut.line === "number" ? cut.line : -1;
      db.prepare("DELETE FROM items WHERE file_id = ? AND line > ?").run(fileId, line);
      db.prepare("DELETE FROM entries WHERE file_id = ? AND line > ?").run(fileId, line);
      db.prepare("UPDATE files SET consumed = ? WHERE file_id = ?").run(end, fileId);
    } finally {
      db.close();
    }
  });
  const outcome = await h.call(made.host, { action: "get", address: "self:r1", context: 2 });
  assert.equal(reset, true, "the call never covered the addressed session");
  assert.equal(outcome.isError, false, outcome.text);
  const direct = await directRead(made, { action: "get", address: "self:r1", context: 2 });
  assert.deepEqual(outcome.lines, direct.lines);
  assert.deepEqual(outcome.details, direct.details);
});

test("rows another process renumbers between the addressed item's reads answer from a direct read", async () => {
  const made = addressed();
  const warm = await harness({ db: made.db }).call(made.host, {
    action: "get",
    address: "self:u1",
  });
  assert.equal(warm.isError, false, warm.text);
  const h = harness({ db: made.db });
  let changed = false;
  h.hook((event) => {
    if (event.phase !== "read" || changed) return;
    changed = true;
    // Another process resets the file and catches it up again between two reads of
    // the call: the items it lists next carry new `item_id`s (session-index.md
    // Section 4), so the neighbours and the pair of the addressed item are the
    // file's, not the rows the call started with.
    const db = new DatabaseSync(made.db);
    db.prepare("UPDATE items SET item_id = item_id + 1000 WHERE file_id = ?").run(
      fileIdOf(made.db),
    );
    db.close();
  });
  const outcome = await h.call(made.host, { action: "get", address: "self:a1.0", context: 1 });
  assert.equal(changed, true, "the call never read the index back");
  assert.equal(outcome.isError, false, outcome.text);
  assert.equal(outcome.text.includes("result: self:r1"), true, outcome.text);
  const direct = await directRead(made, { action: "get", address: "self:a1.0", context: 1 });
  assert.deepEqual(outcome.lines, direct.lines);
  assert.deepEqual(outcome.details, direct.details);
});

test("a lineage column that reaches past the call-start size is recomputed within it", async () => {
  const made = addressed();
  const warm = await harness({ db: made.db }).call(made.host, {
    action: "get",
    address: "self:u1",
  });
  assert.equal(warm.isError, false, warm.text);
  const h = harness({ db: made.db });
  let changed = false;
  h.hook((event) => {
    if (event.phase !== "read" || changed) return;
    changed = true;
    // Another connection appends an entry that branches the lineage and catches the
    // file up: the row's `consumed` now reaches past the call-start size, so its
    // `lineage` column describes bytes the call must not use (Section 2.2).
    const fileId = fileIdOf(made.db);
    const db = new DatabaseSync(made.db);
    db.prepare("UPDATE files SET consumed = consumed + 1 WHERE file_id = ?").run(fileId);
    db.prepare(
      "UPDATE entries SET lineage = 0 WHERE file_id = ? AND entry_id IN ('r1', 'u2', 'a2')",
    ).run(fileId);
    db.close();
  });
  const outcome = await h.call(made.host, { action: "get", address: "self:a2.0", context: 1 });
  assert.equal(changed, true, "the call never read the index back");
  assert.equal(outcome.isError, false, outcome.text);
  // The neighbour `u2` is on the lineage of the entries terminated when the call
  // started, which the column that reaches past that size no longer describes.
  assert.equal(
    outcome.lines.some((line) => line.includes(" off-lineage")),
    false,
    outcome.text,
  );
  const direct = await directRead(made, { action: "get", address: "self:a2.0", context: 1 });
  assert.deepEqual(outcome.lines, direct.lines);
  assert.deepEqual(outcome.details, direct.details);
});

test("a session that is not a session file on the direct read is rejected as unknown", async () => {
  const made = addressed();
  // The index answers this session, so the call starts from its rows.
  setMtime(made.mainFile, instant(60));
  const warm = await harness({ db: made.db }).call(made.host, { action: "find" });
  assert.equal(warm.isError, false, warm.text);
  // The file is rewritten in place, its size and modification time unchanged: the
  // index still holds its rows, and the addressed row is stale when read back.
  const before = readFileSync(made.mainFile, "utf8");
  const rewritten = before
    .replace('"type":"session"', '"type":"sessiox"')
    .replace('"id":"u1"', '"id":"z1"');
  assert.equal(rewritten.length, before.length);
  writeFileSync(made.mainFile, rewritten);
  setMtime(made.mainFile, instant(60));
  const outcome = await harness({ db: made.db }).call(made.host, {
    action: "get",
    address: "self:u1",
  });
  // The file is not a session of the call, so its key names no session (Section 2.2).
  assert.equal(outcome.isError, true, outcome.text);
  assert.equal(outcome.text, 'unknown session "self"');
});
