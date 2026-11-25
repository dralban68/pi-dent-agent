import type { TaskRegistry } from "./registry.ts";
import type { LedgerLink } from "./task-ledger-wiring.ts";
import type { UsageSum } from "./usage.ts";
import { shortenSessionDir } from "./util.ts";

/**
 * Task rows per specs/task-registry.md Section 2: common fields on the
 * abstract base, kind-specific fields on one subclass per task kind; each kind
 * owns its `<detail>` segment of the task tree widget line (task.md Section 4).
 */

export type TaskKind = "agent" | "script" | "bash";
export type TaskStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type TerminalStatus = Exclude<TaskStatus, "running">;
/** What `settle` may produce: `interrupted` is set only by a rebuild, never by `settle` (Section 2). */
export type SettleStatus = "completed" | "failed" | "cancelled";

/** Theme coloring of a rendered task line (task.md Section 4, task-browser.md Section 2). */
export interface TaskPaint {
  status(text: string, status: TaskStatus): string;
  orphan(text: string): string;
  elapsed(text: string): string;
  detail(text: string): string;
  /** `<time>`, the list page's leading segment (task-browser.md Section 3): the widget line has none. */
  time?: ((text: string) => string) | undefined;
}

const identityText = (text: string): string => text;

export const identityPaint: TaskPaint = {
  status: (text) => text,
  orphan: (text) => text,
  elapsed: (text) => text,
  detail: (text) => text,
};

/** `<elapsed>` per task.md Section 4: `<s>s`, then `<m>m<ss>s`, then `<h>h<mm>m`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m`;
}

// CSI, OSC (BEL or ST terminated), then other two-byte ESC sequences.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/** Text with ANSI escape sequences and control characters removed. */
export function plainText(text: string): string {
  return text.replace(ANSI, "").replace(CONTROL, "");
}

// Control characters other than the tab and the line breaks (\t, \n, \r).
// eslint-disable-next-line no-control-regex
const CONTROL_KEEPING_BREAKS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/**
 * Text with ANSI escape sequences and control characters removed, except line breaks and
 * tabs (task.md Section 4.2).
 */
export function feedText(text: string): string {
  return text.replace(ANSI, "").replace(CONTROL_KEEPING_BREAKS, "");
}

// Control characters other than the tab (\t) and the line feed: the tool card keeps a tab, which
// indents source and output, and drops the rest, a carriage return included.
// eslint-disable-next-line no-control-regex
const CONTROL_KEEPING_TABS_AND_BREAKS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Text with ANSI escape sequences and control characters removed, except tabs and line feeds
 * (tool-card.md Section 1).
 */
export function cardText(value: string): string {
  return value.replace(ANSI, "").replace(CONTROL_KEEPING_TABS_AND_BREAKS, "");
}

/** `<label>` per task.md Section 4: first line, ANSI escapes and control characters removed. */
export function labelText(label: string): string {
  return plainText(label.split(/\r?\n/, 1)[0] ?? "");
}

/** The display label for the terminal: the agent directory as `$PI_DENT_SESSION_DIR` (agent-tool.md Section 4.2). */
export function shownLabel(label: string): string {
  return shortenSessionDir(labelText(label));
}

export interface TaskRowInit {
  taskId: string;
  cohort: string;
  label: string;
  background: boolean;
  startedAt: number;
}

export abstract class TaskRow {
  abstract readonly kind: TaskKind;
  readonly taskId: string;
  readonly background: boolean;
  readonly cohort: string;
  label: string;
  status: TaskStatus = "running";
  /** Registration time, milliseconds since the Unix epoch. */
  readonly startedAt: number;
  /** Settlement time, milliseconds since the Unix epoch; present once settled. */
  settledAt?: number | undefined;
  /** Result file, set by the owning contract at settlement. */
  resultPath?: string | undefined;
  /** Progress projection entries, in append order; `at` is the append time (epoch ms). */
  progress: Array<{ at: number; line: string }> = [];
  /** Settled result text; present once settled. */
  result?: string | undefined;
  /** Completion notification consumed: born consumed for foreground rows (Section 5). */
  consumed: boolean;
  /** False at registration; true once adopted (Section 4). */
  orphan = false;
  /** False at registration; true once a cancel is a browser kill (Section 2). */
  browserKill = false;
  /** Cancellation handler, set by the owning contract; present while running. */
  cancel?: (() => void) | undefined;
  /** The row's ledger row (task-ledger.md Section 2.2); absent when it has none. */
  ledger?: LedgerLink | undefined;

  constructor(init: TaskRowInit) {
    this.taskId = init.taskId;
    this.cohort = init.cohort;
    this.label = init.label;
    this.background = init.background;
    this.startedAt = init.startedAt;
    this.consumed = !init.background;
  }

