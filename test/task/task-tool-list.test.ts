import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskRegistry } from "../../lib/registry.ts";
import { makeTaskTool } from "../../lib/tools.ts";

/** Task `list` per specs/task-tool.md Section 2.3. */

const reg = () => new TaskRegistry(() => undefined);

test("list of a session with no task is the single line (no tasks)", async () => {
  const registry = reg();
  const tool = makeTaskTool({ registry: () => registry });
  const result = await tool.execute(
    "tc",
    { action: "list" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "(no tasks)");
  assert.deepEqual(result.details, { action: "list", tasks: [] });
});

test("the list details carry the display label, the same label as the summary line", async () => {
  const registry = reg();
  const row = registry.register({
    kind: "agent",
    cohort: "c",
    label: "\u001b[31mred\u001b[0m\nsecond line",
    background: true,
  });
  const tool = makeTaskTool({ registry: () => registry });
  const result = await tool.execute(
    "tc",
    { action: "list" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    `${row.taskId} · running · red`,
  );
  assert.deepEqual(result.details, {
    action: "list",
    tasks: [{ taskId: row.taskId, status: "running", label: "red" }],
  });
});
