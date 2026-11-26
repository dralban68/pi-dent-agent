import assert from "node:assert/strict";
import { after, test } from "node:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  START,
  cleanupRoots,
  fixture,
  harness,
  headerLine,
  hitAddresses,
  injectedLine,
  stamp,
  toolResultLine,
  userLine,
  writeSession,
  type Outcome,
} from "./support.ts";
import type { SearchHost } from "../../lib/search-tool.ts";
import {
  compareParts,
  currentLineage,
  readSessionFile,
  sessionItems,
  type TranscriptItem,
} from "../../lib/session-transcript.ts";

/**
 * An independent oracle: it computes the expected hit addresses straight from the
 * session files by the rules of specs/search-tool.md#candidates, specs/search-tool.md#matching, specs/search-tool.md#evaluation, specs/search-tool.md#result — no
 * index, none of the tool's evaluation code — and compares `find` against it over
 * a matrix of scopes, filters, orders, branches, paging and index states, and
 * over the paths that are easy to leave uncovered: a fixture above the
 * per-session/scan threshold, a time group above the row cap, a session above
 * 200000 items, stops injected by an advancing clock and their continuation,
 * and the number of items read back where the spec requires narrowing.
 */

after(cleanupRoots);

/** One session of a fixture, as the oracle knows it. */
interface OracleSession {
  /** The session key relative to the invoking session (specs/session-transcript.md#session-tree and specs/session-transcript.md#project). */
  key: string;
  path: string;
}

/** The sessions a scope reaches, written out by hand from the fixture's layout. */
interface Layout {
  self: OracleSession;
  kid?: OracleSession;
  deep?: OracleSession;
  other?: OracleSession;
  deepOther?: OracleSession;
  /** Project members added by a test. */
  members?: OracleSession[];
}

/** One transcript item with the session it belongs to and its ordering fields. */
interface Placed {
  key: string;
  path: string;
  item: TranscriptItem;
  onLineage: boolean;
}

const LITERAL_SPECIALS = new Set([
  "\\",
  "^",
  "$",
  ".",
  "*",
  "+",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
]);

/** The literal pattern of specs/search-tool.md#matching: each metacharacter escaped. */
function literalPattern(query: string): string {
  return [...query].map((ch) => (LITERAL_SPECIALS.has(ch) ? `\\${ch}` : ch)).join("");
}

/** The regular expression of specs/search-tool.md#matching. */
function expressionOf(query: string, regex: boolean, caseSensitive: boolean): RegExp {
  const pattern = regex ? query : literalPattern(query);
  return new RegExp(pattern, caseSensitive ? "m" : "mi");
}

/** The items of the session files a fixture holds, cached per path for the big fixtures. */
const placedCache = new Map<string, Placed[]>();

/** The items of one session file, read directly (specs/session-transcript.md#reading). */
function placedItems(session: OracleSession): Placed[] {
  const cached = placedCache.get(session.path);
  if (cached !== undefined) return cached;
  const read = readSessionFile(session.path);
  const placed: Placed[] =
    read === undefined
      ? []
      : sessionItems(read.entries).map((item) => ({
          key: session.key,
          path: session.path,
          item,
          onLineage: true,
        }));
  if (read !== undefined) {
    const lineage = new Set(currentLineage(read.entries).map((entry) => entry.entryId));
    for (const entry of placed) entry.onLineage = lineage.has(entry.item.entryId);
  }
  placedCache.set(session.path, placed);
  return placed;
}

/** Transcript order of specs/search-tool.md#references. */
function comparePlaced(one: Placed, other: Placed): number {
  if (one.item.time !== other.item.time) return one.item.time - other.item.time;
  if (one.key !== other.key) return one.key < other.key ? -1 : 1;
  if (one.path !== other.path) return one.path < other.path ? -1 : 1;
  if (one.item.line !== other.item.line) return one.item.line - other.item.line;
  return compareParts(one.item.part, other.item.part);
}

