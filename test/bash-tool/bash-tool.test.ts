import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { ToolResult } from "../../lib/engine.ts";
import type { HostSession } from "../../lib/host.ts";
import { BashTaskRow } from "../../lib/task-row.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import {
  bashParameterSchema,
  makeBashTool,
  resolveBashTimeout,
  type BashSettings,
  type BashToolDeps,
} from "../../lib/bash-tool.ts";
import { safeName } from "../../lib/util.ts";
import { at } from "../support/must.ts";

/**
 * Bash tool (specs/bash-tool.md): integration tests through the public
 * `execute` surface against a real shell process.
 */

interface Fixture {
  deps: BashToolDeps;
  registry: TaskRegistry;
  root: string;
  /** The invoking session's agent directory (agent-tool.md Section 4.2). */
  agentDir: string;
  /** The session directory the fixture passes as `PI_DENT_SESSION_DIR` (under `root`). */
  sessionDir: string;
  host: HostSession;
  cleanup: () => void;
}

interface FixtureOptions {
  sessionId?: string;
  settings?: BashSettings;
  /** Returning a new object on every call lets a test watch the read happen. */
  settingsFn?: (cwd: string) => BashSettings;
  extraEnv?: () => Record<string, string> | undefined;
  host?: Partial<HostSession>;
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-bash-"));
  const sessionId = options.sessionId ?? `sess-bash-${Math.random().toString(36).slice(2)}`;
  const host: HostSession = {
    cwd: () => root,
    sessionId: () => sessionId,
    sessionFile: () => undefined,
    sessionDir: () => root,
    model: () => undefined,
    thinking: () => undefined,
    activeTools: () => ["Bash"],
    inventory: () => [],
    configuredModels: () => [],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
    ...options.host,
  };
  const registry = new TaskRegistry(() => host);
  const base = options.settings ?? {};
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "session");
  const deps: BashToolDeps = {
    registry: () => registry,
    hostProvider: () => host,
    cohortFor: (id) => `cohort-${id}`,
    agentDir: () => agentDir,
    settings: options.settingsFn ?? (() => base),
    extraEnv: options.extraEnv ?? (() => ({ PI_DENT_SESSION_DIR: sessionDir })),
  };
  return {
    deps,
    registry,
    root,
    agentDir,
    sessionDir,
    host,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const noCtx = undefined as unknown as ExtensionToolContext;

async function call(
  fixture: Fixture,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: (partial: ToolResult) => void,
): Promise<ToolResult> {
  return makeBashTool(fixture.deps).execute("call-1", params as never, signal, onUpdate, noCtx);
}

function textOf(result: ToolResult): string {
  assert.equal(result.content.length, 1, "one text content block");
  const first = at(result.content, 0);
  if (first.type !== "text") assert.fail(`expected text content, got ${first.type}`);
  return first.text;
}

function detailsOf(result: ToolResult): Record<string, unknown> {
  return result.details;
}

function outputPathOf(fixture: Fixture, taskId: string): string {
  return join(fixture.agentDir, "output", `${safeName(taskId)}.log`);
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((done) => setTimeout(done, 10));
  }
}

test("schema: object, no additional properties, the five parameters, command patterned", () => {
  const schema = bashParameterSchema as unknown as {
    type: string;
    additionalProperties: boolean;
    required?: string[];
    properties: Record<
      string,
      { type?: string; minimum?: number; maximum?: number; pattern?: string }
    >;
  };
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required ?? [], ["command"]);
  assert.deepEqual(Object.keys(schema.properties).toSorted(), [
    "background",
    "command",
    "cwd",
    "description",
    "timeout",
  ]);
  // Section 1: timeout is an integer of 1 or more, with no upper bound.
  const timeout = schema.properties.timeout ?? {};
  assert.equal(timeout.type, "integer");
  assert.equal(timeout.minimum, 1);
  assert.equal(timeout.maximum, undefined);
  assert.equal(schema.properties.command?.type, "string");
  // Section 1: at least one character that is not white space.
  assert.equal(schema.properties.command?.pattern, "\\S");
  assert.equal(schema.properties.cwd?.type, "string");
  assert.equal(schema.properties.background?.type, "boolean");
  assert.equal(schema.properties.description?.type, "string");
});

test("schema: a command without a non-white-space character is a schema rejection", () => {
  for (const command of ["", "   ", "\n\t"]) {
    assert.equal(
      Value.Check(bashParameterSchema, { command }),
      false,
      `${JSON.stringify(command)} is rejected`,
    );
  }
  assert.equal(Value.Check(bashParameterSchema, { command: " ls" }), true);
  // A blank first line still carries a non-white-space character further on.
  assert.equal(Value.Check(bashParameterSchema, { command: "\n\n ls" }), true);
  assert.equal(Value.Check(bashParameterSchema, {}), false, "command is required");
  assert.equal(Value.Check(bashParameterSchema, { command: 7 }), false);
});

test("description: names Bash and carries the &/nohup sentence verbatim", () => {
  const tool = makeBashTool(makeFixture().deps);
  assert.equal(tool.name, "Bash");
  assert.equal(tool.label, "Bash");
  const description = tool.description ?? "";
  assert.ok(
    description.includes("Do not start processes with & or nohup: use background: true."),
    description,
  );
  // Section 1: an omitted timeout defaults for a foreground call only.
  assert.ok(
    description.includes("An omitted `timeout` gives a foreground call 600000 ms"),
    description,
  );
  assert.ok(!/Omitted `timeout` imposes none/.test(description), description);
});

test("validation: cwd, then the shell (Section 2)", async () => {
  const f = makeFixture({ settings: { shellPath: "/nonexistent/shell" } });
  try {
    const missing = await call(f, { command: "true", cwd: join(f.root, "nowhere") });
    assert.equal(missing.isError, true);
    assert.ok(textOf(missing).includes(join(f.root, "nowhere")), textOf(missing));
    assert.equal(at(f.registry.list(), 0).status, "failed");

    const file = join(f.root, "a-file");
    writeFileSync(file, "");
    const notDir = await call(f, { command: "true", cwd: file });
    assert.equal(notDir.isError, true);
    assert.ok(textOf(notDir).includes(file), textOf(notDir));
    assert.equal(at(f.registry.list(), 1).status, "failed");

    const shell = await call(f, { command: "true" });
    assert.equal(shell.isError, true);
    assert.match(textOf(shell), /shell/);
    assert.equal(at(f.registry.list(), 2).status, "failed");
    // A rejected call creates no output directory or file (Section 6).
    assert.ok(!existsSync(join(f.agentDir, "output")));
  } finally {
    f.cleanup();
  }
});

test("validation: a failed rejection settles the row failed, consumed, without an output file", async () => {
  const f = makeFixture({ settings: { shellPath: "/nonexistent/shell" } });
  try {
    const result = await call(f, { command: "true", background: true });
    assert.equal(result.isError, true);
    const row = at(f.registry.list(), 0);
    assert.equal(row.kind, "bash");
    assert.equal(row.status, "failed");
    assert.equal(row.consumed, true);
    assert.equal(row.result, textOf(result));
    assert.ok(!existsSync(join(f.agentDir, "output")));
  } finally {
    f.cleanup();
  }
});

test("rejection order: no live host session comes before the cwd and the shell (Section 2)", async () => {
  const f = makeFixture({ settings: { shellPath: "/nonexistent/shell" } });
  try {
    f.deps.hostProvider = () => undefined;
    const result = await call(f, { command: "true", cwd: "missing-dir", background: true });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "pi-dent: no live host session for the Bash call");
    const row = at(f.registry.list(), 0);
    assert.equal(row.kind, "bash");
    assert.equal(row.status, "failed");
    assert.equal(row.consumed, true);
    assert.equal(row.result, textOf(result));
    assert.ok(!existsSync(join(f.agentDir, "output")));
  } finally {
    f.cleanup();
  }
});

