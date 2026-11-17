import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  getApiProvider,
  registerFauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession } from "../../lib/host.ts";
import { at, must } from "../support/must.ts";

/**
 * specs/agent-tool.md Section 3.4 through dispatch: a child runs with the dispatching
 * session's compaction settings, completed from the defaults, and neither its own
 * working directory's settings nor a nested dispatch's change them.
 */

const root = mkdtempSync(join(tmpdir(), "pi-dent-child-compaction-"));
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

/** Every settings manager the engine created during the test, by the working directory it read. */
const created: { cwd: string; manager: SettingsManager }[] = [];
const realSettingsCreate = SettingsManager.create.bind(SettingsManager);
SettingsManager.create = (cwd: string, dir?: string, options?: never) => {
  const manager = realSettingsCreate(cwd, dir, options);
  created.push({ cwd, manager });
  return manager;
};
after(() => {
  SettingsManager.create = realSettingsCreate;
});

/** The settings a session of `cwd` runs with, as the engine handed them to its session. */
function compactionAt(cwd: string): unknown {
  const entry = created.find((candidate) => realpathSync(candidate.cwd) === realpathSync(cwd));
  if (!entry) assert.fail(`no session was created for ${cwd}`);
  return entry.manager.getSettings().compaction;
}

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

function makeHost(
  inherited: () => { reserveTokens: number; keepRecentTokens: number },
): HostSession {
  return {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => join(root, "main.jsonl"),
    sessionDir: () => root,
    model: () => ({ provider: model.provider, id: model.id }),
    thinking: () => undefined,
    activeTools: () => ["Agent"],
    inventory: () => [model as never],
    configuredModels: () => [model as never],
    contextWindow: () => 100000,
    compaction: inherited,
    notify: () => {},
  };
}

/** A directory whose own settings name different compaction values, so a rewire shows. */
function childCwd(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "settings.json"),
    JSON.stringify({ compaction: { enabled: false, reserveTokens: 7, keepRecentTokens: 9 } }),
  );
  return dir;
}

function singleTurn(answer: string): void {
  faux.setResponses([() => fauxAssistantMessage(answer)]);
}

function nestedTurn(cwd: string): void {
  let turn = 0;
  const step: FauxResponseStep = () =>
    turn++ === 0
      ? fauxAssistantMessage(
          [fauxToolCall("Agent", { prompt: "inner", task: "inner", cwd } as never)],
          { stopReason: "toolUse" },
        )
      : fauxAssistantMessage("outer done");
  faux.setResponses([step, step, step, step, step, step]);
}

const inherited = { reserveTokens: 4321, keepRecentTokens: 5 };
const withDefaults = { enabled: true, reserveTokens: 4321, keepRecentTokens: 5 };

test("a child runs with the dispatching session's compaction settings, not its directory's", async () => {
  singleTurn("done");
  const cwd = childCwd("plain-child");
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
    params: { prompt: "P", task: "go", background: false, cwd },
    host: makeHost(() => inherited),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(compactionAt(cwd), withDefaults);
});

test("a nested dispatch inherits the child's compaction settings, not its own directory's", async () => {
  const nestedCwd = childCwd("nested-child");
  nestedTurn(nestedCwd);
  const cwd = childCwd("outer-child");
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
    params: { prompt: "P", task: "go", background: false, cwd },
    host: makeHost(() => inherited),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined);
  assert.equal(at(engine.registry.list(), 0).result, "outer done", "the nested dispatch ran");
  // The nested child's session ran in its own directory, whose settings name other values.
  assert.deepEqual(compactionAt(cwd), withDefaults);
  assert.deepEqual(compactionAt(nestedCwd), withDefaults);
});
