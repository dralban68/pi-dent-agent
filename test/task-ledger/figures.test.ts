import assert from "node:assert/strict";
import { test } from "node:test";
import { inserted, ok, openLedger, usage } from "./support.ts";

/** specs/task-ledger.md Section 6: figures derived from the rows when read. */

test("row and session figures over a tree with a row whose parent is missing", async () => {
  const { ledger } = openLedger({ now: () => 10_000 });
  const u1 = usage(100, 10, 0.5, 2, 1000, 50);
  const u2 = usage(200, 20, 0.25, 3);
  const u3 = usage(300, 30, 0.125, 4);
  const own = usage(7, 8, 1, 1);

  const root = inserted(ledger, { taskId: "r0000000", startedAt: 1000 });
  ledger.markDispatched(root, { cwd: "/w" });
  ledger.setTaskUsage(root, u1, 4);
  ledger.settleTask(root, { status: "completed", settledAt: 5000 });
  const child = inserted(ledger, { taskId: "a0000000", parentRowId: root, startedAt: 1100 });
  ledger.markDispatched(child, { cwd: "/w" });
  ledger.setTaskUsage(child, u2, 0);
  ledger.settleTask(child, { status: "completed", settledAt: 2100 });
  const grandchild = inserted(ledger, {
    taskId: "b0000000",
    parentRowId: child,
    kind: "bash",
    startedAt: 1200,
  });
  ledger.settleTask(grandchild, { status: "failed", settledAt: 1700 });
  const rejected = inserted(ledger, { taskId: "c0000000", parentRowId: root, startedAt: 1300 });
  ledger.settleTask(rejected, { status: "failed", settledAt: 1300 });

  const orphan = inserted(ledger, {
    taskId: "o0000000",
    parentRowId: "00000000-0000-4000-8000-000000000000",
    kind: "script",
    startedAt: 2000,
    toolCalls: 2,
  });
  const orphanChild = inserted(ledger, {
    taskId: "d0000000",
    parentRowId: orphan,
    startedAt: 3000,
  });
  ledger.markDispatched(orphanChild, { cwd: "/w" });
  ledger.setTaskUsage(orphanChild, u3, 0);
  ledger.settleTask(orphanChild, { status: "cancelled", settledAt: 2500 });

  const elsewhere = inserted(ledger, { sessionId: "session-b", taskId: "e0000000" });
  ledger.markDispatched(elsewhere, { cwd: "/w" });
  ledger.setTaskUsage(elsewhere, usage(9999, 9999, 99, 99), 0);
  ledger.writeSession({
    sessionId: "session-a",
    sessionFile: null,
    cwd: "/w",
    usage: own,
    toolCalls: 0,
  });

  const rows = ok(
    await ledger.readRowFigures([root, orphan, orphanChild, grandchild, "absent-row"]),
  );
  assert.equal(rows.has("absent-row"), false);
  assert.deepEqual(rows.get(root), {
    rowId: root,
    kind: "agent",
    status: "completed",
    own: u1,
    toolCalls: 4,
    total: usage(300, 30, 0.75, 5, 1000, 50),
    descendants: 3,
    wallMs: 4000,
    descendantMs: 1000 + 500 + 0,
    agents: { count: 1, usage: u2 },
  });
  // The missing parent makes the orphan nobody's descendant; its own descendants are still its own.
  assert.deepEqual(rows.get(orphan), {
    rowId: orphan,
    kind: "script",
    status: "running",
    own: usage(0, 0, 0, 0),
    toolCalls: 2,
    total: u3,
    descendants: 1,
    wallMs: 8000,
    descendantMs: 0,
    agents: { count: 1, usage: u3 },
  });
  // A settled_at before started_at gives a wall time of 0, never negative.
  assert.equal(rows.get(orphanChild)?.wallMs, 0);
  assert.equal(rows.get(orphanChild)?.descendants, 0);
  assert.deepEqual(rows.get(grandchild)?.own, usage(0, 0, 0, 0));
  // A bash row's count is unknown, not 0 (Section 6).
  assert.equal(rows.get(grandchild)?.toolCalls, undefined);

  assert.deepEqual(ok(await ledger.readSessionFigures("session-a")), {
    own,
    agents: { count: 3, usage: usage(600, 60, 0.875, 9, 1000, 50) },
    total: usage(607, 68, 1.875, 10, 1000, 50),
  });
  assert.deepEqual(ok(await ledger.readAgentFigures("session-a")), {
    count: 3,
    usage: usage(600, 60, 0.875, 9, 1000, 50),
  });
  ledger.close();
});

test("a session without a ledger session row has no session figures but its agent figures", async () => {
  const { ledger } = openLedger();
  const rowId = inserted(ledger);
  ledger.markDispatched(rowId, { cwd: "/w" });
  assert.equal(ok(await ledger.readSessionFigures("session-a")), undefined);
  assert.equal(ok(await ledger.readAgentFigures("session-a")).count, 1);
  ledger.close();
});

test("a rebuilt row's figures are read by the key Section 4.2 finds its ledger row by", async () => {
  const { ledger } = openLedger();
  const rowId = inserted(ledger, { taskId: "k0000000", startedAt: 42 });
  ledger.setTaskUsage(rowId, usage(5, 6, 0.5, 1), 0);
  const key = { sessionId: "session-a", taskId: "k0000000", startedAt: 42 };
  const missing = { ...key, startedAt: 43 };
  const rows = ok(await ledger.readRowFigures([key, missing]));
  assert.equal(rows.get(key)?.rowId, rowId);
  assert.deepEqual(rows.get(key)?.own, usage(5, 6, 0.5, 1));
  assert.equal(rows.has(missing), false);
  ledger.close();
});
