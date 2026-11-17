import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { BootSnapshot, ToolResult } from "../../lib/engine.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { HostSession } from "../../lib/host.ts";
import type { PluginEntry } from "../../lib/plugins.ts";
import { TaskRegistry, ScriptTaskRow } from "../../lib/registry.ts";
import {
  makeScriptTool,
  resolveScriptTimeout,
  scriptParameterSchema,
} from "../../lib/script-tool.ts";
import { safeName } from "../../lib/util.ts";
import { at, must } from "../support/must.ts";

/**
 * Script tool (specs/script-tool.md): integration tests
 * through the public `execute` surface against a real worker thread.
 */

interface Fixture {
  tool: ReturnType<typeof makeScriptTool>;
  registry: TaskRegistry;
  root: string;
  /** The invoking session's agent directory (agent-tool.md Section 4.2). */
  agentDir: string;
  /** The session directory the fixture passes as `PI_DENT_SESSION_DIR` (under `root`). */
  sessionDir: string;
  cleanup: () => void;
}

function makeFixture(
  extraDeps?: {
    extraEnv?: () => Record<string, string> | undefined;
    hostProvider?: () => HostSession | undefined;
    agentDir?: (host: HostSession) => string;
  },
  sessionId = "sess-test",
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-script-"));
  const pluginRoot = join(root, "plug");
  mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
  writeFileSync(
    join(pluginRoot, "scripts", "hello.ts"),
    `export default input === undefined ? { help: true } : { echoed: input };`,
  );
  const plugin: PluginEntry = { name: "plug", root: pluginRoot, commands: [] };
  const boot = { pluginIndex: new Map([["plug", plugin]]) } as unknown as BootSnapshot;
  const host: HostSession = {
    cwd: () => root,
    sessionId: () => sessionId,
    sessionFile: () => undefined,
    sessionDir: () => root,
    model: () => undefined,
    thinking: () => undefined,
    activeTools: () => ["Script"],
    inventory: () => [],
    configuredModels: () => [],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
  const registry = new TaskRegistry(() => host);
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "session");
  const tool = makeScriptTool({
    boot,
    registry: () => registry,
    hostProvider: () => host,
    cohortFor: (id) => `cohort-${id}`,
    agentDir: () => agentDir,
    extraEnv: () => ({ PI_DENT_SESSION_DIR: sessionDir }),
    ...extraDeps,
  });
  return {
    tool,
    registry,
    root,
    agentDir,
    sessionDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const noCtx = undefined as unknown as ExtensionToolContext;

async function call(
  fixture: Fixture,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return fixture.tool.execute("call-1", params as never, signal, undefined, noCtx);
}

function textOf(result: ToolResult): string {
  assert.equal(result.content.length, 1, "one text content block");
  const first = at(result.content, 0);
  if (first.type !== "text") assert.fail(`expected text content, got ${first.type}`);
  return first.text;
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((res) => setTimeout(res, 20));
  }
}

test("temporary folder: os.tmpdir() in a script returns the session tmp folder, which exists", async () => {
  const f = makeFixture();
  try {
    const tmp = join(f.sessionDir, "tmp");
    const result = await call(f, {
      code: `import { tmpdir } from "node:os"; console.log(tmpdir());`,
    });
    assert.ok(textOf(result).split("\n").includes(tmp), textOf(result));
    assert.ok(existsSync(tmp));
  } finally {
    f.cleanup();
  }
});

test("temporary folder: a process a script spawns sees TMPDIR, with and without a caller env", async () => {
  const f = makeFixture();
  try {
    const tmp = join(f.sessionDir, "tmp");
    const result = await call(f, {
      code: `import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const inherited = await run("sh", ["-c", "echo $TMPDIR"]);
const own = await run("sh", ["-c", "echo $TMPDIR"], { env: { PATH: process.env.PATH ?? "" } });
console.log(inherited.stdout.trim());
console.log(own.stdout.trim());`,
    });
    assert.equal(
      textOf(result)
        .split("\n")
        .filter((line) => line === tmp).length,
      2,
      textOf(result),
    );
  } finally {
    f.cleanup();
  }
});

test("schema: object schema, additional properties rejected, expected fields", () => {
  const schema = scriptParameterSchema as unknown as {
    type: string;
    additionalProperties: boolean;
    properties: Record<string, unknown>;
  };
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  for (const field of [
    "code",
    "plugin",
    "path",
    "input",
    "cwd",
    "timeout",
    "background",
    "description",
  ]) {
    assert.ok(field in schema.properties, `field ${field} present`);
  }
});

test("source resolution: exactly one source required, with no task row (Section 2)", async () => {
  const f = makeFixture();
  try {
    // Both shapes of the first string: code together with a plugin source.
    const both = await call(f, {
      code: "export default 1;",
      plugin: "plug",
      path: "scripts/hello.ts",
    });
    assert.equal(both.isError, true);
    assert.equal(
      textOf(both),
      "exactly one source is required: non-blank code, or non-blank plugin plus non-blank path",
    );
    assert.equal(f.registry.list().length, 0, "no row for a source-shape rejection");

    // Only one half of a plugin source: the second string.
    const half = await call(f, { plugin: "plug" });
    assert.equal(half.isError, true);
    assert.equal(textOf(half), "plugin source requires both non-blank plugin and non-blank path");
    assert.equal(f.registry.list().length, 0, "no row for a source-shape rejection");

    const nothing = await call(f, {});
    assert.equal(nothing.isError, true);
    assert.equal(
      textOf(nothing),
      "exactly one source is required: non-blank code, or non-blank plugin plus non-blank path",
    );
    assert.equal(f.registry.list().length, 0, "no row for a source-shape rejection");
    assert.ok(!existsSync(join(f.agentDir, "output")), "no file for a source-shape rejection");
  } finally {
    f.cleanup();
  }
});

test("a blank cwd is absent: the session's working directory applies (Section 1)", async () => {
  const f = makeFixture();
  try {
    for (const blank of ["", "  \n"]) {
      const ok = await call(f, { code: "export default process.cwd();", cwd: blank });
      assert.notEqual(ok.isError, true, textOf(ok));
      assert.ok(textOf(ok).includes(f.root), textOf(ok));
    }
  } finally {
    f.cleanup();
  }
});

test("rejection order: no live host session comes before the cwd (Section 2)", async () => {
  const f = makeFixture({ hostProvider: () => undefined });
  try {
    const result = await call(f, {
      code: "export default 1;",
      cwd: "missing-dir",
      background: true,
    });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "pi-dent: no live host session for the Script call");
    const row = at(f.registry.list(), 0);
    assert.equal(row.kind, "script");
    assert.equal(row.status, "failed");
    assert.equal(row.consumed, true);
    assert.equal(row.result, textOf(result));
    assert.ok(!existsSync(join(f.agentDir, "output")));
  } finally {
    f.cleanup();
  }
});

