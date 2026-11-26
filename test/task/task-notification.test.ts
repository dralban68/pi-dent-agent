import assert from "node:assert/strict";
import { test } from "node:test";
import { hostFromContext, hostFromSessionBox } from "../../lib/engine.ts";
import { AgentTaskRow, TaskRegistry } from "../../lib/registry.ts";
import { at } from "../support/must.ts";

/**
 * The notification send shape of specs/task-registry.md#cohorts, through the host
 * adapter the main session gives a task registry: `sendMessage` with `customType`
 * `"pi-dent-tasks"`, `display: true`, `deliverAs: "followUp"`, and `triggerTurn: true`.
 */

interface SendMessageCall {
  message: { customType: string; content: string; display: boolean };
  options: { deliverAs: "followUp"; triggerTurn: boolean };
}

/** A main session's host adapter over a fake `pi` that records `sendMessage` calls. */
function fakeMainSession(): { sent: SendMessageCall[]; host: ReturnType<typeof hostFromContext> } {
  const sent: SendMessageCall[] = [];
  const pi = {
    getActiveTools: () => ["Task"],
    sendMessage: (
      message: SendMessageCall["message"],
      options: SendMessageCall["options"],
    ): void => {
      sent.push({ message, options });
    },
  };
  // Every field of the adapter is a closure: the context is read only when a field is used.
  return { sent, host: hostFromContext(pi as never, {} as never) };
}

test("a completion notification is sent with the notification shape of specs/task-registry.md#cohorts", () => {
  const { sent, host } = fakeMainSession();
  const registry = new TaskRegistry(() => host);
  const row = registry.register({ kind: "script", cohort: "c", label: "spin", background: true });
  registry.settle(row, { status: "completed", result: "ok" });
  assert.equal(sent.length, 1, "one notification for the settled cohort");
  const only = at(sent, 0);
  assert.deepEqual(only.message, {
    customType: "pi-dent-tasks",
    content: `Background tasks settled:\n${registry.listLine(row)}`,
    display: true,
  });
  assert.deepEqual(only.options, { deliverAs: "followUp", triggerTurn: true });
});

test("an interrupted notification is sent with the same shape and consumes nothing", () => {
  const { sent, host } = fakeMainSession();
  const registry = new TaskRegistry(() => host);
  const stuck = new AgentTaskRow({
    taskId: "aaaa0001",
    cohort: "c",
    label: "stuck",
    background: true,
    startedAt: 1_000,
  });
  stuck.status = "interrupted";
  stuck.settledAt = 6_000;
  registry.rebuild([stuck]);
  assert.equal(sent.length, 1);
  const only = at(sent, 0);
  assert.deepEqual(only.message, {
    customType: "pi-dent-tasks",
    content: `Interrupted tasks (resume with Agent resume=<taskId>):\n${registry.listLine(stuck)}`,
    display: true,
  });
  assert.deepEqual(only.options, { deliverAs: "followUp", triggerTurn: true });
  assert.equal(stuck.consumed, false);
});

test("a child host with no live child session fails the send, leaving the rows unconsumed", () => {
  // specs/task-registry.md#cohorts: rows are consumed only once the host accepted the message.
  const host = hostFromSessionBox({});
  assert.throws(
    () => host.notify("Background tasks settled:\n…"),
    /^Error: no live child session for the completion notification$/,
  );

  const registry = new TaskRegistry(() => host);
  const row = registry.register({ kind: "script", cohort: "c", label: "spin", background: true });
  registry.settle(row, { status: "completed", result: "ok" });
  assert.equal(row.consumed, false, "the unanswered notification consumes nothing");
  // The next notification of the cohort lists the row again.
  const second = registry.register({
    kind: "script",
    cohort: "c",
    label: "spin again",
    background: true,
  });
  registry.settle(second, { status: "completed", result: "ok" });
  assert.equal(row.consumed, false);
  assert.equal(second.consumed, false);
});
