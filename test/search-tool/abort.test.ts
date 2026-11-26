import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  cleanupRoots,
  fixture,
  harness,
  headerLine,
  testClock,
  userLine,
  writeSession,
} from "./support.ts";
import type { SearchHost } from "../../lib/search-tool.ts";

/**
 * specs/search-tool.md#abort: an aborted call ends within 1000 ms as the
 * tool error `Search aborted`, including while one regular expression is being
 * evaluated on one item, and it starts no continuation of catch-up.
 */

after(cleanupRoots);

interface Session {
  db: string;
  host: SearchHost;
  file: string;
}

/** A main session with three items. */
function session(prefix = "search-tool-abort-"): Session {
  const made = fixture(prefix);
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    userLine("u1", null, "alpha one", 1),
    userLine("u2", "u1", "alpha two", 2),
    userLine("u3", "u2", "alpha three", 3),
  );
  return {
    db: made.db,
    file: made.mainFile,
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
  };
}

test("a signal that aborted before the call ends every action at once", async () => {
  const made = session();
  const h = harness({ db: made.db });
  const controller = new AbortController();
  controller.abort();
  for (const params of [
    { action: "find", query: "alpha" },
    { action: "get", address: "self:u1" },
    { action: "sessions" },
  ]) {
    const outcome = await h.call(made.host, params, controller.signal);
    assert.equal(outcome.isError, true, JSON.stringify(params));
    assert.equal(outcome.text, "Search aborted");
    assert.equal(outcome.elapsed < 1000, true);
  }
});

test("an abort during the evaluation of a find returns the abort error", async () => {
  const made = session();
  const h = harness({ db: made.db });
  const controller = new AbortController();
  h.hook((event) => {
    if (event.phase === "decide") controller.abort();
  });
  const outcome = await h.call(made.host, { action: "find", query: "alpha" }, controller.signal);
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "Search aborted");
  assert.equal(outcome.elapsed < 1000, true);
});

test("an abort stops a regular expression that backtracks without end", async () => {
  const made = session();
  // A pattern that cannot finish on this text: `(a+)+$` over a long run of `a`.
  writeSession(
    made.file,
    headerLine("main-session-id-0001"),
    userLine("u1", null, `${"a".repeat(64)}!`, 1),
  );
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  const controller = new AbortController();
  h.hook((event) => {
    if (event.phase !== "evaluate") return;
    // The evaluation has started and does not return: abort from outside it.
    setTimeout(() => controller.abort(), 5);
  });
  const outcome = await h.call(
    made.host,
    { action: "find", query: "(a+)+$", regex: true },
    controller.signal,
  );
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "Search aborted");
  assert.equal(outcome.elapsed < 1000, true, `took ${outcome.elapsed} ms`);
});

test("the end of the budget stops a regular expression that backtracks without end", async () => {
  const made = session();
  writeSession(
    made.file,
    headerLine("main-session-id-0001"),
    userLine("u1", null, `${"a".repeat(64)}!`, 1),
  );
  // Virtual time runs 50 ms per real millisecond once the evaluation has started,
  // so the 5000 ms budget ends while the worker is inside the pattern.
  let base = 0;
  let from: number | undefined;
  const h = harness({
    db: made.db,
    clock: {
      now: () => (from === undefined ? base : base + Math.round((Date.now() - from) * 50)),
      set: (value) => {
        base = value;
      },
      advance: (value) => {
        base += value;
      },
    },
  });
  h.hook((event) => {
    if (event.phase !== "evaluate") return;
    from = Date.now();
  });
  const outcome = await h.call(made.host, { action: "find", query: "(a+)+$", regex: true });
  assert.equal(outcome.isError, false, outcome.text);
  assert.equal(outcome.details.stopped, true);
  assert.deepEqual(outcome.lines, [
    "(no hits)",
    "Search stopped after 5000 ms before any item was examined. Repeat the call.",
  ]);
  assert.equal(outcome.elapsed < 1000, true, `took ${outcome.elapsed} ms`);
});

test("an abort during a sessions call ends it while its previews are read", async () => {
  const made = session();
  const h = harness({ db: made.db });
  const controller = new AbortController();
  h.hook((event) => {
    if (event.phase === "read") controller.abort();
  });
  const outcome = await h.call(made.host, { action: "sessions" }, controller.signal);
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "Search aborted");
  assert.equal(outcome.elapsed < 1000, true);
});

test("an abort during a get answered by a direct read ends it", async () => {
  const made = session();
  const unusable = made.db.replace("search-v3.sqlite", "unusable.sqlite");
  const handle = new DatabaseSync(unusable);
  handle.exec("PRAGMA user_version = 9;");
  handle.close();
  const h = harness({ db: unusable });
  const controller = new AbortController();
  h.hook((event) => {
    if (event.phase === "read") controller.abort();
  });
  const outcome = await h.call(made.host, { action: "get", address: "self:u1" }, controller.signal);
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, "Search aborted");
  assert.equal(outcome.elapsed < 1000, true);
});

test("an aborted call starts no continuation of catch-up", async () => {
  const made = session();
  writeSession(
    made.file.replace("m1.jsonl", "m1.agents/kid-task1.jsonl"),
    headerLine("kid-session-id-0002"),
    userLine("k1", null, "alpha kid", 4),
  );
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  const controller = new AbortController();
  h.hook((event) => {
    // Covering ends at its deadline with the child session uncovered; the abort
    // then ends the call before any evaluation.
    if (event.phase === "cover" && event.covered === true) {
      clock.set(clock.now() + 3100);
      controller.abort();
    }
  });
  const outcome = await h.call(
    made.host,
    { action: "find", query: "alpha", scope: "tree" },
    controller.signal,
  );
  assert.equal(outcome.text, "Search aborted");
  await h.runtime.backgroundDone();
  const handle = new DatabaseSync(made.db);
  try {
    const row = handle.prepare("SELECT count(*) AS n FROM files").get();
    const rows =
      typeof row === "object" && row !== null && "n" in row && typeof row.n === "number"
        ? row.n
        : -1;
    assert.equal(rows, 1, "only the covered session was indexed");
  } finally {
    handle.close();
  }
});
