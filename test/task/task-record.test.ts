import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteRecord,
  readRecord,
  recordFileName,
  rewriteSettledRecord,
  scanRecords,
  writeRunningRecord,
} from "../../lib/task-record.ts";

/** Task record conformance per specs/task-record.md#format, specs/task-record.md#lifecycle, specs/task-record.md#rebuild. */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "task-record-"));
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

test("recordFileName returns <taskId>.task.json", () => {
  assert.equal(recordFileName("01234567"), "01234567.task.json");
});

test("write+read roundtrip of every field", () => {
  const dir = tempDir();
  const path = writeRunningRecord(dir, runningFields());
  assert.equal(path, join(dir, "01234567.task.json"));
  const record = readRecord(path);
  assert.deepEqual(record, {
    taskId: "01234567",
    agent: "agent-a",
    label: "a label",
    model: "p/m",
    cohort: "cohort-1",
    startedAt: 1000,
    sessionPath: "/abs/session.jsonl",
    status: "running",
  });
  rmSync(dir, { recursive: true, force: true });
});

test("writeRunningRecord omits model when absent", () => {
  const dir = tempDir();
  const fields = runningFields();
  delete fields.model;
  const path = writeRunningRecord(dir, fields);
  const record = readRecord(path);
  assert.equal(record?.model, undefined);
  assert.ok(!("model" in JSON.parse(readFileSync(path, "utf8"))));
  rmSync(dir, { recursive: true, force: true });
});

test("rewrite settles status and preserves the other fields", () => {
  const dir = tempDir();
  const path = writeRunningRecord(dir, runningFields());
  rewriteSettledRecord(path, {
    status: "completed",
    settledAt: 2000,
    resultPath: "/abs/result.txt",
  });
  const record = readRecord(path);
  assert.deepEqual(record, {
    taskId: "01234567",
    agent: "agent-a",
    label: "a label",
    model: "p/m",
    cohort: "cohort-1",
    startedAt: 1000,
    sessionPath: "/abs/session.jsonl",
    status: "completed",
    settledAt: 2000,
    resultPath: "/abs/result.txt",
  });
  rmSync(dir, { recursive: true, force: true });
});

