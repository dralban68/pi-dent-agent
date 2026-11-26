import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SUPPORTED_ROOT_KEYS, readConfig, type BootConfig } from "../../lib/config.ts";
import { hostFromContext } from "../../lib/engine.ts";
import {
  guidanceActive,
  guidanceContent,
  guidedModels,
  isGuidedDispatch,
  modelCatalog,
  parseModelGuidance,
  sessionRules,
  type GuidedModel,
  type ModelGuidance,
} from "../../lib/model-guidance.ts";
import { type InventoryModel } from "../../lib/model-string.ts";
import { errorMessage } from "../../lib/util.ts";
import { at } from "../support/must.ts";

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
  };
}

function configWith(modelGuidance: unknown): BootConfig {
  return configWithMerged({ modelGuidance });
}

/** Parsed guidance of one `modelGuidance` configuration, failing the test on any diagnostic. */
function guidanceOf(
  models: Record<string, { when: string }>,
  rules: Array<{ match: string; rule: string }> = [],
): ModelGuidance {
  const { guidance, diagnostics } = parseModelGuidance(configWith({ models, rules }));
  assert.deepEqual(diagnostics, [], JSON.stringify(diagnostics));
  return guidance;
}

function withIsolatedEnv<T>(fn: (ctx: { home: string; project: string }) => T): T {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-test-home-"));
  const project = mkdtempSync(join(tmpdir(), "pi-dent-test-project-"));
  const origHome = process.env.HOME;
  const origIdle = process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS;
  const origAbs = process.env.PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS;

  process.env.HOME = home;
  delete process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS;
  delete process.env.PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS;

  try {
    return fn({ home, project });
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;

    if (origIdle === undefined) delete process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS;
    else process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS = origIdle;

    if (origAbs === undefined) delete process.env.PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS;
    else process.env.PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS = origAbs;

    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

function writeConf(root: string, content: string): string {
  const dir = join(root, ".pi", "pi-dent");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "pi-dent.conf");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

function unterminatedGroupError(): string {
  const source = "(";
  try {
    new RegExp(source, "u");
  } catch (error) {
    return errorMessage(error);
  }
  throw new Error('expected new RegExp(source, "u") to throw');
}

test("parseModelGuidance: absent modelGuidance yields no entries, no rules, and no diagnostics", () => {
  assert.deepEqual(parseModelGuidance(configWithMerged({})), {
    guidance: { entries: [], rules: [] },
    billing: true,
    diagnostics: [],
  });
});

test("parseModelGuidance: valid parse with models and rules", () => {
  const { guidance, diagnostics } = parseModelGuidance(
    configWith({
      models: {
        "anthropic/claude-opus-4-5:high": { when: "design and code review" },
        "google/gemini-3-flash": { when: "  mechanical edits  " },
      },
      rules: [{ match: "flash|haiku", rule: "  verify its output before relying on it  " }],
    }),
  );
  assert.deepEqual(diagnostics, []);
  assert.equal(guidanceActive(guidance, [{ provider: "google", id: "gemini-3-flash" }]), true);
  assert.equal(guidanceActive(guidance, []), false);
  const available: InventoryModel[] = [
    { provider: "anthropic", id: "claude-opus-4-5", reasoning: true },
    { provider: "google", id: "gemini-3-flash" },
  ];
  assert.equal(
    modelCatalog(guidance, available),
    "- anthropic/claude-opus-4-5:high: design and code review\n- google/gemini-3-flash: mechanical edits",
    "each `when` is used trimmed and the key in canonical serialization (Sections 2 and 6)",
  );
  assert.deepEqual(
    sessionRules(guidance, "google/gemini-3-flash"),
    ["verify its output before relying on it"],
    "the rule text is used trimmed and matched unanchored against `provider/id` (specs/model-guidance.md#session-rules)",
  );
  assert.deepEqual(sessionRules(guidance, "anthropic/claude-opus-4-5"), []);
});

test("parseModelGuidance: rules are ECMAScript regular expressions with the `u` flag and no other flag", () => {
  const { guidance, diagnostics } = parseModelGuidance(
    configWith({
      rules: [
        { match: "\\p{Lu}", rule: "first letter capitalized" },
        { match: "Flash", rule: "capitalized name" },
      ],
    }),
  );
  assert.deepEqual(diagnostics, [], "`\\p{Lu}` compiles only under the `u` flag");
  assert.deepEqual(sessionRules(guidance, "Anthropic/claude"), ["first letter capitalized"]);
  assert.deepEqual(
    sessionRules(guidance, "google/gemini-3-flash"),
    [],
    "no `i` flag: `Flash` does not match `flash`",
  );
  assert.deepEqual(sessionRules(guidance, "google/gemini-3-Flash"), [
    "first letter capitalized",
    "capitalized name",
  ]);
});

test("parseModelGuidance: non-object modelGuidance → one diagnostic, inactive", () => {
  for (const value of [["a"], "x", null, 5]) {
    const { guidance, diagnostics } = parseModelGuidance(configWith(value));
    assert.deepEqual(guidance, { entries: [], rules: [] }, JSON.stringify(value));
    assert.deepEqual(
      diagnostics,
      ["config: modelGuidance must be an object; ignored (/proj/pi-dent.conf)"],
      JSON.stringify(value),
    );
  }
});

test("parseModelGuidance: non-object models → one diagnostic, ignored", () => {
  for (const value of ["nope", ["a"], 123]) {
    const { guidance, diagnostics } = parseModelGuidance(configWith({ models: value }));
    assert.deepEqual(guidance.entries, []);
    assert.deepEqual(diagnostics, [
      "config: modelGuidance.models must be an object; ignored (/proj/pi-dent.conf)",
    ]);
  }
});

test("parseModelGuidance: non-array rules → one diagnostic, ignored", () => {
  for (const value of ["nope", { a: 1 }, 123]) {
    const { guidance, diagnostics } = parseModelGuidance(configWith({ rules: value }));
    assert.deepEqual(guidance.rules, []);
    assert.deepEqual(diagnostics, [
      "config: modelGuidance.rules must be an array; ignored (/proj/pi-dent.conf)",
    ]);
  }
});

test("parseModelGuidance: bad model entries report exactly once, skip, and sibling loads", () => {
  const cases: Array<[key: string, value: unknown, reason: string]> = [
    ["fast", { when: "w" }, "key must be a concrete selector, not a class reference"],
    ["invalid::key", { when: "w" }, 'invalid model selector: invalid class name "invalid::key"'],
    ["a//b", { when: "w" }, "invalid model selector: empty provider, model, or thinking component"],
    ["a/b", { when: "   " }, '"when" must be a non-empty string'],
    ["a/c", {}, '"when" must be a non-empty string'],
    ["a/d", { when: 123 }, '"when" must be a non-empty string'],
    ["a/e", "not-an-object", "entry must be an object"],
  ];

  for (const [key, value, reason] of cases) {
    const { guidance, diagnostics } = parseModelGuidance(
      configWith({
        models: {
          "good/model": { when: "good when" },
          [key]: value,
        },
      }),
    );
    assert.deepEqual(
      guidance.entries.map((e) => e.key),
      ["good/model"],
      key,
    );
    assert.deepEqual(
      diagnostics,
      [`config: modelGuidance.models.${key}: ${reason}; skipped (/proj/pi-dent.conf)`],
      key,
    );
  }
});

test("parseModelGuidance: a models key that duplicates an earlier one after trimming is reported once and skipped", () => {
  const { guidance, diagnostics } = parseModelGuidance(
    configWith({
      models: {
        " a/b ": { when: "first when" },
        "a/b": { when: "second when" },
        "a/b:high": { when: "thinking when" },
      },
    }),
  );
  // Trimming makes the first two keys the same model; the first wins, and the
  // thinking level keeps the third distinct (specs/model-guidance.md#configuration).
  assert.deepEqual(
    guidance.entries.map((entry) => [entry.key, entry.when]),
    [
      ["a/b", "first when"],
      ["a/b:high", "thinking when"],
    ],
  );
  assert.deepEqual(diagnostics, [
    `config: modelGuidance.models.a/b: duplicate of " a/b " after trimming; skipped (/proj/pi-dent.conf)`,
  ]);
});

test("parseModelGuidance: a project key equal after trimming to a global key wins the conflict", () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(
      home,
      JSON.stringify({ modelGuidance: { models: { "p/m": { when: "global when" } } } }),
    );
    writeConf(
      project,
      JSON.stringify({ modelGuidance: { models: { " p/m ": { when: "project when" } } } }),
    );
    const config = readConfig(project);
    assert.deepEqual(config.diagnostics, []);
    const { guidance, diagnostics } = parseModelGuidance(config);
    assert.deepEqual(
      guidance.entries.map((entry) => [entry.key, entry.when]),
      [["p/m", "project when"]],
      "the project layer wins every conflict (specs/config-file.md#merge)",
    );
    assert.equal(diagnostics.length, 1, "the skipped key is reported once");
  });
});

