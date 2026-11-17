import type { HostSession } from "./host.ts";
import { deleteRecord } from "./task-record.ts";
import {
  AgentTaskRow,
  BashTaskRow,
  createTaskRow,
  labelText,
  ScriptTaskRow,
  type SettleStatus,
  type TaskAmendment,
  type TaskKind,
  type TaskRow,
} from "./task-row.ts";
import { shortUuid, errorMessage } from "./util.ts";

/**
 * Extension-owned task registry per specs/task-registry.md: per-session store
 * of task rows, registration-order retention, single settlement, cohort
 * completion notification, interrupted rebuild notification, per-attempt
 * nesting, and recursive change events.
 */

export {
  AgentTaskRow,
  BashTaskRow,
  ScriptTaskRow,
  type SettleStatus,
  TaskRow,
  type TaskKind,
  type TaskStatus,
  type TerminalStatus,
} from "./task-row.ts";

export const SPILL_THRESHOLD = 8000;

/** Every issued taskId; adopted rows keep theirs, so uniqueness spans the task tree (Section 2). */
const issuedTaskIds = new Set<string>();

export const PROGRESS_CAP = 1000;

/** Registering into a task registry that is not live must fail the invocation (Section 1). */
export class RegistryNotLiveError extends Error {
  constructor() {
    super("task registry is not live: the owning session has ended");
    this.name = "RegistryNotLiveError";
  }
}

interface RegisterInput<K extends TaskKind> {
  kind: K;
  cohort: string;
  label: string;
  background: boolean;
  /** `agent` rows: the task text of the dispatch. */
  task?: string | undefined;
  /** `bash` rows: the call's `command` text, unchanged (task-registry.md Section 2). */
  command?: string | undefined;
  /** `script` rows: the call's script source (task-registry.md Section 2). */
  code?: string | undefined;
}

export class TaskRegistry {
  private readonly owned: TaskRow[] = [];
  private isLive = true;

  /** Registries that attach this one as `children`; the emit recursion follows it (Section 7). */
  private readonly parents = new Set<TaskRegistry>();
  /** The registry that attached this one as `children`; the adoption chain follows it (Section 4). */
  private adopter: TaskRegistry | undefined;
  private readonly notifiedCohorts = new Set<string>();
  /** Cohorts whose failed completion notification was already reported (Section 5). */
  private readonly reportedCohorts = new Set<string>();
  /** Whether the failed interrupted notification was already reported (Section 5). */
  private interruptedReported = false;
  private readonly listeners = new Set<() => void>();

  private readonly hostProvider: () => HostSession | null | undefined;
  private readonly nextTaskId: () => string;
  /** Reports a notification the host did not deliver to the boot window's UI (Section 5). */
  private readonly report?: ((message: string) => void) | undefined;

  /**
   * `nextTaskId` supplies the candidates a new row's `taskId` is drawn from: `shortUuid` by
   * default, a fake in a test that needs a collision (Section 2). `report` is the boot window's
   * diagnostic sink; a registry without one, a child session's, reports nothing.
   */
  constructor(
    hostProvider: () => HostSession | null | undefined,
    nextTaskId: () => string = shortUuid,
    report?: (message: string) => void,
  ) {
    this.hostProvider = hostProvider;
    this.nextTaskId = nextTaskId;
    this.report = report;
  }

  /** Whether the owning session is still current (Sections 1 and 4). */
  get live(): boolean {
    return this.isLive;
  }

  /** Rows in registration order, read-only. */
  get rows(): readonly TaskRow[] {
    return this.owned;
  }

  /**
   * Appends a `running` row with a fresh `taskId` and `startedAt` (Sections 2-3);
   * a late background joiner re-opens an already-notified cohort (Section 5).
   * Throws RegistryNotLiveError when the registry is not live (Section 1).
   */
  register(input: RegisterInput<"agent">): AgentTaskRow;
  register(input: RegisterInput<"script">): ScriptTaskRow;
  register(input: RegisterInput<"bash">): BashTaskRow;
  register(input: RegisterInput<TaskKind>): TaskRow {
    if (!this.isLive) throw new RegistryNotLiveError();
    if (input.background && this.notifiedCohorts.has(input.cohort)) {
      this.notifiedCohorts.delete(input.cohort);
    }
    // Foreground and pre-start rows are born consumed: the result already
    // reached (or returns to) the immediate caller.
    const row = createTaskRow(input.kind, {
      taskId: this.uniqueTaskId(),
      cohort: input.cohort,
      label: input.label,
      background: input.background,
      startedAt: Date.now(),
    });
    if (row instanceof AgentTaskRow) row.task = input.task;
    if (row instanceof BashTaskRow && input.command !== undefined) row.command = input.command;
    if (row instanceof ScriptTaskRow && input.code !== undefined) row.code = input.code;
    this.owned.push(row);
    this.emit();
    return row;
  }

