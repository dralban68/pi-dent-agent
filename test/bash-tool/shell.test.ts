import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HostSession } from "../../lib/host.ts";
import { at } from "../support/must.ts";
import {
  buildBashEnv,
  findOnPath,
  readBashSettings,
  resolveShell,
  resolveShellIn,
  type ShellLookup,
} from "../../lib/bash-tool.ts";

/** Shell resolution, environment and host settings (specs/bash-tool.md#execution-model). */

function makeHost(overrides: Partial<HostSession> = {}): HostSession {
  return {
    cwd: () => "/tmp",
    sessionId: () => "sess",
    sessionFile: () => undefined,
    sessionDir: () => "/tmp",
    model: () => undefined,
    thinking: () => undefined,
    activeTools: () => ["Bash"],
    inventory: () => [],
    configuredModels: () => [],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
    ...overrides,
  };
}

test("resolveShell: the platform default when no shell is configured", () => {
  if (process.platform === "win32") return;
  const resolved = resolveShell({});
  assert.deepEqual(resolved, { path: "/bin/bash" });
});

test("resolveShell: a configured shell that exists is used as written", () => {
  const resolved = resolveShell({ shellPath: "/bin/sh" });
  assert.deepEqual(resolved, { path: "/bin/sh" });
});

test("resolveShell: `~` expands to the home directory", () => {
  const resolved = resolveShell({ shellPath: "~" });
  assert.deepEqual(resolved, { path: homedir() });
});

test("resolveShell: a configured shell that does not exist ends the search", () => {
  const missing = join(homedir(), "no-such-shell");
  if (existsSync(missing)) return;
  const resolved = resolveShell({ shellPath: "~/no-such-shell" });
  assert.ok("error" in resolved);
  assert.ok(resolved.error.includes(missing), resolved.error);

  const absolute = resolveShell({ shellPath: "/definitely/not/here" });
  assert.deepEqual(absolute, { error: "shell not found: /definitely/not/here" });

  const relative = resolveShell({ shellPath: "relative-shell" });
  assert.deepEqual(relative, { error: "shell not found: relative-shell" });
});

test("resolveShellIn: off Windows the list ends with sh, so a shell always resolves", () => {
  const lookup: ShellLookup = {
    platform: "linux",
    exists: () => false,
    find: () => undefined,
    env: {},
  };
  assert.deepEqual(resolveShellIn({}, lookup), { path: "sh" });
  assert.deepEqual(
    resolveShellIn({}, { ...lookup, find: (name) => (name === "sh" ? "/usr/bin/sh" : undefined) }),
    { path: "/usr/bin/sh" },
  );
  assert.deepEqual(
    resolveShellIn(
      {},
      { ...lookup, find: (name) => (name === "bash" ? "/usr/local/bin/bash" : undefined) },
    ),
    { path: "/usr/local/bin/bash" },
  );
  assert.deepEqual(resolveShellIn({}, { ...lookup, exists: (path) => path === "/bin/bash" }), {
    path: "/bin/bash",
  });
  // A configured shell that does not exist still ends the search.
  assert.deepEqual(resolveShellIn({ shellPath: "/nowhere" }, lookup), {
    error: "shell not found: /nowhere",
  });
});