/** The sessions of a scope (specs/search-tool.md#reach), written out from the fixture's layout. */
function sessionsOf(layout: Layout, scope: string): OracleSession[] {
  if (scope === "session") return [layout.self];
  const tree = [layout.self, layout.kid, layout.deep].filter(
    (session): session is OracleSession => session !== undefined,
  );
  const members = layout.members ?? [];
  if (scope === "tree") return tree;
  const project = [layout.self, layout.other, ...members].filter(
    (session): session is OracleSession => session !== undefined,
  );
  if (scope === "project") return project;
  const otherTree = [layout.other, layout.deepOther].filter(
    (session): session is OracleSession => session !== undefined,
  );
  return [...tree, ...otherTree, ...members];
}

/** The filters a `find` call applies (specs/search-tool.md#candidates and specs/search-tool.md#matching). */
interface Filters {
  query?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  kinds?: string[];
  tool?: string;
  isError?: boolean;
  since?: string;
  until?: string;
  /** The instant of `since` when the call passes an age, which `Date.parse` cannot read. */
  sinceMs?: number;
  /** The instant of `until` when the call passes an age. */
  untilMs?: number;
  branches?: boolean;
  order?: "newest" | "oldest";
}

/** The parameters of a call: the filters without the oracle-only instant fields. */
function paramsOf(filters: Filters): Record<string, unknown> {
  const params: Record<string, unknown> = { ...filters };
  delete params.sinceMs;
  delete params.untilMs;
  return params;
}

/** True when the item passes every filter of specs/search-tool.md#candidates. */
function passes(placed: Placed, filters: Filters, expression: RegExp | undefined): boolean {
  const item = placed.item;
  if (filters.branches !== true && !placed.onLineage) return false;
  const tool = filters.tool === undefined ? undefined : filters.tool.trim().toLowerCase();
  const isOwn =
    (item.kind === "tool_call" || item.kind === "tool_result") && item.label === "Search";
  if (isOwn && tool !== "search") return false;
  if (filters.kinds !== undefined && !filters.kinds.includes(item.kind)) return false;
  if (tool !== undefined) {
    if (item.kind !== "tool_call" && item.kind !== "tool_result") return false;
    if (item.label === undefined || item.label.toLowerCase() !== tool) return false;
  }
  if (filters.isError !== undefined) {
    if (item.kind !== "tool_result" || item.isError !== filters.isError) return false;
  }
  if (filters.since !== undefined && item.time < (filters.sinceMs ?? Date.parse(filters.since))) {
    return false;
  }
  if (filters.until !== undefined && item.time >= (filters.untilMs ?? Date.parse(filters.until))) {
    return false;
  }
  if (expression !== undefined && !expression.test(item.matchText)) return false;
  return true;
}

/** The hit addresses of a call, in the call's order, after `after`, up to `limit` (specs/search-tool.md#result). */
function oracle(
  layout: Layout,
  scope: string,
  filters: Filters,
  limit: number,
  cursor?: string,
): string[] {
  const expression =
    filters.query === undefined
      ? undefined
      : expressionOf(filters.query, filters.regex === true, filters.caseSensitive === true);
  const all = sessionsOf(layout, scope)
    .flatMap((session) => placedItems(session))
    .filter((placed) => passes(placed, filters, expression))
    .toSorted(comparePlaced);
  const ordered = filters.order === "oldest" ? all : all.toReversed();
  const addresses = ordered.map((placed) => addressOf(placed));
  if (cursor === undefined) return addresses.slice(0, limit);
  const at = addresses.indexOf(cursor);
  if (at < 0) return addresses.slice(0, limit);
  return addresses.slice(at + 1, at + 1 + limit);
}

/** The address of one item (specs/session-transcript.md#item-address). */
function addressOf(placed: Placed): string {
  const part = placed.item.part === undefined ? "" : `.${placed.item.part}`;
  return `${placed.key}:${placed.item.entryId}${part}`;
}

