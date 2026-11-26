import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  START,
  fixture,
  harness,
  headerLine,
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
 * index, none of the tool's evaluation code — and the fixtures `oracle.test.ts`,
 * `oracle-matrix.test.ts` and `oracle-big.test.ts` compare `find` against it on.
 */

/** One session of a fixture, as the oracle knows it. */
export interface OracleSession {
  /** The session key relative to the invoking session (specs/session-transcript.md#session-tree and specs/session-transcript.md#project). */
  key: string;
  path: string;
}

/** The sessions a scope reaches, written out by hand from the fixture's layout. */
export interface Layout {
  self: OracleSession;
  kid?: OracleSession;
  deep?: OracleSession;
  other?: OracleSession;
  deepOther?: OracleSession;
  /** Project members added by a test. */
  members?: OracleSession[];
}

/** One transcript item with the session it belongs to and its ordering fields. */
export interface Placed {
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
export function literalPattern(query: string): string {
  return [...query].map((ch) => (LITERAL_SPECIALS.has(ch) ? `\\${ch}` : ch)).join("");
}

/** The regular expression of specs/search-tool.md#matching. */
export function expressionOf(query: string, regex: boolean, caseSensitive: boolean): RegExp {
  const pattern = regex ? query : literalPattern(query);
  return new RegExp(pattern, caseSensitive ? "m" : "mi");
}

/** The items of the session files a fixture holds, cached per path for the big fixtures. */
const placedCache = new Map<string, Placed[]>();

/** The items of one session file, read directly (specs/session-transcript.md#reading). */
export function placedItems(session: OracleSession): Placed[] {
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
export function comparePlaced(one: Placed, other: Placed): number {
  if (one.item.time !== other.item.time) return one.item.time - other.item.time;
  if (one.key !== other.key) return one.key < other.key ? -1 : 1;
  if (one.path !== other.path) return one.path < other.path ? -1 : 1;
  if (one.item.line !== other.item.line) return one.item.line - other.item.line;
  return compareParts(one.item.part, other.item.part);
}

/** The sessions of a scope (specs/search-tool.md#reach), written out from the fixture's layout. */
export function sessionsOf(layout: Layout, scope: string): OracleSession[] {
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
export interface Filters {
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
export function paramsOf(filters: Filters): Record<string, unknown> {
  const params: Record<string, unknown> = { ...filters };
  delete params.sinceMs;
  delete params.untilMs;
  return params;
}

/** True when the item passes every filter of specs/search-tool.md#candidates. */
export function passes(placed: Placed, filters: Filters, expression: RegExp | undefined): boolean {
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
export function oracle(
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
export function addressOf(placed: Placed): string {
  const part = placed.item.part === undefined ? "" : `.${placed.item.part}`;
  return `${placed.key}:${placed.item.entryId}${part}`;
}

/** The fixture: a main session with a branch, a child, a grandchild, and a project member with one. */
export function layoutOf(prefix: string): {
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
export function assistantToolCall(
  id: string,
  parentId: string | null,
  callId: string,
  name: string,
  seconds: number,
): string {
  return messageToolCall(id, parentId, callId, name, seconds);
}

/** The `message` line of a tool-call entry, spelled out for the oracle's fixture. */
export function messageToolCall(
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
export function unusableDb(db: string): string {
  const path = db.replace("search-v3.sqlite", "unusable.sqlite");
  const handle = new DatabaseSync(path);
  handle.exec("PRAGMA user_version = 9;");
  handle.close();
  return path;
}

export const FILTERS: { label: string; filters: Filters }[] = [
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
export async function paged(
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
export async function continued(
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

/**
 * A fixture for the paths that are easy to leave uncovered: a main session above
 * 200000 items whose times cycle (every time group spans more than one page), and
 * five project members with one time group above the 50000-row cap. Above 200000
 * lines in total, so `project-trees` runs on the scan path while `tree` loads the
 * one session row by row.
 */
export function bigLayout(prefix = "search-tool-oracle-big-"): {
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
