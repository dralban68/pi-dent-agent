import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentDefinition,
  applyAgentsOverride,
  composePluginCatalogs,
  type SkillEntry,
} from "../../lib/catalogs.ts";
import type { BootConfig } from "../../lib/config.ts";
import type { Diagnostic } from "../../lib/util.ts";
import { at, must } from "../support/must.ts";

/**
 * Plugin catalog composition per specs/plugin.md Section 9 and the `agents`
 * override of specs/agent.md Section 2: plugin `agents/*.md` and
 * `skills/<name>/SKILL.md` entries join the composed catalogs as
 * `namespace:name`, after pi-dent's own entries, in admission order with
 * lexicographic file order within a plugin.
 */

interface PluginSource {
  name: string;
  root: string;
}

interface Fixture {
  root: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-compose-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function plugin(root: string, dir: string, namespace: string): PluginSource {
  const pluginRoot = join(root, dir);
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, "plugin.json"), JSON.stringify({ name: namespace }));
  return { name: namespace, root: pluginRoot };
}

function agentFile(pluginRoot: string, file: string, name: string, body = "prompt"): void {
  mkdirSync(join(pluginRoot, "agents"), { recursive: true });
  writeFileSync(join(pluginRoot, "agents", file), `---\nname: ${name}\n---\n\n${body}\n`);
}

function skillDir(pluginRoot: string, dir: string, name: string, description = "d"): void {
  const path = join(pluginRoot, "skills", dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
  );
}

function piDentAgent(name: string): AgentDefinition {
  return { name, prompt: `${name} prompt`, source: `pi-dent-${name}` };
}

function piDentSkill(name: string): SkillEntry {
  return {
    name,
    description: `${name} description`,
    body: `${name} body`,
    source: `pi-dent-${name}`,
  };
}

function linesFor(diagnostics: Diagnostic[], needle: string): string[] {
  return diagnostics.filter((d) => d.message.includes(needle)).map((d) => d.message);
}

test("composition: pi-dent entries first, then plugins in admission order, files lexicographic within a plugin", () => {
  const fixture = makeFixture();
  try {
    const one = plugin(fixture.root, "one", "p1");
    agentFile(one.root, "z.md", "y");
    agentFile(one.root, "a.md", "b");
    skillDir(one.root, "beta", "beta");
    skillDir(one.root, "alpha", "alpha");
    const two = plugin(fixture.root, "two", "p2");
    agentFile(two.root, "m.md", "c");
    skillDir(two.root, "only", "only");

    // Pi-dent's own entries arrive sorted (discoverAgents output); composition appends after them.
    const agents = [piDentAgent("a"), piDentAgent("b")];
    const skills = [piDentSkill("s")];
    const diagnostics: Diagnostic[] = [];
    composePluginCatalogs(agents, skills, [one, two], diagnostics);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      agents.map((agent) => agent.name),
      ["a", "b", "p1:b", "p1:y", "p2:c"],
    );
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["s", "p1:alpha", "p1:beta", "p2:only"],
    );
  } finally {
    fixture.cleanup();
  }
});

test("composition: plugin skills carry referencesDir under the plugin root when they have a references/ folder", () => {
  const fixture = makeFixture();
  try {
    const one = plugin(fixture.root, "one", "p1");
    skillDir(one.root, "alpha", "alpha");
    mkdirSync(join(one.root, "skills", "alpha", "references"));
    skillDir(one.root, "beta", "beta");
    const skills = [piDentSkill("s")];
    const diagnostics: Diagnostic[] = [];
    composePluginCatalogs([], skills, [one], diagnostics);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["s", "p1:alpha", "p1:beta"],
    );
    assert.equal(at(skills, 1).referencesDir, join(one.root, "skills", "alpha", "references"));
    assert.equal(at(skills, 2).referencesDir, undefined, "no references/ folder, no referencesDir");
    assert.equal(
      at(skills, 0).referencesDir,
      undefined,
      "a pi-dent skill without a references/ folder carries no referencesDir",
    );
  } finally {
    fixture.cleanup();
  }
});

test("composition: namespaced entries never shadow bare entries (disjoint key spaces)", () => {
  const fixture = makeFixture();
  try {
    const one = plugin(fixture.root, "one", "p1");
    agentFile(one.root, "same.md", "x");
    skillDir(one.root, "same", "same");
    const agents = [piDentAgent("x")];
    const skills = [piDentSkill("same")];
    const diagnostics: Diagnostic[] = [];
    composePluginCatalogs(agents, skills, [one], diagnostics);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      agents.map((agent) => agent.name),
      ["x", "p1:x"],
    );
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["same", "p1:same"],
    );
  } finally {
    fixture.cleanup();
  }
});

test("composition: a duplicate namespace:name within one plugin is skipped with one report line", () => {
  const fixture = makeFixture();
  try {
    const one = plugin(fixture.root, "one", "p1");
    agentFile(one.root, "a.md", "x", "first body");
    agentFile(one.root, "b.md", "x", "second body");
    const agents: AgentDefinition[] = [];
    const diagnostics: Diagnostic[] = [];
    composePluginCatalogs(agents, [], [one], diagnostics);
    assert.deepEqual(
      agents.map((agent) => [agent.name, agent.prompt]),
      [["p1:x", "first body"]],
    );
    const agentLine = linesFor(diagnostics, join(one.root, "agents", "b.md"));
    assert.equal(agentLine.length, 1, `exactly one line: ${JSON.stringify(agentLine)}`);
    assert.match(at(agentLine, 0), /duplicate name "p1:x"/);
  } finally {
    fixture.cleanup();
  }
});

