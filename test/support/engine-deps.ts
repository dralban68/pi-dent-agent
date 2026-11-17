import type { EngineDeps } from "../../lib/engine.ts";

/**
 * The engine dependencies a test hands the engine (bash-tool.md Section 3): a Bash settings
 * reader that reads no file, overridden per test where the read itself matters.
 */
export function engineDeps(overrides: Partial<EngineDeps> = {}): EngineDeps {
  return { bashSettings: () => ({}), ...overrides };
}
