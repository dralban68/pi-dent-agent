import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { join } from "node:path";
import {
  cleanupRoots,
  fixture,
  harness,
  headerLine,
  hitAddresses,
  toolResultLine,
  userLine,
  writeSession,
} from "./support.ts";
import { bigLayout, continued, oracle, paged, unusableDb } from "./oracle-support.ts";

/**
 * specs/search-tool.md#evaluation, equivalence on the paths a small fixture cannot reach: a
 * session of 200100 items loaded row by row, the index-wide scan a call over more than 200000
 * lines takes, a time group above the 50000-row cap, a filter dense past the 20000-row
 * collection cap. The fixture is just past those caps of `lib/search-eval.ts`; the tests share
 * it and the index it is caught up into, which the first test's duration includes.
 */

after(cleanupRoots);

let sharedBig: ReturnType<typeof bigLayout> | undefined;

/** The one big fixture the tests share, built and caught up into the index by `before`. */
function big(): ReturnType<typeof bigLayout> {
  if (sharedBig === undefined) throw new Error("the big fixture is built in before()");
  return sharedBig;
}

before(async () => {
  sharedBig = bigLayout();
  // Warm the index over every session (the clock does not advance, so covering
  // finishes however long it takes).
  const h = harness({ db: sharedBig.db });
  await h.call(sharedBig.host, {
    action: "find",
    query: "warmup",
    scope: "project-trees",
    limit: 1,
  });
  await h.runtime.backgroundDone();
});

test("the oracle holds on a session above 200000 items loaded row by row (tree and session scope)", async () => {
  const made = big();
  let reads = 0;
  const h = harness({ db: made.db, onItemRead: () => (reads += 1) });
  // Warm the index over every session (the clock does not advance, so covering
  // finishes however long it takes).
  await h.call(made.host, { action: "find", query: "warmup", scope: "project-trees", limit: 1 });
  await h.runtime.backgroundDone();
  // An absent word narrows: no item of the 200100-item session is read back.
  const absent = await h.call(made.host, { action: "find", query: "zqxjv", scope: "session" });
  assert.equal(absent.isError, false, absent.text);
  assert.deepEqual(
    absent.lines.filter((line) => line.includes(" \u00b7 ")),
    [],
  );
  const absentReads = reads;
  assert.equal(absentReads, 0, `${absentReads} items were read back for an absent word`);
  // A query with hits pages to the last hit of the 200100-item session.
  for (const order of ["newest", "oldest"] as const) {
    const actual = await paged(
      h,
      made.host,
      { action: "find", query: "needle special", scope: "session", order },
      100,
    );
    const expected = oracle(
      made.layout,
      "session",
      { query: "needle special", order },
      Number.MAX_SAFE_INTEGER,
    );
    assert.deepEqual(actual, expected, order);
    assert.equal(expected.length, 201);
  }
  // A time bound that leaves only the oldest entries: none may be lost.
  const until = await paged(
    h,
    made.host,
    {
      action: "find",
      query: "needle special",
      scope: "session",
      until: "2026-01-01T00:02:30.000Z",
    },
    100,
  );
  const untilExpected = oracle(
    made.layout,
    "session",
    { query: "needle special", until: "2026-01-01T00:02:30.000Z" },
    Number.MAX_SAFE_INTEGER,
  );
  assert.deepEqual(until, untilExpected);
  assert.ok(untilExpected.length > 0 && untilExpected.length < 201);
  // The same session read directly, without the index: one page, since each page reads
  // the whole file and paging by direct read is the matrix's.
  const direct = await harness({ db: unusableDb(made.db) }).call(made.host, {
    action: "find",
    query: "needle special",
    scope: "session",
    limit: 100,
  });
  assert.deepEqual(
    hitAddresses(direct),
    oracle(made.layout, "session", { query: "needle special" }, 100),
  );
  assert.equal(direct.details.more, true, direct.text);
});

