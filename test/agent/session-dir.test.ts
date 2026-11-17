import { test, after } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  getApiProvider,
  registerFauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  DispatchEngine,
  agentDirForHost,
  agentsDirFor,
  closeMainSessionDir,
  openMainSessionDir,
  retentionSweep,
  type BootSnapshot,
  type ToolResult,
} from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { makeBashTool, readBashSettings } from "../../lib/bash-tool.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import { FleetCoordinator } from "../../lib/fleet.ts";
import type { HostSession } from "../../lib/host.ts";
import { at, must } from "../support/must.ts";

/**
 * specs/agent-tool.md Sections 4.2 and 10: a session's agent directory is its folder,
 * exposed as PI_DENT_SESSION_DIR, never removed by an attempt, pruned only by the sweep.
 * Real child sessions run on a scripted faux provider.
 */

const root = mkdtempSync(join(tmpdir(), "pi-dent-session-dir-"));
process.env.TMPDIR = join(root, "tmp");
mkdirSync(process.env.TMPDIR, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

// An isolated pi agent dir whose auth holds a key for the faux provider.
const agentDir = join(root, "pi-agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const faux = registerFauxProvider({ models: [{ id: "m" }], tokensPerSecond: 60 });
after(() => faux.unregister());
const realCreate = ModelRuntime.create.bind(ModelRuntime);
ModelRuntime.create = async (options) => {
  const runtime = await realCreate(options);
  runtime.registerProvider(faux.models[0].provider, {
    apiKey: "k",
    baseUrl: "http://faux.invalid",
    api: faux.api as never,
    streamSimple: must(getApiProvider(faux.api as never)).streamSimple as never,
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
  });
  return runtime;
};

function bootWith(liveness: { idleTimeoutMs: number; absoluteTimeoutMs: number }): BootSnapshot {
  return {
    cwd: "/tmp",
    config: { merged: {}, layers: {}, projectRoot: "/tmp", diagnostics: [], liveness },
    agents: [],
    agentIndex: new Map(),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: 0,
    sessionTtlDays: 30,
  } as unknown as BootSnapshot;
}

const model = faux.getModel();
const dispatcherValue = "/dispatcher-value";
process.env.PI_DENT_SESSION_DIR = dispatcherValue;
after(() => delete process.env.PI_DENT_SESSION_DIR);

function makeHost(
  sessionFile: string | undefined,
  sessionId: string,
  tools: string[] = ["Agent", "Bash"],
): HostSession {
  return {
    cwd: () => "/tmp",
    sessionId: () => sessionId,
    sessionFile: () => sessionFile,
    sessionDir: () => root,
    model: () => ({ provider: model.provider, id: model.id }),
    thinking: () => undefined,
    activeTools: () => tools,
    inventory: () => [model as never],
    configuredModels: () => [model as never],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
}

const noCtx = undefined as unknown as ExtensionToolContext;
const idle = { idleTimeoutMs: 0, absoluteTimeoutMs: 0 };
const scriptStep = (name: string, args: Record<string, unknown>) => {
  let turn = 0;
  const step: FauxResponseStep = () =>
    turn++ === 0
      ? fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" })
      : fauxAssistantMessage("done");
  faux.setResponses(Array.from({ length: 6 }, () => step));
};
/** The child runs `command` in its `Bash` tool on its first turn, then answers "done". */
function scriptBash(command: string) {
  scriptStep("Bash", { command });
}
/** The child runs `code` in its `Script` tool on its first turn, then answers "done". */
function scriptScript(code: string) {
  scriptStep("Script", { code });
}
const childSessionPath = (engine: DispatchEngine) =>
  (engine.registry.list()[0] as unknown as { sessionPath: string }).sessionPath;
const run = (engine: DispatchEngine, host: HostSession, extra: object = {}) =>
  engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", background: false, ...extra },
    host,
    cohortId: "cohort-1",
  });

test("main session: open creates the agent directory beside the session file and exposes it", () => {
  const sessionFile = join(root, "sessions", "2025_abc.jsonl");
  const dir = join(root, "sessions", "2025_abc.agents");
  assert.equal(agentsDirFor(sessionFile, "id-1"), dir);
  openMainSessionDir(sessionFile, "id-1");
  assert.equal(process.env.PI_DENT_SESSION_DIR, dir);
  assert.equal(existsSync(dir), true);
  writeFileSync(join(dir, "report.md"), "kept");
  closeMainSessionDir(sessionFile, "id-1");
  assert.equal(process.env.PI_DENT_SESSION_DIR, undefined);
  assert.equal(readFileSync(join(dir, "report.md"), "utf8"), "kept", "close never removes");
  openMainSessionDir(sessionFile, "id-1");
  assert.equal(readFileSync(join(dir, "report.md"), "utf8"), "kept", "reopen keeps the files");
  closeMainSessionDir(sessionFile, "id-1");
  process.env.PI_DENT_SESSION_DIR = dispatcherValue;
});

test("main session with no session file: <tmpdir>/pi-dent-sessions/<sessionId>", () => {
  const dir = join(tmpdir(), "pi-dent-sessions", "id-2");
  assert.equal(agentsDirFor(undefined, "id-2"), dir);
  openMainSessionDir(undefined, "id-2");
  assert.equal(process.env.PI_DENT_SESSION_DIR, dir);
  assert.equal(existsSync(dir), true);
  closeMainSessionDir(undefined, "id-2");
  assert.equal(existsSync(dir), true);
  process.env.PI_DENT_SESSION_DIR = dispatcherValue;
});

test("main session: a creation failure leaves PI_DENT_SESSION_DIR unset", () => {
  const blocker = join(root, "blocker");
  writeFileSync(blocker, "file");
  openMainSessionDir(join(blocker, "x.jsonl"), "id-3");
  assert.equal(process.env.PI_DENT_SESSION_DIR, undefined);
  process.env.PI_DENT_SESSION_DIR = dispatcherValue;
});

test("main session: a Bash output file lands in the agent directory's output/", async () => {
  const sessionFile = join(root, "sessions", "main-out.jsonl");
  const dir = agentsDirFor(sessionFile, "id-out");
  openMainSessionDir(sessionFile, "id-out");
  try {
    const registry = new TaskRegistry(() => makeHost(sessionFile, "id-out"));
    const tool = makeBashTool({
      registry: () => registry,
      hostProvider: () => makeHost(sessionFile, "id-out"),
      cohortFor: (id) => `cohort-${id}`,
      agentDir: agentDirForHost,
      settings: (cwd) => readBashSettings(cwd, () => {}, new Set()),
    });
    const result: ToolResult = await tool.execute(
      "call-1",
      { command: "echo hi" } as never,
      undefined,
      undefined,
      noCtx,
    );
    assert.equal(result.isError, undefined);
    const taskId = (result.details as { taskId: string }).taskId;
    const outputPath = (result.details as { outputPath: string }).outputPath;
    assert.equal(outputPath, join(dir, "output", `${taskId}.log`));
    assert.equal(readFileSync(outputPath, "utf8"), "hi\n");
  } finally {
    closeMainSessionDir(sessionFile, "id-out");
    process.env.PI_DENT_SESSION_DIR = dispatcherValue;
  }
});

test("child: tools see the child's own agent directory; its files outlive the attempt", async () => {
  scriptBash('printf "%s" "$PI_DENT_SESSION_DIR" > "$PI_DENT_SESSION_DIR/seen.txt"');
  const sessionFile = join(root, "main", "main.jsonl");
  mkdirSync(join(root, "main"), { recursive: true });
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await run(engine, makeHost(sessionFile, "main-id"));
  assert.equal(result.isError, undefined);
  const childFile = childSessionPath(engine);
  const childDir = agentsDirFor(childFile, "ignored");
  assert.ok(childDir.startsWith(join(root, "main", "main.agents") + "/"), childDir);
  assert.ok(childDir.endsWith(".agents"));
  const seen = join(childDir, "seen.txt");
  assert.equal(existsSync(seen), true, "the file survives the attempt");
  assert.equal(readFileSync(seen, "utf8"), childDir);
  assert.notEqual(readFileSync(seen, "utf8"), dispatcherValue);
  assert.equal(process.env.PI_DENT_SESSION_DIR, dispatcherValue, "process.env is not mutated");
});

test("child: a Bash output file lands in the child's agent directory, not the dispatcher's", async () => {
  scriptBash("echo hi");
  const sessionFile = join(root, "main", "out.jsonl");
  mkdirSync(join(root, "main"), { recursive: true });
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await run(engine, makeHost(sessionFile, "main-id"));
  assert.equal(result.isError, undefined);
  const childDir = agentsDirFor(childSessionPath(engine), "ignored");
  const outputDir = join(childDir, "output");
  assert.equal(existsSync(outputDir), true, "the child's output directory exists");
  const files = readdirSync(outputDir);
  assert.equal(files.length, 1, files.join(","));
  const name = at(files, 0);
  assert.ok(name.endsWith(".log"), name);
  assert.match(readFileSync(join(outputDir, name), "utf8"), /^hi\n/);
  // The dispatcher's own directory (PI_DENT_SESSION_DIR in the process) is untouched.
  assert.equal(existsSync(join(dispatcherValue, "output")), false);
  assert.equal(process.env.PI_DENT_SESSION_DIR, dispatcherValue, "process.env is not mutated");
});

test("child: a Script call writes its output file into the child's agent directory", async () => {
  scriptScript("export default { ok: true };");
  const sessionFile = join(root, "main", "script.jsonl");
  mkdirSync(join(root, "main"), { recursive: true });
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await run(engine, makeHost(sessionFile, "main-id", ["Agent", "Bash", "Script"]));
  assert.equal(result.isError, undefined);
  const childDir = agentsDirFor(childSessionPath(engine), "ignored");
  const outputDir = join(childDir, "output");
  assert.equal(existsSync(outputDir), true, "the child's output directory exists");
  const files = readdirSync(outputDir);
  assert.equal(files.length, 1, files.join(","));
  assert.ok(at(files, 0).endsWith(".log"), at(files, 0));
  assert.match(readFileSync(join(outputDir, at(files, 0)), "utf8"), /--- return ---\n/);
});

test("child: a mistyped output path read in the child gets the hint from its own agent directory", async () => {
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  let real = "";
  let hinted = false;
  // The first turn makes a real output file under the child's directory, then reads a mistyped path.
  const readStep: FauxResponseStep = () => {
    const childDir = agentsDirFor(childSessionPath(engine), "ignored");
    real = join(childDir, "nested.agents", "output", "5b40c845.log");
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, "out\n");
    const wrong = join(childDir, "output", "5b40c845.log");
    return fauxAssistantMessage([fauxToolCall("read", { path: wrong })], { stopReason: "toolUse" });
  };
  // The next turn sees the tool result the model would see.
  const doneStep: FauxResponseStep = (context: unknown) => {
    hinted = JSON.stringify(context).includes(`Did you mean ${real}?`);
    return fauxAssistantMessage("done");
  };
  faux.setResponses([readStep, doneStep, doneStep, doneStep]);
  const sessionFile = join(root, "hint", "script.jsonl");
  mkdirSync(join(root, "hint"), { recursive: true });
  const result = await run(engine, makeHost(sessionFile, "hint-id", ["Agent", "Bash", "read"]));
  assert.equal(result.isError, undefined);
  assert.notEqual(real, "", "the child ran its read turn");
  assert.equal(hinted, true, "the child's read result carries the hint");
});

