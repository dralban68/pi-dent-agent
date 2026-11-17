import assert from "node:assert/strict";
import { test } from "node:test";
import { themePaint } from "../../index.ts";

/** Widget theme paint per specs/task.md Section 4. */

const tagging = { fg: (name: string, text: string) => `<${name}>${text}</${name}>` };

test("an interrupted status line is painted warning, every other status accent", () => {
  const paint = themePaint(tagging);
  assert.equal(paint.status("s", "interrupted"), "<warning>s</warning>");
  assert.equal(paint.status("s", "running"), "<accent>s</accent>");
  assert.equal(paint.status("s", "completed"), "<accent>s</accent>");
  assert.equal(paint.status("s", "failed"), "<accent>s</accent>");
  assert.equal(paint.status("s", "cancelled"), "<accent>s</accent>");
});

test("the orphan, elapsed, and detail channels keep their theme colors", () => {
  const paint = themePaint(tagging);
  assert.equal(paint.orphan("o"), "<warning>o</warning>");
  assert.equal(paint.elapsed("e"), "<muted>e</muted>");
  assert.equal(paint.detail("d"), "<dim>d</dim>");
});
