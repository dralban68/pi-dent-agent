import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BootSnapshot, ToolResult } from "../../lib/engine.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { HostSession } from "../../lib/host.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import { makeScriptTool } from "../../lib/script-tool.ts";
import { bundledAliases } from "../../lib/bundled.ts";

/**
 * Script tool behaviour that stands apart from the rest of the suite
 * (specs/script-tool.md#execution-model, specs/script-tool.md#module-contract, specs/script-tool.md#result-contract, specs/script-tool.md#timeout-delivery): non-Error throws, bundled package
 * resolution, wrapper-independent process, non-string stacks, post-settlement
 * output, the console surface, primitive module.exports, pre-clone rendering, and
 * chdir validation.
 */

interface Fixture {
  tool: ReturnType<typeof makeScriptTool>;
  registry: TaskRegistry;
  root: string;
  cleanup: () => void;
}

function makeFixture(extraEnv?: Record<string, string>): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-script-review-"));
  const boot = { pluginIndex: new Map() } as unknown as BootSnapshot;
  const host: HostSession = {
    cwd: () => root,
    sessionId: () => "sess-test",
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
  const tool = makeScriptTool({
    boot,
    registry: () => registry,
    hostProvider: () => host,
    cohortFor: (id) => `cohort-${id}`,
    agentDir: () => join(root, "agent"),
    ...(extraEnv === undefined ? {} : { extraEnv: () => extraEnv }),
  });
  return { tool, registry, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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
  const first = result.content[0];
  if (first?.type !== "text") assert.fail("expected text content");
  return first.text;
}

/** Run `runScript` in a child node process so a host-thread crash is observable. */
async function runInChild(code: string): Promise<{ code: number | null; out: string }> {
  const runner = join(import.meta.dirname, "..", "..", "lib", "script-runner.ts");
  const payload = [
    `import { runScript } from ${JSON.stringify(runner)};`,
    `const handle = runScript({`,
    `  code: ${JSON.stringify(code)},`,
    `  filename: ${JSON.stringify(join(tmpdir(), "pi-dent-review-child", "__pi_dent_script__.ts"))},`,
    `  cwd: process.env.PI_DENT_REVIEW_CWD ?? process.cwd(),`,
    `  input: undefined,`,
    `  aliases: {},`,
    `});`,
    `const result = await handle.promise;`,
    `console.log(JSON.stringify({ exitReason: result.exitReason, error: result.error }));`,
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", payload], {
      cwd: tmpdir(),
      env: { ...process.env },
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk.toString()));
    child.stderr.on("data", (chunk) => (out += chunk.toString()));
    child.on("close", (exitCode) => resolve({ code: exitCode, out }));
  });
}

const BUNDLED_NAMES = [
  "cheerio",
  "csv-parse",
  "csv-stringify",
  "fast-xml-parser",
  "file-type",
  "glob",
  "gray-matter",
  "ini",
  "js-yaml",
  "jsonc-parser",
  "jszip",
  "semver",
  "smol-toml",
];

test("bundled packages: every alias targets a real installed package", () => {
  const aliases = bundledAliases();
  for (const name of BUNDLED_NAMES) {
    const target = aliases[name];
    assert.ok(target, `${name}: alias present`);
    // Walk up from the alias target to its owning package.json and check it
    // names the package itself (covers both package-root aliases and
    // entry-file aliases such as file-type's).
    let dir = target;
    let owner: string | undefined;
    while (true) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name: string;
        };
        if (pkg.name === name) owner = dir;
        break;
      } catch {
        if (dir === dirname(dir)) break;
        dir = dirname(dir);
      }
    }
    assert.ok(owner, `${name}: alias target lives inside its own package`);
  }
});

test("return value: class instances render via util.inspect; array holes are not JSON-compatible", async () => {
  const f = makeFixture();
  try {
    const cls = await call(f, {
      code: `class P { constructor() { this.x = 1; } }; export default new P();`,
    });
    const clsDetails = cls.details as Record<string, unknown>;
    const clsValue = clsDetails.returnValue as { type: string; representation: string };
    assert.equal(clsValue.type, "non-json-return-value", JSON.stringify(clsValue));
    assert.match(clsValue.representation, /P \{ x: 1 \}/);

    const hole = await call(f, { code: `export default [, 1];` });
    const holeDetails = hole.details as Record<string, unknown>;
    const holeValue = holeDetails.returnValue as { type: string; representation: string };
    assert.equal(holeValue.type, "non-json-return-value", JSON.stringify(holeValue));
    assert.match(holeValue.representation, /undefined/);
  } finally {
    f.cleanup();
  }
});

