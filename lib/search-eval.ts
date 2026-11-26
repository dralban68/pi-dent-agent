/**
 * The evaluation engine of the `Search` tool (specs/search-tool.md): covering a
 * call's sessions by catch-up or by a direct read (specs/search-tool.md#coverage), the candidates
 * and the call's order (specs/search-tool.md#candidates and specs/search-tool.md#evaluation), matching (specs/search-tool.md#matching) with a
 * regular expression evaluated in a worker thread, evaluation (specs/search-tool.md#evaluation), and
 * the rendering of a hit line (specs/search-tool.md#result). `lib/search-tool.ts` owns the tool
 * surface: the parameter schema, validation, session resolution, and the actions.
 *
 * A `find` call costs what it shows, not what exists: candidates come from the
 * index in bounded pages in the call's order, one page at a time, and evaluation
 * stops as soon as the limit and one more hit are established. Every loop yields
 * to the event loop at least every 40 ms of work (specs/search-tool.md#abort), and the regular
 * expression runs in a worker the call can terminate, per item after 1000 ms.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { ToolResult } from "./engine.ts";
import { localStamp } from "./schedule-time.ts";
import {
  PROBE_BY_ID_ROWS,
  type CandidateFilter,
  type CatchUpContinuation,
  type IndexFileRow,
  type IndexItemRow,
  type SessionIndex,
} from "./session-index.ts";
import {
  compareParts,
  currentLineage,
  formatItemAddress,
  readSessionBytes,
  realPath,
  sessionItems,
  type ItemAddress,
  type ItemKind,
  type SessionEntry,
  type SessionHeader,
  type SessionRead,
  type TranscriptItem,
} from "./session-transcript.ts";
import { isPlainObject } from "./util.ts";
import { typeStrippingOptions } from "./worker-options.ts";

// ---------------------------------------------------------------------------
// Constants and terms
// ---------------------------------------------------------------------------

/** The tool name (specs/search-tool.md#registration); the own-calls rule of specs/search-tool.md#candidates names it exactly. */
export const SEARCH_TOOL_NAME = "Search";

/** The default `find` limit (specs/search-tool.md#parameter-schema). */
const FIND_LIMIT = 20;

/** The most bytes one chunk of a direct read consumes before the call yields. */
const READ_CHUNK_BYTES = 1048576;

/** The step limit `pageRows`: the rows one candidate page asks the index for (specs/search-tool.md#step-limits). */
const PAGE_ROWS = 256;

/** The step limits of a call (specs/search-tool.md#step-limits). */
export interface StepLimits {
  fileModeLines: number;
  windowRows: number;
  pageRows: number;
  groupRows: number;
  groupChunkRows: number;
  collectionRows: number;
  collectionChunkItems: number;
  firstLookupMatches: number;
  probeByIdRows: number;
}

/** The step limits the test seam may lower: every one but `pageRows` (specs/search-tool.md#test-seam). */
export type LoweredStepLimits = Partial<Omit<StepLimits, "pageRows">>;

/** The values of specs/search-tool.md#step-limits, which every runtime built without `limits` uses. */
export const STEP_LIMITS: Readonly<StepLimits> = Object.freeze({
  fileModeLines: 200000,
  windowRows: 100000,
  pageRows: PAGE_ROWS,
  groupRows: 50000,
  groupChunkRows: 20000,
  collectionRows: 20000,
  collectionChunkItems: 200000,
  firstLookupMatches: 2000,
  probeByIdRows: PROBE_BY_ID_ROWS,
});

/** The names of the lowered step limits, in the table order of specs/search-tool.md#step-limits. */
const LOWERED_NAMES = [
  "fileModeLines",
  "windowRows",
  "groupRows",
  "groupChunkRows",
  "collectionRows",
  "collectionChunkItems",
  "firstLookupMatches",
  "probeByIdRows",
] as const;

/**
 * The order the rules of specs/search-tool.md#test-seam keep: each pair is
 * `[lower, higher, strict]`, the lower limit below the higher one, or at most it
 * when not strict.
 */
const STEP_ORDER: readonly (readonly [keyof StepLimits, keyof StepLimits, boolean])[] = [
  ["pageRows", "groupRows", true],
  ["groupRows", "windowRows", true],
  ["windowRows", "fileModeLines", true],
  ["groupChunkRows", "groupRows", true],
  ["collectionRows", "groupRows", true],
  ["probeByIdRows", "firstLookupMatches", true],
  ["firstLookupMatches", "collectionRows", true],
  ["collectionRows", "collectionChunkItems", true],
  ["collectionChunkItems", "fileModeLines", false],
  ["probeByIdRows", "groupChunkRows", true],
];

/**
 * The step limits of a runtime: the values of specs/search-tool.md#step-limits,
 * with the lowered ones in their place. Throws a `RangeError` naming the limit
 * when a lowered value breaks a rule of specs/search-tool.md#test-seam.
 */
export function stepLimitsOf(lowered: LoweredStepLimits | undefined): StepLimits {
  const limits: StepLimits = { ...STEP_LIMITS };
  if (lowered === undefined) return limits;
  for (const name of LOWERED_NAMES) {
    const value = lowered[name];
    if (value === undefined) continue;
    const max = STEP_LIMITS[name];
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new RangeError(`step limit ${name} must be an integer from 1 to ${max}, not ${value}`);
    }
    limits[name] = value;
  }
  for (const [lower, higher, strict] of STEP_ORDER) {
    const low = limits[lower];
    const high = limits[higher];
    if (strict ? low < high : low <= high) continue;
    const relation = strict ? "less than" : "at most";
    throw new RangeError(
      `step limit ${lower} (${low}) must be ${relation} step limit ${higher} (${high})`,
    );
  }
  return limits;
}

/** The slots of a loaded session one narrowing probe answers for (specs/search-tool.md#evaluation). */
const PROBE_AHEAD = 256;

/** The most slots one evaluation window pulls before it evaluates them. */
const WINDOW_SLOTS = 32;

/** The milliseconds of work a call does before it yields to the event loop (specs/search-tool.md#abort). */
const YIELD_MS = 40;

/** The milliseconds one item's evaluation may run before the limit ends it (specs/search-tool.md#evaluation). */
export const ITEM_LIMIT_MS = 1000;

/** How often a wait for a regular-expression result re-checks abort and the deadline. */
const REGEX_POLL_MS = 5;

/** The characters of text before a match position that a snippet includes (specs/search-tool.md#result). */
const SNIPPET_BEFORE = 40;

/** The characters of text a snippet shows at most (specs/search-tool.md#result). */
const SNIPPET_LENGTH = 160;

/** The characters of a flattened label a hit line shows (specs/search-tool.md#result). */
const LABEL_LENGTH = 60;

/** The characters a literal query escapes (specs/search-tool.md#matching). */
const LITERAL_SPECIALS: ReadonlySet<string> = new Set([
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

/** The `action` a call performs (specs/search-tool.md#parameter-schema). */
export type SearchAction = "find" | "get" | "sessions";

/** How far a call reaches (specs/search-tool.md#reach). */
export type SearchScope = "session" | "tree" | "project" | "project-trees";

/** The order of a `find` call's hits (specs/search-tool.md#result). */
export type SearchOrder = "newest" | "oldest";

/** One session a call reaches (specs/search-tool.md#reach). */
export interface Reached {
  /** The session key relative to the invoking session. */
  key: string;
  /** The session file's absolute path, symbolic links not resolved. */
  path: string;
  /** The session file's path with symbolic links resolved. */
  resolvedPath: string;
  /** The session header; undefined for a session without a session file. */
  header: SessionHeader | undefined;
  /** The `<stem>`s from the root of its tree down to this member; empty for the root. */
  stems: string[];
  /** The index of its tree in the call's forest; 0 is the invoking session's tree. */
  tree: number;
}

/** The forest of reached sessions: the invoking session's tree, then one tree per project member. */
export interface Forest {
  trees: Reached[][];
  invoking: Reached;
}

/** Compare two strings by UTF-16 code units. */
export function compareStrings(one: string, other: string): number {
  if (one < other) return -1;
  if (one > other) return 1;
  return 0;
}

/** The invoking session, as the host sees it (specs/search-tool.md#reach). */
export interface SearchHost {
  /** The session file (specs/session-tool.md#result), or undefined when the session has none. */
  sessionFile: string | undefined;
  /** The session's agent directory (specs/agent-tool.md#child-session). */
  agentDirectory: string;
  /** Whether the invoking session is a main session. */
  main: boolean;
}

/**
 * A checkpoint of one call, reported so that a test can advance an injected clock
 * at a known point instead of sleeping. It reports no specified behavior.
 */
export interface SearchProgress {
  phase: "start" | "sizes" | "cover" | "read" | "evaluate" | "decide";
  /** The session key, for `cover`, `read`, and `evaluate`. */
  key?: string;
  /** For `cover`: whether the session is covered afterwards. */
  covered?: boolean;
}

/** The settings a validated call runs with. */
export interface Settings {
  query: string | undefined;
  regex: boolean;
  caseSensitive: boolean;
  kinds: readonly string[] | undefined;
  tool: string | undefined;
  isError: boolean | undefined;
  since: number | undefined;
  until: number | undefined;
  session: string | undefined;
  scope: SearchScope;
  branches: boolean;
  order: SearchOrder;
  after: string | undefined;
  limit: number | undefined;
  address: string | undefined;
  offset: number;
  context: number;
}

/** How one session of a call is covered (specs/search-tool.md#coverage). */
type CoverState = "pending" | "catchup" | "direct" | "uncovered" | "lost";

/** One session of a call, with what covering it produced. */
export interface Cover {
  session: Reached;
  /** The session file's modification time, milliseconds since the epoch; undefined without a file. */
  mtime: number | undefined;
  /** The session file's size when the call started; undefined without a session file. */
  size: number | undefined;
  state: CoverState;
  fileId: number | undefined;
  /** The consumed bytes the call's catch-up left (specs/search-tool.md#coverage). */
  consumed: number | undefined;
  /** The number of lines the index holds for the file, an estimate of its items (specs/search-tool.md#coverage). */
  lines: number | undefined;
  items: readonly TranscriptItem[] | undefined;
  onLineage: ReadonlySet<string> | undefined;
  /** Entry IDs of the lineage of the entries terminated when the call started, when recomputed. */
  lineageIds: ReadonlySet<string> | undefined;
  /** True when the call dropped the session after covering it (a stale row, a lost index). */
  dropped: boolean;
  /** The index generation when the catch-up completed (specs/search-tool.md#coverage). */
  generation: number;
}

/** One item of a covered session, with the fields the filters and the order need (specs/search-tool.md#find). */
export interface Slot {
  sessionKey: string;
  sessionPath: string;
  entryId: string;
  time: number;
  line: number;
  part: string | undefined;
  kind: ItemKind;
  /** The tool name with `A–Z` lowercased, for a `tool_call` or `tool_result` item; else null. */
  tool: string | null;
  isError: boolean;
  onLineage: boolean;
  /** True when the page's trigram narrowing excluded the item: decided, not a hit (specs/search-tool.md#evaluation). */
  narrowedOut: boolean;
  /** True while the narrowing of the item is still to be probed, before it is read (specs/search-tool.md#evaluation). */
  unprobed?: boolean | undefined;
  /** The index row of a catch-up session's item; absent for a direct read. */
  row: IndexItemRow | undefined;
  /** The item of a direct read; absent for a catch-up session's item. */
  item: TranscriptItem | undefined;
  /** The file ID of a catch-up session's item; absent for a direct read. */
  fileId: number | undefined;
}

/** One shown hit of a `find` call (specs/search-tool.md#result). */
export interface ShownHit {
  address: string;
  sessionKey: string;
  kind: ItemKind;
  label: string | undefined;
  isError: boolean | undefined;
  offLineage: boolean;
  time: number;
  length: number;
  at: number | undefined;
  snippet: string;
}

/** The query a `find` call matches with (specs/search-tool.md#matching and specs/search-tool.md#evaluation). */
export interface Query {
  pattern: string;
  flags: string;
  /** True when the pattern is the query verbatim; false when it is the escaped literal. */
  regex: boolean;
  /** The printable trigrams every candidate must contain; empty when the call cannot narrow. */
  trigrams: readonly string[];
}

/** The state of one call. */
export interface Call {
  settings: Settings;
  action: SearchAction;
  host: SearchHost;
  zone: string;
  now: () => number;
  /** Yield to the event loop when this call has done enough work since its last yield. */
  pace: () => Promise<void>;
  progress: ((event: SearchProgress) => void) | undefined;
  signal: AbortSignal | undefined;
  started: number;
  coveringDeadline: number;
  budgetDeadline: number;
  indexPath: string | undefined;
  busyTimeoutMs: number | undefined;
  bootDeadline: number | undefined;
  forest: Forest;
  index: SessionIndex | undefined;
  indexUnusable: string | undefined;
  failedWrite: string | undefined;
  covers: Cover[];
  query: Query | undefined;
  /** The item `after` names, when the call continues from one (specs/search-tool.md#result). */
  after: Slot | undefined;
  /** The cover of the session the key of `after` names, when it is a session of the call. */
  afterCover: Cover | undefined;
  /** True when the session the key of `after` names turned out not to be a session of the call. */
  afterLost: boolean;
  /** True when the session the key of `after` names was covered again by a direct read. */
  afterRecovered: boolean;
  /** The candidate sources of a `find` call, so that a lost session can be dropped from them. */
  sources: Source[];
  evaluator: PatternEvaluator | undefined;
  /** The header provider of this call's discovery, built once (specs/search-tool.md#abort). */
  headerOf: ((path: string) => SessionHeader | undefined) | undefined;
  /** A test seam: called for each item read back from a session file (specs/search-tool.md#evaluation). */
  onItemRead: (() => void) | undefined;
  /** True once the call has read the project into its forest (specs/search-tool.md#reach). */
  projectLoaded: boolean;
  /**
   * The index opening and `data_version` at which the call read its sessions'
   * `files` rows before covering: while both are unchanged no other connection has
   * committed since, and the rows the call's catch-ups left are still as they were
   * (specs/session-index.md#concurrent-access).
   */
  knownVersion: { generation: number; dataVersion: number } | undefined;
  /** How a regular-expression evaluator is made; a test may replace it (specs/search-tool.md#abort). */
  makeEvaluator: ((pattern: string, flags: string) => PatternEvaluator) | undefined;
  continuation: CatchUpContinuation | undefined;
  /** The runtime's step limits (specs/search-tool.md#step-limits). */
  limits: StepLimits;
}

export function textError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

export function isAborted(call: Call): boolean {
  return call.signal !== undefined && call.signal.aborted;
}

export function abortedResult(): ToolResult {
  return textError("Search aborted");
}

export function note(call: Call, event: SearchProgress): void {
  call.progress?.(event);
}

/** A turn of the event loop: timers, I/O callbacks, and other sessions proceed. */
function yieldTurn(): Promise<void> {
  return new Promise((resolveTurn) => {
    setImmediate(resolveTurn);
  });
}

/** A pacer: a call yields to the event loop after at most `YIELD_MS` of work (specs/search-tool.md#abort). */
export function makePacer(): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < YIELD_MS) return;
    last = performance.now();
    await yieldTurn();
  };
}

