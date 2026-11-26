import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DispatchEngine,
  appendSkillCatalog,
  type BootSnapshot,
  type DispatchPlan,
} from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { SkillEntry } from "../../lib/catalogs.ts";
import type { HostSession } from "../../lib/host.ts";

/**
 * Skill binding per specs/skill-tool.md#binding and specs/agent-tool.md#skills: a session carries the skill catalog only when its tools include
 * `Skill`; a child's plan skills follow the tool cap.
 */

const skill: SkillEntry = { name: "s", description: "d", body: "B", source: "x" };

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
  skills: [skill],
  skillIndex: new Map([[skill.name, skill]]),
  plugins: [],
  pluginIndex: new Map(),
  diagnostics: [],
  maxRecoveryRetries: 0,
  sessionTtlDays: 30,
} as unknown as BootSnapshot;

function hostWith(tools: string[]): HostSession {
  return {
    cwd: () => "/tmp",
    sessionId: () => "sess-1",
    sessionFile: () => undefined,
    sessionDir: () => "/tmp",
    model: () => ({ provider: "p", id: "main" }),
    thinking: () => undefined,
    activeTools: () => tools,
    inventory: () => [{ provider: "p", id: "main", reasoning: true } as never],
    configuredModels: () => [{ provider: "p", id: "main", reasoning: true } as never],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
}

async function planFor(tools: string[]): Promise<DispatchPlan> {
  const host = hostWith(tools);
  let captured: DispatchPlan | undefined;
  const engine = new DispatchEngine(
    boot,
    () => host,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  (engine as unknown as { runDispatch: (...args: unknown[]) => Promise<unknown> }).runDispatch =
    async (_reg, _row, plan) => {
      captured = plan as DispatchPlan;
      return { content: [{ type: "text", text: "done" }], details: {} };
    };
  await engine.dispatch({
    toolCallId: "c-1",
    params: { prompt: "do something", task: "the task" },
    host,
    cohortId: "c-1",
  });
  assert.ok(captured);
  return captured;
}

test("plan skills are the skill catalog when the tool cap includes Skill", async () => {
  const plan = await planFor(["read", "Agent", "Skill"]);
  assert.deepEqual(
    plan.skills.map((entry) => entry.name),
    ["s"],
  );
});

test("plan skills are empty when the tool cap lacks Skill", async () => {
  const plan = await planFor(["read", "Agent"]);
  assert.deepEqual(plan.skills, []);
});

test("appendSkillCatalog appends one name — description line per skill after a blank line", () => {
  const other: SkillEntry = { name: "ns:t", description: "e", body: "B", source: "y" };
  assert.equal(
    appendSkillCatalog("Base", [skill, other]),
    "Base\n\n<available_skills>\ns — d\nns:t — e\n</available_skills>",
  );
});

test("appendSkillCatalog leaves the prompt unchanged for an empty skill catalog", () => {
  assert.equal(appendSkillCatalog("Base", []), "Base");
});

test("appendSkillCatalog collapses each run of line breaks in a description to one space (specs/skill-tool.md#binding)", () => {
  const multi: SkillEntry = {
    name: "m",
    description: "first line\nsecond\n\nthird\r\nfourth",
    body: "B",
    source: "x",
  };
  assert.equal(
    appendSkillCatalog("Base", [multi]),
    "Base\n\n<available_skills>\nm — first line second third fourth\n</available_skills>",
  );
});
