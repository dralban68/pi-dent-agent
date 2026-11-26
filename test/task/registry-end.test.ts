import { test } from "node:test";
import assert from "node:assert/strict";
import type { BootSnapshot } from "../../lib/engine.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import { makeScriptTool } from "../../lib/script-tool.ts";
import type { HostSession } from "../../lib/host.ts";
import { collectTaskTree, renderTaskTree, startTaskWidget } from "../../lib/task-widget.ts";
import { at } from "../support/must.ts";

/**
 * Registry end and adoption conformance per specs/task-registry.md#registry-end:
 * running and unconsumed rows adopt into the nearest live registry of the attach chain,
 * else are cancelled; adopted rows keep identity and stay in the task tree.
 */

function fixture(): { root: TaskRegistry; notify: string[] } {
  const notify: string[] = [];
  const host = { notify: (message: string) => notify.push(message) } as unknown as HostSession;
  const root = new TaskRegistry(() => host);
  return { root, notify };
}

test("end adopts running rows into the live attacher", () => {
  const { root } = fixture();
  const agent = root.register({ kind: "agent", cohort: "c1", label: "agent", background: true });
  const child = new TaskRegistry(() => undefined);
  root.attach(agent, child);
  const script = child.register({ kind: "script", cohort: "c2", label: "spin", background: true });

  child.end();

  assert.equal(child.live, false);
  assert.equal(root.get(script.taskId), script);
  assert.deepEqual(root.list().at(-1), script);
  assert.equal(script.status, "running");
  assert.equal(script.cohort, "c2");
  assert.equal(script.consumed, false);
  assert.equal(script.orphan, true);
  assert.equal(agent.orphan, false);
  assert.deepEqual(child.list(), []);
});

test("end without a live attacher cancels every running row", () => {
  const root = new TaskRegistry(() => undefined);
  const row = root.register({ kind: "script", cohort: "c", label: "s", background: true });
  const cancelled: string[] = [];
  row.cancel = () => cancelled.push(row.taskId);

  root.end();

  assert.equal(root.live, false);
  assert.deepEqual(cancelled, [row.taskId]);
});

test("end adopts through a dead intermediate registry", () => {
  const { root } = fixture();
  const outer = root.register({ kind: "agent", cohort: "c1", label: "outer", background: true });
  const mid = new TaskRegistry(() => undefined);
  root.attach(outer, mid);
  const inner = mid.register({ kind: "agent", cohort: "c2", label: "inner", background: true });
  const leaf = new TaskRegistry(() => undefined);
  mid.attach(inner, leaf);
  const script = leaf.register({ kind: "script", cohort: "c3", label: "spin", background: true });

  mid.end(); // adopts inner into root
  assert.equal(root.get(inner.taskId), inner);
  leaf.end(); // root is now leaf's attacher

  assert.equal(root.get(script.taskId), script);
  assert.equal(script.status, "running");
});

test("settle and progress on an adopted row are changes of the adopting registry", () => {
  const { root, notify } = fixture();
  const events: string[] = [];
  root.subscribe(() => events.push("change"));

  const agent = root.register({ kind: "agent", cohort: "c1", label: "agent", background: true });
  const child = new TaskRegistry(() => undefined);
  root.attach(agent, child);
  const script = child.register({ kind: "script", cohort: "c2", label: "spin", background: true });
  root.consume(agent); // the agent's result returns to its caller
  root.settle(agent, { status: "completed", result: "done" });
  child.end();

  const before = events.length;
  child.progress(script, "tick 1");
  child.settle(script, { status: "completed", result: "ok" });

  assert.ok(events.length > before);
  assert.equal(script.status, "completed");
  assert.equal(at(script.progress, script.progress.length - 1).line, "tick 1");
  assert.deepEqual(notify, ["Background tasks settled:\n" + root.listLine(script)]);
});

test("register into an ended registry fails the invocation", () => {
  const root = new TaskRegistry(() => undefined);
  root.end();
  assert.throws(() =>
    root.register({ kind: "script", cohort: "c", label: "s", background: false }),
  );
});