test("validation: an empty or whitespace-only cwd or description is absent", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "pwd", cwd: "   ", description: "  \n " });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), realpathSync(f.root));
    const row = at(f.registry.list(), 0);
    assert.equal(row.label, "pwd");
  } finally {
    f.cleanup();
  }
});

test("the row carries the call's command text, unchanged (Section 6)", async () => {
  const f = makeFixture();
  try {
    const command = "echo one\necho two\techo three\x1b[31m";
    const result = await call(f, { command, description: "short label", background: true });
    assert.equal(result.isError, undefined);
    const row = at(f.registry.list(), 0);
    assert.equal(row.label, "short label");
    assert.ok(row instanceof BashTaskRow);
    assert.equal(row.command, command);
    await waitFor(() => row.status !== "running");
  } finally {
    f.cleanup();
  }
});

test("validation: timeout above 2147483647 is accepted and imposes none", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "sleep 0.15; echo ok", timeout: 2147483648 });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "ok");
  } finally {
    f.cleanup();
  }
});

test("timeout: the resolved value defaults for foreground only (Section 1)", () => {
  assert.equal(resolveBashTimeout(undefined, false), 600000);
  assert.equal(resolveBashTimeout(undefined, true), undefined);
  assert.equal(resolveBashTimeout(1, false), 1);
  assert.equal(resolveBashTimeout(12345, true), 12345);
  assert.equal(resolveBashTimeout(2147483647, false), 2147483647);
  assert.equal(resolveBashTimeout(2147483648, false), undefined);
  assert.equal(resolveBashTimeout(2147483648, true), undefined);
});

test("timeout: an omitted foreground timeout schedules 600000 ms; a background one schedules none", async () => {
  const f = makeFixture();
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  const recording = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (typeof ms === "number") delays.push(ms);
    return original(callback, ms, ...args);
  };
  globalThis.setTimeout = recording as typeof setTimeout;
  try {
    const foreground = await call(f, { command: "echo hi" });
    assert.equal(foreground.isError, undefined);
    assert.ok(
      delays.includes(600000),
      `an omitted foreground timeout schedules 600000 ms, saw ${delays.join(",")}`,
    );

    delays.length = 0;
    const background = await call(f, { command: "sleep 0.05; echo bg", background: true });
    assert.equal(background.isError, undefined);
    assert.equal(
      delays.includes(600000),
      false,
      `an omitted background timeout schedules nothing, saw ${delays.join(",")}`,
    );
    await waitFor(() => at(f.registry.list(), 0).status !== "running");
  } finally {
    globalThis.setTimeout = original;
    f.cleanup();
  }
});

test("foreground: exit 0 has no status line and the task completes", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "echo hi" });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "hi");
    const details = detailsOf(result);
    const row = at(f.registry.list(), 0);
    assert.equal(details.taskId, row.taskId);
    assert.equal(details.exitReason, "exited");
    assert.equal(details.exitCode, 0);
    assert.equal(details.truncated, false);
    assert.equal(details.leftover, false);
    assert.equal(details.outputPath, outputPathOf(f, row.taskId));
    assert.ok(typeof details.durationMs === "number" && details.durationMs >= 0);
    assert.ok(!("background" in details), "no background key in a foreground result");
    assert.equal(row.status, "completed");
    assert.equal(row.result, "hi");
    assert.equal(row.resultPath, details.outputPath);
    assert.equal(readFileSync(String(details.outputPath), "utf8"), "hi\n");
    assert.deepEqual(
      row.progress.map((entry) => entry.line),
      ["hi"],
    );
  } finally {
    f.cleanup();
  }
});

test("output: the file lands in <agentDir>/output/, created when absent (Section 4)", async () => {
  const f = makeFixture();
  try {
    assert.ok(!existsSync(f.agentDir), "no agent directory before the call");
    const result = await call(f, { command: "echo hi" });
    const row = at(f.registry.list(), 0);
    const path = outputPathOf(f, row.taskId);
    assert.equal(detailsOf(result).outputPath, path);
    assert.equal(readFileSync(path, "utf8"), "hi\n");
  } finally {
    f.cleanup();
  }
});

test("output: a call still succeeds when the agent directory cannot be created", async () => {
  const f = makeFixture();
  try {
    // A regular file where the agent directory belongs makes the mkdir fail (Section 4).
    writeFileSync(f.agentDir, "");
    const result = await call(f, { command: "echo hi" });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "hi");
    const row = at(f.registry.list(), 0);
    assert.equal(row.status, "completed");
    assert.ok(!existsSync(outputPathOf(f, row.taskId)));
  } finally {
    f.cleanup();
  }
});

test("foreground: a nonzero exit carries the status line, the code and a failed row", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "echo out; exit 3" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "out\n\nCommand exited with code 3");
    assert.equal(detailsOf(result).exitReason, "exited");
    assert.equal(detailsOf(result).exitCode, 3);
    assert.equal(at(f.registry.list(), 0).status, "failed");
  } finally {
    f.cleanup();
  }
});

test("foreground: no output and no status line is `(no output)`", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "true" });
    assert.equal(textOf(result), "(no output)");
    assert.equal(result.isError, undefined);
    assert.equal(detailsOf(result).truncated, false);
  } finally {
    f.cleanup();
  }
});

test("capture: stdout and stderr both reach the output in arrival order", async () => {
  const f = makeFixture();
  try {
    // The sleeps make the arrival order across the two pipes deterministic.
    const result = await call(f, {
      command: "echo one; sleep 0.1; echo two >&2; sleep 0.1; echo three",
    });
    assert.equal(textOf(result), "one\ntwo\nthree");
  } finally {
    f.cleanup();
  }
});

test("capture: a multi-byte character split across chunks decodes whole", async () => {
  const f = makeFixture();
  try {
    // The two halves of 三 (U+4E09) arrive in separate chunks.
    const result = await call(f, { command: "printf '\\344\\270'; sleep 0.2; printf '\\211\\n'" });
    assert.equal(textOf(result), "三");
    assert.ok(!textOf(result).includes("\uFFFD"));
  } finally {
    f.cleanup();
  }
});

test("capture: stdin is empty, so `cat` returns at once", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "cat; echo after" });
    assert.equal(textOf(result), "after");
  } finally {
    f.cleanup();
  }
});

test("invocation: the shell command prefix is prepended with one newline", async () => {
  const f = makeFixture({ settings: { shellCommandPrefix: "echo prefix" } });
  try {
    const result = await call(f, { command: "echo command" });
    assert.equal(textOf(result), "prefix\ncommand");
  } finally {
    f.cleanup();
  }
});

test("settings: both host settings are read on every call", async () => {
  let reads = 0;
  const f = makeFixture({
    settingsFn: () => {
      reads += 1;
      return {};
    },
  });
  try {
    await call(f, { command: "true" });
    await call(f, { command: "true" });
    assert.equal(reads, 2);
  } finally {
    f.cleanup();
  }
});

test("settings: a configured shell is used, and a missing one is unresolvable", async () => {
  const f = makeFixture({ settings: { shellPath: "/bin/sh" } });
  try {
    const result = await call(f, { command: "echo sh" });
    assert.equal(textOf(result), "sh");
  } finally {
    f.cleanup();
  }
});

test("cwd: a relative value resolves against the session cwd", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "pwd", cwd: "." });
    assert.equal(textOf(result), realpathSync(f.root));
  } finally {
    f.cleanup();
  }
});

test("label: description, else the command's first non-blank line without leading white space, cut to 80", async () => {
  const f = makeFixture();
  try {
    await call(f, { command: "true", description: "my label" });
    await call(f, { command: `\n\n   echo ${"x".repeat(200)}` });
    const rows = f.registry.list();
    assert.equal(at(rows, 0).label, "my label");
    assert.equal(at(rows, 1).label, `echo ${"x".repeat(75)}`.slice(0, 80));
    assert.equal(at(rows, 1).label.length, 80);
  } finally {
    f.cleanup();
  }
});

