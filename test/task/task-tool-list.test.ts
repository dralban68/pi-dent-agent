import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentTaskRow, TaskRegistry, type TaskRow } from "../../lib/registry.ts";
import type { TaskLedger } from "../../lib/task-ledger.ts";
import {
  childScope,
  LedgerHolder,
  LedgerTap,
  NestedCalls,
  type LedgerScope,
} from "../../lib/task-ledger-wiring.ts";
import type { ToolResult } from "../../lib/engine.ts";
import { makeTaskTool } from "../../lib/tools.ts";
import { openLedger, raw, usage } from "../task-ledger/support.ts";

/** Task `list` per specs/task-tool.md#list, its figures from the task ledger. */

function scopeOf(ledger: TaskLedger | undefined): LedgerScope {
  const holder = new LedgerHolder();
  holder.ledger = ledger;
  return { holder, sessionId: () => "main", cwd: () => "/work", calls: new NestedCalls() };
}

const registryOf = (scope: LedgerScope | undefined) =>
  new TaskRegistry(
    () => undefined,
    undefined,
    undefined,
    scope === undefined ? undefined : new LedgerTap(scope),
  );

async function list(registry: TaskRegistry, ledger?: TaskLedger): Promise<ToolResult> {
  const tool = makeTaskTool({ registry: () => registry, ledger: () => ledger });
  return tool.execute("tc", { action: "list" } as never, undefined, undefined, undefined as never);
}

const textOf = (result: ToolResult): string =>
  result.content[0]?.type === "text" ? result.content[0].text : "";

const settledMs = (row: TaskRow): number => (row.settledAt ?? 0) - row.startedAt;

test("list of a session with no task is the single line (no tasks), with no ledger read", async () => {
  const result = await list(registryOf(undefined));
  assert.equal(textOf(result), "(no tasks)");
  assert.deepEqual(result.details, { action: "list", tasks: [] });
});

test("an ok read shows elapsed, own turns and cost, the total with descendants, and the display label", async () => {
  const { ledger } = openLedger();
  const scope = scopeOf(ledger);
  const registry = registryOf(scope);
  const parent = registry.register({
    kind: "agent",
    cohort: "c",
    label: "\u001b[31mred\u001b[0m\nsecond line",
    background: true,
  });
  registry.amend(parent, { usage: usage(10, 1, 0.042, 12), toolCalls: 5 });
  // A dispatch's child session files its rows under the dispatch's row (task-ledger.md 3.1).
  const children = registryOf(childScope(scope, parent, () => "/child"));
  const child = children.register({
    kind: "agent",
    cohort: "k",
    label: "inner",
    background: false,
  });
  children.amend(child, { usage: usage(5, 1, 0.076, 1) });
  children.settle(child, { status: "completed" });
  const script = registry.register({ kind: "script", cohort: "c", label: "s", background: false });
  registry.amend(script, { toolCalls: 2 });
  registry.settle(script, { status: "completed" });
  registry.settle(parent, { status: "completed" });

  const result = await list(registry, ledger);
  const elapsed = (row: TaskRow) => `${Math.floor(settledMs(row) / 1000)}s`;
  assert.equal(
    textOf(result),
    [
      `${parent.taskId} · completed · ${elapsed(parent)} · 12 turns · $0.042 · total $0.118 · red`,
      `${script.taskId} · completed · ${elapsed(script)} · s`,
    ].join("\n"),
  );
  const details = result.details as { ledger: string; tasks: Array<Record<string, unknown>> };
  assert.equal(details.ledger, "ok");
  assert.deepEqual(details.tasks[0], {
    taskId: parent.taskId,
    status: "completed",
    label: "red",
    durationMs: settledMs(parent),
    usage: usage(10, 1, 0.042, 12),
    total: usage(15, 2, 0.042 + 0.076, 13),
    descendantMs: settledMs(child),
    toolCalls: 5,
  });
  assert.deepEqual(details.tasks[1], {
    taskId: script.taskId,
    status: "completed",
    label: "s",
    durationMs: settledMs(script),
    usage: usage(0, 0, 0, 0),
    total: usage(0, 0, 0, 0),
    descendantMs: 0,
    toolCalls: 2,
  });
  // A one-turn agent row says `turn`.
  const one = await list(children, ledger);
  assert.match(textOf(one), / · 1 turn · \$0\.076 · inner$/);
  ledger.close();
});

test("details carry no toolCalls for a bash row, never 0", async () => {
  const { ledger } = openLedger();
  const registry = registryOf(scopeOf(ledger));
  const bash = registry.register({ kind: "bash", cohort: "c", label: "b", background: false });
  const result = await list(registry, ledger);
  const details = result.details as { ledger: string; tasks: Array<Record<string, unknown>> };
  assert.equal(details.ledger, "ok");
  const entry = details.tasks.find((task) => task.taskId === bash.taskId) ?? {};
  assert.equal("usage" in entry, true, "the row has a ledger row");
  assert.equal("toolCalls" in entry, false);
  ledger.close();
});

test("a row registered without the ledger shows no ledger row and carries no figures", async () => {
  const { ledger } = openLedger();
  const registry = registryOf(scopeOf(undefined));
  const row = registry.register({ kind: "bash", cohort: "c", label: "b", background: false });
  const result = await list(registry, ledger);
  assert.match(textOf(result), new RegExp(`^${row.taskId} · running · \\d+s · no ledger row · b$`));
  const details = result.details as { ledger: string; tasks: Array<Record<string, unknown>> };
  assert.equal(details.ledger, "ok");
  assert.deepEqual(Object.keys(details.tasks[0] ?? {}).toSorted(), [
    "durationMs",
    "label",
    "status",
    "taskId",
  ]);
  ledger.close();
});

test("an unusable ledger shows ledger unavailable for every row, never zeros", async () => {
  const { ledger, path } = openLedger();
  await ledger.flushed();
  const db = raw(path);
  db.exec("DROP TABLE tasks");
  db.close();
  const registry = registryOf(scopeOf(ledger));
  registry.register({ kind: "agent", cohort: "c", label: "a", background: false });
  await ledger.flushed();
  assert.notEqual(ledger.unusableReason(), undefined, "the failed insert made it unusable");
  registry.register({ kind: "bash", cohort: "c", label: "b", background: false });
  const result = await list(registry, ledger);
  const lines = textOf(result).split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, / · \d+s · ledger unavailable · [ab]$/);
  const details = result.details as { ledger: string; tasks: Array<Record<string, unknown>> };
  assert.equal(details.ledger, "unavailable");
  assert.equal(details.tasks[0]?.usage, undefined);
});

test("a read abandoned at the read deadline shows ledger busy for every row", async () => {
  const { ledger, path } = openLedger({ readDeadlineMs: 50 });
  const registry = registryOf(scopeOf(ledger));
  const row = registry.register({ kind: "agent", cohort: "c", label: "a", background: false });
  assert.ok(row instanceof AgentTaskRow);
  await ledger.flushed();
  const lock = raw(path);
  lock.exec("BEGIN IMMEDIATE");
  try {
    // A write waiting for the lock holds back the read behind it (specs/task-ledger.md#concurrent-access).
    registry.register({ kind: "bash", cohort: "c", label: "b", background: false });
    const result = await list(registry, ledger);
    assert.match(
      textOf(result),
      new RegExp(`^${row.taskId} · running · \\d+s · ledger busy · a\n`),
    );
    assert.match(textOf(result), / · ledger busy · b$/);
    assert.equal((result.details as { ledger: string }).ledger, "busy");
  } finally {
    lock.exec("COMMIT");
    lock.close();
  }
  await ledger.flushed();
  ledger.close();
});
