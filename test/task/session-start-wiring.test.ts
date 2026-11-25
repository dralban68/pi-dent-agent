import { test } from "node:test";
import { isolateTaskLedger } from "../support/task-ledger-env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { at } from "../support/must.ts";

/**
 * The index.ts `session_start` wiring of specs/task-record.md Section 3 and
 * specs/session-store.md Section 4: the rebuild reports an unreadable agent
 * directory, runs only when this boot window owns the session, and a refused
 * registration warns with the ownership text instead of rebuilding. index.ts is
 * loaded through jiti, as in test/schedule-tool/wiring.test.ts.
 */

const entryDir = fileURLToPath(new URL(".", import.meta.url));
const jiti = createJiti(import.meta.url);
const factory = (
  await jiti.import<{ default: (pi: ExtensionAPI) => Promise<void> | void }>(
    join(entryDir, "..", "..", "index.ts"),
  )
).default;

type Handler = (event?: unknown, ctx?: unknown) => unknown;

interface Notification {
  message: string;
  level: string | undefined;
}

interface SentMessage {
  message: { customType?: string; content: string; display?: boolean };
  options: unknown;
}

interface StubPi {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  sent: SentMessage[];
  /** Makes `sendMessage` throw, as a host that has gone away does. */
  refuse: boolean;
}