/** The current instant of the monotonic clock, in milliseconds. */
function nowMs(): number {
  return performance.now();
}

// ---------------------------------------------------------------------------
// specs/search-tool.md#coverage: covering
// ---------------------------------------------------------------------------

/** A session file's size and modification time, milliseconds rounded down. */
interface Stamp {
  size: number;
  mtime: number;
}

export function stampOf(path: string): Stamp | undefined {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return;
  }
  if (!stat.isFile()) return;
  return { size: stat.size, mtime: Math.floor(stat.mtimeMs) };
}

/** The covers of the call's sessions, in the covering order of specs/search-tool.md#coverage. */
export async function coversOf(
  call: Call,
  sessions: readonly Reached[],
  afterSession?: Reached | undefined,
): Promise<Cover[]> {
  // One stat per session, yielding between them (specs/search-tool.md#abort).
  const stamps: Array<Stamp | undefined> = [];
  for (const session of sessions) {
    await call.pace();
    stamps.push(stampOf(session.path));
  }
  const covers: Cover[] = sessions.map((session, index) => {
    const stamp = stamps[index];
    return {
      session,
      mtime: stamp === undefined ? undefined : stamp.mtime,
      size: stamp === undefined ? undefined : stamp.size,
      state: "pending",
      fileId: undefined,
      consumed: undefined,
      lines: undefined,
      items: undefined,
      onLineage: undefined,
      lineageIds: undefined,
      dropped: false,
      generation: 0,
    };
  });
  const ordered: Cover[] = [];
  const afterCover = covers.find((cover) => cover.session === afterSession);
  if (afterCover !== undefined) ordered.push(afterCover);
  const own = covers.find((cover) => cover.session === call.forest.invoking);
  if (own !== undefined && own !== afterCover) ordered.push(own);
  const rest = covers
    .filter((cover) => cover !== afterCover && cover !== own)
    .toSorted((one, other) => {
      const delta = (other.mtime ?? 0) - (one.mtime ?? 0);
      if (delta !== 0) return delta;
      return compareStrings(one.session.key, other.session.key);
    });
  const orderedCovers = [...ordered, ...rest];
  note(call, { phase: "sizes" });
  return orderedCovers;
}

/** A read of a session file in chunks, so the call yields between them. */
type ChunkedRead =
  | { kind: "read"; read: SessionRead }
  | { kind: "stopped" }
  | { kind: "unreadable" };

/** What one chunked read is bounded by. */
interface ReadOptions {
  /** The file position to read up to, not including: the size observed when the call started. */
  to: number;
  /** The most lines to use; no bound when absent. */
  maxLines?: number | undefined;
  /** The instant at which the read stops; no bound when absent. */
  deadline?: number | undefined;
  chunkBytes: number;
  call: Call;
  /** The session key the progress reports carry. */
  key: string;
}

/** The bytes at `offset` up to `length`, shorter when the file ends first. */
function readAt(fd: number, offset: number, length: number): Buffer | undefined {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    let read: number;
    try {
      read = readSync(fd, buffer, filled, length - filled, offset + filled);
    } catch {
      return;
    }
    if (read === 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled);
}

/**
 * One read of a session file by the call itself (specs/search-tool.md#coverage), in chunks: the
 * call yields to the event loop between chunks and stops at the deadline or the
 * abort. Every line a line feed terminated at the call's start is used, and no
 * unterminated last line is (specs/session-transcript.md#reading).
 */
export async function readSessionChunked(path: string, options: ReadOptions): Promise<ChunkedRead> {
  const call = options.call;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { kind: "unreadable" };
  }
  try {
    const entries: SessionEntry[] = [];
    const seen = new Set<string>();
    let header: SessionHeader | undefined;
    let from = 0;
    let line = 1;
    let lines = 0;
    let consumed = 0;
    let tailOffset = 0;
    let previousTime: number | undefined;
    let lastTime: number | undefined;
    let want = options.chunkBytes;
    while (from < options.to) {
      if (isAborted(call)) return { kind: "stopped" };
      if (options.deadline !== undefined && call.now() >= options.deadline) {
        return { kind: "stopped" };
      }
      if (options.maxLines !== undefined && lines >= options.maxLines) break;
      const length = Math.min(want, options.to - from);
      const window = readAt(fd, from, length);
      if (window === undefined) return { kind: "unreadable" };
      if (window.length === 0) break;
      const kept = cutLines(window, line, options.maxLines);
      if (kept.length === 0) break;
      const read = readSessionBytes(kept, { from, line, previousTime, seenIds: seen });
      if (read.consumed === from) {
        // No complete line in the window: one line is longer than the chunk.
        if (window.length < length) break;
        want = Math.min(want * 2, options.to - from);
        if (want <= window.length) break;
        continue;
      }
      for (const entry of read.entries) {
        entries.push(entry);
        seen.add(entry.entryId);
      }
      if (header === undefined) header = read.header;
      if (read.header !== undefined) seen.add(read.header.sessionId);
      line += read.lines;
      lines += read.lines;
      consumed = read.consumed;
      if (read.lines > 0) tailOffset = read.tailOffset;
      if (read.lastTime !== undefined) {
        lastTime = read.lastTime;
        previousTime = read.lastTime;
      }
      from = read.consumed;
      want = options.chunkBytes;
      note(call, { phase: "read", key: options.key });
      await yieldTurn();
    }
    return { kind: "read", read: { header, entries, consumed, lines, tailOffset, lastTime } };
  } finally {
    closeSync(fd);
  }
}

/**
 * The bytes of one chunk a read may use when it is bounded by a number of lines:
 * the chunk up to and including the line feed that ends line `maxLines`. Without
 * a bound, the chunk itself.
 */
function cutLines(window: Buffer, firstLine: number, maxLines: number | undefined): Buffer {
  if (maxLines === undefined) return window;
  const allowed = maxLines - (firstLine - 1);
  if (allowed <= 0) return window.subarray(0, 0);
  let seen = 0;
  let index = 0;
  for (;;) {
    const lineFeed = window.indexOf(0x0a, index);
    if (lineFeed < 0) return window;
    seen += 1;
    if (seen >= allowed) return window.subarray(0, lineFeed + 1);
    index = lineFeed + 1;
  }
}

/** Cover one session by a direct read, or leave it uncovered when the deadline ends first. */
export async function coverDirectly(
  call: Call,
  cover: Cover,
  deadline?: number | undefined,
): Promise<void> {
  const size = cover.size;
  if (size === undefined) {
    cover.state = "direct";
    cover.items = [];
    cover.onLineage = new Set();
    return;
  }
  const outcome = await readSessionChunked(cover.session.path, {
    to: size,
    deadline,
    chunkBytes: READ_CHUNK_BYTES,
    call,
    key: cover.session.key,
  });
  if (outcome.kind === "stopped") {
    cover.state = "uncovered";
    return;
  }
  if (outcome.kind === "unreadable" || outcome.read.header === undefined) {
    // A file the call cannot open, or that is not readable as a session file, is not
    // a session of the call (specs/search-tool.md#coverage).
    cover.state = "lost";
    return;
  }
  cover.state = "direct";
  cover.items = sessionItems(outcome.read.entries);
  cover.onLineage = new Set(currentLineage(outcome.read.entries).map((entry) => entry.entryId));
}

/** Record the index's own view of its health after an operation (specs/session-index.md#failures). */
export function refreshIndexState(call: Call): void {
  const index = call.index;
  if (index === undefined) return;
  const unusable = index.unusableReason();
  if (unusable !== undefined && call.indexUnusable === undefined) call.indexUnusable = unusable;
  const failed = index.failedWriteReason();
  if (failed !== undefined && call.failedWrite === undefined) call.failedWrite = failed;
}

/**
 * Cover one session by a catch-up, or by a direct read where specs/search-tool.md#coverage says so.
 * `known` holds the `files` rows read for the whole call in one statement; a row
 * that already describes the file makes the catch-up complete without a read
 * (specs/session-index.md#catch-up, step 2).
 */
async function coverOne(call: Call, cover: Cover, known: KnownFiles): Promise<void> {
  if (cover.size === undefined) {
    cover.state = "direct";
    cover.items = [];
    cover.onLineage = new Set();
    return;
  }
  if (call.indexUnusable !== undefined || call.failedWrite !== undefined) {
    await coverDirectly(call, cover, call.coveringDeadline);
    return;
  }
  const index = call.index;
  if (index === undefined) {
    call.indexUnusable = "the index is not open";
    await coverDirectly(call, cover, call.coveringDeadline);
    return;
  }
  // The file at the index path may have been replaced since its rows were read:
  // the fast path may compare `generation` only against the file there now
  // (specs/search-tool.md#sessions).
  const refreshed = index.refreshNow();
  refreshIndexState(call);
  const knownRow = known.get(cover.session.resolvedPath);
  if (
    refreshed &&
    knownRow !== undefined &&
    known.generation === index.generation &&
    knownRow.consumed === cover.size &&
    knownRow.mtime === cover.mtime
  ) {
    // The catch-up would change nothing: the file is unchanged since the row was written.
    cover.state = "catchup";
    cover.fileId = knownRow.fileId;
    cover.consumed = knownRow.consumed;
    cover.lines = knownRow.lines;
    cover.generation = index.generation;
    return;
  }
  const outcome = await index.catchUp(cover.session.path, {
    deadline: call.coveringDeadline,
    now: call.now,
    aborted: () => isAborted(call),
  });
  refreshIndexState(call);
  if (outcome.status === "complete") {
    const row = index.fileFor(cover.session.path);
    if (!row.ok) {
      refreshIndexState(call);
      await coverDirectly(call, cover, call.coveringDeadline);
      return;
    }
    const file = row.value;
    if (file === undefined) {
      // The file is absent or not a session file: it is not a session of the call.
      cover.state = "lost";
      return;
    }
    if (file.consumed > (cover.size ?? 0)) {
      // The consumed bytes hold entries terminated after the call started, so the
      // lineage column cannot be used as it stands (specs/search-tool.md#coverage): read the file.
      await coverDirectly(call, cover, call.coveringDeadline);
      return;
    }
    cover.state = "catchup";
    cover.fileId = file.fileId;
    cover.consumed = file.consumed;
    cover.lines = file.lines;
    cover.generation = index.generation;
    return;
  }
  if (outcome.status === "incomplete") return;
  if (outcome.status === "not-session") {
    cover.state = "lost";
    return;
  }
  await coverDirectly(call, cover, call.coveringDeadline);
}

