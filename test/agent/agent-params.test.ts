import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { agentParameterSchema } from "../../lib/tools.ts";

/** Agent parameters per specs/agent-tool.md Section 1.1. */

test("schema: object, no property but the seven, task is the only required one", () => {
  const schema = agentParameterSchema as unknown as {
    type: string;
    additionalProperties: boolean;
    required?: string[];
    properties: Record<string, { type?: string }>;
  };
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...(schema.required ?? [])].toSorted(), ["task"]);
  assert.deepEqual(Object.keys(schema.properties).toSorted(), [
    "agent",
    "background",
    "cwd",
    "model",
    "prompt",
    "resume",
    "task",
  ]);
  assert.equal(schema.properties.background?.type, "boolean");
  assert.equal(Value.Check(agentParameterSchema, { task: "go", background: "yes" }), false);
  assert.equal(Value.Check(agentParameterSchema, { task: "go", extra: 1 }), false);
  assert.equal(Value.Check(agentParameterSchema, {}), false, "task is required");
});

test("schema: task has minLength 1; a whitespace-only task is valid (Section 1.1)", () => {
  const schema = agentParameterSchema as unknown as {
    properties: Record<string, { minLength?: number }>;
  };
  assert.equal(schema.properties.task?.minLength, 1);
  assert.equal(Value.Check(agentParameterSchema, { task: "" }), false);
  assert.equal(Value.Check(agentParameterSchema, { task: " " }), true);
  assert.equal(Value.Check(agentParameterSchema, { task: "go" }), true);
});

test("schema: agent, prompt, model, and resume carry the pattern \\S (Section 1.1)", () => {
  const schema = agentParameterSchema as unknown as {
    properties: Record<string, { pattern?: string }>;
  };
  for (const field of ["agent", "prompt", "model", "resume"]) {
    assert.equal(schema.properties[field]?.pattern, "\\S", `${field} pattern`);
    for (const bad of ["", " ", "\t\n"]) {
      assert.equal(
        Value.Check(agentParameterSchema, { task: "go", [field]: bad }),
        false,
        `${field} ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(
      Value.Check(agentParameterSchema, { task: "go", [field]: "x" }),
      true,
      `${field} non-blank`,
    );
  }
});

test("schema: a blank cwd is admitted; the tool treats it as absent (Section 1.1)", () => {
  for (const blank of ["", " ", "\t\n"]) {
    assert.equal(Value.Check(agentParameterSchema, { task: "go", cwd: blank }), true);
  }
});

test("schema: exactly one of agent and prompt is cross-field, so the tool keeps it (Section 1.1)", () => {
  const base = { task: "go" };
  assert.equal(Value.Check(agentParameterSchema, { ...base, agent: "a", prompt: "p" }), true);
  assert.equal(Value.Check(agentParameterSchema, base), true);
});
