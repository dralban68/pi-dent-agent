import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootSnapshot, ToolResult } from "../../lib/engine.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { PluginEntry } from "../../lib/plugins.ts";
import type { SkillEntry } from "../../lib/catalogs.ts";
import { makePluginTool, makeSkillTool, pluginParameterSchema } from "../../lib/tools.ts";
import { at, must } from "../support/must.ts";

/**
 * Plugin tool execution per specs/plugin-tool.md#parameter-schema, specs/plugin-tool.md#path-rules, and specs/plugin-tool.md#execution-contract:
 * integration tests through the public `execute` surface against a
 * boot-snapshot plugin catalog backed by real files.
 */

interface Fixture {
  tool: ReturnType<typeof makePluginTool>;
  root: string;
  entry: (name: string) => PluginEntry;
  cleanup: () => void;
}

function makeFixture(namespaces: string[]): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-tool-"));
  const pluginIndex = new Map<string, PluginEntry>();
  for (const name of namespaces) {
    const pluginRoot = join(root, name);
    mkdirSync(pluginRoot);
    pluginIndex.set(name, { name, root: pluginRoot, commands: [] });
  }
  const boot = { pluginIndex } as unknown as BootSnapshot;
  return {
    tool: makePluginTool(boot),
    root,
    entry: (name) => must(pluginIndex.get(name)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function textOf(result: ToolResult): string {
  assert.equal(result.content.length, 1, "one text content block");
  const first = at(result.content, 0);
  if (first.type !== "text") assert.fail(`expected text content, got ${first.type}`);
  return first.text;
}

/** The Plugin tool's execute ignores its ExtensionToolContext; the surface still requires one. */
const noCtx = undefined as unknown as ExtensionToolContext;

async function call(
  fixture: Fixture,
  params: { plugin: string; path: string; args?: string },
): Promise<ToolResult> {
  return fixture.tool.execute("call-1", params, undefined, undefined, noCtx);
}

test("schema: object schema, plugin and path required, args optional, additional properties rejected", () => {
  const schema = pluginParameterSchema as unknown as {
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, { type: string }>;
  };
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).toSorted(), ["args", "path", "plugin"]);
  assert.ok(schema.required.includes("plugin") && schema.required.includes("path"));
  assert.ok(!schema.required.includes("args"));
});

test("unknown plugin fails listing known namespaces sorted in ascending ASCII joined by ', '", async () => {
  const fixture = makeFixture(["charlie", "alpha", "bravo"]);
  try {
    const result = await call(fixture, { plugin: "zulu", path: "commands/a.md" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'unknown plugin "zulu". Known namespaces: alpha, bravo, charlie');
  } finally {
    fixture.cleanup();
  }
});

test("unknown plugin with an empty catalog fails with (none)", async () => {
  const fixture = makeFixture([]);
  try {
    const result = await call(fixture, { plugin: "zulu", path: "commands/a.md" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'unknown plugin "zulu". Known namespaces: (none)');
  } finally {
    fixture.cleanup();
  }
});

test("empty or whitespace plugin fails as a tool error", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    for (const name of ["", "  "]) {
      const result = await call(fixture, { plugin: name, path: "commands/a.md" });
      assert.equal(result.isError, true, JSON.stringify(name));
      assert.equal(textOf(result), "plugin is required and must be non-empty");
    }
  } finally {
    fixture.cleanup();
  }
});

test("missing resource fails naming its absolute path", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    const result = await call(fixture, { plugin: "alpha", path: "commands/absent.md" });
    assert.equal(result.isError, true);
    assert.equal(
      textOf(result),
      `plugin "alpha": missing resource ${join(fixture.entry("alpha").root, "commands", "absent.md")}`,
    );
  } finally {
    fixture.cleanup();
  }
});

test("the file is read fresh on every call: edits between calls are visible", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    const root = fixture.entry("alpha").root;
    mkdirSync(join(root, "commands"));
    const file = join(root, "commands", "note.md");
    writeFileSync(file, "v1");
    assert.equal(textOf(await call(fixture, { plugin: "alpha", path: "commands/note.md" })), "v1");
    writeFileSync(file, "v2 written after the first call");
    assert.equal(
      textOf(await call(fixture, { plugin: "alpha", path: "commands/note.md" })),
      "v2 written after the first call",
    );
  } finally {
    fixture.cleanup();
  }
});