test("child of a session with no session file nests under <tmpdir>/pi-dent-sessions/<id>", async () => {
  scriptBash('printf x > "$PI_DENT_SESSION_DIR/f.txt"');
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  await run(engine, makeHost(undefined, "nosession-id"));
  const childDir = agentsDirFor(childSessionPath(engine), "ignored");
  assert.ok(
    childDir.startsWith(join(tmpdir(), "pi-dent-sessions", "nosession-id") + "/"),
    childDir,
  );
  assert.equal(existsSync(join(childDir, "f.txt")), true);
});

test("resume: the attempt continues in the same folder with its earlier files", async () => {
  scriptBash('printf first > "$PI_DENT_SESSION_DIR/a.txt"');
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(undefined, "resume-id");
  await run(engine, host);
  const childFile = childSessionPath(engine);
  const childDir = agentsDirFor(childFile, "ignored");
  scriptBash(
    'printf "%s|%s" "$PI_DENT_SESSION_DIR" "$(cat "$PI_DENT_SESSION_DIR/a.txt")" > "$PI_DENT_SESSION_DIR/b.txt"',
  );
  const second = await run(engine, host, { resume: childFile });
  assert.equal(second.isError, undefined, JSON.stringify(second.content));
  assert.equal(readFileSync(join(childDir, "b.txt"), "utf8"), `${childDir}|first`);
});

