import assert from "node:assert/strict";
import test from "node:test";
import { MAX_INSTANT, localStamp } from "../../lib/schedule-time.ts";
import type { ScheduledMessage } from "../../lib/schedule-tool.ts";
import type { ToolResult } from "../../lib/engine.ts";
import { SESSION, START, ZONE, fixture, inserted, listed, type Fixture } from "./harness.ts";
import { must } from "../support/must.ts";

/** The message envelope of specs/schedule-tool.md#insertion. */
function envelope(
  scheduleId: string,
  createdAt: number,
  dueAt: number,
  message: string,
  repeat = "",
): string {
  return `[Scheduled message ${scheduleId} — set by you at ${localStamp(createdAt, ZONE)}, due ${localStamp(dueAt, ZONE)}${repeat}; not from the user]\n${message}`;
}

function idOf(result: ToolResult): string {
  const id = result.details.scheduleId;
  assert.equal(typeof id, "string");
  if (typeof id !== "string") throw new Error("the result holds no schedule ID");
  return id;
}

function only<T>(items: readonly T[]): T {
  return must(items[0]);
}

/** One pending schedule as `list` reports it (specs/schedule-tool.md#list). */
interface ListedSchedule {
  scheduleId: string;
  createdAt: number;
  dueAt: number;
  message: string;
  everySeconds?: number;
  count?: number;
  occurrences: number;
  queued: boolean;
}

/** The one pending schedule, asserted to be one. */
function pendingOf(f: Fixture): ListedSchedule {
  const pending = listed(f.call({ action: "list" }));
  assert.equal(pending.length, 1);
  return must(pending[0]) as unknown as ListedSchedule;
}

/** The status line of specs/schedule-tool.md#schedule-status-line. */
function statusLine(count: number, repeating: number, dueAt: number): string {
  const clause = repeating === 0 ? "" : ` (${repeating} repeating)`;
  return `schedule: ${count} pending${clause} · next ${localStamp(dueAt, ZONE)}`;
}

test("specs/schedule-tool.md#checks: the next check is armed inside the 1000 ms bound", () => {
  const f = fixture();
  f.call({ action: "create", message: "hello", delaySeconds: 10 });
  // The create refresh arms an immediate check; run it to arm the next one.
  f.clock.advance(0);
  const delay = must(f.clock.nextDelay());
  assert.ok(delay > 0, `a check is armed, got ${delay}`);
  assert.ok(delay < 1000, `the gap between checks stays under the bound, got ${delay}`);
});

test("specs/schedule-tool.md#checks: a throwing window call is reported once and does not stop checking", () => {
  const f = fixture();
  idOf(f.call({ action: "create", message: "later", delaySeconds: 10 }));
  const realIsIdle = f.host.window.isIdle;
  let failures = 0;
  f.host.window.isIdle = () => {
    if (failures < 3) {
      failures += 1;
      throw new Error("stale window");
    }
    return realIsIdle();
  };
  // The first checks throw; the failure is shown once, no exception escapes, and checking
  // continues (specs/schedule-tool.md#schedule-status-line).
  f.clock.advance(2_000);
  assert.equal(failures, 3);
  assert.equal(f.host.sent.length, 0);
  assert.deepEqual(f.host.notices, ["pi-dent: schedule check failed: stale window"]);
  f.clock.advance(8_000);
  assert.equal(f.host.sent.length, 1, "checking continued after the throws");
  assert.equal(f.host.notices.length, 1, "the same failure is not repeated");

  // Another failure of the window is its own report.
  idOf(f.call({ action: "create", message: "again", delaySeconds: 10 }));
  f.host.window.isRunning = () => {
    throw new Error("window is gone");
  };
  f.clock.advance(2_000);
  assert.deepEqual(f.host.notices.slice(1), ["pi-dent: schedule check failed: window is gone"]);
});

test("specs/schedule-tool.md#schedule-status-line: a host notify that throws does not stop checking or fail the check", () => {
  const f = fixture();
  idOf(f.call({ action: "create", message: "later", delaySeconds: 10 }));
  const realIsIdle = f.host.window.isIdle;
  let failed = false;
  f.host.window.isIdle = () => {
    if (!failed) {
      failed = true;
      throw new Error("stale window");
    }
    return realIsIdle();
  };
  f.host.window.notify = () => {
    throw new Error("ui is gone");
  };
  f.clock.advance(10_000);
  assert.equal(failed, true);
  assert.equal(f.host.sent.length, 1, "the schedule still fired after the unreportable failure");
});

