import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, discoverSkills } from "../../lib/catalogs.ts";
import type { Diagnostic } from "../../lib/util.ts";
import { must } from "../support/must.ts";

/**
 * Catalog order per specs/agent.md Section 1 and specs/skill.md Section 1:
 * lexicographic by code unit, never locale collation. `B` sorts before `_x`
 * before `a` by code unit, while `localeCompare` orders `_x`, `a` before `B`.
 *
 * `homedir()` reads HOME, so each test points HOME at a throwaway directory
 * and never sees the global layer of the machine running the tests.
 */

/** Run `fn` with HOME at a fresh directory; that directory is removed afterwards. */
function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-catalogorder-home-"));
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

test("catalog order: skills are ordered by code unit, not by locale", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-catalogorder-"));
    try {
      const skillsDir = join(root, ".pi", "pi-dent", "skills");
      for (const name of ["a", "B", "_x"]) {
        mkdirSync(join(skillsDir, name), { recursive: true });
        writeFileSync(
          join(skillsDir, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: skill ${name}\n---\n\nbody ${name}\n`,
        );
      }
      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(diagnostics, []);
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["B", "_x", "a"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("catalog order: layer skills from both layers interleave by name; a project skill shadows a global one", () => {
  withTempHome((home) => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-catalogorder-"));
    try {
      const globalSkills = join(home, ".pi", "pi-dent", "skills");
      const globals: Array<{ name: string; description: string }> = [
        { name: "beta", description: "global beta" },
        { name: "zeta", description: "global zeta" },
      ];
      for (const { name, description } of globals) {
        mkdirSync(join(globalSkills, name), { recursive: true });
        writeFileSync(
          join(globalSkills, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n\nglobal body ${name}\n`,
        );
      }
      const projectSkills = join(root, ".pi", "pi-dent", "skills");
      for (const name of ["alpha", "zeta"]) {
        mkdirSync(join(projectSkills, name), { recursive: true });
        writeFileSync(
          join(projectSkills, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: project ${name}\n---\n\nproject body ${name}\n`,
        );
      }
      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(diagnostics, []);
      // One lexicographic order over both layers: "alpha", the unshadowed
      // global "beta", then "zeta", never the global layer's entries first.
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["alpha", "beta", "zeta"],
      );
      assert.equal(
        must(skills.find((skill) => skill.name === "beta")).description,
        "global beta",
        "an unshadowed global skill keeps its place between the project skills",
      );
      assert.equal(
        must(skills.find((skill) => skill.name === "zeta")).description,
        "project zeta",
        "the project skill shadows the global skill of the same name",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("catalog order: agent definitions are ordered by code unit, not by locale", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-catalogorder-"));
    try {
      const agentsDir = join(root, ".pi", "pi-dent", "agents");
      mkdirSync(agentsDir, { recursive: true });
      for (const name of ["a", "B", "_x"]) {
        writeFileSync(join(agentsDir, `${name}.md`), `---\nname: ${name}\n---\n\nprompt ${name}\n`);
      }
      const diagnostics: Diagnostic[] = [];
      const agents = discoverAgents(root, diagnostics);
      assert.deepEqual(diagnostics, []);
      assert.deepEqual(
        agents.map((agent) => agent.name),
        ["B", "_x", "a"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
