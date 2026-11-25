/**
 * How the extension writes and reads the task ledger (specs/task-ledger.md): the ledger of the
 * extension instance, each task row's link to its ledger row, the parent row (Section 3.1), the
 * writes a task registry's changes make (Section 3.2), and the figures the `Task` and `Session`
 * tools show (task-tool.md Section 2.3, session-tool.md Section 2).
 *
 * Every write returns at once (task-ledger.md Section 5): nothing here waits on the ledger except
 * a surface's read.
 */

import type { TaskObserver, RegisterCall } from "./registry.ts";
import {
  sessionRowUsage,
  type LedgerResume,
  type LedgerRowFigures,
  type LedgerRowRef,
  type LedgerSessionEntry,
  type LedgerSessionHeader,
  type LedgerTaskAmend,
  type TaskLedger,
} from "./task-ledger.ts";
import { AgentTaskRow, type TaskRow } from "./task-row.ts";
import { isPlainObject } from "./util.ts";
import { formatUsage, type UsageSum } from "./usage.ts";

/** A task row's ledger row: the ledger it is in and how to find it (Section 2.2). */
export interface LedgerLink {
  readonly ledger: TaskLedger;
  /** The `row_id`, or for a rebuilt row the key of Section 4.2. */
  readonly ref: LedgerRowRef;
  /** `label`, `agent`, `model`, and `session_path` as last written (Section 3.2). */
  written: LedgerTaskAmend;
}

/** The extension instance's ledger, opened at its main session's first `session_start` (Section 1). */
export class LedgerHolder {
  ledger: TaskLedger | undefined;
}

/**
 * The nested calls of one session (Section 3.1, rule 1): the calling tool call of each running
 * nested call, as the host reports it, and the `Script` row each `Script` call registered.
 */
export class NestedCalls {
  private readonly callers = new Map<string, string>();
  private readonly scripts = new Map<string, TaskRow>();

  /** A tool execution started; `parentToolCallId` is set for a nested call. */
  started(toolCallId: string, parentToolCallId: string | undefined): void {
    if (parentToolCallId !== undefined) this.callers.set(toolCallId, parentToolCallId);
  }

  ended(toolCallId: string): void {
    this.callers.delete(toolCallId);
  }

  /** The `Script` row whose run made the call, through any nesting; none for a model's call. */
  scriptOf(toolCallId: string | undefined): TaskRow | undefined {
    if (toolCallId === undefined) return;
    for (let id = this.callers.get(toolCallId); id !== undefined; id = this.callers.get(id)) {
      const script = this.scripts.get(id);
      if (script !== undefined) return script;
    }
    return;
  }

  scriptRegistered(toolCallId: string, row: TaskRow): void {
    this.scripts.set(toolCallId, row);
  }

  /** A settled run makes no more nested calls. */
  scriptSettled(row: TaskRow): void {
    for (const [id, script] of this.scripts) if (script === row) this.scripts.delete(id);
  }
}

/** Where the rows of one session's task registries go (Sections 2.2 and 3.1). */
export interface LedgerScope {
  holder: LedgerHolder;
  /** The ledger session ID of the session (Section 2). */
  sessionId: () => string | undefined;
  /** The session's working directory. */
  cwd: () => string | undefined;
  /** For a child session, the row of the dispatch whose child session it is (rule 2). */
  parent?: TaskRow | undefined;
  calls: NestedCalls;
}

/** The scope of a child session of `parent`'s dispatch (rule 2): same ledger and ledger session ID. */
export function childScope(scope: LedgerScope, parent: TaskRow, cwd: () => string): LedgerScope {
  const sessionId = scope.sessionId();
  return {
    holder: scope.holder,
    sessionId: () => sessionId,
    cwd,
    parent,
    calls: new NestedCalls(),
  };
}

function rowIdOf(row: TaskRow | undefined): string | undefined {
  const ref = row?.ledger?.ref;
  return typeof ref === "string" ? ref : undefined;
}

/** The values an amend writes (Section 3.2); a script row keeps the tool log path it was given. */
function amendValues(row: TaskRow, sessionPath?: string): LedgerTaskAmend {
  if (row instanceof AgentTaskRow) {
    return { label: row.label, agent: row.agent, model: row.model, sessionPath: row.sessionPath };
  }
  return { label: row.label, sessionPath };
}

function sameValues(a: LedgerTaskAmend, b: LedgerTaskAmend): boolean {
  return (
    a.label === b.label &&
    a.agent === b.agent &&
    a.model === b.model &&
    a.sessionPath === b.sessionPath
  );
}

/** The writes of Section 3.2 that a task registry's `register`, `amend`, and `settle` make. */
export class LedgerTap implements TaskObserver {
  private readonly scope: LedgerScope;

  constructor(scope: LedgerScope) {
    this.scope = scope;
  }

