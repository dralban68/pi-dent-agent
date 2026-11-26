import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { AgentTaskRow, type TaskRegistry, type TaskRow } from "./registry.ts";
import { identityPaint, type TaskPaint } from "./task-row.ts";

export { formatElapsed, labelText, plainText, type TaskPaint } from "./task-row.ts";

/**
 * Task tree widget per specs/task.md#task-tree-widget: renders the content of the
 * task tree under the `pi-dent-tasks` widget key. Line rendering is a pure
 * function (task tree in, string[] out); each row renders its own line.
 */

export const TASK_WIDGET_ID = "pi-dent-tasks";

/** Node of the task tree content (specs/task.md#task-tree, specs/task.md#task-tree-widget); siblings are displayed nodes only. */
export interface TaskTreeNode {
  row: TaskRow;
  children: TaskTreeNode[];
}

const childRows = (row: TaskRow): TaskRow[] =>
  row instanceof AgentTaskRow && row.children ? row.children.list() : [];

/**
 * A displayed task of the content: running, or interrupted and not consumed
 * (specs/task.md#task-tree-widget).
 */
const displayed = (row: TaskRow): boolean =>
  row.status === "running" || (row.status === "interrupted" && !row.consumed);

const running = (row: TaskRow): boolean => row.status === "running";

const everything = (): boolean => true;

/**
 * The one walk of the task tree (specs/task.md#task-tree): depth-first over a row list and each
 * row's attached child registry. A node is kept when `keep` holds for its row; the children
 * of a row it rejects take its place. Every other tree view is this walk with its own `keep`.
 */
function walkTaskTree(rows: readonly TaskRow[], keep: (row: TaskRow) => boolean): TaskTreeNode[] {
  const nodes: TaskTreeNode[] = [];
  for (const row of rows) {
    const children = walkTaskTree(childRows(row), keep);
    if (keep(row)) nodes.push({ row, children });
    else nodes.push(...children);
  }
  return nodes;
}

/**
 * The task tree content: running and interrupted tasks; any other settled task's
 * displayed children take its place (specs/task.md#task-tree, specs/task.md#task-tree-widget).
 */
export function collectTaskTree(registry: TaskRegistry): TaskTreeNode[] {
  return walkTaskTree(registry.list(), displayed);
}

/** Whether the tree has a displayed task: the widget's show condition (specs/task.md#task-tree-widget). */
function hasDisplayedTask(registry: TaskRegistry): boolean {
  return collectTaskTree(registry).length > 0;
}

/** Whether the tree has a running task: the refresh-timer condition (specs/task.md#task-tree-widget). */
export function hasRunningTask(registry: TaskRegistry): boolean {
  return walkTaskTree(registry.list(), running).length > 0;
}

/**
 * Depth-first rows of a task tree with their `<prefix>` (specs/task.md#task-tree-widget) and their
 * `depth` (specs/task.md#task-feed): 0 for a root.
 */
export function flattenTree(
  roots: TaskTreeNode[],
): Array<{ row: TaskRow; prefix: string; depth: number }> {
  const out: Array<{ row: TaskRow; prefix: string; depth: number }> = [];
  // `columns` holds one column per ancestor below the root; undefined at the root level.
  const draw = (nodes: TaskTreeNode[], depth: number, columns?: string): void => {
    nodes.forEach((node, i) => {
      const later = i < nodes.length - 1;
      out.push({
        row: node.row,
        prefix: columns === undefined ? "" : `${columns}${later ? "├─ " : "└─ "}`,
        depth,
      });
      draw(
        node.children,
        depth + 1,
        columns === undefined ? "" : `${columns}${later ? "│  " : "   "}`,
      );
    });
  };
  draw(roots, 0);
  return out;
}

/** The whole task tree, running and settled (specs/task-browser.md#list-page). */
export function collectAllTasks(registry: TaskRegistry): TaskTreeNode[] {
  return walkTaskTree(registry.list(), everything);
}

/** The running members of the task tree: the list page's `running` filter (specs/task-browser.md#list-page). */
export function collectRunningTasks(registry: TaskRegistry): TaskTreeNode[] {
  return walkTaskTree(registry.list(), running);
}

const MAX_LINES = 10;