test("rejection order: source shape before the row, then cwd, plugin, path, file (Section 2)", async () => {
  const f = makeFixture();
  try {
    // The source shape precedes the row and every later check: even an invalid
    // cwd is not reported, and no row exists.
    const shapeFirst = await call(f, { cwd: join(f.root, "nowhere") });
    assert.match(textOf(shapeFirst), /exactly one source is required/);
    assert.equal(f.registry.list().length, 0, "no row for a source-shape rejection");

    // Once a source is present, cwd is the first of the row-based checks.
    const nothing = await call(f, { code: "export default 1;", cwd: join(f.root, "nowhere") });
    assert.equal(nothing.isError, true);
    assert.ok(textOf(nothing).includes(join(f.root, "nowhere")), textOf(nothing));

    // A shape failure with a valid cwd still precedes the plugin lookup.
    const shape = await call(f, {
      code: "export default 1;",
      plugin: "nope",
      path: "scripts/x.ts",
    });
    assert.match(textOf(shape), /exactly one source/);

    const unknown = await call(f, { plugin: "nope", path: "scripts/x.ts" });
    assert.match(textOf(unknown), /unknown plugin "nope"/);

    // The path pattern precedes the file read.
    const badPath = await call(f, { plugin: "plug", path: "../x.ts" });
    assert.match(textOf(badPath), /plugin "plug"/);

    const missing = await call(f, { plugin: "plug", path: "scripts/none.ts" });
    assert.match(textOf(missing), /missing script/);
    assert.ok(
      textOf(missing).includes(join(f.root, "plug", "scripts", "none.ts")),
      textOf(missing),
    );

    const rows = f.registry.list();
    assert.equal(rows.length, 4, "one row per rejected call after the row");
    for (const row of rows) assert.equal(row.status, "failed");
    assert.ok(!existsSync(join(f.agentDir, "output")), "no output file for a rejection");
  } finally {
    f.cleanup();
  }
});

test("source resolution: blank values treated as absent", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: "   ", plugin: "plug", path: "scripts/hello.ts" });
    assert.equal(r.isError, undefined);
    assert.match(textOf(r), /--- exited ok/);
  } finally {
    f.cleanup();
  }
});

test("source resolution: unknown plugin lists known namespaces", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { plugin: "nope", path: "scripts/x.ts" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /unknown plugin "nope"/);
    assert.match(textOf(r), /plug/);
  } finally {
    f.cleanup();
  }
});

test("source resolution: bad path shape rejected", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { plugin: "plug", path: "commands/x.md" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /must start with scripts/);
    const dotdot = await call(f, { plugin: "plug", path: "scripts/../x.ts" });
    assert.equal(dotdot.isError, true);
    assert.match(textOf(dotdot), /\.\./);
  } finally {
    f.cleanup();
  }
});

test("execution: inline code returns a JSON-compatible value with the Section 5 body", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `console.log("hi"); export default { n: 1 };` });
    assert.equal(r.isError, undefined);
    const text = textOf(r);
    assert.match(text, /^hi\n/);
    assert.match(text, /--- return ---/);
    assert.match(text, /"n": 1/);
    assert.match(text, /--- exited ok in \d+ms ---/);
    assert.match(text, /--- return metadata ---/);
    assert.deepEqual(r.details.returnValue, { n: 1 });
    assert.equal(r.details.exitReason, "ok");
    assert.equal(r.details.stdout, "hi\n");
    assert.deepEqual(r.details.truncated, { stdout: false, stderr: false });
  } finally {
    f.cleanup();
  }
});

test("execution: stdout and stderr are captured separately", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `console.log("out"); console.error("err"); export default 1;`,
    });
    assert.equal(r.details.stdout, "out\n");
    assert.equal(r.details.stderr, "err\n");
    assert.match(textOf(r), /--- stderr ---\n/);
  } finally {
    f.cleanup();
  }
});

