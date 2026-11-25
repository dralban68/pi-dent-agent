import { test, after } from "node:test";
import { isolateTaskLedger } from "../support/task-ledger-env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession } from "../../lib/host.ts";
import { ASK_USER_DESCRIPTION, ASK_USER_PROMPT_SNIPPET } from "../../lib/ask-user-question-tool.ts";
import { must } from "../support/must.ts";

/**
 * specs/ask-user-question-tool.md Section 1.4 and agent-tool.md Section 3.1: the tool is
 * registered for the main session in every mode, a session without a user interface loses
 * it at `session_start`, and a child session never binds it. index.ts is loaded through
 * jiti, as in test/bash-tool/main-session-bash.test.ts.
 */

const entryDir = fileURLToPath(new URL(".", import.meta.url));
const jiti = createJiti(import.meta.url);
const factory = (
  await jiti.import<{ default: (pi: ExtensionAPI) => Promise<void> | void }>(
    join(entryDir, "..", "..", "index.ts"),
  )
).default;

type Handler = (event?: unknown, ctx?: unknown) => unknown;

interface RegisteredTool {
  name: string;
  label?: string;
  exposure?: string;
  description?: string;
  promptSnippet?: string;
}

interface StubPi {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  tools: RegisteredTool[];
  active: string[];
  setActiveCalls: string[][];
}

function makeStubPi(): StubPi {
  const handlers = new Map<string, Handler[]>();
  const stub: StubPi = {
    pi: undefined as unknown as ExtensionAPI,
    handlers,
    tools: [],
    active: [],
    setActiveCalls: [],
  };
  stub.pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (tool: RegisteredTool) => stub.tools.push(tool),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerShortcut: () => {},
    getActiveTools: () => stub.active,
    setActiveTools: (names: string[]) => {
      stub.setActiveCalls.push(names);
      stub.active = names;
    },
    getAllTools: () =>
      stub.tools.map((tool) => ({ name: tool.name, description: "", parameters: {} })),
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return stub;
}

