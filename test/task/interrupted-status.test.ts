import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTaskRow, TaskRegistry, type SettleStatus, type TaskRow } from "../../lib/registry.ts";
import type { HostSession } from "../../lib/host.ts";

/**
 * The `interrupted` task status per specs/task-registry.md Sections 2 and 5:
 * row rendering, settlement exclusion, cohort notification, task-record
 * deletion on consume, and the rebuild of pre-built rows (task-record.md
 * Section 3).
 */

const INTERRUPTED_HEADER = "Interrupted tasks (resume with Agent resume=<taskId>):";

function hostRecording(notify: string[]): HostSession {
  return {
    notify: (message: string) => {
      notify.push(message);
    },
  } as unknown as HostSession;
}

const reg = (notify: string[] = []): TaskRegistry => new TaskRegistry(() => hostRecording(notify));

function bg(registry: TaskRegistry, cohort: string, label = "t"): TaskRow {
  return registry.register({ kind: "script", cohort, label, background: true });
}

/** A pre-built background `agent` row as a rebuild inserts it (task-record.md Section 3). */
function restoredRow(
  status: "interrupted" | "completed" | "failed" | "cancelled",
  taskId: string,
  cohort: string,
  label = "t",
  startedAt = 1000,
  settledAt = 60_000,
): AgentTaskRow {
  const row = new AgentTaskRow({ taskId, cohort, label, background: true, startedAt });
  row.status = status;
  row.settledAt = settledAt;
  return row;
}

test("renderLine freezes elapsed at settledAt once not running", () => {
  const interrupted = restoredRow("interrupted", "aaaa0001", "c", "job");
  assert.equal(
    interrupted.renderLine(9_000_000),
    "aaaa0001 · agent · bg · interrupted · 59s · job",
  );
  const completed = restoredRow("completed", "bbbb0002", "c", "done");
  assert.equal(completed.renderLine(9_000_000), "bbbb0002 · agent · bg · completed · 59s · done");
  const running = new AgentTaskRow({
    taskId: "cccc0003",
    cohort: "c",
    label: "run",
    background: false,
    startedAt: 1000,
  });
  assert.equal(running.renderLine(3500), "cccc0003 · agent · fg · running · 2s · run");
});

test("settle admits only SettleStatus and never yields interrupted", () => {
  // Typecheck-enforced: `interrupted` is not a SettleStatus (Section 2).
  const outcome: { status: SettleStatus } = { status: "completed" };
  // @ts-expect-error - interrupted is set only by a rebuild, never by settle
  outcome.status = "interrupted";

  const registry = new TaskRegistry(() => undefined);
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const row = bg(registry, "c");
    registry.settle(row, { status, result: "x" });
    assert.equal(row.status, status);
  }

  const interrupted = restoredRow("interrupted", "dddd0004", "c");
  registry.rebuild([interrupted]);
  registry.settle(interrupted, { status: "completed", result: "late" });
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.result, undefined);
});

test("a cohort holding only an interrupted row sends no completion notification", () => {
  const notify: string[] = [];
  const registry = reg(notify);
  const row = restoredRow("interrupted", "eeee0005", "c", "stuck");
  registry.rebuild([row]);
  assert.deepEqual(notify, [`${INTERRUPTED_HEADER}\n${registry.listLine(row)}`]);
  assert.equal(row.consumed, false);
});

test("rebuild sends only the interrupted notification and consumes nothing", () => {
  const notify: string[] = [];
  const registry = reg(notify);
  const done = restoredRow("completed", "ffff0006", "c", "done");
  const stuck = restoredRow("interrupted", "ffff0007", "c", "stuck");
  registry.rebuild([done, stuck]);
  assert.deepEqual(notify, [`${INTERRUPTED_HEADER}\n${registry.listLine(stuck)}`]);
  assert.equal(done.consumed, false);
  assert.equal(stuck.consumed, false);
});

