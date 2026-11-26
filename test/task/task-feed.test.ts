import assert from "node:assert/strict";
import { test } from "node:test";
import { feedsAnnounced } from "../../lib/feeds.ts";
import { AgentTaskRow, TaskRegistry } from "../../lib/registry.ts";
import { startTaskFeed, taskFeedTasks } from "../../lib/task-feed.ts";
import { collectTaskTree, renderTaskTree, TASK_WIDGET_ID } from "../../lib/task-widget.ts";
import { at, must } from "../support/must.ts";

/** Task feed conformance per specs/task.md#task-feed and the announcement of `PI_DENT_FEEDS`. */

const reg = () => new TaskRegistry(() => undefined);
const rpc = { env: { PI_DENT_FEEDS: "1" }, hasUI: true, mode: "rpc" };

/** A host recording every `setWidget` call. */
function recorder() {
  const calls: Array<[string, string[] | undefined]> = [];
  return {
    calls,
    host: {
      setWidget(key: string, lines: string[] | undefined) {
        calls.push([key, lines]);
      },
    },
  };
}

/** The feed's parsed payload from the single `pi-dent-tasks` line of the last set. */
function lastPayload(calls: Array<[string, string[] | undefined]>) {
  const last = must(calls.at(-1));
  assert.equal(last[0], TASK_WIDGET_ID);
  const lines = must(last[1]);
  assert.equal(lines.length, 1);
  return JSON.parse(at(lines, 0)) as {
    piDent: string;
    tasks: Array<Record<string, unknown>>;
  };
}

test("the feed is announced only in RPC mode with a UI and PI_DENT_FEEDS set to 1", () => {
  assert.equal(feedsAnnounced(rpc), true);
  assert.equal(feedsAnnounced({ env: {}, hasUI: true, mode: "rpc" }), false);
  assert.equal(feedsAnnounced({ env: { PI_DENT_FEEDS: "0" }, hasUI: true, mode: "rpc" }), false);
  assert.equal(feedsAnnounced({ env: { PI_DENT_FEEDS: "true" }, hasUI: true, mode: "rpc" }), false);
  assert.equal(feedsAnnounced({ env: { PI_DENT_FEEDS: "1" }, hasUI: true, mode: "tui" }), false);
  assert.equal(feedsAnnounced({ env: { PI_DENT_FEEDS: "1" }, hasUI: true, mode: "print" }), false);
  assert.equal(feedsAnnounced({ env: { PI_DENT_FEEDS: "1" }, hasUI: false, mode: "rpc" }), false);
});

test("the payload carries every member of the task tree with every task field", () => {
  const root = reg();
  const a = root.register({ kind: "agent", cohort: "c", label: "a", background: true });
  root.amend(a, { model: "anthropic/claude\x1b[31m:high" });
  const ca = reg();
  root.attach(a, ca);
  const b = ca.register({ kind: "agent", cohort: "c", label: "b\nsecond line", background: true });
  const tc = ca.register({ kind: "script", cohort: "c", label: "c", background: false });
  const cb = reg();
  ca.attach(b, cb);
  const tdeep = cb.register({ kind: "bash", cohort: "c", label: "deep", background: true });
  // A settled, consumed foreground row is a member all the same.
  const fg = root.register({ kind: "bash", cohort: "c", label: "gone", background: false });
  root.settle(fg, { status: "completed", result: "ok" });
  // An interrupted, unconsumed, adopted row.
  const d = root.register({ kind: "bash", cohort: "c", label: "d", background: true });
  d.status = "interrupted";
  d.settledAt = d.startedAt + 5000;
  d.orphan = true;

  const tasks = taskFeedTasks(root);
  assert.deepEqual(
    tasks.map((t) => [t.taskId, t.depth]),
    [
      [a.taskId, 0],
      [b.taskId, 1],
      [tdeep.taskId, 2],
      [tc.taskId, 1],
      [fg.taskId, 0],
      [d.taskId, 0],
    ],
  );
  const [ta, tb, tdeepFeed, tcFeed, tfg, td] = tasks;
  assert.equal(tfg?.status, "completed");
  assert.equal(tfg?.settledAt, fg.settledAt);
  assert.deepEqual(ta, {
    taskId: a.taskId,
    depth: 0,
    kind: "agent",
    background: true,
    status: "running",
    orphan: false,
    startedAt: a.startedAt,
    detail: "anthropic/claude:high",
    label: "a",
    toolCalls: 0,
  });
  assert.deepEqual(tb, {
    taskId: b.taskId,
    depth: 1,
    kind: "agent",
    background: true,
    status: "running",
    orphan: false,
    startedAt: b.startedAt,
    detail: "",
    label: "b",
    toolCalls: 0,
  });
  assert.equal(tcFeed?.kind, "script");
  assert.equal(tcFeed?.background, false);
  assert.equal(tdeepFeed?.kind, "bash");
  assert.deepEqual(td, {
    taskId: d.taskId,
    depth: 0,
    kind: "bash",
    background: true,
    status: "interrupted",
    orphan: true,
    startedAt: d.startedAt,
    settledAt: d.startedAt + 5000,
    detail: "",
    label: "d",
  });
});

