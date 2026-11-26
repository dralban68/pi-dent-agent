import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sessionRowToolCalls,
  sessionRowUsage,
  type LedgerSessionEntry,
} from "../../lib/task-ledger.ts";
import { usage } from "./support.ts";

/** specs/task-ledger.md#session-row: the usage and tool-call count of a ledger session row. */

function hostUsage(input: number, output: number, cost: number, cacheRead = 0, cacheWrite = 0) {
  return { input, output, cacheRead, cacheWrite, cost: { total: cost } };
}

function message(
  role: string,
  timestamp: string,
  usageValue?: ReturnType<typeof hostUsage>,
  toolName?: string,
): LedgerSessionEntry {
  return { type: "message", timestamp, message: { role, toolName, usage: usageValue } };
}

const AT = "2026-03-01T10:00:00.000Z";

test("sums the entries the footer sums, on every branch, and counts assistant messages as turns", () => {
  const entries: LedgerSessionEntry[] = [
    message("user", AT),
    message("assistant", AT, hostUsage(10, 1, 0.5, 100, 20)),
    message("assistant", AT, hostUsage(20, 2, 0.25)),
    message("toolResult", AT, hostUsage(3, 0, 0.125), "Bash"),
    { type: "compaction", timestamp: AT, usage: hostUsage(4, 4, 0.0625) },
    { type: "branch_summary", timestamp: AT, usage: hostUsage(5, 5, 0.03125) },
    { type: "usage", timestamp: AT, usage: hostUsage(6, 6, 0) },
    { type: "custom", timestamp: AT, usage: hostUsage(1000, 1000, 1000) },
  ];
  assert.deepEqual(sessionRowUsage(entries, { timestamp: AT }), usage(48, 18, 0.96875, 2, 100, 20));
});

test("counts an assistant message without a host usage as a turn", () => {
  const entries = [
    message("assistant", AT),
    message("assistant", AT, hostUsage(10, 1, 0.5)),
    message("user", AT),
  ];
  assert.deepEqual(sessionRowUsage(entries, { timestamp: AT }), usage(10, 1, 0.5, 2));
  const header = { timestamp: AT, parentSession: "/s/parent.jsonl" };
  // A fork-copied assistant message adds no turn, with or without a usage.
  assert.deepEqual(
    sessionRowUsage([message("assistant", "2026-03-01T09:00:00.000Z"), ...entries], header),
    usage(10, 1, 0.5, 2),
  );
});

test("leaves out an Agent tool result's usage", () => {
  const entries = [
    message("assistant", AT, hostUsage(10, 1, 0.5)),
    message("toolResult", AT, hostUsage(500, 50, 5), "Agent"),
    message("toolResult", AT, hostUsage(1, 1, 0.25), "Script"),
  ];
  assert.deepEqual(sessionRowUsage(entries, { timestamp: AT }), usage(11, 2, 0.75, 1));
});

test("in a fork, leaves out the entries timestamped before the header", () => {
  const header = { timestamp: "2026-03-01T12:00:00.000+02:00", parentSession: "/s/parent.jsonl" };
  const entries = [
    // 09:59:59Z: before the header's instant, 10:00:00Z, so copied by the fork.
    message("assistant", "2026-03-01T09:59:59.999Z", hostUsage(100, 100, 1)),
    // The same instant as the header, written in another offset: not earlier, so counted.
    message("assistant", "2026-03-01T10:00:00.000Z", hostUsage(1, 2, 0.5)),
    message("assistant", "2026-03-01T11:00:00.000+01:00", hostUsage(3, 4, 0.25)),
  ];
  assert.deepEqual(sessionRowUsage(entries, header), usage(4, 6, 0.75, 2));
  // Without a string parentSession every entry counts.
  assert.deepEqual(
    sessionRowUsage(entries, { timestamp: header.timestamp }),
    usage(104, 106, 1.75, 3),
  );
  assert.deepEqual(
    sessionRowUsage(entries, { timestamp: header.timestamp, parentSession: 7 }),
    usage(104, 106, 1.75, 3),
  );
});

function withContent(role: string, timestamp: string, content: unknown): LedgerSessionEntry {
  return { type: "message", timestamp, message: { role, content } };
}

const call = (name: string) => ({ type: "toolCall", id: name, name, arguments: {} });

test("tool_calls counts the toolCall parts of the assistant messages turns counts, fork copies left out", () => {
  const header = { timestamp: AT, parentSession: "/s/parent.jsonl" };
  const entries = [
    // Copied by the fork: neither a turn nor its tool calls count.
    withContent("assistant", "2026-03-01T09:00:00.000Z", [call("a"), call("b"), call("c")]),
    withContent("assistant", AT, [{ type: "text", text: "x" }, call("Read"), call("Bash")]),
    withContent("assistant", AT, [{ type: "thinking", thinking: "t" }]),
    withContent("assistant", AT, "not an array"),
    // Only assistant messages carry the session's own tool calls.
    withContent("user", AT, [call("u")]),
    withContent("toolResult", AT, [call("r")]),
    { type: "custom", timestamp: AT, message: { role: "assistant", content: [call("x")] } },
  ];
  assert.equal(sessionRowToolCalls(entries, header), 2);
  assert.equal(sessionRowUsage(entries, header).turns, 3);
  // Not a fork: the copied-looking entry counts too.
  assert.equal(sessionRowToolCalls(entries, { timestamp: AT }), 5);
});
