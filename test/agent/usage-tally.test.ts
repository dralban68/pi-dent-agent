import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  DispatchEngine,
  type AttemptRecord,
  type BootSnapshot,
  type ToolResult,
} from "../../lib/engine.ts";
import { AgentTaskRow } from "../../lib/registry.ts";
import { formatTokens, formatUsage, UsageTally, zeroUsageSum } from "../../lib/usage.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession } from "../../lib/host.ts";
import { at, must } from "../support/must.ts";

/**
 * specs/agent-tool.md Section 13: usage sums, the usage tally and the usage status line, and
 * the row and tally accounting of real dispatches. Child sessions of the behaviour tests run
 * on a scripted faux provider.
 */

// --- formatTokens: the spec's rendering of a token count ---------------------

test("formatTokens renders every boundary as Section 13 prescribes", () => {
  assert.equal(formatTokens(999), "999", "below 1000 is decimal");
  assert.equal(formatTokens(1000), "1.0k", "1000 is the first k count, one decimal");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(9999), "10.0k", "below 10000 keeps one decimal");
  assert.equal(formatTokens(10000), "10k", "10000 rounds to the nearest k");
  assert.equal(formatTokens(999999), "1000k", "below 1000000 stays k");
  assert.equal(formatTokens(1000000), "1.0M", "1000000 is the first M count, one decimal");
  assert.equal(formatTokens(9999999), "10.0M", "below 10000000 keeps one decimal");
  assert.equal(formatTokens(10000000), "10M", "10000000 rounds to the nearest M");
});

// --- formatUsage: turns, tokens, cache and cost ------------------------------

test("formatUsage of one turn without cache", () => {
  assert.equal(
    formatUsage({ input: 1500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.042, turns: 1 }),
    "1 turn · ↑1.5k ↓200 · $0.042",
  );
});

test("formatUsage of several turns with cache", () => {
  assert.equal(
    formatUsage({
      input: 182000,
      output: 9600,
      cacheRead: 1200000,
      cacheWrite: 88000,
      cost: 0.214,
      turns: 2,
    }),
    "2 turns · ↑182k ↓9.6k R1.2M W88k · $0.214",
  );
});

// --- UsageTally --------------------------------------------------------------

test("a fresh tally counts nothing and shows no status", () => {
  const tally = new UsageTally();
  assert.equal(tally.tasks, 0);
  assert.deepEqual(tally.sum, zeroUsageSum());
  assert.equal(tally.statusText(), undefined, "no status line while no task is counted");
});

test("countTask counts, addMessage sums, and the status line shows both", () => {
  const tally = new UsageTally();
  tally.countTask();
  assert.equal(tally.tasks, 1);
  tally.addMessage({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } });
  tally.addMessage(undefined);
  assert.deepEqual(tally.sum, {
    input: 1000,
    output: 500,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.5,
    turns: 2,
  });
  assert.equal(tally.statusText(), "1 agent · 2 turns · ↑1.0k ↓500 · $0.500 │");
  assert.equal(
    tally.statusText((color, text) => `<${color}>${text}</>`),
    "1 <accent>agent</><dim> · </><muted>2 turns</><dim> · </><muted>↑1.0k ↓500</><dim> · </><warning>$0.500</><dim> │</>",
    "the painted line has the plain line's text",
  );
});

test("reset returns to no tasks and a zero sum", () => {
  const tally = new UsageTally();
  tally.countTask();
  tally.addMessage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 5 } });
  tally.reset();
  assert.equal(tally.tasks, 0);
  assert.deepEqual(tally.sum, zeroUsageSum());
  assert.equal(tally.statusText(), undefined);
});

test("the tally is partial from reset until its seed applies; the status line says so meanwhile", () => {
  const tally = new UsageTally();
  let changes = 0;
  tally.subscribe(() => (changes += 1));
  const seed = tally.reset();
  assert.equal(tally.partial, true);
  tally.countTask();
  tally.addMessage({ input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } });
  assert.equal(tally.statusText(), "1 agent · 1 turn · ↑1.0k ↓0 · $0.250 (partial) │");
  const before = changes;
  seed({
    count: 2,
    usage: { input: 500, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 3 },
  });
  assert.equal(changes, before + 1, "the end of the partial state is a change");
  assert.equal(tally.partial, false);
  assert.equal(tally.statusText(), "3 agents · 4 turns · ↑1.5k ↓10 · $0.750 │");
  seed({ count: 9, usage: zeroUsageSum() });
  assert.equal(tally.tasks, 3, "a seed applies once");
});

test("a seed of an earlier session start is not applied after the next reset", () => {
  const tally = new UsageTally();
  const stale = tally.reset();
  tally.reset();
  stale({ count: 4, usage: zeroUsageSum() });
  assert.equal(tally.tasks, 0);
  assert.equal(tally.partial, true, "the current seed has not completed");
});

