import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskRegistry } from "../../lib/registry.ts";
import { writeRunningRecord } from "../../lib/task-record.ts";
import { makeTaskTool } from "../../lib/tools.ts";

/** Task `kill` per specs/task-tool.md Section 2.2. */

const reg = () => new TaskRegistry(() => undefined);

/** The text of a tool result. */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

async function kill(registry: TaskRegistry, taskId: string) {
  const tool = makeTaskTool({ registry: () => registry });
  return tool.execute(
    "tc",
    { action: "kill", taskId } as never,
    undefined,
    undefined,
    undefined as never,
  );
}

test("kill of a running row requests cancellation and reports its status", async () => {
  const registry = reg();
  const row = registry.register({ kind: "script", cohort: "c", label: "spin", background: true });
  let cancelled = 0;
  row.cancel = () => {
    cancelled++;
  };
  const result = await kill(registry, row.taskId);
  assert.equal(textOf(result), `Task ${row.taskId} kill requested (running).`);
  assert.deepEqual(result.details, { action: "kill", taskId: row.taskId, status: "running" });
  assert.equal(cancelled, 1, "the cancellation handler is invoked");
  assert.equal(row.consumed, true, "the kill consumes the row");
  assert.equal(row.status, "running", "settlement stays the owning contract's, and asynchronous");
});

test("kill of a running row with no handler consumes it, leaves it running, and keeps its record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-tool-kill-"));
  try {
    const registry = reg();
    const row = registry.register({ kind: "agent", cohort: "c", label: "a", background: true });
    const recordPath = writeRunningRecord(dir, {
      taskId: row.taskId,
      agent: "agent-a",
      label: "a",
      cohort: "c",
      startedAt: 1_000,
      sessionPath: join(dir, "s.jsonl"),
    });
    row.recordPath = recordPath;
    const result = await kill(registry, row.taskId);
    assert.equal(textOf(result), `Task ${row.taskId} kill requested (running).`);
    assert.equal(row.consumed, true);
    assert.equal(row.status, "running", "a row with no cancellation handler is left running");
    // A running row keeps its record; the later settlement rewrites it (task-record.md Section 2).
    assert.equal(existsSync(recordPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
