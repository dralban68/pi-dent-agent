import assert from "node:assert/strict";
import { test } from "node:test";
import { type BootConfig } from "../../lib/config.ts";
import {
  checkThinkingSupport,
  ModelStringError,
  modelClassDiagnostics,
  parseModelString,
  resolveModelString,
  serializeDescriptor,
  validateModelClasses,
} from "../../lib/model-string.ts";
import { at } from "../support/must.ts";

test("model string: `:<level>` final segment is the thinking suffix", () => {
  assert.deepEqual(parseModelString("anthropic/claude:high"), {
    selector: { kind: "concrete", provider: "anthropic", id: "claude" },
    thinking: "high",
  });
  assert.deepEqual(parseModelString("balanced:low"), {
    selector: { kind: "class", name: "balanced" },
    thinking: "low",
  });
});

test("model string: a non-level final segment is model identity", () => {
  assert.deepEqual(parseModelString("openrouter/qwen/qwen3:free"), {
    selector: { kind: "concrete", provider: "openrouter", id: "qwen/qwen3:free" },
    thinking: undefined,
  });
  assert.deepEqual(parseModelString("openrouter/qwen/qwen3:free:max").thinking, "max");
});

test("model string: rejects class names with `:` and the old `thinking=` form", () => {
  assert.throws(() => parseModelString("balanced:fast"), { code: "invalid-plan" });
  assert.throws(() => parseModelString("balanced:thinking=high"), { code: "invalid-plan" });
});

test("model string: canonical serialization round-trips", () => {
  const descriptor = { provider: "litellm", id: "a/b:free", thinking: "xhigh" as const };
  const text = serializeDescriptor(descriptor);
  assert.equal(text, "litellm/a/b:free:xhigh");
  const parsed = parseModelString(text);
  assert.deepEqual(parsed, {
    selector: { kind: "concrete", provider: "litellm", id: "a/b:free" },
    thinking: "xhigh",
  });
});

test("model string: object form rejects provider containing `/` with invalid-plan", () => {
  const problems = validateModelClasses({
    testClass: { provider: "a/b", id: "x" },
  });
  assert.equal(problems.length, 1);
  assert.match(at(problems, 0), /empty provider, model, or thinking component/);

  assert.throws(
    () =>
      resolveModelString("testClass", {
        classes: { testClass: { provider: "a/b", id: "x" } },
        inventory: [{ provider: "a/b", id: "x" }],
        attributeClassPath: () => "conf",
      }),
    (err: unknown) =>
      err instanceof ModelStringError &&
      err.code === "invalid-plan" &&
      err.message.includes("empty provider, model, or thinking component"),
  );
});

test("model string: thinking support matches pi rules", () => {
  const modelWithoutMap = { provider: "anthropic", id: "claude-3-7-sonnet", reasoning: true };
  const ctxWithoutMap = {
    classes: undefined,
    inventory: [modelWithoutMap],
    attributeClassPath: () => "conf",
  };

  // xhigh on reasoning model without map entry → unsupported-thinking
  assert.throws(
    () => checkThinkingSupport(modelWithoutMap, "xhigh"),
    (err: unknown) => err instanceof ModelStringError && err.code === "unsupported-thinking",
  );
  assert.throws(
    () => resolveModelString("anthropic/claude-3-7-sonnet:xhigh", ctxWithoutMap),
    (err: unknown) => err instanceof ModelStringError && err.code === "unsupported-thinking",
  );

  // xhigh with map entry "x" → ok
  const modelWithMap = {
    provider: "anthropic",
    id: "claude-3-7-sonnet",
    reasoning: true,
    thinkingLevelMap: { xhigh: "x" },
  };
  const ctxWithMap = {
    classes: undefined,
    inventory: [modelWithMap],
    attributeClassPath: () => "conf",
  };
  assert.doesNotThrow(() => checkThinkingSupport(modelWithMap, "xhigh"));
  const resolvedXhigh = resolveModelString("anthropic/claude-3-7-sonnet:xhigh", ctxWithMap);
  assert.equal(resolvedXhigh.descriptor.thinking, "xhigh");

  // "high" on reasoning model without map → ok
  assert.doesNotThrow(() => checkThinkingSupport(modelWithoutMap, "high"));
  const resolvedHigh = resolveModelString("anthropic/claude-3-7-sonnet:high", ctxWithoutMap);
  assert.equal(resolvedHigh.descriptor.thinking, "high");
});

test("model string: an empty inventory matches nothing (missing-model, fallback applies)", () => {
  const ctx = {
    classes: undefined,
    inventory: [] as { provider: string; id: string }[],
    attributeClassPath: () => "conf",
  };
  assert.throws(
    () => resolveModelString("anthropic/claude", ctx),
    (err: unknown) => err instanceof ModelStringError && err.code === "missing-model",
  );
  assert.throws(
    () => resolveModelString("balanced", ctx),
    (err: unknown) => err instanceof ModelStringError && err.code === "missing-model-class",
  );
  const withFallback = {
    ...ctx,
    classes: { fallback: "anthropic/claude" },
  };
  assert.throws(
    () => resolveModelString("balanced", withFallback),
    (err: unknown) => err instanceof ModelStringError && err.code === "missing-model",
  );
});

