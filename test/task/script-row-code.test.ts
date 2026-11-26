import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskRegistry } from "../../lib/registry.ts";

/** The `code` field of a `script` row (specs/task-registry.md#task-row). */

const reg = () => new TaskRegistry(() => undefined);

test("script row: register sets code to the given script source", () => {
  const root = reg();
  const row = root.register({
    kind: "script",
    cohort: "c",
    label: "demo",
    background: true,
    code: "const a = 1;\nconsole.log(a);",
  });
  assert.equal(row.code, "const a = 1;\nconsole.log(a);");
});

test("script row: register without code leaves code empty", () => {
  const root = reg();
  const row = root.register({ kind: "script", cohort: "c", label: "demo", background: false });
  assert.equal(row.code, "");
});

test("bash row: register sets command and leaves code alone", () => {
  const root = reg();
  const row = root.register({
    kind: "bash",
    cohort: "c",
    label: "sh",
    background: true,
    command: "echo hi",
  });
  assert.equal(row.command, "echo hi");
  assert.equal("code" in row, false);
});
