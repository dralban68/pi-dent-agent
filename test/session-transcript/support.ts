import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temporary directory for fixtures; the caller removes it. */
export function tempDir(prefix = "session-transcript-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A timestamp every entry of a fixture can carry. */
export const STAMP = "2026-01-01T00:00:00.000Z";

/** The line of one JSON object, no line feed. */
export function entryLine(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/** The session header's line (specs/session-transcript.md#reading). */
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

/** A session file's text: each line terminated by a line feed. */
export function fileText(...lines: string[]): string {
  return lines.map((one) => `${one}\n`).join("");
}

/** Write a session file of the given lines, each terminated by a line feed. */
export function writeSession(path: string, ...lines: string[]): void {
  writeFileSync(path, fileText(...lines));
}