test("model string: an inventory that matches one `provider/id` twice fails with ambiguous-model, never falling back", () => {
  const duplicate = [
    { provider: "p", id: "m" },
    { provider: "p", id: "m" },
  ];
  const ctx = {
    classes: { fallback: "q/fb" },
    inventory: [...duplicate, { provider: "q", id: "fb" }],
    attributeClassPath: () => "conf",
  };
  assert.throws(
    () => resolveModelString("p/m", ctx),
    (err: unknown) =>
      err instanceof ModelStringError &&
      err.code === "ambiguous-model" &&
      err.message.includes('"p/m" matches 2 inventory models: p/m, p/m'),
    "the candidates are listed as provider/id pairs (Section 4.1) and the fallback class is not consulted: ambiguity is not a no-match (Section 4.3)",
  );
});

test("model string: grammar violations and ambiguity never fall back (model-string.md Section 4.3)", () => {
  const ctx = {
    classes: { fallback: "q/fb" },
    inventory: [
      { provider: "q", id: "fb" },
      { provider: "p", id: "m" },
      { provider: "p", id: "m" },
    ],
    attributeClassPath: () => "conf",
  };
  assert.throws(
    () => resolveModelString("balanced:anthropic/claude", ctx),
    (err: unknown) => err instanceof ModelStringError && err.code === "invalid-plan",
  );
  assert.throws(
    () => resolveModelString("p/m", ctx),
    (err: unknown) => err instanceof ModelStringError && err.code === "ambiguous-model",
  );
});

test("model string: an explicit thinking suffix overrides the fallback mapping's thinking", () => {
  const ctx = {
    classes: { fallback: "q/fb:low" },
    inventory: [{ provider: "q", id: "fb", reasoning: true }],
    attributeClassPath: () => "conf",
  };
  assert.deepEqual(resolveModelString("missing/model:high", ctx).descriptor, {
    provider: "q",
    id: "fb",
    thinking: "high",
  });
  assert.deepEqual(resolveModelString("unmapped-class", ctx).descriptor, {
    provider: "q",
    id: "fb",
    thinking: "low",
  });
});

test("model string: a fallback that fails fails with its own error, not the original no-match", () => {
  // The fallback mapping carries a level its model does not support (Section 4.4).
  const unsupported = {
    classes: { fallback: "q/fb:xhigh" },
    inventory: [{ provider: "q", id: "fb", reasoning: true }],
    attributeClassPath: () => "conf",
  };
  assert.throws(
    () => resolveModelString("missing/model", unsupported),
    (err: unknown) =>
      err instanceof ModelStringError &&
      err.code === "unsupported-thinking" &&
      err.message.includes("q/fb") &&
      err.message.includes("xhigh"),
  );
  // A malformed fallback mapping is invalid-plan, again not the original missing-model.
  const malformed = { ...unsupported, classes: { fallback: 123 } };
  assert.throws(
    () => resolveModelString("missing/model", malformed),
    (err: unknown) => err instanceof ModelStringError && err.code === "invalid-plan",
  );
});

test("model class: a thinking suffix on the class reference overrides the mapping's thinking", () => {
  const ctx = {
    classes: { fast: "p/m:low", structured: { provider: "p", id: "m", thinking: "low" } },
    inventory: [{ provider: "p", id: "m", reasoning: true }],
    attributeClassPath: () => "conf",
  };
  assert.deepEqual(resolveModelString("fast:high", ctx).descriptor, {
    provider: "p",
    id: "m",
    thinking: "high",
  });
  assert.deepEqual(resolveModelString("structured:medium", ctx).descriptor, {
    provider: "p",
    id: "m",
    thinking: "medium",
  });
  // Without a suffix the mapping's configured thinking applies (Section 4.4 precedence).
  assert.deepEqual(resolveModelString("fast", ctx).descriptor, {
    provider: "p",
    id: "m",
    thinking: "low",
  });
});

test("model class: an unconfigured or invalid sibling class does not block the referenced class", () => {
  const ctx = {
    classes: { good: "p/m", broken: 123, empty: "" },
    inventory: [{ provider: "p", id: "m" }],
    attributeClassPath: () => "conf",
  };
  assert.deepEqual(resolveModelString("good", ctx).descriptor, { provider: "p", id: "m" });
});

test("model class: an unknown descriptor field is one boot diagnostic and the class still resolves", () => {
  const config: BootConfig = {
    merged: { modelClasses: { fast: { provider: "p", id: "m", extra: 1 } } },
    layers: {
      global: { path: "/global/pi-dent.conf", values: { modelClasses: { fast: { extra: 1 } } } },
      project: {
        path: "/proj/pi-dent.conf",
        values: { modelClasses: { fast: { provider: "p", id: "m" } } },
      },
    },
    projectRoot: "/proj",
    diagnostics: [],
    liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
  };
  assert.deepEqual(
    modelClassDiagnostics(config),
    ["config: /global/pi-dent.conf: modelClasses.fast: unknown keys extra ignored"],
    "the field is attributed to the layer that declares it",
  );

  const resolved = resolveModelString("fast", {
    classes: { fast: { provider: "p", id: "m", extra: 1 } },
    inventory: [{ provider: "p", id: "m" }],
    attributeClassPath: () => "conf",
  });
  assert.deepEqual(resolved.descriptor, { provider: "p", id: "m" });
});
