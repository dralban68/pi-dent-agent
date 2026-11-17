import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootSnapshot, ToolResult } from "../../lib/engine.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { HostSession } from "../../lib/host.ts";
import type { PluginEntry } from "../../lib/plugins.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import { appendStream, type StreamCapture } from "../../lib/script-runner.ts";
import { makeScriptTool } from "../../lib/script-tool.ts";
import { must } from "../support/must.ts";

/**
 * Script runner conformance per specs/script-tool.md Sections 3 and 6: process
 * group termination on timeout/abort/kill, task row status mapping, and the
 * 1 MiB UTF-8 byte output cap.
 */

interface Fixture {
  tool: ReturnType<typeof makeScriptTool>;
  registry: TaskRegistry;
  root: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-script-runner-"));
  const pluginRoot = join(root, "plug");
  mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
  writeFileSync(join(pluginRoot, "scripts", "hello.ts"), `export default { ok: true };`);
  const plugin: PluginEntry = { name: "plug", root: pluginRoot, commands: [] };
  const boot = { pluginIndex: new Map([["plug", plugin]]) } as unknown as BootSnapshot;
  const host: HostSession = {
    cwd: () => root,
    sessionId: () => "sess-test",
    sessionFile: () => undefined,
    sessionDir: () => root,
    model: () => undefined,
    thinking: () => undefined,
    activeTools: () => ["Script"],
    inventory: () => [],
    configuredModels: () => [],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
  const registry = new TaskRegistry(() => host);
  const tool = makeScriptTool({
    boot,
    registry: () => registry,
    hostProvider: () => host,
    cohortFor: (id) => `cohort-${id}`,
    agentDir: () => join(root, "agent"),
  });
  return { tool, registry, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const noCtx = undefined as unknown as ExtensionToolContext;

async function call(
  fixture: Fixture,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return fixture.tool.execute("call-1", params as never, signal, undefined, noCtx);
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((res) => setTimeout(res, 50));
  }
}

/** The script spawns a detached process group and records both PIDs. */
const DETACHED_GROUP = `
  import { spawn } from "node:child_process";
  import { writeFileSync } from "node:fs";
  const c = spawn("sh", ["-c", "sleep 47 & echo $! > " + process.cwd() + "/sleep.pid; sleep 48"], { detached: true });
  writeFileSync("c.pid", String(c.pid));
  await new Promise(() => {});
`;

function readPids(root: string): number[] {
  const pids: number[] = [];
  for (const name of ["c.pid", "sleep.pid"]) {
    const p = join(root, name);
    if (existsSync(p)) {
      const pid = Number(readFileSync(p, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
  }
  return pids;
}

function assertGone(pids: number[]): void {
  assert.ok(pids.length > 0, "expected at least one recorded pid");
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `pid ${pid} should be gone`);
  }
}

function killSurvivors(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore.
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Ignore.
    }
  }
}

/** Record every `process.kill` call the runner makes, and delegate it. */
function recordKills(): {
  calls: { pid: number; signal: string | number }[];
  restore: () => void;
} {
  const original = process.kill;
  const calls: { pid: number; signal: string | number }[] = [];
  process.kill = (pid: number, signal?: string | number): true => {
    calls.push({ pid, signal: signal ?? 0 });
    if (typeof signal === "string") original(pid, signal as NodeJS.Signals);
    else original(pid, signal);
    return true;
  };
  return {
    calls,
    restore: () => {
      process.kill = original;
    },
  };
}

/** The script spawns one child that exits at once, waits for it, and returns. */
const EXITED_CHILD = (options: string): string => `
  import { spawn } from "node:child_process";
  import { writeFileSync } from "node:fs";
  const c = spawn("sh", ["-c", "exit 0"]${options});
  writeFileSync("c.pid", String(c.pid));
  await new Promise((res) => c.once("exit", res));
  export default 1;
`;

function readChildPid(root: string): number {
  const pid = Number(readFileSync(join(root, "c.pid"), "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 0, "the script records its child pid");
  return pid;
}

test("group kill: no survivor after timeout", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: DETACHED_GROUP, timeout: 2000 });
    assert.equal(r.details.exitReason, "timeout");
    await new Promise((res) => setTimeout(res, 600));
    assertGone(readPids(f.root));
  } finally {
    killSurvivors(readPids(f.root));
    f.cleanup();
  }
});

test("group kill: no survivor after Task kill", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: DETACHED_GROUP, background: true });
    const taskId = (r.details as Record<string, unknown>).taskId as string;
    const row = must(f.registry.get(taskId));
    await waitFor(() => existsSync(join(f.root, "c.pid")) && existsSync(join(f.root, "sleep.pid")));
    row.cancel?.();
    await new Promise((res) => setTimeout(res, 600));
    assertGone(readPids(f.root));
  } finally {
    killSurvivors(readPids(f.root));
    f.cleanup();
  }
});

