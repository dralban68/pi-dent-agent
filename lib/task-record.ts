import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorCode, errorMessage } from "./util.ts";

/**
 * Task record per specs/task-record.md: the small JSON file a session writes
 * beside a background `Agent` task's session file so the task can be rebuilt
 * and resumed after its process ends or reloads. A record never carries the
 * task text or the settled result text.
 */

export type TaskRecordStatus = "running" | "completed" | "failed" | "cancelled";

/** The record fields of task-record.md Section 1, and nothing else. */
export interface TaskRecord {
  taskId: string;
  agent: string;
  label: string;
  model?: string | undefined;
  cohort: string;
  startedAt: number;
  sessionPath: string;
  status: TaskRecordStatus;
  settledAt?: number | undefined;
  resultPath?: string | undefined;
}

/** `<taskId>.task.json` (task-record.md Section 1). */
export function recordFileName(taskId: string): string {
  return `${taskId}.task.json`;
}

/**
 * Write `text` to `path` through a temporary file in the same directory and a
 * rename, so a crashed write never leaves a truncated record at `path`. The
 * temporary name cannot match the `scanRecords` pattern.
 */
function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // A temporary file left after a failed write is not worth a second failure.
    }
    throw error;
  }
}

/** Write a `running` record; returns the absolute path of the file written. */
export function writeRunningRecord(
  dir: string,
  fields: {
    taskId: string;
    agent: string;
    label: string;
    model?: string | undefined;
    cohort: string;
    startedAt: number;
    sessionPath: string;
  },
): string {
  const record: TaskRecord = {
    taskId: fields.taskId,
    agent: fields.agent,
    label: fields.label,
    cohort: fields.cohort,
    startedAt: fields.startedAt,
    sessionPath: fields.sessionPath,
    status: "running",
  };
  if (fields.model !== undefined) record.model = fields.model;
  const path = join(dir, recordFileName(fields.taskId));
  writeAtomic(path, JSON.stringify(record));
  return path;
}

/** Rewrite an existing record with the terminal status and new fields. */
export function rewriteSettledRecord(
  recordPath: string,
  fields: {
    status: "completed" | "failed" | "cancelled";
    settledAt: number;
    resultPath?: string | undefined;
  },
): void {
  const record = readRecord(recordPath);
  if (record === undefined) return;
  record.status = fields.status;
  record.settledAt = fields.settledAt;
  if (fields.resultPath !== undefined) record.resultPath = fields.resultPath;
  writeAtomic(recordPath, JSON.stringify(record));
}

/** Unlink the record file; a missing file is ignored. */
export function deleteRecord(recordPath: string): void {
  try {
    unlinkSync(recordPath);
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error)) throw error;
    const err: { code?: unknown } = error;
    if (err.code !== "ENOENT") throw error;
  }
}

/** Parse and validate one record file; undefined on any invalid input. */
export function readRecord(path: string): TaskRecord | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const record = value;

  const taskId = record.taskId;
  if (typeof taskId !== "string") return undefined;
  if (taskId !== stemOf(path)) return undefined;

  if (typeof record.agent !== "string") return undefined;
  if (typeof record.label !== "string") return undefined;
  if (typeof record.cohort !== "string") return undefined;
  if (typeof record.sessionPath !== "string") return undefined;
  if (!isFiniteNumber(record.startedAt)) return undefined;

  const status = record.status;
  if (
    status !== "running" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled"
  )
    return undefined;

  if (record.model !== undefined && typeof record.model !== "string") return undefined;
  if (record.settledAt !== undefined && !isFiniteNumber(record.settledAt)) return undefined;
  // A settled record carries its settlement time (Section 3).
  if (status !== "running" && record.settledAt === undefined) return undefined;
  if (record.resultPath !== undefined && typeof record.resultPath !== "string") return undefined;

  const parsed: TaskRecord = {
    taskId,
    agent: record.agent,
    label: record.label,
    cohort: record.cohort,
    startedAt: record.startedAt,
    sessionPath: record.sessionPath,
    status,
  };
  if (record.model !== undefined) parsed.model = record.model;
  if (record.settledAt !== undefined) parsed.settledAt = record.settledAt;
  if (record.resultPath !== undefined) parsed.resultPath = record.resultPath;
  return parsed;
}

/**
 * Valid records in the directory, ascending by taskId; never throws. A directory that
 * cannot be read yields no record and is reported through `report` (Section 3); an
 * absent one is not a failure.
 */
export function scanRecords(dir: string, report?: (message: string) => void): TaskRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      report?.(`pi-dent: cannot read the task record directory ${dir}: ${errorMessage(error)}`);
    }
    return [];
  }
  const records: TaskRecord[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{8}\.task\.json$/.test(name)) continue;
    const record = readRecord(join(dir, name));
    if (record !== undefined) records.push(record);
  }
  records.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  return records;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `<taskId>` stem of a `<taskId>.task.json` file name. */
function stemOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.task\.json$/, "");
}
