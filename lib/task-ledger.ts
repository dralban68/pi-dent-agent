/**
 * Task ledger per specs/task-ledger.md: the SQLite file that keeps every task's ledger row and each
 * main session's ledger session row.
 *
 * Every operation is issued without waiting: it joins the process's ledger order (specs/task-ledger.md#concurrent-access), one
 * queue shared on `globalThis` by every extension instance of the process, which a drain loop
 * applies in a later turn of the event loop. A transaction that cannot begin is attempted again
 * after an awaited pause; each attempt waits inside SQLite for at most the busy timeout,
 * `BUSY_TIMEOUT_MS`.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { searchIndexPath, sessionStorePath } from "./session-index.ts";
import {
  addUsage,
  failureReason,
  FIGURE_COLUMNS,
  figureRowOf,
  isBusyError,
  isCorruptError,
  LEDGER_SCHEMA,
  numberOf,
  rollbackQuietly,
  tableCount,
  usageOfColumns,
  userVersion,
  type LedgerFigureRow,
} from "./task-ledger-sqlite.ts";
import type { TaskKind, TaskStatus, TerminalStatus } from "./task-row.ts";
import { errorCode, errorMessage, isPlainObject } from "./util.ts";
import { zeroUsageSum, type UsageSum } from "./usage.ts";

export { sessionRowToolCalls, sessionRowUsage, toolCallCount } from "./task-ledger-usage.ts";
export type {
  LedgerEntryUsage,
  LedgerSessionEntry,
  LedgerSessionHeader,
} from "./task-ledger-usage.ts";

/** The environment variable naming the ledger file (specs/task-ledger.md#location). */
export const TASKS_DB_ENV = "PI_DENT_TASKS_DB";
/** The ledger file's name under `~/.pi/pi-dent/` (specs/task-ledger.md#location). */
export const LEDGER_FILE_NAME = "tasks-v1.sqlite";
/** The format version recorded in `user_version` (specs/task-ledger.md#location). */
export const LEDGER_VERSION = 1;
/** The busy timeout of specs/task-ledger.md#location: how long one attempt waits inside SQLite. */
export const BUSY_TIMEOUT_MS = 10;
/** The read deadline of specs/task-ledger.md#concurrent-access. */
export const READ_DEADLINE_MS = 2000;
/** The awaited pause between two attempts (specs/task-ledger.md#concurrent-access). */
const BUSY_RETRY_DELAY_MS = 10;
/** The start-time tolerance of an owner of this process's pid (specs/task-ledger.md#sweep). */
const OWNER_START_TOLERANCE_MS = 1000;

/** The ledger path: `PI_DENT_TASKS_DB` when set and non-empty, else `~/.pi/pi-dent/tasks-v1.sqlite` (specs/task-ledger.md#location). */
export function taskLedgerPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const configured = env[TASKS_DB_ENV];
  if (configured !== undefined && configured.length > 0) return configured;
  return join(home, ".pi", "pi-dent", LEDGER_FILE_NAME);
}

// ---------------------------------------------------------------------------
// The process's ledger order (specs/task-ledger.md#concurrent-access)
// ---------------------------------------------------------------------------

/** One queued operation; it never rejects. */
type OrderItem = () => Promise<void>;

interface LedgerOrder {
  items: OrderItem[];
  running: boolean;
  /** The process's start time, computed once per process (specs/task-ledger.md#ledger-row, `owner_started`). */
  processStartedMs: number;
}

const ORDER_KEY = Symbol.for("pi-dent.task-ledger.order");

function isLedgerOrder(value: unknown): value is LedgerOrder {
  return (
    isPlainObject(value) &&
    Array.isArray(value.items) &&
    typeof value.running === "boolean" &&
    typeof value.processStartedMs === "number"
  );
}

/** The queue every extension instance of the process shares, whichever module copy loaded it. */
function ledgerOrder(): LedgerOrder {
  const existing: unknown = Reflect.get(globalThis, ORDER_KEY);
  if (isLedgerOrder(existing)) return existing;
  const order: LedgerOrder = {
    items: [],
    running: false,
    processStartedMs: Date.now() - Math.round(process.uptime() * 1000),
  };
  Reflect.set(globalThis, ORDER_KEY, order);
  return order;
}

