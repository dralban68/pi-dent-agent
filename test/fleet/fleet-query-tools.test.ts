import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DispatchEngine,
  effectiveToolCap,
  queryToolCap,
  type BootSnapshot,
} from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession } from "../../lib/host.ts";
import type { Api, Model } from "@earendil-works/pi-ai/compat";

/**
 * The Fleet `query` child's effective tool cap per specs/fleet-tool.md#query: only the read-only tools `read`, `grep`, `find`, and `ls`
 * present in the target's tool cap; the query itself must not be rejected by
 * the Agent dispatch-authority check (specs/agent-tool.md#tools).
 */

/** The names of the child tool definitions the engine binds (engine.ts childTools). */
const CHILD_TOOL_NAMES = [
  { name: "Bash" },
  { name: "Agent" },
  { name: "Task" },
  { name: "Plugin" },
  { name: "Script" },
  { name: "Fleet" },
  { name: "Skill" },
] as const;

const FULL_CAP = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
  "Fleet",
  "Script",
  "Agent",
] as const;

function emptyBoot(cwd: string): BootSnapshot {
  return {
    cwd,
    config: {
      merged: {},
      layers: {},
      projectRoot: cwd,
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    },
    agents: [],
    agentIndex: new Map(),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: 0,
    sessionTtlDays: 30,
  };
}

function stubHost(sessionId: string, dir: string): HostSession {
  const fakeModel: Model<Api> = {
    id: "stub-model",
    name: "stub-model",
    api: "unknown-api",
    provider: "stub",
    baseUrl: "http://stub",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 8192,
  };
  return {
    cwd: () => dir,
    sessionId: () => sessionId,
    sessionFile: () => join(dir, `${sessionId}.jsonl`),
    sessionDir: () => dir,
    model: () => ({ provider: "stub", id: "stub-model" }),
    thinking: () => undefined,
    activeTools: () => [...FULL_CAP],
    inventory: () => [fakeModel],
    configuredModels: () => [fakeModel],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
}

test("query tools: the child binds exactly the read-only tools present in the target cap", () => {
  const queryCap = queryToolCap(FULL_CAP);
  assert.deepEqual(queryCap, ["read", "grep", "find", "ls"]);
  // The child binds effectiveToolCap(plan.tools, childTools, []): the query cap
  // has no Skill, so the child carries no skills.
  assert.deepEqual(effectiveToolCap(queryCap, CHILD_TOOL_NAMES, []), [
    "read",
    "grep",
    "find",
    "ls",
  ]);
});

test("query tools: a target cap without grep yields read, find, ls", () => {
  const cap = FULL_CAP.filter((name) => name !== "grep");
  const queryCap = queryToolCap(cap);
  assert.deepEqual(queryCap, ["read", "find", "ls"]);
  assert.deepEqual(effectiveToolCap(queryCap, CHILD_TOOL_NAMES, []), ["read", "find", "ls"]);
  assert.deepEqual(
    queryToolCap(["bash", "edit", "write", "Agent"]),
    [],
    "no read-only tool in the cap, no tool binds",
  );
});

test("query tools: runIsolatedQuery settles through the dispatch, never the authority rejection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-fleet-qtools-"));
  try {
    const engine = new DispatchEngine(
      emptyBoot(dir),
      () => undefined,
      undefined,
      undefined,
      undefined,
      engineDeps(),
    );
    const result = await engine.runIsolatedQuery(stubHost("target-sess", dir), {
      correlationId: "corr-1",
      senderSessionId: "sender-sess",
      body: "What branch are you on?",
    });

    assert.equal(
      /tool cap does not include Agent|missing-tool-authority/i.test(result.text),
      false,
      `authority check rejected the query: ${result.text}`,
    );
    assert.equal(
      result.text.startsWith("Agent "),
      true,
      `query did not settle through the dispatch: ${result.text}`,
    );
    assert.equal(result.isError, true, "the stub model cannot answer, so the query fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
