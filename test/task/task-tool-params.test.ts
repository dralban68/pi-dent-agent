import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { TaskRegistry } from "../../lib/registry.ts";
import type { ToolResult } from "../../lib/engine.ts";
import { makeTaskTool, taskParameterSchema } from "../../lib/tools.ts";

/** Task parameters per specs/task-tool.md#parameter-schema. */

const TIMEOUT_ERROR = 'timeout is only valid when action is "wait"';

function textOf(result: ToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === "text" ? first.text : "";
}

test("schema: action is required and one of read, kill, list, wait; no other property (specs/task-tool.md#parameter-schema)", () => {
  const schema = taskParameterSchema as unknown as {
    type: string;
    additionalProperties: boolean;
    required?: string[];
    properties: Record<string, { type?: string; pattern?: string; minimum?: number }>;
  };
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...(schema.required ?? [])].toSorted(), ["action"]);
  assert.deepEqual(Object.keys(schema.properties).toSorted(), ["action", "taskId", "timeout"]);

  for (const action of ["read", "kill", "list", "wait"]) {
    assert.equal(Value.Check(taskParameterSchema, { action }), true, `action ${action}`);
  }
  for (const bad of ["", " ", "READ", "delete", 1, null]) {
    assert.equal(
      Value.Check(taskParameterSchema, { action: bad }),
      false,
      `action ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(Value.Check(taskParameterSchema, {}), false, "action is required");
  assert.equal(Value.Check(taskParameterSchema, { action: "list", extra: 1 }), false);
});

test("schema: taskId carries the pattern \\S and nothing else (specs/task-tool.md#parameter-schema)", () => {
  const schema = taskParameterSchema as unknown as {
    properties: Record<string, { pattern?: string }>;
  };
  assert.equal(schema.properties.taskId?.pattern, "\\S");
  // The schema rejects a present taskId that is empty or white space.
  for (const bad of ["", " ", "\t\n"]) {
    assert.equal(
      Value.Check(taskParameterSchema, { action: "read", taskId: bad }),
      false,
      `taskId ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(Value.Check(taskParameterSchema, { action: "read", taskId: "aaaa0001" }), true);
  // "Exactly one of" and "only with wait" are cross-field, so they stay the tool's
  // check: the schema admits a taskId with list, omits none with read, kill, or
  // wait, and a timeout with any action.
  assert.equal(Value.Check(taskParameterSchema, { action: "list", taskId: "aaaa0001" }), true);
  assert.equal(Value.Check(taskParameterSchema, { action: "kill" }), true);
  assert.equal(Value.Check(taskParameterSchema, { action: "wait" }), true);
  assert.equal(Value.Check(taskParameterSchema, { action: "read", timeout: 100 }), true);
});

test("schema: timeout is an optional integer of 1 or more (specs/task-tool.md#parameter-schema)", () => {
  const schema = taskParameterSchema as unknown as {
    properties: Record<string, { type?: string; minimum?: number }>;
  };
  assert.equal(schema.properties.timeout?.type, "integer");
  assert.equal(schema.properties.timeout?.minimum, 1);
  assert.equal(Value.Check(taskParameterSchema, { action: "wait", timeout: 1 }), true);
  assert.equal(Value.Check(taskParameterSchema, { action: "wait", timeout: 600000 }), true);
  assert.equal(Value.Check(taskParameterSchema, { action: "wait", timeout: 2147483648 }), true);
  for (const bad of [0, -1, 1.5, "100", null]) {
    assert.equal(
      Value.Check(taskParameterSchema, { action: "wait", timeout: bad }),
      false,
      `timeout ${JSON.stringify(bad)}`,
    );
  }
});

test("tool checks: taskId is omitted with list, present with read, kill, and wait (specs/task-tool.md#parameter-schema)", async () => {
  const registry = new TaskRegistry(() => undefined);
  const tool = makeTaskTool({ registry: () => registry });

  const list = await tool.execute(
    "tc",
    { action: "list" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(list.isError, undefined);

  const withId = await tool.execute(
    "tc",
    { action: "list", taskId: "aaaa0001" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(withId.isError, true);
  assert.equal(textOf(withId), 'taskId must be omitted when action is "list"');

  for (const action of ["read", "kill", "wait"]) {
    const missing = await tool.execute(
      "tc",
      { action } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(missing.isError, true);
    assert.equal(textOf(missing), `taskId is required when action is "${action}"`);
  }
});

test("tool checks: timeout is rejected with a non-wait action, the first failure reported (specs/task-tool.md#parameter-schema)", async () => {
  const registry = new TaskRegistry(() => undefined);
  const tool = makeTaskTool({ registry: () => registry });
  const withTimeout = (action: string, extra: Record<string, unknown>) =>
    tool.execute(
      "tc",
      { action, timeout: 100, ...extra } as never,
      undefined,
      undefined,
      undefined as never,
    );
  const list = await withTimeout("list", {});
  assert.equal(list.isError, true);
  assert.equal(textOf(list), TIMEOUT_ERROR);
  // An unknown taskId would be the later check, so the timeout is reported first.
  for (const action of ["read", "kill"]) {
    const result = await withTimeout(action, { taskId: "aaaa0009" });
    assert.equal(result.isError, true, `action ${action}`);
    assert.equal(textOf(result), TIMEOUT_ERROR);
  }
  // The order of specs/task-tool.md#registration: a taskId with list is reported before the timeout.
  const both = await withTimeout("list", { taskId: "aaaa0001" });
  assert.equal(both.isError, true);
  assert.equal(textOf(both), 'taskId must be omitted when action is "list"');
});

test("tool checks: an unknown taskId is a tool error and no row is registered (specs/task-tool.md#parameter-schema)", async () => {
  const registry = new TaskRegistry(() => undefined);
  const tool = makeTaskTool({ registry: () => registry });
  for (const action of ["read", "kill"]) {
    const result = await tool.execute(
      "tc",
      { action, taskId: "aaaa0009" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'no task "aaaa0009" is owned by this session');
  }
  assert.equal(registry.list().length, 0, "Task registers no task row");
});
