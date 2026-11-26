import assert from "node:assert/strict";
import { after, test } from "node:test";
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  cleanupRoots,
  compactionLine,
  fixture,
  harness,
  headerLine,
  hitAddresses,
  hitLines,
  setMtime,
  stamp,
  testClock,
  userLine,
  writeSession,
  type Fixture,
} from "./support.ts";
import { openSessionIndex } from "../../lib/session-index.ts";
import type { SearchHost } from "../../lib/search-tool.ts";

/**
 * specs/search-tool.md#coverage and specs/search-tool.md#result: covering, its exceptions, the
 * continuation, and every result line a call can report.
 */

after(cleanupRoots);

/** A main session with three items. */
function main(prefix = "search-tool-coverage-"): Fixture & { host: SearchHost } {
  const made = fixture(prefix);
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    userLine("u1", null, "alpha one", 1),
    userLine("u2", "u1", "alpha two", 2),
    userLine("u3", "u2", "alpha three", 3),
  );
  return {
    ...made,
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
  };
}

/** Index one session file into a fresh index, as an earlier call would have. */
async function seed(db: string, path: string): Promise<void> {
  const opened = openSessionIndex({ path: db });
  if (!opened.ok) throw new Error(opened.reason);
  await opened.index.catchUp(path);
  opened.index.close();
}

/** A file at `db` whose `user_version` makes the index unusable (specs/session-index.md#failures). */
function makeUnusable(db: string, version = 7): void {
  const handle = new DatabaseSync(db);
  handle.exec(`PRAGMA user_version = ${version};`);
  handle.close();
}

/** The `files` rows of the index file. */
function fileRowCount(db: string): number {
  const handle = new DatabaseSync(db);
  try {
    const row = handle.prepare("SELECT count(*) AS n FROM files").get();
    return typeof row === "object" && row !== null && "n" in row && typeof row.n === "number"
      ? row.n
      : -1;
  } finally {
    handle.close();
  }
}

test("a call whose sessions are all covered reports no uncovered session", async () => {
  const made = main();
  const h = harness({ db: made.db });
  const outcome = await h.call(made.host, { action: "find", query: "alpha" });
  assert.deepEqual(hitAddresses(outcome), ["self:u3", "self:u2", "self:u1"]);
  assert.equal(outcome.details.uncovered, 0);
  assert.equal(outcome.details.sessions, 1);
  assert.equal(outcome.details.indexError, undefined);
  assert.equal(
    outcome.lines.some((line) => line.includes("were not searched")),
    false,
  );
  assert.equal(
    outcome.lines.some((line) => line.includes("are not indexed yet")),
    false,
  );
  // The index is the one the call wrote: one files row.
  assert.equal(fileRowCount(made.db), 1);
});

test("the covering deadline leaves sessions uncovered, and the continuation completes them", async () => {
  const made = main();
  writeSession(
    made.agentDir + "/kid-task1.jsonl",
    headerLine("kid-session-id-0002"),
    userLine("k1", null, "alpha kid", 4),
  );
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  h.hook((event) => {
    // The first session is covered; the 3000 ms covering deadline has passed.
    if (event.phase === "cover" && event.covered === true) clock.set(clock.now() + 3100);
  });
  const host = { ...made.host };
  const partial = await h.call(host, { action: "find", query: "alpha", scope: "tree" });
  assert.equal(partial.details.uncovered, 1);
  assert.equal(partial.details.sessions, 2);
  assert.equal(
    partial.lines.at(-1),
    "1 of 2 sessions are not indexed yet and were not searched; indexing continues in the background. Repeat the call later, without after, to include them.",
  );
  assert.equal(partial.details.stopped, false);
  await h.runtime.backgroundDone();
  // The continuation indexed the uncovered session: the repeated call returns everything.
  h.hook(undefined);
  clock.advance(10_000);
  const repeated = await h.call(host, { action: "find", query: "alpha", scope: "tree" });
  assert.deepEqual(hitAddresses(repeated), ["kid-task1:k1", "self:u3", "self:u2", "self:u1"]);
  assert.equal(repeated.details.uncovered, 0);
});

