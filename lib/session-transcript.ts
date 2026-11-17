/**
 * Session transcript per specs/session-transcript.md: reading a session file
 * (Section 1), the transcript items an entry yields (Section 2), the current
 * lineage (Section 3), the session tree and the project (Section 4), the item
 * address (Section 5), and transcript and file order (Section 6).
 *
 * Reading is pure over bytes: `readSessionBytes` and its text and file wrappers
 * take the file's content, and only `readSessionFile`, `readSessionHeaderFile`,
 * `sessionTreeAsync`, and `projectMembersAsync` touch the file system. A read never
 * writes to, locks, or otherwise changes the file (Section 1).
 */

import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseDateTime } from "./schedule-time.ts";
import { isPlainObject } from "./util.ts";

/** Byte limit of a line a read parses; a longer line is skipped without parsing (Section 1). */
const LINE_BYTE_LIMIT = 16777216;

/** The most characters of an item's text that a query matches (Section 2). */
const MATCH_TEXT_CHARACTERS = 100000;

/** The bytes read at a time while looking for the first line's line feed. */
const HEADER_CHUNK_BYTES = 65536;

/** The bytes read at a time by a read of a file that continues from a byte offset. */
const READ_CHUNK_BYTES = 1048576;

/**
 * The UTF-8 decoder every line is read with. `ignoreBOM` keeps a byte-order mark
 * in the decoded text, so a line that starts with one is not JSON and is skipped
 * (Section 1).
 */
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** `safe`: `ALPHA`, `DIGIT`, `.`, `_`, and `-` (Section 5). */
const SAFE = "[A-Za-z0-9._-]";

/** A safe name: only the characters of `safe`, at least one (agent-tool.md Section 4.2). */
const SAFE_NAME = new RegExp(`^${SAFE}+$`);

/** `session-key` (Section 5): `self` is a `stem-path`, so the two productions merge. */
const SESSION_KEY = new RegExp(`^(?:${SAFE}+(?:/${SAFE}+)*|~${SAFE}{1,13}(?:/${SAFE}+)*)$`);

/** `entry-id`, which is also the usable entry ID of Section 1. */
const ENTRY_ID = /^[A-Za-z0-9_-]+$/;

/** `part` (Section 5). */
const PART = /^(?:0|[1-9][0-9]*|error)$/;

// ---------------------------------------------------------------------------
// Section 1: reading a session file
// ---------------------------------------------------------------------------

/** The session header: the first line's entry when that is a session entry with `type` `"session"` and a string `id` (Section 1). */
export interface SessionHeader {
  /** The session ID: the header's `id`. */
  sessionId: string;
  /** The header's `time`, milliseconds since the Unix epoch (Section 2). */
  time: number;
  /** The header line's byte length, its line feed not counted. */
  bytes: number;
}

/** What deriving an entry's items needs of the entry (Section 2). */
export interface TranscriptEntryRef {
  /** The line number, counting from 1 (Section 1). */
  line: number;
  /** The entry ID (Section 1). */
  entryId: string;
  /** The entry's `time`, milliseconds since the Unix epoch (Section 2). */
  time: number;
  /** The JSON object of the entry's line (Section 1). */
  value: Record<string, unknown>;
}

/** What the leaf and the current lineage need of an entry (Section 3). */
export interface LineageEntry {
  /** The line number, counting from 1 (Section 1). */
  line: number;
  /** The entry ID (Section 1). */
  entryId: string;
  /** `parentId` when it is a string, else `null` (Section 1). */
  parentId: string | null;
}

/**
 * A session entry that yields items and can be a member of a lineage: not the
 * session header, with a usable entry ID that no entry with a lower line number
 * carries (Sections 1-3).
 */
export interface SessionEntry extends TranscriptEntryRef, LineageEntry {
  /** The entry type; empty when `type` is not a string, which makes the entry one of an unused type (Section 1). */
  type: string;
  /** The byte offset of the line's first byte. */
  offset: number;
  /** The byte length of the line, its line feed not counted. */
  bytes: number;
}

/** The result of one read of a session file (Section 1). */
export interface SessionRead {
  /**
   * The session header, present exactly when the read includes the file's first
   * line and that line is a session header. A file is readable as a session file
   * only then (Section 1).
   */
  header: SessionHeader | undefined;
  /** The usable session entries after the header, in line order (Sections 1-3). */
  entries: SessionEntry[];
  /** The byte offset just after the last line feed the read used: where a continuation begins. */
  consumed: number;
  /** The number of lines the read used. */
  lines: number;
  /** The byte offset of the first byte of the last line the read used, or `from` when it used none. */
  tailOffset: number;
  /** The `time` of the last session entry the read used; absent when it used none (Section 2). */
  lastTime: number | undefined;
}

