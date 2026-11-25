/**
 * SQLite pieces of the task ledger (specs/task-ledger.md): the schema, error classification, and
 * row guards.
 */

import type { DatabaseSync } from "node:sqlite";
import type { TaskKind, TaskStatus } from "./task-row.ts";
import { errorMessage, isPlainObject } from "./util.ts";
import { zeroUsageSum, type UsageSum } from "./usage.ts";

/** The schema of Section 2, verbatim. */
export const LEDGER_SCHEMA = `
CREATE TABLE sessions (
  session_id   TEXT    PRIMARY KEY,
  session_file TEXT,
  cwd          TEXT    NOT NULL,
  started_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  input        INTEGER NOT NULL,
  output       INTEGER NOT NULL,
  cache_read   INTEGER NOT NULL,
  cache_write  INTEGER NOT NULL,
  cost         REAL    NOT NULL,
  turns        INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE tasks (
  row_id        TEXT    PRIMARY KEY,
  session_id    TEXT    NOT NULL,
  task_id       TEXT    NOT NULL,
  parent_id     TEXT,
  resumes_id    TEXT,
  fleet_query   INTEGER NOT NULL,
  kind          TEXT    NOT NULL,
  background    INTEGER NOT NULL,
  cwd           TEXT    NOT NULL,
  agent         TEXT,
  label         TEXT    NOT NULL,
  model         TEXT,
  status        TEXT    NOT NULL,
  dispatched    INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  settled_at    INTEGER,
  updated_at    INTEGER NOT NULL,
  owner_pid     INTEGER NOT NULL,
  owner_started INTEGER NOT NULL,
  session_path  TEXT,
  result_path   TEXT,
  input         INTEGER,
  output        INTEGER,
  cache_read    INTEGER,
  cache_write   INTEGER,
  cost          REAL,
  turns         INTEGER
);
CREATE INDEX tasks_session ON tasks (session_id, task_id);
CREATE INDEX tasks_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX tasks_session_path ON tasks (session_path) WHERE session_path IS NOT NULL;
CREATE INDEX tasks_running ON tasks (status) WHERE status = 'running';
`;

const SQLITE_BUSY = 5;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

function sqliteCode(error: unknown): number | undefined {
  if (!isPlainObject(error)) return;
  const code = error.errcode;
  return typeof code === "number" ? code & 0xff : undefined;
}

/** A transaction that cannot begin now: attempted again, never a failure (Section 5). */
export function isBusyError(error: unknown): boolean {
  const code = sqliteCode(error);
  if (code !== undefined) return code === SQLITE_BUSY;
  return errorMessage(error).toLowerCase().includes("database is locked");
}

/** SQLite reports the file is not a database or is malformed (Section 7). */
export function isCorruptError(error: unknown): boolean {
  const code = sqliteCode(error);
  if (code !== undefined) return code === SQLITE_CORRUPT || code === SQLITE_NOTADB;
  const message = errorMessage(error).toLowerCase();
  return message.includes("not a database") || message.includes("malformed");
}

/** The unusable reason of a failure that is not a busy database (Section 7). */
export function failureReason(error: unknown): string {
  const message = errorMessage(error);
  return isCorruptError(error) ? `task ledger file is corrupt: ${message}` : message;
}

export function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return isPlainObject(row) ? (numberOf(row.user_version) ?? 0) : 0;
}

export function tableCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
  return isPlainObject(row) ? (numberOf(row.n) ?? 0) : 0;
}

/** Roll back after a failed statement; SQLite may already have rolled it back itself. */
export function rollbackQuietly(db: DatabaseSync): void {
  if (!db.isTransaction) return;
  db.exec("ROLLBACK");
}

export function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The columns of a `tasks` row that the derived figures read (Section 6). */
export interface LedgerFigureRow {
  rowId: string;
  parentId: string | null;
  kind: TaskKind;
  status: TaskStatus;
  dispatched: boolean;
  startedAt: number;
  settledAt: number | null;
  /** The own usage: the six usage columns, a zero usage sum when they are null. */
  own: UsageSum;
}

/** The SELECT list that `figureRowOf` reads. */
export const FIGURE_COLUMNS =
  "row_id, parent_id, kind, status, dispatched, started_at, settled_at, input, output, cache_read, cache_write, cost, turns";

const KINDS: readonly string[] = ["agent", "script", "bash"];
const STATUSES: readonly string[] = ["running", "completed", "failed", "cancelled", "interrupted"];

function isKind(value: unknown): value is TaskKind {
  return typeof value === "string" && KINDS.includes(value);
}

function isStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && STATUSES.includes(value);
}

/** A usage sum of six usage columns; a zero usage sum when they are null (Section 6). */
export function usageOfColumns(row: Record<string, unknown>): UsageSum {
  const zero = zeroUsageSum();
  return {
    input: numberOf(row.input) ?? zero.input,
    output: numberOf(row.output) ?? zero.output,
    cacheRead: numberOf(row.cache_read) ?? zero.cacheRead,
    cacheWrite: numberOf(row.cache_write) ?? zero.cacheWrite,
    cost: numberOf(row.cost) ?? zero.cost,
    turns: numberOf(row.turns) ?? zero.turns,
  };
}

/** A `tasks` row read with `FIGURE_COLUMNS`; an error names a row that is not one. */
export function figureRowOf(row: unknown): LedgerFigureRow {
  if (!isPlainObject(row)) throw new Error("task ledger row is not an object");
  const rowId = stringOf(row.row_id);
  const startedAt = numberOf(row.started_at);
  const parentId = row.parent_id === null ? null : stringOf(row.parent_id);
  const settledAt = row.settled_at === null ? null : numberOf(row.settled_at);
  if (
    rowId === undefined ||
    startedAt === undefined ||
    parentId === undefined ||
    settledAt === undefined ||
    !isKind(row.kind) ||
    !isStatus(row.status)
  ) {
    throw new Error(`task ledger row has unexpected columns: ${JSON.stringify(row)}`);
  }
  return {
    rowId,
    parentId,
    kind: row.kind,
    status: row.status,
    dispatched: row.dispatched === 1,
    startedAt,
    settledAt,
    own: usageOfColumns(row),
  };
}

/** `a` plus `b`, field by field. */
export function addUsage(a: UsageSum, b: UsageSum): UsageSum {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
    turns: a.turns + b.turns,
  };
}
