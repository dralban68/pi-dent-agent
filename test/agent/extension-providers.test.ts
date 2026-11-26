import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  DispatchEngine,
  hostFromContext,
  type BootSnapshot,
  type ToolResult,
} from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostExtensionProvider, HostSession } from "../../lib/host.ts";
import { must } from "../support/must.ts";

/**
 * specs/agent-tool.md#child-session: the child's model runtime holds the dispatching
 * session's extension providers as it holds them, so a model of a provider only an
 * extension of the dispatching session registered runs in the child with the stored
 * OAuth credential; a copy the dispatching session no longer holds is removed; a
 * provider that cannot be added is named in a warning; a virtual model the child
 * cannot list fails at startup.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-agent-providers-"));
  roots.push(root);
  return root;
}

const PROVIDER = "parent-only";
const ACCESS_TOKEN = "parent-access-token";

const home = newRoot();
const agentDir = join(home, "pi-agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(
  join(agentDir, "auth.json"),
  JSON.stringify({
    faux: { type: "api_key", key: "k" },
    [PROVIDER]: {
      type: "oauth",
      access: ACCESS_TOKEN,
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
    },
  }),
);
process.env.PI_CODING_AGENT_DIR = agentDir;

const faux = registerFauxProvider({ models: [{ id: "m" }], tokensPerSecond: 1000 });
after(() => faux.unregister());
const fauxStream = must(getApiProvider(faux.api as never)).streamSimple;

const modelConfig = (id: string) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text" as const],
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
    streamSimple: fauxStream as never,
    models: [modelConfig("m")],
  });
  return runtime;
};
const model = faux.getModel();

/** The API keys the parent-only provider's stream was called with. */
const seenKeys: (string | undefined)[] = [];

/**
 * The dispatching session's own model runtime, holding a provider registered with an
 * OAuth block as an extension registers it; the child's runtime starts without it.
 */
const parentRuntime = await realCreate({ refreshOnCreate: false });
parentRuntime.registerProvider(PROVIDER, {
  baseUrl: "http://parent-only.invalid",
  api: faux.api as never,
  streamSimple: ((m: never, context: never, options?: { apiKey?: string }) => {
    seenKeys.push(options?.apiKey);
    return fauxStream(m, context, options as never);
  }) as never,
  oauth: {
    name: "Parent Only",
    login: async () => {
      throw new Error("no login in tests");
    },
    refreshToken: async (credentials) => credentials,
    getApiKey: (credentials) => credentials.access,
  },
  models: [modelConfig("pm")],
});
const parentModel = must(
  parentRuntime.getModels().find((candidate) => candidate.provider === PROVIDER),
);

/** The main host's providers, read through the host adapter over the extension context. */
const mainProviders = hostFromContext(
  {} as Pick<ExtensionAPI, "getActiveTools" | "sendMessage">,
  { modelRegistry: new ModelRegistry(parentRuntime) } as unknown as ExtensionContext,
).extensionProviders;

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
  };
}

interface HostOptions {
  current: { provider: string; id: string; api?: string };
  inventory: readonly (typeof model)[];
  extensionProviders?: (() => readonly HostExtensionProvider[]) | undefined;
  warn?: (message: string) => void;
}

function makeHost(root: string, options: HostOptions): HostSession {
  const mainDir = join(root, "main");
  mkdirSync(mainDir, { recursive: true });
  return {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => join(mainDir, "main.jsonl"),
    sessionDir: () => root,
    model: () => ({ provider: options.current.provider, id: options.current.id }),
    thinking: () => undefined,
    activeTools: () => ["Agent"],
    allTools: () => [],
    ...(options.extensionProviders ? { extensionProviders: options.extensionProviders } : {}),
    inventory: () => options.inventory,
    configuredModels: () => options.inventory,
    contextWindow: () => 100000,
    compaction: () => undefined,
    notify: () => {},
    warn: options.warn ?? (() => {}),
  };
}

function dispatch(host: HostSession): Promise<ToolResult> {
  const engine = new DispatchEngine(
    boot(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  return engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", background: false },
    host,
    cohortId: "cohort-1",
  });
}

function textOf(result: ToolResult): string {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
}

function firstRecord(result: ToolResult): { failureCode?: string; failurePhase?: string } {
  const details = result.details as {
    results?: { failureCode?: string; failurePhase?: string }[];
  };
  return must(details.results?.[0]);
}

test("a child runs on a provider only an extension of the dispatching session registered, with its stored OAuth credential", async () => {
  const root = newRoot();
  faux.setResponses([() => fauxAssistantMessage("done")]);
  seenKeys.length = 0;
  const result = await dispatch(
    makeHost(root, {
      current: parentModel,
      inventory: [model, parentModel],
      extensionProviders: mainProviders,
    }),
  );
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.deepEqual(seenKeys, [ACCESS_TOKEN], "the copied OAuth block resolved the credential");
});

test("a copied provider the dispatching session no longer holds is gone from the next child", async () => {
  const root = newRoot();
  faux.setResponses([() => fauxAssistantMessage("first")]);
  seenKeys.length = 0;
  const first = await dispatch(
    makeHost(root, {
      current: parentModel,
      inventory: [model, parentModel],
      extensionProviders: mainProviders,
    }),
  );
  assert.equal(textOf(first), "first");

  faux.setResponses([() => fauxAssistantMessage("second")]);
  seenKeys.length = 0;
  const second = await dispatch(
    makeHost(root, {
      current: parentModel,
      inventory: [model, parentModel],
      extensionProviders: () => [],
    }),
  );
  assert.equal(second.isError, true, textOf(second));
  // pi names the missing provider or its missing credential, depending on which it looks up first.
  assert.match(textOf(second), /Unknown provider: parent-only|No API key found for parent-only/);
  assert.deepEqual(seenKeys, [], "no request reached the removed provider");
});

test("a provider that cannot be added is named in a warning and the dispatch continues", async () => {
  const root = newRoot();
  faux.setResponses([() => fauxAssistantMessage("done")]);
  const warnings: string[] = [];
  const result = await dispatch(
    makeHost(root, {
      current: model,
      inventory: [model],
      // A stream handler without an API is refused by every model runtime.
      extensionProviders: () => [
        { id: "broken", kind: "config", config: { streamSimple: fauxStream as never } },
      ],
      warn: (message) => warnings.push(message),
    }),
  );
  assert.equal(textOf(result), "done");
  const warning = warnings.find((message) => message.includes("provider broken"));
  assert.ok(warning !== undefined, warnings.join("\n"));
  assert.match(warning, /^pi-dent: provider broken could not be registered for the child: .+/);
});

test("a virtual model the child's runtime does not list fails the dispatch at startup", async () => {
  const root = newRoot();
  const virtual = { ...model, provider: "router", id: "auto", api: "pi-virtual" };
  const result = await dispatch(
    makeHost(root, {
      current: virtual,
      inventory: [model, virtual as typeof model],
      extensionProviders: mainProviders,
    }),
  );
  assert.equal(result.isError, true);
  assert.match(
    textOf(result),
    /virtual model router\/auto is not available to the child: virtual models are not inherited/,
  );
  assert.deepEqual(
    { code: firstRecord(result).failureCode, phase: firstRecord(result).failurePhase },
    { code: "missing-model", phase: "startup" },
  );
});
