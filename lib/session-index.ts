/**
 * Session index per specs/session-index.md: the SQLite file that keeps, per
 * session file, the consumed bytes of its entries and the transcript items they
 * yield (specs/session-index.md#schema), brought up to the file by a catch-up (specs/session-index.md#catch-up), shared by
 * several processes (specs/session-index.md#concurrent-access), reported unusable or failed instead of thrown
 * (specs/session-index.md#failures), and pruned of deleted files (specs/session-index.md#index-prune).
 *
 * Every outcome the specification names is a return value: `openSessionIndex`
 * reports an unusable index with its reason, `catchUp` reports a complete,
 * incomplete, failed or unusable catch-up, and every read reports its own
 * outcome so that an empty answer and a failure cannot be confused. Catch-up and
 * the conditional reset are asynchronous: they yield to the event loop between
 * transactions and between busy attempts, so an abort, a `stop()` or a deadline
 * is observed while another process holds the write lock (specs/session-index.md#concurrent-access).
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  compareParts,
  currentLineage,
  entryItems,
  readSessionBytes,
  readSessionHeaderFile,
  readSessionLineAt,
  realPath,
  type SessionEntry,
  type TranscriptEntryRef,
  type TranscriptItem,
} from "./session-transcript.ts";
import { errorMessage, isPlainObject } from "./util.ts";

// ---------------------------------------------------------------------------
// specs/session-index.md#location: location and format
// ---------------------------------------------------------------------------

/** The environment variable that names the index file (specs/session-index.md#location). */
export const SEARCH_DB_ENV = "PI_DENT_SEARCH_DB";

/** The environment variable that names the session store's file (specs/session-store.md#location). */
export const STORE_DB_ENV = "PI_DENT_FLEET_DB";

/** The index file's name under `~/.pi/pi-dent/` (specs/session-index.md#location). */
export const INDEX_FILE_NAME = "search-v3.sqlite";

/** The session store's file name under `~/.pi/pi-dent/` (specs/session-store.md#location). */
const STORE_FILE_NAME = "fleet-v2.sqlite";

/** The format version recorded in `user_version` (specs/session-index.md#location). */
export const FORMAT_VERSION = 3;

/** The busy timeout in milliseconds (specs/session-index.md#location). */
const BUSY_TIMEOUT_MS = 1000;

/** The busy timeout of one attempt of a retried transaction: short, so an abort is seen quickly (specs/session-index.md#concurrent-access). */
const BUSY_ATTEMPT_MS = 20;

/** The awaited pause between two attempts of a retried transaction (specs/session-index.md#concurrent-access). */
const BUSY_RETRY_DELAY_MS = 20;

/** The most bytes one catch-up transaction extends the consumed bytes by (specs/session-index.md#catch-up). */
const TRANSACTION_BYTE_LIMIT = 8388608;

/** The most `files` rows one prune transaction covers (specs/session-index.md#index-prune). */
const PRUNE_FILES_PER_TRANSACTION = 100;

/** The most bytes read at a time while scanning the region of one transaction (specs/session-index.md#catch-up). */
const READ_CHUNK_BYTES = 1048576;

/**
 * The most items of the searched files for which the trigram narrowing probes the
 * full-text index item by item instead of scanning its trigram lists once
 * (specs/search-tool.md#evaluation): probing costs about 15 µs per
 * searched item and does not grow with the index, while a list scan grows with it.
 */
const TRIGRAM_PROBE_LIMIT = 2000;

/** The item IDs one trigram probe statement checks (specs/search-tool.md#evaluation). */
const PROBE_CHUNK = 20000;

/** The most item IDs a probe looks up one by one; more are matched by one streamed range (specs/session-index.md#schema). */
const PROBE_BY_ID_MAX = 1000;

/** The SQLite error codes of specs/session-index.md#failures, as their base values. */
const SQLITE_BUSY = 5;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/** The schema of specs/session-index.md#schema, verbatim. */
const SCHEMA = `
CREATE TABLE files (
  file_id            INTEGER PRIMARY KEY,
  path               TEXT    NOT NULL UNIQUE,
  session_id         TEXT    NOT NULL,
  started            INTEGER NOT NULL,
  consumed           INTEGER NOT NULL,
  lines              INTEGER NOT NULL,
  last_time          INTEGER NOT NULL,
  mtime              INTEGER NOT NULL,
  tail_offset        INTEGER NOT NULL,
  tail_hash          TEXT    NOT NULL,
  session_name       TEXT,
  first_user_message TEXT
);
CREATE TABLE entries (
  file_id   INTEGER NOT NULL,
  line      INTEGER NOT NULL,
  offset    INTEGER NOT NULL,
  bytes     INTEGER NOT NULL,
  entry_id  TEXT    NOT NULL,
  parent_id TEXT,
  time      INTEGER NOT NULL,
  lineage   INTEGER NOT NULL,
  PRIMARY KEY (file_id, line),
  UNIQUE (file_id, entry_id)
) WITHOUT ROWID;
CREATE TABLE items (
  item_id  INTEGER PRIMARY KEY,
  file_id  INTEGER NOT NULL,
  line     INTEGER NOT NULL,
  part     TEXT    NOT NULL,
  kind     TEXT    NOT NULL,
  tool     TEXT,
  is_error INTEGER NOT NULL,
  call_id  TEXT,
  time     INTEGER NOT NULL,
  UNIQUE (file_id, line, part)
);
CREATE INDEX items_time ON items (time);
CREATE INDEX items_call ON items (file_id, call_id) WHERE call_id IS NOT NULL;
CREATE VIRTUAL TABLE item_text USING fts5 (
  text, content = '', contentless_delete = 1, detail = none, tokenize = 'trigram'
);
`;

/** The most code points of a first user line (specs/session-index.md#schema). */
const USER_LINE_CODE_POINTS = 80;

/** The index file's path: `PI_DENT_SEARCH_DB` when set and non-empty, else `~/.pi/pi-dent/search-v3.sqlite` (specs/session-index.md#location). */
export function searchIndexPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const configured = env[SEARCH_DB_ENV];
  if (configured !== undefined && configured.length > 0) return configured;
  return join(home, ".pi", "pi-dent", INDEX_FILE_NAME);
}

/**
 * The session store's path, which the index MUST NOT share (specs/session-index.md#location): `PI_DENT_FLEET_DB`
 * when set and non-empty, else `~/.pi/pi-dent/fleet-v2.sqlite` (specs/session-store.md#location).
 * The store's module owns this resolution; it is repeated here because specs/session-index.md#location makes
 * the index responsible for not being the store's file.
 */
export function sessionStorePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const configured = env[STORE_DB_ENV];
  if (configured !== undefined && configured.length > 0) return configured;
  return join(home, ".pi", "pi-dent", STORE_FILE_NAME);
}

/** How the opener treats the file: the index opener creates and repairs, the prune opener does neither (specs/session-index.md#index-prune). */
type OpenMode = "index" | "prune";

/** How an index is opened (specs/session-index.md#location). */
export interface SessionIndexOptions {
  /** The index file's path. Default: `searchIndexPath()` (specs/session-index.md#location). */
  path?: string | undefined;
  /** The SQLite busy timeout in milliseconds. Default 1000 (specs/session-index.md#location). */
  busyTimeoutMs?: number | undefined;
  /** How the opener treats the file. Default `index`; the prune passes `prune` (specs/session-index.md#index-prune). */
  mode?: OpenMode | undefined;
  /** The session store's path, which the index must not share. Default `sessionStorePath()` (specs/session-index.md#location). */
  storePath?: string | undefined;
}

/** The outcome of opening an index: usable, or unusable with the reason of specs/session-index.md#failures. */
export type SessionIndexOpen = { ok: true; index: SessionIndex } | { ok: false; reason: string };

/** A `files` row (specs/session-index.md#schema). */
export interface IndexFileRow {
  /** `file_id`, assigned by the database at insertion. */
  fileId: number;
  /** The session file's absolute path with symbolic links resolved. */
  path: string;
  /** The `id` of the session header. */
  sessionId: string;
  /** The `time` of the session header. */
  started: number;
  /** The number of consumed bytes. */
  consumed: number;
  /** The number of lines in the consumed bytes. */
  lines: number;
  /** The `time` of the last session entry in the consumed bytes. */
  lastTime: number;
  /** The file's modification time as observed by the catch-up that last changed the row. */
  mtime: number;
  /** The offset of the first byte of the last line of the consumed bytes. */
  tailOffset: number;
  /** The SHA-256 digest of the tail line, lowercase hexadecimal. */
  tailHash: string;
  /** `session_name`: the session name of the consumed bytes, else null. */
  sessionName: string | null;
  /** `first_user_message`: the first user line of the consumed bytes, else null. */
  firstUserMessage: string | null;
}

/** The session title of one session file (specs/session-index.md#session-titles). */
export interface SessionTitle {
  sessionName: string | null;
  firstUserMessage: string | null;
  /** True when the row's `consumed` and `mtime` equal the file's current size and modification time. */
  complete: boolean;
}

/** One `items` row with the `entries` and `files` columns a reader needs (specs/session-index.md#schema). */
export interface IndexItemRow {
  /** `item_id`, assigned by the database at insertion. */
  itemId: number;
  /** The `file_id` of the item's file. */
  fileId: number;
  /** The session file's absolute path with symbolic links resolved. */
  path: string;
  /** The line number of the item's entry. */
  line: number;
  /** The item's part, or the empty string when it has none. */
  part: string;
  /** The item kind (specs/session-transcript.md#transcript-items). */
  kind: string;
  /** The tool name with `A-Z` lowercased for a `tool_call` or `tool_result` item, else null. */
  tool: string | null;
  /** True for a `tool_result` item that is an error result. */
  isError: boolean;
  /** The item's tool-call ID, else null. */
  callId: string | null;
  /** The item's `time`. */
  time: number;
  /** The entry ID of the item's entry. */
  entryId: string;
  /** The offset of the first byte of the entry's line. */
  offset: number;
  /** The length of the entry's line, its line feed not counted. */
  bytes: number;
  /** True when the entry is on the current lineage of the consumed bytes. */
  lineage: boolean;
  /** The `consumed` of the file's `files` row when the row was read (specs/session-index.md#catch-up). */
  consumed: number;
  /** The `tail_hash` of the file's `files` row when the row was read (specs/session-index.md#catch-up). */
  tailHash: string;
}

/** The outcome of a catch-up (specs/session-index.md#catch-up). */
export type CatchUpStatus = "complete" | "incomplete" | "failed-write" | "unusable" | "not-session";

/** What a catch-up reports (specs/session-index.md#catch-up and specs/session-index.md#failures). */
export interface CatchUpOutcome {
  /** `complete` when no line feed is left between the consumed bytes and the file's size. */
  status: CatchUpStatus;
  /** The reason of a failed write or an unusable index; undefined otherwise. */
  reason: string | undefined;
  /** The session-file bytes this catch-up read. */
  bytesRead: number;
  /** The transactions this catch-up committed. */
  transactions: number;
}

/** How a catch-up is stopped (specs/session-index.md#catch-up and specs/session-index.md#concurrent-access). */
export interface CatchUpOptions {
  /** The instant, milliseconds since the Unix epoch, at which no further transaction starts. */
  deadline?: number | undefined;
  /** The current instant, milliseconds since the Unix epoch. Default `Date.now`. */
  now?: (() => number) | undefined;
  /** True when the call has aborted; the catch-up then stops. */
  aborted?: (() => boolean) | undefined;
}

/** The filters a reader applies to one session's items (specs/search-tool.md#candidates). */
export interface ItemFilter {
  /** Only items of this entry ID. */
  entryId?: string | undefined;
  /** Only items of this part; the empty string is an item without a part. */
  part?: string | undefined;
  /** Only items of these kinds. */
  kinds?: readonly string[] | undefined;
  /** Only `tool_call` and `tool_result` items of this tool, compared with `A-Z` lowercased. */
  tool?: string | undefined;
  /** Only `tool_result` items that are, or are not, error results. */
  isError?: boolean | undefined;
  /** Only items whose `time` is at or after this instant. */
  since?: number | undefined;
  /** Only items whose `time` is before this instant. */
  until?: number | undefined;
  /** True: only items on the current lineage. */
  lineage?: boolean | undefined;
  /** The most items to return, after ordering. */
  limit?: number | undefined;
}

