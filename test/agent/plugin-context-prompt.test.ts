import assert from "node:assert/strict";
import { test } from "node:test";
import { appendSkillCatalog, buildChildSystemPrompt } from "../../lib/engine.ts";
import type { SkillEntry } from "../../lib/catalogs.ts";
import type { BootConfig } from "../../lib/config.ts";
import { appendPluginContext, type PluginEntry } from "../../lib/plugins.ts";

/**
 * Plugin context placement per specs/plugin.md Section 10: the child system prompt
 * order (agent-tool.md Section 4.2) and the main session append after the skill
 * catalog. A child's prompt never includes a non-admitted plugin: callers pass
 * only the admitted entries.
 */

const skill: SkillEntry = {
  name: "s",
  description: "skill desc",
  body: "body",
  source: "/x/SKILL.md",
};

const plugin = (name: string, context?: string): PluginEntry => ({
  name,
  root: `/plugins/${name}`,
  commands: [],
  context,
});

const config = (rules: { match: string; rule: string }[]): BootConfig =>
  ({
    merged: { modelGuidance: { rules } },
    layers: {},
    projectRoot: "/proj",
    diagnostics: [],
    liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
  }) as unknown as BootConfig;

const model = { provider: "p", id: "m" };

test("child prompt: skill catalog, then plugin context blocks, then session rules", () => {
  const prompt = buildChildSystemPrompt(
    "Base",
    [skill],
    model,
    config([{ match: "m", rule: "a rule" }]),
    undefined,
    [plugin("alpha", "Alpha rules."), plugin("beta"), plugin("gamma", "Gamma rules.")],
  );
  assert.equal(
    prompt,
    [
      "Base",
      "",
      "<available_skills>",
      "s — skill desc",
      "</available_skills>",
      "",
      '<plugin_context plugin="alpha">',
      "Alpha rules.",
      "</plugin_context>",
      "",
      '<plugin_context plugin="gamma">',
      "Gamma rules.",
      "</plugin_context>",
      "",
      "a rule",
    ].join("\n"),
  );
});

test("child prompt: plugin context precedes the child guidance", () => {
  const prompt = buildChildSystemPrompt("Base", [], model, config([]), "GUIDANCE", [
    plugin("alpha", "Alpha rules."),
  ]);
  assert.equal(
    prompt,
    'Base\n\n<plugin_context plugin="alpha">\nAlpha rules.\n</plugin_context>\n\nGUIDANCE',
  );
});

test("child prompt: no admitted plugin context leaves the prompt unchanged", () => {
  const cfg = config([{ match: "m", rule: "a rule" }]);
  assert.equal(
    buildChildSystemPrompt("Base", [], model, cfg, undefined, [plugin("alpha")]),
    "Base\n\na rule",
  );
  assert.equal(buildChildSystemPrompt("Base", [], model, cfg), "Base\n\na rule");
});

test("main session: plugin context follows the skill catalog append", () => {
  const withSkills = appendSkillCatalog("Main", [skill]);
  assert.equal(
    appendPluginContext(withSkills, [plugin("alpha", "Alpha rules.")]),
    'Main\n\n<available_skills>\ns — skill desc\n</available_skills>\n\n<plugin_context plugin="alpha">\nAlpha rules.\n</plugin_context>',
  );
});