test("a failed write of a read-only index is reported, and every session is read directly", async () => {
  const made = main();
  const opened = openSessionIndex({ path: made.db });
  if (!opened.ok) throw new Error(opened.reason);
  opened.index.close();
  chmodSync(made.db, 0o444);
  try {
    const h = harness({ db: made.db });
    const outcome = await h.call(made.host, { action: "find", query: "alpha" });
    assert.deepEqual(hitAddresses(outcome), ["self:u3", "self:u2", "self:u1"]);
    assert.equal(outcome.details.indexError, "attempt to write a readonly database");
    assert.equal(outcome.details.uncovered, 0);
    assert.equal(
      outcome.lines.some((line) => line.includes("cannot be written")),
      false,
    );
  } finally {
    chmodSync(made.db, 0o644);
  }
});

test("a failed write with an uncovered session reports the index cannot be written", async () => {
  const made = main();
  await seed(made.db, made.mainFile);
  // Rewrite one entry's ID in place, keeping every byte count, and keep the mtime:
  // the catch-up finds nothing to do, and reading the item back finds a stale row.
  const before = readFileSync(made.mainFile, "utf8");
  writeFileSync(made.mainFile, before.split('"id":"u1"').join('"id":"z1"'));
  const row = new DatabaseSync(made.db).prepare("SELECT mtime FROM files").get();
  const mtime =
    typeof row === "object" && row !== null && "mtime" in row && typeof row.mtime === "number"
      ? row.mtime
      : 0;
  setMtime(made.mainFile, mtime);
  chmodSync(made.db, 0o444);
  try {
    const h = harness({ db: made.db });
    const outcome = await h.call(made.host, { action: "find", query: "alpha" });
    assert.equal(outcome.details.uncovered, 1);
    assert.equal(outcome.details.indexError, "attempt to write a readonly database");
    assert.equal(
      outcome.lines.at(-1),
      "1 of 1 sessions were not searched: the search index cannot be written (attempt to write a readonly database). Narrow the scope.",
    );
    // The hits before the stale row are shown, and none after it.
    assert.deepEqual(hitAddresses(outcome), ["self:u3", "self:u2"]);
  } finally {
    chmodSync(made.db, 0o644);
  }
});

test("an unusable index answers from the session files, with the same hits", async () => {
  const made = main();
  const working = await harness({ db: made.db }).call(made.host, {
    action: "find",
    query: "alpha",
  });
  const unusableDb = made.db.replace("search-v3.sqlite", "unusable.sqlite");
  makeUnusable(unusableDb);
  const h = harness({ db: unusableDb });
  const outcome = await h.call(made.host, { action: "find", query: "alpha" });
  assert.deepEqual(hitAddresses(outcome), hitAddresses(working));
  assert.deepEqual(hitLines(outcome), hitLines(working));
  assert.equal(outcome.details.indexError, "unsupported index version 7");
  assert.equal(outcome.details.uncovered, 0);
  // A second query too: the index changes how fast a call answers and nothing else.
  const regexWorking = await harness({ db: made.db }).call(made.host, {
    action: "find",
    query: "alpha t\\w+",
    regex: true,
  });
  const regexUnusable = await harness({ db: unusableDb }).call(made.host, {
    action: "find",
    query: "alpha t\\w+",
    regex: true,
  });
  assert.deepEqual(hitAddresses(regexUnusable), hitAddresses(regexWorking));
  assert.deepEqual(hitLines(regexUnusable), hitLines(regexWorking));
});

test("an unusable index and an uncovered session report the index is unavailable", async () => {
  const made = main();
  writeSession(
    made.agentDir + "/kid-task1.jsonl",
    headerLine("kid-session-id-0002"),
    userLine("k1", null, "alpha kid", 4),
  );
  makeUnusable(made.db);
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  h.hook((event) => {
    // The budget is gone before the second session's direct read.
    if (event.phase === "cover" && event.covered === true) clock.set(clock.now() + 6000);
  });
  const outcome = await h.call({ ...made.host }, { action: "find", query: "alpha", scope: "tree" });
  assert.equal(outcome.details.stopped, true);
  assert.equal(outcome.details.uncovered, 1);
  assert.equal(
    outcome.lines.at(-1),
    "1 of 2 sessions were not searched: the search index is unavailable (unsupported index version 7). Narrow the scope.",
  );
});

