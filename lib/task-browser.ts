import { type KeyId, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { localStampIn } from "./billing-text.ts";
import { killFromBrowser, type TaskRegistry } from "./registry.ts";
import {
  AgentTaskRow,
  BashTaskRow,
  plainText,
  shownLabel,
  ScriptTaskRow,
  type TaskPaint,
  type TaskRow,
  type TaskStatus,
} from "./task-row.ts";
import {
  collectAllTasks,
  collectRunningTasks,
  flattenTree,
  hasRunningTask,
} from "./task-widget.ts";
import { formatUsage } from "./usage.ts";
import { errorMessage, shortenSessionDir } from "./util.ts";

/**
 * Task browser per specs/task-browser.md: the list page of the whole task
 * tree and the details page of one task row. Rendering is a pure function of
 * (rows, events, state, width, height); `TaskBrowserState` owns the page,
 * selection, expansion, and scroll state and performs no I/O of its own.
 */

export interface BrowserTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
}

export const identityTheme: BrowserTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
};

const STATUS_COLOR: Record<TaskStatus, string> = {
  running: "accent",
  completed: "success",
  failed: "error",
  cancelled: "warning",
  interrupted: "warning",
};

const LIST_HINT = "↑↓ select · g/G top/bottom · f running/all · enter details · esc close";

/** The list page's filter (Section 3): `all` at every open, kept across a details visit. */
export type ListFilter = "all" | "running";
const AGENT_BASE_HINT = "↑↓ select · g/G top/bottom · enter expand · e/c all";
/** The armed agent line has no `g/G top/bottom`, so it fits 80 columns (task-browser.md Section 4.1). */
const AGENT_ARMED_BASE_HINT = "↑↓ select · enter expand · e/c all";
const SCRIPT_BASE_HINT = "↑↓ scroll · g/G top/bottom";
/** The kill key of every details page (Section 4.4). */
const KILL_KEY = "ctrl+k";

/** `g` is an alias of `home`, `G` of `end` (browser-navigation.md, Section 4); `G` is matched on the raw input, as the host folds case. */
const isTop = (data: string): boolean => matchesKey(data, "home") || data === "g";
const isBottom = (data: string): boolean => matchesKey(data, "end") || data === "G";
const MAX_EVENT_LINES = 200;

/** The details page's key-hint line (Sections 4.1, 4.2, 4.4): the kill segment only where it applies. */
function detailsHint(row: TaskRow, killable: boolean, armed: boolean): string {
  const base =
    row instanceof AgentTaskRow
      ? killable && armed
        ? AGENT_ARMED_BASE_HINT
        : AGENT_BASE_HINT
      : SCRIPT_BASE_HINT;
  const kill = killable ? ` · ${KILL_KEY} ${armed ? "again to confirm kill" : "kill"}` : "";
  return `${base}${kill} · esc back`;
}

/** `<time>` per Section 2: `HH:MM:SS` in the local zone. */
function clock(ms: number, zone: string): string {
  return localStampIn(ms, zone).slice(11, 19);
}

/** `<datetime>` per Section 2: `YYYY-MM-DD HH:MM:SS` in the local zone. */
function dateTime(ms: number, zone: string): string {
  const stamp = localStampIn(ms, zone);
  return `${stamp.slice(0, 10)} ${stamp.slice(11, 19)}`;
}

/**
 * The list page's paint (Section 2): the task line's channels, plus `<time>`. The list page
 * leaves `<detail>` uncolored where the widget paints it `dim` (task.md Section 4), and
 * colors every status by its own palette.
 */
function listPaint(theme: BrowserTheme): TaskPaint {
  return {
    status: (text, status) => theme.fg(STATUS_COLOR[status], text),
    orphan: (text) => theme.fg("warning", text),
    elapsed: (text) => theme.fg("muted", text),
    detail: (text) => text,
    time: (text) => theme.fg("muted", text),
  };
}

export interface SessionEvent {
  /** `<entry position>:<block index>`. */
  key: string;
  /** The entry's ISO timestamp. */
  time: string;
  kind: string;
  summary: string;
  content: string;
  isError: boolean;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

function json(value: unknown, indent?: number): string {
  return (indent === undefined ? JSON.stringify(value) : JSON.stringify(value, null, indent)) ?? "";
}

/** The text of a message (Section 4.3): string content, else text blocks and `[<type>]` lines. */
function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (isObject(block) && block.type === "text" && typeof block.text === "string")
        return block.text;
      return `[${isObject(block) ? str(block.type) : ""}]`;
    })
    .join("\n");
}

function assistantEvents(
  entryIndex: number,
  message: Record<string, unknown>,
  time: string,
): SessionEvent[] {
  // A string `message.content` is one `text` block (Section 4.3).
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, blockIndex): SessionEvent[] => {
    const key = `${entryIndex}:${blockIndex}`;
    const type = isObject(block) ? str(block.type) : "";
    const event = (kind: string, summary: string, text: string): SessionEvent => ({
      key,
      time,
      kind,
      summary,
      content: text,
      isError: false,
    });
    // A blank `text` or `thinking` block yields no session event (Section 4.3).
    if (isObject(block) && (type === "text" || type === "thinking")) {
      const text = str(type === "text" ? block.text : block.thinking);
      if (text.trim() === "") return [];
      return [event(type === "text" ? "assistant" : "thinking", firstLine(text), text)];
    }
    if (isObject(block) && type === "toolCall") {
      const args = block.arguments;
      return [event(`call ${str(block.name)}`, json(args), json(args, 2))];
    }
    return [event(type, "", json(block, 2))];
  });
}

