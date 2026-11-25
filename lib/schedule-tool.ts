/**
 * The `Schedule` tool (specs/schedule-tool.md): schedules held in the memory of the
 * process, keyed by session ID (Section 5), fired into the session that created
 * them (Section 4), plus the lifecycle calls the extension's handlers make.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ToolResult } from "./engine.ts";
import { MAX_INSTANT, localStamp, parseDateTime } from "./schedule-time.ts";
import { firstLine, errorMessage, isPlainObject, shortUuid } from "./util.ts";

/**
 * Checks run at most this far apart (Section 4.1): half the bound, so the next check is armed
 * before a whole interval can pass while the previous one runs.
 */
const CHECK_INTERVAL_MS = 500;
/** The `setStatus` key of Section 6. */
export const SCHEDULE_TOOL_NAME = "Schedule";

export const SCHEDULE_UNAVAILABLE_TEXT =
  "Schedule is unavailable: this is an agent session with no user input.";

export const SCHEDULE_STATUS_KEY = "pi-dent-schedule";
/** The `customType` of a scheduled message (Section 4.2). */
export const SCHEDULE_CUSTOM_TYPE = "pi-dent-schedule";
/** A preview is cut to this many characters (Section 3.2). */
const PREVIEW_LENGTH = 120;

/** The `action` values, in schema order. */
export const SCHEDULE_ACTIONS = ["create", "list", "cancel"] as const;

export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];

// Section 1.1: every field but `action` is optional, and a null value counts as
// absent, so a null passes the schema and the checks treat it as absent.
export const scheduleParameterSchema = Type.Object(
  {
    action: StringEnum(SCHEDULE_ACTIONS, {
      description: "The operation to perform.",
    }),
    message: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description: "Required for create: the text to insert when due, kept verbatim.",
      }),
    ),
    delaySeconds: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], {
        description:
          "For create only (exclusive with at; create requires at least one of delaySeconds, at, or everySeconds). First due time as a delay from the call, in seconds: a positive integer.",
      }),
    ),
    at: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "For create only (exclusive with delaySeconds; create requires at least one of delaySeconds, at, or everySeconds). First due time as an RFC 3339 date-time with a time-zone offset.",
      }),
    ),
    everySeconds: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], {
        description:
          "For create only (create requires at least one of delaySeconds, at, or everySeconds). Makes the schedule repeating: the interval between due times, in seconds: a positive integer.",
      }),
    ),
    count: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], {
        description:
          "For create with everySeconds only: the number of occurrences after which the schedule ends: a positive integer.",
      }),
    ),
    scheduleId: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description: "Required for cancel: the schedule ID returned by create.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ScheduleToolParams = Static<typeof scheduleParameterSchema>;

/** A schedule of Section 2.1. */
interface Schedule {
  scheduleId: string;
  message: string;
  createdAt: number;
  dueAt: number;
  everySeconds: number | undefined;
  count: number | undefined;
  occurrences: number;
  queued: boolean;
  /** The due time of the queued occurrence, while `queued`. */
  queuedDueAt: number | undefined;
  /** Creation order within the session, for ties (Section 2.1). */
  order: number;
  /** The `<error>` of the last undelivered hand-off shown (Section 4.2), while pending. */
  deliveryFailure: string | undefined;
}

/** What a session handler supplies to the runtime: the host and UI it may use. */
export interface ScheduleWindow {
  /** Hands one scheduled message to the host `sendMessage` API (Section 4.2). */
  send(message: ScheduledMessage): void;
  /** Sets the status line, or clears it with `undefined` (Section 6). */
  setStatus(text: string | undefined): void;
  /** Shows a notification to the user (Sections 4.2 and 6), through the host `notify` API. */
  notify?(text: string): void;
  /** Whether the session has an interactive terminal UI. */
  interactive: boolean;
  /** Whether an agent run is in progress (Section 4). */
  isRunning(): boolean;
  /** Whether the session is idle (Section 4). */
  isIdle(): boolean;
}

/** One entry of a scheduled message's `details.schedules` (Section 4.2). */
export interface ScheduledOccurrence {
  scheduleId: string;
  createdAt: number;
  dueAt: number;
  occurrence?: number;
}