test("a child's agent directory that cannot be created fails the dispatch as invalid-plan", async () => {
  scriptBash("true");
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const host = makeHost(undefined, "fail-id");
  await run(engine, host);
  const childFile = childSessionPath(engine);
  const childDir = agentsDirFor(childFile, "ignored");
  rmSync(childDir, { recursive: true, force: true });
  writeFileSync(childDir, "a file where the directory belongs");
  const result = await run(engine, host, { resume: childFile });
  assert.equal(result.isError, true);
  const record = at((result.details as { results: Record<string, unknown>[] }).results, 0);
  assert.equal(record.failureCode, "invalid-plan");
  assert.equal(record.failurePhase, "plan-resolution");
});

// Retention sweep (Section 10).
const DAY = 86_400_000;
const sessionsRoot = () => join(root, "pi-agent", "sessions", "proj");
const age = (path: string, days: number) => {
  const t = (Date.now() - days * DAY) / 1000;
  utimesSync(path, t, t);
};
/** A directory with `files` written, then every entry and the directory aged `days`. */
function makeTree(dir: string, files: string[], days: number) {
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const path = join(dir, f);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
    age(path, days);
  }
  for (const f of files) {
    let d = join(dir, f, "..");
    while (d.length >= dir.length) {
      age(d, days);
      d = join(d, "..");
    }
  }
}

