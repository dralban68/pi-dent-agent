import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootSnapshot, ToolResult } from "../../lib/engine.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { discoverSkills, type SkillEntry } from "../../lib/catalogs.ts";
import type { Diagnostic } from "../../lib/util.ts";
import { makeSkillTool, skillParameterSchema } from "../../lib/tools.ts";
import { at } from "../support/must.ts";

/**
 * The Skill tool's `reference` parameter per specs/skill-tool.md#parameter-schema
 * and specs/skill-tool.md#execution-contract: resolution under the skill's `references/` folder with the rejection
 * rules, verbatim bodies, and no side effects.
 */

interface Fixture {
  tool: ReturnType<typeof makeSkillTool>;
  root: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-skillref-"));
  const references = join(root, "skill", "references");
  mkdirSync(join(references, "deep"), { recursive: true });
  writeFileSync(join(references, "guide.md"), "guide body\n");
  writeFileSync(join(references, "noext.md"), "no-extension body\n");
  writeFileSync(join(references, "deep", "nested.md"), "nested body\n");
  writeFileSync(join(root, "outside.md"), "outside the references directory\n");
  symlinkSync(join(root, "outside.md"), join(references, "escape.md"));
  symlinkSync(join(references, "guide.md"), join(references, "alias.md"));

  const bare: SkillEntry = {
    name: "bare",
    description: "bare skill",
    body: "bare body",
    source: "bare.md",
  };
  const withRefs: SkillEntry = {
    name: "plug",
    description: "plugin skill",
    body: "plug body",
    source: "x",
    referencesDir: references,
  };
  const boot = {
    skills: [bare, withRefs],
    skillIndex: new Map([
      [bare.name, bare],
      [withRefs.name, withRefs],
    ]),
  } as unknown as BootSnapshot;
  return {
    tool: makeSkillTool(boot),
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function textOf(result: ToolResult): string {
  const first = at(result.content, 0);
  if (first.type !== "text") assert.fail(`expected text content, got ${first.type}`);
  return first.text;
}

const noCtx = undefined as unknown as ExtensionToolContext;

async function call(
  fixture: Fixture,
  params: { name: string; reference?: string },
): Promise<ToolResult> {
  return fixture.tool.execute("call-1", params, undefined, undefined, noCtx);
}

test("schema: reference is an optional string beside the required name", () => {
  const schema = skillParameterSchema as unknown as {
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, { type: string }>;
  };
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).toSorted(), ["name", "reference"]);
  assert.deepEqual(schema.required, ["name"]);
});

test("reference: a bare basename loads verbatim; .md is appended when absent", async () => {
  const fixture = makeFixture();
  try {
    const explicit = await call(fixture, { name: "plug", reference: "guide" });
    assert.equal(explicit.isError, undefined);
    assert.equal(textOf(explicit), "guide body\n");
    assert.equal(
      textOf(await call(fixture, { name: "plug", reference: "guide.md" })),
      "guide body\n",
    );
    assert.equal(
      textOf(await call(fixture, { name: "plug", reference: "noext" })),
      "no-extension body\n",
    );
  } finally {
    fixture.cleanup();
  }
});

test("reference: /-separated sub-paths load; a symlink inside references/ resolves within", async () => {
  const fixture = makeFixture();
  try {
    assert.equal(
      textOf(await call(fixture, { name: "plug", reference: "deep/nested" })),
      "nested body\n",
    );
    assert.equal(
      textOf(await call(fixture, { name: "plug", reference: "deep\\nested.md" })),
      "nested body\n",
    );
    assert.equal(textOf(await call(fixture, { name: "plug", reference: "alias" })), "guide body\n");
  } finally {
    fixture.cleanup();
  }
});

test("reference: an empty or whitespace-only reference fails as a tool error", async () => {
  const fixture = makeFixture();
  try {
    for (const reference of ["", "  "]) {
      const result = await call(fixture, { name: "plug", reference });
      assert.equal(result.isError, true, JSON.stringify(reference));
      assert.match(textOf(result), /reference must be non-empty when provided/);
    }
  } finally {
    fixture.cleanup();
  }
});

