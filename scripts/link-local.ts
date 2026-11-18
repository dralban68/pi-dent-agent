// Puts the local links of .local-links in place (specs/package.md, Section 5.2). Runs as the
// `prepare` script, so after every `pnpm install` that changed something.
// Usage: node scripts/link-local.ts
import { resolve } from "node:path";
import { applyLocalLinks } from "../lib/local-links.ts";
import { errorMessage } from "../lib/util.ts";

try {
  for (const line of applyLocalLinks(resolve(import.meta.dirname, ".."))) {
    process.stdout.write(`${line}\n`);
  }
} catch (error) {
  process.stderr.write(`link-local: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
