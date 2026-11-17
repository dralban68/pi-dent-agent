import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "../../lib/config.ts";

test("recapModel is trimmed when valid and invalid values diagnose their owning file", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-recap-home-"));
  const project = mkdtempSync(join(tmpdir(), "pi-dent-recap-project-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const dir = join(project, ".pi", "pi-dent");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "pi-dent.conf");
    writeFileSync(path, '{ "recapModel": "  provider/model  ", }');
    const valid = readConfig(project);
    assert.equal(valid.merged.recapModel, "provider/model");
    assert.deepEqual(valid.diagnostics, []);
    for (const value of [12, null, {}, [], true, "", "bad input"]) {
      writeFileSync(path, JSON.stringify({ recapModel: value }));
      const invalid = readConfig(project);
      assert.equal(invalid.merged.recapModel, undefined);
      assert.equal(invalid.diagnostics.length, 1);
      assert.ok(invalid.diagnostics[0]?.message.includes(path));
      assert.ok(invalid.diagnostics[0]?.message.includes("recapModel"));
    }
    writeFileSync(path, '{ "recapModel": " quick:low " }');
    assert.equal(readConfig(project).merged.recapModel, "quick:low");
    writeFileSync(path, "{}");
    const absent = readConfig(project);
    assert.equal(absent.merged.recapModel, undefined);
    assert.deepEqual(absent.diagnostics, []);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
