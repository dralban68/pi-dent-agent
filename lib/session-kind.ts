/**
 * Session kind classification, environment variable, and system prompt mode line
 * (specs/session-tool.md#session-kind).
 */

export type SessionKind = "user" | "agent";

export const SESSION_KIND_ENV = "PI_DENT_SESSION_KIND";

export const USER_SESSION_MODE_LINE =
  "Session mode: user session (user input is available; run long-running or substantial tools with background: true and end your turn with no tool calls so you do not block user input — never call Task wait when you can simply end your turn, as notifications arrive automatically).";

export const AGENT_SESSION_MODE_LINE =
  "Session mode: agent session (no user input is available; do not ask the user questions or wait for user confirmation — complete the task autonomously or report blockers in your final response; never call Task wait when you can simply end your turn, as ending your turn with no tool calls pauses the session until background tasks finish and delivers their notifications in your next turn).";

/** Classify a main session from whether the host reports a user interface. */
export function sessionKindForMain(hasUI: boolean): SessionKind {
  return hasUI ? "user" : "agent";
}

/** The normative system prompt mode line for a session kind (specs/session-tool.md#prompt-mode). */
export function sessionModeLine(kind: SessionKind): string {
  return kind === "user" ? USER_SESSION_MODE_LINE : AGENT_SESSION_MODE_LINE;
}

/** Append the session mode line as the final part of a system prompt, joined by `"\n\n"`. */
export function appendSessionMode(prompt: string, kind: SessionKind): string {
  const line = sessionModeLine(kind);
  return prompt === "" ? line : `${prompt}\n\n${line}`;
}