/** How a read continues the bytes of a file read earlier (Sections 1 and 2). */
export interface SessionReadOptions {
  /** The byte offset to continue from: the first byte of a line. Default `0`. */
  from?: number | undefined;
  /** The line number of the line at `from`. Default `1`. */
  line?: number | undefined;
  /**
   * The `time` of the last session entry before `from`, as an earlier read of
   * the same file returned it: the fallback `time` of the first entry read (Section 2).
   */
  previousTime?: number | undefined;
  /** The entry IDs carried by lines before `from`, the header's included (Section 1). */
  seenIds?: Iterable<string> | undefined;
  /**
   * The file position to read up to, not including: the size the caller observed
   * when it started the read. Default: to the end of the file. Bytes at or after
   * it are not read, so a line it cuts is dropped (Section 1).
   */
  to?: number | undefined;
  /**
   * The most bytes one read consumes, except that a single line longer than this
   * is consumed whole (session-index.md Section 3): the read ends after the last
   * line whose bytes end at or before `from + maxBytes`, or after the first line
   * when that one alone is longer. Default: no bound.
   */
  maxBytes?: number | undefined;
}

/** The header entry's narrowed shape: `type` `"session"` and a string `id` (Section 1). */
export interface SessionHeaderValue extends Record<string, unknown> {
  type: "session";
  id: string;
}

/**
 * The JSON object of one line, or undefined when the line is skipped: empty,
 * longer than 16777216 bytes, not JSON, or JSON other than an object. A longer
 * line is not parsed (Section 1).
 */
export function parseSessionLine(line: Uint8Array | string): Record<string, unknown> | undefined {
  const bytes = typeof line === "string" ? Buffer.byteLength(line, "utf8") : line.length;
  if (bytes === 0 || bytes > LINE_BYTE_LIMIT) return;
  const text = typeof line === "string" ? line : UTF8.decode(line);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  return isPlainObject(value) ? value : undefined;
}

/** True when `id` is a usable entry ID: a non-empty string of `A-Z`, `a-z`, `0-9`, `_`, and `-` (Section 1). */
export function isUsableEntryId(id: string): boolean {
  return ENTRY_ID.test(id);
}

/** True when `value` is a session header: `type` `"session"` and a string `id` (Section 1). */
export function isSessionHeader(value: Record<string, unknown>): value is SessionHeaderValue {
  return value.type === "session" && typeof value.id === "string";
}

/**
 * One read of the bytes of a session file, `bytes[0]` lying at file offset
 * `options.from` (Section 1). Every line a line feed terminates is used; a last
 * line no line feed terminates is not.
 */
export function readSessionBytes(bytes: Uint8Array, options: SessionReadOptions = {}): SessionRead {
  const from = options.from ?? 0;
  const seen = new Set<string>(options.seenIds ?? []);
  const entries: SessionEntry[] = [];
  let header: SessionHeader | undefined;
  let previousInstant = options.previousTime;
  let lastTime: number | undefined;
  let consumed = from;
  let tailOffset = from;
  let lines = 0;
  let line = options.line ?? 1;
  let cursor = 0;
  while (cursor < bytes.length) {
    const lf = bytes.indexOf(0x0a, cursor);
    if (lf < 0) break;
    const lineBytes = bytes.subarray(cursor, lf);
    const offset = from + cursor;
    cursor = lf + 1;
    lines += 1;
    consumed = from + cursor;
    tailOffset = offset;
    const value = parseSessionLine(lineBytes);
    if (value !== undefined) {
      const instant = instantOf(value);
      const time = instant ?? previousInstant ?? 0;
      if (instant !== undefined) previousInstant = instant;
      lastTime = time;
      if (offset === 0 && isSessionHeader(value)) {
        header = { sessionId: value.id, time, bytes: lineBytes.length };
        seen.add(value.id);
      } else {
        const id = value.id;
        if (typeof id === "string" && ENTRY_ID.test(id) && !seen.has(id)) {
          seen.add(id);
          entries.push({
            line,
            entryId: id,
            time,
            value,
            type: typeof value.type === "string" ? value.type : "",
            parentId: typeof value.parentId === "string" ? value.parentId : null,
            offset,
            bytes: lineBytes.length,
          });
        }
      }
    }
    line += 1;
  }
  return { header, entries, consumed, lines, tailOffset, lastTime };
}