test("a stale row found mid-call drops its session, and the file is reset", async () => {
  const made = main();
  await seed(made.db, made.mainFile);
  // Rename the root entry in place, keeping every byte count and the mtime: the
  // catch-up finds nothing to do, and reading the item back finds a stale row.
  const before = readFileSync(made.mainFile, "utf8");
  writeFileSync(made.mainFile, before.split('"id":"u1"').join('"id":"z1"'));
  const row = new DatabaseSync(made.db).prepare("SELECT mtime FROM files").get();
  const mtime =
    typeof row === "object" && row !== null && "mtime" in row && typeof row.mtime === "number"
      ? row.mtime
      : 0;
  setMtime(made.mainFile, mtime);
  const h = harness({ db: made.db });
  const outcome = await h.call(made.host, { action: "find", query: "alpha" });
  // Newest first: u3 and u2 are decided before the stale row of u1 is read.
  assert.deepEqual(hitAddresses(outcome), ["self:u3", "self:u2"]);
  assert.equal(outcome.details.uncovered, 1);
  assert.equal(
    outcome.lines.at(-1),
    "1 of 1 sessions are not indexed yet and were not searched; indexing continues in the background. Repeat the call later, without after, to include them.",
  );
  // The continuation re-indexed the reset file.
  await h.runtime.backgroundDone();
  assert.equal(fileRowCount(made.db), 1);
  const again = await harness({ db: made.db }).call(made.host, { action: "find", query: "alpha" });
  assert.deepEqual(hitAddresses(again), ["self:u3", "self:u2"]);
});

test("a call stopped by its budget names the last decided item, and every hit up to there is shown", async () => {
  const made = main();
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  let decided = 0;
  h.hook((event) => {
    if (event.phase !== "decide") return;
    decided += 1;
    if (decided === 2) clock.set(clock.now() + 6000);
  });
  const outcome = await h.call(made.host, { action: "find", query: "alpha" });
  assert.equal(outcome.details.stopped, true);
  assert.equal(outcome.details.more, false);
  // The window's items were all decided before the budget expired, so every hit of
  // them is shown and the stop item is the last of them (specs/search-tool.md#evaluation).
  assert.equal(outcome.details.next, "self:u1");
  assert.deepEqual(hitAddresses(outcome), ["self:u3", "self:u2", "self:u1"]);
  assert.equal(
    outcome.lines.at(-1),
    'Search stopped after 5000 ms at self:u1: every hit of the searched sessions up to there is shown. Continue with after: "self:u1"',
  );
  // Continuing from an earlier item of the run returns the rest.
  h.hook(undefined);
  clock.advance(10_000);
  const rest = await h.call(made.host, {
    action: "find",
    query: "alpha",
    after: "self:u2",
  });
  assert.deepEqual(hitAddresses(rest), ["self:u1"]);
  assert.equal(rest.details.stopped, false);
});

test("a call stopped before any item was examined has no stop item", async () => {
  const made = main();
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  h.hook((event) => {
    if (event.phase === "cover") clock.set(clock.now() + 6000);
  });
  const outcome = await h.call(made.host, { action: "find", query: "alpha" });
  assert.equal(outcome.details.stopped, true);
  assert.equal(outcome.details.next, undefined);
  assert.deepEqual(hitAddresses(outcome), []);
  assert.equal(
    outcome.lines.at(-1),
    "Search stopped after 5000 ms before any item was examined. Repeat the call.",
  );
});