/** The fixture: a main session with a branch, a child, a grandchild, and a project member with one. */
function layoutOf(prefix: string): {
  layout: Layout;
  host: SearchHost;
  db: string;
  sessions: string;
} {
  const made = fixture(prefix);
  // Equal timestamps across sessions, a branch entry, tool calls and results of
  // several tools — Search's own among them — and an unterminated last line.
  writeSession(
    made.mainFile,
    headerLine("main-session-0001"),
    userLine("u1", null, "alpha needle one", 1),
    userLine("b1", "u1", "alpha needle branch", 2),
    userLine("u2", "u1", "alpha two", 2),
    userLine("u3", "u2", "needle three", 3),
    assistantToolCall("a0", "u3", "c0", "List", 3),
    toolResultLine("r0", "a0", "List", "c0", "needle listed", false, 3),
    assistantToolCall("a1", "r0", "c1", "Bash", 4),
    toolResultLine("r1", "a1", "Bash", "c1", "grep: needle not found", true, 4),
    assistantToolCall("a2", "r1", "c2", "Search", 4),
    toolResultLine("r2", "a2", "Search", "c2", "(no hits)", false, 5),
  );
  // The unterminated last line is not part of any read.
  appendFileSync(made.mainFile, `${userLine("u9", "r2", "needle tail", 9)}\n`);
  const kidPath = join(made.agentDir, "kid-task1.jsonl");
  writeSession(
    kidPath,
    headerLine("kid-session-0002"),
    userLine("k1", null, "needle kid", -10),
    userLine("k2", "k1", "other kid", 2),
  );
  const deepDir = join(made.agentDir, "kid-task1.agents");
  mkdirSync(deepDir, { recursive: true });
  const deepPath = join(deepDir, "deep-task2.jsonl");
  writeSession(deepPath, headerLine("deep-session-0003"), userLine("d1", null, "needle deep", 2));
  const otherPath = join(made.sessions, "m2.jsonl");
  writeSession(
    otherPath,
    headerLine("other-session-0004"),
    userLine("v1", null, "needle other", 1),
    userLine("v2", "v1", "other two", 3),
  );
  const otherDeepDir = join(made.sessions, "m2.agents");
  mkdirSync(otherDeepDir, { recursive: true });
  const deepOtherPath = join(otherDeepDir, "deep-task9.jsonl");
  writeSession(deepOtherPath, headerLine("deep-other-0005"), userLine("w1", null, "needle w", -7));
  const layout: Layout = {
    self: { key: "self", path: made.mainFile },
    kid: { key: "kid-task1", path: kidPath },
    deep: { key: "kid-task1/deep-task2", path: deepPath },
    other: { key: "~other-session", path: otherPath },
    deepOther: { key: "~other-session/deep-task9", path: deepOtherPath },
  };
  return {
    layout,
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
    db: made.db,
    sessions: made.sessions,
  };
}

/** An assistant entry whose only content element is a tool call. */
function assistantToolCall(
  id: string,
  parentId: string | null,
  callId: string,
  name: string,
  seconds: number,
): string {
  return messageToolCall(id, parentId, callId, name, seconds);
}

/** The `message` line of a tool-call entry, spelled out for the oracle's fixture. */
function messageToolCall(
  id: string,
  parentId: string | null,
  callId: string,
  name: string,
  seconds: number,
): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: stamp(seconds),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name, arguments: { command: "grep needle" } }],
    },
  });
}

/** A database file the index cannot use, so every session is read directly. */
function unusableDb(db: string): string {
  const path = db.replace("search-v3.sqlite", "unusable.sqlite");
  const handle = new DatabaseSync(path);
  handle.exec("PRAGMA user_version = 9;");
  handle.close();
  return path;
}

