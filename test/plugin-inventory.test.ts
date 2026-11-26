import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPluginInventory,
  type PluginInventory,
  type InventoryCandidate,
} from "../lib/plugin-inventory.ts";
import { readBootSnapshot } from "../lib/engine.ts";
import { SUPPORTED_ROOT_KEYS } from "../lib/config.ts";
import { must } from "./support/must.ts";

/**
 * The plugin inventory per specs/plugin.md#plugin-inventory: layer states, per-candidate skips,
 * admitted-plugin resources, the specs/plugin.md#script-listing script walk, and agreement with boot discovery
 * (the same rules, read anew through readPluginInventory instead of the boot snapshot).
 */

interface Fixture {
  /** Throwaway temp root, removed in each test's finally block. */
  root: string;
  /** HOME for the call: the global layer directory is `<home>/.pi/pi-dent`. */
  home: string;
  globalLayer: string;
  globalConf: string;
  /** The `cwd` argument: the project layer directory is `<project>/.pi/pi-dent`. */
  project: string;
  projectLayer: string;
  projectConf: string;
}

const ENV_KEYS = [
  "HOME",
  "PI_DENT_AGENT_IDLE_TIMEOUT_MS",
  "PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS",
  "PI_DENT_AGENT_RECOVERY_MAX_RETRIES",
  "PI_DENT_SESSION_TTL_DAYS",
];

