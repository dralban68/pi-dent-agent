import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  getApiProvider,
  registerFauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot } from "../../lib/engine.ts";
import type { HostSession } from "../../lib/host.ts";
import { readBashSettings } from "../../lib/bash-tool.ts";
import { at, must } from "../support/must.ts";

/**
 * specs/bash-tool.md Section 3: a settings file that cannot be read is reported once per boot
 * window per file, whichever session calls `Bash`. The extension instance passes its reporter
 * to the engine, so a child session's call reports it too.
 */

const root = mkdtempSync(join(tmpdir(), "pi-dent-child-bash-settings-"));
process.env.TMPDIR = join(root, "tmp");
mkdirSync(process.env.TMPDIR, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const agentDir = join(root, "pi-agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

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

function makeHost(): HostSession {
  return {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => join(root, "main.jsonl"),
    sessionDir: () => root,
    model: () => ({ provider: model.provider, id: model.id }),
    thinking: () => undefined,
    activeTools: () => ["Agent", "Bash"],
    inventory: () => [model as never],
    configuredModels: () => [model as never],
    contextWindow: () => 100000,
    compaction: () => undefined,
    notify: () => {},
  };
}

/** A child that calls `Bash` on its first turn and then answers. */
function scriptBash(): void {
  let turn = 0;
  const step: FauxResponseStep = () =>
    turn++ === 0
      ? fauxAssistantMessage([fauxToolCall("Bash", { command: "true" } as never)], {
          stopReason: "toolUse",
        })
      : fauxAssistantMessage("done");
  faux.setResponses([step, step, step, step]);
}

/** A directory whose `.pi/settings.json` cannot be parsed; returns the file's path. */
function brokenProject(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  const file = join(dir, ".pi", "settings.json");
  writeFileSync(file, "{ not json");
  return file;
}

async function dispatchChild(engine: DispatchEngine, cwd: string): Promise<void> {
  const result = await engine.dispatch({
    toolCallId: `call-${Math.random().toString(36).slice(2)}`,
    params: { prompt: "P", task: "go", background: false, cwd },
    host: makeHost(),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined);
}

test("a child session's Bash reports a settings file it cannot read, once per boot window", async () => {
  const cwd = join(root, "child-project");
  const settingsPath = brokenProject("child-project");
  const reported: string[] = [];
  const warned = new Set<string>();
  const engine = new DispatchEngine(boot(), () => undefined, undefined, undefined, undefined, {
    bashSettings: (path) => readBashSettings(path, (message) => reported.push(message), warned),
  });

  scriptBash();
  await dispatchChild(engine, cwd);
  assert.equal(reported.length, 1, JSON.stringify(reported));
  assert.ok(at(reported, 0).startsWith(`${settingsPath}: `), at(reported, 0));

  // The same file of the same boot window is not reported by the next child session.
  scriptBash();
  await dispatchChild(engine, cwd);
  assert.equal(reported.length, 1, JSON.stringify(reported));
});