test("sweep deletes an expired agent directory whole: any file, nested agent directory included", () => {
  const dir = join(sessionsRoot(), "old.agents");
  makeTree(dir, ["notes.txt", "x-1234abcd.agents/inner.bin", "t-1234abcd.jsonl"], 40);
  writeFileSync(join(sessionsRoot(), "old.jsonl"), "s");
  age(join(sessionsRoot(), "old.jsonl"), 40);
  const fallback = join(tmpdir(), "pi-dent-sessions", "gone-id");
  makeTree(fallback, ["report.md"], 40);
  retentionSweep(30, []);
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(fallback), false);
  assert.equal(
    existsSync(join(sessionsRoot(), "old.jsonl")),
    true,
    "the session file is not swept",
  );
});

test("sweep leaves an agent directory whole when anything in it is recent", () => {
  const dir = join(sessionsRoot(), "live.agents");
  makeTree(dir, ["old.txt", "child-1234abcd.agents/old.jsonl"], 40);
  writeFileSync(join(dir, "child-1234abcd.agents", "fresh.txt"), "x");
  const fallback = join(tmpdir(), "pi-dent-sessions", "live-id");
  makeTree(fallback, ["old.txt"], 40);
  writeFileSync(join(fallback, "fresh.txt"), "x");
  retentionSweep(30, []);
  assert.equal(existsSync(join(dir, "old.txt")), true);
  assert.equal(existsSync(join(dir, "child-1234abcd.agents", "old.jsonl")), true);
  assert.equal(existsSync(join(fallback, "old.txt")), true);
});