test("environment: PATH gains the agent bin directory, the session values are set", async () => {
  const f = makeFixture({
    host: {
      model: () => ({ provider: "prov", id: "mod" }),
      thinking: () => "high",
      sessionFile: () => "/tmp/session.jsonl",
    },
  });
  const saved = process.env.PI_DENT_SESSION_DIR;
  const savedPath = process.env.PATH;
  // About 2000 characters of dummy entries: the PATH line is cut in the excerpt, so the test reads the saved output.
  const dummies = Array.from({ length: 40 }, (_, i) => `/pi-dent-dummy-${i}-${"d".repeat(40)}`);
  process.env.PATH = [...dummies, savedPath ?? ""].join(delimiter);
  try {
    const bin = join(getAgentDir(), "bin");
    const result = await call(f, {
      command: [
        'echo "path:[$PATH]"',
        'echo "dir:[$PI_DENT_SESSION_DIR]"',
        'echo "id:[$PI_SESSION_ID]"',
        'echo "file:[$PI_SESSION_FILE]"',
        'echo "provider:[$PI_PROVIDER]"',
        'echo "model:[$PI_MODEL]"',
        'echo "thinking:[$PI_REASONING_LEVEL]"',
      ].join("; "),
    });
    assert.equal(detailsOf(result).exitReason, "exited", textOf(result));
    const text = readFileSync(String(detailsOf(result).outputPath), "utf8");
    const pathLine = text.split("\n").find((line) => line.startsWith("path:[")) ?? "";
    const entries = pathLine.slice("path:[".length, -1).split(delimiter);
    assert.equal(entries.filter((entry) => entry === bin).length, 1, pathLine);
    assert.ok(entries.includes(bin), pathLine);
    assert.ok(text.includes(`dir:[${f.sessionDir}]`), text);
    assert.ok(text.includes(`id:[${f.host.sessionId()}]`), text);
    assert.ok(text.includes("file:[/tmp/session.jsonl]"), text);
    assert.ok(text.includes("provider:[prov]"), text);
    assert.ok(text.includes("model:[mod]"), text);
    assert.ok(text.includes("thinking:[high]"), text);
  } finally {
    if (saved === undefined) delete process.env.PI_DENT_SESSION_DIR;
    else process.env.PI_DENT_SESSION_DIR = saved;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    f.cleanup();
  }
});

test("environment: a value the session lacks is absent whatever the process holds", async () => {
  const f = makeFixture();
  const saved = {
    PI_MODEL: process.env.PI_MODEL,
    PI_PROVIDER: process.env.PI_PROVIDER,
    PI_REASONING_LEVEL: process.env.PI_REASONING_LEVEL,
  };
  process.env.PI_MODEL = "leaked-model";
  process.env.PI_PROVIDER = "leaked-provider";
  process.env.PI_REASONING_LEVEL = "leaked-level";
  try {
    const result = await call(f, {
      command: 'echo "model:[$PI_MODEL] provider:[$PI_PROVIDER] thinking:[$PI_REASONING_LEVEL]"',
    });
    assert.equal(textOf(result), "model:[] provider:[] thinking:[]");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    f.cleanup();
  }
});

test("environment: extraEnv overrides the session value without mutating process.env", async () => {
  let childDir = "";
  const f = makeFixture({ extraEnv: () => ({ PI_DENT_SESSION_DIR: childDir }) });
  childDir = join(f.root, "child");
  const saved = process.env.PI_DENT_SESSION_DIR;
  process.env.PI_DENT_SESSION_DIR = "/main/dir";
  try {
    const result = await call(f, { command: 'echo "dir:[$PI_DENT_SESSION_DIR]"' });
    assert.equal(textOf(result), `dir:[${childDir}]`);
    assert.equal(process.env.PI_DENT_SESSION_DIR, "/main/dir");
  } finally {
    if (saved === undefined) delete process.env.PI_DENT_SESSION_DIR;
    else process.env.PI_DENT_SESSION_DIR = saved;
    f.cleanup();
  }
});

test("temporary folder: TMPDIR, TMP and TEMP name the session tmp folder, which exists", async () => {
  const f = makeFixture();
  try {
    const tmp = join(f.sessionDir, "tmp");
    const result = await call(f, { command: 'printf "%s\\n" "$TMPDIR" "$TMP" "$TEMP"' });
    assert.equal(textOf(result), `${tmp}\n${tmp}\n${tmp}`);
    assert.ok(statSync(tmp).isDirectory());
  } finally {
    f.cleanup();
  }
});

test("temporary folder: mktemp with a template under $TMPDIR creates its file in the session tmp folder", async () => {
  const f = makeFixture();
  try {
    // A bare `mktemp` ignores TMPDIR on macOS, so the template names the folder.
    const path = textOf(await call(f, { command: 'mktemp "$TMPDIR/pi-dent.XXXXXX"' }));
    assert.equal(dirname(path), join(f.sessionDir, "tmp"));
    assert.ok(existsSync(path));
  } finally {
    f.cleanup();
  }
});

test("temporary folder: with no session dir the process's temp values pass through", async () => {
  const saved = {
    PI_DENT_SESSION_DIR: process.env.PI_DENT_SESSION_DIR,
    TMPDIR: process.env.TMPDIR,
  };
  const processTmp = process.env.TMP ?? "";
  const processTemp = process.env.TEMP ?? "";
  const f = makeFixture({ extraEnv: () => undefined });
  delete process.env.PI_DENT_SESSION_DIR;
  process.env.TMPDIR = "/pass/through";
  try {
    const result = await call(f, { command: 'echo "$TMPDIR|$TMP|$TEMP"' });
    assert.equal(textOf(result), `/pass/through|${processTmp}|${processTemp}`);
    assert.equal(existsSync(join(f.sessionDir, "tmp")), false);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    f.cleanup();
  }
});

test("temporary folder: a session dir that cannot hold the tmp folder leaves the three variables absent", async () => {
  const f = makeFixture();
  try {
    // A regular file where the session dir belongs makes the folder's creation fail.
    writeFileSync(f.sessionDir, "");
    const result = await call(f, { command: 'echo "[$TMPDIR][$TMP][$TEMP]"' });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "[][][]");
  } finally {
    f.cleanup();
  }
});

test("timeout: the run is killed, reports the timeout and fails the row", async () => {
  const f = makeFixture();
  try {
    const started = Date.now();
    const result = await call(f, { command: "sleep 5; echo late", timeout: 200 });
    const elapsed = Date.now() - started;
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "Command timed out after 200 ms");
    assert.equal(detailsOf(result).exitReason, "timeout");
    assert.ok(!("exitCode" in detailsOf(result)), "no exitCode for a timeout");
    assert.equal(detailsOf(result).leftover, false);
    assert.equal(at(f.registry.list(), 0).status, "failed");
    assert.ok(elapsed < 3000, `took ${elapsed} ms`);
  } finally {
    f.cleanup();
  }
});

test("end: a timeout run does not end when the pipes close before the shell exits", async () => {
  const f = makeFixture();
  try {
    // The shell ignores SIGTERM, points both pipes away at 200 ms, then lives
    // until the SIGKILL at 300 ms; the run ends with the shell (Section 3).
    const started = Date.now();
    const result = await call(f, {
      command: "trap '' TERM; sleep 0.2; exec >/dev/null 2>/dev/null; sleep 3",
      timeout: 50,
    });
    const elapsed = Date.now() - started;
    const details = detailsOf(result);
    assert.equal(details.exitReason, "timeout");
    assert.ok(Number(details.durationMs) >= 250, `durationMs ${String(details.durationMs)}`);
    assert.ok(elapsed >= 250, `took ${elapsed} ms`);
    assert.ok(elapsed < 3000, `took ${elapsed} ms`);
  } finally {
    f.cleanup();
  }
});