function makeProject(): { project: string; restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-ask-activation-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(project, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  const prevHome = process.env.HOME;
  const prevTmpdir = process.env.TMPDIR;
  const prevCwd = process.cwd();
  process.env.HOME = home;
  const restoreLedger = isolateTaskLedger(home);
  process.env.TMPDIR = join(root, "tmp");
  process.chdir(project);
  return {
    project,
    restore: () => {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      restoreLedger();
      if (prevTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdir;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeCtx(project: string, hasUI: boolean, mode: string): ExtensionContext {
  return {
    cwd: project,
    mode,
    hasUI,
    ui: {
      notify: () => {},
      setWidget: () => {},
      setStatus: () => {},
      custom: () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => "ask-session",
      getEntries: () => [],
      getHeader: () => null,
      getSessionFile: () => join(project, "session.jsonl"),
      getSessionDir: () => project,
      getBranch: () => [],
    },
    model: undefined,
    thinkingLevel: undefined,
    modelRegistry: { getAll: () => [], getAvailable: () => [] },
    isIdle: () => true,
    abort: () => {},
    compact: () => {},
    getContextUsage: () => undefined,
  } as unknown as ExtensionContext;
}

async function sessionStart(stub: StubPi, ctx: ExtensionContext): Promise<void> {
  const handlers = stub.handlers.get("session_start") ?? [];
  assert.ok(handlers.length > 0, "a session_start handler is registered");
  for (const handler of handlers) await handler({ reason: "startup" }, ctx);
}

/** The boot window is cached on globalThis; a reload shutdown clears it for the next factory call. */
function clearBootWindow(stub: StubPi): void {
  for (const handler of stub.handlers.get("session_shutdown") ?? []) handler({ reason: "reload" });
}

test("the tool is registered once, as the host's model-only tool", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  try {
    await factory(stub.pi);
    const registered = stub.tools.filter((tool) => tool.name === "AskUserQuestion");
    assert.equal(registered.length, 1);
    const tool = registered[0];
    assert.equal(tool?.label, "AskUserQuestion");
    assert.equal(tool?.exposure, "model-only");
    assert.equal(tool?.description, ASK_USER_DESCRIPTION);
    assert.equal(tool?.promptSnippet, ASK_USER_PROMPT_SNIPPET);
    assert.ok(project);
  } finally {
    clearBootWindow(stub);
    restore();
  }
});

test("session_start without a user interface removes the tool and keeps every other tool", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  try {
    await factory(stub.pi);
    stub.active = ["read", "AskUserQuestion", "Agent", "Bash"];
    await sessionStart(stub, makeCtx(project, false, "print"));
    assert.deepEqual(stub.active, ["read", "Agent", "Bash"]);
    assert.deepEqual(stub.setActiveCalls[stub.setActiveCalls.length - 1], [
      "read",
      "Agent",
      "Bash",
    ]);

    // Every session_start of the process decides the same.
    stub.active = ["AskUserQuestion", "read"];
    await sessionStart(stub, makeCtx(project, false, "json"));
    assert.deepEqual(stub.active, ["read"]);
  } finally {
    clearBootWindow(stub);
    restore();
  }
});

test("session_start with a user interface leaves the tool's activity as the host set it", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  try {
    await factory(stub.pi);
    stub.active = ["read", "AskUserQuestion", "Agent"];
    await sessionStart(stub, makeCtx(project, true, "tui"));
    assert.deepEqual(stub.active, ["read", "AskUserQuestion", "Agent"]);
    for (const call of stub.setActiveCalls) {
      assert.equal(call.includes("AskUserQuestion"), true);
    }
  } finally {
    clearBootWindow(stub);
    restore();
  }
});

test("session_start removes the tool before any later step can throw", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  try {
    await factory(stub.pi);
    stub.active = ["read", "AskUserQuestion"];
    const ctx = makeCtx(project, false, "print");
    const failing = {
      ...ctx,
      sessionManager: {
        ...ctx.sessionManager,
        getSessionFile: () => {
          throw new Error("session file boom");
        },
      },
    } as unknown as ExtensionContext;
    await assert.rejects(async () => {
      await sessionStart(stub, failing);
    });
    assert.deepEqual(stub.active, ["read"]);
  } finally {
    clearBootWindow(stub);
    restore();
  }
});

test("session_shutdown ends the session's open calls and completes (Section 5)", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  try {
    await factory(stub.pi);
    const handlers = stub.handlers.get("session_shutdown") ?? [];
    assert.ok(handlers.length > 0, "a session_shutdown handler is registered");
    for (const handler of handlers) {
      await handler({ reason: "quit" }, makeCtx(project, true, "tui"));
    }
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// agent-tool.md Section 3.1: a child session never binds AskUserQuestion
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const fauxHome = mkdtempSync(join(tmpdir(), "pi-dent-ask-cap-"));
roots.push(fauxHome);
const fauxAgentDir = join(fauxHome, "pi-agent");
mkdirSync(fauxAgentDir, { recursive: true });
writeFileSync(
  join(fauxAgentDir, "auth.json"),
  JSON.stringify({ faux: { type: "api_key", key: "k" } }),
);
process.env.PI_CODING_AGENT_DIR = fauxAgentDir;

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

const fauxModel = faux.getModel();

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

function childHost(cap: readonly string[], root: string, sessionFile: string): HostSession {
  return {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => sessionFile,
    sessionDir: () => root,
    model: () => ({ provider: fauxModel.provider, id: fauxModel.id }),
    thinking: () => undefined,
    activeTools: () => [...cap],
    inventory: () => [fauxModel as never],
    configuredModels: () => [fauxModel as never],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The tool names the child's request declares (the transcript's `toolsAdded` entries). */
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

test("a child session is offered no AskUserQuestion, even when the tool cap names it (agent-tool.md Section 3.1)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-ask-child-"));
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
    host: childHost(["read", "AskUserQuestion", "Agent", "Bash"], root, sessionFile),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined, "the child completes on the scripted answer");
  const offered = must(requests[0]);
  // The declarations are read, so a missing AskUserQuestion is not an empty read.
  for (const name of ["read", "Agent", "Bash"]) {
    assert.ok(offered.includes(name), `the child is offered ${name}`);
  }
  assert.equal(
    offered.includes("AskUserQuestion"),
    false,
    "a tool-cap name naming AskUserQuestion is not bound in the child",
  );
});
