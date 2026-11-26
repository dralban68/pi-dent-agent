import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession } from "../../lib/host.ts";
import { must } from "../support/must.ts";

/**
 * specs/agent-tool.md#registration and specs/agent-tool.md#child-session: a child session's `Agent`
 * description is computed when the child session is created, with the model
 * catalog of the configured models. A real child runs on a scripted faux
 * provider; the tool declarations it was offered are read off its request.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "pi-dent-child-agent-description-"));
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
const modelKey = `${model.provider}/${model.id}`;

function boot(modelGuidance?: unknown): BootSnapshot {
  return {
    cwd: "/tmp",
    config: {
      merged: modelGuidance === undefined ? {} : { modelGuidance },
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

/** The description of the `Agent` declaration the request carries (its `toolsAdded` entries). */
function offeredDescription(messages: readonly unknown[]): string | undefined {
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.toolsAdded)) continue;
    for (const tool of message.toolsAdded) {
      if (isRecord(tool) && tool.name === "Agent" && typeof tool.description === "string") {
        return tool.description;
      }
    }
  }
  return undefined;
}

async function childAgentDescription(config: BootSnapshot): Promise<string | undefined> {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-child-agent-run-"));
  roots.push(root);
  const sessionFile = join(root, "main.jsonl");
  let description: string | undefined;
  faux.setResponses([
    (context) => {
      description = offeredDescription(context.messages);
      return fauxAssistantMessage("done");
    },
  ]);
  const engine = new DispatchEngine(
    config,
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: makeHost(["Agent", "read"], root, sessionFile),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined, "the child completes on the scripted answer");
  return description;
}

test("a child's Agent description carries the model catalog of the configured models", async () => {
  const description = await childAgentDescription(
    boot({ models: { [modelKey]: { when: "cheap edits" } } }),
  );
  assert.ok(description, "the child is offered Agent");
  assert.ok(
    description.endsWith(`\n\nModels:\n- ${modelKey}: cheap edits`),
    description.slice(-200),
  );
});

test("a child's Agent description has no Models suffix without guided models", async () => {
  const description = await childAgentDescription(boot());
  assert.ok(description, "the child is offered Agent");
  assert.equal(description.includes("Models:"), false);
});
