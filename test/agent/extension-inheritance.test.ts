import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  ModelRuntime,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  DispatchEngine,
  hostFromContext,
  hostFromSessionBox,
  inheritedExtensions,
  type BootSnapshot,
  type EngineDeps,
  type ToolResult,
} from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession, HostToolInfo } from "../../lib/host.ts";
import { must } from "../support/must.ts";

/**
 * specs/agent-tool.md Section 3.1: a child loads the dispatching session's
 * extension sources — files and `builtin:<name>` paths — in inventory order,
 * never its own and never pi-dent's package again. It binds the tool cap's
 * extension tools, even one a source registers only at session start, and
 * nothing outside the cap. An inherited source that cannot load is named to the
 * dispatching session with its error while the dispatch continues.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-agent-extensions-"));
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

/** The repository root, the directory a child must never load as an extension again. */
const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

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

function writeExtension(root: string, name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, source);
  return path;
}

/** A file extension registering `tools`, each appending its name to `marker` when it runs. */
function toolExtension(marker: string, tools: readonly string[]): string {
  const registrations = tools
    .map(
      (name) => `  pi.registerTool({
    name: ${JSON.stringify(name)},
    label: ${JSON.stringify(name)},
    description: ${JSON.stringify(`${name} probe`)},
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)});
      return { content: [{ type: "text", text: ${JSON.stringify(`${name} ran`)} }], details: {} };
    },
  });`,
    )
    .join("\n");
  return `import { appendFileSync } from "node:fs";
export default function (pi) {
${registrations}
}
`;
}

/** A file extension that registers `Probe`, which nested-calls `target` and records the outcome. */
function nestedProbeExtension(marker: string, target: string): string {
  return `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.registerTool({
    name: "Probe",
    label: "Probe",
    description: "nested call probe",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(id, params, signal, onUpdate, ctx) {
      const outcome = await ctx.executeTool(${JSON.stringify(target)}, {});
      const text = (outcome.result.content ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(" ");
      appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ isError: outcome.isError, text }) + "\\n");
      return { content: [{ type: "text", text: "Probe ran" }], details: {} };
    },
  });
}
`;
}

/**
 * A file extension that registers MCP-style tools at session start, as the MCP
 * extension does, optionally with codemode exposure.
 */
function sessionStartProxyExtension(
  marker: string,
  tools: readonly string[],
  options: { exposure?: "codemode" } = {},
): string {
  const registrations = tools
    .map(
      (name) => `    pi.registerTool({
      name: ${JSON.stringify(name)},
      label: ${JSON.stringify(name)},
      description: "mcp proxy",
      ${options.exposure === undefined ? "" : `exposure: ${JSON.stringify(options.exposure)},`}
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return { content: [{ type: "text", text: ${JSON.stringify(`${name} ran`)} }], details: {} };
      },
    });`,
    )
    .join("\n");
  return `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => {
    appendFileSync(${JSON.stringify(marker)}, "registered\\n");
${registrations}
  });
}
`;
}

/** A fake built-in extension supplying `BuiltinProbe` for the `builtin:probe` source. */
function builtinProbe(marker: string): InlineExtension {
  return {
    name: "probe",
    builtin: true,
    replaceable: true,
    factory: (pi: ExtensionAPI) => {
      pi.registerTool(
        defineTool({
          name: "BuiltinProbe",
          label: "BuiltinProbe",
          description: "builtin probe",
          parameters: Type.Object({}),
          async execute() {
            appendFileSync(marker, "BuiltinProbe\n");
            return { content: [{ type: "text", text: "BuiltinProbe ran" }], details: {} };
          },
        }),
      );
    },
  };
}

/** A file extension recording its session start and shutdown, optionally failing the start. */
function lifecycleExtension(
  marker: string,
  options: { failStart?: boolean; hangShutdown?: boolean } = {},
): string {
  return `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => {
    appendFileSync(${JSON.stringify(marker)}, "start\\n");
    ${options.failStart === true ? 'throw new Error("start boom");' : ""}
  });
  pi.on("session_shutdown", () => {
    appendFileSync(${JSON.stringify(marker)}, "shutdown\\n");
    ${options.hangShutdown === true ? "return new Promise(() => {});" : ""}
  });
}
`;
}

interface HostOptions {
  /** The complete tool inventory; a function serves the freeze and query tests. */
  allTools?: readonly HostToolInfo[] | (() => readonly HostToolInfo[]) | undefined;
  activeTools?: readonly string[] | undefined;
  notify?: ((message: string) => void) | undefined;
  /** The warning channel; defaults to `notify` so a test that only counts messages keeps working. */
  warn?: ((message: string) => void) | undefined;
}

