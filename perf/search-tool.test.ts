import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupRoots,
  crowded,
  fixture,
  harness,
  headerLine,
  hitAddresses,
  largestHold,
  many,
  seed,
  testClock,
  userLine,
  writeSession,
} from "../test/search-tool/support.ts";
import type { SearchHost } from "../lib/search-tool.ts";

/**
 * specs/search-tool.md#abort: the time bounds of `Search` on workloads large enough to show
 * them, with the real step limits (specs/search-tool.md#step-limits). Each test prints what it
 * measured. The behaviour on the same paths is in test/search-tool/.
 */

after(cleanupRoots);

// specs/search-tool.md#abort: no 250 ms without yielding.
test("discovery and a sparse filter scan do not hold the event loop for 250 ms", async (t) => {
  const made = crowded(2000);
  const h = harness({ db: made.db });
  const gap = await largestHold(async () => {
    // The first call discovers every session and the second runs a filter that
    // matches nothing, which scans the whole candidate order.
    await h.call(made.host, { action: "find", query: "needle", scope: "project-trees", limit: 1 });
    await h.runtime.backgroundDone();
    await h.call(made.host, { action: "find", isError: true, scope: "project-trees" });
  });
  t.diagnostic(`largest event-loop hold: ${gap} ms (bound 250 ms)`);
  assert.equal(gap < 250, true, `the event loop was held for ${gap} ms`);
});

// specs/search-tool.md#abort: a session-scope find of at most 100 items returns within 500 ms.
test("a session-scope find does not depend on the other sessions of the index", async (t) => {
  const made = crowded(2000);
  // The invoking session at the bound's 100 items: the hit and 99 others.
  const lines = [headerLine("main-session-0001"), userLine("a", null, "alpha needle a", 1)];
  let parent = "a";
  for (let index = 0; index < 99; index += 1) {
    const id = `b${index}`;
    lines.push(userLine(id, parent, `alpha haystack ${index}`, 2 + index));
    parent = id;
  }
  writeSession(made.host.sessionFile ?? "", ...lines);
  await seed(made.db, [made.host.sessionFile ?? "", made.other]);
  const h = harness({ db: made.db });
  // Warm the index over every session first, so the call meets a full index.
  await h.call(made.host, { action: "find", query: "haystack", scope: "project-trees", limit: 1 });
  await h.runtime.backgroundDone();
  const started = Date.now();
  const outcome = await h.call(made.host, { action: "find", query: "needle", scope: "session" });
  const elapsed = Date.now() - started;
  t.diagnostic(`session-scope find of 100 items among 2002 sessions: ${elapsed} ms (bound 500 ms)`);
  assert.deepEqual(hitAddresses(outcome), ["self:a"]);
  assert.equal(elapsed < 500, true, `session-scope find took ${elapsed} ms`);
});

// specs/search-tool.md#abort: a project-wide find with no hit over 2000 sessions returns within 1000 ms.
test("a project-wide find with no hit over 2000 sessions returns within 1000 ms", async (t) => {
  // The invoking session, one other, and 1998 tiny ones: 2000 sessions of at most 2 items.
  const made = crowded(1998);
  // Catch every session up first, so the call meets a full index.
  const sessions = join(made.root, "sessions");
  const files = readdirSync(sessions).filter((name) => name.endsWith(".jsonl"));
  await seed(
    made.db,
    files.map((name) => join(sessions, name)),
  );
  const h = harness({ db: made.db });
  const started = Date.now();
  const outcome = await h.call(made.host, {
    action: "find",
    query: "zzzzabsent",
    scope: "project",
  });
  const elapsed = Date.now() - started;
  t.diagnostic(`project-wide find with no hit over 2000 sessions: ${elapsed} ms (bound 1000 ms)`);
  assert.equal(outcome.text, "(no hits)");
  assert.equal(outcome.details.sessions, 2000);
  assert.equal(elapsed < 1000, true, `the project-wide find took ${elapsed} ms`);
});

// specs/search-tool.md#abort: an abort after covering ends the call within 100 ms.
test("an abort after covering is observed within 100 ms", async (t) => {
  const made = crowded(2000);
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  await h.call(made.host, { action: "find", query: "haystack", scope: "project-trees", limit: 1 });
  await h.runtime.backgroundDone();
  const controller = new AbortController();
  let covered = 0;
  let abortedAt: number | undefined;
  // 50 ms after the last of the 2002 sessions is covered, while the call reads their rows
  // (about 220 ms on a developer machine).
  h.hook((event) => {
    if (event.phase !== "cover") return;
    covered += 1;
    if (covered !== 2002) return;
    setTimeout(() => {
      abortedAt = Date.now();
      controller.abort();
    }, 50);
  });
  const outcome = await h.call(
    made.host,
    { action: "find", query: "zzzzabsent", scope: "project-trees" },
    controller.signal,
  );
  assert.notEqual(abortedAt, undefined, "the call ended before the abort");
  const elapsed = Date.now() - (abortedAt ?? 0);
  t.diagnostic(`abort observed after ${elapsed} ms (bound 100 ms)`);
  assert.equal(outcome.text, "Search aborted");
  assert.equal(elapsed < 100, true, `the abort took ${elapsed} ms`);
});

// specs/search-tool.md#abort: no 250 ms without yielding.
test("a long evaluation yields to the event loop at least every 250 ms", async (t) => {
  const made = many(200, 100);
  const h = harness({ db: made.db });
  let outcome: { lines: string[] } | undefined;
  const gap = await largestHold(async () => {
    outcome = await h.call(made.host, { action: "find", query: "ǂ", scope: "project-trees" });
  });
  t.diagnostic(`largest event-loop hold: ${gap} ms (bound 250 ms)`);
  assert.ok(outcome !== undefined);
  assert.equal(gap < 250, true, `the event loop was held for ${gap} ms`);
});

// specs/search-tool.md#abort: no 250 ms without yielding, on a scan past the real `fileModeLines`.
test("a filter no item passes ends unstopped and yields to the event loop", async (t) => {
  const made = fixture("search-tool-r3-sparse-");
  writeSession(made.mainFile, headerLine("main-session-0001"), userLine("a", null, "alpha", 1));
  // 400 project members of 600 items each: 240000 lines, above `fileModeLines`.
  for (let member = 0; member < 400; member += 1) {
    const lines = [headerLine(`member-${String(member).padStart(4, "0")}-sess`)];
    let parent: string | null = null;
    for (let index = 0; index < 600; index += 1) {
      const id = `m${member}x${index}`;
      lines.push(userLine(id, parent, `plain text ${index}`, 10 + index));
      parent = id;
    }
    writeSession(join(made.sessions, `p${member}.jsonl`), ...lines);
  }
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const h = harness({ db: made.db });
  await h.call(host, { action: "find", query: "warmup", scope: "project" });
  await h.runtime.backgroundDone();
  const gap = await largestHold(async () => {
    for (const params of [
      { isError: true },
      { tool: "Bash" },
      { kinds: ["summary"] },
      { isError: true, query: "plain text" },
    ]) {
      const outcome = await h.call(host, { action: "find", scope: "project", ...params });
      assert.equal(outcome.isError, false, outcome.text);
      assert.equal(outcome.details.stopped, false, outcome.text);
      assert.deepEqual(hitAddresses(outcome), [], JSON.stringify(params));
    }
  });
  t.diagnostic(`largest event-loop hold: ${gap} ms (bound 250 ms)`);
  assert.ok(gap < 250, `the event loop was held for ${gap} ms`);
});