test("specs/schedule-tool.md#checks: a due schedule fires once, and never before it is due", () => {
  const f = fixture();
  const id = idOf(f.call({ action: "create", message: "hello", delaySeconds: 10 }));
  assert.equal(f.clock.armed(), 1);
  f.clock.advance(9_999);
  assert.equal(f.host.sent.length, 0);
  f.clock.advance(1);
  assert.equal(f.host.sent.length, 1);
  const message = only(f.host.sent);
  assert.equal(message.customType, "pi-dent-schedule");
  assert.equal(message.display, true);
  assert.deepEqual(message.details, {
    schedules: [{ scheduleId: id, createdAt: START, dueAt: START + 10_000 }],
  });
  assert.equal(message.content, envelope(id, START, START + 10_000, "hello"));
  assert.deepEqual(listed(f.call({ action: "list" })), []);
});

test("specs/schedule-tool.md#checks: checks run at most 1000 ms apart", () => {
  const f = fixture();
  const at = START + 10_500;
  f.call({ action: "create", message: "x", at: new Date(at).toISOString() });
  f.clock.advance(10_499);
  assert.equal(f.host.sent.length, 0);
  f.clock.advance(1);
  assert.equal(f.host.sent.length, 1);
  // The first check at or after the due time fires it, inside the 1000 ms bound.
  assert.equal(f.clock.now(), at);
  assert.ok(only(f.host.sent).content.includes(localStamp(at, ZONE)));
});

test("specs/schedule-tool.md#checks: a due schedule waits while neither a run is in progress nor the session idle", () => {
  const f = fixture({ running: false, idle: false });
  f.call({ action: "create", message: "x", delaySeconds: 1 });
  f.clock.advance(5_000);
  assert.equal(f.host.sent.length, 0);
  const pending = listed(f.call({ action: "list" }));
  assert.equal(pending.length, 1);
  assert.equal(must(pending[0]).dueAt, START + 1_000);
  f.host.state.idle = true;
  f.clock.advance(1_000);
  assert.equal(f.host.sent.length, 1);
  assert.ok(only(f.host.sent).content.includes(localStamp(START + 1_000, ZONE)));
});

test("specs/schedule-tool.md#repeating-schedules: missed grid points collapse into one firing, whose due time jumps to the next grid point", () => {
  const f = fixture({ running: false, idle: false });
  const id = idOf(f.call({ action: "create", message: "x", everySeconds: 10 }));
  f.clock.advance(35_000);
  assert.equal(f.host.sent.length, 0);
  f.host.state.idle = true;
  f.clock.advance(1_000);
  assert.equal(f.host.sent.length, 1);
  const schedule = pendingOf(f);
  assert.equal(schedule.occurrences, 1);
  assert.equal(schedule.dueAt, START + 40_000);
  assert.deepEqual(only(f.host.sent).details.schedules, [
    { scheduleId: id, createdAt: START, dueAt: START + 10_000, occurrence: 1 },
  ]);
  assert.equal(
    only(f.host.sent).content,
    envelope(id, START, START + 10_000, "x", "; occurrence 1, every 10 s"),
  );
});

test("specs/schedule-tool.md#checks: a repeating schedule whose occurrence is queued is skipped, not fired", () => {
  const f = fixture({ running: true, idle: false });
  const id = idOf(f.call({ action: "create", message: "x", everySeconds: 10 }));
  f.clock.advance(10_000);
  assert.equal(f.host.sent.length, 1);
  const first = only(f.host.sent);
  assert.equal(pendingOf(f).queued, true);
  f.clock.advance(10_000);
  assert.equal(f.host.sent.length, 1);
  const skipped = pendingOf(f);
  assert.equal(skipped.occurrences, 1);
  assert.equal(skipped.dueAt, START + 30_000);
  f.runtime.messageStarted({ sessionId: SESSION, message: inserted(first) });
  assert.equal(pendingOf(f).queued, false);
  f.clock.advance(10_000);
  assert.equal(f.host.sent.length, 2);
  assert.deepEqual(must(f.host.sent[1]).details.schedules, [
    { scheduleId: id, createdAt: START, dueAt: START + 30_000, occurrence: 2 },
  ]);
});

test("specs/schedule-tool.md#checks: a schedule fires at most once per check", () => {
  const f = fixture();
  f.call({
    action: "create",
    message: "x",
    at: new Date(START - 20_000).toISOString(),
    everySeconds: 1,
  });
  f.clock.advance(0);
  assert.equal(f.host.sent.length, 1);
  assert.equal(must(only(f.host.sent).details.schedules[0]).occurrence, 1);
});

