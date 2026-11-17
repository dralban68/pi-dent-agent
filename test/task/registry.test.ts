import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTaskRow, PROGRESS_CAP, TaskRegistry, type TaskRow } from "../../lib/registry.ts";
import { DispatchEngine, type BootSnapshot } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession } from "../../lib/host.ts";
import { at } from "../support/must.ts";

/** Task registry conformance per specs/task-registry.md Sections 1-7. */

function hostRecording(notify: string[], throws = false): HostSession {
  return {
    notify: (message: string) => {
      notify.push(message);
      if (throws) throw new Error("This extension ctx is stale");
    },
  } as unknown as HostSession;
}

function bg(registry: TaskRegistry, cohort: string, label = "t"): TaskRow {
  return registry.register({ kind: "script", cohort, label, background: true });
}

test("no notification after end when a cancelled row settles later", () => {
  for (const throws of [false, true]) {
    const notify: string[] = [];
    const registry = new TaskRegistry(() => hostRecording(notify, throws));
    const row = bg(registry, "c");
    let cancelled = false;
    row.cancel = () => (cancelled = true);
    registry.end();
    assert.equal(cancelled, true);
    assert.doesNotThrow(() => registry.settle(row, { status: "cancelled", result: "x" }));
    assert.equal(row.status, "cancelled");
    assert.deepEqual(notify, []);
  }
});

test("listeners are called and settlement stands when notify throws", () => {
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify, true));
  const row = bg(registry, "c");
  let calls = 0;
  registry.subscribe(() => calls++);
  assert.doesNotThrow(() => registry.settle(row, { status: "completed", result: "ok" }));
  assert.equal(calls, 1);
  assert.equal(notify.length, 1);
  assert.equal(row.status, "completed");
});

test("nested changes reach root after agent-row adoption", () => {
  const root = new TaskRegistry(() => undefined);
  const a = root.register({ kind: "agent", cohort: "c1", label: "A", background: true });
  const mid = new TaskRegistry(() => undefined);
  root.attach(a, mid);
  const b = mid.register({ kind: "agent", cohort: "c2", label: "B", background: true });
  const leaf = new TaskRegistry(() => undefined);
  mid.attach(b, leaf);
  const s = bg(leaf, "c3");

  mid.end();
  root.settle(a, { status: "completed", result: "done" });
  assert.equal(root.get(b.taskId), b);
  assert.equal(b.children, leaf);

  let calls = 0;
  root.subscribe(() => calls++);
  leaf.progress(s, "tick");
  assert.equal(calls, 1);
  bg(leaf, "c3");
  assert.equal(calls, 2);

  leaf.end(); // adopts into root, b's new attacher
  assert.equal(root.get(s.taskId), s);
});

test("attach to an adopted row routes to its holder", () => {
  const root = new TaskRegistry(() => undefined);
  const a = root.register({ kind: "agent", cohort: "c1", label: "A", background: true });
  const mid = new TaskRegistry(() => undefined);
  root.attach(a, mid);
  const b = mid.register({ kind: "agent", cohort: "c2", label: "B", background: true });
  mid.end();
  root.settle(a, { status: "completed", result: "done" });

  const next = new TaskRegistry(() => undefined);
  mid.attach(b, next);
  assert.equal(b.children, next);
  let calls = 0;
  root.subscribe(() => calls++);
  const s = bg(next, "c3");
  assert.equal(calls, 1);
  next.end();
  assert.equal(root.get(s.taskId), s);
});

test("cohort notification: once, re-open on late join, consumed excluded, silent when all consumed", () => {
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify));
  const r1 = bg(registry, "c", "one");
  const r2 = bg(registry, "c", "two");
  registry.settle(r1, { status: "completed", result: "1" });
  assert.deepEqual(notify, []);
  registry.consume(r2);
  registry.settle(r2, { status: "failed", result: "2" });
  assert.deepEqual(notify, ["Background tasks settled:\n" + registry.listLine(r1)]);
  registry.settle(r2, { status: "completed", result: "again" });
  assert.equal(notify.length, 1);

  const r3 = bg(registry, "c", "three");
  registry.settle(r3, { status: "completed", result: "3" });
  assert.deepEqual(notify.at(-1), "Background tasks settled:\n" + registry.listLine(r3));
  assert.equal(notify.length, 2);

  const r4 = bg(registry, "d");
  registry.consume(r4);
  registry.settle(r4, { status: "completed", result: "4" });
  const fg = registry.register({ kind: "script", cohort: "e", label: "f", background: false });
  registry.settle(fg, { status: "completed", result: "5" });
  assert.equal(notify.length, 2);
});