/** The outcome of one read: its value, or the reason the index could not give it (specs/session-index.md#failures). */
export type ReadOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The rows of one read transaction, or the reason the index could not give them (specs/session-index.md#failures). */
export type SnapshotOutcome<T> = ReadOutcome<T>;

/** The two kinds that pair through a tool-call ID (specs/session-transcript.md#transcript-items). */
export type ToolPairKind = "tool_call" | "tool_result";

/** The read methods of one evaluation: they must be called in one read transaction (specs/session-index.md#concurrent-access). */
export interface IndexView {
  /** Every `files` row, in ascending `path` order. */
  files(): ReadOutcome<IndexFileRow[]>;
  /** The `files` row of one session file, its symbolic links resolved; its value is undefined when there is none. */
  fileFor(path: string): ReadOutcome<IndexFileRow | undefined>;
  /** The items of one file in file order (specs/session-transcript.md#transcript-order). */
  listItems(fileId: number, filter?: ItemFilter): ReadOutcome<IndexItemRow[]>;
  /** The item of one entry and part of one file; its value is undefined when there is none. */
  findItem(
    fileId: number,
    entryId: string,
    part?: string | undefined,
  ): ReadOutcome<IndexItemRow | undefined>;
  /**
   * The first item of `kind` with this tool-call ID in file order, the partner of an
   * addressed `tool_call` or `tool_result` item (specs/session-transcript.md#transcript-items); its value is undefined when there is none.
   */
  pairedItem(
    fileId: number,
    callId: string,
    kind: ToolPairKind,
  ): ReadOutcome<IndexItemRow | undefined>;
  /**
   * The item IDs whose match text matches every trigram, or undefined without
   * trigrams. With `detail = none` a query of more than three characters is an
   * AND of single-trigram terms (specs/search-tool.md#evaluation).
   */
  matchingItemIds(
    trigrams: readonly string[],
    fileIds?: readonly number[] | undefined,
  ): ReadOutcome<ReadonlySet<number> | undefined>;
}

/** One item read back from its session file (specs/session-index.md#catch-up). */
export type ItemRead = { status: "item"; item: TranscriptItem } | { status: "stale" };

/** The filters and bounds of one candidate read (specs/search-tool.md#evaluation). */
export interface CandidateFilter {
  /** True: from the newest item down; false: from the oldest up. */
  newest: boolean;
  /** The inclusive time bound the page starts at; with `exactBound`, the only time it holds. */
  bound: number;
  /** True: only items whose `time` equals `bound`. */
  exactBound?: boolean | undefined;
  /** The other, inclusive end of a bounded time window the page holds (Section 2.3). */
  withinTime?: number | undefined;
  /** Only items of these kinds. */
  kinds?: readonly string[] | undefined;
  /** Only `tool_call` and `tool_result` items of this tool, with `A-Z` lowercased. */
  tool?: string | undefined;
  /** Only `tool_result` items that are, or are not, error results. */
  isError?: boolean | undefined;
  /** Only items whose `time` is at or after this instant. */
  since?: number | undefined;
  /** Only items whose `time` is before this instant. */
  until?: number | undefined;
  /** The most rows to return; a negative value means no bound. */
  limit: number;
  /** The trigrams whose match every candidate's text must satisfy. */
  trigrams?: readonly string[] | undefined;
  /** Fetch at most this many matching item IDs first and select the rows by them. */
  narrowFirst?: number | undefined;
  /** Only these item IDs. */
  itemIds?: readonly number[] | undefined;
  /** Only items of these files. */
  fileIds?: readonly number[] | undefined;
  /**
   * True: the files are a large part of the index, and `fileIds` only filters the
   * rows the time order yields, rather than leading the read through the file
   * index (specs/search-tool.md#abort).
   */
  fileIdsFilterOnly?: boolean | undefined;
  /** Only items of lines at or below this number, so that a chunk of one time group never splits a line. */
  lineBelow?: number | undefined;
  /** Only items of lines at or above this number. */
  lineAbove?: number | undefined;
  /** Order rows of equal `time` by line number this way, for those chunks (Section 2.3). */
  lineOrder?: "asc" | "desc" | undefined;
}

/**
 * One page of candidates with what the reader uses of their files
 * (specs/search-tool.md#coverage): the rows, the `files` rows of
 * their files, and the `item_text` matches of the rows, all from one read
 * transaction (specs/session-index.md#concurrent-access).
 */
export interface CandidatePage {
  /** The candidate rows, in ascending or descending `time` order as asked. */
  rows: IndexItemRow[];
  /** The `files` rows of the files the rows belong to. */
  files: IndexFileRow[];
  /** With trigrams: the IDs among `rows` whose text matches every trigram; undefined without. */
  matched: ReadonlySet<number> | undefined;
  /** True when `narrowFirst` found more matching items than it admitted; no rows are returned then. */
  overflow: boolean;
}

/** The outcome of a conditional reset (specs/session-index.md#catch-up). */
export type ResetOutcome =
  | { status: "reset" }
  | { status: "unchanged" }
  | { status: "stopped" }
  | { status: "failed-write"; reason: string }
  | { status: "unusable"; reason: string };

/** What a continuation of catch-up reports (specs/search-tool.md#coverage). */
export interface ContinuationOutcome {
  status: "complete" | "stopped" | "failed-write" | "unusable";
  reason: string | undefined;
}

/** A continuation of catch-up the caller starts and stops (Section 2.2). */
export interface CatchUpContinuation {
  /** Settles when the continuation ends. */
  readonly done: Promise<ContinuationOutcome>;
  /** Stop the continuation; it ends after the transaction in flight. */
  stop(): void;
}

/** The outcome of an index prune (specs/session-index.md#index-prune). */
export interface PruneOutcome {
  /** The number of `files` rows deleted. */
  files: number;
  /** The number of transactions the prune ran. */
  transactions: number;
}

// ---------------------------------------------------------------------------
// Opening (specs/session-index.md#location and specs/session-index.md#failures)
// ---------------------------------------------------------------------------

/** Open the session index (specs/session-index.md#location and specs/session-index.md#failures): the usable index, or the reason it is unusable. */
export function openSessionIndex(options: SessionIndexOptions = {}): SessionIndexOpen {
  const index = new SessionIndex(options);
  const reason = index.start();
  return reason === undefined ? { ok: true, index } : { ok: false, reason };
}

/** A file's size and modification time, read once at the start of a catch-up (specs/session-index.md#catch-up). */
interface FileStamp {
  size: number;
  mtime: number;
}

/** The outcome of one opening attempt. */
type TryOpen =
  | { kind: "open"; db: DatabaseSync }
  | { kind: "corrupt"; message: string }
  | { kind: "unusable"; reason: string };

/** The outcome of one write transaction (specs/session-index.md#concurrent-access and specs/session-index.md#failures). */
type TransactionOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "stopped" }
  | { kind: "failed-write"; reason: string }
  | { kind: "unusable"; reason: string };

/** The outcome of one catch-up transaction (specs/session-index.md#catch-up). */
type StepOutcome =
  | { kind: "complete"; bytesRead: number }
  | { kind: "progress"; bytesRead: number; advanced: number }
  | { kind: "not-session"; bytesRead: number }
  | { kind: "stopped" }
  | { kind: "failed-write"; reason: string }
  | { kind: "unusable"; reason: string };

/** One `files` row as the catch-up inserts it. */
interface NewFileRow {
  path: string;
  sessionId: string;
  started: number;
  consumed: number;
  lines: number;
  lastTime: number;
  mtime: number;
  tailOffset: number;
  tailHash: string;
}

/** The bytes of one transaction's region, read once, and how many of them a read consumes (specs/session-index.md#catch-up). */
interface RegionRead {
  bytes: Buffer;
  consumed: number;
  /** True when a line feed at or after the limit cut the region, so more lines follow it. */
  cutAtLineFeed: boolean;
}

/** The `parent_id` and `lineage` of one entry, for the incremental lineage (specs/session-index.md#catch-up). */
interface LineageRow {
  parentId: string | null;
  lineage: boolean;
}

/**
 * The session index of one tool call: an open SQLite file, the catch-up that
 * brings one session file's rows up to the file, and the reads
 * [search-tool.md](search-tool.md) answers from. Every specified outcome is a
 * return value; nothing is thrown for a failure of the index (specs/session-index.md#failures).
 */
export class SessionIndex implements IndexView {
  /** The index file's path (specs/session-index.md#location). */
  readonly path: string;
  /** The SQLite busy timeout in milliseconds: 1000 unless injected (specs/session-index.md#location). */
  readonly busyTimeoutMs: number;
  private readonly mode: OpenMode;
  private readonly storePath: string;
  private db: DatabaseSync | undefined;
  private device = -1;
  private inode = -1;
  private recovered = false;
  private unusable: string | undefined;
  private failedWrite: string | undefined;
  private readDepth = 0;
  private openings = 0;

  constructor(options: SessionIndexOptions = {}) {
    this.path = options.path ?? searchIndexPath();
    this.busyTimeoutMs = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
    this.mode = options.mode ?? "index";
    this.storePath = options.storePath ?? sessionStorePath();
  }

  /**
   * Use the file at the index path when it was replaced or deleted since the index
   * was opened (specs/session-index.md#location): true when the index is usable afterwards. A caller
   * compares `generation` only after this, so that a replaced file is seen first.
   */
  refreshNow(): boolean {
    return this.refresh() === undefined;
  }

  /** The number of times this call has opened the index file; it grows when the file was opened anew (specs/session-index.md#failures). */
  get generation(): number {
    return this.openings;
  }

  /** The reason the index is unusable for the rest of the call, or undefined (specs/session-index.md#failures). */
  unusableReason(): string | undefined {
    return this.unusable;
  }

  /** The reason of the call's first failed write, or undefined (specs/session-index.md#concurrent-access and specs/session-index.md#failures). */
  failedWriteReason(): string | undefined {
    return this.failedWrite;
  }

  /** Close the file; a call does this when it is done with the index (specs/session-index.md#concurrent-access). */
  close(): void {
    this.closeDatabase();
  }

  // -------------------------------------------------------------------------
  // specs/session-index.md#location: opening the file and creating the schema
  // -------------------------------------------------------------------------

  /** Open the index file; returns the reason it is unusable, or undefined when it is usable. */
  start(): string | undefined {
    return this.openDatabase();
  }

