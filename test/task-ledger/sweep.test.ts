import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { processStartedMs } from "../../lib/task-ledger.ts";
import { inserted, openLedger, raw, taskRow } from "./support.ts";

/** specs/task-ledger.md Section 4.1: the sweep at opening. */

/** The pid of a process that has exited. */
function deadPid(): Promise<number> {
  return new Promise((resolvePid, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => {
      if (child.pid === undefined) reject(new Error("no pid"));
      else resolvePid(child.pid);
    });
  });
}

function setOwner(path: string, rowId: string, pid: number, started: number, updatedAt: number) {
  const db = raw(path);
  db.prepare(
    "UPDATE tasks SET owner_pid = ?, owner_started = ?, updated_at = ? WHERE row_id = ?",
  ).run(pid, started, updatedAt, rowId);
  db.close();
}

test("opening settles the running rows of a gone owner interrupted at their updated_at", async () => {
  const first = openLedger();
  const dead = inserted(first.ledger, { taskId: "dead0001" });
  const deadSettled = inserted(first.ledger, { taskId: "dead0002" });
  first.ledger.settleTask(deadSettled, { status: "completed", settledAt: 3000 });
  const recycled = inserted(first.ledger, { taskId: "self0001" });
  const live = inserted(first.ledger, { taskId: "self0002" });
  const parent = inserted(first.ledger, { taskId: "ppid0001" });
  await first.ledger.flushed();
  first.ledger.close();

  const pid = await deadPid();
  setOwner(first.path, dead, pid, 1, 4242);
  setOwner(first.path, deadSettled, pid, 1, 4343);
  // This process's pid with a start time over 1000 ms away: an earlier process with the same pid.
  setOwner(first.path, recycled, process.pid, processStartedMs() - 1500, 4444);
  setOwner(first.path, live, process.pid, processStartedMs() + 900, 4545);
  setOwner(first.path, parent, process.ppid, 1, 4646);

  const second = openLedger({ path: first.path, now: () => 9999 });
  await second.ledger.flushed();
  const columns = (rowId: string) => {
    const row = taskRow(first.path, rowId);
    return [row.status, row.settled_at, row.updated_at];
  };
  // settled_at from the old updated_at, then updated_at the time of the sweep.
  assert.deepEqual(columns(dead), ["interrupted", 4242, 9999]);
  assert.deepEqual(columns(deadSettled), ["completed", 3000, 4343]);
  assert.deepEqual(columns(recycled), ["interrupted", 4444, 9999]);
  assert.deepEqual(columns(live), ["running", null, 4545]);
  assert.deepEqual(columns(parent), ["running", null, 4646]);
  second.ledger.close();
});