test("a window the budget ends keeps the items its evaluation decided", async () => {
  // An item's evaluation limit is wall time; the call's clock runs three times as fast once
  // the evaluation has started, so the 5000 ms budget ends about 1700 ms in: after the
  // limit ended the first slow item, while the second is still being evaluated.
  const made = fixture("search-tool-limit-window-");
  const lines = [headerLine("main-session-0001"), userLine("u0", null, "aaaa", 1)];
  let parent: string | null = "u0";
  for (let index = 1; index <= 8; index += 1) {
    const id = `e${index}`;
    lines.push(userLine(id, parent, `${"a".repeat(64)}!`, index + 1));
    parent = id;
  }
  writeSession(made.mainFile, ...lines);
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  let base = 0;
  let from: number | undefined;
  const h = harness({
    db: made.db,
    clock: {
      now: () => (from === undefined ? base : base + (Date.now() - from) * 3),
      set: (value) => {
        base = value;
      },
      advance: (value) => {
        base += value;
      },
    },
  });
  h.hook((event) => {
    if (event.phase === "evaluate" && from === undefined) from = Date.now();
  });
  const outcome = await h.call(host, {
    action: "find",
    query: "(a+)+$",
    regex: true,
    order: "oldest",
  });
  await h.runtime.backgroundDone();
  const text = outcome.text;
  const shown = outcome.lines;
  const details = outcome.details;
  const unmatched = typeof details.unmatched === "number" ? details.unmatched : -1;
  const next = details.next;
  assert.equal(details.stopped, true, text);
  // The hit ahead of the slow items is decided, and it is shown.
  assert.equal(shown[0], "1 hits, oldest first", text);
  assert.equal(shown[1]?.startsWith("self:u0 "), true, text);
  // The items the evaluation limit ended are counted, and the last of them is the
  // stop item: the run of decided items reaches past those the budget outlasted.
  assert.equal(unmatched >= 1, true, `${unmatched} items were passed over: ${text}`);
  assert.equal(
    typeof next === "string" && /^self:e[1-8]$/.test(next),
    true,
    `the stop item is ${String(next)}`,
  );
  assert.deepEqual(shown, [
    "1 hits, oldest first",
    shown[1],
    `${unmatched} items were not matched: the pattern ran over 1000 ms on each. Simplify the pattern.`,
    `Search stopped after 5000 ms at ${String(next)}: every hit of the searched sessions up to there is shown. Continue with after: "${String(next)}"`,
  ]);
});

test("a stopped call without the index says a session is too large to read", async () => {
  const made = main();
  makeUnusable(made.db);
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  h.hook((event) => {
    if (event.phase === "cover") clock.set(clock.now() + 6000);
  });
  const outcome = await h.call(made.host, { action: "find", query: "alpha" });
  assert.equal(outcome.details.stopped, true);
  assert.deepEqual(hitAddresses(outcome), []);
  assert.equal(
    outcome.lines.at(-1),
    "Search stopped after 5000 ms before any item was examined: a session is too large to read without the search index.",
  );
});

test("a stop with no stop item while a session other than after is uncovered", async () => {
  const made = main();
  writeSession(
    made.agentDir + "/kid-task1.jsonl",
    headerLine("kid-session-id-0002"),
    userLine("k1", null, "alpha kid", 4),
  );
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  h.hook((event) => {
    // The after session (`kid-task1`) is covered first; the budget is then gone
    // before the invoking session is covered, so that one is uncovered.
    if (event.phase === "cover" && event.covered === true) clock.set(clock.now() + 6000);
  });
  const outcome = await h.call(
    { ...made.host },
    { action: "find", query: "alpha", scope: "tree", after: "kid-task1:k1" },
  );
  assert.equal(outcome.details.stopped, true);
  assert.equal(outcome.details.next, undefined);
  assert.equal(outcome.details.uncovered, 1, outcome.text);
  assert.deepEqual(hitAddresses(outcome), []);
  // The after session is covered, so the call is not in the after-session state: the
  // generic stop line and the uncovered-sessions line are both present (specs/search-tool.md#result).
  assert.deepEqual(outcome.lines, [
    "(no hits)",
    "Search stopped after 5000 ms before any item was examined. Repeat the call.",
    "1 of 2 sessions are not indexed yet and were not searched; indexing continues in the background. Repeat the call later, without after, to include them.",
  ]);
});

test("a session without a session file has no items, and is not uncovered", async () => {
  const made = fixture("search-tool-no-file-");
  writeSession(
    made.agentDir + "/kid-task1.jsonl",
    headerLine("kid-session-id-0002"),
    userLine("k1", null, "alpha kid", 1),
  );
  const host = { sessionFile: undefined, agentDirectory: made.agentDir, main: true };
  const h = harness({ db: made.db });
  const self = await h.call(host, { action: "find", query: "alpha" });
  assert.deepEqual(self.lines, ["(no hits)"]);
  assert.equal(self.details.uncovered, 0);
  assert.equal(self.details.sessions, 1);
  // Its session tree still reaches the child session.
  const tree = await h.call(host, { action: "find", query: "alpha", scope: "tree" });
  assert.deepEqual(hitAddresses(tree), ["kid-task1:k1"]);
  // An address of the session without items resolves to no item.
  assert.equal((await h.call(host, { action: "get", address: "self:u1" })).text, "no item self:u1");
});

