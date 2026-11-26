import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import {
  cleanupRoots,
  fixture,
  harness,
  headerLine,
  hitAddresses,
  SMALL_LIMITS,
  userLine,
  writeSession,
} from "./support.ts";
import type { SearchHost } from "../../lib/search-tool.ts";
import {
  continued,
  expressionOf,
  layoutOf,
  oracle,
  paged,
  placedItems,
  sessionsOf,
  unusableDb,
  type Layout,
} from "./oracle-support.ts";

/**
 * specs/search-tool.md#evaluation and specs/search-tool.md#result: `find` against the oracle where
 * the first trigram lookup overflows, in time groups larger than a page, from an `after` inside a
 * group, across a stop and its continuation, and the items narrowing reads back.
 */

after(cleanupRoots);

// specs/search-tool.md#step-limits: `firstLookupMatches`, lowered through the test seam.
test("the oracle holds where the first trigram lookup overflows (more than firstLookupMatches)", async () => {
  const made = layoutOf("search-tool-oracle-overflow-");
  // A session whose 25 items all contain the trigram, with the fixture's other
  // needles just past the matches the first lookup admits, 10 of them at one time.
  const lines: string[] = [headerLine("bulk-session-0006")];
  let parent: string | null = null;
  for (let index = 0; index < 25; index += 1) {
    const id = `n${index}`;
    lines.push(userLine(id, parent, `needle item ${index}`, index < 10 ? 1 : 2 + index));
    parent = id;
  }
  const bulkPath = join(made.sessions, "m3.jsonl");
  writeSession(bulkPath, ...lines);
  const layout: Layout = {
    ...made.layout,
    members: [{ key: "~bulk-session-", path: bulkPath }],
  };
  for (const scope of ["session", "project", "project-trees"]) {
    for (const order of ["newest", "oldest"] as const) {
      for (const db of [made.db, unusableDb(made.db)]) {
        const h = harness({ db, limits: SMALL_LIMITS });
        const actual = await paged(
          h,
          made.host,
          { action: "find", query: "needle", scope, order },
          7,
        );
        const expected = oracle(layout, scope, { query: "needle", order }, Number.MAX_SAFE_INTEGER);
        assert.deepEqual(
          actual,
          expected,
          `${scope} / ${order} / ${db === made.db ? "index" : "direct"}`,
        );
      }
    }
  }
});

test("more than 32 rows at one time keep the call's order, with no repeat and none lost", async () => {
  const made = fixture("search-tool-oracle-group-");
  const lines: string[] = [headerLine("main-session-0001")];
  for (let index = 0; index < 60; index += 1) {
    lines.push(
      userLine(`g${index}`, index === 0 ? null : `g${index - 1}`, `alpha row ${index}`, 1),
    );
  }
  writeSession(made.mainFile, ...lines);
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const expected = Array.from({ length: 60 }, (_, index) => `self:g${index}`).toReversed();
  for (const db of [made.db, unusableDb(made.db)]) {
    for (const order of ["newest", "oldest"] as const) {
      const h = harness({ db });
      const actual = await paged(h, host, { action: "find", query: "alpha", order }, 7);
      assert.deepEqual(actual, order === "newest" ? expected : [...expected].toReversed());
    }
  }
});