test("timeout: SIGKILL follows SIGTERM when the shell ignores the term signal", async () => {
  const f = makeFixture();
  try {
    const started = Date.now();
    const result = await call(f, { command: "trap '' TERM; sleep 5", timeout: 150 });
    const elapsed = Date.now() - started;
    assert.equal(textOf(result), "Command timed out after 150 ms");
    // SIGTERM at 150 ms, SIGKILL 250 ms later: the run ends near 400 ms.
    assert.ok(elapsed >= 350, `took ${elapsed} ms`);
    assert.ok(elapsed < 3000, `took ${elapsed} ms`);
  } finally {
    f.cleanup();
  }
});

test("abort: a signal already aborted prevents the spawn", async () => {
  const f = makeFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await call(f, { command: "echo should-not-run" }, controller.signal);
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "Command aborted");
    assert.equal(detailsOf(result).durationMs, 0);
    assert.equal(detailsOf(result).leftover, false);
    const row = at(f.registry.list(), 0);
    assert.equal(row.status, "cancelled");
    assert.ok(!existsSync(String(detailsOf(result).outputPath)), "no output file");
  } finally {
    f.cleanup();
  }
});

test("abort: a background call ignores an already-aborted signal (Section 6)", async () => {
  const f = makeFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await call(f, { command: "echo ran", background: true }, controller.signal);
    assert.equal(result.isError, undefined);
    const details = detailsOf(result);
    assert.equal(details.exitReason, "running");
    assert.equal(details.background, true);
    const row = at(f.registry.list(), 0);
    assert.equal(row.status, "running");
    await waitFor(() => row.status !== "running");
    assert.equal(row.status, "completed");
    assert.equal(row.result, "ran");
  } finally {
    f.cleanup();
  }
});

test("abort: a foreground run is terminated and reported as aborted", async () => {
  const f = makeFixture();
  try {
    const controller = new AbortController();
    const started = Date.now();
    const pending = call(
      f,
      { command: "echo started; sleep 5", timeout: undefined },
      controller.signal,
    );
    await new Promise((done) => setTimeout(done, 200));
    controller.abort();
    const result = await pending;
    const elapsed = Date.now() - started;
    assert.equal(result.isError, true);
    assert.ok(textOf(result).startsWith("started\n\nCommand aborted"), textOf(result));
    assert.equal(detailsOf(result).exitReason, "aborted");
    assert.equal(at(f.registry.list(), 0).status, "cancelled");
    assert.ok(elapsed < 3000, `took ${elapsed} ms`);
  } finally {
    f.cleanup();
  }
});

test("kill: the row's cancellation handler reports `Command killed`", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "sleep 5", background: true });
    assert.equal(result.isError, undefined);
    const taskId = String(detailsOf(result).taskId);
    const row = f.registry.get(taskId);
    assert.ok(row !== undefined);
    f.registry.cancel(row);
    await waitFor(() => row.status !== "running");
    const body = row.result ?? "";
    assert.ok(body.includes("Command killed"), body);
    assert.equal(row.status, "cancelled");
    assert.equal(row.resultPath, detailsOf(result).outputPath);
  } finally {
    f.cleanup();
  }
});

test("browser kill: a foreground run's result names the user (Sections 5, 6)", async () => {
  const f = makeFixture();
  try {
    const pending = call(f, { command: "sleep 5" });
    const row = at(f.registry.list(), 0);
    assert.equal(row.status, "running");
    // The task browser's kill key: a browser kill in the registry that holds the row.
    f.registry.cancel(row, true);
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "Command killed by the user from the task browser");
    assert.equal(detailsOf(result).exitReason, "killed");
    assert.equal(row.status, "cancelled");
    assert.equal(row.browserKill, true);
    assert.equal(row.result, textOf(result));
  } finally {
    f.cleanup();
  }
});

test("leftover: a `cmd &` process is terminated with the notice and a bounded run", async () => {
  const f = makeFixture();
  try {
    const marker = join(f.root, "marker");
    const started = Date.now();
    const result = await call(f, { command: `(sleep 1; touch ${marker}) & echo hi` });
    const elapsed = Date.now() - started;
    assert.equal(
      textOf(result),
      "hi\n\nCommand left a process running; it was terminated. Use background: true, not & or nohup.",
    );
    const details = detailsOf(result);
    assert.equal(details.leftover, true);
    assert.ok(elapsed < 2500, `took ${elapsed} ms`);
    assert.equal(at(f.registry.list(), 0).status, "completed");
    // The leftover process is dead: its marker never appears.
    await new Promise((done) => setTimeout(done, 1500));
    assert.ok(!existsSync(marker), "the leftover process was terminated");
  } finally {
    f.cleanup();
  }
});

test("leftover: SIGKILL follows SIGTERM when the leftover ignores the term signal", async () => {
  const f = makeFixture();
  try {
    const ready = join(f.root, "ready");
    const started = Date.now();
    // The subshell ignores SIGTERM and holds the pipes open; only the SIGKILL
    // 250 ms after the shell exits ends it, well before the 1000 ms pipe bound.
    // The shell exits only once the subshell has installed its trap.
    const result = await call(f, {
      command: `(trap '' TERM; touch ${ready}; while :; do sleep 0.05; done) & until [ -e ${ready} ]; do sleep 0.01; done; echo hi`,
    });
    const elapsed = Date.now() - started;
    assert.equal(detailsOf(result).leftover, true);
    assert.ok(elapsed >= 200, `took ${elapsed} ms`);
    assert.ok(elapsed < 950, `took ${elapsed} ms`);
    assert.equal(
      textOf(result),
      "hi\n\nCommand left a process running; it was terminated. Use background: true, not & or nohup.",
    );
  } finally {
    f.cleanup();
  }
});

test("leftover: the SIGKILL still follows when the run ends before it is due", async () => {
  const f = makeFixture();
  try {
    const marker = join(f.root, "marker");
    const started = Date.now();
    // The leftover ignores SIGTERM and sends its output to /dev/null, so both
    // pipes close at the exit and the run ends long before the 250 ms SIGKILL;
    // the group must still be killed afterwards. The shell exits only once the
    // leftover has installed its trap and written the marker.
    const result = await call(f, {
      command: `i=0; (trap '' TERM; while :; do i=$((i+1)); echo $i > ${marker}; sleep 0.05; done) >/dev/null 2>&1 & until [ -s ${marker} ]; do sleep 0.01; done; echo hi`,
    });
    const elapsed = Date.now() - started;
    assert.equal(detailsOf(result).leftover, true);
    assert.ok(elapsed < 200, `took ${elapsed} ms`);
    assert.equal(
      textOf(result),
      "hi\n\nCommand left a process running; it was terminated. Use background: true, not & or nohup.",
    );
    await new Promise((done) => setTimeout(done, 600));
    const before = readFileSync(marker, "utf8");
    assert.ok(before !== "", "the leftover was running");
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(readFileSync(marker, "utf8"), before, "the leftover was terminated");
  } finally {
    f.cleanup();
  }
});

test("leftover: false when the group signal reaches no process", async () => {
  const f = makeFixture();
  const original = process.kill;
  try {
    const marker = join(f.root, "marker");
    // `kill` fails as a whole: EPERM (no member signalable) delivered the signal
    // to no process, so the run claims no leftover (Section 3).
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid < 0) {
        const error: NodeJS.ErrnoException = new Error("kill EPERM");
        error.code = "EPERM";
        throw error;
      }
      return original(pid, signal);
    }) as typeof process.kill;
    const result = await call(f, { command: `(sleep 0.3; touch ${marker}) & echo hi` });
    assert.equal(detailsOf(result).leftover, false);
    assert.equal(textOf(result), "hi");
    assert.equal(at(f.registry.list(), 0).status, "completed");
    // Nothing was signalled, so the process ran to completion.
    await new Promise((done) => setTimeout(done, 700));
    assert.ok(existsSync(marker), "the process was not signalled");
  } finally {
    process.kill = original;
    f.cleanup();
  }
});