  /** The row with the given taskId, or none (Section 3 `get`). */
  get(taskId: string): TaskRow | undefined {
    return this.owned.find((row) => row.taskId === taskId);
  }

  /** Every row in registration order (Section 3 `list`). */
  list(): TaskRow[] {
    return [...this.owned];
  }

  /**
   * Settle a row once; the first committed outcome is preserved; clears `cancel`
   * and `children` (Section 3). `interrupted` is set only by a rebuild, never
   * by `settle` (Section 2), so the status type admits only SettleStatus.
   */
  settle(
    row: TaskRow,
    outcome: {
      status: SettleStatus;
      result?: string | undefined;
      resultPath?: string | undefined;
    },
  ): void {
    const owner = this.holder(row);
    if (owner !== this) {
      owner.settle(row, outcome);
      return;
    }
    if (row.status !== "running") return;
    row.status = outcome.status;
    row.result = outcome.result;
    if (outcome.resultPath !== undefined) row.resultPath = outcome.resultPath;
    row.settledAt = Date.now();
    this.detachChildren(row);
    row.cancel = undefined;
    this.emit();
    this.notifyCohort(row.cohort);
  }

  /**
   * Send a cohort's completion notification, then consume the rows it lists, in that order
   * (Section 5): a notification no host accepted leaves the rows unconsumed and the cohort
   * unnotified, so its next notification lists them again, and is reported once for that cohort.
   */
  private notifyCohort(cohort: string): void {
    const notification = this.cohortNotification(cohort);
    if (notification === undefined) return;
    const delivery = this.send(notification.message);
    if (!delivery.delivered) {
      if (this.reportedCohorts.has(cohort)) return;
      this.reportedCohorts.add(cohort);
      this.reportNotDelivered(delivery.error);
      return;
    }
    this.notifiedCohorts.add(cohort);
    // Marked consumed without deleting the record: only `Task` read/kill and resume delete it
    // (task-record.md Section 2).
    for (const row of notification.rows) row.consumed = true;
  }

  /** Send `message` into the session's conversation; the failure when no host accepted it (Section 5). */
  private send(
    message: string | undefined,
  ): { delivered: true } | { delivered: false; error: unknown } {
    if (message === undefined) return { delivered: false, error: "no message to send" };
    const host = this.hostProvider();
    if (!host) return { delivered: false, error: "no live session for the notification" };
    try {
      host.notify(message);
      return { delivered: true };
    } catch (error) {
      // The host UI may be gone: the message is not delivered, and the rows stay unconsumed.
      return { delivered: false, error };
    }
  }

  /** Section 5: one warning through the boot window's UI, and nothing at all without one. */
  private reportNotDelivered(error: unknown): void {
    this.report?.(`task notification was not delivered: ${errorMessage(error)}`);
  }

  /** Replace `label` and kind-specific fields of a running row; a no-op on a settled row (Section 3). */
  amend<R extends TaskRow>(row: R, fields: TaskAmendment<R>): void {
    const owner = this.holder(row);
    if (owner !== this) {
      owner.amend(row, fields);
      return;
    }
    if (row.status !== "running") return;
    const changed = row.apply(fields);
    if (changed) this.emit();
  }

  /** Append one progress line, keeping the latest 1000; a no-op on a settled row (Section 3). */
  progress(row: TaskRow, line: string): void {
    const owner = this.holder(row);
    if (owner !== this) {
      owner.progress(row, line);
      return;
    }
    if (row.status !== "running") return;
    row.progress.push({ at: Date.now(), line });
    if (row.progress.length > PROGRESS_CAP)
      row.progress.splice(0, row.progress.length - PROGRESS_CAP);
    this.emit();
  }

