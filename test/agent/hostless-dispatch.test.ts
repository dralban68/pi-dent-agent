import { test } from "node:test";
import assert from "node:assert/strict";
import { DispatchEngine, type BootSnapshot, type ToolResult } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { makeAgentTool } from "../../lib/tools.ts";
import { at } from "../support/must.ts";

/**
 * A host-less Agent call per specs/agent-tool.md#tools and specs/agent-tool.md#invocation-lifecycle: when no
 * live main session exists there is no tool cap, so the dispatch fails the plan
 * with `missing-tool-authority` — routed through DispatchEngine.dispatch's
 * rejection path, registering exactly one failed, consumed task row.
 */

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

function textOf(result: ToolResult): string {
  const first = at(result.content, 0);
  if (first.type !== "text") assert.fail(`expected text content, got ${first.type}`);
  return first.text;
}

const noCtx = undefined as unknown as ExtensionToolContext;

test("host-less: the tool routes through dispatch and returns the specs/agent-tool.md#result-contract error shape with one failed consumed row", async () => {
  const engine = new DispatchEngine(
    boot,
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const tool = makeAgentTool({
    boot,
    modelCatalog: "",
    dispatch: (call) => engine.dispatch(call),
    hostProvider: () => undefined,
    cohortFor: () => "cohort-1",
  });
  const result = await tool.execute(
    "call-1",
    { prompt: "agent prompt", task: "do the thing" },
    undefined,
    undefined,
    noCtx,
  );

  assert.equal(result.isError, true);
  assert.match(textOf(result), /^Agent error: no live main session for the dispatch/);
  const details = result.details as {
    taskId: string;
    agent: string;
    results: Array<Record<string, unknown>>;
  };
  assert.equal(details.agent, "dynamic");
  assert.equal(details.results.length, 1, "one record with no attempt");
  const record = at(details.results, 0);
  assert.equal(record.status, "failed");
  assert.equal(record.failureCode, "missing-tool-authority");
  assert.equal(record.failurePhase, "plan-resolution");
  assert.equal(record.sessionPath, undefined);
  assert.deepEqual(record.usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  });

  assert.equal(engine.registry.rows.length, 1, "exactly one row per invocation");
  const row = at(engine.registry.rows, 0);
  assert.equal(row.taskId, details.taskId);
  assert.equal(row.status, "failed");
  assert.equal(row.consumed, true, "pre-start rejection rows suppress the completion notification");
  assert.equal(row.background, false);
  assert.equal(row.result, textOf(result));
});

test("host-less: dispatch reached directly registers the same single rejection row", async () => {
  const engine = new DispatchEngine(
    boot,
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-2",
    params: { prompt: "agent prompt", task: "do the thing" },
    host: undefined,
    cohortId: "cohort-2",
  });
  assert.equal(result.isError, true);
  const record = at((result.details as { results: Array<Record<string, unknown>> }).results, 0);
  assert.equal(record.failureCode, "missing-tool-authority");
  assert.equal(record.failurePhase, "plan-resolution");
  assert.equal(engine.registry.rows.length, 1);
  const row = at(engine.registry.rows, 0);
  assert.equal(row.status, "failed");
  assert.equal(row.consumed, true);
});
