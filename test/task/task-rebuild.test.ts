import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRegistry, AgentTaskRow } from "../../lib/registry.ts";
import { rewriteSettledRecord, writeRunningRecord } from "../../lib/task-record.ts";
import { rebuildInterruptedTasks } from "../../lib/task-rebuild.ts";
import type { HostSession } from "../../lib/host.ts";
import { at } from "../support/must.ts";

/** Rebuild per specs/task-record.md#rebuild and specs/task-registry.md#cohorts. */

function hostRecording(notify: string[]): HostSession {
  return {
    notify: (message: string) => {
      notify.push(message);
    },
  } as unknown as HostSession;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "task-rebuild-"));
}

type RunningFields = {
  taskId: string;
  agent: string;
  label: string;
  model?: string | undefined;
  cohort: string;
  startedAt: number;
  sessionPath: string;
};

function runningFields(taskId = "01234567"): RunningFields {
  return {
    taskId,
    agent: "agent-a",
    label: "a label",
    model: "p/m",
    cohort: "cohort-1",
    startedAt: 1000,
    sessionPath: "/abs/session.jsonl",
  };
}

test("a running record becomes an interrupted row settled at rebuild time", () => {
  const dir = tempDir();
  const path = writeRunningRecord(dir, runningFields());
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify));
  const now = 5000;
  const count = rebuildInterruptedTasks(registry, dir, now);
  assert.equal(count, 1);
  const rows = registry.list();
  assert.equal(rows.length, 1);
  const row = at(rows, 0);
  assert.ok(row instanceof AgentTaskRow);
  assert.equal(row.taskId, "01234567");
  assert.equal(row.status, "interrupted");
  assert.equal(row.settledAt, now);
  assert.equal(row.resultPath, undefined);
  assert.equal(row.background, true);
  assert.equal(row.agent, "agent-a");
  assert.equal(row.model, "p/m");
  assert.equal(row.sessionPath, "/abs/session.jsonl");
  assert.equal(row.startedAt, 1000);
  assert.equal(row.cohort, "cohort-1");
  assert.equal(row.label, "a label");
  assert.equal(row.recordPath, path);
  rmSync(dir, { recursive: true, force: true });
});

test("a terminal record keeps its status, settledAt, and resultPath", () => {
  const dir = tempDir();
  const path = writeRunningRecord(dir, runningFields());
  rewriteSettledRecord(path, {
    status: "completed",
    settledAt: 2000,
    resultPath: "/abs/result.txt",
  });
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify));
  const count = rebuildInterruptedTasks(registry, dir, 5000);
  assert.equal(count, 1);
  const row = at(registry.list(), 0);
  assert.equal(row.status, "completed");
  assert.equal(row.settledAt, 2000);
  assert.equal(row.resultPath, "/abs/result.txt");
  assert.equal(row.background, true);
  // A rebuild that inserted no `interrupted` row sends no interrupted
  // notification (specs/task-registry.md#cohorts).
  assert.deepEqual(notify, []);
  rmSync(dir, { recursive: true, force: true });
});

test("rebuilt taskIds are reserved, so a fresh register never reissues one (Section 2)", () => {
  const dir = tempDir();
  writeRunningRecord(dir, runningFields("01234567"));
  // A fake taskId source that offers a rebuilt row's id twice before a free one
  // (dev:testing: randomness is replaced by a fake).
  const candidates = ["01234567", "01234567"];
  let spare = 0;
  const nextTaskId = (): string => {
    const candidate = candidates.shift();
    if (candidate !== undefined) return candidate;
    spare++;
    return `f0f0f${spare.toString(16).padStart(2, "0")}`;
  };
  const registry = new TaskRegistry(() => undefined, nextTaskId);
  rebuildInterruptedTasks(registry, dir, 5000);
  const fresh = registry.register({
    kind: "script",
    cohort: "c",
    label: "fresh",
    background: true,
  });
  assert.notEqual(fresh.taskId, "01234567", "the rebuilt id is never reissued");
  assert.equal(registry.get("01234567")?.status, "interrupted");
  assert.equal(registry.get(fresh.taskId), fresh);
  rmSync(dir, { recursive: true, force: true });
});