test("leftover: the notice follows the status line in the body", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "sleep 3 & exit 2" });
    const parts = textOf(result).split("\n\n");
    assert.deepEqual(parts, [
      "Command exited with code 2",
      "Command left a process running; it was terminated. Use background: true, not & or nohup.",
    ]);
    assert.equal(detailsOf(result).leftover, true);
  } finally {
    f.cleanup();
  }
});

test("redirect notice: recognizes file redirects and excludes non-redirects", async () => {
  const f = makeFixture();
  try {
    const yes = [
      "cmd >f",
      "cmd 1>f",
      "cmd 3> f",
      "echo a>f",
      "cmd &>> f",
      "cmd >| f",
      'cmd > "a b"',
      "cmd > f 2>/dev/null",
      "cmd > f 2> err",
      'echo "a > b" > f',
      "cmd 2> e > f",
      "cmd > /dev/null 2> err",
    ];
    const no = [
      "cmd > /dev/null",
      "cmd 2>&1",
      "echo '>'",
      'echo "a > b"',
      "echo a \\> b",
      "cmd > f; echo done",
      "echo hi",
      "cmd 2>/dev/null",
      "cmd >&2",
      "cmd > f &",
    ];
    for (const command of yes) {
      const result = await call(f, { command });
      assert.ok(textOf(result).includes("Note: output redirected to a file"), command);
    }
    for (const command of no) {
      const result = await call(f, { command });
      assert.ok(!textOf(result).includes("Note: output redirected to a file"), command);
    }
    const pipeNotice =
      "Note: the saved output holds only what the final pipe printed; rerun without the pipe to keep it all.";
    const redirectNotice =
      "Note: output redirected to a file is not shown or saved by Bash; run the command plainly to have its output saved for Read or rg.";
    assert.equal(textOf(await call(f, { command: "printf a | grep a > f" })), redirectNotice);
    assert.equal(
      textOf(await call(f, { command: "printf a | grep a 2> e" })),
      `a\n\n${pipeNotice}\n\n${redirectNotice}`,
    );
    assert.equal(textOf(await call(f, { command: "true > f >&2" })), redirectNotice);
    for (const command of ['echo "x > y" | grep x 2> e', "cmd > f; printf a | grep a 2> e"]) {
      const text = textOf(await call(f, { command }));
      assert.ok(text.includes(pipeNotice), command);
      assert.ok(text.includes(redirectNotice), command);
    }
  } finally {
    f.cleanup();
  }
});

test("background: the call returns at once with the task id and the output path", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "sleep 1; echo done", background: true });
    assert.equal(result.isError, undefined);
    const details = detailsOf(result);
    assert.equal(
      textOf(result),
      `Command started in background (taskId ${details.taskId}).\nOutput: ${details.outputPath}`,
    );
    assert.deepEqual(details, {
      taskId: details.taskId,
      outputPath: details.outputPath,
      background: true,
      exitReason: "running",
      truncated: false,
      leftover: false,
      durationMs: 0,
    });
    const row = at(f.registry.list(), 0);
    assert.equal(row.status, "running");
    assert.equal(row.background, true);
    assert.equal(row.consumed, false);
    await waitFor(() => row.status !== "running");
    assert.equal(row.status, "completed");
    assert.equal(row.result, "done");
    assert.equal(row.resultPath, details.outputPath);
    assert.equal(readFileSync(String(details.outputPath), "utf8"), "done\n");
  } finally {
    f.cleanup();
  }
});

test("background: a nonzero exit settles the row failed with the status line", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "exit 4", background: true });
    const row = at(f.registry.list(), 0);
    await waitFor(() => row.status !== "running");
    assert.equal(row.status, "failed");
    assert.equal(row.result, "Command exited with code 4");
    assert.equal(detailsOf(result).exitReason, "running");
  } finally {
    f.cleanup();
  }
});

test("background: a spawn failure still returns the background text and settles the row", async () => {
  const f = makeFixture();
  try {
    const shell = join(f.root, "not-executable.sh");
    writeFileSync(shell, "#!/bin/sh\necho hi\n");
    chmodSync(shell, 0o644);
    const settings: BashSettings = { shellPath: shell };
    const tool = makeBashTool({ ...f.deps, settings: () => settings });
    const result = await tool.execute(
      "call-1",
      { command: "echo hi", background: true } as never,
      undefined,
      undefined,
      noCtx,
    );
    const details = detailsOf(result);
    assert.equal(result.isError, undefined);
    assert.equal(
      textOf(result),
      `Command started in background (taskId ${details.taskId}).\nOutput: ${details.outputPath}`,
    );
    assert.equal(details.exitReason, "running");
    const row = at(f.registry.list(), 0);
    await waitFor(() => row.status !== "running");
    assert.equal(row.status, "failed");
    assert.match(row.result ?? "", /^Command failed to start: /);
    const foreground = await tool.execute(
      "call-2",
      { command: "echo hi" } as never,
      undefined,
      undefined,
      noCtx,
    );
    assert.equal(foreground.isError, true);
    assert.match(textOf(foreground), /^Command failed to start: /);
    assert.equal(detailsOf(foreground).durationMs, 0);
    assert.ok(!("exitCode" in detailsOf(foreground)));
    assert.equal(at(f.registry.list(), 1).status, "failed");
  } finally {
    f.cleanup();
  }
});

test("foreground: output arrives as partial results", async () => {
  const f = makeFixture();
  try {
    const seen: string[] = [];
    const result = await call(
      f,
      { command: "echo one; sleep 0.3; echo two; sleep 0.3; echo three" },
      undefined,
      (partial) => {
        seen.push(textOf(partial));
      },
    );
    assert.equal(textOf(result), "one\ntwo\nthree");
    assert.ok(seen.length >= 2, `partial updates: ${seen.length}`);
    assert.ok(
      seen.some((text) => text.includes("one") && !text.includes("two")),
      seen.join("|"),
    );
  } finally {
    f.cleanup();
  }
});

test("progress: one entry per line once its newline arrived, plus the last line at the end", async () => {
  const f = makeFixture();
  try {
    await call(f, { command: "printf 'a\\nb\\nc'" });
    const row = at(f.registry.list(), 0);
    assert.deepEqual(
      row.progress.map((entry) => entry.line),
      ["a", "b", "c"],
    );
  } finally {
    f.cleanup();
  }
});