test("a time group that spans more than one page keeps the call's order, from any after inside it", async () => {
  const made = fixture("search-tool-oracle-group2-");
  const lines: string[] = [headerLine("main-session-0001")];
  for (let index = 0; index < 600; index += 1) {
    lines.push(
      userLine(`g${index}`, index === 0 ? null : `g${index - 1}`, `alpha row ${index}`, 1),
    );
  }
  writeSession(made.mainFile, ...lines);
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const layout: Layout = { self: { key: "self", path: made.mainFile } };
  const all = oracle(layout, "session", { query: "alpha" }, Number.MAX_SAFE_INTEGER, undefined);
  assert.equal(all.length, 600);
  const mid = all[300];
  assert.equal(typeof mid, "string");
  for (const order of ["newest", "oldest"] as const) {
    for (const db of [made.db, unusableDb(made.db)]) {
      const h = harness({ db });
      const fromStart = await paged(h, host, { action: "find", query: "alpha", order }, 7);
      assert.deepEqual(
        fromStart,
        oracle(layout, "session", { query: "alpha", order }, Number.MAX_SAFE_INTEGER),
        `${order} / ${db === made.db ? "index" : "direct"}`,
      );
      const afterMid = await continued(
        h,
        host,
        { action: "find", query: "alpha", order, after: mid },
        7,
      );
      const expected = oracle(
        layout,
        "session",
        { query: "alpha", order },
        Number.MAX_SAFE_INTEGER,
        mid,
      );
      assert.deepEqual(afterMid, expected, `${order} after ${mid}`);
    }
  }
});

test("after taken from the middle of a time group shared across sessions loses nothing", async () => {
  const made = layoutOf("search-tool-oracle-midgroup-");
  // Second 2 holds u2 (self), k2 (kid) and d1 (deep) under one timestamp: transcript
  // order k2, d1, u2, so the group's middle item is d1 in both orders.
  for (const order of ["newest", "oldest"] as const) {
    const ordered = oracle(made.layout, "tree", { order }, Number.MAX_SAFE_INTEGER);
    const at = ordered.indexOf("kid-task1/deep-task2:d1");
    assert.ok(at > 0, `d1 missing from ${order}: ${ordered.join(",")}`);
    // The three items of second 2 are contiguous in the call's order.
    const neighbours = ordered.slice(at - 1, at + 2);
    assert.deepEqual(
      neighbours.toSorted(),
      ["kid-task1:k2", "kid-task1/deep-task2:d1", "self:u2"].toSorted(),
    );
    for (const db of [made.db, unusableDb(made.db)]) {
      const h = harness({ db });
      const actual = await continued(
        h,
        made.host,
        { action: "find", scope: "tree", order, after: "kid-task1/deep-task2:d1" },
        7,
      );
      const expected = oracle(
        made.layout,
        "tree",
        { order },
        Number.MAX_SAFE_INTEGER,
        "kid-task1/deep-task2:d1",
      );
      assert.deepEqual(actual, expected, `${order} / after d1`);
    }
  }
});

