import { Console } from "node:console";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { ChildProcess } from "node:child_process";
import * as vm from "node:vm";
import { Writable } from "node:stream";
import { isJsonCompatible, renderReturn } from "./script-render.ts";
import { TEMP_VARIABLES } from "./session-tmp.ts";
import { parentPort, workerData } from "node:worker_threads";
import { createJiti } from "jiti";

/**
 * The Script tool worker (specs/script-tool.md Section 3): runs one script
 * in-process with ESM semantics, TypeScript syntax, and top-level await via
 * jiti transform + vm.compileFunction. The worker is a lifecycle boundary,
 * not a sandbox. It injects the `input` binding, a cwd-observing `process`
 * proxy, captured stdout/stderr, and process.exit interception.
 */

interface ScriptWorkerData {
  code: string;
  /** Synthetic filename anchoring module resolution and error reporting. */
  filename: string;
  cwd: string;
  input: unknown;
  /** Package name -> absolute directory, for jiti's `alias` (bundled packages). */
  aliases: Record<string, string>;
  /** Bound tool names, in declaration order (Section 10.3). */
  toolNames: string[];
  /** The tool declarations (Section 10.2). */
  toolTypes: string;
  background: boolean;
}

const port = parentPort;
if (!port) throw new Error("script-worker must run inside a Worker");
const data: ScriptWorkerData = workerData;

// --- exit interception ------------------------------------------------------
// `process.exit` settles the run as `exit-called` and ends the script's own flow
// (Section 3). The worker MUST NOT die with it: the runner kills the script's
// spawned tree after settlement (Section 6), and only this thread's libuv loop
// reaps those children — a thread that is blocked or gone leaves them behind as
// zombies of the host process. So the exit throws, the worker's own level
// swallows it, and the loop stays up until the runner terminates the worker;
// the script's timers are guarded so none of its code runs meanwhile.
let exitCalled = false;

/** Ends the script's flow at `process.exit`; the worker alone catches it. */
class ScriptExit extends Error {}

const isScriptExit = (value: unknown): boolean => value instanceof ScriptExit;

/** Settle `exit-called` and end the script's flow (Section 3). */
const postExit = (code?: number): never => {
  exitCalled = true;
  try {
    port.postMessage({ type: "exit-called", code: code ?? 0 });
  } catch {
    // Port closed.
  }
  throw new ScriptExit("pi-dent: process.exit");
};

// --- stdout/stderr capture ---------------------------------------------------
const post = (type: "stdout" | "stderr", chunk: string) => {
  try {
    port.postMessage({ type, chunk });
  } catch {
    // Port closed.
  }
};
const captureWrite =
  (type: "stdout" | "stderr") =>
  (chunk: unknown, ...rest: unknown[]) => {
    let text: string;
    if (typeof chunk === "string") text = chunk;
    else if (chunk instanceof Uint8Array) text = Buffer.from(chunk).toString("utf-8");
    else text = String(chunk);
    post(type, text);
    const cb = rest[rest.length - 1];
    if (typeof cb === "function") queueMicrotask(() => cb());
    return true;
  };
/** Tags the capture streams the entry proxy serves as `process.stdout`/`stderr`. */
const captureTag = Symbol("pi-dent.captureStream");
const captureStream = (type: "stdout" | "stderr") => {
  const stream = new Writable({
    write(chunk: unknown, _encoding, callback) {
      captureWrite(type)(chunk);
      callback();
    },
  });
  // Child stdio resolution (Section 6): the entry proxy hands one of these out
  // for every `process.stdout`/`process.stderr` access. They carry no fd, so as
  // a spawn stdio element node would reject them outright; tagged, they resolve
  // like the worker's own streams — never the host's.
  Object.defineProperty(stream, captureTag, { value: type });
  return stream;
};
// console.log/error route through the captured streams (Section 3). A real
// Console instance keeps the full surface (dir, table, time, group, ...);
// only its write sink is captured.
const scriptConsole = new Console({
  stdout: captureStream("stdout"),
  stderr: captureStream("stderr"),
});

// --- unhandled rejection ----------------------------------------------------
// The runner settles `threw` from this message and the tool renders it
// (Section 3), so the text is never duplicated onto the captured stderr.
const reportError = (err: { name: unknown; message: unknown; stack?: unknown }) => {
  try {
    // name/message/stack are user-controllable (a thrown Error may carry a
    // non-string stack); coerce so the tool always renders text (Section 5).
    port.postMessage({
      type: "error",
      message: String(err.message),
      stack: String(err.stack ?? ""),
      name: String(err.name),
    });
  } catch {
    // Port closed.
  }
};
process.on("unhandledRejection", (reason) => {
  // The exit has settled the run; its sentinel is not a script failure.
  if (exitCalled || isScriptExit(reason)) return;
  const err = reason instanceof Error ? reason : new Error(String(reason));
  reportError(err);
});
process.on("uncaughtException", (thrown: unknown) => {
  // The sentinel leaves a timer or another callback when the script calls
  // process.exit outside its own flow: the loop must keep running (Section 6).
  if (exitCalled || isScriptExit(thrown)) return;
  reportError(thrown instanceof Error ? thrown : new Error(String(thrown)));
});