test("timing: the first leftover signal follows the exit within 100 ms", async () => {
  const f = makeFixture();
  let polling = true;
  let observation: Promise<void> | undefined;
  try {
    const term = join(f.root, "term");
    const kill = join(f.root, "kill");
    // Two group members write a counter every 10 ms: the first dies on SIGTERM,
    // the second ignores it and dies on the SIGKILL. The shell exits only once
    // both have written, so the second has installed its trap.
    const command = [
      `( i=0; while :; do i=$((i+1)); echo $i > ${term}; sleep 0.01; done ) >/dev/null 2>&1 &`,
      `( trap '' TERM; j=0; while :; do j=$((j+1)); echo $j > ${kill}; sleep 0.01; done ) >/dev/null 2>&1 &`,
      `until [ -s ${term} ] && [ -s ${kill} ]; do sleep 0.01; done`,
      // Observe several counter changes before the shell exits.
      "sleep 0.5",
      "echo hi",
    ].join("\n");
    const readOr = (path: string): string => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };
    const last = new Map<string, number>([
      [term, 0],
      [kill, 0],
    ]);
    const seen = new Map<string, string>([
      [term, ""],
      [kill, ""],
    ]);
    let exitAt = Infinity;
    let cadence = 0;
    observation = (async () => {
      while (polling && Date.now() < exitAt + 700 + 2 * cadence) {
        for (const path of [term, kill]) {
          const content = readOr(path);
          // Ignore the empty interval between truncating and writing a counter.
          if (content !== "" && content !== seen.get(path)) {
            const now = Date.now();
            const previous = last.get(path) ?? 0;
            if (now < exitAt && previous !== 0) {
              cadence = Math.max(cadence, now - previous);
            }
            seen.set(path, content);
            last.set(path, now);
          }
        }
        await new Promise((done) => setTimeout(done, 5));
      }
    })();
    const result = await call(f, { command });
    exitAt = Date.now();
    assert.equal(detailsOf(result).leftover, true);
    await observation;
    const termAt = last.get(term) ?? 0;
    const killAt = last.get(kill) ?? 0;
    // Measured write/poll lag, with floors preserving the quiet-machine bounds.
    const firstSlack = Math.max(100, cadence);
    const earlySlack = Math.max(50, cadence);
    const lateSlack = Math.max(150, cadence);
    assert.ok(
      termAt - exitAt <= 100 + firstSlack,
      `first signal after ${termAt - exitAt} ms (slack ${firstSlack} ms)`,
    );
    assert.ok(killAt > termAt, "the second member survived the SIGTERM");
    // The grace is 200–300 ms; 250 minus 50 retains the previous lower bound.
    assert.ok(
      killAt - termAt >= 250 - earlySlack,
      `SIGKILL after ${killAt - termAt} ms (slack ${earlySlack} ms)`,
    );
    assert.ok(
      killAt - termAt <= 300 + lateSlack,
      `SIGKILL after ${killAt - termAt} ms (slack ${lateSlack} ms)`,
    );
  } finally {
    polling = false;
    await observation;
    f.cleanup();
  }
});

test("background: a settlement failure does not escape as an unhandled rejection", async () => {
  const f = makeFixture();
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    const inner = f.registry;
    const wrapping = Object.create(inner) as unknown as TaskRegistry;
    let armed = false;
    wrapping.settle = (...args: Parameters<TaskRegistry["settle"]>) => {
      if (!armed) {
        inner.settle(...args);
        return;
      }
      armed = false;
      throw new Error("settle boom");
    };
    f.deps.registry = () => wrapping;
    const result = await call(f, { command: "echo done", background: true });
    assert.equal(result.isError, undefined);
    armed = true;
    await new Promise((done) => setTimeout(done, 400));
    assert.deepEqual(rejections, []);
    assert.equal(at(f.registry.list(), 0).status, "failed");
  } finally {
    process.off("unhandledRejection", onRejection);
    f.cleanup();
  }
});

// Two writes exercise capped progress entries for a line spanning chunks.
const longLine = (tail: string, lead = 60000, rest = 10000): string =>
  `node -e 'process.stdout.write("a".repeat(${lead})); setTimeout(() => process.stdout.write("a".repeat(${rest}) + "${tail}"), 100)'`;

test("progress: a terminated long line is capped at its first 500 code points", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: longLine("\\n") });
    const row = at(f.registry.list(), 0);
    const line = at(row.progress, 0).line;
    assert.equal(line, "a".repeat(500) + " … [69500 characters omitted]");
    assert.equal(detailsOf(result).truncated, true);
    assert.ok(textOf(result).startsWith("[The output's end is shown (1 line"), textOf(result));
  } finally {
    f.cleanup();
  }
});

test("progress: an unterminated long line is capped at its first 500 code points", async () => {
  const f = makeFixture();
  try {
    await call(f, { command: longLine("") });
    const row = at(f.registry.list(), 0);
    assert.equal(row.progress.length, 1);
    assert.equal(at(row.progress, 0).line, "a".repeat(500) + " … [69500 characters omitted]");
  } finally {
    f.cleanup();
  }
});

async function emitOutput(f: Fixture, text: string, onUpdate?: (partial: ToolResult) => void) {
  writeFileSync(join(f.root, "input.txt"), text);
  return call(f, { command: "cat input.txt" }, undefined, onUpdate);
}

test("excerpt: fifty lines come back whole, fifty-one show only the last fifty", async () => {
  const f = makeFixture();
  try {
    for (const finalNewline of ["", "\n"]) {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
      const whole = await emitOutput(f, lines.join("\n") + finalNewline);
      assert.equal(textOf(whole), lines.join("\n"));
      assert.equal(whole.details.truncated, false);
      assert.equal(textOf(whole).includes(String(whole.details.outputPath)), false);
      lines.push("line 51");
      const cut = await emitOutput(f, lines.join("\n") + finalNewline);
      assert.equal(
        textOf(cut),
        `[Line 1 of 51 not shown; full output: ${cut.details.outputPath}. Search it with rg or Read it.]\n` +
          lines.slice(1).join("\n"),
      );
      assert.equal(cut.details.truncated, true);
      assert.equal(
        readFileSync(String(cut.details.outputPath), "utf8"),
        lines.join("\n") + finalNewline,
      );
    }
  } finally {
    f.cleanup();
  }
});

test("excerpt: sixteen lines come back whole, with no header", async () => {
  const f = makeFixture();
  try {
    const lines = Array.from({ length: 16 }, (_, i) => `row ${i + 1}`);
    const result = await emitOutput(f, lines.join("\n") + "\n");
    assert.equal(textOf(result), lines.join("\n"));
    assert.equal(result.details.truncated, false);
  } finally {
    f.cleanup();
  }
});

test("excerpt: the header names a file that exists and holds the full output", async () => {
  const f = makeFixture();
  try {
    const text = Array.from({ length: 60 }, (_, i) => `entry ${i + 1}`).join("\n");
    const result = await emitOutput(f, text);
    const path = String(result.details.outputPath);
    assert.equal(
      textOf(result).split("\n")[0],
      `[Lines 1–10 of 60 not shown; full output: ${path}. Search it with rg or Read it.]`,
    );
    assert.equal(readFileSync(path, "utf8"), text);
    assert.ok(!readFileSync(path, "utf8").includes("not shown"));
  } finally {
    f.cleanup();
  }
});

test("excerpt: 59 lines name the 9 lines not shown at the start", async () => {
  const f = makeFixture();
  try {
    const lines = Array.from({ length: 59 }, (_, i) => `row ${i + 1}`);
    const result = await emitOutput(f, lines.join("\n"));
    assert.equal(
      textOf(result),
      `[Lines 1–9 of 59 not shown; full output: ${result.details.outputPath}. Search it with rg or Read it.]\n` +
        lines.slice(9).join("\n"),
    );
  } finally {
    f.cleanup();
  }
});

test("excerpt: a few very long lines show the end-of-output header form", async () => {
  const f = makeFixture();
  try {
    const lines = ["a", "b", "c"].map((c) => c.repeat(600));
    const text = lines.join("\n");
    const result = await emitOutput(f, text);
    const path = result.details.outputPath;
    assert.equal(
      textOf(result),
      `[The output's end is shown (3 lines, ${Buffer.byteLength(text)} bytes), long lines cut to their last 500 characters; full output: ${path}. Search it with rg or Read it.]\n` +
        ["a", "b", "c"].map((c) => `… ${c.repeat(500)}`).join("\n"),
    );
  } finally {
    f.cleanup();
  }
});

test("excerpt: six and seven lines come back whole, and fourteen 300-character lines keep only their last thirteen", async () => {
  const f = makeFixture();
  try {
    for (const count of [6, 7]) {
      for (const newline of ["", "\n"]) {
        const text = Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");
        const result = await emitOutput(f, text + newline);
        assert.equal(textOf(result), text);
        assert.equal(result.details.truncated, false);
      }
    }
    const lines = Array.from({ length: 14 }, (_, i) => `${i}`.padEnd(300, "x"));
    const tail = await emitOutput(f, lines.join("\n"));
    assert.equal(
      textOf(tail),
      `[Line 1 of 14 not shown; full output: ${tail.details.outputPath}. Search it with rg or Read it.]\n` +
        lines.slice(-13).join("\n"),
    );
  } finally {
    f.cleanup();
  }
});