/** A message handed to the host `sendMessage` API (Section 4.2). */
export interface ScheduledMessage {
  customType: string;
  content: string;
  display: boolean;
  details: { schedules: ScheduledOccurrence[] };
}

/** A clock and one-shot timer, injected so that tests need no real sleeps. */
export interface ScheduleClock {
  now(): number;
  /** Calls `tick` once after `ms`; the returned function cancels the call. */
  after(ms: number, tick: () => void): () => void;
}

/** The schedules of one session. */
export interface ScheduleSession {
  schedules: Schedule[];
  /** The creation order of its next schedule (Section 2.1). */
  order: number;
  window: ScheduleWindow | undefined;
  cancelCheck: (() => void) | undefined;
  /** The `<error>` of the last check failure shown (Section 6), so it is not repeated. */
  checkFailure: string | undefined;
}

/** The schedules of every session of the process (Section 5). */
export interface ScheduleStore {
  sessions: Map<string, ScheduleSession>;
  /** The schedule IDs created in this process, so they stay unique (Section 2.1). */
  ids: Set<string>;
}

export type ScheduleStartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type ScheduleShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface ScheduleRuntime {
  clock: ScheduleClock;
  store: ScheduleStore;
  /** `session_start`: adopt the window and resume checking (Section 5). */
  sessionStart(options: {
    sessionId: string;
    reason: ScheduleStartReason;
    window: ScheduleWindow;
  }): void;
  /** `session_shutdown`: stop checking, and keep the schedules only for a reload (Section 5). */
  sessionShutdown(options: { sessionId: string; reason: ScheduleShutdownReason }): void;
  /** `message_start`: the host inserted a scheduled message, or started someone else's (Section 4.2). */
  messageStarted(options: { sessionId: string; message: unknown }): void;
  /** One `Schedule` call of the session (Sections 1.2, 1.3, and 3). */
  execute(options: {
    sessionId: string;
    params: ScheduleToolParams;
    hasUI?: boolean | undefined;
  }): ToolResult;
}

declare global {
  // The extension module is evaluated again on every reload; this store is not.
  var piDentScheduleStore: ScheduleStore | undefined;
}

export function newScheduleStore(): ScheduleStore {
  return { sessions: new Map(), ids: new Set() };
}

function processStore(): ScheduleStore {
  const existing = globalThis.piDentScheduleStore;
  if (existing !== undefined) return existing;
  const store = newScheduleStore();
  globalThis.piDentScheduleStore = store;
  return store;
}

const systemClock: ScheduleClock = {
  now: () => Date.now(),
  after(ms, tick) {
    const timer = setTimeout(tick, ms);
    return () => clearTimeout(timer);
  },
};

/** A firing, as Sections 2.3 and 4.2 need it after the schedule has moved on. */
interface Firing {
  scheduleId: string;
  createdAt: number;
  dueAt: number;
  message: string;
  everySeconds: number | undefined;
  count: number | undefined;
  /** `occurrences` after this firing, for a repeating schedule. */
  occurrence: number | undefined;
  final: "count" | "late" | undefined;
}

/** What a firing leaves of its schedule, held back until the hand-off succeeds (Section 4.2). */
interface FiringPlan {
  firing: Firing;
  /** The schedule's next due time, or `undefined` when this firing ends it. */
  nextDueAt: number | undefined;
}