/** One read of a session file given as text (Section 1); the text's UTF-8 bytes are read. */
export function readSessionText(text: string, options: SessionReadOptions = {}): SessionRead {
  return readSessionBytes(Buffer.from(text, "utf8"), options);
}

/**
 * One read of a session file (Section 1), or undefined when the file cannot be
 * read. The read starts at `options.from`, which is a byte offset of the file, so
 * `consumed`, every entry's offset, and every line number are absolute file
 * positions. The file is not written to, locked, or otherwise changed.
 */
export function readSessionFile(
  path: string,
  options: SessionReadOptions = {},
): SessionRead | undefined {
  const from = options.from ?? 0;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  let window: Buffer;
  try {
    window = readWindow(fd, from, options.to, options.maxBytes);
  } catch {
    return;
  } finally {
    closeSync(fd);
  }
  const consumed = consumedBytes(window, options.maxBytes);
  return readSessionBytes(window.subarray(0, consumed), { ...options, from });
}

/**
 * The parsed value of one line of a session file read back by byte offset and
 * length (session-index.md Section 3), or undefined when the bytes cannot be
 * read, are fewer than `bytes`, or are skipped by Section 1.
 */
export function readSessionLineAt(
  path: string,
  offset: number,
  bytes: number,
): Record<string, unknown> | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, offset);
    if (read !== bytes) return;
    return parseSessionLine(buffer.subarray(0, read));
  } catch {
    return;
  } finally {
    closeSync(fd);
  }
}

/**
 * The bytes of the file from `from` up to `to` or the end of the file, read at
 * their file positions. With `maxBytes`, the read stops once the line feed that
 * ends the first line reaching `maxBytes` has been read.
 */
function readWindow(
  fd: number,
  from: number,
  to: number | undefined,
  maxBytes: number | undefined,
): Buffer {
  const parts: Buffer[] = [];
  let position = from;
  let scanned = 0;
  for (;;) {
    let want = READ_CHUNK_BYTES;
    if (to !== undefined) {
      const remaining = to - position;
      if (remaining <= 0) break;
      if (remaining < want) want = remaining;
    }
    const chunk = Buffer.alloc(want);
    const read = readSync(fd, chunk, 0, want, position);
    if (read <= 0) break;
    const slice = chunk.subarray(0, read);
    parts.push(slice);
    const base = scanned;
    position += read;
    scanned += read;
    if (maxBytes !== undefined) {
      const lf = slice.indexOf(0x0a);
      if (lf >= 0 && base + lf >= maxBytes) break;
    }
  }
  return Buffer.concat(parts);
}

/**
 * The number of bytes of a window a read consumes (Section 1): the lines a line
 * feed terminates, up to the last line whose bytes end at or before `maxBytes`;
 * with no such line, the first line, which alone is longer than `maxBytes`
 * (session-index.md Section 3).
 */
function consumedBytes(bytes: Uint8Array, maxBytes: number | undefined): number {
  let cut = 0;
  let index = 0;
  for (;;) {
    const lf = bytes.indexOf(0x0a, index);
    if (lf < 0) break;
    const end = lf + 1;
    if (maxBytes !== undefined && end > maxBytes) {
      if (cut === 0) cut = end;
      break;
    }
    cut = end;
    index = end;
  }
  return cut;
}

/**
 * The session header of a session file (Section 1), or undefined when the file
 * cannot be read or its first line is not a session header. Only the first line
 * is read, so a file whose first line no line feed terminates is not readable as
 * a session file.
 */
export function readSessionHeaderFile(path: string): SessionHeader | undefined {
  const first = firstLineBytes(path);
  if (first === undefined) return;
  const value = parseSessionLine(first);
  if (value === undefined || !isSessionHeader(value)) return;
  return { sessionId: value.id, time: instantOf(value) ?? 0, bytes: first.length };
}

/** The instant an entry's `timestamp` names when it is a date-time (Section 2), else undefined. */
function instantOf(value: Record<string, unknown>): number | undefined {
  const timestamp = value.timestamp;
  return typeof timestamp === "string" ? parseDateTime(timestamp) : undefined;
}

/**
 * The bytes of the file's first line, its line feed not included, or undefined
 * when the file cannot be read, has no line feed, or its first line is longer
 * than the byte limit (Section 1).
 */
