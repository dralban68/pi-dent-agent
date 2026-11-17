import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskRegistry } from "../../lib/registry.ts";
import {
  openTaskDetailFeed,
  parseTasksVerb,
  runTasksVerb,
  TASK_DETAIL_WIDGET_ID,
  TASKS_USAGE,
  TaskDetailFeed,
  type TaskDetailFeedOptions,
} from "../../lib/task-detail-feed.ts";
import { must } from "../support/must.ts";

/** The `tasks` verbs per specs/slash-commands.md Section 3 and the announcement of task.md Section 4.1. */

const rpc = { env: { PI_DENT_FEEDS: "1" }, hasUI: true, mode: "rpc" };

function options(registry: TaskRegistry): TaskDetailFeedOptions {
  return {
    registry,
    host: { setWidget: () => undefined },
    zone: "UTC",
    readSession: () => undefined,
    ticker: { start: () => () => undefined },
  };
}

function errors(): { messages: string[]; error(message: string): void } {
  const messages: string[] = [];
  return {
    messages,
    error(message: string) {
      messages.push(message);
    },
  };
}

test("the verbs parse to their effect; anything else is the usage", () => {
  assert.deepEqual(parseTasksVerb("watch t1"), { verb: "watch", taskId: "t1" });
  assert.deepEqual(parseTasksVerb("  watch   t1  "), { verb: "watch", taskId: "t1" });
  assert.deepEqual(parseTasksVerb("unwatch"), { verb: "unwatch" });
  assert.deepEqual(parseTasksVerb("kill t1"), { verb: "kill", taskId: "t1" });
  assert.deepEqual(parseTasksVerb("watch"), { verb: "usage" });
  assert.deepEqual(parseTasksVerb("kill"), { verb: "usage" });
  assert.deepEqual(parseTasksVerb("watch t1 t2"), { verb: "usage" });
  assert.deepEqual(parseTasksVerb("unwatch t1"), { verb: "usage" });
  assert.deepEqual(parseTasksVerb("kill t1 now"), { verb: "usage" });
  assert.deepEqual(parseTasksVerb("open t1"), { verb: "usage" });
});

test("the usage notification is the specified text", () => {
  assert.equal(TASKS_USAGE, "Usage: /tasks [watch <taskId> | unwatch | kill <taskId>]");
  const registry = new TaskRegistry(() => undefined);
  const feed = new TaskDetailFeed(options(registry));
  const sink = errors();
  runTasksVerb("open t1", { feed, error: sink.error });
  assert.deepEqual(sink.messages, [TASKS_USAGE]);
});

test("a kill that does not apply shows the cannot-be-killed notification", () => {
  const registry = new TaskRegistry(() => undefined);
  const row = registry.register({ kind: "agent", cohort: "c", label: "a", background: true });
  registry.settle(row, { status: "completed" });
  const feed = new TaskDetailFeed(options(registry));
  const sink = errors();
  runTasksVerb(`kill ${row.taskId}`, { feed, error: sink.error });
  runTasksVerb("kill nope", { feed, error: sink.error });
  assert.deepEqual(sink.messages, [
    `Task ${row.taskId} cannot be killed.`,
    "Task nope cannot be killed.",
  ]);
});

test("a kill that applies cancels the row and shows no notification", () => {
  const registry = new TaskRegistry(() => undefined);
  const row = registry.register({ kind: "bash", cohort: "c", label: "sleep", background: true });
  let cancelled = 0;
  row.cancel = () => {
    cancelled++;
  };
  const feed = new TaskDetailFeed(options(registry));
  const sink = errors();
  runTasksVerb(`kill ${row.taskId}`, { feed, error: sink.error });
  assert.equal(cancelled, 1);
  assert.equal(row.consumed, false);
  assert.deepEqual(sink.messages, []);
});

test("watch and unwatch drive the feed through the verbs", () => {
  const registry = new TaskRegistry(() => undefined);
  const row = registry.register({ kind: "script", cohort: "c", label: "s", background: false });
  const calls: Array<[string, string[] | undefined]> = [];
  const feed = new TaskDetailFeed({
    ...options(registry),
    host: {
      setWidget(key, lines) {
        calls.push([key, lines]);
      },
    },
  });
  const sink = errors();
  runTasksVerb(`watch ${row.taskId}`, { feed, error: sink.error });
  const set = must(calls.at(-1));
  assert.equal(set[0], TASK_DETAIL_WIDGET_ID);
  assert.ok(set[1]?.[0]?.includes(`"taskId":"${row.taskId}"`));
  runTasksVerb("unwatch", { feed, error: sink.error });
  assert.deepEqual(calls.at(-1), [TASK_DETAIL_WIDGET_ID, undefined]);
  assert.deepEqual(sink.messages, []);
});

test("without the feed, the verbs are no-ops: no notification, no widget", () => {
  const sink = errors();
  runTasksVerb("watch t1", { feed: undefined, error: sink.error });
  runTasksVerb("open t1", { feed: undefined, error: sink.error });
  runTasksVerb("kill t1", { feed: undefined, error: sink.error });
  runTasksVerb("unwatch", { feed: undefined, error: sink.error });
  assert.deepEqual(sink.messages, []);
});

test("the feed exists only with the announcement: RPC mode, a UI, and PI_DENT_FEEDS 1", () => {
  const registry = new TaskRegistry(() => undefined);
  assert.ok(openTaskDetailFeed(rpc, options(registry)) instanceof TaskDetailFeed);
  assert.equal(
    openTaskDetailFeed({ env: {}, hasUI: true, mode: "rpc" }, options(registry)),
    undefined,
  );
  assert.equal(
    openTaskDetailFeed(
      { env: { PI_DENT_FEEDS: "1" }, hasUI: true, mode: "tui" },
      options(registry),
    ),
    undefined,
  );
  assert.equal(
    openTaskDetailFeed(
      { env: { PI_DENT_FEEDS: "1" }, hasUI: false, mode: "rpc" },
      options(registry),
    ),
    undefined,
  );
});
