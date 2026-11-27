import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot, type ToolResult } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession } from "../../lib/host.ts";
import { must } from "../support/must.ts";

/**
 * specs/agent-tool.md#resume: a `resume` dispatch records the model and
 * thinking it runs with, so a later `resume` without them continues the same
 * lineage instead of silently reverting to the source's original model.
 *
 * Real child sessions run on a scripted faux provider with two models: `m`
 * (no reasoning) and `m2` (reasoning).
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "pi-dent-engine-resume-model-"));
roots.push(home);
const agentDir = join(home, "pi-agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const faux = registerFauxProvider({
  models: [{ id: "m" }, { id: "m2", reasoning: true }],
  tokensPerSecond: 1000,
});
after(() => faux.unregister());

const descriptor = (id: string, reasoning: boolean) => ({
  id,
  name: id,
  reasoning,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 4096,
});

const realCreate = ModelRuntime.create.bind(ModelRuntime);
ModelRuntime.create = async (options) => {
  const runtime = await realCreate(options);
  runtime.registerProvider(faux.models[0].provider, {
    apiKey: "k",
    baseUrl: "http://faux.invalid",
    api: faux.api as never,
    streamSimple: must(getApiProvider(faux.api as never)).streamSimple as never,
    models: [descriptor("m", false), descriptor("m2", true)],
  });
  return runtime;
};

const base = faux.getModel();
const modelA = `${base.provider}/${base.id}`;
const modelB = `${base.provider}/m2`;
const models = faux.models as unknown as never[];

function boot(maxRecoveryRetries = 0, settings: Record<string, unknown> = {}): BootSnapshot {
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 }, ...settings }),
  );
  return {
    cwd: "/tmp",
    config: {
      merged: {},
      layers: {},
      projectRoot: "/tmp",
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
    maxRecoveryRetries,
    sessionTtlDays: 30,
  } as unknown as BootSnapshot;
}

function newRoot(): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-engine-resume-model-"));
  roots.push(root);
  const dir = join(root, "main");
  mkdirSync(dir, { recursive: true });
  return { root, sessionFile: join(dir, "main.jsonl") };
}

function makeHost(sessionFile: string, root: string): HostSession {
  return {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => sessionFile,
    sessionDir: () => root,
    model: () => ({ provider: base.provider, id: base.id }),
    thinking: () => undefined,
    activeTools: () => ["Agent", "bash"],
    inventory: () => models,
    configuredModels: () => models,
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
}

function textOf(result: ToolResult): string {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
}

interface RecordLike {
  sessionPath?: string | undefined;
  model?: string | undefined;
  modelSource?: string | undefined;
  previousModel?: string | undefined;
}
const sessionPathOf = (result: ToolResult): string => {
  const details = result.details as { results?: RecordLike[] };
  return must(must(details.results)[0]?.sessionPath);
};
const recordOf = (result: ToolResult): RecordLike => {
  const details = result.details as { results?: RecordLike[] };
  return must(must(details.results)[0]);
};

function entries(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const ofType = (path: string, type: string) => entries(path).filter((entry) => entry.type === type);

/** Dispatch a fresh task, returning its session file. */
async function freshSession(
  engine: DispatchEngine,
  host: HostSession,
  model: string,
): Promise<string> {
  faux.setResponses([() => fauxAssistantMessage("first")]);
  const result = await engine.dispatch({
    toolCallId: "call-fresh",
    params: { prompt: "P", task: "go", model },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(textOf(result), "first", textOf(result));
  return sessionPathOf(result);
}

/** Continue a session without naming a model, the way a later `resume` would. */
async function resumeWithoutModel(
  engine: DispatchEngine,
  host: HostSession,
  source: string,
  text: string,
): Promise<RecordLike> {
  faux.setResponses([() => fauxAssistantMessage(text)]);
  const result = await engine.dispatch({
    toolCallId: "call-later",
    params: { prompt: "P", task: "go", resume: source },
    host,
    cohortId: "cohort-later",
  });
  assert.equal(textOf(result), text, textOf(result));
  return recordOf(result);
}

test("a resume with a different model persists it, so a later resume keeps it", async () => {
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, root);
  const engine = new DispatchEngine(
    boot(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const source = await freshSession(engine, host, modelA);
  assert.equal(ofType(source, "model_change").length, 1, "the fresh session records its model");

  faux.setResponses([() => fauxAssistantMessage("second")]);
  const resumed = await engine.dispatch({
    toolCallId: "call-resume",
    params: { prompt: "P", task: "go", resume: source, model: modelB },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(textOf(resumed), "second", textOf(resumed));

  const changes = ofType(source, "model_change");
  assert.equal(changes.length, 2, JSON.stringify(changes));
  assert.equal(changes[1]?.provider, base.provider, JSON.stringify(changes));
  assert.equal(changes[1]?.modelId, "m2", JSON.stringify(changes));

  const plan = await resumeWithoutModel(engine, host, source, "third");
  assert.equal(plan.modelSource, "persisted", "the later resume runs the persisted model");
  // The bare resume onto m2 ran at m2's default level, not the source's `off`
  // (specs/agent-tool.md#model-thinking).
  assert.equal(
    plan.model,
    `${modelB}:medium`,
    "the model and level are the ones the resume ran with",
  );
  assert.equal(plan.previousModel, undefined, "the persisted model was not superseded");
});

test("a failed resume records previousModel when it supersedes the persisted model", async () => {
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, root);
  const engine = new DispatchEngine(
    boot(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const source = await freshSession(engine, host, modelA);

  faux.setResponses([
    () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" }),
  ]);
  const result = await engine.dispatch({
    toolCallId: "call-failed-resume",
    params: { prompt: "P", task: "go", resume: source, model: modelB },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, true, textOf(result));
  const details = result.details as {
    results?: {
      status?: string;
      failureCode?: string;
      model?: string;
      modelSource?: string;
      previousModel?: string;
    }[];
  };
  const records = must(details.results);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "failed");
  assert.equal(records[0]?.failureCode, "execution-error");
  // A resume reports its run level: m2's default (specs/agent-tool.md#model-thinking).
  assert.equal(records[0]?.model, `${modelB}:medium`);
  assert.equal(records[0]?.modelSource, "call");
  assert.equal(records[0]?.previousModel, modelA);
});

test("a resume with a different thinking level persists it, so a later resume keeps it", async () => {
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, root);
  const engine = new DispatchEngine(
    boot(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const source = await freshSession(engine, host, `${modelB}:low`);

  faux.setResponses([() => fauxAssistantMessage("second")]);
  const resumed = await engine.dispatch({
    toolCallId: "call-resume",
    params: { prompt: "P", task: "go", resume: source, model: `${modelB}:high` },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(textOf(resumed), "second", textOf(resumed));

  const levels = ofType(source, "thinking_level_change").map((entry) => entry.thinkingLevel);
  assert.deepEqual(levels, ["low", "high"]);

  const plan = await resumeWithoutModel(engine, host, source, "third");
  assert.equal(plan.modelSource, "persisted");
  assert.equal(plan.model, `${modelB}:high`);
});

test("a resume with the same model and thinking appends no entry", async () => {
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, root);
  const engine = new DispatchEngine(
    boot(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const source = await freshSession(engine, host, `${modelB}:low`);

  faux.setResponses([() => fauxAssistantMessage("second")]);
  const resumed = await engine.dispatch({
    toolCallId: "call-resume",
    params: { prompt: "P", task: "go", resume: source, model: `${modelB}:low` },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(textOf(resumed), "second", textOf(resumed));

  assert.equal(ofType(source, "model_change").length, 1);
  assert.equal(
    ofType(source, "thinking_level_change").length,
    1,
    JSON.stringify(ofType(source, "thinking_level_change")),
  );
});

test("a resume with no thinking level onto a model without reasoning records its default, off", async () => {
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, root);
  const engine = new DispatchEngine(
    boot(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const source = await freshSession(engine, host, `${modelB}:high`);

  faux.setResponses([() => fauxAssistantMessage("second")]);
  const resumed = await engine.dispatch({
    toolCallId: "call-resume",
    params: { prompt: "P", task: "go", resume: source, model: modelA },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(textOf(resumed), "second", textOf(resumed));

  assert.deepEqual(
    ofType(source, "thinking_level_change").map((entry) => entry.thinkingLevel),
    ["high", "off"],
    JSON.stringify(ofType(source, "thinking_level_change")),
  );

  const plan = await resumeWithoutModel(engine, host, source, "third");
  assert.equal(plan.model, `${modelA}:off`, "the later resume runs with no thinking");
});

test("the persisted model is appended once per dispatch, not per recovery attempt", async () => {
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, root);
  const engine = new DispatchEngine(
    boot(1),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const source = await freshSession(engine, host, modelA);

  faux.setResponses([
    () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" }),
    () => fauxAssistantMessage("done"),
  ]);
  const resumed = await engine.dispatch({
    toolCallId: "call-resume",
    params: { prompt: "P", task: "go", resume: source, model: `${modelB}:high` },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(textOf(resumed), "done", textOf(resumed));
  const details = resumed.details as { results?: RecordLike[] };
  const attempts = must(details.results);
  assert.equal(attempts.length, 2, "the recovery attempt ran");
  assert.deepEqual(
    attempts.map((attempt) => [attempt.model, attempt.modelSource]),
    [
      [`${modelB}:high`, "call"],
      [`${modelB}:high`, "call"],
    ],
    "every attempt runs the plan resolved once for the dispatch (specs/agent-tool.md#dispatch-plan)",
  );

  assert.equal(
    ofType(source, "model_change").length,
    2,
    JSON.stringify(ofType(source, "model_change")),
  );
  assert.deepEqual(
    ofType(source, "thinking_level_change").map((entry) => entry.thinkingLevel),
    ["off", "high"],
  );
});

// --- specs/agent-tool.md#model-thinking: the run level of a plan with no effective level ---------

/** Dispatch once and return the result and the thinking level the child's request ran at. */
async function runLevel(
  engine: DispatchEngine,
  host: HostSession,
  params: Record<string, unknown>,
): Promise<{ result: ToolResult; level: string | undefined }> {
  let level: string | undefined;
  faux.setResponses([
    (_context, options) => {
      level = options?.reasoning ?? "off";
      return fauxAssistantMessage("ran");
    },
  ]);
  const result = await engine.dispatch({
    toolCallId: `call-level-${Math.random()}`,
    params: { prompt: "P", task: "go", ...params },
    host,
    cohortId: "cohort-level",
  });
  assert.equal(textOf(result), "ran", textOf(result));
  return { result, level };
}

// specs/agent-tool.md#model-thinking and specs/agent-tool.md#resume: a resume onto another bare
// model runs at what a fresh dispatch on it gets, and a later bare resume keeps that level.
for (const [name, settings, expected] of [
  ["the host default", {}, "medium"],
  ["the default setting", { defaultThinkingLevel: "low" }, "low"],
  [
    "the per-model setting",
    { defaultThinkingLevel: "low", modelThinkingLevels: { [modelB]: "high" } },
    "high",
  ],
] as const) {
  test(`a resume onto a different bare model runs at the fresh level: ${name}`, async () => {
    const { root, sessionFile } = newRoot();
    const host = makeHost(sessionFile, root);
    const engine = new DispatchEngine(
      boot(0, settings),
      () => undefined,
      undefined,
      undefined,
      undefined,
      engineDeps(),
    );
    const fresh = await runLevel(engine, host, { model: modelB });
    assert.equal(fresh.level, expected, "a fresh dispatch on the model");

    // A source that ran on the caller's model, which has no reasoning, so at `off`.
    const source = await freshSession(engine, host, modelA);
    assert.deepEqual(
      ofType(source, "thinking_level_change").map((entry) => entry.thinkingLevel),
      ["off"],
    );
    const resumed = await runLevel(engine, host, { resume: source, model: modelB });
    assert.equal(resumed.level, fresh.level, "the resume runs at the fresh level");
    assert.equal(ofType(source, "thinking_level_change").at(-1)?.thinkingLevel, fresh.level);

    const later = await runLevel(engine, host, { resume: source });
    assert.equal(later.level, fresh.level, "a later bare resume keeps the level");
    assert.equal(recordOf(later.result).modelSource, "persisted");
    assert.equal(recordOf(later.result).model, `${modelB}:${expected}`);
  });
}

// specs/agent-tool.md#model-thinking: the tiers above the default are unchanged on a resume.
test("a suffix and the persisted level on the persisted model still win over the default", async () => {
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, root);
  const engine = new DispatchEngine(
    boot(0, { defaultThinkingLevel: "high" }),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const source = await freshSession(engine, host, `${modelB}:low`);
  const persisted = await runLevel(engine, host, { resume: source, model: modelB });
  assert.equal(persisted.level, "low", "the persisted level on the persisted model");
  const suffixed = await runLevel(engine, host, { resume: source, model: `${modelB}:minimal` });
  assert.equal(suffixed.level, "minimal", "the call's suffix");
});

// --- specs/agent-tool.md#recovery item 3: a refusal whose recovery cannot run keeps the refusal text ---

test("a refusal with recovery bound 0 fails with the refusal as its error text", async () => {
  const refusal = "I cannot assist with that request.";
  faux.setResponses([() => fauxAssistantMessage(refusal)]);
  const { root, sessionFile } = newRoot();
  const host = makeHost(sessionFile, root);
  const engine = new DispatchEngine(
    boot(0),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  const text = textOf(result);
  assert.equal(result.isError, true, text);
  assert.ok(text.startsWith(`Agent error: ${refusal}`), text);
  assert.ok(!text.startsWith("Agent error: \n"), text);
  const details = result.details as {
    results?: { status?: string; stopReason?: string; failureCode?: string }[];
  };
  const records = must(details.results);
  assert.equal(records.length, 1, JSON.stringify(records));
  assert.equal(records[0]?.status, "failed");
  assert.equal(records[0]?.stopReason, "error");
  assert.equal(records[0]?.failureCode, "execution-error");
});
