import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentTaskRow, PROGRESS_CAP, ScriptTaskRow, TaskRegistry } from "../../lib/registry.ts";
import { makeTaskTool } from "../../lib/tools.ts";
import { at } from "../support/must.ts";

/**
 * Task row fields per specs/task-registry.md Section 2: timestamped progress
 * entries, the `agent` kind fields (`agent`, `task`, `sessionPath`), and the
 * `Task` `read` projection of progress lines (task-tool.md Section 2.2).
 */

const reg = () => new TaskRegistry(() => undefined);

function scriptRow(registry: TaskRegistry): ScriptTaskRow {
  return registry.register({ kind: "script", cohort: "c", label: "s", background: true });
}

test("progress entries carry the append time and keep the latest 1000", () => {
  const registry = reg();
  const row = scriptRow(registry);
  const before = Date.now();
  registry.progress(row, "first");
  const after = Date.now();
  assert.equal(at(row.progress, 0).line, "first");
  assert.ok(at(row.progress, 0).at >= before && at(row.progress, 0).at <= after);

  for (let i = 0; i < PROGRESS_CAP + 5; i++) registry.progress(row, `l${i}`);
  assert.equal(row.progress.length, PROGRESS_CAP);
  assert.equal(at(row.progress, 0).line, "l5");
  assert.equal(at(row.progress, row.progress.length - 1).line, `l${PROGRESS_CAP + 4}`);
  for (let i = 1; i < row.progress.length; i++) {
    assert.ok(at(row.progress, i).at >= at(row.progress, i - 1).at);
  }
});

test("progress on a settled row is a no-op and does not emit", () => {
  const registry = reg();
  const row = scriptRow(registry);
  registry.progress(row, "one");
  registry.settle(row, { status: "completed", result: "done" });
  let calls = 0;
  registry.subscribe(() => calls++);
  registry.progress(row, "two");
  assert.deepEqual(
    row.progress.map((entry) => entry.line),
    ["one"],
  );
  assert.equal(calls, 0);
});

test("agent rows register the task text; other kinds carry no agent fields", () => {
  const registry = reg();
  const withTask = registry.register({
    kind: "agent",
    cohort: "c",
    label: "a",
    background: true,
    task: "do the thing",
  });
  assert.ok(withTask instanceof AgentTaskRow);
  assert.equal(withTask.task, "do the thing");
  assert.equal(withTask.agent, undefined);
  assert.equal(withTask.model, undefined);
  assert.equal(withTask.sessionPath, undefined);

  const withoutTask = registry.register({
    kind: "agent",
    cohort: "c",
    label: "b",
    background: true,
  });
  assert.equal(withoutTask.task, undefined);

  const script = scriptRow(registry);
  for (const key of ["agent", "task", "model", "sessionPath", "children"]) {
    assert.equal(key in script, false, key);
  }
});

test("amend sets agent, model, label, and sessionPath with one change event", () => {
  const registry = reg();
  const row = registry.register({
    kind: "agent",
    cohort: "c",
    label: "old",
    background: true,
  });
  let calls = 0;
  registry.subscribe(() => calls++);

  registry.amend(row, {
    agent: "reviewer",
    model: "anthropic/claude:high",
    label: "reviewer — review",
    sessionPath: "/tmp/session.jsonl",
  });
  assert.equal(row.agent, "reviewer");
  assert.equal(row.model, "anthropic/claude:high");
  assert.equal(row.label, "reviewer — review");
  assert.equal(row.sessionPath, "/tmp/session.jsonl");
  assert.equal(calls, 1);

  registry.amend(row, {
    agent: "reviewer",
    model: "anthropic/claude:high",
    label: "reviewer — review",
    sessionPath: "/tmp/session.jsonl",
  });
  assert.equal(calls, 1, "unchanged fields do not emit");

  registry.settle(row, { status: "completed", result: "ok" });
  const settledCalls = calls;
  registry.amend(row, { agent: "later", label: "later" });
  assert.equal(row.agent, "reviewer");
  assert.equal(row.label, "reviewer — review");
  assert.equal(calls, settledCalls, "amend on a settled row is a no-op");
});

test("Task read of a running row joins progress lines, else reports no output yet", async () => {
  const registry = reg();
  const row = scriptRow(registry);
  const tool = makeTaskTool({ registry: () => registry });
  const read = async (taskId: string) => {
    const result = await tool.execute(
      "tc",
      { action: "read", taskId } as never,
      undefined,
      undefined,
      undefined as never,
    );
    return result.content[0]?.type === "text" ? result.content[0].text : "";
  };

  assert.equal(await read(row.taskId), "(running, no output yet)");
  registry.progress(row, "alpha");
  registry.progress(row, "beta");
  assert.equal(await read(row.taskId), "alpha\nbeta");
});