// --- tool functions and dent (Sections 4 and 10.3) ----------------------------
// A nested call is one `tool-call` message; the runner answers with `tool-result`. The port is
// referenced only while a call is pending, so a script awaiting nothing else still ends as before.
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
const pendingCalls = new Map<number, PendingCall>();
let nextCallId = 0;
let listening = false;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const freezeResult = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const content = Array.isArray(value.content)
    ? Object.freeze(value.content.map((part: unknown) => Object.freeze(part)))
    : value.content;
  return Object.freeze({
    text: value.text,
    content,
    details: value.details,
    structured: value.structured,
  });
};

const onToolResult = (message: unknown): void => {
  if (!isRecord(message) || message.type !== "tool-result" || typeof message.id !== "number") {
    return;
  }
  const call = pendingCalls.get(message.id);
  if (call === undefined) return;
  pendingCalls.delete(message.id);
  if (pendingCalls.size === 0) port.unref();
  // No code of the script runs after process.exit (Section 3).
  if (exitCalled) return;
  const reply = message.reply;
  if (isRecord(reply) && reply.ok === true) {
    call.resolve(freezeResult(reply.value));
    return;
  }
  const failure = isRecord(reply) && isRecord(reply.error) ? reply.error : {};
  const error = new Error(String(failure.message ?? "tool call failed"));
  if (typeof failure.name === "string" && failure.name !== "Error") error.name = failure.name;
  call.reject(error);
};

const toolFunction =
  (name: string) =>
  (args: unknown): Promise<unknown> => {
    if (data.background) {
      return Promise.reject(new Error(`tools.${name} is not available in a background run`));
    }
    const plain =
      isRecord(args) &&
      !Array.isArray(args) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(args));
    if (!plain || !isJsonCompatible(args)) {
      return Promise.reject(new Error(`tools.${name} args must be a JSON-compatible object`));
    }
    return new Promise((resolveCall, rejectCall) => {
      const id = nextCallId++;
      pendingCalls.set(id, { resolve: resolveCall, reject: rejectCall });
      if (!listening) {
        listening = true;
        port.on("message", onToolResult);
      }
      port.ref();
      port.postMessage({ type: "tool-call", id, name, args });
    });
  };