test("the oracle holds on the scan path: a time group above the row cap, filters, both orders, deep pages", async () => {
  const made = big();
  const h = harness({ db: made.db });
  await h.call(made.host, { action: "find", query: "warmup", scope: "project-trees", limit: 1 });
  await h.runtime.backgroundDone();
  // No query: the first pages of `newest` sit inside the members' single time
  // group of 105000 items, above the 50000-row cap. Three pages of 100 suffice:
  // what they must not do is reorder or repeat the group's items.
  for (const order of ["newest", "oldest"] as const) {
    const prefix: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const params: Record<string, unknown> = {
        action: "find",
        scope: "project-trees",
        order,
        limit: 100,
      };
      if (cursor !== undefined) params.after = cursor;
      const outcome = await h.call(made.host, params);
      assert.equal(outcome.isError, false, outcome.text);
      prefix.push(
        ...outcome.lines
          .filter((line) => line.includes(" \u00b7 ") && !line.startsWith("---"))
          .map((line) => line.slice(0, line.indexOf(" \u00b7 "))),
      );
      if (typeof outcome.details.next === "string") cursor = outcome.details.next;
      else cursor = undefined;
      if (typeof cursor !== "string") break;
    }
    const expected = oracle(made.layout, "project-trees", { order }, 300);
    assert.deepEqual(prefix, expected, `${order} / no query / first 300`);
  }
  // Queries and filters page to the last hit.
  for (const order of ["newest", "oldest"] as const) {
    for (const filters of [
      { query: "needle special" },
      { isError: true },
      { tool: "Bash", query: "zq" },
    ]) {
      const actual = await continued(
        h,
        made.host,
        { action: "find", scope: "project-trees", order, ...filters },
        100,
      );
      const expected = oracle(
        made.layout,
        "project-trees",
        { order, ...filters },
        Number.MAX_SAFE_INTEGER,
      );
      assert.deepEqual(actual, expected, `${order} / ${JSON.stringify(filters)}`);
    }
  }
  // Filters no item passes scan the whole candidate order and end unstopped with no hit.
  for (const filters of [
    { isError: true, query: "plain filler" },
    { tool: "Read" },
    { kinds: ["summary"] },
  ]) {
    const outcome = await h.call(made.host, { action: "find", scope: "project-trees", ...filters });
    assert.equal(outcome.isError, false, outcome.text);
    assert.equal(outcome.details.stopped, false, outcome.text);
    assert.deepEqual(hitAddresses(outcome), [], JSON.stringify(filters));
    assert.deepEqual(
      oracle(made.layout, "project-trees", filters, Number.MAX_SAFE_INTEGER),
      [],
      JSON.stringify(filters),
    );
  }
  // An absent word on the scan path narrows: no item is read back.
  let reads = 0;
  const absentHarness = harness({
    db: made.db,
    onItemRead: () => (reads += 1),
  });
  const absent = await absentHarness.call(made.host, {
    action: "find",
    query: "zqxjv",
    scope: "project-trees",
  });
  assert.equal(absent.isError, false, absent.text);
  assert.equal(
    absent.lines.some((line) => line.includes(" \u00b7 ")),
    false,
  );
  assert.equal(reads, 0, `${reads} items were read back for an absent word on the scan path`);
});

for (const order of ["newest", "oldest"] as const) {
  test(`the oracle holds on the scan path with a filter dense past the collection cap, ${order} first`, async () => {
    const made = big();
    const h = harness({ db: made.db });
    // A filter dense past the collection cap (104790 injected items) falls back to
    // the windowed pages, alone and with a query whose trigrams overflow; a sparse
    // kind with that query is collected and probed. First 300 of each order.
    for (const filters of [
      { kinds: ["injected"] },
      { kinds: ["injected"], query: "filler" },
      { kinds: ["user"], query: "filler" },
    ]) {
      const prefix: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 3; page += 1) {
        const params: Record<string, unknown> = {
          action: "find",
          scope: "project-trees",
          order,
          limit: 100,
          ...filters,
        };
        if (cursor !== undefined) params.after = cursor;
        const outcome = await h.call(made.host, params);
        assert.equal(outcome.isError, false, outcome.text);
        prefix.push(
          ...outcome.lines
            .filter((line) => line.includes(" \u00b7 ") && !line.startsWith("---"))
            .map((line) => line.slice(0, line.indexOf(" \u00b7 "))),
        );
        if (typeof outcome.details.next === "string") cursor = outcome.details.next;
        else break;
      }
      const expected = oracle(made.layout, "project-trees", { order, ...filters }, 300);
      assert.deepEqual(prefix, expected, `${order} / ${JSON.stringify(filters)} / first 300`);
    }
  });
}

