import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot, type ToolResult } from "../../lib/engine.ts";
import type { AgentDefinition } from "../../lib/catalogs.ts";
import type { HostSession } from "../../lib/host.ts";
import { makeAgentTool, type AgentToolParams } from "../../lib/tools.ts";
import { engineDeps } from "../support/engine-deps.ts";
import { must } from "../support/must.ts";

/**
 * The handle a caller continues a child with: the continuation line of a foreground result
 * (specs/agent-tool.md#result-contract), `resume` by task ID or session file stem, and the
 * unresolved-`resume` rejection (specs/agent-tool.md#resume). Calls go through the registered
 * `Agent` tool, which is what the caller's model sees; real child sessions run on a faux provider.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "pi-dent-resume-handle-"));
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
  prompt: "ALPHA",
  source: "project",
};

function boot(): BootSnapshot {
  return {
    cwd: "/tmp",
    config: {
      merged: {},
      layers: {},
      projectRoot: "/tmp",
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    },
    agents: [alpha],
    agentIndex: new Map([[alpha.name, alpha]]),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: 0,
    sessionTtlDays: 30,
  } as unknown as BootSnapshot;
}

let calls = 0;

/** A main session with an engine, and its registered `Agent` tool. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-resume-handle-"));
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
    boot(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const tool = makeAgentTool({
    boot: boot(),
    modelCatalog: "",
    dispatch: (call) => engine.dispatch(call),
    hostProvider: () => host,
    cohortFor: () => "cohort-1",
  });
  /** One `Agent` call through the tool, the child answering `answer`. */
  const call = async (
    params: Partial<AgentToolParams>,
    answer: () => ReturnType<typeof fauxAssistantMessage> = () => fauxAssistantMessage("done"),
  ): Promise<ToolResult> => {
    faux.setResponses([answer]);
    calls += 1;
    return tool.execute(
      `call-${calls}`,
      { task: "go", ...params },
      undefined,
      undefined,
      undefined as never,
    ) as Promise<ToolResult>;
  };
  return { engine, tool, call };
}

const textOf = (result: ToolResult): string => {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
};
interface Details {
  taskId?: string;
  results?: { sessionPath?: string; failureCode?: string }[];
}
const detailsOf = (result: ToolResult): Details => result.details as Details;
const taskIdOf = (result: ToolResult): string => must(detailsOf(result).taskId);
const sessionPathOf = (result: ToolResult): string =>
  must(must(detailsOf(result).results).at(-1)?.sessionPath);

/** Resolves once the row settles, on the registry's change signal. */
function settled(engine: DispatchEngine, taskId: string): Promise<void> {
  return new Promise((done) => {
    const check = () => {
      if (engine.registry.get(taskId)?.status === "running") return;
      unsubscribe();
      done();
    };
    const unsubscribe = engine.registry.subscribe(check);
    check();
  });
}

/** The task ID the continuation line of a foreground result carries. */
function continuationId(text: string): string {
  const match = /\n\n\(To continue this agent, call Agent with resume: "([0-9a-f]{8})"\.\)$/.exec(
    text,
  );
  return must(match?.[1]);
}

// specs/agent-tool.md#result-contract: a foreground success ends with the continuation line, and
// the ID it carries is a `resume` value the tool accepts (specs/agent-tool.md#resume).
test("a foreground result ends with the continuation line whose task ID resume accepts", async () => {
  const { engine, call } = setup();
  const first = await call({});
  const id = continuationId(textOf(first));
  assert.equal(id, taskIdOf(first));
  assert.equal(textOf(first), `done\n\n(To continue this agent, call Agent with resume: "${id}".)`);
  assert.equal(
    engine.registry.get(id)?.result,
    "done",
    "the task row's result carries no continuation line",
  );

  const resumed = await call({ resume: id }, () => fauxAssistantMessage("again"));
  assert.equal(resumed.isError, undefined, textOf(resumed));
  assert.equal(sessionPathOf(resumed), sessionPathOf(first), "the same session file continues");
  assert.equal(continuationId(textOf(resumed)), taskIdOf(resumed));
});

// specs/agent-tool.md#result-contract: a failed foreground result keeps its Session line and
// ends with the continuation line, like a success.
test("a failed foreground result ends with its Session line and then the continuation line", async () => {
  const { call } = setup();
  const result = await call({}, () =>
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" }),
  );
  assert.equal(result.isError, true);
  const id = taskIdOf(result);
  assert.equal(
    textOf(result),
    `Agent error: provider exploded\nSession: ${sessionPathOf(result)}\n\n(To continue this agent, call Agent with resume: "${id}".)`,
  );
});