const scriptTools: Record<string, unknown> = Object.freeze(
  Object.fromEntries(data.toolNames.map((name) => [name, toolFunction(name)])),
);
const scriptDent = Object.freeze({ toolTypes: (): string => data.toolTypes });
Object.defineProperty(globalThis, "tools", {
  value: scriptTools,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, "dent", {
  value: scriptDent,
  writable: true,
  configurable: true,
});

// --- cwd-observing process proxy --------------------------------------------
let cwd = data.cwd;
// Node's chdir rejects a missing directory (ENOENT, from statSync) and a non-
// directory (ENOTDIR) instead of silently adopting a bogus cwd, which would
// make later relative fs calls fail somewhere unrelated (Section 3).
const changeDir = (directory: string): void => {
  const next = resolve(cwd, directory);
  if (!statSync(next).isDirectory()) {
    const notDirectory = new Error(`ENOTDIR: not a directory, chdir '${cwd}' -> '${next}'`);
    Object.assign(notDirectory, { code: "ENOTDIR", path: cwd, errno: -20, syscall: "chdir" });
    throw notDirectory;
  }
  cwd = next;
};
const scriptProcess = new Proxy(process, {
  get(target, property, _receiver) {
    if (property === "cwd") return () => cwd;
    if (property === "chdir") return changeDir;
    if (property === "stdout") return captureStream("stdout");
    if (property === "stderr") return captureStream("stderr");
    // process.exit is intercepted without terminating the host process; the
    // main thread terminates the worker on receipt (Section 3).
    if (property === "exit") return postExit;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

// --- globalThis proxy: input binding + process -------------------------------
const scriptGlobal = new Proxy(globalThis, {
  get(target, property, receiver) {
    if (property === "process") return scriptProcess;
    if (property === "input") return data.input;
    if (property === "global" || property === "globalThis") return scriptGlobal;
    return Reflect.get(target, property, receiver);
  },
});

// --- relative fs paths follow the script cwd ---------------------------------
// Path-first functions: the first argument is a path (or a file descriptor,
// which resolvePathArg passes through unchanged). `symlink` is excluded: its
// first argument is the link target, passed unchanged (Section 3).
const FS_PATH_FIRST = new Set([
  "access",
  "accessSync",
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "createReadStream",
  "createWriteStream",
  "exists",
  "existsSync",
  "lchmod",
  "lchmodSync",
  "lchown",
  "lchownSync",
  "link",
  "linkSync",
  "lstat",
  "lstatSync",
  "lutimes",
  "lutimesSync",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempDisposable",
  "mkdtempDisposableSync",
  "mkdtempSync",
  "open",
  "openAsBlob",
  "openAsBlobSync",
  "openSync",
  "opendir",
  "opendirSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "readlink",
  "readlinkSync",
  "realpath",
  "realpathSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "stat",
  "statSync",
  "statfs",
  "statfsSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "unwatchFile",
  "utimes",
  "utimesSync",
  "watch",
  "watchFile",
  "writeFile",
  "writeFileSync",
]);
// Two-path functions: the second argument is also a path. For `symlink` the
// second argument is the link path; the first (target) stays unchanged.
const FS_PATH_SECOND = new Set([
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "link",
  "linkSync",
  "rename",
  "renameSync",
  "symlink",
  "symlinkSync",
]);

// Glob functions take a glob pattern, not a path: the pattern is left unchanged
// and the `cwd` option defaults to the script cwd (Section 3).
const FS_GLOB = new Set(["glob", "globSync"]);

function resolvePathArg(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) return value;
  return resolve(cwd, value);
}

const isCallable = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === "function";

const isOptionsObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** fs arguments with every relative path argument resolved against the script cwd. */
function withResolvedPathArgs(name: string, args: unknown[]): unknown[] {
  const next = [...args];
  if (next.length > 0 && FS_PATH_FIRST.has(name)) next[0] = resolvePathArg(next[0]);
  if (next.length > 1 && FS_PATH_SECOND.has(name)) next[1] = resolvePathArg(next[1]);
  return next;
}

/** Glob arguments: pattern unchanged, `cwd` option defaulted to the script cwd. */
function withGlobCwd(args: unknown[]): unknown[] {
  const next = [...args];
  const options = next[1];
  if (isOptionsObject(options)) {
    const given = options.cwd;
    next[1] = { ...options, cwd: given === undefined ? cwd : resolvePathArg(given) };
    return next;
  }
  // fs.glob(pattern, cb): options must sit before the callback.
  if (typeof options === "function") next.splice(1, 0, { cwd });
  else if (options === undefined) {
    if (next.length > 1) next[1] = { cwd };
    else next.push({ cwd });
  }
  return next;
}

const FUNCTION_INTRINSIC_KEYS = new Set(["length", "name", "prototype"]);

/**
 * Whether the transformed body has a top-level `await` — an await expression or
 * a `for await` outside every function and class body (Section 4). A class
 * static initialization block has `await` reserved at its own top level and
 * legal inside every nested function, so compiling the body there without
 * running it makes V8 answer exactly that question: a SyntaxError means a
 * top-level await. A body the block rejects for another reason (`arguments`,
 * `return`) takes the wrapper too, which is safe.
 */
function hasTopLevelAwait(body: string): boolean {
  try {
    new vm.Script(`class __piDentProbe { static {\n${body}\n} }`);
  } catch {
    return true;
  }
  return false;
}

/**
 * Wrap one fs function so relative paths follow the script cwd, carrying over
 * the original's own properties (`realpath.native`, the `promisify.custom`
 * symbol) so `fs.realpathSync.native` and `promisify(fs.exists)` still work.
 * Function-valued properties resolve their arguments the same way.
 */
function wrapFsFunction(
  name: string,
  original: (...args: unknown[]) => unknown,
  receiver: object,
): (...args: unknown[]) => unknown {
  const rewrite = (args: unknown[]): unknown[] =>
    FS_GLOB.has(name) ? withGlobCwd(args) : withResolvedPathArgs(name, args);
  const wrapper = (...args: unknown[]) => Reflect.apply(original, receiver, rewrite(args));
  for (const key of Reflect.ownKeys(original)) {
    if (typeof key === "string" && FUNCTION_INTRINSIC_KEYS.has(key)) continue;
    const value = Reflect.get(original, key);
    Reflect.set(
      wrapper,
      key,
      isCallable(value)
        ? (...args: unknown[]) => Reflect.apply(value, original, rewrite(args))
        : value,
    );
  }
  return wrapper;
}

void (async () => {
  const nativeRequire = createRequire(data.filename);

  // --- timer guards after process.exit (Section 3) ---------------------------
  // No code of the script runs after `process.exit`: a callback it registered
  // through setTimeout, setInterval or setImmediate never runs once the exit is
  // called, and one it registers afterwards does not run either. The rest of the
  // loop keeps running (Section 6), so the callbacks that are not timers — I/O
  // completions, promise continuations — can still run until termination.
  const guardTimerCallback = (callback: unknown): unknown =>
    isCallable(callback)
      ? (...args: unknown[]) => {
          if (exitCalled) return;
          Reflect.apply(callback, undefined, args);
        }
      : callback;
  const TIMER_PROMISIFY = Symbol.for("nodejs.util.promisify.custom");
  const guardTimer = (
    original: (...args: unknown[]) => unknown,
  ): ((...args: unknown[]) => unknown) => {
    const wrapper = (...args: unknown[]) =>
      Reflect.apply(original, undefined, [guardTimerCallback(args[0]), ...args.slice(1)]);
    // `util.promisify(setTimeout)` keeps its own form; after the exit its promise
    // simply never settles.
    const promisified = Reflect.get(original, TIMER_PROMISIFY);
    if (isCallable(promisified)) {
      Reflect.set(wrapper, TIMER_PROMISIFY, (...args: unknown[]) =>
        exitCalled ? new Promise<never>(() => null) : Reflect.apply(promisified, original, args),
      );
    }
    return wrapper;
  };
  const guardTimers = (holder: object): void => {
    for (const name of ["setTimeout", "setInterval", "setImmediate"]) {
      const original = Reflect.get(holder, name);
      if (isCallable(original)) Reflect.set(holder, name, guardTimer(original));
    }
  };

  // --- worker-realm builtin patching (Section 3) -----------------------------
  // Each worker thread has its own instances of the Node builtin modules and
  // the worker is fresh per call, so patching the real module objects IN PLACE
  // scopes every wrapper to this script run and covers every import path: the
  // entry script's require/jitiImport, relative helper modules compiled by
  // jiti, createRequire(import.meta.url), process.getBuiltinModule, and ESM
  // named imports (via syncBuiltinESMExports below).
  const realFs: Record<string, unknown> = nativeRequire("node:fs");
  // node:fs/promises exports the SAME object as fs.promises (one builtin
  // module, two specifiers), so patching either view patches both.
  const realFsPromises: Record<string, unknown> = nativeRequire("node:fs/promises");
  const realChildProcess: Record<string, unknown> = nativeRequire("node:child_process");
  const realPath: Record<string, unknown> = nativeRequire("node:path");
  const realTimers: Record<string, unknown> = nativeRequire("node:timers");
  // node:timers/promises hands back a promise or an async iterable instead of a handle, so the
  // pending timers of a script's own import would settle after the exit and run its code
  // (Section 3): a value it produced never settles once the exit has happened.
  const realTimerPromises: Record<string, unknown> = nativeRequire("node:timers/promises");
  guardTimers(globalThis);
  guardTimers(realTimers);
  const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    isOptionsObject(value) && "then" in value && isCallable(value.then);
  /** A pending value that would settle after the exit never settles instead (Section 3). */
  const guardSettling = (pending: PromiseLike<unknown>): Promise<unknown> =>
    new Promise((fulfil, fail) => {
      pending.then(
        (settled: unknown) => {
          if (!exitCalled) fulfil(settled);
        },
        (error: unknown) => {
          if (!exitCalled) fail(error);
        },
      );
    });
  /** An async iterable whose `next()` never settles once the exit has happened. */
  const guardAsyncIterable = (value: unknown): unknown => {
    // The module returns an async generator, which is its own iterator: `next` is patched on
    // that object, so `return`, `throw` and the prototype chain stay as they were.
    if (!isOptionsObject(value)) return value;
    const next: unknown = Reflect.get(value, "next");
    if (!isCallable(next)) return value;
    Reflect.set(value, "next", (...args: unknown[]) => {
      const pending: unknown = Reflect.apply(next, value, args);
      return isThenable(pending) ? guardSettling(pending) : pending;
    });
    return value;
  };
  const guardTimerPromise =
    (original: (...args: unknown[]) => unknown, receiver: object) =>
    (...args: unknown[]) => {
      const result: unknown = Reflect.apply(original, receiver, args);
      return isThenable(result) ? guardSettling(result) : guardAsyncIterable(result);
    };
  for (const name of ["setTimeout", "setInterval", "setImmediate"]) {
    const original = realTimerPromises[name];
    if (isCallable(original)) {
      realTimerPromises[name] = guardTimerPromise(original, realTimerPromises);
    }
  }
  const scheduler = realTimerPromises.scheduler;
  if (isOptionsObject(scheduler) && isCallable(scheduler.wait)) {
    // `scheduler.wait` needs the scheduler as its receiver.
    Reflect.set(scheduler, "wait", guardTimerPromise(scheduler.wait, scheduler));
  }

  // fs: every relative path argument resolves against the script cwd
  // (Section 3). `symlink` remains FS_PATH_SECOND-only, so its first argument
  // (the link target) is passed unchanged, as before.
  for (const name of new Set([...FS_PATH_FIRST, ...FS_PATH_SECOND, ...FS_GLOB])) {
    const sync = realFs[name];
    if (isCallable(sync)) realFs[name] = wrapFsFunction(name, sync, realFs);
    const async = realFsPromises[name];
    if (isCallable(async)) realFsPromises[name] = wrapFsFunction(name, async, realFsPromises);
  }

  // path.resolve resolves against the script cwd (Section 3).
  const origPathResolve = realPath.resolve;
  if (typeof origPathResolve === "function") {
    realPath.resolve = (...args: string[]) =>
      Reflect.apply(origPathResolve, realPath, [cwd, ...args]);
  }

  // process: patch the worker realm's real process module IN PLACE (Section 3),
  // like fs/path above. The scriptProcess proxy only serves the entry script's
  // bindings and the require("process") path; helper modules reach the real
  // module by other roads (bare global `process`, default ESM import,
  // createRequire, getBuiltinModule) and would otherwise observe the host cwd
  // and a live exit. Closing over the same `cwd` keeps every access path in
  // lockstep, including the entry proxy's cwd/chdir.
  const realProcess: NodeJS.Process = nativeRequire("node:process");
  const scriptExit = (code?: number) => postExit(code);
  Object.defineProperty(realProcess, "cwd", {
    value: () => cwd,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(realProcess, "chdir", {
    value: changeDir,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(realProcess, "exit", {
    value: scriptExit,
    configurable: true,
    writable: true,
  });
  // stdout/stderr: patch the `write` method ON THE REAL STREAM OBJECTS rather
  // than replacing the properties — the worker realm's internals read private
  // symbols such as `process.stdout[kStdioWantsMoreDataCallback]`, which a
  // bare replacement object would drop.
  const patchWrite = (
    stream: typeof process.stdout | typeof process.stderr,
    type: "stdout" | "stderr",
  ): void => {
    Object.defineProperty(stream, "write", {
      value: captureWrite(type),
      configurable: true,
      writable: true,
    });
  };
  patchWrite(realProcess.stdout, "stdout");
  patchWrite(realProcess.stderr, "stderr");

  // --- child_process PID tracking -------------------------------------------
  // Spawned children are owned by the host runtime; their PIDs and whether each
  // leads its own process group are reported so the main thread can terminate
  // the process tree on timeout/abort/kill.
  const trackChild = (child: ChildProcess, detached: boolean): ChildProcess => {
    const pid = child.pid;
    if (typeof pid === "number") {
      try {
        port.postMessage({ type: "child-pid", pid, detached });
      } catch {
        // Port closed.
      }
      child.once("exit", () => {
        try {
          port.postMessage({ type: "child-exit", pid });
        } catch {
          // Port closed.
        }
      });
    }
    return child;
  };
  // --- child stdio resolution (Section 6) -------------------------------------
  // A child process a script spawns never receives the host process's standard
  // streams: an element that is "inherit", a numeric fd 0/1/2, or one of the
  // worker's own process.stdin/stdout/stderr (the entry proxy's tagged capture
  // streams included) resolves to "ignore" (stdin) or a pipe (stdout, stderr)
  // whose chunks the run captures like the worker's own writes. Every other
  // element — another numeric fd, an already-open file, "ignore", "pipe" —
  // passes through unchanged; a caller-chosen pipe stays the script's to read
  // itself. fork carries an IPC channel in its stdio array and inherits the
  // worker's streams when silent is unset or false, so its default resolves to
  // the full 4-element form.
  interface ChildStdio {
    stdio: unknown;
    /** The child's stdout/stderr became capture pipes through this resolution. */
    pipes: { stdout: boolean; stderr: boolean };
  }
  const isHostStdElement = (element: unknown): boolean =>
    element === "inherit" ||
    element === 0 ||
    element === 1 ||
    element === 2 ||
    element === process.stdin ||
    element === process.stdout ||
    element === process.stderr ||
    (typeof element === "object" && element !== null && captureTag in element);
  const resolveStdio = (stdio: unknown, ipc: boolean): ChildStdio | undefined => {
    if (stdio === "inherit") {
      return {
        stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
        pipes: { stdout: true, stderr: true },
      };
    }
    if (Array.isArray(stdio)) {
      let touched = false;
      const pipes = { stdout: false, stderr: false };
      const next = stdio.map((element, index) => {
        if (!isHostStdElement(element)) return element;
        touched = true;
        if (index === 1) pipes.stdout = true;
        if (index === 2) pipes.stderr = true;
        return index === 0 ? "ignore" : "pipe";
      });
      return touched ? { stdio: next, pipes } : undefined;
    }
    return undefined;
  };
  // Forward a resolved child pipe into the run's capture (Section 6): one
  // `captureWrite` post per data event, in arrival order, like the worker's own
  // writes. A pipe error is reported into the captured stderr, not thrown or
  // dropped.
  const forwardChildOutput = (
    child: ChildProcess,
    forward: { stdout: boolean; stderr: boolean },
  ): void => {
    const attach = (stream: ChildProcess["stdout"], type: "stdout" | "stderr"): void => {
      if (!stream) return;
      stream.on("error", (error: Error) => {
        captureWrite("stderr")(`pi-dent: child ${type} pipe error: ${error.message}\n`);
      });
      stream.on("data", (chunk: unknown) => captureWrite(type)(chunk));
    };
    if (forward.stdout) attach(child.stdout, "stdout");
    if (forward.stderr) attach(child.stderr, "stderr");
  };
  // Spawned children must lead their own process group so the runner can
  // terminate the whole tree with kill(-pid) (Section 6). On POSIX, default
  // detached: true when the caller did not set it; an explicit caller value is
  // kept. Processes also default cwd to the script's cwd when not set
  // (Section 3). Options can be the 2nd or 3rd argument; exec/execFile may take a
  // callback in place of options; options may be omitted entirely.
  // Returns the rewritten arguments plus the effective detached value, which
  // drives the exec/execFile spawn latch below, and which stdio pipes of the
  // child the wrapper must forward into the capture.
  const withDetachedDefault = (
    method: string,
    args: unknown[],
  ): { args: unknown[]; detached: boolean; forward: { stdout: boolean; stderr: boolean } } => {
    const next = [...args];
    // Options occupy the slot immediately before the optional callback: index 1
    // or 2 for spawn/fork/execFile, index 1 only for exec. A callback may also
    // stand in place of options (execFile(f, cb), exec(cmd, cb)).
    const optionSlots = method === "exec" ? [1] : [1, 2];
    let optionsIndex = -1;
    let options: Record<string, unknown> | undefined;
    for (const slot of optionSlots) {
      if (next.length > slot && isOptionsObject(next[slot])) {
        optionsIndex = slot;
        options = next[slot];
        break;
      }
    }
    if (options !== undefined) {
      let optionsModified = false;
      let newOptions = { ...options };
      if (process.platform !== "win32" && !("detached" in newOptions)) {
        newOptions.detached = true;
        optionsModified = true;
      }
      if (!("cwd" in newOptions) || newOptions.cwd === undefined) {
        newOptions.cwd = cwd;
        optionsModified = true;
      } else if (typeof newOptions.cwd === "string") {
        // A relative caller `cwd` resolves against the script cwd, not the
        // host process cwd (Section 3).
        const resolvedCwd = resolvePathArg(newOptions.cwd);
        if (resolvedCwd !== newOptions.cwd) {
          newOptions.cwd = resolvedCwd;
          optionsModified = true;
        }
      }
      // A caller-supplied `env` keeps the session's agent directory and temp
      // variables unless it names them itself (Section 6).
      const callerEnv = newOptions.env;
      if (isOptionsObject(callerEnv)) {
        const injected: Record<string, string> = {};
        const sessionDir = process.env.PI_DENT_SESSION_DIR;
        if (sessionDir !== undefined && !("PI_DENT_SESSION_DIR" in callerEnv)) {
          injected.PI_DENT_SESSION_DIR = sessionDir;
        }
        for (const name of TEMP_VARIABLES) {
          const value = process.env[name];
          if (value !== undefined && !(name in callerEnv)) injected[name] = value;
        }
        if (Object.keys(injected).length > 0) {
          newOptions.env = { ...callerEnv, ...injected };
          optionsModified = true;
        }
      }
      // Child stdio resolution (Section 6): resolve inherited elements before
      // the spawn, and mark which pipes the wrapper must forward into the
      // capture. fork's own stdio is inherited when silent is unset or false,
      // so it needs the explicit resolved array; its silent pipes are forwarded
      // as node built them. A caller-chosen pipe (spawn/fork stdio "pipe") is
      // not forwarded — the script reads it itself.
      const forward = { stdout: false, stderr: false };
      if (method === "fork") {
        const callerStdio = newOptions.stdio;
        if (callerStdio === undefined || callerStdio === null) {
          if (newOptions.silent === true) {
            // node already pipes the child's stdio; forward those pipes.
            forward.stdout = true;
            forward.stderr = true;
          } else {
            newOptions.stdio = ["ignore", "pipe", "pipe", "ipc"];
            forward.stdout = true;
            forward.stderr = true;
            optionsModified = true;
          }
        } else {
          const resolved = resolveStdio(callerStdio, true);
          if (resolved !== undefined) {
            newOptions.stdio = resolved.stdio;
            forward.stdout = resolved.pipes.stdout;
            forward.stderr = resolved.pipes.stderr;
            optionsModified = true;
          }
        }
      } else {
        const resolved = resolveStdio(newOptions.stdio, false);
        if (resolved !== undefined) {
          newOptions.stdio = resolved.stdio;
          forward.stdout = resolved.pipes.stdout;
          forward.stderr = resolved.pipes.stderr;
          optionsModified = true;
        }
      }
      if (optionsModified) {
        next[optionsIndex] = newOptions;
      }
      return {
        args: next,
        detached: process.platform !== "win32" && newOptions.detached === true,
        forward,
      };
    }
    // No options argument: insert before the first callback so the options stay
    // in the slot Node reads (options after a callback are re-interpreted and
    // dropped). With no callback, append after the last fixed argument.
    const callbackIndex = next.findIndex((arg) => typeof arg === "function");
    const insertAt =
      callbackIndex === -1 ? Math.min(next.length, optionSlots.length) : callbackIndex;
    const newOptions: Record<string, unknown> = { cwd };
    if (process.platform !== "win32") {
      newOptions.detached = true;
    }
    const forward = { stdout: false, stderr: false };
    if (method === "fork") {
      // fork with no options inherits the worker's streams outright (Section 6).
      newOptions.stdio = ["ignore", "pipe", "pipe", "ipc"];
      forward.stdout = true;
      forward.stderr = true;
    }
    if (insertAt > 0 && (next[insertAt - 1] === null || next[insertAt - 1] === undefined)) {
      next[insertAt - 1] = newOptions;
    } else {
      next.splice(insertAt, 0, newOptions);
    }
    return { args: next, detached: newOptions.detached === true, forward };
  };
  // exec/execFile build the low-level spawn options from a fixed field
  // allowlist that drops `detached`, so Node never detaches them no matter what
  // the options object says. Patch this worker realm's ChildProcess.spawn
  // (workers have their own realm; the host is unaffected) so the single child
  // spawned by an exec/execFile call still leads its own process group while
  // the wrapper holds `execDetached` set; the latch carries the caller's
  // effective detached value, so an explicit `detached: false` is respected.
  let execDetached = false;
  const childSpawn = Reflect.get(ChildProcess.prototype, "spawn");
  if (typeof childSpawn === "function") {
    Reflect.set(
      ChildProcess.prototype,
      "spawn",
      function (this: ChildProcess, options: Record<string, unknown> | null | undefined) {
        if (!execDetached || options === null || options === undefined) {
          return Reflect.apply(childSpawn, this, [options]);
        }
        return Reflect.apply(childSpawn, this, [{ ...options, detached: true }]);
      },
    );
  }
  // Originals captured BEFORE patching: the wrappers below must call the
  // native functions, not the patched exports (avoiding infinite recursion).
  const isChildProcessFactory = (value: unknown): value is (...args: unknown[]) => ChildProcess =>
    typeof value === "function";
  const spawnOriginals = new Map<string, (...args: unknown[]) => ChildProcess>();
  for (const name of ["spawn", "exec", "execFile", "fork"]) {
    const original = realChildProcess[name];
    if (isChildProcessFactory(original)) spawnOriginals.set(name, original);
  }
  // Sync child-process calls are rejected with an error (Section 6).
  for (const name of ["spawnSync", "execSync", "execFileSync"]) {
    realChildProcess[name] = () => {
      throw new Error(
        `child_process.${name} is rejected in Script; use async spawn, exec, or execFile instead`,
      );
    };
  }
  // Async spawn-family wrappers: default `detached` so each child leads its
  // own process group, report the PID for tree termination, and resolve the
  // child's stdio so the host's streams never reach it (Section 6).
  const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
  for (const [name, original] of spawnOriginals) {
    const wrapper = (...args: unknown[]) => {
      const applied = withDetachedDefault(name, args);
      let child: ChildProcess;
      if (name === "exec" || name === "execFile") {
        // The native call spawns synchronously; keep the latch scoped.
        execDetached = applied.detached;
        try {
          child = trackChild(original(...applied.args), applied.detached);
        } finally {
          execDetached = false;
        }
      } else {
        child = trackChild(original(...applied.args), applied.detached);
      }
      // Resolved stdio pipes capture into the run (Section 6).
      forwardChildOutput(child, applied.forward);
      return child;
    };
    if (Reflect.has(original, promisifyCustom)) {
      Reflect.set(wrapper, promisifyCustom, (...args: unknown[]) => {
        let child: ChildProcess | undefined;
        const promise = new Promise<{ stdout: unknown; stderr: unknown }>((res, rej) => {
          child = wrapper(...args, (err: Error | null, stdout: unknown, stderr: unknown) => {
            if (err === null) {
              res({ stdout, stderr });
            } else {
              Object.assign(err, { stdout, stderr });
              rej(err);
            }
          });
        });
        return Object.assign(promise, { child });
      });
    }
    realChildProcess[name] = wrapper;
  }

  // console capture must hold for every access path (Section 3): the worker
  // realm's global console is replaced outright (a helper module compiled by
  // jiti reads the real global), and scriptGlobal serves it for the `console`
  // property; the entry script's `console` binding already points at
  // scriptConsole.
  Reflect.set(globalThis, "console", scriptConsole);

  // ESM named imports (`import { readFileSync } from "node:fs"`) must observe
  // the patched functions too (Section 3).
  syncBuiltinESMExports();

  // Fresh compilation every call (Section 3): no module cache and no on-disk
  // transpile cache (fsCache) — every module is recompiled afresh per run.
  const jiti = createJiti(data.filename, {
    moduleCache: false,
    fsCache: false,
    alias: data.aliases,
  });

  // fs / child_process / path need no interception here: the real builtin
  // module objects were patched in place above, so every require — entry script,
  // relative helper module, createRequire, process.getBuiltinModule — already
  // returns the cwd-observing, tracked modules.
  const scriptRequire = new Proxy(jiti, {
    apply(target, thisArg, args) {
      const [specifier] = args;
      if (specifier === "process" || specifier === "node:process") return scriptProcess;
      return Reflect.apply(target, thisArg, args);
    },
  });

  // jiti's transform rewrites dynamic `import()` to `jitiImport(...)`; provide
  // the binding so `await import(...)` works. node builtins resolve through
  // the ESM loader, whose named exports were re-linked by
  // syncBuiltinESMExports above, so they observe the patched modules (Section 3).
  const jitiImport = async (specifier: string): Promise<unknown> => {
    if (specifier === "process" || specifier === "node:process") return scriptProcess;
    return jiti.import(specifier);
  };

  let mod: { default: unknown } | undefined;
  try {
    const cjs = jiti.transform({ source: data.code, filename: data.filename, ts: true });
    if (typeof cjs !== "string" || cjs.length === 0) {
      throw new Error("jiti.transform returned empty output");
    }
    const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
    const bindings = {
      module: moduleObj,
      exports: moduleObj.exports,
      require: scriptRequire,
      jitiImport,
      __filename: data.filename,
      __dirname: dirname(data.filename),
      input: data.input,
      tools: scriptTools,
      dent: scriptDent,
      Buffer,
      process: scriptProcess,
      console: scriptConsole,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      queueMicrotask,
      URL,
      URLSearchParams,
      TextDecoder,
      TextEncoder,
      AbortController,
      AbortSignal,
      fetch,
      crypto,
      structuredClone,
      globalThis: scriptGlobal,
      global: scriptGlobal,
    };
    // Async function bodies never yield completion values, so a bare final
    // expression is only observable when the code runs as a plain script.
    // Scripts reject top-level await, return, and a `var` that redeclares a
    // binding name; those run in the async-IIFE wrapper instead (completion
    // falls back to undefined). The probe above decides the top-level `await`
    // case by compiling, so `await` in a comment, string, template, regex, or
    // nested function keeps the plain script path.
    const strict = '"use strict";';
    const names = Object.keys(bindings).filter((n) => n !== "globalThis" && n !== "global");
    // The user code sits in its own block, so its own `const`/`let`/`function`/
    // `class` declaration of a binding name shadows the prologue; a block keeps
    // the script's completion value (Section 4).
    const prologue =
      `${strict}\n` +
      `const __piDent = __piDentBindings;\n` +
      `const { ${names.join(", ")} } = __piDent;\n` +
      `const { globalThis, global } = __piDent; {\n`;
    let script: vm.Script | undefined;
    if (cjs.startsWith(strict) && !hasTopLevelAwait(cjs.slice(strict.length))) {
      try {
        script = new vm.Script(`${prologue}${cjs.slice(strict.length)}\n}`, {
          filename: data.filename,
          lineOffset: -4,
        });
      } catch {
        script = undefined;
      }
    }
    let completion: unknown;
    if (script === undefined) {
      const wrapped = `return (async () => {\n${cjs}\n})()`;
      const executeScript = vm.compileFunction(wrapped, Object.keys(bindings), {
        filename: data.filename,
        lineOffset: -1,
        columnOffset: 0,
      });
      await executeScript.call(scriptGlobal, ...Object.values(bindings));
    } else {
      Reflect.set(globalThis, "__piDentBindings", bindings);
      try {
        completion = script.runInThisContext();
        // The strict directive and CJS export plumbing leak as the completion
        // value when the final statement is not an expression (Section 4:
        // undefined then).
        if (completion === "use strict" || completion === moduleObj.exports) {
          completion = undefined;
        }
      } finally {
        Reflect.deleteProperty(globalThis, "__piDentBindings");
      }
    }
    const exportsValue: unknown = moduleObj.exports;
    if (exportsValue !== null && typeof exportsValue === "object" && "default" in exportsValue) {
      mod = { default: exportsValue.default };
    } else if (
      // `module.exports = <primitive or null>`: the value itself is the return
      // value. Reading a property from a primitive (`"default" in 5`) throws an
      // internal TypeError, and functions are not structured-cloneable, so a
      // plain `module.exports = function` keeps the completion-value fallback.
      (exportsValue === null ||
        (typeof exportsValue !== "object" && typeof exportsValue !== "function")) &&
      exportsValue !== undefined
    ) {
      mod = { default: exportsValue };
    } else if (completion !== undefined) {
      // No default export: the completion value is the return value (Section 4).
      mod = { default: completion };
    }
  } catch (err) {
    // The exit already settled the run (Section 3); the worker stays up for the
    // runner's termination and the reaping of the tree it kills (Section 6).
    if (exitCalled || isScriptExit(err)) return;
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e);
    return;
  }
  // A script that caught the exit's error reaches its own end; its run already
  // settled as exit-called, so there is no result to report.
  if (exitCalled) return;
  // Section 4: a return value that cannot be structured-cloned degrades, without
  // failing the run, to the `<non-cloneable: <error>>` marker string. The check
  // happens here, where the original value still exists. A value that clones
  // (a class instance becomes a plain object) keeps its original for rendering:
  // the render must show the real prototype (Section 5), so it happens before
  // the clone below.
  let exported: unknown = mod?.default;
  try {
    structuredClone(exported);
  } catch (cloneErr) {
    exported = `<non-cloneable: ${String(cloneErr)}>`;
  }
  const rendered = renderReturn(exported);
  try {
    port.postMessage({
      type: "result",
      rendered: rendered.rendered,
      render: rendered.render,
      json: rendered.json,
      returnValue:
        rendered.jsonValue === undefined
          ? { type: "non-json-return-value", representation: rendered.rendered }
          : rendered.jsonValue,
    });
  } catch {
    // Port closed.
  }
})();
