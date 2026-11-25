import assert from "node:assert/strict";
import { test } from "node:test";
import type { BootSnapshot } from "../../lib/engine.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import type { TaskLedger } from "../../lib/task-ledger.ts";
import {
  childScope,
  LedgerHolder,
  LedgerTap,
  ledgerDispatched,
  NestedCalls,
  type LedgerScope,
  type SessionLedgerSource,
} from "../../lib/task-ledger-wiring.ts";
import type { TaskRow } from "../../lib/task-row.ts";
import type { ToolResult } from "../../lib/engine.ts";
import { makeSessionTool } from "../../lib/tools.ts";
import { openLedger, raw, usage } from "../task-ledger/support.ts";

/** The `Session` tool's `ledger` and `usage` (session-tool.md Section 2). */

const boot = {
  cwd: "/w",
  config: { merged: {}, layers: {}, projectRoot: "/w", diagnostics: [], liveness: {} },
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

const ctx = (id: string) => ({
  cwd: "/w",
  sessionManager: { getSessionId: () => id, getSessionFile: () => undefined },
  modelRegistry: { getAvailable: () => [] },
});

async function report(source: SessionLedgerSource, id: string): Promise<ToolResult> {
  const tool = makeSessionTool({ boot, hostProvider: () => undefined, ledger: source });
  return tool.execute("tc", {} as never, undefined, undefined, ctx(id) as never);
}

const textOf = (result: ToolResult): string =>
  result.content[0]?.type === "text" ? result.content[0].text : "";

function holderOf(ledger: TaskLedger): LedgerHolder {
  const holder = new LedgerHolder();
  holder.ledger = ledger;
  return holder;
}

/** A main session `main` with one dispatched agent row, whose child session dispatched another. */
function arrange(ledger: TaskLedger): { holder: LedgerHolder; dispatch: TaskRow } {
  const holder = holderOf(ledger);
  const scope: LedgerScope = {
    holder,
    sessionId: () => "main",
    cwd: () => "/w",
    calls: new NestedCalls(),
  };
  const registry = new TaskRegistry(() => undefined, undefined, undefined, new LedgerTap(scope));
  const dispatch = registry.register({ kind: "agent", cohort: "c", label: "a", background: true });
  ledgerDispatched(dispatch, "/w");
  registry.amend(dispatch, { usage: usage(100, 10, 0.5, 2) });
  const nested = new TaskRegistry(
    () => undefined,
    undefined,
    undefined,
    new LedgerTap(childScope(scope, dispatch, () => "/c")),
  );
  const inner = nested.register({ kind: "agent", cohort: "k", label: "b", background: false });
  ledgerDispatched(inner, "/c");
  nested.amend(inner, { usage: usage(20, 2, 0.25, 1) });
  ledger.writeSession({
    sessionId: "main",
    sessionFile: null,
    cwd: "/w",
    usage: usage(5, 5, 1, 3),
  });
  return { holder, dispatch };
}

test("a main session reports its own usage, its agents, and the session usage", async () => {
  const { ledger } = openLedger();
  const { holder } = arrange(ledger);
  const result = await report({ holder }, "main");
  const details = result.details as Record<string, unknown>;
  assert.equal(details.ledger, "ok");
  assert.deepEqual(details.usage, {
    own: usage(5, 5, 1, 3),
    tasks: { count: 2, usage: usage(120, 12, 0.75, 3) },
    total: usage(125, 17, 1.75, 6),
  });
  const text = textOf(result);
  assert.ok(text.includes("\nledger: ok\n"), text);
  assert.ok(
    text.endsWith(
      [
        "usage:",
        "own: 3 turns · ↑5 ↓5 · $1.000",
        "tasks: 2 agents · 3 turns · ↑120 ↓12 · $0.750",
        "total: 6 turns · ↑125 ↓17 · $1.750",
      ].join("\n"),
    ),
    text,
  );
  ledger.close();
});

test("a child session reports its dispatch's row: own, its agents, and the cumulative usage", async () => {
  const { ledger } = openLedger();
  const { holder, dispatch } = arrange(ledger);
  const result = await report({ holder, row: dispatch }, "child-session");
  assert.deepEqual((result.details as Record<string, unknown>).usage, {
    own: usage(100, 10, 0.5, 2),
    tasks: { count: 1, usage: usage(20, 2, 0.25, 1) },
    total: usage(120, 12, 0.75, 3),
  });
  assert.ok(textOf(result).includes("\ntasks: 1 agent · 1 turn · ↑20 ↓2 · $0.250\n"));
  ledger.close();
});

test("a session the ledger holds no row for reports no ledger row", async () => {
  const { ledger } = openLedger();
  const { holder } = arrange(ledger);
  const main = await report({ holder }, "other");
  assert.equal((main.details as Record<string, unknown>).ledger, "missing");
  assert.equal((main.details as Record<string, unknown>).usage, null);
  assert.ok(textOf(main).endsWith("\nusage: no ledger row"));
  // A child session whose dispatch row has no ledger row.
  const unlinked = new TaskRegistry(() => undefined).register({
    kind: "agent",
    cohort: "c",
    label: "x",
    background: false,
  });
  const child = await report({ holder, row: unlinked }, "child");
  assert.equal((child.details as Record<string, unknown>).ledger, "missing");
  ledger.close();
});

test("an unusable ledger reports ledger unavailable, never zero figures", async () => {
  const { ledger, path } = openLedger();
  await ledger.flushed();
  const db = raw(path);
  db.exec("DROP TABLE sessions");
  db.close();
  ledger.writeSession({
    sessionId: "main",
    sessionFile: null,
    cwd: "/w",
    usage: usage(1, 1, 1, 1),
  });
  await ledger.flushed();
  const result = await report({ holder: holderOf(ledger) }, "main");
  assert.equal((result.details as Record<string, unknown>).ledger, "unavailable");
  assert.equal((result.details as Record<string, unknown>).usage, null);
  assert.ok(textOf(result).endsWith("\nusage: ledger unavailable"));
});

test("a read abandoned at the read deadline reports ledger busy", async () => {
  const { ledger, path } = openLedger({ readDeadlineMs: 50 });
  await ledger.flushed();
  const lock = raw(path);
  lock.exec("BEGIN IMMEDIATE");
  try {
    // A write waiting for the lock holds back the read behind it (task-ledger.md Section 5).
    ledger.writeSession({
      sessionId: "main",
      sessionFile: null,
      cwd: "/w",
      usage: usage(0, 0, 0, 0),
    });
    const result = await report({ holder: holderOf(ledger) }, "main");
    assert.equal((result.details as Record<string, unknown>).ledger, "busy");
    assert.equal((result.details as Record<string, unknown>).usage, null);
    assert.ok(textOf(result).endsWith("\nusage: ledger busy"));
  } finally {
    lock.exec("COMMIT");
    lock.close();
  }
  await ledger.flushed();
  ledger.close();
});