function withFixture<T>(fn: (fixture: Fixture) => T): T {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-inventory-"));
  const home = join(root, "home");
  const globalLayer = join(home, ".pi", "pi-dent");
  const project = join(root, "project");
  const projectLayer = join(project, ".pi", "pi-dent");
  mkdirSync(globalLayer, { recursive: true });
  mkdirSync(projectLayer, { recursive: true });
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  for (const key of ENV_KEYS) {
    if (key !== "HOME") delete process.env[key];
  }
  try {
    return fn({
      root,
      home,
      globalLayer,
      globalConf: join(globalLayer, "pi-dent.conf"),
      project,
      projectLayer,
      projectConf: join(projectLayer, "pi-dent.conf"),
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function writeConf(path: string, body: string | Record<string, unknown>): void {
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

/** Create one plugin directory (with an optional manifest) under a base directory. */
function pluginDir(base: string, dir: string, manifest?: string | Record<string, unknown>): string {
  const path = join(base, dir);
  mkdirSync(path, { recursive: true });
  if (manifest !== undefined) {
    writeFileSync(
      join(path, "plugin.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  }
  return path;
}

function candidateOf(inventory: PluginInventory, key: string): InventoryCandidate {
  return must(inventory.candidates.find((candidate) => candidate.key === key));
}

test("inventory: an admitted plugin lists every manifest field, context flag, and resource kind", () => {
  withFixture((fixture) => {
    const full = pluginDir(fixture.projectLayer, "plugins/full", {
      name: "full",
      description: "Everything at once",
      version: "1.2.3",
      author: { name: "Ada", email: "a@example.com" },
    });
    mkdirSync(join(full, "commands"));
    mkdirSync(join(full, "agents"));
    mkdirSync(join(full, "skills", "useful"), { recursive: true });
    mkdirSync(join(full, "scripts", "deep"), { recursive: true });
    writeFileSync(join(full, "context.md"), "Context text.\n");
    writeFileSync(join(full, "commands", "greet.md"), "---\ndescription: Say hi\n---\nHello\n");
    writeFileSync(join(full, "commands", "plain.md"), "No frontmatter.\n");
    writeFileSync(join(full, "commands", "bad name.md"), "Skipped without a diagnostic.\n");
    writeFileSync(
      join(full, "agents", "helper.md"),
      "---\nname: helper\ndescription: Helps out\n---\nYou are a helper.\n",
    );
    writeFileSync(
      join(full, "skills", "useful", "SKILL.md"),
      "---\nname: useful\ndescription: A useful skill\n---\nBe useful.\n",
    );
    writeFileSync(join(full, "scripts", "run.js"), "export default 1;\n");
    writeFileSync(join(full, "scripts", "deep", "nested.ts"), "export default 2;\n");
    writeFileSync(join(full, "scripts", "README.md"), "not a script\n");
    const bare = pluginDir(fixture.projectLayer, "plugins/bare", { name: "bare" });
    writeConf(fixture.projectConf, {
      plugins: { "a-full": { path: "plugins/full" }, "z-bare": { path: "plugins/bare" } },
    });
    const inventory = readPluginInventory(fixture.project);
    assert.equal(inventory.cwd, fixture.project);
    assert.deepEqual(inventory.layers, [
      { layer: "global", file: fixture.globalConf, state: "missing" },
      { layer: "project", file: fixture.projectConf, state: "read" },
    ]);
    assert.deepEqual(inventory.diagnostics, []);
    assert.deepEqual(
      inventory.candidates.map((candidate) => candidate.key),
      ["a-full", "z-bare"],
    );
    const fullCandidate = candidateOf(inventory, "a-full");
    assert.equal(fullCandidate.layer, "project");
    assert.equal(fullCandidate.configFile, fixture.projectConf);
    assert.equal(fullCandidate.root, full);
    assert.equal(fullCandidate.skip, null);
    assert.deepEqual(fullCandidate.diagnostics, []);
    assert.deepEqual(fullCandidate.plugin, {
      namespace: "full",
      description: "Everything at once",
      version: "1.2.3",
      author: { name: "Ada", email: "a@example.com" },
      context: true,
      commands: [
        { name: "greet", description: "Say hi", file: "commands/greet.md" },
        { name: "plain", description: null, file: "commands/plain.md" },
      ],
      agents: [{ name: "helper", description: "Helps out", file: "agents/helper.md" }],
      skills: [{ name: "useful", description: "A useful skill", file: "skills/useful/SKILL.md" }],
      scripts: [
        { name: "scripts/deep/nested.ts", description: null, file: "scripts/deep/nested.ts" },
        { name: "scripts/run.js", description: null, file: "scripts/run.js" },
      ],
      mcpServers: [],
    });
    const bareCandidate = candidateOf(inventory, "z-bare");
    assert.equal(bareCandidate.root, bare);
    assert.deepEqual(bareCandidate.plugin, {
      namespace: "bare",
      description: null,
      version: null,
      author: null,
      context: false,
      commands: [],
      agents: [],
      skills: [],
      scripts: [],
      mcpServers: [],
    });
  });
});

test("inventory: manifest author shapes; non-string description and version are null", () => {
  withFixture((fixture) => {
    const dir = pluginDir(fixture.projectLayer, "plugins/shapes");
    writeConf(fixture.projectConf, { plugins: { shapes: { path: "plugins/shapes" } } });
    const manifestOf = () =>
      must(candidateOf(readPluginInventory(fixture.project), "shapes").plugin);
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({ name: "shapes", description: 5, version: [], author: "Ada" }),
    );
    assert.deepEqual(manifestOf(), {
      namespace: "shapes",
      description: null,
      version: null,
      author: "Ada",
      context: false,
      commands: [],
      agents: [],
      skills: [],
      scripts: [],
      mcpServers: [],
    });
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({
        name: "shapes",
        description: "d",
        version: "2",
        author: { name: 7, email: "a@x" },
      }),
    );
    assert.deepEqual(manifestOf().author, { name: null, email: "a@x" });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "shapes", author: 7 }));
    assert.equal(manifestOf().author, null);
  });
});

test("inventory: each skip kind reports its skip text, root, and plugin null", () => {
  withFixture((fixture) => {
    const first = pluginDir(fixture.projectLayer, "plugins/first", { name: "same" });
    const dup = pluginDir(fixture.projectLayer, "plugins/dup", { name: "same" });
    const unparseable = pluginDir(fixture.projectLayer, "plugins/unparseable", "{ not json");
    const noManifest = pluginDir(fixture.projectLayer, "plugins/no-manifest");
    const badName = pluginDir(fixture.projectLayer, "plugins/bad-name", { name: "a b" });
    const missing = join(fixture.projectLayer, "plugins", "missing");
    writeConf(fixture.projectConf, {
      plugins: {
        "a-first": { path: "plugins/first" },
        "b-dup": { path: "plugins/dup" },
        unparseable: { path: "plugins/unparseable" },
        "no-manifest": { path: "plugins/no-manifest" },
        "bad-name": { path: "plugins/bad-name" },
        missing: { path: "plugins/missing" },
        remote: { path: "https://example.com/p" },
        str: "plugins/nowhere",
        empty: { path: "" },
      },
    });
    const inventory = readPluginInventory(fixture.project);
    const skipped = (key: string, root: string | null, skip: string): void => {
      const candidate = candidateOf(inventory, key);
      assert.equal(candidate.root, root, key);
      assert.equal(candidate.plugin, null, key);
      assert.equal(candidate.skip, skip, key);
      assert.equal(candidate.diagnostics.at(-1), skip, `${key}: skip is the last diagnostic`);
    };
    skipped(
      "str",
      null,
      `plugins: ${fixture.projectConf}#plugins.str: skipped (malformed value; expected { "path": string })`,
    );
    skipped(
      "empty",
      null,
      `plugins: ${fixture.projectConf}#plugins.empty: skipped (malformed value; expected { "path": string })`,
    );
    skipped(
      "remote",
      null,
      `plugins: ${fixture.projectConf}#plugins.remote: skipped (remote or URL source is not supported: https://example.com/p)`,
    );
    skipped(
      "missing",
      missing,
      `plugins: ${missing}: skipped (configured in ${fixture.projectConf}#plugins.missing: not a directory)`,
    );
    assert.match(
      must(candidateOf(inventory, "unparseable").skip),
      new RegExp(`^plugins: ${unparseable}: skipped \\(plugin\\.json failed to parse: .+\\)$`),
    );
    assert.equal(candidateOf(inventory, "unparseable").root, unparseable);
    skipped(
      "no-manifest",
      noManifest,
      `plugins: ${noManifest}: skipped (plugin.json unreadable: ENOENT)`,
    );
    skipped("bad-name", badName, `plugins: ${badName}: skipped (plugin.json lacks a valid name)`);
    skipped(
      "b-dup",
      dup,
      `plugins: ${dup}: skipped (namespace "same" already admitted from ${first})`,
    );
    const admitted = candidateOf(inventory, "a-first");
    assert.notEqual(admitted.plugin, null);
    assert.equal(admitted.skip, null);
  });
});

test("inventory: layer states missing, dropped, and read", () => {
  withFixture((fixture) => {
    pluginDir(fixture.globalLayer, "plugins/g", { name: "g" });
    writeConf(fixture.globalConf, { plugins: { g: { path: "plugins/g" } } });
    writeConf(fixture.projectConf, "{ not json");
    const inventory = readPluginInventory(fixture.project);
    assert.deepEqual(inventory.layers, [
      { layer: "global", file: fixture.globalConf, state: "read" },
      { layer: "project", file: fixture.projectConf, state: "dropped" },
    ]);
    assert.equal(inventory.diagnostics.length, 1);
    assert.ok(inventory.diagnostics[0]?.includes(fixture.projectConf));
    assert.match(must(inventory.diagnostics[0]), /failed to parse/);
    // The dropped project layer still leaves the global plugin, attributed to the global file.
    const candidate = candidateOf(inventory, "g");
    assert.equal(candidate.layer, "global");
    assert.equal(candidate.configFile, fixture.globalConf);
    assert.notEqual(candidate.plugin, null);
  });
  withFixture((fixture) => {
    const inventory = readPluginInventory(fixture.project);
    assert.deepEqual(inventory.layers, [
      { layer: "global", file: fixture.globalConf, state: "missing" },
      { layer: "project", file: fixture.projectConf, state: "missing" },
    ]);
    assert.deepEqual(inventory.diagnostics, []);
    assert.deepEqual(inventory.candidates, []);
  });
});

test("inventory: unknown root keys and failed substitutions are inventory diagnostics, not candidate ones", () => {
  withFixture((fixture) => {
    pluginDir(fixture.projectLayer, "plugins/p", { name: "p" });
    writeConf(
      fixture.projectConf,
      '{ "bogus": 1, "plugins": { "p": { "path": "plugins/p" }, "a": { "path": "${env.PI_DENT_INVENTORY_MISSING}" } } }',
    );
    const inventory = readPluginInventory(fixture.project);
    // The unknown root key does not drop the layer, and the failed substitution removes
    // `plugins.a.path` (a layer diagnostic), leaving a malformed `plugins.a` candidate.
    assert.deepEqual(
      inventory.layers.map((layer) => [layer.layer, layer.state]),
      [
        ["global", "missing"],
        ["project", "read"],
      ],
    );
    assert.deepEqual(
      inventory.diagnostics,
      [
        "config: plugins.a.path: `${env.PI_DENT_INVENTORY_MISSING}` references undefined environment variable " +
          `PI_DENT_INVENTORY_MISSING (${fixture.projectConf})`,
        `config: ${fixture.projectConf}: unknown root keys "bogus"; supported keys are ${SUPPORTED_ROOT_KEYS.map((key) => `"${key}"`).join(", ")}`,
      ],
      JSON.stringify(inventory.diagnostics),
    );
    assert.deepEqual(
      inventory.candidates.map((candidate) => candidate.key),
      ["a", "p"],
    );
    assert.deepEqual(candidateOf(inventory, "a").diagnostics, [
      `plugins: ${fixture.projectConf}#plugins.a: skipped (malformed value; expected { "path": string })`,
    ]);
    assert.deepEqual(candidateOf(inventory, "p").diagnostics, []);
  });
});

test("inventory: a plugins value that is not an object is one inventory diagnostic and no candidates", () => {
  withFixture((fixture) => {
    writeConf(fixture.projectConf, { plugins: "plugins/a" });
    const inventory = readPluginInventory(fixture.project);
    assert.deepEqual(inventory.candidates, []);
    assert.deepEqual(inventory.diagnostics, [
      `plugins: ${fixture.projectConf}: skipped ("plugins" must be an object)`,
    ]);
  });
});

test("inventory: a candidate from each layer names its owning layer's file and root", () => {
  withFixture((fixture) => {
    const g = pluginDir(fixture.globalLayer, "plugins/g", { name: "g" });
    const p = pluginDir(fixture.projectLayer, "plugins/p", { name: "p" });
    const viaRoot = pluginDir(fixture.project, "plugins/p", { name: "p" });
    writeConf(fixture.globalConf, { plugins: { g: { path: "plugins/g" } } });
    writeConf(
      fixture.projectConf,
      '{ "plugins": { "p": { "path": "plugins/p" }, "pp": { "path": "${project.root}/plugins/p" } } }',
    );
    const inventory = readPluginInventory(fixture.project);
    assert.deepEqual(
      inventory.candidates.map((candidate) => [candidate.key, candidate.layer, candidate.root]),
      [
        ["g", "global", g],
        ["p", "project", p],
        ["pp", "project", viaRoot],
      ],
    );
    assert.equal(candidateOf(inventory, "g").configFile, fixture.globalConf);
    assert.equal(candidateOf(inventory, "pp").configFile, fixture.projectConf);
  });
});

test("inventory: unknown manifest and author keys, and a context skip, are the candidate's diagnostics", () => {
  withFixture((fixture) => {
    const dir = pluginDir(fixture.projectLayer, "plugins/noisy", {
      name: "noisy",
      extra: 1,
      author: { name: "Ada", role: "dev" },
    });
    writeFileSync(join(dir, "context.md"), "  \n\t\n");
    writeConf(fixture.projectConf, { plugins: { noisy: { path: "plugins/noisy" } } });
    const candidate = candidateOf(readPluginInventory(fixture.project), "noisy");
    assert.equal(candidate.skip, null);
    assert.deepEqual(candidate.diagnostics, [
      `plugins: ${join(dir, "plugin.json")}: unknown manifest keys extra ignored`,
      `plugins: ${join(dir, "plugin.json")}: unknown author keys role ignored`,
      `plugins: ${join(dir, "context.md")}: context skipped (empty)`,
    ]);
    assert.equal(must(candidate.plugin).context, false);
    assert.deepEqual(must(candidate.plugin).author, { name: "Ada", email: null });
  });
});

test("inventory: the script walk lists matching files and reports the directories it leaves out", () => {
  withFixture((fixture) => {
    const dir = pluginDir(fixture.projectLayer, "plugins/walk", { name: "walk" });
    const scripts = join(dir, "scripts");
    mkdirSync(join(scripts, "deep", "node_modules"), { recursive: true });
    writeFileSync(join(scripts, "run.js"), "export default 1;\n");
    writeFileSync(join(scripts, "deep", "nested.ts"), "export default 2;\n");
    writeFileSync(join(scripts, "deep", "node_modules", "dep.js"), "export default 3;\n");
    writeFileSync(join(scripts, "README.md"), "not a script\n");
    writeFileSync(join(fixture.root, "outside.js"), "outside the plugin root\n");
    symlinkSync(join(fixture.root, "outside.js"), join(scripts, "outside.js"));
    symlinkSync(join(scripts, "run.js"), join(scripts, "inside.js"));
    symlinkSync(fixture.project, join(scripts, "linked-dir"));
    writeConf(fixture.projectConf, { plugins: { walk: { path: "plugins/walk" } } });
    const candidate = candidateOf(readPluginInventory(fixture.project), "walk");
    assert.deepEqual(must(candidate.plugin).scripts, [
      { name: "scripts/deep/nested.ts", description: null, file: "scripts/deep/nested.ts" },
      { name: "scripts/inside.js", description: null, file: "scripts/inside.js" },
      { name: "scripts/run.js", description: null, file: "scripts/run.js" },
    ]);
    assert.deepEqual(candidate.diagnostics, [
      `scripts: ${scripts}: 2 directories not listed (node_modules and links)`,
    ]);
  });
});

test("inventory: one left-out directory is reported in the singular", () => {
  withFixture((fixture) => {
    const dir = pluginDir(fixture.projectLayer, "plugins/one", { name: "one" });
    mkdirSync(join(dir, "scripts", "node_modules"), { recursive: true });
    writeFileSync(join(dir, "scripts", "node_modules", "dep.js"), "export default 1;\n");
    writeConf(fixture.projectConf, { plugins: { one: { path: "plugins/one" } } });
    const candidate = candidateOf(readPluginInventory(fixture.project), "one");
    assert.deepEqual(must(candidate.plugin).scripts, []);
    assert.deepEqual(candidate.diagnostics, [
      `scripts: ${join(dir, "scripts")}: 1 directory not listed (node_modules and links)`,
    ]);
  });
});

test(
  "inventory: an unreadable directory of the walk reports and the walk continues",
  {
    skip:
      typeof process.getuid === "function" && process.getuid() === 0
        ? "root reads any directory"
        : false,
  },
  () => {
    withFixture((fixture) => {
      const dir = pluginDir(fixture.projectLayer, "plugins/locked", { name: "locked" });
      const scripts = join(dir, "scripts");
      const locked = join(scripts, "locked");
      mkdirSync(locked, { recursive: true });
      mkdirSync(join(scripts, "node_modules"), { recursive: true });
      writeFileSync(join(locked, "x.js"), "export default 1;\n");
      writeFileSync(join(scripts, "node_modules", "dep.js"), "export default 2;\n");
      writeFileSync(join(scripts, "run.js"), "export default 3;\n");
      writeConf(fixture.projectConf, { plugins: { locked: { path: "plugins/locked" } } });
      chmodSync(locked, 0o000);
      let candidate: InventoryCandidate;
      try {
        candidate = candidateOf(readPluginInventory(fixture.project), "locked");
      } finally {
        chmodSync(locked, 0o755);
      }
      assert.deepEqual(must(candidate.plugin).scripts, [
        { name: "scripts/run.js", description: null, file: "scripts/run.js" },
      ]);
      assert.deepEqual(candidate.diagnostics, [
        `scripts: ${locked}: unreadable: EACCES`,
        `scripts: ${scripts}: 1 directory not listed (node_modules and links)`,
      ]);
    });
  },
);

test("inventory: a missing scripts folder adds nothing", () => {
  withFixture((fixture) => {
    const dir = pluginDir(fixture.projectLayer, "plugins/plain", { name: "plain" });
    writeFileSync(join(dir, "scripts"), "a file named scripts\n");
    writeConf(fixture.projectConf, { plugins: { plain: { path: "plugins/plain" } } });
    const candidate = candidateOf(readPluginInventory(fixture.project), "plain");
    assert.deepEqual(must(candidate.plugin).scripts, []);
    assert.deepEqual(candidate.diagnostics, []);
  });
});

test("inventory: a dangling link under scripts is not listed", () => {
  withFixture((fixture) => {
    const dir = pluginDir(fixture.projectLayer, "plugins/dangling", { name: "dangling" });
    const scripts = join(dir, "scripts");
    mkdirSync(scripts);
    writeFileSync(join(scripts, "run.js"), "export default 1;\n");
    symlinkSync(join(scripts, "missing.js"), join(scripts, "dangling.js"));
    writeConf(fixture.projectConf, { plugins: { dangling: { path: "plugins/dangling" } } });
    const candidate = candidateOf(readPluginInventory(fixture.project), "dangling");
    assert.deepEqual(must(candidate.plugin).scripts, [
      { name: "scripts/run.js", description: null, file: "scripts/run.js" },
    ]);
    assert.deepEqual(candidate.diagnostics, []);
  });
});

test("inventory: a scripts folder that is a symbolic link to a directory is walked", () => {
  withFixture((fixture) => {
    const dir = pluginDir(fixture.projectLayer, "plugins/linked", { name: "linked" });
    const real = join(dir, "real-scripts");
    mkdirSync(join(real, "deep"), { recursive: true });
    writeFileSync(join(real, "run.js"), "export default 1;\n");
    writeFileSync(join(real, "deep", "nested.ts"), "export default 2;\n");
    symlinkSync(real, join(dir, "scripts"));
    writeConf(fixture.projectConf, { plugins: { linked: { path: "plugins/linked" } } });
    const candidate = candidateOf(readPluginInventory(fixture.project), "linked");
    assert.deepEqual(must(candidate.plugin).scripts, [
      { name: "scripts/deep/nested.ts", description: null, file: "scripts/deep/nested.ts" },
      { name: "scripts/run.js", description: null, file: "scripts/run.js" },
    ]);
    assert.deepEqual(candidate.diagnostics, []);
  });
});

test(
  "inventory: a script file named with a backslash is not listed",
  { skip: process.platform === "win32" ? "Windows forbids a `\\` in a file name" : false },
  () => {
    withFixture((fixture) => {
      const dir = pluginDir(fixture.projectLayer, "plugins/backslash", { name: "backslash" });
      const scripts = join(dir, "scripts");
      mkdirSync(scripts);
      writeFileSync(join(scripts, "x\\y.js"), "export default 1;\n");
      writeFileSync(join(scripts, "run.js"), "export default 2;\n");
      writeConf(fixture.projectConf, { plugins: { backslash: { path: "plugins/backslash" } } });
      const candidate = candidateOf(readPluginInventory(fixture.project), "backslash");
      assert.deepEqual(must(candidate.plugin).scripts, [
        { name: "scripts/run.js", description: null, file: "scripts/run.js" },
      ]);
      assert.deepEqual(candidate.diagnostics, []);
    });
  },
);

test("inventory: a non-absolute or non-string cwd throws the specified message", () => {
  assert.throws(() => readPluginInventory("relative/path"), {
    message: "readPluginInventory: cwd must be an absolute path",
  });
  assert.throws(() => readPluginInventory(""), {
    message: "readPluginInventory: cwd must be an absolute path",
  });
  assert.throws(() => readPluginInventory(undefined as unknown as string), {
    message: "readPluginInventory: cwd must be an absolute path",
  });
});

test("inventory: every call reads anew and changes nothing on disk", () => {
  withFixture((fixture) => {
    const dir = pluginDir(fixture.projectLayer, "plugins/live", { name: "one" });
    writeConf(fixture.projectConf, { plugins: { live: { path: "plugins/live" } } });
    assert.equal(
      must(candidateOf(readPluginInventory(fixture.project), "live").plugin).namespace,
      "one",
    );
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "two" }));
    assert.equal(
      must(candidateOf(readPluginInventory(fixture.project), "live").plugin).namespace,
      "two",
    );
    // No layer file or plugin file appeared or changed: the call only read.
    assert.deepEqual(readdirSync(fixture.projectLayer).toSorted(), ["pi-dent.conf", "plugins"]);
    assert.equal(readFileSync(join(dir, "plugin.json"), "utf8"), JSON.stringify({ name: "two" }));
  });
});

