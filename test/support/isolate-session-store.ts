import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Imported for its effect: points the local session store (specs/session-store.md Section 1)
 * of this test file's process at a fresh temporary file, so a test that starts the extension
 * never opens the real store, whatever `PI_DENT_FLEET_DB` the environment carries.
 */
const dir = mkdtempSync(join(tmpdir(), "pi-dent-test-store-"));
process.env.PI_DENT_FLEET_DB = join(dir, "fleet-v2.sqlite");
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