/**
 * Cover the call's sessions in the order of specs/search-tool.md#coverage. A catch-up or a direct
 * read still running 3000 ms after the call started is abandoned; only the two
 * exception sessions — the one session of a call with exactly one, and the
 * session the key of `after` names — are bounded by the time budget alone.
 */
export async function coverSessions(
  call: Call,
  exceptions: readonly (Reached | undefined)[],
): Promise<void> {
  await call.pace();
  const known = await knownFiles(call);
  for (const cover of call.covers) {
    if (isAborted(call)) return;
    if (call.now() >= call.coveringDeadline) break;
    await call.pace();
    await coverOne(call, cover, known);
    note(call, { phase: "cover", key: cover.session.key, covered: isCovered(cover) });
  }
  for (const session of exceptions) {
    if (session === undefined) continue;
    const cover = call.covers.find((candidate) => candidate.session === session);
    if (cover === undefined) continue;
    if (cover.state === "catchup" || cover.state === "direct") continue;
    await coverDirectly(call, cover, call.budgetDeadline);
    note(call, { phase: "cover", key: cover.session.key, covered: isCovered(cover) });
  }
}

/** The `files` rows of the call's sessions, with the index generation they were read at. */
interface KnownFiles extends ReadonlyMap<string, IndexFileRow> {
  generation: number;
}

/** The `files` rows of the call's sessions, read once (specs/search-tool.md#abort; specs/session-index.md#concurrent-access). */
async function knownFiles(call: Call): Promise<KnownFiles> {
  const index = call.index;
  const known = new Map<string, IndexFileRow>();
  if (index === undefined || call.indexUnusable !== undefined) {
    return Object.assign(known, { generation: -1 });
  }
  // The paths were resolved once, when the session was found (specs/search-tool.md#reach); the
  // index stores them resolved (specs/session-index.md#schema).
  const paths: string[] = [];
  for (const cover of call.covers) {
    if (cover.size === undefined) continue;
    paths.push(cover.session.resolvedPath);
  }
  const generation = index.generation;
  const outcome = index.filesForResolvedPaths(paths);
  refreshIndexState(call);
  if (!outcome.ok) return Object.assign(known, { generation: -1 });
  for (const row of outcome.value.rows) known.set(row.path, row);
  call.knownVersion = { generation, dataVersion: outcome.value.dataVersion };
  return Object.assign(known, { generation });
}

export function isCovered(cover: Cover): boolean {
  if (cover.dropped) return false;
  return cover.state === "catchup" || cover.state === "direct";
}

/** Reset the file of a stale row, in one transaction (specs/session-index.md#catch-up). */
export async function resetStaleRow(
  call: Call,
  row: IndexItemRow,
  deadline?: number | undefined,
): Promise<void> {
  const index = call.index;
  if (index === undefined) return;
  await index.resetStale(row, {
    deadline,
    now: call.now,
    aborted: () => isAborted(call),
  });
  refreshIndexState(call);
}

// ---------------------------------------------------------------------------
// specs/search-tool.md#find: candidates and order
// ---------------------------------------------------------------------------

/** True when `value` is an item kind (specs/session-transcript.md#transcript-items). */
function isItemKind(value: string): value is ItemKind {
  switch (value) {
    case "user":
    case "system":
    case "assistant":
    case "thinking":
    case "tool_call":
    case "tool_result":
    case "injected":
    case "summary":
    case "error":
      return true;
    default:
      return false;
  }
}

