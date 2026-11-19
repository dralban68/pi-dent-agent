import { Worker } from "node:worker_threads";
import type { ReturnValueRender } from "./script-render.ts";
import type { ToolCallReply } from "./script-tool-calls.ts";
import { toolDeclarations } from "./script-tool-types.ts";
import { applySessionTmp } from "./session-tmp.ts";
import { killTreeWindows, prefixBytes, signalGroup } from "./tool-common.ts";
import { errorCode, errorMessage, isPlainObject } from "./util.ts";
import { typeStrippingOptions } from "./worker-options.ts";

/**
 * Script tool execution (specs/script-tool.md Sections 3 and 6): spawns one
 * in-process worker thread per call, captures stdout/stderr (1 MiB caps),
 * enforces the timeout, and hard-terminates the worker and its spawned process
 * tree on every settlement (Section 6): the run's own end, timeout, caller
 * abort, or Task kill.
 */

const MAX_STREAM = 1048576;
const TRUNCATION_MARKER = "\n... [truncated] ...\n";
/** SIGTERM -> SIGKILL grace before the spawned tree is killed (Section 6). */
const TERM_GRACE_MS = 200;
/** Extra drain after SIGKILL before the worker is terminated. */
const KILL_GRACE_MS = 100;
/** Exit-report poll while draining. */
const REAP_POLL_MS = 25;

/** Captured stdout/stderr under the 1 MiB per-stream cap (Section 3). */
export interface StreamCapture {
  text: { stdout: string; stderr: string };
  /** Bytes of kept text per stream (the marker is not counted). */
  bytes: { stdout: number; stderr: number };
  truncated: { stdout: boolean; stderr: boolean };
}

/** Mark a stream truncated once, appending the marker to its text. */
function markTruncated(
  capture: StreamCapture,
  stream: "stdout" | "stderr",
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
): void {
  if (capture.truncated[stream]) return;
  capture.truncated[stream] = true;
  capture.text[stream] += TRUNCATION_MARKER;
  onOutput?.(stream, TRUNCATION_MARKER);
}

/**
 * Append one captured chunk: the first chunk that would exceed the cap is cut
 * at the cap and marked, and output arriving after the cap is dropped but still
 * marked truncated exactly once (Section 3).
 */
export function appendStream(
  capture: StreamCapture,
  stream: "stdout" | "stderr",
  chunk: string,
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
): void {
  const remaining = MAX_STREAM - capture.bytes[stream];
  if (remaining <= 0) {
    markTruncated(capture, stream, onOutput);
    return;
  }
  const chunkBytes = Buffer.byteLength(chunk);
  const kept = chunkBytes > remaining ? prefixBytes(chunk, remaining) : chunk;
  if (kept !== "") {
    capture.text[stream] += kept;
    capture.bytes[stream] += Buffer.byteLength(kept);
    onOutput?.(stream, kept);
  }
  if (chunkBytes > remaining) markTruncated(capture, stream, onOutput);
}

export type ScriptExitReason = "ok" | "exit-called" | "timeout" | "threw" | "killed" | "aborted";

export interface ScriptRunRequest {
  code: string;
  /** Synthetic filename anchoring module resolution and error reporting. */
  filename: string;
  cwd: string;
  input: unknown;
  aliases: Record<string, string>;
  /** Absent imposes no timeout; `Script` passes the foreground default of Section 1 explicitly. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Fired with each appended chunk (already truncated) for background streaming. */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * Extra environment variables for the worker, merged over process.env
   * (never mutating it). When absent or empty, the default worker env copy is
   * kept (no `env` option).
   */
  extraEnv?: Record<string, string>;
  /** The tool functions (Section 10); absent binds none. */
  tools?: ScriptRunTools;
  /** Whether this run is a plugin UI call (specs/plugin-ui.md). */
  uiCall?: boolean;
  /** Fired with each validated UI message JSON payload before settlement. */
  onUiMessage?: (json: string) => void;
}