test("while every task runs, the feed's task IDs follow the widget's lines in order", () => {
  const root = reg();
  const a = root.register({ kind: "agent", cohort: "c", label: "a", background: true });
  const ca = reg();
  root.attach(a, ca);
  ca.register({ kind: "bash", cohort: "c", label: "x", background: true });
  root.register({ kind: "bash", cohort: "c", label: "y", background: true });
  const widgetIds = (renderTaskTree(collectTaskTree(root), Date.now(), 200) ?? []).map(
    (line) => must(/^[│├└─ ]*(\S+) ·/.exec(line))[1],
  );
  assert.deepEqual(
    taskFeedTasks(root).map((t) => t.taskId),
    widgetIds,
  );
});

test("the feed has no 10-line limit", () => {
  const r = reg();
  for (let i = 0; i < 12; i += 1) {
    r.register({ kind: "bash", cohort: "c", label: `t${i}`, background: true });
  }
  const { calls, host } = recorder();
  const feed = startTaskFeed(r, host);
  assert.equal(lastPayload(calls).tasks.length, 12);
  feed.stop();
});

test("the feed sets the JSON text once per change, never for an unchanged text", () => {
  const r = reg();
  const { calls, host } = recorder();
  const feed = startTaskFeed(r, host);
  assert.deepEqual(calls, []);
  const a = r.register({ kind: "bash", cohort: "c", label: "a", background: true });
  assert.equal(calls.length, 1);
  assert.equal(at(calls, 0)[0], TASK_WIDGET_ID);
  assert.equal(lastPayload(calls).piDent, "tasks/2");
  // Progress changes the registry but not the feed's content: no set.
  r.progress(a, "step 1");
  assert.equal(calls.length, 1);
  // A relabel changes the text.
  r.amend(a, { label: "a2" });
  assert.equal(calls.length, 2);
  assert.equal(lastPayload(calls).tasks[0]?.label, "a2");
  feed.stop();
});

test("a settled task stays in the feed with its status and settledAt", () => {
  const r = reg();
  const { calls, host } = recorder();
  const feed = startTaskFeed(r, host);
  // No member: nothing is set.
  assert.deepEqual(calls, []);
  const a = r.register({ kind: "bash", cohort: "c", label: "a", background: true });
  r.settle(a, { status: "failed", result: "boom" });
  assert.equal(calls.length, 2);
  const task = must(lastPayload(calls).tasks[0]);
  assert.equal(task.status, "failed");
  assert.equal(task.settledAt, a.settledAt);
  // Consuming changes no field of the feed: no set.
  r.consume(a);
  assert.equal(calls.length, 2);
  feed.stop();
  assert.deepEqual(calls.at(-1), [TASK_WIDGET_ID, undefined]);
});

test("ending the main session clears a set feed", () => {
  const r = reg();
  const { calls, host } = recorder();
  r.register({ kind: "bash", cohort: "c", label: "a", background: true });
  const feed = startTaskFeed(r, host);
  assert.equal(calls.length, 1);
  feed.stop();
  assert.deepEqual(calls.at(-1), [TASK_WIDGET_ID, undefined]);
  // A stopped feed reports nothing to a later registry change.
  r.register({ kind: "bash", cohort: "c", label: "b", background: true });
  assert.equal(calls.length, 2);
});

test("a registry change while the feed holds a failing host leaves no error behind", () => {
  const r = reg();
  let failing = true;
  const sent: string[][] = [];
  const feed = startTaskFeed(r, {
    setWidget(_key, lines) {
      if (failing) throw new Error("ui gone");
      if (lines) sent.push(lines);
    },
  });
  r.register({ kind: "bash", cohort: "c", label: "a", background: true });
  assert.deepEqual(sent, []);
  failing = false;
  r.register({ kind: "bash", cohort: "c", label: "b", background: true });
  assert.equal(sent.length, 1);
  feed.stop();
});

