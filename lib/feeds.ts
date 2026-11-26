/**
 * The feed announcement (specs/task.md#task-feed, specs/fleet-tool.md#fleet-feed): a feed
 * is set only in pi's RPC mode with an interactive host surface, and only when the client
 * announces it with `PI_DENT_FEEDS` set to `1`. The host values are parameters so tests inject them.
 */

export const FEEDS_ENV = "PI_DENT_FEEDS";

/** The host values the gate reads: the environment and the session's context. */
export interface FeedHost {
  env: { readonly [name: string]: string | undefined };
  hasUI: boolean;
  mode: string;
}

/** Whether a session at start announces the feeds (specs/task.md#task-feed). */
export function feedsAnnounced(host: FeedHost): boolean {
  return host.hasUI && host.mode === "rpc" && host.env[FEEDS_ENV] === "1";
}