test("the hit line carries the address, time, kind, label, flags, length, position, and snippet", async () => {
  const made = fixture("search-tool-hit-line-");
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    userLine("u1", null, "one\n\n  alpha\ttext  with   spaces  ", 1),
    compactionLine("s1", "u1", "alpha summary", 2),
    userLine("u2", "s1", "alpha " + "z".repeat(400), 3),
  );
  const host = { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true };
  const h = harness({ db: made.db });
  const outcome = await h.call(host, { action: "find", query: "alpha", order: "oldest" });
  assert.equal(
    outcome.lines[1],
    "self:u1 \u00b7 2026-01-01T00:00:01+00:00 \u00b7 user \u00b7 34 chars @7 \u00b7 one alpha text with spaces",
  );
  assert.equal(
    outcome.lines[2],
    "self:s1 \u00b7 2026-01-01T00:00:02+00:00 \u00b7 summary \u00b7 13 chars @0 \u00b7 alpha summary",
  );
  // A long text is cut to 160 characters from 40 before the match, with ellipses.
  const long = outcome.lines[3] ?? "";
  assert.equal(
    long.startsWith(
      "self:u2 \u00b7 2026-01-01T00:00:03+00:00 \u00b7 user \u00b7 406 chars @0 \u00b7 alpha zzz",
    ),
    true,
    long,
  );
  assert.equal(long.endsWith("\u2026"), true, long);
  // The snippet of an empty item is `(empty)`; an item of length 0 is only a tool result.
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    `{"type":"message","id":"r1","parentId":null,"timestamp":"${stamp(1)}","message":{"role":"toolResult","toolName":"Bash","toolCallId":"c1","isError":false,"content":[]}}`,
  );
  const empty = await harness({ db: made.db }).call(host, { action: "find" });
  assert.equal(
    empty.lines[1],
    "self:r1 \u00b7 2026-01-01T00:00:01+00:00 \u00b7 tool_result Bash \u00b7 0 chars \u00b7 (empty)",
  );
});

// ---------------------------------------------------------------------------
// Covering under a changing index, and the stop lines it leads to
// ---------------------------------------------------------------------------

/** A project: the invoking session and one project member, both with items. */
function pair(prefix: string): {
  mainFile: string;
  main: string;
  other: string;
  agentDir: string;
  db: string;
  host: SearchHost;
} {
  const made = fixture(prefix);
  writeSession(
    made.mainFile,
    headerLine("main-session-0001"),
    userLine("a", null, "needle a", 1),
    userLine("b", "a", "filler b", 2),
  );
  const other = join(made.sessions, "m2.jsonl");
  writeSession(other, headerLine("other-session-0002"), userLine("v1", null, "needle other", 3));
  return {
    mainFile: made.mainFile,
    main: made.mainFile,
    other,
    agentDir: made.agentDir,
    db: made.db,
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
  };
}

test("a direct read still running at 3000 ms is abandoned: the covering deadline bounds it", async () => {
  const made = pair("search-tool-cover-deadline-");
  // A large second session, so that its direct read would outlast the covering deadline.
  const lines: string[] = [headerLine("other-session-0002")];
  let parent: string | null = null;
  for (let index = 0; index < 40000; index += 1) {
    lines.push(userLine(`x${index}`, parent, `filler ${index} ${"z".repeat(200)}`, 10 + index));
    parent = `x${index}`;
  }
  writeSession(made.other, ...lines);
  const unusable = made.db.replace("search-v3.sqlite", "unusable.sqlite");
  makeUnusable(unusable);
  const clock = testClock();
  let reads = 0;
  const h = harness({ db: unusable, clock });
  h.hook((event) => {
    if (event.phase !== "read") return;
    reads += 1;
    // The invoking session has been read; the covering deadline has passed.
    if (reads === 1) clock.set(clock.now() + 3200);
  });
  const outcome = await h.call(made.host, { action: "find", query: "needle", scope: "project" });
  assert.deepEqual(hitAddresses(outcome), ["self:a"]);
  assert.equal(outcome.details.uncovered, 1);
  assert.equal(outcome.details.sessions, 2);
  assert.equal(
    outcome.lines.at(-1),
    "1 of 2 sessions were not searched: the search index is unavailable (unsupported index version 7). Narrow the scope.",
  );
});