test("execution: input binding reaches the script via structured clone", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `export default { got: input };`, input: { a: 1, b: "x" } });
    assert.deepEqual(r.details.returnValue, { got: { a: 1, b: "x" } });
  } finally {
    f.cleanup();
  }
});

test("execution: plugin script help contract (omitted input is undefined)", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { plugin: "plug", path: "scripts/hello.ts" });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.details.returnValue, { help: true });
    const withInput = await call(f, { plugin: "plug", path: "scripts/hello.ts", input: { z: 9 } });
    assert.deepEqual(withInput.details.returnValue, { echoed: { z: 9 } });
  } finally {
    f.cleanup();
  }
});

test("execution: thrown error settles with exitReason threw", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `throw new Error("boom");` });
    assert.equal(r.isError, true);
    assert.equal(r.details.exitReason, "threw");
    assert.match(textOf(r), /boom/);
  } finally {
    f.cleanup();
  }
});

test("execution: an error outside the main body keeps name, message, and stack", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `await new Promise((r) => setTimeout(() => { throw new Error("boom") }, 10));`,
    });
    assert.equal(r.isError, true);
    assert.equal(r.details.exitReason, "threw");
    const text = textOf(r);
    assert.match(text, /--- stderr ---\nError: boom\n/, `name and message: ${text}`);
    assert.match(text, /__pi_dent_script__\.ts:1:\d+/, `stack: ${text}`);
  } finally {
    f.cleanup();
  }
});

test("execution: an unhandled rejection keeps name, message, and stack", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `Promise.reject(new Error("y")); await new Promise((r) => setTimeout(r, 50));`,
    });
    assert.equal(r.isError, true);
    assert.equal(r.details.exitReason, "threw");
    const text = textOf(r);
    assert.equal(text.split("Error: y").length - 1, 1, `name and message once: ${text}`);
    assert.match(text, /__pi_dent_script__\.ts:2:\d+/, `stack: ${text}`);
  } finally {
    f.cleanup();
  }
});

test("execution: a thrown error reports name and message once", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `throw new Error("dup");` });
    assert.equal(r.details.exitReason, "threw");
    const text = textOf(r);
    assert.equal(text.split("Error: dup").length - 1, 1, `name and message once: ${text}`);
    assert.match(text, /__pi_dent_script__\.ts:1:7/, `stack: ${text}`);
  } finally {
    f.cleanup();
  }
});

test("execution: an unexpected worker exit reports its error text", async () => {
  const f = makeFixture();
  try {
    // reallyExit skips the exit interception, so the worker dies before it
    // settles: the runner's exit path reports the settlement error.
    const r = await call(f, { code: `process.reallyExit(7);` });
    assert.equal(r.isError, true);
    assert.equal(r.details.exitReason, "threw");
    assert.match(textOf(r), /Error: script worker exited unexpectedly \(code 7\)/);
  } finally {
    f.cleanup();
  }
});

test("module contract: bare final expression is the return value", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `const x = 41;\nx + 1` });
    assert.equal(r.isError, undefined);
    assert.equal(r.details.exitReason, "ok");
    assert.equal(r.details.returnValue, 42);
  } finally {
    f.cleanup();
  }
});

test("module contract: final expression survives named-export plumbing", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `export const a = 1;\na + 1` });
    assert.equal(r.isError, undefined);
    assert.equal(r.details.exitReason, "ok");
    assert.equal(r.details.returnValue, 2);
  } finally {
    f.cleanup();
  }
});

test("module contract: default export wins over the completion value", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `const x = 1;\nx + 1;\nexport default 7;` });
    assert.equal(r.isError, undefined);
    assert.equal(r.details.exitReason, "ok");
    assert.equal(r.details.returnValue, 7);
  } finally {
    f.cleanup();
  }
});

test("module contract: no default export and no final expression returns undefined", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `const x = 1;` });
    assert.equal(r.isError, undefined);
    assert.equal(r.details.exitReason, "ok");
    assert.match(textOf(r), /--- return ---\nundefined/);
  } finally {
    f.cleanup();
  }
});

test("module contract: top-level await yields no completion value", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `await Promise.resolve();\n41 + 1` });
    assert.equal(r.isError, undefined);
    assert.equal(r.details.exitReason, "ok");
    assert.match(textOf(r), /--- return ---\nundefined/);
  } finally {
    f.cleanup();
  }
});

test("module contract: non-cloneable export degrades to a marker without failing", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `export default function f() { return 1; };` });
    assert.equal(r.isError, undefined);
    assert.equal(r.details.exitReason, "ok");
    assert.match(String(r.details.returnValue), /non-cloneable/);
  } finally {
    f.cleanup();
  }
});

test("execution: process.exit settles with exit-called and the exit code", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `console.log("before"); process.exit(3);` });
    assert.equal(r.isError, undefined);
    assert.equal(r.details.exitReason, "exit-called");
    assert.equal(r.details.exitCode, 3);
    assert.match(textOf(r), /--- exited exit-called code=3/);
  } finally {
    f.cleanup();
  }
});

test("timeout: a synchronous loop is hard-terminated", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `while (true) {}`, timeout: 200 });
    assert.equal(r.isError, true);
    assert.equal(r.details.exitReason, "timeout");
    assert.match(textOf(r), /--- exited timeout/);
  } finally {
    f.cleanup();
  }
});

