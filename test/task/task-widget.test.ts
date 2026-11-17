import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentTaskRow, TaskRegistry } from "../../lib/registry.ts";
import { rebuildInterruptedTasks } from "../../lib/task-rebuild.ts";
import { writeRunningRecord } from "../../lib/task-record.ts";
import { makeTaskTool } from "../../lib/tools.ts";
import {
  collectTaskTree,
  formatElapsed,
  renderTaskTree,
  startTaskWidget,
  TASK_WIDGET_ID,
  type TaskWidgetFactory,
} from "../../lib/task-widget.ts";
import { at, must } from "../support/must.ts";

/** Task tree widget conformance per specs/task.md Section 4. */

const reg = () => new TaskRegistry(() => undefined);
const add = (r: TaskRegistry, label: string) =>
  r.register({ kind: "agent", cohort: "c", label, background: true });
const lines = (r: TaskRegistry, width = 200) =>
  renderTaskTree(collectTaskTree(r), Date.now(), width) ?? [];
const prefixes = (r: TaskRegistry) => lines(r).map((l) => must(/^[│├└─ ]*/.exec(l))[0]);
const done = { status: "completed", result: "ok" } as const;

test("children of a root have no root column; grandchildren have one column", () => {
  const root = reg();
  const a = add(root, "a");
  const ca = reg();
  root.attach(a, ca);
  const b = add(ca, "b");
  add(ca, "c");
  const cb = reg();
  ca.attach(b, cb);
  add(cb, "d");
  assert.deepEqual(prefixes(root), ["", "├─ ", "│  └─ ", "└─ "]);
});

test("a settled later sibling is not displayed and does not count", () => {
  const root = reg();
  const a = add(root, "a");
  const ca = reg();
  root.attach(a, ca);
  const b = add(ca, "b");
  const c = add(ca, "c");
  const cb = reg();
  ca.attach(b, cb);
  add(cb, "d");
  ca.settle(c, done);
  assert.deepEqual(prefixes(root), ["", "└─ ", "   └─ "]);
});

test("more than 10 lines render 9 plus an overflow line", () => {
  const root = reg();
  for (let i = 0; i < 12; i++) add(root, `s${i}`);
  const out = lines(root);
  assert.equal(out.length, 10);
  assert.equal(out[9], "… 3 more");
  root.settle(at(root.list(), 0), done);
  root.settle(at(root.list(), 1), done);
  assert.equal(lines(root).length, 10);
  assert.doesNotMatch(lines(root).join("\n"), /more/);
});