test("reads succeed under each of commands/, agents/, and skills/", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    const root = fixture.entry("alpha").root;
    for (const dir of [join(root, "commands"), join(root, "agents"), join(root, "skills", "s")]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(root, "commands", "c.md"), "command body");
    writeFileSync(join(root, "agents", "a.md"), "agent body");
    writeFileSync(join(root, "skills", "s", "SKILL.md"), "skill body");
    assert.equal(
      textOf(await call(fixture, { plugin: "alpha", path: "commands/c.md" })),
      "command body",
    );
    assert.equal(
      textOf(await call(fixture, { plugin: "alpha", path: "agents/a.md" })),
      "agent body",
    );
    assert.equal(
      textOf(await call(fixture, { plugin: "alpha", path: "skills/s/SKILL.md" })),
      "skill body",
    );
  } finally {
    fixture.cleanup();
  }
});

test("omitted args return the file text verbatim, frontmatter included, with no substitution", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    const root = fixture.entry("alpha").root;
    mkdirSync(join(root, "commands"));
    const file = join(root, "commands", "raw.md");
    const text =
      "---\ndescription: frontmatter stays\nunknown: key\n---\n\nBody $1 $2 $@ $ARGUMENTS ${@:1} ${@:2:1} $5\n";
    writeFileSync(file, text);
    const result = await call(fixture, { plugin: "alpha", path: "commands/raw.md" });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), text);
  } finally {
    fixture.cleanup();
  }
});

test("present args substitute per the token table; empty args substitute empties", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    const root = fixture.entry("alpha").root;
    mkdirSync(join(root, "commands"));
    writeFileSync(join(root, "commands", "sub.md"), "Hello $1 and $ARGUMENTS");
    assert.equal(
      textOf(await call(fixture, { plugin: "alpha", path: "commands/sub.md", args: "a b" })),
      "Hello a and a b",
    );
    assert.equal(
      textOf(await call(fixture, { plugin: "alpha", path: "commands/sub.md", args: "" })),
      "Hello  and ",
    );
  } finally {
    fixture.cleanup();
  }
});

test("present args: only $ARGUMENTS and $N substitute; $0, $@ and ${@:...} stay literal", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    const root = fixture.entry("alpha").root;
    mkdirSync(join(root, "commands"));
    writeFileSync(
      join(root, "commands", "forms.md"),
      "a=$1 b=$@ c=${@:1} d=${@:2:1} e=$0 f=$ARGUMENTSX g=$5\n",
    );
    assert.equal(
      textOf(await call(fixture, { plugin: "alpha", path: "commands/forms.md", args: "x y" })),
      "a=x b=$@ c=${@:1} d=${@:2:1} e=$0 f=x yX g=\n",
    );
  } finally {
    fixture.cleanup();
  }
});

test("a plugin skill file is served from the boot snapshot by Skill and read fresh by Plugin", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    const root = fixture.entry("alpha").root;
    const dir = join(root, "skills", "s");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    writeFileSync(file, "---\nname: s\ndescription: d\n---\n\nsnapshot body\n");
    const snapshot: SkillEntry = {
      name: "alpha:s",
      description: "d",
      body: "snapshot body\n",
      source: file,
    };
    const boot = {
      pluginIndex: new Map([["alpha", fixture.entry("alpha")]]),
      skills: [snapshot],
      skillIndex: new Map([[snapshot.name, snapshot]]),
    } as unknown as BootSnapshot;
    const skillTool = makeSkillTool(boot);
    const pluginTool = makePluginTool(boot);
    writeFileSync(file, "---\nname: s\ndescription: d\n---\n\nfresh body\n");
    assert.equal(
      textOf(await skillTool.execute("c", { name: "alpha:s" }, undefined, undefined, noCtx)),
      "snapshot body\n",
      "Skill serves the boot snapshot",
    );
    assert.equal(
      textOf(
        await pluginTool.execute(
          "c",
          { plugin: "alpha", path: "skills/s/SKILL.md" },
          undefined,
          undefined,
          noCtx,
        ),
      ),
      "---\nname: s\ndescription: d\n---\n\nfresh body\n",
      "Plugin reads the file fresh (specs/plugin.md#plugin-catalog)",
    );
  } finally {
    fixture.cleanup();
  }
});

test("path: absolute paths fail as a tool error", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    for (const path of [
      "/etc/passwd",
      "C:/commands/x.md",
      "C:\\commands\\x.md",
      "\\foo",
      "\\\\server\\share",
    ]) {
      const result = await call(fixture, { plugin: "alpha", path });
      assert.equal(result.isError, true, path);
      assert.match(textOf(result), /path must be relative/);
    }
  } finally {
    fixture.cleanup();
  }
});