/** A due schedule and its planned firing (Section 4.2). */
interface PlannedFiring {
  schedule: Schedule;
  plan: FiringPlan;
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function millisecondsOf(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  return value;
}

/** A positive integer (Section 1.1), or undefined when the value is not one. */
function positiveIntegerOf(value: unknown): number | undefined {
  if (typeof value !== "number") return;
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

function orderedSchedules(schedules: readonly Schedule[]): Schedule[] {
  return schedules.toSorted((left, right) => left.dueAt - right.dueAt || left.order - right.order);
}

/** The first due time of Section 2.1. */
function firstDueAt(
  createdAt: number,
  delaySeconds: number | undefined,
  at: number | undefined,
  everySeconds: number | undefined,
): number {
  if (delaySeconds !== undefined) return createdAt + delaySeconds * 1000;
  if (at !== undefined) return Math.max(at, createdAt);
  return everySeconds === undefined ? createdAt : createdAt + everySeconds * 1000;
}

/** The first due time of the grid later than `now` (Section 2.3, step 3). */
function gridAfter(now: number, dueAt: number, step: number): number {
  return dueAt + step * (Math.floor((now - dueAt) / step) + 1);
}

function finalMarker(final: Firing["final"]): string {
  if (final === "count") return ", final: count reached";
  if (final === "late") return ", final: next due time not representable";
  return "";
}

function envelopeRepeat(firing: Firing): string {
  if (firing.everySeconds === undefined) return "";
  const occurrence = firing.occurrence ?? 0;
  return `; occurrence ${occurrence}, every ${firing.everySeconds} s${finalMarker(firing.final)}`;
}

/** The message envelope of Section 4.2, message verbatim after one line break. */
function envelope(firing: Firing, zone: string): string {
  const head = `[Scheduled message ${firing.scheduleId} — set by you at ${localStamp(firing.createdAt, zone)}, due ${localStamp(firing.dueAt, zone)}${envelopeRepeat(firing)}; not from the user]`;
  return `${head}\n${firing.message}`;
}

function occurrenceOf(firing: Firing): ScheduledOccurrence {
  return {
    scheduleId: firing.scheduleId,
    createdAt: firing.createdAt,
    dueAt: firing.dueAt,
    ...(firing.occurrence === undefined ? {} : { occurrence: firing.occurrence }),
  };
}

function scheduledMessage(firings: readonly Firing[], zone: string): ScheduledMessage {
  return {
    customType: SCHEDULE_CUSTOM_TYPE,
    content: firings.map((firing) => envelope(firing, zone)).join("\n\n"),
    display: true,
    details: { schedules: firings.map(occurrenceOf) },
  };
}

/** `create` repeat clause of Section 3.1. */
function createRepeat(schedule: Schedule): string {
  if (schedule.everySeconds === undefined) return "";
  const base = `, repeating every ${schedule.everySeconds} s`;
  return schedule.count === undefined ? base : `${base} for ${schedule.count} occurrences`;
}

/** `list` repeat clause of Section 3.2. */
function listRepeat(schedule: Schedule): string {
  if (schedule.everySeconds === undefined) return "";
  const occurrences =
    schedule.count === undefined
      ? `${schedule.occurrences} fired`
      : `${schedule.occurrences} fired of ${schedule.count}`;
  const queued = schedule.queued ? " · queued" : "";
  return ` · every ${schedule.everySeconds} s · ${occurrences}${queued}`;
}

function listLine(schedule: Schedule, zone: string): string {
  const preview = firstLine(schedule.message, PREVIEW_LENGTH);
  return `${schedule.scheduleId} · due ${localStamp(schedule.dueAt, zone)}${listRepeat(schedule)} · ${preview}`;
}

/** The status line of Section 6, or undefined with no pending schedule. */
function statusText(schedules: readonly Schedule[], zone: string): string | undefined {
  const pending = orderedSchedules(schedules);
  const first = pending[0];
  if (first === undefined) return;
  const repeating = pending.filter((schedule) => schedule.everySeconds !== undefined).length;
  const clause = repeating === 0 ? "" : ` (${repeating} repeating)`;
  return `schedule: ${pending.length} pending${clause} · next ${localStamp(first.dueAt, zone)}`;
}

function textError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

/** The schedules a message carries in its `details`, if it is a scheduled message (Section 4.2). */
function carriedOccurrences(message: unknown): ScheduledOccurrence[] {
  if (!isPlainObject(message)) return [];
  if (message.role !== "custom" || message.customType !== SCHEDULE_CUSTOM_TYPE) return [];
  if (!isPlainObject(message.details)) return [];
  const entries = message.details.schedules;
  if (!Array.isArray(entries)) return [];
  const found: ScheduledOccurrence[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    const scheduleId = textOf(entry.scheduleId);
    const createdAt = millisecondsOf(entry.createdAt);
    const dueAt = millisecondsOf(entry.dueAt);
    if (scheduleId === undefined || createdAt === undefined || dueAt === undefined) continue;
    found.push({ scheduleId, createdAt, dueAt });
  }
  return found;
}

const FIELD_ORDER = [
  "message",
  "delaySeconds",
  "at",
  "everySeconds",
  "count",
  "scheduleId",
] as const;

const ACCEPTED_FIELDS: Readonly<Record<ScheduleAction, readonly string[]>> = {
  create: ["message", "delaySeconds", "at", "everySeconds", "count"],
  list: [],
  cancel: ["scheduleId"],
};

function fieldValue(params: ScheduleToolParams, field: string): unknown {
  const record: Record<string, unknown> = isPlainObject(params) ? params : {};
  return record[field];
}

function actionOf(params: ScheduleToolParams): ScheduleAction | undefined {
  return SCHEDULE_ACTIONS.find((candidate) => candidate === params.action);
}

export function scheduleRuntime(settings: {
  clock?: ScheduleClock;
  store?: ScheduleStore;
  zone: string;
}): ScheduleRuntime {
  const clock = settings.clock ?? systemClock;
  const store = settings.store ?? processStore();
  // Read once where the extension instance reads it (billing.md Section 5).
  const zone = settings.zone;

  function sessionOf(sessionId: string): ScheduleSession {
    const existing = store.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: ScheduleSession = {
      schedules: [],
      order: 0,
      window: undefined,
      cancelCheck: undefined,
      checkFailure: undefined,
    };
    store.sessions.set(sessionId, created);
    return created;
  }

  function updateStatus(session: ScheduleSession): void {
    const window = session.window;
    if (window === undefined || !window.interactive) return;
    window.setStatus(statusText(session.schedules, zone));
  }

  /**
   * Shows one notification to the user (Sections 4.2 and 6). A host whose `notify` API throws
   * has no channel left: the call or check carries on and no failure is reported (Section 6).
   */
  function notifyUser(session: ScheduleSession, text: string): void {
    try {
      session.window?.notify?.(text);
    } catch {
      // Section 6: the report channel itself failed.
    }
  }

  function removeSchedule(session: ScheduleSession, schedule: Schedule): void {
    const index = session.schedules.indexOf(schedule);
    if (index >= 0) session.schedules.splice(index, 1);
  }

  function stopCheck(session: ScheduleSession): void {
    const cancel = session.cancelCheck;
    session.cancelCheck = undefined;
    if (cancel !== undefined) cancel();
  }

  /** Arms the next check, unless one is armed or nothing is pending (Section 4.1). */
  function scheduleCheck(session: ScheduleSession, delayMs = CHECK_INTERVAL_MS): void {
    if (session.cancelCheck !== undefined) return;
    if (session.window === undefined || session.schedules.length === 0) return;
    session.cancelCheck = clock.after(delayMs, () => check(session));
  }

  function check(session: ScheduleSession): void {
    session.cancelCheck = undefined;
    try {
      runCheck(session);
      session.checkFailure = undefined;
    } catch (error) {
      // A host query the check needs threw: the schedules are untouched, and the failure is
      // shown once (Section 6). The next check reads the live window again.
      reportCheckFailure(session, error);
    }
    try {
      updateStatus(session);
    } catch {
      // Section 6: at a check, no failure is reported when the host `setStatus` API throws.
    } finally {
      scheduleCheck(session);
    }
  }

  /** Section 6: one notification per distinct check failure, and none for a repeated `<error>`. */
  function reportCheckFailure(session: ScheduleSession, error: unknown): void {
    const failure = errorMessage(error);
    if (session.checkFailure === failure) return;
    session.checkFailure = failure;
    notifyUser(session, `pi-dent: schedule check failed: ${failure}`);
  }

  /** Fires and skips the due schedules of Section 4.1, handing one message to the host. */
  function runCheck(session: ScheduleSession): void {
    const window = session.window;
    if (window === undefined) return;
    const running = window.isRunning();
    const idle = window.isIdle();
    if (idle) {
      for (const schedule of session.schedules) {
        schedule.queued = false;
        schedule.queuedDueAt = undefined;
      }
    }
    const fireable = running || idle;
    const now = clock.now();
    const planned: PlannedFiring[] = [];
    for (const schedule of orderedSchedules(session.schedules)) {
      if (schedule.dueAt > now) continue;
      if (schedule.queued && schedule.everySeconds !== undefined) {
        advanceSkipped(session, schedule, now);
        continue;
      }
      if (!fireable) continue;
      // Nothing changes on the schedule until the hand-off succeeds (Section 4.2).
      planned.push({ schedule, plan: planFiring(schedule, now) });
    }
    if (planned.length === 0) return;
    try {
      window.send(
        scheduledMessage(
          planned.map((entry) => entry.plan.firing),
          zone,
        ),
      );
    } catch (error) {
      reportUndelivered(session, planned, errorMessage(error));
      return;
    }
    for (const { schedule, plan } of planned) commitFiring(session, schedule, plan);
  }

  /** Section 4.2: the schedules stay pending, and the user learns that the hand-off failed. */
  function reportUndelivered(
    session: ScheduleSession,
    planned: readonly PlannedFiring[],
    failure: string,
  ): void {
    for (const { schedule } of planned) {
      if (schedule.deliveryFailure === failure) continue;
      schedule.deliveryFailure = failure;
      notifyUser(
        session,
        `pi-dent: schedule ${schedule.scheduleId} was not delivered: ${failure}; it stays pending`,
      );
    }
  }

  /** Section 2.3 step 3 for a skip: the occurrence stays queued. */
  function advanceSkipped(session: ScheduleSession, schedule: Schedule, now: number): void {
    const every = schedule.everySeconds;
    if (every === undefined) return;
    const next = gridAfter(now, schedule.dueAt, every * 1000);
    if (next > MAX_INSTANT) {
      removeSchedule(session, schedule);
      return;
    }
    schedule.dueAt = next;
  }

  /**
   * Section 2.3 for a firing, as the envelope and the schedule's next state need it, without
   * changing the schedule: the hand-off comes first (Section 4.2).
   */
  function planFiring(schedule: Schedule, now: number): FiringPlan {
    const dueAt = schedule.dueAt;
    const occurrences = schedule.occurrences + 1;
    const firing: Firing = {
      scheduleId: schedule.scheduleId,
      createdAt: schedule.createdAt,
      dueAt,
      message: schedule.message,
      everySeconds: schedule.everySeconds,
      count: schedule.count,
      occurrence: undefined,
      final: undefined,
    };
    if (schedule.everySeconds === undefined) return { firing, nextDueAt: undefined };
    firing.occurrence = occurrences;
    if (schedule.count !== undefined && occurrences === schedule.count) {
      firing.final = "count";
      return { firing, nextDueAt: undefined };
    }
    const next = gridAfter(now, dueAt, schedule.everySeconds * 1000);
    if (next > MAX_INSTANT) {
      firing.final = "late";
      return { firing, nextDueAt: undefined };
    }
    return { firing, nextDueAt: next };
  }

  /** Applies a firing whose hand-off the host accepted (Sections 2.3 and 4.2). */
  function commitFiring(session: ScheduleSession, schedule: Schedule, plan: FiringPlan): void {
    schedule.deliveryFailure = undefined;
    schedule.occurrences += 1;
    if (plan.nextDueAt === undefined) {
      removeSchedule(session, schedule);
      return;
    }
    schedule.dueAt = plan.nextDueAt;
    schedule.queued = true;
    schedule.queuedDueAt = plan.firing.dueAt;
  }

  function execute(options: {
    sessionId: string;
    params: ScheduleToolParams;
    hasUI?: boolean | undefined;
  }): ToolResult {
    // Section 1.3: an agent session has no user input, so Schedule is unavailable.
    if (options.hasUI === false) return textError(SCHEDULE_UNAVAILABLE_TEXT);
    const { params } = options;
    const action = actionOf(params);
    if (action === undefined) {
      return textError(`action must be one of ${SCHEDULE_ACTIONS.join(", ")}`);
    }
    const accepted = ACCEPTED_FIELDS[action];
    for (const field of FIELD_ORDER) {
      if (accepted.includes(field)) continue;
      if (isPresent(fieldValue(params, field))) {
        return textError(`${field} is not valid for action ${action}`);
      }
    }
    const session = sessionOf(options.sessionId);
    // Section 6: a failing status call is reported, and neither fails the call nor undoes it.
    const refresh = (): void => {
      try {
        updateStatus(session);
      } catch (error) {
        notifyUser(
          session,
          `pi-dent: schedule status line could not be updated: ${errorMessage(error)}`,
        );
      }
      scheduleCheck(session, 0);
    };
    if (action === "list") return listAction(session);
    if (action === "cancel") return cancelAction(session, params, refresh);
    return createAction({ session, params, clock, store, zone, refresh });
  }

  function listAction(session: ScheduleSession): ToolResult {
    const pending = orderedSchedules(session.schedules);
    const lines = pending.map((schedule) => listLine(schedule, zone));
    return {
      content: [
        { type: "text", text: lines.length === 0 ? "(no pending schedules)" : lines.join("\n") },
      ],
      details: {
        action: "list",
        schedules: pending.map((schedule) => ({
          scheduleId: schedule.scheduleId,
          createdAt: schedule.createdAt,
          dueAt: schedule.dueAt,
          message: schedule.message,
          ...(schedule.everySeconds === undefined ? {} : { everySeconds: schedule.everySeconds }),
          ...(schedule.count === undefined ? {} : { count: schedule.count }),
          occurrences: schedule.occurrences,
          queued: schedule.queued,
        })),
      },
    };
  }

  function cancelAction(
    session: ScheduleSession,
    params: ScheduleToolParams,
    refresh: () => void,
  ): ToolResult {
    const raw = textOf(params.scheduleId);
    const scheduleId = raw === undefined ? undefined : raw.trim();
    if (scheduleId === undefined || scheduleId === "") {
      return textError("scheduleId must be a non-empty string");
    }
    const target = session.schedules.find((schedule) => schedule.scheduleId === scheduleId);
    if (target === undefined) return textError(`no pending schedule "${scheduleId}"`);
    removeSchedule(session, target);
    refresh();
    return {
      content: [{ type: "text", text: `Schedule ${scheduleId} cancelled.` }],
      details: { action: "cancel", scheduleId },
    };
  }

  function sessionStart(options: {
    sessionId: string;
    reason: ScheduleStartReason;
    window: ScheduleWindow;
  }): void {
    const session = sessionOf(options.sessionId);
    if (options.reason !== "reload") session.schedules = [];
    session.window = options.window;
    updateStatus(session);
    scheduleCheck(session, 0);
  }

  function sessionShutdown(options: { sessionId: string; reason: ScheduleShutdownReason }): void {
    const session = store.sessions.get(options.sessionId);
    if (session === undefined) return;
    stopCheck(session);
    const window = session.window;
    if (window !== undefined && window.interactive) {
      try {
        window.setStatus(undefined);
      } catch {
        // The UI is gone already.
      }
    }
    session.window = undefined;
    if (options.reason === "reload") {
      for (const schedule of session.schedules) {
        schedule.queued = false;
        schedule.queuedDueAt = undefined;
      }
      return;
    }
    store.sessions.delete(options.sessionId);
  }

  function messageStarted(options: { sessionId: string; message: unknown }): void {
    const session = store.sessions.get(options.sessionId);
    if (session === undefined) return;
    for (const occurrence of carriedOccurrences(options.message)) {
      for (const schedule of session.schedules) {
        if (schedule.scheduleId !== occurrence.scheduleId) continue;
        if (!schedule.queued || schedule.queuedDueAt !== occurrence.dueAt) continue;
        schedule.queued = false;
        schedule.queuedDueAt = undefined;
      }
    }
  }

  return { clock, store, sessionStart, sessionShutdown, messageStarted, execute };
}

function createAction(options: {
  session: ScheduleSession;
  params: ScheduleToolParams;
  clock: ScheduleClock;
  store: ScheduleStore;
  zone: string;
  refresh: () => void;
}): ToolResult {
  const { session, params } = options;
  const message = textOf(params.message);
  if (message === undefined || message.trim() === "") {
    return textError("message must be a non-empty string");
  }
  const hasDelay = isPresent(params.delaySeconds);
  const hasAt = isPresent(params.at);
  const hasEvery = isPresent(params.everySeconds);
  if (hasDelay && hasAt) return textError("create accepts at most one of delaySeconds or at");
  if (!hasDelay && !hasAt && !hasEvery) {
    return textError("create requires delaySeconds, at, or everySeconds");
  }
  const delaySeconds = hasDelay ? positiveIntegerOf(params.delaySeconds) : undefined;
  if (hasDelay && delaySeconds === undefined) {
    return textError("delaySeconds must be a positive integer");
  }
  const atText = hasAt ? textOf(params.at) : undefined;
  const at = atText === undefined ? undefined : parseDateTime(atText);
  if (hasAt && at === undefined) {
    return textError("at must be an RFC 3339 date-time with a time-zone offset");
  }
  const everySeconds = hasEvery ? positiveIntegerOf(params.everySeconds) : undefined;
  if (hasEvery && everySeconds === undefined) {
    return textError("everySeconds must be a positive integer");
  }
  const hasCount = isPresent(params.count);
  if (hasCount && !hasEvery) return textError("count requires everySeconds");
  const count = hasCount ? positiveIntegerOf(params.count) : undefined;
  if (hasCount && count === undefined) return textError("count must be a positive integer");

  const createdAt = options.clock.now();
  const dueAt = firstDueAt(createdAt, delaySeconds, at, everySeconds);
  if (dueAt > MAX_INSTANT) return textError("due time is not representable");

  const schedule: Schedule = {
    scheduleId: newScheduleId(options.store),
    message,
    createdAt,
    dueAt,
    everySeconds,
    count,
    occurrences: 0,
    queued: false,
    queuedDueAt: undefined,
    order: session.order,
    deliveryFailure: undefined,
  };
  session.order += 1;
  session.schedules.push(schedule);
  options.refresh();
  return {
    content: [
      {
        type: "text",
        text: `Schedule ${schedule.scheduleId} created at ${localStamp(createdAt, options.zone)}, due ${localStamp(dueAt, options.zone)}${createRepeat(schedule)}; its message will be inserted into this session when due, queued as a follow-up if an agent run is in progress.`,
      },
    ],
    details: {
      action: "create",
      scheduleId: schedule.scheduleId,
      createdAt,
      dueAt,
      ...(everySeconds === undefined ? {} : { everySeconds }),
      ...(count === undefined ? {} : { count }),
    },
  };
}

function newScheduleId(store: ScheduleStore): string {
  let id = shortUuid();
  while (store.ids.has(id)) id = shortUuid();
  store.ids.add(id);
  return id;
}

export function makeScheduleTool(runtime: ScheduleRuntime) {
  return defineTool({
    name: "Schedule",
    label: "Schedule",
    description:
      "Insert a message into this same session when it is due: queued as a follow-up when an agent run is in progress, else starting one. A schedule fires once unless `everySeconds` makes it repeat; a repeating schedule ends at its `count` or on `cancel`, and pending schedules end with the session. `create` one with `message` and one of `delaySeconds`, `at`, or `everySeconds` (with optional `count`), `list` this session's pending schedules, or `cancel` one by `scheduleId`.",
    promptSnippet: "Schedule: insert a message into this session later, once or repeatedly.",
    parameters: scheduleParameterSchema,
    async execute(
      _toolCallId: string,
      params: ScheduleToolParams,
      _signal: AbortSignal | undefined,
      _onUpdate: ((partial: ToolResult) => void) | undefined,
      ctx: ExtensionToolContext,
    ): Promise<ToolResult> {
      return runtime.execute({
        sessionId: ctx.sessionManager.getSessionId(),
        params,
        hasUI: ctx.hasUI,
      });
    },
  });
}
