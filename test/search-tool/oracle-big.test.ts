import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { join } from "node:path";
import {
  assistantLine,
  cleanupRoots,
  fixture,
  harness,
  headerLine,
  hitAddresses,
  SMALL_LIMITS,
  toolResultLine,
  userLine,
  writeSession,
} from "./support.ts";
import { bigLayout, continued, oracle, paged, unusableDb } from "./oracle-support.ts";

/**
 * specs/search-tool.md#evaluation, equivalence on the paths past the step limits of
 * specs/search-tool.md#step-limits, lowered to `SMALL_LIMITS` through the test seam
 * (specs/search-tool.md#test-seam): a session of more items than `fileModeLines` loaded row by
 * row, the scan a call over more lines takes, in several windows, a time group above `groupRows`
 * walked in chunks, a filter dense past `collectionRows`, and a collection over more than one
 * `item_id` chunk, probed by range. The fixture is just past those limits; the tests share it
 * and the index it is caught up into.
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
  const h = harness({ db: sharedBig.db, limits: SMALL_LIMITS });
  await h.call(sharedBig.host, {
    action: "find",
    query: "warmup",
    scope: "project-trees",
    limit: 1,
  });
  await h.runtime.backgroundDone();
});

test("the oracle holds on a session of more items than fileModeLines, loaded row by row", async () => {
  const made = big();
  let reads = 0;
  const h = harness({ db: made.db, limits: SMALL_LIMITS, onItemRead: () => (reads += 1) });
  // Warm the index over every session (the clock does not advance, so covering
  // finishes however long it takes).
  await h.call(made.host, { action: "find", query: "warmup", scope: "project-trees", limit: 1 });
  await h.runtime.backgroundDone();
  // An absent word narrows: no item of the 1400-item session is read back.
  const absent = await h.call(made.host, { action: "find", query: "zqxjv", scope: "session" });
  assert.equal(absent.isError, false, absent.text);
  assert.deepEqual(
    absent.lines.filter((line) => line.includes(" \u00b7 ")),
    [],
  );
  const absentReads = reads;
  assert.equal(absentReads, 0, `${absentReads} items were read back for an absent word`);
  // A query with hits pages to the last hit of the 1400-item session.
  for (const order of ["newest", "oldest"] as const) {
    const actual = await paged(
      h,
      made.host,
      { action: "find", query: "needle special", scope: "session", order },
      5,
    );
    const expected = oracle(
      made.layout,
      "session",
      { query: "needle special", order },
      Number.MAX_SAFE_INTEGER,
    );
    assert.deepEqual(actual, expected, order);
    assert.equal(expected.length, 15);
  }
  // A time bound that leaves only the oldest entries: none may be lost.
  const until = await paged(
    h,
    made.host,
    {
      action: "find",
      query: "needle special",
      scope: "session",
      until: "2026-01-01T00:01:42.000Z",
    },
    5,
  );
  const untilExpected = oracle(
    made.layout,
    "session",
    { query: "needle special", until: "2026-01-01T00:01:42.000Z" },
    Number.MAX_SAFE_INTEGER,
  );
  assert.deepEqual(until, untilExpected);
  assert.ok(untilExpected.length > 0 && untilExpected.length < 15);
  // The same session read directly, without the index: one page, since each page reads
  // the whole file and paging by direct read is the matrix's.
  const direct = await harness({ db: unusableDb(made.db), limits: SMALL_LIMITS }).call(made.host, {
    action: "find",
    query: "needle special",
    scope: "session",
    limit: 10,
  });
  assert.deepEqual(
    hitAddresses(direct),
    oracle(made.layout, "session", { query: "needle special" }, 10),
  );
  assert.equal(direct.details.more, true, direct.text);
});

test("the oracle holds on the scan path: a time group above groupRows, filters, both orders, deep pages", async () => {
  const made = big();
  const h = harness({ db: made.db, limits: SMALL_LIMITS });
  await h.call(made.host, { action: "find", query: "warmup", scope: "project-trees", limit: 1 });
  await h.runtime.backgroundDone();
  // No query: the first pages of `newest` sit inside the members' single time
  // group of 550 items, above `groupRows`. Three pages of 100 suffice:
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
    limits: SMALL_LIMITS,
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
  test(`the oracle holds on the scan path with a filter dense past collectionRows, ${order} first`, async () => {
    const made = big();
    const h = harness({ db: made.db, limits: SMALL_LIMITS });
    // A filter dense past `collectionRows` (515 injected items) falls back to
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
  const h = harness({ db: made.db, limits: SMALL_LIMITS });
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
      // More than the hits of the first window of 32 items, so the budget, not the
      // limit, ends the first page.
      limit: 20,
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

// specs/search-tool.md#step-limits: the group walk reads one session's part in chunks of
// `groupChunkRows`; a line of more items than that keeps every item.
test("the group walk keeps every item of a line with more items than groupChunkRows", async () => {
  const made = fixture("search-tool-oracle-wide-");
  const U = 5000;
  const WIDE = SMALL_LIMITS.groupChunkRows + 10;
  // The main session: one entry of 60 text parts at second U, then more lines than
  // `fileModeLines` at earlier seconds, so the call scans.
  const selfLines = [headerLine("main-session-0001")];
  selfLines.push(
    assistantLine(
      "wide",
      null,
      Array.from({ length: WIDE }, (_, part) => ({ type: "text", text: `wide part ${part}` })),
      U,
    ),
  );
  let parent = "wide";
  for (let index = 0; index < SMALL_LIMITS.fileModeLines; index += 1) {
    const id = `s${index}`;
    selfLines.push(userLine(id, parent, `early ${index}`, index + 1));
    parent = id;
  }
  writeSession(made.mainFile, ...selfLines);
  // A member with `groupRows` lines at second U: the group at U is above `groupRows`.
  const memberPath = join(made.sessions, "p1.jsonl");
  const memberLines = [headerLine("mem1-session-0001")];
  let memberParent: string | null = null;
  for (let index = 0; index < SMALL_LIMITS.groupRows; index += 1) {
    const id = `m${index}`;
    memberLines.push(userLine(id, memberParent, `late ${index}`, U));
    memberParent = id;
  }
  writeSession(memberPath, ...memberLines);
  const layout = {
    self: { key: "self", path: made.mainFile },
    members: [{ key: "~mem1-session-", path: memberPath }],
  };
  const host = { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true };
  const h = harness({ db: made.db, limits: SMALL_LIMITS });
  await h.call(host, { action: "find", query: "warmup", scope: "project", limit: 1 });
  await h.runtime.backgroundDone();
  for (const order of ["newest", "oldest"] as const) {
    const actual = await continued(h, host, { action: "find", scope: "project", order }, 100);
    const expected = oracle(layout, "project", { order }, Number.MAX_SAFE_INTEGER);
    assert.equal(expected.filter((address) => address.startsWith("self:wide.")).length, WIDE);
    assert.deepEqual(actual, expected, order);
  }
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
  const other = harness({ db: made.db, limits: SMALL_LIMITS });
  await other.call(
    { sessionFile: elsewhere.mainFile, agentDirectory: elsewhere.agentDir, main: true },
    { action: "find", query: "warmup", scope: "project-trees", limit: 1 },
  );
  await other.runtime.backgroundDone();
  const h = harness({ db: made.db, limits: SMALL_LIMITS });
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