function makeStubPi(): StubPi {
  const handlers = new Map<string, Handler[]>();
  const stub: StubPi = {
    pi: undefined as unknown as ExtensionAPI,
    handlers,
    sent: [],
    refuse: false,
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
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    sendMessage: (message: SentMessage["message"], options: unknown) => {
      if (stub.refuse) throw new Error("This extension ctx is stale");
      stub.sent.push({ message, options });
    },
    sendUserMessage: async () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return stub;
}

/** A throwaway project and home, a store of its own, and `cwd` inside the project. */
function makeProject(): { project: string; restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-session-start-wiring-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(project, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  const prevHome = process.env.HOME;
  const prevTmpdir = process.env.TMPDIR;
  const prevDb = process.env.PI_DENT_FLEET_DB;
  const prevCwd = process.cwd();
  process.env.HOME = home;
  const restoreLedger = isolateTaskLedger(home);
  process.env.TMPDIR = join(root, "tmp");
  process.env.PI_DENT_FLEET_DB = join(root, "fleet.sqlite");
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
      if (prevDb === undefined) delete process.env.PI_DENT_FLEET_DB;
      else process.env.PI_DENT_FLEET_DB = prevDb;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const SESSION_ID = "wired-session";

/** The main session's agent directory of the session file `<project>/session.jsonl`. */
function agentsDir(project: string): string {
  return join(project, "session.agents");
}

function makeCtx(project: string, notifications: Notification[]): ExtensionContext {
  return {
    cwd: project,
    mode: "print",
    hasUI: true,
    ui: {
      notify: (message: string, level: string | undefined) =>
        notifications.push({ message, level }),
      setStatus: () => {},
      setWidget: () => {},
      custom: async () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => SESSION_ID,
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

async function sessionShutdown(stub: StubPi, ctx: ExtensionContext, reason: string): Promise<void> {
  for (const handler of stub.handlers.get("session_shutdown") ?? []) await handler({ reason }, ctx);
}

/** One `running` task record, as a task of an earlier boot window would leave it. */
function writeRunningRecord(project: string): string {
  const dir = agentsDir(project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "aaaa0001.task.json");
  writeFileSync(
    file,
    JSON.stringify({
      taskId: "aaaa0001",
      agent: "dynamic",
      label: "stuck",
      cohort: "cohort-1",
      startedAt: 1_000,
      sessionPath: join(project, "child.jsonl"),
      status: "running",
    }),
  );
  return file;
}

function interruptedNotifications(stub: StubPi): SentMessage[] {
  return stub.sent.filter(
    (sent) =>
      sent.message.customType === "pi-dent-tasks" &&
      sent.message.content.startsWith("Interrupted tasks (resume with Agent resume="),
  );
}

/**
 * Leave the session's record owned by another live boot window: a foreign process that is
 * alive, so the store refuses this boot window's registration (session-store.md Section 4).
 */
function ownSessionInAnotherProcess(project: string): void {
  const dbPath = process.env.PI_DENT_FLEET_DB ?? "";
  assert.ok(dbPath !== "", "the project isolates the store");
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO fleet_sessions
         (session_id, cwd, repo_root, state, alive, updated_at, turns_json, owner_pid, owner_boot, owner_started, agents_dir, hidden)
       VALUES (?, ?, NULL, 'idle', 1, ?, '[]', ?, 'bbbbbbbb', NULL, NULL, 0)`,
    ).run(SESSION_ID, project, Date.now(), process.ppid);
  } finally {
    db.close();
  }
}

test("an unreadable agent directory is one warning naming it, and inserts no row", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  const notifications: Notification[] = [];
  const ctx = makeCtx(project, notifications);
  try {
    // The agent directory's path is a regular file, so listing it fails (ENOTDIR).
    writeFileSync(agentsDir(project), "not a directory");
    await factory(stub.pi);
    await sessionStart(stub, ctx);

    const warnings = notifications.filter((call) =>
      call.message.includes("cannot read the task record directory"),
    );
    assert.equal(warnings.length, 1, JSON.stringify(notifications));
    const only = at(warnings, 0);
    assert.equal(only.level, "warning");
    assert.ok(
      only.message.startsWith(
        `pi-dent: cannot read the task record directory ${agentsDir(project)}: `,
      ),
      only.message,
    );
    assert.match(only.message, /ENOTDIR/u, "the notice names the error");
    assert.deepEqual(
      interruptedNotifications(stub),
      [],
      "no row comes from an unreadable directory",
    );
  } finally {
    await sessionShutdown(stub, ctx, "quit");
    restore();
  }
});

test("a session this boot window owns rebuilds its records and notifies the interrupted rows", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  const notifications: Notification[] = [];
  const ctx = makeCtx(project, notifications);
  try {
    writeRunningRecord(project);
    await factory(stub.pi);
    await sessionStart(stub, ctx);

    const rebuilt = interruptedNotifications(stub);
    assert.equal(rebuilt.length, 1, JSON.stringify(stub.sent));
    assert.match(at(rebuilt, 0).message.content, /^Interrupted tasks \(resume with Agent resume=/);
    assert.equal(
      notifications.some((call) => call.message.includes("already owned")),
      false,
      "the registration was accepted",
    );
  } finally {
    await sessionShutdown(stub, ctx, "quit");
    restore();
  }
});

test("a notification the host refuses is one warning naming the failure", async () => {
  const { project, restore } = makeProject();
  const stub = makeStubPi();
  stub.refuse = true;
  const notifications: Notification[] = [];
  const ctx = makeCtx(project, notifications);
  try {
    writeRunningRecord(project);
    await factory(stub.pi);
    await sessionStart(stub, ctx);

    const warnings = notifications.filter((call) =>
      call.message.startsWith("pi-dent: task notification was not delivered: "),
    );
    assert.equal(warnings.length, 1, JSON.stringify(notifications));
    assert.equal(at(warnings, 0).level, "warning");
    assert.match(
      at(warnings, 0).message,
      /This extension ctx is stale/u,
      "the notice names the error",
    );
  } finally {
    await sessionShutdown(stub, ctx, "quit");
    restore();
  }
});

test("a refused registration warns with the ownership text and rebuilds nothing", async () => {
  const { project, restore } = makeProject();
  const record = writeRunningRecord(project);
  const before = readFileSync(record, "utf8");
  const stub = makeStubPi();
  const notifications: Notification[] = [];
  const ctx = makeCtx(project, notifications);
  try {
    // The store exists once this boot window opened it.
    await factory(stub.pi);
    // Another live boot window, in another process, owns the session (session-store.md Section 4).
    ownSessionInAnotherProcess(project);
    await sessionStart(stub, ctx);

    const ownership = notifications.filter((call) => call.message.includes("already owned"));
    assert.equal(ownership.length, 1, JSON.stringify(notifications));
    assert.equal(
      at(ownership, 0).message,
      `pi-dent: session ${SESSION_ID} is already owned by another live boot window; Fleet delivery to this session is disabled`,
    );
    assert.equal(at(ownership, 0).level, "warning");
    assert.deepEqual(interruptedNotifications(stub), [], "a refused boot window inserts no row");
    assert.equal(readFileSync(record, "utf8"), before, "and changes no record");
  } finally {
    await sessionShutdown(stub, ctx, "quit");
    restore();
  }
});