/** The session events of one entry line at `entryIndex` (Section 4.3). */
function entryEvents(line: string, entryIndex: number): SessionEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  const type = parsed.type;
  const time = parsed.timestamp;
  if (typeof type !== "string" || type === "session") return [];
  if (typeof time !== "string" || !ISO_TIMESTAMP.test(time)) return [];
  const key = `${entryIndex}:0`;
  if (type !== "message") {
    return [{ key, time, kind: type, summary: "", content: json(parsed, 2), isError: false }];
  }
  const message = isObject(parsed.message) ? parsed.message : {};
  // A `message` without a string `role` has `<kind>` `message` (Section 4.3).
  const role = typeof message.role === "string" ? message.role : undefined;
  if (role === "assistant") return assistantEvents(entryIndex, message, time);
  const content = messageText(message);
  const kind =
    role === undefined
      ? "message"
      : role === "toolResult"
        ? `result ${str(message.toolName)}`
        : role;
  return [
    {
      key,
      time,
      kind,
      summary: firstLine(content),
      content,
      isError: role === "toolResult" && message.isError === true,
    },
  ];
}

/** Session events of a session file (Section 4.3), derived from its lines in file order. */
export function deriveSessionEvents(text: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  text.split(/\r?\n/).forEach((line, entryIndex) => {
    events.push(...entryEvents(line, entryIndex));
  });
  return events;
}

/** The outcome of one `SessionEventReader.next` read. */
export interface SessionStep {
  /** The events read so far no longer hold: the file shrank, or it cannot be read. */
  restarted: boolean;
  /** The events this read appended, in file order. */
  added: SessionEvent[];
}

/**
 * Incremental session-file reader (Section 4.3): parses only the appended complete lines of
 * the file. Shared by the details page and the task detail feed (task.md Section 4.2).
 */
export class SessionEventReader {
  /** Consumed length, partial line, and entry index of the file read so far. */
  private offset = 0;
  private partial = "";
  private entry = 0;

  /** Forget the file: the next read parses it from the start. */
  reset(): void {
    this.offset = 0;
    this.partial = "";
    this.entry = 0;
  }

  /**
   * One read of the file's `text`, `undefined` when it cannot be read. A shorter file is
   * re-read from the start. `final` also parses a trailing line without a newline.
   */
  next(text: string | undefined, final: boolean): SessionStep {
    if (text === undefined) {
      this.reset();
      return { restarted: true, added: [] };
    }
    // A trailing U+FFFD may be a half-written multi-byte character that completes on the
    // next read; consuming it now shifts every later index and garbles the appended text.
    // Hold it back: re-read it whole once the file grows, or at settlement (Section 4.3).
    let usable = text;
    if (!final && text.endsWith("\uFFFD")) usable = text.slice(0, -1);
    let restarted = false;
    if (usable.length < this.offset) {
      this.reset();
      restarted = true;
    }
    const appended = this.partial + usable.slice(this.offset);
    this.offset = usable.length;
    if (appended === "") return { restarted, added: [] };
    const end = appended.lastIndexOf("\n");
    let complete: string;
    if (end < 0) {
      if (!final) {
        this.partial = appended;
        return { restarted, added: [] };
      }
      complete = appended;
      this.partial = "";
    } else {
      const rest = appended.slice(end + 1);
      if (final && rest !== "") {
        complete = appended;
        this.partial = "";
      } else {
        complete = appended.slice(0, end);
        this.partial = rest;
      }
    }
    return { restarted, added: this.parseLines(complete.split("\n")) };
  }

  private parseLines(lines: string[]): SessionEvent[] {
    const added: SessionEvent[] = [];
    lines.forEach((line, index) => {
      added.push(...entryEvents(line.replace(/\r$/, ""), this.entry + index));
    });
    this.entry += lines.length;
    return added;
  }
}

export interface ListEntry {
  row: TaskRow;
  prefix: string;
}

/** The list page's content (Section 3): every task of the tree, or only the running ones. */
export function listEntries(registry: TaskRegistry, filter: ListFilter = "all"): ListEntry[] {
  return flattenTree(
    filter === "running" ? collectRunningTasks(registry) : collectAllTasks(registry),
  );
}

/** The title's counts: those of the whole task tree under either filter (Section 3). */
export function treeCounts(registry: TaskRegistry): { running: number; total: number } {
  const entries = flattenTree(collectAllTasks(registry));
  return {
    running: entries.filter((entry) => entry.row.status === "running").length,
    total: entries.length,
  };
}

/** List row line (Section 3) without theme coloring of the selection: the row line plus `<time>`. */
export function renderListLine(
  entry: ListEntry,
  now: number,
  theme: BrowserTheme = identityTheme,
  zone = "UTC",
): string {
  const row = entry.row;
  return `${entry.prefix}${row.renderLine(now, listPaint(theme), clock(row.startedAt, zone))}`;
}

/**
 * The registry that holds `row` while the kill key applies to it (Section 4.4): the row is
 * `running` and a registry of the task tree from `root` holds it. Otherwise undefined.
 */
export function killHolder(root: TaskRegistry, row: TaskRow): TaskRegistry | undefined {
  return row.status === "running" ? holderIn(root, row) : undefined;
}