  /**
   * Mark the completion notification as consumed (Section 5). A consumed
   * `agent` row's task record is deleted, and a delete failure must never
   * throw out of consume (task-record.md Section 2). A running row keeps its
   * record: the task is still live and settles later.
   */
  consume(row: TaskRow): void {
    const changed = !row.consumed;
    row.consumed = true;
    if (row instanceof AgentTaskRow && row.recordPath !== undefined && row.status !== "running") {
      try {
        deleteRecord(row.recordPath);
      } catch {
        // The record may be undeletable; consumption stands (task-record.md Section 2).
      }
    }
    // Consumption can remove a row from a widget's content (task.md Section 4).
    if (changed) this.emit();
  }

  /**
   * Set `browserKill` when the cancel is a browser kill, then invoke the row's cancellation
   * handler while running; a no-op on a settled row (Section 3).
   */
  cancel(row: TaskRow, browserKill = false): void {
    if (row.status !== "running") return;
    if (browserKill) row.browserKill = true;
    row.cancel?.();
  }

  /** Invoke `cancel` on every running row (Section 3). */
  cancelAll(): void {
    for (const row of this.owned) this.cancel(row);
  }

  /** Set or replace `children` of a running `agent` row (Sections 3 and 6). */
  attach(row: AgentTaskRow, children: TaskRegistry): void {
    const owner = this.holder(row);
    if (owner !== this) {
      owner.attach(row, children);
      return;
    }
    if (row.status !== "running") return;
    if (row.children === children) return;
    this.detachChildren(row);
    row.children = children;
    children.parents.add(this);
    children.adopter = this;
    this.emit();
  }

  /** Whether the registry currently holding `row` is live (agent-tool.md Section 8). */
  holderLive(row: TaskRow): boolean {
    return this.holder(row).isLive;
  }

  /**
   * Stop being live; adopt every running and every unconsumed row into the nearest live
   * registry in the attach chain, else `cancelAll` (Section 4).
   */
  end(): void {
    this.isLive = false;
    const target = this.liveAdopter();
    if (!target) {
      this.cancelAll();
      return;
    }
    const adopted = this.owned.filter((row) => row.status === "running" || !row.consumed);
    if (adopted.length === 0) return;
    let kept = 0;
    for (const row of this.owned) {
      if (row.status === "running" || !row.consumed) continue;
      this.owned[kept++] = row;
    }
    this.owned.length = kept;
    for (const row of adopted) {
      row.orphan = true;
      target.owned.push(row);
      // The adopter becomes the attacher of the row's children (Section 4).
      const children = row instanceof AgentTaskRow ? row.children : undefined;
      if (children) {
        children.parents.delete(this);
        children.parents.add(target);
        children.adopter = target;
      }
    }
    target.emit();
    // Adoption may leave an adopted cohort with no running row (Section 5).
    for (const cohort of new Set(adopted.map((row) => row.cohort))) target.notifyCohort(cohort);
  }

  /**
   * Insert pre-built rows restored from task records (task-record.md Section 3):
   * skip a row whose taskId a row of this registry already carries, reserve the
   * taskIds of the rest, append them in order with one change event each, then
   * send one interrupted notification for the inserted interrupted rows, which
   * is never consumed (Section 5). Rows an earlier rebuild inserted are neither
   * inserted nor listed again. Returns the inserted rows. A no-op on a registry
   * that is not live.
   */
  rebuild(rows: AgentTaskRow[]): AgentTaskRow[] {
    if (!this.isLive) return [];
    const inserted: AgentTaskRow[] = [];
    for (const row of rows) {
      if (this.owned.some((existing) => existing.taskId === row.taskId)) continue;
      issuedTaskIds.add(row.taskId);
      this.owned.push(row);
      inserted.push(row);
      this.emit();
    }
    const interrupted = inserted.filter((row) => row.status === "interrupted");
    if (interrupted.length === 0) return inserted;
    const delivery = this.send(
      [
        "Interrupted tasks (resume with Agent resume=<taskId>):",
        ...interrupted.map((row) => this.listLine(row)),
      ].join("\n"),
    );
    if (!delivery.delivered && !this.interruptedReported) {
      this.interruptedReported = true;
      this.reportNotDelivered(delivery.error);
    }
    return inserted;
  }