test("chdir: a missing or non-directory path is rejected", async () => {
  const f = makeFixture();
  try {
    writeFileSync(join(f.root, "plain.txt"), "x");
    const missing = await call(f, { code: `process.chdir("nope"); export default 1;` });
    assert.equal((missing.details as Record<string, unknown>).exitReason, "threw");
    assert.match(textOf(missing), /ENOENT/);
    const notDir = await call(f, { code: `process.chdir("plain.txt"); export default 1;` });
    assert.equal((notDir.details as Record<string, unknown>).exitReason, "threw");
    assert.match(textOf(notDir), /ENOTDIR/);
    // Valid directories still work.
    mkdirSync(join(f.root, "sub"));
    const ok = await call(f, { code: `process.chdir("sub"); process.cwd();` });
    assert.equal((ok.details as Record<string, unknown>).exitReason, "ok");
  } finally {
    f.cleanup();
  }
});

test("module.exports: a primitive or null is the return value", async () => {
  const f = makeFixture();
  try {
    for (const [code, expected] of [
      ["module.exports = 5;", "\n5\n"],
      ["module.exports = null;", "\nnull\n"],
      ['module.exports = "boxed";', '\n"boxed"\n'],
    ] as const) {
      const r = await call(f, { code });
      const text = textOf(r);
      assert.ok(text.includes(`--- return ---${expected}---`), `code ${code} -> ${text}`);
      assert.doesNotMatch(text, /TypeError|Cannot use 'in' operator/);
    }
  } finally {
    f.cleanup();
  }
});

test("console: the captured console has the full Node surface", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: [
        "console.dir({ a: 1 }, { depth: 0 });",
        "console.table([{ x: 1 }]);",
        'console.time("t"); console.timeEnd("t");',
        'console.log("%s", 7);',
        "export default 1;",
      ].join("\n"),
    });
    const text = textOf(r);
    assert.match(text, /a: 1/);
    assert.match(text, /(x|columns)/);
    assert.match(text, /t: [0-9.]+m?s/);
    assert.match(text, /7/);
  } finally {
    f.cleanup();
  }
});

test("output: nothing arriving after settlement lands after the exit block", async () => {
  const f = makeFixture();
  try {
    // Output (under the 1 MiB cap in total) floods the port in bursts for 4 s
    // while the 2000 ms timeout settles the run; chunks delivered after the
    // suffix was appended used to land after `--- exited ...` in the output
    // file. The bursts span the timeout however late the worker starts.
    const r = await call(f, {
      background: true,
      timeout: 2000,
      code: `for (let n = 0; n < 40; n++) { for (let i = 0; i < 10000; i++) console.log("t"); await new Promise((r) => setTimeout(r, 100)); } await new Promise(() => {});`,
    });
    const details = r.details as Record<string, unknown>;
    assert.equal(details.background, true);
    const taskId = details.taskId as string;
    assert.ok(taskId);
    // Wait for the settlement itself, not a fixed time: under load it is late.
    const deadline = Date.now() + 30000;
    while (f.registry.get(taskId)?.status === "running" && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
    }
    const row = f.registry.get(taskId);
    assert.ok(row);
    assert.notEqual(row.status, "running");
    // Let any chunk still in flight after the settlement arrive.
    await new Promise((res) => setTimeout(res, 500));
    const out = readFileSync(details.outputPath as string, "utf8");
    const exitIndex = out.lastIndexOf("--- exited");
    assert.ok(exitIndex >= 0, `no exit block in output: ${out.slice(0, 200)}`);
    const tail = out.slice(out.indexOf("\n", exitIndex));
    assert.doesNotMatch(
      tail,
      /^t$/m,
      `output landed after the exit block: ${out.slice(exitIndex, exitIndex + 400)}`,
    );
    assert.match(out, /\nt\n/);
  } finally {
    f.cleanup();
  }
});

test("threw: a non-string stack still renders the thrown error", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      cwd: f.root,
      code: `const e = new Error("boom"); e.stack = 42; throw e;`,
    });
    assert.equal(r.details.exitReason, "threw", textOf(r));
    // The error section must render the coerced stack, not a tool-side crash.
    assert.match(textOf(r), /boom/);
    assert.match(textOf(r), /42/);
  } finally {
    f.cleanup();
  }
});