test("parseModelGuidance: within one layer the first key of its own order loads, not the merged order", () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(
      home,
      JSON.stringify({ modelGuidance: { models: { "p/m": { when: "global when" } } } }),
    );
    const projectFile = writeConf(
      project,
      JSON.stringify({
        modelGuidance: {
          models: { " p/m ": { when: "project first" }, "p/m": { when: "project second" } },
        },
      }),
    );
    const config = readConfig(project);
    assert.deepEqual(config.diagnostics, []);
    const { guidance, diagnostics } = parseModelGuidance(config);
    // The merged object holds "p/m" at the global layer's position, so the merged order
    // would load "project second"; the project layer's own order loads "project first".
    assert.equal(
      modelCatalog(guidance, [{ provider: "p", id: "m" }]),
      "- p/m: project first",
      "the project layer's first key is the one that loads (specs/model-guidance.md#configuration)",
    );
    assert.deepEqual(diagnostics, [
      `config: modelGuidance.models.p/m: duplicate of " p/m " after trimming; skipped (${projectFile})`,
    ]);
  });
});

test("parseModelGuidance: bad rules report exactly once, skip, and sibling loads", () => {
  const cases: Array<[index: number, value: unknown, reason: string]> = [
    [
      1,
      { match: "(", rule: "r" },
      `invalid "match" regular expression: ${unterminatedGroupError()}`,
    ],
    [1, { match: "m", rule: "   " }, '"rule" must be a non-empty string'],
    [1, { match: "m" }, '"rule" must be a non-empty string'],
    [1, { match: "m", rule: 123 }, '"rule" must be a non-empty string'],
    [1, { rule: "r" }, '"match" must be a string'],
    [1, { match: 123, rule: "r" }, '"match" must be a string'],
    [1, "not-an-object", "rule must be an object"],
  ];

  for (const [_idx, value, reason] of cases) {
    const { guidance, diagnostics } = parseModelGuidance(
      configWith({
        rules: [{ match: "good", rule: "good rule" }, value],
      }),
    );
    assert.deepEqual(
      guidance.rules.map((r) => r.rule),
      ["good rule"],
      reason,
    );
    assert.deepEqual(
      diagnostics,
      [`config: modelGuidance.rules[1]: ${reason}; skipped (/proj/pi-dent.conf)`],
      reason,
    );
  }
});