test("group kill: no survivor after abort", async () => {
  const f = makeFixture();
  try {
    const ac = new AbortController();
    const promise = call(f, { code: DETACHED_GROUP }, ac.signal);
    await waitFor(() => existsSync(join(f.root, "c.pid")) && existsSync(join(f.root, "sleep.pid")));
    ac.abort();
    const r = await promise;
    assert.equal(r.details.exitReason, "aborted");
    await new Promise((res) => setTimeout(res, 600));
    assertGone(readPids(f.root));
  } finally {
    killSurvivors(readPids(f.root));
    f.cleanup();
  }
});

/**
 * The script spawns one detached child that starts a background `sleep` and
 * exits at once, leaving the grandchild alone in the group; the script then
 * runs forever, so only the timeout, abort, or kill ends the run.
 */
const ORPHANED_GRANDCHILD = `
  import { spawn } from "node:child_process";
  import { writeFileSync } from "node:fs";
  const c = spawn("sh", ["-c", "sleep 999 & echo $! > " + process.cwd() + "/sleep.pid; exit 0"]);
  writeFileSync("c.pid", String(c.pid));
  await new Promise(() => {});
`;

/** Wait until the direct child has exited, leaving the group to the grandchild. */
async function waitForChildExit(root: string): Promise<void> {
  const path = join(root, "c.pid");
  await waitFor(() => existsSync(path));
  const pid = Number(readFileSync(path, "utf8").trim());
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}

test("group kill: the tree of an exited child is still terminated on timeout", async () => {
  const f = makeFixture();
  try {
    const promise = call(f, { code: ORPHANED_GRANDCHILD, timeout: 1500 });
    await waitForChildExit(f.root);
    const r = await promise;
    assert.equal(r.details.exitReason, "timeout");
    await new Promise((res) => setTimeout(res, 600));
    assertGone(readPids(f.root));
  } finally {
    killSurvivors(readPids(f.root));
    f.cleanup();
  }
});

test("group kill: the tree of an exited child is still terminated on Task kill", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: ORPHANED_GRANDCHILD, background: true });
    const taskId = (r.details as Record<string, unknown>).taskId as string;
    const row = must(f.registry.get(taskId));
    await waitForChildExit(f.root);
    row.cancel?.();
    await waitFor(() => row.status !== "running");
    await new Promise((res) => setTimeout(res, 600));
    assertGone(readPids(f.root));
  } finally {
    killSurvivors(readPids(f.root));
    f.cleanup();
  }
});

/** The same tree, but the script returns at once: the run settles `ok`. */
const ORPHANED_GRANDCHILD_AND_RETURN = `
  import { spawn } from "node:child_process";
  import { writeFileSync } from "node:fs";
  const c = spawn("sh", ["-c", "sleep 999 & echo $! > " + process.cwd() + "/sleep.pid; exit 0"]);
  writeFileSync("c.pid", String(c.pid));
  await new Promise((res) => setTimeout(res, 300));
  export default 1;
`;

test("group kill: a normal completion terminates the spawned tree too", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: ORPHANED_GRANDCHILD_AND_RETURN });
    assert.equal(r.details.exitReason, "ok");
    await waitForChildExit(f.root);
    await new Promise((res) => setTimeout(res, 600));
    assertGone(readPids(f.root));
  } finally {
    killSurvivors(readPids(f.root));
    f.cleanup();
  }
});

test("group kill: an exited child whose group is empty is dropped and never signalled", async () => {
  const f = makeFixture();
  const recorder = recordKills();
  try {
    const r = await call(f, { code: EXITED_CHILD("") });
    assert.equal(r.details.exitReason, "ok");
    const pid = readChildPid(f.root);
    assert.ok(
      recorder.calls.some((entry) => entry.pid === -pid && entry.signal === 0),
      "the exit probes the group with signal 0",
    );
    assert.deepEqual(
      recorder.calls.filter((entry) => entry.pid === -pid && entry.signal !== 0),
      [],
      "a group that emptied at its leader's exit is not part of the tree",
    );
  } finally {
    recorder.restore();
    f.cleanup();
  }
});

test("group kill: a child spawned with detached false is never signalled as a group", async () => {
  const f = makeFixture();
  const recorder = recordKills();
  try {
    const r = await call(f, { code: EXITED_CHILD(", { detached: false }") });
    assert.equal(r.details.exitReason, "ok");
    const pid = readChildPid(f.root);
    assert.deepEqual(
      recorder.calls.filter((entry) => entry.pid === -pid),
      [],
      "a child outside a group of its own is never signalled by negative pid",
    );
  } finally {
    recorder.restore();
    f.cleanup();
  }
});