/** The registry of the task tree from `root` that holds `row` (Section 4.4). */
function holderIn(root: TaskRegistry, row: TaskRow): TaskRegistry | undefined {
  const seen = new Set<TaskRegistry>();
  const walk = (registry: TaskRegistry): TaskRegistry | undefined => {
    if (seen.has(registry)) return undefined;
    seen.add(registry);
    if (registry.get(row.taskId) === row) return registry;
    for (const candidate of registry.list()) {
      if (!(candidate instanceof AgentTaskRow) || candidate.children === undefined) continue;
      const found = walk(candidate.children);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(root);
}

interface PageArgs {
  now: number;
  width: number;
  height: number;
  theme: BrowserTheme;
  /** The local zone of billing.md Section 5; `UTC` when the caller names none. */
  zone?: string | undefined;
}

/** Exactly `height` lines: title, the scrolled and padded body, the hint line. */
function pageView(
  title: string,
  body: string[],
  hint: string,
  height: number,
  width: number,
  scroll: number,
): string[] {
  const view = Math.max(0, height - 2);
  const start = Math.max(0, Math.min(scroll, Math.max(0, body.length - view)));
  const out = [truncateToWidth(title, width)];
  for (let i = 0; i < view; i++) out.push(truncateToWidth(body[start + i] ?? "", width));
  out.push(truncateToWidth(hint, width));
  return out.slice(0, Math.max(0, height));
}

export interface ListPageArgs extends PageArgs {
  entries: readonly ListEntry[];
  /** The whole task tree's counts, which the title shows under either filter (Section 3). */
  counts: { running: number; total: number };
  filter?: ListFilter | undefined;
  selected?: number | undefined;
  scroll?: number | undefined;
}

/** List page (Section 3): the filtered task rows, one selected, exactly `height` lines. */
export function renderList(args: ListPageArgs): string[] {
  const { entries, counts, now, width, height, theme } = args;
  const filter = args.filter ?? "all";
  const selected = args.selected ?? 0;
  const body =
    entries.length === 0
      ? [filter === "running" ? "(no running tasks)" : "(no tasks)"]
      : entries.map((entry, index) => {
          const line = renderListLine(entry, now, theme, args.zone ?? "UTC");
          return index === selected ? theme.bg("selectedBg", line) : line;
        });
  const suffix = filter === "running" ? " · running only" : "";
  return pageView(
    `Tasks · ${counts.running} running · ${counts.total} total${suffix}`,
    body,
    LIST_HINT,
    height,
    width,
    args.scroll ?? 0,
  );
}

interface Section {
  name: string;
  lines: string[];
}

/** Sections: name on its own line, `(none)` when empty, one empty line between sections. */
function sectionsToLines(sections: Section[]): string[] {
  const out: string[] = [];
  sections.forEach((section, index) => {
    out.push(section.name);
    out.push(...(section.lines.length > 0 ? section.lines : ["(none)"]));
    if (index < sections.length - 1) out.push("");
  });
  return out;
}

function deliveryValue(row: TaskRow, theme: BrowserTheme): string {
  return `${row.delivery}${row.orphan ? ` · ${theme.fg("warning", "orphan")}` : ""}`;
}

const shownPath = (path: string): string => shortenSessionDir(plainText(path));

/** One `<name>: <value>` line of a details section (Sections 4.1, 4.2). */
export interface DetailField {
  name: string;
  value: string;
}

const fieldLine = (field: DetailField): string => `${field.name}: ${field.value}`;

/** The `Agent` section fields of Section 4.1, absent values omitted. */
export function agentFields(row: AgentTaskRow, theme: BrowserTheme, zone: string): DetailField[] {
  const fields: DetailField[] = [];
  if (row.agent !== undefined) fields.push({ name: "agent", value: plainText(row.agent) });
  if (row.model !== undefined) fields.push({ name: "model", value: plainText(row.model) });
  fields.push({ name: "delivery", value: deliveryValue(row, theme) });
  fields.push({ name: "started", value: dateTime(row.startedAt, zone) });
  if (row.settledAt !== undefined)
    fields.push({ name: "settled", value: dateTime(row.settledAt, zone) });
  if (row.usage !== undefined) fields.push({ name: "usage", value: formatUsage(row.usage) });
  if (row.sessionPath !== undefined)
    fields.push({ name: "session", value: shownPath(row.sessionPath) });
  if (row.resultPath !== undefined)
    fields.push({ name: "result", value: shownPath(row.resultPath) });
  return fields;
}

/** The `Task` section of Section 4.1: every line of the task text, wrapped to the body width. */
function taskLines(task: string, width: number): string[] {
  return task
    .split(/\r?\n/)
    .flatMap((line) =>
      wrapTextWithAnsi(shownPath(line.replaceAll("\t", "  ")), Math.max(1, width)),
    );
}

/** The `Error` section of Section 4.1: a failed row's result text, wrapped to the body width. */
function errorSection(row: AgentTaskRow, width: number): Section[] {
  if (row.status !== "failed" || row.result === undefined) return [];
  const lines = row.result
    .split(/\r?\n/)
    .flatMap((line) => wrapTextWithAnsi(shownPath(line), Math.max(1, width)));
  return [{ name: "Error", lines }];
}

/**
 * The `Command` section of Section 4.2: a `bash` row's command, one line per text line, each
 * wrapped to the body width, the agent directory as `$PI_DENT_SESSION_DIR` (agent-tool.md Section
 * 4.2); a tab is 2 spaces, as in the expanded content of Section 4.3.
 */
function commandSection(row: BashTaskRow, width: number): Section {
  const lines = row.command
    .split(/\r?\n/)
    .flatMap((line) =>
      wrapTextWithAnsi(shownPath(line.replaceAll("\t", "  ")), Math.max(1, width)),
    );
  return { name: "Command", lines };
}

/** Syntax highlighting of script source (task-browser.md Section 4.2); absent where the extension instance provides none. */
export type HighlightCode = (code: string, lang?: string) => readonly string[];

/** Cached `Code` section lines, keyed by row and code length: the owning contract sets `code` once. */
interface CachedCodeLines {
  width: number;
  lines: string[];
}

/**
 * The `Code` section of Section 4.2: a `script` row's code, one line per text line, each wrapped
 * to the body width, a tab as 2 spaces, highlighted as TypeScript where the browser has a
 * highlighter. Shown per agent-tool.md Section 4.2, like `Command`.
 */
function codeSection(
  row: ScriptTaskRow,
  width: number,
  highlightCode: HighlightCode | undefined,
  cache: Map<string, CachedCodeLines> | undefined,
): Section {
  const key = `${row.taskId}:${row.code.length}`;
  const cached = cache?.get(key);
  if (cached && cached.width === width) return { name: "Code", lines: cached.lines };
  const source = highlightCode ? highlightCode(row.code, "ts") : row.code.split(/\r?\n/);
  const lines = source.flatMap((line) =>
    wrapTextWithAnsi(shownPath(line.replaceAll("\t", "  ")), Math.max(1, width)),
  );
  if (cache) cache.set(key, { width, lines });
  return { name: "Code", lines };
}

/** The section fields of Section 4.2, shared by `script` and `bash` rows. */
export function scriptFields(row: TaskRow, theme: BrowserTheme, zone: string): DetailField[] {
  const fields: DetailField[] = [
    { name: "label", value: shownLabel(row.label) },
    { name: "delivery", value: deliveryValue(row, theme) },
    { name: "started", value: dateTime(row.startedAt, zone) },
  ];
  if (row.settledAt !== undefined)
    fields.push({ name: "settled", value: dateTime(row.settledAt, zone) });
  if (row.resultPath !== undefined)
    fields.push({ name: "result", value: shownPath(row.resultPath) });
  return fields;
}

interface CachedEventLines {
  width: number;
  open: boolean;
  /** The header line without selection coloring, then the expanded content lines. */
  lines: string[];
}

/** The unselected lines of one session event, cached by (event key, expanded, width). */
function renderEventLines(
  event: SessionEvent,
  open: boolean,
  width: number,
  theme: BrowserTheme,
  zone: string,
): string[] {
  const summary = plainText(event.summary);
  const line = `${open ? "▾" : "▸"} ${theme.fg("muted", clock(Date.parse(event.time), zone))} ${theme.fg(
    event.isError ? "error" : "accent",
    plainText(event.kind),
  )}${summary === "" ? "" : ` · ${summary}`}`;
  if (!open) return [line];
  const lines = [line];
  if (event.content === "") {
    lines.push("  (empty)");
    return lines;
  }
  const textWidth = Math.max(1, width - 2);
  for (const source of event.content.split(/\r?\n/)) {
    // A tab is 2 spaces, before control-character removal (Section 4.3).
    const text = plainText(source.replaceAll("\t", "  "));
    for (const wrapped of wrapTextWithAnsi(text, textWidth)) lines.push(`  ${wrapped}`);
  }
  return lines;
}

function eventLines(
  events: readonly SessionEvent[],
  expanded: ReadonlyMap<string, boolean>,
  selected: string | undefined,
  width: number,
  theme: BrowserTheme,
  zone: string,
  cache: Map<string, CachedEventLines>,
): { lines: string[]; at: Map<string, number> } {
  const lines: string[] = [];
  const at = new Map<string, number>();
  for (const event of events) {
    at.set(event.key, lines.length);
    const open = expanded.get(event.key) === true;
    let cached = cache.get(event.key);
    if (!cached || cached.width !== width || cached.open !== open) {
      cached = { width, open, lines: renderEventLines(event, open, width, theme, zone) };
      cache.set(event.key, cached);
    }
    const [header, ...content] = cached.lines;
    // At most 200 wrapped content lines, then `… <n> more lines` (Section 4.3).
    const shown = content.slice(0, MAX_EVENT_LINES);
    const headerLine = header ?? "";
    lines.push(event.key === selected ? theme.bg("selectedBg", headerLine) : headerLine);
    lines.push(...shown);
    if (content.length > shown.length)
      lines.push(`  … ${content.length - shown.length} more lines`);
  }
  for (const key of cache.keys()) if (!at.has(key)) cache.delete(key);
  return { lines, at };
}

interface DetailLayout {
  title: string;
  hint: string;
  lines: string[];
  eventLines: Map<string, number>;
}

function buildDetails(
  row: TaskRow,
  events: readonly SessionEvent[],
  expanded: ReadonlyMap<string, boolean>,
  selected: string | undefined,
  theme: BrowserTheme,
  width: number,
  now: number,
  zone: string,
  cache: Map<string, CachedEventLines>,
  killable: boolean,
  armed: boolean,
  highlightCode?: HighlightCode | undefined,
  codeCache?: Map<string, CachedCodeLines> | undefined,
): DetailLayout {
  let sections: Section[];
  let eventAt: Map<string, number>;
  if (row instanceof AgentTaskRow) {
    const events_ = eventLines(events, expanded, selected, width, theme, zone, cache);
    sections = [
      { name: "Agent", lines: agentFields(row, theme, zone).map(fieldLine) },
      ...errorSection(row, width),
      {
        name: "Task",
        lines: row.task === undefined ? [] : taskLines(row.task, width),
      },
      { name: "Events", lines: events_.lines },
    ];
    // Map each event's line to its body position; `Events` is the last section.
    const offset = sectionsToLines(sections).length - events_.lines.length;
    eventAt = new Map([...events_.at].map(([key, index]) => [key, index + offset]));
  } else {
    eventAt = new Map();
    sections = [
      {
        name: row.kind === "bash" ? "Bash" : "Script",
        lines: scriptFields(row, theme, zone).map(fieldLine),
      },
      ...(row instanceof BashTaskRow ? [commandSection(row, width)] : []),
      ...(row instanceof ScriptTaskRow && row.code !== ""
        ? [codeSection(row, width, highlightCode, codeCache)]
        : []),
      {
        name: "Output",
        lines: row.progress.map((entry) => plainText(entry.line)),
      },
    ];
  }
  const title = `Task ${row.taskId} · ${row.kind} · ${theme.fg(
    STATUS_COLOR[row.status],
    row.status,
  )} · ${theme.fg("muted", row.elapsedText(now))}`;
  return {
    title,
    hint: detailsHint(row, killable, armed),
    lines: sectionsToLines(sections),
    eventLines: eventAt,
  };
}

export interface DetailsPageArgs extends PageArgs {
  row: TaskRow;
  events?: readonly SessionEvent[] | undefined;
  expanded?: ReadonlyMap<string, boolean> | undefined;
  selected?: string | undefined;
  scroll?: number | undefined;
  /** Whether the kill key applies to `row` (Section 4.4); absent means it does not. */
  killable?: boolean | undefined;
  /** Whether the kill key is armed (Section 4.4). */
  armed?: boolean | undefined;
  /** Syntax highlighting of a `script` row's `Code` section (Section 4.2); absent leaves the lines plain. */
  highlightCode?: HighlightCode | undefined;
}

/** Details page of one task row (Sections 4.1, 4.2), exactly `height` lines. */
export function renderDetails(args: DetailsPageArgs): string[] {
  const layout = buildDetails(
    args.row,
    args.events ?? [],
    args.expanded ?? new Map(),
    args.selected,
    args.theme,
    args.width,
    args.now,
    args.zone ?? "UTC",
    new Map(),
    args.killable === true,
    args.armed === true,
    args.highlightCode,
  );
  return pageView(
    layout.title,
    layout.lines,
    layout.hint,
    args.height,
    args.width,
    args.scroll ?? 0,
  );
}

export interface TaskBrowserOptions {
  registry: TaskRegistry;
  /** The local zone of billing.md Section 5, read once by the extension instance. */
  zone: string;
  now?: (() => number) | undefined;
  height?: (() => number) | undefined;
  readSession?: ((path: string) => string | undefined) | undefined;
  theme?: BrowserTheme | undefined;
  /** Syntax highlighting of a `script` row's `Code` section (Section 4.2); absent leaves the lines plain. */
  highlightCode?: HighlightCode | undefined;
}

/**
 * Task browser state machine (Sections 3-4): owns page, selection, expansion,
 * and scroll; the caller feeds registry changes and the refresh timer through
 * `refresh`, closes on the shortcut, and renders on demand.
 */
export class TaskBrowserState {
  private readonly registry: TaskRegistry;
  private readonly zone: string;
  private readonly clockNow: () => number;
  private readonly getHeight: () => number;
  private readonly readSessionFile: (path: string) => string | undefined;
  private readonly theme: BrowserTheme;

  private page: "list" | "details" = "list";
  /** `all` at every open, kept across a details visit (Section 3). */
  private filter: ListFilter = "all";
  private entries: ListEntry[] = [];
  private counts = { running: 0, total: 0 };
  private selectedId: string | undefined;
  private selectedIndex = 0;
  private listScroll = 0;

  private detail: TaskRow | undefined;
  private events: SessionEvent[] = [];
  private expanded = new Map<string, boolean>();
  private selectedEvent: string | undefined;
  private tail = true;
  private bodyScroll = 0;
  private stick = true;
  private settledRead = false;
  /** Whether the kill key is armed (Section 4.4). */
  private armed = false;
  private width = 80;
  private eventCache = new Map<string, CachedEventLines>();
  private codeCache = new Map<string, CachedCodeLines>();
  private readonly highlightCode: HighlightCode | undefined;
  private readonly reader = new SessionEventReader();

  constructor(options: TaskBrowserOptions) {
    this.registry = options.registry;
    this.zone = options.zone;
    this.clockNow = options.now ?? Date.now;
    this.getHeight = options.height ?? (() => 24);
    this.readSessionFile = options.readSession ?? (() => void 0);
    this.theme = options.theme ?? identityTheme;
    this.highlightCode = options.highlightCode;
    this.syncList();
    this.select(this.entries.length - 1);
  }

  /** Registry change (Sections 2, 4.3): re-sync the content; read only at the row's settlement. */
  refresh(): void {
    this.syncList();
    if (this.page !== "details") return;
    // Arming ends when the shown row settles (Section 4.4).
    if (this.killTarget() === undefined) this.armed = false;
    this.settlementRead();
  }

  /** 1000 ms refresh tick (Section 2): re-read the session file only while the row is `running`. */
  tick(): void {
    const row = this.detail;
    if (this.page !== "details" || !(row instanceof AgentTaskRow)) return;
    if (row.status !== "running") return;
    this.readEvents(false);
  }

  /** Whether the task tree has a running task (Section 2 refresh-timer rule). */
  hasRunning(): boolean {
    return hasRunningTask(this.registry);
  }

  handleKey(data: string): "close" | undefined {
    if (this.page === "list") {
      this.armed = false;
      return this.keyList(data);
    }
    // The kill key of every details page (Section 4.4).
    if (matchesKey(data, KILL_KEY)) {
      this.pressKill();
      return undefined;
    }
    // Any other key disarms the kill key and is handled per its own rule (Section 4.4).
    this.armed = false;
    if (this.detail instanceof AgentTaskRow) this.keyAgent(data);
    else this.keyScript(data);
    return undefined;
  }

  /**
   * The shown row while the kill key applies to it (Section 4.4): `running`, with a registry
   * that holds it reachable from the browser's registry through the task tree.
   */
  private killTarget(): { registry: TaskRegistry; row: TaskRow } | undefined {
    const row = this.detail;
    if (!row) return undefined;
    const registry = killHolder(this.registry, row);
    return registry === undefined ? undefined : { registry, row };
  }

  /** First press arms, the next cancels in the holding registry, any other row does nothing (Section 4.4). */
  private pressKill(): void {
    const target = this.killTarget();
    if (!target) {
      this.armed = false;
      return;
    }
    if (!this.armed) {
      this.armed = true;
      return;
    }
    this.armed = false;
    killFromBrowser(target.registry, target.row);
  }

  render(width: number): string[] {
    this.width = width;
    const height = this.getHeight();
    const now = this.clockNow();
    if (this.page === "list" || !this.detail) {
      this.syncList();
      return renderList({
        entries: this.entries,
        counts: this.counts,
        filter: this.filter,
        selected: this.selectedIndex,
        scroll: this.listScroll,
        now,
        width,
        height,
        theme: this.theme,
        zone: this.zone,
      });
    }
    const row = this.detail;
    if (!(row instanceof AgentTaskRow)) this.syncScript();
    const layout = buildDetails(
      row,
      this.events,
      this.expanded,
      this.selectedEvent,
      this.theme,
      width,
      now,
      this.zone,
      this.eventCache,
      this.killTarget() !== undefined,
      this.armed,
      this.highlightCode,
      this.codeCache,
    );
    this.bodyScroll = Math.max(
      0,
      Math.min(this.bodyScroll, Math.max(0, layout.lines.length - this.bodyHeight())),
    );
    return pageView(layout.title, layout.lines, layout.hint, height, width, this.bodyScroll);
  }

  private bodyHeight(): number {
    return Math.max(0, this.getHeight() - 2);
  }

  private syncList(): void {
    this.entries = listEntries(this.registry, this.filter);
    this.counts = treeCounts(this.registry);
    const count = this.entries.length;
    if (count === 0) {
      this.selectedId = undefined;
      this.selectedIndex = 0;
      this.listScroll = 0;
      return;
    }
    const found =
      this.selectedId === undefined
        ? -1
        : this.entries.findIndex((entry) => entry.row.taskId === this.selectedId);
    // With no previous selection, the content became non-empty: select the last row (Section 3).
    const index =
      found >= 0
        ? found
        : this.selectedId === undefined
          ? count - 1
          : Math.min(this.selectedIndex, count - 1);
    this.selectedIndex = Math.max(0, index);
    this.selectedId = this.entries[this.selectedIndex]?.row.taskId;
    this.keepSelectedVisible();
  }

  private keepSelectedVisible(): void {
    const view = this.bodyHeight();
    if (this.entries.length === 0 || view <= 0) {
      this.listScroll = 0;
      return;
    }
    if (this.selectedIndex < this.listScroll) this.listScroll = this.selectedIndex;
    else if (this.selectedIndex >= this.listScroll + view)
      this.listScroll = this.selectedIndex - view + 1;
    this.listScroll = Math.max(0, Math.min(this.listScroll, this.entries.length - view));
  }

  private select(index: number): void {
    const count = this.entries.length;
    if (count === 0) return;
    this.selectedIndex = Math.max(0, Math.min(index, count - 1));
    this.selectedId = this.entries[this.selectedIndex]?.row.taskId;
    this.keepSelectedVisible();
  }

  private keyList(data: string): "close" | undefined {
    const view = Math.max(1, this.bodyHeight());
    const last = this.entries.length - 1;
    if (matchesKey(data, "up") || matchesKey(data, "k")) this.select(this.selectedIndex - 1);
    else if (matchesKey(data, "down") || matchesKey(data, "j")) this.select(this.selectedIndex + 1);
    else if (matchesKey(data, "pageUp")) this.select(this.selectedIndex - view);
    else if (matchesKey(data, "pageDown")) this.select(this.selectedIndex + view);
    else if (isTop(data)) this.select(0);
    else if (isBottom(data)) this.select(last);
    else if (matchesKey(data, "f")) this.switchFilter();
    else if (matchesKey(data, "right")) this.openDetails();
    else if (matchesKey(data, "enter")) this.openDetails();
    else if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "left"))
      return "close";
    return undefined;
  }

  /** Switch the filter between `all` and `running`; the selection follows its taskId (Section 3). */
  private switchFilter(): void {
    this.filter = this.filter === "all" ? "running" : "all";
    this.syncList();
  }

  private openDetails(): void {
    const entry = this.entries[this.selectedIndex];
    if (!entry) return;
    this.page = "details";
    this.detail = entry.row;
    this.events = [];
    this.expanded = new Map();
    this.selectedEvent = undefined;
    this.tail = true;
    this.bodyScroll = 0;
    this.stick = true;
    this.settledRead = false;
    this.armed = false;
    this.resetSession();
    if (entry.row instanceof AgentTaskRow) {
      this.readEvents(entry.row.status !== "running");
      this.settledRead = entry.row.status !== "running";
    }
  }

  /** Read once when the open details row settles; every other registry change is a sync only. */
  private settlementRead(): void {
    const row = this.detail;
    if (!(row instanceof AgentTaskRow) || row.status === "running" || this.settledRead) return;
    this.settledRead = true;
    this.readEvents(true);
  }

  private resetSession(): void {
    this.reader.reset();
    this.eventCache = new Map();
  }

  /**
   * Read the session file through the shared reader (Section 4.3). `final` also parses a
   * trailing line without a newline.
   */
  private readEvents(final: boolean): void {
    const row = this.detail;
    if (!(row instanceof AgentTaskRow)) return;
    let text: string | undefined;
    if (row.sessionPath !== undefined) {
      try {
        text = this.readSessionFile(row.sessionPath);
      } catch {
        text = undefined;
      }
    }
    const step = this.reader.next(text, final);
    if (step.restarted) {
      this.eventCache = new Map();
      this.events = [];
      this.selectedEvent = undefined;
      this.tail = true;
    }
    if (step.added.length > 0) this.events = [...this.events, ...step.added];
    if (step.restarted || step.added.length > 0) this.selectAfterAppend();
  }

  /** Selection after a read: follow the last event while `tail`, never move it otherwise. */
  private selectAfterAppend(): void {
    const previous = this.selectedEvent;
    if (this.events.length === 0) {
      this.selectedEvent = undefined;
      this.tail = true;
      return;
    }
    const present = previous !== undefined && this.events.some((event) => event.key === previous);
    if (this.tail || !present) {
      this.selectedEvent = this.events[this.events.length - 1]?.key;
      this.tail = true;
    }
    // Move the scroll only when the selection changes (Section 4.1).
    if (this.selectedEvent !== previous) this.keepEventVisible();
  }

  private back(): void {
    this.page = "list";
    this.detail = undefined;
    this.events = [];
    this.expanded = new Map();
    this.selectedEvent = undefined;
    this.tail = true;
    this.bodyScroll = 0;
    this.stick = true;
    this.armed = false;
    this.syncList();
  }

  private eventIndex(): number {
    if (this.selectedEvent === undefined) return -1;
    return this.events.findIndex((event) => event.key === this.selectedEvent);
  }

  private selectEvent(index: number): void {
    const count = this.events.length;
    if (count === 0) return;
    const clamped = Math.max(0, Math.min(index, count - 1));
    const event = this.events[clamped];
    if (!event) return;
    this.selectedEvent = event.key;
    this.tail = clamped === count - 1;
    this.keepEventVisible();
  }

  private keyAgent(data: string): void {
    const view = Math.max(1, this.bodyHeight());
    if (this.events.length === 0) {
      // No session event: the Section 4.2 keys scroll the body.
      if (matchesKey(data, "up") || matchesKey(data, "k")) this.scrollBody(-1);
      else if (matchesKey(data, "down") || matchesKey(data, "j")) this.scrollBody(1);
      else if (matchesKey(data, "pageUp")) this.scrollBody(-view);
      else if (matchesKey(data, "pageDown")) this.scrollBody(view);
      else if (isTop(data)) this.bodyScroll = 0;
      else if (isBottom(data)) this.bodyScroll = this.maxScroll();
      else if (
        matchesKey(data, "escape") ||
        matchesKey(data, "backspace") ||
        matchesKey(data, "q") ||
        matchesKey(data, "left")
      )
        this.back();
      return;
    }
    const index = this.eventIndex();
    const last = this.events.length - 1;
    const open = this.selectedEvent !== undefined && this.expanded.get(this.selectedEvent) === true;
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      const span = this.eventSpan();
      if (span && span.first < this.bodyScroll) this.scrollBody(-1);
      else if (index > 0) this.selectEvent(index - 1);
      else this.scrollBody(-1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      const span = this.eventSpan();
      if (span && span.last >= this.bodyScroll + this.bodyHeight()) this.scrollBody(1);
      else if (index >= 0 && index < last) this.selectEvent(index + 1);
    } else if (matchesKey(data, "pageUp")) {
      this.moveSelectionByLines(-view);
    } else if (matchesKey(data, "pageDown")) {
      this.moveSelectionByLines(view);
    } else if (isTop(data)) {
      this.selectEvent(0);
      this.bodyScroll = 0;
    } else if (isBottom(data)) {
      this.selectEvent(last);
    } else if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      if (this.selectedEvent !== undefined) this.setExpanded(this.selectedEvent, !open);
    } else if (matchesKey(data, "right")) {
      if (this.selectedEvent !== undefined) this.setExpanded(this.selectedEvent, true);
    } else if (matchesKey(data, "left")) {
      this.back();
    } else if (matchesKey(data, "e")) {
      for (const event of this.events) this.expanded.set(event.key, true);
      this.keepEventVisible();
    } else if (matchesKey(data, "c")) {
      for (const event of this.events) this.expanded.set(event.key, false);
      this.keepEventVisible();
    } else if (
      matchesKey(data, "escape") ||
      matchesKey(data, "backspace") ||
      matchesKey(data, "q")
    ) {
      this.back();
    }
  }

  /** Move by body height in lines: the last event whose header line is at or before the target. */
  private moveSelectionByLines(delta: number): void {
    if (this.selectedEvent === undefined) return;
    const layout = this.buildDetail();
    const line = layout.eventLines.get(this.selectedEvent);
    const first = this.events[0]?.key;
    if (line === undefined || first === undefined) return;
    const target = line + delta;
    let chosen = first;
    for (const [key, at] of layout.eventLines) if (at <= target) chosen = key;
    this.selectedEvent = chosen;
    this.tail = chosen === this.events[this.events.length - 1]?.key;
    this.keepEventVisible(layout);
  }

  private setExpanded(key: string, value: boolean): void {
    this.expanded.set(key, value);
    this.keepEventVisible();
  }

  private buildDetail(cache = this.eventCache): DetailLayout {
    const row = this.detail;
    if (!row) return { title: "", hint: "", lines: [], eventLines: new Map() };
    return buildDetails(
      row,
      this.events,
      this.expanded,
      this.selectedEvent,
      this.theme,
      this.width,
      this.clockNow(),
      this.zone,
      cache,
      this.killTarget() !== undefined,
      this.armed,
      this.highlightCode,
      this.codeCache,
    );
  }

  private maxScroll(): number {
    return Math.max(0, this.buildDetail().lines.length - this.bodyHeight());
  }

  private scrollBody(delta: number): void {
    this.bodyScroll = Math.max(0, Math.min(this.bodyScroll + delta, this.maxScroll()));
  }

  /** Body line indexes of the selected event: its line and its last expanded content line. */
  private eventSpan(layout = this.buildDetail()): { first: number; last: number } | undefined {
    if (this.selectedEvent === undefined) return undefined;
    const first = layout.eventLines.get(this.selectedEvent);
    if (first === undefined) return undefined;
    let last = layout.lines.length - 1;
    for (const at of layout.eventLines.values()) if (at > first && at - 1 < last) last = at - 1;
    return { first, last };
  }

  /** Scrolls the least needed to show the selected event's line and what fits of its content. */
  private keepEventVisible(layout = this.buildDetail()): void {
    const span = this.eventSpan(layout);
    const view = this.bodyHeight();
    if (!span || view <= 0) return;
    if (span.last >= this.bodyScroll + view) this.bodyScroll = span.last - view + 1;
    if (span.first < this.bodyScroll) this.bodyScroll = span.first;
    this.bodyScroll = Math.max(
      0,
      Math.min(this.bodyScroll, Math.max(0, layout.lines.length - view)),
    );
  }

  private syncScript(): void {
    if (this.stick) this.bodyScroll = this.maxScroll();
  }

  private setScriptScroll(value: number): void {
    const max = this.maxScroll();
    this.bodyScroll = Math.max(0, Math.min(value, max));
    this.stick = this.bodyScroll >= max;
  }

  private keyScript(data: string): void {
    const view = Math.max(1, this.bodyHeight());
    this.syncScript();
    if (matchesKey(data, "up") || matchesKey(data, "k")) this.setScriptScroll(this.bodyScroll - 1);
    else if (matchesKey(data, "down") || matchesKey(data, "j"))
      this.setScriptScroll(this.bodyScroll + 1);
    else if (matchesKey(data, "pageUp")) this.setScriptScroll(this.bodyScroll - view);
    else if (matchesKey(data, "pageDown")) this.setScriptScroll(this.bodyScroll + view);
    else if (isTop(data)) this.setScriptScroll(0);
    else if (isBottom(data)) this.setScriptScroll(this.maxScroll());
    else if (
      matchesKey(data, "escape") ||
      matchesKey(data, "left") ||
      matchesKey(data, "backspace") ||
      matchesKey(data, "q")
    )
      this.back();
  }
}

