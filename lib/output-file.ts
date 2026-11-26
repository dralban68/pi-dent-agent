import { mkdirSync, opendirSync, type Dir, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import type {
  ExtensionAPI,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { safeName } from "./util.ts";

/**
 * A task's output file (specs/script-tool.md#timeout-delivery, used by `Bash` too,
 * specs/bash-tool.md#output-capture): `<agentDir>/output/<safeTaskId>.log`, where
 * `<agentDir>` is the agent directory of the session that invoked the task
 * (specs/agent-tool.md#child-session). It lives inside that directory, so the
 * retention sweep deletes it with it (specs/agent-tool.md#retention-sweep), and nothing else removes it.
 */

/** Create `<agentDir>/output/`, and `<agentDir>` itself, when absent; never fails. */
export function ensureOutputDir(agentDir: string): void {
  try {
    mkdirSync(join(agentDir, "output"), { recursive: true });
  } catch {
    // A failure to create the directory never fails the call (specs/script-tool.md#timeout-delivery).
  }
}

/** The output file of `taskId` in `agentDir`. */
export function outputPathsFor(agentDir: string, taskId: string): { outputPath: string } {
  return { outputPath: join(agentDir, "output", `${safeName(taskId)}.log`) };
}

const OUTPUT_LOG_NAME = /^[A-Za-z0-9._-]+\.log$/;

/** Scan bounds of the read hint (specs/script-tool.md#timeout-delivery). */
const HINT_MAX_ENTRIES = 10000;
const HINT_MAX_DEPTH = 16;

interface HintScan {
  baseName: string;
  /** Directory entries read so far, against HINT_MAX_ENTRIES. */
  entries: number;
  found: string[];
}

/** The entries of `dir`, read one at a time; the directory is closed when iteration ends. */
function* readEntries(dir: string): Generator<Dirent> {
  let handle: Dir;
  try {
    handle = opendirSync(dir);
  } catch {
    return;
  }
  try {
    let entry = handle.readSync();
    while (entry !== null) {
      yield entry;
      entry = handle.readSync();
    }
  } catch {
    // A read error ends the directory's entries.
  } finally {
    try {
      handle.closeSync();
    } catch {
      // Already closed.
    }
  }
}

/** Count one directory entry read by the scan; `false` once the bound is passed. */
function countEntry(scan: HintScan): boolean {
  scan.entries++;
  return scan.entries <= HINT_MAX_ENTRIES;
}

/**
 * Scan a visited directory (the root, or an `.agents` folder) and the folders
 * below it. Returns `false` when a bound stops the scan, `true` otherwise.
 */
function scanDir(dir: string, depth: number, scan: HintScan): boolean {
  if (depth > HINT_MAX_DEPTH) return false;
  for (const entry of readEntries(dir)) {
    if (!countEntry(scan)) return false;
    if (scan.found.length > 1) return true;
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    let ok = true;
    if (entry.name === "output") ok = scanOutput(path, depth + 1, scan);
    else if (entry.name.endsWith(".agents")) ok = scanDir(path, depth + 1, scan);
    if (!ok) return false;
  }
  return true;
}

/** Collect the matching files directly inside an `output` folder; same result shape as scanDir. */
function scanOutput(dir: string, depth: number, scan: HintScan): boolean {
  if (depth > HINT_MAX_DEPTH) return false;
  for (const file of readEntries(dir)) {
    if (!countEntry(scan)) return false;
    if (file.name === scan.baseName && file.isFile()) scan.found.push(join(dir, file.name));
  }
  return true;
}

/**
 * The `read` error hint of specs/script-tool.md#timeout-delivery: the failed `read`
 * result with its `Did you mean <path>?` line, or `undefined` when it does not apply.
 * `root` is the session's search root; `undefined` means no hint.
 */
export function readErrorHint(
  event: ToolResultEvent,
  root: string | undefined,
): ToolResultEventResult | undefined {
  try {
    if (event.toolName !== "read" || !event.isError || !root) return undefined;
    const requested = event.input.path;
    if (typeof requested !== "string") return undefined;
    const baseName = basename(requested);
    if (!OUTPUT_LOG_NAME.test(baseName)) return undefined;
    const content = event.content;
    if (!content.some((part) => part.type === "text" && part.text.includes("ENOENT"))) {
      return undefined;
    }
    let last = -1;
    content.forEach((part, i) => {
      if (part.type === "text") last = i;
    });
    const part = content[last];
    if (part?.type !== "text") return undefined;
    const scan: HintScan = { baseName, entries: 0, found: [] };
    if (!scanDir(root, 0, scan)) return undefined;
    const match = scan.found.length === 1 ? scan.found[0] : undefined;
    if (match === undefined) return undefined;
    const hinted = { ...part, text: `${part.text}\nDid you mean ${match}?` };
    return { content: [...content.slice(0, last), hinted, ...content.slice(last + 1)] };
  } catch {
    return undefined;
  }
}

/**
 * Register the read hint on a session's `tool_result` events (specs/script-tool.md#timeout-delivery). `root` gives the session's search root at each event.
 */
export function registerReadErrorHint(
  pi: Pick<ExtensionAPI, "on">,
  root: () => string | undefined,
): void {
  pi.on("tool_result", async (event) => readErrorHint(event, root()));
}