test("a throwing listener affects neither the tally nor the caller", () => {
  const tally = new UsageTally();
  let calls = 0;
  tally.subscribe(() => {
    calls += 1;
    throw new Error("status line failed");
  });
  assert.doesNotThrow(() => tally.countTask());
  assert.doesNotThrow(() =>
    tally.addMessage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
  );
  assert.equal(calls, 2, "the listener was called for both changes");
  assert.equal(tally.tasks, 1);
  assert.equal(tally.sum.turns, 1);
});

// --- Behaviour: real dispatches ---------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// An isolated pi agent dir whose auth holds a key for the faux provider; retry is off, so
// only the engine's own recovery re-prompts.
const home = mkdtempSync(join(tmpdir(), "pi-dent-usage-tally-"));
roots.push(home);
const agentDir = join(home, "pi-agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
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

const model = faux.getModel();

function bootWith(maxRecoveryRetries = 0): BootSnapshot {
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

/** A fresh temp root holding a main session at `<root>/main/main.jsonl`. */
function newRoot(): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-usage-tally-"));
  roots.push(root);
  const dir = join(root, "main");
  mkdirSync(dir, { recursive: true });
  return { root, sessionFile: join(dir, "main.jsonl") };
}

function makeHost(root: string, sessionFile: string, tools = ["Agent"]): HostSession {
  return {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => sessionFile,
    sessionDir: () => root,
    model: () => ({ provider: model.provider, id: model.id }),
    thinking: () => undefined,
    activeTools: () => tools,
    inventory: () => [model as never],
    configuredModels: () => [model as never],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
}

const textOf = (result: ToolResult): string => {
  const part = at(result.content, 0);
  return part.type === "text" ? part.text : "";
};
const recordsOf = (result: ToolResult): AttemptRecord[] =>
  (result.details as { results?: AttemptRecord[] }).results ?? [];
const agentRow = (engine: DispatchEngine): AgentTaskRow => {
  const row = at(engine.registry.rows, 0);
  assert.ok(row instanceof AgentTaskRow, "one agent row per invocation");
  return row;
};

test("a dispatch's row usage sums its assistant messages and the tally matches", async () => {
  // Two assistant messages: a tool call, then the final answer.
  faux.setResponses([
    () =>
      fauxAssistantMessage([fauxToolCall("read", { path: "/nonexistent/pi-dent-usage" })], {
        stopReason: "toolUse",
      }),
    () => fauxAssistantMessage("done"),
  ]);
  const { root, sessionFile } = newRoot();
  const tally = new UsageTally();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps({ usageTally: tally }),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: makeHost(root, sessionFile, ["Agent", "read"]),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");

  const record = at(recordsOf(result), 0);
  assert.equal(record.usage.turns, 2, "one attempt, two assistant messages");
  const row = agentRow(engine);
  const usage = must(row.usage);
  assert.equal(usage.turns, 2, "the row sums both of the attempt's assistant messages");
  assert.ok(usage.input + usage.cacheRead + usage.cacheWrite > 0, "tokens are summed");
  assert.equal(usage.input, record.usage.input);
  assert.equal(usage.output, record.usage.output);
  assert.equal(usage.cacheRead, record.usage.cacheRead);
  assert.equal(usage.cacheWrite, record.usage.cacheWrite);
  assert.equal(usage.cost, record.usage.cost);

  assert.equal(tally.tasks, 1, "the dispatch is counted once");
  assert.deepEqual(tally.sum, usage, "the tally adds every message the row added");
  assert.equal(tally.statusText()?.startsWith("1 agent · 2 turns · "), true);
});

test("a pre-start rejection leaves the tally unchanged and its row without usage", async () => {
  faux.setResponses([]);
  const tally = new UsageTally();
  const engine = new DispatchEngine(
    bootWith(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps({ usageTally: tally }),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: undefined,
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, true, textOf(result));
  assert.equal(at(recordsOf(result), 0).failureCode, "missing-tool-authority");
  assert.equal(tally.tasks, 0, "a pre-start rejection is no dispatch");
  assert.deepEqual(tally.sum, zeroUsageSum());
  assert.equal(tally.statusText(), undefined);
  const row = agentRow(engine);
  assert.equal(row.consumed, true);
  assert.equal(row.usage, undefined, "no assistant message ended in a rejected dispatch");
});

test("a recovery attempt keeps the row's usage growing and counts one task", async () => {
  faux.setResponses([
    () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" }),
    () => fauxAssistantMessage("recovered"),
  ]);
  const { root, sessionFile } = newRoot();
  const tally = new UsageTally();
  const engine = new DispatchEngine(
    bootWith(1),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps({ usageTally: tally }),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: makeHost(root, sessionFile),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "recovered");

  const records = recordsOf(result);
  assert.equal(records.length, 2, "a transient error is recovered by a second attempt");
  assert.equal(at(records, 0).usage.turns, 1, "an attempt record holds its own attempt's usage");
  assert.equal(at(records, 1).usage.turns, 1);

  const row = agentRow(engine);
  assert.equal(must(row.usage).turns, 2, "the row's usage is never reset between attempts");
  assert.equal(tally.tasks, 1, "a recovery attempt is no new dispatch");
  assert.deepEqual(tally.sum, must(row.usage), "the tally counts each message once");
});
