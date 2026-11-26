import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** The variables that name the temporary folder (specs/bash-tool.md#execution-model). */
export const TEMP_VARIABLES = ["TMPDIR", "TMP", "TEMP"] as const;

/**
 * Points the temporary-folder variables of `env` at `<PI_DENT_SESSION_DIR>/tmp` (specs/bash-tool.md#execution-model): creates the folder, or on failure leaves those variables absent. A variable the
 * caller-supplied environment `caller` names keeps its value. Does nothing without a session dir.
 */
export function applySessionTmp(
  env: NodeJS.ProcessEnv,
  caller: Record<string, string> | undefined,
): void {
  const dir = env.PI_DENT_SESSION_DIR;
  if (dir === undefined || dir === "") return;
  const names = TEMP_VARIABLES.filter((name) => caller === undefined || !(name in caller));
  if (names.length === 0) return;
  const tmp = join(dir, "tmp");
  try {
    mkdirSync(tmp, { recursive: true });
    for (const name of names) env[name] = tmp;
  } catch {
    for (const name of names) delete env[name];
  }
}