function firstLineBytes(path: string): Uint8Array | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const chunk = Buffer.alloc(HEADER_CHUNK_BYTES);
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      let read: number;
      try {
        read = readSync(fd, chunk, 0, chunk.length, null);
      } catch {
        return;
      }
      if (read === 0) return;
      const slice = chunk.subarray(0, read);
      const lf = slice.indexOf(0x0a);
      if (lf >= 0) {
        parts.push(Buffer.from(slice.subarray(0, lf)));
        return Buffer.concat(parts);
      }
      parts.push(Buffer.from(slice));
      total += read;
      if (total > LINE_BYTE_LIMIT) return;
    }
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Section 2: transcript items
// ---------------------------------------------------------------------------

/** The item kinds of Section 2. */
export type ItemKind =
  | "user"
  | "system"
  | "assistant"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "injected"
  | "summary"
  | "error";

/** One searchable piece of a session entry (Section 2). */
export interface TranscriptItem {
  /** The item kind. */
  kind: ItemKind;
  /** The part: the content element index in decimal digits, `error`, or undefined when the item has none. */
  part: string | undefined;
  /** The item's text. */
  text: string;
  /** The label when a non-empty string; the tool name for a `tool_call` or `tool_result` item. */
  label: string | undefined;
  /** The tool-call ID when a string. */
  toolCallId: string | undefined;
  /** True exactly for a `tool_result` item whose `message.isError` is `true`. */
  isError: boolean;
  /** The line number of the item's entry (Section 1). */
  line: number;
  /** The entry ID of the item's entry (Section 1). */
  entryId: string;
  /** The item's `time`: its entry's (Section 2), milliseconds since the Unix epoch. */
  time: number;
  /** The length of the text in characters. */
  length: number;
  /** The first 100000 characters of the text. */
  matchText: string;
}

/** The fields an item is built from. */
interface ItemFields {
  kind: ItemKind;
  part: string | undefined;
  text: string;
  label: string | undefined;
  toolCallId: string | undefined;
  isError: boolean;
}

/**
 * The items an entry yields, in part order, and no other (Section 2): one per
 * `message.content` element of an assistant entry, one for its model error, or
 * one for the entry as a whole. An entry of any other type, and a `message` entry
 * of any other role, yields none.
 */
export function entryItems(entry: TranscriptEntryRef): TranscriptItem[] {
  const value = entry.value;
  const type = value.type;
  if (type === "message") return messageItems(entry, value.message);
  if (type === "custom_message") {
    return listOf(
      buildItem(entry, {
        kind: "injected",
        part: undefined,
        text: contentText(value.content),
        label: labelOf(value.customType),
        toolCallId: undefined,
        isError: false,
      }),
    );
  }
  if (type === "compaction") {
    return listOf(
      buildItem(entry, {
        kind: "summary",
        part: undefined,
        text: stringOf(value.summary) ?? "",
        label: undefined,
        toolCallId: undefined,
        isError: false,
      }),
    );
  }
  return [];
}

/** The items of every entry given, in the order given: file order when the entries are in line order (Section 6). */
export function sessionItems(entries: readonly SessionEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const entry of entries) {
    for (const item of entryItems(entry)) items.push(item);
  }
  return items;
}

/**
 * The item that `item` is paired with (Section 2): the first item of the other
 * kind in file order that carries the same tool-call ID, when `item` is itself
 * the first of its kind to carry it. `items` are the items of one session file.
 */
export function pairedItem(
  item: TranscriptItem,
  items: readonly TranscriptItem[],
): TranscriptItem | undefined {
  const id = item.toolCallId;
  if (id === undefined) return;
  if (item.kind !== "tool_call" && item.kind !== "tool_result") return;
  const otherKind: ItemKind = item.kind === "tool_call" ? "tool_result" : "tool_call";
  const own = items
    .filter((other) => other.kind === item.kind && other.toolCallId === id)
    .toSorted(compareFileOrder);
  const first = own[0];
  if (first === undefined || compareFileOrder(first, item) !== 0) return;
  const opposite = items
    .filter((other) => other.kind === otherKind && other.toolCallId === id)
    .toSorted(compareFileOrder);
  return opposite[0];
}

/**
 * The content text of a value (Section 2): the value itself when it is a string;
 * when it is an array, the texts of the elements that give one, joined by one
 * line feed; otherwise the empty string.
 */
export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  const elements = arrayOf(value);
  if (elements === undefined) return "";
  const texts: string[] = [];
  for (const element of elements) {
    if (!isPlainObject(element)) continue;
    const type = element.type;
    if (type === "text") {
      const text = stringOf(element.text);
      if (text !== undefined) texts.push(text);
      continue;
    }
    if (type === "image") {
      const mimeType = stringOf(element.mimeType);
      texts.push(mimeType === undefined ? "[image]" : `[image ${mimeType}]`);
    }
  }
  return texts.join("\n");
}

