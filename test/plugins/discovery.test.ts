import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlugins, type PluginCatalog } from "../../lib/plugins.ts";
import {
  composePluginCatalogs,
  type AgentDefinition,
  type SkillEntry,
} from "../../lib/catalogs.ts";
import type { BootConfig } from "../../lib/config.ts";
import type { Diagnostic } from "../../lib/util.ts";
import { at, must } from "../support/must.ts";

/**
 * Configuration-driven discovery, manifest skip rules, unknown-key
 * diagnostics, and namespace identity per specs/plugin.md#plugin-manifest, specs/plugin.md#identity-namespace, specs/plugin.md#discovery, specs/plugin.md#slash-commands:
 * discoverPlugins reads the merged `plugins` configuration over manually
 * constructed BootConfig layers, so each test pins the exact merged entries
 * and owning-layer file paths without going through the config loader.
 */

interface Fixture {
  /** Throwaway temp root, removed in each test's finally block. */
  root: string;
  /** Global-layer base directory (`~/.pi/pi-dent` equivalent) for relative paths. */
  home: string;
  /** projectRoot (the process working directory); the project layer directory is `<project>/.pi/pi-dent`. */
  project: string;
  /** Project-layer base directory (`<project>/.pi/pi-dent`) for relative paths. */
  projectLayer: string;
  globalConf: string;
  projectConf: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-discovery-"));
  const home = join(root, "home", ".pi", "pi-dent");
  const project = join(root, "project");
  const projectLayer = join(project, ".pi", "pi-dent");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectLayer, { recursive: true });
  return {
    root,
    home,
    project,
    projectLayer,
    globalConf: join(home, "pi-dent.conf"),
    projectConf: join(projectLayer, "pi-dent.conf"),
  };
}

/** Create one plugin directory (with an optional raw manifest) under a base directory. */
function pluginDir(base: string, dir: string, manifest?: string): string {
  const path = join(base, dir);
  mkdirSync(path, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(path, "plugin.json"), manifest);
  return path;
}

type Entries = Record<string, { path: string }>;

function makeConfig(fixture: Fixture, layers: { global?: Entries; project?: Entries }): BootConfig {
  return {
    merged: { plugins: { ...layers.global, ...layers.project } },
    layers: {
      global: layers.global
        ? { path: fixture.globalConf, values: { plugins: layers.global } }
        : undefined,
      project: layers.project
        ? { path: fixture.projectConf, values: { plugins: layers.project } }
        : undefined,
    },
    projectRoot: fixture.project,
    diagnostics: [],
    liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
  } as unknown as BootConfig;
}

function discover(
  fixture: Fixture,
  layers: { global?: Entries; project?: Entries },
): { catalog: PluginCatalog; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const catalog = discoverPlugins(makeConfig(fixture, layers), diagnostics);
  return { catalog, diagnostics };
}

function linesFor(diagnostics: Diagnostic[], needle: string): string[] {
  return diagnostics.filter((d) => d.message.includes(needle)).map((d) => d.message);
}

