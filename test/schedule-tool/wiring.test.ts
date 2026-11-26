import "../support/isolate-session-store.ts";
import { test } from "node:test";
import { isolateTaskLedger } from "../support/task-ledger-env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SCHEDULE_STATUS_KEY } from "../../lib/schedule-tool.ts";
import { must } from "../support/must.ts";

/**
 * The index.ts wiring of specs/schedule-tool.md: `Schedule` is registered in
 * the main session, `session_start` builds the window the runtime fires and
 * sets the status line through, `session_shutdown` drops it (keeping the
 * schedules across a reload), `message_start` feeds the runtime, and a firing
 * goes out through `pi.sendMessage` as a follow-up. index.ts is loaded through
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

interface Sent {
  message: {
    customType?: string;
    content: string;
    display?: boolean;
    details?: unknown;
  };
  options: unknown;
}

interface StatusCall {
  key: string;
  text: string | undefined;
}

interface NotificationCall {
  message: string;
  level: string | undefined;
}

interface StubPi {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  tools: { name: string; label?: string; execute?: (...args: never[]) => unknown }[];
  sent: Sent[];
  statuses: StatusCall[];
  notifications: NotificationCall[];
  /** When set, the host `sendMessage` API throws it (specs/schedule-tool.md#insertion). */
  sendFailure: string | undefined;
}

function makeStubPi(): StubPi {
  const handlers = new Map<string, Handler[]>();
  const stub: StubPi = {
    pi: undefined as unknown as ExtensionAPI,
    handlers,
    tools: [],
    sent: [],
    statuses: [],
    notifications: [],
    sendFailure: undefined,
  };
  stub.pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (tool: { name: string }) => stub.tools.push(tool),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerShortcut: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    sendMessage: (message: Sent["message"], options: unknown) => {
      if (stub.sendFailure !== undefined) throw new Error(stub.sendFailure);
      stub.sent.push({ message, options });
    },
    sendUserMessage: async () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return stub;
}

/** A throwaway project and home; returns the project path and a restore function. */
function makeProject(): { project: string; restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-schedule-wiring-"));
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

/** The live session context, interactive so the status line is set (specs/schedule-tool.md#schedule-status-line). */
function makeCtx(project: string, stub: StubPi): ExtensionContext {
  return {
    cwd: project,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string, level: string | undefined) =>
        stub.notifications.push({ message, level }),
      setStatus: (key: string, text: string | undefined) => stub.statuses.push({ key, text }),
      setWidget: () => {},
      custom: async () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => "schedule-main-session",
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

async function sessionStart(stub: StubPi, ctx: ExtensionContext, reason: string): Promise<void> {
  const handlers = stub.handlers.get("session_start") ?? [];
  assert.ok(handlers.length > 0, "a session_start handler is registered");
  for (const handler of handlers) await handler({ reason }, ctx);
}

async function sessionShutdown(stub: StubPi, ctx: ExtensionContext, reason: string): Promise<void> {
  for (const handler of stub.handlers.get("session_shutdown") ?? []) {
    await handler({ reason }, ctx);
  }
}

async function messageStart(stub: StubPi, ctx: ExtensionContext, message: unknown): Promise<void> {
  for (const handler of stub.handlers.get("message_start") ?? []) await handler({ message }, ctx);
}

interface ToolLike {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
}

function scheduleTool(stub: StubPi): ToolLike {
  const tool = stub.tools.find((candidate) => candidate.name === "Schedule");
  assert.ok(tool, "Schedule is registered in the main session");
  return tool as unknown as ToolLike;
}

async function call(
  stub: StubPi,
  ctx: ExtensionContext,
  params: Record<string, unknown>,
): Promise<string> {
  const result = await scheduleTool(stub).execute("call-1", params, undefined, undefined, ctx);
  const part = result.content[0];
  assert.equal(result.isError, undefined, "the call succeeds");
  return part?.text ?? "";
}

function lastStatus(stub: StubPi): string | undefined {
  const calls = stub.statuses.filter((status) => status.key === SCHEDULE_STATUS_KEY);
  return calls.at(-1)?.text;
}

/** Poll `probe` until it returns a value. */
async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

test("Schedule is registered in the main session", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  try {
    await factory(stub.pi);
    const names = stub.tools.map((tool) => tool.name);
    assert.equal(names.filter((name) => name === "Schedule").length, 1);
    assert.equal(must(stub.tools.find((tool) => tool.name === "Schedule")).label, "Schedule");
  } finally {
    await sessionShutdown(stub, makeCtx(project, stub), "reload");
    restore();
  }
});

test("create sets the status line, a reload keeps the schedule, a quit clears both", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  const ctx = makeCtx(project, stub);
  try {
    await factory(stub.pi);
    await sessionStart(stub, ctx, "startup");
    assert.equal(lastStatus(stub), undefined, "nothing pending at session start");

    const created = await call(stub, ctx, {
      action: "create",
      message: "check the build",
      delaySeconds: 60,
    });
    assert.match(created, /^Schedule [0-9a-f]{8} created at /);
    assert.match(must(lastStatus(stub)), /^schedule: 1 pending · next /);

    // A reload is a new extension instance over the same process.
    await sessionShutdown(stub, ctx, "reload");
    assert.equal(lastStatus(stub), undefined, "the key is cleared with the session");
    const reloaded = makeStubPi();
    const reloadedCtx = makeCtx(project, reloaded);
    await factory(reloaded.pi);
    await sessionStart(reloaded, reloadedCtx, "reload");
    assert.match(must(lastStatus(reloaded)), /^schedule: 1 pending · next /);
    assert.match(await call(reloaded, reloadedCtx, { action: "list" }), /check the build/);

    await sessionShutdown(reloaded, reloadedCtx, "quit");
    assert.equal(
      lastStatus(reloaded),
      undefined,
      "the session end clears the status line (specs/schedule-tool.md#schedule-status-line)",
    );
    const fresh = makeStubPi();
    const freshCtx = makeCtx(project, fresh);
    await factory(fresh.pi);
    await sessionStart(fresh, freshCtx, "startup");
    const listed = await call(fresh, freshCtx, { action: "list" });
    assert.equal(listed, "(no pending schedules)");
    await sessionShutdown(fresh, freshCtx, "quit");
  } finally {
    restore();
  }
});

