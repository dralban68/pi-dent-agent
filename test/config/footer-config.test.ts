import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseFooter, readConfig, SUPPORTED_ROOT_KEYS } from "../../lib/config.ts";

/**
 * `footer` configuration per specs/footer.md Section 1.1 and specs/config-file.md Section 2: the
 * `enabled` default, the diagnostics of a value that is not an object or not a boolean, the
 * unknown keys of the object, and the supported root key.
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

test("no footer config → enabled and no diagnostics", () => {
  withIsolatedEnv(({ project }) => {
    assert.deepEqual(parseFooter(readConfig(project)), { enabled: true, diagnostics: [] });
  });
});

test("footer.enabled is used when it is a boolean", () => {
  withIsolatedEnv(({ project }) => {
    writeConf(project, JSON.stringify({ footer: { enabled: false } }));
    assert.deepEqual(parseFooter(readConfig(project)), { enabled: false, diagnostics: [] });
    writeConf(project, JSON.stringify({ footer: { enabled: true } }));
    assert.deepEqual(parseFooter(readConfig(project)), { enabled: true, diagnostics: [] });
    writeConf(project, JSON.stringify({ footer: {} }));
    assert.deepEqual(parseFooter(readConfig(project)), { enabled: true, diagnostics: [] });
  });
});

test("a footer that is not an object produces one diagnostic naming its file and the default", () => {
  withIsolatedEnv(({ project }) => {
    for (const value of ["false", 7, true, null, ["enabled"]]) {
      const projectFile = writeConf(project, JSON.stringify({ footer: value }));
      assert.deepEqual(parseFooter(readConfig(project)), {
        enabled: true,
        diagnostics: [`config: ${projectFile}: footer must be an object; ignored`],
      });
    }
  });
});

test("a footer.enabled that is not a boolean produces one diagnostic naming its file and the default", () => {
  withIsolatedEnv(({ project }) => {
    for (const value of ["false", 0, 1, null, {}, []]) {
      const projectFile = writeConf(project, JSON.stringify({ footer: { enabled: value } }));
      assert.deepEqual(
        parseFooter(readConfig(project)),
        {
          enabled: true,
          diagnostics: [`config: ${projectFile}: footer.enabled must be a boolean; ignored`],
        },
        JSON.stringify(value),
      );
    }
  });
});

test("unknown footer keys produce exactly one diagnostic naming all of them; enabled still loads", () => {
  withIsolatedEnv(({ project }) => {
    const projectFile = writeConf(
      project,
      JSON.stringify({ footer: { enabled: false, height: 3, theme: "dim" } }),
    );
    assert.deepEqual(parseFooter(readConfig(project)), {
      enabled: false,
      diagnostics: [`config: ${projectFile}: footer: unknown keys height, theme ignored`],
    });
  });
});

test("unknown footer keys declared by different layers each name their own file", () => {
  withIsolatedEnv(({ home, project }) => {
    const globalFile = writeConf(home, JSON.stringify({ footer: { height: 3 } }));
    const projectFile = writeConf(project, JSON.stringify({ footer: { theme: "dim" } }));
    assert.deepEqual(parseFooter(readConfig(project)), {
      enabled: true,
      diagnostics: [
        `config: footer: unknown keys height (${globalFile}), theme (${projectFile}) ignored`,
      ],
    });
  });
});

test("footer is a supported root key, not an unknown one", () => {
  assert.ok(SUPPORTED_ROOT_KEYS.includes("footer"));
  withIsolatedEnv(({ project }) => {
    writeConf(project, JSON.stringify({ footer: { enabled: false } }));
    const config = readConfig(project);
    assert.deepEqual(config.diagnostics, []);
    assert.deepEqual(config.merged.footer, { enabled: false });
  });
});
