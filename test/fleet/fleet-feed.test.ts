import assert from "node:assert/strict";
import { test } from "node:test";
import type { FleetSessionRecord } from "../../lib/fleet.ts";
import {
  FLEET_FEED_INTERVAL_MS,
  FLEET_WIDGET_ID,
  type FeedFleet,
  fleetFeedSummary,
  fleetFeedText,
  type FleetFeedTimers,
  startFleetFeed,
} from "../../lib/fleet-feed.ts";
import { at, must } from "../support/must.ts";

/** Fleet feed conformance per specs/fleet-tool.md#fleet-feed. */

const record = (
  sessionId: string,
  turns: FleetSessionRecord["turns"] = [],
  state: FleetSessionRecord["state"] = "idle",
): FleetSessionRecord => ({
  sessionId,
  cwd: `/work/${sessionId}`,
  state,
  updatedAt: 0,
  turns,
  ownerPid: 0,
  ownerStarted: 0,
  hidden: false,
});

/** A fleet whose listing the test controls; `classifyCaller` answers `identity`. */
function fakeFleet(initial: FleetSessionRecord[], identity: "endpoint" | "child" | "foreign") {
  const state = { sessions: initial, fail: false, listed: [] as Array<[string, string]> };
  const fleet: FeedFleet = {
    listSessions(scope, cwd) {
      state.listed.push([scope, cwd]);
      if (state.fail) throw new Error("store unavailable");
      return state.sessions;
    },
    classifyCaller() {
      return identity;
    },
  };
  return { fleet, state };
}