test("a stopped call shows a prefix of the oracle and its continuation loses nothing (per-session path)", async () => {
  const made = layoutOf("search-tool-oracle-stop-");
  const h = harness({ db: made.db });
  await h.call(made.host, { action: "find", query: "warmup", scope: "tree", limit: 1 });
  await h.runtime.backgroundDone();
  let decided = 0;
  h.hook((event) => {
    if (event.phase !== "decide") return;
    decided += 1;
    if (decided === 3) h.clock.advance(10_000);
  });
  const order = "newest";
  const addresses: string[] = [];
  let firstPageAddresses: string[] | undefined;
  let stopped = false;
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const params: Record<string, unknown> = {
      action: "find",
      query: "a",
      scope: "tree",
      order,
      limit: 5,
    };
    if (cursor !== undefined) params.after = cursor;
    const outcome = await h.call(made.host, params);
    assert.equal(outcome.isError, false, outcome.text);
    const shown = outcome.lines
      .filter((line) => line.includes(" \u00b7 ") && !line.startsWith("---"))
      .map((line) => line.slice(0, line.indexOf(" \u00b7 ")));
    if (firstPageAddresses === undefined) firstPageAddresses = [...shown];
    addresses.push(...shown);
    if (outcome.details.stopped === true) {
      stopped = true;
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
  assert.equal(stopped, true, "the call was expected to stop at the budget");
  const expected = oracle(made.layout, "tree", { query: "a", order }, Number.MAX_SAFE_INTEGER);
  // The first, stopped page showed a prefix of the oracle's order (specs/search-tool.md#evaluation). It
  // may hold every hit: the run of decided items can reach the end of the list, and
  // a stop shortens no page, it only names the item the next call goes on from.
  assert.deepEqual(firstPageAddresses, expected.slice(0, firstPageAddresses?.length));
  // The continuation loses nothing and repeats nothing.
  assert.deepEqual(addresses, expected);
});

test("narrowing reads back only the items that match, on every covered session of a tree", async () => {
  const made = layoutOf("search-tool-oracle-reads-");
  let reads = 0;
  const h = harness({ db: made.db, onItemRead: () => (reads += 1) });
  await h.call(made.host, { action: "find", query: "warmup", scope: "tree", limit: 1 });
  await h.runtime.backgroundDone();
  reads = 0;
  const outcome = await h.call(made.host, { action: "find", query: "needle", scope: "tree" });
  assert.equal(outcome.isError, false, outcome.text);
  // Every item on the lineage whose match text contains "needle" is read back —
  // Search's own calls among them, whose label the call reads to apply the
  // own-calls rule — and nothing else (specs/search-tool.md#evaluation).
  const tree = sessionsOf(made.layout, "tree").flatMap((session) => placedItems(session));
  const expression = expressionOf("needle", false, false);
  const ownRead = tree.filter(
    (placed) => placed.onLineage && expression.test(placed.item.matchText),
  ).length;
  assert.equal(reads, ownRead, `${reads} items read back, ${ownRead} expected`);
});

test("a regular expression narrows by trigrams without losing a hit", async () => {
  // Each pattern with the texts it matches: `find` must return exactly the items
  // the pattern matches, whether the call narrows the candidates by trigrams or
  // evaluates every one of them (specs/search-tool.md#evaluation).
  const cases: { pattern: string; texts: string[] }[] = [
    { pattern: "needle", texts: ["a needle here"] },
    { pattern: "nee?dle", texts: ["nedle", "needle"] },
    { pattern: "ne+dle", texts: ["nedle", "neeeedle"] },
    { pattern: "abc{0,2}def", texts: ["abdef", "abccdef"] },
    { pattern: "ab(cd)?efg", texts: ["abefg", "abcdefg"] },
    { pattern: "foo|barbaz", texts: ["foo", "barbaz"] },
    { pattern: "\\x41bcdef", texts: ["Abcdef", "zzz"] },
    { pattern: "\\u0041bcdef", texts: ["Abcdef", "zzz"] },
    { pattern: "\\bword\\b", texts: ["a word b"] },
    { pattern: "x\\.y\\.z\\.w", texts: ["x.y.z.w"] },
    { pattern: "[abc]xyz+q", texts: ["axyzzzq"] },
    { pattern: "(?=abc)abcde", texts: ["abcde"] },
    { pattern: "a{3}bcd", texts: ["aaabcd"] },
    { pattern: "\\d+ items? found", texts: ["12 item found", "3 items found"] },
    { pattern: "1\\d{3}-2", texts: ["1999-2", "zzz"] },
    { pattern: "^start middle$", texts: ["start middle"] },
    { pattern: "(a|b)cdefg", texts: ["acdefg", "bcdefg"] },
  ];
  for (const { pattern, texts } of cases) {
    const made = fixture("search-tool-narrow-");
    const lines = [headerLine("narrow-session-0001")];
    let parent: string | null = null;
    for (let index = 0; index < texts.length; index += 1) {
      const id = `t${index}`;
      lines.push(userLine(id, parent, texts[index] ?? "", index + 1));
      parent = id;
    }
    writeSession(made.mainFile, ...lines);
    const outcome = await harness({ db: made.db }).call(
      { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
      { action: "find", query: pattern, regex: true, order: "oldest" },
    );
    assert.equal(outcome.isError, false, `${pattern}: ${outcome.text}`);
    const expression = new RegExp(pattern, "mi");
    const expected: string[] = [];
    for (let index = 0; index < texts.length; index += 1) {
      if (expression.test(texts[index] ?? "")) expected.push(`self:t${index}`);
    }
    assert.deepEqual(hitAddresses(outcome), expected, `${pattern}: ${outcome.text}`);
  }
});
