import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot, type ToolResult } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import { agentParameterSchema } from "../../lib/tools.ts";
import type { AgentDefinition } from "../../lib/catalogs.ts";
import type { HostSession } from "../../lib/host.ts";
import { must } from "../support/must.ts";

/**
 * Model precedence per specs/agent-tool.md#model-thinking: the call's `model` outranks
 * the agent definition's model, which outranks the dispatching session's. Each test
 * dispatches and reads the model the attempt record carries.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "pi-dent-call-model-"));
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
const provider = base.provider;
const models = faux.models as unknown as never[];
const fixer: AgentDefinition = {
  name: "fixer",
  description: "fix",
  model: `${provider}/m2`,
  prompt: "SYSTEM",
  source: "test",
};

function boot(): BootSnapshot {
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 } }),
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
    agents: [fixer],
    agentIndex: new Map([[fixer.name, fixer]]),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: 0,
    sessionTtlDays: 30,
  } as unknown as BootSnapshot;
}

function newRoot(): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-call-model-case-"));
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
    activeTools: () => ["Agent"],
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
  status?: string | undefined;
  model?: string | undefined;
  modelSource?: string | undefined;
  previousModel?: string | undefined;
}

/** The one attempt record of a settled dispatch. */
function recordOf(result: ToolResult): RecordLike {
  const details = result.details as { results?: RecordLike[] };
  return must(must(details.results)[0]);
}

test("the call's model outranks the agent model and the dispatching session", async () => {
  faux.setResponses([
    () => fauxAssistantMessage("call"),
    () => fauxAssistantMessage("agent"),
    () => fauxAssistantMessage("inherited"),
  ]);
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

  const called = await engine.dispatch({
    toolCallId: "call-1",
    params: { agent: "fixer", task: "go", model: `${provider}/m2:high` },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(textOf(called), "call", textOf(called));
  assert.equal(recordOf(called).model, `${provider}/m2:high`);
  assert.equal(recordOf(called).modelSource, "call");

  const fromAgent = await engine.dispatch({
    toolCallId: "call-2",
    params: { agent: "fixer", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(textOf(fromAgent), "agent", textOf(fromAgent));
  assert.equal(recordOf(fromAgent).model, `${provider}/m2`);
  assert.equal(recordOf(fromAgent).modelSource, "agent");

  const inherited = await engine.dispatch({
    toolCallId: "call-3",
    params: { prompt: "x", task: "go" },
    host,
    cohortId: "cohort-1",
  });
  assert.equal(textOf(inherited), "inherited", textOf(inherited));
  assert.equal(recordOf(inherited).model, `${provider}/${base.id}`);
  assert.equal(recordOf(inherited).modelSource, "inherited");
  assert.equal(recordOf(inherited).previousModel, undefined, "nothing was superseded");
});

test("an unresolvable call model fails the plan instead of falling through", async () => {
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
  const result = await engine.dispatch({
    toolCallId: "c",
    params: { agent: "fixer", task: "t", model: `${provider}/missing` },
    host,
    cohortId: "c",
  });
  assert.equal(result.isError, true);
  const record = must((result.details as { results?: Record<string, unknown>[] }).results?.[0]);
  assert.equal(record.failureCode, "missing-model");
  assert.equal(record.failurePhase, "plan-resolution");
});

test("an empty call model is a schema rejection (specs/agent-tool.md#parameter-schema)", () => {
  // The host rejects a blank `model` before `execute` runs, so the check left
  // the engine for the schema.
  for (const blank of ["", " ", "\t"]) {
    assert.equal(
      Value.Check(agentParameterSchema, { prompt: "x", task: "t", model: blank }),
      false,
      `model ${JSON.stringify(blank)}`,
    );
  }
  assert.equal(
    Value.Check(agentParameterSchema, { prompt: "x", task: "t", model: `${provider}/m2:high` }),
    true,
  );
});
