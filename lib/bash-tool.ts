import { spawn, type ChildProcess } from "node:child_process";
import { ledgerDispatched } from "./task-ledger-wiring.ts";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SettingsManager, defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ToolResult } from "./engine.ts";
import type { HostSession } from "./host.ts";
import type { BashTaskRow, TaskRegistry } from "./registry.ts";
import { resolveCwdParam } from "./cwd-param.ts";
import { ensureOutputDir, outputPathsFor } from "./output-file.ts";
import { renderCardCall } from "./tool-card.ts";
import {
  LINE_CHARACTERS,
  killTreeWindows,
  labelFallback,
  omissionNote,
  pointCount,
  prefixPoints,
  rejectCall,
  renderToolCardResult,
  settleBackgroundFailure,
  signalGroup,
  textError,
} from "./tool-common.ts";
import { applySessionTmp } from "./session-tmp.ts";
import { errorMessage } from "./util.ts";

/**
 * The Bash tool (specs/bash-tool.md): a shell command run as a task, in the
 * foreground or in the background, with captured output, bounded excerpts,
 * timeout, kill and abort. Replaces pi's built-in `bash`, which pi-dent disables.
 */

/** Lines an excerpt shows at most: the line bound (specs/bash-tool.md#output-capture). */
const EXCERPT_LINE_BOUND = 50;
/** Code points of line text an excerpt may retain in total (specs/bash-tool.md#output-capture). */
const EXCERPT_BUDGET = 4000;
/** Largest `setTimeout` delay in ms; a larger `timeout` imposes no timeout (specs/bash-tool.md#parameter-schema). */
const MAX_TIMEOUT_MS = 2147483647;
/** The timeout of a foreground call that omits `timeout` (specs/bash-tool.md#parameter-schema). */
export const DEFAULT_TIMEOUT_MS = 600000;
/** Delay between SIGTERM and SIGKILL of the process group (specs/bash-tool.md#timeout-delivery: 200-300 ms). */
const KILL_GRACE_MS = 250;
/** The run ends at most this long after the shell exits, pipes still open (specs/bash-tool.md#execution-model). */
const PIPE_GRACE_MS = 1000;
/** Partial-result report interval for a foreground call (specs/bash-tool.md#output-capture: within 1000 ms). */
const PARTIAL_INTERVAL_MS = 150;

const LEFTOVER_NOTICE =
  "Command left a process running; it was terminated. Use background: true, not & or nohup.";
/** The body line of a filter-piped call (specs/bash-tool.md#result-contract). */
const PIPE_NOTICE =
  "Note: the saved output holds only what the final pipe printed; rerun without the pipe to keep it all.";
const REDIRECT_NOTICE =
  "Note: output redirected to a file is not shown or saved by Bash; run the command plainly to have its output saved for Read or rg.";
/** The pipeline stages that make a call filter-piped (specs/bash-tool.md#result-contract). */
const FILTER_STAGES = ["head", "tail", "grep"] as const;

export const bashParameterSchema = Type.Object(
  {
    command: Type.String({
      pattern: "\\S",
      description: `Shell command text: one line or several, passed to the shell unchanged. Its output is captured to a file by default: do not cut it with \`| tail\`, \`| head\` or \`| grep\`. At least one character that is not white space.`,
    }),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Per-call timeout in milliseconds, `1` or more; above 2147483647 imposes no timeout. Omitted gives a foreground call 600000 ms and imposes no timeout on a background call.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Working directory of the shell. Relative values resolve against the invoking session's working directory, which is the default.",
      }),
    ),
    background: Type.Optional(
      Type.Boolean({ description: "Background delivery (default `false`)." }),
    ),
    description: Type.Optional(Type.String({ description: "UI label for the call." })),
  },
  { additionalProperties: false },
);
export type BashToolParams = Static<typeof bashParameterSchema>;

export interface BashToolDeps {
  registry: () => TaskRegistry;
  hostProvider: () => HostSession | undefined;
  cohortFor: (toolCallId: string) => string;
  /**
   * The agent directory of the session that invokes the task (specs/agent-tool.md#child-session); the output file goes under its `output/` (specs/script-tool.md#timeout-delivery).
   */
  agentDir: (host: HostSession) => string;
  /** Extra environment variables for the shell, merged over the built environment. */
  extraEnv?: () => Record<string, string> | undefined;
  /**
   * The host settings the call reads (specs/bash-tool.md#execution-model), `readBashSettings` bound to the boot window's
   * reporter: a settings file that cannot be read is reported there, so the read cannot be silent.
   */
  settings: (cwd: string) => BashSettings;
}

