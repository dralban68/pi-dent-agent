import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelGuidance } from "../../lib/model-guidance.ts";
import type { BootConfig } from "../../lib/config.ts";
import { at } from "../support/must.ts";

/**
 * The `modelGuidance` object of specs/model-guidance.md Section 1: its unknown keys follow
 * specs/config-file.md Section 2, one diagnostic naming each key and the file of its layer.
 */

function configWithMerged(merged: Record<string, unknown>): BootConfig {
  return {
    merged,
    layers: {
      project: { path: "/proj/pi-dent.conf", values: {} },
      global: { path: "/global/pi-dent.conf", values: {} },
    },
    projectRoot: "/proj",
    diagnostics: [],
    liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
  } as unknown as BootConfig;
}

test("parseModelGuidance reports unknown top-level keys exactly once, naming all of them", () => {
  const config = configWithMerged({
    modelGuidance: { billing: true, models: {}, modls: 1, rulez: [] },
  });
  const { diagnostics } = parseModelGuidance(config);
  assert.equal(diagnostics.length, 1);
  assert.match(at(diagnostics, 0), /unknown keys modls, rulez ignored/u);
  assert.match(at(diagnostics, 0), /\/proj\/pi-dent\.conf/u);
});

test("parseModelGuidance reports no unknown keys for billing, models, and rules", () => {
  const config = configWithMerged({
    modelGuidance: { billing: true, models: { "a/b": { when: "x" } }, rules: [] },
  });
  const { diagnostics } = parseModelGuidance(config);
  assert.deepEqual(diagnostics, []);
});
