import assert from "node:assert/strict";
import { test } from "node:test";
import { STEP_LIMITS, searchRuntime, type LoweredStepLimits } from "../../lib/search-tool.ts";
import { SMALL_LIMITS } from "./support.ts";

/**
 * specs/search-tool.md#step-limits and specs/search-tool.md#test-seam: the step limits a runtime
 * built without `limits` uses, and the lowered values the seam admits or refuses.
 */

// specs/search-tool.md#step-limits: the real limits stay checked, whatever the tests lower.
test("a runtime built without limits uses the step limits of the spec's table", () => {
  assert.deepEqual(
    { ...STEP_LIMITS },
    {
      fileModeLines: 200000,
      windowRows: 100000,
      pageRows: 256,
      groupRows: 50000,
      groupChunkRows: 20000,
      collectionRows: 20000,
      collectionChunkItems: 200000,
      firstLookupMatches: 2000,
      probeByIdRows: 1000,
    },
  );
});

// specs/search-tool.md#test-seam
test("the test seam admits a lowered set that keeps the order of the table", () => {
  assert.doesNotThrow(() => searchRuntime({ zone: "UTC", limits: SMALL_LIMITS }));
  assert.doesNotThrow(() => searchRuntime({ zone: "UTC", limits: {} }));
  // One limit lowered alone, within the order the others keep.
  assert.doesNotThrow(() => searchRuntime({ zone: "UTC", limits: { probeByIdRows: 1 } }));
});

// specs/search-tool.md#test-seam
test("the test seam refuses a value that breaks a rule, naming the limit", () => {
  const cases: { limits: LoweredStepLimits; names: string }[] = [
    { limits: { probeByIdRows: 0 }, names: "probeByIdRows" },
    { limits: { probeByIdRows: 1.5 }, names: "probeByIdRows" },
    { limits: { firstLookupMatches: 2001 }, names: "firstLookupMatches" },
    { limits: { ...SMALL_LIMITS, groupRows: 256 }, names: "groupRows" },
    { limits: { ...SMALL_LIMITS, windowRows: 300 }, names: "windowRows" },
    { limits: { ...SMALL_LIMITS, fileModeLines: 600 }, names: "fileModeLines" },
    { limits: { ...SMALL_LIMITS, groupChunkRows: 300 }, names: "groupChunkRows" },
    { limits: { ...SMALL_LIMITS, collectionRows: 300 }, names: "collectionRows" },
    { limits: { ...SMALL_LIMITS, firstLookupMatches: 40 }, names: "firstLookupMatches" },
    { limits: { ...SMALL_LIMITS, probeByIdRows: 20 }, names: "probeByIdRows" },
    { limits: { ...SMALL_LIMITS, collectionChunkItems: 40 }, names: "collectionChunkItems" },
    { limits: { ...SMALL_LIMITS, collectionChunkItems: 1201 }, names: "collectionChunkItems" },
    { limits: { ...SMALL_LIMITS, groupChunkRows: 10 }, names: "groupChunkRows" },
    // The real collection chunk is above a lowered `fileModeLines`.
    { limits: { fileModeLines: 150000 }, names: "fileModeLines" },
  ];
  for (const { limits, names } of cases) {
    assert.throws(
      () => searchRuntime({ zone: "UTC", limits }),
      (error: unknown) => error instanceof RangeError && error.message.includes(names),
      JSON.stringify(limits),
    );
  }
});