test("a stopped windowed scan continues by after and loses nothing (scan path)", async () => {
  const made = big();
  const h = harness({ db: made.db });
  await h.call(made.host, { action: "find", query: "warmup", scope: "project-trees", limit: 1 });
  await h.runtime.backgroundDone();
  let decided = 0;
  h.hook((event) => {
    if (event.phase !== "decide") return;
    decided += 1;
    if (decided === 10) h.clock.advance(10_000);
  });
  const addresses: string[] = [];
  let stoppedOnce = false;
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const params: Record<string, unknown> = {
      action: "find",
      query: "zq",
      kinds: ["user"],
      scope: "project-trees",
      limit: 5,
    };
    if (cursor !== undefined) params.after = cursor;
    const outcome = await h.call(made.host, params);
    assert.equal(outcome.isError, false, outcome.text);
    const shown = outcome.lines
      .filter((line) => line.includes(" \u00b7 ") && !line.startsWith("---"))
      .map((line) => line.slice(0, line.indexOf(" \u00b7 ")));
    addresses.push(...shown);
    if (outcome.details.stopped === true) {
      stoppedOnce = true;
      const stop = outcome.details.next;
      assert.equal(typeof stop, "string", outcome.text);
      if (typeof stop === "string") cursor = stop;
      continue;
    }
    if (outcome.details.more === true && typeof outcome.details.next === "string") {
      if (typeof outcome.details.next === "string") cursor = outcome.details.next;
      else cursor = undefined;
      continue;
    }
    break;
  }
  assert.equal(stoppedOnce, true, "the scan was expected to stop at the budget");
  const expected = oracle(
    made.layout,
    "project-trees",
    { query: "zq", kinds: ["user"] },
    Number.MAX_SAFE_INTEGER,
  );
  assert.deepEqual(addresses, expected);
  assert.equal(expected.length, 15);
});

test("the scan path restricted to the call's files, when they are a small part of the index", async () => {
  const made = big();
  // Thirty sessions of another project share the index, so the call's six files
  // are at most a quarter of it and its statements name them.
  const elsewhere = fixture("search-tool-oracle-elsewhere-");
  writeSession(
    elsewhere.mainFile,
    headerLine("else-main-0000"),
    userLine("x0", null, "needle elsewhere", 1),
  );
  for (let index = 1; index <= 30; index += 1) {
    const lines = [headerLine(`else-${index}-session`)];
    let parent: string | null = null;
    for (let line = 0; line < 50; line += 1) {
      const id = `e${index}x${line}`;
      lines.push(toolResultLine(id, parent, "Bash", `c${line}`, "needle elsewhere zq", true, 600));
      parent = id;
    }
    writeSession(join(elsewhere.sessions, `e${index}.jsonl`), ...lines);
  }
  const other = harness({ db: made.db });
  await other.call(
    { sessionFile: elsewhere.mainFile, agentDirectory: elsewhere.agentDir, main: true },
    { action: "find", query: "warmup", scope: "project-trees", limit: 1 },
  );
  await other.runtime.backgroundDone();
  const h = harness({ db: made.db });
  await h.call(made.host, { action: "find", query: "warmup", scope: "project-trees", limit: 1 });
  await h.runtime.backgroundDone();
  for (const order of ["newest", "oldest"] as const) {
    for (const filters of [
      { isError: true },
      { tool: "bash", query: "needle" },
      { kinds: ["user"], query: "zq" },
    ]) {
      const actual = await continued(
        h,
        made.host,
        { action: "find", scope: "project-trees", order, ...filters },
        100,
      );
      const expected = oracle(
        made.layout,
        "project-trees",
        { order, ...filters },
        Number.MAX_SAFE_INTEGER,
      );
      assert.deepEqual(actual, expected, `${order} / ${JSON.stringify(filters)}`);
    }
  }
});
