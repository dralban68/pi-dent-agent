import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import type { BootSnapshot } from "../../lib/engine.ts";
import type { HostSession } from "../../lib/host.ts";
import { serializeModelClasses } from "../../lib/model-string.ts";
import { makeSessionTool, sessionParameterSchema } from "../../lib/tools.ts";

function boot(
  modelClasses?: Record<string, unknown>,
  modelGuidance?: Record<string, unknown>,
): BootSnapshot {
  const merged: Record<string, unknown> = {};
  if (modelClasses) merged.modelClasses = modelClasses;
  if (modelGuidance) merged.modelGuidance = modelGuidance;
  return {
    cwd: "/w",
    config: {
      merged,
      layers: {},
      projectRoot: "/w",
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    },
    agents: [],
    agentIndex: new Map(),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: 2,
    sessionTtlDays: 30,
  };
}

interface CtxOptions {
  file?: string | undefined;
  model?: { provider: string; id: string } | undefined;
  thinkingLevel?: string | undefined;
  available?: { provider: string; id: string; reasoning?: boolean }[];
}

function stubCtx(id: string, options: CtxOptions = {}) {
  return {
    cwd: "/w/cwd",
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    sessionManager: { getSessionId: () => id, getSessionFile: () => options.file },
    modelRegistry: { getAvailable: () => options.available ?? [] },
  };
}

function run(
  deps: { boot: BootSnapshot; host?: HostSession | undefined },
  params: Record<string, unknown>,
  ctx: unknown,
) {
  const tool = makeSessionTool({ boot: deps.boot, hostProvider: () => deps.host });
  return tool.execute("tc-1", params as never, undefined, undefined, ctx as never);
}

test("Session registration: name, label, description, snippet, parameterless schema", () => {
  const tool = makeSessionTool({ boot: boot(), hostProvider: () => undefined });
  assert.equal(tool.name, "Session");
  assert.equal(tool.label, "Session");
  assert.equal(
    tool.description,
    "Report the current session: session ID, session file, cwd, model, the models an Agent call may name, model classes, and model guidance.",
  );
  assert.equal(
    tool.promptSnippet,
    "Report the current session's ID, session file, configured models, and model guidance",
  );
  assert.equal(sessionParameterSchema.type, "object");
  assert.deepEqual(sessionParameterSchema.properties, {});
  assert.equal(Reflect.get(sessionParameterSchema, "additionalProperties"), false);
  assert.equal(Value.Check(sessionParameterSchema, {}), true);
  assert.equal(Value.Check(sessionParameterSchema, { extra: 1 }), false);
});

test("Session details: identity, null rules, sorted models, canonical classes", async () => {
  const ctx = stubCtx("s-uuid", {
    file: "/tmp/s.jsonl",
    model: { provider: "anthropic", id: "claude" },
    thinkingLevel: "high",
    available: [
      { provider: "openai", id: "gpt" },
      { provider: "anthropic", id: "claude" },
      { provider: "anthropic", id: "Zed" },
    ],
  });
  const result = await run(
    {
      boot: boot({
        small: "openai/gpt:low",
        big: { provider: "anthropic", id: "claude", thinking: "high" },
        plain: { provider: "anthropic", id: "claude" },
      }),
    },
    {},
    ctx,
  );
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.details, {
    sessionId: "s-uuid",
    sessionKind: "agent",
    userInput: false,
    sessionFile: "/tmp/s.jsonl",
    cwd: "/w/cwd",
    model: "anthropic/claude:high",
    models: ["anthropic/Zed", "anthropic/claude", "openai/gpt"],
    modelClasses: {
      big: "anthropic/claude:high",
      plain: "anthropic/claude",
      small: "openai/gpt:low",
    },
    modelGuidance: null,
    billing: null,
    // Without a task ledger the usage figures are unavailable (specs/session-tool.md#result).
    ledger: "unavailable",
    usage: null,
  });
  const text = result.content[0];
  assert.equal(text?.type, "text");
  assert.equal(
    text?.type === "text" ? text.text : "",
    [
      "sessionId: s-uuid",
      "sessionKind: agent",
      "userInput: false",
      "sessionFile: /tmp/s.jsonl",
      "cwd: /w/cwd",
      "model: anthropic/claude:high",
      "ledger: unavailable",
      "models:",
      "anthropic/Zed",
      "anthropic/claude",
      "openai/gpt",
      "modelClasses:",
      "big → anthropic/claude:high",
      "plain → anthropic/claude",
      "small → openai/gpt:low",
      "usage: ledger unavailable",
    ].join("\n"),
  );
});

test("Session: null file and model, empty models and classes", async () => {
  const result = await run({ boot: boot() }, {}, stubCtx("s2"));
  assert.deepEqual(result.details, {
    sessionId: "s2",
    sessionKind: "agent",
    userInput: false,
    sessionFile: null,
    cwd: "/w/cwd",
    model: null,
    models: [],
    modelClasses: {},
    modelGuidance: null,
    billing: null,
    // Without a task ledger the usage figures are unavailable (specs/session-tool.md#result).
    ledger: "unavailable",
    usage: null,
  });
  const first = result.content[0];
  assert.equal(
    first?.type === "text" ? first.text : "",
    [
      "sessionId: s2",
      "sessionKind: agent",
      "userInput: false",
      "sessionFile: (none)",
      "cwd: /w/cwd",
      "model: (none)",
      "ledger: unavailable",
      "models:",
      "modelClasses:",
      "usage: ledger unavailable",
    ].join("\n"),
  );
});