/** The two host settings Bash reads at each call (specs/bash-tool.md#execution-model). */
export interface BashSettings {
  shellPath?: string | undefined;
  shellCommandPrefix?: string | undefined;
}

/**
 * The settings files read, and their failures reported (specs/bash-tool.md#execution-model): a file that cannot
 * be read or parsed contributes neither setting and is passed to `report` once per file
 * in `reported`, so one boot window reports each file once. The message is
 * `<file>: <error>`; the reporting layer prefixes `pi-dent: `.
 */
export function readBashSettings(
  cwd: string,
  report: (message: string) => void,
  reported: Set<string>,
): BashSettings {
  const manager = SettingsManager.create(cwd, getAgentDir());
  const failures = manager.drainErrors();
  const settings = manager.getSettings();
  for (const failure of failures) {
    const file = failure.path ?? `${failure.scope} settings`;
    if (reported.has(file)) continue;
    reported.add(file);
    report(`${file}: ${failure.error.message}`);
  }
  return { shellPath: settings.shellPath, shellCommandPrefix: settings.shellCommandPrefix };
}

function expandHome(path: string): string {
  const home = homedir();
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith(`~${sep}`)) return join(home, path.slice(2));
  return path;
}

/** First existing `name` in the host process PATH (specs/bash-tool.md#execution-model). */
export function findOnPath(name: string): string | undefined {
  const env = process.env;
  const key =
    process.platform === "win32"
      ? Object.keys(env).find((entry) => entry.toUpperCase() === "PATH")
      : "PATH";
  const value = key === undefined ? undefined : env[key];
  if (value === undefined) return undefined;
  for (const entry of value.split(delimiter)) {
    if (entry === "") continue;
    const candidate = join(entry, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The platform view shell resolution reads (specs/bash-tool.md#execution-model); tests inject it. */
export interface ShellLookup {
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
  find: (name: string) => string | undefined;
  env: NodeJS.ProcessEnv;
}

/** Shell resolution (specs/bash-tool.md#execution-model): the configured path, else the platform defaults. */
export function resolveShell(settings: BashSettings): { path: string } | { error: string } {
  return resolveShellIn(settings, {
    platform: process.platform,
    exists: existsSync,
    find: findOnPath,
    env: process.env,
  });
}

export function resolveShellIn(
  settings: BashSettings,
  lookup: ShellLookup,
): { path: string } | { error: string } {
  const configured = typeof settings.shellPath === "string" ? settings.shellPath : undefined;
  if (configured !== undefined && configured !== "") {
    const expanded = expandHome(configured);
    if (lookup.exists(expanded)) return { path: expanded };
    return { error: `shell not found: ${expanded}` };
  }
  if (lookup.platform === "win32") {
    const roots = [lookup.env.ProgramFiles, lookup.env["ProgramFiles(x86)"]];
    for (const root of roots) {
      if (root === undefined || root === "") continue;
      const candidate = join(root, "Git", "bin", "bash.exe");
      if (lookup.exists(candidate)) return { path: candidate };
    }
    const found = lookup.find("bash.exe");
    if (found !== undefined) return { path: found };
    return { error: "shell not found: bash.exe" };
  }
  if (lookup.exists("/bin/bash")) return { path: "/bin/bash" };
  const bash = lookup.find("bash");
  if (bash !== undefined) return { path: bash };
  // The list ends with `sh`: off Windows a shell always resolves, and a `sh`
  // that is nowhere becomes a spawn failure rather than a rejection.
  return { path: lookup.find("sh") ?? "sh" };
}

/** The shell environment (specs/bash-tool.md#execution-model). */
export function buildBashEnv(
  host: HostSession,
  extraEnv?: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const binaryDir = join(getAgentDir(), "bin");
  const pathKey =
    process.platform === "win32"
      ? (Object.keys(env).find((entry) => entry.toUpperCase() === "PATH") ?? "Path")
      : "PATH";
  const existing = env[pathKey];
  const entries = existing === undefined || existing === "" ? [] : existing.split(delimiter);
  if (!entries.includes(binaryDir)) env[pathKey] = [binaryDir, ...entries].join(delimiter);

  const model = host.model();
  setOrDelete(env, "PI_DENT_SESSION_DIR", process.env.PI_DENT_SESSION_DIR);
  setOrDelete(env, "PI_DENT_SESSION_KIND", process.env.PI_DENT_SESSION_KIND);
  setOrDelete(env, "PI_SESSION_ID", host.sessionId());
  setOrDelete(env, "PI_SESSION_FILE", host.sessionFile());
  setOrDelete(env, "PI_PROVIDER", model?.provider);
  setOrDelete(env, "PI_MODEL", model?.id);
  setOrDelete(env, "PI_REASONING_LEVEL", host.thinking());
  if (extraEnv !== undefined) Object.assign(env, extraEnv);
  applySessionTmp(env, extraEnv);
  return env;
}

function setOrDelete(env: NodeJS.ProcessEnv, name: string, value: string | undefined): void {
  if (value === undefined || value === "") delete env[name];
  else env[name] = value;
}

interface ShownLine {
  /** The first 500 code points, for progress entries. */
  head: string;
  /** The last 501 code points: a cut keeps 500 after its final `\r` is dropped. */
  end: string;
  count: number;
  /** Whether the line ends in `\r`, which display drops (specs/bash-tool.md#output-capture). */
  endsCR: boolean;
}

/** The display code points of a line: its count without a final `\r` (specs/bash-tool.md#output-capture). */
function displayCount(line: ShownLine): number {
  return line.count - (line.endsCR ? 1 : 0);
}

function suffixPoints(text: string, limit: number): string {
  let start = text.length;
  for (let count = 0; count < limit && start > 0; count += 1) {
    start -= 1;
    const low = text.charCodeAt(start);
    const high = text.charCodeAt(start - 1);
    if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) start -= 1;
  }
  // Copy only the bounded suffix so its backing store cannot retain the input chunk.
  const points: string[] = [];
  for (const point of text.slice(start)) points.push(point);
  return points.join("");
}

/** The index of the last top-level `|` in `command`, or `-1` when it has none (specs/bash-tool.md#result-contract). */
function lastTopLevelPipe(command: string): number {
  let quote: "'" | '"' | undefined;
  let last = -1;
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    // Outside single quotes a backslash escapes the character after it.
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "|") {
      // `||` is one or-list operator, not a pipe.
      if (command.charAt(index + 1) === "|") index += 1;
      else last = index;
    }
  }
  return last;
}

/** Whether the call is filter-piped: a head, tail, or grep stage after the last top-level `|` (specs/bash-tool.md#result-contract). */
export function isFilterPiped(command: string): boolean {
  const pipe = lastTopLevelPipe(command);
  if (pipe < 0) return false;
  const stage = command.slice(pipe + 1).trimStart();
  return FILTER_STAGES.some(
    (name) => stage.startsWith(name) && !/[A-Za-z0-9_]/.test(stage.charAt(name.length)),
  );
}

interface FileRedirection {
  redirected: boolean;
  stdout: boolean;
}

/** Whether a top-level trailing redirection sends output to a file (specs/bash-tool.md#result-contract). */
export function fileRedirection(command: string): FileRedirection {
  const text = command.trimEnd();
  let quote: "'" | '"' | undefined;
  const operators: { start: number; end: number; target: string; stdout: boolean }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quote === "'") {
      if (c === "'") quote = undefined;
      continue;
    }
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    const redirectStart = i;
    let start = i;
    let fd: string | undefined;
    if (/\d/.test(c) && (text.charAt(i + 1) === ">" || text.charAt(i + 1) === "&")) {
      fd = c;
      start += 1;
    }
    if (
      text.charAt(start) === ">" &&
      text.charAt(start + 1) === "&" &&
      /\d/.test(text.charAt(start + 2))
    ) {
      const end = start + 3;
      operators.push({
        start: redirectStart,
        end,
        target: `&${text.charAt(start + 2)}`,
        stdout: fd === undefined || fd === "1",
      });
      i = end - 1;
      continue;
    }
    const suffix = text.slice(start);
    const op = ["&>>", ">>", ">|", "&>", ">"].find((candidate) => suffix.startsWith(candidate));
    if (op === undefined) continue;
    let targetStart = start + op.length;
    while (/\s/.test(text.charAt(targetStart))) targetStart += 1;
    let end = targetStart;
    const q = text.charAt(targetStart);
    let target: string;
    if (q === "'" || q === '"') {
      end += 1;
      while (end < text.length && text.charAt(end) !== q) end += 1;
      target = text.slice(targetStart + 1, end);
      if (text.charAt(end) === q) end += 1;
    } else {
      while (end < text.length && !/[\s;&|]/.test(text.charAt(end))) end += 1;
      target = text.slice(targetStart, end);
    }
    if (target !== "")
      operators.push({
        start: redirectStart,
        end,
        target,
        stdout: fd === undefined || fd === "1" || op.startsWith("&"),
      });
    i = Math.max(i, end - 1);
  }
  let end = text.length;
  const trailing: typeof operators = [];
  for (let index = operators.length - 1; index >= 0; index -= 1) {
    const redirect = operators[index];
    if (redirect === undefined || text.slice(redirect.end, end).trim() !== "") break;
    trailing.unshift(redirect);
    end = redirect.start;
  }
  const files = trailing.filter(({ target }) => target !== "/dev/null" && !/^&\d+$/.test(target));
  return { redirected: files.length > 0, stdout: files.some(({ stdout }) => stdout) };
}