  private openDatabase(): string | undefined {
    // specs/session-index.md#failures: the index path MUST NOT name the session store's file, and the file is not opened then.
    if (sameFile(this.path, this.storePath)) {
      return this.markUnusable("the index file is the session store file");
    }
    if (this.mode === "index") {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
      } catch (error) {
        return this.markUnusable(errorMessage(error));
      }
    }
    for (;;) {
      const attempt = this.tryOpen();
      if (attempt.kind === "open") {
        this.attach(attempt.db);
        return;
      }
      if (attempt.kind === "unusable") return this.markUnusable(attempt.reason);
      if (this.mode === "prune" || this.recovered) {
        return this.markUnusable(`index file is corrupt: ${attempt.message}`);
      }
      this.recovered = true;
      this.deleteIndexFiles();
    }
  }

  /**
   * One opening attempt. The version is read on a read-only connection first, so a
   * file that is not used is not changed (specs/session-index.md#failures); the schema of specs/session-index.md#schema is
   * created only for a version-0 file without a table, in one transaction (specs/session-index.md#location).
   */
  private tryOpen(): TryOpen {
    const exists = statFile(this.path) !== undefined;
    if (!exists) {
      // specs/session-index.md#index-prune: the prune MUST NOT create the index file when it is absent.
      if (this.mode === "prune") return { kind: "unusable", reason: "the index file is absent" };
      return this.createIndex();
    }
    const probe = this.probe();
    if (probe.kind !== "version") {
      // A read-only connection cannot read it: let the read-write open report its own failure.
      return probe.kind === "corrupt" ? probe : this.openExisting();
    }
    if (probe.version === FORMAT_VERSION) return this.openExisting();
    if (probe.version === 0 && probe.tables === 0) {
      if (this.mode === "prune") return { kind: "unusable", reason: "the index has no schema" };
      return this.createIndex();
    }
    return { kind: "unusable", reason: `unsupported index version ${probe.version}` };
  }

  /** The version and table count of an existing file, read on a read-only connection (specs/session-index.md#failures). */
  private probe():
    | { kind: "version"; version: number; tables: number }
    | { kind: "corrupt"; message: string }
    | { kind: "unreadable" } {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.path, { readOnly: true });
    } catch (error) {
      if (isCorruptError(error)) return { kind: "corrupt", message: errorMessage(error) };
      return { kind: "unreadable" };
    }
    try {
      db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
      const version = userVersion(db);
      return { kind: "version", version, tables: tableCount(db) };
    } catch (error) {
      if (isCorruptError(error)) return { kind: "corrupt", message: errorMessage(error) };
      return { kind: "unreadable" };
    } finally {
      try {
        db.close();
      } catch {
        // A handle that cannot be closed is already unusable.
      }
    }
  }

  /** Open an existing index read-write and use it; any other version is unusable (specs/session-index.md#location, step 3). */
  private openExisting(): TryOpen {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.path);
    } catch (error) {
      if (isCorruptError(error)) return { kind: "corrupt", message: errorMessage(error) };
      return { kind: "unusable", reason: errorMessage(error) };
    }
    try {
      db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
      const version = userVersion(db);
      if (version !== FORMAT_VERSION) {
        db.close();
        return { kind: "unusable", reason: `unsupported index version ${version}` };
      }
      if (this.mode === "index") db.exec("PRAGMA journal_mode = WAL;");
      return { kind: "open", db };
    } catch (error) {
      rollbackQuietly(db);
      try {
        db.close();
      } catch {
        // A handle that cannot be closed is already unusable.
      }
      if (isCorruptError(error)) return { kind: "corrupt", message: errorMessage(error) };
      return { kind: "unusable", reason: errorMessage(error) };
    }
  }

  /** Create the file and the schema of specs/session-index.md#schema, the check and the creation in one transaction (specs/session-index.md#location, step 2). */
  private createIndex(): TryOpen {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.path);
    } catch (error) {
      if (isCorruptError(error)) return { kind: "corrupt", message: errorMessage(error) };
      return { kind: "unusable", reason: errorMessage(error) };
    }
    try {
      db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
      db.exec("BEGIN IMMEDIATE");
      const version = userVersion(db);
      const tables = tableCount(db);
      if (version !== 0 || tables !== 0) {
        db.exec(version === FORMAT_VERSION ? "COMMIT" : "ROLLBACK");
        if (version === FORMAT_VERSION) {
          if (this.mode === "index") db.exec("PRAGMA journal_mode = WAL;");
          return { kind: "open", db };
        }
        db.close();
        return { kind: "unusable", reason: `unsupported index version ${version}` };
      }
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${FORMAT_VERSION};`);
      db.exec("COMMIT");
      db.exec("PRAGMA journal_mode = WAL;");
      return { kind: "open", db };
    } catch (error) {
      rollbackQuietly(db);
      try {
        db.close();
      } catch {
        // A handle that cannot be closed is already unusable.
      }
      if (isCorruptError(error)) return { kind: "corrupt", message: errorMessage(error) };
      return { kind: "unusable", reason: errorMessage(error) };
    }
  }

  private attach(db: DatabaseSync): void {
    this.db = db;
    this.openings += 1;
    const stat = statFile(this.path);
    this.device = stat === undefined ? -1 : stat.dev;
    this.inode = stat === undefined ? -1 : stat.ino;
  }

  private closeDatabase(): void {
    const db = this.db;
    this.db = undefined;
    if (db === undefined) return;
    try {
      db.close();
    } catch {
      // A handle that cannot be closed is already unusable.
    }
  }

  private markUnusable(reason: string): string {
    if (this.unusable === undefined) this.unusable = reason;
    this.closeDatabase();
    return this.unusable;
  }

  private failWrite(reason: string): string {
    if (this.failedWrite === undefined) this.failedWrite = reason;
    return reason;
  }

  /** Delete the file and its `-wal` and `-shm` companions (specs/session-index.md#failures). */
  private deleteIndexFiles(): void {
    this.closeDatabase();
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        unlinkSync(path);
      } catch {
        // Absent companions are the usual case; a file that cannot be deleted is left.
      }
    }
  }

  /** Use the file at the path when a call starts; a deleted or replaced file is opened anew (specs/session-index.md#location). */
  private refresh(): string | undefined {
    if (this.unusable !== undefined) return this.unusable;
    const stat = statFile(this.path);
    if (stat !== undefined && stat.dev === this.device && stat.ino === this.inode) return;
    this.closeDatabase();
    return this.openDatabase();
  }

  // -------------------------------------------------------------------------
  // specs/session-index.md#catch-up: catch-up
  // -------------------------------------------------------------------------

  /** Bring one session file's rows up to the file (specs/session-index.md#catch-up). */
  async catchUp(sessionPath: string, options: CatchUpOptions = {}): Promise<CatchUpOutcome> {
    const failure = this.refresh();
    if (failure !== undefined) return catchUpOutcome("unusable", 0, 0, failure);
    const failed = this.failedWrite;
    if (failed !== undefined) return catchUpOutcome("failed-write", 0, 0, failed);
    const path = sessionFilePath(sessionPath);
    const stamp = stampOf(path);
    if (stamp === undefined) {
      // specs/session-index.md#catch-up: a file that is absent has no catch-up; every row of its path is deleted.
      const dropped = await this.dropRows(path, options);
      if (dropped.kind === "ok") return catchUpOutcome("not-session", 0, 0);
      if (dropped.kind === "stopped") return catchUpOutcome("not-session", 0, 0);
      return catchUpOutcome(dropped.kind, 0, 0, dropped.reason);
    }
    const found = this.fileByPath(path);
    if (!found.ok) return catchUpOutcome("unusable", 0, 0, found.reason);
    const row = found.value;
    // specs/session-index.md#catch-up step 2: an unchanged file costs no read.
    if (row !== undefined && row.consumed === stamp.size && row.mtime === stamp.mtime) {
      return catchUpOutcome("complete", 0, 0);
    }
    let bytesRead = 0;
    let transactions = 0;
    for (;;) {
      if (stopped(options)) return catchUpOutcome("incomplete", bytesRead, transactions);
      // specs/session-index.md#concurrent-access: the writer yields to the event loop between two transactions.
      await yieldToEventLoop();
      if (stopped(options)) return catchUpOutcome("incomplete", bytesRead, transactions);
      const step = await this.transaction(path, stamp.size, stamp.mtime, options);
      if (step.kind === "complete") {
        return catchUpOutcome("complete", bytesRead + step.bytesRead, transactions + 1);
      }
      if (step.kind === "progress") {
        bytesRead += step.bytesRead;
        transactions += 1;
        if (step.advanced === 0) return catchUpOutcome("incomplete", bytesRead, transactions);
        continue;
      }
      if (step.kind === "not-session") {
        return catchUpOutcome("not-session", bytesRead + step.bytesRead, transactions);
      }
      if (step.kind === "stopped") return catchUpOutcome("incomplete", bytesRead, transactions);
      return catchUpOutcome(step.kind, bytesRead, transactions, step.reason);
    }
  }

  /** Delete every row of one path in one transaction: a file with no catch-up keeps no rows (specs/session-index.md#catch-up). */
  private async dropRows(
    path: string,
    options: CatchUpOptions,
  ): Promise<TransactionOutcome<boolean>> {
    return this.writeTransaction((db) => {
      const row = selectFileRowByPath(db, path);
      if (row === undefined) return { commit: false, value: false };
      deleteFileRows(db, row.fileId);
      return { commit: true, value: true };
    }, options);
  }

  /**
   * Continue the catch-up of sessions after a call returned, in the order given,
   * until each is complete, a write fails, or the deadline ends
   * (specs/search-tool.md#coverage).
   */
  continueCatchUp(
    sessionPaths: readonly string[],
    options: CatchUpOptions = {},
  ): CatchUpContinuation {
    let stopRequested = false;
    const stopOptions: CatchUpOptions = {
      deadline: options.deadline,
      now: options.now,
      aborted: () => stopRequested || (options.aborted !== undefined && options.aborted()),
    };
    const done = (async (): Promise<ContinuationOutcome> => {
      for (const sessionPath of sessionPaths) {
        if (stopRequested || stopped(stopOptions)) return continuationOutcome("stopped");
        await yieldToEventLoop();
        if (stopRequested) return continuationOutcome("stopped");
        const outcome = await this.catchUp(sessionPath, stopOptions);
        if (outcome.status === "failed-write") {
          return continuationOutcome("failed-write", outcome.reason);
        }
        if (outcome.status === "unusable") return continuationOutcome("unusable", outcome.reason);
        if (outcome.status === "incomplete") return continuationOutcome("stopped");
      }
      return continuationOutcome("complete");
    })();
    return {
      done,
      stop: () => {
        stopRequested = true;
      },
    };
  }

  /** One catch-up transaction: re-read the row, reset when it is stale, extend by at most the limit (specs/session-index.md#catch-up and specs/session-index.md#concurrent-access). */
  private async transaction(
    path: string,
    size: number,
    mtime: number,
    options: CatchUpOptions,
  ): Promise<StepOutcome> {
    const failure = this.refresh();
    if (failure !== undefined) return { kind: "unusable", reason: failure };
    const failed = this.failedWrite;
    if (failed !== undefined) return { kind: "failed-write", reason: failed };
    const outcome = await this.writeTransaction(
      (db) => this.stepBody(db, path, size, mtime),
      options,
    );
    if (outcome.kind === "ok") return outcome.value;
    if (outcome.kind === "stopped") return { kind: "stopped" };
    return { kind: outcome.kind, reason: outcome.reason };
  }

  /** The body of one catch-up transaction (specs/session-index.md#catch-up, steps 1 to 4). */
  private stepBody(
    db: DatabaseSync,
    path: string,
    size: number,
    mtime: number,
  ): { commit: boolean; value: StepOutcome } {
    let bytesRead = 0;
    const row = selectFileRowByPath(db, path);
    let fileId: number | undefined;
    let sessionId = "";
    let consumed = 0;
    let lines = 0;
    let lastTime = 0;
    let tailOffset = 0;
    let tailHash = "";
    let sessionName: string | null = null;
    let firstUserMessage: string | null = null;
    let reset = false;
    if (row !== undefined) {
      fileId = row.fileId;
      sessionName = row.sessionName;
      firstUserMessage = row.firstUserMessage;
      sessionId = row.sessionId;
      consumed = row.consumed;
      lines = row.lines;
      lastTime = row.lastTime;
      tailOffset = row.tailOffset;
      tailHash = row.tailHash;
      if (row.consumed > size) {
        reset = true;
      } else if (row.consumed === size && row.mtime === mtime) {
        return { commit: false, value: { kind: "complete", bytesRead: 0 } };
      } else {
        const tailLength = row.consumed - row.tailOffset;
        const tail = readBytesAt(path, row.tailOffset, tailLength);
        bytesRead += tail === undefined ? 0 : tail.length;
        if (tail === undefined || tail.length !== tailLength || sha256(tail) !== row.tailHash) {
          reset = true;
        } else if (row.consumed === size) {
          // specs/session-index.md#catch-up step 4 with nothing to extend: the modification time alone moves.
          updateProgress(db, fileId, consumed, lines, lastTime, mtime, tailOffset, tailHash);
          return { commit: true, value: { kind: "complete", bytesRead } };
        }
      }
    }
    let previousLeaf: string | undefined;
    if (reset && fileId !== undefined) {
      previousLeaf = selectLeafId(db, fileId);
      deleteFileRows(db, fileId);
      fileId = undefined;
      sessionName = null;
      firstUserMessage = null;
    }
    if (fileId === undefined) {
      const header = readSessionHeaderFile(path);
      // specs/session-index.md#catch-up: a file the read bound does not hold a session header for yet is not readable
      // as a session file, so it has no catch-up.
      if (header === undefined || header.bytes + 1 > size) {
        return { commit: reset, value: { kind: "not-session", bytesRead } };
      }
      const first = readBytesAt(path, 0, header.bytes + 1);
      bytesRead += header.bytes + 1;
      if (first === undefined || first.length !== header.bytes + 1) {
        return { commit: reset, value: { kind: "not-session", bytesRead } };
      }
      consumed = header.bytes + 1;
      lines = 1;
      lastTime = header.time;
      tailOffset = 0;
      tailHash = sha256(first);
      sessionId = header.sessionId;
      fileId = insertFileRow(db, {
        path,
        sessionId,
        started: header.time,
        consumed,
        lines,
        lastTime,
        mtime,
        tailOffset,
        tailHash,
      });
    } else {
      previousLeaf = selectLeafId(db, fileId);
    }
    const remaining = size - consumed;
    if (remaining <= 0) return { commit: true, value: { kind: "complete", bytesRead } };
    // specs/session-index.md#catch-up: one transaction extends by at most the limit, or by one longer line. The bytes are
    // read once, so the tail line's digest comes from them (specs/session-index.md#schema).
    const region = readRegion(path, consumed, size, TRANSACTION_BYTE_LIMIT);
    if (region === undefined) {
      // The file vanished under the transaction: its rows are deleted and it is no session.
      deleteFileRows(db, fileId);
      return { commit: true, value: { kind: "not-session", bytesRead } };
    }
    bytesRead += region.bytes.length;
    const read = readSessionBytes(region.bytes.subarray(0, region.consumed), {
      from: consumed,
      line: lines + 1,
      previousTime: lastTime,
      seenIds: [sessionId],
      // specs/session-index.md#schema: the titles come from the added lines and the row's values alone.
      onEntry: (value) => {
        if (value.type === "session_info") sessionName = sessionNameOf(value);
        else if (firstUserMessage === null) firstUserMessage = userLineOf(value) ?? null;
      },
    });
    const nextConsumed = read.consumed;
    // specs/session-index.md#location: an entry ID that an earlier line carries yields no row; the unique index answers per ID.
    const check = entryIdCheck(db);
    const accepted = read.entries.filter(
      (entry) => entry.entryId !== sessionId && !entryIdExists(check, fileId, entry.entryId),
    );
    insertEntries(db, fileId, accepted);
    const nextLines = lines + read.lines;
    const nextLastTime = read.lastTime ?? lastTime;
    const nextTailOffset = read.lines === 0 ? tailOffset : read.tailOffset;
    const nextTailHash =
      read.lines === 0
        ? tailHash
        : sha256(region.bytes.subarray(nextTailOffset - consumed, nextConsumed - consumed));
    // specs/session-index.md#catch-up step 4: the modification time is stored even when only an unterminated line remains.
    updateProgress(
      db,
      fileId,
      nextConsumed,
      nextLines,
      nextLastTime,
      mtime,
      nextTailOffset,
      nextTailHash,
    );
    updateTitles(db, fileId, sessionName, firstUserMessage);
    updateLineage(
      db,
      fileId,
      previousLeaf,
      accepted.map((entry) => entry.entryId),
    );
    // The region covers every byte up to the size only when no line feed cut it, and a line feed that
    // cut it is the end of the region only when the read reached the size.
    const complete =
      !region.cutAtLineFeed ||
      (region.consumed === region.bytes.length && region.bytes.length === remaining);
    const kind = complete ? "complete" : "progress";
    return { commit: true, value: { kind, bytesRead, advanced: nextConsumed - consumed } };
  }

  // -------------------------------------------------------------------------
  // specs/session-index.md#concurrent-access: transactions
  // -------------------------------------------------------------------------

  /**
   * Run one write transaction begun with `BEGIN IMMEDIATE`, retrying a busy begin
   * after a turn of the event loop (specs/session-index.md#concurrent-access).
   */
  private async writeTransaction<T>(
    body: (db: DatabaseSync) => { commit: boolean; value: T },
    options: CatchUpOptions,
    retryBusy = true,
  ): Promise<TransactionOutcome<T>> {
    for (;;) {
      const db = this.db;
      if (db === undefined)
        return { kind: "unusable", reason: this.unusable ?? "the index is not open" };
      let begun = false;
      try {
        begun = await this.beginImmediate(db, options, retryBusy);
        if (!begun) return { kind: "stopped" };
        const { commit, value } = body(db);
        db.exec(commit ? "COMMIT" : "ROLLBACK");
        return { kind: "ok", value };
      } catch (error) {
        if (begun) rollbackQuietly(db);
        if (!isSqliteError(error)) throw error;
        const recovered = this.recoverFrom(error);
        if (recovered === "retry") continue;
        if (recovered !== undefined) return { kind: "unusable", reason: recovered };
        if (isBusyError(error)) {
          if (!retryBusy || stopped(options)) return { kind: "stopped" };
          await delay(BUSY_RETRY_DELAY_MS);
          continue;
        }
        return { kind: "failed-write", reason: this.failWrite(errorMessage(error)) };
      }
    }
  }

  /**
   * Begin a write transaction, retrying while the file is busy: each attempt sleeps
   * for at most the short attempt timeout inside SQLite, and the loop awaits a pause
   * between attempts, so an abort or a deadline is observed (specs/session-index.md#concurrent-access). A transaction
   * that is not attempted again — the prune's — is attempted until the busy timeout has
   * passed, and stops then (specs/session-index.md#index-prune).
   */
  private async beginImmediate(
    db: DatabaseSync,
    options: CatchUpOptions,
    retryBusy: boolean,
  ): Promise<boolean> {
    const startedAt = Date.now();
    for (;;) {
      try {
        setBusyTimeout(db, BUSY_ATTEMPT_MS);
        db.exec("BEGIN IMMEDIATE");
        setBusyTimeout(db, this.busyTimeoutMs);
        return true;
      } catch (error) {
        setBusyTimeout(db, this.busyTimeoutMs);
        if (!isBusyError(error)) throw error;
        if (stopped(options)) return false;
        if (!retryBusy && Date.now() - startedAt >= this.busyTimeoutMs) return false;
        await delay(BUSY_RETRY_DELAY_MS);
        if (stopped(options)) return false;
      }
    }
  }

  /**
   * Handle a corrupt-file report: delete the file and open the index anew, once
   * per call (specs/session-index.md#failures). Returns "retry" when the caller may try again, the
   * unusable reason when it may not, and undefined when the error is not a
   * corruption report.
   */
  private recoverFrom(error: unknown): "retry" | string | undefined {
    if (!isCorruptError(error)) return;
    if (this.mode === "prune" || this.recovered) {
      return this.markUnusable(`index file is corrupt: ${errorMessage(error)}`);
    }
    this.recovered = true;
    this.deleteIndexFiles();
    const reason = this.openDatabase();
    return reason === undefined
      ? "retry"
      : this.markUnusable(`index file is corrupt: ${errorMessage(error)}`);
  }

  /**
   * Run one read transaction, so that one evaluation sees each file's rows as one
   * commit left them (specs/session-index.md#concurrent-access). Only an SQLite error is a failure of the index; an
   * error of the caller's own code ends the transaction and propagates unchanged.
   */
  private readTransaction<T>(body: (db: DatabaseSync) => T): ReadOutcome<T> {
    for (;;) {
      const db = this.db;
      if (db === undefined) return { ok: false, reason: this.unusable ?? "the index is not open" };
      let begun = false;
      this.readDepth += 1;
      try {
        db.exec("BEGIN");
        begun = true;
        const value = body(db);
        db.exec("COMMIT");
        return { ok: true, value };
      } catch (error) {
        if (begun) rollbackQuietly(db);
        if (!isSqliteError(error)) throw error;
        const recovered = this.recoverFrom(error);
        if (recovered === "retry") continue;
        return { ok: false, reason: recovered ?? this.markUnusable(errorMessage(error)) };
      } finally {
        this.readDepth -= 1;
      }
    }
  }

  /** Run one read; outside a snapshot it is a read transaction of its own (specs/session-index.md#concurrent-access). */
  private query<T>(body: (db: DatabaseSync) => T): ReadOutcome<T> {
    const db = this.db;
    if (this.readDepth > 0) {
      // Inside a snapshot the enclosing transaction reports failures; a caller's error propagates.
      if (db === undefined) {
        return { ok: false, reason: this.unusable ?? "the index is not open" };
      }
      return { ok: true, value: body(db) };
    }
    const failure = this.refresh();
    if (failure !== undefined) return { ok: false, reason: failure };
    return this.readTransaction(body);
  }

  /** Take the rows of one evaluation from one read transaction (specs/session-index.md#concurrent-access). */
  snapshot<T>(body: (view: IndexView) => T): SnapshotOutcome<T> {
    if (this.readDepth > 0) return { ok: true, value: body(this) };
    const failure = this.refresh();
    if (failure !== undefined) return { ok: false, reason: failure };
    return this.readTransaction(() => body(this));
  }

  // -------------------------------------------------------------------------
  // Reads for Search (specs/search-tool.md#evaluation and specs/search-tool.md#get)
  // -------------------------------------------------------------------------

  /** Every `files` row, in ascending `path` order (specs/session-index.md#schema). */
  files(): ReadOutcome<IndexFileRow[]> {
    return this.query((db) => selectFiles(db));
  }

  /** The `files` row of one session file, its symbolic links resolved (specs/session-index.md#schema). */
  fileFor(path: string): ReadOutcome<IndexFileRow | undefined> {
    return this.fileByPath(sessionFilePath(path));
  }

  /** The `files` row of a path that is already resolved (specs/session-index.md#schema). */
  private fileByPath(path: string): ReadOutcome<IndexFileRow | undefined> {
    return this.query((db) => selectFileRowByPath(db, path));
  }

  /** The items of one file in file order, with the filters of specs/search-tool.md#candidates applied (specs/session-transcript.md#transcript-order). */
  listItems(fileId: number, filter: ItemFilter = {}): ReadOutcome<IndexItemRow[]> {
    return this.query((db) => filterItems(selectItemRows(db, fileId), filter));
  }

  /** The item of one entry and part of one file (specs/search-tool.md#get). */
  findItem(
    fileId: number,
    entryId: string,
    part?: string | undefined,
  ): ReadOutcome<IndexItemRow | undefined> {
    return this.query((db) => selectItemRow(db, fileId, entryId, part ?? ""));
  }

  /** The first item of `kind` with this tool-call ID in file order, the partner of an addressed item (specs/session-index.md#schema). */
  pairedItem(
    fileId: number,
    callId: string,
    kind: ToolPairKind,
  ): ReadOutcome<IndexItemRow | undefined> {
    return this.query((db) => selectPairedItem(db, fileId, callId, kind));
  }

  /**
   * The item IDs whose match text matches every trigram, or undefined without
   * trigrams. With `detail = none` a query of more than three characters is an
   * AND of single-trigram terms (specs/search-tool.md#evaluation).
   */
  matchingItemIds(
    trigrams: readonly string[],
    fileIds?: readonly number[] | undefined,
  ): ReadOutcome<ReadonlySet<number> | undefined> {
    const query = trigramQuery(trigrams);
    if (query === undefined) return { ok: true, value: undefined };
    return this.query((db) => selectTrigramIds(db, query, fileIds));
  }

  /** The session titles of session files, keyed by the paths as given (specs/session-index.md#session-titles). */
  titles(paths: readonly string[]): ReadOutcome<Map<string, SessionTitle>> {
    const resolved = new Map<string, string>();
    for (const path of paths) {
      if (resolved.has(path)) continue;
      const real = resolvedTitlePath(path);
      if (real !== undefined) resolved.set(path, real);
    }
    const rows = this.query((db) => selectTitleRows(db, [...new Set(resolved.values())]));
    if (!rows.ok) return rows;
    const titles = new Map<string, SessionTitle>();
    for (const [given, real] of resolved) {
      const row = rows.value.get(real);
      if (row === undefined) continue;
      const stamp = stampOf(real);
      titles.set(given, {
        sessionName: row.sessionName,
        firstUserMessage: row.firstUserMessage,
        complete: stamp !== undefined && stamp.size === row.consumed && stamp.mtime === row.mtime,
      });
    }
    return { ok: true, value: titles };
  }

  /**
   * The `files` rows of session file paths, read in one transaction: what a call
   * checks before it catches a session up (specs/session-index.md#catch-up, step 2;
   * specs/search-tool.md#coverage).
   */
  filesForPaths(paths: readonly string[]): ReadOutcome<IndexFileRow[]> {
    if (paths.length === 0) return { ok: true, value: [] };
    const resolved = paths.map((path) => sessionFilePath(path));
    return this.snapshot(() => {
      const db = this.db;
      if (db === undefined) return [];
      const rows: IndexFileRow[] = [];
      const statement = db.prepare(
        "SELECT * FROM files WHERE path IN (SELECT value FROM json_each(?))",
      );
      for (const row of statement.all(JSON.stringify(resolved))) {
        const file = fileRowOf(row);
        if (file !== undefined) rows.push(file);
      }
      return rows;
    });
  }

  /**
   * The `files` rows of paths already resolved, read in one transaction: what a
   * call checks before it catches its sessions up, without resolving each path
   * again (specs/session-index.md#catch-up, step 2; specs/search-tool.md#coverage).
   */
  filesForResolvedPaths(
    paths: readonly string[],
  ): ReadOutcome<{ rows: IndexFileRow[]; dataVersion: number }> {
    return this.snapshot(() => {
      const db = this.db;
      if (db === undefined) return { rows: [], dataVersion: -1 };
      const rows: IndexFileRow[] = [];
      const dataVersion = dataVersionOf(db);
      if (paths.length === 0) return { rows, dataVersion };
      const countRow = db.prepare("SELECT count(*) AS n FROM files").get();
      const total = isPlainObject(countRow) ? (numberOf(countRow.n) ?? 0) : 0;
      if (paths.length * 4 > total) {
        // Most of the index: one pass over the table costs less than a lookup per path.
        const wanted = new Set(paths);
        for (const row of db.prepare("SELECT * FROM files").all()) {
          if (!isPlainObject(row) || !wanted.has(stringOf(row.path) ?? "")) continue;
          const file = fileRowOf(row);
          if (file !== undefined) rows.push(file);
        }
        return { rows, dataVersion };
      }
      const statement = db.prepare(
        "SELECT * FROM files WHERE path IN (SELECT value FROM json_each(?))",
      );
      for (const row of statement.all(JSON.stringify(paths))) {
        const file = fileRowOf(row);
        if (file !== undefined) rows.push(file);
      }
      return { rows, dataVersion };
    });
  }

  /**
   * The trigram matches among the rows of one file, with the identities of those
   * rows and the file's `files` row, from one read transaction (specs/session-index.md#concurrent-access;
   * specs/search-tool.md#evaluation). `intact` is false when a row
   * is gone or its `item_id` now names another item: the caller then no longer
   * reads the file's rows as it loaded them.
   */
  probeRows(
    rows: readonly IndexItemRow[],
    trigrams: readonly string[],
    fileId: number,
  ): ReadOutcome<{ matched: Set<number>; intact: boolean; files: IndexFileRow[] }> {
    const query = trigramQuery(trigrams);
    return this.snapshot(() => {
      const db = this.db;
      if (db === undefined) return { matched: new Set<number>(), intact: false, files: [] };
      const ids = rows.map((row) => row.itemId);
      const identity = new Map<number, string>();
      const statement = db.prepare(
        "SELECT item_id, file_id, line, part FROM items WHERE item_id IN (SELECT value FROM json_each(?))",
      );
      for (const row of statement.all(JSON.stringify(ids))) {
        if (!isPlainObject(row)) continue;
        const id = numberOf(row.item_id);
        if (id === undefined) continue;
        identity.set(id, `${numberOf(row.file_id)}:${numberOf(row.line)}:${stringOf(row.part)}`);
      }
      const intact = rows.every(
        (row) => identity.get(row.itemId) === `${row.fileId}:${row.line}:${row.part}`,
      );
      const matched = query === undefined ? new Set<number>(ids) : selectMatchedIds(db, query, ids);
      return { matched, intact, files: selectFilesByIds(db, [fileId]) };
    });
  }

  /**
   * The connection's `data_version`: it changes when another connection has
   * committed since this one last read, and not for this connection's own
   * commits. A reader compares two to know whether rows it read are still as
   * they were (specs/session-index.md#concurrent-access).
   */
  dataVersion(): ReadOutcome<number> {
    return this.query((db) => dataVersionOf(db));
  }

  /** The greatest `item_id`, or 0 for an index with no item: the end of a collection (specs/search-tool.md#evaluation). */
  maxItemId(): ReadOutcome<number> {
    return this.query((db) => {
      const row = db.prepare("SELECT max(item_id) AS n FROM items").get();
      return isPlainObject(row) ? (numberOf(row.n) ?? 0) : 0;
    });
  }

  /**
   * The IDs of the items in `item_id` range (`after`, `upTo`] that pass the
   * filter, at most `filter.limit`: one chunk of a collection, which reads rows in
   * `item_id` order and so costs the same whatever their times
   * (specs/search-tool.md#abort and specs/search-tool.md#evaluation). With `fileIds`, the
   * files' own rows are read instead and the range is ignored.
   */
  candidateIds(filter: CandidateFilter, after: number, upTo: number): ReadOutcome<number[]> {
    return this.query((db) => selectCandidateIds(db, filter, after, upTo));
  }

  /**
   * The rows of the item IDs that pass the filter, with their files' rows and
   * their trigram matches, from one read transaction (specs/session-index.md#concurrent-access;
   * specs/search-tool.md#coverage). Without trigrams `matched` is
   * undefined; with them, the IDs are probed in chunks.
   */
  rowsOfIds(filter: CandidateFilter, itemIds: readonly number[]): ReadOutcome<CandidatePage> {
    const query = trigramQuery(filter.trigrams ?? []);
    return this.snapshot(() => {
      const db = this.db;
      if (db === undefined) return { rows: [], files: [], matched: undefined, overflow: false };
      let ids = itemIds;
      let matched: Set<number> | undefined;
      if (query !== undefined) {
        matched = new Set<number>();
        for (let start = 0; start < itemIds.length; start += PROBE_CHUNK) {
          for (const id of selectMatchedIds(db, query, itemIds.slice(start, start + PROBE_CHUNK))) {
            matched.add(id);
          }
        }
        // Only matched rows are needed: the others are decided by the narrowing.
        ids = [...matched];
      }
      const rows = selectCandidates(db, { ...filter, itemIds: ids, limit: -1 });
      return {
        rows,
        files: selectFilesByIds(db, distinctFileIds(rows)),
        matched,
        overflow: false,
      };
    });
  }

  /** The number of `files` rows, which a call compares its own file count with (Section 2.3). */
  fileCount(): ReadOutcome<number> {
    return this.query((db) => {
      const row = db.prepare("SELECT count(*) AS n FROM files").get();
      return isPlainObject(row) ? (numberOf(row.n) ?? 0) : 0;
    });
  }

  /**
   * The greatest and least `time` of one file's items, or undefined when it has
   * none: what a call orders its sessions by before it loads them
   * (specs/search-tool.md#evaluation).
   */
  itemTimeBounds(fileId: number): ReadOutcome<{ max: number; min: number } | undefined> {
    return this.query((db) => {
      const row = db
        .prepare("SELECT max(time) AS hi, min(time) AS lo FROM items WHERE file_id = ?")
        .get(fileId);
      if (!isPlainObject(row)) return;
      const max = numberOf(row.hi);
      const min = numberOf(row.lo);
      if (max === undefined || min === undefined) return;
      return { max, min };
    });
  }

  /**
   * The `files` rows of the file IDs, read in one transaction: what a call checks
   * a session's cover against as it reads its rows (specs/session-index.md#concurrent-access;
   * specs/search-tool.md#coverage).
   */
  filesFor(fileIds: readonly number[]): ReadOutcome<IndexFileRow[]> {
    return this.snapshot(() => {
      const db = this.db;
      if (db === undefined) return [];
      return selectFilesByIds(db, fileIds);
    });
  }

  /**
   * The time of the `rows`-th item from `bound` in the scan direction, or
   * undefined when fewer items exist: the far end of one bounded time window of a
   * trigramless scan, so that no one statement walks the whole index
   * (specs/search-tool.md#abort and specs/search-tool.md#evaluation).
   */
  windowBoundary(newest: boolean, bound: number, rows: number): ReadOutcome<number | undefined> {
    return this.query((db) => {
      const compare = newest ? "<=" : ">=";
      const order = newest ? "DESC" : "ASC";
      const row = db
        .prepare(
          `SELECT time FROM items WHERE time ${compare} ? ORDER BY time ${order} LIMIT 1 OFFSET ?`,
        )
        .get(bound, rows - 1);
      if (!isPlainObject(row)) return;
      return numberOf(row.time);
    });
  }

  /**
   * One page of candidates with the `files` rows and the `item_text` matches it
   * uses, from one read transaction (specs/session-index.md#concurrent-access; specs/search-tool.md#coverage). With `narrowFirst`, the matching item IDs are fetched first and
   * the rows are selected by them, or `overflow` is set when there are more.
   */
  candidatePage(filter: CandidateFilter): ReadOutcome<CandidatePage> {
    const query = trigramQuery(filter.trigrams ?? []);
    return this.snapshot(() => {
      const db = this.db;
      if (db === undefined) {
        return { rows: [], files: [], matched: undefined, overflow: false };
      }
      const narrowFirst = filter.narrowFirst;
      if (query !== undefined && narrowFirst !== undefined) {
        const ids = selectMatchIds(db, query, narrowFirst + 1);
        if (ids.length > narrowFirst) {
          return { rows: [], files: [], matched: undefined, overflow: true };
        }
        const rows = selectCandidates(db, { ...filter, itemIds: ids, limit: ids.length });
        return {
          rows,
          files: selectFilesByIds(db, distinctFileIds(rows)),
          matched: new Set<number>(ids),
          overflow: false,
        };
      }
      const rows = selectCandidates(db, filter);
      return {
        rows,
        files: selectFilesByIds(db, distinctFileIds(rows)),
        matched:
          query === undefined
            ? undefined
            : selectMatchedIds(
                db,
                query,
                rows.map((row) => row.itemId),
              ),
        overflow: false,
      };
    });
  }

  // -------------------------------------------------------------------------
  // specs/session-index.md#catch-up: reading an item back and the conditional reset
  // -------------------------------------------------------------------------

  /**
   * Read an item's text back from its session file by byte offset and detect a
   * stale row (specs/session-index.md#catch-up): a row is stale when the line it names cannot be read,
   * is not a JSON object whose `id` is the row's entry ID, or does not yield an item
   * with the row's part and kind.
   */
  readItem(row: IndexItemRow): ItemRead {
    const value = readSessionLineAt(row.path, row.offset, row.bytes);
    if (value === undefined || value.id !== row.entryId) return { status: "stale" };
    const entry: TranscriptEntryRef = {
      line: row.line,
      entryId: row.entryId,
      time: row.time,
      value,
    };
    const wanted = row.part === "" ? undefined : row.part;
    for (const item of entryItems(entry)) {
      if (item.part !== wanted) continue;
      // specs/session-index.md#catch-up: an items row is stale when the line read back does not yield an
      // item with the row's part and kind.
      return item.kind === row.kind ? { status: "item", item } : { status: "stale" };
    }
    return { status: "stale" };
  }

  /**
   * Reset the file of a stale row, in one transaction, when its `files` row still
   * has the `consumed` and `tail_hash` the reader read, and change nothing when it
   * has not or is gone (specs/session-index.md#catch-up).
   */
  async resetStale(row: IndexItemRow, options: CatchUpOptions = {}): Promise<ResetOutcome> {
    const failure = this.refresh();
    if (failure !== undefined) return { status: "unusable", reason: failure };
    const failed = this.failedWrite;
    if (failed !== undefined) return { status: "failed-write", reason: failed };
    // A call whose time is up does not start the reset; the session stays uncovered (specs/session-index.md#catch-up).
    if (stopped(options)) return { status: "stopped" };
    // specs/session-index.md#concurrent-access: the writer yields to the event loop before its transaction.
    await yieldToEventLoop();
    if (stopped(options)) return { status: "stopped" };
    const outcome = await this.writeTransaction<ResetOutcome>((db) => {
      const current = selectFileRowById(db, row.fileId);
      if (
        current === undefined ||
        current.consumed !== row.consumed ||
        current.tailHash !== row.tailHash
      ) {
        return { commit: false, value: { status: "unchanged" } };
      }
      deleteFileRows(db, row.fileId);
      return { commit: true, value: { status: "reset" } };
    }, options);
    if (outcome.kind === "ok") return outcome.value;
    if (outcome.kind === "stopped") return { status: "stopped" };
    if (outcome.kind === "failed-write") return { status: "failed-write", reason: outcome.reason };
    return { status: "unusable", reason: outcome.reason };
  }

  /**
   * The entry IDs on the current lineage of the entries of one file that were
   * terminated at or before `size` (specs/session-transcript.md#current-lineage), read from the `entries` rows rather than the `lineage` column,
   * which describes the consumed bytes (specs/search-tool.md#coverage).
   */
  lineageWithin(fileId: number, size: number): ReadOutcome<string[]> {
    return this.query((db) => {
      const entries: { line: number; entryId: string; parentId: string | null }[] = [];
      const statement = db.prepare(
        "SELECT line, entry_id, parent_id, offset, bytes FROM entries WHERE file_id = ? ORDER BY line",
      );
      for (const row of statement.all(fileId)) {
        if (!isPlainObject(row)) continue;
        const line = numberOf(row.line);
        const entryId = stringOf(row.entry_id);
        const offset = numberOf(row.offset);
        const bytes = numberOf(row.bytes);
        if (line === undefined || entryId === undefined) continue;
        if (offset === undefined || bytes === undefined) continue;
        if (offset + bytes + 1 > size) continue;
        entries.push({ line, entryId, parentId: stringOf(row.parent_id) ?? null });
      }
      return currentLineage(entries).map((entry) => entry.entryId);
    });
  }

  // -------------------------------------------------------------------------
  // specs/session-index.md#index-prune: the prune
  // -------------------------------------------------------------------------

  /** One prune transaction over at most 100 `files` rows after `after`; a busy begin stops the prune once the busy timeout has passed (specs/session-index.md#index-prune). */
  async pruneBatch(
    after: number,
  ): Promise<{ deleted: number; last: number; more: boolean } | undefined> {
    const outcome = await this.writeTransaction(
      (db) => {
        const rows = selectFileRowsAfter(db, after, PRUNE_FILES_PER_TRANSACTION);
        let deleted = 0;
        for (const row of rows) {
          const stat = statFile(row.path);
          if (stat !== undefined && stat.isFile()) continue;
          deleteFileRows(db, row.fileId);
          deleted += 1;
        }
        const last = rows[rows.length - 1];
        return {
          commit: deleted > 0,
          value: {
            deleted,
            last: last === undefined ? after : last.fileId,
            more: rows.length === PRUNE_FILES_PER_TRANSACTION,
          },
        };
      },
      {},
      // specs/session-index.md#index-prune: a prune that cannot begin a transaction within the busy timeout stops.
      false,
    );
    if (outcome.kind !== "ok") return;
    return outcome.value;
  }
}

/**
 * The index prune (specs/session-index.md#index-prune): delete, for every `files` row whose path is not an
 * existing regular file, the row and every row of its `file_id`, in transactions
 * of at most 100 `files` rows. It never creates the index file, deletes no file,
 * and reports no failure: it stops and returns what it did.
 */
export async function pruneSessionIndex(options: SessionIndexOptions = {}): Promise<PruneOutcome> {
  const path = options.path ?? searchIndexPath();
  const stat = statFile(path);
  if (stat === undefined) return { files: 0, transactions: 0 };
  const index = new SessionIndex({ ...options, path, mode: "prune" });
  // specs/session-index.md#index-prune: the file is opened without creating it, so a file that vanished is not recreated.
  if (index.start() !== undefined) return { files: 0, transactions: 0 };
  let after = 0;
  let files = 0;
  let transactions = 0;
  for (;;) {
    const batch = await index.pruneBatch(after);
    if (batch === undefined) break;
    transactions += 1;
    files += batch.deleted;
    after = batch.last;
    if (!batch.more) break;
  }
  index.close();
  return { files, transactions };
}

// ---------------------------------------------------------------------------
// The trigram narrowing (specs/search-tool.md#evaluation)
// ---------------------------------------------------------------------------

/** The FTS5 query of the trigrams: one quoted single-trigram term per trigram, joined by AND. */
export function trigramQuery(trigrams: readonly string[]): string | undefined {
  if (trigrams.length === 0) return;
  return trigrams.map((trigram) => `"${trigram.split('"').join('""')}"`).join(" AND ");
}