test("a firing goes out through pi.sendMessage as a follow-up, and message_start clears it", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  const ctx = makeCtx(project, stub);
  try {
    await factory(stub.pi);
    await sessionStart(stub, ctx, "startup");
    await call(stub, ctx, { action: "create", message: "tick", everySeconds: 1 });

    // The runtime arms the first check on create; the shortest real wait keeps
    // this test off the injected clock the firing rules are tested with.
    const sent = await waitFor(() => stub.sent[0], "the scheduled message");
    assert.deepEqual(sent.options, { triggerTurn: true, deliverAs: "followUp" });
    assert.equal(sent.message.customType, "pi-dent-schedule");
    assert.equal(sent.message.display, true);
    assert.match(sent.message.content, /occurrence 1/);
    assert.match(await call(stub, ctx, { action: "list" }), / · queued · /);

    await messageStart(stub, ctx, {
      role: "custom",
      customType: "pi-dent-schedule",
      display: true,
      content: sent.message.content,
      details: sent.message.details,
      timestamp: 0,
    });
    assert.doesNotMatch(
      await call(stub, ctx, { action: "list" }),
      / · queued/,
      "the delivered message clears the queued occurrence",
    );
  } finally {
    await sessionShutdown(stub, ctx, "quit");
    restore();
  }
});

test("a refused hand-off notifies at level error and keeps the schedule pending", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  const ctx = makeCtx(project, stub);
  try {
    await factory(stub.pi);
    await sessionStart(stub, ctx, "startup");
    const created = await call(stub, ctx, { action: "create", message: "tick", everySeconds: 1 });
    const scheduleId = /^Schedule ([0-9a-f]{8}) created at /.exec(created)?.[1];
    assert.ok(scheduleId, created);

    // The host refuses the hand-off (specs/schedule-tool.md#insertion).
    stub.sendFailure = "the host is gone";
    const notice = await waitFor(
      () =>
        stub.notifications.find((notification) =>
          notification.message.includes("was not delivered"),
        ),
      "the delivery warning",
    );
    assert.equal(
      notice.message,
      `pi-dent: schedule ${scheduleId} was not delivered: the host is gone; it stays pending`,
    );
    assert.equal(notice.level, "error");
    assert.match(
      await call(stub, ctx, { action: "list" }),
      new RegExp(`^${scheduleId} · due `),
      "the repeating schedule stays pending after the failed hand-off",
    );
  } finally {
    await sessionShutdown(stub, ctx, "quit");
    restore();
  }
});
