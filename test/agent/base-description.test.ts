import assert from "node:assert/strict";
import { test } from "node:test";
import type { BootSnapshot } from "../../lib/engine.ts";
import { makeAgentTool } from "../../lib/tools.ts";

/**
 * specs/agent-tool.md#registration: the base `Agent` description states the dispatch contract,
 * and the agent catalog suffix is present only for a non-empty catalog. The description is
 * read off the registered tool, which is what the host and the model receive.
 */

function agentTool(boot: BootSnapshot) {
  return makeAgentTool({
    boot,
    modelCatalog: "",
    dispatch: async () => {
      throw new Error("no dispatch in this test");
    },
    hostProvider: () => undefined,
    cohortFor: () => "cohort-1",
  });
}

const emptyBoot = { agents: [] } as unknown as BootSnapshot;

test("the Agent description states the dispatch contract of specs/agent-tool.md#registration", () => {
  const description = agentTool(emptyBoot).description;
  // Each fact of the contract the specification requires the description to state.
  for (const fact of [
    "system prompt",
    "agent",
    "`task`",
    "final answer",
    "`prompt`",
    "`resume`",
    "foreground",
    "blocks",
    "`background: true`",
    "task ID",
    "notification",
    "file path or by task ID",
    "working directory",
    "share",
    "Only `task` is required",
    "omit both",
    "never give both",
    "`model` is the only place for a model",
    "`agent` never takes a model",
    "as the agent it last ran as",
  ]) {
    assert.ok(description.includes(fact), `the description states ${fact}: ${description}`);
  }
});

test("the description carries the catalog suffix only when the agent catalog is non-empty", () => {
  const empty = agentTool(emptyBoot).description;
  assert.equal(empty.includes("Available agents:"), false);

  const boot = {
    agents: [
      { name: "alpha", description: "Does alpha work" },
      { name: "beta", description: "" },
    ],
  } as unknown as BootSnapshot;
  const filled = agentTool(boot).description;
  assert.ok(filled.endsWith("\n\nAvailable agents:\nalpha — Does alpha work\nbeta"), filled);
});

test("a catalog line replaces each run of line terminators in the description with one space", () => {
  const boot = {
    agents: [{ name: "alpha", description: "first\r\nline\n\nsecond\rthird" }],
  } as unknown as BootSnapshot;
  const description = agentTool(boot).description;
  assert.ok(
    description.endsWith("\n\nAvailable agents:\nalpha — first line second third"),
    description,
  );
});
