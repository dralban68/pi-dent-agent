import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after } from "node:test";
import {
  openTaskLedger,
  type LedgerRead,
  type LedgerTaskInsert,
  type TaskLedger,
  type TaskLedgerOptions,
} from "../../lib/task-ledger.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A temporary directory removed after the file's tests. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "task-ledger-"));
  roots.push(dir);
  return dir;
}

export interface Opened {
  ledger: TaskLedger;
  path: string;
  notices: Array<{ message: string; level: string }>;
}

/**
 * A ledger in a fresh temporary directory, its store and index paths elsewhere in it; `path`
 * overrides the ledger path.
 */
export function openLedger(options: Partial<TaskLedgerOptions> = {}): Opened {
  const dir = tempDir();
  const notices: Array<{ message: string; level: string }> = [];
  const path = options.path ?? join(dir, "tasks-v1.sqlite");
  const ledger = openTaskLedger({
    storePath: join(dir, "fleet.sqlite"),
    indexPath: join(dir, "search-v2.sqlite"),
    ...options,
    path,
    notify: (message, level) => notices.push({ message, level }),
  });
  return { ledger, path, notices };
}

/** A second connection to the ledger file, for arranging and asserting rows. */
export function raw(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

/** One `tasks` row as SQLite returns it. */
export function taskRow(path: string, rowId: string): Record<string, unknown> {
  const db = raw(path);
  try {
    const row = db.prepare("SELECT * FROM tasks WHERE row_id = ?").get(rowId);
    if (row === undefined) throw new Error(`no ledger row ${rowId}`);
    return { ...row };
  } finally {
    db.close();
  }
}

export function sessionRow(path: string, sessionId: string): Record<string, unknown> | undefined {
  const db = raw(path);
  try {
    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
    return row === undefined ? undefined : { ...row };
  } finally {
    db.close();
  }
}

export function userVersionOf(path: string): number {
  const db = raw(path);
  try {
    const value = db.prepare("PRAGMA user_version").get()?.user_version;
    return typeof value === "number" ? value : -1;
  } finally {
    db.close();
  }
}

/** A ledger row's insert values, overridable. */
export function insert(overrides: Partial<LedgerTaskInsert> = {}): LedgerTaskInsert {
  return {
    sessionId: "session-a",
    taskId: "a1b2c3d4",
    fleetQuery: false,
    kind: "agent",
    background: false,
    cwd: "/work",
    label: "reviewer — Review",
    startedAt: 1000,
    ...overrides,
  };
}

/** Insert a row the test expects the ledger to accept. */
export function inserted(ledger: TaskLedger, overrides: Partial<LedgerTaskInsert> = {}): string {
  const rowId = ledger.insertTask(insert(overrides));
  if (rowId === undefined) throw new Error(`ledger unusable: ${ledger.unusableReason()}`);
  return rowId;
}

/** The value of a read the test expects to succeed. */
export function ok<T>(outcome: LedgerRead<T>): T {
  if (outcome.status !== "ok") throw new Error(`ledger read ${outcome.status}`);
  return outcome.value;
}

export function usage(
  input: number,
  output: number,
  cost: number,
  turns: number,
  cacheRead = 0,
  cacheWrite = 0,
) {
  return { input, output, cacheRead, cacheWrite, cost, turns };
}
