import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot, type ToolResult } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession, HostToolInfo } from "../../lib/host.ts";
import { must } from "../support/must.ts";

/**
 * specs/agent-tool.md#tools lifecycle rules: the child runs its inherited
 * extensions' session-start before its first prompt, so tools registered then
 * are available, and invokes their session-shutdown on completion, cancellation
 * and failure. It loads the sources from the dispatching session's inventory, so
 * a child whose working directory differs still has them.
 */

// --- Runtime harness: the same faux wiring as test/agent/extension-inheritance.test.ts ---

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-extension-lifecycle-"));
  roots.push(root);
  return root;
}

const home = newRoot();
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

function boot(maxRecoveryRetries = 0): BootSnapshot {
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

function writeExtension(root: string, name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, source);
  return path;
}

/**
 * A file extension registering `Marker`, which appends `tool` when it runs, and
 * recording its session start and shutdown in the same marker file.
 */
function lifecycleExtension(marker: string): string {
  return `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => {
    appendFileSync(${JSON.stringify(marker)}, "start\\n");
  });
  pi.on("session_shutdown", () => {
    appendFileSync(${JSON.stringify(marker)}, "shutdown\\n");
  });
  pi.registerTool({
    name: "Marker",
    label: "Marker",
    description: "marker probe",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      appendFileSync(${JSON.stringify(marker)}, "tool\\n");
      return { content: [{ type: "text", text: "Marker ran" }], details: {} };
    },
  });
}
`;
}

/** The main session's host, whose complete tool inventory holds the extension's `Marker`. */
function mainHost(root: string, extension: string, activeTools: readonly string[]): HostSession {
  const allTools: HostToolInfo[] = [{ name: "Marker", sourceInfo: { path: extension } }];
  return {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => join(root, "main", "main.jsonl"),
    sessionDir: () => root,
    model: () => ({ provider: model.provider, id: model.id }),
    thinking: () => undefined,
    activeTools: () => [...activeTools],
    allTools: () => allTools,
    inventory: () => [model],
    configuredModels: () => [model],
    contextWindow: () => 100000,
    compaction: () => undefined,
    notify: () => {},
  };
}

/** One dispatch of the host's child, configured from the test's boot snapshot. */
function dispatchOnce(
  root: string,
  extension: string,
  activeTools: readonly string[],
  params: Record<string, unknown>,
  options: { signal?: AbortSignal | undefined; maxRecoveryRetries?: number | undefined } = {},
): Promise<ToolResult> {
  mkdirSync(join(root, "main"), { recursive: true });
  const engine = new DispatchEngine(
    boot(options.maxRecoveryRetries ?? 0),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  return engine.dispatch({
    toolCallId: "call-1",
    params: params as never,
    signal: options.signal,
    host: mainHost(root, extension, activeTools),
    cohortId: "cohort-1",
  });
}

// --- Helpers ---------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function textOf(result: ToolResult): string {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
}

// --- Tests -----------------------------------------------------------------

test("the child runs its inherited extensions' session-start before its first prompt", async () => {
  const root = newRoot();
  const marker = join(root, "life.log");
  const extension = writeExtension(root, "lifecycle.mjs", lifecycleExtension(marker));
  const seenAtFirstPrompt: string[] = [];
  faux.setResponses([
    () => {
      seenAtFirstPrompt.push(existsSync(marker) ? readFileSync(marker, "utf8") : "");
      return fauxAssistantMessage("done");
    },
  ]);

  const result = await dispatchOnce(root, extension, ["Agent"], { prompt: "P", task: "go" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.deepEqual(
    seenAtFirstPrompt,
    ["start\n"],
    "the extension's session start had already run at the child's first prompt",
  );
});

test("a cancelled dispatch runs session-shutdown", async () => {
  const root = newRoot();
  const marker = join(root, "life.log");
  const extension = writeExtension(root, "lifecycle.mjs", lifecycleExtension(marker));
  const modelStarted = deferred<void>();
  const gate = deferred<void>();
  faux.setResponses([
    async () => {
      modelStarted.resolve();
      await gate.promise;
      return fauxAssistantMessage("too late");
    },
  ]);

  const controller = new AbortController();
  const dispatched = dispatchOnce(
    root,
    extension,
    ["Agent"],
    { prompt: "P", task: "go" },
    { signal: controller.signal },
  );
  await modelStarted.promise;
  assert.equal(readFileSync(marker, "utf8"), "start\n", "the child started its extensions");

  controller.abort();
  gate.resolve();
  const result = await dispatched;
  assert.equal(result.isError, true, "the cancelled dispatch failed");
  assert.ok(
    readFileSync(marker, "utf8").endsWith("shutdown\n"),
    "the cancelled dispatch ran session-shutdown",
  );
});

test("a failed dispatch runs session-shutdown", async () => {
  const root = newRoot();
  const marker = join(root, "life.log");
  const extension = writeExtension(root, "lifecycle.mjs", lifecycleExtension(marker));
  // A non-transient error (specs/agent-tool.md#recovery), with no recovery attempt allowed.
  faux.setResponses([
    () =>
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "invalid api key for provider",
      }),
  ]);

  const result = await dispatchOnce(
    root,
    extension,
    ["Agent"],
    { prompt: "P", task: "go" },
    { maxRecoveryRetries: 0 },
  );
  assert.equal(result.isError, true, textOf(result));
  assert.ok(
    readFileSync(marker, "utf8").endsWith("shutdown\n"),
    "the failed dispatch ran session-shutdown",
  );
});

test("the child loads the parent's extension sources even when its working directory differs", async () => {
  const root = newRoot();
  const marker = join(root, "ran.log");
  const extension = writeExtension(root, "probe.mjs", lifecycleExtension(marker));
  const elsewhere = newRoot();
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("Marker", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done"),
  ]);

  const result = await dispatchOnce(root, extension, ["Agent", "Marker"], {
    prompt: "P",
    task: "go",
    cwd: elsewhere,
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.match(
    readFileSync(marker, "utf8"),
    /tool/,
    "the extension's tool ran from the dispatching session's source, not the child's cwd",
  );
});

test("the child discovers no extensions from its own working directory or settings", async () => {
  const root = newRoot();
  const marker = join(root, "inherited.log");
  const extension = writeExtension(root, "probe.mjs", lifecycleExtension(marker));
  // An extension planted where the child runs: its settings and working directory.
  const elsewhere = newRoot();
  const planted = join(elsewhere, ".pi", "extensions");
  mkdirSync(planted, { recursive: true });
  writeFileSync(
    join(planted, "planted.mjs"),
    `import { appendFileSync } from "node:fs";
export default function (pi) {
  appendFileSync(${JSON.stringify(join(root, "planted.log"))}, "loaded\\n");
  pi.registerTool({
    name: "Planted",
    label: "Planted",
    description: "planted probe",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: "planted" }], details: {} };
    },
  });
}
`,
  );
  writeFileSync(
    join(elsewhere, ".pi", "settings.json"),
    JSON.stringify({ extensions: [join(planted, "planted.mjs")] }),
  );
  faux.setResponses([() => fauxAssistantMessage("done")]);

  const result = await dispatchOnce(root, extension, ["Agent", "Planted"], {
    prompt: "P",
    task: "go",
    cwd: elsewhere,
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.equal(
    existsSync(join(root, "planted.log")),
    false,
    "the child's own settings and working directory add no extension",
  );
  assert.match(readFileSync(marker, "utf8"), /start/, "the inherited source still started");
});
