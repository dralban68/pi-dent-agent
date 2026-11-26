import { join } from "node:path";
import type { TaskRegistry } from "./registry.ts";
import type { TaskLedger } from "./task-ledger.ts";
import { AgentTaskRow } from "./task-row.ts";
import { recordFileName, scanRecords } from "./task-record.ts";

/**
 * Rebuild interrupted tasks per specs/task-record.md#rebuild: scan the main
 * session's agent directory for task records and insert one task row per
 * record into the live registry. A `running` record becomes an `interrupted`
 * row settled at rebuild time; a terminal record keeps its own status,
 * `settledAt`, and `resultPath`. Records are never consumed or deleted.
 */

/**
 * Scan `agentsDir` with `scanRecords`, map each record to an `AgentTaskRow`
 * (background true), pass them to `registry.rebuild(rows)`, and return the
 * number of rows inserted (0 when `scanRecords` returns `[]`, without calling
 * `rebuild`). A record whose taskId is already a row of the registry is skipped
 * by `rebuild` and not counted. With `ledger`, each inserted row is linked to the ledger row
 * specs/task-ledger.md#rebuild finds, which an `interrupted` row makes `interrupted`.
 */
export function rebuildInterruptedTasks(
  registry: TaskRegistry,
  agentsDir: string,
  now?: number,
  report?: (message: string) => void,
  ledger?: { ledger: TaskLedger; sessionId: string },
): number {
  const records = scanRecords(agentsDir, report);
  if (records.length === 0) return 0;
  const rows = records.map((record) => {
    const row = new AgentTaskRow({
      taskId: record.taskId,
      cohort: record.cohort,
      label: record.label,
      background: true,
      startedAt: record.startedAt,
    });
    row.agent = record.agent;
    row.model = record.model;
    row.sessionPath = record.sessionPath;
    row.recordPath = join(agentsDir, recordFileName(record.taskId));
    if (record.status === "running") {
      row.status = "interrupted";
      row.settledAt = now ?? Date.now();
    } else {
      row.status = record.status;
      row.settledAt = record.settledAt;
      row.resultPath = record.resultPath;
    }
    return row;
  });
  const inserted = registry.rebuild(rows);
  if (ledger !== undefined) {
    for (const row of inserted) {
      const key = { sessionId: ledger.sessionId, taskId: row.taskId, startedAt: row.startedAt };
      ledger.ledger.rebuildTask({ ...key, status: row.status });
      row.ledger = {
        ledger: ledger.ledger,
        ref: key,
        written: {
          label: row.label,
          agent: row.agent,
          model: row.model,
          sessionPath: row.sessionPath,
        },
      };
    }
  }
  return inserted.length;
}