test("a consumed interrupted row is not widget content", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-widget-consumed-"));
  try {
    writeRunningRecord(dir, {
      taskId: "abcd0001",
      agent: "dynamic",
      label: "stuck",
      cohort: "c",
      startedAt: 1,
      sessionPath: join(dir, "s.jsonl"),
    });
    const r = reg();
    assert.equal(rebuildInterruptedTasks(r, dir), 1);
    const row = must(r.get("abcd0001"));
    assert.equal(lines(r).length, 1, "the interrupted row is displayed");
    r.consume(row);
    assert.deepEqual(lines(r), [], "a consumed interrupted row is not content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatElapsed boundaries", () => {
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(60_000), "1m00s");
  assert.equal(formatElapsed(3_599_000), "59m59s");
  assert.equal(formatElapsed(3_600_000), "1h00m");
});

test("label: first line, ANSI and control characters stripped, truncated to width only", () => {
  const root = reg();
  const long = "x".repeat(300);
  add(root, `${long}\nsecond`);
  assert.ok(at(lines(root, 1000), 0).endsWith(` · ${long}`));
  const r2 = reg();
  add(r2, "\x1b[31mred\x1b[0m \x1b]0;title\x07ok\tz\x07\r\nnext");
  assert.ok(at(lines(r2), 0).endsWith(" · red okz"));
  assert.ok(visibleWidth(at(lines(root, 40), 0)) <= 40);
});

interface FakeHost {
  sets: Array<"set" | undefined>;
  renders: number;
  factory: TaskWidgetFactory | undefined;
  setWidget(key: string, factory: TaskWidgetFactory | undefined): void;
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    sets: [],
    renders: 0,
    factory: undefined,
    setWidget(key, factory) {
      assert.equal(key, TASK_WIDGET_ID);
      host.sets.push(factory ? "set" : undefined);
      host.factory = factory;
      factory?.(
        { requestRender: () => host.renders++ },
        {
          status: (t) => t,
          orphan: (t) => t,
          elapsed: (t) => t,
          detail: (t) => t,
        },
      );
    },
  };
  return host;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("controller installs once, coalesces renders, clears and stops the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = reg();
  const host = fakeHost();
  const handle = startTaskWidget(root, host);
  assert.deepEqual(host.sets, []);

  const row = add(root, "a");
  assert.deepEqual(host.sets, ["set"]);
  for (let i = 0; i < 50; i++) root.progress(row, `line ${i}`);
  await flush();
  assert.deepEqual(host.sets, ["set"]);
  assert.equal(host.renders, 1);

  t.mock.timers.tick(1000);
  assert.equal(host.renders, 2);

  root.settle(row, done);
  assert.deepEqual(host.sets, ["set", undefined]);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(host.renders, 2);

  add(root, "b");
  assert.deepEqual(host.sets, ["set", undefined, "set"]);
  handle.stop();
  assert.deepEqual(host.sets, ["set", undefined, "set", undefined]);
  add(root, "c");
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(host.sets.length, 4);
  assert.equal(host.renders, 2);
});

test("an interrupted row keeps the widget shown; the timer follows running only", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = reg();
  const host = fakeHost();
  startTaskWidget(root, host);

  const stuck = new AgentTaskRow({
    taskId: "aaaa0001",
    cohort: "c",
    label: "stuck",
    background: true,
    startedAt: 1_000,
  });
  stuck.status = "interrupted";
  stuck.settledAt = 6_000;
  root.rebuild([stuck]);
  assert.deepEqual(host.sets, ["set"]);
  await flush();
  assert.equal(host.renders, 1); // the rebuild is reflected
  t.mock.timers.tick(5_000);
  assert.equal(host.renders, 1); // no refresh timer without a running task (Section 4)

  const row = add(root, "a");
  await flush();
  assert.equal(host.renders, 2);
  t.mock.timers.tick(1_000);
  assert.equal(host.renders, 3); // the timer runs while a task is running

  root.settle(row, done);
  await flush();
  assert.equal(host.renders, 4); // the settlement is reflected
  assert.deepEqual(host.sets, ["set"]); // the interrupted row keeps the widget shown
  t.mock.timers.tick(5_000);
  assert.equal(host.renders, 4); // the timer stopped: no running task
});

test("killing an interrupted row clears the widget (Section 4)", async () => {
  const root = reg();
  const host = fakeHost();
  startTaskWidget(root, host);

  const stuck = new AgentTaskRow({
    taskId: "aaaa0002",
    cohort: "c",
    label: "stuck",
    background: true,
    startedAt: 1_000,
  });
  stuck.status = "interrupted";
  stuck.settledAt = 6_000;
  root.rebuild([stuck]);
  assert.deepEqual(host.sets, ["set"]);

  const tool = makeTaskTool({ registry: () => root });
  const result = await tool.execute(
    "tc",
    { action: "kill", taskId: stuck.taskId } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(result.details.status, "interrupted");
  assert.deepEqual(host.sets, ["set", undefined], "the killed row leaves no content");
  assert.deepEqual(collectTaskTree(root), []);
});

test("the component renders the tree and re-renders after invalidate", () => {
  const root = reg();
  let component: ReturnType<TaskWidgetFactory> | undefined;
  const handle = startTaskWidget(root, {
    setWidget: (_key, factory) => {
      component = factory?.(
        { requestRender: () => {} },
        {
          status: (t) => t,
          orphan: (t) => t,
          elapsed: (t) => t,
          detail: (t) => t,
        },
      );
    },
  });
  const a = add(root, "first");
  assert.match(at(must(component).render(100), 0), /first$/);
  add(root, "second");
  must(component).invalidate();
  assert.equal(must(component).render(100).length, 2);
  root.settle(a, done);
  handle.stop();
});

test("a throwing host never throws out of registry operations or timers", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const root = reg();
    startTaskWidget(root, {
      setWidget: () => {
        throw new Error("ui gone");
      },
    });
    const row = add(root, "a");
    root.progress(row, "p");
    mock.timers.tick(3000);
    await flush();
    root.settle(row, done);

    const r2 = reg();
    startTaskWidget(r2, {
      setWidget: (_key, factory) =>
        factory?.(
          {
            requestRender: () => {
              throw new Error("stale tui");
            },
          },
          { status: (t) => t, orphan: (t) => t, elapsed: (t) => t, detail: (t) => t },
        ),
    });
    const r = add(r2, "a");
    r2.progress(r, "p");
    await flush();
    mock.timers.tick(3000);
    r2.settle(r, done);
  } finally {
    mock.timers.reset();
  }
});