test("excerpt: a CRLF output shows without its CR, and the saved file keeps it", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "printf 'a\\r\\nb\\r\\n'" });
    assert.equal(textOf(result), "a\nb");
    assert.equal(readFileSync(String(result.details.outputPath), "utf8"), "a\r\nb\r\n");
  } finally {
    f.cleanup();
  }
});

test("excerpt: an empty last line of a CRLF tail is shown as an empty line", async () => {
  const f = makeFixture();
  try {
    const lines = Array.from({ length: 60 }, (_, i) => `l${i + 1}`);
    const result = await call(f, {
      command: "for i in $(seq 1 60); do printf 'l%s\\r\\n' $i; done; printf '\\n'",
    });
    assert.equal(
      textOf(result),
      `[Lines 1–11 of 61 not shown; full output: ${result.details.outputPath}. Search it with rg or Read it.]\n` +
        [...lines.slice(11), ""].join("\n"),
    );
  } finally {
    f.cleanup();
  }
});

test("excerpt: 500 code points fit, and a cut single line keeps its last 500 without splitting astral characters", async () => {
  const f = makeFixture();
  try {
    const wholeText = "😀".repeat(500);
    const whole = await emitOutput(f, wholeText);
    assert.equal(textOf(whole), wholeText);
    assert.equal(whole.details.truncated, false);
    const text = "a".repeat(249) + "😀" + "é" + "🚀" + "z".repeat(249);
    const cut = await emitOutput(f, text);
    assert.equal(
      textOf(cut),
      `[The output's end is shown (1 line, ${Buffer.byteLength(text)} bytes), long lines cut to their last 500 characters; full output: ${cut.details.outputPath}. Search it with rg or Read it.]\n` +
        "… " +
        "a".repeat(248) +
        "😀é🚀" +
        "z".repeat(249),
    );
    assert.equal(cut.details.truncated, true);
  } finally {
    f.cleanup();
  }
});

test("excerpt: a multiline cut keeps the last 500 code points of its line", async () => {
  const f = makeFixture();
  try {
    const text = "a".repeat(499) + "😀é\nshort";
    const cut = await emitOutput(f, text);
    assert.equal(
      textOf(cut),
      `[The output's end is shown (2 lines, ${Buffer.byteLength(text)} bytes), long lines cut to their last 500 characters; full output: ${cut.details.outputPath}. Search it with rg or Read it.]\n` +
        "… " +
        "a".repeat(498) +
        "😀é\nshort",
    );
    assert.equal(cut.details.truncated, true);
  } finally {
    f.cleanup();
  }
});

