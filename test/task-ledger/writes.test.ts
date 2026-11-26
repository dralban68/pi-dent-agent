import assert from "node:assert/strict";
import { test } from "node:test";
import { processStartedMs } from "../../lib/task-ledger.ts";
import { inserted, openLedger, raw, sessionRow, taskRow, usage } from "./support.ts";

/** specs/task-ledger.md#writes and specs/task-ledger.md#rebuild: the writes of a ledger row and a ledger session row. */

function clock(start = 5000) {
  const state = { now: start };
  return { state, now: () => state.now };
}

test("register inserts a running, undispatched row with the task row's columns", async () => {
  const { state, now } = clock();
  const { ledger, path } = openLedger({ now });
  const parent = inserted(ledger);
  state.now = 6000;
  const rowId = inserted(ledger, {
    sessionId: "session-b",
    taskId: "0badf00d",
    parentRowId: parent,
    fleetQuery: true,
    kind: "agent",
    background: true,
    cwd: "/invoker",
    agent: "reviewer",
    label: "line one\nline two",
    model: "anthropic/claude:high",
    startedAt: 5900,
    sessionPath: "/s/child.jsonl",
    toolCalls: 0,
  });
  await ledger.flushed();
  assert.match(rowId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(taskRow(path, rowId), {
    row_id: rowId,
    session_id: "session-b",
    task_id: "0badf00d",
    parent_id: parent,
    resumes_id: null,
    fleet_query: 1,
    kind: "agent",
    background: 1,
    cwd: "/invoker",
    agent: "reviewer",
    label: "line one\nline two",
    model: "anthropic/claude:high",
    status: "running",
    dispatched: 0,
    started_at: 5900,
    settled_at: null,
    updated_at: 6000,
    owner_pid: process.pid,
    owner_started: processStartedMs(),
    session_path: "/s/child.jsonl",
    result_path: null,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    cost: 0,
    turns: 0,
    tool_calls: 0,
  });
  ledger.close();
});

test("a script row starts with its tool-call count; a bash row's is null whatever it is given", async () => {
  const { ledger, path } = openLedger();
  const script = inserted(ledger, { kind: "script", toolCalls: 0 });
  const bash = inserted(ledger, { kind: "bash", toolCalls: 3 });
  await ledger.flushed();
  assert.equal(taskRow(path, script).tool_calls, 0);
  assert.equal(taskRow(path, bash).tool_calls, null);
  ledger.close();
});

test("a nested call's write sets a script row's tool_calls and updated_at whatever the status", async () => {
  const { state, now } = clock();
  const { ledger, path } = openLedger({ now });
  const rowId = inserted(ledger, { kind: "script", toolCalls: 0 });
  ledger.settleTask(rowId, { status: "completed", settledAt: 5500 });
  state.now = 6000;
  ledger.setTaskToolCalls(rowId, 2);
  await ledger.flushed();
  const row = taskRow(path, rowId);
  assert.deepEqual([row.tool_calls, row.updated_at, row.status], [2, 6000, "completed"]);
  ledger.close();
});

test("a script or bash row has null usage columns and no agent or model", async () => {
  const { ledger, path } = openLedger();
  for (const kind of ["script", "bash"] as const) {
    const row = taskRow(path, await insertAndFlush(kind));
    assert.deepEqual(
      [
        row.agent,
        row.model,
        row.input,
        row.output,
        row.cache_read,
        row.cache_write,
        row.cost,
        row.turns,
      ],
      [null, null, null, null, null, null, null, null],
    );
  }
  ledger.close();

  async function insertAndFlush(kind: "script" | "bash"): Promise<string> {
    const rowId = inserted(ledger, { kind });
    await ledger.flushed();
    return rowId;
  }
});

test("amend sets label, agent, model and session_path and updated_at", async () => {
  const { state, now } = clock();
  const { ledger, path } = openLedger({ now });
  const rowId = inserted(ledger, { agent: "old", model: "m/old" });
  state.now = 7000;
  ledger.amendTask(rowId, { label: "new label", agent: "new", sessionPath: "/s/a.jsonl" });
  await ledger.flushed();
  const row = taskRow(path, rowId);
  assert.deepEqual(
    [row.label, row.agent, row.model, row.session_path, row.updated_at],
    ["new label", "new", null, "/s/a.jsonl", 7000],
  );
  ledger.close();
});

test("passing the pre-start checks sets dispatched and the working directory the task runs in", async () => {
  const { ledger, path } = openLedger();
  const rowId = inserted(ledger, { cwd: "/invoker" });
  ledger.markDispatched(rowId, { cwd: "/plan" });
  await ledger.flushed();
  const row = taskRow(path, rowId);
  assert.deepEqual([row.dispatched, row.cwd, row.resumes_id], [1, "/plan", null]);
  ledger.close();
});

test("a resume by task ID records the resolved row, or null when it has none", async () => {
  const { ledger, path } = openLedger();
  const original = inserted(ledger);
  const resume = inserted(ledger, { taskId: "22222222" });
  ledger.markDispatched(resume, { cwd: "/w", resume: { by: "task", row: original } });
  const orphan = inserted(ledger, { taskId: "33333333" });
  ledger.markDispatched(orphan, { cwd: "/w", resume: { by: "task", row: undefined } });
  // A rebuilt row is named by the key specs/task-ledger.md#rebuild finds its ledger row by.
  const rebuilt = inserted(ledger, { taskId: "44444444", startedAt: 77 });
  const byKey = inserted(ledger, { taskId: "55555555" });
  const key = { sessionId: "session-a", taskId: "44444444", startedAt: 77 };
  ledger.markDispatched(byKey, { cwd: "/w", resume: { by: "task", row: key } });
  const unknown = inserted(ledger, { taskId: "66666666" });
  ledger.markDispatched(unknown, {
    cwd: "/w",
    resume: { by: "task", row: { ...key, startedAt: 78 } },
  });
  await ledger.flushed();
  assert.equal(taskRow(path, resume).resumes_id, original);
  assert.equal(taskRow(path, orphan).resumes_id, null);
  assert.equal(taskRow(path, byKey).resumes_id, rebuilt);
  assert.equal(taskRow(path, unknown).resumes_id, null);
  ledger.close();
});

test("a resume by path records the other row with the latest started_at and the same session_path text", async () => {
  const { ledger, path } = openLedger();
  const file = "/s/child.jsonl";
  const older = inserted(ledger, { startedAt: 100, sessionPath: file });
  const latest = inserted(ledger, { startedAt: 300, sessionPath: file });
  inserted(ledger, { startedAt: 400, sessionPath: "/s/./child.jsonl" });
  const resume = inserted(ledger, { startedAt: 200, sessionPath: file });
  ledger.markDispatched(resume, { cwd: "/w", resume: { by: "path" } });
  const lonely = inserted(ledger, { startedAt: 500, sessionPath: "/s/none.jsonl" });
  ledger.markDispatched(lonely, { cwd: "/w", resume: { by: "path" } });
  // Before its session_path is set, the path the row's session_path takes is matched.
  const early = inserted(ledger, { startedAt: 600 });
  ledger.markDispatched(early, { cwd: "/w", resume: { by: "path", sessionPath: file } });
  await ledger.flushed();
  assert.equal(taskRow(path, early).resumes_id, latest);
  assert.equal(taskRow(path, resume).resumes_id, latest);
  assert.notEqual(taskRow(path, resume).resumes_id, older);
  assert.equal(taskRow(path, lonely).resumes_id, null);
  ledger.close();
});

test("a usage write sets the six usage columns and tool_calls whatever the status", async () => {
  const { ledger, path } = openLedger();
  const rowId = inserted(ledger);
  ledger.settleTask(rowId, { status: "completed", settledAt: 2000 });
  ledger.setTaskUsage(rowId, usage(10, 20, 0.5, 3, 4, 5), 7);
  await ledger.flushed();
  const row = taskRow(path, rowId);
  assert.deepEqual(
    [
      row.input,
      row.output,
      row.cache_read,
      row.cache_write,
      row.cost,
      row.turns,
      row.tool_calls,
      row.status,
    ],
    [10, 20, 4, 5, 0.5, 3, 7, "completed"],
  );
  ledger.close();
});

test("settle sets status, settled_at and result_path of a running row, once", async () => {
  const { ledger, path } = openLedger();
  const rowId = inserted(ledger);
  ledger.settleTask(rowId, { status: "failed", settledAt: 2000, resultPath: "/r/out.md" });
  ledger.settleTask(rowId, { status: "completed", settledAt: 3000 });
  await ledger.flushed();
  const row = taskRow(path, rowId);
  assert.deepEqual([row.status, row.settled_at, row.result_path], ["failed", 2000, "/r/out.md"]);
  ledger.close();
});

test("settle does not overwrite a row already made interrupted", async () => {
  const { ledger, path } = openLedger();
  const rowId = inserted(ledger);
  await ledger.flushed();
  const db = raw(path);
  db.prepare("UPDATE tasks SET status = 'interrupted', settled_at = 1500 WHERE row_id = ?").run(
    rowId,
  );
  db.close();
  ledger.settleTask(rowId, { status: "cancelled", settledAt: 2000, resultPath: "/r" });
  await ledger.flushed();
  const row = taskRow(path, rowId);
  assert.deepEqual([row.status, row.settled_at, row.result_path], ["interrupted", 1500, null]);
  ledger.close();
});

test("a rebuilt interrupted row makes its running or cancelled ledger row interrupted", async () => {
  const { state, now } = clock(1000);
  const { ledger, path } = openLedger({ now });
  const running = inserted(ledger, { taskId: "aaaaaaaa", startedAt: 100 });
  const cancelled = inserted(ledger, { taskId: "bbbbbbbb", startedAt: 200 });
  const completed = inserted(ledger, { taskId: "cccccccc", startedAt: 300 });
  const otherStart = inserted(ledger, { taskId: "dddddddd", startedAt: 400 });
  state.now = 1200;
  ledger.settleTask(cancelled, { status: "cancelled", settledAt: 1150 });
  ledger.settleTask(completed, { status: "completed", settledAt: 1160 });
  state.now = 1300;
  ledger.rebuildTask({
    sessionId: "session-a",
    taskId: "aaaaaaaa",
    startedAt: 100,
    status: "interrupted",
  });
  ledger.rebuildTask({
    sessionId: "session-a",
    taskId: "bbbbbbbb",
    startedAt: 200,
    status: "interrupted",
  });
  ledger.rebuildTask({
    sessionId: "session-a",
    taskId: "cccccccc",
    startedAt: 300,
    status: "interrupted",
  });
  ledger.rebuildTask({
    sessionId: "session-a",
    taskId: "dddddddd",
    startedAt: 999,
    status: "interrupted",
  });
  ledger.rebuildTask({
    sessionId: "session-a",
    taskId: "aaaaaaaa",
    startedAt: 100,
    status: "completed",
  });
  ledger.rebuildTask({
    sessionId: "other",
    taskId: "eeeeeeee",
    startedAt: 1,
    status: "interrupted",
  });
  await ledger.flushed();
  const columns = (rowId: string) => {
    const row = taskRow(path, rowId);
    return [row.status, row.settled_at, row.updated_at];
  };
  // settled_at from the old updated_at (or kept), then updated_at the time of the write.
  assert.deepEqual(columns(running), ["interrupted", 1000, 1300]);
  assert.deepEqual(columns(cancelled), ["interrupted", 1150, 1300]);
  assert.deepEqual(columns(completed), ["completed", 1160, 1200]);
  assert.deepEqual(columns(otherStart), ["running", null, 1000]);
  const db = raw(path);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get()?.n, 4);
  db.close();
  ledger.close();
});

test("the ledger session row is inserted once and updated after, keeping started_at", async () => {
  const { state, now } = clock(100);
  const { ledger, path } = openLedger({ now });
  ledger.writeSession({
    sessionId: "main",
    sessionFile: null,
    cwd: "/a",
    usage: usage(1, 2, 0.1, 1),
    toolCalls: 1,
  });
  state.now = 200;
  ledger.writeSession({
    sessionId: "main",
    sessionFile: "/s/main.jsonl",
    cwd: "/b",
    usage: usage(3, 4, 0.25, 2, 5, 6),
    toolCalls: 4,
  });
  await ledger.flushed();
  assert.deepEqual(sessionRow(path, "main"), {
    session_id: "main",
    session_file: "/s/main.jsonl",
    cwd: "/b",
    started_at: 100,
    updated_at: 200,
    input: 3,
    output: 4,
    cache_read: 5,
    cache_write: 6,
    cost: 0.25,
    turns: 2,
    tool_calls: 4,
  });
  ledger.close();
});