test("parseModelGuidance: an unknown field in a model entry or rule is one diagnostic and the entry loads", () => {
  const { guidance, diagnostics } = parseModelGuidance(
    configWith({
      models: { "a/f": { when: "w", extra: 1, another: 2 } },
      rules: [{ match: "m", rule: "r", extra: 1 }],
    }),
  );
  assert.deepEqual(
    guidance.entries.map((e) => e.key),
    ["a/f"],
  );
  assert.deepEqual(
    guidance.rules.map((r) => r.rule),
    ["r"],
  );
  assert.deepEqual(diagnostics, [
    "config: /proj/pi-dent.conf: modelGuidance.models.a/f: unknown keys extra, another ignored",
    "config: /proj/pi-dent.conf: modelGuidance.rules[0]: unknown keys extra ignored",
  ]);
});

test("parseModelGuidance: an unknown model-entry field names the file of its own layer", () => {
  const config: BootConfig = {
    merged: { modelGuidance: { models: { "a/f": { when: "w", globalOnly: 1, fromProject: 2 } } } },
    layers: {
      global: {
        path: "/global/pi-dent.conf",
        values: { modelGuidance: { models: { "a/f": { globalOnly: 1 } } } },
      },
      project: {
        path: "/proj/pi-dent.conf",
        values: { modelGuidance: { models: { "a/f": { when: "w", fromProject: 2 } } } },
      },
    },
    projectRoot: "/proj",
    diagnostics: [],
    liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
  };
  const { diagnostics } = parseModelGuidance(config);
  assert.deepEqual(diagnostics, [
    "config: modelGuidance.models.a/f: unknown keys globalOnly (/global/pi-dent.conf), fromProject (/proj/pi-dent.conf) ignored",
  ]);
});