function makeHost(root: string, sessionFile: string, options: HostOptions = {}): HostSession {
  const inventory = options.allTools;
  return {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => sessionFile,
    sessionDir: () => root,
    model: () => ({ provider: model.provider, id: model.id }),
    thinking: () => undefined,
    activeTools: () => [...(options.activeTools ?? ["Agent"])],
    allTools: () => (typeof inventory === "function" ? inventory() : (inventory ?? [])),
    inventory: () => [model],
    configuredModels: () => [model],
    contextWindow: () => 100000,
    compaction: () => undefined,
    notify: options.notify ?? (() => {}),
    warn: options.warn ?? options.notify ?? (() => {}),
  };
}

async function dispatchWith(
  root: string,
  options: HostOptions,
  deps: Partial<EngineDeps> = {},
): Promise<ToolResult> {
  const mainDir = join(root, "main");
  mkdirSync(mainDir, { recursive: true });
  const engine = new DispatchEngine(
    boot(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(deps),
  );
  return engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", background: false },
    host: makeHost(root, join(mainDir, "main.jsonl"), options),
    cohortId: "cohort-1",
  });
}

function textOf(result: ToolResult): string {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
}

/** The tool results a child session recorded, as `[toolName, isError]` pairs. */
function toolResults(result: ToolResult): [string, boolean][] {
  const details = result.details as { results?: { sessionPath?: string | undefined }[] };
  const sessionPath = details.results?.[0]?.sessionPath;
  assert.ok(sessionPath !== undefined, "the attempt recorded its child session path");
  return readFileSync(sessionPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type?: string; message?: unknown })
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message)
    .filter(
      (message): message is { role: string; toolName: string; isError: boolean } =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "toolResult" &&
        "toolName" in message &&
        typeof message.toolName === "string" &&
        "isError" in message &&
        typeof message.isError === "boolean",
    )
    .map((message) => [message.toolName, message.isError]);
}

/** The nested-call outcomes the probe extension recorded. */
function probeOutcomes(marker: string): { isError: boolean; text: string }[] {
  return readFileSync(marker, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { isError: boolean; text: string });
}

/** One probe call, then the final answer. */
function probeThenAnswer(toolName: string): void {
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall(toolName, {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done"),
  ]);
}

test("snapshot: sources keep inventory order within the file and built-in groups, dropping pi built-in tools and pi-dent's own code but keeping dependencies", () => {
  const outsideA = join(tmpdir(), "pi-dent-not-a-real-extension-a.mjs");
  const outsideB = join(tmpdir(), "pi-dent-not-a-real-extension-b.mjs");
  const dependency = join(packageRoot, "node_modules", "pi-mcp-adapter", "index.ts");
  const aliasRoot = newRoot();
  const alias = join(aliasRoot, "alias.ts");
  symlinkSync(join(packageRoot, "lib", "engine.ts"), alias);
  const host = makeHost(tmpdir(), join(tmpdir(), "pi-dent-snapshot-main.jsonl"), {
    allTools: [
      { name: "Thing", sourceInfo: { path: join(packageRoot, "index.ts") } },
      { name: "Engine", sourceInfo: { path: join(packageRoot, "lib", "engine.ts") } },
      { name: "Root", sourceInfo: { path: packageRoot } },
      { name: "Alias", sourceInfo: { path: alias } },
      { name: "read", sourceInfo: { path: "builtin:read" } },
      { name: "bash", sourceInfo: { path: "builtin:bash" } },
      { name: "Relative", sourceInfo: { path: "relative/extension.mjs" } },
      { name: "Missing", sourceInfo: {} },
      { name: "Dependency", sourceInfo: { path: dependency } },
      { name: "A", sourceInfo: { path: outsideA } },
      { name: "A again", sourceInfo: { path: outsideA } },
      { name: "Mcp", sourceInfo: { path: "builtin:mcp" } },
      { name: "Proxy", sourceInfo: { path: "builtin:mcp" } },
      { name: "Llama", sourceInfo: { path: "builtin:llama.cpp" } },
      { name: "B", sourceInfo: { path: outsideB } },
    ],
  });
  // The sources are the policy contract; which tools they carry is asserted by the
  // dispatch tests below.
  const { sources } = inheritedExtensions(host);
  assert.deepEqual(
    sources.filter((source) => !source.startsWith("builtin:")),
    [dependency, outsideA, outsideB],
    "file sources keep inventory order",
  );
  assert.deepEqual(
    sources.filter((source) => source.startsWith("builtin:")),
    ["builtin:mcp", "builtin:llama.cpp"],
    "built-in sources keep inventory order",
  );
});