/**
 * The trigrams of a literal query: every run of three consecutive characters in
 * the range U+0020 to U+007E (specs/search-tool.md#evaluation).
 */
export function printableTrigrams(query: string): string[] {
  const trigrams: string[] = [];
  for (let index = 0; index + 3 <= query.length; index += 1) {
    const run = query.slice(index, index + 3);
    if (/^[\u0020-\u007e]{3}$/.test(run)) trigrams.push(run);
  }
  return trigrams;
}

// ---------------------------------------------------------------------------
// Rows of specs/session-index.md#schema
// ---------------------------------------------------------------------------

/** The connection's `data_version` (specs/session-index.md#concurrent-access). */
function dataVersionOf(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA data_version").get();
  return isPlainObject(row) ? (numberOf(row.data_version) ?? -1) : -1;
}

function selectFiles(db: DatabaseSync): IndexFileRow[] {
  const rows: IndexFileRow[] = [];
  for (const row of db.prepare("SELECT * FROM files ORDER BY path").all()) {
    const file = fileRowOf(row);
    if (file !== undefined) rows.push(file);
  }
  return rows;
}

function selectFileRowByPath(db: DatabaseSync, path: string): IndexFileRow | undefined {
  return fileRowOf(db.prepare("SELECT * FROM files WHERE path = ?").get(path));
}

