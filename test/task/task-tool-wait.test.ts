import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentTaskRow, TaskRegistry } from "../../lib/registry.ts";
import { makeTaskTool } from "../../lib/tools.ts";

/** Task `wait` per specs/task-tool.md#wait. */

const reg = () => new TaskRegistry(() => undefined);

/** An interrupted background `agent` row as a rebuild inserts it. */
function interruptedRow(taskId: string): AgentTaskRow {
  const row = new AgentTaskRow({
    taskId,
    cohort: "c",
    label: "stuck",
    background: true,
    startedAt: 1_000,
  });
  row.status = "interrupted";
  row.settledAt = 6_000;
  return row;
}

/** The text of a tool result. */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

function wait(
  registry: TaskRegistry,
  params: { taskId: string; timeout?: number },
  signal?: AbortSignal,
) {
  const tool = makeTaskTool({ registry: () => registry });
  return tool.execute(
    "tc",
    { action: "wait", ...params } as never,
    signal,
    undefined,
    undefined as never,
  );
}

/** A `read` through the tool (for the follow-up read of the deadline test). */
function read(registry: TaskRegistry, taskId: string) {
  const tool = makeTaskTool({ registry: () => registry });
  return tool.execute(
    "tc",
    { action: "read", taskId } as never,
    undefined,
    undefined,
    undefined as never,
  );
}

test("wait on an already-settled row returns its read result at once and consumes it", async () => {
  const registry = reg();
  const row = registry.register({ kind: "script", cohort: "c", label: "done", background: true });
  registry.settle(row, { status: "failed", result: "line one\nline two" });
  const result = await wait(registry, { taskId: row.taskId });
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), "line one\nline two");
  assert.deepEqual(result.details, {
    action: "wait",
    taskId: row.taskId,
    status: "failed",
  });
  assert.equal(row.consumed, true, "the wait consumes a settled non-interrupted row");
  // Nothing will ever emit again: the wait returned instead of blocking on a wake.
});

test("wait on an already-settled row carries the row's resultPath and returns the same text as a read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-tool-wait-"));
  try {
    const resultPath = join(dir, "out.result.md");
    writeFileSync(resultPath, "only line\n");
    const registry = reg();
    const row = registry.register({ kind: "bash", cohort: "c", label: "emit", background: true });
    registry.settle(row, { status: "completed", result: "only line", resultPath });
    const result = await wait(registry, { taskId: row.taskId });
    assert.equal(
      textOf(result),
      `only line\nFull output: ${resultPath}`,
      "the wait returns the read preview",
    );
    assert.deepEqual(result.details, {
      action: "wait",
      taskId: row.taskId,
      status: "completed",
      resultPath,
    });
    assert.equal(row.consumed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wait on a running row blocks, then returns the settled result with action wait", async () => {
  const registry = reg();
  const row = registry.register({ kind: "script", cohort: "c", label: "spin", background: true });
  // Settlement only happens after the wait is pending: waking proves the block.
  setTimeout(() => registry.settle(row, { status: "completed", result: "settled output" }), 20);
  const result = await wait(registry, { taskId: row.taskId });
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), "settled output");
  assert.deepEqual(result.details, {
    action: "wait",
    taskId: row.taskId,
    status: "completed",
  });
  assert.equal(row.consumed, true, "the woken wait consumes the row");
});

test("wait expires at the deadline with the verbatim error and leaves the row running", async () => {
  const registry = reg();
  const row = registry.register({ kind: "script", cohort: "c", label: "spin", background: true });
  const result = await wait(registry, { taskId: row.taskId, timeout: 50 });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), `Task ${row.taskId} still running after 50ms`);
  assert.equal(row.status, "running", "the row is untouched by the expiry");
  assert.equal(row.consumed, false, "the row stays unconsumed");
  const followUp = await read(registry, row.taskId);
  assert.equal(textOf(followUp), "(running, no output yet)");
  assert.equal(followUp.isError, undefined);
});

test("wait on an interrupted row returns the resume line at once and does not consume", async () => {
  const registry = reg();
  const row = interruptedRow("aaaa0001");
  registry.rebuild([row]);
  const result = await wait(registry, { taskId: "aaaa0001" });
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), "(interrupted, resume with Agent resume=aaaa0001)");
  assert.deepEqual(result.details, {
    action: "wait",
    taskId: "aaaa0001",
    status: "interrupted",
  });
  assert.equal(row.consumed, false, "an interrupted row is never consumed");
});

test("wait with an unknown taskId is a tool error (specs/task-tool.md#parameter-schema)", async () => {
  const registry = reg();
  const result = await wait(registry, { taskId: "aaaa0009" });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'no task "aaaa0009" is owned by this session');
  assert.equal(registry.list().length, 0, "Task registers no task row");
});

test("an abort during wait ends the call with the abort result and leaves the row running", async () => {
  const registry = reg();
  const row = registry.register({ kind: "script", cohort: "c", label: "spin", background: true });
  const controller = new AbortController();
  const pending = wait(registry, { taskId: row.taskId, timeout: 600000 }, controller.signal);
  setTimeout(() => controller.abort(), 20);
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(textOf(result), "Operation aborted");
  assert.equal(row.status, "running", "the row stays as a deadline expiry leaves it");
  assert.equal(row.consumed, false);
  assert.equal(registry.get(row.taskId), row);
});

test("two concurrent waits on one taskId both wake at settlement", async () => {
  const registry = reg();
  const row = registry.register({ kind: "script", cohort: "c", label: "spin", background: true });
  const first = wait(registry, { taskId: row.taskId });
  const second = wait(registry, { taskId: row.taskId });
  registry.settle(row, { status: "failed", result: "boom" });
  const [one, two] = await Promise.all([first, second]);
  for (const result of [one, two]) {
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "boom");
    assert.deepEqual(result.details, {
      action: "wait",
      taskId: row.taskId,
      status: "failed",
    });
  }
  assert.equal(row.consumed, true, "consume is idempotent across the two wakes");
});

test("wait without a timeout expires after the default 600000ms (specs/task-tool.md#parameter-schema)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = reg();
  const row = registry.register({ kind: "script", cohort: "c", label: "spin", background: true });
  const pending = wait(registry, { taskId: row.taskId });
  t.mock.timers.tick(600_000);
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(textOf(result), `Task ${row.taskId} still running after 600000ms`);
  assert.equal(row.status, "running");
  assert.equal(row.consumed, false);
});

test("wait with a timeout above 2147483647 imposes no deadline (specs/task-tool.md#parameter-schema)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const registry = reg();
  const row = registry.register({ kind: "script", cohort: "c", label: "spin", background: true });
  const pending = wait(registry, { taskId: row.taskId, timeout: 2_147_483_648 });
  t.mock.timers.tick(86_400_000_000);
  registry.settle(row, { status: "completed", result: "finally" });
  const result = await pending;
  assert.equal(result.isError, undefined, "no deadline fired despite the tick");
  assert.equal(textOf(result), "finally");
  assert.deepEqual(result.details, {
    action: "wait",
    taskId: row.taskId,
    status: "completed",
  });
  assert.equal(row.consumed, true);
});
