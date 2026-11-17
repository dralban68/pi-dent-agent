import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlugins, type PluginEntry } from "../../lib/plugins.ts";
import type { BootConfig } from "../../lib/config.ts";
import type { Diagnostic } from "../../lib/util.ts";
import { at } from "../support/must.ts";

/**
 * The plugin manifest per specs/plugin.md Section 2: an unknown key inside `author` follows the
 * unknown-key rule, while an `author` string or an object with the keys Section 2 defines is
 * accepted without a diagnostic.
 */

function pluginFixture(): { root: string; home: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-manifest-author-"));
  const home = join(root, "home", ".pi", "pi-dent");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(project, ".pi", "pi-dent"), { recursive: true });
  return { root, home, project };
}

function discoverFrom(
  fixture: { home: string; project: string },
  pluginRoot: string,
): { plugins: PluginEntry[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const catalog = discoverPlugins(
    {
      merged: { plugins: { under: { path: pluginRoot } } },
      layers: {
        project: undefined,
        global: {
          path: join(fixture.home, "pi-dent.conf"),
          values: { plugins: { under: { path: pluginRoot } } },
        },
      },
      projectRoot: fixture.project,
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    } as unknown as BootConfig,
    diagnostics,
  );
  return { plugins: catalog.plugins, diagnostics };
}

test("an unknown author key produces one diagnostic and the plugin is admitted", () => {
  const fixture = pluginFixture();
  try {
    const pluginRoot = join(fixture.home, "under");
    mkdirSync(join(pluginRoot, "commands"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "under", author: { name: "Ada", email: "a@x", role: "dev" } }),
    );
    const result = discoverFrom(fixture, pluginRoot);
    assert.equal(result.plugins.length, 1, "the plugin is admitted");
    assert.equal(result.diagnostics.length, 1);
    assert.match(at(result.diagnostics, 0).message, /unknown author keys role ignored/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an author string and an author object with known keys produce no diagnostic", () => {
  const fixture = pluginFixture();
  try {
    const pluginRoot = join(fixture.home, "under");
    mkdirSync(join(pluginRoot, "commands"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "under", author: { name: "Ada", email: "a@x" } }),
    );
    assert.deepEqual(discoverFrom(fixture, pluginRoot).diagnostics, []);

    writeFileSync(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "under", author: "Ada" }),
    );
    assert.deepEqual(discoverFrom(fixture, pluginRoot).diagnostics, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
