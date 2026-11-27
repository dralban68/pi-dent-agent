import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  DEFAULT_AGENT_PROMPT,
  DispatchEngine,
  type BootSnapshot,
  type ToolResult,
} from "../../lib/engine.ts";
import type { AgentDefinition } from "../../lib/catalogs.ts";
import type { HostSession } from "../../lib/host.ts";
import { makeAgentTool } from "../../lib/tools.ts";
import { engineDeps } from "../support/engine-deps.ts";
import { must } from "../support/must.ts";

/**
 * The agent source of a dispatch (specs/agent-tool.md#dispatch-plan), its record in the session
 * file and its use by a `resume` with neither agent nor prompt (specs/agent-tool.md#resume), and
 * the pre-start rejections around it (specs/agent-tool.md#parameter-schema). Real child sessions
 * run on a scripted faux provider.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "pi-dent-agent-source-"));
roots.push(home);
const agentDir = join(home, "pi-agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 } }),
);
process.env.PI_CODING_AGENT_DIR = agentDir;

const faux = registerFauxProvider({ models: [{ id: "m" }], tokensPerSecond: 1000 });
after(() => faux.unregister());
const realCreate = ModelRuntime.create.bind(ModelRuntime);
ModelRuntime.create = async (options) => {
  const runtime = await realCreate(options);
  runtime.registerProvider(faux.models[0].provider, {
    apiKey: "k",
    baseUrl: "http://faux.invalid",
    api: faux.api as never,
    streamSimple: must(getApiProvider(faux.api as never)).streamSimple as never,
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
  });
  return runtime;
};
const base = faux.getModel();
const models = faux.models as unknown as never[];

const alpha: AgentDefinition = {
  name: "alpha",
  description: "Alpha agent",
  prompt: "ALPHA SYSTEM PROMPT",
  source: "project",
};

function boot(agents: AgentDefinition[] = [alpha]): BootSnapshot {
  return {
    cwd: "/tmp",
    config: {
      merged: { modelClasses: { fast: `${base.provider}/${base.id}` } },
      layers: {},
      projectRoot: "/tmp",
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    },
    agents,
    agentIndex: new Map(agents.map((agent) => [agent.name, agent])),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: 0,
    sessionTtlDays: 30,
  } as unknown as BootSnapshot;
}

function setup(agents?: AgentDefinition[]) {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-agent-source-"));
  roots.push(root);
  mkdirSync(join(root, "main"), { recursive: true });
  const sessionFile = join(root, "main", "main.jsonl");
  const host: HostSession = {
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
  const engine = new DispatchEngine(
    boot(agents),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  return { host, engine };
}

const textOf = (result: ToolResult): string => {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
};
interface Details {
  agent?: string;
  results?: { sessionPath?: string; failureCode?: string }[];
}
const detailsOf = (result: ToolResult): Details => result.details as Details;
const sessionPathOf = (result: ToolResult): string =>
  must(must(detailsOf(result).results)[0]?.sessionPath);

/** Dispatch once and return the result and the system prompt the child sent. */
async function run(
  engine: DispatchEngine,
  host: HostSession,
  params: Record<string, unknown>,
): Promise<{ result: ToolResult; system: string }> {
  let system = "";
  faux.setResponses([
    (context) => {
      // The current run's system prompt is the last system message.
      system = JSON.stringify(
        context.messages.filter((message) => message.role === "system").at(-1),
      );
      return fauxAssistantMessage("done");
    },
  ]);
  const result = await engine.dispatch({
    toolCallId: `call-${Math.random()}`,
    params: { task: "go", ...params },
    host,
    cohortId: "cohort-1",
  });
  return { result, system };
}

