/**
 * The usage of a main session's ledger session row (specs/task-ledger.md Section 2.1), from the
 * session entries and header the host holds.
 */

import { zeroUsageSum, type UsageSum } from "./usage.ts";

/** A host `usage` (agent-tool.md Section 13). */
export interface LedgerEntryUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

/** The parts of a host session entry that Section 2.1 reads. */
export interface LedgerSessionEntry {
  type: string;
  timestamp?: string | undefined;
  usage?: LedgerEntryUsage | undefined;
  message?:
    | { role: string; toolName?: string | undefined; usage?: LedgerEntryUsage | undefined }
    | undefined;
}

/** The parts of the host session header that Section 2.1 reads. */
export interface LedgerSessionHeader {
  timestamp?: string | undefined;
  parentSession?: unknown;
}

/**
 * The usage sum of a ledger session row: the entries footer.md Section 2.2 sums, on every branch,
 * less `Agent` tool results and, in a fork, the entries copied from the parent session
 * (Section 2.1). `turns` counts the counted assistant messages.
 */
export function sessionRowUsage(
  entries: readonly LedgerSessionEntry[],
  header: LedgerSessionHeader | undefined,
): UsageSum {
  const forkedAt =
    header !== undefined && typeof header.parentSession === "string"
      ? instant(header.timestamp)
      : undefined;
  const sum = zeroUsageSum();
  for (const entry of entries) {
    const counted = countedUsage(entry);
    if (counted === undefined) continue;
    if (forkedAt !== undefined) {
      const at = instant(entry.timestamp);
      if (at !== undefined && at < forkedAt) continue;
    }
    sum.input += counted.usage.input;
    sum.output += counted.usage.output;
    sum.cacheRead += counted.usage.cacheRead;
    sum.cacheWrite += counted.usage.cacheWrite;
    sum.cost += counted.usage.cost.total;
    if (counted.assistant) sum.turns += 1;
  }
  return sum;
}

/** The usage an entry adds to the footer's session totals, less an `Agent` tool result's. */
function countedUsage(
  entry: LedgerSessionEntry,
): { usage: LedgerEntryUsage; assistant: boolean } | undefined {
  if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
    return entry.usage === undefined ? undefined : { usage: entry.usage, assistant: false };
  }
  if (entry.type !== "message" || entry.message?.usage === undefined) return;
  const { role, toolName, usage } = entry.message;
  if (role === "assistant") return { usage, assistant: true };
  if (role === "toolResult" && toolName !== "Agent") return { usage, assistant: false };
  return;
}

/** An RFC 3339 date-time as milliseconds since the epoch, or undefined when it is not one. */
function instant(text: string | undefined): number | undefined {
  if (text === undefined) return;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}