test("path: .. segments fail, with backslash treated as a separator", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    for (const path of [
      "commands/../secret.md",
      "commands\\..\\secret.md",
      "skills/s/../../escape.md",
    ]) {
      const result = await call(fixture, { plugin: "alpha", path });
      assert.equal(result.isError, true, path);
      assert.match(textOf(result), /path must not contain a "\.\." segment/);
    }
  } finally {
    fixture.cleanup();
  }
});

test("path: a first segment other than commands, agents, or skills fails", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    for (const path of ["docs/x.md", "commands.md/x", "package.json", "commandsx/y.md"]) {
      const result = await call(fixture, { plugin: "alpha", path });
      assert.equal(result.isError, true, path);
      assert.match(textOf(result), /path must start with commands, agents, or skills/);
    }
  } finally {
    fixture.cleanup();
  }
});

test("path: an empty path fails", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    const result = await call(fixture, { plugin: "alpha", path: "" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /path is required/);
  } finally {
    fixture.cleanup();
  }
});

test("path: whitespace-only plugin or path, and non-resource skills shapes, fail as tool errors", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    mkdirSync(join(fixture.entry("alpha").root, "skills", "sk"), { recursive: true });
    writeFileSync(join(fixture.entry("alpha").root, "skills", "sk", "other.md"), "not SKILL.md");
    for (const [params, pattern] of [
      [{ plugin: "   ", path: "commands/x.md" }, /plugin is required/],
      [{ plugin: "alpha", path: "  " }, /path is required/],
      [{ plugin: "alpha", path: "skills/sk/other.md" }, /skills\/<name>\/SKILL\.md/],
      [{ plugin: "alpha", path: "commands/sub/x.md" }, /commands\/\*\.md/],
    ] as const) {
      const result = await call(fixture, { ...params });
      assert.equal(result.isError, true, JSON.stringify(params));
      assert.match(textOf(result), pattern);
    }
  } finally {
    fixture.cleanup();
  }
});

test("path: references/ resources must be Markdown; non-.md shapes fail like other invalid shapes", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    const root = fixture.entry("alpha").root;
    mkdirSync(join(root, "skills", "s", "references"), { recursive: true });
    writeFileSync(join(root, "skills", "s", "references", "a.txt"), "not markdown");
    writeFileSync(join(root, "skills", "s", "references", "b.md"), "markdown reference");
    for (const path of ["skills/s/references/a.txt", "skills/s/references/.md"]) {
      const result = await call(fixture, { plugin: "alpha", path });
      assert.equal(result.isError, true, path);
      assert.match(
        textOf(result),
        /path must match commands\/\*\.md, agents\/\*\.md, skills\/<name>\/SKILL\.md, or skills\/<name>\/references\/\*\*\/\*\.md/,
      );
    }
    assert.equal(
      textOf(await call(fixture, { plugin: "alpha", path: "skills/s/references/b.md" })),
      "markdown reference",
      "a .md reference is a valid resource",
    );
    const absent = await call(fixture, { plugin: "alpha", path: "skills/s/references/absent.md" });
    assert.equal(absent.isError, true);
    assert.match(textOf(absent), /missing resource/);
  } finally {
    fixture.cleanup();
  }
});

test("path: a symlink that escapes its root is rejected before any read", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    const root = fixture.entry("alpha").root;
    mkdirSync(join(root, "commands"));
    const outside = mkdtempSync(join(tmpdir(), "pi-dent-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "secret outside the plugin root");
      symlinkSync(join(outside, "secret.md"), join(root, "commands", "escape.md"));
      const result = await call(fixture, { plugin: "alpha", path: "commands/escape.md" });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /escapes its root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fixture.cleanup();
  }
});

test("path: a dangling link that escapes through a directory link is rejected before any read", async () => {
  const fixture = makeFixture(["alpha"]);
  try {
    const root = fixture.entry("alpha").root;
    mkdirSync(join(root, "commands"));
    const outside = mkdtempSync(join(tmpdir(), "pi-dent-outside-"));
    try {
      mkdirSync(join(outside, "dir"));
      // The link's text stays under the root; only the directory link leaves it.
      symlinkSync(join(outside, "dir"), join(root, "commands", "link"));
      symlinkSync("link/missing.md", join(root, "commands", "escape.md"));
      const result = await call(fixture, { plugin: "alpha", path: "commands/escape.md" });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /escapes its root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fixture.cleanup();
  }
});
