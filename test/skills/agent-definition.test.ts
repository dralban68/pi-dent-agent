import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../../lib/catalogs.ts";
import type { Diagnostic } from "../../lib/util.ts";
import { at } from "../support/must.ts";

/**
 * The layer-scope skip rules of specs/agent.md Section 1: the reserved bare name
 * `dynamic`, a duplicate `name` within one scope, and an empty body each skip one
 * definition with one diagnostic naming its file.
 *
 * `homedir()` reads HOME, so each test points HOME at a throwaway directory.
 */

function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "pi-dent-agentdef-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

function projectAgentsDir(root: string): string {
  const dir = join(root, ".pi", "pi-dent", "agents");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function linesFor(diagnostics: Diagnostic[], needle: string): string[] {
  return diagnostics.filter((d) => d.message.includes(needle)).map((d) => d.message);
}

test("agent definition: the bare name `dynamic` is reserved and a definition using it is skipped", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-agentdef-"));
    try {
      const dir = projectAgentsDir(root);
      const file = join(dir, "dynamic.md");
      writeFileSync(file, "---\nname: dynamic\n---\n\nprompt\n");
      const diagnostics: Diagnostic[] = [];
      assert.deepEqual(discoverAgents(root, diagnostics), []);
      const lines = linesFor(diagnostics, file);
      assert.equal(lines.length, 1, `exactly one line for ${file}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /^agents: /);
      assert.match(at(lines, 0), /reserved/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("agent definition: a duplicate name within one scope skips the later file with one diagnostic", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-agentdef-"));
    try {
      const dir = projectAgentsDir(root);
      const first = join(dir, "a.md");
      writeFileSync(first, "---\nname: dup\n---\n\nfirst prompt\n");
      const second = join(dir, "b.md");
      writeFileSync(second, "---\nname: dup\n---\n\nsecond prompt\n");
      const diagnostics: Diagnostic[] = [];
      const agents = discoverAgents(root, diagnostics);
      assert.deepEqual(
        agents.map((agent) => [agent.name, agent.prompt]),
        [["dup", "first prompt"]],
        "the first file in lexicographic order loads",
      );
      const lines = linesFor(diagnostics, second);
      assert.equal(lines.length, 1, `exactly one line for ${second}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /duplicate name "dup" in project scope/);
      assert.deepEqual(linesFor(diagnostics, first), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("agent definition: an empty body skips the definition with one diagnostic naming the file", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-agentdef-"));
    try {
      const dir = projectAgentsDir(root);
      const file = join(dir, "hollow.md");
      writeFileSync(file, "---\nname: hollow\n---\n\n   \n\n");
      const diagnostics: Diagnostic[] = [];
      assert.deepEqual(discoverAgents(root, diagnostics), []);
      const lines = linesFor(diagnostics, file);
      assert.equal(lines.length, 1, `exactly one line for ${file}: ${JSON.stringify(lines)}`);
      assert.match(at(lines, 0), /empty body/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("agent definition: the same name in two scopes is not a duplicate, and the project definition shadows the global one", () => {
  withTempHome((home) => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-agentdef-"));
    try {
      const globalDir = join(home, ".pi", "pi-dent", "agents");
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(globalDir, "shared.md"), "---\nname: shared\n---\n\nglobal prompt\n");
      writeFileSync(
        join(projectAgentsDir(root), "shared.md"),
        "---\nname: shared\n---\n\nproject prompt\n",
      );
      const diagnostics: Diagnostic[] = [];
      const agents = discoverAgents(root, diagnostics);
      assert.deepEqual(diagnostics, []);
      assert.deepEqual(
        agents.map((agent) => [agent.name, agent.prompt]),
        [["shared", "project prompt"]],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("agent definition: an unknown frontmatter key is reported with the object name `frontmatter` and the definition loads", () => {
  withTempHome(() => {
    const root = mkdtempSync(join(tmpdir(), "pi-dent-agentdef-"));
    try {
      const dir = projectAgentsDir(root);
      const file = join(dir, "keyed.md");
      writeFileSync(file, "---\nname: keyed\nfuture: x\n---\n\nprompt\n");
      const diagnostics: Diagnostic[] = [];
      assert.deepEqual(
        discoverAgents(root, diagnostics).map((agent) => agent.name),
        ["keyed"],
      );
      assert.deepEqual(
        diagnostics.map((d) => d.message),
        [`agents: ${file}: frontmatter: unknown keys future ignored`],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
