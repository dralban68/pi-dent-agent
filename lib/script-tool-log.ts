import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, safeName } from "./util.ts";

/**
 * The tool log of a `Script` run (specs/script-tool.md Section 10.4): a session file in the
 * invoking session's agent directory recording the run's source and every nested call, so that
 * `Search` reads it as a member of the session tree. Lines are appended synchronously, in event
 * order; a write failure is reported once on the run's stderr and ends the log.
 */

/** The tool log of `taskId` in `agentDir`: `<agentDir>/script-<safeTaskId>.jsonl`. */
export function toolLogPathFor(agentDir: string, taskId: string): string {
  return join(agentDir, `script-${safeName(taskId)}.jsonl`);
}

/** The outcome of a nested call as the host returned it. */
export interface LoggedOutcome {
  content: unknown;
  details?: unknown;
  isError: boolean;
}

export interface ToolLogOptions {
  agentDir: string;
  taskId: string;
  /** The run's resolved `cwd`. */
  cwd: string;
  /** The row's `code`. */
  source: string;
  /** The run's start, in ms since the epoch. */
  runStart: () => number;
  /** Append one line to the run's stderr. */
  reportFailure: (line: string) => void;
  now?: () => number;
}

const ABORTED_CONTENT = [{ type: "text", text: "aborted: the script run settled" }];

export class ScriptToolLog {
  readonly path: string;
  /** Nested calls started, whether or not the log could be written. */
  calls = 0;
  private readonly options: ToolLogOptions;
  private state: "none" | "open" | "failed" = "none";
  private created = false;
  private entries = 0;
  private lastId: string | null = null;
  /** Calls started and not yet logged as settled: call ID to tool name. */
  private readonly open = new Map<string, string>();

  constructor(options: ToolLogOptions) {
    this.options = options;
    this.path = toolLogPathFor(options.agentDir, options.taskId);
  }

  /** The path for `details.toolLogPath`: present exactly when the log was created. */
  get createdPath(): string | undefined {
    return this.created ? this.path : undefined;
  }

  /** Record the start of a nested call, creating the log at the first; returns its call ID. */
  start(name: string, args: unknown): string {
    this.calls++;
    const callId = `call-${this.calls}`;
    this.open.set(callId, name);
    if (this.state === "none") this.create();
    this.append({
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name, arguments: args }],
    });
    return callId;
  }

  /** Record a nested call's settlement; a call already logged as settled is left alone. */
  settle(callId: string, outcome: LoggedOutcome): void {
    const name = this.open.get(callId);
    if (name === undefined) return;
    this.open.delete(callId);
    this.append({
      role: "toolResult",
      toolCallId: callId,
      toolName: name,
      content: outcome.content,
      details: outcome.details,
      isError: outcome.isError,
    });
  }

  /** Record a call still running when the run settles as aborted at this moment. */
  abort(callId: string): void {
    this.settle(callId, { content: ABORTED_CONTENT, isError: true });
  }

  private timestamp(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }

  private create(): void {
    const { agentDir, taskId, cwd, source, runStart } = this.options;
    const header = {
      type: "session",
      id: taskId,
      timestamp: new Date(runStart()).toISOString(),
      cwd,
    };
    try {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(this.path, `${JSON.stringify(header)}\n`);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.created = true;
    this.state = "open";
    this.append({ role: "user", content: source });
  }

  private append(message: Record<string, unknown>): void {
    if (this.state !== "open") return;
    const id = `entry-${this.entries + 1}`;
    const entry = {
      type: "message",
      id,
      parentId: this.lastId,
      timestamp: this.timestamp(),
      message,
    };
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.entries++;
    this.lastId = id;
  }

  private fail(error: unknown): void {
    this.state = "failed";
    this.options.reportFailure(`pi-dent: tool log write failed: ${errorMessage(error)}`);
  }
}