/** The TUI surface the overlay needs. */
export interface TaskBrowserTui {
  requestRender(): void;
  terminal: { rows: number };
}

export interface TaskBrowserOverlayOptions {
  registry: TaskRegistry;
  tui: TaskBrowserTui;
  theme: BrowserTheme;
  shortcut: KeyId;
  /** The local zone of billing.md Section 5, read once by the extension instance. */
  zone: string;
  readSession: (path: string) => string | undefined;
  /** Syntax highlighting of a `script` row's `Code` section (Section 4.2); absent leaves the lines plain. */
  highlightCode?: HighlightCode | undefined;
  done: () => void;
  /** Called once when the overlay is disposed, even when `done` is never called. */
  onDispose?: (() => void) | undefined;
  /**
   * Called with the message of an error thrown by the browser's refresh or its timer tick. The
   * overlay keeps running: those callbacks run in a microtask and a timer, where a throw would be
   * an unhandled exception, and execution MUST NOT depend on the browser (task-browser.md Section 1).
   */
  onError?: ((message: string) => void) | undefined;
}

/**
 * Overlay component (task-browser.md Section 1): consumes all input; the
 * shortcut closes it; the 1000 ms timer runs only while a task is running.
 */
export class TaskBrowserOverlay {
  private readonly state: TaskBrowserState;
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private pending = false;
  /** Whether this browser has already reported a failure (Section 1). */
  private reported = false;

