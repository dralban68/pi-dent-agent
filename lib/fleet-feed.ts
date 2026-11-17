import { fleetListSession, type FleetCoordinator, type FleetSessionRecord } from "./fleet.ts";
import type { FeedHandle, FeedWidgetHost } from "./task-feed.ts";

/**
 * Fleet feed (specs/fleet-tool.md Section 6): a machine-scope `list` as one JSON widget line
 * for an RPC client, computed at start and every 5 seconds, set only when its text changes.
 * Reading it is not a `Fleet` call and changes no fleet state.
 */

export const FLEET_WIDGET_ID = "pi-dent-fleet";
export const FLEET_FEED_INTERVAL_MS = 5000;

/** The fleet reads the feed needs: the machine listing and the caller's identity. */
export type FeedFleet = Pick<FleetCoordinator, "listSessions" | "classifyCaller">;

/** The timer the boot window's feed runs on; tests inject a fake. */
export interface FleetFeedTimers {
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export const systemFleetFeedTimers: FleetFeedTimers = {
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    handle.unref();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle);
  },
};

/** `summary` of a feed session (fleet-tool.md Section 6): goal, else command, else `null`. */
export function fleetFeedSummary(session: FleetSessionRecord): string | null {
  const last = session.turns[session.turns.length - 1];
  return last?.goal || last?.command || null;
}

/** The fleet feed's JSON text (fleet-tool.md Section 6): the machine `list` plus `summary`. */
export function fleetFeedText(fleet: FeedFleet, sessionId: string, cwd: string): string {
  const sessions = fleet
    .listSessions("machine", cwd)
    .map((session) => ({ ...fleetListSession(session), summary: fleetFeedSummary(session) }));
  return JSON.stringify({ piDent: "fleet/1", sessionId, sessions });
}

/** Whether the session is a member of the fleet with a live session identity (fleet-tool.md Section 6). */
function isFleetMember(fleet: FeedFleet, sessionId: string): boolean {
  if (sessionId === "") return false;
  try {
    return fleet.classifyCaller(sessionId) === "endpoint";
  } catch {
    return false;
  }
}

/**
 * Starts the fleet feed of a session at its start (fleet-tool.md Section 6). Without a live
 * identity it starts nothing. Its timer belongs to the returned handle: `stop` ends it and
 * clears the widget. Failures compute nothing and leave the widget as it is.
 */
export function startFleetFeed(options: {
  fleet: FeedFleet;
  sessionId: string;
  cwd: string;
  host: FeedWidgetHost;
  timers?: FleetFeedTimers;
}): FeedHandle {
  const { fleet, sessionId, cwd, host } = options;
  const timers = options.timers ?? systemFleetFeedTimers;
  if (!isFleetMember(fleet, sessionId)) return { stop() {} };

  let last: string | undefined;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    let text: string;
    try {
      text = fleetFeedText(fleet, sessionId, cwd);
    } catch {
      return;
    }
    if (text === last) return;
    try {
      host.setWidget(FLEET_WIDGET_ID, [text]);
      last = text;
    } catch {
      // The UI may already be gone; the next tick tries again.
    }
  };

  const timer = timers.setInterval(tick, FLEET_FEED_INTERVAL_MS);
  tick();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(timer);
      if (last === undefined) return;
      last = undefined;
      try {
        host.setWidget(FLEET_WIDGET_ID, undefined);
      } catch {
        // The UI may already be gone at shutdown.
      }
    },
  };
}