/** A progress entry: the first code points of the line's display text (specs/bash-tool.md#output-capture). */
function progressLine(line: ShownLine): string {
  const count = line.endsCR ? line.count - 1 : line.count;
  const head = line.endsCR && line.count <= LINE_CHARACTERS ? line.head.slice(0, -1) : line.head;
  return head + (count > LINE_CHARACTERS ? omissionNote(count - LINE_CHARACTERS) : "");
}

/** The header line of a truncated excerpt (specs/bash-tool.md#output-capture). */
function headerLine(
  total: number,
  shown: number,
  cut: number,
  bytes: number,
  path: string,
): string {
  const omitted = total - shown;
  const tail = `; full output: ${path}. Search it with rg or Read it.]`;
  const cutNote = `long lines cut to their last ${LINE_CHARACTERS} characters`;
  if (omitted === 0) {
    const noun = total === 1 ? "line" : "lines";
    return `[The output's end is shown (${total} ${noun}, ${bytes} bytes), ${cutNote}${tail}`;
  }
  const range = omitted === 1 ? `Line 1 of ${total}` : `Lines 1–${omitted} of ${total}`;
  return `[${range} not shown${cut === 0 ? "" : `, ${cutNote}`}${tail}`;
}

/**
 * The captured output's excerpt state and capped progress lines (specs/bash-tool.md#output-capture). Each
 * `append` takes whole code points, as a `StringDecoder` emits them: a surrogate pair
 * split between two calls would be counted, and could be cut, as two characters.
 */
