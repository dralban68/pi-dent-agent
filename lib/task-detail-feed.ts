import { feedsAnnounced, type FeedHost } from "./feeds.ts";
import { killFromBrowser, type TaskRegistry } from "./registry.ts";
import {
  agentFields,
  type DetailField,
  identityTheme,
  killHolder,
  listEntries,
  scriptFields,
  type SessionEvent,
  SessionEventReader,
} from "./task-browser.ts";
import type { FeedWidgetHost } from "./task-feed.ts";
import { AgentTaskRow, BashTaskRow, feedText, shownLabel, type TaskRow } from "./task-row.ts";

/**
 * Task detail feed (specs/task.md Section 4.2): the details page of the watched task as the
 * one-line JSON widget `pi-dent-task` for an RPC client, and the `tasks` verbs that drive it
 * (specs/slash-commands.md Section 3). Host values are parameters: the feed reads the session
 * file and runs its timer through the options it is given.
 */

export const TASK_DETAIL_WIDGET_ID = "pi-dent-task";
/** The session file re-read interval of a running agent row (task-browser.md Section 4.3). */
export const TASK_DETAIL_INTERVAL_MS = 1000;
const MAX_OUTPUT_LINES = 500;
const MAX_EVENTS = 200;
const MAX_CONTENT_LINES = 200;

/** One `events` entry of the payload (task.md Section 4.2). */
export interface TaskDetailEvent {
  time: string;
  kind: string;
  summary: string;
  content: string;
  error: boolean;
}

/** The payload of `pi-dent-task` (task.md Section 4.2); absent fields are omitted, not null. */
export interface TaskDetailPayload {
  piDent: "task/1";
  taskId: string;
  found: boolean;
  kind?: string;
  background?: boolean;
  orphan?: boolean;
  status?: string;
  startedAt?: number;
  settledAt?: number;
  label?: string;
  killable?: boolean;
  fields?: Array<{ name: string; value: string }>;
  error?: string;
  task?: string;
  command?: string;
  output?: string[];
  events?: TaskDetailEvent[];
}

/** What one payload is built from: the watched row, when found, and the session's state. */
export interface TaskDetailSource {
  taskId: string;
  row: TaskRow | undefined;
  /** Whether the kill key applies to `row` (task-browser.md Section 4.4). */
  killable: boolean;
  events: readonly SessionEvent[];
  zone: string;
}

const fieldsOf = (fields: DetailField[]): Array<{ name: string; value: string }> =>
  fields
    .filter((field) => field.name !== "delivery")
    .map((field) => ({ name: field.name, value: feedText(field.value) }));

function eventOf(event: SessionEvent): TaskDetailEvent {
  const content = event.content.split(/\r?\n/).slice(0, MAX_CONTENT_LINES).join("\n");
  return {
    time: event.time,
    kind: feedText(event.kind),
    summary: feedText(event.summary),
    content: feedText(content),
    error: event.isError,
  };
}

/** The `pi-dent-task` payload of one source (task.md Section 4.2), without the serialization. */
export function taskDetailPayload(source: TaskDetailSource): TaskDetailPayload {
  const { taskId, row } = source;
  if (row === undefined) return { piDent: "task/1", taskId, found: false };
  const head: TaskDetailPayload = {
    piDent: "task/1",
    taskId,
    found: true,
    kind: row.kind,
    background: row.background,
    orphan: row.orphan,
    status: row.status,
    startedAt: row.startedAt,
    ...(row.settledAt === undefined ? {} : { settledAt: row.settledAt }),
    label: shownLabel(row.label),
    killable: source.killable,
  };
  if (row instanceof AgentTaskRow) {
    return {
      ...head,
      fields: fieldsOf(agentFields(row, identityTheme, source.zone)),
      // The Error section exists for a failed row with a result (task-browser.md Section 4.1).
      ...(row.status === "failed" && row.result !== undefined
        ? { error: feedText(row.result) }
        : {}),
      ...(row.task === undefined ? {} : { task: feedText(row.task) }),
      output: [],
      events: source.events.slice(-MAX_EVENTS).map(eventOf),
    };
  }
  return {
    ...head,
    fields: fieldsOf(scriptFields(row, identityTheme, source.zone)),
    ...(row instanceof BashTaskRow ? { command: feedText(row.command) } : {}),
    output: row.progress.slice(-MAX_OUTPUT_LINES).map((entry) => feedText(entry.line)),
    events: [],
  };
}

