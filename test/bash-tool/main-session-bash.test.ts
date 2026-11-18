import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * specs/bash-tool.md Section 7: `Bash` is registered at load and active on
 * registration, the built-in `bash` is deactivated on every `session_start`,
 * every `bash` call is blocked with the reason, and a selection left without a
 * shell tool warns once per `session_start`. index.ts is loaded through jiti,
 * as in test/skills/main-session-skill.test.ts.
 */

const entryDir = fileURLToPath(new URL(".", import.meta.url));
const jiti = createJiti(import.meta.url);
const factory = (
  await jiti.import<{ default: (pi: ExtensionAPI) => Promise<void> | void }>(
    join(entryDir, "..", "..", "index.ts"),
  )
).default;

type Handler = (event?: unknown, ctx?: unknown) => unknown;

interface StubPi {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  tools: { name: string; label?: string }[];
  active: string[];
  /** Tool names the host withholds from the session (a `--tools` selection or `-Bash`). */
  withheld: Set<string>;
  setActiveCalls: string[][];
}

function makeStubPi(): StubPi {
  const handlers = new Map<string, Handler[]>();
  const stub: StubPi = {
    pi: undefined as unknown as ExtensionAPI,
    handlers,
    tools: [],
    active: [],
    withheld: new Set(),
    setActiveCalls: [],
  };
  stub.pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (tool: { name: string; label?: string }) => stub.tools.push(tool),
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
      stub.tools
        .filter((tool) => !stub.withheld.has(tool.name))
        .map((tool) => ({ name: tool.name, description: "", parameters: {} })),
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return stub;
}

