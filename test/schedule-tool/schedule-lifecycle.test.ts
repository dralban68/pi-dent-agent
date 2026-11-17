import assert from "node:assert/strict";
import test from "node:test";
import { localStamp } from "../../lib/schedule-time.ts";
import { scheduleRuntime } from "../../lib/schedule-tool.ts";
import { SESSION, START, ZONE, fakeClock, fakeWindow, fixture, listed, textOf } from "./harness.ts";
import { must } from "../support/must.ts";

/** The status line of Section 6. */
function statusLine(count: number, repeating: number, dueAt: number): string {
  const clause = repeating === 0 ? "" : ` (${repeating} repeating)`;
  return `schedule: ${count} pending${clause} · next ${localStamp(dueAt, ZONE)}`;
}

function idOf(result: { details: Record<string, unknown> }): string {
  const id = result.details.scheduleId;
  assert.equal(typeof id, "string");
  if (typeof id !== "string") throw new Error("the result holds no schedule ID");
  return id;
}

function first<T>(items: readonly T[]): T {
  return must(items[0]);
}

test("Section 5: a reload discards the queued occurrence but keeps the schedule", () => {
  const f = fixture({ running: true, idle: false });
  const id = idOf(f.call({ action: "create", message: "x", everySeconds: 10 }));
  f.clock.advance(10_000);
  const before = listed(f.call({ action: "list" }));
  assert.equal(first(before).queued, true);
  f.runtime.sessionShutdown({ sessionId: SESSION, reason: "reload" });
  assert.equal(f.host.status(), undefined);
  f.clock.advance(30_000);
  assert.equal(f.host.sent.length, 1);
  f.runtime.sessionStart({ sessionId: SESSION, reason: "reload", window: f.host.window });
  const after = listed(f.call({ action: "list" }));
  assert.equal(first(after).scheduleId, id);
  assert.equal(first(after).queued, false);
  assert.equal(first(after).dueAt, START + 20_000);
  assert.equal(first(after).occurrences, 1);
  f.clock.advance(0);
  assert.equal(f.host.sent.length, 2);
  assert.deepEqual(must(f.host.sent[1]).details.schedules, [
    { scheduleId: id, createdAt: START, dueAt: START + 20_000, occurrence: 2 },
  ]);
});

test("Section 5: a reload neither fires nor changes a pending schedule", () => {
  const f = fixture();
  const id = idOf(f.call({ action: "create", message: "x", everySeconds: 30, count: 3 }));
  const before = listed(f.call({ action: "list" }));
  f.runtime.sessionShutdown({ sessionId: SESSION, reason: "reload" });
  assert.equal(f.clock.armed(), 0);
  f.clock.advance(120_000);
  assert.equal(f.host.sent.length, 0);
  f.runtime.sessionStart({ sessionId: SESSION, reason: "reload", window: f.host.window });
  assert.deepEqual(listed(f.call({ action: "list" })), before);
  f.clock.advance(0);
  assert.equal(f.host.sent.length, 1);
  assert.deepEqual(first(f.host.sent).details.schedules, [
    { scheduleId: id, createdAt: START, dueAt: START + 30_000, occurrence: 1 },
  ]);
});

test("Section 5: a session end drops its pending schedules without firing", () => {
  for (const reason of ["quit", "new", "resume", "fork"] as const) {
    const f = fixture();
    f.call({ action: "create", message: reason, delaySeconds: 5 });
    f.runtime.sessionShutdown({ sessionId: SESSION, reason });
    assert.equal(f.clock.armed(), 0, reason);
    f.clock.advance(10_000);
    assert.equal(f.host.sent.length, 0, reason);
    f.runtime.sessionStart({ sessionId: SESSION, reason: "resume", window: f.host.window });
    assert.deepEqual(listed(f.call({ action: "list" })), [], reason);
  }
});

test("Section 5: a session start that is not a reload has no pending schedule", () => {
  const f = fixture();
  f.call({ action: "create", message: "x", delaySeconds: 5 });
  f.runtime.sessionStart({ sessionId: SESSION, reason: "resume", window: f.host.window });
  assert.deepEqual(listed(f.call({ action: "list" })), []);
  assert.equal(f.host.status(), undefined);
  f.clock.advance(10_000);
  assert.equal(f.host.sent.length, 0);
});

