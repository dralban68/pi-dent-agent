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
 * Plugin commands per specs/plugin.md Section 5: command frontmatter that is not a mapping
 * reports one warning and still registers the command, without a description. The mapping rule
 * itself is owned by specs/skill.md Section 1.
 */

function pluginFixture(): { root: string; home: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-command-frontmatter-"));
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

test("command frontmatter that is not an object reports one warning and registers the command", () => {
  const fixture = pluginFixture();
  try {
    const pluginRoot = join(fixture.home, "under");
    mkdirSync(join(pluginRoot, "commands"), { recursive: true });
    writeFileSync(join(pluginRoot, "plugin.json"), JSON.stringify({ name: "under" }));
    writeFileSync(join(pluginRoot, "commands", "hello.md"), "---\nhello\n---\nRun it.\n");

    const result = discoverFrom(fixture, pluginRoot);
    assert.equal(at(at(result.plugins, 0).commands, 0).name, "hello");
    assert.equal(
      at(at(result.plugins, 0).commands, 0).description,
      undefined,
      "a non-mapping frontmatter yields no description",
    );
    assert.equal(result.diagnostics.length, 1);
    assert.match(at(result.diagnostics, 0).message, /must be a mapping/u);
    assert.equal(at(result.diagnostics, 0).message.includes("0, 1, 2"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