/** A throwaway project and home; returns the project path and a restore function. */
function makeProject(): { project: string; restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-main-bash-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(project, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  const prevHome = process.env.HOME;
  const prevTmpdir = process.env.TMPDIR;
  const prevCwd = process.cwd();
  process.env.HOME = home;
  process.env.TMPDIR = join(root, "tmp");
  process.chdir(project);
  return {
    project,
    restore: () => {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdir;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface Notified {
  message: string;
  level: string;
}

// package.md Section 5.3 notices follow the checkout's own .local-links, not the Bash rules tested here.
const LOCAL_LINK_NOTICE = /^pi-dent: local links? /;

function makeCtx(project: string, notified: Notified[]): ExtensionContext {
  return {
    cwd: project,
    mode: "print",
    hasUI: false,
    ui: {
      notify: (message: string, level?: string) => {
        if (!LOCAL_LINK_NOTICE.test(message)) notified.push({ message, level: level ?? "info" });
      },
      setWidget: () => {},
      custom: () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => "bash-main-session",
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

async function sessionStart(stub: StubPi, project: string, notified: Notified[]): Promise<void> {
  const handlers = stub.handlers.get("session_start") ?? [];
  assert.ok(handlers.length > 0, "a session_start handler is registered");
  for (const handler of handlers) await handler({ reason: "start" }, makeCtx(project, notified));
}

/** The same context, but a later step throws (Section 7: removal comes first). */
function makeFailingCtx(project: string, notified: Notified[]): ExtensionContext {
  const ctx = makeCtx(project, notified);
  return {
    ...ctx,
    sessionManager: {
      ...ctx.sessionManager,
      getSessionFile: () => {
        throw new Error("session file boom");
      },
    },
  } as unknown as ExtensionContext;
}

/** The boot window is cached on globalThis; a reload shutdown clears it for the next factory call. */
function clearBootWindow(stub: StubPi): void {
  for (const handler of stub.handlers.get("session_shutdown") ?? []) handler({ reason: "reload" });
}

test("Bash is registered once, with the name and label the host shows", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  try {
    await factory(stub.pi);
    const registered = stub.tools.filter((tool) => tool.name === "Bash");
    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.label, "Bash");
    assert.equal(
      stub.tools.some((tool) => tool.name === "bash"),
      false,
    );
    assert.ok(project);
  } finally {
    clearBootWindow(stub);
    restore();
  }
});

test("session_start removes bash, keeps every other name in order, and warns nothing", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  const notified: Notified[] = [];
  try {
    await factory(stub.pi);
    stub.active = ["read", "bash", "Bash", "Agent"];
    await sessionStart(stub, project, notified);
    assert.deepEqual(stub.setActiveCalls, [["read", "Bash", "Agent"]]);
    assert.deepEqual(stub.active, ["read", "Bash", "Agent"]);
    assert.deepEqual(notified, []);

    // A further session_start sets the current set again, without bash.
    stub.active = ["read", "bash", "Bash"];
    await sessionStart(stub, project, notified);
    assert.deepEqual(stub.setActiveCalls[1], ["read", "Bash"]);
    assert.deepEqual(notified, []);
  } finally {
    clearBootWindow(stub);
    restore();
  }
});

test("session_start removes bash before any later step can throw", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  const notified: Notified[] = [];
  try {
    await factory(stub.pi);
    stub.active = ["read", "bash"];
    const handlers = stub.handlers.get("session_start") ?? [];
    assert.ok(handlers.length > 0, "a session_start handler is registered");
    await assert.rejects(
      async () => {
        for (const handler of handlers) {
          await handler({ reason: "start" }, makeFailingCtx(project, notified));
        }
      },
      { message: "session file boom" },
    );
    assert.deepEqual(stub.active, ["read"]);
  } finally {
    clearBootWindow(stub);
    restore();
  }
});

test("a selection that keeps bash and withholds Bash warns once per session_start", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  const notified: Notified[] = [];
  try {
    await factory(stub.pi);
    stub.withheld.add("Bash");
    stub.active = ["read", "bash"];
    await sessionStart(stub, project, notified);
    assert.deepEqual(stub.active, ["read"]);
    assert.deepEqual(notified, [
      {
        message:
          "pi-dent: the tool selection names `bash`, which is disabled, and omits `Bash`: the session has no shell tool",
        level: "warning",
      },
    ]);

    // Once per session_start: the same selection warns again.
    stub.active = ["read", "bash"];
    await sessionStart(stub, project, notified);
    assert.equal(notified.length, 2);

    // A selection without bash has nothing to report.
    stub.active = ["read"];
    await sessionStart(stub, project, notified);
    assert.equal(notified.length, 2);
  } finally {
    clearBootWindow(stub);
    restore();
  }
});

test("every call to a tool named bash is blocked with the reason, whatever registered it", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  const notified: Notified[] = [];
  try {
    await factory(stub.pi);
    const handlers = stub.handlers.get("tool_call") ?? [];
    assert.ok(handlers.length > 0, "a tool_call handler is registered");
    const blocks = async (toolName: string) => {
      const results = [];
      for (const handler of handlers) {
        results.push(
          await handler({ toolName, toolCallId: "call-1", input: {} }, makeCtx(project, notified)),
        );
      }
      return results.filter((result) => result !== undefined);
    };
    assert.deepEqual(await blocks("bash"), [
      { block: true, reason: "The `bash` tool is disabled: use `Bash`." },
    ]);
    assert.deepEqual(await blocks("Bash"), []);
    assert.deepEqual(await blocks("read"), []);
  } finally {
    clearBootWindow(stub);
    restore();
  }
});

/** The registered `Bash` tool as this file calls it: the arguments of the host tool surface. */
interface BashToolLike {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
  ): Promise<{ isError?: boolean; content: { type: string; text?: string }[] }>;
}

test("a broken settings file warns once per boot window, naming the file (Section 3)", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  const notified: Notified[] = [];
  try {
    const settingsFile = join(project, ".pi", "settings.json");
    writeFileSync(settingsFile, "{ not JSON");
    await factory(stub.pi);
    await sessionStart(stub, project, notified);
    const bash = stub.tools.find((tool) => tool.name === "Bash") as unknown as BashToolLike;
    assert.ok(bash, "Bash is registered");
    const callBash = () => bash.execute("call-1", { command: "true" }, undefined, undefined);

    const first = await callBash();
    assert.equal(first.isError, undefined, "the call still runs on the default shell");
    // A second call reads the same file again but reports nothing: once per boot window.
    await callBash();

    const warnings = notified.filter((call) => call.message.includes(settingsFile));
    assert.equal(warnings.length, 1, JSON.stringify(notified));
    const only = warnings[0];
    assert.ok(only !== undefined);
    assert.ok(
      only.message.startsWith(`pi-dent: ${settingsFile}: `),
      `names the settings file: ${only.message}`,
    );
    assert.equal(only.level, "warning");
  } finally {
    clearBootWindow(stub);
    restore();
  }
});
