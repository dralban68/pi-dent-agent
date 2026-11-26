import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveCwdParam } from "../../lib/cwd-param.ts";

// specs/task.md#cwd-parameter: one `cwd` contract for Agent, Script, and Bash.
test("cwd parameter: blank is absent, relative resolves, a non-directory is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-cwd-"));
  try {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "file"), "");

    for (const blank of [undefined, "", "  ", "\t\n"]) {
      assert.deepEqual(resolveCwdParam(blank, root), { cwd: undefined });
    }
    assert.deepEqual(resolveCwdParam("sub", root), { cwd: join(root, "sub") });
    assert.deepEqual(resolveCwdParam(join(root, "sub"), "/nowhere"), { cwd: join(root, "sub") });
    assert.deepEqual(resolveCwdParam("missing", root), {
      error: `cwd is not an existing directory: ${join(root, "missing")}`,
    });
    assert.deepEqual(resolveCwdParam("file", root), {
      error: `cwd is not an existing directory: ${join(root, "file")}`,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
