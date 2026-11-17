import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PluginCatalog, appendPluginContext, discoverPlugins } from "../../lib/plugins.ts";
import type { BootConfig } from "../../lib/config.ts";
import type { Diagnostic } from "../../lib/util.ts";
import { at } from "../support/must.ts";

/**
 * Plugin context per specs/plugin.md Section 10: the root `context.md` read into
 * the boot snapshot for admitted plugins, its skip rules, admission order, and
 * the rendered block format.
 */

interface Fixture {
  root: string;
  project: string;
  projectConf: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-context-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".pi", "pi-dent"), { recursive: true });
  return { root, project, projectConf: join(project, ".pi", "pi-dent", "pi-dent.conf") };
}

function pluginDir(base: string, dir: string, namespace = dir): string {
  const path = join(base, dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "plugin.json"), JSON.stringify({ name: namespace }));
  return path;
}

function makeConfig(fixture: Fixture, plugins: Record<string, { path: string }>): BootConfig {
  return {
    merged: { plugins },
    layers: { project: { path: fixture.projectConf, values: { plugins } } },
    projectRoot: fixture.project,
    diagnostics: [],
    liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
  } as unknown as BootConfig;
}

function discover(
  fixture: Fixture,
  plugins: Record<string, { path: string }>,
): { catalog: PluginCatalog; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const catalog = discoverPlugins(makeConfig(fixture, plugins), diagnostics);
  return { catalog, diagnostics };
}

function contextOf(catalog: PluginCatalog, namespace: string): string | undefined {
  return catalog.byNamespace.get(namespace)?.context;
}