/** Pre-validated return outcome of a plugin UI call (specs/plugin-ui.md Section 5). */
export type UiReturnOutcome = { ok: true; json: string } | { ok: false; error: string };

/** The tool functions of a run (Section 10.3). */
export interface ScriptRunTools {
  /** Bound tool names, in declaration order. */
  names: string[];
  /** The tool declarations (Section 10.2), returned by `dent.toolTypes()`. */
  declarations: string;
  /** Runs one nested call; the signal aborts at settlement. */
  call: (name: string, args: unknown, signal: AbortSignal) => Promise<ToolCallReply>;
}

export interface ScriptRunResult {
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  /** The return value (JSON-compatible subset) or the non-json marker (Section 5). */
  returnValue?: unknown;
  /** Pre-clone render of the return value, computed in the worker (Section 5). */
  rendered?: string;
  render?: ReturnValueRender;
  /** Single-line JSON of a JSON-compatible return value (Section 5). */
  json?: string;
  exitReason: ScriptExitReason;
  exitCode?: number;
  durationMs: number;
  error?: { name: string; message: string; stack: string };
  /** Pre-validated return outcome of a plugin UI call (specs/plugin-ui.md Section 5). */
  uiReturn?: UiReturnOutcome;
}

export interface ScriptRunHandle {
  promise: Promise<ScriptRunResult>;
  cancel: (reason: "killed" | "aborted") => void;
  /** When the run started (Section 6), in ms since the epoch; absent when none started. */
  startedAt: () => number | undefined;
  /**
   * Append one line of the host's own to the run's stderr, until the result is built
   * (the tool log's write failure, Section 10.4). Returns `false` when it is too late.
   */
  stderrLine: (line: string) => boolean;
}

/** Parse a worker's `uiReturn` payload without type assertions. */
function parseUiReturn(value: unknown): UiReturnOutcome | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.ok === true && typeof value.json === "string") {
    return { ok: true, json: value.json };
  }
  if (value.ok === false && typeof value.error === "string") {
    return { ok: false, error: value.error };
  }
  return undefined;
}