  registered(row: TaskRow, call: RegisterCall): void {
    const { holder, calls } = this.scope;
    if (row.kind === "script" && call.toolCallId !== undefined) {
      calls.scriptRegistered(call.toolCallId, row);
    }
    const ledger = holder.ledger;
    const sessionId = this.scope.sessionId();
    const cwd = this.scope.cwd();
    // No ledger yet, or no session to file the row under: the row has no ledger row.
    if (ledger === undefined || sessionId === undefined || cwd === undefined) return;
    const parent = calls.scriptOf(call.toolCallId) ?? this.scope.parent;
    const values = amendValues(row);
    const rowId = ledger.insertTask({
      sessionId,
      taskId: row.taskId,
      parentRowId: rowIdOf(parent),
      fleetQuery: call.fleetQuery === true,
      kind: row.kind,
      background: row.background,
      cwd,
      agent: values.agent,
      label: values.label,
      model: values.model,
      startedAt: row.startedAt,
      sessionPath: values.sessionPath,
    });
    if (rowId !== undefined) row.ledger = { ledger, ref: rowId, written: values };
  }

  amended(row: TaskRow, fields: object): void {
    const link = row.ledger;
    if (link === undefined || typeof link.ref !== "string") return;
    if ("usage" in fields && row instanceof AgentTaskRow && row.usage !== undefined) {
      link.ledger.setTaskUsage(link.ref, row.usage);
    }
    const values = amendValues(row, link.written.sessionPath);
    if (sameValues(values, link.written)) return;
    link.written = values;
    link.ledger.amendTask(link.ref, values);
  }

  settled(row: TaskRow): void {
    this.scope.calls.scriptSettled(row);
    const link = row.ledger;
    if (link === undefined || typeof link.ref !== "string" || row.status === "running") return;
    link.ledger.settleTask(link.ref, {
      status: row.status,
      settledAt: row.settledAt ?? Date.now(),
      resultPath: row.resultPath,
    });
  }
}

/** The task's pre-start checks passed (Section 3.2): `cwd` is the working directory it runs in. */
export function ledgerDispatched(row: TaskRow, cwd: string, resume?: LedgerResume): void {
  const link = row.ledger;
  if (link === undefined || typeof link.ref !== "string") return;
  link.ledger.markDispatched(link.ref, { cwd, resume });
}

/** A `script` row's tool log was created (Section 3.2): its path is the row's `session_path`. */
export function ledgerToolLog(row: TaskRow, path: string): void {
  const link = row.ledger;
  if (link === undefined || typeof link.ref !== "string") return;
  link.written = { ...link.written, sessionPath: path };
  link.ledger.amendTask(link.ref, link.written);
}

// ---------------------------------------------------------------------------
// The ledger session row (Section 3.3)
// ---------------------------------------------------------------------------

/** The host's session entries and header, as the ledger session row reads them (Section 2.1). */
export interface HostSessionEntries {
  getEntries(): readonly unknown[];
  getHeader(): unknown;
}

function usageOf(value: unknown): LedgerSessionEntry["usage"] {
  if (!isPlainObject(value) || !isPlainObject(value.cost)) return;
  const { input, output, cacheRead, cacheWrite } = value;
  const total = value.cost.total;
  if (
    typeof input !== "number" ||
    typeof output !== "number" ||
    typeof cacheRead !== "number" ||
    typeof cacheWrite !== "number" ||
    typeof total !== "number"
  ) {
    return;
  }
  return { input, output, cacheRead, cacheWrite, cost: { total } };
}

function entryOf(value: unknown): LedgerSessionEntry | undefined {
  if (!isPlainObject(value) || typeof value.type !== "string") return;
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : undefined;
  const message = value.message;
  return {
    type: value.type,
    timestamp,
    usage: usageOf(value.usage),
    message:
      isPlainObject(message) && typeof message.role === "string"
        ? {
            role: message.role,
            toolName: typeof message.toolName === "string" ? message.toolName : undefined,
            usage: usageOf(message.usage),
          }
        : undefined,
  };
}

/**
 * The usage sum of the main session's ledger session row (Section 2.1); `ended` is the message
 * whose end the host is reporting, counted when the host has not saved it yet.
 */
export function hostSessionUsage(session: HostSessionEntries, ended?: unknown): UsageSum {
  const entries: LedgerSessionEntry[] = [];
  let saved = false;
  for (const raw of session.getEntries()) {
    if (isPlainObject(raw) && ended !== undefined && raw.message === ended) saved = true;
    const entry = entryOf(raw);
    if (entry !== undefined) entries.push(entry);
  }
  // The host reports a message's end before it saves the message (Section 3.3): count it as the
  // entry the host is about to append.
  if (ended !== undefined && !saved) {
    const entry = entryOf({ type: "message", timestamp: new Date().toISOString(), message: ended });
    if (entry !== undefined) entries.push(entry);
  }
  const header = session.getHeader();
  const read: LedgerSessionHeader | undefined = isPlainObject(header)
    ? {
        timestamp: typeof header.timestamp === "string" ? header.timestamp : undefined,
        parentSession: header.parentSession,
      }
    : undefined;
  return sessionRowUsage(entries, read);
}