test("Session: model without thinking level serializes without suffix", async () => {
  const result = await run(
    { boot: boot() },
    {},
    stubCtx("s3", { model: { provider: "p", id: "m" } }),
  );
  assert.equal(result.details.model, "p/m");
});

test("Session: reports the invoking session's own context, not the host's", async () => {
  const host: HostSession = {
    cwd: () => "/other",
    sessionId: () => "dispatcher",
    sessionFile: () => "/other/d.jsonl",
    sessionDir: () => "/other",
    model: () => ({ provider: "x", id: "y" }),
    thinking: () => undefined,
    activeTools: () => [],
    inventory: () => [],
    configuredModels: () => [],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
  const result = await run({ boot: boot(), host }, {}, stubCtx("child"));
  assert.equal(result.details.sessionId, "child");
  assert.equal(result.details.sessionFile, null);
  assert.equal(result.details.model, null);
});

test("serializeModelClasses: sorted keys, invalid entries skipped", () => {
  assert.deepEqual(
    Object.entries(serializeModelClasses({ b: "p/m", a: { provider: "p", id: "n" }, bad: 5 })),
    [
      ["a", "p/n"],
      ["b", "p/m"],
    ],
  );
  assert.deepEqual(serializeModelClasses(undefined), {});
});

test("Session: active model guidance filters models and appends guidance", async () => {
  const result = await run(
    {
      boot: boot(undefined, {
        models: {
          "a/flash-1": { when: "quick edits" },
        },
      }),
    },
    {},
    stubCtx("s4", {
      available: [
        { provider: "a", id: "flash-1" },
        { provider: "b", id: "pro-2" },
      ],
    }),
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.models, ["a/flash-1"]);
  assert.deepEqual(result.details.modelGuidance, [{ model: "a/flash-1", when: "quick edits" }]);
  const text = result.content[0];
  assert.equal(text?.type, "text");
  const textStr = text?.type === "text" ? text.text : "";
  assert.ok(
    textStr.endsWith("Model guidance:\n- a/flash-1: quick edits\nusage: ledger unavailable"),
    `expected text to end with guidance, got:\n${textStr}`,
  );
});

test("Session: active model guidance with leveled entry strips level for models list", async () => {
  const result = await run(
    {
      boot: boot(undefined, {
        models: {
          "a/flash-1:high": { when: "deep thought" },
        },
      }),
    },
    {},
    stubCtx("s5", {
      // specs/model-string.md#thinking-precedence support of the keyed level needs the inventory's reasoning flag.
      available: [{ provider: "a", id: "flash-1", reasoning: true }],
    }),
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.models, ["a/flash-1"]);
  assert.deepEqual(result.details.modelGuidance, [
    { model: "a/flash-1:high", when: "deep thought" },
  ]);
  const text = result.content[0];
  assert.equal(text?.type, "text");
  const textStr = text?.type === "text" ? text.text : "";
  assert.ok(
    textStr.endsWith("Model guidance:\n- a/flash-1:high: deep thought\nusage: ledger unavailable"),
    `expected text to end with guidance, got:\n${textStr}`,
  );
});

test("Session: guided models keep the guidance order, not sorted provider/id order", async () => {
  const result = await run(
    {
      boot: boot(undefined, {
        models: {
          // Guided order is by identifier in ascending ASCII order (`-` sorts before
          // `:`), which is not the order of the provider/id forms they map to.
          "a/claude:high": { when: "deep thought" },
          "a/claude-x": { when: "quick edits" },
        },
      }),
    },
    {},
    stubCtx("s6", {
      available: [
        { provider: "a", id: "claude", reasoning: true },
        { provider: "a", id: "claude-x" },
      ],
    }),
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    result.details.modelGuidance,
    [
      { model: "a/claude-x", when: "quick edits" },
      { model: "a/claude:high", when: "deep thought" },
    ],
    "specs/model-guidance.md#guided-models order is ascending ASCII of the identifier",
  );
  assert.deepEqual(result.details.models, ["a/claude-x", "a/claude"]);
});

test("Session: configured guidance matching no inventory model is inactive (null, all models, no section)", async () => {
  const result = await run(
    {
      boot: boot(undefined, {
        models: {
          "a/absent": { when: "not installed" },
        },
      }),
    },
    {},
    stubCtx("s6", {
      available: [{ provider: "b", id: "pro-2" }],
    }),
  );
  assert.equal(result.isError, undefined);
  assert.equal(result.details.modelGuidance, null);
  assert.deepEqual(result.details.models, ["b/pro-2"]);
  const textStr = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.ok(!textStr.includes("Model guidance:"), textStr);
});

test("Session: an absent inventory list is a report of no models, not a tool failure", async () => {
  const result = await run(
    {
      boot: boot(undefined, {
        models: {
          "a/flash-1": { when: "quick edits" },
        },
      }),
    },
    {},
    {
      cwd: "/w/cwd",
      sessionManager: { getSessionId: () => "s7", getSessionFile: () => undefined },
      modelRegistry: { getAvailable: () => undefined },
    },
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.models, []);
  assert.equal(result.details.modelGuidance, null);
});

test("Session: a call with no session ID fails before reporting anything", async () => {
  const ctx = { ...stubCtx(""), sessionManager: { getSessionId: () => undefined } };
  const res = await run({ boot: boot() }, {}, ctx);
  assert.equal(res.isError, true);
  const first = res.content[0];
  assert.equal(
    first?.type === "text" ? first.text : "",
    "no live session identity for Session",
    "specs/session-tool.md#result: the failure is the call's whole result",
  );
});