test("rewrite without resultPath leaves it absent", () => {
  const dir = tempDir();
  const path = writeRunningRecord(dir, runningFields());
  rewriteSettledRecord(path, { status: "failed", settledAt: 2000 });
  const record = readRecord(path);
  assert.equal(record?.status, "failed");
  assert.equal(record?.settledAt, 2000);
  assert.equal(record?.resultPath, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("delete removes the file and a second delete is fine", () => {
  const dir = tempDir();
  const path = writeRunningRecord(dir, runningFields());
  assert.ok(readRecord(path) !== undefined);
  deleteRecord(path);
  assert.equal(readRecord(path), undefined);
  assert.doesNotThrow(() => deleteRecord(path));
  rmSync(dir, { recursive: true, force: true });
});

test("the written JSON contains only the declared record fields", () => {
  const dir = tempDir();
  const path = writeRunningRecord(dir, runningFields());
  const keys = Object.keys(JSON.parse(readFileSync(path, "utf8"))).toSorted();
  assert.deepEqual(keys, [
    "agent",
    "cohort",
    "label",
    "model",
    "sessionPath",
    "startedAt",
    "status",
    "taskId",
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("scan returns valid records in ascending taskId order", () => {
  const dir = tempDir();
  const ids = ["abcdef01", "12345678", "89abcdef", "deadbeef"];
  for (const id of ids) writeRunningRecord(dir, runningFields(id));
  const records = scanRecords(dir);
  assert.deepEqual(
    records.map((r) => r.taskId),
    [...ids].toSorted(),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("scan skips invalid and non-matching files", () => {
  const dir = tempDir();
  writeRunningRecord(dir, runningFields("01234567"));

  // Bad JSON.
  writeFileSync(join(dir, "11111111.task.json"), "{ not json");
  // Wrong taskId (does not equal the filename stem).
  writeFileSync(join(dir, "22222222.task.json"), JSON.stringify(runningFields("99999999")));
  // Missing required field.
  const missing = runningFields("33333333") as Record<string, unknown>;
  delete missing.agent;
  writeFileSync(join(dir, "33333333.task.json"), JSON.stringify(missing));
  // Wrong type.
  const wrongType = runningFields("44444444") as Record<string, unknown>;
  wrongType.startedAt = "1000";
  writeFileSync(join(dir, "44444444.task.json"), JSON.stringify(wrongType));
  // Unknown status.
  const badStatus = runningFields("55555555") as Record<string, unknown>;
  badStatus.status = "paused";
  writeFileSync(join(dir, "55555555.task.json"), JSON.stringify(badStatus));
  // Non-matching file name.
  writeFileSync(join(dir, "not-a-record.txt"), JSON.stringify(runningFields("66666666")));
  // Non-hex taskId in the file name.
  writeFileSync(join(dir, "zzzzzzzz.task.json"), JSON.stringify(runningFields("zzzzzzzz")));

  const records = scanRecords(dir);
  assert.deepEqual(
    records.map((r) => r.taskId),
    ["01234567"],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("scan of a missing directory returns []", () => {
  assert.deepEqual(scanRecords(join(tmpdir(), "does-not-exist-" + Date.now())), []);
});

test("readRecord returns undefined for a missing file", () => {
  assert.equal(readRecord(join(tmpdir(), "missing.task.json")), undefined);
});

test("readRecord rejects a non-object JSON value", () => {
  const dir = tempDir();
  const path = join(dir, "01234567.task.json");
  writeFileSync(path, "[1,2,3]");
  assert.equal(readRecord(path), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("readRecord rejects a non-finite number", () => {
  const dir = tempDir();
  const path = join(dir, "01234567.task.json");
  const bad = runningFields() as Record<string, unknown>;
  bad.startedAt = Number.NaN;
  writeFileSync(path, JSON.stringify(bad));
  assert.equal(readRecord(path), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("readRecord rejects a wrong-typed optional field", () => {
  const dir = tempDir();
  const path = join(dir, "01234567.task.json");
  const bad = runningFields() as Record<string, unknown>;
  bad.model = 42;
  writeFileSync(path, JSON.stringify(bad));
  assert.equal(readRecord(path), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("readRecord accepts a record without optional fields", () => {
  const dir = tempDir();
  const path = join(dir, "01234567.task.json");
  const fields = runningFields();
  delete fields.model;
  writeFileSync(path, JSON.stringify({ ...fields, status: "running" }));
  const record = readRecord(path);
  assert.equal(record?.status, "running");
  assert.equal(record?.model, undefined);
  assert.equal(record?.settledAt, undefined);
  assert.equal(record?.resultPath, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("scan reads records in a nested directory", () => {
  const dir = tempDir();
  const nested = join(dir, "agent");
  mkdirSync(nested);
  writeRunningRecord(nested, runningFields("01234567"));
  assert.deepEqual(
    scanRecords(nested).map((r) => r.taskId),
    ["01234567"],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("write and rewrite leave no temporary file behind and the record reads back", () => {
  const dir = tempDir();
  const path = writeRunningRecord(dir, runningFields());
  assert.deepEqual(readdirSync(dir), ["01234567.task.json"]);
  assert.equal(readRecord(path)?.status, "running");
  rewriteSettledRecord(path, { status: "completed", settledAt: 2000 });
  assert.deepEqual(readdirSync(dir), ["01234567.task.json"]);
  assert.equal(readRecord(path)?.status, "completed");
  assert.equal(readRecord(path)?.settledAt, 2000);
  rmSync(dir, { recursive: true, force: true });
});

test("a failed write leaves no temporary file behind", () => {
  const dir = tempDir();
  // A directory at the record path makes the rename fail after the temporary file exists.
  mkdirSync(join(dir, "01234567.task.json"));
  assert.throws(() => writeRunningRecord(dir, runningFields()));
  assert.deepEqual(readdirSync(dir), ["01234567.task.json"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a settled record without settledAt is not a valid record (specs/task-record.md#rebuild)", () => {
  const dir = tempDir();
  const path = writeRunningRecord(dir, runningFields());
  const stored = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...stored, status: "completed" }));
  assert.equal(readRecord(path), undefined);
  writeFileSync(path, JSON.stringify({ ...stored, status: "completed", settledAt: 2000 }));
  assert.equal(readRecord(path)?.status, "completed");
  rmSync(dir, { recursive: true, force: true });
});