/** Starts a timer that calls `tick` every interval; returns the stop. */
export interface DetailTicker {
  start(tick: () => void): () => void;
}

export interface TaskDetailFeedOptions {
  registry: TaskRegistry;
  host: FeedWidgetHost;
  /** The local zone of billing.md Section 5, for the `started` and `settled` fields. */
  zone: string;
  /** The session file's text, or `undefined` when it cannot be read. */
  readSession: (path: string) => string | undefined;
  ticker: DetailTicker;
}

/** The task row with `taskId` in the task tree of `registry`, if any (task.md Section 3). */
function findTaskRow(registry: TaskRegistry, taskId: string): TaskRow | undefined {
  return listEntries(registry).find((entry) => entry.row.taskId === taskId)?.row;
}

/**
 * The task detail feed (task.md Section 4.2): at most one watched task. The widget is set on
 * watch, on a registry change that changes its text, and for a running agent row after each
 * session-file read (task-browser.md Section 4.3); an unchanged text is never set again.
 */
export class TaskDetailFeed {
  private readonly options: TaskDetailFeedOptions;
  private readonly reader = new SessionEventReader();
  private readonly unsubscribe: () => void;
  private watched: string | undefined;
  /** The watched row as the task tree last held it: it stays found after leaving the tree. */
  private held: TaskRow | undefined;
  private events: SessionEvent[] = [];
  private settledRead = false;
  private last: string | undefined;
  private stopTick: (() => void) | undefined;
  private stopped = false;

  constructor(options: TaskDetailFeedOptions) {
    this.options = options;
    this.unsubscribe = options.registry.subscribe(() => this.refresh(false));
  }

  /** Makes `taskId` the watched task, replacing any other (slash-commands.md Section 3). */
  watch(taskId: string): void {
    if (this.stopped) return;
    this.resetWatch();
    this.watched = taskId;
    const row = this.find();
    // The read on open follows the reading rule (task-browser.md Section 4.3).
    if (row instanceof AgentTaskRow) {
      this.settledRead = row.status !== "running";
      this.readFile(this.settledRead, row);
    }
    this.refresh(false);
  }

  /** Ends the watch and clears the widget (slash-commands.md Section 3). */
  unwatch(): void {
    if (this.stopped) return;
    this.resetWatch();
    this.stopTicking();
    this.clear();
  }

  /**
   * The `kill <taskId>` verb (slash-commands.md Section 3): the confirming press of the kill
   * key, a browser kill that does not consume the row (task-browser.md Section 4.4). Returns
   * false when the kill key does not apply to the row of `taskId`.
   */
  kill(taskId: string): boolean {
    if (this.stopped) return false;
    const row = findTaskRow(this.options.registry, taskId);
    if (row === undefined) return false;
    const holder = killHolder(this.options.registry, row);
    if (holder === undefined) return false;
    killFromBrowser(holder, row);
    this.refresh(false);
    return true;
  }

  /** Ends the feed at the boot window's close or the main session's end (task.md Section 4.2). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    this.resetWatch();
    this.stopTicking();
    this.clear();
  }

  /** `refresh(true)` is the 1000 ms tick: the one read a running agent row gets per tick. */
  private refresh(tick: boolean): void {
    if (this.stopped || this.watched === undefined) return;
    try {
      const row = this.find();
      if (row instanceof AgentTaskRow) {
        if (row.status !== "running") {
          if (!this.settledRead) {
            this.settledRead = true;
            this.readFile(true, row);
          }
        } else if (tick) this.readFile(false, row);
      }
      this.publish(row);
      this.syncTicker(row);
    } catch {
      // Diagnostics only; execution never depends on the feed.
    }
  }

