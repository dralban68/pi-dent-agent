import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import {
  cleanupRoots,
  fixture,
  harness,
  headerLine,
  hitAddresses,
  largestHold,
  userLine,
  writeSession,
} from "./support.ts";
import { DatabaseSync } from "node:sqlite";
import { type PatternEvaluator } from "../../lib/search-eval.ts";
import { searchRuntime } from "../../lib/search-tool.ts";
import type { SearchHost } from "../../lib/search-tool.ts";

/**
 * specs/search-tool.md Sections 2.2, 2.3 and 3.3: the evaluation of a query and
 * what bounds it — the event loop yield under a long one, an abort during one, the
 * per-item evaluation limit, a failing evaluation, and the end of a continuation's
 * boot window.
 */

after(cleanupRoots);

interface Many {
  host: SearchHost;
  db: string;
  sessions: number;
  items: number;
}

/** Many sessions of many items each, in one sessions directory. */
function many(sessions: number, items: number, prefix = "search-tool-evaluation-"): Many {
  const made = fixture(prefix);
  for (let s = 0; s < sessions; s += 1) {
    const lines: string[] = [headerLine(`session-${String(s).padStart(4, "0")}`)];
    let parent: string | null = null;
    for (let i = 0; i < items; i += 1) {
      const id = `e${s}_${i}`;
      lines.push(
        userLine(
          id,
          parent,
          `item ${s} ${i} ${i % 7 === 0 ? "needle" : "haystack"}`,
          s * items + i,
        ),
      );
      parent = id;
    }
    // The invoking session is one of the project's files; the rest are its members.
    const path =
      s === 0 ? made.mainFile : join(made.sessions, `s${String(s).padStart(4, "0")}.jsonl`);
    writeSession(path, ...lines);
  }
  return {
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
    db: made.db,
    sessions,
    items,
  };
}

test("a long evaluation yields to the event loop at least every 250 ms", async () => {
  const made = many(200, 100);
  const h = harness({ db: made.db });
  let outcome: { lines: string[] } | undefined;
  const gap = await largestHold(async () => {
    outcome = await h.call(made.host, { action: "find", query: "ǂ", scope: "project-trees" });
  });
  assert.ok(outcome !== undefined);
  assert.equal(gap < 250, true, `the event loop was held for ${gap} ms`);
});

test("an abort during a long evaluation ends the call well within 1000 ms", async () => {
  const made = many(200, 100);
  const h = harness({ db: made.db });
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 100);
  const outcome = await h.call(
    made.host,
    { action: "find", query: "ǂ", scope: "project-trees" },
    controller.signal,
  );
  const elapsed = Date.now() - started;
  assert.equal(outcome.text, "Search aborted");
  assert.equal(elapsed < 1000, true, `took ${elapsed} ms`);
});

test("the evaluation limit ends one item, counts it, and the call goes on", async () => {
  const made = fixture("search-tool-limit-");
  writeSession(
    made.mainFile,
    headerLine("main-session-0001"),
    userLine("a", null, "alpha first", 1),
    userLine("evil", "a", `${"a".repeat(64)}!`, 2),
    userLine("c", "evil", "alpha last", 3),
  );
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const h = harness({ db: made.db });
  const outcome = await h.call(host, {
    action: "find",
    query: "(a+)+$",
    regex: true,
    order: "oldest",
  });
  assert.equal(outcome.isError, false);
  assert.equal(outcome.details.unmatched, 1);
  assert.deepEqual(hitAddresses(outcome), []);
  assert.deepEqual(outcome.lines, [
    "(no hits)",
    "1 items were not matched: the pattern ran over 1000 ms on each. Simplify the pattern.",
  ]);
  // A later call is not affected: the item is only passed over in the call that met the limit.
  const next = await h.call(host, { action: "find", query: "alpha", order: "oldest" });
  assert.deepEqual(hitAddresses(next), ["self:a", "self:c"]);
});

test("an evaluation that fails ends the call at once as Search failed", async () => {
  const made = fixture("search-tool-evaluation-failure-");
  writeSession(made.mainFile, headerLine("main-session-0001"), userLine("a", null, "alpha", 1));
  // The evaluation fails for a reason other than the pattern, the evaluation limit,
  // the budget, or an abort (Section 2.3).
  const failing = (): PatternEvaluator => ({
    evaluate: async () => ({ kind: "failed", message: "the search worker exited (code 1)" }),
    close: () => {},
  });
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const result = await searchRuntime({
    indexPath: made.db,
    zone: "UTC",
    makeEvaluator: failing,
  }).execute({
    ...host,
    params: { action: "find", query: "alpha", regex: true } as never,
    signal: undefined,
  });
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  assert.equal(result.isError, true);
  assert.equal(text, "Search failed: the search worker exited (code 1)");
});

test("stopping the runtime ends its continuation of catch-up", async () => {
  const made = many(6, 40);
  const clock = harness({ db: made.db }).clock;
  const h = harness({ db: made.db, clock });
  h.hook((event) => {
    if (event.phase === "cover" && event.covered === true) clock.set(clock.now() + 3100);
  });
  const outcome = await h.call(made.host, {
    action: "find",
    query: "needle",
    scope: "project-trees",
  });
  assert.equal((outcome.details.uncovered as number) >= 1, true);
  h.runtime.stop();
  await h.runtime.backgroundDone();
  const rowsAfterStop = fileRows(made.db);
  assert.equal(rowsAfterStop < made.sessions, true, `${rowsAfterStop} files rows after the stop`);
  // Nothing writes after the stop: the count stays where the stop left it.
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(fileRows(made.db), rowsAfterStop);
});

/** The `files` rows of the index file. */
function fileRows(db: string): number {
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