test("sweep keeps an old agent directory while its session file beside it is recent", () => {
  const dir = join(sessionsRoot(), "running.agents");
  makeTree(dir, ["old.txt"], 40);
  writeFileSync(join(sessionsRoot(), "running.jsonl"), "s");
  retentionSweep(30, []);
  assert.equal(existsSync(join(dir, "old.txt")), true);
});

test("sweep never deletes a nested agent directory on its own", () => {
  const dir = join(sessionsRoot(), "parent.agents");
  makeTree(dir, ["child-1234abcd.agents/old.txt"], 40);
  writeFileSync(join(dir, "recent.txt"), "x");
  retentionSweep(30, []);
  assert.equal(existsSync(join(dir, "child-1234abcd.agents", "old.txt")), true);
});

test("sweep removes an expired agent directory's output files with it, and touches no pi-dent-scripts tree", () => {
  const dir = join(sessionsRoot(), "expired.agents");
  makeTree(dir, ["output/run1.log", "output/run1.json", "output/notes.txt"], 40);
  const live = join(sessionsRoot(), "fresh.agents");
  makeTree(live, ["output/run2.log"], 0);
  // Output files have no sweep of their own (Section 10): a stray tree with
  // Script's former layout is not touched.
  const scripts = join(tmpdir(), "pi-dent-scripts", `stray-${process.pid}`);
  makeTree(scripts, ["run3.log", "run3.json"], 40);
  try {
    retentionSweep(30, []);
    assert.equal(existsSync(join(dir, "output", "run1.log")), false);
    assert.equal(existsSync(join(dir, "output", "run1.json")), false);
    assert.equal(existsSync(dir), false, "the directory goes whole");
    assert.equal(existsSync(join(live, "output", "run2.log")), true);
    assert.equal(existsSync(join(scripts, "run3.log")), true);
    assert.equal(existsSync(join(scripts, "run3.json")), true);
  } finally {
    rmSync(scripts, { recursive: true, force: true });
  }
});

// Live sessions (Section 10): the local session store says which directories are in use.
const dbPath = () => join(root, `fleet-${Math.random().toString(36).slice(2)}.sqlite`);
const coordinator = (path: string) => new FleetCoordinator(bootWith(idle), { dbPath: path });
const endpoint = (sessionId: string, agentsDir: string | undefined) => ({
  sessionId,
  agentsDir,
  cwd: () => "/tmp",
  isIdle: () => true,
  abortTurn: () => {},
  deliverTurn: () => {},
});
/** A pid that is verifiably dead: a node process that already exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
/** Writes a record as another pi-dent process would: owner `pid`, a foreign boot window. */
function foreignRecord(path: string, id: string, pid: number, agentsDir: string | null) {
  const db = new DatabaseSync(path);
  db.prepare(
    "INSERT INTO fleet_sessions (session_id, cwd, state, alive, updated_at, turns_json, owner_pid, owner_boot, owner_started, agents_dir) VALUES (?, '/tmp', 'idle', 1, ?, '[]', ?, 'deadbeef', ?, ?)",
  ).run(id, Date.now(), pid, Date.now() - 100_000, agentsDir);
  db.close();
}

test("sweep keeps the old directory of a session live in this process, nested child directories included", () => {
  const sessionFile = join(sessionsRoot(), "mine.jsonl");
  const dir = agentsDirFor(sessionFile, "mine-id");
  makeTree(dir, ["old.txt", "child-1234abcd.agents/old.jsonl"], 40);
  writeFileSync(sessionFile, "s");
  age(sessionFile, 40);
  const fleet = coordinator(dbPath());
  try {
    fleet.registerEndpoint(endpoint("mine-id", dir));
    retentionSweep(30, fleet.liveAgentDirs());
    assert.equal(existsSync(join(dir, "old.txt")), true);
    assert.equal(existsSync(join(dir, "child-1234abcd.agents", "old.jsonl")), true);
  } finally {
    fleet.close();
  }
});