// specs/agent-tool.md#result-contract: no continuation line on a pre-start rejection or a
// background start (specs/agent-tool.md#background-contract).
test("a pre-start rejection and a background start carry no continuation line", async () => {
  const { engine, call } = setup();
  const rejected = await call({ agent: "alpha", prompt: "P" });
  assert.equal(rejected.isError, true);
  assert.ok(!textOf(rejected).includes("To continue this agent"), textOf(rejected));

  const started = await call({ background: true });
  assert.ok(textOf(started).startsWith("Agent dynamic started in background (taskId "));
  assert.ok(!textOf(started).includes("To continue this agent"), textOf(started));
  // The child must not take a later test's faux response.
  await settled(engine, taskIdOf(started));
});

// specs/agent-tool.md#registration: renderResult does not show the continuation line.
test("renderResult shows the result without the continuation line", async () => {
  const { tool, call } = setup();
  const result = await call({});
  const context = { toolCallId: "render-1", outputPad: 0 } as never;
  const rendered = must(tool.renderResult)(result, {} as never, {} as never, context);
  const shown = rendered.render(200).join("\n");
  assert.ok(shown.includes("done"), shown);
  assert.ok(!shown.includes("To continue this agent"), shown);
});

// specs/agent-tool.md#resume: the session file stem resolves as the task ID it ends with, for a
// dynamic and for a named agent.
test("resume accepts the session file stem of a dynamic and of a named agent", async () => {
  const { call } = setup();
  for (const params of [{}, { agent: "alpha" }]) {
    const first = await call(params);
    const stem = basename(sessionPathOf(first), ".jsonl");
    assert.equal(
      stem,
      `${"agent" in params ? "alpha" : "dynamic"}-${taskIdOf(first)}`,
      "the stem is the safe agent identity and the task ID",
    );
    const resumed = await call({ resume: stem }, () => fauxAssistantMessage("again"));
    assert.equal(resumed.isError, undefined, textOf(resumed));
    assert.equal(sessionPathOf(resumed), sessionPathOf(first));
  }
});

// specs/agent-tool.md#resume: a stem resolves only when it is that row's session file stem.
test("a stem whose prefix or task ID does not name the session file is rejected", async () => {
  const { call } = setup();
  const first = await call({});
  const id = taskIdOf(first);
  for (const value of [`summarizer-${id}`, "dynamic-abcdef01", `x/dynamic-${id}`]) {
    const result = await call({ resume: value });
    assert.equal(result.isError, true, value);
    assert.ok(
      textOf(result).startsWith(
        `Agent error: resume must be an absolute path to an Agent session file or the task ID of an agent task of this session; received ${JSON.stringify(value)}.\n`,
      ),
      textOf(result),
    );
    assert.equal(detailsOf(result).results?.[0]?.failureCode, "invalid-plan");
  }
});

// specs/agent-tool.md#resume: the rejection lists the resumable tasks, newest first, one per
// session file, the newest row naming it.
test("an unresolved resume lists the resumable tasks newest first, one per session file", async () => {
  const { call } = setup();
  const named = await call({ agent: "alpha", task: "first job\nsecond line" });
  const dynamic = await call({ task: "a dynamic job" });
  const resumed = await call({ resume: taskIdOf(named), task: "continue it" });
  const result = await call({ resume: "./sessions/child.jsonl" });
  assert.equal(
    textOf(result),
    [
      `Agent error: resume must be an absolute path to an Agent session file or the task ID of an agent task of this session; received "./sessions/child.jsonl".`,
      "Resumable agent tasks, newest first:",
      `- ${taskIdOf(resumed)} · alpha · continue it`,
      `- ${taskIdOf(dynamic)} · dynamic · a dynamic job`,
    ].join("\n"),
  );
});

// specs/agent-tool.md#resume: the list stops at its limit and says how many it left out; a long
// first line is cut with `…`.
test("an unresolved resume lists at most five tasks and states how many it left out", async () => {
  const { call } = setup();
  const long = "x".repeat(61);
  const ids: string[] = [];
  for (let i = 0; i < 7; i += 1) ids.push(taskIdOf(await call({ task: `${long}${i}` })));
  const result = await call({ resume: "latest" });
  const lines = textOf(result).split("\n");
  assert.equal(lines[1], "Resumable agent tasks, newest first:");
  assert.deepEqual(
    lines.slice(2),
    [
      ...ids
        .toReversed()
        .slice(0, 5)
        .map((id) => `- ${id} · dynamic · ${"x".repeat(60)}…`),
      "(2 more not listed; only the 5 newest are listed)",
    ],
    textOf(result),
  );
});