test("reference: an absolute path fails as a tool error", async () => {
  const fixture = makeFixture();
  try {
    for (const reference of [
      "/etc/passwd",
      "C:/refs/x",
      "C:\\refs\\x",
      "\\refs\\x",
      "\\\\server\\share",
    ]) {
      const result = await call(fixture, { name: "plug", reference });
      assert.equal(result.isError, true, reference);
      assert.match(textOf(result), /path must be relative/);
    }
  } finally {
    fixture.cleanup();
  }
});

test("reference: any .. segment fails, with backslash split as /", async () => {
  const fixture = makeFixture();
  try {
    for (const reference of ["../outside", "a/../guide", "a\\..\\guide", ".."]) {
      const result = await call(fixture, { name: "plug", reference });
      assert.equal(result.isError, true, reference);
      assert.match(textOf(result), /path must not contain a "\.\." segment/);
    }
  } finally {
    fixture.cleanup();
  }
});

test("reference: a symlink escaping references/ is rejected, not read", async () => {
  const fixture = makeFixture();
  try {
    const result = await call(fixture, { name: "plug", reference: "escape" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /path escapes its root/);
    assert.ok(
      !textOf(result).includes("outside the references directory"),
      "the escaped file is never read",
    );
  } finally {
    fixture.cleanup();
  }
});

test("reference: a missing reference fails naming the skill and the reference", async () => {
  const fixture = makeFixture();
  try {
    const result = await call(fixture, { name: "plug", reference: "absent" });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.ok(text.includes('"plug"'), "names the skill");
    assert.ok(text.includes('"absent"'), "names the reference");
    assert.match(text, /missing reference "absent"/);
  } finally {
    fixture.cleanup();
  }
});

test("reference: a skill without referencesDir fails every reference call naming both", async () => {
  const fixture = makeFixture();
  try {
    const result = await call(fixture, { name: "bare", reference: "guide" });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.ok(text.includes('"bare"'), "names the skill");
    assert.ok(text.includes('"guide"'), "names the reference");
    assert.match(text, /no references\/ directory/);
  } finally {
    fixture.cleanup();
  }
});

test("reference: a pi-dent skill with a references/ folder loads its references; one without fails every reference call", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-skillref-home-"));
  const root = mkdtempSync(join(tmpdir(), "pi-dent-skillref-proj-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const skillsDir = join(root, ".pi", "pi-dent", "skills");
    mkdirSync(join(skillsDir, "guided", "references", "deep"), { recursive: true });
    writeFileSync(
      join(skillsDir, "guided", "SKILL.md"),
      "---\nname: guided\ndescription: pi-dent skill\n---\n\nguided body\n",
    );
    writeFileSync(join(skillsDir, "guided", "references", "topic.md"), "topic body\n");
    writeFileSync(join(skillsDir, "guided", "references", "deep", "nested.md"), "nested\n");
    mkdirSync(join(skillsDir, "plain"));
    writeFileSync(
      join(skillsDir, "plain", "SKILL.md"),
      "---\nname: plain\ndescription: no references\n---\n\nplain body\n",
    );
    const diagnostics: Diagnostic[] = [];
    const skills = discoverSkills(root, diagnostics);
    assert.deepEqual(diagnostics, []);
    const boot = {
      skills,
      skillIndex: new Map(skills.map((skill) => [skill.name, skill])),
    } as unknown as BootSnapshot;
    const tool = makeSkillTool(boot);
    const execute = (params: { name: string; reference?: string }) =>
      tool.execute("call-1", params, undefined, undefined, noCtx);
    assert.equal(textOf(await execute({ name: "guided", reference: "topic" })), "topic body\n");
    assert.equal(textOf(await execute({ name: "guided", reference: "deep/nested" })), "nested\n");
    assert.equal(textOf(await execute({ name: "guided" })), "guided body");
    const missing = await execute({ name: "plain", reference: "topic" });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /no references\/ directory/);
    const escape = await execute({ name: "guided", reference: "../plain/SKILL" });
    assert.equal(escape.isError, true);
    assert.match(textOf(escape), /path must not contain a "\.\." segment/);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("reference: omitted still loads the SKILL.md body verbatim", async () => {
  const fixture = makeFixture();
  try {
    const result = await call(fixture, { name: "plug" });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "plug body");
  } finally {
    fixture.cleanup();
  }
});
