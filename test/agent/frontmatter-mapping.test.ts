import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, discoverSkills } from "../../lib/catalogs.ts";
import type { Diagnostic } from "../../lib/util.ts";
import { at } from "../support/must.ts";

/**
 * The frontmatter mapping rule of specs/skill.md Section 1, shared by every
 * Markdown resource: a frontmatter that is not a mapping produces one diagnostic
 * naming the file and is read as empty, so the resource is then handled as one
 * with no frontmatter field at all (skipped here, for it lacks a `name`).
 *
 * `homedir()` reads HOME, so each test points HOME at a throwaway directory.
 */

function linesFor(diagnostics: Diagnostic[], needle: string): string[] {
  return diagnostics.filter((d) => d.message.includes(needle)).map((d) => d.message);
}

function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-frontmatter-"));
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

test("a layer skill whose frontmatter is not a mapping reports it and counts as empty", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-frontmatter-skill-"));
    try {
      const skillDir = join(root, ".pi", "pi-dent", "skills", "odd");
      mkdirSync(skillDir, { recursive: true });
      const file = join(skillDir, "SKILL.md");
      writeFileSync(file, "---\nhello\n---\n\nbody\n");
      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(
        skills.map((skill) => skill.name),
        [],
        "the skill is skipped: an empty frontmatter has no name",
      );
      const lines = linesFor(diagnostics, file);
      assert.equal(lines.length, 2, `two lines for ${file}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /^skills: /);
      assert.match(at(lines, 0), /frontmatter must be a mapping/);
      assert.match(at(lines, 1), /skipped/);
      assert.match(at(lines, 1), /name none/, "no field survives the non-mapping frontmatter");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a layer agent definition whose frontmatter is not a mapping reports it and counts as empty", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-frontmatter-agent-"));
    try {
      const agentsDir = join(root, ".pi", "pi-dent", "agents");
      mkdirSync(agentsDir, { recursive: true });
      const file = join(agentsDir, "odd.md");
      writeFileSync(file, "---\n- first\n- second\n---\n\nprompt\n");
      const diagnostics: Diagnostic[] = [];
      const agents = discoverAgents(root, diagnostics);
      assert.deepEqual(agents, [], "the definition is skipped: an empty frontmatter has no name");
      const lines = linesFor(diagnostics, file);
      assert.equal(lines.length, 2, `two lines for ${file}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /^agents: /);
      assert.match(at(lines, 0), /frontmatter must be a mapping/);
      assert.match(at(lines, 1), /skipped/);
      assert.match(at(lines, 1), /received none/, "no field survives the non-mapping frontmatter");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
