import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { ToolResult } from "../../lib/engine.ts";
import type { HostSession } from "../../lib/host.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import { makeBashTool, type BashSettings, type BashToolDeps } from "../../lib/bash-tool.ts";
import { at } from "../support/must.ts";

/** Fixtures for the Bash tool's tests (test/bash-tool/) and its performance tests (perf/). */

export interface Fixture {
  deps: BashToolDeps;
  registry: TaskRegistry;
  root: string;
  /** The invoking session's agent directory (specs/agent-tool.md#child-session). */
  agentDir: string;
  /** The session directory the fixture passes as `PI_DENT_SESSION_DIR` (under `root`). */
  sessionDir: string;
  host: HostSession;
  cleanup: () => void;
}

export interface FixtureOptions {
  sessionId?: string;
  settings?: BashSettings;
  /** Returning a new object on every call lets a test watch the read happen. */
  settingsFn?: (cwd: string) => BashSettings;
  extraEnv?: () => Record<string, string> | undefined;
  host?: Partial<HostSession>;
}

export function makeFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-bash-"));
  const sessionId = options.sessionId ?? `sess-bash-${Math.random().toString(36).slice(2)}`;
  const host: HostSession = {
    cwd: () => root,
    sessionId: () => sessionId,
    sessionFile: () => undefined,
    sessionDir: () => root,
    model: () => undefined,
    thinking: () => undefined,
    activeTools: () => ["Bash"],
    inventory: () => [],
    configuredModels: () => [],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
    ...options.host,
  };
  const registry = new TaskRegistry(() => host);
  const base = options.settings ?? {};
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "session");
  const deps: BashToolDeps = {
    registry: () => registry,
    hostProvider: () => host,
    cohortFor: (id) => `cohort-${id}`,
    agentDir: () => agentDir,
    settings: options.settingsFn ?? (() => base),
    extraEnv: options.extraEnv ?? (() => ({ PI_DENT_SESSION_DIR: sessionDir })),
  };
  return {
    deps,
    registry,
    root,
    agentDir,
    sessionDir,
    host,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const noCtx = undefined as unknown as ExtensionToolContext;

export async function call(
  fixture: Fixture,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: (partial: ToolResult) => void,
): Promise<ToolResult> {
  return makeBashTool(fixture.deps).execute("call-1", params as never, signal, onUpdate, noCtx);
}

export function textOf(result: ToolResult): string {
  assert.equal(result.content.length, 1, "one text content block");
  const first = at(result.content, 0);
  if (first.type !== "text") assert.fail(`expected text content, got ${first.type}`);
  return first.text;
}

export function detailsOf(result: ToolResult): Record<string, unknown> {
  return result.details;
}

/** True while a process with `pid` exists (signal 0 probes without sending anything). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Resolves once `check()` holds, polling; rejects after `deadlineMs`. No fixed sleeps. */
export async function waitUntil(
  check: () => boolean,
  deadlineMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}