const agentRecords = (path: string): unknown[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-dent-agent")
    .map((entry) => entry.data);

// specs/agent-tool.md#dispatch-plan: neither agent nor prompt runs the default prompt.
test("a call with neither agent nor prompt runs a dynamic dispatch on the default prompt", async () => {
  const { host, engine } = setup();
  const { result, system } = await run(engine, host, {});
  assert.equal(textOf(result), "done", textOf(result));
  assert.equal(detailsOf(result).agent, "dynamic");
  assert.ok(system.includes(DEFAULT_AGENT_PROMPT), system);
  assert.deepEqual(agentRecords(sessionPathOf(result)), [{}]);
});

// specs/agent-tool.md#resume: a resume with neither continues as the recorded definition.
test("a resume with neither agent nor prompt after a named dispatch continues as that agent", async () => {
  const { host, engine } = setup();
  const first = await run(engine, host, { agent: "alpha" });
  const source = sessionPathOf(first.result);
  assert.deepEqual(agentRecords(source), [{ agent: "alpha" }]);
  const { result, system } = await run(engine, host, { resume: source });
  assert.equal(textOf(result), "done", textOf(result));
  assert.equal(detailsOf(result).agent, "alpha");
  assert.ok(system.includes("ALPHA SYSTEM PROMPT"), system);
  assert.deepEqual(agentRecords(source), [{ agent: "alpha" }], "an unchanged source appends none");
});

// specs/agent-tool.md#resume: a recorded prompt is reused verbatim.
test("a resume with neither agent nor prompt after an inline-prompt dispatch reuses the prompt", async () => {
  const { host, engine } = setup();
  const first = await run(engine, host, { prompt: "INLINE PROMPT" });
  const source = sessionPathOf(first.result);
  const { result, system } = await run(engine, host, { resume: source });
  assert.equal(detailsOf(result).agent, "dynamic");
  assert.ok(system.includes("INLINE PROMPT"), system);
  assert.ok(!system.includes(DEFAULT_AGENT_PROMPT), system);
});

// specs/agent-tool.md#resume: a resume after a default dispatch keeps the default prompt.
test("a resume with neither agent nor prompt after a default dispatch keeps the default prompt", async () => {
  const { host, engine } = setup();
  const first = await run(engine, host, {});
  const source = sessionPathOf(first.result);
  const { result, system } = await run(engine, host, { resume: source });
  assert.equal(textOf(result), "done", textOf(result));
  assert.ok(system.includes(DEFAULT_AGENT_PROMPT), system);
  assert.deepEqual(agentRecords(source), [{}]);
});

// specs/agent-tool.md#resume: a source without an agent record has the default prompt.
test("a resume of a source without an agent record runs the default prompt and records it", async () => {
  const { host, engine } = setup();
  const first = await run(engine, host, { agent: "alpha" });
  const source = sessionPathOf(first.result);
  const kept = readFileSync(source, "utf8")
    .split("\n")
    .filter((line) => !line.includes('"pi-dent-agent"'));
  writeFileSync(source, kept.join("\n"));
  const { result, system } = await run(engine, host, { resume: source });
  assert.equal(textOf(result), "done", textOf(result));
  assert.equal(detailsOf(result).agent, "dynamic");
  assert.ok(system.includes(DEFAULT_AGENT_PROMPT), system);
  assert.ok(!system.includes("ALPHA SYSTEM PROMPT"), system);
  assert.deepEqual(agentRecords(source), [{}]);
});

// specs/agent-tool.md#parameter-schema: a recorded key no longer in the catalog is rejected.
test("a resume whose recorded agent left the catalog is rejected naming the key", async () => {
  const before = setup();
  const first = await run(before.engine, before.host, { agent: "alpha" });
  const source = sessionPathOf(first.result);
  const later = setup([]);
  const { result } = await run(later.engine, later.host, { resume: source });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.ok(text.includes('"alpha"') && text.includes("pass agent or prompt"), text);
  assert.ok(text.includes("Available agents: (none)"), text);
  assert.equal(detailsOf(result).results?.[0]?.failureCode, "invalid-plan");
});

// specs/agent-tool.md#resume: a resume that gives prompt records it for the next resume.
test("a resume that gives prompt records it, and a later resume with neither reuses it", async () => {
  const { host, engine } = setup();
  const first = await run(engine, host, { agent: "alpha" });
  const source = sessionPathOf(first.result);
  await run(engine, host, { resume: source, prompt: "NEW PROMPT" });
  assert.deepEqual(agentRecords(source), [{ agent: "alpha" }, { prompt: "NEW PROMPT" }]);
  const { system } = await run(engine, host, { resume: source });
  assert.ok(system.includes("NEW PROMPT") && !system.includes("ALPHA SYSTEM PROMPT"), system);
});

// specs/agent-tool.md#parameter-schema: a model-like agent value says to pass it as model.
test("a model string or model class in agent is rejected with the corrective message", async () => {
  const { host, engine } = setup();
  for (const value of ["anthropic/claude-haiku-5-5", "fast", "fast:high"]) {
    const { result } = await run(engine, host, { agent: value });
    const text = textOf(result);
    assert.equal(result.isError, true);
    assert.ok(text.includes(`"${value}" is a model, not an agent`), text);
    assert.ok(text.includes("pass it as model") && text.includes("omit agent"), text);
    assert.ok(text.includes("Available agents: alpha"), text);
  }
  const { result } = await run(engine, host, { agent: "zeta" });
  assert.ok(!textOf(result).includes("is a model"), textOf(result));
  assert.ok(textOf(result).includes("Available agents: alpha"), textOf(result));
});

// specs/agent-tool.md#parameter-schema: both agent and prompt stay a pre-start rejection.
test("a call with both agent and prompt is rejected", async () => {
  const { host, engine } = setup();
  const { result } = await run(engine, host, { agent: "alpha", prompt: "P" });
  assert.equal(result.isError, true);
  assert.ok(textOf(result).includes("both agent and prompt"), textOf(result));
  assert.equal(detailsOf(result).results?.[0]?.failureCode, "invalid-plan");
});

// specs/agent-tool.md#registration: renderCall shows a resumed call's plan identity once known.
test("renderCall of a resume with neither shows the agent of its latest result", () => {
  const tool = makeAgentTool({
    boot: boot(),
    modelCatalog: "",
    dispatch: async () => {
      throw new Error("no dispatch in this test");
    },
    hostProvider: () => undefined,
    cohortFor: () => "cohort-1",
  });
  // The host gives one row's call and result renders a shared state object.
  const context = { toolCallId: "render-1", outputPad: 0, state: {} } as never;
  const args = { task: "go on", resume: "/x.jsonl" };
  const call = must(tool.renderCall)(args, {} as never, context);
  assert.match(call.render(120).join(""), /Agent dynamic — go on/);
  must(tool.renderResult)(
    { content: [{ type: "text", text: "" }], details: { agent: "alpha" } },
    {} as never,
    {} as never,
    context,
  );
  assert.match(call.render(120).join(""), /Agent alpha — Alpha agent/);
});