test("specs/schedule-tool.md#insertion: schedules due at one check fire together in one message, in the order of specs/schedule-tool.md#schedule", () => {
  const f = fixture();
  const first = idOf(f.call({ action: "create", message: "first", delaySeconds: 10 }));
  const second = idOf(
    f.call({ action: "create", message: "at", at: new Date(START + 10_000).toISOString() }),
  );
  f.clock.advance(10_000);
  assert.equal(f.host.sent.length, 1);
  const message = only(f.host.sent);
  assert.equal(
    message.content,
    `${envelope(first, START, START + 10_000, "first")}\n\n${envelope(second, START, START + 10_000, "at")}`,
  );
  assert.deepEqual(message.details.schedules, [
    { scheduleId: first, createdAt: START, dueAt: START + 10_000 },
    { scheduleId: second, createdAt: START, dueAt: START + 10_000 },
  ]);
});

test("specs/schedule-tool.md#insertion: a message starting with a slash is kept verbatim", () => {
  const f = fixture();
  const id = idOf(f.call({ action: "create", message: "/clear\nsecond line", delaySeconds: 1 }));
  f.clock.advance(1_000);
  assert.equal(
    only(f.host.sent).content,
    envelope(id, START, START + 1_000, "/clear\nsecond line"),
  );
});

test("specs/schedule-tool.md#insertion: a queued occurrence is discarded when a check finds the session idle, and never handed over again", () => {
  const f = fixture({ running: true, idle: false });
  const id = idOf(f.call({ action: "create", message: "x", everySeconds: 10 }));
  f.clock.advance(10_000);
  assert.equal(f.host.sent.length, 1);
  f.host.state.running = false;
  f.host.state.idle = true;
  f.clock.advance(1_000);
  const discarded = pendingOf(f);
  assert.equal(discarded.queued, false);
  assert.equal(discarded.occurrences, 1);
  assert.equal(discarded.dueAt, START + 20_000);
  f.clock.advance(9_000);
  assert.equal(f.host.sent.length, 2);
  assert.deepEqual(must(f.host.sent[1]).details.schedules, [
    { scheduleId: id, createdAt: START, dueAt: START + 20_000, occurrence: 2 },
  ]);
  const handedOff = f.host.sent
    .flatMap((message: ScheduledMessage) => message.details.schedules)
    .filter((occurrence) => occurrence.dueAt === START + 10_000);
  assert.equal(handedOff.length, 1);
});

test("specs/schedule-tool.md#insertion: a one-off schedule ends with its hand-off, even when the occurrence is discarded", () => {
  const f = fixture({ running: true, idle: false });
  f.call({ action: "create", message: "x", delaySeconds: 5 });
  f.clock.advance(5_000);
  assert.equal(f.host.sent.length, 1);
  assert.deepEqual(listed(f.call({ action: "list" })), []);
  f.host.state.running = false;
  f.host.state.idle = true;
  f.clock.advance(2_000);
  assert.equal(f.host.sent.length, 1);
});

test("specs/schedule-tool.md#insertion: only a message_start that carries the queued occurrence clears it", () => {
  const f = fixture({ running: true, idle: false });
  f.call({ action: "create", message: "x", everySeconds: 10 });
  f.clock.advance(10_000);
  const handOff = only(f.host.sent);
  const queued = (): boolean => pendingOf(f).queued;
  f.runtime.messageStarted({
    sessionId: SESSION,
    message: { ...inserted(handOff), customType: "other" },
  });
  assert.equal(queued(), true);
  f.runtime.messageStarted({
    sessionId: SESSION,
    message: { ...inserted(handOff), role: "assistant" },
  });
  assert.equal(queued(), true);
  f.runtime.messageStarted({
    sessionId: SESSION,
    message: { ...inserted(handOff), details: { schedules: [] } },
  });
  assert.equal(queued(), true);
  f.runtime.messageStarted({
    sessionId: SESSION,
    message: {
      ...inserted(handOff),
      details: {
        schedules: [must(handOff.details.schedules[0])],
      },
    },
  });
  assert.equal(queued(), false);
});

test("specs/schedule-tool.md#insertion: an occurrence of another due time leaves the queued occurrence in place", () => {
  const f = fixture({ running: true, idle: false });
  f.call({ action: "create", message: "x", everySeconds: 10 });
  f.clock.advance(10_000);
  const handOff = only(f.host.sent);
  const occurrence = must(handOff.details.schedules[0]);
  f.runtime.messageStarted({
    sessionId: SESSION,
    message: {
      ...inserted(handOff),
      details: { schedules: [{ ...occurrence, dueAt: occurrence.dueAt + 10_000 }] },
    },
  });
  assert.equal(pendingOf(f).queued, true);
});