/** Fake timers: the test fires the captured callback itself. */
function fakeTimers() {
  const timers = {
    intervals: [] as Array<{ callback: () => void; ms: number; cleared: boolean }>,
  };
  const feedTimers: FleetFeedTimers = {
    setInterval(callback, ms) {
      const entry = { callback, ms, cleared: false };
      timers.intervals.push(entry);
      return entry as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(handle) {
      const entry = handle as unknown as { cleared: boolean };
      entry.cleared = true;
    },
  };
  return { timers, feedTimers };
}

function recorder() {
  const calls: Array<[string, string[] | undefined]> = [];
  return {
    calls,
    host: {
      setWidget(key: string, lines: string[] | undefined) {
        calls.push([key, lines]);
      },
    },
  };
}

function parsed(text: string) {
  return JSON.parse(text) as {
    piDent: string;
    sessionId: string;
    sessions: Array<Record<string, unknown>>;
  };
}

test("a session without a live endpoint identity starts no feed", () => {
  for (const identity of ["child", "foreign"] as const) {
    const { fleet } = fakeFleet([record("s1")], identity);
    const { timers, feedTimers } = fakeTimers();
    const { calls, host } = recorder();
    startFleetFeed({ fleet, sessionId: "s1", cwd: "/work/s1", host, timers: feedTimers });
    assert.deepEqual(calls, []);
    assert.deepEqual(timers.intervals, []);
  }
});

test("a session without a session identity starts no feed", () => {
  const { fleet } = fakeFleet([], "endpoint");
  const { timers, feedTimers } = fakeTimers();
  const { calls, host } = recorder();
  startFleetFeed({ fleet, sessionId: "", cwd: "/work", host, timers: feedTimers });
  assert.deepEqual(calls, []);
  assert.deepEqual(timers.intervals, []);
});

test("the feed is computed at start and every 5 seconds on the boot window's timer", () => {
  const { fleet } = fakeFleet([record("s1")], "endpoint");
  const { timers, feedTimers } = fakeTimers();
  const { calls, host } = recorder();
  startFleetFeed({ fleet, sessionId: "s1", cwd: "/work/s1", host, timers: feedTimers });
  assert.equal(calls.length, 1);
  assert.equal(timers.intervals.length, 1);
  assert.equal(must(timers.intervals[0]).ms, 5000);
  assert.equal(FLEET_FEED_INTERVAL_MS, 5000);
});

test("the payload carries the session ID, the machine list, and each summary", () => {
  const sessions = [
    record("a", [{ command: "/x", goal: "ship the feed", files: [], startedAt: 0 }], "running"),
    record("b", [{ command: "run tests", goal: "", files: [], startedAt: 0 }]),
    record("c", []),
  ];
  const { fleet, state } = fakeFleet(sessions, "endpoint");
  const { feedTimers } = fakeTimers();
  const { calls, host } = recorder();
  startFleetFeed({ fleet, sessionId: "a", cwd: "/work/a", host, timers: feedTimers });
  assert.deepEqual(state.listed, [["machine", "/work/a"]]);
  const [key, lines] = must(calls[0]);
  assert.equal(key, FLEET_WIDGET_ID);
  assert.equal(must(lines).length, 1);
  const payload = parsed(at(must(lines), 0));
  assert.equal(payload.piDent, "fleet/1");
  assert.equal(payload.sessionId, "a");
  assert.deepEqual(
    payload.sessions.map((s) => [s.sessionId, s.state, s.kind, s.summary]),
    [
      ["a", "running", "machine", "ship the feed"],
      ["b", "idle", "machine", "run tests"],
      ["c", "idle", "machine", null],
    ],
  );
  const first = must(payload.sessions[0]);
  assert.equal(first.cwd, "/work/a");
  assert.deepEqual(first.turns, [
    { command: "/x", goal: "ship the feed", files: [], startedAt: 0 },
  ]);
});

test("the feed sets the widget only when its text changes", () => {
  const { fleet, state } = fakeFleet([record("s1")], "endpoint");
  const { timers, feedTimers } = fakeTimers();
  const { calls, host } = recorder();
  startFleetFeed({ fleet, sessionId: "s1", cwd: "/work/s1", host, timers: feedTimers });
  const tick = must(timers.intervals[0]).callback;
  tick();
  tick();
  assert.equal(calls.length, 1);
  state.sessions = [record("s1", [{ command: "c", goal: "g", files: [], startedAt: 0 }])];
  tick();
  assert.equal(calls.length, 2);
  assert.equal(parsed(at(must(must(calls[1])[1]), 0)).sessions[0]?.summary, "g");
});

test("a failing computation leaves the widget as it is and reports nothing", () => {
  const { fleet, state } = fakeFleet([record("s1")], "endpoint");
  const { timers, feedTimers } = fakeTimers();
  const { calls, host } = recorder();
  startFleetFeed({ fleet, sessionId: "s1", cwd: "/work/s1", host, timers: feedTimers });
  assert.equal(calls.length, 1);
  state.fail = true;
  const tick = must(timers.intervals[0]).callback;
  assert.doesNotThrow(() => tick());
  assert.equal(calls.length, 1);
  state.fail = false;
  tick();
  assert.equal(calls.length, 1);
});

test("a failing start reports nothing and the next tick may still set the widget", () => {
  const { fleet, state } = fakeFleet([record("s1")], "endpoint");
  state.fail = true;
  const { timers, feedTimers } = fakeTimers();
  const { calls, host } = recorder();
  startFleetFeed({ fleet, sessionId: "s1", cwd: "/work/s1", host, timers: feedTimers });
  assert.deepEqual(calls, []);
  state.fail = false;
  must(timers.intervals[0]).callback();
  assert.equal(calls.length, 1);
});

test("stopping ends the timer and clears the widget", () => {
  const { fleet } = fakeFleet([record("s1")], "endpoint");
  const { timers, feedTimers } = fakeTimers();
  const { calls, host } = recorder();
  const feed = startFleetFeed({
    fleet,
    sessionId: "s1",
    cwd: "/work/s1",
    host,
    timers: feedTimers,
  });
  feed.stop();
  assert.equal(must(timers.intervals[0]).cleared, true);
  assert.deepEqual(calls.at(-1), [FLEET_WIDGET_ID, undefined]);
  assert.equal(calls.length, 2);
  // A tick that fires after the stop does nothing.
  must(timers.intervals[0]).callback();
  assert.equal(calls.length, 2);
  feed.stop();
  assert.equal(calls.length, 2);
});

test("stopping a feed that never set the widget clears nothing", () => {
  const { fleet, state } = fakeFleet([record("s1")], "endpoint");
  state.fail = true;
  const { timers, feedTimers } = fakeTimers();
  const { calls, host } = recorder();
  const feed = startFleetFeed({
    fleet,
    sessionId: "s1",
    cwd: "/work/s1",
    host,
    timers: feedTimers,
  });
  feed.stop();
  assert.equal(must(timers.intervals[0]).cleared, true);
  assert.deepEqual(calls, []);
});

test("the summary is the goal, else the command, else null", () => {
  assert.equal(
    fleetFeedSummary(record("s", [{ command: "c", goal: "g", files: [], startedAt: 0 }])),
    "g",
  );
  assert.equal(
    fleetFeedSummary(record("s", [{ command: "c", goal: "", files: [], startedAt: 0 }])),
    "c",
  );
  assert.equal(
    fleetFeedSummary(record("s", [{ command: "", goal: "", files: [], startedAt: 0 }])),
    null,
  );
  assert.equal(fleetFeedSummary(record("s", [])), null);
  const { fleet } = fakeFleet(
    [record("s", [{ command: "c", goal: "", files: [], startedAt: 0 }])],
    "endpoint",
  );
  assert.equal(
    fleetFeedText(fleet, "s", "/work/s"),
    JSON.stringify({
      piDent: "fleet/1",
      sessionId: "s",
      sessions: [
        {
          sessionId: "s",
          kind: "machine",
          state: "idle",
          cwd: "/work/s",
          turns: [{ command: "c", goal: "", files: [], startedAt: 0 }],
          summary: "c",
        },
      ],
    }),
  );
});
