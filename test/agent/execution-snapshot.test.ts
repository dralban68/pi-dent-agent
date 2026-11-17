import { test } from "node:test";
import assert from "node:assert/strict";
import { DispatchEngine, type BootSnapshot } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession } from "../../lib/host.ts";
import { at } from "../support/must.ts";

const boot = {
  cwd: "/tmp",
  config: {
    merged: {},
    layers: {},
    projectRoot: "/tmp",
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
} as unknown as BootSnapshot;

const host: HostSession = {
  cwd: () => "/tmp",
  sessionId: () => "sess-1",
  sessionFile: () => undefined,
  sessionDir: () => "/tmp",
  model: () => ({ provider: "p", id: "main" }),
  thinking: () => undefined,
  activeTools: () => ["Agent"],
  inventory: () => [{ provider: "p", id: "main", reasoning: true } as never],
  configuredModels: () => [{ provider: "p", id: "main", reasoning: true } as never],
  contextWindow: () => undefined,
  compaction: () => undefined,
  notify: () => {},
};

test("snapshot failure is a pre-start rejection for foreground calls", async () => {
  const throwingHost: HostSession = {
    ...host,
    sessionId: () => {
      throw new Error("failed to retrieve sessionId");
    },
  };
  const engine = new DispatchEngine(
    boot,
    () => throwingHost,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "c-1",
    params: { prompt: "do something", task: "the task" },
    host: throwingHost,
    cohortId: "c-1",
  });

  assert.equal(result.isError, true);
  assert.match(
    (result.content[0] as { text: string }).text,
    /snapshot failed: failed to retrieve sessionId/,
  );
  const details = result.details as { results: Array<Record<string, unknown>> };
  const record = at(details.results, 0);
  assert.equal(record.status, "failed");
  assert.equal(record.failureCode, "invalid-plan");
  assert.equal(record.failurePhase, "plan-resolution");

  const row = at(engine.registry.rows, 0);
  assert.equal(row.status, "failed");
  assert.equal(row.consumed, true);
});

test("snapshot failure is a pre-start rejection for background calls, never starting in background", async () => {
  const throwingHost: HostSession = {
    ...host,
    sessionId: () => {
      throw new Error("storage unreadable");
    },
  };
  const engine = new DispatchEngine(
    boot,
    () => throwingHost,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "c-2",
    params: { prompt: "do something", task: "the task", background: true },
    host: throwingHost,
    cohortId: "c-2",
  });

  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /snapshot failed: storage unreadable/);
  assert.doesNotMatch((result.content[0] as { text: string }).text, /started in background/);
  const details = result.details as { results: Array<Record<string, unknown>> };
  const record = at(details.results, 0);
  assert.equal(record.status, "failed");
  assert.equal(record.failureCode, "invalid-plan");

  const row = at(engine.registry.rows, 0);
  assert.equal(row.status, "failed");
  assert.equal(row.consumed, true);
});