test("parseModelGuidance attributes a bad global model entry and rule to global pi-dent.conf", () => {
  withIsolatedEnv(({ home, project }) => {
    const globalFile = writeConf(
      home,
      JSON.stringify({
        modelGuidance: {
          models: {
            fast: { when: "fast class" },
          },
          rules: [{ match: "(", rule: "broken" }],
        },
      }),
    );
    writeConf(
      project,
      JSON.stringify({
        modelGuidance: {
          models: {
            "p/proj": { when: "proj when" },
          },
        },
      }),
    );

    const config = readConfig(project);
    assert.deepEqual(config.diagnostics, []);
    const { guidance, diagnostics } = parseModelGuidance(config);
    assert.deepEqual(
      guidance.entries.map((e) => e.key),
      ["p/proj"],
    );
    assert.deepEqual(diagnostics, [
      `config: modelGuidance.models.fast: key must be a concrete selector, not a class reference; skipped (${globalFile})`,
      `config: modelGuidance.rules[0]: invalid "match" regular expression: ${unterminatedGroupError()}; skipped (${globalFile})`,
    ]);
  });
});

test("rules-only → inactive but sessionRules still returns matches", () => {
  const { guidance, diagnostics } = parseModelGuidance(
    configWith({
      rules: [{ match: "flash|haiku", rule: "verify fast model output" }],
    }),
  );
  assert.deepEqual(diagnostics, []);
  assert.equal(guidanceActive(guidance, [{ provider: "google", id: "gemini-3-flash" }]), false);
  assert.deepEqual(sessionRules(guidance, "google/gemini-3-flash"), ["verify fast model output"]);
  assert.deepEqual(sessionRules(guidance, "anthropic/claude-3-5-haiku:low"), [
    "verify fast model output",
  ]);
  assert.deepEqual(sessionRules(guidance, "anthropic/claude-opus-4-5"), []);
  assert.deepEqual(sessionRules(guidance, undefined), []);
});

test("guided-model omission: not available; unsupported thinking; no runtime → []", () => {
  const guidance = guidanceOf({
    "anthropic/claude-opus-4-5:high": { when: "review" },
    "google/gemini-3-flash": { when: "edits" },
    "openai/gpt-5:high": { when: "complex reasoning" },
    "missing/model": { when: "does not exist" },
  });

  // an empty inventory guides nothing
  assert.deepEqual(guidedModels(guidance, []), []);

  const available: InventoryModel[] = [
    // anthropic/claude-opus-4-5 with reasoning: false (does not support high thinking)
    { provider: "anthropic", id: "claude-opus-4-5", reasoning: false },
    // google/gemini-3-flash (unleveled, available)
    { provider: "google", id: "gemini-3-flash" },
    // openai/gpt-5 (leveled high, reasoning: true, supports high)
    { provider: "openai", id: "gpt-5", reasoning: true },
  ];

  const guided = guidedModels(guidance, available);
  assert.deepEqual(guided, [
    { model: "google/gemini-3-flash", provider: "google", id: "gemini-3-flash", when: "edits" },
    {
      model: "openai/gpt-5:high",
      provider: "openai",
      id: "gpt-5",
      thinking: "high",
      when: "complex reasoning",
    },
  ]);
});

test("a guided model carries the parsed provider, model id, and thinking level of its key", () => {
  const guidance = guidanceOf({
    "openai/gpt-5:high": { when: "hard" },
    "google/flash": { when: "quick" },
  });
  const guided = guidedModels(guidance, [
    { provider: "openai", id: "gpt-5", reasoning: true },
    { provider: "google", id: "flash" },
  ]);
  assert.deepEqual(
    guided.map((g) => ({ model: g.model, provider: g.provider, id: g.id, thinking: g.thinking })),
    [
      { model: "google/flash", provider: "google", id: "flash", thinking: undefined },
      { model: "openai/gpt-5:high", provider: "openai", id: "gpt-5", thinking: "high" },
    ],
  );
  // A key without a thinking level yields a record without the field.
  assert.equal("thinking" in at(guided, 0), false);
});