test("a child binds and runs a parent extension tool inside the cap, and none outside it", async () => {
  const root = newRoot();
  const marker = join(root, "ran.log");
  const extension = writeExtension(root, "probe.mjs", toolExtension(marker, ["Probe", "Other"]));
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("Other", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxToolCall("Probe", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done"),
  ]);
  const result = await dispatchWith(root, {
    allTools: [
      { name: "Probe", sourceInfo: { path: extension } },
      { name: "Other", sourceInfo: { path: extension } },
    ],
    activeTools: ["Agent", "Probe"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.deepEqual(
    toolResults(result),
    [
      ["Other", true],
      ["Probe", false],
    ],
    "the tool outside the cap is not bound",
  );
  // `Other` is registered by the extension but outside the cap, so it never runs.
  assert.equal(readFileSync(marker, "utf8"), "Probe\n");
});

test("the extension sources are the dispatch snapshot, not a live inventory read", async () => {
  const root = newRoot();
  const marker = join(root, "ran.log");
  const extension = writeExtension(root, "probe.mjs", toolExtension(marker, ["Probe"]));
  let inventory: HostToolInfo[] = [{ name: "Probe", sourceInfo: { path: extension } }];
  faux.setResponses([
    () => {
      // The parent's inventory changes while the child runs; its snapshot does not.
      inventory = [];
      return fauxAssistantMessage([fauxToolCall("Probe", {})], { stopReason: "toolUse" });
    },
    () => fauxAssistantMessage("done"),
  ]);
  const result = await dispatchWith(root, {
    allTools: () => inventory,
    activeTools: ["Agent", "Probe"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(toolResults(result), [["Probe", false]]);
  assert.equal(readFileSync(marker, "utf8"), "Probe\n");
});

test("a dispatch never loads a path in pi-dent's own package", async () => {
  const root = newRoot();
  const marker = join(root, "ran.log");
  const extension = writeExtension(root, "probe.mjs", toolExtension(marker, ["Probe"]));
  const warnings: string[] = [];
  probeThenAnswer("Probe");
  const result = await dispatchWith(root, {
    allTools: [
      // Real files of pi-dent's package. `lib/engine.ts` has no default extension
      // factory, so the loader would report it were it loaded at all.
      { name: "Engine", sourceInfo: { path: join(packageRoot, "lib", "engine.ts") } },
      { name: "Agent", sourceInfo: { path: join(packageRoot, "index.ts") } },
      { name: "Probe", sourceInfo: { path: extension } },
    ],
    activeTools: ["Agent", "Probe"],
    notify: (message) => warnings.push(message),
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.deepEqual(warnings, []);
  assert.equal(readFileSync(marker, "utf8"), "Probe\n");
});

test("a failing inherited extension names its source and error while the dispatch continues", async () => {
  const root = newRoot();
  const marker = join(root, "ran.log");
  // The failing factory registers a tool before throwing, so the snapshot's tool
  // for it is known and must be unavailable.
  const broken = writeExtension(
    root,
    "broken.mjs",
    `export default function (pi) {
  pi.registerTool({
    name: "Broken",
    label: "Broken",
    description: "broken probe",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: "Broken ran" }], details: {} };
    },
  });
  throw new Error("factory boom");
}
`,
  );
  const extension = writeExtension(root, "probe.mjs", toolExtension(marker, ["Probe"]));
  const warnings: string[] = [];
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("Broken", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxToolCall("Probe", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done"),
  ]);
  const result = await dispatchWith(root, {
    allTools: [
      { name: "Broken", sourceInfo: { path: broken } },
      { name: "Probe", sourceInfo: { path: extension } },
    ],
    activeTools: ["Agent", "Broken", "Probe"],
    notify: (message) => warnings.push(message),
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.deepEqual(
    toolResults(result),
    [
      ["Broken", true],
      ["Probe", false],
    ],
    "the failed source's tool is not bound, the rest still load",
  );
  assert.equal(readFileSync(marker, "utf8"), "Probe\n");
  const warning = warnings.find(
    (message) => message.includes(basename(broken)) && message.includes("factory boom"),
  );
  assert.ok(warning, `expected a load warning naming ${broken}, got: ${warnings.join(" | ")}`);
  assert.match(must(warning), /^pi-dent: /, "the warning notification is pi-dent's");
});

test("a requested source the loader never loads is warned and its tools are unavailable", async () => {
  const root = newRoot();
  const marker = join(root, "ran.log");
  const missing = join(root, "gone.mjs");
  const extension = writeExtension(root, "probe.mjs", toolExtension(marker, ["Probe"]));
  const warnings: string[] = [];
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("Gone", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxToolCall("Probe", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done"),
  ]);
  const result = await dispatchWith(root, {
    allTools: [
      { name: "Gone", sourceInfo: { path: missing } },
      { name: "Probe", sourceInfo: { path: extension } },
    ],
    activeTools: ["Agent", "Gone", "Probe"],
    notify: (message) => warnings.push(message),
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.deepEqual(
    toolResults(result),
    [
      ["Gone", true],
      ["Probe", false],
    ],
    "the unloaded source's tool is not bound, the rest still load",
  );
  assert.equal(readFileSync(marker, "utf8"), "Probe\n");
  assert.ok(
    warnings.includes(
      `pi-dent: extension ${missing} failed to load: Extension path does not exist: ${missing}`,
    ),
    `expected a load failure naming ${missing}, got: ${warnings.join(" | ")}`,
  );
  assert.equal(
    warnings.filter((message) => message.includes(missing)).length,
    1,
    "the source is warned about once",
  );
});

test("a requested source the loader omits without an error is warned as not loaded", async () => {
  const root = newRoot();
  const fileMarker = join(root, "file.log");
  const builtinMarker = join(root, "builtin.log");
  // The file extension registers the same tool as the replaceable built-in, so the
  // loader drops the built-in without an error.
  const extension = writeExtension(root, "probe.mjs", toolExtension(fileMarker, ["BuiltinProbe"]));
  const warnings: string[] = [];
  probeThenAnswer("BuiltinProbe");
  const result = await dispatchWith(
    root,
    {
      allTools: [
        { name: "BuiltinProbe", sourceInfo: { path: "builtin:probe" } },
        { name: "BuiltinProbe", sourceInfo: { path: extension } },
      ],
      activeTools: ["Agent", "BuiltinProbe"],
      notify: (message) => warnings.push(message),
    },
    { builtinExtensions: [builtinProbe(builtinMarker)] },
  );
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.deepEqual(toolResults(result), [["BuiltinProbe", false]]);
  assert.equal(readFileSync(fileMarker, "utf8"), "BuiltinProbe\n", "the file's tool runs");
  assert.equal(existsSync(builtinMarker), false, "the replaced built-in registers nothing");
  assert.ok(
    warnings.some(
      (message) => message.includes("builtin:probe") && message.includes("was not loaded"),
    ),
    `expected a not-loaded warning for builtin:probe, got: ${warnings.join(" | ")}`,
  );
});

test("an extension's session lifecycle runs before the first prompt and shuts down by the dispatch return", async () => {
  const root = newRoot();
  const marker = join(root, "life.log");
  const extension = writeExtension(root, "lifecycle.mjs", lifecycleExtension(marker));
  faux.setResponses([() => fauxAssistantMessage("done")]);
  const result = await dispatchWith(root, {
    allTools: [{ name: "Lifecycle", sourceInfo: { path: extension } }],
    activeTools: ["Agent"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.equal(
    readFileSync(marker, "utf8"),
    "start\nshutdown\n",
    "the child starts its extensions, then shuts them down before the dispatch returns",
  );
});

test("a lifecycle error is warned to the dispatching session and the dispatch continues", async () => {
  const root = newRoot();
  const marker = join(root, "life.log");
  const extension = writeExtension(
    root,
    "lifecycle.mjs",
    lifecycleExtension(marker, { failStart: true }),
  );
  const warnings: string[] = [];
  faux.setResponses([() => fauxAssistantMessage("done")]);
  const result = await dispatchWith(root, {
    allTools: [{ name: "Lifecycle", sourceInfo: { path: extension } }],
    activeTools: ["Agent"],
    notify: (message) => warnings.push(message),
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.equal(
    readFileSync(marker, "utf8"),
    "start\nshutdown\n",
    "the start ran, the shutdown followed",
  );
  const warning = warnings.find(
    (message) => message.includes(extension) && message.includes("start boom"),
  );
  assert.ok(
    warning,
    `expected a lifecycle warning naming ${extension}, got: ${warnings.join(" | ")}`,
  );
  assert.match(must(warning), /session_start/, "the warning names the lifecycle event");
});

test("an unknown built-in source is reported as a load error instead of dropped silently", async () => {
  const root = newRoot();
  const marker = join(root, "ran.log");
  const extension = writeExtension(root, "probe.mjs", toolExtension(marker, ["Probe"]));
  const warnings: string[] = [];
  probeThenAnswer("Probe");
  const result = await dispatchWith(root, {
    allTools: [
      { name: "Llama", sourceInfo: { path: "builtin:llama.cpp" } },
      { name: "Probe", sourceInfo: { path: extension } },
    ],
    activeTools: ["Agent", "Probe"],
    notify: (message) => warnings.push(message),
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(readFileSync(marker, "utf8"), "Probe\n");
  assert.ok(
    warnings.some(
      (message) =>
        message.includes("builtin:llama.cpp") && message.includes("Unknown built-in extension"),
    ),
    `expected an unknown built-in warning, got: ${warnings.join(" | ")}`,
  );
  assert.equal(
    warnings.filter((message) => message.includes("builtin:llama.cpp")).length,
    1,
    "an errored source is not also warned about as not loaded",
  );
});

test("a child runs a tool of an inherited built-in extension source", async () => {
  const root = newRoot();
  const marker = join(root, "ran.log");
  probeThenAnswer("BuiltinProbe");
  const result = await dispatchWith(
    root,
    {
      allTools: [{ name: "BuiltinProbe", sourceInfo: { path: "builtin:probe" } }],
      activeTools: ["Agent", "BuiltinProbe"],
    },
    { builtinExtensions: [builtinProbe(marker)] },
  );
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.deepEqual(toolResults(result), [["BuiltinProbe", false]]);
  assert.equal(readFileSync(marker, "utf8"), "BuiltinProbe\n");
});

test("an MCP proxy tool registered at session start is callable only when the cap names an MCP tool", async () => {
  const root = newRoot();
  const probeMarker = join(root, "probe.log");
  const proxyMarker = join(root, "proxy.log");
  const probeFile = writeExtension(
    root,
    "probe.mjs",
    nestedProbeExtension(probeMarker, "mcp__fake__proxy"),
  );
  const proxyFile = writeExtension(
    root,
    "proxy.mjs",
    sessionStartProxyExtension(proxyMarker, ["mcp__fake__proxy"]),
  );
  const inventory: HostToolInfo[] = [
    { name: "Probe", sourceInfo: { path: probeFile } },
    { name: "mcp__fake__proxy", sourceInfo: { path: proxyFile } },
  ];

  // The cap names no `mcp__` tool: the proxy registers at session start but is
  // neither declared nor callable.
  probeThenAnswer("Probe");
  const outside = await dispatchWith(root, {
    allTools: inventory,
    activeTools: ["Agent", "Probe"],
  });
  assert.equal(outside.isError, undefined, textOf(outside));
  assert.deepEqual(toolResults(outside), [["Probe", false]]);
  assert.equal(readFileSync(proxyMarker, "utf8"), "registered\n");
  const [excluded] = probeOutcomes(probeMarker);
  assert.equal(must(excluded).isError, true, "a proxy outside the cap is not callable");

  // The cap names the proxy: the snapshot's inherited name keeps it in the cap
  // even though the source registers it only at session start.
  rmSync(probeMarker, { force: true });
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("mcp__fake__proxy", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxToolCall("Probe", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done"),
  ]);
  const inside = await dispatchWith(root, {
    allTools: inventory,
    activeTools: ["Agent", "Probe", "mcp__fake__proxy"],
  });
  assert.equal(inside.isError, undefined, textOf(inside));
  assert.deepEqual(
    toolResults(inside),
    [
      ["mcp__fake__proxy", false],
      ["Probe", false],
    ],
    "the cap's MCP tool is declared and callable",
  );
  const [included] = probeOutcomes(probeMarker);
  assert.equal(must(included).isError, false, "the cap's MCP tool is callable from a nested call");
});

test("a cap naming one MCP proxy leaves another proxy uncallable", async () => {
  const root = newRoot();
  const probeMarker = join(root, "probe.log");
  const proxyMarker = join(root, "proxy.log");
  const probeFile = writeExtension(
    root,
    "probe.mjs",
    nestedProbeExtension(probeMarker, "mcp__fake__two"),
  );
  const proxyFile = writeExtension(
    root,
    "proxy.mjs",
    sessionStartProxyExtension(proxyMarker, ["mcp__fake__one", "mcp__fake__two"]),
  );
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("mcp__fake__one", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxToolCall("Probe", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done"),
  ]);
  const result = await dispatchWith(root, {
    allTools: [
      { name: "Probe", sourceInfo: { path: probeFile } },
      { name: "mcp__fake__one", sourceInfo: { path: proxyFile } },
      { name: "mcp__fake__two", sourceInfo: { path: proxyFile } },
    ],
    // The cap names one proxy; the other stays outside it.
    activeTools: ["Agent", "Probe", "mcp__fake__one"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(
    toolResults(result),
    [
      ["mcp__fake__one", false],
      ["Probe", false],
    ],
    "the cap's proxy is callable, the other is not bound",
  );
  const [other] = probeOutcomes(probeMarker);
  assert.equal(must(other).isError, true, "a proxy the cap does not name is not callable");
});

test("an MCP resource tool registered with codemode exposure is uncallable when the cap omits it", async () => {
  const root = newRoot();
  const probeMarker = join(root, "probe.log");
  const resourceMarker = join(root, "resource.log");
  const probeFile = writeExtension(
    root,
    "probe.mjs",
    nestedProbeExtension(probeMarker, "list_mcp_resources"),
  );
  const resourceFile = writeExtension(
    root,
    "resource.mjs",
    sessionStartProxyExtension(resourceMarker, ["list_mcp_resources"], { exposure: "codemode" }),
  );
  probeThenAnswer("Probe");
  const result = await dispatchWith(root, {
    allTools: [
      { name: "Probe", sourceInfo: { path: probeFile } },
      { name: "list_mcp_resources", sourceInfo: { path: resourceFile } },
    ],
    activeTools: ["Agent", "Probe"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(toolResults(result), [["Probe", false]]);
  const [outcome] = probeOutcomes(probeMarker);
  assert.equal(
    must(outcome).isError,
    true,
    "an MCP resource tool outside the cap is not callable, even with codemode exposure",
  );
});

test("a tool of the effective tool cap that the child did not register is warned about", async () => {
  const root = newRoot();
  const marker = join(root, "ran.log");
  // The parent's inventory names `Ghost` from this source, but the child's copy registers only `Probe`.
  const extension = writeExtension(root, "probe.mjs", toolExtension(marker, ["Probe"]));
  const warnings: string[] = [];
  probeThenAnswer("Probe");
  const result = await dispatchWith(root, {
    allTools: [
      { name: "Ghost", sourceInfo: { path: extension } },
      { name: "Probe", sourceInfo: { path: extension } },
    ],
    activeTools: ["Agent", "Probe", "Ghost"],
    warn: (message) => warnings.push(message),
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.deepEqual(toolResults(result), [["Probe", false]]);
  assert.equal(readFileSync(marker, "utf8"), "Probe\n");
  const missing = warnings.filter((message) =>
    message.includes("tool Ghost of the effective tool cap is not registered"),
  );
  assert.equal(missing.length, 1, `expected one warning for Ghost, got: ${warnings.join(" | ")}`);
});

/**
 * A file extension registering `Lazy`, which it deactivates at `phase`, as an on-demand
 * tool loader does; at the run start it also drops `Lazy` from the run's selected tools.
 */
function deactivatingExtension(
  marker: string,
  phase: "session_start" | "before_agent_start",
): string {
  return `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.registerTool({
    name: "Lazy",
    label: "Lazy",
    description: "lazy probe",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      appendFileSync(${JSON.stringify(marker)}, "Lazy\\n");
      return { content: [{ type: "text", text: "Lazy ran" }], details: {} };
    },
  });
  pi.on(${JSON.stringify(phase)}, (event) => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "Lazy"));
    if (event.systemPromptOptions) {
      event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(
        (name) => name !== "Lazy",
      );
    }
  });
}
`;
}

/** The tool names a request declares: its transcript's tool additions less its removals. */
function declaredTools(messages: readonly unknown[]): string[] {
  const names = new Set<string>();
  const namesOf = (tools: unknown): string[] =>
    Array.isArray(tools)
      ? tools.flatMap((tool: { name?: unknown }) =>
          typeof tool.name === "string" ? [tool.name] : [],
        )
      : [];
  for (const message of messages as { toolsAdded?: unknown; toolsRemoved?: unknown }[]) {
    for (const name of namesOf(message.toolsRemoved)) names.delete(name);
    for (const name of namesOf(message.toolsAdded)) names.add(name);
  }
  return [...names].toSorted();
}

for (const phase of ["session_start", "before_agent_start"] as const) {
  test(`a cap tool an extension deactivates at ${phase} is active at the child's first request, without a warning`, async () => {
    const root = newRoot();
    const marker = join(root, "ran.log");
    const extension = writeExtension(root, "lazy.mjs", deactivatingExtension(marker, phase));
    const warnings: string[] = [];
    const declared: string[][] = [];
    faux.setResponses([
      (context) => {
        declared.push(declaredTools(context.messages));
        return fauxAssistantMessage([fauxToolCall("Lazy", {})], { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage("done"),
    ]);
    const result = await dispatchWith(root, {
      allTools: [{ name: "Lazy", sourceInfo: { path: extension } }],
      activeTools: ["Agent", "Lazy"],
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(textOf(result), "done");
    assert.deepEqual(
      declared[0],
      ["Agent", "Lazy"],
      "the first request declares the cap's tools, nothing else",
    );
    assert.deepEqual(toolResults(result), [["Lazy", false]]);
    assert.equal(readFileSync(marker, "utf8"), "Lazy\n");
    assert.deepEqual(warnings, []);
  });
}

test("a conflict between loaded extension sources is warned as a conflict, not a load failure", async () => {
  const root = newRoot();
  const first = writeExtension(root, "dup-a.mjs", toolExtension(join(root, "a.log"), ["Dup"]));
  const second = writeExtension(root, "dup-b.mjs", toolExtension(join(root, "b.log"), ["Dup"]));
  const warnings: string[] = [];
  faux.setResponses([() => fauxAssistantMessage("done")]);
  const result = await dispatchWith(root, {
    allTools: [
      { name: "Dup", sourceInfo: { path: first } },
      { name: "Dup", sourceInfo: { path: second } },
    ],
    activeTools: ["Agent", "Dup"],
    warn: (message) => warnings.push(message),
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  const conflicts = warnings.filter((message) => message.includes("reported a conflict:"));
  assert.equal(conflicts.length, 1, `expected one conflict warning, got: ${warnings.join(" | ")}`);
  assert.ok(
    must(conflicts[0]).includes(
      `extension ${second} reported a conflict: Tool "Dup" conflicts with`,
    ),
    `expected the conflict to name ${second}, got: ${must(conflicts[0])}`,
  );
  assert.equal(
    warnings.some(
      (message) =>
        (message.includes(first) || message.includes(second)) && message.includes("failed to load"),
    ),
    false,
    "a conflict is not reported as a load failure",
  );
});

test("a warning goes to the warning channel, never the completion notification channel", async () => {
  const root = newRoot();
  const missing = join(root, "gone.mjs");
  const warnings: string[] = [];
  const notifications: string[] = [];
  faux.setResponses([() => fauxAssistantMessage("done")]);
  const result = await dispatchWith(root, {
    allTools: [{ name: "Gone", sourceInfo: { path: missing } }],
    activeTools: ["Agent"],
    warn: (message) => warnings.push(message),
    notify: (message) => notifications.push(message),
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.ok(
    warnings.some((message) => message.includes(missing)),
    `expected the warning on the warning channel, got: ${warnings.join(" | ")}`,
  );
  assert.deepEqual(notifications, [], "a warning starts no model turn");
});

test("a child session's warning is a displayed message without a triggered turn or completion hooks", async () => {
  const sent: unknown[] = [];
  const calls: {
    message: { customType: string; content: string; display: boolean };
    options: { deliverAs?: string; triggerTurn?: boolean };
  }[] = [];
  const fakeSession = {
    sendCustomMessage: (
      message: { customType: string; content: string; display: boolean },
      options: { deliverAs?: string; triggerTurn?: boolean },
    ) => {
      calls.push({ message, options });
      return Promise.resolve();
    },
  };
  const host = hostFromSessionBox(
    { current: fakeSession as unknown as AgentSession },
    {
      sent: (token) => sent.push(token),
      failed: (token) => sent.push(token),
    },
  );
  host.warn?.("pi-dent: trouble");
  await Promise.resolve();
  assert.equal(calls.length, 1, "the warning is sent into the child conversation");
  const [call] = calls;
  assert.ok(must(call).message.content.includes("pi-dent: trouble"), "the warning text arrived");
  assert.equal(must(call).message.display, true);
  assert.equal(must(call).options.triggerTurn, false, "the warning starts no model turn");
  assert.deepEqual(sent, [], "a warning takes no completion bookkeeping");
});

test("the main session's warning is a warning-level UI notification, not a message", () => {
  const ui: { text: string; level?: string | undefined }[] = [];
  const messages: unknown[] = [];
  const host = hostFromContext(
    {
      getActiveTools: () => ["Agent"],
      sendMessage: (message: unknown) => messages.push(message),
    } as unknown as ExtensionAPI,
    {
      hasUI: true,
      ui: {
        notify: (text: string, level?: string) => ui.push({ text, level }),
      },
    } as unknown as ExtensionContext,
  );
  host.warn?.("pi-dent: boom");
  assert.deepEqual(ui, [{ text: "pi-dent: boom", level: "warning" }]);
  assert.deepEqual(messages, [], "a warning sends no conversation message");
});

test("a main session without a UI reports warnings on stderr without starting a turn", (t) => {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  const host = hostFromContext(
    {
      getActiveTools: () => ["Agent"],
      sendMessage: () => assert.fail("a warning must not start a model turn"),
    } as unknown as ExtensionAPI,
    {
      hasUI: false,
      ui: { notify: () => assert.fail("the UI is unavailable") },
    } as unknown as ExtensionContext,
  );
  host.warn?.("pi-dent: extension failed");
  assert.deepEqual(lines, ["pi-dent: extension failed\n"]);
});

test("a grandchild binds and runs the extension tools its dispatching child carries", async () => {
  const root = newRoot();
  const marker = join(root, "grandchild.log");
  const source = writeExtension(root, "probe.mjs", toolExtension(marker, ["Probe"]));
  faux.setResponses([
    () =>
      fauxAssistantMessage(
        [fauxToolCall("Agent", { prompt: "Use Probe", task: "probe", background: false })],
        { stopReason: "toolUse" },
      ),
    () => fauxAssistantMessage([fauxToolCall("Probe", {})], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("grandchild done"),
    () => fauxAssistantMessage("root done"),
  ]);
  const result = await dispatchWith(root, {
    allTools: [{ name: "Probe", sourceInfo: { path: source } }],
    activeTools: ["Agent", "Probe"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "root done");
  assert.equal(readFileSync(marker, "utf8"), "Probe\n");
});

test("a Fleet query loads no inherited extension sources", async () => {
  const root = newRoot();
  const marker = join(root, "loaded.log");
  const source = writeExtension(
    root,
    "source.mjs",
    `import { appendFileSync } from "node:fs";
export default function () {
  appendFileSync(${JSON.stringify(marker)}, "loaded\\n");
  throw new Error("a query must not load an inherited source");
}
`,
  );
  const warnings: string[] = [];
  const notifications: string[] = [];
  const host = makeHost(root, join(root, "main.jsonl"), {
    allTools: [{ name: "Probe", sourceInfo: { path: source } }],
    activeTools: ["Agent", "read"],
    warn: (message) => warnings.push(message),
    notify: (message) => notifications.push(message),
  });
  faux.setResponses([() => fauxAssistantMessage("query answer")]);
  const engine = new DispatchEngine(
    boot(),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.runIsolatedQuery(host, {
    correlationId: "correlation-1",
    senderSessionId: "sender-1",
    body: "what happens?",
  });
  assert.equal(result.isError, false);
  assert.equal(result.text, "query answer");
  assert.equal(existsSync(marker), false, "the parent source extension never loads");
  assert.deepEqual(warnings, []);
  assert.deepEqual(notifications, []);
});

test("a hanging extension shutdown is warned about and the dispatch still returns", async () => {
  const root = newRoot();
  const warnings: string[] = [];
  faux.setResponses([() => fauxAssistantMessage("done")]);
  const result = await dispatchWith(
    root,
    {
      allTools: [{ name: "Hang", sourceInfo: { path: "builtin:hang" } }],
      activeTools: ["Agent"],
      warn: (message) => warnings.push(message),
    },
    {
      extensionShutdownTimeoutMs: 10,
      builtinExtensions: [
        {
          name: "hang",
          builtin: true,
          replaceable: true,
          factory: (pi: ExtensionAPI) => {
            pi.on("session_shutdown", () => new Promise(() => {}));
          },
        },
      ],
    },
  );
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
  assert.ok(
    warnings.some((message) =>
      message.includes("extension shutdown timed out after 10ms; resources may remain active"),
    ),
    `expected a shutdown timeout warning, got: ${warnings.join(" | ")}`,
  );
});

test("an inherited extension's discovered skills do not widen the child's skill catalog", async () => {
  const root = newRoot();
  const marker = join(root, "discovered.log");
  const skillDir = join(root, "discovered-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: discovered\ndescription: LEAKED_SKILL_DESCRIPTION\n---\nbody\n",
  );
  const extension = writeExtension(
    root,
    "resources.mjs",
    `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("resources_discover", () => {
    appendFileSync(${JSON.stringify(marker)}, "discovered\\n");
    return { skillPaths: [${JSON.stringify(skillDir)}] };
  });
}
`,
  );
  const systemPrompts: string[] = [];
  faux.setResponses([
    (context) => {
      for (const message of context.messages) {
        if (message.role === "system") systemPrompts.push(JSON.stringify(message));
      }
      return fauxAssistantMessage("done");
    },
  ]);
  const result = await dispatchWith(root, {
    allTools: [{ name: "Resource", sourceInfo: { path: extension } }],
    activeTools: ["Agent"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(readFileSync(marker, "utf8"), "discovered\n", "the discovery hook ran");
  assert.ok(systemPrompts.length > 0, "the child sent a system prompt");
  assert.ok(
    !systemPrompts.join("\n").includes("LEAKED_SKILL_DESCRIPTION"),
    "the child's skill catalog stays the plan's",
  );
});
