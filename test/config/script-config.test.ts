import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseScript, readConfig } from "../../lib/config.ts";

/**
 * `script` configuration per specs/script-tool.md#configuration: the allow lists, the diagnostics
 * of a wrong-typed value, unknown keys, and the merge that replaces arrays whole.
 */

function withIsolatedEnv<T>(fn: (ctx: { home: string; project: string }) => T): T {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-test-home-"));
  const project = mkdtempSync(join(tmpdir(), "pi-dent-test-project-"));
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn({ home, project });
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

function writeConf(root: string, value: unknown): string {
  const dir = join(root, ".pi", "pi-dent");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "pi-dent.conf");
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

test("script config: absent keys give no allow lists and no diagnostics", () => {
  withIsolatedEnv(({ project }) => {
    const config = readConfig(project);
    assert.deepEqual(parseScript(config), {
      networkAllow: undefined,
      toolsAllow: undefined,
      diagnostics: [],
    });
    assert.deepEqual(config.diagnostics, []);
  });
});

test("script config: allow lists are read, and a higher layer replaces a lower list whole", () => {
  withIsolatedEnv(({ home, project }) => {
    writeConf(home, {
      script: { tools: { allow: ["Bash", "read"] }, network: { allow: ["a.com"] } },
    });
    writeConf(project, { script: { tools: { allow: ["mcp__*"] } } });
    assert.deepEqual(parseScript(readConfig(project)), {
      networkAllow: ["a.com"],
      toolsAllow: ["mcp__*"],
      diagnostics: [],
    });
  });
});

test("script config: wrong-typed values give one diagnostic each, naming the layer file", () => {
  withIsolatedEnv(({ project }) => {
    const file = writeConf(project, { script: "x" });
    assert.deepEqual(parseScript(readConfig(project)).diagnostics, [
      `config: ${file}: script must be an object; ignored`,
    ]);
    writeConf(project, { script: { tools: [], network: 1 } });
    assert.deepEqual(parseScript(readConfig(project)).diagnostics, [
      `config: ${file}: script.network must be an object; ignored`,
      `config: ${file}: script.tools must be an object; ignored`,
    ]);
    writeConf(project, { script: { tools: { allow: ["a", 1] }, network: { allow: "*" } } });
    const parsed = parseScript(readConfig(project));
    assert.deepEqual(parsed, {
      networkAllow: undefined,
      toolsAllow: undefined,
      diagnostics: [
        `config: ${file}: script.network.allow must be an array of strings; ignored`,
        `config: ${file}: script.tools.allow must be an array of strings; ignored`,
      ],
    });
  });
});

test("script config: unknown keys give one diagnostic per object", () => {
  withIsolatedEnv(({ project }) => {
    const file = writeConf(project, { script: { tools: { allow: [], deny: [] }, fs: {} } });
    const parsed = parseScript(readConfig(project));
    assert.deepEqual(parsed.toolsAllow, []);
    assert.deepEqual(parsed.diagnostics, [
      `config: ${file}: script: unknown keys fs ignored`,
      `config: ${file}: script.tools: unknown keys deny ignored`,
    ]);
    // `script` is a supported root key.
    assert.deepEqual(readConfig(project).diagnostics, []);
  });
});