/**
 * The argument text of a value (Section 2): one `<key>: <value>` block per key of
 * an object that is not an array, joined by one line feed, a string value
 * verbatim and any other value its `JSON.stringify` form; for any other value
 * its `JSON.stringify` form, and the empty string when the value is absent.
 */
export function argumentText(value: unknown): string {
  if (value === undefined) return "";
  if (isPlainObject(value)) {
    const blocks: string[] = [];
    for (const key of Object.keys(value)) blocks.push(`${key}: ${argumentValueText(value[key])}`);
    return blocks.join("\n");
  }
  return JSON.stringify(value) ?? "";
}

function argumentValueText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

/**
 * The prompt text of a system message (Section 2): its content text and the string
 * values of its `sections`, in the order `Object.values` gives for the value `JSON.parse`
 * returns, joined by one blank line; a non-string section value and an empty part are
 * left out, and a `sections` that is not an object yields no section values.
 */
export function systemPromptText(message: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = contentText(message.content);
  if (content.length > 0) parts.push(content);
  const sections = message.sections;
  if (isPlainObject(sections)) {
    for (const value of Object.values(sections)) {
      if (typeof value === "string" && value.length > 0) parts.push(value);
    }
  }
  return parts.join("\n\n");
}

function messageItems(entry: TranscriptEntryRef, message: unknown): TranscriptItem[] {
  if (!isPlainObject(message)) return [];
  const role = message.role;
  if (role === "user") {
    return listOf(
      buildItem(entry, {
        kind: "user",
        part: undefined,
        text: contentText(message.content),
        label: undefined,
        toolCallId: undefined,
        isError: false,
      }),
    );
  }
  if (role === "system") {
    return listOf(
      buildItem(entry, {
        kind: "system",
        part: undefined,
        text: systemPromptText(message),
        label: undefined,
        toolCallId: undefined,
        isError: false,
      }),
    );
  }
  if (role === "toolResult") {
    return listOf(
      buildItem(entry, {
        kind: "tool_result",
        part: undefined,
        text: contentText(message.content),
        label: labelOf(message.toolName),
        toolCallId: stringOf(message.toolCallId),
        isError: message.isError === true,
      }),
    );
  }
  if (role === "assistant") return assistantItems(entry, message);
  return [];
}

function assistantItems(
  entry: TranscriptEntryRef,
  message: Record<string, unknown>,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const content = arrayOf(message.content);
  if (content !== undefined) {
    for (let index = 0; index < content.length; index += 1) {
      const element = content[index];
      if (!isPlainObject(element)) continue;
      const part = String(index);
      const type = element.type;
      if (type === "text") {
        pushItem(
          items,
          buildItem(entry, {
            kind: "assistant",
            part,
            text: stringOf(element.text) ?? "",
            label: undefined,
            toolCallId: undefined,
            isError: false,
          }),
        );
        continue;
      }
      if (type === "thinking") {
        pushItem(
          items,
          buildItem(entry, {
            kind: "thinking",
            part,
            text: stringOf(element.thinking) ?? "",
            label: undefined,
            toolCallId: undefined,
            isError: false,
          }),
        );
        continue;
      }
      if (type === "toolCall") {
        pushItem(
          items,
          buildItem(entry, {
            kind: "tool_call",
            part,
            text: argumentText(element.arguments),
            label: labelOf(element.name),
            toolCallId: stringOf(element.id),
            isError: false,
          }),
        );
      }
    }
  }
  const errorMessage = stringOf(message.errorMessage);
  if (errorMessage !== undefined) {
    pushItem(
      items,
      buildItem(entry, {
        kind: "error",
        part: "error",
        text: errorMessage,
        label: undefined,
        toolCallId: undefined,
        isError: false,
      }),
    );
  }
  return items;
}

/**
 * The item of `fields`, or undefined when Section 2 forbids yielding it: an item
 * of kind `user`, `system`, `assistant`, `thinking`, `injected`, `summary`, or `error` whose
 * text has no character other than white space is not yielded.
 */