  /** Apply an `amend` (task-registry.md Section 3); returns whether a field changed. */
  apply(fields: { label?: string }): boolean {
    if (fields.label === undefined || fields.label === this.label) return false;
    this.label = fields.label;
    return true;
  }

  /** Kind-owned `<detail>` segment (task.md Section 4); empty when none. */
  protected abstract detail(): string;

  /** `<delivery>` (task.md Section 4). */
  get delivery(): "bg" | "fg" {
    return this.background ? "bg" : "fg";
  }

  /** `<detail>` with ANSI escape sequences and control characters removed. */
  displayDetail(): string {
    return plainText(this.detail());
  }

  /** Milliseconds `<elapsed>` counts: to `settledAt` once the row has one, else to `now`. */
  elapsedMs(now: number): number {
    return (this.settledAt ?? now) - this.startedAt;
  }

  /** `<elapsed>` (task.md Section 4). */
  elapsedText(now: number): string {
    return formatElapsed(this.elapsedMs(now));
  }

  /**
   * The one task line (task.md Section 4, task-browser.md Section 3). The caller supplies
   * `<prefix>`. Without `time` it is the widget line, with `<elapsed>` after `<status>`;
   * with the list page's `<time>` it is the list row, whose format puts `<time> · <elapsed>`
   * first. The paint carries the remaining differences: each surface's `<status>` colors,
   * and `<detail>`, which the list page leaves uncolored.
   */
  renderLine(now: number, paint: TaskPaint = identityPaint, time?: string): string {
    const elapsed = paint.elapsed(this.elapsedText(now));
    const orphan = this.orphan ? ` · ${paint.orphan("orphan")}` : "";
    const detail = this.displayDetail();
    const fields = `${this.taskId} · ${this.kind} · ${this.delivery}${orphan} · ${paint.status(
      this.status,
      this.status,
    )}`;
    const tail = `${detail === "" ? "" : `${paint.detail(detail)} · `}${shownLabel(this.label)}`;
    if (time === undefined) return `${fields} · ${elapsed} · ${tail}`;
    return `${(paint.time ?? identityText)(time)} · ${elapsed} · ${fields} · ${tail}`;
  }
}

export class AgentTaskRow extends TaskRow {
  readonly kind = "agent";
  /** Canonical serialization of the dispatch plan's model, set by the owning contract. */
  model?: string | undefined;
  /** Agent identity of the dispatch. */
  agent?: string | undefined;
  /** Task text of the dispatch. */
  task?: string | undefined;
  /** Session file of the current attempt's child session. */
  sessionPath?: string | undefined;
  /** Absolute path of the task record file; deleted when the row is consumed (task-record.md Section 2). */
  recordPath?: string | undefined;
  /** Usage sum of the dispatch (agent-tool.md Section 13); absent until its first assistant message ends. */
  usage?: UsageSum | undefined;
  /** Attached task registry (Section 6). */
  children?: TaskRegistry | undefined;

  override apply(fields: {
    label?: string;
    model?: string;
    agent?: string;
    sessionPath?: string;
    usage?: UsageSum;
  }): boolean {
    let changed = super.apply(fields);
    if (fields.usage !== undefined) {
      this.usage = fields.usage;
      changed = true;
    }
    for (const key of ["model", "agent", "sessionPath"] as const) {
      const value = fields[key];
      if (value !== undefined && value !== this[key]) {
        this[key] = value;
        changed = true;
      }
    }
    return changed;
  }

  protected detail(): string {
    return this.model ?? "";
  }
}

export class ScriptTaskRow extends TaskRow {
  readonly kind = "script";
  /** The script source of the call (task-registry.md Section 2); set by `register` and by the owning contract at source resolution. */
  code = "";

  protected detail(): string {
    return "";
  }
}

export class BashTaskRow extends TaskRow {
  readonly kind = "bash";
  /** The call's `command` text, unchanged (task-registry.md Section 2); set by `register`. */
  command = "";

  protected detail(): string {
    return "";
  }
}

/** Fields `amend` may replace on a row of type `R` (task-registry.md Section 3). */
export type TaskAmendment<R extends TaskRow> = Parameters<R["apply"]>[0];

export function createTaskRow(kind: "agent", init: TaskRowInit): AgentTaskRow;
export function createTaskRow(kind: "script", init: TaskRowInit): ScriptTaskRow;
export function createTaskRow(kind: "bash", init: TaskRowInit): BashTaskRow;
export function createTaskRow(kind: TaskKind, init: TaskRowInit): TaskRow;
export function createTaskRow(kind: TaskKind, init: TaskRowInit): TaskRow {
  if (kind === "agent") return new AgentTaskRow(init);
  return kind === "script" ? new ScriptTaskRow(init) : new BashTaskRow(init);
}
