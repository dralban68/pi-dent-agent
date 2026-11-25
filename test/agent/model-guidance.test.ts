import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AGENT_SESSION_MODE_LINE } from "../../lib/session-kind.ts";
import {
  DispatchEngine,
  buildChildSystemPrompt,
  sessionNotes,
  type BootSnapshot,
  type ToolResult,
} from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession } from "../../lib/host.ts";
import { at } from "../support/must.ts";

const definition = { name: "fixer", description: "fix", model: "p/agent-model", prompt: "x" };

const makeBoot = (modelGuidance?: Record<string, unknown>): BootSnapshot =>
  ({
    cwd: "/tmp",
    config: {
      merged: modelGuidance ? { modelGuidance } : {},
      layers: {},
      projectRoot: "/tmp",
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    },
    agents: [definition],
    agentIndex: new Map([["fixer", definition]]),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: 0,
    sessionTtlDays: 30,
  }) as unknown as BootSnapshot;

const model = (id: string, reasoning = true) => ({ provider: "p", id, reasoning }) as never;

const host: HostSession = {
  cwd: () => "/tmp",
  sessionId: () => "s",
  sessionFile: () => undefined,
  sessionDir: () => "/tmp",
  model: () => ({ provider: "p", id: "main" }),
  thinking: () => undefined,
  activeTools: () => ["Agent"],
  inventory: () => [model("main"), model("agent-model"), model("cheap"), model("guided-leveled")],
  configuredModels: () => [
    model("main"),
    model("agent-model"),
    model("cheap"),
    model("guided-leveled"),
  ],
  contextWindow: () => undefined,
  compaction: () => undefined,
  notify: () => {},
};

// --- Dispatch restriction, driven through real dispatches --------------------
//
// A guided dispatch is accepted only by running it: guidance is decided from
// the host's model inventory (specs/model-guidance.md Section 3), and an
// accepted dispatch runs a real child session on the model the plan resolved.
// The child sessions run on a scripted faux provider whose models the
// inventory lists.

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "pi-dent-model-guidance-"));
roots.push(home);
const agentDir = join(home, "pi-agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const faux = registerFauxProvider({
  models: [
    { id: "main", reasoning: true },
    { id: "cheap", reasoning: true },
    { id: "guided-leveled", reasoning: true },
  ],
  tokensPerSecond: 1000,
});
after(() => faux.unregister());

const descriptor = (id: string) => ({
  id,
  name: id,
  reasoning: true,
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
    streamSimple: (getApiProvider(faux.api as never) as unknown as { streamSimple: unknown })
      .streamSimple as never,
    models: ["main", "cheap", "guided-leveled"].map(descriptor),
  });
  return runtime;
};

const provider = faux.getModel().provider;
/** The host's registered model list: the faux provider's models, as the runtime serves them. */
const inventory = faux.models as unknown as never[];

/** Boot configuration holding the given `modelGuidance` value. */
function guidedBoot(modelGuidance: Record<string, unknown>): BootSnapshot {
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 } }),
  );
  return {
    cwd: "/tmp",
    config: {
      merged: { modelGuidance },
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
    maxRecoveryRetries: 0,
    sessionTtlDays: 30,
  } as unknown as BootSnapshot;
}

/** A fresh temp root holding a main session at `<root>/main/main.jsonl`. */
function newRoot(): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-model-guidance-"));
  roots.push(root);
  const dir = join(root, "main");
  mkdirSync(dir, { recursive: true });
  return { root, sessionFile: join(dir, "main.jsonl") };
}