test("an entry appended after the call started is not used, and the lineage is the call-start one", async () => {
  const made = fixture("search-tool-lineage-");
  writeSession(
    made.mainFile,
    headerLine("main-session-0001"),
    userLine("a", null, "alpha a", 1),
    userLine("b1", "a", "alpha b1", 2),
    userLine("b2", "b1", "alpha b2", 3),
    userLine("b3", "b2", "alpha b3", 4),
  );
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  let appended = false;
  h.hook((event) => {
    if (event.phase !== "cover" || appended) return;
    appended = true;
    // A branch entry between the call's start and the catch-up: it moves b1..b3 off
    // the lineage the column records, and it is past the call-start size.
    appendFileSync(made.mainFile, `${userLine("b9", "a", "alpha branch", 9)}\n`);
  });
  const outcome = await h.call(host, { action: "find", query: "alpha" });
  assert.deepEqual(hitAddresses(outcome), ["self:b3", "self:b2", "self:b1", "self:a"]);
  assert.equal(outcome.details.uncovered, 0);
});

test("a session whose files row is reset mid-call loses its cover", async () => {
  const made = pair("search-tool-snapshot-");
  const opened = openSessionIndex({ path: made.db });
  if (!opened.ok) throw new Error(opened.reason);
  await opened.index.catchUp(made.mainFile);
  opened.index.close();
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  let reset = false;
  h.hook((event) => {
    if (event.phase !== "cover" || reset) return;
    reset = true;
    const other = new DatabaseSync(made.db);
    try {
      other.exec("PRAGMA busy_timeout = 1000;");
      other.exec("BEGIN IMMEDIATE");
      const statement = other.prepare("SELECT file_id FROM files");
      const row = statement.get();
      const fileId =
        typeof row === "object" &&
        row !== null &&
        "file_id" in row &&
        typeof row.file_id === "number"
          ? row.file_id
          : 0;
      const remove = (sql: string) => {
        const prepared = other.prepare(sql);
        prepared.setReadBigInts(true);
        prepared.run(fileId);
      };
      remove("DELETE FROM item_text WHERE rowid IN (SELECT item_id FROM items WHERE file_id = ?)");
      remove("DELETE FROM items WHERE file_id = ?");
      remove("DELETE FROM entries WHERE file_id = ?");
      remove("DELETE FROM files WHERE file_id = ?");
      other.exec("COMMIT");
    } finally {
      other.close();
    }
  });
  const outcome = await h.call(made.host, { action: "find", query: "needle" });
  assert.deepEqual(hitAddresses(outcome), []);
  assert.equal(outcome.details.uncovered, 1);
  assert.equal(
    outcome.lines.at(-1),
    "1 of 1 sessions are not indexed yet and were not searched; indexing continues in the background. Repeat the call later, without after, to include them.",
  );
});

test("the after session that loses its cover mid-call is covered again by a direct read", async () => {
  const made = fixture("search-tool-after-recover-");
  writeSession(
    made.mainFile,
    headerLine("main-session-0001"),
    userLine("a", null, "alpha a", 1),
    userLine("b", "a", "alpha b", 2),
    userLine("c", "b", "alpha c", 3),
    userLine("d", "c", "alpha d", 4),
  );
  const opened = openSessionIndex({ path: made.db });
  if (!opened.ok) throw new Error(opened.reason);
  await opened.index.catchUp(made.mainFile);
  opened.index.close();
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  let reset = false;
  h.hook((event) => {
    if (event.phase !== "cover" || reset) return;
    reset = true;
    const other = new DatabaseSync(made.db);
    try {
      other.exec("PRAGMA busy_timeout = 1000;");
      other.exec("BEGIN IMMEDIATE");
      const row = other.prepare("SELECT file_id FROM files").get();
      const fileId =
        typeof row === "object" &&
        row !== null &&
        "file_id" in row &&
        typeof row.file_id === "number"
          ? row.file_id
          : 0;
      const remove = (sql: string) => {
        const prepared = other.prepare(sql);
        prepared.setReadBigInts(true);
        prepared.run(fileId);
      };
      remove("DELETE FROM item_text WHERE rowid IN (SELECT item_id FROM items WHERE file_id = ?)");
      remove("DELETE FROM items WHERE file_id = ?");
      remove("DELETE FROM entries WHERE file_id = ?");
      remove("DELETE FROM files WHERE file_id = ?");
      other.exec("COMMIT");
    } finally {
      other.close();
    }
  });
  const outcome = await h.call(host, {
    action: "find",
    query: "alpha",
    order: "oldest",
    after: "self:a",
  });
  assert.equal(outcome.isError, false, outcome.text);
  assert.equal(outcome.lines.length > 0, true);
  assert.deepEqual(hitAddresses(outcome), ["self:b", "self:c", "self:d"]);
});

