import type { TaskRegistry } from "./registry.ts";
import { collectAllTasks, flattenTree, TASK_WIDGET_ID } from "./task-widget.ts";
import { AgentTaskRow, shownLabel, toolCallsOf } from "./task-row.ts";
import type { UsageSum } from "./usage.ts";

/**
 * Task feed (specs/task.md Section 4.1): the whole task tree, settled rows included, as one
 * JSON widget line for an RPC client, in the task browser's order with no limit; the feed is
 * set on registry changes only, never on a timer.
 */

/** One `<task>` of the feed (task.md Section 4.1). */
export interface TaskFeedTask {
  taskId: string;
  depth: number;
  kind: string;
  background: boolean;
  status: string;
  orphan: boolean;
  startedAt: number;
  settledAt?: number;
  detail: string;
  label: string;
  usage?: UsageSum;
  /** Absent for a `bash` row and a row without one: not applicable or unknown, never 0. */
  toolCalls?: number;
}

/** The task feed's `<task>` objects, one per member of the task tree (task.md Section 4.1). */
export function taskFeedTasks(registry: TaskRegistry): TaskFeedTask[] {
  return flattenTree(collectAllTasks(registry)).map(({ row, depth }) => {
    const toolCalls = toolCallsOf(row);
    return {
      taskId: row.taskId,
      depth,
      kind: row.kind,
      background: row.background,
      status: row.status,
      orphan: row.orphan,
      startedAt: row.startedAt,
      ...(row.settledAt === undefined ? {} : { settledAt: row.settledAt }),
      detail: row.displayDetail(),
      label: shownLabel(row.label),
      ...(row instanceof AgentTaskRow && row.usage !== undefined
        ? { usage: { ...row.usage } }
        : {}),
      ...(toolCalls === undefined ? {} : { toolCalls }),
    };
  });
}

/** The host surface the feed needs: set a widget's lines, or clear it with `undefined`. */
export interface FeedWidgetHost {
  setWidget(key: string, lines: string[] | undefined): void;
}

export interface FeedHandle {
  stop(): void;
}

/**
 * Starts the task feed for `registry` (task.md Section 4.1). It sets `pi-dent-tasks` to the
 * JSON line when the text changes, clears it when the content is empty, and clears it on
 * `stop`. Failures are silent and leave the widget as it is.
 */
export function startTaskFeed(registry: TaskRegistry, host: FeedWidgetHost): FeedHandle {
  let last: string | undefined;
  let stopped = false;

  const sync = (): void => {
    if (stopped) return;
    try {
      const tasks = taskFeedTasks(registry);
      if (tasks.length === 0) {
        if (last === undefined) return;
        host.setWidget(TASK_WIDGET_ID, undefined);
        last = undefined;
        return;
      }
      const text = JSON.stringify({ piDent: "tasks/2", tasks });
      if (text === last) return;
      host.setWidget(TASK_WIDGET_ID, [text]);
      last = text;
    } catch {
      // A failed feed reports nothing and leaves the widget as it is.
    }
  };

  const unsubscribe = registry.subscribe(sync);
  sync();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      if (last === undefined) return;
      last = undefined;
      try {
        host.setWidget(TASK_WIDGET_ID, undefined);
      } catch {
        // The UI may already be gone at shutdown.
      }
    },
  };
}