test("the label is the one the task tree widget shows: the agent directory as $PI_DENT_SESSION_DIR", () => {
  const saved = process.env.PI_DENT_SESSION_DIR;
  process.env.PI_DENT_SESSION_DIR = "/tmp/s.agents";
  try {
    const r = reg();
    r.register({ kind: "bash", cohort: "c", label: "cat /tmp/s.agents/out.md", background: true });
    const task = must(taskFeedTasks(r)[0]);
    assert.equal(task.label, "cat $PI_DENT_SESSION_DIR/out.md");
    const line = must(renderTaskTree(collectTaskTree(r), task.startedAt, 200)?.[0]);
    assert.ok(line.endsWith(` · ${task.label}`));
  } finally {
    if (saved === undefined) delete process.env.PI_DENT_SESSION_DIR;
    else process.env.PI_DENT_SESSION_DIR = saved;
  }
});

test("each task carries its own usage sum once present and omits it when absent", () => {
  const root = reg();
  const rec = recorder();
  const feed = startTaskFeed(root, rec.host);

  const parent = root.register({ kind: "agent", cohort: "c", label: "parent", background: true });
  const childReg = reg();
  root.attach(parent, childReg);
  const child = childReg.register({ kind: "agent", cohort: "c", label: "child", background: true });
  const bash = root.register({ kind: "bash", cohort: "c", label: "echo", background: false });

  // Before any usage is amended, `usage` is absent on every row.
  for (const t of lastPayload(rec.calls).tasks) {
    assert.equal("usage" in t, false);
  }

  const parentUsage = {
    input: 1200,
    output: 340,
    cacheRead: 500,
    cacheWrite: 100,
    cost: 0.0123,
    turns: 2,
  };
  const childUsage = {
    input: 400,
    output: 80,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.0021,
    turns: 1,
  };
  const callsBeforeAmend = rec.calls.length;
  root.amend(parent, { usage: parentUsage });
  childReg.amend(child, { usage: childUsage });
  assert.equal(rec.calls.length, callsBeforeAmend + 2);

  const payload = lastPayload(rec.calls);
  assert.equal(payload.piDent, "tasks/2");
  const byId = new Map(payload.tasks.map((t) => [t.taskId, t]));
  assert.deepEqual(byId.get(parent.taskId)?.usage, parentUsage);
  assert.deepEqual(byId.get(child.taskId)?.usage, childUsage);
  assert.equal("usage" in must(byId.get(bash.taskId)), false);

  feed.stop();
});

test("an agent or script task carries its toolCalls; a bash or rebuilt task has none, never 0", () => {
  const root = reg();
  const rec = recorder();
  const feed = startTaskFeed(root, rec.host);
  const agent = root.register({ kind: "agent", cohort: "c", label: "agent", background: true });
  const script = root.register({ kind: "script", cohort: "c", label: "run", background: true });
  const bash = root.register({ kind: "bash", cohort: "c", label: "echo", background: true });
  const rebuilt = new AgentTaskRow({
    taskId: "0000beef",
    cohort: "c",
    label: "rebuilt",
    background: true,
    startedAt: 1,
  });
  rebuilt.status = "interrupted";
  rebuilt.settledAt = 2;
  root.rebuild([rebuilt]);

  const counts = () =>
    new Map(lastPayload(rec.calls).tasks.map((t) => [t.taskId, t.toolCalls ?? "absent"]));
  assert.deepEqual(
    counts(),
    new Map<string, unknown>([
      [agent.taskId, 0],
      [script.taskId, 0],
      [bash.taskId, "absent"],
      [rebuilt.taskId, "absent"],
    ]),
  );
  for (const t of lastPayload(rec.calls).tasks) {
    if (t.taskId === bash.taskId || t.taskId === rebuilt.taskId)
      assert.equal("toolCalls" in t, false);
  }

  const before = rec.calls.length;
  root.amend(agent, { toolCalls: 3 });
  root.amend(script, { toolCalls: 1 });
  assert.equal(rec.calls.length, before + 2, "each change of a count sets the feed");
  assert.equal(counts().get(agent.taskId), 3);
  assert.equal(counts().get(script.taskId), 1);
  feed.stop();
});
