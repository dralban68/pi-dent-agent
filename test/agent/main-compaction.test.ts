import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hostFromContext } from "../../lib/engine.ts";
import { at } from "../support/must.ts";

/**
 * Compaction per specs/agent-tool.md Section 3.4: the dispatching session's
 * compaction settings come from the settings files of its working directory, and a
 * settings file that cannot be read contributes nothing and is reported.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// An isolated pi agent dir, so the global settings file is the test's, not the machine's.
const home = mkdtempSync(join(tmpdir(), "pi-dent-main-compaction-"));
roots.push(home);
const agentDir = join(home, "pi-agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => delete process.env.PI_CODING_AGENT_DIR);

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-main-compaction-case-"));
  roots.push(root);
  mkdirSync(join(root, ".pi"), { recursive: true });
  return root;
}

/** A host adapter over a fake extension context whose UI records its notifications. */
function hostAt(root: string, notified: string[]) {
  const ctx = {
    cwd: root,
    sessionManager: {
      getSessionId: () => "main-id",
      getSessionFile: () => undefined,
      getSessionDir: () => root,
    },
    model: undefined,
    thinkingLevel: undefined,
    modelRegistry: { getAll: () => [], getAvailable: () => [] },
    ui: {
      notify: (message: string) => {
        notified.push(message);
      },
    },
  } as unknown as ExtensionContext;
  const pi = { getActiveTools: () => [], sendMessage: () => {} } as unknown as Pick<
    ExtensionAPI,
    "getActiveTools" | "sendMessage"
  >;
  return hostFromContext(pi, ctx);
}

test("the dispatching session's compaction settings come from its working directory", () => {
  const root = newRoot();
  writeFileSync(
    join(root, ".pi", "settings.json"),
    JSON.stringify({ compaction: { reserveTokens: 4321, keepRecentTokens: 5 } }),
  );
  const notified: string[] = [];
  const compaction = hostAt(root, notified).compaction();
  assert.deepEqual(compaction, { reserveTokens: 4321, keepRecentTokens: 5 });
  assert.deepEqual(notified, [], "a readable settings file warns about nothing");
});

test("a settings read failure applies the defaults and is reported", () => {
  const root = newRoot();
  const settingsPath = join(root, ".pi", "settings.json");
  writeFileSync(settingsPath, "{ not json");
  const notified: string[] = [];
  const compaction = hostAt(root, notified).compaction();
  assert.equal(compaction, undefined, "an unreadable file contributes no compaction settings");
  assert.equal(notified.length, 1, "the failure is reported once");
  assert.match(notified[0] ?? "", /settings\.json/, "the warning names the settings file");
});

test("each settings file that cannot be read is named in its own warning", () => {
  const root = newRoot();
  const globalDir = join(root, "global");
  mkdirSync(globalDir, { recursive: true });
  const globalSettings = join(globalDir, "settings.json");
  writeFileSync(globalSettings, "{ not json");
  const projectSettings = join(root, ".pi", "settings.json");
  writeFileSync(projectSettings, "{ not json");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = globalDir;
  try {
    const notified: string[] = [];
    const compaction = hostAt(root, notified).compaction();
    assert.equal(compaction, undefined, "no file contributes compaction settings");
    assert.equal(notified.length, 2, JSON.stringify(notified));
    assert.ok(
      notified.some((message) => message.includes(globalSettings)),
      JSON.stringify(notified),
    );
    assert.ok(
      notified.some((message) => message.includes(projectSettings)),
      JSON.stringify(notified),
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("a broken project settings file contributes nothing while the global layer still applies", () => {
  const root = newRoot();
  const globalDir = join(root, "global");
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(
    join(globalDir, "settings.json"),
    JSON.stringify({ compaction: { reserveTokens: 111 } }),
  );
  const projectSettings = join(root, ".pi", "settings.json");
  writeFileSync(projectSettings, "{ not json");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = globalDir;
  try {
    const notified: string[] = [];
    const compaction = hostAt(root, notified).compaction();
    assert.deepEqual(compaction, { reserveTokens: 111 }, "the global layer still applies");
    assert.equal(notified.length, 1, JSON.stringify(notified));
    assert.ok(at(notified, 0).includes(projectSettings), at(notified, 0));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