test("excerpt: one MB without a newline and three 100 KB lines stay bounded", async () => {
  const f = makeFixture();
  try {
    const size = 1024 * 1024;
    const text = "a".repeat(size - 3) + "END";
    const cut = await emitOutput(f, text);
    assert.equal(
      textOf(cut),
      `[The output's end is shown (1 line, ${size} bytes), long lines cut to their last 500 characters; full output: ${cut.details.outputPath}. Search it with rg or Read it.]\n` +
        "… " +
        "a".repeat(497) +
        "END",
    );
    assert.equal(cut.details.truncated, true);
    assert.equal(readFileSync(String(cut.details.outputPath), "utf8"), text);
    const lines = ["a", "b", "c"].map((c) => c.repeat(100 * 1024));
    const multi = await emitOutput(f, lines.join("\n"));
    assert.equal(
      textOf(multi),
      `[The output's end is shown (3 lines, ${Buffer.byteLength(lines.join("\n"))} bytes), long lines cut to their last 500 characters; full output: ${multi.details.outputPath}. Search it with rg or Read it.]\n` +
        ["a", "b", "c"].map((c) => `… ${c.repeat(500)}`).join("\n"),
    );
    assert.equal(multi.details.truncated, true);
    assert.ok(Array.from(textOf(multi)).length < 2000);
    assert.equal(readFileSync(String(multi.details.outputPath), "utf8"), lines.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("header: a 1500-character line shows its last 500, and the header form counts one line", async () => {
  const f = makeFixture();
  try {
    const cutOnly = await emitOutput(f, "y".repeat(1500));
    assert.equal(
      textOf(cutOnly),
      `[The output's end is shown (1 line, 1500 bytes), long lines cut to their last 500 characters; full output: ${cutOnly.details.outputPath}. Search it with rg or Read it.]\n` +
        "… " +
        "y".repeat(500),
    );

    const omittedOnly = await emitOutput(
      f,
      Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n"),
    );
    assert.equal(
      textOf(omittedOnly),
      `[Lines 1–10 of 60 not shown; full output: ${omittedOnly.details.outputPath}. Search it with rg or Read it.]\n` +
        Array.from({ length: 50 }, (_, i) => `l${i + 10}`).join("\n"),
    );

    const lines = Array.from({ length: 52 }, (_, i) => `l${i}`);
    lines[51] = "z".repeat(600);
    const both = await emitOutput(f, lines.join("\n"));
    assert.equal(
      textOf(both),
      `[Lines 1–2 of 52 not shown, long lines cut to their last 500 characters; full output: ${both.details.outputPath}. Search it with rg or Read it.]\n` +
        [...lines.slice(2, 51), `… ${"z".repeat(500)}`].join("\n"),
    );
  } finally {
    f.cleanup();
  }
});

test("pipe notice: a head, tail, or grep last stage adds one line after the excerpt", async () => {
  const f = makeFixture();
  const notice =
    "Note: the saved output holds only what the final pipe printed; rerun without the pipe to keep it all.";
  try {
    // The pipe keeps one line; nothing is cut, and the notice still appears.
    const head = await call(f, { command: "printf 'a\\nb\\nc\\n' | head -1" });
    assert.equal(textOf(head), `a\n\n${notice}`);
    assert.equal(head.details.truncated, false);
    const tail = await call(f, { command: "seq 12 | tail -2" });
    assert.equal(textOf(tail), `11\n12\n\n${notice}`);
    // A cut excerpt carries the notice between the marker and the status line.
    const grep = await call(f, { command: "seq 60 | grep ''; exit 2" });
    assert.equal(
      textOf(grep),
      `[Lines 1–10 of 60 not shown; full output: ${grep.details.outputPath}. Search it with rg or Read it.]\n` +
        Array.from({ length: 50 }, (_, i) => String(i + 11)).join("\n") +
        `\n\n${notice}\n\nCommand exited with code 2`,
    );
    assert.equal(grep.details.truncated, true);
  } finally {
    f.cleanup();
  }
});

test("pipe notice: it precedes the leftover notice, one empty line apart", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, { command: "printf 'a\\nb\\n' | head -1; sleep 0.3 &" });
    assert.equal(
      textOf(result),
      "a\n\nNote: the saved output holds only what the final pipe printed; rerun without the pipe to keep it all.\n\nCommand left a process running; it was terminated. Use background: true, not & or nohup.",
    );
    assert.equal(detailsOf(result).leftover, true);
  } finally {
    f.cleanup();
  }
});

test("pipe notice: no top-level pipe to a filter stage means no notice", async () => {
  const f = makeFixture();
  try {
    writeFileSync(join(f.root, "input.txt"), "first\nsecond\n");
    const cases = [
      // `||` is an or-list, not a pipe.
      ["echo hi || head -1", "hi"],
      // A `|` inside single quotes is not top-level.
      ["echo 'a | tail'", "a | tail"],
      // A `|` inside double quotes is not top-level either.
      ['echo "a | head"', "a | head"],
      // An escaped `|` is a literal character, not a pipe.
      ["echo a \\| tail", "a | tail"],
      // `grep` is not the last stage.
      ["printf 'x\\n' | grep x | cat", "x"],
      // `headless` is a word of its own, not `head`.
      ["headless() { cat; }; printf 'x\\n' | headless", "x"],
      // No pipe at all, so no notice names a pipe that is not there.
      ["head -1 input.txt", "first"],
    ] as const;
    for (const [command, expected] of cases) {
      const result = await call(f, { command });
      assert.equal(textOf(result), expected, command);
      assert.equal(textOf(result).includes("Note:"), false, command);
    }
  } finally {
    f.cleanup();
  }
});

test("schema: the command description states the plain-run rule verbatim (Section 1)", () => {
  const schema = bashParameterSchema as unknown as {
    properties: Record<string, { description?: string }>;
  };
  assert.equal(
    schema.properties.command?.description,
    "Shell command text: one line or several, passed to the shell unchanged. Run it plainly: long output is cut to its last lines and saved in full to a file. Do not pipe to head, tail or grep. At least one character that is not white space.",
  );
});

test("excerpt: the character budget keeps the last eight 700-character lines of 52", async () => {
  const f = makeFixture();
  try {
    const lines = Array.from({ length: 52 }, (_, i) => String(i % 10).repeat(700));
    const result = await emitOutput(f, lines.join("\n"));
    assert.equal(
      textOf(result),
      `[Lines 1–44 of 52 not shown, long lines cut to their last 500 characters; full output: ${result.details.outputPath}. Search it with rg or Read it.]\n` +
        lines
          .slice(-8)
          .map((line) => `… ${line.slice(-500)}`)
          .join("\n"),
    );
    assert.equal(result.details.truncated, true);
  } finally {
    f.cleanup();
  }
});

test("excerpt: 100 lines of 300 characters show the last 13 within the budget", async () => {
  const f = makeFixture();
  try {
    const lines = Array.from({ length: 100 }, (_, i) => `${i + 1}`.padEnd(300, "x"));
    const result = await emitOutput(f, lines.join("\n"));
    assert.equal(
      textOf(result),
      `[Lines 1–87 of 100 not shown; full output: ${result.details.outputPath}. Search it with rg or Read it.]\n` +
        lines.slice(-13).join("\n"),
    );
    assert.equal(result.details.truncated, true);
  } finally {
    f.cleanup();
  }
});

test("partial results use the same tail excerpt without the header", async () => {
  const f = makeFixture();
  try {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    lines[59] = "😀".repeat(501);
    const updates: string[] = [];
    const expected = [...lines.slice(10, 59), `… ${"😀".repeat(500)}`].join("\n");
    writeFileSync(join(f.root, "input.txt"), lines.join("\n"));
    const result = await call(
      f,
      { command: "cat input.txt; while [ ! -e release ]; do sleep 0.01; done", timeout: 5000 },
      undefined,
      (r) => {
        const text = textOf(r);
        updates.push(text);
        if (text === expected) writeFileSync(join(f.root, "release"), "");
      },
    );
    assert.equal(result.details.exitReason, "exited", textOf(result));
    assert.equal(updates.at(-1), expected);
    assert.ok(
      updates.every((text) => !text.includes("Full output:") && !text.includes("full output:")),
    );
  } finally {
    f.cleanup();
  }
});

test("capture: a 200 MB unterminated line streams to disk with bounded excerpts and progress", async (t) => {
  const f = makeFixture();
  try {
    const start = performance.now();
    const result = await call(f, {
      command: `node -e 'const fs = require("node:fs"); const chunk = Buffer.alloc(65536, 120); for (let left = 200000000; left > 0;) { const size = Math.min(left, chunk.length); fs.writeSync(1, chunk, 0, size); left -= size; }'`,
      timeout: 10000,
    });
    t.diagnostic(`200 MB capture: ${(performance.now() - start).toFixed(1)} ms`);
    assert.equal(result.details.exitReason, "exited", textOf(result));
    assert.equal(result.details.exitCode, 0);
    assert.equal(result.details.truncated, true);
    assert.equal(
      textOf(result),
      `[The output's end is shown (1 line, 200000000 bytes), long lines cut to their last 500 characters; full output: ${result.details.outputPath}. Search it with rg or Read it.]\n` +
        "… " +
        "x".repeat(500),
    );
    assert.equal(statSync(String(result.details.outputPath)).size, 200000000);
    assert.deepEqual(
      at(f.registry.list(), 0).progress.map((entry) => entry.line),
      ["x".repeat(500) + " … [199999500 characters omitted]"],
    );
  } finally {
    f.cleanup();
  }
});

test("partial results during a long unterminated line remain bounded and preserve the current end", async () => {
  const f = makeFixture();
  try {
    const expected = "… " + "x".repeat(500);
    let observed = false;
    let invalidUpdate = false;
    const result = await call(
      f,
      {
        command:
          "head -c 8000000 /dev/zero | LC_ALL=C tr '\\000' x; while [ ! -e release ]; do sleep 0.01; done; printf END",
        timeout: 60000,
      },
      undefined,
      (r) => {
        const text = textOf(r);
        if (text.length > 600 || text.includes("full output:")) invalidUpdate = true;
        if (text === expected) {
          observed = true;
          writeFileSync(join(f.root, "release"), "");
        }
      },
    );
    assert.equal(result.details.exitReason, "exited", textOf(result));
    assert.equal(observed, true);
    assert.equal(invalidUpdate, false);
    assert.equal(
      textOf(result),
      `[The output's end is shown (1 line, 8000003 bytes), long lines cut to their last 500 characters; full output: ${result.details.outputPath}. Search it with rg or Read it.]\n` +
        "… " +
        "x".repeat(497) +
        "END",
    );
    assert.equal(statSync(String(result.details.outputPath)).size, 8000003);
  } finally {
    f.cleanup();
  }
});

test("capture continues when a host partial-result callback throws", async () => {
  const f = makeFixture();
  try {
    let updates = 0;
    const result = await call(
      f,
      { command: "printf one; sleep 0.2; printf two" },
      undefined,
      () => {
        updates += 1;
        throw new Error("host callback failed");
      },
    );
    assert.equal(textOf(result), "onetwo");
    assert.equal(result.details.exitCode, 0);
    assert.ok(updates > 0);
  } finally {
    f.cleanup();
  }
});

test("progress entries count Unicode code points across writes and use singular omission notes", async () => {
  const f = makeFixture();
  try {
    const result = await call(f, {
      command: `node -e 'process.stdout.write("😀".repeat(499)); setTimeout(() => process.stdout.write("🚀é\\n"), 50)'`,
    });
    assert.equal(result.details.truncated, true);
    assert.equal(
      at(at(f.registry.list(), 0).progress, 0).line,
      "😀".repeat(499) + "🚀 … [1 character omitted]",
    );
  } finally {
    f.cleanup();
  }
});

test("description tells the model to run plainly and keeps the background warning", () => {
  const f = makeFixture();
  try {
    const tool = makeBashTool(f.deps);
    assert.ok(
      tool.description.includes(
        "Run commands plainly, without piping to head, tail or grep or redirecting to a file: full output is saved for Read or rg.",
      ),
    );
    assert.ok(
      tool.description.includes("Do not start processes with & or nohup: use background: true."),
    );
    assert.ok(
      tool.description.includes(
        'Temporary files go under $TMPDIR, the session\'s tmp folder, never /tmp; create them with mktemp "$TMPDIR/name.XXXXXX", since a bare mktemp may ignore $TMPDIR.',
      ),
    );
  } finally {
    f.cleanup();
  }
});

test("registry: a nonexistent registry fails the call before any registration", async () => {
  const f = makeFixture();
  try {
    f.registry.end();
    const result = await call(f, { command: "echo hi" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Bash error/);
  } finally {
    f.cleanup();
  }
});