/** The letters `A–Z` of a string converted to lowercase and no other character (specs/search-tool.md#candidates). */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Transcript order of two slots (specs/session-transcript.md#transcript-order). */
export function compareSlots(one: Slot, other: Slot): number {
  if (one.time !== other.time) return one.time - other.time;
  if (one.sessionKey !== other.sessionKey) return compareStrings(one.sessionKey, other.sessionKey);
  if (one.sessionPath !== other.sessionPath) {
    return compareStrings(one.sessionPath, other.sessionPath);
  }
  if (one.line !== other.line) return one.line - other.line;
  return compareParts(one.part, other.part);
}

/** The call's order of two slots: transcript order, reversed for `newest` (specs/search-tool.md#evaluation). */
export function compareCallOrder(one: Slot, other: Slot, newest: boolean): number {
  const base = compareSlots(one, other);
  return newest ? -base : base;
}

/** The slot of one index row of a catch-up session. */
function slotOfRow(
  cover: Cover,
  row: IndexItemRow,
  narrowedOut: boolean,
  lineageIds: ReadonlySet<string> | undefined,
): Slot | undefined {
  if (!isItemKind(row.kind)) return;
  return {
    sessionKey: cover.session.key,
    sessionPath: cover.session.resolvedPath,
    entryId: row.entryId,
    time: row.time,
    line: row.line,
    part: row.part === "" ? undefined : row.part,
    kind: row.kind,
    tool: row.tool,
    isError: row.isError,
    onLineage: lineageIds === undefined ? row.lineage : lineageIds.has(row.entryId),
    narrowedOut,
    row,
    item: undefined,
    fileId: row.fileId,
  };
}

/** The slot of one item of a direct read. */
export function slotOfItem(cover: Cover, item: TranscriptItem): Slot {
  let toolName: string | null = null;
  if (item.kind === "tool_call" || item.kind === "tool_result") {
    toolName = item.label === undefined ? null : asciiLower(item.label);
  }
  return {
    sessionKey: cover.session.key,
    sessionPath: cover.session.resolvedPath,
    entryId: item.entryId,
    time: item.time,
    line: item.line,
    part: item.part,
    kind: item.kind,
    tool: toolName,
    isError: item.isError,
    onLineage: cover.onLineage?.has(item.entryId) === true,
    narrowedOut: false,
    row: undefined,
    item,
    fileId: undefined,
  };
}

// ---------------------------------------------------------------------------
// specs/search-tool.md#evaluation: candidate sources
// ---------------------------------------------------------------------------

/** One source of candidates in the call's order. */
export interface Source {
  /** The next slot in the call's order, without consuming it; undefined when exhausted. */
  peek(): Promise<Slot | undefined>;
  /** Consume the slot `peek` returned. */
  take(): Slot | undefined;
  /** True when the source contributes nothing more. */
  readonly dropped: boolean;
  /** True when the source stopped because the time budget or the abort ended it (specs/search-tool.md#evaluation). */
  readonly stopped: boolean;
  /** Drop one session's remaining candidates, when the source holds several (specs/search-tool.md#coverage). */
  dropFile?(fileId: number): void;
  /** The item time the source can reach, for the merge's lazy loading (specs/search-tool.md#evaluation). */
  reach(): number;
}

/** A list of slots in the call's order: one directly read session, or one loaded catch-up session. */
class SlotListSource implements Source {
  private readonly slots: Slot[];
  private cursor = 0;
  private head: Slot | undefined;
  private readonly limit: number;
  dropped = false;
  readonly stopped = false;

  constructor(slots: readonly Slot[], newest: boolean, limit: number) {
    this.slots = slots.toSorted((one, other) => compareCallOrder(one, other, newest));
    this.limit = limit;
  }

  /** Drop the items at or before `after` (specs/search-tool.md#evaluation). */
  startAfter(after: Slot | undefined, newest: boolean): void {
    if (after === undefined) return;
    while (this.cursor < this.slots.length) {
      const slot = this.slots[this.cursor];
      if (slot === undefined || compareCallOrder(slot, after, newest) > 0) break;
      this.cursor += 1;
    }
  }

  async peek(): Promise<Slot | undefined> {
    if (this.head !== undefined) return this.head;
    if (this.dropped) return;
    const slot = this.slots[this.cursor];
    if (slot === undefined) return;
    this.cursor += 1;
    this.head = slot;
    return slot;
  }

  take(): Slot | undefined {
    const head = this.head;
    this.head = undefined;
    return head;
  }

  /** The head and up to `count - 1` slots after it, in the call's order. */
  upcoming(count: number): Slot[] {
    const ahead: Slot[] = [];
    if (this.head !== undefined) ahead.push(this.head);
    for (let index = this.cursor; index < this.slots.length && ahead.length < count; index += 1) {
      const slot = this.slots[index];
      if (slot !== undefined) ahead.push(slot);
    }
    return ahead;
  }

  reach(): number {
    return this.limit;
  }
}

/** The exact greatest and least item time of one session file, cached across calls (specs/search-tool.md#coverage). */
interface TimeBounds {
  size: number;
  mtime: number;
  max: number;
  min: number;
}

const timeBoundsCache = new Map<string, TimeBounds>();

/** The exact time bounds of one session file's items, from the index or the cache (specs/search-tool.md#evaluation). */
function timeBoundsOf(call: Call, cover: Cover): { max: number; min: number } | undefined {
  const index = call.index;
  const fileId = cover.fileId;
  if (index === undefined || fileId === undefined) return;
  const key = `${call.indexPath ?? ""}\u0000${realPath(cover.session.path)}`;
  const size = cover.size ?? 0;
  const mtime = cover.mtime ?? 0;
  const cached = timeBoundsCache.get(key);
  if (cached !== undefined && cached.size === size && cached.mtime === mtime) {
    return { max: cached.max, min: cached.min };
  }
  const outcome = index.itemTimeBounds(fileId);
  refreshIndexState(call);
  if (!outcome.ok) return;
  const value = outcome.value;
  if (value === undefined) return;
  timeBoundsCache.set(key, { size, mtime, max: value.max, min: value.min });
  return value;
}

/**
 * One catch-up session's candidates, loaded row by row through the
 * `(file_id, line, part)` index when the call loads its sessions instead of
 * scanning the time order (specs/search-tool.md#evaluation). The rows are fetched on first need, so a
 * call that shows its first hits at once never loads the sessions below them.
 */
class FileSource implements Source {
  private readonly call: Call;
  private readonly cover: Cover;
  private readonly newest: boolean;
  private readonly limit: number;
  private inner: SlotListSource | undefined;
  private failed = false;
  dropped = false;
  readonly stopped = false;

  constructor(call: Call, cover: Cover, newest: boolean, limit: number) {
    this.call = call;
    this.cover = cover;
    this.newest = newest;
    this.limit = limit;
  }

  async peek(): Promise<Slot | undefined> {
    if (this.dropped) return;
    if (this.inner === undefined) {
      this.inner = await this.load();
      if (this.inner === undefined) {
        this.dropped = true;
        return;
      }
      this.inner.startAfter(this.call.after, this.newest);
    }
    const slot = await this.inner.peek();
    if (slot?.unprobed === true) {
      await this.probeAhead(this.inner);
      if (this.dropped) return;
    }
    return slot;
  }

  /**
   * Probe the narrowing of the next slots in the call's order, up to
   * `PROBE_AHEAD` of them, from one read transaction that also re-reads their
   * rows' identities and the session's `files` row: an item gone or replaced
   * since the session was loaded takes the session's cover away, so a probe
   * answers exactly for the rows the session was loaded with (specs/search-tool.md#coverage and
   * specs/search-tool.md#evaluation). The cost is that of the slots probed, not of the index's matches.
   */
  private async probeAhead(inner: SlotListSource): Promise<void> {
    const call = this.call;
    const index = call.index;
    const fileId = this.cover.fileId;
    const slots = inner.upcoming(PROBE_AHEAD).filter((slot) => slot.unprobed === true);
    const rows: IndexItemRow[] = [];
    for (const slot of slots) if (slot.row !== undefined) rows.push(slot.row);
    if (index === undefined || fileId === undefined) {
      this.dropped = true;
      this.cover.dropped = true;
      return;
    }
    await call.pace();
    const outcome = index.probeRows(rows, call.query?.trigrams ?? [], fileId);
    refreshIndexState(call);
    if (!outcome.ok || !outcome.value.intact) {
      this.dropped = true;
      this.cover.dropped = true;
      return;
    }
    this.checkCovers(outcome.value.files);
    if (this.dropped) return;
    for (const slot of slots) {
      slot.unprobed = false;
      slot.narrowedOut = slot.row === undefined || !outcome.value.matched.has(slot.row.itemId);
    }
  }

  take(): Slot | undefined {
    return this.inner?.take();
  }

  reach(): number {
    return this.limit;
  }

  /** Load the session's rows, or undefined when the index cannot answer (specs/search-tool.md#coverage). */
  private async load(): Promise<SlotListSource | undefined> {
    const call = this.call;
    const index = call.index;
    const fileId = this.cover.fileId;
    if (index === undefined || fileId === undefined) return;
    await call.pace();
    // The session is loaded whole: no row cap may cut it silently, whatever its
    // item count (specs/search-tool.md#evaluation). The mode choice in `sourcesOf` bounds which
    // sessions come here.
    const filter: CandidateFilter = {
      newest: this.newest,
      bound: this.newest ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
      limit: -1,
      fileIds: [fileId],
      ...sqlFiltersOf(call),
    };
    // A literal query with a printable trigram narrows before anything is read
    // back from the session file (specs/search-tool.md#evaluation).
    const trigrams = call.query?.trigrams ?? [];
    if (trigrams.length > 0) {
      filter.trigrams = trigrams;
      filter.narrowFirst = call.limits.firstLookupMatches;
    }
    let outcome = index.candidatePage(filter);
    refreshIndexState(call);
    if (!outcome.ok) return;
    let unprobed = false;
    if (outcome.value.overflow) {
      // More matches in the index than `narrowFirst` admits: the session's own rows,
      // whose narrowing is probed as the call reaches them (`probeAhead`), so the
      // cost follows the hits shown rather than the index's matches (specs/search-tool.md#evaluation).
      filter.narrowFirst = undefined;
      filter.trigrams = undefined;
      outcome = index.candidatePage(filter);
      refreshIndexState(call);
      if (!outcome.ok) return;
      unprobed = true;
    }
    this.checkCovers(outcome.value.files);
    const slots = this.slotsOf(outcome.value.rows, outcome.value.matched);
    if (slots === undefined) return;
    if (unprobed) for (const slot of slots) slot.unprobed = true;
    return new SlotListSource(slots, this.newest, this.limit);
  }

  /** Check the cover of the session this page names (specs/search-tool.md#coverage; specs/session-index.md#concurrent-access). */
  private checkCovers(files: readonly IndexFileRow[]): void {
    const index = this.call.index;
    for (const file of files) {
      if (file.fileId !== this.cover.fileId) continue;
      const consumed = this.cover.consumed ?? 0;
      // Another path under this `file_id`: the index file was opened anew (specs/search-tool.md#coverage).
      if (file.consumed < consumed || file.path !== this.cover.session.resolvedPath) {
        this.dropped = true;
        this.cover.dropped = true;
        return;
      }
      if (file.consumed > consumed && this.cover.lineageIds === undefined) {
        const lineage = index?.lineageWithin(file.fileId, this.cover.size ?? 0);
        refreshIndexState(this.call);
        if (lineage !== undefined && lineage.ok) this.cover.lineageIds = new Set(lineage.value);
        else if (lineage !== undefined) this.cover.lineageIds = new Set();
      }
    }
  }

  /** The slots of one page, or undefined when the session is no longer covered (specs/search-tool.md#coverage). */
  private slotsOf(
    rows: readonly IndexItemRow[],
    matched: ReadonlySet<number> | undefined,
  ): Slot[] | undefined {
    const cover = this.cover;
    if (cover.dropped) return;
    const slots: Slot[] = [];
    for (const row of rows) {
      // A row of another path under this `file_id` is from an index file opened
      // anew during the call, and never an item of this session (specs/search-tool.md#coverage).
      if (row.path !== cover.session.resolvedPath) continue;
      if (row.offset + row.bytes + 1 > (cover.size ?? 0)) continue;
      const narrowedOut = matched !== undefined && !matched.has(row.itemId);
      const slot = slotOfRow(cover, row, narrowedOut, cover.lineageIds);
      if (slot !== undefined) slots.push(slot);
    }
    return slots;
  }
}

/**
 * The index's candidates of every catch-up session, scanned in the time order of
 * `items_time` in bounded pages (specs/search-tool.md#abort), restricted to the call's files
 * (specs/search-tool.md#evaluation), with the filters SQL can express applied in the statement. Every
 * page checks the abort signal and the budget, and the page's own trigram matches
 * decide its rows. A call whose query narrows by trigrams pages through the index
 * directly; a trigramless call — no query, or one without a printable run of
 * three — scans in bounded time windows, so that no one statement runs long
 * however sparse its matches are.
 */
class ScanSource implements Source {
  private readonly call: Call;
  private readonly newest: boolean;
  private readonly coversByFile = new Map<number, Cover>();
  private readonly droppedFiles = new Set<number>();
  private bound: number;
  private done = false;
  private first = true;
  private slots: Slot[] = [];
  private cursor = 0;
  private head: Slot | undefined;
  private stopFlag = false;
  /** True when the call narrows by trigrams (specs/search-tool.md#evaluation). */
  private readonly narrowed: boolean;
  /**
   * The collection of a call whose SQL filters may be sparse: undefined before it
   * runs, `dense` once it found more rows than it keeps, `done` once it answered.
   */
  private collection: "dense" | "done" | undefined;
  /** The far end of the current window's time range, until its pages are done. */
  private windowLow: number | undefined;
  /** True once no further window exists: the remaining items are one open range. */
  private lastWindow = false;
  private groupTime: number | undefined;
  private groupQueue: Array<{ fileId: number; line: number }> = [];
  /** The index's file count, read once (specs/search-tool.md#abort). */
  private fileTotal: number | undefined;

  constructor(call: Call, covers: readonly Cover[]) {
    this.call = call;
    this.newest = call.settings.order === "newest";
    this.narrowed = (call.query?.trigrams.length ?? 0) > 0;
    // Paging starts at the `after` item's position, so that the cost of page N does
    // not grow with N (specs/search-tool.md#result).
    const after = call.after;
    const start = after === undefined ? undefined : after.time;
    this.bound = start ?? (this.newest ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    for (const cover of covers) {
      if (cover.state !== "catchup" || cover.fileId === undefined) continue;
      this.coversByFile.set(cover.fileId, cover);
    }
  }

  get dropped(): boolean {
    return false;
  }

  get stopped(): boolean {
    return this.stopFlag;
  }

  reach(): number {
    return this.newest ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }

  /** Drop one session's remaining candidates (specs/search-tool.md#coverage). */
  dropFile(fileId: number): void {
    this.droppedFiles.add(fileId);
  }

  /** Drop every session's remaining candidates: the index became unusable (specs/search-tool.md#coverage). */
  dropAll(): void {
    for (const fileId of this.coversByFile.keys()) this.droppedFiles.add(fileId);
    this.done = true;
    this.slots = [];
  }

  async peek(): Promise<Slot | undefined> {
    if (this.head !== undefined) return this.head;
    for (;;) {
      if (isAborted(this.call)) {
        this.stopFlag = true;
        return;
      }
      if (this.call.now() >= this.call.budgetDeadline) {
        this.stopFlag = true;
        return;
      }
      const slot = this.slots[this.cursor];
      if (slot !== undefined) {
        this.cursor += 1;
        if (slot.fileId !== undefined && this.droppedFiles.has(slot.fileId)) continue;
        this.head = slot;
        return slot;
      }
      if (this.groupTime !== undefined) {
        await this.fetchGroupChunk();
        continue;
      }
      if (this.done) return;
      await this.fetchPage();
    }
  }

  take(): Slot | undefined {
    const head = this.head;
    this.head = undefined;
    return head;
  }

  /**
   * The page's filter: the time bound and the window, the call's files named in
   * the statement only when they are a small part of the index, where the file
   * index serves them cheaply, and the filters SQL can express (specs/search-tool.md#evaluation).
   */
  private filter(limit: number): CandidateFilter {
    const filter: CandidateFilter = {
      newest: this.newest,
      bound: this.bound,
      limit,
      ...sqlFiltersOf(this.call),
    };
    if (this.windowLow !== undefined) filter.withinTime = this.windowLow;
    const fileIds = [...this.coversByFile.keys()].filter((id) => !this.droppedFiles.has(id));
    if (this.fileTotal === undefined) {
      const total = this.call.index?.fileCount();
      if (total !== undefined && total.ok) this.fileTotal = total.value;
    }
    // The statement always names the call's files, so rows of other sessions are
    // dropped inside SQLite and never probed or built (specs/search-tool.md#evaluation). Where the
    // files are a large part of the index the time order still leads the read.
    filter.fileIds = fileIds;
    const total = this.fileTotal;
    if (total === undefined || fileIds.length * 4 > total) filter.fileIdsFilterOnly = true;
    return filter;
  }

  /**
   * One page of candidates (specs/search-tool.md#abort and specs/search-tool.md#evaluation). With narrowing, the first page
   * probes the trigram matches once and selects its rows by them; on overflow the
   * pages narrow by their own rows. Without narrowing, the page is bounded by a
   * time window of `windowRows` items, computed by one indexed statement, so a
   * page with no matches cannot walk to the end of the index.
   */
  private async fetchPage(): Promise<void> {
    const call = this.call;
    const index = call.index;
    if (index === undefined || call.indexUnusable !== undefined) {
      this.done = true;
      return;
    }
    if (this.first && this.narrowed) {
      // The trigram matches of the whole index, when there are few: the rows are
      // selected by them in one page and the source is done (specs/search-tool.md#evaluation).
      this.first = false;
      const filter = this.filter(PAGE_ROWS);
      if (filter.fileIds !== undefined && filter.fileIds.length === 0) {
        this.done = true;
        return;
      }
      filter.trigrams = call.query?.trigrams ?? [];
      filter.narrowFirst = call.limits.firstLookupMatches;
      filter.limit = call.limits.firstLookupMatches;
      await call.pace();
      const outcome = index.candidatePage(filter);
      refreshIndexState(call);
      if (!outcome.ok) {
        this.done = true;
        return;
      }
      if (!outcome.value.overflow) {
        this.checkCovers(outcome.value.files);
        this.slots = this.slotsOf(outcome.value.rows, outcome.value.matched);
        this.cursor = 0;
        this.done = true;
        return;
      }
    }
    this.first = false;
    if (this.collection === undefined && hasSparseFilter(call)) {
      await this.collect();
      if (this.stopFlag || this.collection === "done") return;
    }
    for (;;) {
      await call.pace();
      if (isAborted(call) || call.now() >= call.budgetDeadline) {
        this.stopFlag = true;
        return;
      }
      if (this.windowLow === undefined && !this.lastWindow) {
        // The far end of the next window: the time of its last item in the call's order.
        const boundary = index.windowBoundary(this.newest, this.bound, call.limits.windowRows);
        refreshIndexState(call);
        if (!boundary.ok) {
          this.done = true;
          return;
        }
        if (boundary.value === undefined) this.lastWindow = true;
        else this.windowLow = boundary.value;
        continue;
      }
      const filter = this.filter(PAGE_ROWS);
      if (filter.fileIds !== undefined && filter.fileIds.length === 0) {
        this.done = true;
        return;
      }
      if (this.narrowed) filter.trigrams = call.query?.trigrams ?? [];
      const outcome = index.candidatePage(filter);
      refreshIndexState(call);
      if (!outcome.ok) {
        this.done = true;
        return;
      }
      const page = outcome.value;
      await call.pace();
      if (isAborted(call) || call.now() >= call.budgetDeadline) {
        this.stopFlag = true;
        return;
      }
      this.checkCovers(page.files);
      const low = this.windowLow;
      if (page.rows.length === 0) {
        if (this.lastWindow) {
          this.done = true;
          return;
        }
        // Nothing in the window passes: on to the next one.
        this.windowLow = undefined;
        if (low !== undefined) this.bound = this.newest ? low - 1 : low + 1;
        continue;
      }
      const times = page.rows.map((row) => row.time);
      const boundaryTime = this.newest ? Math.min(...times) : Math.max(...times);
      let rows = page.rows;
      let matched = page.matched;
      if (page.rows.length >= PAGE_ROWS) {
        // A full page was cut by its limit, so the boundary time's group is
        // completed before the scan moves past it (specs/search-tool.md#evaluation).
        const group = await this.completeGroup(page.rows, boundaryTime, page.matched);
        if (this.stopFlag) return;
        if (group.groupWalk) {
          // The boundary time's group is above the cap: the page's own rows at that
          // time are dropped, and the group is walked in the call's order instead.
          rows = page.rows.filter((row) => row.time !== boundaryTime);
        } else {
          rows = group.rows;
          matched = group.matched;
        }
        this.bound = this.newest ? boundaryTime - 1 : boundaryTime + 1;
        if (boundaryTime === low) this.windowLow = undefined;
      } else {
        // A short page holds every row of the window that passes: the window is used up.
        this.windowLow = undefined;
        if (this.lastWindow) this.done = true;
        else if (low !== undefined) this.bound = this.newest ? low - 1 : low + 1;
      }
      this.slots = this.slotsOf(rows, matched);
      this.cursor = 0;
      return;
    }
  }

  /**
   * The collection of a call with a filter SQL can apply and that may be sparse
   * (`kinds`, `tool`, `isError`): the IDs of the rows that pass, read in chunks in
   * `item_id` order, which costs the same whatever the rows' times. When at most
   * `collectionRows` rows pass, they are every candidate of the call: they are
   * ordered and the source is done, every other item decided by the filters
   * (specs/search-tool.md#evaluation). More, and the filter is dense: the windowed pages take over,
   * and find their rows at once.
   */
  private async collect(): Promise<void> {
    const call = this.call;
    const index = call.index;
    if (index === undefined) return;
    const { collectionRows, collectionChunkItems } = call.limits;
    const base = this.filter(collectionRows + 1);
    base.withinTime = undefined;
    const ids: number[] = [];
    const chunks: Array<{ after: number; upTo: number }> = [];
    const byRange = base.fileIds === undefined || base.fileIdsFilterOnly === true;
    if (byRange) {
      const top = index.maxItemId();
      refreshIndexState(call);
      if (!top.ok) {
        this.collection = "dense";
        return;
      }
      for (let after = 0; after < top.value; after += collectionChunkItems) {
        chunks.push({ after, upTo: Math.min(top.value, after + collectionChunkItems) });
      }
    }
    const fileChunks: number[][] = [];
    if (!byRange && base.fileIds !== undefined) {
      for (let start = 0; start < base.fileIds.length; start += COLLECT_CHUNK_FILES) {
        fileChunks.push(base.fileIds.slice(start, start + COLLECT_CHUNK_FILES));
      }
    }
    const steps = byRange ? chunks.length : fileChunks.length;
    for (let step = 0; step < steps; step += 1) {
      await call.pace();
      if (isAborted(call) || call.now() >= call.budgetDeadline) {
        this.stopFlag = true;
        return;
      }
      const filter: CandidateFilter = { ...base, limit: collectionRows + 1 - ids.length };
      const chunk = chunks[step];
      const files = fileChunks[step];
      if (files !== undefined) filter.fileIds = files;
      const outcome = index.candidateIds(filter, chunk?.after ?? 0, chunk?.upTo ?? 0);
      refreshIndexState(call);
      if (!outcome.ok) {
        this.collection = "dense";
        return;
      }
      for (const id of outcome.value) ids.push(id);
      if (ids.length > collectionRows) {
        this.collection = "dense";
        return;
      }
    }
    await call.pace();
    if (isAborted(call) || call.now() >= call.budgetDeadline) {
      this.stopFlag = true;
      return;
    }
    const filter = this.filter(-1);
    filter.withinTime = undefined;
    if (this.narrowed) filter.trigrams = call.query?.trigrams ?? [];
    const rows = index.rowsOfIds(filter, ids);
    refreshIndexState(call);
    if (!rows.ok) {
      this.collection = "dense";
      return;
    }
    this.checkCovers(rows.value.files);
    this.slots = this.slotsOf(rows.value.rows, rows.value.matched);
    this.cursor = 0;
    this.collection = "done";
    this.done = true;
  }

  /**
   * The rest of the boundary time's group, with its own trigram matches
   * (specs/search-tool.md#evaluation): the page's rows and the group's rows merged and decided by the
   * union of their match sets, or the instruction to walk a group above the cap.
   */
  private async completeGroup(
    rows: readonly IndexItemRow[],
    time: number,
    matched: ReadonlySet<number> | undefined,
  ): Promise<
    | { rows: IndexItemRow[]; matched: ReadonlySet<number> | undefined; groupWalk: false }
    | { groupWalk: true }
  > {
    const call = this.call;
    const index = call.index;
    if (index === undefined) return { rows: [...rows], matched, groupWalk: false };
    await call.pace();
    if (isAborted(call) || call.now() >= call.budgetDeadline) {
      this.stopFlag = true;
      return { groupWalk: true };
    }
    const filter: CandidateFilter = {
      newest: this.newest,
      bound: time,
      exactBound: true,
      limit: call.limits.groupRows,
      ...sqlFiltersOf(call),
    };
    const files = this.filter(1);
    filter.fileIds = files.fileIds;
    filter.fileIdsFilterOnly = files.fileIdsFilterOnly;
    const trigrams = call.query?.trigrams ?? [];
    if (trigrams.length > 0) filter.trigrams = trigrams;
    const outcome = index.candidatePage(filter);
    refreshIndexState(call);
    if (!outcome.ok) return { rows: [...rows], matched, groupWalk: false };
    const page = outcome.value;
    if (page.rows.length >= call.limits.groupRows) {
      // A very large group: walk it file by file in the call's order, one bounded
      // chunk at a time, without the page's own rows at this time (specs/search-tool.md#evaluation).
      this.groupTime = time;
      this.groupQueue = this.groupFiles();
      return { groupWalk: true };
    }
    this.checkCovers(page.files);
    const seen = new Set(rows.map((row) => row.itemId));
    const all = [...rows];
    for (const row of page.rows) {
      if (seen.has(row.itemId)) continue;
      seen.add(row.itemId);
      all.push(row);
    }
    // The group page's own matches decide its rows (specs/search-tool.md#evaluation).
    let union = matched;
    const groupMatched = page.matched;
    if (groupMatched !== undefined) {
      const merged = new Set<number>(matched ?? []);
      for (const id of groupMatched) merged.add(id);
      union = merged;
    }
    return { rows: all, matched: union, groupWalk: false };
  }

  /**
   * The covered catch-up sessions of a very large time group, as chunks to walk in
   * the call's order: transcript order at one time is ascending session key, so
   * `oldest` walks the files in that order and `newest` in its reverse
   * (specs/search-tool.md#evaluation and specs/search-tool.md#references).
   */
  private groupFiles(): Array<{ fileId: number; line: number }> {
    const entries = [...this.coversByFile.entries()].filter(
      ([fileId]) => !this.droppedFiles.has(fileId),
    );
    entries.sort((one, other) => {
      const delta = compareStrings(one[1].session.key, other[1].session.key);
      if (delta !== 0) return delta;
      return compareStrings(one[1].session.resolvedPath, other[1].session.resolvedPath);
    });
    const start = this.newest ? Number.MAX_SAFE_INTEGER : 0;
    const files = entries.map(([fileId]) => ({ fileId, line: start }));
    return this.newest ? files.toReversed() : files;
  }

  /**
   * One chunk of one session's part of a very large time group, in the call's
   * order (specs/search-tool.md#evaluation): rows of at most `groupChunkRows` lines, never splitting
   * a line, so a session of any size is paged through without a long statement.
   */
  private async fetchGroupChunk(): Promise<void> {
    const call = this.call;
    const index = call.index;
    const time = this.groupTime;
    if (index === undefined || time === undefined) {
      this.groupTime = undefined;
      return;
    }
    await call.pace();
    if (isAborted(call) || call.now() >= call.budgetDeadline) {
      this.stopFlag = true;
      this.groupTime = undefined;
      return;
    }
    const entry = this.groupQueue[0];
    if (entry === undefined) {
      this.groupTime = undefined;
      return;
    }
    if (this.droppedFiles.has(entry.fileId)) {
      this.groupQueue.shift();
      return;
    }
    const filter: CandidateFilter = {
      newest: this.newest,
      bound: time,
      exactBound: true,
      limit: call.limits.groupChunkRows,
      fileIds: [entry.fileId],
      lineOrder: this.newest ? "desc" : "asc",
      ...sqlFiltersOf(call),
    };
    if (this.newest) filter.lineBelow = entry.line;
    else filter.lineAbove = entry.line;
    const trigrams = call.query?.trigrams ?? [];
    if (trigrams.length > 0) filter.trigrams = trigrams;
    const outcome = index.candidatePage(filter);
    refreshIndexState(call);
    if (!outcome.ok) {
      this.groupTime = undefined;
      return;
    }
    this.checkCovers(outcome.value.files);
    const fetched = outcome.value.rows;
    if (fetched.length === 0) {
      this.groupQueue.shift();
      return;
    }
    let rows = fetched;
    if (fetched.length >= call.limits.groupChunkRows) {
      // Keep the chunk on whole lines only; the rest of the file continues from
      // the boundary line in the next chunk, and a line too big for one chunk is
      // split rather than walked forever.
      const edge = fetched[fetched.length - 1];
      if (edge !== undefined) {
        const kept = fetched.filter((row) => row.line !== edge.line);
        if (kept.length === 0) {
          entry.line = edge.line + (this.newest ? -1 : 1);
        } else {
          rows = kept;
          entry.line = edge.line;
        }
      }
    } else {
      this.groupQueue.shift();
    }
    this.slots = this.slotsOf(rows, outcome.value.matched);
    this.cursor = 0;
  }

  /** Check the cover of the sessions a page names (specs/search-tool.md#coverage; specs/session-index.md#concurrent-access). */
  private checkCovers(files: readonly IndexFileRow[]): void {
    const index = this.call.index;
    for (const file of files) {
      const cover = this.coversByFile.get(file.fileId);
      if (cover === undefined || cover.dropped) continue;
      const consumed = cover.consumed ?? 0;
      // Another path under this `file_id`: the index file was opened anew (specs/search-tool.md#coverage).
      if (file.consumed < consumed || file.path !== cover.session.resolvedPath) {
        this.lose(cover);
        continue;
      }
      if (file.consumed > consumed && cover.lineageIds === undefined) {
        const lineage = index?.lineageWithin(file.fileId, cover.size ?? 0);
        refreshIndexState(this.call);
        if (lineage !== undefined && lineage.ok) cover.lineageIds = new Set(lineage.value);
        else if (lineage !== undefined) cover.lineageIds = new Set();
      }
    }
  }

  /** A session of the call loses its cover (specs/search-tool.md#coverage). */
  lose(cover: Cover): void {
    if (cover.dropped) return;
    cover.dropped = true;
    if (cover.fileId !== undefined) this.droppedFiles.add(cover.fileId);
  }

  /** The slots of one page, in the call's order. */
  private slotsOf(rows: readonly IndexItemRow[], matched: ReadonlySet<number> | undefined): Slot[] {
    const slots: Slot[] = [];
    for (const row of rows) {
      const cover = this.coversByFile.get(row.fileId);
      if (cover === undefined) continue;
      if (this.droppedFiles.has(row.fileId)) continue;
      // A row of another path under this `file_id` is from an index file opened
      // anew during the call, and never an item of this session (specs/search-tool.md#coverage).
      if (row.path !== cover.session.resolvedPath) continue;
      if (row.offset + row.bytes + 1 > (cover.size ?? 0)) continue;
      const narrowedOut = matched !== undefined && !matched.has(row.itemId);
      const slot = slotOfRow(cover, row, narrowedOut, cover.lineageIds);
      if (slot !== undefined) slots.push(slot);
    }
    const newest = this.newest;
    return slots.toSorted((one, other) => compareCallOrder(one, other, newest));
  }
}

/** The files one collection statement reads when the call names its files (specs/search-tool.md#abort). */
const COLLECT_CHUNK_FILES = 500;

/** True when the call has a filter SQL applies that may pass few rows: `kinds`, `tool`, `isError` (specs/search-tool.md#candidates). */
function hasSparseFilter(call: Call): boolean {
  const settings = call.settings;
  return (
    settings.kinds !== undefined || settings.tool !== undefined || settings.isError !== undefined
  );
}

/**
 * The filters of specs/search-tool.md#candidates that SQL can express exactly — `kinds`, `tool`,
 * `isError`, `since` and `until`, on the columns the schema defines — so a page
 * statement skips the items they exclude instead of reading them back. The
 * lineage and own-calls filters stay with the caller, which checks them on every
 * slot again.
 */
function sqlFiltersOf(call: Call): Partial<CandidateFilter> {
  const settings = call.settings;
  const filter: Partial<CandidateFilter> = {};
  if (settings.kinds !== undefined) filter.kinds = settings.kinds;
  if (settings.tool !== undefined) filter.tool = asciiLower(settings.tool);
  if (settings.isError !== undefined) filter.isError = settings.isError;
  if (settings.since !== undefined) filter.since = settings.since;
  if (settings.until !== undefined) filter.until = settings.until;
  return filter;
}

/**
 * Check the `files` rows of catch-up sessions against the index file as it is
 * now (specs/search-tool.md#coverage; specs/session-index.md#concurrent-access): a session keeps its cover only
 * when its `file_id` still names its path with a `consumed` no smaller than the
 * call's catch-up left. A row that is gone, names another path — the index file
 * was opened anew and the `file_id` reused — or holds fewer bytes takes the cover
 * away, since the call can no longer read the session's rows. With `onlyStale`,
 * only the sessions covered from an earlier opening of the file are checked.
 */
async function recheckCovers(call: Call, onlyStale: boolean): Promise<void> {
  const index = call.index;
  if (index === undefined || call.indexUnusable !== undefined) return;
  const generation = index.generation;
  const covers = call.covers.filter(
    (cover) =>
      cover.state === "catchup" &&
      cover.fileId !== undefined &&
      !cover.dropped &&
      (!onlyStale || cover.generation !== generation),
  );
  if (covers.length === 0) return;
  await call.pace();
  const outcome = index.filesFor(covers.map((cover) => cover.fileId ?? 0));
  refreshIndexState(call);
  if (!outcome.ok) return;
  const rows = new Map<number, IndexFileRow>();
  for (const file of outcome.value) rows.set(file.fileId, file);
  for (const cover of covers) {
    const file = rows.get(cover.fileId ?? 0);
    if (
      file === undefined ||
      file.path !== cover.session.resolvedPath ||
      file.consumed < (cover.consumed ?? 0)
    ) {
      dropCover(call, cover);
      continue;
    }
    cover.generation = index.generation;
    if (file.consumed > (cover.consumed ?? 0) && cover.lineageIds === undefined) {
      await call.pace();
      const lineage = index.lineageWithin(file.fileId, cover.size ?? 0);
      refreshIndexState(call);
      if (lineage.ok) cover.lineageIds = new Set(lineage.value);
      else cover.lineageIds = new Set();
    }
  }
}

/**
 * The one full check per call of every catch-up session's `files` row (specs/search-tool.md#coverage), before evaluation. It is skipped when no other connection has committed
 * since the call read those rows and the index was not opened anew: the rows are
 * then the ones the call's own catch-ups left.
 */
async function checkAllCoversOnce(call: Call): Promise<void> {
  const index = call.index;
  const known = call.knownVersion;
  if (index !== undefined && known !== undefined && known.generation === index.generation) {
    const version = index.dataVersion();
    refreshIndexState(call);
    if (
      version.ok &&
      version.value === known.dataVersion &&
      index.generation === known.generation
    ) {
      return;
    }
  }
  await recheckCovers(call, false);
}

/** The sources of a call: catch-up sessions loaded or scanned, and every directly read session. */
export async function sourcesOf(call: Call): Promise<Source[]> {
  const newest = call.settings.order === "newest";
  // A source whose bounds are unknown must always be loaded: the bound that cannot
  // exclude it is the one beyond every item time in the call's order.
  const unknown = newest ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  await checkAllCoversOnce(call);
  const sources: Source[] = [];
  const catchUp = call.covers.filter(
    (cover) => cover.state === "catchup" && cover.fileId !== undefined && !cover.dropped,
  );
  let lines = 0;
  for (const cover of catchUp) lines += cover.lines ?? 0;
  // The sessions are loaded whole, however many items they hold: `fileModeLines`
  // keeps a call from loading thousands of sessions, never a session's own rows.
  if (catchUp.length > 0 && lines <= call.limits.fileModeLines) {
    // A call with few sessions loads them whole, row by row through the
    // (file_id, line, part) index, so its cost does not depend on the sessions it
    // does not search and no row of them is cut off (specs/search-tool.md#evaluation).
    for (const cover of catchUp) {
      const bounds = timeBoundsOf(call, cover);
      const reach = bounds === undefined ? unknown : newest ? bounds.max : bounds.min;
      sources.push(new FileSource(call, cover, newest, reach));
    }
  } else if (catchUp.length > 0) {
    sources.push(new ScanSource(call, catchUp));
  }
  for (const cover of call.covers) {
    if (cover.state !== "direct" || cover.dropped) continue;
    const slots = (cover.items ?? []).map((item) => slotOfItem(cover, item));
    const source = new SlotListSource(slots, newest, unknown);
    source.startAfter(call.after, newest);
    sources.push(source);
  }
  return sources;
}

// ---------------------------------------------------------------------------
// specs/search-tool.md#matching: matching, and the interruptible regular expression
// ---------------------------------------------------------------------------

/** The literal pattern of a query: each of `\ ^ $ . * + ? ( ) [ ] { } |` preceded by `\` (specs/search-tool.md#matching). */
export function literalPattern(query: string): string {
  const parts: string[] = [];
  for (const character of query) {
    parts.push(LITERAL_SPECIALS.has(character) ? `\\${character}` : character);
  }
  return parts.join("");
}

/** The regular-expression flags of a query (specs/search-tool.md#matching): `m`, and `i` unless case is significant. */
function flagsOf(caseSensitive: boolean): string {
  return caseSensitive ? "m" : "mi";
}

/** The evaluator a `find` call uses for a regular expression (specs/search-tool.md#matching). */
export interface PatternEvaluator {
  /** The match positions of `texts`, in order; an item the limit ended has `undefined`. */
  evaluate(texts: readonly string[], stop: () => boolean): Promise<EvalOutcome>;
  /** Release the worker. */
  close(): void;
}

/**
 * One evaluation window's outcome: a position per text (`undefined`: the limit
 * ended it). A window that the budget or the abort ended before every text was
 * evaluated carries the positions it reached, so that the items they decide stay
 * decided (specs/search-tool.md#evaluation).
 */
export type EvalOutcome =
  | { kind: "done"; positions: Array<number | undefined> }
  | { kind: "stopped"; positions: Array<number | undefined> }
  | { kind: "failed"; message: string };

/**
 * A worker thread that evaluates one pattern (specs/search-tool.md#matching), so that a pattern
 * which backtracks without end is terminated when the call's budget, the abort
 * signal, or one item's 1000 ms limit ends it (specs/search-tool.md#abort and specs/search-tool.md#evaluation). Texts are
 * sent in batches, and a fresh worker takes over after a termination.
 */
export class RegexEvaluator implements PatternEvaluator {
  private readonly pattern: string;
  private readonly flags: string;
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly inbox: Array<{ id: number; at: number }> = [];
  private failure: string | undefined;
  private notify: (() => void) | undefined;

  constructor(pattern: string, flags: string) {
    this.pattern = pattern;
    this.flags = flags;
  }

  private start(): Worker {
    const existing = this.worker;
    if (existing !== undefined) return existing;
    const workerUrl = new URL("./search-worker.ts", import.meta.url);
    const worker = new Worker(workerUrl, {
      ...typeStrippingOptions(workerUrl),
      workerData: { pattern: this.pattern, flags: this.flags },
    });
    worker.on("message", (message: unknown) => {
      if (!isPlainObject(message)) return;
      const id = message.id;
      const at = message.at;
      if (typeof id !== "number" || typeof at !== "number") return;
      this.inbox.push({ id, at });
      this.wake();
    });
    worker.on("error", (error: unknown) => {
      this.failure = error instanceof Error ? error.message : String(error);
      this.wake();
    });
    worker.on("exit", (code: number) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      if (this.failure === undefined) this.failure = `the search worker exited (code ${code})`;
      this.wake();
    });
    this.worker = worker;
    return worker;
  }

  private wake(): void {
    const notify = this.notify;
    this.notify = undefined;
    notify?.();
  }

  /** Wait up to `ms` for a message, or for the worker to fail. */
  private wait(ms: number): Promise<void> {
    return new Promise((resolveWait) => {
      const timer = setTimeout(() => {
        this.notify = undefined;
        resolveWait();
      }, ms);
      this.notify = () => {
        clearTimeout(timer);
        resolveWait();
      };
    });
  }

  /**
   * The next position for `id`, `timeout` when the item has run its 1000 ms limit
   * and no answer arrived (specs/search-tool.md#evaluation).
   */
  private async poll(
    id: number,
    stop: () => boolean,
    deadline: number,
  ): Promise<EvalOutcome | "timeout"> {
    for (;;) {
      const at = this.inbox.findIndex((message) => message.id === id);
      if (at >= 0) {
        const [message] = this.inbox.splice(at, 1);
        if (message !== undefined) return { kind: "done", positions: [message.at] };
      }
      if (this.failure !== undefined) return { kind: "failed", message: this.failure };
      if (stop()) return { kind: "stopped", positions: [] };
      if (nowMs() >= deadline) return "timeout";
      await this.wait(REGEX_POLL_MS);
    }
  }

  /**
   * The match positions of `texts`, in order; an item the limit ended has
   * `undefined`, and a window the budget or the abort ended carries the positions
   * it reached. The worker is terminated and a fresh one started after each limit.
   */
  async evaluate(texts: readonly string[], stop: () => boolean): Promise<EvalOutcome> {
    const positions: Array<number | undefined> = [];
    let index = 0;
    let worker: Worker;
    try {
      worker = this.start();
    } catch (error) {
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    let id = (this.nextId += 1);
    worker.postMessage({ id, texts: texts.slice(index) });
    let startedAt = nowMs();
    for (;;) {
      const outcome = await this.poll(id, stop, startedAt + ITEM_LIMIT_MS);
      if (outcome === "timeout") {
        // specs/search-tool.md#evaluation: the evaluation of this item has run 1000 ms; it is ended,
        // the item is decided and is not a hit, and a fresh worker goes on.
        positions.push(undefined);
        index += 1;
        this.close();
        if (index >= texts.length) return { kind: "done", positions };
        worker = this.start();
        id = this.nextId += 1;
        worker.postMessage({ id, texts: texts.slice(index) });
        startedAt = nowMs();
        continue;
      }
      if (outcome.kind === "failed") {
        this.close();
        return outcome;
      }
      if (outcome.kind === "stopped") {
        this.close();
        return { kind: "stopped", positions };
      }
      positions.push(outcome.positions[0]);
      index += 1;
      startedAt = nowMs();
      if (index >= texts.length) return { kind: "done", positions };
    }
  }

  close(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.inbox.length = 0;
    this.failure = undefined;
    if (worker === undefined) return;
    worker.removeAllListeners("exit");
    worker.removeAllListeners("error");
    worker.removeAllListeners("message");
    void worker.terminate();
  }
}

// ---------------------------------------------------------------------------
// Rendering (specs/search-tool.md#result)
// ---------------------------------------------------------------------------

// A maximal run of white space and of U+0000-U+001F and U+007F-U+009F (specs/search-tool.md#result).
// eslint-disable-next-line no-control-regex
const WHITE_RUN = /[\s\x00-\x1f\x7f-\x9f]+/g;

/**
 * A string with every maximal run of white space and of U+0000–U+001F and
 * U+007F–U+009F replaced by one space, and one leading and one trailing space
 * removed (specs/search-tool.md#result).
 */
export function flattenText(text: string): string {
  const collapsed = text.replace(WHITE_RUN, " ");
  return collapsed.replace(/^ /, "").replace(/ $/, "");
}

/** The snippet of a text at match position `start` (specs/search-tool.md#result). */
export function snippetOf(text: string, start: number): string {
  const length = text.length;
  if (length === 0) return "(empty)";
  const from = Math.max(0, start - SNIPPET_BEFORE);
  const to = Math.min(length, from + SNIPPET_LENGTH);
  const head = from > 0 ? "\u2026" : "";
  const tail = to < length ? "\u2026" : "";
  return `${head}${flattenText(text.slice(from, to))}${tail}`;
}

/** The parts of one hit line (specs/search-tool.md#result). */
export interface HitLineParts {
  address: string;
  time: number;
  kind: string;
  label: string | undefined;
  isError: boolean;
  offLineage: boolean;
  length: number;
  at: number | undefined;
  /** The snippet, or undefined when the line carries none. */
  snippet: string | undefined;
}

/** One hit line (specs/search-tool.md#result). */
export function hitLine(parts: HitLineParts, zone: string): string {
  const label =
    parts.label === undefined ? "" : ` ${flattenText(parts.label).slice(0, LABEL_LENGTH)}`;
  const flags = `${parts.isError ? " error" : ""}${parts.offLineage ? " off-lineage" : ""}`;
  const at = parts.at === undefined ? "" : ` @${parts.at}`;
  const snippet = parts.snippet === undefined ? "" : ` \u00b7 ${parts.snippet}`;
  return `${parts.address} \u00b7 ${localStamp(parts.time, zone)} \u00b7 ${parts.kind}${label}${flags} \u00b7 ${parts.length} chars${at}${snippet}`;
}

/** The address of one item, relative to the invoking session (specs/session-transcript.md#item-address). */
export function addressOf(sessionKey: string, entryId: string, part: string | undefined): string {
  return formatItemAddress({ sessionKey, entryId, part });
}

/** The `<hit>` object of a `find` result or a `get` neighbour (specs/search-tool.md#result). */
export function hitDetails(hit: ShownHit): Record<string, unknown> {
  const details: Record<string, unknown> = {
    address: hit.address,
    session: hit.sessionKey,
    kind: hit.kind,
    offLineage: hit.offLineage,
    time: hit.time,
    length: hit.length,
    snippet: hit.snippet,
  };
  if (hit.label !== undefined) details.label = hit.label;
  if (hit.isError !== undefined) details.isError = hit.isError;
  if (hit.at !== undefined) details.at = hit.at;
  return details;
}

/** One hit of a `find` result, built from an item (specs/search-tool.md#result). */
function shownHitOf(slot: Slot, item: TranscriptItem, at?: number | undefined): ShownHit {
  return {
    address: addressOf(slot.sessionKey, slot.entryId, slot.part),
    sessionKey: slot.sessionKey,
    kind: item.kind,
    label: item.label,
    isError: item.kind === "tool_result" ? item.isError : undefined,
    offLineage: !slot.onLineage,
    time: item.time,
    length: item.length,
    at,
    snippet: snippetOf(item.text, at ?? 0),
  };
}

// ---------------------------------------------------------------------------
// specs/search-tool.md#evaluation: evaluation
// ---------------------------------------------------------------------------

/** What one window of candidates is prepared with. */
type Prepared =
  | { kind: "skip" }
  | { kind: "hit"; item: TranscriptItem }
  | { kind: "evaluate"; item: TranscriptItem }
  | { kind: "stale"; fileId: number | undefined };

/** The item of one slot, read back from its session file when the slot is an index row. */
function itemOf(call: Call, slot: Slot): { item: TranscriptItem } | { stale: true } | undefined {
  const existing = slot.item;
  if (existing !== undefined) return { item: existing };
  const row = slot.row;
  const index = call.index;
  if (row === undefined || index === undefined) return { stale: true };
  const read = index.readItem(row);
  refreshIndexState(call);
  if (read.status !== "item") return { stale: true };
  call.onItemRead?.();
  slot.item = read.item;
  return { item: read.item };
}

/**
 * The filters of specs/search-tool.md#candidates that need only a slot's fields: lineage, `kinds`,
 * `tool`, `isError`, `since`, and `until`. Both the indexed path and the
 * direct-read path use it.
 */
export function filterSlot(call: Call, slot: Slot): boolean {
  const settings = call.settings;
  if (!settings.branches && !slot.onLineage) return false;
  const kinds = settings.kinds;
  if (kinds !== undefined && !kinds.includes(slot.kind)) return false;
  if (settings.tool !== undefined && slot.tool !== asciiLower(settings.tool)) return false;
  const isError = settings.isError;
  if (isError !== undefined) {
    if (slot.kind !== "tool_result" || slot.isError !== isError) return false;
  }
  if (settings.since !== undefined && slot.time < settings.since) return false;
  if (settings.until !== undefined && slot.time >= settings.until) return false;
  return true;
}

/** A stale row: the reader resets its file before the session loses its cover (specs/search-tool.md#coverage). */
async function staleOf(call: Call, slot: Slot): Promise<Prepared> {
  if (slot.row !== undefined) await resetStaleRow(call, slot.row, call.budgetDeadline);
  return { kind: "stale", fileId: slot.fileId };
}

/** Apply the filters of specs/search-tool.md#candidates that need the item, and read it back. */
async function prepareSlot(call: Call, slot: Slot, query: Query | undefined): Promise<Prepared> {
  const settings = call.settings;
  if (slot.narrowedOut) return { kind: "skip" };
  if (!filterSlot(call, slot)) return { kind: "skip" };
  const wantedTool = settings.tool === undefined ? undefined : asciiLower(settings.tool);
  if (slot.tool === "search" && wantedTool !== "search") {
    const read = itemOf(call, slot);
    if (read === undefined || "stale" in read) return staleOf(call, slot);
    if (read.item.label === SEARCH_TOOL_NAME) return { kind: "skip" };
  }
  if (query === undefined) {
    const read = itemOf(call, slot);
    if (read === undefined || "stale" in read) return staleOf(call, slot);
    return { kind: "hit", item: read.item };
  }
  const read = itemOf(call, slot);
  if (read === undefined || "stale" in read) return staleOf(call, slot);
  return { kind: "evaluate", item: read.item };
}

/** The outcome of a `find` evaluation. */
export type FindEvaluation =
  | {
      kind: "evaluation";
      hits: ShownHit[];
      more: boolean;
      stopped: boolean;
      stop: string | undefined;
      unmatched: number;
      afterUncovered: boolean;
    }
  | { kind: "aborted" }
  | { kind: "failed"; message: string };

/** The outcome of a `find` call that ran to a result (specs/search-tool.md#result). */
export type FindOutcome = Extract<FindEvaluation, { kind: "evaluation" }>;

/**
 * The merge of the call's sources in the call's order (specs/search-tool.md#evaluation). A session the
 * call loads row by row is loaded only when its time bound can still reach the
 * head of the merge, so a call that shows its first hits at once never loads the
 * sessions below them.
 */
class Merger {
  private readonly sources: readonly Source[];
  private readonly newest: boolean;
  /** The sources not loaded yet, with the time each can reach, in call order. */
  private readonly pending: { source: Source; reach: number }[];
  private readonly loaded: Source[] = [];

  constructor(sources: readonly Source[], newest: boolean) {
    this.sources = sources;
    this.newest = newest;
    this.pending = sources
      .map((source) => ({ source, reach: source.reach() }))
      .toSorted((one, other) => (newest ? other.reach - one.reach : one.reach - other.reach));
  }

  /** The next slot of the call's order, or undefined when every source is exhausted. */
  async next(): Promise<Slot | undefined> {
    for (;;) {
      let best: Source | undefined;
      let bestSlot: Slot | undefined;
      let stopped = false;
      for (const source of this.loaded) {
        if (source.stopped) stopped = true;
        if (source.dropped) continue;
        const slot = await source.peek();
        if (slot === undefined) continue;
        if (bestSlot === undefined || compareCallOrder(slot, bestSlot, this.newest) < 0) {
          best = source;
          bestSlot = slot;
        }
      }
      if (stopped) return;
      const next = this.pending[0];
      if (next === undefined) {
        if (best === undefined) return;
        return best.take();
      }
      const reach = next.reach;
      const head = bestSlot === undefined ? undefined : bestSlot.time;
      const matters = head === undefined || (this.newest ? reach >= head : reach <= head);
      if (matters) {
        this.pending.shift();
        if (next.source.dropped || next.source.stopped) continue;
        this.loaded.push(next.source);
        continue;
      }
      if (best === undefined) return;
      return best.take();
    }
  }

  /** True when any source stopped for the budget or the abort (specs/search-tool.md#evaluation). */
  get stopped(): boolean {
    for (const source of this.loaded) if (source.stopped) return true;
    return false;
  }
}

/** Evaluate the call's hits in the call's order (specs/search-tool.md#evaluation). */
export async function evaluate(call: Call): Promise<FindEvaluation> {
  const newest = call.settings.order === "newest";
  const limit = call.settings.limit ?? FIND_LIMIT;
  const query = call.query;
  const literal =
    query === undefined || query.regex ? undefined : new RegExp(query.pattern, query.flags);
  const sources = await sourcesOf(call);
  call.sources = sources;
  const merger = new Merger(sources, newest);
  const hits: ShownHit[] = [];
  /** The last decided slot of each session, for the stop item (specs/search-tool.md#evaluation). */
  const lastDecided = new Map<string, Slot>();
  let stopped = false;
  let more = false;
  let unmatched = 0;
  const stop = (): boolean => isAborted(call) || call.now() >= call.budgetDeadline;
  let seenGeneration = call.index?.generation;
  for (;;) {
    await call.pace();
    if (isAborted(call)) return { kind: "aborted" };
    if (call.now() >= call.budgetDeadline) {
      stopped = true;
      break;
    }
    refreshIndexState(call);
    const generation = call.index?.generation;
    if (generation !== undefined && generation !== seenGeneration) {
      // The index file was opened anew: each session keeps its cover only if the
      // new file still holds its rows (specs/search-tool.md#coverage).
      seenGeneration = generation;
      await recheckCovers(call, true);
    }
    if (call.indexUnusable !== undefined) {
      // The index became unusable: every catch-up session loses its cover (specs/search-tool.md#coverage).
      for (const source of sources) source.dropFile?.(0);
      for (const cover of call.covers) {
        if (cover.state !== "catchup") continue;
        cover.dropped = true;
      }
    }
    // The session the key of `after` names is covered again by a direct read (specs/search-tool.md#coverage).
    const lostAfter = call.afterCover;
    if (lostAfter !== undefined && lostAfter.dropped && !call.afterRecovered) {
      call.afterRecovered = true;
      await recoverAfterSession(call, lostAfter, sources, newest);
    }
    const window: Slot[] = [];
    while (window.length < WINDOW_SLOTS) {
      const slot = await merger.next();
      if (slot === undefined) break;
      if (call.after !== undefined && compareCallOrder(slot, call.after, newest) <= 0) continue;
      window.push(slot);
    }
    if (merger.stopped) {
      stopped = true;
      break;
    }
    if (window.length === 0) break;
    const prepared: Prepared[] = [];
    for (const slot of window) prepared.push(await prepareSlot(call, slot, query));
    await call.pace();
    const positions = await evaluateWindow(call, prepared, literal, stop);
    if (isAborted(call)) return { kind: "aborted" };
    if (positions.kind === "failed") return positions;
    // Every item of the window whose evaluation finished is decided, and its hit
    // or its unmatched count is kept even when the budget ends the window early:
    // the run of decided items of specs/search-tool.md#evaluation ends at the first undecided one.
    let cursor = 0;
    let undecided = false;
    for (let index = 0; index < window.length; index += 1) {
      await call.pace();
      if (isAborted(call)) return { kind: "aborted" };
      const slot = window[index];
      const entry = prepared[index];
      if (slot === undefined || entry === undefined) continue;
      if (entry.kind === "stale") {
        const cover = coverOfSlot(call, slot);
        if (cover !== undefined) {
          dropCover(call, cover);
          if (cover === call.afterCover && !call.afterRecovered) {
            call.afterRecovered = true;
            await recoverAfterSession(call, cover, sources, newest);
          }
        }
        continue;
      }
      const key = `${slot.sessionKey}\u0000${slot.sessionPath}`;
      let hit: ShownHit | undefined;
      if (entry.kind === "hit") {
        hit = shownHitOf(slot, entry.item);
      } else if (entry.kind === "evaluate") {
        if (cursor >= positions.positions.length) {
          // The stop of the window ended this item's evaluation: it is not decided.
          undecided = true;
          break;
        }
        const at = positions.positions[cursor] ?? undefined;
        cursor += 1;
        if (at === undefined) {
          unmatched += 1;
        } else if (at >= 0) {
          hit = shownHitOf(slot, entry.item, at);
        }
      }
      const cover = coverOfSlot(call, slot);
      if (cover !== undefined && cover.dropped) continue;
      // An item excluded by a filter is decided all the same (specs/search-tool.md#evaluation).
      lastDecided.set(key, slot);
      note(call, { phase: "decide" });
      if (hit !== undefined) {
        hits.push(hit);
        if (hits.length > limit) {
          more = true;
          break;
        }
      }
    }
    if (more) break;
    if (undecided || positions.stopped) {
      stopped = true;
      break;
    }
  }
  if (isAborted(call)) return { kind: "aborted" };
  let stopSlot: Slot | undefined;
  for (const slot of lastDecided.values()) {
    const cover = coverOfSlot(call, slot);
    if (cover !== undefined && cover.dropped) continue;
    if (stopSlot === undefined || compareCallOrder(stopSlot, slot, newest) < 0) stopSlot = slot;
  }
  const afterCover = call.afterCover;
  return {
    kind: "evaluation",
    hits: hits.slice(0, limit),
    more,
    stopped,
    stop:
      stopped && stopSlot !== undefined
        ? addressOf(stopSlot.sessionKey, stopSlot.entryId, stopSlot.part)
        : undefined,
    unmatched,
    afterUncovered:
      stopped &&
      stopSlot === undefined &&
      afterCover !== undefined &&
      !isCovered(afterCover) &&
      call.indexUnusable === undefined &&
      call.failedWrite === undefined,
  };
}

/**
 * Cover the session the key of `after` names again by a direct read after it lost
 * its cover, and merge its items from where the call had reached (specs/search-tool.md#coverage).
 */
export async function recoverAfterSession(
  call: Call,
  cover: Cover,
  sources: Source[],
  newest: boolean,
): Promise<void> {
  cover.dropped = false;
  cover.lineageIds = undefined;
  await coverDirectly(call, cover, call.budgetDeadline);
  if (cover.state === "lost") {
    cover.dropped = true;
    call.afterLost = true;
    return;
  }
  if (cover.state !== "direct") return;
  const slots = (cover.items ?? []).map((item) => slotOfItem(cover, item));
  const source = new SlotListSource(
    slots,
    newest,
    newest ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
  );
  source.startAfter(call.after, newest);
  sources.push(source);
}

/** The cover a slot belongs to, when its session is a session of the call. */
function coverOfSlot(call: Call, slot: Slot): Cover | undefined {
  for (const cover of call.covers) {
    if (cover.session.key !== slot.sessionKey) continue;
    if (cover.session.resolvedPath !== slot.sessionPath) continue;
    return cover;
  }
  return;
}

/** A session loses its cover for the rest of a `find` call (specs/search-tool.md#coverage). */
function dropCover(call: Call, cover: Cover): void {
  if (cover.dropped) return;
  cover.dropped = true;
  if (cover.fileId !== undefined) {
    for (const source of call.sources) source.dropFile?.(cover.fileId);
  }
}

/** What one window of evaluations reports (specs/search-tool.md#evaluation): the positions it reached, and whether a stop ended it early. */
type EvalWindowOutcome =
  | { kind: "positions"; positions: Array<number | undefined>; stopped: boolean }
  | { kind: "failed"; message: string };

/**
 * The positions of one window's evaluations: literal in process, regular expression
 * in the worker. A window the budget or the abort ended reports the positions it
 * reached and that it stopped (specs/search-tool.md#evaluation).
 */
async function evaluateWindow(
  call: Call,
  prepared: readonly Prepared[],
  literal: RegExp | undefined,
  stop: () => boolean,
): Promise<EvalWindowOutcome> {
  const texts: string[] = [];
  for (const entry of prepared) {
    if (entry.kind === "evaluate") texts.push(entry.item.matchText);
  }
  if (texts.length === 0) return { kind: "positions", positions: [], stopped: false };
  if (literal !== undefined) {
    const positions: Array<number | undefined> = [];
    for (const text of texts) {
      const started = nowMs();
      const match = literal.exec(text);
      if (nowMs() - started >= ITEM_LIMIT_MS) {
        positions.push(undefined);
        continue;
      }
      positions.push(match === null ? -1 : match.index);
    }
    return { kind: "positions", positions, stopped: false };
  }
  note(call, { phase: "evaluate" });
  let evaluator = call.evaluator;
  if (evaluator === undefined) {
    const query = call.query;
    if (query === undefined) return { kind: "positions", positions: [], stopped: false };
    const make = call.makeEvaluator;
    evaluator =
      make === undefined
        ? new RegexEvaluator(query.pattern, query.flags)
        : make(query.pattern, query.flags);
    call.evaluator = evaluator;
  }
  const outcome = await evaluator.evaluate(texts, stop);
  if (outcome.kind === "failed") return outcome;
  return {
    kind: "positions",
    positions: outcome.positions,
    stopped: outcome.kind === "stopped",
  };
}

/** The query of a `find` call, with the trigrams its narrowing may use (specs/search-tool.md#evaluation). */
export function queryOf(call: Call): Query | undefined {
  const settings = call.settings;
  const query = settings.query;
  if (query === undefined) return;
  const pattern = settings.regex ? query : literalPattern(query);
  const flags = flagsOf(settings.caseSensitive);
  const trigrams = settings.regex ? regexTrigrams(query) : printableTrigramsOf(query);
  return { pattern, flags, regex: settings.regex, trigrams };
}

/** Every run of three printable characters of a literal query (specs/search-tool.md#evaluation). */
function printableTrigramsOf(query: string): string[] {
  const trigrams: string[] = [];
  for (let index = 0; index + 3 <= query.length; index += 1) {
    const run = query.slice(index, index + 3);
    if (/^[\u0020-\u007e]{3}$/.test(run)) trigrams.push(run);
  }
  return trigrams;
}

/** Characters after `\` that start an escape other than an identity escape: a class, an anchor, a code, a reference. */
const ESCAPE_LETTER = /[A-Za-z0-9]/;

/** The characters of an escape's payload that the extractor skips after `\` and a letter or digit. */
const ESCAPE_PAYLOAD = /[A-Za-z0-9{}<>,_]/;

/**
 * The trigrams every match of a regular expression contains (specs/search-tool.md#evaluation, which
 * allows a call to narrow by them), or none when that is not evident. Only literal
 * characters at the top level of the pattern count, in runs that no quantifier,
 * group, class, anchor, wildcard, or escape other than an identity escape
 * interrupts; a character a quantifier makes optional ends a run and is left
 * out, and a top-level `|` gives no trigram at all. Every run is a substring of
 * every match, so every printable trigram of a run is one of every match.
 */
export function regexTrigrams(pattern: string): string[] {
  const runs: string[] = [];
  let run = "";
  const end = (): void => {
    if (run.length >= 3) runs.push(run);
    run = "";
  };
  /** The index after a quantifier at `at`, or `at` when none starts there. */
  const quantifierEnd = (at: number): number => {
    const ch = pattern[at];
    let next = at;
    if (ch === "*" || ch === "+" || ch === "?") next = at + 1;
    else if (ch === "{") {
      const close = pattern.indexOf("}", at);
      if (close < 0 || !/^\{\d+(,\d*)?\}$/.test(pattern.slice(at, close + 1))) return at;
      next = close + 1;
    } else return at;
    // A lazy quantifier carries a `?` of its own.
    return pattern[next] === "?" ? next + 1 : next;
  };
  /** The index after the group or class that starts at `at`. */
  const skipNested = (at: number): number => {
    let depth = 0;
    let inClass = false;
    for (let index = at; index < pattern.length; index += 1) {
      const ch = pattern[index];
      if (ch === "\\") {
        index += 1;
        continue;
      }
      if (inClass) {
        if (ch === "]") {
          inClass = false;
          if (depth === 0) return index + 1;
        }
        continue;
      }
      if (ch === "[") inClass = true;
      else if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return pattern.length;
  };
  let index = 0;
  while (index < pattern.length) {
    const ch = pattern[index] ?? "";
    if (ch === "|") return [];
    if (ch === "(" || ch === "[") {
      end();
      index = quantifierEnd(skipNested(index));
      continue;
    }
    let literal: string | undefined;
    let next = index + 1;
    if (ch === "\\") {
      const escaped = pattern[index + 1] ?? "";
      if (escaped === "" || ESCAPE_LETTER.test(escaped)) {
        // A class, an anchor, a code point, or a reference: not a known literal.
        end();
        next = index + 2;
        while (next < pattern.length && ESCAPE_PAYLOAD.test(pattern[next] ?? "")) next += 1;
        index = quantifierEnd(next);
        continue;
      }
      literal = escaped;
      next = index + 2;
    } else if (ch === "." || ch === "^" || ch === "$" || ch === ")" || ch === "]") {
      end();
      index = quantifierEnd(index + 1);
      continue;
    } else if (ch === "*" || ch === "+" || ch === "?" || ch === "{" || ch === "}") {
      end();
      index = quantifierEnd(index) === index ? index + 1 : quantifierEnd(index);
      continue;
    } else {
      literal = ch;
    }
    const after = quantifierEnd(next);
    if (after === next) {
      run += literal;
      index = next;
      continue;
    }
    const quantifier = pattern[next];
    if (quantifier === "+") {
      // At least once: the run may end with it, and the next run starts afresh.
      run += literal;
      end();
    } else {
      // Optional or counted: left out, and the run ends before it.
      end();
    }
    index = after;
  }
  end();
  const trigrams = new Set<string>();
  for (const one of runs) for (const trigram of printableTrigramsOf(one)) trigrams.add(trigram);
  return [...trigrams];
}

/** The item `after` names in one covered session, or undefined when it names none (specs/search-tool.md#result). */
export function afterSlotOf(call: Call, cover: Cover, address: ItemAddress): Slot | undefined {
  if (cover.state === "catchup" && cover.fileId !== undefined) {
    const index = call.index;
    if (index !== undefined) {
      const outcome = index.findItem(cover.fileId, address.entryId, address.part);
      refreshIndexState(call);
      if (outcome.ok) {
        if (outcome.value === undefined) return;
        if (outcome.value.offset + outcome.value.bytes + 1 > (cover.size ?? 0)) return;
        return slotOfRow(cover, outcome.value, false, cover.lineageIds);
      }
    }
  }
  for (const item of cover.items ?? []) {
    if (item.entryId !== address.entryId) continue;
    if (item.part !== address.part) continue;
    return slotOfItem(cover, item);
  }
  return;
}

/** The uncovered sessions of the call, as the result reports them (specs/search-tool.md#result). */
export function uncoveredCount(call: Call): number {
  let count = 0;
  for (const cover of call.covers) {
    if (cover.state === "lost") continue;
    if (!isCovered(cover)) count += 1;
  }
  return count;
}

/** The sessions of the call, for `<n>` (specs/search-tool.md#result). */
export function sessionCount(call: Call): number {
  let count = 0;
  for (const cover of call.covers) {
    if (cover.state === "lost") continue;
    count += 1;
  }
  return count;
}

/** Start the continuation of catch-up after the call returned (specs/search-tool.md#coverage). */
export function startContinuation(
  call: Call,
  register: (continuation: CatchUpContinuation) => void,
): void {
  if (isAborted(call)) return;
  if (call.indexUnusable !== undefined || call.failedWrite !== undefined) return;
  const index = call.index;
  if (index === undefined) return;
  const paths: string[] = [];
  for (const cover of call.covers) {
    if (cover.state === "lost") continue;
    if (isCovered(cover)) continue;
    if (cover.size === undefined) continue;
    paths.push(cover.session.path);
  }
  if (paths.length === 0) return;
  const continuation = index.continueCatchUp(paths, {
    deadline: call.bootDeadline,
    now: call.now,
  });
  call.continuation = continuation;
  register(continuation);
}