  /** Register a listener for registry changes (Section 7); returns the unsubscribe handle. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The `list` line format of task-tool.md Section 2.3, with the display label (task-registry.md Section 2). */
  listLine(row: TaskRow): string {
    return `${row.taskId} · ${row.status} · ${labelText(row.label)}`;
  }

  get runningCount(): number {
    return this.owned.filter((row) => row.status === "running").length;
  }

  /**
   * Exactly one completion notification per background cohort, after every task joined;
   * none from a registry that is not live (Section 5). Returns the message to send and the
   * rows it lists, which the sender consumes once the host accepted the message.
   */
  private cohortNotification(cohort: string): { message: string; rows: TaskRow[] } | undefined {
    if (!this.isLive) return undefined;
    const cohortRows = this.owned.filter((row) => row.cohort === cohort);
    if (cohortRows.length === 0 || cohortRows.some((row) => row.status === "running")) return;
    if (this.notifiedCohorts.has(cohort)) return;
    // Only completed, failed, or cancelled rows qualify; interrupted rows never
    // fire and are never consumed by the completion notification (Section 5).
    const unconsumed = cohortRows.filter(
      (row) =>
        row.background &&
        !row.consumed &&
        (row.status === "completed" || row.status === "failed" || row.status === "cancelled"),
    );
    if (unconsumed.length === 0) return;
    return {
      message: [
        "Background tasks settled:",
        ...unconsumed.map((row) =>
          row.browserKill && row.status === "cancelled"
            ? `${this.listLine(row)} · killed by the user from the task browser`
            : this.listLine(row),
        ),
      ].join("\n"),
      rows: unconsumed,
    };
  }

  /** A taskId no row of any registry of this process carries yet (Section 2). */
  private uniqueTaskId(): string {
    let taskId = this.nextTaskId();
    while (issuedTaskIds.has(taskId)) taskId = this.nextTaskId();
    issuedTaskIds.add(taskId);
    return taskId;
  }

  private detachChildren(row: TaskRow): void {
    if (!(row instanceof AgentTaskRow)) return;
    const children = row.children;
    if (!children) return;
    children.parents.delete(this);
    row.children = undefined;
  }

  /** The nearest live registry in the attach chain, or none (Section 4). */
  private liveAdopter(): TaskRegistry | undefined {
    for (let r: TaskRegistry | undefined = this.adopter; r; r = r.adopter) {
      if (r.isLive) return r;
    }
    return undefined;
  }

  /** The registry in the attach chain currently holding `row`; itself when local (Section 4). */
  private holder(row: TaskRow): TaskRegistry {
    if (this.owned.includes(row)) return this;
    for (let r = this.adopter; r; r = r.adopter) {
      if (r.owned.includes(row)) return r;
    }
    return this;
  }

  /**
   * Call every listener of this registry and of every attaching ancestor once
   * per change, after the change is applied; a throwing listener must not
   * affect the operation or other listeners (Section 7).
   */
  private emit(): void {
    if (!this.isLive) {
      const target = this.liveAdopter();
      if (target) {
        target.emit();
        return;
      }
    }
    const seen = new Set<TaskRegistry>();
    const walk = (registry: TaskRegistry): void => {
      if (seen.has(registry)) return;
      seen.add(registry);
      for (const listener of registry.listeners) {
        try {
          listener();
        } catch {
          // Isolated: the operation and other listeners are unaffected.
        }
      }
      for (const parent of registry.parents) walk(parent);
    };
    walk(this);
  }
}

/**
 * The cancellation path of `Task` `kill` (task-tool.md Section 2.2): invoke the
 * row's cancellation handler and consume the row, so the model's own kill is not
 * delivered to it. Settlement stays the owning contract's and asynchronous.
 */
export function killTask(registry: TaskRegistry, row: TaskRow): void {
  registry.cancel(row);
  registry.consume(row);
}

/**
 * The task browser's kill key (task-browser.md Section 4.4): the same cancel, in
 * the registry that holds the row, marked as a browser kill and not consumed, so
 * the settlement is delivered as any other settled task of its delivery mode is.
 */
export function killFromBrowser(registry: TaskRegistry, row: TaskRow): void {
  registry.cancel(row, true);
}
