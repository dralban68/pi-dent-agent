import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { USAGE_STATUS_KEY } from "../../lib/usage.ts";
import { must } from "../support/must.ts";
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
    // The main session's active tools: `Agent` gives a dispatch its authority (agent-tool.md 3.1).
    getActiveTools: () => ["Agent", "Script", "Bash"],
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

function sandbox(footer = false): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-ledger-wiring-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(project, ".pi", "pi-dent"), { recursive: true });
  // Without pi-dent's footer, the usage status line shows the tally (agent-tool.md Section 13).
  writeFileSync(
    join(project, ".pi", "pi-dent", "pi-dent.conf"),
    JSON.stringify({ footer: { enabled: footer } }),
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
  /** The footer pi-dent set, rendered at a width of 300. */
  footer?: (() => string[]) | undefined;
}

/** A model no provider serves: a dispatch with it passes its checks and fails to start. */
const MODEL = {
  provider: "nowhere",
  id: "m",
  name: "m",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:9",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};

type Factory = (tui: unknown, theme: unknown, data: unknown) => { render(width: number): string[] };

function makeCtx(project: string, entries: unknown[], ui: Ui): ExtensionContext {
  return {
    cwd: project,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string, level: string | undefined) => ui.notices.push({ message, level }),
      setStatus: (key: string, text: string | undefined) => ui.statuses.set(key, text),
      setWidget: () => {},
      setFooter: (make: Factory | undefined) => {
        if (make === undefined) {
          ui.footer = undefined;
          return;
        }
        const component = make(
          { requestRender: () => {} },
          { fg: (_color: string, text: string) => text },
          {
            getGitBranch: () => null,
            getAvailableProviderCount: () => 1,
            getExtensionStatuses: () => new Map(),
            onBranchChange: () => () => {},
          },
        );
        ui.footer = () => component.render(300);
      },
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
    model: MODEL,
    thinkingLevel: undefined,
    modelRegistry: {
      getAll: () => [MODEL],
      getAvailable: () => [MODEL],
      isUsingOAuth: () => false,
      getRegisteredProviderIds: () => [],
    },
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
    ledger.setTaskUsage(rowId, sum, 0);
    ledger.settleTask(rowId, { status: "completed", settledAt: 2000 });
  }
  await ledger.flushed();
  ledger.close();
}

/** A background `Agent` call of the main session that passes its checks: the tally counts it. */
async function countedDispatch(stub: Stub, ctx: ExtensionContext): Promise<void> {
  const result = (await must(stub.tools.get("Agent")).execute(
    "agent-1",
    { prompt: "P", task: "t", background: true },
    undefined,
    undefined,
    ctx,
  )) as { content: Array<{ text?: string }>; isError?: boolean };
  assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
}

/** Hold the ledger file's write lock from another connection, as another process would. */
function lockLedger(path: string): () => void {
  const lock = raw(path);
  lock.exec("BEGIN IMMEDIATE");
  return () => {
    lock.exec("COMMIT");
    lock.close();
  };
}

const SEEDED = "3 agents · 3 turns · ↑1.5k ↓150 · $0.375";
const COUNTED_ONLY = "1 agent · 0 turns · ↑0 ↓0 · $0.000";

