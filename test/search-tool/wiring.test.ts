import "../support/isolate-session-store.ts";
import assert from "node:assert/strict";
import { isolateTaskLedger } from "../support/task-ledger-env.ts";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effectiveToolCap, sessionNotes } from "../../lib/engine.ts";
import { makeSearchTool, searchRuntime } from "../../lib/search-tool.ts";
import { openSessionIndex } from "../../lib/session-index.ts";
import { must } from "../support/must.ts";

/**
 * The wiring of specs/search-tool.md Section 1 and specs/agent-tool.md Sections
 * 3.1, 4.2, and 10: `Search` is registered for the main session, a child session
 * binds it when the tool cap includes it and carries its session-notes line, and
 * the index prune runs after the retention sweep. index.ts is loaded through
 * jiti, as in test/schedule-tool/wiring.test.ts.
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
  tools: { name: string; label?: string; parameters?: unknown }[];
}

function makeStubPi(): StubPi {
  const handlers = new Map<string, Handler[]>();
  const stub: StubPi = { pi: undefined as unknown as ExtensionAPI, handlers, tools: [] };
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
    sendMessage: () => {},
    sendUserMessage: async () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return stub;
}

interface Sandbox {
  project: string;
  home: string;
  restore: () => void;
}

/** A throwaway project, home, and temporary directory. */
function makeSandbox(prefix = "pi-dent-search-wiring-"): Sandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(project, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  const previous = {
    home: process.env.HOME,
    tmpdir: process.env.TMPDIR,
    db: process.env.PI_DENT_SEARCH_DB,
    cwd: process.cwd(),
  };
  process.env.HOME = home;
  const restoreLedger = isolateTaskLedger(home);
  process.env.TMPDIR = join(root, "tmp");
  delete process.env.PI_DENT_SEARCH_DB;
  process.chdir(project);
  return {
    project,
    home,
    restore: () => {
      process.chdir(previous.cwd);
      restoreLedger();
      for (const [name, value] of [
        ["HOME", previous.home],
        ["TMPDIR", previous.tmpdir],
        ["PI_DENT_SEARCH_DB", previous.db],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The live session context of a main session. */
function makeCtx(project: string, sessionFile: string): ExtensionContext {
  return {
    cwd: project,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      custom: async () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => "search-main-session",
      getEntries: () => [],
      getHeader: () => null,
      getSessionFile: () => sessionFile,
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

test("Search is registered for the main session with its label and parameter schema", async () => {
  const sandbox = makeSandbox();
  try {
    const stub = makeStubPi();
    await factory(stub.pi);
    const tools = stub.tools.filter((tool) => tool.name === "Search");
    assert.equal(tools.length, 1);
    const tool = must(tools[0]);
    assert.equal(tool.label, "Search");
    const schema = tool.parameters;
    assert.equal(typeof schema, "object");
    assert.equal((schema as { type?: string }).type, "object");
    assert.equal((schema as { additionalProperties?: boolean }).additionalProperties, false);
    assert.deepEqual((schema as { required?: string[] }).required, ["action"]);
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.equal("action" in properties, true);
    for (const field of [
      "query",
      "regex",
      "caseSensitive",
      "kinds",
      "tool",
      "isError",
      "since",
      "until",
      "session",
      "scope",
      "branches",
      "order",
      "after",
      "limit",
      "address",
      "offset",
      "context",
    ]) {
      assert.equal(field in properties, true, field);
    }
  } finally {
    sandbox.restore();
  }
});

test("a child session binds Search when the tool cap includes it, and carries its notes line", () => {
  const tool = makeSearchTool({
    runtime: searchRuntime({ zone: "UTC" }),
    host: () => ({ sessionFile: undefined, agentDirectory: "/tmp/pi-dent-test", main: false }),
  });
  assert.equal(tool.name, "Search");
  // The effective tool cap is the cap filtered to the tools the child binds in process.
  assert.deepEqual(effectiveToolCap(["Search", "Bash", "Schedule", "read"], [tool], []), [
    "Search",
    "read",
  ]);
  // A child whose cap omits Search does not bind it.
  assert.deepEqual(effectiveToolCap(["Bash"], [tool], []), []);
  // The line is for a child that can both search and dispatch (agent-tool.md Section 4.2).
  const line =
    "- Everything an agent you dispatched ran, printed, or said is in its transcript, not only its final message: `Search` `find` with `session` set to its task ID, or to its session file path for a resumed agent, then `get` the hit by its address. A bare `find` searches this session; use it before redoing work and after a summary replaced earlier turns. Never read session files through `Bash`.";
  const notes = sessionNotes("/tmp/pi-dent-test", ["Search", "Agent"]);
  assert.equal(notes.includes(line), true, notes);
  // Without Agent nothing it could search for exists; without Search it cannot look back.
  assert.equal(sessionNotes("/tmp/pi-dent-test", ["Search"]).includes("`Search` `find`"), false);
  assert.equal(sessionNotes("/tmp/pi-dent-test", ["Agent"]).includes("`Search` `find`"), false);
  assert.equal(sessionNotes("/tmp/pi-dent-test", ["read"]).includes("`Search`"), false);
});

test("the index prune runs after the retention sweep", async () => {
  const sandbox = makeSandbox("pi-dent-search-prune-");
  const db = join(sandbox.project, "search-v3.sqlite");
  const sessionFile = join(sandbox.project, "gone.jsonl");
  try {
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "gone-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: sandbox.project })}\n`,
    );
    const opened = openSessionIndex({ path: db });
    if (!opened.ok) throw new Error(opened.reason);
    assert.equal((await opened.index.catchUp(sessionFile)).status, "complete");
    opened.index.close();
    // The session file is gone: only a prune removes its rows.
    rmSync(sessionFile);
    process.env.PI_DENT_SEARCH_DB = db;
    const stub = makeStubPi();
    const ctx = makeCtx(sandbox.project, join(sandbox.project, "main.jsonl"));
    await factory(stub.pi);
    for (const handler of stub.handlers.get("session_start") ?? []) {
      await handler({ reason: "startup" }, ctx);
    }
    // The prune is asynchronous and starts no timer of its own: poll for it.
    const deadline = Date.now() + 5000;
    for (;;) {
      const handle = new DatabaseSync(db);
      const row = handle.prepare("SELECT count(*) AS n FROM files").get();
      handle.close();
      const rows =
        typeof row === "object" && row !== null && "n" in row && typeof row.n === "number"
          ? row.n
          : -1;
      if (rows === 0) break;
      if (Date.now() > deadline) throw new Error(`the prune left ${rows} files rows`);
      await new Promise((done) => setTimeout(done, 5));
    }
    // The prune deletes no file.
    assert.equal(existsSync(db), true);
  } finally {
    sandbox.restore();
  }
});