test("specs/schedule-tool.md#repeating-schedules: a repeating schedule ends at its count with the count marker", () => {
  const f = fixture();
  const id = idOf(f.call({ action: "create", message: "tick", everySeconds: 5, count: 2 }));
  f.clock.advance(5_000);
  assert.equal(f.host.sent.length, 1);
  assert.ok(!only(f.host.sent).content.includes("final:"));
  f.clock.advance(5_000);
  assert.equal(f.host.sent.length, 2);
  const last = must(f.host.sent[1]);
  assert.ok(
    last.content.includes("; occurrence 2, every 5 s, final: count reached; not from the user]"),
  );
  assert.deepEqual(last.details.schedules, [
    { scheduleId: id, createdAt: START, dueAt: START + 10_000, occurrence: 2 },
  ]);
  assert.deepEqual(listed(f.call({ action: "list" })), []);
});

test("specs/schedule-tool.md#repeating-schedules: a count of 1 ends the schedule with its first firing", () => {
  const f = fixture();
  const id = idOf(f.call({ action: "create", message: "once", everySeconds: 5, count: 1 }));
  f.clock.advance(5_000);
  assert.equal(f.host.sent.length, 1);
  const message = only(f.host.sent);
  assert.ok(
    message.content.includes("; occurrence 1, every 5 s, final: count reached; not from the user]"),
  );
  assert.deepEqual(message.details.schedules, [
    { scheduleId: id, createdAt: START, dueAt: START + 5_000, occurrence: 1 },
  ]);
  assert.deepEqual(listed(f.call({ action: "list" })), []);
});

test("specs/schedule-tool.md#repeating-schedules: a repeating schedule ends when its next due time is not representable", () => {
  const start = MAX_INSTANT - 7_000;
  const f = fixture({}, start);
  const id = idOf(f.call({ action: "create", message: "late", everySeconds: 5 }));
  f.clock.advance(5_000);
  assert.equal(f.host.sent.length, 1);
  const message = only(f.host.sent);
  assert.ok(
    message.content.includes(
      "; occurrence 1, every 5 s, final: next due time not representable; not from the user]",
    ),
  );
  assert.deepEqual(message.details.schedules, [
    { scheduleId: id, createdAt: start, dueAt: start + 5_000, occurrence: 1 },
  ]);
  assert.deepEqual(listed(f.call({ action: "list" })), []);
});

test("specs/schedule-tool.md#repeating-schedules: a skip whose next due time is not representable ends the schedule", () => {
  const start = MAX_INSTANT - 12_000;
  const f = fixture({ running: true, idle: false }, start);
  f.call({ action: "create", message: "late", everySeconds: 5 });
  f.clock.advance(5_000);
  assert.equal(f.host.sent.length, 1);
  const queued = pendingOf(f);
  assert.equal(queued.queued, true);
  assert.equal(queued.dueAt, MAX_INSTANT - 2_000);
  // The queued occurrence is skipped past the last representable instant.
  f.clock.advance(5_000);
  assert.equal(f.host.sent.length, 1);
  assert.deepEqual(listed(f.call({ action: "list" })), []);
  assert.equal(f.host.status(), undefined);
});

test("specs/schedule-tool.md#insertion: a hand-off the host refuses leaves the schedule pending and tells the user once", () => {
  const f = fixture();
  const id = idOf(f.call({ action: "create", message: "hello", delaySeconds: 10 }));
  const deliver = f.host.window.send;
  f.host.window.send = () => {
    throw new Error("the host is gone");
  };
  f.clock.advance(10_000);
  assert.equal(f.host.sent.length, 0);
  // A further refusal with the same error shows no second notification.
  f.clock.advance(1_000);
  assert.deepEqual(f.host.notices, [
    `pi-dent: schedule ${id} was not delivered: the host is gone; it stays pending`,
  ]);
  // The schedule is still pending at its due time, and the status line says so.
  const pending = pendingOf(f);
  assert.equal(pending.dueAt, START + 10_000);
  assert.equal(pending.queued, false);
  assert.equal(f.host.status(), statusLine(1, 0, START + 10_000));
  // A later check hands it over, and the one-off schedule ends with that hand-off.
  f.host.window.send = deliver;
  f.clock.advance(1_000);
  assert.equal(f.host.sent.length, 1);
  assert.equal(only(f.host.sent).content, envelope(id, START, START + 10_000, "hello"));
  assert.deepEqual(listed(f.call({ action: "list" })), []);
});

test("specs/schedule-tool.md#insertion: a refused hand-off loses no occurrence of a repeating schedule", () => {
  const f = fixture({ running: true, idle: false });
  f.call({ action: "create", message: "x", everySeconds: 10 });
  f.host.window.send = () => {
    throw new Error("refused");
  };
  f.clock.advance(10_000);
  const pending = pendingOf(f);
  assert.equal(pending.occurrences, 0);
  assert.equal(pending.queued, false);
  assert.equal(pending.dueAt, START + 10_000);
});
