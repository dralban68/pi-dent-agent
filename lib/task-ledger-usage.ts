/**
 * The usage and tool-call count of a main session's ledger session row (specs/task-ledger.md
 * Section 2.1), from the session entries and header the host holds.
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
    | {
        role: string;
        toolName?: string | undefined;
        usage?: LedgerEntryUsage | undefined;
        /** The host `content`, read for its tool calls. */
        content?: unknown;
      }
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
 * (Section 2.1). `turns` counts every assistant message not copied by a fork, with or without a
 * host `usage`.
 */
export function sessionRowUsage(
  entries: readonly LedgerSessionEntry[],
  header: LedgerSessionHeader | undefined,
): UsageSum {
  const sum = zeroUsageSum();
  for (const entry of notForkCopied(entries, header)) {
    if (isAssistantMessage(entry)) sum.turns += 1;
    const usage = countedUsage(entry);
    if (usage === undefined) continue;
    sum.input += usage.input;
    sum.output += usage.output;
    sum.cacheRead += usage.cacheRead;
    sum.cacheWrite += usage.cacheWrite;
    sum.cost += usage.cost.total;
  }
  return sum;
}

/**
 * The `tool_calls` of a ledger session row (Section 2.1): the tool calls of the assistant messages
 * whose entries `turns` counts.
 */
export function sessionRowToolCalls(
  entries: readonly LedgerSessionEntry[],
  header: LedgerSessionHeader | undefined,
): number {
  let count = 0;
  for (const entry of notForkCopied(entries, header)) {
    if (isAssistantMessage(entry)) count += toolCallCount(entry.message?.content);
  }
  return count;
}

/** The tool calls of an assistant message (agent-tool.md Section 13): its `toolCall` parts. */
export function toolCallCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const part of content) {
    if (typeof part === "object" && part !== null && Reflect.get(part, "type") === "toolCall") {
      count += 1;
    }
  }
  return count;
}

function isAssistantMessage(entry: LedgerSessionEntry): boolean {
  return entry.type === "message" && entry.message?.role === "assistant";
}

/** The entries of the session less, in a fork, those copied from the parent session. */
function* notForkCopied(
  entries: readonly LedgerSessionEntry[],
  header: LedgerSessionHeader | undefined,
): Generator<LedgerSessionEntry> {
  const forkedAt =
    header !== undefined && typeof header.parentSession === "string"
      ? instant(header.timestamp)
      : undefined;
  for (const entry of entries) {
    if (forkedAt !== undefined) {
      const at = instant(entry.timestamp);
      if (at !== undefined && at < forkedAt) continue;
    }
    yield entry;
  }
}

/** The usage an entry adds to the footer's session totals, less an `Agent` tool result's. */
function countedUsage(entry: LedgerSessionEntry): LedgerEntryUsage | undefined {
  if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
    return entry.usage;
  }
  if (entry.type !== "message" || entry.message?.usage === undefined) return;
  const { role, toolName, usage } = entry.message;
  if (role === "assistant") return usage;
  if (role === "toolResult" && toolName !== "Agent") return usage;
  return;
}

/** An RFC 3339 date-time as milliseconds since the epoch, or undefined when it is not one. */
function instant(text: string | undefined): number | undefined {
  if (text === undefined) return;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : at;
}
