import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { USAGE_STATUS_KEY } from "../../lib/usage.ts";
import { isolateTaskLedger } from "../support/task-ledger-env.ts";
import { inserted, openLedger, raw, sessionRow, usage } from "./support.ts";

/**
 * The index.ts wiring of specs/task-ledger.md Sections 1, 3.3 and 7 and agent-tool.md Section 13:
 * the ledger opened at session_start, the ledger session row, the usage tally's seed read, and
 * the tool-result rule of Section 2.1. index.ts is loaded through jiti.
 */

const entryDir = fileURLToPath(new URL(".", import.meta.url));
const jiti = createJiti(import.meta.url);
const factory = (
  await jiti.import<{ default: (pi: ExtensionAPI) => Promise<void> | void }>(
    join(entryDir, "..", "..", "index.ts"),
  )
).default;

type Handler = (event?: unknown, ctx?: unknown) => unknown;

interface Stub {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
}

function makeStub(): Stub {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
      tools.set(tool.name, tool),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerShortcut: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    getThinkingLevel: () => "off",
    sendMessage: () => {},
    sendUserMessage: async () => {},
    appendEntry: () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools };
}

const SESSION_ID = "ledger-wired";

interface Sandbox {
  project: string;
  ledgerPath: string;
  restore: () => void;
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-ledger-wiring-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(project, ".pi", "pi-dent"), { recursive: true });
  // The usage status line, not pi-dent's footer, shows the tally (agent-tool.md Section 13).
  writeFileSync(
    join(project, ".pi", "pi-dent", "pi-dent.conf"),
    JSON.stringify({ footer: { enabled: false } }),
  );
  const previous = {
    home: process.env.HOME,
    tmpdir: process.env.TMPDIR,
    fleet: process.env.PI_DENT_FLEET_DB,
    cwd: process.cwd(),
  };
  process.env.HOME = home;
  const restoreLedger = isolateTaskLedger(root);
  process.env.TMPDIR = root;
  process.env.PI_DENT_FLEET_DB = join(root, "fleet.sqlite");
  process.chdir(project);
  return {
    project,
    ledgerPath: join(root, "tasks-v1.sqlite"),
    restore: () => {
      process.chdir(previous.cwd);
      restoreLedger();
      for (const [name, value] of [
        ["HOME", previous.home],
        ["TMPDIR", previous.tmpdir],
        ["PI_DENT_FLEET_DB", previous.fleet],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const AT = "2026-03-01T10:00:00.000Z";
const hostUsage = (input: number, cost: number) => ({
  input,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + 1,
  cost: { total: cost },
});

interface Ui {
  notices: Array<{ message: string; level: string | undefined }>;
  statuses: Map<string, string | undefined>;
}

function makeCtx(project: string, entries: unknown[], ui: Ui): ExtensionContext {
  return {
    cwd: project,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string, level: string | undefined) => ui.notices.push({ message, level }),
      setStatus: (key: string, text: string | undefined) => ui.statuses.set(key, text),
      setWidget: () => {},
      setFooter: () => {},
      theme: { fg: (_color: string, text: string) => text },
      custom: async () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => SESSION_ID,
      getEntries: () => entries,
      getHeader: () => ({ type: "session", id: SESSION_ID, timestamp: AT }),
      getSessionFile: () => join(project, "session.jsonl"),
      getSessionDir: () => project,
      getBranch: () => [],
      getLeafId: () => null,
      getSessionName: () => undefined,
    },
    model: undefined,
    thinkingLevel: undefined,
    modelRegistry: { getAll: () => [], getAvailable: () => [], isUsingOAuth: () => false },
    isIdle: () => true,
    abort: () => {},
    compact: () => {},
    getContextUsage: () => undefined,
    isProjectTrusted: () => false,
  } as unknown as ExtensionContext;
}

async function fire(stub: Stub, event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of stub.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
  return results;
}

/** Resolves once `check` holds, polling the event loop; fails after 5 s. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** An earlier instance's dispatches of the session: two dispatched agent rows with usage. */
async function earlierDispatches(path: string): Promise<void> {
  const { ledger } = openLedger({ path });
  for (const [taskId, sum] of [
    ["e0000001", usage(1000, 100, 0.25, 2)],
    ["e0000002", usage(500, 50, 0.125, 1)],
  ] as const) {
    const rowId = inserted(ledger, { sessionId: SESSION_ID, taskId });
    ledger.markDispatched(rowId, { cwd: "/w" });
    ledger.setTaskUsage(rowId, sum);
    ledger.settleTask(rowId, { status: "completed", settledAt: 2000 });
  }
  await ledger.flushed();
  ledger.close();
}

test("session_start writes the ledger session row and seeds the usage tally from the ledger", async () => {
  const box = sandbox();
  const stub = makeStub();
  const ui: Ui = { notices: [], statuses: new Map() };
  const entries: unknown[] = [
    { type: "message", timestamp: AT, message: { role: "user", content: "hi" } },
    {
      type: "message",
      timestamp: AT,
      message: { role: "assistant", content: [], usage: hostUsage(10, 0.5) },
    },
    // The usage of an Agent dispatch is in its ledger row, not the session's (Section 2.1).
    {
      type: "message",
      timestamp: AT,
      message: { role: "toolResult", toolName: "Agent", content: [], usage: hostUsage(99, 9) },
    },
  ];
  const ctx = makeCtx(box.project, entries, ui);
  try {
    await earlierDispatches(box.ledgerPath);
    // A lock held by another process holds the seed read back: the tally stays partial.
    const lock = raw(box.ledgerPath);
    lock.exec("BEGIN IMMEDIATE");
    await factory(stub.pi);
    await fire(stub, "session_start", { reason: "reload" }, ctx);
    assert.equal(ui.statuses.get(USAGE_STATUS_KEY), undefined, "no counted task yet");
    lock.exec("COMMIT");
    lock.close();

    // The seed read adds the earlier dispatches, and the tally is no longer partial.
    await until(() => ui.statuses.get(USAGE_STATUS_KEY) !== undefined, "the seeded status line");
    assert.equal(ui.statuses.get(USAGE_STATUS_KEY), "2 agents · 3 turns · ↑1.5k ↓150 · $0.375 │");
    await until(() => sessionRow(box.ledgerPath, SESSION_ID) !== undefined, "the session row");
    const row = sessionRow(box.ledgerPath, SESSION_ID);
    assert.deepEqual(
      [row?.session_file, row?.cwd, row?.input, row?.output, row?.cost, row?.turns],
      [join(box.project, "session.jsonl"), box.project, 10, 1, 0.5, 1],
    );

    // Each message end rewrites the row from the host's entries (Section 3.3).
    entries.push({
      type: "message",
      timestamp: AT,
      message: { role: "assistant", content: [] },
    });
    await fire(stub, "message_end", { message: { role: "assistant", content: [] } }, ctx);
    await until(() => sessionRow(box.ledgerPath, SESSION_ID)?.turns === 2, "the rewritten row");

    // The Session tool reports the ledger's figures (session-tool.md Section 2).
    const session = (await stub.tools
      .get("Session")
      ?.execute("tc", {}, undefined, undefined, ctx)) as {
      details: Record<string, unknown>;
    };
    assert.equal(session.details.ledger, "ok");
    assert.deepEqual(session.details.usage, {
      own: usage(10, 1, 0.5, 2),
      tasks: { count: 2, usage: usage(1500, 150, 0.375, 3) },
      total: usage(1510, 151, 0.875, 5),
    });
    assert.equal("usage" in session, false, "a pi-dent tool result carries no host usage");
    assert.deepEqual(
      ui.notices.filter((notice) => notice.message.includes("ledger")),
      [],
    );
  } finally {
    await fire(stub, "session_shutdown", { reason: "quit" }, ctx);
    box.restore();
  }
});

test("a ledger that cannot be used is one notice, and the tally stays partial", async () => {
  const box = sandbox();
  const stub = makeStub();
  const ui: Ui = { notices: [], statuses: new Map() };
  const ctx = makeCtx(box.project, [], ui);
  try {
    // A file of another format version is left unchanged and makes the ledger unusable.
    const db = raw(box.ledgerPath);
    db.exec("PRAGMA user_version = 2");
    db.close();
    await factory(stub.pi);
    await fire(stub, "session_start", { reason: "startup" }, ctx);
    await until(
      () => ui.notices.some((notice) => notice.message.includes("task ledger")),
      "the notice",
    );
    assert.deepEqual(
      ui.notices.filter((notice) => notice.message.includes("task ledger")),
      [
        {
          message: "pi-dent: task ledger unavailable: unsupported task ledger version 2",
          level: "warning",
        },
      ],
    );
    const session = (await stub.tools
      .get("Session")
      ?.execute("tc", {}, undefined, undefined, ctx)) as { details: Record<string, unknown> };
    assert.equal(session.details.ledger, "unavailable");
    assert.equal(session.details.usage, null);
  } finally {
    await fire(stub, "session_shutdown", { reason: "quit" }, ctx);
    box.restore();
  }
});

test("pi-dent's tool-result handlers never set a host usage (task-ledger.md Section 2.1)", async () => {
  const box = sandbox();
  const stub = makeStub();
  const ui: Ui = { notices: [], statuses: new Map() };
  const ctx = makeCtx(box.project, [], ui);
  try {
    await factory(stub.pi);
    await fire(stub, "session_start", { reason: "startup" }, ctx);
    for (const toolName of ["Agent", "Script", "Bash", "Task", "Fleet", "Session", "Edit"]) {
      const event = {
        type: "tool_result",
        toolCallId: "c1/1",
        parentToolCallId: "c1",
        toolName,
        input: {},
        content: [{ type: "text", text: "x" }],
        details: {},
        isError: false,
      };
      for (const result of await fire(stub, "tool_result", event, ctx)) {
        const changed = result !== null && typeof result === "object" && "usage" in result;
        assert.equal(changed, false, `${toolName}: a handler set a usage`);
      }
      assert.equal("usage" in event, false, `${toolName}: a handler added a usage to the event`);
    }
  } finally {
    await fire(stub, "session_shutdown", { reason: "quit" }, ctx);
    box.restore();
  }
});