test("inventory: when both layers share one file, a candidate's layer is project", () => {
  withFixture((fixture) => {
    // cwd is the fixture home, so the project layer file is the global layer file.
    pluginDir(fixture.globalLayer, "plugins/home", { name: "home" });
    writeConf(fixture.globalConf, { plugins: { home: { path: "plugins/home" } } });
    const inventory = readPluginInventory(fixture.home);
    assert.deepEqual(
      inventory.layers.map((layer) => [layer.layer, layer.file, layer.state]),
      [
        ["global", fixture.globalConf, "read"],
        ["project", fixture.globalConf, "read"],
      ],
    );
    assert.equal(candidateOf(inventory, "home").layer, "project");
    assert.equal(candidateOf(inventory, "home").configFile, fixture.globalConf);
  });
});

test("inventory: agreement with boot for the same cwd", () => {
  withFixture((fixture) => {
    // Global layer: an unknown root key (a layer diagnostic in both views) and one plugin
    // with an unknown manifest key, a command with an unknown frontmatter key, a context,
    // an agent, and a skill.
    writeConf(fixture.globalConf, { bogus: 1, plugins: { g: { path: "plugins/g" } } });
    const g = pluginDir(fixture.globalLayer, "plugins/g", { name: "g", extra: 1 });
    mkdirSync(join(g, "commands"));
    mkdirSync(join(g, "agents"));
    mkdirSync(join(g, "skills", "s"), { recursive: true });
    writeFileSync(join(g, "context.md"), "G context");
    writeFileSync(join(g, "commands", "hi.md"), "---\ndescription: Hi\nfuture: 1\n---\nHi\n");
    writeFileSync(join(g, "agents", "a.md"), "---\nname: a\ndescription: A\n---\nYou are a.\n");
    writeFileSync(join(g, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: S\n---\nBe s.\n");
    // Project layer: one plugin with agents (a duplicate agent name), a skill, and a
    // scripts tree (inventory-only diagnostics); a duplicate-namespace candidate; a
    // malformed entry.
    writeConf(fixture.projectConf, {
      plugins: {
        p: { path: "plugins/p" },
        "g-again": { path: "plugins/g" },
        broken: "nope",
      },
    });
    const p = pluginDir(fixture.projectLayer, "plugins/p", { name: "p" });
    mkdirSync(join(p, "agents"));
    mkdirSync(join(p, "skills", "t"), { recursive: true });
    mkdirSync(join(p, "scripts", "node_modules"), { recursive: true });
    writeFileSync(join(p, "agents", "x.md"), "---\nname: same\ndescription: X\n---\nYou are x.\n");
    writeFileSync(join(p, "agents", "y.md"), "---\nname: same\ndescription: Y\n---\nYou are y.\n");
    writeFileSync(join(p, "skills", "t", "SKILL.md"), "---\nname: t\ndescription: T\n---\nBe t.\n");
    writeFileSync(join(p, "scripts", "run.js"), "export default 1;\n");
    writeFileSync(join(p, "scripts", "node_modules", "dep.js"), "export default 2;\n");

    const snapshot = readBootSnapshot(fixture.project);
    const inventory = readPluginInventory(fixture.project);

    // Admitted namespaces and order equal boot's.
    assert.deepEqual(
      inventory.candidates
        .filter((candidate) => candidate.plugin !== null)
        .map((candidate) => must(candidate.plugin).namespace),
      snapshot.plugins.map((plugin) => plugin.name),
    );

    // Commands, contexts, agents, and skills equal boot's, per admitted plugin.
    for (const candidate of inventory.candidates) {
      const plugin = candidate.plugin;
      if (plugin === null) continue;
      const entry = must(snapshot.plugins.find((boot) => boot.name === plugin.namespace));
      assert.equal(candidate.root, entry.root, plugin.namespace);
      assert.equal(candidate.skip, null, plugin.namespace);
      assert.equal(plugin.context, entry.context !== undefined, plugin.namespace);
      assert.deepEqual(
        plugin.commands.map((command) => [command.name, command.description]),
        entry.commands.map((command) => [command.name, command.description ?? null]),
        plugin.namespace,
      );
      assert.deepEqual(
        plugin.agents.map((agent) => `${plugin.namespace}:${agent.name}`),
        snapshot.agents
          .filter((agent) => agent.name.startsWith(`${plugin.namespace}:`))
          .map((agent) => agent.name),
        plugin.namespace,
      );
      assert.deepEqual(
        plugin.skills.map((skill) => `${plugin.namespace}:${skill.name}`),
        snapshot.skills
          .filter((skill) => skill.name.startsWith(`${plugin.namespace}:`))
          .map((skill) => skill.name),
        plugin.namespace,
      );
    }

    // Every boot diagnostic the spec assigns appears exactly once, with the same text,
    // and the inventory holds no other (the fixture makes every boot diagnostic an
    // assigned one; specs/plugin.md#script-listing's are the inventory's alone).
    const bootMessages = snapshot.diagnostics.map((diagnostic) => diagnostic.message);
    const inventoryMessages = [
      ...inventory.diagnostics,
      ...inventory.candidates.flatMap((candidate) => candidate.diagnostics),
    ].filter((message) => !message.startsWith("scripts: "));
    assert.equal(
      inventoryMessages.length,
      bootMessages.length,
      `inventory: ${JSON.stringify(inventoryMessages)}\nboot: ${JSON.stringify(bootMessages)}`,
    );
    for (const message of new Set(bootMessages)) {
      assert.equal(
        inventoryMessages.filter((candidate) => candidate === message).length,
        bootMessages.filter((boot) => boot === message).length,
        message,
      );
    }
  });
});
