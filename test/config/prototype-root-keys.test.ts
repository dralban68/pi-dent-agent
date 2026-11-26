import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelClassDiagnostics } from "../../lib/model-string.ts";
import { readConfig } from "../../lib/config.ts";
import { at } from "../support/must.ts";

/**
 * Configuration loading per specs/config-file.md#format and specs/config-file.md#merge: a `__proto__` key in a
 * configuration file stays an own key of the parsed and merged object, and is validated like any
 * other key instead of reaching the object prototype.
 */

function withIsolatedConfig<T>(fn: (ctx: { home: string; project: string }) => T): T {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-config-proto-home-"));
  const project = mkdtempSync(join(tmpdir(), "pi-dent-config-proto-project-"));
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

function writeConf(root: string, content: string): string {
  const dir = join(root, ".pi", "pi-dent");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "pi-dent.conf");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("a `__proto__` root key stays an own key and gets the unknown-root-key diagnostic", () => {
  withIsolatedConfig(({ project }) => {
    // Raw JSON text: a `__proto__` key in a parsed document must behave like any other key.
    const projectFile = writeConf(project, '{"__proto__": {"injected": true}, "modelClasses": {}}');
    const config = readConfig(project);
    assert.deepEqual(config.merged, { modelClasses: {} });
    const messages = config.diagnostics.map((d) => d.message);
    assert.equal(messages.length, 1);
    const pattern = `${projectFile.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}: unknown root keys "__proto__"`;
    assert.match(at(messages, 0), new RegExp(pattern));
  });
});

test("a `__proto__` key inside a merged object stays an own key and is validated", () => {
  withIsolatedConfig(({ project }) => {
    writeConf(project, '{"modelClasses": {"__proto__": 5, "fast": {"provider": "a", "id": "b"}}}');
    const config = readConfig(project);
    assert.ok(Object.hasOwn(config.merged, "modelClasses"));
    const classes = config.merged.modelClasses as Record<string, unknown>;
    assert.ok(Object.hasOwn(classes, "__proto__"), "__proto__ stays an own key");
    assert.ok(Object.hasOwn(classes, "fast"), "sibling keys survive");
    assert.deepEqual(Object.keys(classes).toSorted(), ["__proto__", "fast"]);
    const problems = modelClassDiagnostics(config);
    assert.equal(problems.length, 1);
    assert.match(at(problems, 0), /modelClasses\.__proto__/u);
  });
});

test("project `__proto__` keys cannot shadow a global sibling during the merge", () => {
  withIsolatedConfig(({ home, project }) => {
    writeConf(home, '{"modelClasses": {"__proto__": 5, "fast": {"provider": "a", "id": "b"}}}');
    writeConf(project, '{"modelClasses": {"__proto__": 7}}');
    const config = readConfig(project);
    const classes = config.merged.modelClasses as Record<string, unknown>;
    assert.ok(Object.hasOwn(classes, "__proto__"));
    const own = Object.getOwnPropertyDescriptor(classes, "__proto__");
    assert.ok(own, "__proto__ is an own property");
    assert.equal(Object.entries(classes).find(([k]) => k === "__proto__")?.[1], 7);
    assert.ok(Object.hasOwn(classes, "fast"), "the global sibling survives the merge");
  });
});
