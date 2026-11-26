import { appendFileSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openSessionIndex,
  type IndexFileRow,
  type IndexItemRow,
  type ReadOutcome,
  type SessionIndex,
  type SessionIndexOptions,
} from "../../lib/session-index.ts";

/** A temporary directory for fixtures; the caller removes it. */
export function tempDir(prefix = "session-index-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A timestamp every entry of a fixture can carry. */
export const STAMP = "2026-01-01T00:00:00.000Z";

/** The index file's path inside a test's temporary directory. */
export function indexPath(dir: string, name = "search-v3.sqlite"): string {
  return join(dir, name);
}

/** The line of one JSON object, no line feed. */
export function entryLine(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/** The session header's line (Section 1). */
export function headerLine(id = "session-one", timestamp = STAMP): string {
  return entryLine({ type: "session", version: 3, id, timestamp, cwd: "/tmp" });
}

/** A `message` entry's line with `message` as given. */
export function messageLine(
  id: string,
  parentId: string | null,
  message: Record<string, unknown>,
  timestamp = STAMP,
): string {
  return entryLine({ type: "message", id, parentId, timestamp, message });
}

/** A `user` entry's line whose content is one text element. */
export function userLine(
  id: string,
  parentId: string | null,
  text: string,
  timestamp = STAMP,
): string {
  return messageLine(id, parentId, { role: "user", content: [{ type: "text", text }] }, timestamp);
}

/** An `assistant` entry's line with the content elements given. */
export function assistantLine(
  id: string,
  parentId: string | null,
  content: readonly unknown[],
  timestamp = STAMP,
): string {
  return messageLine(id, parentId, { role: "assistant", content }, timestamp);
}

/** A `toolResult` entry's line. */
export function toolResultLine(
  id: string,
  parentId: string | null,
  toolName: string,
  toolCallId: string,
  text: string,
  isError = false,
  timestamp = STAMP,
): string {
  return messageLine(
    id,
    parentId,
    { role: "toolResult", toolName, toolCallId, isError, content: [{ type: "text", text }] },
    timestamp,
  );
}

/** A session file's text: each line terminated by a line feed. */
export function fileText(...lines: readonly string[]): string {
  return lines.map((one) => `${one}\n`).join("");
}

/** Write a session file of the given lines, each terminated by a line feed. */
export function writeSession(path: string, ...lines: readonly string[]): void {
  writeFileSync(path, fileText(...lines));
}

/** Append one line and its line feed to a session file. */
export function appendLine(path: string, line: string): void {
  appendFileSync(path, `${line}\n`);
}

/** Set a file's modification time, in milliseconds since the Unix epoch, for a deterministic catch-up. */
export function setMtime(path: string, milliseconds: number): void {
  const seconds = milliseconds / 1000;
  utimesSync(path, seconds, seconds);
}

/** Open a test's index, failing the test when it is unusable. */
export function openIndex(path: string, options: SessionIndexOptions = {}): SessionIndex {
  const opened = openSessionIndex({ ...options, path });
  if (!opened.ok) throw new Error(`index unusable: ${opened.reason}`);
  return opened.index;
}

/** The value of a read that the test expects to succeed. */
export function ok<T>(outcome: ReadOutcome<T>): T {
  if (!outcome.ok) throw new Error(`index read failed: ${outcome.reason}`);
  return outcome.value;
}

/** The `files` row of a session file the test has caught up. */
export function fileOf(index: SessionIndex, sessionPath: string): IndexFileRow {
  const row = ok(index.fileFor(sessionPath));
  if (row === undefined) throw new Error(`no files row for ${sessionPath}`);
  return row;
}

/** The items of a session file the test has caught up, in file order. */
export function itemsOf(index: SessionIndex, sessionPath: string): IndexItemRow[] {
  return ok(index.listItems(fileOf(index, sessionPath).fileId));
}

/** A second connection to the index file, for reading rows the test asserts on. */
export function rawIndex(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

/** The value of `PRAGMA user_version` of the file at `path`, or -1 when it has none. */
export function userVersionOf(path: string): number {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("PRAGMA user_version").get();
    const value = row === undefined ? undefined : row.user_version;
    return typeof value === "number" ? value : -1;
  } finally {
    db.close();
  }
}