export class CapturedOutput {
  private readonly last: ShownLine[] = [];
  private current: ShownLine = { head: "", end: "", count: 0, endsCR: false };
  private complete = 0;
  /** Raw bytes received from both pipes, as the saved file holds them (specs/bash-tool.md#output-capture). */
  private received = 0;

  append(text: string, bytes: number): string[] {
    this.received += bytes;
    const lines: string[] = [];
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline < 0 ? text.length : newline;
      this.grow(text.slice(start, end));
      if (newline < 0) break;
      const shown = this.current;
      this.last.push(shown);
      if (this.last.length > EXCERPT_LINE_BOUND) this.last.shift();
      this.complete += 1;
      lines.push(progressLine(shown));
      this.current = { head: "", end: "", count: 0, endsCR: false };
      start = newline + 1;
    }
    return lines;
  }

  private grow(text: string): void {
    if (text === "") return;
    const count = pointCount(text);
    const room = Math.max(0, LINE_CHARACTERS - this.current.count);
    if (room > 0) this.current.head += prefixPoints(text, room);
    this.current.end = suffixPoints(
      this.current.end + suffixPoints(text, LINE_CHARACTERS + 1),
      LINE_CHARACTERS + 1,
    );
    this.current.count += count;
    this.current.endsCR = text.endsWith("\r");
  }

  pending(): string | undefined {
    return this.current.count === 0 ? undefined : progressLine(this.current);
  }

  lineCount(): number {
    return this.complete + (this.current.count === 0 ? 0 : 1);
  }

  excerpt(outputPath?: string): { text: string; truncated: boolean } {
    const total = this.lineCount();
    const candidates = [...this.last, ...(this.current.count === 0 ? [] : [this.current])];
    // Tail (specs/bash-tool.md#output-capture): the last lines, within the line bound and the character budget.
    const lines: ShownLine[] = [];
    let budget = 0;
    for (let i = candidates.length - 1; i >= 0 && lines.length < EXCERPT_LINE_BOUND; i -= 1) {
      const line = candidates[i];
      if (line === undefined) break;
      const retained = Math.min(displayCount(line), LINE_CHARACTERS);
      if (lines.length > 0 && budget + retained > EXCERPT_BUDGET) break;
      lines.unshift(line);
      budget += retained;
    }
    const omitted = total - lines.length;
    const cut = lines.filter((line) => displayCount(line) > LINE_CHARACTERS).length;
    const truncated = omitted > 0 || cut > 0;
    const header =
      truncated && outputPath !== undefined
        ? `${headerLine(total, lines.length, cut, this.received, outputPath)}\n`
        : "";
    const body = lines
      .map((line) => {
        const size = displayCount(line);
        if (size <= LINE_CHARACTERS) return prefixPoints(line.head, size);
        const end = line.endsCR ? line.end.slice(0, -1) : line.end;
        return `… ${suffixPoints(end, LINE_CHARACTERS)}`;
      })
      .join("\n");
    return { text: header + body, truncated };
  }
}