/**
 * Render the task tree lines (pure): one line per node, depth-first, every
 * line truncated to `width`. Returns nothing when the tree has neither a
 * running nor an interrupted task.
 */
export function renderTaskTree(
  roots: TaskTreeNode[],
  now: number,
  width: number,
  paint: TaskPaint = identityPaint,
): string[] | undefined {
  if (roots.length === 0) return undefined;
  const lines = flattenTree(roots).map(({ row, prefix }) =>
    truncateToWidth(`${prefix}${row.renderLine(now, paint)}`, width),
  );
  if (lines.length > MAX_LINES) {
    const shown = lines.slice(0, MAX_LINES - 1);
    shown.push(truncateToWidth(`… ${lines.length - shown.length} more`, width));
    return shown;
  }
  return lines;
}

/** The TUI surface the widget needs. */
export interface TaskWidgetTui {
  requestRender(): void;
}

/** Builds the widget component; the host invokes it once per `setWidget`. */
export type TaskWidgetFactory = (tui: TaskWidgetTui, paint: TaskPaint) => Component;

/** The host surface the widget needs: install a component factory under `key`, or clear it. */
export interface TaskWidgetHost {
  setWidget(key: string, factory: TaskWidgetFactory | undefined): void;
}

export interface TaskWidgetHandle {
  stop(): void;
}

/**
 * Live widget controller (specs/task.md#task-tree-widget): installs the widget once while
 * the task tree has a running or interrupted task and clears it otherwise;
 * the 1000 ms timer runs only while a task is running. Registry changes and
 * the timer only invalidate and request a (coalesced) render. Any
 * widget failure stops the controller and never propagates.
 */
export function startTaskWidget(registry: TaskRegistry, host: TaskWidgetHost): TaskWidgetHandle {
  let timer: ReturnType<typeof setInterval> | undefined;
  let shown = false;
  let stopped = false;
  let pending = false;
  let view: { component: Component; tui: TaskWidgetTui } | undefined;

  const factory: TaskWidgetFactory = (tui, paint) => {
    let cache: { width: number; lines: string[] } | undefined;
    const component: Component = {
      render(width) {
        if (cache?.width !== width) {
          let lines: string[] = [];
          try {
            lines = renderTaskTree(collectTaskTree(registry), Date.now(), width, paint) ?? [];
          } catch {
            // Diagnostics only.
          }
          cache = { width, lines };
        }
        return cache.lines;
      },
      invalidate() {
        cache = undefined;
      },
    };
    view = { component, tui };
    return component;
  };

  const stopTimer = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const fail = (): void => {
    stopped = true;
    stopTimer();
    unsubscribe();
    // A failed update leaves no stale content behind (specs/task.md#task-tree-widget).
    if (!shown) return;
    shown = false;
    view = undefined;
    try {
      host.setWidget(TASK_WIDGET_ID, undefined);
    } catch {
      // The host that just failed may be gone for good; nothing else can clear the widget.
    }
  };
  const refresh = (): void => {
    if (stopped) return;
    try {
      view?.component.invalidate();
      view?.tui.requestRender();
    } catch {
      fail();
    }
  };
  const update = (): void => {
    if (stopped) return;
    try {
      if (!hasDisplayedTask(registry)) {
        stopTimer();
        if (shown) {
          shown = false;
          view = undefined;
          host.setWidget(TASK_WIDGET_ID, undefined);
        }
        return;
      }
      if (!shown) {
        shown = true;
        host.setWidget(TASK_WIDGET_ID, factory);
      }
      // The timer runs only while a task runs: an interrupted row's elapsed is
      // frozen at `settledAt`, so nothing advances without a running task (specs/task.md#task-tree-widget).
      if (hasRunningTask(registry)) {
        if (!timer) {
          timer = setInterval(refresh, 1000);
          timer.unref?.();
        }
      } else {
        stopTimer();
      }
      if (!pending) {
        pending = true;
        queueMicrotask(() => {
          pending = false;
          refresh();
        });
      }
    } catch {
      fail();
    }
  };

  const unsubscribe = registry.subscribe(update);
  update();

  return {
    /** Clear the widget and stop the controller; a failure in the host never throws. */
    stop(): void {
      fail();
    },
  };
}