// ---------------------------------------------------------------------------
// Surfaces (task-tool.md Section 2.3, session-tool.md Section 2)
// ---------------------------------------------------------------------------

/** The outcome of a surface's read of row figures. */
export type TaskFiguresRead =
  | { status: "ok"; figures: Map<TaskRow, LedgerRowFigures> }
  | { status: "unavailable" }
  | { status: "busy" };

/** One read of the figures of `rows`' ledger rows; a row without a ledger row is absent. */
export async function readTaskFigures(
  ledger: TaskLedger | undefined,
  rows: readonly TaskRow[],
): Promise<TaskFiguresRead> {
  if (ledger === undefined || ledger.unusableReason() !== undefined) {
    return { status: "unavailable" };
  }
  const byRef = new Map<LedgerRowRef, TaskRow>();
  for (const row of rows) if (row.ledger !== undefined) byRef.set(row.ledger.ref, row);
  const read = await ledger.readRowFigures([...byRef.keys()]);
  if (read.status !== "ok") return { status: read.status };
  const figures = new Map<TaskRow, LedgerRowFigures>();
  for (const [ref, value] of read.value) {
    const row = byRef.get(ref);
    if (row !== undefined) figures.set(row, value);
  }
  return { status: "ok", figures };
}

/** `<figures>` of a `Task` `list` line (task-tool.md Section 2.3). */
export function figuresText(
  row: TaskRow,
  read: TaskFiguresRead,
): { text: string; figures?: LedgerRowFigures | undefined } {
  if (read.status === "unavailable") return { text: "ledger unavailable" };
  if (read.status === "busy") return { text: "ledger busy" };
  const figures = read.figures.get(row);
  if (figures === undefined) return { text: "no ledger row" };
  const parts: string[] = [];
  if (row.kind === "agent") {
    const own = figures.own;
    parts.push(`${own.turns} ${own.turns === 1 ? "turn" : "turns"}`, `$${own.cost.toFixed(3)}`);
  }
  if (figures.descendants > 0) parts.push(`total $${figures.total.cost.toFixed(3)}`);
  return { text: parts.join(" · "), figures };
}

/** The `Session` tool's usage report (session-tool.md Section 2). */
export interface SessionUsageReport {
  ledger: "ok" | "unavailable" | "busy" | "missing";
  usage: { own: UsageSum; tasks: { count: number; usage: UsageSum }; total: UsageSum } | null;
}

/** Where a session's `Session` tool reads its figures: a child session names its dispatch's row. */
export interface SessionLedgerSource {
  holder: LedgerHolder;
  /** For a child session, the row of the dispatch whose child session it is. */
  row?: TaskRow | undefined;
}

/** One read of the session's usage figures (session-tool.md Section 2). */
export async function readSessionUsage(
  source: SessionLedgerSource,
  sessionId: string,
): Promise<SessionUsageReport> {
  const ledger = source.holder.ledger;
  if (ledger === undefined || ledger.unusableReason() !== undefined) {
    return { ledger: "unavailable", usage: null };
  }
  if (source.row === undefined) {
    const read = await ledger.readSessionFigures(sessionId);
    if (read.status !== "ok") return { ledger: read.status, usage: null };
    if (read.value === undefined) return { ledger: "missing", usage: null };
    const { own, agents, total } = read.value;
    return { ledger: "ok", usage: { own, tasks: agents, total } };
  }
  const ref = source.row.ledger?.ref;
  if (ref === undefined) return { ledger: "missing", usage: null };
  const read = await ledger.readRowFigures([ref]);
  if (read.status !== "ok") return { ledger: read.status, usage: null };
  const figures = read.value.get(ref);
  if (figures === undefined) return { ledger: "missing", usage: null };
  return {
    ledger: "ok",
    usage: { own: figures.own, tasks: figures.agents, total: figures.total },
  };
}

/** The usage lines of the `Session` tool's text (session-tool.md Section 2). */
export function sessionUsageLines(report: SessionUsageReport): string[] {
  const usage = report.usage;
  if (report.ledger !== "ok" || usage === null) {
    const state =
      report.ledger === "missing"
        ? "no ledger row"
        : report.ledger === "busy"
          ? "ledger busy"
          : "ledger unavailable";
    return [`usage: ${state}`];
  }
  const count = usage.tasks.count;
  return [
    "usage:",
    `own: ${formatUsage(usage.own)}`,
    `tasks: ${count} ${count === 1 ? "agent" : "agents"} · ${formatUsage(usage.tasks.usage)}`,
    `total: ${formatUsage(usage.total)}`,
  ];
}