test("the ledger session row is written at session_start, each message end, compaction, branch summary and shutdown", async () => {
  const box = sandbox();
  const stub = makeStub();
  const ui: Ui = { notices: [], statuses: new Map() };
  const entries: unknown[] = [
    { type: "message", timestamp: AT, message: { role: "user", content: "hi" } },
    {
      type: "message",
      timestamp: AT,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "Agent", arguments: {} }],
        usage: hostUsage(10, 0.5),
      },
    },
    // The usage of an Agent dispatch is in its ledger row, not the session's (Section 2.1).
    {
      type: "message",
      timestamp: AT,
      message: { role: "toolResult", toolName: "Agent", content: [], usage: hostUsage(99, 9) },
    },
  ];
  const ctx = makeCtx(box.project, entries, ui);
  // Undefined until the ledger file has its schema and the row.
  const row = () => {
    try {
      return sessionRow(box.ledgerPath, SESSION_ID);
    } catch {
      return undefined;
    }
  };
  let shutDown = false;
  try {
    await factory(stub.pi);
    await fire(stub, "session_start", { reason: "startup" }, ctx);
    await until(() => row() !== undefined, "the session row");
    assert.deepEqual(
      [
        row()?.session_file,
        row()?.cwd,
        row()?.input,
        row()?.output,
        row()?.cost,
        row()?.turns,
        row()?.tool_calls,
      ],
      [join(box.project, "session.jsonl"), box.project, 10, 1, 0.5, 1, 1],
    );

    // The host reports a message's end before it saves the message (Section 3.3).
    const ended = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c2", name: "Read", arguments: {} },
        { type: "toolCall", id: "c3", name: "Bash", arguments: {} },
      ],
      usage: hostUsage(5, 0.25),
    };
    await fire(stub, "message_end", { message: ended }, ctx);
    await until(() => row()?.turns === 2, "the row counting the ended message");
    assert.equal(row()?.input, 15);
    assert.equal(row()?.tool_calls, 3, "the ended message's tool calls, counted like its turn");
    // Once saved, the same message is counted once.
    entries.push({ type: "message", timestamp: AT, message: ended });
    await fire(stub, "message_end", { message: { role: "user", content: "next" } }, ctx);

    // The host saves a compaction and a branch summary before it reports them.
    entries.push({ type: "compaction", timestamp: AT, usage: hostUsage(7, 0.125) });
    await fire(stub, "session_compact", { compactionEntry: {} }, ctx);
    await until(() => row()?.input === 22, "the row with the compaction");
    assert.equal(row()?.turns, 2, "the saved message is counted once");
    assert.equal(row()?.tool_calls, 3, "and its tool calls once");
    const summary = { type: "branch_summary", timestamp: AT, usage: hostUsage(3, 0.0625) };
    entries.push(summary);
    await fire(stub, "session_tree", { summaryEntry: summary }, ctx);
    await until(() => row()?.input === 25, "the row with the branch summary");

    // The Session tool reports the ledger's figures (session-tool.md Section 2).
    const session = (await must(stub.tools.get("Session")).execute(
      "tc",
      {},
      undefined,
      undefined,
      ctx,
    )) as { details: Record<string, unknown> };
    assert.equal(session.details.ledger, "ok");
    assert.deepEqual(session.details.usage, {
      own: { input: 25, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.9375, turns: 2 },
      tasks: { count: 0, usage: usage(0, 0, 0, 0) },
      total: { input: 25, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.9375, turns: 2 },
    });
    assert.equal("usage" in session, false, "a pi-dent tool result carries no host usage");

    entries.push({ type: "message", timestamp: AT, message: { role: "assistant", content: [] } });
    shutDown = true;
    await fire(stub, "session_shutdown", { reason: "quit" }, ctx);
    await until(() => row()?.turns === 3, "the row written at shutdown");
    assert.deepEqual(
      ui.notices.filter((notice) => notice.message.includes("ledger")),
      [],
    );
  } finally {
    if (!shutDown) await fire(stub, "session_shutdown", { reason: "quit" }, ctx);
    box.restore();
  }
});

test("the status line shows (partial) while the seed read waits, and the seeded tally after", async () => {
  const box = sandbox();
  const stub = makeStub();
  const ui: Ui = { notices: [], statuses: new Map() };
  const ctx = makeCtx(box.project, [], ui);
  let release = (): void => {};
  try {
    await earlierDispatches(box.ledgerPath);
    // Another process's lock holds the ledger order, and with it the seed read, back.
    release = lockLedger(box.ledgerPath);
    await factory(stub.pi);
    await fire(stub, "session_start", { reason: "reload" }, ctx);
    await countedDispatch(stub, ctx);
    assert.equal(ui.statuses.get(USAGE_STATUS_KEY), `${COUNTED_ONLY} (partial) │`);
    release();
    release = () => {};
    await until(
      () => ui.statuses.get(USAGE_STATUS_KEY) === `${SEEDED} │`,
      "the seeded status line",
    );
  } finally {
    release();
    await fire(stub, "session_shutdown", { reason: "quit" }, ctx);
    box.restore();
  }
});