  private readonly options: TaskBrowserOverlayOptions;

  constructor(options: TaskBrowserOverlayOptions) {
    this.options = options;
    this.state = new TaskBrowserState({
      registry: options.registry,
      zone: options.zone,
      height: () => options.tui.terminal.rows,
      readSession: options.readSession,
      theme: options.theme,
      highlightCode: options.highlightCode,
    });
    this.unsubscribe = options.registry.subscribe(() => this.onChange());
    this.syncTimer();
  }

  render(width: number): string[] {
    // Section 1: a browser failure is reported, never thrown into the host TUI;
    // the page renders empty for that frame and the next one may recover.
    try {
      return this.state.render(width);
    } catch (error) {
      this.report(error);
      return [];
    }
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, this.options.shortcut) || this.state.handleKey(data) === "close") {
      this.close();
      return;
    }
    this.options.tui.requestRender();
  }

  /** Stop the timer and subscription; idempotent. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe();
    this.options.onDispose?.();
  }

  close(): void {
    if (this.closed) return;
    this.dispose();
    this.options.done();
  }

  private onChange(): void {
    if (this.closed || this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (this.closed) return;
      this.refresh();
    });
  }

  private refresh(): void {
    try {
      this.state.refresh();
      this.syncTimer();
      this.options.tui.requestRender();
    } catch (error) {
      this.report(error);
    }
  }

  /** 1000 ms tick (Section 2): advance durations and re-read a running row's session file. */
  private onTick(): void {
    try {
      this.state.tick();
      this.syncTimer();
      this.options.tui.requestRender();
    } catch (error) {
      this.report(error);
    }
  }

  /**
   * A browser failure never reaches the user as an unhandled exception, nor goes unreported:
   * one report per opened browser (Section 1), as the tick repeats a lasting failure.
   */
  private report(error: unknown): void {
    if (this.reported) return;
    this.reported = true;
    this.options.onError?.(`pi-dent: task browser: ${errorMessage(error)}`);
  }

  private syncTimer(): void {
    const running = this.state.hasRunning();
    if (running && !this.timer) {
      this.timer = setInterval(() => this.onTick(), 1000);
      this.timer.unref?.();
    } else if (!running && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
