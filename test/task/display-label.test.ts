import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostSession } from "../../lib/host.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import { makeTaskTool } from "../../lib/tools.ts";
import { at } from "../support/must.ts";

/** Display label per specs/task-registry.md#task-row: first line, ANSI escapes and control characters removed. */

const RAW_LABEL = "\x1b[31mBuild\x1b[0m step\x07\x01\tnow\nsecond line";
const DISPLAY_LABEL = "Build stepnow";

function registryWithNotifications(notify: string[]): TaskRegistry {
  const host = { notify: (message: string) => notify.push(message) } as unknown as HostSession;
  return new TaskRegistry(() => host);
}

test("Task list line uses the display label, not the raw label", async () => {
  const registry = registryWithNotifications([]);
  const row = registry.register({
    kind: "script",
    cohort: "c1",
    label: RAW_LABEL,
    background: false,
  });
  const tool = makeTaskTool({ registry: () => registry });
  const result = await tool.execute(
    "tc",
    { action: "list" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  // Without a task ledger the figures say so (specs/task-tool.md#list).
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.ok(text.startsWith(`${row.taskId} · running · `), text);
  assert.ok(text.endsWith(` · ledger unavailable · ${DISPLAY_LABEL}`), text);
  assert.equal(registry.listLine(row), `${row.taskId} · running · ${DISPLAY_LABEL}`);
});

test("completion notification lists each row by its display label", () => {
  const notify: string[] = [];
  const registry = registryWithNotifications(notify);
  const row = registry.register({
    kind: "script",
    cohort: "c2",
    label: RAW_LABEL,
    background: true,
  });
  registry.settle(row, { status: "completed", result: "done" });
  assert.deepEqual(notify, [
    `Background tasks settled:\n${row.taskId} · completed · ${DISPLAY_LABEL}`,
  ]);
  assert.ok(!at(notify, 0).includes("\x1b"));
  assert.ok(!at(notify, 0).includes("\x07"));
});