/** The process's start time, as `owner_started` records it (specs/task-ledger.md#ledger-row). */
export function processStartedMs(): number {
  return ledgerOrder().processStartedMs;
}

function pushToOrder(item: OrderItem): void {
  const order = ledgerOrder();
  order.items.push(item);
  if (order.running) return;
  order.running = true;
  // Never on the caller's path: the drain starts in a later turn (specs/task-ledger.md#concurrent-access, no task waits).
  setImmediate(() => void drainOrder(order));
}

async function drainOrder(order: LedgerOrder): Promise<void> {
  try {
    for (let item = order.items.shift(); item !== undefined; item = order.items.shift()) {
      try {
        await item();
      } catch (error) {
        // Items report their own failures; reaching here is a defect, reported and passed over.
        process.emitWarning(`pi-dent: task ledger operation failed: ${errorMessage(error)}`);
      }
    }
  } finally {
    order.running = false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    // Unreferenced: writes still queued when the process ends are lost (specs/task-ledger.md#session-end).
    setTimeout(resolveDelay, milliseconds).unref();
  });
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The host `notify` API, for the single warning notice of specs/task-ledger.md#failures. */
export type LedgerNotify = (message: string, level: "warning") => void;

export interface TaskLedgerOptions {
  /** Shows the specs/task-ledger.md#failures warning notice. */
  notify: LedgerNotify;
  /** The ledger path. Default `taskLedgerPath()`, read at opening. */
  path?: string | undefined;
  /** The local session store's path. Default `sessionStorePath()`. */
  storePath?: string | undefined;
  /** The session index's path. Default `searchIndexPath()`. */
  indexPath?: string | undefined;
  /** The clock. Default `Date.now`. */
  now?: (() => number) | undefined;
  /** The read deadline. Default `READ_DEADLINE_MS`; tests shorten it. */
  readDeadlineMs?: number | undefined;
}

/** The outcome of a ledger read. */
export type LedgerRead<T> =
  | { status: "ok"; value: T }
  /** The ledger is unusable (specs/task-ledger.md#failures), or became so before the read was applied. */
  | { status: "unavailable"; reason: string }
  /** Abandoned at the read deadline (specs/task-ledger.md#concurrent-access). */
  | { status: "busy" };

/** The columns `register` inserts (specs/task-ledger.md#ledger-row and specs/task-ledger.md#write-rules). */
export interface LedgerTaskInsert {
  /** The ledger session ID of the invoking session; for a `Fleet` query, of the target session. */
  sessionId: string;
  taskId: string;
  /** The `row_id` of the parent row (specs/task-ledger.md#parent-row). */
  parentRowId?: string | undefined;
  fleetQuery: boolean;
  kind: TaskKind;
  background: boolean;
  /** The invoking session's working directory. */
  cwd: string;
  agent?: string | undefined;
  label: string;
  model?: string | undefined;
  /** The task row's `startedAt`. */
  startedAt: number;
  sessionPath?: string | undefined;
  /** The row's `toolCalls`: present for an `agent` or `script` row, absent for a `bash` row. */
  toolCalls?: number | undefined;
}

/** The new values an `amend`, or a script row's tool log creation, sets (specs/task-ledger.md#write-rules). */
export interface LedgerTaskAmend {
  label: string;
  agent?: string | undefined;
  model?: string | undefined;
  sessionPath?: string | undefined;
}

/** The key specs/task-ledger.md#rebuild finds a rebuilt task row's ledger row by. */
export interface LedgerTaskKey {
  /** The session's ledger session ID. */
  sessionId: string;
  taskId: string;
  startedAt: number;
}

/** A task row's ledger row: its `row_id`, or for a rebuilt row the key that finds it (specs/task-ledger.md#ledger-row). */
export type LedgerRowRef = string | LedgerTaskKey;

