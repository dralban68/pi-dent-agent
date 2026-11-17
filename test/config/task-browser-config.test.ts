import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_TASK_BROWSER_SHORTCUT,
  parseTaskBrowser,
  readConfig,
  SUPPORTED_ROOT_KEYS,
} from "../../lib/config.ts";

/**
 * `taskBrowser` configuration per specs/task-browser.md Section 1.1 and
 * specs/config-file.md Section 2: the default shortcut, validation, and the
 * supported root key.
 */

const tempBase = () => tmpdir();

function withIsolatedEnv<T>(fn: (ctx: { home: string; project: string }) => T): T {
  const home = mkdtempSync(join(tempBase(), "pi-dent-test-home-"));
  const project = mkdtempSync(join(tempBase(), "pi-dent-test-project-"));
  const origHome = process.env.HOME;
  const origIdle = process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS;
  const origAbs = process.env.PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS;

  process.env.HOME = home;
  delete process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS;
  delete process.env.PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS;

  try {
    return fn({ home, project });
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;

    if (origIdle === undefined) delete process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS;
    else process.env.PI_DENT_AGENT_IDLE_TIMEOUT_MS = origIdle;

    if (origAbs === undefined) delete process.env.PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS;
    else process.env.PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS = origAbs;

    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

function writeConf(root: string, content: string): string {
  const dir = join(root, ".pi", "pi-dent");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "pi-dent.conf");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("no taskBrowser config → default shortcut and no diagnostics", () => {
  withIsolatedEnv(({ project }) => {
    const parsed = parseTaskBrowser(readConfig(project));
    assert.equal(parsed.shortcut, "shift+right");
    assert.equal(DEFAULT_TASK_BROWSER_SHORTCUT, "shift+right");
    assert.deepEqual(parsed.diagnostics, []);
  });
});

test("a valid taskBrowser.shortcut is used", () => {
  withIsolatedEnv(({ project }) => {
    for (const value of ["ctrl+t", "pageUp", "f12", "+", "ctrl+shift+p", "super+alt+x", "escape"]) {
      writeConf(project, JSON.stringify({ taskBrowser: { shortcut: value } }));
      const parsed = parseTaskBrowser(readConfig(project));
      assert.equal(parsed.shortcut, value);
      assert.deepEqual(parsed.diagnostics, [], value);
    }
  });
});

test("a non-object taskBrowser produces one diagnostic and the default", () => {
  withIsolatedEnv(({ project }) => {
    const projectFile = writeConf(project, JSON.stringify({ taskBrowser: "alt+t" }));
    const parsed = parseTaskBrowser(readConfig(project));
    assert.equal(parsed.shortcut, "shift+right");
    assert.deepEqual(parsed.diagnostics, [
      `config: ${projectFile}: taskBrowser must be an object; ignored`,
    ]);
  });
});

test("a non-string or empty shortcut produces one diagnostic and the default", () => {
  withIsolatedEnv(({ project }) => {
    for (const value of [7, true, null, "", ["ctrl+t"]]) {
      const projectFile = writeConf(project, JSON.stringify({ taskBrowser: { shortcut: value } }));
      const parsed = parseTaskBrowser(readConfig(project));
      assert.equal(parsed.shortcut, "shift+right", JSON.stringify(value));
      assert.deepEqual(
        parsed.diagnostics,
        [`config: ${projectFile}: taskBrowser.shortcut must be a non-empty string; ignored`],
        JSON.stringify(value),
      );
    }
  });
});

test("a shortcut that is not a host key identifier produces one diagnostic naming its file and the default", () => {
  withIsolatedEnv(({ project }) => {
    for (const value of ["shift+rigth", "banana", "pageup", "ctrl+ctrl+t", "ctrl", "shift+"]) {
      const projectFile = writeConf(project, JSON.stringify({ taskBrowser: { shortcut: value } }));
      const parsed = parseTaskBrowser(readConfig(project));
      assert.equal(parsed.shortcut, "shift+right", JSON.stringify(value));
      assert.deepEqual(
        parsed.diagnostics,
        [`config: ${projectFile}: taskBrowser.shortcut must be a host key identifier; ignored`],
        JSON.stringify(value),
      );
    }
  });
});

test("unknown taskBrowser keys produce exactly one diagnostic naming all of them; the known key loads", () => {
  withIsolatedEnv(({ project }) => {
    const projectFile = writeConf(
      project,
      JSON.stringify({ taskBrowser: { shortcut: "ctrl+x", width: 80, height: 24 } }),
    );
    const parsed = parseTaskBrowser(readConfig(project));
    assert.equal(parsed.shortcut, "ctrl+x");
    assert.deepEqual(parsed.diagnostics, [
      `config: ${projectFile}: taskBrowser: unknown keys width, height ignored`,
    ]);
  });
});

test("unknown taskBrowser keys declared by different layers each name their own file", () => {
  withIsolatedEnv(({ home, project }) => {
    const globalFile = writeConf(home, JSON.stringify({ taskBrowser: { width: 80 } }));
    const projectFile = writeConf(
      project,
      JSON.stringify({ taskBrowser: { shortcut: "ctrl+x", height: 24 } }),
    );
    const parsed = parseTaskBrowser(readConfig(project));
    assert.equal(parsed.shortcut, "ctrl+x");
    assert.deepEqual(parsed.diagnostics, [
      `config: taskBrowser: unknown keys width (${globalFile}), height (${projectFile}) ignored`,
    ]);
  });
});

test("taskBrowser is a supported root key, not an unknown one", () => {
  assert.ok(SUPPORTED_ROOT_KEYS.includes("taskBrowser"));
  withIsolatedEnv(({ project }) => {
    writeConf(project, JSON.stringify({ taskBrowser: { shortcut: "alt+b" } }));
    const config = readConfig(project);
    assert.deepEqual(config.diagnostics, []);
    assert.deepEqual(config.merged.taskBrowser, { shortcut: "alt+b" });
  });
});
