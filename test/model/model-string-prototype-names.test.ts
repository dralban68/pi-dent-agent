import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveModelString } from "../../lib/model-string.ts";

/**
 * Model string resolution per specs/model-string.md#model-classes: a class name that only names an
 * `Object.prototype` property resolves as an unknown class, and an own class of that name still
 * resolves through its mapping.
 */

test("a class named like an Object.prototype property resolves as not-configured via the fallback", () => {
  const ctx = {
    classes: { fallback: { provider: "test", id: "model" } } as Record<string, unknown>,
    inventory: [{ provider: "test", id: "model" }],
    attributeClassPath: () => "conf",
  };
  for (const name of ["constructor", "toString", "hasOwnProperty"]) {
    const resolved = resolveModelString(name, ctx);
    assert.deepEqual(
      resolved.descriptor,
      { provider: "test", id: "model" },
      `class "${name}" falls back instead of resolving an inherited property`,
    );
  }
});

test("an own class named like an Object.prototype property still resolves through its mapping", () => {
  const ctx = {
    classes: { constructor: { provider: "test", id: "model" } } as Record<string, unknown>,
    inventory: [{ provider: "test", id: "model" }],
    attributeClassPath: () => "conf",
  };
  const resolved = resolveModelString("constructor", ctx);
  assert.deepEqual(resolved.descriptor, { provider: "test", id: "model" });
});