function selectFileRowById(db: DatabaseSync, fileId: number): IndexFileRow | undefined {
  return fileRowOf(db.prepare("SELECT * FROM files WHERE file_id = ?").get(fileId));
}

function selectFileRowsAfter(db: DatabaseSync, after: number, limit: number): IndexFileRow[] {
  const rows: IndexFileRow[] = [];
  const statement = db.prepare("SELECT * FROM files WHERE file_id > ? ORDER BY file_id LIMIT ?");
  for (const row of statement.all(after, limit)) {
    const file = fileRowOf(row);
    if (file !== undefined) rows.push(file);
  }
  return rows;
}

function fileRowOf(row: unknown): IndexFileRow | undefined {
  if (!isPlainObject(row)) return;
  const fileId = numberOf(row.file_id);
  const path = stringOf(row.path);
  const sessionId = stringOf(row.session_id);
  const started = numberOf(row.started);
  const consumed = numberOf(row.consumed);
  const lines = numberOf(row.lines);
  const lastTime = numberOf(row.last_time);
  const mtime = numberOf(row.mtime);
  const tailOffset = numberOf(row.tail_offset);
  const tailHash = stringOf(row.tail_hash);
  if (
    fileId === undefined ||
    path === undefined ||
    sessionId === undefined ||
    started === undefined ||
    consumed === undefined ||
    lines === undefined ||
    lastTime === undefined ||
    mtime === undefined ||
    tailOffset === undefined ||
    tailHash === undefined
  ) {
    return;
  }
  return {
    fileId,
    path,
    sessionId,
    started,
    consumed,
    lines,
    lastTime,
    mtime,
    tailOffset,
    tailHash,
    sessionName: stringOf(row.session_name) ?? null,
    firstUserMessage: stringOf(row.first_user_message) ?? null,
  };
}

