import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * The `cwd` parameter of `Agent`, `Script`, and `Bash` (specs/task.md#cwd-parameter):
 * a blank value is absent, a relative one resolves against the invoking session's
 * working directory, and a present one must name an existing directory.
 * `cwd` is undefined when the parameter is absent: the default is the caller's.
 */
export function resolveCwdParam(
  value: string | undefined,
  sessionCwd: string,
): { cwd: string | undefined } | { error: string } {
  if (value === undefined || value.trim() === "") return { cwd: undefined };
  const cwd = isAbsolute(value) ? value : resolve(sessionCwd, value);
  let ok = false;
  try {
    ok = statSync(cwd).isDirectory();
  } catch {
    // Missing or unreadable: not an existing directory.
  }
  return ok ? { cwd } : { error: `cwd is not an existing directory: ${cwd}` };
}
