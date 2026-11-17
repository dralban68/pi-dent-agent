import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, discoverSkills } from "../../lib/catalogs.ts";
import type { Diagnostic } from "../../lib/util.ts";
import { at } from "../support/must.ts";

/**
 * Pi-dent skill discovery per specs/skill.md Section 1 and the skip-and-report
 * rules of specs/agent.md Section 1: each `<name>/SKILL.md` under a layer's
 * `skills/` folder is one skill; a malformed or unreadable SKILL.md is skipped
 * with exactly one report line naming the file; absent paths stay silent
 * because discovery directories are advisory.
 *
 * `homedir()` reads HOME, so each test points HOME at a throwaway directory:
 * the global layer is then under test control too.
 */

function linesFor(diagnostics: Diagnostic[], needle: string): string[] {
  return diagnostics.filter((d) => d.message.includes(needle)).map((d) => d.message);
}

function projectSkillsDir(root: string): string {
  const dir = join(root, ".pi", "pi-dent", "skills");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run `fn` with HOME at a fresh directory; returns that directory's cleanup. */
function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-skillhome-"));
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

test("discovery: malformed YAML frontmatter is skipped with exactly one report line naming the file", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skilldiag-"));
    try {
      const skillsDir = projectSkillsDir(root);
      mkdirSync(join(skillsDir, "bad"));
      const bad = join(skillsDir, "bad", "SKILL.md");
      writeFileSync(bad, "---\nname: [unclosed\n---\nbody");
      mkdirSync(join(skillsDir, "good"));
      const good = join(skillsDir, "good", "SKILL.md");
      writeFileSync(good, "---\nname: good\ndescription: fine\n---\n\nbody\n");
      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(
        skills.filter((s) => s.name === "good" || s.name === "bad").map((s) => s.name),
        ["good"],
        "the malformed skill is skipped; the valid sibling is discovered",
      );
      const lines = linesFor(diagnostics, bad);
      assert.equal(lines.length, 1, `exactly one line for ${bad}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /^skills: /);
      assert.match(at(lines, 0), /malformed frontmatter/);
      assert.match(at(lines, 0), /skipped/);
      assert.equal(linesFor(diagnostics, good).length, 0, "the valid file produces no diagnostics");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("discovery: an unreadable SKILL.md is skipped with one report line; absent paths stay silent", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("the root user reads through file modes, so the unreadable case cannot be produced");
    return;
  }
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skilldiag-"));
    const skillsDir = projectSkillsDir(root);
    mkdirSync(join(skillsDir, "locked"));
    const unreadable = join(skillsDir, "locked", "SKILL.md");
    try {
      writeFileSync(unreadable, "---\nname: locked\ndescription: d\n---\nbody");
      chmodSync(unreadable, 0o000);
      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.equal(
        skills.some((s) => s.name === "locked"),
        false,
        "the unreadable skill is skipped",
      );
      const lines = linesFor(diagnostics, unreadable);
      assert.equal(lines.length, 1, `exactly one line for ${unreadable}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /unreadable/);
      assert.doesNotMatch(at(lines, 0), /malformed frontmatter/);

      // A project root without a skills directory yields no diagnostics (advisory discovery).
      const silentRoot = mkdtempSync(join(tmpdir(), "pi-dent-skilldiag-empty-"));
      try {
        const silent: Diagnostic[] = [];
        discoverSkills(silentRoot, silent);
        assert.deepEqual(silent, []);
      } finally {
        rmSync(silentRoot, { recursive: true, force: true });
      }
    } finally {
      chmodSync(unreadable, 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("layout: flat skills/*.md files are not discovered; a subdirectory without SKILL.md is not a skill", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skilllayout-"));
    try {
      const skillsDir = projectSkillsDir(root);
      writeFileSync(join(skillsDir, "flat.md"), "---\nname: flat\ndescription: d\n---\n\nbody\n");
      mkdirSync(join(skillsDir, "empty-dir"));
      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(skills, []);
      assert.deepEqual(diagnostics, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("layout: the frontmatter name must equal the directory name, else the skill is skipped with one line", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skillname-"));
    try {
      const skillsDir = projectSkillsDir(root);
      mkdirSync(join(skillsDir, "dir-name"));
      const file = join(skillsDir, "dir-name", "SKILL.md");
      writeFileSync(file, "---\nname: other-name\ndescription: d\n---\n\nbody\n");
      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(skills, []);
      const lines = linesFor(diagnostics, file);
      assert.equal(lines.length, 1, `exactly one line: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /name "other-name" does not match directory "dir-name"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("layout: unknown frontmatter keys produce one diagnostic and the skill still loads", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skillkeys-"));
    try {
      const skillsDir = projectSkillsDir(root);
      mkdirSync(join(skillsDir, "keyed"));
      const file = join(skillsDir, "keyed", "SKILL.md");
      writeFileSync(file, "---\nname: keyed\ndescription: d\nfuture: x\n---\n\nbody\n");
      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(
        skills.map((s) => s.name),
        ["keyed"],
      );
      const lines = linesFor(diagnostics, file);
      assert.equal(lines.length, 1, `exactly one line: ${JSON.stringify(diagnostics)}`);
      assert.equal(
        at(lines, 0),
        `skills: ${file}: frontmatter: unknown keys future ignored`,
        "the unknown-key text of config-file.md Section 2, with `frontmatter` as the object",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("scope: a project skill shadows a global skill of the same name; each directory name is one skill", () => {
  withTempHome((home) => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skillscope-"));
    try {
      const globalDir = join(home, ".pi", "pi-dent", "skills", "shared");
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(
        join(globalDir, "SKILL.md"),
        "---\nname: shared\ndescription: global one\n---\n\nglobal body\n",
      );
      const projectDir = join(projectSkillsDir(root), "shared");
      mkdirSync(projectDir);
      writeFileSync(
        join(projectDir, "SKILL.md"),
        "---\nname: shared\ndescription: project one\n---\n\nproject body\n",
      );
      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(
        skills.map((s) => [s.name, s.description, s.body]),
        [["shared", "project one", "project body"]],
      );
      assert.deepEqual(diagnostics, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("catalog order: layer skills sorted by name; global is read before project, which shadows it", () => {
  withTempHome((home) => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skillorder-"));
    try {
      const globalSkills = join(home, ".pi", "pi-dent", "skills");
      for (const [name, description] of [
        ["zeta", "global zeta"],
        ["shared", "global shared"],
      ] as const) {
        mkdirSync(join(globalSkills, name), { recursive: true });
        writeFileSync(
          join(globalSkills, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n\nglobal ${name} body\n`,
        );
      }
      const projectSkills = projectSkillsDir(root);
      for (const [name, description] of [
        ["alpha", "project alpha"],
        ["shared", "project shared"],
      ] as const) {
        mkdirSync(join(projectSkills, name));
        writeFileSync(
          join(projectSkills, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n\nproject ${name} body\n`,
        );
      }

      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(diagnostics, []);
      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.description, skill.body]),
        [
          ["alpha", "project alpha", "project alpha body"],
          ["shared", "project shared", "project shared body"],
          ["zeta", "global zeta", "global zeta body"],
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("discovery: a skills directory that cannot be read is reported, not lost silently", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("the root user reads through file modes, so the unreadable case cannot be produced");
    return;
  }
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skillsunreadable-"));
    const skillsDir = projectSkillsDir(root);
    mkdirSync(join(skillsDir, "hidden"));
    writeFileSync(
      join(skillsDir, "hidden", "SKILL.md"),
      "---\nname: hidden\ndescription: d\n---\n\nbody\n",
    );
    try {
      chmodSync(skillsDir, 0o000);
      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(skills, [], "the skills behind the unreadable directory are lost");
      const lines = linesFor(diagnostics, skillsDir);
      assert.equal(lines.length, 1, `exactly one line for ${skillsDir}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /^skills: /);
      assert.match(at(lines, 0), /unreadable/);
    } finally {
      chmodSync(skillsDir, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("discovery: an agents directory that cannot be read is reported, not lost silently", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("the root user reads through file modes, so the unreadable case cannot be produced");
    return;
  }
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-agentsunreadable-"));
    const agentsDir = join(root, ".pi", "pi-dent", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "hidden.md"), "---\nname: hidden\n---\n\nprompt\n");
    try {
      chmodSync(agentsDir, 0o000);
      const diagnostics: Diagnostic[] = [];
      const agents = discoverAgents(root, diagnostics);
      assert.deepEqual(agents, []);
      const lines = linesFor(diagnostics, agentsDir);
      assert.equal(lines.length, 1, `exactly one line for ${agentsDir}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /^agents: /);
      assert.match(at(lines, 0), /unreadable/);
    } finally {
      chmodSync(agentsDir, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("discovery: a skills path that is a file is reported, not treated as an absent folder", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skillsfile-"));
    try {
      const layerDir = join(root, ".pi", "pi-dent");
      mkdirSync(layerDir, { recursive: true });
      const skillsPath = join(layerDir, "skills");
      writeFileSync(skillsPath, "not a directory");
      const diagnostics: Diagnostic[] = [];
      assert.deepEqual(discoverSkills(root, diagnostics), []);
      const lines = linesFor(diagnostics, skillsPath);
      assert.equal(lines.length, 1, `exactly one line for ${skillsPath}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /^skills: /);
      assert.match(at(lines, 0), /unreadable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