test("timeout: an omitted foreground timeout schedules the 600000 ms default", async () => {
  const f = makeFixture();
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  const recording = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (typeof ms === "number") delays.push(ms);
    return original(callback, ms, ...args);
  };
  globalThis.setTimeout = recording as typeof setTimeout;
  try {
    const omitted = await call(f, { code: "export default 1;" });
    assert.equal(omitted.details.exitReason, "ok");
    assert.ok(
      delays.includes(600000),
      `an omitted foreground timeout schedules 600000 ms, saw ${delays.join(",")}`,
    );
    delays.length = 0;
    const explicit = await call(f, { code: "export default 1;", timeout: 12345 });
    assert.equal(explicit.details.exitReason, "ok");
    assert.ok(
      delays.includes(12345),
      `an explicit timeout schedules its timer, saw ${delays.join(",")}`,
    );
    delays.length = 0;
    const background = await call(f, { code: "export default 1;", background: true });
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

test("timeout: the resolved value defaults for foreground only (Section 1)", () => {
  assert.equal(resolveScriptTimeout(undefined, false), 600000);
  assert.equal(resolveScriptTimeout(undefined, true), undefined);
  assert.equal(resolveScriptTimeout(1, false), 1);
  assert.equal(resolveScriptTimeout(600000, true), 600000);
});

test("result contract: long strings are clipped and reported in truncatedStrings", async () => {
  const f = makeFixture();
  try {
    const long = "x".repeat(600);
    const r = await call(f, { code: `export default { a: ${JSON.stringify(long)} };` });
    assert.equal(r.isError, undefined);
    const render = r.details.returnValueRender as {
      stringsOverLimit: number;
      truncatedStrings: {
        path: (string | number)[];
        originalLength: number;
        renderedLength: number;
      }[];
    };
    assert.equal(render.stringsOverLimit, 1);
    assert.deepEqual(render.truncatedStrings[0]?.path, ["a"]);
    assert.equal(render.truncatedStrings[0]?.originalLength, 600);
    assert.equal(render.truncatedStrings[0]?.renderedLength, 500);
    assert.equal("jsonPath" in render, false, "no jsonPath in details");
    const log = readFileSync(String((r.details as Record<string, unknown>).outputPath), "utf8");
    assert.equal(
      log.split(JSON.stringify({ a: long })).length - 1,
      1,
      "full JSON once in the file",
    );
  } finally {
    f.cleanup();
  }
});

test("fs paths: two-path functions resolve both arguments under cwd", async () => {
  const f = makeFixture();
  try {
    const cwd = join(f.root, "work");
    mkdirSync(cwd, { recursive: true });
    const r = await call(f, {
      cwd,
      code: `
        import { renameSync, copyFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
        import { rename as renameP } from "node:fs/promises";
        writeFileSync("a.txt", "A");
        renameSync("a.txt", "b.txt");
        copyFileSync("b.txt", "c.txt");
        await renameP("c.txt", "d.txt");
        export default {
          a: existsSync("a.txt"),
          b: readFileSync("b.txt", "utf8"),
          c: existsSync("c.txt"),
          d: readFileSync("d.txt", "utf8"),
        };
      `,
    });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.details.returnValue, { a: false, b: "A", c: false, d: "A" });
    // Second-path arguments must not leak into the fixture root or the host cwd.
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      assert.equal(existsSync(join(f.root, name)), false, `${name} not in fixture root`);
      assert.equal(existsSync(join(process.cwd(), name)), false, `${name} not in host cwd`);
    }
  } finally {
    f.cleanup();
  }
});

test("fs paths: newly covered path-first functions resolve under cwd", async () => {
  const f = makeFixture();
  try {
    const cwd = join(f.root, "work");
    mkdirSync(cwd, { recursive: true });
    const r = await call(f, {
      cwd,
      code: `
        import { mkdtempSync, opendirSync, writeFileSync } from "node:fs";
        const dir = mkdtempSync("tmp-");
        writeFileSync("x.txt", "X");
        const d = opendirSync(".");
        const names = [];
        for await (const entry of d) names.push(entry.name);
        export default { underCwd: dir.startsWith(process.cwd()), hasX: names.includes("x.txt") };
      `,
    });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.details.returnValue, { underCwd: true, hasX: true });
    // mkdtemp must not have leaked into the host cwd.
    assert.equal(existsSync(join(process.cwd(), "tmp-")), false);
  } finally {
    f.cleanup();
  }
});

test("fs paths: symlink resolves the link path under cwd, target unchanged", async () => {
  const f = makeFixture();
  try {
    const cwd = join(f.root, "work");
    mkdirSync(cwd, { recursive: true });
    const r = await call(f, {
      cwd,
      code: `
        import { symlinkSync, readlinkSync, writeFileSync, readFileSync } from "node:fs";
        writeFileSync("target-rel", "T");
        symlinkSync("target-rel", "link");
        export default { target: readlinkSync("link"), content: readFileSync("link", "utf8") };
      `,
    });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.details.returnValue, { target: "target-rel", content: "T" });
    // The link lives under cwd, not the fixture root or the host cwd.
    assert.equal(existsSync(join(f.root, "link")), false);
    assert.equal(existsSync(join(process.cwd(), "link")), false);
  } finally {
    f.cleanup();
  }
});