/** Signal one spawned child by its process ID (Windows: its tree with taskkill /T /F). */
function signalChild(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    killTreeWindows(pid);
    return;
  }
  // ESRCH: already gone. macOS yields EPERM for a zombie — harmless, since
  // settlement reaps the children before returning.
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/** Whether a spawned child's process group holds no member (POSIX). */
function groupIsEmpty(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

export function runScript(req: ScriptRunRequest): ScriptRunHandle {
  let cancel: (reason: "killed" | "aborted") => void = () => {};
  /** The run's start; absent until the run is created. */
  let started: number | undefined;
  let stderrLine: (line: string) => boolean = () => false;
  const promise = new Promise<ScriptRunResult>((resolve) => {
    /** Whether the result was built: nothing reaches the capture after it. */
    let finished = false;
    /** When the run settled: its end (Section 5), before the termination drain. */
    let ended: number | undefined;
    const capture: StreamCapture = {
      text: { stdout: "", stderr: "" },
      bytes: { stdout: 0, stderr: 0 },
      truncated: { stdout: false, stderr: false },
    };
    let settled = false;
    /** The spawned children still running. */
    const childPids = new Set<number>();
    /**
     * The spawned children that lead their own process group, kept after the
     * child exits: the group MAY still hold its own children (Section 6).
     */
    const groupPids = new Set<number>();
    let worker: Worker | undefined;
    let timer: NodeJS.Timeout | undefined;
    /** Signals of the nested calls still running (Section 10.3). */
    const nestedCalls = new Set<AbortController>();

    const finish = (partial: Partial<ScriptRunResult>) => {
      finished = true;
      void worker?.terminate();
      resolve({
        stdout: capture.text.stdout,
        stderr: capture.text.stderr,
        truncated: capture.truncated,
        exitReason: "ok",
        durationMs: started === undefined || ended === undefined ? 0 : ended - started,
        ...partial,
      });
    };

    /** Drain exit reports for up to graceMs, then run `next` once. */
    const drain = (graceMs: number, next: () => void) => {
      let done = false;
      const conclude = () => {
        if (done) return;
        done = true;
        clearTimeout(cap);
        clearInterval(poll);
        next();
      };
      const poll = setInterval(() => {
        if (childPids.size === 0) conclude();
      }, REAP_POLL_MS);
      const cap = setTimeout(conclude, graceMs);
    };

    /**
     * Signal one spawned child and, when it leads one, its process group
     * (Section 6). A child that has exited keeps only its group, which MAY
     * still hold its own children; a group found empty at its leader's exit
     * has been dropped, so a reused pid is never signalled.
     */
    const signalTree = (pid: number, signal: NodeJS.Signals): void => {
      if (childPids.has(pid)) signalChild(pid, signal);
      if (process.platform !== "win32" && groupPids.has(pid)) signalGroup(pid, signal);
    };

    /** Every pid a settlement must reach: running children and groups that outlived their leader. */
    const treePids = (): number[] => [...new Set([...childPids, ...groupPids])];

    // Terminate the spawned process tree and reap the direct children
    // (Section 6). The worker's event loop reaps its children while it runs —
    // including one final pass during worker.terminate() — so the tree must be
    // killed while the worker still exists, or the children linger forever as
    // zombies owned by this process. SIGTERM, drain exits, SIGKILL after the
    // grace, drain again, then terminate the worker.
    const settleTree = (partial: Partial<ScriptRunResult>) => {
      const targets = treePids();
      if (targets.length === 0) {
        finish(partial);
        return;
      }
      for (const pid of targets) signalTree(pid, "SIGTERM");
      drain(TERM_GRACE_MS, () => {
        for (const pid of treePids()) signalTree(pid, "SIGKILL");
        drain(KILL_GRACE_MS, () => finish(partial));
      });
    };

    const settle = (partial: Partial<ScriptRunResult>) => {
      if (settled) return;
      settled = true;
      // The run ends here, at settlement (Section 5): the drain of Section 6 that
      // follows the spawned tree's termination is not part of its duration.
      ended = Date.now();
      if (timer) clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      // Section 10.3: nested calls still running are aborted, not awaited, and their outcomes dropped.
      for (const controller of nestedCalls) controller.abort();
      nestedCalls.clear();
      settleTree(partial);
    };

    const onAbort = () => settle({ exitReason: "aborted" });
    if (req.signal) {
      if (req.signal.aborted) {
        settle({ exitReason: "aborted" });
        return;
      }
      req.signal.addEventListener("abort", onAbort, { once: true });
    }

    cancel = (reason) => settle({ exitReason: reason });
    stderrLine = (line) => {
      if (finished) return false;
      const text = capture.text.stderr;
      const lead = text !== "" && !text.endsWith("\n") ? "\n" : "";
      appendStream(capture, "stderr", `${lead}${line}\n`, req.onOutput);
      return true;
    };

    // The worker's process.env: the host's, the caller's extra env merged over it, then the
    // session tmp folder (bash-tool.md, Section 3).
    const workerEnv: NodeJS.ProcessEnv = { ...process.env, ...req.extraEnv };
    applySessionTmp(workerEnv, req.extraEnv);
    const workerUrl = new URL("./script-worker.ts", import.meta.url);
    worker = new Worker(workerUrl, {
      ...typeStrippingOptions(workerUrl),
      workerData: {
        code: req.code,
        filename: req.filename,
        cwd: req.cwd,
        input: req.input,
        aliases: req.aliases,
        toolNames: req.tools?.names ?? [],
        toolTypes: req.tools?.declarations ?? toolDeclarations({ bound: [], unbound: [] }),
        uiCall: req.uiCall === true,
      },
      env: workerEnv,
    });
    // The run starts here (Section 5): the ms before the worker existed are no run.
    started = Date.now();
    // The timeout deadline counts from the run's start (Section 6).
    if (req.timeoutMs !== undefined) {
      timer = setTimeout(() => settle({ exitReason: "timeout" }), req.timeoutMs);
      timer.unref?.();
    }

    worker.on("message", (msg) => {
      switch (msg.type) {
        case "stdout":
          // Termination is asynchronous: chunks the worker posted before it was
          // terminated may still arrive after settlement (timeout, kill, exit),
          // and they must never land after the tool's exit block (Section 5).
          if (settled) break;
          appendStream(capture, "stdout", msg.chunk, req.onOutput);
          break;
        case "stderr":
          if (settled) break;
          appendStream(capture, "stderr", msg.chunk, req.onOutput);
          break;
        case "child-pid":
          childPids.add(msg.pid);
          // Only a child that leads its own group is ever signalled as a group.
          if (process.platform !== "win32" && msg.detached === true) groupPids.add(msg.pid);
          if (settled) signalTree(msg.pid, "SIGKILL");
          break;
        case "child-exit":
          childPids.delete(msg.pid);
          // A group that emptied at its leader's exit cannot refill, and the pid
          // is free to be reused: it is no longer part of the tree (Section 6).
          if (groupPids.has(msg.pid) && groupIsEmpty(msg.pid)) groupPids.delete(msg.pid);
          break;
        case "tool-call":
          if (!settled) startNestedCall(msg.id, String(msg.name), msg.args);
          break;
        case "ui-message":
          if (!settled && typeof msg.json === "string") req.onUiMessage?.(msg.json);
          break;
        case "exit-called":
          settle({ exitReason: "exit-called", exitCode: msg.code ?? 0 });
          break;
        case "error":
          settle({
            exitReason: "threw",
            // Non-string fields are coerced here too: the worker posts them
            // user-controllable, and the tool renders them as text (Section 5).
            error: {
              name: String(msg.name),
              message: String(msg.message),
              stack: String(msg.stack ?? ""),
            },
          });
          break;
        case "result": {
          const uiReturn = parseUiReturn(msg.uiReturn);
          settle({
            exitReason: "ok",
            returnValue: msg.returnValue,
            rendered: msg.rendered,
            render: msg.render,
            json: msg.json,
            ...(uiReturn === undefined ? {} : { uiReturn }),
          });
          break;
        }
      }
    });

    /** Section 10.3, step 2 onward: run the nested call and post its reply unless the run settled. */
    function startNestedCall(id: unknown, name: string, args: unknown): void {
      const controller = new AbortController();
      nestedCalls.add(controller);
      const call = req.tools?.call;
      const pending: Promise<ToolCallReply> =
        call === undefined || !req.tools?.names.includes(name)
          ? Promise.resolve({
              ok: false,
              error: { name: "Error", message: `tool ${name} is not bound` },
            })
          : call(name, args, controller.signal);
      void pending
        .catch((error: unknown): ToolCallReply => ({
          ok: false,
          error: { name: "Error", message: errorMessage(error) },
        }))
        .then((reply) => {
          nestedCalls.delete(controller);
          if (settled) return;
          try {
            worker?.postMessage({ type: "tool-result", id, reply });
          } catch (error) {
            try {
              worker?.postMessage({
                type: "tool-result",
                id,
                reply: { ok: false, error: { name: "Error", message: errorMessage(error) } },
              });
            } catch {
              // Port closed.
            }
          }
        });
    }

    worker.on("error", (err: unknown) => {
      // A worker that throws a non-Error value passes it through raw; normalise
      // before reading name/message/stack (Section 3: strings).
      const error = err instanceof Error ? err : new Error(String(err));
      settle({
        exitReason: "threw",
        error: {
          name: String(error.name),
          message: String(error.message),
          stack: String(error.stack ?? ""),
        },
      });
    });

    worker.on("exit", (code) => {
      // A worker that exits without settling (e.g. crashed) reports threw.
      if (!settled) {
        settle({
          exitReason: "threw",
          error: {
            name: "Error",
            message: `script worker exited unexpectedly (code ${code})`,
            stack: "",
          },
        });
      }
    });
  });
  return { promise, cancel, startedAt: () => started, stderrLine: (line) => stderrLine(line) };
}