function buildItem(entry: TranscriptEntryRef, fields: ItemFields): TranscriptItem | undefined {
  const always = fields.kind === "tool_call" || fields.kind === "tool_result";
  if (!always && !/\S/.test(fields.text)) return;
  return {
    kind: fields.kind,
    part: fields.part,
    text: fields.text,
    label: fields.label,
    toolCallId: fields.toolCallId,
    isError: fields.isError,
    line: entry.line,
    entryId: entry.entryId,
    time: entry.time,
    length: fields.text.length,
    matchText: fields.text.slice(0, MATCH_TEXT_CHARACTERS),
  };
}

function pushItem(items: TranscriptItem[], item: TranscriptItem | undefined): void {
  if (item !== undefined) items.push(item);
}

function listOf(item: TranscriptItem | undefined): TranscriptItem[] {
  return item === undefined ? [] : [item];
}

/** A label that is not a non-empty string is absent (Section 2). */
function labelOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arrayOf(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Section 3: current lineage
// ---------------------------------------------------------------------------

/**
 * The leaf of a session file (Section 3): its entry with the highest line number.
 * `entries` are the entries `readSessionBytes` returns for one file; a minimal
 * `LineageEntry` is enough.
 */
export function leafEntry<T extends LineageEntry>(entries: readonly T[]): T | undefined {
  let leaf: T | undefined;
  for (const entry of entries) {
    if (leaf === undefined || entry.line > leaf.line) leaf = entry;
  }
  return leaf;
}

/**
 * The current lineage (Section 3), from the leaf's first ancestor to the leaf: the
 * leaf, the entry whose `id` equals its `parentId`, and so on, ending at an entry
 * whose `parentId` is null, absent, the ID of no entry, or the ID of an entry
 * already on the path. `entries` are the entries `readSessionBytes` returns for one
 * file, so a compaction's summarized entries stay members; a minimal `LineageEntry`
 * is enough.
 */
export function currentLineage<T extends LineageEntry>(entries: readonly T[]): T[] {
  const leaf = leafEntry(entries);
  if (leaf === undefined) return [];
  const byId = new Map<string, T>();
  for (const entry of entries) {
    if (!byId.has(entry.entryId)) byId.set(entry.entryId, entry);
  }
  const path: T[] = [leaf];
  const onPath = new Set<string>([leaf.entryId]);
  let current: T = leaf;
  for (;;) {
    const parentId = current.parentId;
    if (parentId === null || onPath.has(parentId)) break;
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    path.push(parent);
    onPath.add(parentId);
    current = parent;
  }
  return path.toReversed();
}

// ---------------------------------------------------------------------------
// Section 4: session tree
// ---------------------------------------------------------------------------

/** One member of a session tree (Section 4). */
export interface SessionMember {
  /** The session file's absolute path, symbolic links not resolved. */
  path: string;
  /** The session key relative to the root: `self` for the root, else the stem path. */
  key: string;
  /** The session header; undefined for a root without a session file or without a readable one. */
  header: SessionHeader | undefined;
  /** The `<stem>`s from the root's child down to this member; empty for the root. */
  stems: string[];
}

/** A project member and its session tree (Section 4.1). */
export interface ProjectMember {
  /** The session key: `~` and the first 13 characters of the session ID, or the whole ID when shorter. */
  key: string;
  /** The member's session tree, in session tree order: its root keyed `key`, each member `key/stem path`. */
  members: SessionMember[];
}

/**
 * The session tree of Section 4, discovered with a turn of the event loop
 * between members: `headerOf` answers a file's header, from a cache or by reading
 * it, and `pace` is awaited before each member is visited. `rootPath` need not
 * exist: a root without a session file is a member with no session entries, and
 * its agent directory is still read. `rootAgentDirectory` is the root's agent
 * directory when it is not `<stem>.agents` beside its file: a session without a
 * session file has `<tmpdir>/pi-dent-sessions/<sessionId>/` (agent-tool.md Section 4.2).
 */
export async function sessionTreeAsync(
  rootPath: string,
  rootAgentDirectory: string | undefined,
  headerOf: HeaderProvider,
  pace: () => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<SessionMember[]> {
  const members: SessionMember[] = [];
  await walkSessionTreeAsync(
    resolve(rootPath),
    [],
    sessionTreeKey,
    members,
    rootAgentDirectory,
    headerOf,
    pace,
    shouldStop,
  );
  return members;
}

/** How a session file's header is obtained: read, or answered from a cache (Section 4). */
export type HeaderProvider = (path: string) => SessionHeader | undefined;

/**
 * The project members of a main session (Section 4.1), each with its session tree,
 * in ascending order of their files' `<stem>`, discovered with a turn of the event
 * loop between members (see `sessionTreeAsync`).
 */
export async function projectMembersAsync(
  mainSessionPath: string,
  headerOf: HeaderProvider,
  pace: () => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<ProjectMember[]> {
  const mainPath = resolve(mainSessionPath);
  if (!isFile(mainPath)) return [];
  const directory = dirname(mainPath);
  const main = realPath(mainPath);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const members: ProjectMember[] = [];
  // A member is a regular file, never a symbolic link, so its path with links
  // resolved is the directory's resolved path and its name; a link to the main
  // session's file is no member either way (Section 4.1).
  const realDirectory = realPath(directory);
  for (const name of names.toSorted(compareStrings)) {
    if (shouldStop()) return members;
    if (!name.endsWith(".jsonl")) continue;
    const stem = name.slice(0, -".jsonl".length);
    if (!isChildStem(stem)) continue;
    const path = join(directory, name);
    if (join(realDirectory, name) === main) continue;
    if (!isRegularFile(path)) continue;
    await pace();
    const header = headerOf(path);
    if (header === undefined) continue;
    if (!SAFE_NAME.test(header.sessionId)) continue;
    const key = `~${header.sessionId.slice(0, 13)}`;
    const tree: SessionMember[] = [];
    await walkSessionTreeAsync(
      path,
      [],
      (stems) => (stems.length === 0 ? key : [key, ...stems].join("/")),
      tree,
      undefined,
      headerOf,
      pace,
      shouldStop,
    );
    members.push({ key, members: tree });
  }
  return members;
}

/** The sessions directory of a main session (Section 4.1): the directory that holds its session file. */
export function sessionsDirectory(sessionPath: string): string {
  return dirname(resolve(sessionPath));
}

/** The session key of a member of the invoking session's own tree: `self` for the root, else its stem path (Section 4). */
function sessionTreeKey(stems: string[]): string {
  return stems.length === 0 ? "self" : stems.join("/");
}

/** The session tree walk of Section 4, yielding to the event loop before each member. */
async function walkSessionTreeAsync(
  path: string,
  stems: string[],
  keyOf: (stems: string[]) => string,
  out: SessionMember[],
  rootAgentDirectory: string | undefined,
  headerOf: HeaderProvider,
  pace: () => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  if (shouldStop()) return;
  await pace();
  out.push({ path, key: keyOf(stems), header: headerOf(path), stems });
  const directory = rootAgentDirectory ?? agentDirectory(path);
  for (const child of childSessionFiles(directory, headerOf)) {
    await walkSessionTreeAsync(
      child.path,
      [...stems, child.stem],
      keyOf,
      out,
      undefined,
      headerOf,
      pace,
      shouldStop,
    );
  }
}

/** A session's agent directory: `<sessionDir>/<sessionStem>.agents/` (agent-tool.md Section 4.2). */
function agentDirectory(sessionPath: string): string {
  return join(dirname(sessionPath), `${sessionStem(sessionPath)}.agents`);
}

/** The `<stem>` of a session file: its basename without the `.jsonl` extension. */
function sessionStem(sessionPath: string): string {
  const name = basename(sessionPath);
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
}

/** The `<stem>` Section 4 requires of a child: non-empty, only safe-name characters, and not `self`. */
function isChildStem(stem: string): boolean {
  return stem !== "self" && SAFE_NAME.test(stem);
}

/**
 * The child session files of one agent directory (Section 4): the regular files,
 * not symbolic links, named `<stem>.jsonl` with a child `<stem>` that are readable
 * as session files, in ascending order of their `<stem>` by UTF-16 code units. A
 * missing or unreadable directory has no children.
 */
function childSessionFiles(
  agentDirectoryPath: string,
  headerOf: HeaderProvider = readSessionHeaderFile,
): { path: string; stem: string }[] {
  let names: string[];
  try {
    if (!lstatSync(agentDirectoryPath).isDirectory()) return [];
    names = readdirSync(agentDirectoryPath);
  } catch {
    return [];
  }
  const children: { path: string; stem: string }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const stem = name.slice(0, -".jsonl".length);
    if (!isChildStem(stem)) continue;
    const path = join(agentDirectoryPath, name);
    if (!isRegularFile(path)) continue;
    if (headerOf(path) === undefined) continue;
    children.push({ path, stem });
  }
  return children.toSorted((a, b) => compareStrings(a.stem, b.stem));
}

/** True when `path` is a regular file and not a symbolic link. */
function isRegularFile(path: string): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  return stat.isFile();
}

/** True when `path` is a file, a symbolic link to one included. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `path` with symbolic links resolved, or `path` when it cannot be resolved (Section 6). */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// ---------------------------------------------------------------------------
// Section 5: item address
// ---------------------------------------------------------------------------

/** An item address (Section 5): one transcript item relative to a session. */
export interface ItemAddress {
  /** The session key: `self`, a stem path, or `~` and up to 13 safe characters with an optional stem path. */
  sessionKey: string;
  /** The entry ID. */
  entryId: string;
  /** The part, or undefined when the address names no part. */
  part?: string | undefined;
}

/** The address `text` names, or undefined when it matches no `address` production (Section 5). */
export function parseItemAddress(text: string): ItemAddress | undefined {
  const colon = text.indexOf(":");
  if (colon < 0) return;
  const sessionKey = text.slice(0, colon);
  if (!SESSION_KEY.test(sessionKey)) return;
  const rest = text.slice(colon + 1);
  const dot = rest.indexOf(".");
  const entryId = dot < 0 ? rest : rest.slice(0, dot);
  if (!ENTRY_ID.test(entryId)) return;
  if (dot < 0) return { sessionKey, entryId };
  const part = rest.slice(dot + 1);
  if (!PART.test(part)) return;
  return { sessionKey, entryId, part };
}

/** The address of an item as text (Section 5): the session key, `:`, the entry ID, and the part when it has one. */
export function formatItemAddress(address: ItemAddress): string {
  const part = address.part;
  const suffix = part === undefined ? "" : `.${part}`;
  return `${address.sessionKey}:${address.entryId}${suffix}`;
}

/** The address of `item` relative to the session keyed `sessionKey` (Section 5). */
export function itemAddress(sessionKey: string, item: TranscriptItem): ItemAddress {
  return { sessionKey, entryId: item.entryId, part: item.part };
}

/** The item of `items` that `address` is the address of, or undefined when it is the address of none (Section 5). */
export function resolveItem(
  items: readonly TranscriptItem[],
  address: ItemAddress,
): TranscriptItem | undefined {
  for (const item of items) {
    if (item.entryId !== address.entryId) continue;
    if (item.part !== address.part) continue;
    return item;
  }
  return;
}

// ---------------------------------------------------------------------------
// Section 6: transcript order and file order
// ---------------------------------------------------------------------------

/** An item with the session it belongs to, for transcript order (Section 6). */
export interface SessionItem {
  /** The session key relative to the invoking session. */
  sessionKey: string;
  /** The session file's absolute path. */
  sessionPath: string;
  /**
   * The session file's path with symbolic links resolved, when the caller has it;
   * the comparator resolves `sessionPath` when it is absent (Section 6).
   */
  resolvedPath?: string | undefined;
  /** The transcript item. */
  item: TranscriptItem;
}

/**
 * File order (Section 6): the order of one session's items by line number, then
 * part as numbers with `error` last.
 */
export function compareFileOrder(a: TranscriptItem, b: TranscriptItem): number {
  if (a.line !== b.line) return a.line - b.line;
  return compareParts(a.part, b.part);
}

/**
 * Part order (Sections 2 and 6): `0`, `1`, `2`, … as numbers, `error` last. An
 * item without a part precedes every part; one entry never yields both.
 */
export function compareParts(a: string | undefined, b: string | undefined): number {
  const rankA = partRank(a);
  const rankB = partRank(b);
  if (rankA !== rankB) return rankA - rankB;
  if (rankA !== 1 || a === undefined || b === undefined) return 0;
  return Number(a) - Number(b);
}

/**
 * Transcript order (Section 6): ascending `time`, then ascending session key, then
 * ascending session file path with symbolic links resolved for equal keys of
 * different sessions, then line number, then part.
 */
export function compareTranscriptOrder(a: SessionItem, b: SessionItem): number {
  if (a.item.time !== b.item.time) return a.item.time - b.item.time;
  if (a.sessionKey !== b.sessionKey) return compareStrings(a.sessionKey, b.sessionKey);
  const pathA = placedPath(a);
  const pathB = placedPath(b);
  if (pathA !== pathB) return compareStrings(pathA, pathB);
  return compareFileOrder(a.item, b.item);
}

/** The session file path a placed item is ordered by: its resolved path (Section 6). */
function placedPath(placed: SessionItem): string {
  return placed.resolvedPath ?? realPath(placed.sessionPath);
}

function partRank(part: string | undefined): number {
  if (part === undefined) return 0;
  return part === "error" ? 2 : 1;
}

/** Compare two strings by UTF-16 code units. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
