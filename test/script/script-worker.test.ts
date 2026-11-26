import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootSnapshot, ToolResult } from "../../lib/engine.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { HostSession } from "../../lib/host.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import { makeScriptTool } from "../../lib/script-tool.ts";
import { at } from "../support/must.ts";

/**
 * Script worker internals per specs/script-tool.md#execution-model and specs/script-tool.md#timeout-delivery: the
 * process.exit gate (no script code runs after the call), the detached
 * process-group default for spawned children, and the child stdio resolution
 * that keeps the host's standard streams from a script's children. Integration
 * through the tool's public `execute` surface against a real worker thread.
 */

interface Fixture {
  tool: ReturnType<typeof makeScriptTool>;
  registry: TaskRegistry;
  root: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-script-worker-"));
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
  assert.equal(result.content.length, 1, "one text content block");
  const first = at(result.content, 0);
  if (first.type !== "text") assert.fail(`expected text content, got ${first.type}`);
  return first.text;
}

const pgidHelper = `
const pgidOf = (pid) =>
  new Promise((resolve, reject) => {
    execFile("ps", ["-o", "pgid=", "-p", String(pid)], (err, stdout) =>
      err ? reject(err) : resolve(Number(String(stdout).trim())),
    );
  });
`;

test("exit gate: no script code runs after process.exit", async () => {
  const f = makeFixture();
  try {
    const work = join(f.root, "work");
    mkdirSync(work, { recursive: true });
    const r = await call(f, {
      cwd: work,
      code: `
        import { writeFileSync } from "node:fs";
        setTimeout(() => writeFileSync("timer.txt", "T"), 10);
        await null;
        process.exit(3);
        writeFileSync("sync.txt", "S");
        await Promise.resolve().then(() => writeFileSync("continuation.txt", "C"));
        export default 1;
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.exitReason, "exit-called");
    assert.equal(r.details.exitCode, 3);
    // The synchronous write after the call, the await-continuation after it,
    // and the timer registered before it must all have been prevented.
    for (const name of ["sync.txt", "continuation.txt", "timer.txt"]) {
      assert.equal(existsSync(join(work, name)), false, `${name} not in script cwd`);
      assert.equal(existsSync(join(f.root, name)), false, `${name} not in fixture root`);
      assert.equal(existsSync(join(process.cwd(), name)), false, `${name} not in host cwd`);
    }
  } finally {
    f.cleanup();
  }
});

/**
 * Whether `pid` leaves the process table within `timeoutMs`; a terminated process
 * whose parent has not reaped it stays there.
 */
async function pidGoneWithin(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((res) => setTimeout(res, 25));
  }
}

test("exit gate: process.exit with a running child leaves no zombie", async () => {
  const f = makeFixture();
  try {
    const work = join(f.root, "work");
    mkdirSync(work, { recursive: true });
    const r = await call(f, {
      cwd: work,
      code: `
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        const child = spawn("sleep", ["30"]);
        writeFileSync("child.pid", String(child.pid));
        process.exit(0);
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.exitReason, "exit-called");
    const pid = Number(readFileSync(join(work, "child.pid"), "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 0, "the script recorded its child's pid");
    // The runner kills the tree after settlement (specs/script-tool.md#timeout-delivery); the child must leave
    // the process table, not linger as a zombie of the host process.
    const gone = await pidGoneWithin(pid);
    assert.ok(gone, `pid ${pid} is still in the process table after settlement`);
  } finally {
    f.cleanup();
  }
});

test("exit gate: process.exit from a timer settles exit-called with its code", async () => {
  const f = makeFixture();
  try {
    // The call leaves a callback rather than the script's own flow: the exit still
    // settles the run, with no error of the worker's own reported afterwards.
    const r = await call(f, {
      code: `setTimeout(() => process.exit(5), 10); await new Promise(() => {});`,
    });
    assert.equal(r.details.exitReason, "exit-called", textOf(r));
    assert.equal(r.details.exitCode, 5);
    assert.equal(r.details.stderr, "");
  } finally {
    f.cleanup();
  }
});

test("exit gate: node:timers/promises timers never settle after process.exit", async () => {
  const f = makeFixture();
  try {
    const work = join(f.root, "timer-promises");
    mkdirSync(work, { recursive: true });
    // The child keeps the worker alive past the exit, so a timer of the promises module
    // that is still pending at the call has its chance to run (specs/script-tool.md#execution-model).
    const r = await call(f, {
      cwd: work,
      code: `
        import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        import {
          scheduler,
          setImmediate as soon,
          setInterval as repeat,
          setTimeout as sleep,
        } from "node:timers/promises";
        spawn("sleep", ["30"]);
        const write = (name) => () => writeFileSync(name, "x");
        sleep(20).then(write("sleep.txt"), () => {});
        soon().then(write("immediate.txt"), () => {});
        (async () => {
          for await (const _ of repeat(20)) writeFileSync("interval.txt", "x");
        })().catch(() => {});
        if (scheduler?.wait) scheduler.wait(20).then(write("scheduler.txt"), () => {});
        process.exit(0);
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.exitReason, "exit-called", textOf(r));
    for (const name of ["sleep.txt", "immediate.txt", "interval.txt", "scheduler.txt"]) {
      assert.equal(existsSync(join(work, name)), false, `${name} was written after the exit`);
    }
  } finally {
    f.cleanup();
  }
});

test("node:timers/promises setInterval keeps its iterator methods", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `
        import { setInterval } from "node:timers/promises";
        const direct = setInterval(5, 7);
        const first = await direct.next();
        const closed = await direct.return();
        let seen = 0;
        for await (const value of setInterval(5, 3)) {
          seen += value;
          break;
        }
        export default [first.value, closed.done, seen];
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /\[\s*7,\s*true,\s*3\s*\]/);
  } finally {
    f.cleanup();
  }
});

test("detached default: spawned children lead their own process group", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `
        import { exec, execFile, spawn } from "node:child_process";
        ${pgidHelper}
        const children = [];
        let result;
        try {
          const sp = spawn("sh", ["-c", "sleep 30"]);
          children.push(sp);
          const ex = exec("sleep 30", () => {});
          children.push(ex);
          const ef = execFile("sleep", ["30"], () => {});
          children.push(ef);
          // execFile with a callback and no args: options must be inserted
          // before the callback or Node drops them.
          const efCb = execFile("cat", () => {});
          children.push(efCb);
          result = {
            spawn: { pid: sp.pid, pgid: await pgidOf(sp.pid) },
            exec: { pid: ex.pid, pgid: await pgidOf(ex.pid) },
            execFileArgsCb: { pid: ef.pid, pgid: await pgidOf(ef.pid) },
            execFileCb: { pid: efCb.pid, pgid: await pgidOf(efCb.pid) },
          };
        } finally {
          for (const child of children) child.kill("SIGKILL");
        }
        export default result;
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.exitReason, "ok");
    const children = r.details.returnValue as Record<string, { pid: number; pgid: number }>;
    for (const [label, child] of Object.entries(children)) {
      assert.equal(child.pgid, child.pid, `${label}: pgid equals pid`);
    }
  } finally {
    f.cleanup();
  }
});

test("detached default: explicit detached false is respected", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `
        import { execFile, spawn } from "node:child_process";
        ${pgidHelper}
        const children = [];
        let result;
        try {
          const sp = spawn("sh", ["-c", "sleep 30"], { detached: false });
          children.push(sp);
          const ef = execFile("sleep", ["30"], { detached: false }, () => {});
          children.push(ef);
          result = {
            spawn: { pid: sp.pid, pgid: await pgidOf(sp.pid) },
            execFile: { pid: ef.pid, pgid: await pgidOf(ef.pid) },
          };
        } finally {
          for (const child of children) child.kill("SIGKILL");
        }
        export default result;
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.exitReason, "ok");
    const children = r.details.returnValue as Record<string, { pid: number; pgid: number }>;
    for (const [label, child] of Object.entries(children)) {
      assert.notEqual(child.pgid, child.pid, `${label}: pgid differs from pid`);
    }
  } finally {
    f.cleanup();
  }
});

test("sync child_process APIs (spawnSync, execSync, execFileSync) are rejected", async () => {
  const f = makeFixture();
  try {
    for (const fn of ["spawnSync", "execSync", "execFileSync"]) {
      const r = await call(f, {
        code: `
          import * as cp from "node:child_process";
          cp.${fn}("true");
          export default "unreachable";
        `,
      });
      assert.equal(r.isError, true, `${fn}: should fail`);
      assert.equal(r.details.exitReason, "threw", `${fn}: exitReason is threw`);
      assert.match(textOf(r), new RegExp(`child_process\\.${fn} is rejected in Script`));
    }
  } finally {
    f.cleanup();
  }
});

test("builtin patching: helper module's fs resolves relative paths against the script cwd", async () => {
  const f = makeFixture();
  try {
    const cwd = join(f.root, "work");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, "helper.ts"),
      `import { existsSync } from "node:fs";\nexport const has = () => existsSync("marker");\n`,
    );
    writeFileSync(join(cwd, "marker"), "M");
    // The inline entry's filename lives at cwd, so "./helper.ts" resolves
    // under the script cwd and the helper's fs must observe that cwd too.
    const r = await call(f, {
      cwd,
      code: `import { has } from "./helper.ts";\nexport default { helper: has() };`,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.deepEqual(r.details.returnValue, { helper: true });
  } finally {
    f.cleanup();
  }
});

test("builtin patching: process.getBuiltinModule returns the cwd-observing fs", async () => {
  const f = makeFixture();
  try {
    const cwd = join(f.root, "work");
    mkdirSync(cwd, { recursive: true });
    const r = await call(f, {
      cwd,
      code: `
        import { writeFileSync } from "node:fs";
        writeFileSync("marker", "M");
        const fs2 = process.getBuiltinModule("fs");
        export default { viaBuiltin: fs2.existsSync("marker"), content: fs2.readFileSync("marker", "utf8") };
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.deepEqual(r.details.returnValue, { viaBuiltin: true, content: "M" });
  } finally {
    f.cleanup();
  }
});

test("builtin patching: createRequire(...)(child_process).execSync is rejected", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `
        import { createRequire } from "node:module";
        createRequire(import.meta.url)("child_process").execSync("true");
        export default "unreachable";
      `,
    });
    assert.equal(r.isError, true);
    assert.equal(r.details.exitReason, "threw");
    assert.match(textOf(r), /child_process\.execSync is rejected in Script/);
  } finally {
    f.cleanup();
  }
});

test("console capture: globalThis.console.log is captured (specs/script-tool.md#execution-model)", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `globalThis.console.log("via-global"); console.error("err-via-global"); export default 1;`,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.stdout, "via-global\n");
    assert.equal(r.details.stderr, "err-via-global\n");
  } finally {
    f.cleanup();
  }
});

test("script cwd: path.resolve resolves relative paths against cwd", async () => {
  const f = makeFixture();
  try {
    const work = join(f.root, "work");
    mkdirSync(work, { recursive: true });
    const r = await call(f, {
      cwd: work,
      code: `
        import path from "node:path";
        import { resolve } from "node:path";
        import barePath from "path";
        const cjsPath = require("node:path");
        const dynamicPath = await import("node:path");
        const getBuiltin = process.getBuiltinModule("node:path");
        export default {
          importPath: path.resolve("x"),
          namedResolve: resolve("x"),
          barePath: barePath.resolve("x"),
          cjsPath: cjsPath.resolve("x"),
          dynamicPath: dynamicPath.resolve("x"),
          getBuiltin: getBuiltin.resolve("x"),
          posix: path.posix.resolve("x"),
          noArgs: path.resolve(),
        };
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    const expected = join(work, "x");
    const val = r.details.returnValue as Record<string, string>;
    assert.equal(val.importPath, expected);
    assert.equal(val.namedResolve, expected);
    assert.equal(val.barePath, expected);
    assert.equal(val.cjsPath, expected);
    assert.equal(val.dynamicPath, expected);
    assert.equal(val.getBuiltin, expected);
    assert.equal(val.posix, expected);
    assert.equal(val.noArgs, work);
  } finally {
    f.cleanup();
  }
});

test("script cwd: child_process defaults cwd to script cwd", async () => {
  const f = makeFixture();
  try {
    const work = join(f.root, "work");
    mkdirSync(work, { recursive: true });
    const realWork = realpathSync(work);
    const r = await call(f, {
      cwd: work,
      code: `
        import { exec, execFile, spawn } from "node:child_process";
        import { promisify } from "node:util";

        const execAsync = promisify(exec);

        const { stdout: execOut } = await execAsync("pwd");

        const efOut = await new Promise((res, rej) => {
          execFile("pwd", (err, stdout) => (err ? rej(err) : res(stdout)));
        });

        const spawnOut = await new Promise((res, rej) => {
          const cp = spawn("pwd");
          let out = "";
          cp.stdout.on("data", (d) => (out += d.toString()));
          cp.on("error", rej);
          cp.on("close", () => res(out));
        });

        const explicitOut = await new Promise((res, rej) => {
          exec("pwd", { cwd: "/" }, (err, stdout) => (err ? rej(err) : res(stdout)));
        });

        export default {
          exec: execOut.trim(),
          execFile: String(efOut).trim(),
          spawn: spawnOut.trim(),
          explicit: explicitOut.trim(),
        };
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    const val = r.details.returnValue as Record<string, string>;
    assert.equal(val.exec, realWork);
    assert.equal(val.execFile, realWork);
    assert.equal(val.spawn, realWork);
    assert.equal(val.explicit, realpathSync("/"));
  } finally {
    f.cleanup();
  }
});

test("script cwd: process.chdir updates cwd for path.resolve and child_process", async () => {
  const f = makeFixture();
  try {
    const work = join(f.root, "work");
    const sub = join(work, "sub");
    mkdirSync(sub, { recursive: true });
    const realSub = realpathSync(sub);
    const r = await call(f, {
      cwd: work,
      code: `
        import path from "node:path";
        import { exec } from "node:child_process";
        process.chdir("sub");
        const resolved = path.resolve("target.txt");
        const pwd = await new Promise((res, rej) => {
          exec("pwd", (err, stdout) => (err ? rej(err) : res(stdout.trim())));
        });
        export default { resolved, pwd };
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    const val = r.details.returnValue as { resolved: string; pwd: string };
    assert.equal(val.resolved, join(sub, "target.txt"));
    assert.equal(val.pwd, realSub);
  } finally {
    f.cleanup();
  }
});

test("fs wrappers: the original's own properties survive (realpath native, promisify.custom)", async () => {
  const f = makeFixture();
  try {
    const cwd = join(f.root, "work");
    mkdirSync(cwd, { recursive: true });
    const realCwd = realpathSync(cwd);
    const root = JSON.stringify(f.root);
    const r = await call(f, {
      cwd,
      code: `
        import fs from "node:fs";
        import { exists } from "node:fs";
        import { promisify } from "node:util";
        export default {
          types: [typeof fs.realpathSync.native, typeof fs.realpath.native],
          nativeSync: fs.realpathSync.native("."),
          nativeAsync: await promisify(fs.realpath.native)("."),
          exists: await promisify(fs.exists)(${root}),
          namedExists: await promisify(exists)(${root}),
        };
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.deepEqual(r.details.returnValue, {
      types: ["function", "function"],
      nativeSync: realCwd,
      nativeAsync: realCwd,
      exists: true,
      namedExists: true,
    });
  } finally {
    f.cleanup();
  }
});

test("fs glob: the pattern is left alone and the cwd option defaults to the script cwd", async () => {
  const f = makeFixture();
  try {
    const cwd = join(f.root, "work");
    mkdirSync(join(cwd, "nested"), { recursive: true });
    writeFileSync(join(cwd, "nested", "inner.txt"), "x");
    const r = await call(f, {
      cwd,
      code: `
        import { glob, globSync } from "node:fs";
        import { glob as globPromise } from "node:fs/promises";
        const callGlob = (pattern, options) =>
          new Promise((res, rej) => {
            const cb = (err, matches) => (err ? rej(err) : res(matches));
            if (options === undefined) glob(pattern, cb);
            else glob(pattern, options, cb);
          });
        const collected = [];
        for await (const match of globPromise("nested/*.txt")) collected.push(match);
        export default {
          sync: globSync("nested"),
          syncOptions: globSync("inner.txt", { cwd: "nested" }),
          callback: await callGlob("../work/nested"),
          callbackOptions: await callGlob("inner.txt", { cwd: "nested" }),
          promises: collected,
        };
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.deepEqual(r.details.returnValue, {
      sync: ["nested"],
      syncOptions: ["inner.txt"],
      callback: ["../work/nested"],
      callbackOptions: ["inner.txt"],
      promises: ["nested/inner.txt"],
    });
  } finally {
    f.cleanup();
  }
});

test("script mode: a script may redeclare a pre-bound name (const, class, function, var)", async () => {
  const f = makeFixture();
  try {
    const cases: { code: string; expected: unknown }[] = [
      { code: `const input = 5;\ninput + 1`, expected: 6 },
      { code: `const crypto = require("node:crypto");\ncrypto.randomUUID().length`, expected: 36 },
      { code: `class input { static value() { return 3; } }\ninput.value()`, expected: 3 },
      { code: `function crypto() { return 1; }\ncrypto()`, expected: 1 },
      { code: `var crypto = 5;\nexport default crypto + 1;`, expected: 6 },
      { code: `var input = 5;\nexport default input + 1;`, expected: 6 },
    ];
    for (const { code, expected } of cases) {
      const r = await call(f, { code });
      assert.equal(r.isError, undefined, `${code}: ${textOf(r)}`);
      assert.equal(r.details.exitReason, "ok", code);
      assert.equal(r.details.returnValue, expected, code);
    }
  } finally {
    f.cleanup();
  }
});

test("script mode: stack lines stay aligned after the binding prologue", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `const x = 1;\nconst y = 2;\nthrow new Error("line check");` });
    assert.equal(r.isError, true);
    assert.equal(r.details.exitReason, "threw");
    // The recorded position is the user's own line 3, not the prologue's offset.
    assert.match(textOf(r), /__pi_dent_script__\.ts:3:7/);
  } finally {
    f.cleanup();
  }
});

test("error reporting: the error text is in stderr exactly once", async () => {
  const f = makeFixture();
  try {
    // The worker does not write it; the tool appends it at settlement (specs/script-tool.md#execution-model).
    const r = await call(f, { code: `console.error("partial"); throw new Error("dup");` });
    assert.equal(r.details.exitReason, "threw");
    const stderr = String(r.details.stderr);
    assert.equal(stderr.split("Error: dup").length - 1, 1);
    assert.ok(stderr.startsWith("partial\n"));
  } finally {
    f.cleanup();
  }
});

test("error reporting: a message spanning several lines writes its header once", async () => {
  const f = makeFixture();
  try {
    // The stack already carries both message lines; prepending the header again
    // would show them twice (specs/script-tool.md#execution-model).
    const r = await call(f, { code: `throw new Error("first line\\nsecond line");` });
    assert.equal(r.details.exitReason, "threw");
    const stderr = String(r.details.stderr);
    assert.equal(
      stderr.split("Error: first line\nsecond line").length - 1,
      1,
      `the header appears once: ${stderr}`,
    );
    assert.match(stderr, /\n\s+at /, "the stack still follows it");
  } finally {
    f.cleanup();
  }
});

test("child_process: a relative cwd option resolves against the script cwd", async () => {
  const f = makeFixture();
  try {
    const cwd = join(f.root, "work");
    const sub = join(cwd, "sub");
    mkdirSync(sub, { recursive: true });
    const realSub = realpathSync(sub);
    const r = await call(f, {
      cwd,
      code: `
        import { execFile, spawn } from "node:child_process";
        const collect = (cp) =>
          new Promise((res, rej) => {
            let out = "";
            cp.stdout.on("data", (d) => (out += d.toString()));
            cp.on("error", rej);
            cp.on("close", () => res(out.trim()));
          });
        const execFileOut = await new Promise((res, rej) => {
          execFile("pwd", { cwd: "sub" }, (err, stdout) =>
            err ? rej(err) : res(String(stdout).trim()),
          );
        });
        export default {
          execFile: execFileOut,
          spawnOptionsFirst: await collect(spawn("pwd", { cwd: "sub" })),
          spawnOptionsSecond: await collect(spawn("pwd", [], { cwd: "sub" })),
        };
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.deepEqual(r.details.returnValue, {
      execFile: realSub,
      spawnOptionsFirst: realSub,
      spawnOptionsSecond: realSub,
    });
  } finally {
    f.cleanup();
  }
});

// --- child stdio resolution (specs/script-tool.md#timeout-delivery) --------------------------------------
// A child process a script spawns never receives the host's standard streams:
// inherited elements resolve to captured pipes before the spawn.

test("child stdio: spawn stdio inherit captures the child's output; its stdout is not a TTY (specs/script-tool.md#timeout-delivery)", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `
        import { spawn } from "node:child_process";
        const child = spawn(
          "node",
          ["-p", "'child-out ' + String(process.stdout.isTTY)"],
          { stdio: "inherit" },
        );
        await new Promise((res) => child.on("close", res));
        export default { spawned: typeof child.pid };
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.exitReason, "ok", textOf(r));
    const stdout = String(r.details.stdout);
    // The child's stdout text lands in the run's captured output (previously:
    // painted straight onto the terminal, uncaptured), and the child's stdout
    // is not a terminal — the value the child itself reports is anything but
    // `true`.
    const match = /child-out (.+)/.exec(stdout);
    assert.ok(match, `child output captured: ${JSON.stringify(stdout)}`);
    assert.notEqual(at(match, 1), "true", `not a TTY: ${JSON.stringify(stdout)}`);
  } finally {
    f.cleanup();
  }
});

test("child stdio: inherit elements of an array stdio resolve to captured pipes (specs/script-tool.md#timeout-delivery)", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `
        import { spawn } from "node:child_process";
        const wait = (cp) => new Promise((res) => cp.on("close", res));
        const write = (name) =>
          ["-e", "console.log('OUT-" + name + "'); console.error('ERR-" + name + "');"];
        // Bracket form ...
        await wait(spawn("node", write("bracket"), { stdio: ["ignore", "inherit", "inherit"] }));
        // ... and the numeric host fds 0, 1, 2.
        await wait(spawn("node", write("fds"), { stdio: [0, 1, 2] }));
        export default 1;
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.exitReason, "ok", textOf(r));
    const stdout = String(r.details.stdout);
    const stderr = String(r.details.stderr);
    assert.match(stdout, /OUT-bracket/, `bracket stdout captured: ${JSON.stringify(stdout)}`);
    assert.match(stderr, /ERR-bracket/, `bracket stderr captured: ${JSON.stringify(stderr)}`);
    assert.match(stdout, /OUT-fds/, `numeric fds stdout captured: ${JSON.stringify(stdout)}`);
    assert.match(stderr, /ERR-fds/, `numeric fds stderr captured: ${JSON.stringify(stderr)}`);
  } finally {
    f.cleanup();
  }
});

test("child stdio: the worker's process.stdout/stderr elements resolve like inherit (specs/script-tool.md#timeout-delivery)", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `
        import { spawn } from "node:child_process";
        const wait = (cp) => new Promise((res) => cp.on("close", res));
        // The entry proxy serves a fresh capture stream per access ...
        await wait(
          spawn("node", ["-e", "console.log('proxy-out'); console.error('proxy-err');"], {
            stdio: [undefined, process.stdout, process.stderr],
          }),
        );
        // ... and the worker realm's real streams are reachable too.
        const real = process.getBuiltinModule("node:process");
        await wait(
          spawn("node", ["-e", "console.log('real-out'); console.error('real-err');"], {
            stdio: [undefined, real.stdout, real.stderr],
          }),
        );
        export default 1;
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.exitReason, "ok", textOf(r));
    const stdout = String(r.details.stdout);
    const stderr = String(r.details.stderr);
    assert.match(stdout, /proxy-out/, `proxy stdout captured: ${JSON.stringify(stdout)}`);
    assert.match(stderr, /proxy-err/, `proxy stderr captured: ${JSON.stringify(stderr)}`);
    assert.match(stdout, /real-out/, `real stdout captured: ${JSON.stringify(stdout)}`);
    assert.match(stderr, /real-err/, `real stderr captured: ${JSON.stringify(stderr)}`);
  } finally {
    f.cleanup();
  }
});

test("child stdio: fork's console output is captured, default and silent (specs/script-tool.md#timeout-delivery)", async () => {
  const f = makeFixture();
  try {
    const mod = join(f.root, "forked.mjs");
    writeFileSync(mod, `console.log("fork-out"); console.error("fork-err");\n`);
    const r = await call(f, {
      code: `
        import { fork } from "node:child_process";
        const mod = ${JSON.stringify(mod)};
        const wait = (cp) => new Promise((res) => cp.on("close", res));
        await wait(fork(mod));
        await wait(fork(mod, {}));
        // silent: true pipes the child's stdio without printing it; without
        // forwarding, its output would be silently dropped.
        await wait(fork(mod, { silent: true }));
        export default 1;
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.exitReason, "ok", textOf(r));
    const stdout = String(r.details.stdout);
    const stderr = String(r.details.stderr);
    // Each of the three forks (no options, empty options, silent) contributes
    // exactly one copy of each marker to its own stream.
    for (const marker of ["fork-out", "fork-err"]) {
      const expected = marker === "fork-out" ? stdout : stderr;
      assert.equal(
        expected.split(marker).length - 1,
        3,
        `${marker} captured from all three forks: ${JSON.stringify(expected)}`,
      );
    }
  } finally {
    f.cleanup();
  }
});

test("child stdio: an already-open file element passes through unchanged (specs/script-tool.md#timeout-delivery)", async () => {
  const f = makeFixture();
  try {
    const target = join(f.root, "passthrough.log");
    const r = await call(f, {
      code: `
        import { spawn } from "node:child_process";
        import { closeSync, openSync, readFileSync } from "node:fs";
        const target = ${JSON.stringify(target)};
        const fd = openSync(target, "w");
        const child = spawn("node", ["-p", "'file-bytes'"], { stdio: ["ignore", fd, "pipe"] });
        await new Promise((res) => child.on("close", res));
        closeSync(fd);
        export default { file: readFileSync(target, "utf8") };
      `,
    });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.exitReason, "ok", textOf(r));
    // The file received the child's bytes ...
    const ret = r.details.returnValue as { file?: string };
    assert.equal(ret.file, "file-bytes\n");
    // ... and they were not double-captured into the run's output.
    const stdout = String(r.details.stdout);
    assert.ok(!stdout.includes("file-bytes"), `not double-captured: ${JSON.stringify(stdout)}`);
  } finally {
    f.cleanup();
  }
});