test("status: Task kill settles cancelled", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `await new Promise(() => {});`, background: true });
    const taskId = (r.details as Record<string, unknown>).taskId as string;
    const row = must(f.registry.get(taskId));
    row.cancel?.();
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(row.status, "cancelled");
  } finally {
    f.cleanup();
  }
});

test("status: timeout settles failed", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `while (true) {}`, background: true, timeout: 200 });
    const taskId = (r.details as Record<string, unknown>).taskId as string;
    await new Promise((res) => setTimeout(res, 400));
    const row = must(f.registry.get(taskId));
    assert.equal(row.status, "failed");
  } finally {
    f.cleanup();
  }
});

test("duration: the run ends at settlement, so the drain is not in durationMs", async () => {
  const f = makeFixture();
  try {
    // A direct child that ignores SIGTERM makes the settlement drain its full
    // 200 ms SIGTERM grace (Section 6); the run's end is its settlement
    // (Section 5), so the call outlasts durationMs by that grace. Comparing the
    // two keeps the check free of any absolute bound on this machine's speed.
    const code = `
      import { spawn } from "node:child_process";
      spawn("sh", ["-c", "trap '' TERM; sleep 30"]);
      await new Promise(() => {});
    `;
    const started = Date.now();
    const r = await call(f, { code, timeout: 1000 });
    const wallMs = Date.now() - started;
    assert.equal(r.details.exitReason, "timeout");
    const durationMs = Number(r.details.durationMs);
    assert.ok(
      wallMs - durationMs > 150,
      `call ${wallMs} ms, durationMs ${durationMs}: the drain is not part of the run`,
    );
  } finally {
    f.cleanup();
  }
});

const TRUNCATION_MARKER = "\n... [truncated] ...\n";
const CAP = 1048576;

function emptyCapture(): StreamCapture {
  return {
    text: { stdout: "", stderr: "" },
    bytes: { stdout: 0, stderr: 0 },
    truncated: { stdout: false, stderr: false },
  };
}

test("output cap: a chunk ending exactly on the cap marks later output truncated once", () => {
  const capture = emptyCapture();
  const streamed: string[] = [];
  const sink = (chunk: string): void => {
    streamed.push(chunk);
  };
  appendStream(capture, "stdout", "x".repeat(CAP), (_stream, chunk) => sink(chunk));
  assert.equal(capture.truncated.stdout, false, "an exactly-full stream is not truncated yet");
  assert.equal(capture.bytes.stdout, CAP);
  appendStream(capture, "stdout", "dropped", (_stream, chunk) => sink(chunk));
  assert.equal(capture.truncated.stdout, true, "output dropped after the cap is truncated");
  appendStream(capture, "stdout", "dropped again", (_stream, chunk) => sink(chunk));
  assert.equal(
    capture.text.stdout.split(TRUNCATION_MARKER).length - 1,
    1,
    "the marker appears exactly once",
  );
  assert.equal(capture.text.stdout, "x".repeat(CAP) + TRUNCATION_MARKER);
  assert.equal(streamed.join(""), capture.text.stdout, "streamed text matches the capture");
  assert.deepEqual(capture.truncated, { stdout: true, stderr: false });
});

test("output cap: the chunk that overflows the cap is cut and marked once", () => {
  const capture = emptyCapture();
  appendStream(capture, "stderr", "y".repeat(CAP - 2));
  appendStream(capture, "stderr", "zzzz");
  assert.equal(capture.truncated.stderr, true);
  assert.equal(capture.text.stderr, "y".repeat(CAP - 2) + "zz" + TRUNCATION_MARKER);
  appendStream(capture, "stderr", "more");
  assert.equal(capture.text.stderr.split(TRUNCATION_MARKER).length - 1, 1);
  assert.equal(capture.truncated.stdout, false, "streams are capped independently");
});

test("output cap: 1 MiB UTF-8 byte cap, no split multi-byte characters", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `console.log("é".repeat(600000)); export default 1;` });
    assert.equal(r.isError, undefined);
    const stdout = r.details.stdout as string;
    const marker = "\n... [truncated] ...\n";
    const idx = stdout.indexOf(marker);
    assert.ok(idx !== -1, "truncation marker present");
    const prefix = stdout.slice(0, idx);
    assert.equal(Buffer.byteLength(prefix), 1048576, "capped at exactly 1 MiB UTF-8 bytes");
    assert.ok(!stdout.includes("\uFFFD"), "no replacement characters");
    assert.deepEqual(r.details.truncated, { stdout: true, stderr: false });
  } finally {
    f.cleanup();
  }
});