test("helper module: the worker process sees the script cwd and chdir", async () => {
  const f = makeFixture();
  try {
    writeFileSync(
      join(f.root, "helper.ts"),
      [
        // The helper module reads the worker realm's real process, not the
        // entry script's proxy: bare global, ESM default import, and
        // getBuiltinModule must all observe the wrapper-independent state.
        "export function cwdBare() { return process.cwd(); }",
        'import processImported from "node:process";',
        "export function cwdImported() { return processImported.cwd(); }",
        "export function chdirImported(d: string) { processImported.chdir(d); }",
        "export function exitImported(code: number) { processImported.exit(code); }",
        "export function exitBare(code: number) { process.exit(code); }",
      ].join("\n"),
      "utf8",
    );
    // chdir now requires a real directory (finding 10).
    mkdirSync(join(f.root, "sub"));
    const r = await call(f, {
      cwd: f.root,
      code: [
        "import * as helper from './helper.ts';",
        "const observed = { bare: helper.cwdBare(), imported: helper.cwdImported() };",
        "helper.chdirImported('sub');",
        "const afterChdir = process.cwd(); // entry-script proxy must see it too",
        "export default { observed, afterChdir };",
      ].join("\n"),
    });
    assert.equal(r.details.exitReason, "ok", textOf(r));
    const value = r.details.returnValue as {
      observed: { bare: string; imported: string };
      afterChdir: string;
    };
    assert.equal(value.observed.bare, f.root, "bare process.cwd() in helper");
    assert.equal(value.observed.imported, f.root, "ESM-imported process.cwd() in helper");
    assert.equal(value.afterChdir, join(f.root, "sub"), "helper chdir visible to entry proxy");
  } finally {
    f.cleanup();
  }
});

test("helper module: process.exit is intercepted, not fatal", async () => {
  const f = makeFixture();
  try {
    writeFileSync(
      join(f.root, "helper.ts"),
      "export function exitBare(code: number) { process.exit(code); }",
      "utf8",
    );
    const r = await call(f, {
      cwd: f.root,
      code: [
        "import { exitBare } from './helper.ts';",
        "export default { staged: true };",
        "exitBare(7);",
      ].join("\n"),
    });
    assert.equal(r.details.exitReason, "exit-called", textOf(r));
    assert.equal(r.details.exitCode, 7);
  } finally {
    f.cleanup();
  }
});

test("bundled packages: a script imports them from a cwd outside the repository", async () => {
  const f = makeFixture();
  try {
    // The fixture root lives under the OS tmpdir, outside the repository, so
    // Node's own resolution cannot find the repo's node_modules.
    const r = await call(f, {
      cwd: f.root,
      code: `
        const specifiers = ${JSON.stringify([...BUNDLED_NAMES, "csv-parse/sync"])};
        const outcome = {};
        for (const specifier of specifiers) {
          try {
            const mod = await import(specifier);
            outcome[specifier] = Object.keys(mod).length > 0 ? "ok" : "empty";
          } catch (error) {
            outcome[specifier] = "threw: " + String(error).slice(0, 120);
          }
        }
        export default outcome;
      `,
    });
    assert.equal(r.details.exitReason, "ok", textOf(r));
    for (const [specifier, outcome] of Object.entries(
      r.details.returnValue as Record<string, string>,
    )) {
      assert.equal(outcome, "ok", `${specifier}: ${outcome}`);
    }
  } finally {
    f.cleanup();
  }
});

test("threw: a non-Error throw from a timer settles the run, not the host", async () => {
  const f = makeFixture();
  try {
    // The delay keeps the run unsettled until the timer throws, so the value
    // reaches the runner's worker 'error' handler; the whole scenario runs in a
    // child process because the defect crashes the host thread itself.
    for (const thrown of ["undefined", "null"]) {
      const crashed = await runInChild(
        `setTimeout(() => { throw ${thrown}; }, 10);\nawait new Promise((res) => setTimeout(res, 300));`,
      );
      assert.equal(
        crashed.code,
        0,
        `throw ${thrown}: child died instead of settling: ${crashed.out}`,
      );
      assert.match(crashed.out, /"exitReason":"threw"/, `throw ${thrown}: ${crashed.out}`);
      assert.match(crashed.out, /"name":"Error"/, `throw ${thrown}: ${crashed.out}`);
    }
    const strThrown = await runInChild(
      `setTimeout(() => { throw "str"; }, 10);\nawait new Promise((res) => setTimeout(res, 300));`,
    );
    assert.equal(strThrown.code, 0, `throw "str": child died: ${strThrown.out}`);
    assert.match(strThrown.out, /"message":"str"/, `throw "str": ${strThrown.out}`);
  } finally {
    f.cleanup();
  }
});

test("a child process spawned with its own env still gets PI_DENT_SESSION_DIR", async () => {
  const f = makeFixture({ PI_DENT_SESSION_DIR: "/session/dir" });
  try {
    const code = `
      import { exec } from "node:child_process";
      import { promisify } from "node:util";
      const run = async (env) =>
        (await promisify(exec)("echo $PI_DENT_SESSION_DIR", { env })).stdout.trim();
      export default [
        await run({ PATH: process.env.PATH }),
        await run({ PATH: process.env.PATH, PI_DENT_SESSION_DIR: "/mine" }),
      ];`;
    const r = await call(f, { code });
    assert.deepEqual(r.details?.returnValue, ["/session/dir", "/mine"]);
  } finally {
    f.cleanup();
  }
});