test("the interrupted notification header and list lines are delivered once", () => {
  const dir = tempDir();
  writeRunningRecord(dir, runningFields("01234567"));
  writeRunningRecord(dir, runningFields("89abcdef"));
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify));
  rebuildInterruptedTasks(registry, dir, 5000);
  assert.equal(notify.length, 1);
  const lines = at(notify, 0).split("\n");
  assert.equal(lines[0], "Interrupted tasks (resume with Agent resume=<taskId>):");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], "01234567 · interrupted · a label");
  assert.equal(lines[2], "89abcdef · interrupted · a label");
  // The interrupted notification must not consume the rows.
  assert.equal(registry.get("01234567")?.consumed, false);
  rmSync(dir, { recursive: true, force: true });
});

test("a second rebuild skips records already rebuilt and sends no second notification", () => {
  const dir = tempDir();
  writeRunningRecord(dir, runningFields("01234567"));
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify));
  assert.equal(rebuildInterruptedTasks(registry, dir, 5000), 1);
  const first = at(registry.list(), 0);
  assert.equal(rebuildInterruptedTasks(registry, dir, 6000), 0);
  assert.equal(registry.list().length, 1);
  assert.equal(at(registry.list(), 0), first);
  assert.equal(notify.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("a record in a child session's agent directory is not read (specs/task-record.md#rebuild)", () => {
  const dir = tempDir();
  writeRunningRecord(dir, runningFields("01234567"));
  // A nested agent directory, as a child session's own would be: only the directory the
  // rebuild is given is scanned.
  const child = join(dir, "child.agents");
  mkdirSync(child);
  writeRunningRecord(child, runningFields("89abcdef"));
  const registry = new TaskRegistry(() => undefined);
  assert.equal(rebuildInterruptedTasks(registry, dir, 5000), 1);
  assert.deepEqual(
    registry.list().map((row) => row.taskId),
    ["01234567"],
  );
  assert.equal(registry.get("89abcdef"), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("0 rows for an empty directory", () => {
  const dir = tempDir();
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify));
  const count = rebuildInterruptedTasks(registry, dir, 5000);
  assert.equal(count, 0);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(notify, []);
  rmSync(dir, { recursive: true, force: true });
});

test("0 rows for a missing directory", () => {
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify));
  const count = rebuildInterruptedTasks(
    registry,
    join(tmpdir(), "does-not-exist-" + Date.now()),
    5000,
  );
  assert.equal(count, 0);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(notify, []);
});

test("a rebuild whose agent directory cannot be read reports it once and inserts no row", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("the root user reads through file modes, so the unreadable case cannot be produced");
    return;
  }
  const dir = tempDir();
  writeRunningRecord(dir, runningFields("01234567"));
  const notify: string[] = [];
  const registry = new TaskRegistry(() => hostRecording(notify));
  const reports: string[] = [];
  try {
    chmodSync(dir, 0o000);
    assert.equal(
      rebuildInterruptedTasks(registry, dir, 5000, (message) => reports.push(message)),
      0,
    );
    assert.deepEqual(registry.list(), [], "the unreadable directory inserts no row");
    assert.equal(reports.length, 1, JSON.stringify(reports));
    assert.ok(
      at(reports, 0).startsWith(`pi-dent: cannot read the task record directory ${dir}: `),
      at(reports, 0),
    );
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing agent directory reports nothing (specs/task-record.md#rebuild)", () => {
  const registry = new TaskRegistry(() => undefined);
  const reports: string[] = [];
  const count = rebuildInterruptedTasks(
    registry,
    join(tmpdir(), "does-not-exist-" + Date.now()),
    5000,
    (message) => reports.push(message),
  );
  assert.equal(count, 0);
  assert.deepEqual(reports, []);
});
