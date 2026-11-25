import "../support/isolate-session-store.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildBashEnv } from "../../lib/bash-tool.ts";
import type { BootSnapshot } from "../../lib/engine.ts";
import type { HostSession } from "../../lib/host.ts";
import { SCHEDULE_UNAVAILABLE_TEXT, scheduleRuntime } from "../../lib/schedule-tool.ts";
import { runScript } from "../../lib/script-runner.ts";
import {
  AGENT_SESSION_MODE_LINE,
  SESSION_KIND_ENV,
  USER_SESSION_MODE_LINE,
  appendSessionMode,
  sessionKindForMain,
} from "../../lib/session-kind.ts";
import { makeSessionTool } from "../../lib/tools.ts";
import { isolateTaskLedger } from "../support/task-ledger-env.ts";

/**
 * specs/session-tool.md Section 3, specs/schedule-tool.md Section 1.3,
 * specs/bash-tool.md Section 3, and specs/script-tool.md Section 6:
 * user session vs agent session classification, PI_DENT_SESSION_KIND,
 * system prompt mode line, Session tool fields, and Schedule gating.
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
  active: string[];
}

function makeStubPi(): StubPi {
  const handlers = new Map<string, Handler[]>();
  const stub: StubPi = {
    pi: undefined as unknown as ExtensionAPI,
    handlers,
    active: [],
  };
  stub.pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerShortcut: () => {},
    getActiveTools: () => stub.active,
    setActiveTools: (names: string[]) => {
      stub.active = names;
    },
    getAllTools: () => [],
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return stub;
}

function makeProject(): { project: string; restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-session-kind-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(project, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  const prevHome = process.env.HOME;
  const prevTmpdir = process.env.TMPDIR;
  const prevCwd = process.cwd();
  const prevKind = process.env[SESSION_KIND_ENV];
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
      if (prevKind === undefined) delete process.env[SESSION_KIND_ENV];
      else process.env[SESSION_KIND_ENV] = prevKind;
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
      getSessionId: () => "kind-session",
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

function emptyBoot(): BootSnapshot {
  return {
    cwd: "/w",
    config: {
      merged: {},
      layers: {},
      projectRoot: "/w",
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
    maxRecoveryRetries: 2,
    sessionTtlDays: 30,
  };
}

function minimalHost(overrides: Partial<HostSession> = {}): HostSession {
  return {
    cwd: () => "/w",
    sessionId: () => "s-1",
    sessionFile: () => undefined,
    sessionDir: () => "/w",
    model: () => undefined,
    thinking: () => undefined,
    activeTools: () => [],
    inventory: () => [],
    configuredModels: () => [],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
    ...overrides,
  };
}

test("Session tool reports sessionKind and userInput for user, headless, and child sessions", async () => {
  const mainTool = makeSessionTool({ boot: emptyBoot(), hostProvider: () => undefined });

  const userRes = await mainTool.execute("tc-1", {} as never, undefined, undefined, {
    cwd: "/w",
    hasUI: true,
    sessionManager: { getSessionId: () => "u-1", getSessionFile: () => undefined },
    modelRegistry: { getAvailable: () => [] },
  } as never);
  assert.equal(userRes.details.sessionKind, "user");
  assert.equal(userRes.details.userInput, true);
  const userText = userRes.content[0]?.type === "text" ? userRes.content[0].text : "";
  assert.ok(userText.includes("sessionKind: user\nuserInput: true"));

  const headlessRes = await mainTool.execute("tc-2", {} as never, undefined, undefined, {
    cwd: "/w",
    hasUI: false,
    sessionManager: { getSessionId: () => "a-1", getSessionFile: () => undefined },
    modelRegistry: { getAvailable: () => [] },
  } as never);
  assert.equal(headlessRes.details.sessionKind, "agent");
  assert.equal(headlessRes.details.userInput, false);
  const headlessText = headlessRes.content[0]?.type === "text" ? headlessRes.content[0].text : "";
  assert.ok(headlessText.includes("sessionKind: agent\nuserInput: false"));

  const childTool = makeSessionTool({
    boot: emptyBoot(),
    hostProvider: () => undefined,
    sessionKind: "agent",
  });
  const childRes = await childTool.execute("tc-3", {} as never, undefined, undefined, {
    cwd: "/w",
    hasUI: true,
    sessionManager: { getSessionId: () => "c-1", getSessionFile: () => undefined },
    modelRegistry: { getAvailable: () => [] },
  } as never);
  assert.equal(childRes.details.sessionKind, "agent");
  assert.equal(childRes.details.userInput, false);
});

test("main session lifecycle sets PI_DENT_SESSION_KIND, gates Schedule/AskUserQuestion, and appends mode line", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  try {
    await factory(stub.pi);
    const startHandlers = stub.handlers.get("session_start") ?? [];
    const shutdownHandlers = stub.handlers.get("session_shutdown") ?? [];
    const beforeHandlers = stub.handlers.get("before_agent_start") ?? [];
    assert.ok(startHandlers.length > 0);
    assert.ok(beforeHandlers.length > 0);

    // User session (TUI): keeps AskUserQuestion & Schedule, sets env=user, appends user mode line.
    stub.active = ["read", "AskUserQuestion", "Schedule", "Bash"];
    const tuiCtx = makeCtx(project, true, "tui");
    for (const h of startHandlers) await h({ reason: "startup" }, tuiCtx);
    assert.equal(process.env[SESSION_KIND_ENV], "user");
    assert.deepEqual(stub.active, ["read", "AskUserQuestion", "Schedule", "Bash"]);
    const userPrompt = (await beforeHandlers[0]?.({ systemPrompt: "Base" }, tuiCtx)) as
      | { systemPrompt?: string }
      | undefined;
    assert.equal(userPrompt?.systemPrompt, appendSessionMode("Base", "user"));
    assert.ok(userPrompt?.systemPrompt?.endsWith(USER_SESSION_MODE_LINE));

    // Shutdown unsets PI_DENT_SESSION_KIND.
    for (const h of shutdownHandlers) await h({ reason: "quit" }, tuiCtx);
    assert.equal(process.env[SESSION_KIND_ENV], undefined);

    // Agent session (print): removes AskUserQuestion & Schedule, sets env=agent, appends agent mode line.
    stub.active = ["read", "AskUserQuestion", "Schedule", "Bash"];
    const printCtx = makeCtx(project, false, "print");
    for (const h of startHandlers) await h({ reason: "startup" }, printCtx);
    assert.equal(process.env[SESSION_KIND_ENV], "agent");
    assert.deepEqual(stub.active, ["read", "Bash"]);
    const agentPrompt = (await beforeHandlers[0]?.({ systemPrompt: "Base" }, printCtx)) as
      | { systemPrompt?: string }
      | undefined;
    assert.equal(agentPrompt?.systemPrompt, appendSessionMode("Base", "agent"));
    assert.ok(agentPrompt?.systemPrompt?.endsWith(AGENT_SESSION_MODE_LINE));

    for (const h of shutdownHandlers) await h({ reason: "reload" }, printCtx);
    assert.equal(process.env[SESSION_KIND_ENV], undefined);
  } finally {
    restore();
  }
});

test("Schedule runtime rejects calls in an agent session before validation and keeps schedules unchanged", () => {
  const rt = scheduleRuntime({
    clock: { now: () => 1_700_000_000_000, after: () => () => {} },
    store: { sessions: new Map(), ids: new Set() },
    zone: "UTC",
  });
  // Calling with invalid params in an agent session still returns the unavailable error first.
  const rejected = rt.execute({
    sessionId: "s-agent",
    params: { action: "create", message: "" },
    hasUI: false,
  });
  assert.equal(rejected.isError, true);
  assert.equal(
    rejected.content[0]?.type === "text" ? rejected.content[0].text : "",
    SCHEDULE_UNAVAILABLE_TEXT,
  );

  // In a user session, create succeeds.
  const ok = rt.execute({
    sessionId: "s-user",
    params: { action: "create", message: "ping", delaySeconds: 60 },
    hasUI: true,
  });
  assert.notEqual(ok.isError, true);
});

test("Bash env carries PI_DENT_SESSION_KIND and child extraEnv overrides without mutating process.env", () => {
  const prev = process.env[SESSION_KIND_ENV];
  try {
    process.env[SESSION_KIND_ENV] = "user";
    const mainEnv = buildBashEnv(minimalHost());
    assert.equal(mainEnv[SESSION_KIND_ENV], "user");

    const childEnv = buildBashEnv(minimalHost(), { [SESSION_KIND_ENV]: "agent" });
    assert.equal(childEnv[SESSION_KIND_ENV], "agent");
    assert.equal(process.env[SESSION_KIND_ENV], "user");

    delete process.env[SESSION_KIND_ENV];
    const unsetEnv = buildBashEnv(minimalHost());
    assert.equal(SESSION_KIND_ENV in unsetEnv, false);
  } finally {
    if (prev === undefined) delete process.env[SESSION_KIND_ENV];
    else process.env[SESSION_KIND_ENV] = prev;
  }
});

test("Script worker preserves PI_DENT_SESSION_KIND in spawned child processes unless caller overrides it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-script-kind-"));
  const prev = process.env[SESSION_KIND_ENV];
  try {
    process.env[SESSION_KIND_ENV] = "user";
    const handle = runScript({
      code: `
        import { execFile } from "node:child_process";
        import { promisify } from "node:util";
        const execFileAsync = promisify(execFile);
        const a = await execFileAsync(process.execPath, ["-e", "process.stdout.write(process.env.PI_DENT_SESSION_KIND ?? 'NONE')"], { env: { PATH: process.env.PATH ?? "" } });
        const b = await execFileAsync(process.execPath, ["-e", "process.stdout.write(process.env.PI_DENT_SESSION_KIND ?? 'NONE')"], { env: { PATH: process.env.PATH ?? "", PI_DENT_SESSION_KIND: "custom" } });
        export default { inherited: a.stdout, overridden: b.stdout, own: process.env.PI_DENT_SESSION_KIND };
      `,
      filename: join(root, "script.ts"),
      cwd: root,
      input: undefined,
      aliases: {},
      extraEnv: { [SESSION_KIND_ENV]: "agent" },
    });
    const run = await handle.promise;
    assert.equal(run.exitReason, "ok");
    assert.deepEqual(run.returnValue, {
      inherited: "agent",
      overridden: "custom",
      own: "agent",
    });
    assert.equal(process.env[SESSION_KIND_ENV], "user");
  } finally {
    if (prev === undefined) delete process.env[SESSION_KIND_ENV];
    else process.env[SESSION_KIND_ENV] = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("sessionKindForMain classifies hasUI cleanly", () => {
  assert.equal(sessionKindForMain(true), "user");
  assert.equal(sessionKindForMain(false), "agent");
});