test("a tool call into a registry that is not live is a tool error naming it (specs/task-registry.md#ownership)", async () => {
  const root = new TaskRegistry(() => undefined);
  root.end();
  const tool = makeScriptTool({
    boot: {} as unknown as BootSnapshot,
    registry: () => root,
    hostProvider: () => undefined,
    cohortFor: () => "cohort-1",
    agentDir: () => "unused",
  });
  const result = await tool.execute(
    "call-1",
    { code: "1" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(result.isError, true);
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    "Script error: task registry is not live: the owning session has ended",
  );
  assert.deepEqual(root.list(), [], "no row is registered");
});

test("the widget keeps showing an adopted task after its agent settles", () => {
  const { root } = fixture();
  const sets: Array<string | undefined> = [];
  const handle = startTaskWidget(root, {
    setWidget: (_key, factory) => sets.push(factory ? "set" : undefined),
  });

  const agent = root.register({
    kind: "agent",
    cohort: "c1",
    label: "spin a script",
    background: true,
  });
  const child = new TaskRegistry(() => undefined);
  root.attach(agent, child);
  const script = child.register({
    kind: "script",
    cohort: "c2",
    label: "spin 120s",
    background: true,
  });

  root.settle(agent, { status: "completed", result: "done" });
  child.end();

  assert.equal(sets.at(-1), "set");
  const lines = renderTaskTree(collectTaskTree(root), Date.now(), 100) ?? [];
  assert.equal(lines.length, 1);
  assert.match(at(lines, 0), new RegExp(`^${script.taskId} · script · bg · orphan · running`));

  handle.stop();
});

test("the paint colors the status, orphan, and elapsed segments", () => {
  const { root } = fixture();
  const agent = root.register({ kind: "agent", cohort: "c1", label: "agent", background: true });
  const child = new TaskRegistry(() => undefined);
  root.attach(agent, child);
  const script = child.register({ kind: "script", cohort: "c2", label: "spin", background: true });
  root.consume(agent);
  root.settle(agent, { status: "completed", result: "done" });
  child.end();

  const paint = {
    status: (text: string, status: string) => `<${status}:${text}>`,
    orphan: (text: string) => `[${text}]`,
    elapsed: (text: string) => `{${text}}`,
  };
  const lines =
    renderTaskTree(collectTaskTree(root), script.startedAt + 10_000, 100, {
      status: (text, status) => paint.status(text, status),
      orphan: (text) => paint.orphan(text),
      elapsed: (text) => paint.elapsed(text),
      detail: (text) => text,
    }) ?? [];

  assert.equal(
    lines[0],
    `${script.taskId} · script · bg · [orphan] · <running:running> · {10s} · spin`,
  );
});

test("end adopts unconsumed settled rows; their cohort notifies from the adopting registry", () => {
  const { root, notify } = fixture();
  const agent = root.register({ kind: "agent", cohort: "c1", label: "agent", background: false });
  const child = new TaskRegistry(() => undefined);
  root.attach(agent, child);
  const done = child.register({ kind: "script", cohort: "c2", label: "done", background: true });
  const spin = child.register({ kind: "script", cohort: "c2", label: "spin", background: true });
  const fg = child.register({ kind: "script", cohort: "c3", label: "fg", background: false });
  child.settle(done, { status: "completed", result: "ok" });
  child.settle(fg, { status: "completed", result: "ok" });

  child.end();

  assert.equal(root.get(done.taskId), done);
  assert.equal(done.orphan, true);
  assert.equal(root.get(fg.taskId), undefined, "consumed rows stay in the ended registry");
  child.settle(spin, { status: "completed", result: "ok" });
  assert.deepEqual(notify, [
    "Background tasks settled:\n" + root.listLine(done) + "\n" + root.listLine(spin),
  ]);
});

test("a child registry notifies its own session", () => {
  const sent: string[] = [];
  const child = new TaskRegistry(
    () => ({ notify: (message: string) => sent.push(message) }) as unknown as HostSession,
  );
  const row = child.register({ kind: "script", cohort: "c", label: "bg", background: true });
  child.settle(row, { status: "completed", result: "ok" });
  assert.deepEqual(sent, ["Background tasks settled:\n" + child.listLine(row)]);
});

test("taskIds stay unique across registries", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const registry = new TaskRegistry(() => undefined);
    ids.add(
      registry.register({ kind: "script", cohort: "c", label: "x", background: false }).taskId,
    );
    ids.add(
      registry.register({ kind: "script", cohort: "c", label: "y", background: false }).taskId,
    );
  }
  assert.equal(ids.size, 100);
});
