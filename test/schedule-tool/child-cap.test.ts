import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DispatchEngine, effectiveToolCap, type BootSnapshot } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession } from "../../lib/host.ts";
import { must } from "../support/must.ts";

/**
 * specs/agent-tool.md Section 3.1: a tool-cap name naming `Schedule` is not
 * bound, so a child session never has the tool. A real child runs on a
 * scripted faux provider, and the tool declarations the child was offered are
 * read off its request.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "pi-dent-schedule-cap-"));
roots.push(home);
const agentDir = join(home, "pi-agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const faux = registerFauxProvider({ models: [{ id: "m" }], tokensPerSecond: 60 });
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

/** The child tool definitions the engine binds (engine.ts childTools, sans Fleet/Skill). */
const CHILD_TOOLS = ["Bash", "Agent", "Task", "Plugin", "Session", "Script"].map((name) => ({
  name,
}));

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

function makeHost(cap: readonly string[], root: string, sessionFile: string): HostSession {
  return {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => sessionFile,
    sessionDir: () => root,
    model: () => ({ provider: model.provider, id: model.id }),
    thinking: () => undefined,
    activeTools: () => [...cap],
    inventory: () => [model as never],
    configuredModels: () => [model as never],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The tool names the request declares (the transcript's `toolsAdded` entries). */
function offeredTools(messages: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const added = message.toolsAdded;
    if (!Array.isArray(added)) continue;
    for (const tool of added) {
      if (isRecord(tool) && typeof tool.name === "string") names.push(tool.name);
    }
  }
  return names;
}

test("the effective child cap drops a Schedule name", () => {
  assert.deepEqual(
    effectiveToolCap(["Agent", "Schedule", "read", "Bash", "Schedule"], CHILD_TOOLS, []),
    ["Agent", "read", "Bash"],
    "Schedule is neither a pi builtin nor a child tool, so it is dropped",
  );
});

test("a real child session is offered no Schedule tool, even when the cap names it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-schedule-child-"));
  roots.push(root);
  const sessionFile = join(root, "main.jsonl");
  const requests: string[][] = [];
  faux.setResponses([
    (context) => {
      requests.push(offeredTools(context.messages));
      return fauxAssistantMessage("done");
    },
  ]);
  const engine = new DispatchEngine(
    boot(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: makeHost(["Agent", "Schedule", "read", "Bash"], root, sessionFile),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined, "the child completes on the scripted answer");
  const offered = must(requests[0]);
  // The declarations are read, so a missing Schedule is not an empty read.
  for (const name of ["Agent", "read", "Bash"]) {
    assert.ok(offered.includes(name), `the child is offered ${name}`);
  }
  assert.equal(
    offered.includes("Schedule"),
    false,
    "the child binds the effective cap: the Schedule name is dropped, not bound",
  );
});