test("context: absent context.md yields no context and no diagnostic", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.root, "a");
    const { catalog, diagnostics } = discover(fixture, { a: { path: dir } });
    assert.equal(at(catalog.plugins, 0).context, undefined);
    assert.deepEqual(diagnostics, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("context: text is read with BOM removed, CRLF normalized, and surrounding whitespace trimmed", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.root, "a");
    writeFileSync(join(dir, "context.md"), "\uFEFF\n  Line one\r\nLine two\r\n\n");
    const { catalog, diagnostics } = discover(fixture, { a: { path: dir } });
    assert.equal(contextOf(catalog, "a"), "Line one\nLine two");
    assert.deepEqual(diagnostics, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("context: empty and whitespace-only files yield no context and one diagnostic naming the file", () => {
  const fixture = makeFixture();
  try {
    const empty = pluginDir(fixture.root, "empty");
    const blank = pluginDir(fixture.root, "blank");
    writeFileSync(join(empty, "context.md"), "");
    writeFileSync(join(blank, "context.md"), " \n\t\n");
    const { catalog, diagnostics } = discover(fixture, {
      a: { path: empty },
      b: { path: blank },
    });
    assert.equal(contextOf(catalog, "empty"), undefined);
    assert.equal(contextOf(catalog, "blank"), undefined);
    assert.equal(diagnostics.length, 2);
    assert.ok(diagnostics[0]?.message.includes(join(empty, "context.md")));
    assert.ok(diagnostics[1]?.message.includes(join(blank, "context.md")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("context: non-UTF-8 bytes yield no context and one diagnostic naming the file", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.root, "a");
    writeFileSync(join(dir, "context.md"), Buffer.from([0x66, 0x6f, 0x6f, 0xff, 0xfe]));
    const { catalog, diagnostics } = discover(fixture, { a: { path: dir } });
    assert.equal(contextOf(catalog, "a"), undefined);
    assert.equal(diagnostics.length, 1);
    assert.ok(diagnostics[0]?.message.includes(join(dir, "context.md")));
    assert.ok(diagnostics[0]?.message.includes("UTF-8"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("context: a directory named context.md is skipped with one diagnostic", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.root, "a");
    mkdirSync(join(dir, "context.md"));
    const { catalog, diagnostics } = discover(fixture, { a: { path: dir } });
    assert.equal(contextOf(catalog, "a"), undefined);
    assert.equal(diagnostics.length, 1);
    assert.ok(diagnostics[0]?.message.includes(join(dir, "context.md")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("context: a symbolic link escaping the plugin root is skipped with one diagnostic", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.root, "a");
    const outside = join(fixture.root, "outside.md");
    writeFileSync(outside, "outside text");
    symlinkSync(outside, join(dir, "context.md"));
    const { catalog, diagnostics } = discover(fixture, { a: { path: dir } });
    assert.equal(contextOf(catalog, "a"), undefined);
    assert.equal(diagnostics.length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("context: a dangling symbolic link into the plugin root is ignored silently", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.root, "a");
    symlinkSync("missing.md", join(dir, "context.md"));
    const { catalog, diagnostics } = discover(fixture, { a: { path: dir } });
    assert.equal(contextOf(catalog, "a"), undefined);
    assert.deepEqual(diagnostics, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("context: a dangling symbolic link whose target is outside the plugin root is skipped with one diagnostic", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.root, "a");
    symlinkSync(join(fixture.root, "missing.md"), join(dir, "context.md"));
    const { catalog, diagnostics } = discover(fixture, { a: { path: dir } });
    assert.equal(contextOf(catalog, "a"), undefined);
    assert.equal(diagnostics.length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("context: a dangling link that reaches outside through a directory link is skipped with one diagnostic", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.root, "a");
    const outside = join(fixture.root, "outside");
    mkdirSync(outside);
    mkdirSync(join(dir, "inside"));
    // The link's text stays under the root; only the directory link leaves it.
    symlinkSync(outside, join(dir, "inside", "sub"));
    symlinkSync("inside/sub/missing.md", join(dir, "context.md"));
    const { catalog, diagnostics } = discover(fixture, { a: { path: dir } });
    assert.equal(contextOf(catalog, "a"), undefined);
    assert.equal(diagnostics.length, 1, `one diagnostic: ${JSON.stringify(diagnostics)}`);
    assert.ok(at(diagnostics, 0).message.includes(join(dir, "context.md")), "names the file");
    assert.match(at(diagnostics, 0).message, /context skipped \(path escapes its root/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("context: a symbolic link to a file inside the plugin root is read", () => {
  const fixture = makeFixture();
  try {
    const dir = pluginDir(fixture.root, "a");
    writeFileSync(join(dir, "real.md"), "linked text");
    symlinkSync(join(dir, "real.md"), join(dir, "context.md"));
    const { catalog, diagnostics } = discover(fixture, { a: { path: dir } });
    assert.equal(contextOf(catalog, "a"), "linked text");
    assert.deepEqual(diagnostics, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("context: a skipped plugin candidate is not read (its context.md is never reported)", () => {
  const fixture = makeFixture();
  try {
    const first = pluginDir(fixture.root, "first", "shared");
    const second = pluginDir(fixture.root, "second", "shared");
    writeFileSync(join(first, "context.md"), "first");
    writeFileSync(join(second, "context.md"), "");
    const badManifest = join(fixture.root, "bad");
    mkdirSync(badManifest);
    writeFileSync(join(badManifest, "plugin.json"), "{ not json");
    writeFileSync(join(badManifest, "context.md"), "");
    const { catalog, diagnostics } = discover(fixture, {
      a: { path: first },
      b: { path: second },
      c: { path: badManifest },
    });
    assert.equal(catalog.plugins.length, 1);
    assert.equal(contextOf(catalog, "shared"), "first");
    assert.equal(
      diagnostics.some((d) => d.message.includes("context.md")),
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("context: appendPluginContext renders one block per plugin with a context, in admission order", () => {
  const fixture = makeFixture();
  try {
    const alpha = pluginDir(fixture.root, "alpha");
    const beta = pluginDir(fixture.root, "beta");
    const gamma = pluginDir(fixture.root, "gamma");
    writeFileSync(join(alpha, "context.md"), "Alpha rules.");
    writeFileSync(join(gamma, "context.md"), "Gamma rules.");
    // Admission follows the lexicographic key order; beta has no context.md.
    const { catalog, diagnostics } = discover(fixture, {
      "a-key": { path: alpha },
      "b-key": { path: beta },
      "c-key": { path: gamma },
    });
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      catalog.plugins.map((plugin) => plugin.name),
      ["alpha", "beta", "gamma"],
    );
    assert.equal(
      appendPluginContext("Base", catalog.plugins),
      'Base\n\n<plugin_context plugin="alpha">\nAlpha rules.\n</plugin_context>\n\n<plugin_context plugin="gamma">\nGamma rules.\n</plugin_context>',
    );
    assert.equal(appendPluginContext("Base", []), "Base");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