test("a settled cohort with no host keeps its rows for the next notification", () => {
  const notify: string[] = [];
  let host: HostSession | undefined;
  const registry = new TaskRegistry(() => host);
  const first = bg(registry, "c", "one");
  registry.settle(first, { status: "completed", result: "1" });
  assert.deepEqual(notify, []);
  assert.equal(first.consumed, false, "no host accepted the notification, so nothing is consumed");

  // The cohort's next notification lists the row no host ever received.
  host = hostRecording(notify);
  const second = bg(registry, "c", "two");
  registry.settle(second, { status: "completed", result: "2" });
  assert.deepEqual(notify, [
    "Background tasks settled:\n" + registry.listLine(first) + "\n" + registry.listLine(second),
  ]);
  assert.equal(first.consumed, true);
  assert.equal(second.consumed, true);
});

test("a host whose send throws leaves the rows for the cohort's next notification", () => {
  const notify: string[] = [];
  let refuse = true;
  const registry = new TaskRegistry(
    () =>
      ({
        notify: (message: string) => {
          if (refuse) throw new Error("This extension ctx is stale");
          notify.push(message);
        },
      }) as unknown as HostSession,
  );
  const first = bg(registry, "c", "one");
  const second = bg(registry, "c", "two");
  registry.settle(first, { status: "completed", result: "1" });
  registry.settle(second, { status: "completed", result: "2" });
  assert.deepEqual(notify, []);
  assert.equal(first.consumed, false, "a refused notification consumes nothing");
  assert.equal(second.consumed, false);

  // The cohort is not marked notified: its next notification lists every unconsumed row.
  const third = bg(registry, "c", "three");
  refuse = false;
  registry.settle(third, { status: "completed", result: "3" });
  assert.deepEqual(notify, [
    "Background tasks settled:\n" +
      [first, second, third].map((row) => registry.listLine(row)).join("\n"),
  ]);
  assert.equal(first.consumed, true);
  assert.equal(second.consumed, true);
  assert.equal(third.consumed, true);
});

test("a refused completion notification is reported once for its cohort (Section 5)", () => {
  const reported: string[] = [];
  const registry = new TaskRegistry(
    () => hostRecording([], true),
    undefined,
    (message) => reported.push(message),
  );
  const first = bg(registry, "c", "one");
  registry.settle(first, { status: "completed", result: "1" });
  assert.deepEqual(reported, ["task notification was not delivered: This extension ctx is stale"]);
  assert.equal(first.consumed, false, "a refused notification consumes nothing");

  // The cohort fails again on its next attempt, and is not reported twice.
  const second = bg(registry, "c", "two");
  registry.settle(second, { status: "completed", result: "2" });
  assert.equal(reported.length, 1, JSON.stringify(reported));

  // Another cohort of the same registry is its own report.
  const other = bg(registry, "d", "three");
  registry.settle(other, { status: "completed", result: "3" });
  assert.equal(reported.length, 2, JSON.stringify(reported));
});

test("a registry with no host reports its undelivered notification (Section 5)", () => {
  const reported: string[] = [];
  const registry = new TaskRegistry(
    () => undefined,
    undefined,
    (message) => reported.push(message),
  );
  const row = bg(registry, "c");
  registry.settle(row, { status: "completed", result: "1" });
  assert.deepEqual(reported, [
    "task notification was not delivered: no live session for the notification",
  ]);
  assert.equal(row.consumed, false);
});

test("a registry without a boot-window UI reports nothing itself (Section 5)", () => {
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify, true));
  const row = bg(registry, "c");
  registry.settle(row, { status: "completed", result: "1" });
  assert.equal(row.consumed, false);
  assert.equal(notify.length, 1, "only the refused send itself reached the host");
});

test("a refused interrupted notification is reported once (Section 5)", () => {
  const reported: string[] = [];
  const registry = new TaskRegistry(
    () => hostRecording([], true),
    undefined,
    (message) => reported.push(message),
  );
  const stuck = new AgentTaskRow({
    taskId: "aaaa0001",
    cohort: "c",
    label: "stuck",
    background: true,
    startedAt: 1_000,
  });
  stuck.status = "interrupted";
  stuck.settledAt = 6_000;
  registry.rebuild([stuck]);
  assert.deepEqual(reported, ["task notification was not delivered: This extension ctx is stale"]);
  assert.equal(stuck.consumed, false, "the interrupted notification consumes nothing");

  const other = new AgentTaskRow({
    taskId: "aaaa0002",
    cohort: "c",
    label: "stuck again",
    background: true,
    startedAt: 1_000,
  });
  other.status = "interrupted";
  other.settledAt = 6_000;
  registry.rebuild([other]);
  assert.equal(reported.length, 1, JSON.stringify(reported));
});

