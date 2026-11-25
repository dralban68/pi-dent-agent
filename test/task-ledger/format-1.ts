import { DatabaseSync } from "node:sqlite";

/**
 * Format version 1 of the task ledger as pi-dent 0.2.27 released it: its schema and the write
 * statements of its process, copied from that release's text, never derived from the current code.
 */

/** The released schema (format version 1). */
export const FORMAT_1_SCHEMA = `
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

/** The released `register` insert. */
const INSERT_TASK = `INSERT INTO tasks (row_id, session_id, task_id, parent_id, resumes_id, fleet_query, kind,
           background, cwd, agent, label, model, status, dispatched, started_at, settled_at,
           updated_at, owner_pid, owner_started, session_path, result_path,
           input, output, cache_read, cache_write, cost, turns)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, NULL, ?, ?, ?, ?, NULL,
           ?, ?, ?, ?, ?, ?)`;

/** The released usage write of an `agent` row. */
const SET_TASK_USAGE = `UPDATE tasks SET input = ?, output = ?, cache_read = ?, cache_write = ?, cost = ?, turns = ?,
           updated_at = ? WHERE row_id = ?`;

/** The released `settle` write. */
const SETTLE_TASK = `UPDATE tasks SET status = ?, settled_at = ?, result_path = ?, updated_at = ?
         WHERE row_id = ? AND status = 'running'`;

/** The released ledger session row write. */
const WRITE_SESSION = `INSERT INTO sessions (session_id, session_file, cwd, started_at, updated_at,
           input, output, cache_read, cache_write, cost, turns)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET session_file = excluded.session_file,
           cwd = excluded.cwd, updated_at = excluded.updated_at, input = excluded.input,
           output = excluded.output, cache_read = excluded.cache_read,
           cache_write = excluded.cache_write, cost = excluded.cost, turns = excluded.turns`;

/** A format version 1 file at `path`, as a 0.2.27 process creates it. */
export function createFormat1(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("BEGIN IMMEDIATE");
    db.exec(FORMAT_1_SCHEMA);
    db.exec("PRAGMA user_version = 1;");
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/** The writes of a 0.2.27 process, on a connection of its own. */
export class Format1Writer {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 1000 });
  }

  insertAgent(rowId: string, taskId: string, turns: number): void {
    this.db
      .prepare(INSERT_TASK)
      .run(
        rowId,
        "session-old",
        taskId,
        null,
        0,
        "agent",
        0,
        "/w",
        null,
        "old",
        null,
        1000,
        1000,
        process.pid,
        1,
        null,
        0,
        0,
        0,
        0,
        0,
        turns,
      );
  }

  setUsage(rowId: string, turns: number): void {
    this.db.prepare(SET_TASK_USAGE).run(1, 2, 3, 4, 0.5, turns, 2000, rowId);
  }

  settle(rowId: string): void {
    this.db.prepare(SETTLE_TASK).run("completed", 3000, null, 3000, rowId);
  }

  writeSession(sessionId: string, turns: number): void {
    this.db.prepare(WRITE_SESSION).run(sessionId, null, "/w", 1000, 1000, 1, 2, 3, 4, 0.5, turns);
  }

  close(): void {
    this.db.close();
  }
}