test("discovery: no plugins key yields an empty catalog with no diagnostics", () => {
  const fixture = makeFixture();
  try {
    const { catalog, diagnostics } = discover(fixture, {});
    assert.deepEqual(catalog.plugins, []);
    assert.deepEqual(diagnostics, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("manifest: unparseable, unreadable, or missing plugin.json skips with one line naming the directory", () => {
  const fixture = makeFixture();
  try {
    const badJson = pluginDir(fixture.home, "plugins/bad-json", "{ not json");
    const array = pluginDir(fixture.home, "plugins/array-manifest", "[1, 2]");
    const bare = pluginDir(fixture.home, "plugins/string-manifest", '"hello"');
    const missing = pluginDir(fixture.home, "plugins/no-manifest");
    const { catalog, diagnostics } = discover(fixture, {
      global: {
        "bad-json": { path: "plugins/bad-json" },
        "array-manifest": { path: "plugins/array-manifest" },
        "string-manifest": { path: "plugins/string-manifest" },
        "no-manifest": { path: "plugins/no-manifest" },
      },
    });
    assert.deepEqual(catalog.plugins, []);
    for (const dir of [badJson, array, bare, missing]) {
      const lines = linesFor(diagnostics, dir);
      assert.equal(lines.length, 1, `exactly one line for ${dir}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /skipped/);
    }
    // An unreadable manifest is not a parse failure: name the read error instead.
    assert.match(at(linesFor(diagnostics, missing), 0), /plugin\.json unreadable: ENOENT/);
    assert.match(at(linesFor(diagnostics, badJson), 0), /plugin\.json failed to parse/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("manifest: invalid name (missing, empty, whitespace, colon, slash) skips with one line naming the directory", () => {
  const fixture = makeFixture();
  try {
    const dirs = [
      pluginDir(fixture.home, "plugins/no-name", JSON.stringify({ description: "x" })),
      pluginDir(fixture.home, "plugins/empty-name", JSON.stringify({ name: "" })),
      pluginDir(fixture.home, "plugins/space-name", JSON.stringify({ name: "a b" })),
      pluginDir(fixture.home, "plugins/colon-name", JSON.stringify({ name: "a:b" })),
      pluginDir(fixture.home, "plugins/slash-name", JSON.stringify({ name: "a/b" })),
      pluginDir(fixture.home, "plugins/num-name", JSON.stringify({ name: 7 })),
    ];
    const { catalog, diagnostics } = discover(fixture, {
      global: {
        "no-name": { path: "plugins/no-name" },
        "empty-name": { path: "plugins/empty-name" },
        "space-name": { path: "plugins/space-name" },
        "colon-name": { path: "plugins/colon-name" },
        "slash-name": { path: "plugins/slash-name" },
        "num-name": { path: "plugins/num-name" },
      },
    });
    assert.deepEqual(catalog.plugins, []);
    for (const dir of dirs) {
      assert.equal(linesFor(diagnostics, dir).length, 1, `exactly one line for ${dir}`);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("manifest: known keys load; unknown keys produce one diagnostic and are ignored", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(
      fixture.home,
      "plugins/valid",
      JSON.stringify({
        name: "valid",
        description: "d",
        version: "1",
        author: "a",
        tools: ["x"],
        anything: { nested: true },
      }),
    );
    const { catalog, diagnostics } = discover(fixture, {
      global: { valid: { path: "plugins/valid" } },
    });
    assert.equal(
      diagnostics.length,
      1,
      `one unknown-key diagnostic: ${JSON.stringify(diagnostics)}`,
    );
    assert.match(at(diagnostics, 0).message, /unknown manifest keys tools, anything ignored/);
    assert.ok(at(diagnostics, 0).message.includes(join(dir, "plugin.json")), "names the manifest");
    assert.equal(catalog.plugins.length, 1);
    assert.equal(at(catalog.plugins, 0).name, "valid");
    assert.equal(
      at(catalog.plugins, 0).root,
      dir,
      "global-layer relative path resolves against the global base directory",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("discovery: merged entries are read in lexicographic key order", () => {
  const fixture = makeFixture();
  try {
    // Keys spread over both layers; "10x" sorts before "2x" ("1" < "2") —
    // lexicographic, not numeric. Directory names are irrelevant. Keys
    // sorting before "m" are declared in the global layer, the rest in the
    // project layer, and each relative path must resolve under its
    // owning layer's base directory.
    const order: Array<[string, string]> = [
      ["beta", "one"],
      ["10x", "two"],
      ["alpha", "three"],
      ["2x", "four"],
    ];
    const global: Entries = {};
    const project: Entries = {};
    for (const [key, name] of order) {
      const inGlobal = key < "m";
      const base = inGlobal ? fixture.home : fixture.projectLayer;
      pluginDir(base, `plugins/${name}`, JSON.stringify({ name }));
      (inGlobal ? global : project)[key] = { path: `plugins/${name}` };
    }
    const { catalog, diagnostics } = discover(fixture, { global, project });
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      catalog.plugins.map((p) => p.name),
      ["two", "four", "three", "one"],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("discovery: relative paths resolve against the owning layer directory; absolute paths are used as given", () => {
  const fixture = makeFixture();
  try {
    const gRel = pluginDir(fixture.home, "plugins/g-rel", JSON.stringify({ name: "g" }));
    const pRel = pluginDir(fixture.projectLayer, "plugins/p-rel", JSON.stringify({ name: "p" }));
    const pAbs = pluginDir(fixture.root, "elsewhere/abs", JSON.stringify({ name: "a" }));
    const { catalog, diagnostics } = discover(fixture, {
      global: { g: { path: "plugins/g-rel" } },
      project: { p: { path: "plugins/p-rel" }, a: { path: pAbs } },
    });
    assert.deepEqual(diagnostics, []);
    // Merged key order: "a" (project, absolute), "g" (global), "p" (project).
    assert.deepEqual(
      catalog.plugins.map((p) => p.root),
      [pAbs, gRel, pRel],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("discovery: a project-layer relative path is not resolved against the process working directory", () => {
  const fixture = makeFixture();
  try {
    // Exists only under <cwd>, not under <cwd>/.pi/pi-dent/: must be skipped as not a directory.
    pluginDir(fixture.project, "plugins/cwd-only", JSON.stringify({ name: "cwd" }));
    const { catalog, diagnostics } = discover(fixture, {
      project: { "cwd-only": { path: "plugins/cwd-only" } },
    });
    assert.deepEqual(catalog.plugins, []);
    const lines = linesFor(diagnostics, join(fixture.projectLayer, "plugins", "cwd-only"));
    assert.equal(lines.length, 1, `one skip line: ${JSON.stringify(diagnostics)}`);
    assert.match(at(lines, 0), /not a directory/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("discovery: malformed entries are skipped with one line naming the owning file and key", () => {
  const fixture = makeFixture();
  try {
    const entries = {
      "missing-path": {},
      "empty-path": { path: "" },
      "space-path": { path: "   " },
      "string-value": "plugins/str",
      remote: { path: "https://example.com/p" },
    } as unknown as Entries;
    const { catalog, diagnostics } = discover(fixture, { global: entries });
    assert.deepEqual(catalog.plugins, []);
    assert.equal(
      diagnostics.length,
      5,
      `one line per malformed entry: ${JSON.stringify(diagnostics)}`,
    );
    for (const key of ["missing-path", "empty-path", "space-path", "string-value", "remote"]) {
      const lines = linesFor(diagnostics, `${fixture.globalConf}#plugins.${key}`);
      assert.equal(lines.length, 1, `exactly one line for ${key}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /skipped/);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("discovery: unknown keys in a plugins entry produce one diagnostic and the entry still loads", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.home, "plugins/extra", JSON.stringify({ name: "extra" }));
    const { catalog, diagnostics } = discover(fixture, {
      global: { extra: { path: "plugins/extra", note: "x", weight: 2 } } as unknown as Entries,
    });
    assert.equal(catalog.plugins.length, 1);
    assert.equal(at(catalog.plugins, 0).root, dir);
    assert.equal(diagnostics.length, 1, `one diagnostic: ${JSON.stringify(diagnostics)}`);
    assert.ok(
      at(diagnostics, 0).message.includes(`${fixture.globalConf}: plugins.extra`),
      "names the owning file and key",
    );
    assert.match(at(diagnostics, 0).message, /unknown keys note, weight ignored/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("discovery: unknown keys of one plugins entry each name the file of their own layer", () => {
  const fixture = makeFixture();
  try {
    pluginDir(fixture.home, "plugins/extra", JSON.stringify({ name: "extra" }));
    const config: BootConfig = {
      merged: { plugins: { extra: { path: "plugins/extra", note: "x", weight: 2 } } },
      layers: {
        global: {
          path: fixture.globalConf,
          values: { plugins: { extra: { path: "plugins/extra", note: "x" } } },
        },
        project: { path: fixture.projectConf, values: { plugins: { extra: { weight: 2 } } } },
      },
      projectRoot: fixture.project,
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    } as unknown as BootConfig;
    const diagnostics: Diagnostic[] = [];
    const catalog = discoverPlugins(config, diagnostics);
    assert.equal(catalog.plugins.length, 1);
    assert.equal(diagnostics.length, 1, `one diagnostic: ${JSON.stringify(diagnostics)}`);
    assert.equal(
      at(diagnostics, 0).message,
      `plugins: plugins.extra: unknown keys note (${fixture.globalConf}), weight (${fixture.projectConf}) ignored`,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("discovery: a path that is not a directory is skipped naming the directory and the entry", () => {
  const fixture = makeFixture();
  try {
    const filePath = join(fixture.home, "plugins", "file-x");
    mkdirSync(join(fixture.home, "plugins"), { recursive: true });
    writeFileSync(filePath, "not a directory");
    const { catalog, diagnostics } = discover(fixture, {
      global: { "file-x": { path: "plugins/file-x" } },
    });
    assert.deepEqual(catalog.plugins, []);
    const lines = linesFor(diagnostics, filePath);
    assert.equal(lines.length, 1);
    assert.ok(
      at(lines, 0).includes(`${fixture.globalConf}#plugins.file-x`),
      "names the owning file and key",
    );
    assert.match(at(lines, 0), /not a directory/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("identity: a later candidate with an already-admitted namespace is skipped with one line naming the namespace and both roots", () => {
  const fixture = makeFixture();
  try {
    const first = pluginDir(fixture.home, "plugins/first", JSON.stringify({ name: "same" }));
    const second = pluginDir(fixture.home, "plugins/second", JSON.stringify({ name: "same" }));
    const { catalog, diagnostics } = discover(fixture, {
      global: { "a-first": { path: "plugins/first" }, "b-second": { path: "plugins/second" } },
    });
    assert.equal(catalog.plugins.length, 1);
    assert.equal(at(catalog.plugins, 0).root, first);
    assert.equal(must(catalog.byNamespace.get("same")).root, first);
    const lines = linesFor(diagnostics, second);
    assert.equal(lines.length, 1, `exactly one line for ${second}`);
    assert.ok(at(lines, 0).includes('"same"'), "the line names the namespace");
    assert.ok(at(lines, 0).includes(first), "the line names the first (admitted) root");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("discovery: command frontmatter with unknown keys produces one diagnostic and the command still loads", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.home, "plugins/cmds", JSON.stringify({ name: "cmds" }));
    mkdirSync(join(dir, "commands"));
    const file = join(dir, "commands", "greet.md");
    writeFileSync(file, "---\ndescription: Say hi\nfuture: ignored\n---\n\nHello $1\n");
    const { catalog, diagnostics } = discover(fixture, {
      global: { cmds: { path: "plugins/cmds" } },
    });
    assert.equal(diagnostics.length, 1, `one diagnostic: ${JSON.stringify(diagnostics)}`);
    assert.ok(at(diagnostics, 0).message.includes(file), "names the command file");
    assert.equal(
      at(diagnostics, 0).message,
      `commands: ${file}: frontmatter: unknown keys future ignored`,
    );
    const commands = at(catalog.plugins, 0).commands;
    assert.deepEqual(
      commands.map((c) => [c.name, c.description]),
      [["greet", "Say hi"]],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resources: malformed frontmatter in plugin agents or SKILL.md is skipped with exactly one report line per file", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-malformed-"));
  try {
    const pluginRoot = join(root, "shared");
    mkdirSync(join(pluginRoot, "agents"), { recursive: true });
    mkdirSync(join(pluginRoot, "skills", "broken"), { recursive: true });
    const agentFile = join(pluginRoot, "agents", "bad.md");
    const skillFile = join(pluginRoot, "skills", "broken", "SKILL.md");
    writeFileSync(agentFile, "---\nname: [unclosed\n---\nbody");
    writeFileSync(skillFile, "---\ndescription: [unclosed\n---\nbody");
    const agents: AgentDefinition[] = [];
    const skills: SkillEntry[] = [];
    const diagnostics: Diagnostic[] = [];
    composePluginCatalogs(agents, skills, [{ name: "shared", root: pluginRoot }], diagnostics);
    assert.deepEqual(agents, []);
    assert.deepEqual(skills, []);
    for (const file of [agentFile, skillFile]) {
      const lines = linesFor(diagnostics, file);
      assert.equal(lines.length, 1, `exactly one line for ${file}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /malformed frontmatter/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery: a plugins value that is not an object is skipped with one diagnostic", () => {
  const fixture = makeFixture();
  try {
    const config: BootConfig = {
      merged: { plugins: "plugins/a" },
      layers: { project: { path: fixture.projectConf, values: { plugins: "plugins/a" } } },
      projectRoot: fixture.project,
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    } as unknown as BootConfig;
    const diagnostics: Diagnostic[] = [];
    const catalog = discoverPlugins(config, diagnostics);
    assert.deepEqual(catalog.plugins, []);
    assert.equal(diagnostics.length, 1, `one diagnostic: ${JSON.stringify(diagnostics)}`);
    assert.ok(at(diagnostics, 0).message.includes(fixture.projectConf), "names the owning file");
    assert.match(at(diagnostics, 0).message, /skipped \("plugins" must be an object\)/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resources: a command basename that is not a valid name is skipped without a diagnostic", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.home, "plugins/cmds", JSON.stringify({ name: "cmds" }));
    mkdirSync(join(dir, "commands"));
    for (const name of ["bad name.md", "a:b.md", ".md", "ok.md"]) {
      writeFileSync(join(dir, "commands", name), "body of $ARGUMENTS\n");
    }
    const { catalog, diagnostics } = discover(fixture, {
      global: { cmds: { path: "plugins/cmds" } },
    });
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      at(catalog.plugins, 0).commands.map((command) => command.name),
      ["ok"],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resources: a command file whose frontmatter fails to parse at boot is registered without a description", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.home, "plugins/cmds", JSON.stringify({ name: "cmds" }));
    mkdirSync(join(dir, "commands"));
    writeFileSync(join(dir, "commands", "hello.md"), "---\ndescription: [unclosed\n---\nRun it.\n");
    const { catalog, diagnostics } = discover(fixture, {
      global: { cmds: { path: "plugins/cmds" } },
    });
    assert.deepEqual(diagnostics, []);
    const commands = at(catalog.plugins, 0).commands;
    assert.deepEqual(
      commands.map((command) => [command.name, command.description]),
      [["hello", undefined]],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test(
  "resources: a command file that cannot be read at boot is registered without a description",
  {
    skip:
      typeof process.getuid === "function" && process.getuid() === 0
        ? "root reads any file"
        : false,
  },
  () => {
    const fixture = makeFixture();
    try {
      const dir = pluginDir(fixture.home, "plugins/cmds", JSON.stringify({ name: "cmds" }));
      mkdirSync(join(dir, "commands"));
      const file = join(dir, "commands", "quiet.md");
      writeFileSync(file, "---\ndescription: hidden\n---\nbody\n");
      chmodSync(file, 0o000);
      const { catalog, diagnostics } = discover(fixture, {
        global: { cmds: { path: "plugins/cmds" } },
      });
      chmodSync(file, 0o600);
      assert.deepEqual(diagnostics, []);
      const commands = at(catalog.plugins, 0).commands;
      assert.deepEqual(
        commands.map((command) => [command.name, command.description]),
        [["quiet", undefined]],
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "resources: a commands directory that cannot be read is one diagnostic naming it",
  {
    skip:
      typeof process.getuid === "function" && process.getuid() === 0
        ? "root reads any directory"
        : false,
  },
  () => {
    const fixture = makeFixture();
    try {
      const dir = pluginDir(fixture.home, "plugins/cmds", JSON.stringify({ name: "cmds" }));
      const commandsDir = join(dir, "commands");
      mkdirSync(commandsDir);
      writeFileSync(join(commandsDir, "hidden.md"), "---\ndescription: hidden\n---\nbody\n");
      chmodSync(commandsDir, 0o000);
      let discovered: { catalog: PluginCatalog; diagnostics: Diagnostic[] };
      try {
        discovered = discover(fixture, { global: { cmds: { path: "plugins/cmds" } } });
      } finally {
        chmodSync(commandsDir, 0o755);
      }
      const lines = linesFor(discovered.diagnostics, commandsDir);
      assert.equal(lines.length, 1, `exactly one line: ${JSON.stringify(discovered.diagnostics)}`);
      assert.equal(at(lines, 0), `commands: ${commandsDir}: unreadable: EACCES`);
      assert.deepEqual(at(discovered.catalog.plugins, 0).commands, []);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "resources: a command file whose own stat fails is registered with no description and no diagnostic",
  {
    skip:
      typeof process.getuid === "function" && process.getuid() === 0
        ? "root reads any directory"
        : false,
  },
  () => {
    const fixture = makeFixture();
    try {
      const dir = pluginDir(fixture.home, "plugins/cmds", JSON.stringify({ name: "cmds" }));
      const commandsDir = join(dir, "commands");
      const hidden = join(dir, "hidden");
      mkdirSync(commandsDir);
      mkdirSync(hidden);
      writeFileSync(join(hidden, "quiet.md"), "---\ndescription: hidden\n---\nbody\n");
      symlinkSync(join(hidden, "quiet.md"), join(commandsDir, "quiet.md"));
      chmodSync(hidden, 0o000);
      let discovered: { catalog: PluginCatalog; diagnostics: Diagnostic[] };
      try {
        discovered = discover(fixture, { global: { cmds: { path: "plugins/cmds" } } });
      } finally {
        chmodSync(hidden, 0o755);
      }
      // specs/plugin.md#slash-commands: still registered, without a description and without a diagnostic.
      assert.deepEqual(discovered.diagnostics, []);
      const commands = at(discovered.catalog.plugins, 0).commands;
      assert.deepEqual(
        commands.map((command) => [command.name, command.description]),
        [["quiet", undefined]],
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);
test(
  "resources: a command link that leads outside the plugin root is skipped even when its target cannot be read",
  {
    skip:
      typeof process.getuid === "function" && process.getuid() === 0
        ? "root reads any directory"
        : false,
  },
  () => {
    const fixture = makeFixture();
    try {
      const dir = pluginDir(fixture.home, "plugins/cmds", JSON.stringify({ name: "cmds" }));
      const commandsDir = join(dir, "commands");
      const outside = join(fixture.home, "outside");
      mkdirSync(commandsDir);
      mkdirSync(outside);
      writeFileSync(join(outside, "esc.md"), "body\n");
      symlinkSync(join(outside, "esc.md"), join(commandsDir, "esc.md"));
      chmodSync(outside, 0o000);
      let discovered: { catalog: PluginCatalog; diagnostics: Diagnostic[] };
      try {
        discovered = discover(fixture, { global: { cmds: { path: "plugins/cmds" } } });
      } finally {
        chmodSync(outside, 0o755);
      }
      // specs/plugin.md#slash-commands: not a contained path, so skipped without a diagnostic.
      assert.deepEqual(discovered.diagnostics, []);
      assert.deepEqual(at(discovered.catalog.plugins, 0).commands, []);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
);