const FILTERS: { label: string; filters: Filters }[] = [
  { label: "no query", filters: {} },
  { label: "literal needle", filters: { query: "needle" } },
  { label: "literal NEEDLE case-sensitive", filters: { query: "NEEDLE", caseSensitive: true } },
  { label: "literal needle kinds user", filters: { query: "needle", kinds: ["user"] } },
  { label: "regex n..dle", filters: { query: "n..dle", regex: true } },
  { label: "regex nee?dle", filters: { query: "nee?dle", regex: true } },
  { label: "regex ne+dle \\s\\w+", filters: { query: "ne+dle\\s\\w+", regex: true } },
  { label: "regex needle|kid", filters: { query: "needle|kid", regex: true } },
  { label: "regex [a-z]eedle (t|o)", filters: { query: "[a-z]eedle (t|o)", regex: true } },
  {
    label: "since/until",
    filters: { query: "needle", since: "2026-01-01T00:00:02Z", until: "2026-01-01T00:00:03Z" },
  },
  { label: "branch text", filters: { query: "branch" } },
  { label: "tool bash", filters: { tool: "bash" } },
  { label: "tool Search", filters: { tool: "Search" } },
  { label: "isError true", filters: { isError: true } },
  { label: "isError false", filters: { isError: false, query: "listed" } },
  {
    label: "since/until as ages",
    filters: {
      query: "needle",
      since: "12s",
      until: "8s",
      sinceMs: START - 12_000,
      untilMs: START - 8_000,
    },
  },
];

/** Run the tool to the end of its hits, following `after` (specs/search-tool.md#result). */
async function paged(
  h: ReturnType<typeof harness>,
  host: SearchHost,
  params: Record<string, unknown>,
  limit: number,
): Promise<string[]> {
  const addresses: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 500; page += 1) {
    const call: Record<string, unknown> = { ...params, limit };
    if (cursor !== undefined) call.after = cursor;
    const outcome = await h.call(host, call);
    assert.equal(outcome.isError, false, outcome.text);
    const lines = outcome.lines.filter(
      (line) => line.includes(" \u00b7 ") && !line.startsWith("---"),
    );
    const shown = lines.map((line) => line.slice(0, line.indexOf(" \u00b7 ")));
    addresses.push(...shown);
    const next = outcome.details.next;
    if (outcome.details.more !== true || typeof next !== "string") break;
    cursor = next;
  }
  return addresses;
}

/**
 * Run the tool to the end of its hits whether a page stops at the time budget or
 * reports more: a stopped page continues from its stop item (specs/search-tool.md#evaluation), a page
 * with more hits from its last hit (specs/search-tool.md#result).
 */
async function continued(
  h: ReturnType<typeof harness>,
  host: SearchHost,
  params: Record<string, unknown>,
  limit: number,
  onPage?: (outcome: Outcome, addresses: string[]) => void,
): Promise<string[]> {
  const addresses: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 500; page += 1) {
    const call: Record<string, unknown> = { ...params, limit };
    if (cursor !== undefined) call.after = cursor;
    const outcome = await h.call(host, call);
    assert.equal(outcome.isError, false, outcome.text);
    const lines = outcome.lines.filter(
      (line) => line.includes(" \u00b7 ") && !line.startsWith("---"),
    );
    const shown = lines.map((line) => line.slice(0, line.indexOf(" \u00b7 ")));
    addresses.push(...shown);
    onPage?.(outcome, shown);
    const next = outcome.details.next;
    if (typeof next !== "string") break;
    cursor = next;
  }
  return addresses;
}

test("the oracle and find agree over the matrix: scopes, filters, orders, branches, paging, index states", async () => {
  const made = layoutOf("search-tool-oracle-");
  const unusable = unusableDb(made.db);
  let runs = 0;
  for (const scope of ["session", "tree", "project", "project-trees"]) {
    for (const { label, filters } of FILTERS) {
      for (const order of ["newest", "oldest"] as const) {
        for (const branches of [false, true]) {
          for (const db of [made.db, unusable]) {
            for (const limit of [7, 100]) {
              const h = harness({ db });
              const params: Record<string, unknown> = {
                ...paramsOf(filters),
                action: "find",
                scope,
                order,
                branches,
              };
              const actual = await paged(h, made.host, params, limit);
              const expected = oracle(
                made.layout,
                scope,
                { ...filters, order, branches },
                Number.MAX_SAFE_INTEGER,
              );
              assert.deepEqual(
                actual,
                expected,
                `${scope} / ${label} / ${order} / branches ${branches} / ${db === made.db ? "index" : "direct"} / limit ${limit}`,
              );
              runs += 1;
            }
          }
        }
      }
    }
  }
  assert.equal(runs, 1024);
});

