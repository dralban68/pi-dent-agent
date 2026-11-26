import assert from "node:assert/strict";
import { test } from "node:test";
import type { BootSnapshot } from "../../lib/engine.ts";
import { AgentToolRegistry, buildAgentDescription, makeAgentTool } from "../../lib/tools.ts";

/**
 * specs/agent-tool.md#registration: the `Models:` suffix carries the model catalog
 * when non-empty, and the main session's `Agent` is registered again only when
 * its description changes.
 */

const CATALOG = "- anthropic/opus: hard problems\n- google/flash: quick edits";
const emptyBoot = { agents: [] } as unknown as BootSnapshot;
const filledBoot = {
  agents: [{ name: "alpha", description: "Does alpha work" }],
} as unknown as BootSnapshot;

const deps = {
  dispatch: async () => {
    throw new Error("no dispatch in this test");
  },
  hostProvider: () => undefined,
  cohortFor: () => "cohort-1",
};

test("the Models suffix is present only for a non-empty model catalog", () => {
  const without = buildAgentDescription(emptyBoot, "");
  assert.equal(without.includes("Models:"), false);
  const withCatalog = buildAgentDescription(emptyBoot, CATALOG);
  assert.ok(withCatalog.endsWith(`\n\nModels:\n${CATALOG}`), withCatalog);
  assert.equal(withCatalog.includes("Available agents:"), false);
});

test("the agent catalog precedes the model catalog", () => {
  const description = buildAgentDescription(filledBoot, CATALOG);
  assert.ok(
    description.endsWith(
      "\n\nAvailable agents:\nalpha — Does alpha work\n\nModels:\n- anthropic/opus: hard problems\n- google/flash: quick edits",
    ),
    description,
  );
});

test("the registered Agent tool carries the model catalog in its description", () => {
  const tool = makeAgentTool({ ...deps, boot: emptyBoot, modelCatalog: CATALOG });
  assert.equal(tool.description, buildAgentDescription(emptyBoot, CATALOG));
  assert.equal(
    makeAgentTool({ ...deps, boot: emptyBoot, modelCatalog: "" }).description,
    buildAgentDescription(emptyBoot, ""),
  );
});

test("the registry registers again only when the description changes", () => {
  const registered: string[] = [];
  const registry = new AgentToolRegistry({ ...deps, boot: emptyBoot }, (tool) =>
    registered.push(tool.description),
  );

  registry.refresh("");
  assert.equal(registered.length, 1, "registered at load");
  registry.refresh("");
  assert.equal(registered.length, 1, "same description: no second registration");

  registry.refresh(CATALOG);
  assert.equal(registered.length, 2, "a changed catalog registers again");
  assert.equal(registered[1], buildAgentDescription(emptyBoot, CATALOG));
  registry.refresh(CATALOG);
  assert.equal(registered.length, 2, "unchanged catalog: no registration");

  registry.refresh("");
  assert.equal(registered.length, 3, "back to an empty catalog registers again");
  assert.equal(registered[2], buildAgentDescription(emptyBoot, ""));
});
