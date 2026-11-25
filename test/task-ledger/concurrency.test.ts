import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_DEADLINE_MS } from "../../lib/task-ledger.ts";
import { inserted, ok, openLedger, raw, taskRow, usage } from "./support.ts";

/** specs/task-ledger.md Sections 5 and 7: the process's ledger order, busy files, deadlines, failures. */

/** Hold the ledger's write lock from another connection until `release` is called. */
function holdWriteLock(path: string): { release: () => void } {
  const db = raw(path);
  db.exec("BEGIN IMMEDIATE");
  return {
    release: () => {
      db.exec("COMMIT");
      db.close();
    },
  };
}

/** The longest gap between ticks of a 10 ms interval while `during` runs. */
async function longestGap(during: () => Promise<void>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  const ticker = setInterval(() => {
    const at = performance.now();
    longest = Math.max(longest, at - last);
    last = at;
  }, 10);
  try {
    await during();
  } finally {
    clearInterval(ticker);
  }
  return longest;
}

test("a write behind a held lock is retried, not failed, and the event loop keeps running", async () => {
  const { ledger, path, notices } = openLedger();
  await ledger.flushed();
  const lock = holdWriteLock(path);
  let rowId = "";
  const gap = await longestGap(async () => {
    rowId = inserted(ledger);
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    lock.release();
    await ledger.flushed();
  });
  assert.equal(ledger.unusableReason(), undefined);
  assert.deepEqual(notices, []);
  assert.equal(taskRow(path, rowId).status, "running");
  // Far below the 5000 ms busy timeout: no attempt held the event loop for it.
  assert.ok(gap < 250, `event loop blocked for ${gap} ms`);
  ledger.close();
});

test("a surface read not applied by the read deadline is busy; the seed read waits", async () => {
  assert.equal(READ_DEADLINE_MS, 2000);
  const { ledger, path } = openLedger({ readDeadlineMs: 50 });
  await ledger.flushed();
  const lock = holdWriteLock(path);
  const rowId = inserted(ledger);
  ledger.markDispatched(rowId, { cwd: "/w" });
  const surface = ledger.readRowFigures([rowId]);
  const seed = ledger.readAgentFigures("session-a");
  assert.deepEqual(await surface, { status: "busy" });
  lock.release();
  assert.deepEqual(ok(await seed), { count: 1, usage: usage(0, 0, 0, 0) });
  const after = ok(await ledger.readRowFigures([rowId]));
  assert.equal(after.get(rowId)?.status, "running");
  assert.equal(ledger.unusableReason(), undefined);
  ledger.close();
});

test("reads see every write issued before them, across instances, an ended instance's included", async () => {
  const first = openLedger();
  const rowId = inserted(first.ledger);
  first.ledger.markDispatched(rowId, { cwd: "/w" });
  first.ledger.setTaskUsage(rowId, usage(5, 6, 0.125, 2));
  first.ledger.close();
  const second = openLedger({ path: first.path });
  const figures = ok(await second.ledger.readAgentFigures("session-a"));
  assert.deepEqual(figures, { count: 1, usage: usage(5, 6, 0.125, 2) });
  // A write issued after close is still applied.
  first.ledger.settleTask(rowId, { status: "completed", settledAt: 2000 });
  await first.ledger.flushed();
  assert.equal(taskRow(first.path, rowId).status, "completed");
  second.ledger.close();
});

test("a failing statement makes the ledger unusable once, dropping queued reads", async () => {
  const { ledger, path, notices } = openLedger();
  await ledger.flushed();
  const db = raw(path);
  db.exec("DROP TABLE tasks");
  db.close();
  inserted(ledger);
  const queued = ledger.readAgentFigures("session-a");
  const reason = "no such table: tasks";
  assert.deepEqual(await queued, { status: "unavailable", reason });
  assert.equal(ledger.unusableReason(), reason);
  assert.equal(
    ledger.insertTask({
      sessionId: "s",
      taskId: "t",
      fleetQuery: false,
      kind: "agent",
      background: false,
      cwd: "/",
      label: "l",
      startedAt: 1,
    }),
    undefined,
  );
  ledger.writeSession({ sessionId: "s", sessionFile: null, cwd: "/", usage: usage(0, 0, 0, 0) });
  assert.deepEqual(await ledger.readRowFigures([]), { status: "unavailable", reason });
  await ledger.flushed();
  assert.deepEqual(notices, [
    { message: `pi-dent: task ledger unavailable: ${reason}`, level: "warning" },
  ]);
  ledger.close();
});

test("a write that fails is rolled back whole", async () => {
  const { ledger, path } = openLedger();
  const rowId = inserted(ledger, { sessionPath: "/s/a.jsonl" });
  await ledger.flushed();
  const db = raw(path);
  db.exec(
    "CREATE TRIGGER refuse AFTER UPDATE OF resumes_id ON tasks BEGIN SELECT RAISE(ABORT, 'refused'); END",
  );
  db.close();
  ledger.markDispatched(rowId, { cwd: "/plan", resume: { by: "path" } });
  await ledger.flushed();
  assert.equal(ledger.unusableReason(), "refused");
  const row = taskRow(path, rowId);
  assert.deepEqual([row.dispatched, row.cwd], [0, "/work"]);
  ledger.close();
});

test("a read of a session the ledger holds no row of adds nothing", async () => {
  const { ledger } = openLedger();
  assert.deepEqual(ok(await ledger.readAgentFigures("nobody")), {
    count: 0,
    usage: usage(0, 0, 0, 0),
  });
  assert.equal(ok(await ledger.readSessionFigures("nobody")), undefined);
  ledger.close();
});