export type BashExitReason = "exited" | "timeout" | "aborted" | "killed" | "spawn-failed";
export type BashTaskStatus = "completed" | "failed" | "cancelled";

export interface BashRunOutcome {
  exitReason: BashExitReason;
  exitCode?: number | undefined;
  message?: string | undefined;
  leftover: boolean;
  durationMs: number;
}

/** The status line of a settled run (specs/bash-tool.md#result-contract); undefined when there is none. */
export function statusLine(
  outcome: BashRunOutcome,
  timeoutMs: number | undefined,
  browserKill = false,
): string | undefined {
  switch (outcome.exitReason) {
    case "exited":
      return outcome.exitCode === 0
        ? undefined
        : `Command exited with code ${outcome.exitCode ?? 0}`;
    case "timeout":
      return `Command timed out after ${timeoutMs ?? 0} ms`;
    case "aborted":
      return "Command aborted";
    case "killed":
      return browserKill ? "Command killed by the user from the task browser" : "Command killed";
    case "spawn-failed":
      return `Command failed to start: ${outcome.message ?? ""}`;
  }
}

/** The task status of a settled run (specs/bash-tool.md#result-contract). */
export function taskStatusOf(outcome: BashRunOutcome): BashTaskStatus {
  if (outcome.exitReason === "exited") return outcome.exitCode === 0 ? "completed" : "failed";
  if (outcome.exitReason === "timeout" || outcome.exitReason === "spawn-failed") return "failed";
  return "cancelled";
}

export interface BashRunRequest {
  shell: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  output: CapturedOutput;
  outputPath: string;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onLine?: (line: string) => void;
  onPartial?: (text: string) => void;
}

export interface BashRun {
  readonly promise: Promise<BashRunOutcome>;
  cancel(): void;
}

/**
 * Spawn the shell and follow the run to its end (specs/bash-tool.md#execution-model, specs/bash-tool.md#output-capture and specs/bash-tool.md#timeout-delivery):
 * process-group leader, piped capture, timeout, kill and abort, leftover reap.
 */
