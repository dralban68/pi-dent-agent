import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  searchRuntime,
  type LoweredStepLimits,
  type SearchHost,
  type SearchProgress,
  type SearchRuntime,
} from "../../lib/search-tool.ts";
import { openSessionIndex } from "../../lib/session-index.ts";

/**
 * Fixtures for specs/search-tool.md: a throwaway directory with session files and
 * an index path inside it, an injected clock, and a call wrapper that reports the
 * result text, its lines, and its details. No test touches the real index or a
 * real session.
 */

/**
 * The main thread's own CPU time so far, in milliseconds. Unlike wall time it
 * does not grow while the OS runs other processes, so cost bounds measured with
 * it hold on a loaded machine.
 */
export function threadCpuMs(): number {
  const usage = process.threadCpuUsage();
  return (usage.user + usage.system) / 1000;
}

/**
 * The longest the main thread ran without yielding to the event loop while
 * `work` ran, in milliseconds (specs/search-tool.md#abort, the 250 ms
 * bound). A 5 ms interval timer marks each yield; between two ticks it counts
 * the main thread's own CPU time, not wall time, so time the OS spends running
 * other processes on a loaded machine does not count as holding the loop.
 */
export async function largestHold(work: () => Promise<void>): Promise<number> {
  let lastWall = performance.now();
  let lastCpu = threadCpuMs();
  let hold = 0;
  const timer = setInterval(() => {
    const wall = performance.now();
    const cpu = threadCpuMs();
    hold = Math.max(hold, Math.min(wall - lastWall, cpu - lastCpu));
    lastWall = wall;
    lastCpu = cpu;
  }, 5);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return Math.round(hold);
}

const roots: string[] = [];

/** Remove every temporary directory a test made. */
export function cleanupRoots(): void {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
}