test("a file that is not a session file on a direct read is not a session of the call", async () => {
  const made = pair("search-tool-lost-");
  const unusable = made.db.replace("search-v3.sqlite", "unusable.sqlite");
  makeUnusable(unusable);
  // The second session's file stops being a session file before the call reads it: it
  // is neither covered nor uncovered and counts in neither <n> nor <k>.
  const clock = testClock();
  const first = harness({ db: unusable, clock });
  let broken = false;
  first.hook((event) => {
    if (event.phase !== "cover" || broken) return;
    broken = true;
    writeFileSync(made.other, `${JSON.stringify({ hello: "world" })}\n`);
  });
  const outcome = await first.call(made.host, {
    action: "find",
    query: "needle",
    scope: "project",
  });
  assert.equal(outcome.details.sessions, 1);
  assert.equal(outcome.details.uncovered, 0);
  assert.deepEqual(hitAddresses(outcome), ["self:a"]);
  // An address of a session so lost is rejected with the resolution error, and an
  // `after` with the error of specs/search-tool.md#result.
  const addressed = pair("search-tool-lost-get-");
  const addressedDb = addressed.db.replace("search-v3.sqlite", "unusable.sqlite");
  makeUnusable(addressedDb);
  const second = harness({ db: addressedDb, clock: testClock() });
  second.hook((event) => {
    if (event.phase !== "start") return;
    writeFileSync(addressed.mainFile, `${JSON.stringify({ hello: "world" })}\n`);
  });
  const fetched = await second.call(addressed.host, { action: "get", address: "self:a" });
  assert.equal(fetched.text, 'unknown session "self"');
  const continued = await second.call(addressed.host, {
    action: "find",
    query: "needle",
    after: "self:a",
  });
  assert.equal(continued.text, "no item self:a in the searched sessions");
});

test("an uncovered after session has its own stopped line, without the uncovered line", async () => {
  const made = pair("search-tool-after-state-");
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  h.hook((event) => {
    // The budget is gone before the after session's catch-up: it cannot be covered,
    // and its direct read (the exception) is bounded by the budget alone.
    if (event.phase === "start") clock.set(clock.now() + 6000);
  });
  const outcome = await h.call(made.host, {
    action: "find",
    query: "needle",
    scope: "project",
    after: "self:a",
  });
  assert.equal(outcome.details.stopped, true, outcome.text);
  // Both sessions are uncovered, and the after-session state suppresses the uncovered line.
  assert.equal(outcome.details.uncovered, 2, outcome.text);
  assert.deepEqual(outcome.lines, [
    "(no hits)",
    "Search stopped after 5000 ms: the session of after is not indexed yet. Repeat the call later.",
  ]);
});

test("an uncovered after session with an unusable index reports the index, not the after state", async () => {
  const made = pair("search-tool-after-unusable-");
  const unusable = made.db.replace("search-v3.sqlite", "unusable.sqlite");
  makeUnusable(unusable);
  const clock = testClock();
  const h = harness({ db: unusable, clock });
  h.hook((event) => {
    // The budget is gone before any session is covered, the after session included.
    if (event.phase === "start") clock.set(clock.now() + 6000);
  });
  const outcome = await h.call(made.host, {
    action: "find",
    query: "needle",
    scope: "project",
    after: "self:a",
  });
  assert.equal(outcome.details.stopped, true, outcome.text);
  assert.equal(outcome.details.uncovered, 2, outcome.text);
  assert.equal(outcome.details.indexError, "unsupported index version 7", outcome.text);
  // The after-session state needs a usable index, so the call reports the index and
  // the sessions it could not search (specs/search-tool.md#result).
  assert.deepEqual(outcome.lines, [
    "(no hits)",
    "Search stopped after 5000 ms before any item was examined: a session is too large to read without the search index.",
    "2 of 2 sessions were not searched: the search index is unavailable (unsupported index version 7). Narrow the scope.",
  ]);
});