test("guided-model thinking support is decided by model-string Section 4.4 alone", () => {
  const leveled = (thinking: "high" | "xhigh", id: string): ModelGuidance =>
    guidanceOf({ [`openai/${id}:${thinking}`]: { when: "w" } });
  // Neither flag nor level map: only `off` is supported, so `:high` is omitted.
  assert.deepEqual(
    guidedModels(leveled("high", "plain"), [{ provider: "openai", id: "plain" }]),
    [],
  );
  // An explicit `reasoning: false` behaves the same.
  assert.deepEqual(
    guidedModels(leveled("high", "plain"), [{ provider: "openai", id: "plain", reasoning: false }]),
    [],
  );
  // With the flag, `high` is supported.
  assert.deepEqual(
    guidedModels(leveled("high", "plain"), [{ provider: "openai", id: "plain", reasoning: true }]),
    [{ model: "openai/plain:high", provider: "openai", id: "plain", thinking: "high", when: "w" }],
  );
  // A level map setting the level to null removes it even with the flag.
  assert.deepEqual(
    guidedModels(leveled("high", "plain"), [
      { provider: "openai", id: "plain", reasoning: true, thinkingLevelMap: { high: null } },
    ]),
    [],
  );
  // `xhigh` needs the map to define it non-null.
  assert.deepEqual(
    guidedModels(leveled("xhigh", "plain"), [{ provider: "openai", id: "plain", reasoning: true }]),
    [],
  );
  assert.deepEqual(
    guidedModels(leveled("xhigh", "plain"), [
      { provider: "openai", id: "plain", reasoning: true, thinkingLevelMap: { xhigh: "max" } },
    ]),
    [
      {
        model: "openai/plain:xhigh",
        provider: "openai",
        id: "plain",
        thinking: "xhigh",
        when: "w",
      },
    ],
  );
});

test("modelCatalog / guidanceContent exact strings", () => {
  const multi = guidanceOf({
    "anthropic/claude-opus-4-5:high": { when: "design and code review" },
    "google/gemini-3-flash": { when: "mechanical edits" },
  });
  assert.equal(
    modelCatalog(multi, [
      { provider: "anthropic", id: "claude-opus-4-5", reasoning: true },
      { provider: "google", id: "gemini-3-flash" },
    ]),
    "- anthropic/claude-opus-4-5:high: design and code review\n- google/gemini-3-flash: mechanical edits",
  );
  assert.equal(modelCatalog(multi, []), "");

  const available: InventoryModel[] = [
    { provider: "anthropic", id: "claude-opus-4-5", reasoning: true },
    { provider: "google", id: "gemini-3-flash" },
  ];

  // guidanceContent: empty guidance → ""
  assert.equal(guidanceContent(guidanceOf({}), available, "google/gemini-3-flash"), "");

  // guidanceContent: rules-only content
  const rulesOnly = guidanceOf({}, [{ match: "flash", rule: "verify flash output" }]);
  assert.equal(
    guidanceContent(rulesOnly, available, "google/gemini-3-flash"),
    "verify flash output",
  );
  assert.equal(guidanceContent(rulesOnly, available, "anthropic/claude-opus-4-5"), "");

  // guidanceContent: active models only
  const activeOnly = guidanceOf({ "google/gemini-3-flash": { when: "quick edits" } });
  // The model catalog stays out of the message (specs/model-guidance.md#guidance-message): without billing, no content.
  assert.equal(modelCatalog(activeOnly, available), "- google/gemini-3-flash: quick edits");
  assert.equal(guidanceContent(activeOnly, available, "google/gemini-3-flash"), "");
  assert.equal(guidanceContent(activeOnly, [], "google/gemini-3-flash"), "");

  // guidanceContent: both sections; the session model is canonical `provider/id` (specs/model-guidance.md#session-rules)
  const both = guidanceOf(
    { "anthropic/claude-opus-4-5:high": { when: "design and code review" } },
    [{ match: "opus", rule: "opus rule 1" }],
  );
  assert.equal(guidanceContent(both, available, "anthropic/claude-opus-4-5"), "opus rule 1");
});