function insertFileRow(db: DatabaseSync, row: NewFileRow): number {
  const statement = writable(
    db,
    "INSERT INTO files (path, session_id, started, consumed, lines, last_time, mtime, tail_offset, tail_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  return rowIdOf(
    statement.run(
      row.path,
      row.sessionId,
      row.started,
      row.consumed,
      row.lines,
      row.lastTime,
      row.mtime,
      row.tailOffset,
      row.tailHash,
    ),
  );
}

function updateProgress(
  db: DatabaseSync,
  fileId: number,
  consumed: number,
  lines: number,
  lastTime: number,
  mtime: number,
  tailOffset: number,
  tailHash: string,
): void {
  writable(
    db,
    "UPDATE files SET consumed = ?, lines = ?, last_time = ?, mtime = ?, tail_offset = ?, tail_hash = ? WHERE file_id = ?",
  ).run(consumed, lines, lastTime, mtime, tailOffset, tailHash, fileId);
}

function updateTitles(
  db: DatabaseSync,
  fileId: number,
  sessionName: string | null,
  firstUserMessage: string | null,
): void {
  writable(db, "UPDATE files SET session_name = ?, first_user_message = ? WHERE file_id = ?").run(
    sessionName,
    firstUserMessage,
    fileId,
  );
}

/** The session name a `session_info` entry sets: its trimmed `name`, or null (specs/session-index.md#schema). */
function sessionNameOf(value: Record<string, unknown>): string | null {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  return name.length > 0 ? name : null;
}

/** The user line of a `user` message entry, or undefined when it is none or has none (specs/session-index.md#schema). */
function userLineOf(value: Record<string, unknown>): string | undefined {
  if (value.type !== "message") return;
  const message = value.message;
  if (!isPlainObject(message) || message.role !== "user") return;
  const content = message.content;
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const element of content) {
      if (isPlainObject(element) && element.type === "text" && typeof element.text === "string") {
        parts.push(element.text);
      }
    }
  }
  for (const line of parts.join("\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return Array.from(trimmed).slice(0, USER_LINE_CODE_POINTS).join("");
  }
  return;
}

/** The `files` rows of resolved paths, by path, looked up through the `path` index (specs/session-index.md#session-titles). */
function selectTitleRows(db: DatabaseSync, paths: readonly string[]): Map<string, IndexFileRow> {
  const rows = new Map<string, IndexFileRow>();
  if (paths.length === 0) return rows;
  const statement = db.prepare(
    "SELECT * FROM files WHERE path IN (SELECT value FROM json_each(?))",
  );
  for (const row of statement.all(JSON.stringify(paths))) {
    const file = fileRowOf(row);
    if (file !== undefined) rows.set(file.path, file);
  }
  return rows;
}

/** A path resolved as a `files` row's `path`, or undefined when it cannot be resolved (specs/session-index.md#session-titles). */
function resolvedTitlePath(path: string): string | undefined {
  try {
    return realpathSync(resolve(path));
  } catch {
    // specs/session-index.md#session-titles: an unresolvable path has no key in the map, which is how the caller learns of it.
    return;
  }
}

/** Delete a `files` row and every row of its `file_id`, its item text included (specs/session-index.md#catch-up and specs/session-index.md#index-prune). */
function deleteFileRows(db: DatabaseSync, fileId: number): void {
  writable(
    db,
    "DELETE FROM item_text WHERE rowid IN (SELECT item_id FROM items WHERE file_id = ?)",
  ).run(fileId);
  writable(db, "DELETE FROM items WHERE file_id = ?").run(fileId);
  writable(db, "DELETE FROM entries WHERE file_id = ?").run(fileId);
  writable(db, "DELETE FROM files WHERE file_id = ?").run(fileId);
}

/** True when an entry of an earlier line of the file already carries this ID (specs/session-index.md#location). */
function entryIdExists(statement: StatementSync, fileId: number, entryId: string): boolean {
  return statement.get(fileId, entryId) !== undefined;
}

/** The statement that answers whether a file already carries an entry ID (specs/session-index.md#location). */
function entryIdCheck(db: DatabaseSync): StatementSync {
  return db.prepare("SELECT 1 AS found FROM entries WHERE file_id = ? AND entry_id = ?");
}

/** The entry with the highest line number of one file, or undefined (specs/session-index.md#catch-up). */
function selectLeafId(db: DatabaseSync, fileId: number): string | undefined {
  const row = db
    .prepare("SELECT entry_id FROM entries WHERE file_id = ? ORDER BY line DESC LIMIT 1")
    .get(fileId);
  if (!isPlainObject(row)) return;
  return stringOf(row.entry_id);
}

/** The `parent_id` and `lineage` of one entry, or undefined when the file has no such entry. */
function selectLineageRow(
  statement: StatementSync,
  fileId: number,
  entryId: string,
): LineageRow | undefined {
  const row = statement.get(fileId, entryId);
  if (!isPlainObject(row)) return;
  const lineage = numberOf(row.lineage);
  if (lineage === undefined) return;
  return { parentId: stringOf(row.parent_id) ?? null, lineage: lineage === 1 };
}

