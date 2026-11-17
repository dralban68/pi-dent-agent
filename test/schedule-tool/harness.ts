import assert from "node:assert/strict";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { ToolResult } from "../../lib/engine.ts";
import {
  makeScheduleTool,
  newScheduleStore,
  scheduleRuntime,
  type ScheduleClock,
  type ScheduledMessage,
  type ScheduleRuntime,
  type ScheduleStore,
  type ScheduleToolParams,
  type ScheduleWindow,
} from "../../lib/schedule-tool.ts";
import { must } from "../support/must.ts";

export const SESSION = "session-1";
export const START = 1_700_000_000_000;
/** The local zone every fixture runtime renders in (billing.md Section 5). */
export const ZONE = "UTC";

interface Timer {
  at: number;
  tick: () => void;
  cancelled: boolean;
}

/** An injected clock and timer: time moves only when a test advances it. */
export function fakeClock(start = START) {
  let now = start;
  const timers: Timer[] = [];
  const clock: ScheduleClock = {
    now: () => now,
    after(ms, tick) {
      const timer: Timer = { at: now + ms, tick, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  function advance(ms: number): void {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((timer) => !timer.cancelled && timer.at <= target);
      if (due.length === 0) break;
      const next = must(due.reduce((left, right) => (right.at < left.at ? right : left)));
      timers.splice(timers.indexOf(next), 1);
      if (next.at > now) now = next.at;
      next.tick();
    }
    if (target > now) now = target;
  }
  return {
    clock,
    advance,
    now: () => now,
    armed: () => timers.filter((t) => !t.cancelled).length,
    /** The delay until the earliest armed timer fires, or none. */
    nextDelay: (): number | undefined => {
      const armed = timers.filter((timer) => !timer.cancelled);
      if (armed.length === 0) return undefined;
      return Math.min(...armed.map((timer) => timer.at)) - now;
    },
  };
}

export interface Flags {
  running: boolean;
  idle: boolean;
  interactive: boolean;
}

/** An injected session window: it records hand-offs, status lines, and notifications. */
export function fakeWindow(flags: Partial<Flags> = {}) {
  const state: Flags = { running: false, idle: true, interactive: true, ...flags };
  const sent: ScheduledMessage[] = [];
  const statuses: (string | undefined)[] = [];
  const notices: string[] = [];
  const window: ScheduleWindow = {
    send: (message) => {
      sent.push(message);
    },
    setStatus: (text) => {
      statuses.push(text);
    },
    notify: (text) => {
      notices.push(text);
    },
    get interactive() {
      return state.interactive;
    },
    isRunning: () => state.running,
    isIdle: () => state.idle,
  };
  const status = (): string | undefined => statuses.at(-1);
  return { window, state, sent, statuses, notices, status };
}

export function fixture(flags: Partial<Flags> = {}, start = START) {
  const clock = fakeClock(start);
  const store: ScheduleStore = newScheduleStore();
  const runtime: ScheduleRuntime = scheduleRuntime({ clock: clock.clock, store, zone: ZONE });
  const host = fakeWindow(flags);
  runtime.sessionStart({ sessionId: SESSION, reason: "startup", window: host.window });
  const tool = makeScheduleTool(runtime);
  const call = (params: Record<string, unknown>): ToolResult =>
    runtime.execute({ sessionId: SESSION, params: params as ScheduleToolParams });
  const callIn = (sessionId: string, params: Record<string, unknown>): ToolResult =>
    runtime.execute({ sessionId, params: params as ScheduleToolParams });
  return { clock, store, runtime, host, tool, call, callIn };
}

export type Fixture = ReturnType<typeof fixture>;

/** The agent message the host builds from a hand-off, for `message_start`. */
export function inserted(message: ScheduledMessage) {
  return {
    role: "custom",
    customType: message.customType,
    content: message.content,
    display: message.display,
    details: message.details,
    timestamp: 0,
  };
}

/** A tool context that reports the session ID a call arrives in. */
export function toolContext(sessionId = SESSION): ExtensionToolContext {
  return { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionToolContext;
}

/** The single text block of a result. */
export function textOf(result: ToolResult): string {
  assert.equal(result.content.length, 1);
  const block = must(result.content[0]);
  assert.equal(block.type, "text");
  if (block.type !== "text") throw new Error("the result holds no text");
  return block.text;
}

/** The details of a `list` result. */
export function listed(result: ToolResult): Record<string, unknown>[] {
  const details = result.details.schedules;
  assert.ok(Array.isArray(details));
  return details as Record<string, unknown>[];
}
