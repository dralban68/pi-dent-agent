import type { Api } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "./model-string.ts";

/** Compaction settings shape used for child inheritance (pi `CompactionSettings` subset). */
export interface CompactionSettings {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

/**
 * One tool of a session's complete configured inventory; the engine reads its name
 * and file source path (agent-tool.md Section 3.1).
 */
export interface HostToolInfo {
  readonly name: string;
  readonly sourceInfo?: { readonly path?: string | undefined } | undefined;
}

/**
 * The dispatching ("main") session as seen by the engine: the host extension
 * context for top-level dispatches, the child AgentSession for nested ones.
 */
export interface HostSession {
  cwd(): string;
  sessionId(): string;
  sessionFile(): string | undefined;
  /** Directory of the session file (default session dir when not persisted). */
  sessionDir(): string;
  model(): { provider: string; id: string } | undefined;
  thinking(): ThinkingLevel | undefined;
  /** Live active tool set, in session order (the tool cap). */
  activeTools(): string[];
  /**
   * Every configured tool of the session, active or inactive, in inventory
   * order (agent-tool.md Section 3.1); absent when the host exposes none.
   */
  allTools?(): readonly HostToolInfo[];
  /** The host pi runtime's registered model list. */
  inventory(): readonly Model<Api>[];
  /**
   * The configured model list the guidance message is computed from
   * (specs/model-guidance.md Section 2): only models whose provider has
   * authentication configured.
   */
  configuredModels(): readonly Model<Api>[] | undefined;
  contextWindow(): number | undefined;
  /** Effective compaction settings for the session's cwd (undefined when unknown). */
  compaction(): CompactionSettings | undefined;
  notify(message: string): void;
  /**
   * Warn without starting a model turn: the main session's UI (stderr without a
   * UI), or a displayed message in a child (agent-tool.md Section 3.1). Absent
   * on a host that predates the channel, which falls back to `notify`.
   */
  warn?(message: string): void;
}