test("sweep keeps the old directory of a session another process runs, until its owner is gone", () => {
  const path = dbPath();
  const fleet = coordinator(path);
  try {
    const dir = join(sessionsRoot(), "theirs.agents");
    makeTree(dir, ["old.txt"], 40);
    const bare = join(tmpdir(), "pi-dent-sessions", "theirs-bare");
    makeTree(bare, ["old.txt"], 40);
    foreignRecord(path, "theirs", process.ppid, dir);
    foreignRecord(path, "theirs-bare", process.ppid, bare);
    retentionSweep(30, fleet.liveAgentDirs());
    assert.equal(
      existsSync(join(dir, "old.txt")),
      true,
      "live foreign owner protects the directory",
    );
    assert.equal(
      existsSync(join(bare, "old.txt")),
      true,
      "--no-session directory protected by path",
    );
    const db = new DatabaseSync(path);
    db.prepare("UPDATE fleet_sessions SET owner_pid = ?").run(deadPid());
    db.close();
    retentionSweep(30, fleet.liveAgentDirs());
    assert.equal(existsSync(dir), false, "a crashed owner's directory is pruned");
    assert.equal(existsSync(bare), false);
  } finally {
    fleet.close();
  }
});

test("sweep deletes no agent directory when the store is unreadable or a live record lacks a directory", () => {
  const dir = join(sessionsRoot(), "unknown.agents");
  makeTree(dir, ["old.txt"], 40);
  const closed = coordinator(dbPath());
  closed.close();
  assert.equal(closed.liveAgentDirs(), undefined);
  retentionSweep(30, closed.liveAgentDirs());
  assert.equal(existsSync(join(dir, "old.txt")), true, "unavailable store");
  const path = dbPath();
  const fleet = coordinator(path);
  try {
    foreignRecord(path, "legacy", process.ppid, null);
    assert.equal(fleet.liveAgentDirs(), undefined);
    retentionSweep(30, fleet.liveAgentDirs());
    assert.equal(existsSync(join(dir, "old.txt")), true, "record without a directory");
  } finally {
    fleet.close();
  }
  retentionSweep(30, []);
  assert.equal(existsSync(dir), false, "an empty live set prunes as before");
});

test("a session resumed past the age keeps its files after start", () => {
  // The index.ts order at the window's first session_start: open the directory,
  // register in the store, then sweep.
  const sessionFile = join(sessionsRoot(), "resumed.jsonl");
  const dir = agentsDirFor(sessionFile, "resumed-id");
  makeTree(dir, ["report.md"], 60);
  writeFileSync(sessionFile, "s");
  age(sessionFile, 60);
  const fleet = coordinator(dbPath());
  try {
    openMainSessionDir(sessionFile, "resumed-id");
    fleet.registerEndpoint(endpoint("resumed-id", dir));
    retentionSweep(30, fleet.liveAgentDirs());
    assert.equal(readFileSync(join(dir, "report.md"), "utf8"), "x");
    closeMainSessionDir(sessionFile, "resumed-id");
  } finally {
    fleet.close();
  }
  retentionSweep(30, []);
  assert.equal(existsSync(join(dir, "report.md")), true, "ending the session restarts its age");
  process.env.PI_DENT_SESSION_DIR = dispatcherValue;
});

test("a reload keeps the record's directory protected", () => {
  const dir = join(sessionsRoot(), "reload.agents");
  makeTree(dir, ["old.txt"], 40);
  const path = dbPath();
  const first = coordinator(path);
  first.registerEndpoint(endpoint("reload-id", dir));
  first.releaseEndpointForReload("reload-id");
  first.close({ keepPending: true });
  const second = coordinator(path);
  try {
    retentionSweep(30, second.liveAgentDirs());
    assert.equal(existsSync(join(dir, "old.txt")), true);
  } finally {
    second.close();
  }
});