test("Section 5: schedules are held per session and fire into the session that created them", () => {
  const f = fixture();
  const other = fakeWindow();
  f.runtime.sessionStart({ sessionId: "session-2", reason: "startup", window: other.window });
  const mine = idOf(f.call({ action: "create", message: "mine", delaySeconds: 5 }));
  f.callIn("session-2", { action: "create", message: "theirs", delaySeconds: 10 });
  assert.equal(listed(f.call({ action: "list" })).length, 1);
  assert.equal(listed(f.callIn("session-2", { action: "list" })).length, 1);
  assert.equal(f.callIn("session-2", { action: "cancel", scheduleId: mine }).isError, true);
  f.clock.advance(5_000);
  assert.equal(f.host.sent.length, 1);
  assert.equal(other.sent.length, 0);
  f.clock.advance(5_000);
  assert.equal(other.sent.length, 1);
  assert.ok(first(other.sent).content.endsWith("\ntheirs"));
});

test("Section 5: the process keeps a session's schedules across extension instances", () => {
  const clock = fakeClock();
  const window = fakeWindow();
  const before = scheduleRuntime({ clock: clock.clock, zone: ZONE });
  before.sessionStart({ sessionId: "reload-keeper", reason: "startup", window: window.window });
  before.execute({
    sessionId: "reload-keeper",
    params: { action: "create", message: "kept", delaySeconds: 60 },
  });
  const after = scheduleRuntime({ clock: clock.clock, zone: ZONE });
  const listedAfter = after.execute({ sessionId: "reload-keeper", params: { action: "list" } });
  assert.equal(textOf(listedAfter).split("\n").length, 1);
  assert.ok(textOf(listedAfter).includes("kept"));
  after.sessionShutdown({ sessionId: "reload-keeper", reason: "quit" });
  assert.equal(after.store.sessions.has("reload-keeper"), false);
});

test("Section 6: the status line counts pending schedules and names the first due time", () => {
  const f = fixture();
  f.call({ action: "create", message: "a", delaySeconds: 60 });
  assert.equal(f.host.status(), statusLine(1, 0, START + 60_000));
  const repeating = idOf(f.call({ action: "create", message: "b", everySeconds: 30 }));
  assert.equal(f.host.status(), statusLine(2, 1, START + 30_000));
  f.call({ action: "cancel", scheduleId: repeating });
  assert.equal(f.host.status(), statusLine(1, 0, START + 60_000));
  f.clock.advance(60_000);
  assert.equal(f.host.status(), undefined);
});

test("Section 6: the status line follows a firing and a skip", () => {
  const f = fixture({ running: true, idle: false });
  f.call({ action: "create", message: "x", everySeconds: 10 });
  assert.equal(f.host.status(), statusLine(1, 1, START + 10_000));
  f.clock.advance(10_000);
  assert.equal(f.host.status(), statusLine(1, 1, START + 20_000));
  f.clock.advance(10_000);
  assert.equal(f.host.status(), statusLine(1, 1, START + 30_000));
});

test("Section 6: a status line that cannot be set is reported and fails no call", () => {
  const f = fixture();
  f.host.window.setStatus = () => {
    throw new Error("the UI is gone");
  };
  const created = f.call({ action: "create", message: "x", delaySeconds: 60 });
  assert.equal(created.isError, undefined);
  const id = idOf(created);
  assert.deepEqual(
    listed(f.call({ action: "list" })).map((schedule) => schedule.scheduleId),
    [id],
  );
  const cancelled = f.call({ action: "cancel", scheduleId: id });
  assert.equal(cancelled.isError, undefined);
  assert.equal(textOf(cancelled), `Schedule ${id} cancelled.`);
  assert.deepEqual(listed(f.call({ action: "list" })), []);
  assert.deepEqual(f.host.notices, [
    "pi-dent: schedule status line could not be updated: the UI is gone",
    "pi-dent: schedule status line could not be updated: the UI is gone",
  ]);
});

test("Section 6: a session without an interactive UI shows no status line", () => {
  const f = fixture({ interactive: false });
  f.call({ action: "create", message: "x", delaySeconds: 60 });
  f.clock.advance(60_000);
  f.runtime.sessionShutdown({ sessionId: SESSION, reason: "quit" });
  assert.deepEqual(f.host.statuses, []);
});

test("Section 6: the status line is cleared when the session ends", () => {
  const f = fixture();
  f.call({ action: "create", message: "x", delaySeconds: 60 });
  assert.equal(f.host.status(), statusLine(1, 0, START + 60_000));
  f.runtime.sessionShutdown({ sessionId: SESSION, reason: "quit" });
  assert.equal(f.host.status(), undefined);
});

test("Section 6: the status line is set again at the session start after a reload", () => {
  const f = fixture();
  f.call({ action: "create", message: "x", delaySeconds: 60 });
  f.runtime.sessionShutdown({ sessionId: SESSION, reason: "reload" });
  assert.equal(f.host.status(), undefined);
  f.runtime.sessionStart({ sessionId: SESSION, reason: "reload", window: f.host.window });
  assert.equal(f.host.status(), statusLine(1, 0, START + 60_000));
});