/** How a `resume` dispatch names the row it continues (specs/task-ledger.md#write-rules). */
export type LedgerResume =
  /** A task ID: the resolved task row's ledger row, undefined when it has none. */
  | { by: "task"; row: LedgerRowRef | undefined }
  /**
   * A path: the latest other row whose `session_path` equals `sessionPath`, the text this row's
   * `session_path` takes; this row's current `session_path` when omitted.
   */
  | { by: "path"; sessionPath?: string | undefined };

export interface LedgerDispatched {
  /** The working directory the task runs in. */
  cwd: string;
  /** Present for a `resume` dispatch. */
  resume?: LedgerResume | undefined;
}

export interface LedgerTaskSettle {
  status: TerminalStatus;
  settledAt: number;
  resultPath?: string | undefined;
}

/** The task row a rebuild inserted (specs/task-ledger.md#rebuild). */
export interface LedgerRebuiltRow {
  /** The session's ledger session ID. */
  sessionId: string;
  taskId: string;
  startedAt: number;
  status: TaskStatus;
}

/** The ledger session row's values (specs/task-ledger.md#session-row and specs/task-ledger.md#session-row-writes). */
export interface LedgerSessionWrite {
  sessionId: string;
  /** Null without a session file (`--no-session`). */
  sessionFile: string | null;
  cwd: string;
  /** `sessionRowUsage` of the session's entries and header. */
  usage: UsageSum;
  /** `sessionRowToolCalls` of the session's entries and header. */
  toolCalls: number;
}

/** Agent figures (specs/task-ledger.md#derived-figures). */
export interface LedgerAgentFigures {
  count: number;
  usage: UsageSum;
}

/** The figures of one ledger row (specs/task-ledger.md#derived-figures). */
export interface LedgerRowFigures {
  rowId: string;
  kind: TaskKind;
  status: TaskStatus;
  own: UsageSum;
  /** The own tool-call count; undefined for a `bash` row. */
  toolCalls: number | undefined;
  /** The cumulative usage. */
  total: UsageSum;
  /** The number of descendants. */
  descendants: number;
  /** The wall time, in milliseconds. */
  wallMs: number;
  /** The descendant time, in milliseconds. */
  descendantMs: number;
  agents: LedgerAgentFigures;
}

/** The figures of a ledger session ID whose ledger session row exists (specs/task-ledger.md#derived-figures). */
export interface LedgerSessionFigures {
  /** The own usage of the ledger session row. */
  own: UsageSum;
  agents: LedgerAgentFigures;
  /** The session usage. */
  total: UsageSum;
}

// ---------------------------------------------------------------------------
// The ledger of one extension instance
// ---------------------------------------------------------------------------

/**
 * Open the ledger for one extension instance (specs/task-ledger.md#location). Returns at once; the opening is the
 * instance's first operation in the process's ledger order.
 */
export function openTaskLedger(options: TaskLedgerOptions): TaskLedger {
  return new TaskLedger(options);
}

type Attempt<T> = { ok: true; value: T } | { ok: false };

export class TaskLedger {
  readonly path: string;
  private readonly storePath: string;
  private readonly indexPath: string;
  private readonly notify: LedgerNotify;
  private readonly now: () => number;
  private readonly readDeadlineMs: number;
  private db: DatabaseSync | undefined;
  private reason: string | undefined;
  private noticeShown = false;
  private closing = false;
  private queued = 0;
  /** Resolves every queued read and flush of this instance when the ledger becomes unusable. */
  private readonly drops = new Set<() => void>();

  constructor(options: TaskLedgerOptions) {
    this.path = options.path ?? taskLedgerPath();
    this.storePath = options.storePath ?? sessionStorePath();
    this.indexPath = options.indexPath ?? searchIndexPath();
    this.notify = options.notify;
    this.now = options.now ?? Date.now;
    this.readDeadlineMs = options.readDeadlineMs ?? READ_DEADLINE_MS;
    this.enqueue(() => this.open(), noop);
  }

  /** The unusable reason (specs/task-ledger.md#failures), or undefined while the ledger is usable. */
  unusableReason(): string | undefined {
    return this.reason;
  }

  /** Resolves once every operation issued before the call has been applied or dropped. */
  flushed(): Promise<void> {
    return new Promise((resolveFlush) => {
      const done = (): void => resolveFlush();
      if (!this.enqueue(async () => done(), done)) done();
    });
  }