test("the oracle holds where the first trigram lookup overflows (more than 2001 matches)", async () => {
  const made = layoutOf("search-tool-oracle-overflow-");
  // A session whose 3000 items all contain the trigram, 100 of them at one time.
  const lines: string[] = [headerLine("bulk-session-0006")];
  let parent: string | null = null;
  for (let index = 0; index < 3000; index += 1) {
    const id = `n${index}`;
    lines.push(userLine(id, parent, `needle item ${index}`, index < 100 ? 1 : 2 + index));
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
        const h = harness({ db });
        const actual = await paged(
          h,
          made.host,
          { action: "find", query: "needle", scope, order },
          100,
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

/**
 * A fixture for the paths that are easy to leave uncovered: a main session above
 * 200000 items whose times cycle (every time group spans more than one page), and
 * five project members with one time group above the 50000-row cap. Above 200000
 * lines in total, so `project-trees` runs on the scan path while `tree` loads the
 * one session row by row.
 */
function bigLayout(prefix = "search-tool-oracle-big-"): {
  layout: Layout;
  host: SearchHost;
  db: string;
  sessions: string;
} {
  const made = fixture(prefix);
  const SELF_ENTRIES = 100050;
  const MEMBER_ENTRIES = 21000;
  const MEMBER_COUNT = 5;
  const T = 100;
  const U = 600;
  // The main session: 100050 assistant entries of two text parts each — 200100
  // items — entry i recorded at second T + (i % 400).
  const selfLines: string[] = [headerLine("main-session-0001")];
  let parent: string | null = null;
  for (let index = 0; index < SELF_ENTRIES; index += 1) {
    const id = `s${index}`;
    const first = index % 500 === 0 ? `needle special ${index}` : `filler row ${index} alpha beta`;
    const second = `filler part one ${index}`;
    selfLines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId: parent,
        timestamp: stamp(T + (index % 400)),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: first },
            { type: "text", text: second },
          ],
        },
      }),
    );
    parent = id;
  }
  writeFileSync(made.mainFile, `${selfLines.join("\n")}\n`);
  const members: OracleSession[] = [];
  for (let member = 1; member <= MEMBER_COUNT; member += 1) {
    const path = join(made.sessions, `p${member}.jsonl`);
    const lines: string[] = [headerLine(`mem${member}-session-000${member}`)];
    let kidParent: string | null = null;
    for (let index = 0; index < MEMBER_ENTRIES; index += 1) {
      const id = `m${member}x${index}`;
      if (index % 100 === 0) {
        const text = index % 10000 === 0 ? `zq filler ${index}` : `plain filler ${index}`;
        lines.push(userLine(id, kidParent, text, U));
      } else {
        lines.push(injectedLine(id, kidParent, "note", `quiet filler ${index}`, U));
      }
      kidParent = id;
    }
    if (member === 1) {
      lines.push(messageToolCall("mc", kidParent, "cz", "Bash", U + 1));
      lines.push(toolResultLine("mr", "mc", "Bash", "cz", "needle listed zq", true, U + 1));
    }
    writeFileSync(path, `${lines.join("\n")}\n`);
    members.push({ key: `~mem${member}-session-`, path });
  }
  return {
    layout: { self: { key: "self", path: made.mainFile }, members },
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
    db: made.db,
    sessions: made.sessions,
  };
}

/** The one big fixture the big tests share, built on first use. */
let sharedBig: ReturnType<typeof bigLayout> | undefined;

function big(): ReturnType<typeof bigLayout> {
  sharedBig ??= bigLayout();
  return sharedBig;
}

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
  // The same session read directly, without the index.
  const direct = harness({ db: unusableDb(made.db) });
  const directHits = await paged(
    direct,
    made.host,
    { action: "find", query: "needle special", scope: "session" },
    100,
  );
  assert.deepEqual(
    directHits,
    oracle(made.layout, "session", { query: "needle special" }, Number.MAX_SAFE_INTEGER),
  );
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
  // A filter dense past the collection cap (104790 injected items) falls back to
  // the windowed pages, alone and with a query whose trigrams overflow; a sparse
  // kind with that query is collected and probed. First 300 of each order.
  for (const order of ["newest", "oldest"] as const) {
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