test("fs paths: await import returns cwd-wrapped fs modules", async () => {
  const f = makeFixture();
  try {
    const cwd = join(f.root, "work");
    mkdirSync(cwd, { recursive: true });
    const r = await call(f, {
      cwd,
      code: `
        const fs = await import("node:fs");
        const fsp = await import("node:fs/promises");
        const fsBare = await import("fs");
        fs.writeFileSync("a.txt", "A");
        await fsp.writeFile("b.txt", "B");
        fsBare.writeFileSync("c.txt", "C");
        export default {
          a: fs.readFileSync("a.txt", "utf8"),
          b: await fsp.readFile("b.txt", "utf8"),
          c: fsBare.readFileSync("c.txt", "utf8"),
        };
      `,
    });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.details.returnValue, { a: "A", b: "B", c: "C" });
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      assert.equal(existsSync(join(f.root, name)), false, `${name} not in fixture root`);
      assert.equal(existsSync(join(process.cwd(), name)), false, `${name} not in host cwd`);
    }
  } finally {
    f.cleanup();
  }
});

test("dynamic import: bundled package import works", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `
        const yaml = await import("js-yaml");
        export default yaml.load("a: 1");
      `,
    });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.details.returnValue, { a: 1 });
  } finally {
    f.cleanup();
  }
});

test("delivery: background returns running with taskId/outputPath and settles completed", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `console.log("bg"); export default 42;`, background: true });
    assert.equal(r.isError, undefined);
    const details = r.details as Record<string, unknown>;
    assert.equal(details.background, true);
    assert.equal(details.exitReason, "running");
    assert.equal(typeof details.taskId, "string");
    assert.equal(typeof details.outputPath, "string");
    const taskId = details.taskId as string;
    await waitFor(() => f.registry.get(taskId)?.status !== "running");
    const row = f.registry.get(taskId);
    assert.ok(row, "background row registered");
    assert.equal(must(row).status, "completed");
    const out = readFileSync(details.outputPath as string, "utf8");
    assert.match(out, /bg\n/);
    assert.match(out, /--- exited ok/);
  } finally {
    f.cleanup();
  }
});

test("delivery: a background call ignores an already-aborted signal (Section 6)", async () => {
  const f = makeFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    const r = await call(f, { code: `export default 7;`, background: true }, controller.signal);
    assert.equal(r.isError, undefined);
    const details = r.details as Record<string, unknown>;
    assert.equal(details.exitReason, "running");
    assert.equal(details.background, true);
    const taskId = details.taskId as string;
    await waitFor(() => f.registry.get(taskId)?.status !== "running");
    assert.equal(must(f.registry.get(taskId)).status, "completed");
  } finally {
    f.cleanup();
  }
});

test("delivery: a foreground call with an already-aborted signal starts no run and reports 0 ms (Sections 5, 6)", async () => {
  const f = makeFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    const r = await call(f, { code: `export default 7;` }, controller.signal);
    assert.equal(r.isError, true);
    assert.equal(r.details.exitReason, "aborted");
    assert.equal(r.details.durationMs, 0);
    assert.equal(textOf(r), "\n--- exited aborted in 0ms ---");
    assert.equal(at(f.registry.list(), 0).status, "cancelled");
  } finally {
    f.cleanup();
  }
});

test("delivery: a background threw writes the error text to outputPath once", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `await new Promise((r) => setTimeout(() => { throw new Error("bgb") }, 10));`,
      background: true,
    });
    const details = r.details as Record<string, unknown>;
    const taskId = details.taskId as string;
    const outputPath = details.outputPath as string;
    await waitFor(() => f.registry.get(taskId)?.status !== "running");
    const out = readFileSync(outputPath, "utf8");
    assert.equal(out.split("Error: bgb").length - 1, 1, `error text once: ${out}`);
    assert.match(out, /--- exited threw/);
    assert.match(must(f.registry.get(taskId)).result ?? "", /Error: bgb/);
  } finally {
    f.cleanup();
  }
});

test("delivery: Task kill hard-terminates a running background script", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `await new Promise(() => {});`, background: true });
    const taskId = (r.details as Record<string, unknown>).taskId as string;
    const row = must(f.registry.get(taskId));
    row.cancel?.();
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(row.status, "cancelled");
    assert.match(row.result ?? "", /killed/);
  } finally {
    f.cleanup();
  }
});

test("foreground: Task cancellation hard-terminates and settles cancelled (Section 6)", async () => {
  const f = makeFixture();
  try {
    // A pending timer keeps the worker's event loop alive (a forever-pending
    // promise would let the worker drain and exit); the timeout of 20s is
    // never reached because the row's cancellation handler kills first.
    const pending = call(f, {
      code: `await new Promise((res) => setTimeout(res, 200000));`,
      timeout: 20000,
    });
    await new Promise((res) => setTimeout(res, 150));
    const running = f.registry.list().find((row) => row.status === "running");
    assert.ok(running, "a running foreground row is registered");
    assert.equal(running.background, false);
    f.registry.cancel(running);
    const r = await pending;
    assert.equal(r.isError, true);
    assert.equal(r.details.exitReason, "killed");
    assert.equal(running.status, "cancelled");
  } finally {
    f.cleanup();
  }
});