/** Insert the entries of one chunk and their items, with the item text in the contentless table (specs/session-index.md#schema). */
function insertEntries(db: DatabaseSync, fileId: number, entries: readonly SessionEntry[]): void {
  const insertEntry = writable(
    db,
    "INSERT INTO entries (file_id, line, offset, bytes, entry_id, parent_id, time, lineage) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
  );
  const insertItem = writable(
    db,
    "INSERT INTO items (file_id, line, part, kind, tool, is_error, call_id, time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertText = writable(db, "INSERT INTO item_text(rowid, text) VALUES (?, ?)");
  for (const entry of entries) {
    insertEntry.run(
      fileId,
      entry.line,
      entry.offset,
      entry.bytes,
      entry.entryId,
      entry.parentId,
      entry.time,
    );
    for (const item of entryItems(entry)) {
      const itemId = rowIdOf(
        insertItem.run(
          fileId,
          entry.line,
          item.part ?? "",
          item.kind,
          toolNameOf(item),
          item.isError ? 1 : 0,
          item.toolCallId ?? null,
          item.time,
        ),
      );
      if (itemId === 0) continue;
      insertText.run(itemId, item.matchText);
    }
  }
}

/** The tool name of a `tool_call` or `tool_result` item with `A-Z` lowercased, else null (specs/session-index.md#schema). */
function toolNameOf(item: TranscriptItem): string | null {
  if (item.kind !== "tool_call" && item.kind !== "tool_result") return null;
  const label = item.label;
  return label === undefined ? null : asciiLower(label);
}

/**
 * The `lineage` column after an extension (specs/session-index.md#catch-up): from the new leaf walk up until
 * an entry already on the lineage, then clear the old path below that point, so that the
 * column is the current lineage of the consumed bytes taken as a whole session file. A
 * lineage ends at an entry whose `parent_id` is null, is absent, names no entry, or names
 * an entry already on the path (specs/session-transcript.md#current-lineage),
 * so the walk relies on the entries above the one it stops at being unchanged: a lineage
 * that has no last entry, and one that ended at the ID of no entry which an entry appended
 * now carries, are rebuilt from the leaf instead.
 */
function updateLineage(
  db: DatabaseSync,
  fileId: number,
  previousLeaf: string | undefined,
  inserted: readonly string[],
): void {
  const newLeaf = inserted[inserted.length - 1];
  if (newLeaf === undefined) return;
  if (lineageNeedsRebuild(db, fileId, inserted)) {
    rebuildLineage(db, fileId);
    return;
  }
  const selectRow = db.prepare(
    "SELECT parent_id, lineage FROM entries WHERE file_id = ? AND entry_id = ?",
  );
  const setRow = writable(db, "UPDATE entries SET lineage = ? WHERE file_id = ? AND entry_id = ?");
  const onPath = new Set<string>();
  let current: string | undefined = newLeaf;
  while (current !== undefined && !onPath.has(current)) {
    const row = selectLineageRow(selectRow, fileId, current);
    if (row === undefined) break;
    onPath.add(current);
    if (row.lineage) break;
    setLineage(setRow, fileId, current, true);
    current = row.parentId ?? undefined;
  }
  let cursor = previousLeaf;
  const cleared = new Set<string>();
  while (cursor !== undefined && !onPath.has(cursor) && !cleared.has(cursor)) {
    const row = selectLineageRow(selectRow, fileId, cursor);
    if (row === undefined || !row.lineage) break;
    setLineage(setRow, fileId, cursor, false);
    cleared.add(cursor);
    cursor = row.parentId ?? undefined;
  }
}

/**
 * True when the column may not be brought up to date entry by entry (specs/session-index.md#catch-up): a lineage
 * with no last entry — every entry on it continues another entry on it — and one that ended
 * at the ID of no entry which an entry of this transaction now carries. The statement scans
 * the file's `entries` rows, since no index serves `lineage` alone; its inner lookups use the
 * primary key.
 */
function lineageNeedsRebuild(
  db: DatabaseSync,
  fileId: number,
  inserted: readonly string[],
): boolean {
  const row = db
    .prepare(
      `SELECT count(*) AS marked,
              sum(CASE WHEN w.entry_id IS NOT NULL THEN 1 ELSE 0 END) AS anchored,
              sum(CASE WHEN e.parent_id IN (SELECT value FROM json_each(?2)) THEN 1 ELSE 0 END) AS resolved
         FROM entries e
         LEFT JOIN entries w
           ON w.file_id = e.file_id AND w.entry_id = e.parent_id AND w.lineage = 1
        WHERE e.file_id = ?1 AND e.lineage = 1`,
    )
    .get(fileId, JSON.stringify(inserted));
  if (!isPlainObject(row)) return false;
  const marked = numberOf(row.marked) ?? 0;
  const anchored = numberOf(row.anchored) ?? 0;
  const resolved = numberOf(row.resolved) ?? 0;
  return (marked > 0 && marked === anchored) || resolved > 0;
}

/** The leaf of one file and the entries its `parent_id`s name, up to the entry that ends it (specs/session-index.md#schema). */
const LINEAGE_CHAIN_SQL = `WITH RECURSIVE chain(entry_id) AS (
  SELECT entry_id FROM (SELECT entry_id FROM entries WHERE file_id = ?1 ORDER BY line DESC LIMIT 1)
  UNION
  SELECT parent.parent_id FROM chain JOIN entries parent
    ON parent.file_id = ?1 AND parent.entry_id = chain.entry_id
   WHERE parent.parent_id IS NOT NULL
)`;

/** Set the column of one file to its current lineage, as a whole file (specs/session-index.md#schema, `entries.lineage`). */
function rebuildLineage(db: DatabaseSync, fileId: number): void {
  writable(
    db,
    `${LINEAGE_CHAIN_SQL}
     UPDATE entries SET lineage = 0
      WHERE file_id = ?1 AND lineage = 1 AND entry_id NOT IN (SELECT entry_id FROM chain)`,
  ).run(fileId);
  writable(
    db,
    `${LINEAGE_CHAIN_SQL}
     UPDATE entries SET lineage = 1
      WHERE file_id = ?1 AND lineage = 0 AND entry_id IN (SELECT entry_id FROM chain)`,
  ).run(fileId);
}

function setLineage(
  statement: StatementSync,
  fileId: number,
  entryId: string,
  lineage: boolean,
): void {
  statement.run(lineage ? 1 : 0, fileId, entryId);
}

const ITEM_COLUMNS = `i.item_id, i.file_id, i.line, i.part, i.kind, i.tool, i.is_error, i.call_id, i.time,
            e.entry_id, e.offset, e.bytes, e.lineage, f.path, f.consumed, f.tail_hash`;

const ITEM_JOINS = `FROM items i
       JOIN entries e ON e.file_id = i.file_id AND e.line = i.line
       JOIN files f ON f.file_id = i.file_id`;

function selectItemRows(db: DatabaseSync, fileId: number): IndexItemRow[] {
  const rows: IndexItemRow[] = [];
  const statement = db.prepare(`SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.file_id = ?`);
  for (const row of statement.all(fileId)) {
    const item = itemRowOf(row);
    if (item !== undefined) rows.push(item);
  }
  return rows.toSorted(compareFileOrder);
}

/**
 * The WHERE conditions of a candidate read, or undefined when the filter admits
 * no row. With `plainTime`, the time conditions are written so that the planner
 * cannot serve them from `items_time`: a collection scans rows in `item_id` order
 * instead (specs/search-tool.md#abort).
 */
function candidateWhere(
  filter: CandidateFilter,
  plainTime = false,
): { conditions: string[]; params: (string | number)[] } | undefined {
  const time = plainTime ? "+i.time" : "i.time";
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filter.exactBound === true) {
    conditions.push(`${time} = ?`);
    params.push(filter.bound);
  } else if (filter.withinTime !== undefined) {
    conditions.push(`${time} <= ? AND ${time} >= ?`);
    params.push(
      Math.max(filter.bound, filter.withinTime),
      Math.min(filter.bound, filter.withinTime),
    );
  } else if (filter.newest) {
    conditions.push(`${time} <= ?`);
    params.push(filter.bound);
  } else {
    conditions.push(`${time} >= ?`);
    params.push(filter.bound);
  }
  if (filter.lineBelow !== undefined) {
    conditions.push("i.line <= ?");
    params.push(filter.lineBelow);
  }
  if (filter.lineAbove !== undefined) {
    conditions.push("i.line >= ?");
    params.push(filter.lineAbove);
  }
  const kinds = filter.kinds;
  if (kinds !== undefined) {
    if (kinds.length === 0) return;
    conditions.push(`i.kind IN (${kinds.map(() => "?").join(", ")})`);
    for (const kind of kinds) params.push(kind);
  }
  if (filter.tool !== undefined) {
    conditions.push("i.tool = ?");
    params.push(filter.tool);
  }
  if (filter.isError !== undefined) {
    conditions.push("i.kind = 'tool_result' AND i.is_error = ?");
    params.push(filter.isError ? 1 : 0);
  }
  if (filter.since !== undefined) {
    conditions.push(`${time} >= ?`);
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    conditions.push(`${time} < ?`);
    params.push(filter.until);
  }
  const itemIds = filter.itemIds;
  if (itemIds !== undefined) {
    if (itemIds.length === 0) return;
    conditions.push("i.item_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(itemIds));
  }
  const fileIds = filter.fileIds;
  if (fileIds !== undefined) {
    if (fileIds.length === 0) return;
    const column = filter.fileIdsFilterOnly === true ? "+i.file_id" : "i.file_id";
    conditions.push(`${column} IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(fileIds));
  }
  return { conditions, params };
}

/** The candidate rows of one page (specs/search-tool.md#evaluation). */
function selectCandidates(db: DatabaseSync, filter: CandidateFilter): IndexItemRow[] {
  const where = candidateWhere(filter);
  if (where === undefined) return [];
  const { conditions, params } = where;
  const order = filter.newest ? "DESC" : "ASC";
  const byLine = filter.lineOrder === undefined ? "" : `, i.line ${filter.lineOrder}`;
  const sql = `SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE ${conditions.join(" AND ")} ORDER BY i.time ${order}${byLine} LIMIT ?`;
  params.push(filter.limit);
  const rows: IndexItemRow[] = [];
  for (const row of db.prepare(sql).all(...params)) {
    const item = itemRowOf(row);
    if (item !== undefined) rows.push(item);
  }
  return rows;
}

/**
 * The IDs of the items in `item_id` range (`after`, `upTo`] that pass the
 * filter, read in `item_id` order without `items_time`, at most `limit`
 * (specs/search-tool.md#evaluation). With `fileIds`, the range is
 * ignored and the files' own rows are read through their file index instead.
 */
function selectCandidateIds(
  db: DatabaseSync,
  filter: CandidateFilter,
  after: number,
  upTo: number,
): number[] {
  const where = candidateWhere(filter, true);
  if (where === undefined) return [];
  const { conditions, params } = where;
  const ids: number[] = [];
  let sql: string;
  if (filter.fileIds === undefined || filter.fileIdsFilterOnly === true) {
    conditions.push("i.item_id > ? AND i.item_id <= ?");
    params.push(after, upTo);
    sql = `SELECT i.item_id FROM items AS i NOT INDEXED WHERE ${conditions.join(" AND ")} LIMIT ?`;
  } else {
    sql = `SELECT i.item_id FROM items AS i WHERE ${conditions.join(" AND ")} LIMIT ?`;
  }
  params.push(filter.limit);
  for (const row of db.prepare(sql).all(...params)) addItemId(ids, row);
  return ids;
}

/** The distinct file IDs of the rows, in ascending order. */
function distinctFileIds(rows: readonly IndexItemRow[]): number[] {
  const ids = new Set<number>();
  for (const row of rows) ids.add(row.fileId);
  return [...ids].toSorted((one, other) => one - other);
}

/** The `files` rows of the file IDs (specs/search-tool.md#coverage). */
function selectFilesByIds(db: DatabaseSync, fileIds: readonly number[]): IndexFileRow[] {
  if (fileIds.length === 0) return [];
  const files: IndexFileRow[] = [];
  const statement = db.prepare(
    "SELECT * FROM files WHERE file_id IN (SELECT value FROM json_each(?))",
  );
  for (const row of statement.all(JSON.stringify(fileIds))) {
    const file = fileRowOf(row);
    if (file !== undefined) files.push(file);
  }
  return files;
}

/** At most `limit` item IDs whose text matches every trigram (specs/session-index.md#schema). */
function selectMatchIds(db: DatabaseSync, query: string, limit: number): number[] {
  const ids: number[] = [];
  const statement = db.prepare(
    "SELECT rowid AS item_id FROM item_text WHERE item_text MATCH ? LIMIT ?",
  );
  for (const row of statement.all(query, limit)) addItemId(ids, row);
  return ids;
}

/** The item IDs among `itemIds` whose text matches every trigram (specs/session-index.md#schema). */
function selectMatchedIds(
  db: DatabaseSync,
  query: string,
  itemIds: readonly number[],
): Set<number> {
  const matched = new Set<number>();
  if (itemIds.length === 0) return matched;
  if (itemIds.length <= PROBE_BY_ID_MAX) {
    // Up to a page of IDs: each is looked up in the trigram lists, at a cost per ID
    // that does not depend on how many items the index holds.
    const statement = db.prepare(
      "SELECT rowid AS item_id FROM item_text WHERE rowid IN (SELECT value FROM json_each(?)) AND item_text MATCH ?",
    );
    for (const row of statement.all(JSON.stringify(itemIds), query)) addItemId(matched, row);
    return matched;
  }
  // Many IDs: SQLite intersects them with the matches between the least and the
  // greatest in one statement, at a cost of the trigram lists rather than per ID.
  let least = Number.POSITIVE_INFINITY;
  let greatest = Number.NEGATIVE_INFINITY;
  for (const id of itemIds) {
    if (id < least) least = id;
    if (id > greatest) greatest = id;
  }
  const statement = db.prepare(
    "SELECT value AS item_id FROM json_each(?) WHERE value IN (SELECT rowid FROM item_text WHERE item_text MATCH ? AND rowid >= ? AND rowid <= ?)",
  );
  for (const row of statement.all(JSON.stringify(itemIds), query, least, greatest)) {
    addItemId(matched, row);
  }
  return matched;
}

function selectItemRow(
  db: DatabaseSync,
  fileId: number,
  entryId: string,
  part: string,
): IndexItemRow | undefined {
  const row = db
    .prepare(
      `SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.file_id = ? AND e.entry_id = ? AND i.part = ?`,
    )
    .get(fileId, entryId, part);
  return itemRowOf(row);
}

/** The first item of one kind with a tool-call ID, in file order (specs/session-index.md#schema). */
function selectPairedItem(
  db: DatabaseSync,
  fileId: number,
  callId: string,
  kind: ToolPairKind,
): IndexItemRow | undefined {
  const rows: IndexItemRow[] = [];
  const statement = db.prepare(
    `SELECT ${ITEM_COLUMNS} ${ITEM_JOINS} WHERE i.file_id = ? AND i.call_id = ? AND i.kind = ?`,
  );
  for (const row of statement.all(fileId, callId, kind)) {
    const item = itemRowOf(row);
    if (item !== undefined) rows.push(item);
  }
  return rows.toSorted(compareFileOrder)[0];
}

function itemRowOf(row: unknown): IndexItemRow | undefined {
  if (!isPlainObject(row)) return;
  const itemId = numberOf(row.item_id);
  const fileId = numberOf(row.file_id);
  const path = stringOf(row.path);
  const line = numberOf(row.line);
  const part = stringOf(row.part);
  const kind = stringOf(row.kind);
  const time = numberOf(row.time);
  const entryId = stringOf(row.entry_id);
  const offset = numberOf(row.offset);
  const bytes = numberOf(row.bytes);
  const lineage = numberOf(row.lineage);
  const consumed = numberOf(row.consumed);
  const tailHash = stringOf(row.tail_hash);
  if (
    itemId === undefined ||
    fileId === undefined ||
    path === undefined ||
    line === undefined ||
    part === undefined ||
    kind === undefined ||
    time === undefined ||
    entryId === undefined ||
    offset === undefined ||
    bytes === undefined ||
    lineage === undefined ||
    consumed === undefined ||
    tailHash === undefined
  ) {
    return;
  }
  return {
    itemId,
    fileId,
    path,
    line,
    part,
    kind,
    tool: stringOf(row.tool) ?? null,
    isError: numberOf(row.is_error) === 1,
    callId: stringOf(row.call_id) ?? null,
    time,
    entryId,
    offset,
    bytes,
    lineage: lineage === 1,
    consumed,
    tailHash,
  };
}

/** File order of two rows: ascending line number, then part as numbers with `error` last (specs/session-index.md#index-prune). */
function compareFileOrder(a: IndexItemRow, b: IndexItemRow): number {
  if (a.line !== b.line) return a.line - b.line;
  return compareParts(partOf(a.part), partOf(b.part));
}

function partOf(part: string): string | undefined {
  return part === "" ? undefined : part;
}

function filterItems(rows: readonly IndexItemRow[], filter: ItemFilter): IndexItemRow[] {
  const kinds = filter.kinds;
  const tool = filter.tool === undefined ? undefined : asciiLower(filter.tool);
  const kept = rows.filter((row) => {
    if (filter.entryId !== undefined && row.entryId !== filter.entryId) return false;
    if (filter.part !== undefined && row.part !== filter.part) return false;
    if (kinds !== undefined && !kinds.includes(row.kind)) return false;
    if (tool !== undefined && row.tool !== tool) return false;
    if (
      filter.isError !== undefined &&
      (row.kind !== "tool_result" || row.isError !== filter.isError)
    ) {
      return false;
    }
    if (filter.since !== undefined && row.time < filter.since) return false;
    if (filter.until !== undefined && row.time >= filter.until) return false;
    if (filter.lineage === true && !row.lineage) return false;
    return true;
  });
  const limit = filter.limit;
  return limit === undefined ? kept : kept.slice(0, limit);
}

/**
 * The item IDs of the searched files whose match text matches every trigram
 * (specs/search-tool.md#evaluation). A small set of searched items is
 * probed one by one, which costs about the same whatever the index holds; a large
 * one scans the trigram lists once and keeps the searched files' rows.
 */
function selectTrigramIds(
  db: DatabaseSync,
  query: string,
  fileIds: readonly number[] | undefined,
): Set<number> {
  const ids = new Set<number>();
  if (fileIds === undefined) {
    for (const row of db
      .prepare("SELECT rowid AS item_id FROM item_text WHERE item_text MATCH ?")
      .all(query)) {
      addItemId(ids, row);
    }
    return ids;
  }
  if (fileIds.length === 0) return ids;
  const placeholders = fileIds.map(() => "?").join(", ");
  const searched = countItemsOfFiles(db, fileIds, placeholders);
  const sql =
    searched <= TRIGRAM_PROBE_LIMIT
      ? `SELECT rowid AS item_id FROM item_text WHERE item_text MATCH ? AND rowid IN (SELECT item_id FROM items WHERE file_id IN (${placeholders}))`
      : `SELECT t.rowid AS item_id FROM item_text t JOIN items i ON i.item_id = t.rowid WHERE t.item_text MATCH ? AND i.file_id IN (${placeholders})`;
  for (const row of db.prepare(sql).all(query, ...fileIds)) addItemId(ids, row);
  return ids;
}

function countItemsOfFiles(
  db: DatabaseSync,
  fileIds: readonly number[],
  placeholders: string,
): number {
  const row = db
    .prepare(`SELECT count(*) AS count FROM items WHERE file_id IN (${placeholders})`)
    .get(...fileIds);
  return isPlainObject(row) ? (numberOf(row.count) ?? 0) : 0;
}

function addItemId(ids: Set<number> | number[], row: unknown): void {
  if (!isPlainObject(row)) return;
  const itemId = numberOf(row.item_id);
  if (itemId === undefined) return;
  if (Array.isArray(ids)) ids.push(itemId);
  else ids.add(itemId);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The `user_version` of the open database (specs/session-index.md#location). */
function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return isPlainObject(row) ? (numberOf(row.user_version) ?? 0) : 0;
}

/** The number of tables in the open database (specs/session-index.md#location, step 2). */
function tableCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get();
  return isPlainObject(row) ? (numberOf(row.count) ?? 0) : 0;
}

/** Set the busy timeout of one connection, so that one attempt sleeps briefly (specs/session-index.md#concurrent-access). */
function setBusyTimeout(db: DatabaseSync, milliseconds: number): void {
  try {
    db.exec(`PRAGMA busy_timeout = ${milliseconds};`);
  } catch {
    // A connection that cannot take the setting is reported by the statement that follows.
  }
}

/**
 * Read the region of one catch-up transaction (specs/session-index.md#catch-up): the bytes from `from` up to
 * `to`, stopping after the first line feed at or after `limit` bytes, so that a line
 * longer than the limit is read whole. The bytes are read once, so the tail line's
 * digest comes from them without reading the line again (specs/session-index.md#schema).
 */
function readRegion(path: string, from: number, to: number, limit: number): RegionRead | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  const parts: Buffer[] = [];
  let scanned = 0;
  let cutAtLineFeed = false;
  try {
    let position = from;
    for (;;) {
      const want = Math.min(READ_CHUNK_BYTES, to - position);
      if (want <= 0) break;
      const chunk = Buffer.alloc(want);
      const read = readSync(fd, chunk, 0, want, position);
      if (read <= 0) break;
      const slice = chunk.subarray(0, read);
      const base = scanned;
      parts.push(slice);
      position += read;
      scanned += read;
      const lineFeed = slice.indexOf(0x0a);
      if (lineFeed >= 0 && base + lineFeed >= limit) {
        cutAtLineFeed = true;
        break;
      }
    }
  } catch {
    return;
  } finally {
    closeSync(fd);
  }
  const bytes = Buffer.concat(parts);
  return { bytes, consumed: cutOf(bytes, limit), cutAtLineFeed };
}

/**
 * The bytes of a region a read consumes (specs/session-index.md#catch-up): the lines a line feed terminates, up to
 * the last line whose bytes end at or before `limit`; with no such line, the first line, which
 * alone is longer than the limit.
 */
function cutOf(bytes: Uint8Array, limit: number): number {
  let cut = 0;
  let index = 0;
  for (;;) {
    const lineFeed = bytes.indexOf(0x0a, index);
    if (lineFeed < 0) break;
    const end = lineFeed + 1;
    if (end > limit) {
      if (cut === 0) cut = end;
      break;
    }
    cut = end;
    index = end;
  }
  return cut;
}

/** A file's size and modification time, milliseconds rounded down, or undefined when it cannot be read (specs/session-index.md#catch-up). */
function stampOf(path: string): FileStamp | undefined {
  const stat = statFile(path);
  if (stat === undefined || !stat.isFile()) return;
  return { size: stat.size, mtime: Math.floor(stat.mtimeMs) };
}

function statFile(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return;
  }
}

/**
 * The session file's absolute path with symbolic links resolved (specs/session-index.md#schema), which is
 * what a `files` row carries: a file that exists resolves whole, and a file that is gone
 * resolves through its directory, so its rows are still found.
 */
function sessionFilePath(path: string): string {
  const absolute = resolve(path);
  if (statFile(absolute) !== undefined) return realPath(absolute);
  return join(realPath(dirname(absolute)), basename(absolute));
}

/**
 * True when two paths name one file (specs/session-index.md#location): the device and inode decide when both
 * exist, so a differently-cased name on a case-insensitive volume and a hard link are
 * the same file; otherwise the resolved paths decide.
 */
function sameFile(one: string, other: string): boolean {
  const first = statFile(one);
  const second = statFile(other);
  if (first !== undefined && second !== undefined) {
    return first.dev === second.dev && first.ino === second.ino;
  }
  return resolve(realPath(one)) === resolve(realPath(other));
}

/** The bytes of a file range, shorter than asked when the file ends first, or undefined when it cannot be read. */
function readBytesAt(path: string, start: number, length: number): Buffer | undefined {
  if (length <= 0) return Buffer.alloc(0);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const read = readSync(fd, buffer, filled, length - filled, start + filled);
      if (read === 0) break;
      filled += read;
    }
    return buffer.subarray(0, filled);
  } catch {
    return;
  } finally {
    closeSync(fd);
  }
}

/** The SHA-256 digest of the bytes, lowercase hexadecimal (specs/session-index.md#schema). */
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The letters `A-Z` of a string converted to lowercase and no other character (specs/session-index.md#schema). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function stopped(options: CatchUpOptions): boolean {
  const aborted = options.aborted;
  if (aborted !== undefined && aborted()) return true;
  const deadline = options.deadline;
  if (deadline === undefined) return false;
  const now = options.now ?? Date.now;
  return now() >= deadline;
}

function catchUpOutcome(
  status: CatchUpStatus,
  bytesRead: number,
  transactions: number,
  reason?: string,
): CatchUpOutcome {
  return { status, reason, bytesRead, transactions };
}

function continuationOutcome(
  status: ContinuationOutcome["status"],
  reason?: string,
): ContinuationOutcome {
  return { status, reason };
}

/** A turn of the event loop: timers and other work of the process proceed (specs/session-index.md#concurrent-access). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolveTurn) => {
    setImmediate(resolveTurn);
  });
}

/** An awaited pause between two attempts of a busy transaction (specs/session-index.md#concurrent-access). */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No transaction is open any more; SQLite rolled it back itself.
  }
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Prepare a write statement whose result is not read as a JavaScript number: SQLite's
 * `last_insert_rowid()` is left over from an earlier insert, and the rowid an FTS5
 * insert leaves can exceed the range of a number, which a plain `run()` reports as
 * an error.
 */
function writable(db: DatabaseSync, sql: string): StatementSync {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}

/** The rowid an insert assigned, or 0 when SQLite gives none. */
function rowIdOf(result: { lastInsertRowid: number | bigint }): number {
  const id = result.lastInsertRowid;
  return typeof id === "bigint" ? Number(id) : id;
}

/** True when the error is SQLite's, and so a failure of the index (specs/session-index.md#failures). */
function isSqliteError(error: unknown): boolean {
  if (!isPlainObject(error)) return false;
  if (typeof error.errcode === "number") return true;
  return error.code === "ERR_SQLITE_ERROR";
}

/** The base SQLite error code of an error, when SQLite named one. */
function sqliteCode(error: unknown): number | undefined {
  if (!isPlainObject(error)) return;
  const code = error.errcode;
  if (typeof code !== "number") return;
  return code & 0xff;
}

/** True when SQLite reported that the file is not a database or is malformed (specs/session-index.md#failures). */
function isCorruptError(error: unknown): boolean {
  const code = sqliteCode(error);
  if (code !== undefined) return code === SQLITE_CORRUPT || code === SQLITE_NOTADB;
  const message = errorMessage(error).toLowerCase();
  return message.includes("not a database") || message.includes("malformed");
}

/** True when a write transaction cannot begin within the busy timeout (specs/session-index.md#concurrent-access). */
function isBusyError(error: unknown): boolean {
  const code = sqliteCode(error);
  if (code !== undefined) return code === SQLITE_BUSY;
  return errorMessage(error).toLowerCase().includes("database is locked");
}