function guidedHost(sessionFile: string, root: string): HostSession {
  return {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => sessionFile,
    sessionDir: () => root,
    model: () => ({ provider, id: "main" }),
    thinking: () => undefined,
    activeTools: () => ["Agent"],
    inventory: () => inventory,
    configuredModels: () => inventory,
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
}

interface AttemptLike {
  model?: string | undefined;
  modelSource?: string | undefined;
  failureCode?: string | undefined;
  failurePhase?: string | undefined;
  status?: string | undefined;
}

/** The attempt record of a dispatch result (specs/agent-tool.md Section 7). */
function attemptOf(result: ToolResult): AttemptLike {
  return at((result.details as { results: AttemptLike[] }).results, 0);
}

function textOf(result: ToolResult): string {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
}

/** One dispatch on a fresh engine with one scripted answer. */
async function dispatchGuided(
  modelGuidance: Record<string, unknown>,
  params: { prompt: string; task: string; model?: string },
): Promise<ToolResult> {
  const { root, sessionFile } = newRoot();
  const dispatchHost = guidedHost(sessionFile, root);
  const engine = new DispatchEngine(
    guidedBoot(modelGuidance),
    () => dispatchHost,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  faux.setResponses([() => fauxAssistantMessage("done")]);
  return engine.dispatch({
    toolCallId: "call-1",
    params,
    host: dispatchHost,
    cohortId: "cohort-1",
  });
}

test("unguided model rejected with unguided-model plan error", async () => {
  const boot = makeBoot({
    models: {
      "p/cheap": { when: "cheap tasks" },
    },
  });
  const engine = new DispatchEngine(
    boot,
    () => host,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "c1",
    params: { prompt: "x", task: "t", model: "p/main" },
    host,
    cohortId: "c1",
  });
  assert.equal(result.isError, true);
  const record = at((result.details as { results: Array<Record<string, unknown>> }).results, 0);
  assert.equal(record.failureCode, "unguided-model");
  assert.equal(record.failurePhase, "plan-resolution");
  assert.match(
    (result.content[0] as { text: string }).text,
    /model "p\/main" is not a guided model; guided models: p\/cheap/,
  );
});

test("a guided model keyed without a thinking level dispatches at any thinking level", async () => {
  const guidance = { models: { [`${provider}/cheap`]: { when: "cheap tasks" } } };
  for (const [requested, expected] of [
    ["cheap", `${provider}/cheap`],
    ["cheap:low", `${provider}/cheap:low`],
    ["cheap:high", `${provider}/cheap:high`],
  ]) {
    const result = await dispatchGuided(guidance, {
      prompt: "x",
      task: "t",
      model: `${provider}/${requested}`,
    });
    assert.equal(result.isError, undefined, textOf(result));
    const attempt = attemptOf(result);
    assert.equal(attempt.status, "completed");
    assert.equal(attempt.model, expected);
    assert.equal(attempt.modelSource, "call");
  }
});

test("a guided model keyed at one thinking level rejects the same model at another level", async () => {
  const guidance = { models: { [`${provider}/guided-leveled:high`]: { when: "deep reasoning" } } };

  // The keyed level dispatches: the guided model is the model at that level.
  const guided = await dispatchGuided(guidance, {
    prompt: "x",
    task: "t",
    model: `${provider}/guided-leveled:high`,
  });
  assert.equal(guided.isError, undefined, textOf(guided));
  assert.equal(attemptOf(guided).model, `${provider}/guided-leveled:high`);

  // The same model at another level is unguided, and the plan says so.
  const otherLevel = await dispatchGuided(guidance, {
    prompt: "x",
    task: "t",
    model: `${provider}/guided-leveled:low`,
  });
  assert.equal(otherLevel.isError, true);
  const record = attemptOf(otherLevel);
  assert.equal(record.failureCode, "unguided-model");
  assert.equal(record.failurePhase, "plan-resolution");
  assert.match(
    textOf(otherLevel),
    new RegExp(
      `model "${provider}/guided-leveled:low" is not a guided model; guided models: ${provider}/guided-leveled:high`,
    ),
  );

  // A request with no level is not the keyed level either.
  const unleveled = await dispatchGuided(guidance, {
    prompt: "x",
    task: "t",
    model: `${provider}/guided-leveled`,
  });
  assert.equal(unleveled.isError, true);
  assert.equal(attemptOf(unleveled).failureCode, "unguided-model");
  assert.equal(attemptOf(unleveled).failurePhase, "plan-resolution");
});

test("no guidance → dispatch is unrestricted", async () => {
  const result = await dispatchGuided(
    {},
    {
      prompt: "x",
      task: "t",
      model: `${provider}/cheap`,
    },
  );
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(attemptOf(result).status, "completed");
});

test("child system prompt gets matching rule texts appended (and not non-matching ones)", () => {
  const boot = makeBoot({
    rules: [
      { match: "main", rule: "rule for main model" },
      { match: "nomatch", rule: "rule for other model" },
      { match: "p/", rule: "rule for p provider" },
    ],
  });

  const prompt = buildChildSystemPrompt(
    "Base system prompt",
    [],
    { provider: "p", id: "main" },
    boot.config,
  );
  assert.equal(
    prompt,
    `Base system prompt\n\nrule for main model\n\nrule for p provider\n\n${AGENT_SESSION_MODE_LINE}`,
  );

  // For a model that doesn't match the first rule
  const prompt2 = buildChildSystemPrompt(
    "Base prompt",
    [],
    { provider: "p", id: "other" },
    boot.config,
  );
  assert.equal(prompt2, `Base prompt\n\nrule for p provider\n\n${AGENT_SESSION_MODE_LINE}`);

  // When skills are also present, skills section is preserved before rules
  const skill = { name: "test-skill", description: "a test skill", body: "...", source: "..." };
  const promptWithSkills = buildChildSystemPrompt(
    "Base prompt",
    [skill],
    { provider: "p", id: "main" },
    boot.config,
  );
  assert.equal(
    promptWithSkills,
    `Base prompt\n\n<available_skills>\ntest-skill — a test skill\n</available_skills>\n\nrule for main model\n\nrule for p provider\n\n${AGENT_SESSION_MODE_LINE}`,
  );
});

test("session notes: the agent directory, a line per bound tool, the final-message line", () => {
  assert.equal(
    sessionNotes("/tmp/x.agents", ["read", "Bash", "Script"]),
    [
      "Session notes:",
      "- `PI_DENT_SESSION_DIR` (/tmp/x.agents) is this session's own directory, set in your tools' environment. Write temporary files there, never in the project tree.",
      "- Read a file with `read` before editing it, not through `Bash`.",
      "- Run JavaScript or TypeScript with `Script`, never through `Bash`.",
      "- Run a long-running command with `Bash` and `background: true`, never with `&` or `nohup`.",
      "- Before every `Bash` call, check the command: if it ends in `| tail`, `| head`, `| grep` or `> file`, delete that ending. `Bash` already returns only the last 50 lines and saves the full output to a file the result names.",
      "- Your final message is the result returned to the caller: make it complete, and claim only what you verified.",
    ].join("\n"),
  );
  const all = sessionNotes("/d", ["read", "edit", "Script", "Bash", "Skill"]);
  assert.equal(all.split("\n").length, 9);
});

test("an unguided inherited model dispatches", async () => {
  const result = await dispatchGuided(
    { models: { [`${provider}/cheap`]: { when: "cheap tasks" } } },
    { prompt: "x", task: "t" },
  );
  assert.equal(result.isError, undefined, textOf(result));
  const attempt = attemptOf(result);
  assert.equal(attempt.status, "completed");
  assert.equal(attempt.modelSource, "inherited");
  assert.equal(attempt.model, `${provider}/main`);
});

test("an unguided agent-tier model still fails unguided-model", async () => {
  const boot = makeBoot({
    models: {
      "p/cheap": { when: "cheap tasks" },
    },
  });
  const engine = new DispatchEngine(
    boot,
    () => host,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "c4",
    params: { agent: "fixer", task: "t" },
    host,
    cohortId: "c4",
  });
  assert.equal(result.isError, true);
  const record = at((result.details as { results: Array<Record<string, unknown>> }).results, 0);
  assert.equal(record.failureCode, "unguided-model");
  assert.match(
    (result.content[0] as { text: string }).text,
    /model "p\/agent-model" is not a guided model; guided models: p\/cheap/,
  );
});

test("guidance naming a model outside the inventory does not restrict dispatch", async () => {
  const guidance = { models: { [`${provider}/absent`]: { when: "not in the inventory" } } };

  const call = await dispatchGuided(guidance, {
    prompt: "x",
    task: "t",
    model: `${provider}/cheap`,
  });
  assert.equal(call.isError, undefined, textOf(call));
  assert.equal(attemptOf(call).model, `${provider}/cheap`);

  const inherited = await dispatchGuided(guidance, { prompt: "x", task: "t" });
  assert.equal(inherited.isError, undefined, textOf(inherited));
  assert.equal(attemptOf(inherited).model, `${provider}/main`);
});