test("foreground: a browser kill settles cancelled and names the user in the body (Sections 5, 6)", async () => {
  const f = makeFixture();
  try {
    const pending = call(f, {
      code: `await new Promise((res) => setTimeout(res, 200000));`,
      timeout: 20000,
    });
    await new Promise((res) => setTimeout(res, 150));
    const running = f.registry.list().find((row) => row.status === "running");
    assert.ok(running, "a running foreground row is registered");
    // The task browser's kill key: a browser kill in the registry that holds the row.
    f.registry.cancel(running, true);
    const r = await pending;
    assert.equal(r.isError, true);
    assert.equal(r.details.exitReason, "killed");
    assert.equal(running.status, "cancelled");
    assert.equal(running.browserKill, true);
    assert.match(
      textOf(r),
      /--- exited killed in \d+ms ---\n--- killed by the user from the task browser ---$/,
    );
    assert.equal(running.result, textOf(r));

    // The same body reaches the output file of a background run.
    const bg = await call(f, {
      code: `await new Promise((res) => setTimeout(res, 200000));`,
      background: true,
    });
    const bgRow = must(f.registry.get(String((bg.details as Record<string, unknown>).taskId)));
    f.registry.cancel(bgRow, true);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(bgRow.status, "cancelled");
    assert.match(bgRow.result ?? "", /\n--- killed by the user from the task browser ---/);
    const outputPath = String((bg.details as Record<string, unknown>).outputPath);
    assert.match(
      readFileSync(outputPath, "utf8"),
      /--- killed by the user from the task browser ---/,
    );
  } finally {
    f.cleanup();
  }
});

test("row label: plugin script label is the caller-provided plugin-relative path (Section 6)", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { plugin: "plug", path: "scripts/hello.ts", input: { z: 1 } });
    assert.equal(r.isError, undefined);
    const rows = f.registry.list();
    assert.equal(rows.length, 1);
    assert.equal(at(rows, 0).label, "scripts/hello.ts");
  } finally {
    f.cleanup();
  }
});

test("row label: a present description wins over the plugin path and the code preview (Section 6)", async () => {
  const f = makeFixture();
  try {
    const pluginCall = await call(f, {
      plugin: "plug",
      path: "scripts/hello.ts",
      description: "echo input",
    });
    assert.equal(pluginCall.isError, undefined);
    const codeCall = await call(f, { code: "export default 1;", description: "inline one" });
    assert.equal(codeCall.isError, undefined);
    const labels = f.registry.list().map((row) => row.label);
    assert.deepEqual(labels, ["echo input", "inline one"]);
  } finally {
    f.cleanup();
  }
});

test("row label: a blank description is treated as absent (Sections 1 and 6)", async () => {
  const f = makeFixture();
  try {
    const pluginCall = await call(f, {
      plugin: "plug",
      path: "scripts/hello.ts",
      description: "   ",
    });
    assert.equal(pluginCall.isError, undefined);
    const codeCall = await call(f, { code: "export default 2;", description: "\t" });
    assert.equal(codeCall.isError, undefined);
    const labels = f.registry.list().map((row) => row.label);
    assert.deepEqual(labels, ["scripts/hello.ts", "export default 2;"]);
  } finally {
    f.cleanup();
  }
});

test("row label: a code source drops its leading white space, line breaks included (Section 6)", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: "\n\n  export default 3;\n" });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(at(f.registry.list(), 0).label, "export default 3;");
  } finally {
    f.cleanup();
  }
});

test("worker env: extraEnv reaches the worker and never mutates process.env", async () => {
  const f = makeFixture({ extraEnv: () => ({ PI_DENT_SESSION_DIR: "/x" }) });
  try {
    delete process.env.PI_DENT_SESSION_DIR;
    const r = await call(f, { code: `export default process.env.PI_DENT_SESSION_DIR;` });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.returnValue, "/x");
    assert.equal(process.env.PI_DENT_SESSION_DIR, undefined, "test process env unchanged");
  } finally {
    f.cleanup();
  }
});