  /**
   * End the instance's use of the ledger: its connection closes once its queued operations are
   * applied. An operation issued later is still applied, on a connection opened for it.
   */
  close(): void {
    this.closing = true;
    if (this.queued === 0) this.closeConnection();
  }

  // -- Writes (specs/task-ledger.md#write-rules, specs/task-ledger.md#session-row-writes, specs/task-ledger.md#rebuild) ---------------------------------------

  /**
   * `register`: insert the ledger row. Returns its `row_id`, or undefined when the ledger is
   * unusable, in which case the task row has no ledger row.
   */
  insertTask(row: LedgerTaskInsert): string | undefined {
    if (this.reason !== undefined) return;
    const rowId = randomUUID();
    const at = this.now();
    const usage = row.kind === "agent" ? zeroUsageSum() : undefined;
    const ownerStarted = processStartedMs();
    this.write((db) => {
      db.prepare(
        `INSERT INTO tasks (row_id, session_id, task_id, parent_id, resumes_id, fleet_query, kind,
           background, cwd, agent, label, model, status, dispatched, started_at, settled_at,
           updated_at, owner_pid, owner_started, session_path, result_path,
           input, output, cache_read, cache_write, cost, turns, tool_calls)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, NULL, ?, ?, ?, ?, NULL,
           ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        rowId,
        row.sessionId,
        row.taskId,
        row.parentRowId ?? null,
        row.fleetQuery ? 1 : 0,
        row.kind,
        row.background ? 1 : 0,
        row.cwd,
        row.agent ?? null,
        row.label,
        row.model ?? null,
        row.startedAt,
        at,
        process.pid,
        ownerStarted,
        row.sessionPath ?? null,
        usage?.input ?? null,
        usage?.output ?? null,
        usage?.cacheRead ?? null,
        usage?.cacheWrite ?? null,
        usage?.cost ?? null,
        usage?.turns ?? null,
        row.kind === "bash" ? null : (row.toolCalls ?? null),
      );
    });
    return rowId;
  }

  /** An `amend` that changes `label`, `agent`, `model`, or `sessionPath`; a script row's tool log creation. */
  amendTask(rowId: string, values: LedgerTaskAmend): void {
    const at = this.now();
    this.write((db) => {
      db.prepare(
        "UPDATE tasks SET label = ?, agent = ?, model = ?, session_path = ?, updated_at = ? WHERE row_id = ?",
      ).run(
        values.label,
        values.agent ?? null,
        values.model ?? null,
        values.sessionPath ?? null,
        at,
        rowId,
      );
    });
  }

  /** The task's pre-start checks passed (specs/task-ledger.md#ledger-row). */
  markDispatched(rowId: string, values: LedgerDispatched): void {
    const at = this.now();
    const resume = values.resume;
    this.write((db) => {
      db.prepare("UPDATE tasks SET dispatched = 1, cwd = ?, updated_at = ? WHERE row_id = ?").run(
        values.cwd,
        at,
        rowId,
      );
      if (resume === undefined) return;
      if (resume.by === "task") {
        const resumed = resume.row === undefined ? undefined : resolveRef(db, resume.row);
        db.prepare("UPDATE tasks SET resumes_id = ? WHERE row_id = ?").run(resumed ?? null, rowId);
        return;
      }
      db.prepare(
        `UPDATE tasks SET resumes_id = (
           SELECT other.row_id FROM tasks AS other
           WHERE other.session_path = COALESCE(?, tasks.session_path)
             AND other.row_id <> tasks.row_id
           ORDER BY other.started_at DESC, other.row_id DESC LIMIT 1)
         WHERE row_id = ?`,
      ).run(resume.sessionPath ?? null, rowId);
    });
  }

  /**
   * An assistant message was added to the row's `usage`: write its usage sum and `toolCalls`,
   * whatever the status.
   */
  setTaskUsage(rowId: string, usage: UsageSum, toolCalls: number): void {
    const at = this.now();
    const sum = { ...usage };
    this.write((db) => {
      db.prepare(
        `UPDATE tasks SET input = ?, output = ?, cache_read = ?, cache_write = ?, cost = ?, turns = ?,
           tool_calls = ?, updated_at = ? WHERE row_id = ?`,
      ).run(
        sum.input,
        sum.output,
        sum.cacheRead,
        sum.cacheWrite,
        sum.cost,
        sum.turns,
        toolCalls,
        at,
        rowId,
      );
    });
  }

  /** A `script` row's run started a nested call: write its `toolCalls`, whatever the status. */
  setTaskToolCalls(rowId: string, toolCalls: number): void {
    const at = this.now();
    this.write((db) => {
      db.prepare("UPDATE tasks SET tool_calls = ?, updated_at = ? WHERE row_id = ?").run(
        toolCalls,
        at,
        rowId,
      );
    });
  }

  /** `settle`: only a ledger row still `running` changes. */
  settleTask(rowId: string, values: LedgerTaskSettle): void {
    const at = this.now();
    this.write((db) => {
      db.prepare(
        `UPDATE tasks SET status = ?, settled_at = ?, result_path = ?, updated_at = ?
         WHERE row_id = ? AND status = 'running'`,
      ).run(values.status, values.settledAt, values.resultPath ?? null, at, rowId);
    });
  }

  /** A rebuild inserted this row (specs/task-ledger.md#rebuild): an `interrupted` one makes its ledger row `interrupted`. */
  rebuildTask(row: LedgerRebuiltRow): void {
    if (row.status !== "interrupted") return;
    const at = this.now();
    this.write((db) => {
      db.prepare(
        `UPDATE tasks SET status = 'interrupted', settled_at = COALESCE(settled_at, updated_at),
           updated_at = ?
         WHERE session_id = ? AND task_id = ? AND started_at = ? AND status IN ('running', 'cancelled')`,
      ).run(at, row.sessionId, row.taskId, row.startedAt);
    });
  }

  /** Insert or update the main session's ledger session row (specs/task-ledger.md#session-row-writes). */
  writeSession(values: LedgerSessionWrite): void {
    const at = this.now();
    const usage = { ...values.usage };
    const toolCalls = values.toolCalls;
    this.write((db) => {
      db.prepare(
        `INSERT INTO sessions (session_id, session_file, cwd, started_at, updated_at,
           input, output, cache_read, cache_write, cost, turns, tool_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET session_file = excluded.session_file,
           cwd = excluded.cwd, updated_at = excluded.updated_at, input = excluded.input,
           output = excluded.output, cache_read = excluded.cache_read,
           cache_write = excluded.cache_write, cost = excluded.cost, turns = excluded.turns,
           tool_calls = excluded.tool_calls`,
      ).run(
        values.sessionId,
        values.sessionFile,
        values.cwd,
        at,
        at,
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheWrite,
        usage.cost,
        usage.turns,
        toolCalls,
      );
    });
  }

  // -- Reads (specs/task-ledger.md#derived-figures) -----------------------------------------------------

  /** The agent figures of a ledger session ID, with no deadline: the usage tally's seed read. */
  readAgentFigures(sessionId: string): Promise<LedgerRead<LedgerAgentFigures>> {
    return this.read((db) => agentFiguresOf(sessionRows(db, sessionId)), false);
  }

  /**
   * The figures of a ledger session ID, for a surface, under the read deadline; undefined value
   * when the ledger holds no ledger session row for it.
   */
  readSessionFigures(sessionId: string): Promise<LedgerRead<LedgerSessionFigures | undefined>> {
    return this.read((db): LedgerSessionFigures | undefined => {
      const session = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
      if (session === undefined) return;
      if (!isPlainObject(session)) throw new Error("task ledger session row is not an object");
      const own = usageOfColumns(session);
      const rows = sessionRows(db, sessionId);
      let total = own;
      for (const row of rows) total = addUsage(total, row.own);
      return { own, agents: agentFiguresOf(rows), total };
    }, true);
  }

  /**
   * The figures of ledger rows, for a surface, under the read deadline, in one read, keyed by the
   * refs given; a ref the ledger holds no row of is absent from the map.
   */
  readRowFigures(
    refs: readonly LedgerRowRef[],
  ): Promise<LedgerRead<Map<LedgerRowRef, LedgerRowFigures>>> {
    const given = [...refs];
    return this.read((db) => {
      const at = this.now();
      const byId = db.prepare(`SELECT ${FIGURE_COLUMNS} FROM tasks WHERE row_id = ?`);
      const below = db.prepare(
        `WITH RECURSIVE below (row_id) AS (
           SELECT row_id FROM tasks WHERE parent_id = ?
           UNION SELECT tasks.row_id FROM tasks JOIN below ON tasks.parent_id = below.row_id)
         SELECT ${FIGURE_COLUMNS} FROM tasks WHERE row_id IN (SELECT row_id FROM below) AND row_id <> ?`,
      );
      const figures = new Map<LedgerRowRef, LedgerRowFigures>();
      for (const ref of given) {
        const id = resolveRef(db, ref);
        if (id === undefined) continue;
        const found = byId.get(id);
        if (found === undefined) continue;
        const row = figureRowOf(found);
        const descendants = below.all(id, id).map(figureRowOf);
        let total = row.own;
        let descendantMs = 0;
        for (const one of descendants) {
          total = addUsage(total, one.own);
          descendantMs += wallMs(one, at);
        }
        figures.set(ref, {
          rowId: id,
          kind: row.kind,
          status: row.status,
          own: row.own,
          toolCalls: row.toolCalls,
          total,
          descendants: descendants.length,
          wallMs: wallMs(row, at),
          descendantMs,
          agents: {
            count: descendants.filter(isDispatchedAgent).length,
            usage: descendants.reduce((sum, one) => addUsage(sum, one.own), zeroUsageSum()),
          },
        });
      }
      return figures;
    }, true);
  }

  // -- Opening (specs/task-ledger.md#location) and the sweep (specs/task-ledger.md#sweep) -----------------------

  private async open(): Promise<void> {
    if (sameFile(this.path, this.storePath)) {
      this.fail("the task ledger file is the local session store file");
      return;
    }
    if (sameFile(this.path, this.indexPath)) {
      this.fail("the task ledger file is the session index file");
      return;
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch (error) {
      this.fail(errorMessage(error));
      return;
    }
    if (existsSync(this.path) && !(await this.probe())) return;
    if (this.connection() === undefined) return;
    // Steps 3 to 5: the check and the creation in one `BEGIN IMMEDIATE` transaction.
    const version = await this.transact("write", (db) => {
      const found = userVersion(db);
      if (found !== 0 || tableCount(db) !== 0) return found;
      db.exec(LEDGER_SCHEMA);
      db.exec(`PRAGMA user_version = ${LEDGER_VERSION};`);
      return LEDGER_VERSION;
    });
    if (!version.ok) return;
    if (version.value !== LEDGER_VERSION) {
      this.fail(`unsupported task ledger version ${version.value}`);
      return;
    }
    if (!(await this.retryBusy((db) => db.exec("PRAGMA journal_mode = WAL;")))) return;
    await this.sweep();
  }

  /**
   * Read the version of an existing file on a read-only connection, so a file of another version
   * or a corrupt one is left unchanged (specs/task-ledger.md#failures). False when the ledger became unusable.
   */
  private async probe(): Promise<boolean> {
    for (;;) {
      let db: DatabaseSync;
      try {
        db = new DatabaseSync(this.path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
      } catch (error) {
        if (!isCorruptError(error)) return true; // The read-write opening reports its own failure.
        this.fail(failureReason(error));
        return false;
      }
      let outcome: "busy" | "readable" | "unreadable" = "readable";
      try {
        // One snapshot: another process's schema creation commits between two bare reads.
        db.exec("BEGIN");
        const version = userVersion(db);
        if (version !== LEDGER_VERSION && (version !== 0 || tableCount(db) !== 0)) {
          this.fail(`unsupported task ledger version ${version}`);
          return false;
        }
      } catch (error) {
        if (isBusyError(error)) outcome = "busy";
        else if (isCorruptError(error)) {
          this.fail(failureReason(error));
          return false;
        } else outcome = "unreadable"; // The read-write opening reports its own failure.
      } finally {
        db.close();
      }
      if (outcome !== "busy") return true;
      await delay(BUSY_RETRY_DELAY_MS);
    }
  }

  private async sweep(): Promise<void> {
    const self = { pid: process.pid, started: processStartedMs() };
    await this.transact("write", (db) => {
      const at = this.now();
      const owners = db
        .prepare("SELECT DISTINCT owner_pid, owner_started FROM tasks WHERE status = 'running'")
        .all();
      const settle = db.prepare(
        `UPDATE tasks SET status = 'interrupted', settled_at = updated_at, updated_at = ?
         WHERE status = 'running' AND owner_pid = ? AND owner_started = ?`,
      );
      for (const owner of owners) {
        if (!isPlainObject(owner)) continue;
        const pid = numberOf(owner.owner_pid);
        const started = numberOf(owner.owner_started);
        if (pid === undefined || started === undefined) continue;
        if (ownerIsGone(pid, started, self)) settle.run(at, pid, started);
      }
    });
  }

  // -- The queue -------------------------------------------------------------

  /** Queue one operation of this instance; false when the ledger is unusable and nothing was queued. */
  private enqueue(step: () => Promise<void>, drop: () => void): boolean {
    if (this.reason !== undefined) return false;
    this.queued += 1;
    this.drops.add(drop);
    pushToOrder(async () => {
      try {
        if (this.reason === undefined) await step();
      } catch (error) {
        this.fail(failureReason(error));
      } finally {
        this.drops.delete(drop);
        this.queued -= 1;
        if (this.closing && this.queued === 0) this.closeConnection();
      }
    });
    return true;
  }

  private write(body: (db: DatabaseSync) => void): void {
    this.enqueue(async () => {
      await this.transact("write", body);
    }, noop);
  }

  private read<T>(body: (db: DatabaseSync) => T, deadline: boolean): Promise<LedgerRead<T>> {
    const unavailable = (): LedgerRead<T> => ({
      status: "unavailable",
      reason: this.reason ?? "the task ledger is unusable",
    });
    if (this.reason !== undefined) return Promise.resolve(unavailable());
    return new Promise((resolveRead) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (outcome: LedgerRead<T>): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        resolveRead(outcome);
      };
      const drop = (): void => finish(unavailable());
      if (deadline) timer = setTimeout(() => finish({ status: "busy" }), this.readDeadlineMs);
      const queued = this.enqueue(async () => {
        if (done) return; // Abandoned at the deadline before its turn.
        const outcome = await this.transact("read", body, () => done);
        if (outcome.ok) finish({ status: "ok", value: outcome.value });
        else drop();
      }, drop);
      if (!queued) drop();
    });
  }

  /**
   * One transaction, attempted again while the file is busy (specs/task-ledger.md#concurrent-access). Any other failure makes
   * the ledger unusable after the transaction is rolled back (specs/task-ledger.md#failures).
   */
  private async transact<T>(
    mode: "write" | "read",
    body: (db: DatabaseSync) => T,
    abandoned: () => boolean = () => false,
  ): Promise<Attempt<T>> {
    for (;;) {
      if (this.reason !== undefined || abandoned()) return { ok: false };
      const db = this.connection();
      if (db === undefined) return { ok: false };
      try {
        db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
        const value = body(db);
        db.exec("COMMIT");
        return { ok: true, value };
      } catch (error) {
        try {
          rollbackQuietly(db);
        } catch (rollbackError) {
          this.fail(failureReason(rollbackError));
          return { ok: false };
        }
        if (!isBusyError(error)) {
          this.fail(failureReason(error));
          return { ok: false };
        }
      }
      await delay(BUSY_RETRY_DELAY_MS);
    }
  }

  /** A statement outside a transaction, attempted again while the file is busy; false when unusable. */
  private async retryBusy(statement: (db: DatabaseSync) => void): Promise<boolean> {
    for (;;) {
      const db = this.connection();
      if (db === undefined) return false;
      try {
        statement(db);
        return true;
      } catch (error) {
        if (!isBusyError(error)) {
          this.fail(failureReason(error));
          return false;
        }
      }
      await delay(BUSY_RETRY_DELAY_MS);
    }
  }

  /** The instance's connection, opened when absent; undefined when the ledger became unusable. */
  private connection(): DatabaseSync | undefined {
    if (this.reason !== undefined) return;
    if (this.db !== undefined) return this.db;
    try {
      // Each attempt waits at most the busy timeout inside SQLite; the queue waits between attempts.
      this.db = new DatabaseSync(this.path, { timeout: BUSY_TIMEOUT_MS });
      return this.db;
    } catch (error) {
      this.fail(failureReason(error));
      return;
    }
  }

  private closeConnection(): void {
    const db = this.db;
    this.db = undefined;
    if (db !== undefined && db.isOpen) db.close();
  }

  /** Make the ledger unusable for this instance (specs/task-ledger.md#failures). */
  private fail(reason: string): void {
    if (this.reason !== undefined) return;
    this.reason = reason;
    try {
      this.closeConnection();
    } catch (error) {
      process.emitWarning(`pi-dent: task ledger close failed: ${errorMessage(error)}`);
    }
    const drops = [...this.drops];
    this.drops.clear();
    for (const drop of drops) drop();
    if (this.noticeShown) return;
    this.noticeShown = true;
    try {
      this.notify(`pi-dent: task ledger unavailable: ${reason}`, "warning");
    } catch (error) {
      process.emitWarning(`pi-dent: task ledger notice failed: ${errorMessage(error)}`);
    }
  }
}

function noop(): void {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The owner of a ledger row is gone (specs/task-ledger.md#sweep). */
function ownerIsGone(
  pid: number,
  started: number,
  self: { pid: number; started: number },
): boolean {
  if (pid === self.pid) return Math.abs(started - self.started) > OWNER_START_TOLERANCE_MS;
  return !processExists(pid);
}

/** A permission-denied probe counts as existing (specs/task-ledger.md#sweep). */
function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/** Device and inode when both exist, else the resolved paths (specs/task-ledger.md#location, step 1). */
function sameFile(one: string, other: string): boolean {
  const first = statSync(one, { throwIfNoEntry: false });
  const second = statSync(other, { throwIfNoEntry: false });
  if (first !== undefined && second !== undefined) {
    return first.dev === second.dev && first.ino === second.ino;
  }
  return resolvedPath(one) === resolvedPath(other);
}

/** The path with symbolic links resolved as far as it exists. */
function resolvedPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(resolvedPath(parent), basename(absolute));
}

/** The `row_id` a ref names; for a key, the first match in `row_id` order (specs/task-ledger.md#rebuild). */
function resolveRef(db: DatabaseSync, ref: LedgerRowRef): string | undefined {
  if (typeof ref === "string") return ref;
  const found = db
    .prepare(
      `SELECT row_id FROM tasks WHERE session_id = ? AND task_id = ? AND started_at = ?
       ORDER BY row_id LIMIT 1`,
    )
    .get(ref.sessionId, ref.taskId, ref.startedAt);
  return isPlainObject(found) && typeof found.row_id === "string" ? found.row_id : undefined;
}

function sessionRows(db: DatabaseSync, sessionId: string): LedgerFigureRow[] {
  return db
    .prepare(`SELECT ${FIGURE_COLUMNS} FROM tasks WHERE session_id = ?`)
    .all(sessionId)
    .map(figureRowOf);
}

/** Count of dispatched `agent` rows and the usage sum of the `agent` rows given. */
function agentFiguresOf(rows: readonly LedgerFigureRow[]): LedgerAgentFigures {
  let usage = zeroUsageSum();
  let count = 0;
  for (const row of rows) {
    if (row.kind !== "agent") continue;
    usage = addUsage(usage, row.own);
    if (row.dispatched) count += 1;
  }
  return { count, usage };
}

function isDispatchedAgent(row: LedgerFigureRow): boolean {
  return row.kind === "agent" && row.dispatched;
}

/** The wall time (specs/task-ledger.md#derived-figures). */
function wallMs(row: LedgerFigureRow, at: number): number {
  const end = row.settledAt ?? (row.status === "running" ? at : row.startedAt);
  return Math.max(0, end - row.startedAt);
}