test("resolveShellIn: Windows tries Git for Windows, then bash.exe on PATH", () => {
  const lookup: ShellLookup = {
    platform: "win32",
    exists: () => false,
    find: () => undefined,
    env: { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
  };
  const git = join("C:\\Program Files", "Git", "bin", "bash.exe");
  assert.deepEqual(resolveShellIn({}, { ...lookup, exists: (path) => path === git }), {
    path: git,
  });
  const onPath = resolveShellIn({}, { ...lookup, find: () => "C:\\bin\\bash.exe" });
  assert.deepEqual(onPath, { path: "C:\\bin\\bash.exe" });
  // Windows has no `sh` fallback: nothing found is unresolvable.
  assert.deepEqual(resolveShellIn({}, lookup), { error: "shell not found: bash.exe" });
});

test("findOnPath: reads the host process PATH, first match wins", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-path-"));
  const saved = process.env.PATH;
  const name = process.platform === "win32" ? "bash.exe" : "bash";
  try {
    process.env.PATH = root;
    assert.equal(findOnPath(name), undefined);
    assert.equal(findOnPath("no-such-binary-xyz"), undefined);
    writeFileSync(join(root, name), "");
    assert.equal(findOnPath(name), join(root, name));
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("findOnPath: finds a binary that exists in PATH", () => {
  if (process.platform === "win32") return;
  const found = findOnPath("sh");
  assert.ok(found !== undefined && existsSync(found), String(found));
});

test("buildBashEnv: the agent bin directory prefixes PATH when it is absent", () => {
  const bin = join(getAgentDir(), "bin");
  const saved = process.env.PATH;
  process.env.PATH = ["/usr/bin", "/bin"].join(delimiter);
  try {
    const env = buildBashEnv(makeHost());
    const entries = (env.PATH ?? "").split(delimiter);
    assert.equal(entries[0], bin);
    assert.equal(entries.filter((entry) => entry === bin).length, 1);
    assert.deepEqual(entries.slice(1), ["/usr/bin", "/bin"]);
    assert.equal(process.env.PATH, ["/usr/bin", "/bin"].join(delimiter));
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
});

test("buildBashEnv: an existing agent bin entry is not added again", () => {
  const bin = join(getAgentDir(), "bin");
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}/usr/bin${delimiter}/bin`;
  try {
    const env = buildBashEnv(makeHost());
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
});

test("buildBashEnv: the session values are set, the missing ones are removed", () => {
  const saved = {
    PI_DENT_SESSION_DIR: process.env.PI_DENT_SESSION_DIR,
    PI_MODEL: process.env.PI_MODEL,
    PI_PROVIDER: process.env.PI_PROVIDER,
    PI_REASONING_LEVEL: process.env.PI_REASONING_LEVEL,
    PI_SESSION_FILE: process.env.PI_SESSION_FILE,
  };
  process.env.PI_DENT_SESSION_DIR = "/main/dir";
  process.env.PI_MODEL = "leaked-model";
  process.env.PI_PROVIDER = "leaked-provider";
  process.env.PI_REASONING_LEVEL = "leaked-level";
  process.env.PI_SESSION_FILE = "/leaked/file.jsonl";
  try {
    const withValues = makeHost({
      model: () => ({ provider: "prov", id: "mod" }),
      thinking: () => "low",
      sessionFile: () => "/tmp/session.jsonl",
    });
    const env = buildBashEnv(withValues);
    assert.equal(env.PI_DENT_SESSION_DIR, "/main/dir");
    assert.equal(env.PI_SESSION_ID, "sess");
    assert.equal(env.PI_SESSION_FILE, "/tmp/session.jsonl");
    assert.equal(env.PI_PROVIDER, "prov");
    assert.equal(env.PI_MODEL, "mod");
    assert.equal(env.PI_REASONING_LEVEL, "low");

    const withoutValues = buildBashEnv(makeHost());
    assert.equal("PI_MODEL" in withoutValues, false);
    assert.equal("PI_PROVIDER" in withoutValues, false);
    assert.equal("PI_REASONING_LEVEL" in withoutValues, false);
    assert.equal("PI_SESSION_FILE" in withoutValues, false);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("buildBashEnv: PI_DENT_SESSION_DIR is absent when the process has none", () => {
  const saved = process.env.PI_DENT_SESSION_DIR;
  delete process.env.PI_DENT_SESSION_DIR;
  try {
    const env = buildBashEnv(makeHost());
    assert.equal("PI_DENT_SESSION_DIR" in env, false);
  } finally {
    if (saved !== undefined) process.env.PI_DENT_SESSION_DIR = saved;
  }
});

test("buildBashEnv: extra values win and process.env stays unchanged", () => {
  const saved = process.env.PI_DENT_SESSION_DIR;
  process.env.PI_DENT_SESSION_DIR = "/main/dir";
  try {
    const env = buildBashEnv(makeHost(), { PI_DENT_SESSION_DIR: "/child/dir", EXTRA: "1" });
    assert.equal(env.PI_DENT_SESSION_DIR, "/child/dir");
    assert.equal(env.EXTRA, "1");
    assert.equal(process.env.PI_DENT_SESSION_DIR, "/main/dir");
  } finally {
    if (saved === undefined) delete process.env.PI_DENT_SESSION_DIR;
    else process.env.PI_DENT_SESSION_DIR = saved;
  }
});

test("readBashSettings: only the two settings, of the right types", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-settings-"));
  try {
    const settings = readBashSettings(root, () => {}, new Set());
    assert.deepEqual(Object.keys(settings).toSorted(), ["shellCommandPrefix", "shellPath"]);
    for (const value of [settings.shellPath, settings.shellCommandPrefix]) {
      assert.ok(value === undefined || typeof value === "string", String(value));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBashSettings: a settings file that cannot be parsed is reported once per file", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-bash-settings-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const projectSettings = join(project, ".pi", "settings.json");
  writeFileSync(projectSettings, "{ this is not JSON");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const reported: string[] = [];
    const reportedFiles = new Set<string>();
    const settings = readBashSettings(project, (message) => reported.push(message), reportedFiles);
    assert.equal(settings.shellPath, undefined, "the unreadable file contributes no shellPath");
    assert.equal(settings.shellCommandPrefix, undefined);
    assert.equal(reported.length, 1, JSON.stringify(reported));
    assert.ok(at(reported, 0).startsWith(`${projectSettings}: `), at(reported, 0));

    // The same file of the same boot window is not reported again.
    const again: string[] = [];
    readBashSettings(project, (message) => again.push(message), reportedFiles);
    assert.deepEqual(again, []);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBashSettings: a settings file that parses supplies both settings", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-bash-settings-ok-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(project, ".pi", "settings.json"),
    JSON.stringify({ shellPath: "/bin/sh", shellCommandPrefix: "set -eu" }),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const reported: string[] = [];
    const settings = readBashSettings(project, (message) => reported.push(message), new Set());
    assert.deepEqual(settings, { shellPath: "/bin/sh", shellCommandPrefix: "set -eu" });
    assert.deepEqual(reported, []);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
