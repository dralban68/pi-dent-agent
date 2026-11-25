import { join } from "node:path";

/**
 * Point the task ledger (specs/task-ledger.md Section 1) into `dir`, so a test that starts the
 * extension never opens the real one; returns the function that restores the variable.
 */
export function isolateTaskLedger(dir: string): () => void {
  const previous = process.env.PI_DENT_TASKS_DB;
  process.env.PI_DENT_TASKS_DB = join(dir, "tasks-v1.sqlite");
  return () => {
    if (previous === undefined) delete process.env.PI_DENT_TASKS_DB;
    else process.env.PI_DENT_TASKS_DB = previous;
  };
}