/** A temporary directory for fixtures, removed by `cleanupRoots`. */
export function tempDir(prefix = "search-tool-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

/** The instant every fixture entry is relative to. */
export const START = Date.UTC(2026, 0, 1, 0, 0, 0);

/** The timestamp of second `seconds` after `START`, as an RFC 3339 date-time. */
export function stamp(seconds: number): string {
  return new Date(START + seconds * 1000).toISOString();
}

/** The instant of `seconds` after `START`. */
export function instant(seconds: number): number {
  return START + seconds * 1000;
}

/** The line of one JSON object, no line feed. */
export function entryLine(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/** A session header's line (specs/session-transcript.md#reading). */
export function headerLine(id = "session-one", seconds = 0): string {
  return entryLine({ type: "session", version: 3, id, timestamp: stamp(seconds), cwd: "/tmp" });
}

/** A `message` entry's line with `message` as given. */
export function messageLine(
  id: string,
  parentId: string | null,
  message: Record<string, unknown>,
  seconds = 0,
): string {
  return entryLine({ type: "message", id, parentId, timestamp: stamp(seconds), message });
}

/** A `user` entry's line whose content is one text element. */
export function userLine(id: string, parentId: string | null, text: string, seconds = 0): string {
  return messageLine(id, parentId, { role: "user", content: [{ type: "text", text }] }, seconds);
}

/** An `assistant` entry's line with the content elements given. */
export function assistantLine(
  id: string,
  parentId: string | null,
  content: readonly unknown[],
  seconds = 0,
): string {
  return messageLine(id, parentId, { role: "assistant", content }, seconds);
}

/** One `toolCall` content element. */
export function toolCall(id: string, name: string, args: Record<string, unknown>): unknown {
  return { type: "toolCall", id, name, arguments: args };
}

/** A `toolResult` entry's line. */
export function toolResultLine(
  id: string,
  parentId: string | null,
  toolName: string,
  toolCallId: string,
  text: string,
  isError = false,
  seconds = 0,
): string {
  return messageLine(
    id,
    parentId,
    { role: "toolResult", toolName, toolCallId, isError, content: [{ type: "text", text }] },
    seconds,
  );
}

/** A `custom_message` entry's line. */
export function injectedLine(
  id: string,
  parentId: string | null,
  customType: string,
  text: string,
  seconds = 0,
): string {
  return entryLine({
    type: "custom_message",
    id,
    parentId,
    timestamp: stamp(seconds),
    customType,
    content: text,
  });
}

/** A `compaction` entry's line. */
export function compactionLine(
  id: string,
  parentId: string | null,
  summary: string,
  seconds = 0,
): string {
  return entryLine({ type: "compaction", id, parentId, timestamp: stamp(seconds), summary });
}

/** A session file's text: each line terminated by a line feed. */
export function fileText(...lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

/** Write a session file of the given lines, each terminated by a line feed. */
export function writeSession(path: string, ...lines: readonly string[]): void {
  writeFileSync(path, fileText(...lines));
}

/** Set a file's modification time, in milliseconds since the Unix epoch. */
export function setMtime(path: string, milliseconds: number): void {
  const seconds = milliseconds / 1000;
  utimesSync(path, seconds, seconds);
}

/** An injected clock: time moves only when a test sets or advances it. */
export interface TestClock {
  now: () => number;
  /** Set the current instant. */
  set(milliseconds: number): void;
  /** Move the current instant forward. */
  advance(milliseconds: number): void;
}

export function testClock(start = START): TestClock {
  let value = start;
  return {
    now: () => value,
    set: (milliseconds) => {
      value = milliseconds;
    },
    advance: (milliseconds) => {
      value += milliseconds;
    },
  };
}

/** One call's result, as a test reads it. */
export interface Outcome {
  text: string;
  lines: string[];
  details: Record<string, unknown>;
  isError: boolean;
  /** The wall time the call took, in milliseconds. */
  elapsed: number;
}

/** A runtime with its clock, its progress events, and a hook a test can set. */
export interface Harness {
  runtime: SearchRuntime;
  clock: TestClock;
  /** Every progress event the runtime reported. */
  events: SearchProgress[];
  /** Replace the hook the runtime calls at each checkpoint. */
  hook(next: ((event: SearchProgress) => void) | undefined): void;
  /** One call of the tool. */
  call(host: SearchHost, params: Record<string, unknown>, signal?: AbortSignal): Promise<Outcome>;
}

/**
 * The step limits the fixtures sized to them use, lowered through the test seam
 * (specs/search-tool.md#test-seam) in the order its rules keep, so that a
 * fixture of hundreds of rows takes the paths the real limits take at tens of
 * thousands.
 */
export const SMALL_LIMITS = {
  fileModeLines: 1200,
  windowRows: 600,
  groupRows: 300,
  groupChunkRows: 50,
  collectionRows: 40,
  collectionChunkItems: 1200,
  firstLookupMatches: 20,
  probeByIdRows: 10,
} as const satisfies LoweredStepLimits;

export function harness(options: {
  db: string;
  clock?: TestClock;
  bootDeadline?: number;
  busyTimeoutMs?: number;
  onItemRead?: () => void;
  limits?: LoweredStepLimits;
}): Harness {
  const clock = options.clock ?? testClock();
  const events: SearchProgress[] = [];
  let hook: ((event: SearchProgress) => void) | undefined;
  const runtime = searchRuntime({
    indexPath: options.db,
    zone: "UTC",
    now: clock.now,
    progress: (event) => {
      events.push(event);
      hook?.(event);
    },
    ...(options.bootDeadline === undefined ? {} : { bootDeadline: options.bootDeadline }),
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    ...(options.onItemRead === undefined ? {} : { onItemRead: options.onItemRead }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return {
    runtime,
    clock,
    events,
    hook: (next) => {
      hook = next;
    },
    async call(host, params, signal) {
      const started = Date.now();
      const result = await runtime.execute({
        ...host,
        params: params as never,
        signal,
      });
      const elapsed = Date.now() - started;
      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      return {
        text,
        lines: text.split("\n"),
        details: result.details,
        isError: result.isError === true,
        elapsed,
      };
    },
  };
}

/** The hit lines of a `find` result: those that start with an item address. */
export function hitLines(outcome: Outcome): string[] {
  return outcome.lines.filter((line) => line.includes(" \u00b7 ") && !line.startsWith("---"));
}

/** The addresses of a `find` result's hit lines, in order. */
export function hitAddresses(outcome: Outcome): string[] {
  return hitLines(outcome).map((line) => line.slice(0, line.indexOf(" \u00b7 ")));
}

/** A session directory with a main session file and its agent directory. */
export interface Fixture {
  root: string;
  sessions: string;
  mainFile: string;
  agentDir: string;
  db: string;
}

/** A project directory: the sessions directory, a main session file, and an index path. */
export function fixture(prefix = "search-tool-"): Fixture {
  const root = tempDir(prefix);
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  const mainFile = join(sessions, "m1.jsonl");
  const agentDir = join(sessions, "m1.agents");
  mkdirSync(agentDir, { recursive: true });
  return { root, sessions, mainFile, agentDir, db: join(root, "search-v3.sqlite") };
}

/** A project with one small invoking session, one other session, and many tiny other sessions. */
export function crowded(
  sessions: number,
  prefix = "search-tool-fixes-",
): {
  host: SearchHost;
  db: string;
  other: string;
  root: string;
} {
  const made = fixture(prefix);
  writeSession(
    made.mainFile,
    headerLine("main-session-0001"),
    userLine("a", null, "alpha needle a", 1),
    userLine("b", "a", "alpha b", 2),
  );
  const other = join(made.sessions, "m2.jsonl");
  writeSession(other, headerLine("other-session-0002"), userLine("v1", null, "needle other", 1));
  for (let index = 0; index < sessions; index += 1) {
    writeSession(
      join(made.sessions, `z${String(index).padStart(5, "0")}.jsonl`),
      headerLine(`noise-${String(index).padStart(6, "0")}`),
      userLine("n1", null, `noise ${index} haystack`, 2),
    );
  }
  return {
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
    db: made.db,
    other,
    root: made.root,
  };
}

/** Catch every given session file up into the index at `db`, as a warm-up call would. */
export async function seed(db: string, paths: readonly string[]): Promise<void> {
  const opened = openSessionIndex({ path: db });
  if (!opened.ok) throw new Error(opened.reason);
  for (const path of paths) await opened.index.catchUp(path);
  opened.index.close();
}

/** A project of `sessions` sessions of `items` items each; every seventh item holds `needle`. */
export function many(
  sessions: number,
  items: number,
  prefix = "search-tool-evaluation-",
): { host: SearchHost; db: string; sessions: number; items: number } {
  const made = fixture(prefix);
  for (let s = 0; s < sessions; s += 1) {
    const lines: string[] = [headerLine(`session-${String(s).padStart(4, "0")}`)];
    let parent: string | null = null;
    for (let i = 0; i < items; i += 1) {
      const id = `e${s}_${i}`;
      lines.push(
        userLine(
          id,
          parent,
          `item ${s} ${i} ${i % 7 === 0 ? "needle" : "haystack"}`,
          s * items + i,
        ),
      );
      parent = id;
    }
    // The invoking session is one of the project's files; the rest are its members.
    const path =
      s === 0 ? made.mainFile : join(made.sessions, `s${String(s).padStart(4, "0")}.jsonl`);
    writeSession(path, ...lines);
  }
  return {
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
    db: made.db,
    sessions,
    items,
  };
}
