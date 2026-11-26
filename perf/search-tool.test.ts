import assert from "node:assert/strict";
import { after, test } from "node:test";
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
 * them. The 250 ms yield bound is the spec's; the 100 ms abort and 500 ms session-scope bounds
 * are tighter than the spec's 1000 ms abort bound and are this suite's own. Each test prints
 * what it measured. The behaviour on the same paths is in test/search-tool/.
 */

after(cleanupRoots);

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

test("a session-scope find does not depend on the other sessions of the index", async (t) => {
  const made = crowded(2000);
  await seed(made.db, [made.host.sessionFile ?? "", made.other]);
  const h = harness({ db: made.db });
  // Warm the index over every session first, so the call meets a full index.
  await h.call(made.host, { action: "find", query: "haystack", scope: "project-trees", limit: 1 });
  await h.runtime.backgroundDone();
  const started = Date.now();
  const outcome = await h.call(made.host, { action: "find", query: "needle", scope: "session" });
  const elapsed = Date.now() - started;
  t.diagnostic(`session-scope find among 2002 sessions: ${elapsed} ms (bound 500 ms)`);
  assert.deepEqual(hitAddresses(outcome), ["self:a"]);
  assert.equal(elapsed < 500, true, `session-scope find took ${elapsed} ms`);
});

test("an abort during paging is observed within 100 ms", async (t) => {
  const made = crowded(2000);
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  await h.call(made.host, { action: "find", query: "haystack", scope: "project-trees", limit: 1 });
  await h.runtime.backgroundDone();
  const controller = new AbortController();
  const pending = h.call(
    made.host,
    { action: "find", query: "zzzzabsent", scope: "project-trees" },
    controller.signal,
  );
  await new Promise((done) => setTimeout(done, 20));
  const abortedAt = Date.now();
  controller.abort();
  const outcome = await pending;
  const elapsed = Date.now() - abortedAt;
  t.diagnostic(`abort observed after ${elapsed} ms (bound 100 ms)`);
  assert.equal(outcome.text, "Search aborted");
  assert.equal(elapsed < 100, true, `the abort took ${elapsed} ms`);
});

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

test("a filter no item passes ends unstopped and yields to the event loop", async (t) => {
  const made = fixture("search-tool-r3-sparse-");
  writeSession(made.mainFile, headerLine("main-session-0001"), userLine("a", null, "alpha", 1));
  // 400 project members of 600 items each: 240000 lines, above the per-session bound.
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