test("composition: a plugin skill whose frontmatter name differs from its directory is skipped with one report line", () => {
  const fixture = makeFixture();
  try {
    const one = plugin(fixture.root, "one", "p1");
    skillDir(one.root, "wrong", "other");
    skillDir(one.root, "right", "right");
    const skills: SkillEntry[] = [];
    const diagnostics: Diagnostic[] = [];
    composePluginCatalogs([], skills, [one], diagnostics);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["p1:right"],
    );
    const lines = linesFor(diagnostics, join(one.root, "skills", "wrong", "SKILL.md"));
    assert.equal(lines.length, 1, `exactly one line: ${JSON.stringify(lines)}`);
    assert.match(at(lines, 0), /name "other" does not match directory "wrong"/);
  } finally {
    fixture.cleanup();
  }
});

test("composition: the reserved dynamic rule applies only to bare names", () => {
  const fixture = makeFixture();
  try {
    const one = plugin(fixture.root, "one", "p1");
    agentFile(one.root, "dyn.md", "dynamic");
    const agents: AgentDefinition[] = [];
    const diagnostics: Diagnostic[] = [];
    composePluginCatalogs(agents, [], [one], diagnostics);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      agents.map((agent) => agent.name),
      ["p1:dynamic"],
    );
  } finally {
    fixture.cleanup();
  }
});

test("composition: invalid per-file entries follow the agent.md and skill.md skip rules", () => {
  const fixture = makeFixture();
  try {
    const one = plugin(fixture.root, "one", "p1");
    mkdirSync(join(one.root, "agents"), { recursive: true });
    writeFileSync(join(one.root, "agents", "no-name.md"), "---\ndescription: d\n---\n\nbody\n");
    writeFileSync(join(one.root, "agents", "empty.md"), "---\nname: e\n---\n\n\n");
    mkdirSync(join(one.root, "skills", "nodescription"), { recursive: true });
    writeFileSync(
      join(one.root, "skills", "nodescription", "SKILL.md"),
      "---\nname: nodescription\n---\n\nbody\n",
    );
    const agents: AgentDefinition[] = [];
    const skills: SkillEntry[] = [];
    const diagnostics: Diagnostic[] = [];
    composePluginCatalogs(agents, skills, [one], diagnostics);
    assert.deepEqual(agents, []);
    assert.deepEqual(skills, []);
    for (const file of [
      join(one.root, "agents", "no-name.md"),
      join(one.root, "agents", "empty.md"),
    ]) {
      assert.equal(linesFor(diagnostics, file).length, 1, `one skip line for ${file}`);
    }
    assert.equal(
      linesFor(diagnostics, join(one.root, "skills", "nodescription", "SKILL.md")).length,
      1,
    );
  } finally {
    fixture.cleanup();
  }
});

test("override: applyAgentsOverride replaces the prompt of a namespace:name key after composition", () => {
  const fixture = makeFixture();
  try {
    const one = plugin(fixture.root, "one", "p1");
    agentFile(one.root, "x.md", "x", "file body");
    const agents = [piDentAgent("bare")];
    const diagnostics: Diagnostic[] = [];
    composePluginCatalogs(agents, [], [one], diagnostics);
    const config = {
      merged: { agents: { "p1:x": { prompt: "replaced prompt" }, "p1:ghost": { prompt: "no" } } },
      layers: {},
      projectRoot: fixture.root,
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    } as unknown as BootConfig;
    applyAgentsOverride(config, agents, diagnostics);
    assert.equal(must(agents.find((agent) => agent.name === "p1:x")).prompt, "replaced prompt");
    assert.equal(must(agents.find((agent) => agent.name === "bare")).prompt, "bare prompt");
    const lines = linesFor(diagnostics, "p1:ghost");
    assert.equal(lines.length, 1, `one warning for the unknown identity: ${JSON.stringify(lines)}`);
    assert.match(at(lines, 0), /unknown agent identity/);
  } finally {
    fixture.cleanup();
  }
});

test("override: unknown keys of one agents entry each name the file of their own layer", () => {
  const fixture = makeFixture();
  try {
    const globalConf = join(fixture.root, "global", "pi-dent.conf");
    const projectConf = join(fixture.root, "project", ".pi", "pi-dent", "pi-dent.conf");
    const agents = [piDentAgent("bare")];
    const diagnostics: Diagnostic[] = [];
    const config = {
      merged: { agents: { bare: { prompt: "p", fromGlobal: 1, fromProject: 2 } } },
      layers: {
        global: { path: globalConf, values: { agents: { bare: { fromGlobal: 1 } } } },
        project: { path: projectConf, values: { agents: { bare: { fromProject: 2 } } } },
      },
      projectRoot: fixture.root,
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    } as unknown as BootConfig;
    applyAgentsOverride(config, agents, diagnostics);
    assert.equal(must(agents.find((agent) => agent.name === "bare")).prompt, "p");
    assert.equal(diagnostics.length, 1, `one diagnostic: ${JSON.stringify(diagnostics)}`);
    assert.equal(
      at(diagnostics, 0).message,
      `agents override: agents.bare: unknown keys fromGlobal (${globalConf}), fromProject (${projectConf}) ignored`,
    );
  } finally {
    fixture.cleanup();
  }
});