test("isGuidedDispatch: leveled vs unleveled matching", () => {
  const guided: GuidedModel[] = guidedModels(
    guidanceOf({
      "google/gemini-3-flash": { when: "edits" },
      "anthropic/claude-opus-4-5:high": { when: "review" },
    }),
    [
      { provider: "google", id: "gemini-3-flash" },
      { provider: "anthropic", id: "claude-opus-4-5", reasoning: true },
    ],
  );

  // Unleveled guided model matches any thinking including undefined
  assert.equal(isGuidedDispatch(guided, "google", "gemini-3-flash", undefined), true);
  assert.equal(isGuidedDispatch(guided, "google", "gemini-3-flash", "low"), true);
  assert.equal(isGuidedDispatch(guided, "google", "gemini-3-flash", "high"), true);
  assert.equal(isGuidedDispatch(guided, "google", "gemini-3-flash", "off"), true);

  // Leveled guided model matches only its exact level
  assert.equal(isGuidedDispatch(guided, "anthropic", "claude-opus-4-5", "high"), true);
  assert.equal(isGuidedDispatch(guided, "anthropic", "claude-opus-4-5", "low"), false);
  assert.equal(isGuidedDispatch(guided, "anthropic", "claude-opus-4-5", undefined), false);
  assert.equal(isGuidedDispatch(guided, "anthropic", "claude-opus-4-5", "off"), false);

  // Non-matching model
  assert.equal(isGuidedDispatch(guided, "other", "model", undefined), false);
});

test('"modelGuidance" is a supported root key: readConfig reports no unknown-key warning', () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(
      home,
      JSON.stringify({
        modelGuidance: {
          models: { "p/m": { when: "w" } },
        },
      }),
    );
    const config = readConfig(project);
    assert.deepEqual(config.diagnostics, []);
    assert.ok(SUPPORTED_ROOT_KEYS.includes("modelGuidance"));
  });
});

test("host configuredModels lists only the configured provider; guidance content uses it", () => {
  // A host whose inventory has two providers, only one of them configured
  // (specs/model-guidance.md#guided-models): `inventory()` is the full registered
  // list, `configuredModels()` only the authenticated one.
  const ctx = {
    cwd: "/w",
    model: { provider: "p", id: "configured", contextWindow: 100 },
    thinkingLevel: undefined,
    sessionManager: {
      getSessionId: () => "s",
      getSessionFile: () => undefined,
      getSessionDir: () => "/w",
    },
    modelRegistry: {
      getAll: () => [
        { provider: "p", id: "configured" },
        { provider: "q", id: "unconfigured" },
      ],
      getAvailable: () => [{ provider: "p", id: "configured" }],
    },
  };
  const pi = { getActiveTools: () => ["Agent"], sendMessage: () => {} };
  const host = hostFromContext(pi as never, ctx as never);

  assert.deepEqual(
    host.inventory().map((m) => `${m.provider}/${m.id}`),
    ["p/configured", "q/unconfigured"],
  );
  assert.deepEqual(
    (host.configuredModels() ?? []).map((m) => `${m.provider}/${m.id}`),
    ["p/configured"],
  );

  // Guidance content is computed from the configured models: the guided model
  // on the unauthenticated provider is absent, so nothing is listed.
  const { guidance } = parseModelGuidance(
    configWith({ models: { "q/unconfigured": { when: "q has no auth" } } }),
  );
  assert.equal(modelCatalog(guidance, host.configuredModels() ?? []), "");
  assert.match(modelCatalog(guidance, host.inventory()), /q\/unconfigured/);
});

test("model catalog computed with configured models differs from the full inventory", () => {
  const { guidance } = parseModelGuidance(
    configWith({ models: { "q/unconfigured": { when: "q has no auth" } } }),
  );
  const full: InventoryModel[] = [
    { provider: "p", id: "configured" },
    { provider: "q", id: "unconfigured" },
  ];
  const configured: InventoryModel[] = [{ provider: "p", id: "configured" }];
  const fullText = modelCatalog(guidance, full);
  const configuredText = modelCatalog(guidance, configured);
  assert.match(fullText, /q\/unconfigured/);
  assert.equal(configuredText, "");
  assert.notEqual(fullText, configuredText);
});