export function runBash(
  req: BashRunRequest,
  onCancelReady?: (cancel: () => void) => void,
): BashRun {
  const output = req.output;
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const startedAt = Date.now();
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, run: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };
  let resolveOutcome: (outcome: BashRunOutcome) => void = () => {};
  /**
   * SIGKILL to the group 250 ms after SIGTERM. Not tracked in `timers`: the
   * sequence completes even when the run ends first (specs/bash-tool.md#execution-model and specs/bash-tool.md#timeout-delivery).
   */
  const scheduleGroupKill = (pid: number): void => {
    const timer = setTimeout(() => {
      signalGroup(pid, "SIGKILL");
    }, KILL_GRACE_MS);
    timer.unref();
  };
  const promise = new Promise<BashRunOutcome>((settle) => {
    resolveOutcome = settle;
  });
  let exitReason: BashExitReason | undefined;
  let exitCode: number | undefined;
  let message: string | undefined;
  let leftover = false;
  let finished = false;
  /** Set by the shell's `exit` handler: the run cannot end before it (specs/bash-tool.md#execution-model). */
  let shellExited = false;
  let pipesOpen = 2;
  let partialTimer: NodeJS.Timeout | undefined;
  let child: ChildProcess | undefined;

  const emit = (lines: readonly string[]): void => {
    if (req.onLine === undefined) return;
    for (const line of lines) {
      try {
        req.onLine(line);
      } catch {
        // Host projection failures must not interrupt capture.
      }
    }
  };

  const reportPartial = (): void => {
    try {
      req.onPartial?.(output.excerpt().text);
    } catch {
      // A host callback cannot break output capture or settlement.
    }
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (partialTimer !== undefined) {
      clearTimeout(partialTimer);
      partialTimer = undefined;
    }
    if (req.signal !== undefined) req.signal.removeEventListener("abort", onAbort);
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    // An incomplete UTF-8 sequence at the end decodes as U+FFFD (specs/bash-tool.md#output-capture).
    emit(output.append(decoders.stdout.end(), 0));
    emit(output.append(decoders.stderr.end(), 0));
    const pending = output.pending();
    if (pending !== undefined) emit([pending]);
    reportPartial();
    const reason = exitReason ?? "exited";
    resolveOutcome({
      exitReason: reason,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(message === undefined ? {} : { message }),
      leftover,
      durationMs: reason === "spawn-failed" ? 0 : Date.now() - startedAt,
    });
  };

  const terminate = (): void => {
    const pid = child?.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      killTreeWindows(pid);
      return;
    }
    signalGroup(pid, "SIGTERM");
    scheduleGroupKill(pid);
  };

  const settleReason = (reason: BashExitReason): boolean => {
    if (exitReason !== undefined) return false;
    exitReason = reason;
    return true;
  };

  const onAbort = (): void => {
    if (settleReason("aborted")) terminate();
  };

  const cancel = (): void => {
    if (settleReason("killed")) terminate();
  };

  const checkEnd = (): void => {
    if (!finished && shellExited && pipesOpen <= 0) finish();
  };

  const schedulePartial = (): void => {
    if (req.onPartial === undefined || partialTimer !== undefined) return;
    partialTimer = setTimeout(() => {
      partialTimer = undefined;
      if (finished || req.onPartial === undefined) return;
      reportPartial();
    }, PARTIAL_INTERVAL_MS);
  };

  const onData = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    if (finished) return;
    try {
      appendFileSync(req.outputPath, chunk);
    } catch {
      // A file failure never fails the call (specs/bash-tool.md#output-capture).
    }
    try {
      emit(output.append(decoders[stream].write(chunk), chunk.length));
      schedulePartial();
    } catch {
      // Keep the raw saved output even if presentation fails; never throw from a pipe event.
    }
  };

  // The cancellation handler is installed before the shell is spawned (specs/bash-tool.md#timeout-delivery).
  onCancelReady?.(cancel);

  try {
    child = spawn(req.shell, ["-c", req.command], {
      cwd: req.cwd,
      env: req.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (error) {
    const failed: BashRunOutcome = {
      exitReason: "spawn-failed",
      message: errorMessage(error),
      leftover: false,
      durationMs: 0,
    };
    const failing = Promise.resolve(failed);
    return { promise: failing, cancel: () => {} };
  }

  child.on("error", (error: Error) => {
    if (!settleReason("spawn-failed")) return;
    message = errorMessage(error);
    finish();
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    onData("stdout", chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    onData("stderr", chunk);
  });
  child.stdout?.on("close", () => {
    pipesOpen -= 1;
    checkEnd();
  });
  child.stderr?.on("close", () => {
    pipesOpen -= 1;
    checkEnd();
  });
  child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    shellExited = true;
    if (settleReason("exited")) {
      exitCode = code ?? (signal === null ? 0 : 128 + (osConstants.signals[signal] ?? 0));
    }
    if (exitReason === "exited") {
      const pid = child?.pid;
      if (pid !== undefined && process.platform !== "win32") {
        leftover = signalGroup(pid, "SIGTERM");
        if (leftover) scheduleGroupKill(pid);
      }
    }
    if (pipesOpen <= 0) {
      finish();
      return;
    }
    later(PIPE_GRACE_MS, finish);
  });

  if (req.timeoutMs !== undefined) {
    later(req.timeoutMs, () => {
      if (settleReason("timeout")) terminate();
    });
  }
  if (req.signal !== undefined) {
    req.signal.addEventListener("abort", onAbort);
    if (req.signal.aborted) onAbort();
  }

  return { promise, cancel };
}

interface FormattedBash {
  body: string;
  isError: boolean;
  details: {
    exitReason: BashExitReason;
    exitCode?: number;
    truncated: boolean;
    leftover: boolean;
    outputPath: string;
    durationMs: number;
  };
}

/** The result body, status and details of a settled run (specs/bash-tool.md#result-contract). */
export function formatBashOutcome(
  outcome: BashRunOutcome,
  output: CapturedOutput,
  outputPath: string,
  timeoutMs: number | undefined,
  command: string,
  browserKill = false,
): FormattedBash {
  const excerpt = output.excerpt(outputPath);
  const parts: string[] = [];
  if (excerpt.text !== "") parts.push(excerpt.text);
  const redirection = fileRedirection(command);
  if (isFilterPiped(command) && !redirection.stdout) parts.push(PIPE_NOTICE);
  if (redirection.redirected) parts.push(REDIRECT_NOTICE);
  const status = statusLine(outcome, timeoutMs, browserKill);
  if (status !== undefined) parts.push(status);
  if (outcome.leftover) parts.push(LEFTOVER_NOTICE);
  const body = parts.length === 0 ? "(no output)" : parts.join("\n\n");
  return {
    body,
    isError: taskStatusOf(outcome) !== "completed",
    details: {
      exitReason: outcome.exitReason,
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      truncated: excerpt.truncated,
      leftover: outcome.leftover,
      outputPath,
      durationMs: outcome.durationMs,
    },
  };
}

/**
 * The timeout a call imposes (specs/bash-tool.md#parameter-schema): an omitted `timeout` gives a foreground call
 * `DEFAULT_TIMEOUT_MS` and imposes none on a background call; above `MAX_TIMEOUT_MS` imposes none.
 */
export function resolveBashTimeout(
  timeout: number | undefined,
  background: boolean,
): number | undefined {
  if (timeout === undefined) return background ? undefined : DEFAULT_TIMEOUT_MS;
  return timeout > MAX_TIMEOUT_MS ? undefined : timeout;
}

/** The row label of the call (specs/bash-tool.md#timeout-delivery). */
function bashLabel(params: BashToolParams): string {
  if (typeof params.description === "string" && params.description.trim() !== "")
    return params.description;
  return labelFallback(params.command);
}

export function makeBashTool(deps: BashToolDeps) {
  return defineTool({
    name: "Bash",
    label: "Bash",
    description:
      "`Bash` output is captured to a file by default: never cut it with `| tail`, `| head` or `| grep` or redirect it, and `Read` or `rg` that file instead of rerunning the command. Run a shell command as a task, in the foreground or, with `background: true`, as a background task that returns at once with a task ID, keeps running, and notifies you when it settles (in a user session, prefer `background: true` for long-running commands so you do not block user input). Output is written to a file and to the task's output feed; long output shows a bounded excerpt of its last lines. An omitted `timeout` gives a foreground call 600000 ms and imposes none on a background call. Do not start processes with & or nohup: use background: true. Temporary files go under $TMPDIR, the session's tmp folder, never /tmp; create them with mktemp \"$TMPDIR/name.XXXXXX\", since a bare mktemp may ignore $TMPDIR.",
    promptSnippet: "Run a shell command as a task, in the foreground or background",
    parameters: bashParameterSchema,
    async execute(
      toolCallId: string,
      params: BashToolParams,
      signal: AbortSignal | undefined,
      onUpdate: ((partial: ToolResult) => void) | undefined,
    ): Promise<ToolResult> {
      const registry = deps.registry();
      const background = params.background === true;

      // One row per invocation, registered before any validation (specs/bash-tool.md#timeout-delivery).
      let row: BashTaskRow;
      try {
        row = registry.register({
          kind: "bash",
          cohort: deps.cohortFor(toolCallId),
          label: bashLabel(params),
          background,
          command: params.command,
          toolCallId,
        });
      } catch (error) {
        return textError(`Bash error: ${errorMessage(error)}`);
      }
      // A specs/bash-tool.md#validation failure is a pre-start rejection: the row is consumed and
      // settles failed with the error text, and no output file is created.
      const reject = (message: string): ToolResult => rejectCall(registry, row, message);

      const host = deps.hostProvider();
      if (!host) return reject("pi-dent: no live host session for the Bash call");

      // specs/bash-tool.md#validation, in order: cwd, then the shell.
      const sessionCwd = host.cwd();
      const resolvedCwd = resolveCwdParam(params.cwd, sessionCwd);
      if ("error" in resolvedCwd) return reject(resolvedCwd.error);
      const cwd = resolvedCwd.cwd ?? sessionCwd;

      const settings = deps.settings(sessionCwd);
      const shell = resolveShell(settings);
      if ("error" in shell) return reject(shell.error);
      // The checks of specs/bash-tool.md#validation passed (specs/task-ledger.md#ledger-row).
      ledgerDispatched(row, cwd);
      // Above 2147483647 the call imposes no timeout; an omitted one defaults for foreground only.
      const timeoutMs = resolveBashTimeout(params.timeout, background);

      const prefix =
        typeof settings.shellCommandPrefix === "string" && settings.shellCommandPrefix !== ""
          ? `${settings.shellCommandPrefix}\n`
          : "";
      const env = buildBashEnv(host, deps.extraEnv?.());

      const agentDir = deps.agentDir(host);
      const outputPath = outputPathsFor(agentDir, row.taskId).outputPath;
      const output = new CapturedOutput();

      // An already-aborted tool-call signal prevents the spawn (specs/bash-tool.md#timeout-delivery).
      const preSettled = (reason: BashExitReason): ToolResult => {
        const outcome: BashRunOutcome = { exitReason: reason, leftover: false, durationMs: 0 };
        const text = statusLine(outcome, timeoutMs) ?? "(no output)";
        registry.consume(row);
        registry.settle(row, { status: taskStatusOf(outcome), result: text });
        return {
          content: [{ type: "text", text }],
          details: {
            taskId: row.taskId,
            exitReason: reason,
            outputPath,
            truncated: false,
            leftover: false,
            durationMs: 0,
          },
          isError: true,
        };
      };
      // A background call ignores the tool-call signal (specs/bash-tool.md#timeout-delivery), an
      // already-aborted one included: only a foreground call can abort.
      if (!background && signal?.aborted === true) return preSettled("aborted");

      ensureOutputDir(agentDir);
      try {
        writeFileSync(outputPath, "");
      } catch {
        // Creating the output file never fails the call (specs/bash-tool.md#output-capture).
      }

      const request: BashRunRequest = {
        shell: shell.path,
        command: `${prefix}${params.command}`,
        cwd,
        env,
        output,
        outputPath,
        timeoutMs,
        onLine: (line) => {
          registry.progress(row, line);
        },
      };
      if (background) {
        request.signal = undefined;
      } else {
        request.signal = signal;
        request.onPartial = (text) => {
          onUpdate?.({ content: [{ type: "text", text }], details: {} });
        };
      }

      let run: BashRun;
      try {
        run = runBash(request, (cancel) => {
          row.cancel = cancel;
        });
      } catch (error) {
        return reject(`Bash error: ${errorMessage(error)}`);
      }

      if (!background) {
        const outcome = await run.promise;
        const formatted = formatBashOutcome(
          outcome,
          output,
          outputPath,
          timeoutMs,
          params.command,
          row.browserKill,
        );
        registry.settle(row, {
          status: taskStatusOf(outcome),
          result: formatted.body,
          resultPath: outputPath,
        });
        return {
          content: [{ type: "text", text: formatted.body }],
          details: { taskId: row.taskId, ...formatted.details },
          ...(formatted.isError ? { isError: true } : {}),
        };
      }

      void run.promise
        .then((outcome) => {
          const formatted = formatBashOutcome(
            outcome,
            output,
            outputPath,
            timeoutMs,
            params.command,
            row.browserKill,
          );
          registry.settle(row, {
            status: taskStatusOf(outcome),
            result: formatted.body,
            resultPath: outputPath,
          });
        })
        .catch((error: unknown) => {
          // No unhandled rejection from a background run.
          settleBackgroundFailure(registry, row, "Bash", error);
        });
      return {
        content: [
          {
            type: "text",
            text: `Command started in background (taskId ${row.taskId}).\nOutput: ${outputPath}`,
          },
        ],
        details: {
          taskId: row.taskId,
          outputPath,
          background: true,
          exitReason: "running",
          truncated: false,
          leftover: false,
          durationMs: 0,
        },
      };
    },
    renderCall(args: Partial<BashToolParams> | undefined, theme, context) {
      const command = typeof args?.command === "string" ? args.command : "";
      return renderCardCall(
        {
          tool: "Bash",
          description: args?.description,
          background: args?.background,
          source: `$ ${command}`,
        },
        theme,
        context,
      );
    },
    renderResult: renderToolCardResult,
  });
}
