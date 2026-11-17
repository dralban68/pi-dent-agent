import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills } from "../../lib/catalogs.ts";
import type { Diagnostic } from "../../lib/util.ts";
import { at } from "../support/must.ts";

/**
 * The skill file rules of specs/skill.md Section 1 (a `description` and a non-empty
 * body are required, and a skip is reported once naming the file) and Section 2
 * (a leading byte-order mark is removed and line endings normalised in the body).
 *
 * `homedir()` reads HOME, so each test points HOME at a throwaway directory.
 */

function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-skillfile-home-"));
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

/** One skill `<name>/SKILL.md` under the project layer, written with `text`. */
function writeSkill(root: string, name: string, text: string): string {
  const dir = join(root, ".pi", "pi-dent", "skills", name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, text);
  return file;
}

function linesFor(diagnostics: Diagnostic[], needle: string): string[] {
  return diagnostics.filter((d) => d.message.includes(needle)).map((d) => d.message);
}

test("skill file: a missing or empty description skips the skill with one diagnostic naming the file", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skillfile-"));
    try {
      const missing = writeSkill(root, "missing", "---\nname: missing\n---\n\nbody\n");
      const empty = writeSkill(root, "empty", '---\nname: empty\ndescription: ""\n---\n\nbody\n');
      const diagnostics: Diagnostic[] = [];
      assert.deepEqual(discoverSkills(root, diagnostics), [], "neither skill is catalogued");
      for (const file of [missing, empty]) {
        const lines = linesFor(diagnostics, file);
        assert.equal(lines.length, 1, `exactly one line for ${file}: ${JSON.stringify(lines)}`);
        assert.match(at(lines, 0), /^skills: /);
        assert.match(at(lines, 0), /skipped/);
        assert.match(at(lines, 0), /description/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("skill file: a whitespace-only description is accepted (skill.md Section 1)", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skillfile-"));
    try {
      writeSkill(root, "spaced", '---\nname: spaced\ndescription: "   "\n---\n\nbody\n');
      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(diagnostics, []);
      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.description]),
        [["spaced", "   "]],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("skill file: an empty body skips the skill with one diagnostic naming the file", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skillfile-"));
    try {
      const file = writeSkill(root, "hollow", "---\nname: hollow\ndescription: d\n---\n\n  \n\t\n");
      const diagnostics: Diagnostic[] = [];
      assert.deepEqual(discoverSkills(root, diagnostics), []);
      const lines = linesFor(diagnostics, file);
      assert.equal(lines.length, 1, `exactly one line for ${file}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /empty body/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("skill file: a leading byte-order mark is removed and CRLF line endings are normalised in the body", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skillfile-"));
    try {
      writeSkill(
        root,
        "crlf",
        "\uFEFF---\r\nname: crlf\r\ndescription: d\r\n---\r\n\r\nline one\r\nline two\r\n",
      );
      const diagnostics: Diagnostic[] = [];
      const skills = discoverSkills(root, diagnostics);
      assert.deepEqual(diagnostics, []);
      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.description, skill.body]),
        [["crlf", "d", "line one\nline two"]],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("skill file: a delimiter on a longer line does not open or close the frontmatter (skill.md Section 1)", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skillfile-"));
    try {
      // The closing line is `---not-a-delimiter`, so the file has no frontmatter and no
      // `name`; the frontmatter keys are not read.
      const file = writeSkill(
        root,
        "loose",
        "---\nname: loose\ndescription: d\n---not-a-delimiter\nbody\n",
      );
      const diagnostics: Diagnostic[] = [];
      assert.deepEqual(discoverSkills(root, diagnostics), []);
      const lines = linesFor(diagnostics, file);
      assert.equal(lines.length, 1, `exactly one line for ${file}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /name none/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("skill file: a first line of more than three dashes does not open a frontmatter block", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-skillfile-"));
    try {
      const file = writeSkill(root, "dashes", "----\nname: dashes\ndescription: d\n---\n\nbody\n");
      const diagnostics: Diagnostic[] = [];
      assert.deepEqual(discoverSkills(root, diagnostics), []);
      const lines = linesFor(diagnostics, file);
      assert.equal(lines.length, 1, `exactly one line for ${file}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /name none/, "no frontmatter key is read from the file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
