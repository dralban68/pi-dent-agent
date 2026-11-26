import { spawn } from "node:child_process";
import type { ToolResult } from "./engine.ts";
import type { TaskRegistry } from "./registry.ts";
import type { TaskRow } from "./task-row.ts";
import { renderCardResult, type CardContext, type CardTheme } from "./tool-card.ts";
import { errorMessage, firstLine } from "./util.ts";

/**
 * Task-tool helpers (specs/bash-tool.md and specs/script-tool.md): tool errors,
 * process-tree termination, UTF-8 prefix bounds, progress entries, Script's
 * progress line splitter, and pre-start rejections.
 */

/** Code points a line's progress entry keeps, and an excerpt line cuts at (specs/bash-tool.md#output-capture). */
export const LINE_CHARACTERS = 500;

/** A tool error result: the message as content, no details. */
export function textError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

/**
 * Windows forced termination of a process and its descendants (taskkill /T /F).
 * `taskkill` may be missing or fail to start: the error listener keeps that
 * asynchronous failure from escaping as an uncaught exception.
 */
export function killTreeWindows(pid: number): void {
  try {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {});
  } catch {
    // Best effort.
  }
}

/**
 * Signal one process group: `kill` fails as a whole, so `ESRCH` (no member) and
 * `EPERM` (no member signalable) both mean the signal reached no process.
 */
export function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** The longest prefix of `text` of at most `maxBytes` UTF-8 bytes, at a code point boundary. */
export function prefixBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const parts: string[] = [];
  let bytes = 0;
  for (const ch of text) {
    const charBytes = Buffer.byteLength(ch);
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    parts.push(ch);
  }
  return parts.join("");
}

/** The first `limit` code points of `text`, never splitting a surrogate pair. */
export function prefixPoints(text: string, limit: number): string {
  const points: string[] = [];
  for (const point of text) {
    if (points.length >= limit) break;
    points.push(point);
  }
  return points.join("");
}

/** The number of Unicode code points in `text`. */
export function pointCount(text: string): number {
  let count = text.length;
  const pairs = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
  while (pairs.exec(text) !== null) count -= 1;
  return count;
}

/** The cut note of a progress entry (specs/bash-tool.md#output-capture). */
export function omissionNote(count: number): string {
  return ` … [${count} ${count === 1 ? "character" : "characters"} omitted]`;
}

/**
 * Script's progress lines (specs/script-tool.md#timeout-delivery): a line is the text
 * between two `\n` characters, a final `\n` starting no further line, and the
 * text after the last `\n` is the unterminated last line. Each line becomes its
 * progress entry as it completes, so a chunk costs O(chunk) and the pending
 * line keeps only an entry's worth of text — its first 500 code points, a final
 * `\r` excepted, and its length (specs/bash-tool.md#output-capture).
 */
export class ProgressLines {
  /** The first `LINE_CHARACTERS` code points of the pending line. */
  private head = "";
  /** The code points of the pending line. */
  private count = 0;
  /** The last code unit of the pending line, for the line's final `\r`. */
  private tail = "";

  /** The entries of the lines `chunk` completed, in order. */
  push(chunk: string): string[] {
    const entries: string[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline < 0) {
        this.add(chunk.slice(start));
        return entries;
      }
      this.add(chunk.slice(start, newline));
      entries.push(this.entry());
      this.head = "";
      this.count = 0;
      this.tail = "";
      start = newline + 1;
    }
  }

  /** The entry of the unterminated last line; `undefined` when there is none. */
  last(): string | undefined {
    return this.count === 0 ? undefined : this.entry();
  }

  /** Append text to the pending line, keeping only its entry's part. */
  private add(text: string): void {
    if (text === "") return;
    const room = LINE_CHARACTERS - this.count;
    if (room > 0) this.head += prefixPoints(text, room);
    this.count += pointCount(text);
    this.tail = text.slice(-1);
  }

  /** The pending line's entry: its display text, cut, with the omission note. */
  private entry(): string {
    const carriageReturn = this.tail === "\r";
    const count = carriageReturn ? this.count - 1 : this.count;
    const head =
      carriageReturn && this.count <= LINE_CHARACTERS ? this.head.slice(0, -1) : this.head;
    return head + (count > LINE_CHARACTERS ? omissionNote(count - LINE_CHARACTERS) : "");
  }
}

/** The label fallback of Section 6: the first line of `text` without leading white space, 80 characters. */
export function labelFallback(text: string): string {
  return firstLine(text.trimStart(), 80);
}

/** A pre-start rejection (Section 6): the row is consumed and settles `failed`. */
export function rejectCall(registry: TaskRegistry, row: TaskRow, message: string): ToolResult {
  registry.consume(row);
  registry.settle(row, { status: "failed", result: message });
  return textError(message);
}

/** Settle a background run whose promise failed, so no rejection escapes. */
export function settleBackgroundFailure(
  registry: TaskRegistry,
  row: TaskRow,
  tool: "Bash" | "Script",
  error: unknown,
): void {
  registry.settle(row, { status: "failed", result: `${tool} error: ${errorMessage(error)}` });
}

/** The result card of a `Bash` or `Script` call (tool-card.md). */
export function renderToolCardResult(
  result: { content: readonly { type: string; text?: string }[] },
  _options: unknown,
  theme: CardTheme,
  context: CardContext,
) {
  return renderCardResult(result, theme, context);
}