test("settled tasks are never rendered; their running children take their place", () => {
  const root = reg();
  const a = add(root, "a");
  const ca = reg();
  root.attach(a, ca);
  add(ca, "b");
  add(root, "c");
  root.consume(a);
  root.settle(a, done);
  // Settling detaches `children`; adoption keeps the nested row running under root.
  ca.end();
  const out = lines(root);
  assert.equal(out.length, 2);
  assert.doesNotMatch(out.join("\n"), /completed|failed|cancelled/);
  assert.deepEqual(prefixes(root), ["", ""]);
});

test("a failed widget refresh clears the widget and stops the controller (Section 4)", async () => {
  const root = reg();
  const sets: Array<"set" | undefined> = [];
  let renderFails = false;
  startTaskWidget(root, {
    setWidget(_key, factory) {
      sets.push(factory ? "set" : undefined);
      factory?.(
        {
          requestRender: () => {
            if (renderFails) throw new Error("stale tui");
          },
        },
        { status: (t) => t, orphan: (t) => t, elapsed: (t) => t, detail: (t) => t },
      );
    },
  });
  const row = add(root, "a");
  await flush();
  assert.deepEqual(sets, ["set"]);

  renderFails = true;
  root.progress(row, "step");
  await flush();
  assert.deepEqual(sets, ["set", undefined], "the widget whose render failed is cleared");

  // Stopped: a later registry change installs nothing and refreshes nothing.
  root.progress(row, "again");
  await flush();
  assert.deepEqual(sets, ["set", undefined]);
});

test("an interrupted row is a displayed node with elapsed frozen at settledAt", () => {
  const root = reg();
  const row = add(root, "stuck");
  Object.assign(row, { startedAt: 1_000, status: "interrupted", settledAt: 6_000 });
  const tree = collectTaskTree(root);
  assert.deepEqual(
    tree.map((node) => node.row),
    [row],
  );
  assert.deepEqual(renderTaskTree(tree, 9_999_999, 200), [
    `${row.taskId} · agent · bg · interrupted · 5s · stuck`,
  ]);
});

test("an agent row renders its model as the detail segment; a script row has none", () => {
  const root = reg();
  const a = add(root, "a");
  const s = root.register({ kind: "script", cohort: "c", label: "s", background: false });
  assert.match(at(lines(root), 0), new RegExp(`^${a.taskId} · agent · bg · running · \\d+s · a$`));
  root.amend(a, { model: "anthropic/claude\x1b[31m:high" });
  const paint = {
    status: (t: string) => t,
    orphan: (t: string) => t,
    elapsed: () => "E",
    detail: (t: string) => `<${t}>`,
  };
  assert.deepEqual(renderTaskTree(collectTaskTree(root), Date.now(), 200, paint), [
    `${a.taskId} · agent · bg · running · E · <anthropic/claude:high> · a`,
    `${s.taskId} · script · fg · running · E · s`,
  ]);
});