test("progress keeps the latest 1000 lines", () => {
  const registry = new TaskRegistry(() => undefined);
  const row = bg(registry, "c");
  for (let i = 0; i < PROGRESS_CAP + 5; i++) registry.progress(row, `l${i}`);
  assert.equal(row.progress.length, 1000);
  assert.equal(at(row.progress, 0).line, "l5");
  assert.equal(at(row.progress, row.progress.length - 1).line, `l${PROGRESS_CAP + 4}`);
});

test("a throwing listener does not affect the operation or other listeners", () => {
  const registry = new TaskRegistry(() => undefined);
  let calls = 0;
  registry.subscribe(() => {
    throw new Error("boom");
  });
  registry.subscribe(() => calls++);
  const row = bg(registry, "c");
  assert.equal(calls, 1);
  assert.equal(registry.get(row.taskId), row);
});

test("amend emits on a running row and is a no-op once settled", () => {
  const registry = new TaskRegistry(() => undefined);
  const row = bg(registry, "c", "old");
  let calls = 0;
  registry.subscribe(() => calls++);
  registry.amend(row, { label: "new" });
  assert.equal(row.label, "new");
  assert.equal(calls, 1);
  registry.amend(row, { label: "new" });
  assert.equal(calls, 1);
  registry.settle(row, { status: "completed", result: "" });
  registry.amend(row, { label: "later" });
  assert.equal(row.label, "new");
  assert.equal(calls, 2);
});

test("register sets the row's kind and its kind-specific fields (Section 2)", () => {
  const registry = new TaskRegistry(() => undefined);
  const agent = registry.register({ kind: "agent", cohort: "c", label: "a", background: true });
  const script = bg(registry, "c");
  assert.equal(agent.kind, "agent");
  assert.equal(script.kind, "script");
  assert.equal("children" in script, false, "a script row has no kind-specific field");
  registry.amend(agent, { model: "p/m" });
  assert.equal(agent.model, "p/m");
});

test("listLine uses the first line of the label", () => {
  const registry = new TaskRegistry(() => undefined);
  const row = bg(registry, "c", "first\nsecond");
  assert.equal(registry.listLine(row), `${row.taskId} · running · first`);
});

test("live is true until end and false after it (Section 1)", () => {
  const registry = new TaskRegistry(() => undefined);
  assert.equal(registry.live, true);
  registry.end();
  assert.equal(registry.live, false);
});

test("engine registry reset yields a new, live, empty registry", () => {
  const engine = new DispatchEngine(
    {} as BootSnapshot,
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const old = engine.registry;
  bg(old, "c");
  old.end();
  engine.resetRegistry();
  assert.notEqual(engine.registry, old);
  assert.equal(engine.registry.live, true);
  assert.deepEqual(engine.registry.list(), []);
});

test("browser kill: the cancel is recorded, consumes nothing, and the notification names it (Sections 3, 5)", () => {
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify));
  const row = bg(registry, "c", "stuck");
  let cancelled = 0;
  row.cancel = () => {
    cancelled++;
  };
  registry.cancel(row, true);
  assert.equal(cancelled, 1);
  assert.equal(row.browserKill, true);
  assert.equal(row.consumed, false, "a browser kill consumes nothing");
  assert.equal(row.status, "running");
  registry.settle(row, {
    status: "cancelled",
    result: "Command killed by the user from the task browser",
  });
  assert.deepEqual(notify, [
    `Background tasks settled:\n${registry.listLine(row)} · killed by the user from the task browser`,
  ]);
  assert.equal(row.consumed, true, "the completion notification consumes the row");
});

test("a browser-killed row that still completes gets no notification suffix (Section 5)", () => {
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify));
  const row = bg(registry, "c", "finishing");
  row.cancel = () => {};
  registry.cancel(row, true);
  registry.settle(row, { status: "completed", result: "done" });
  assert.deepEqual(notify, [`Background tasks settled:\n${registry.listLine(row)}`]);
});

test("a plain cancel is no browser kill and adds no notification suffix (Sections 3, 5)", () => {
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify));
  const row = bg(registry, "c", "plain");
  row.cancel = () => {};
  registry.cancel(row);
  assert.equal(row.browserKill, false);
  registry.settle(row, { status: "cancelled", result: "Command killed" });
  assert.deepEqual(notify, [`Background tasks settled:\n${registry.listLine(row)}`]);

  // A settled row's cancel is a no-op, the flag included.
  const settled = bg(registry, "d", "later");
  registry.settle(settled, { status: "completed", result: "x" });
  registry.cancel(settled, true);
  assert.equal(settled.browserKill, false);
});
