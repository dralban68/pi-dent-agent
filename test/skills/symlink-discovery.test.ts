import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePluginCatalogs, discoverAgents, discoverSkills } from "../../lib/catalogs.ts";
import type { Diagnostic } from "../../lib/util.ts";

/**
 * Symlink discovery per specs/agent.md#definition-files and specs/skill.md#skill-files:
 * a symlink to a regular file counts as a file and a symlink to a directory
 * counts as a directory, in pi-dent's own scans and in the plugin scans; a
 * dangling symlink is ignored silently.
 *
 * `homedir()` reads HOME, so each test points HOME at a throwaway directory.
 */

/** Run `fn` with HOME at a fresh directory; that directory is removed afterwards. */
function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-symlink-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("discovery: a symlink to a skill directory is a skill", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-symlink-"));
    try {
      const elsewhere = join(root, "elsewhere", "linked");
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(
        join(elsewhere, "SKILL.md"),
        "---\nname: linked\ndescription: a linked skill\n---\n\nlinked body\n",
      );
      const skillsDir = join(root, ".pi", "pi-dent", "skills");
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync(elsewhere, join(skillsDir, "linked"));

      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(diagnostics, []);
      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.body]),
        [["linked", "linked body"]],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("discovery: a symlink to an agent file is an agent definition", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-symlink-"));
    try {
      const target = join(root, "elsewhere", "linked.md");
      mkdirSync(join(root, "elsewhere"));
      writeFileSync(target, "---\nname: linked\n---\n\nlinked prompt\n");
      const agentsDir = join(root, ".pi", "pi-dent", "agents");
      mkdirSync(agentsDir, { recursive: true });
      symlinkSync(target, join(agentsDir, "linked.md"));

      const diagnostics: Diagnostic[] = [];
      const agents = discoverAgents(root, diagnostics);
      assert.deepEqual(diagnostics, []);
      assert.deepEqual(
        agents.map((agent) => [agent.name, agent.prompt]),
        [["linked", "linked prompt"]],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("discovery: dangling symlinks in the agents and skills folders are ignored silently", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-symlink-"));
    try {
      const agentsDir = join(root, ".pi", "pi-dent", "agents");
      const skillsDir = join(root, ".pi", "pi-dent", "skills");
      mkdirSync(agentsDir, { recursive: true });
      mkdirSync(skillsDir, { recursive: true });
      symlinkSync(join(root, "gone.md"), join(agentsDir, "gone.md"));
      symlinkSync(join(root, "gone"), join(skillsDir, "gone"));

      const diagnostics: Diagnostic[] = [];
      assert.deepEqual(discoverAgents(root, diagnostics), []);
      assert.deepEqual(discoverSkills(root, diagnostics), []);
      assert.deepEqual(diagnostics, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("plugin composition: a symlink to a plugin skill directory is a skill", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-symlink-"));
    try {
      const pluginRoot = join(root, "plugin");
      const skillsDir = join(pluginRoot, "skills");
      const target = join(root, "elsewhere", "shared");
      mkdirSync(skillsDir, { recursive: true });
      mkdirSync(target, { recursive: true });
      writeFileSync(
        join(target, "SKILL.md"),
        "---\nname: shared\ndescription: a shared skill\n---\n\nshared body\n",
      );
      symlinkSync(target, join(skillsDir, "shared"));
      symlinkSync(join(root, "gone"), join(skillsDir, "gone"));

      const diagnostics: Diagnostic[] = [];
      const skills: Parameters<typeof composePluginCatalogs>[1] = [];
      composePluginCatalogs([], skills, [{ name: "ns", root: pluginRoot }], diagnostics);
      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.body]),
        [["ns:shared", "shared body"]],
      );
      assert.deepEqual(diagnostics, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