test("schema: timeout is an integer from 1 to 600000, no other property is admitted", () => {
  // The host rejects an out-of-range timeout before `execute` runs, so these
  // are assertions on the schema object, not on the tool's own checks.
  for (const bad of [0, -1, 1.5, 600001, "1"]) {
    assert.equal(
      Value.Check(scriptParameterSchema, { code: "export default 1;", timeout: bad }),
      false,
      `timeout ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(Value.Check(scriptParameterSchema, { code: "export default 1;", timeout: 1 }), true);
  assert.equal(
    Value.Check(scriptParameterSchema, { code: "export default 1;", timeout: 600000 }),
    true,
  );
  // Section 1: no field is required, and only the eight properties are admitted.
  assert.equal(Value.Check(scriptParameterSchema, {}), true);
  assert.equal(Value.Check(scriptParameterSchema, { code: "x", extra: 1 }), false);
  assert.equal(Value.Check(scriptParameterSchema, { code: "x", input: 5 }), false);
  assert.equal(Value.Check(scriptParameterSchema, { code: "x", input: { any: [1] } }), true);
});

test("background output: a removed output directory never throws out of the handler", async () => {
  const f = makeFixture();
  const outputDir = join(f.agentDir, "output");
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    uncaught.push(error);
  };
  process.on("uncaughtException", onUncaught);
  try {
    // Prints for about a second, so chunks keep arriving after the directory
    // holding outputPath is gone — the sweep removing the agent directory.
    const r = await call(f, {
      code: `for (let i = 0; i < 50; i++) { console.log("tick " + i); await new Promise((res) => setTimeout(res, 20)); }\nexport default 1;`,
      background: true,
    });
    const taskId = (r.details as Record<string, unknown>).taskId as string;
    const outputPath = (r.details as Record<string, unknown>).outputPath as string;
    await waitFor(() => existsSync(outputPath));
    rmSync(outputDir, { recursive: true, force: true });
    const row = must(f.registry.get(taskId));
    await waitFor(() => row.status !== "running");
    assert.equal(row.status, "completed");
    assert.deepEqual(uncaught, [], `no uncaught exception: ${String(uncaught[0])}`);
  } finally {
    process.off("uncaughtException", onUncaught);
    f.cleanup();
  }
});

test("foreground output feeds the row's progress projection line by line", async () => {
  const f = makeFixture();
  try {
    await call(f, {
      code: `console.log("one\\ntwo"); console.error("err"); process.stdout.write("tail");`,
    });
    assert.deepEqual(
      at(f.registry.list(), 0).progress.map((entry) => entry.line),
      ["one", "two", "err", "tail"],
    );
  } finally {
    f.cleanup();
  }
});

test("progress: lines are formed on the run's output across streams (Section 6)", async () => {
  const f = makeFixture();
  try {
    await call(f, {
      code: `process.stdout.write("part"); process.stderr.write("ial\\n");`,
    });
    assert.deepEqual(
      at(f.registry.list(), 0).progress.map((entry) => entry.line),
      ["partial"],
    );
  } finally {
    f.cleanup();
  }
});

test("progress: an entry is its line's display text, cut to its first 500 code points (Section 6)", async () => {
  const f = makeFixture();
  try {
    await call(f, {
      code: `process.stdout.write("x".repeat(600) + "\\r\\n");
process.stdout.write("a".repeat(499) + "😀b" + "\\n");
process.stdout.write("y".repeat(501) + "\\r");`,
    });
    assert.deepEqual(
      at(f.registry.list(), 0).progress.map((entry) => entry.line),
      [
        "x".repeat(500) + " … [100 characters omitted]",
        "a".repeat(499) + "😀 … [1 character omitted]",
        "y".repeat(500) + " … [1 character omitted]",
      ],
    );
  } finally {
    f.cleanup();
  }
});

test("output: the file lives under <agentDir>/output/, created when absent", async () => {
  const f = makeFixture();
  try {
    assert.ok(!existsSync(f.agentDir), "no agent directory before the call");
    const r = await call(f, { code: "export default { ok: true };" });
    assert.equal(r.isError, undefined, textOf(r));
    const row = at(f.registry.list(), 0);
    const details = r.details as Record<string, unknown>;
    assert.equal(details.outputPath, join(f.agentDir, "output", `${safeName(row.taskId)}.log`));
    assert.match(readFileSync(String(details.outputPath), "utf8"), /--- exited ok/);
    assert.deepEqual(readdirSync(join(f.agentDir, "output")), [`${safeName(row.taskId)}.log`]);
  } finally {
    f.cleanup();
  }
});

test("output: a clipped return value's full JSON is one section of the file, in both deliveries", async () => {
  const f = makeFixture();
  try {
    const long = "z".repeat(600);
    const code = `export default { long: "${long}", n: 1 };`;
    const json = `{"long":"${long}","n":1}`;
    const fg = await call(f, { code });
    assert.equal(fg.isError, undefined, textOf(fg));
    const bg = await call(f, { code, background: true });
    const bgRow = must(f.registry.get((bg.details as Record<string, unknown>).taskId as string));
    await waitFor(() => bgRow.status !== "running");
    const logs = [fg, bg].map((r) => {
      const path = String((r.details as Record<string, unknown>).outputPath);
      return readFileSync(path, "utf8").replace(/in \d+ms/, "in Nms");
    });
    for (const log of logs) {
      assert.equal(log.split(json).length - 1, 1, "the full JSON appears exactly once");
      assert.ok(
        log.includes(`\n--- return json ---\n${json}\n--- exited ok in Nms ---`),
        "the section sits before the exit line",
      );
    }
    assert.equal(logs[0], logs[1], "both deliveries write the same file");
    assert.doesNotMatch(textOf(fg), /--- return json ---/, "the body does not carry the section");
    const render = (fg.details as Record<string, unknown>).returnValueRender as Record<
      string,
      unknown
    >;
    assert.equal("jsonPath" in render, false, "no jsonPath in details");
    assert.ok(
      readdirSync(join(f.agentDir, "output")).every((name) => name.endsWith(".log")),
      "no .json file is created",
    );
  } finally {
    f.cleanup();
  }
});

test("output: a return value that is not clipped adds no return json section", async () => {
  const f = makeFixture();
  try {
    for (const background of [false, true]) {
      const r = await call(f, { code: "export default { ok: true };", background });
      const details = r.details as Record<string, unknown>;
      const row = must(f.registry.get(details.taskId as string));
      await waitFor(() => row.status !== "running");
      const log = readFileSync(String(details.outputPath), "utf8");
      assert.doesNotMatch(log, /--- return json ---/, `background=${background}`);
      assert.match(log, /--- return ---\n/, `background=${background}`);
    }
  } finally {
    f.cleanup();
  }
});

test("output: a background call writes its output file under <agentDir>/output/", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `console.log("hi"); export default 1;`, background: true });
    const details = r.details as Record<string, unknown>;
    const taskId = details.taskId as string;
    assert.equal(details.outputPath, join(f.agentDir, "output", `${safeName(taskId)}.log`));
    const row = must(f.registry.get(taskId));
    await waitFor(() => row.status !== "running");
    assert.equal(readFileSync(String(details.outputPath), "utf8").startsWith("hi\n"), true);
  } finally {
    f.cleanup();
  }
});

test("output: the return section sits directly after the return block, before the exit line", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `export default { long: "${"z".repeat(600)}" };` });
    const log = readFileSync(String((r.details as Record<string, unknown>).outputPath), "utf8");
    const start = log.indexOf("\n--- return ---\n");
    const json = log.indexOf("\n--- return json ---\n");
    assert.ok(start >= 0 && json > start, "the return block precedes the section");
    assert.equal(log.slice(start, json).split("\n--- ").length, 2, "no other section between them");
    assert.ok(log.indexOf("\n--- exited ") > json, "the exit line follows the section");
  } finally {
    f.cleanup();
  }
});

test("output: the aggregate cap alone triggers the return json section", async () => {
  const f = makeFixture();
  try {
    const value = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const r = await call(f, {
      code: `export default Array.from({ length: 1000 }, (_, i) => ({ id: i }));`,
    });
    assert.equal(r.isError, undefined, textOf(r));
    const render = (r.details as Record<string, unknown>).returnValueRender as Record<
      string,
      unknown
    >;
    assert.equal(render.stringsOverLimit, 0, "no string is clipped");
    assert.equal(render.aggregateTruncated, true, "the aggregate cap applied");
    const log = readFileSync(String((r.details as Record<string, unknown>).outputPath), "utf8");
    const section = `\n--- return json ---\n${JSON.stringify(value)}\n--- exited `;
    assert.equal(log.split(section).length - 1, 1, "the full JSON is in the file once");
  } finally {
    f.cleanup();
  }
});

test("output: a clipped return names the full value's path in the body, in both deliveries", async () => {
  const f = makeFixture();
  try {
    const code = `export default { long: "${"z".repeat(600)}" };`;
    const fg = await call(f, { code });
    const fgDetails = fg.details as Record<string, unknown>;
    const fgPath = String(fgDetails.outputPath);
    const fgRow = must(f.registry.get(fgDetails.taskId as string));
    assert.ok(
      textOf(fg).includes(`\nFull return value: ${fgPath}\n--- exited `),
      "foreground body",
    );
    assert.equal(fgRow.resultPath, fgPath, "foreground resultPath");

    const bg = await call(f, { code, background: true });
    const bgDetails = bg.details as Record<string, unknown>;
    const bgPath = String(bgDetails.outputPath);
    const bgRow = must(f.registry.get(bgDetails.taskId as string));
    await waitFor(() => bgRow.status !== "running");
    assert.ok(
      bgRow.result?.includes(`\nFull return value: ${bgPath}\n--- exited `),
      "background settled body",
    );
    assert.equal(bgRow.resultPath, bgPath, "background resultPath");
  } finally {
    f.cleanup();
  }
});

test("output: an unclipped return names no full value in the body", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: "export default { ok: true };" });
    assert.doesNotMatch(textOf(r), /Full return value/);
  } finally {
    f.cleanup();
  }
});

test("output: an unusable output directory still lets the call succeed (Section 6)", async () => {
  const f = makeFixture();
  // A regular file where the agent directory belongs: creating <dir>/output/ throws.
  writeFileSync(f.agentDir, "");
  try {
    const r = await call(f, { code: "export default { ok: true };" });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /--- exited ok/);
    const render = (r.details as Record<string, unknown>).returnValueRender as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.keys(render).toSorted(), [
      "aggregateTruncated",
      "stringsOverLimit",
      "truncatedStrings",
    ]);
    const rows = f.registry.list();
    assert.equal(rows.length, 1);
    assert.equal(at(rows, 0).status, "completed");
  } finally {
    f.cleanup();
  }
});

test("task row: an inline call registers the row's code", async () => {
  const f = makeFixture();
  try {
    const code = `console.log("row-code-inline");`;
    const r = await call(f, { code });
    assert.equal(r.isError, undefined, textOf(r));
    const row = at(f.registry.list(), 0);
    if (!(row instanceof ScriptTaskRow)) assert.fail("the row is a script row");
    assert.equal(row.code, code);
  } finally {
    f.cleanup();
  }
});

test("task row: a plugin call sets the row's code to the file's content", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { plugin: "plug", path: "scripts/hello.ts", input: { a: 1 } });
    assert.equal(r.isError, undefined, textOf(r));
    const row = at(f.registry.list(), 0);
    if (!(row instanceof ScriptTaskRow)) assert.fail("the row is a script row");
    assert.equal(
      row.code,
      `export default input === undefined ? { help: true } : { echoed: input };`,
    );
  } finally {
    f.cleanup();
  }
});

test("task row: a plugin call that fails to read its file leaves the code empty", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { plugin: "plug", path: "scripts/missing.ts" });
    assert.equal(r.isError, true, textOf(r));
    const row = at(f.registry.list(), 0);
    if (!(row instanceof ScriptTaskRow)) assert.fail("the row is a script row");
    assert.equal(row.code, "");
  } finally {
    f.cleanup();
  }
});