test("consume deletes an agent row's record file and ignores failures", () => {
  const registry = new TaskRegistry(() => undefined);
  const dir = mkdtempSync(join(tmpdir(), "interrupted-status-"));
  try {
    const row = registry.register({ kind: "agent", cohort: "c", label: "a", background: true });
    row.status = "completed";
    row.settledAt = 2000;
    const recordPath = join(dir, "aaaa0001.task.json");
    row.recordPath = recordPath;
    writeFileSync(recordPath, "{}");
    registry.consume(row);
    assert.equal(row.consumed, true);
    assert.throws(() => statSync(recordPath), /ENOENT/);

    row.recordPath = join(dir, "missing.task.json"); // already gone: ignored
    assert.doesNotThrow(() => registry.consume(row));
    row.recordPath = dir; // a directory: unlink fails, still swallowed
    assert.doesNotThrow(() => registry.consume(row));

    const script = bg(registry, "c");
    assert.doesNotThrow(() => registry.consume(script)); // script rows carry no record
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("consume of a running agent row keeps its record for the later settle", () => {
  const registry = new TaskRegistry(() => undefined);
  const dir = mkdtempSync(join(tmpdir(), "interrupted-running-"));
  try {
    const row = registry.register({ kind: "agent", cohort: "c", label: "a", background: true });
    const recordPath = join(dir, `${row.taskId}.task.json`);
    row.recordPath = recordPath;
    writeFileSync(recordPath, "{}");
    registry.cancel(row);
    registry.consume(row);
    assert.equal(row.consumed, true);
    assert.equal(row.status, "running");
    assert.doesNotThrow(() => statSync(recordPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second rebuild lists only its own rows, never rows of an earlier rebuild", () => {
  const notify: string[] = [];
  const registry = reg(notify);
  const first = restoredRow("interrupted", "11111111", "c1", "first");
  registry.rebuild([first]);
  const second = restoredRow("interrupted", "22222222", "c2", "second");
  registry.rebuild([second]);
  assert.deepEqual(notify, [
    `${INTERRUPTED_HEADER}\n${registry.listLine(first)}`,
    `${INTERRUPTED_HEADER}\n${registry.listLine(second)}`,
  ]);
});

test("rebuild inserts rows in order, emits once per row, and reserves taskIds", () => {
  const ids = ["0a0a0a0a", "0a0a0a0a"];
  let spare = 0;
  const nextTaskId = (): string => {
    const candidate = ids.shift();
    if (candidate !== undefined) return candidate;
    spare++;
    return `e0e0e${spare.toString(16).padStart(2, "0")}`;
  };
  const registry = new TaskRegistry(() => undefined, nextTaskId);
  const a = restoredRow("interrupted", "0a0a0a0a", "c1", "a");
  const b = restoredRow("completed", "0b0b0b0b", "c2", "b");
  let changes = 0;
  registry.subscribe(() => changes++);
  registry.rebuild([a, b]);
  assert.deepEqual(registry.list(), [a, b]);
  assert.equal(registry.get("0a0a0a0a"), a);
  assert.equal(changes, 2);

  // A rebuilt id is reserved: the fake source offers it twice, and register skips both.
  const fresh = bg(registry, "fresh");
  const ids2 = registry.list().map((row) => row.taskId);
  assert.equal(new Set(ids2).size, ids2.length);
  assert.notEqual(fresh.taskId, "0a0a0a0a");
  assert.equal(registry.get("0a0a0a0a"), a);
});

test("rebuild sends exactly one interrupted notification for every interrupted row", () => {
  const notify: string[] = [];
  const registry = reg(notify);
  const one = restoredRow("interrupted", "10101010", "c1", "one\ntwo");
  const two = restoredRow("interrupted", "20202020", "c2", "two");
  registry.rebuild([one, two]);
  assert.deepEqual(notify, [
    [INTERRUPTED_HEADER, registry.listLine(one), registry.listLine(two)].join("\n"),
  ]);
  assert.equal(one.consumed, false);
  assert.equal(two.consumed, false);
});

test("rebuild sends no completion notification for a fully settled cohort", () => {
  const notify: string[] = [];
  const registry = reg(notify);
  const first = restoredRow("failed", "30303030", "c", "first");
  const second = restoredRow("cancelled", "40404040", "c", "second\nline");
  registry.rebuild([first, second]);
  assert.deepEqual(notify, []);
  assert.equal(first.consumed, false);
  assert.equal(second.consumed, false);
});

test("rebuild is a no-op on a registry that is not live", () => {
  const notify: string[] = [];
  const registry = reg(notify);
  registry.end();
  const row = restoredRow("interrupted", "50505050", "c");
  let changes = 0;
  registry.subscribe(() => changes++);
  registry.rebuild([row]);
  assert.deepEqual(registry.list(), []);
  assert.equal(changes, 0);
  assert.deepEqual(notify, []);
});