  /** Sets the widget when the payload text changes; never with an unchanged text. */
  private publish(row: TaskRow | undefined): void {
    const taskId = this.watched ?? "";
    const payload = taskDetailPayload({
      taskId,
      row,
      killable: row !== undefined && killHolder(this.options.registry, row) !== undefined,
      events: this.events,
      zone: this.options.zone,
    });
    const text = JSON.stringify(payload);
    if (text === this.last) return;
    this.options.host.setWidget(TASK_DETAIL_WIDGET_ID, [text]);
    this.last = text;
  }

  private clear(): void {
    if (this.last === undefined) return;
    this.last = undefined;
    try {
      this.options.host.setWidget(TASK_DETAIL_WIDGET_ID, undefined);
    } catch {
      // The UI may already be gone at shutdown.
    }
  }

  /** The watched row: the one in the task tree, else the one the feed last saw there. */
  private find(): TaskRow | undefined {
    if (this.watched === undefined) return undefined;
    const inTree = findTaskRow(this.options.registry, this.watched);
    if (inTree !== undefined) this.held = inTree;
    return this.held;
  }

  private readFile(final: boolean, row: AgentTaskRow): void {
    let text: string | undefined;
    if (row.sessionPath !== undefined) {
      try {
        text = this.options.readSession(row.sessionPath);
      } catch {
        text = undefined;
      }
    }
    const step = this.reader.next(text, final);
    this.events = [...(step.restarted ? [] : this.events), ...step.added];
  }

  /** The 1000 ms timer runs only while the watched row is a running agent row. */
  private syncTicker(row: TaskRow | undefined): void {
    const running = row instanceof AgentTaskRow && row.status === "running";
    if (running && this.stopTick === undefined) {
      this.stopTick = this.options.ticker.start(() => this.refresh(true));
    } else if (!running) this.stopTicking();
  }

  private stopTicking(): void {
    const stop = this.stopTick;
    this.stopTick = undefined;
    stop?.();
  }

  private resetWatch(): void {
    this.watched = undefined;
    this.held = undefined;
    this.reader.reset();
    this.events = [];
    this.settledRead = false;
  }
}

/** The feed of a session that announces it (task.md Section 4.1), else undefined. */
export function openTaskDetailFeed(
  gate: FeedHost,
  options: TaskDetailFeedOptions,
): TaskDetailFeed | undefined {
  return feedsAnnounced(gate) ? new TaskDetailFeed(options) : undefined;
}

export const TASKS_USAGE = "Usage: /tasks [watch <taskId> | unwatch | kill <taskId>]";

/** A parsed `/tasks` argument string with arguments (slash-commands.md Section 3). */
export type TasksVerb =
  | { verb: "watch"; taskId: string }
  | { verb: "unwatch" }
  | { verb: "kill"; taskId: string }
  | { verb: "usage" };

export function parseTasksVerb(args: string): TasksVerb {
  const words = args.split(/\s+/).filter((word) => word !== "");
  const [verb, taskId] = words;
  if (verb === "unwatch" && words.length === 1) return { verb: "unwatch" };
  if (verb === "watch" && words.length === 2 && taskId !== undefined) {
    return { verb: "watch", taskId };
  }
  if (verb === "kill" && words.length === 2 && taskId !== undefined) {
    return { verb: "kill", taskId };
  }
  return { verb: "usage" };
}

export interface TasksVerbHost {
  /** The feed of the announcing session; undefined elsewhere, where the verbs are no-ops. */
  feed: TaskDetailFeed | undefined;
  /** Shows an `error` notification with `message`. */
  error(message: string): void;
}

/** Runs the verb of a `/tasks` argument string that has arguments (slash-commands.md Section 3). */
export function runTasksVerb(args: string, host: TasksVerbHost): void {
  const feed = host.feed;
  if (feed === undefined) return;
  const command = parseTasksVerb(args);
  if (command.verb === "watch") feed.watch(command.taskId);
  else if (command.verb === "unwatch") feed.unwatch();
  else if (command.verb === "kill") {
    if (!feed.kill(command.taskId)) host.error(`Task ${command.taskId} cannot be killed.`);
  } else host.error(TASKS_USAGE);
}