test("pi-dent's footer shows (partial) while the seed read waits, and the seeded tally after", async () => {
  const box = sandbox(true);
  const stub = makeStub();
  const ui: Ui = { notices: [], statuses: new Map() };
  const ctx = makeCtx(box.project, [], ui);
  const agents = () => must(ui.footer)().find((line) => line.includes(" agent")) ?? "";
  let release = (): void => {};
  try {
    await earlierDispatches(box.ledgerPath);
    release = lockLedger(box.ledgerPath);
    await factory(stub.pi);
    await fire(stub, "session_start", { reason: "reload" }, ctx);
    await countedDispatch(stub, ctx);
    assert.ok(agents().includes(`│ ${COUNTED_ONLY} (partial)`), agents());
    release();
    release = () => {};
    await until(() => agents().includes(`│ ${SEEDED}`), "the seeded footer");
    assert.equal(agents().includes("(partial)"), false, agents());
  } finally {
    release();
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
    // The seed read was dropped with the ledger: what is counted now is all the tally has.
    await countedDispatch(stub, ctx);
    assert.equal(ui.statuses.get(USAGE_STATUS_KEY), `${COUNTED_ONLY} (partial) │`);
    const session = (await must(stub.tools.get("Session")).execute(
      "tc",
      {},
      undefined,
      undefined,
      ctx,
    )) as { details: Record<string, unknown> };
    assert.equal(session.details.ledger, "unavailable");
    assert.equal(session.details.usage, null);
    assert.equal(ui.statuses.get(USAGE_STATUS_KEY), `${COUNTED_ONLY} (partial) │`);
  } finally {
    await fire(stub, "session_shutdown", { reason: "quit" }, ctx);
    box.restore();
  }
});

test("a task a nested call of a main-session Script run registers has the script's row as parent", async () => {
  const box = sandbox();
  const stub = makeStub();
  const ui: Ui = { notices: [], statuses: new Map() };
  const ctx = makeCtx(box.project, [], ui);
  // The host's nested-call function: it reports the calling tool call with each execution event.
  const toolCtx = {
    ...ctx,
    tools: [
      {
        name: "Bash",
        description: "Bash",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
    executeTool: async (name: string, args: unknown, options?: { signal?: AbortSignal }) => {
      const id = "script-1/1";
      const event = { toolCallId: id, toolName: name, args, parentToolCallId: "script-1" };
      await fire(stub, "tool_execution_start", event, ctx);
      const result = (await must(stub.tools.get(name)).execute(
        id,
        args,
        options?.signal,
        undefined,
        ctx,
      )) as { isError?: boolean };
      const isError = result.isError === true;
      await fire(stub, "tool_execution_end", { ...event, result, isError }, ctx);
      return { result, isError };
    },
  };
  try {
    await factory(stub.pi);
    await fire(stub, "session_start", { reason: "startup" }, ctx);
    await fire(
      stub,
      "tool_execution_start",
      { toolCallId: "script-1", toolName: "Script", args: {} },
      ctx,
    );
    const ran = (await must(stub.tools.get("Script")).execute(
      "script-1",
      { code: 'await tools.Bash({ command: "echo nested" }); "ok"' },
      undefined,
      undefined,
      toolCtx,
    )) as { isError?: boolean; content: Array<{ text?: string }> };
    assert.equal(ran.isError, undefined, ran.content[0]?.text ?? "");
    const rows = () => {
      const db = raw(box.ledgerPath);
      try {
        return db.prepare("SELECT row_id, kind, parent_id, status FROM tasks").all();
      } finally {
        db.close();
      }
    };
    await until(
      () => rows().filter((row) => row.status === "completed").length === 2,
      "both rows settled",
    );
    const script = must(rows().find((row) => row.kind === "script"));
    const bash = must(rows().find((row) => row.kind === "bash"));
    assert.equal(script.parent_id, null);
    assert.equal(bash.parent_id, script.row_id);
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
