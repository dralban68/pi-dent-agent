import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginEntry } from "../../lib/plugins.ts";
import {
  PLUGIN_UI_INSPECT_WIDGET_KEY,
  PluginUiInspectController,
  pluginUiInspectEnabled,
  PLUGIN_UI_TOOL_DESCRIPTION,
} from "../../lib/plugin-ui-inspect.ts";
import {
  PLUGIN_UI_EXCLUDED_TOOLS,
  PLUGIN_UI_WIDGET_KEY,
  PluginUiController,
} from "../../lib/plugin-ui.ts";
import { toolDeclarations } from "../../lib/script-tool-types.ts";
import { must } from "../support/must.ts";

/**
 * `PluginUI` tool and inspection feed conformance per specs/plugin-ui-tool.md,
 * specs/plugin-ui.md Sections 1, 2, 4.2, 6, 7, 8, and specs/plugin-state.md Section 6.
 */

const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

function makeFixtureEnv() {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-plugin-ui-tool-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const pluginRoot = join(root, "plugins", "demo");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
  const entry: PluginEntry = { name: "demo", root: pluginRoot, commands: [] };
  const pluginIndex = new Map<string, PluginEntry>([["demo", entry]]);
  return {
    root,
    cwd,
    agentDir,
    pluginRoot,
    pluginIndex,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeRecorder() {
  const records: Array<{ key: string; payload: Record<string, unknown> }> = [];
  const listeners: Array<(key: string, payload: Record<string, unknown>) => void> = [];
  return {
    records,
    setWidget(key: string, lines: string[] | undefined) {
      if (!lines || lines.length === 0) return;
      const payload = JSON.parse(must(lines[0])) as Record<string, unknown>;
      records.push({ key, payload });
      const snapshot = listeners.slice();
      for (const fn of snapshot) fn(key, payload);
    },
    waitFor(predicate: (r: { key: string; payload: Record<string, unknown> }) => boolean) {
      const existing = records.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<{ key: string; payload: Record<string, unknown> }>((resolve) => {
        const fn = (key: string, payload: Record<string, unknown>) => {
          if (predicate({ key, payload })) {
            const idx = listeners.indexOf(fn);
            if (idx !== -1) listeners.splice(idx, 1);
            resolve({ key, payload });
          }
        };
        listeners.push(fn);
      });
    },
  };
}

test("Section 1: gating requires RPC mode and PI_DENT_UI_INSPECT=1; description states live and fixtures caveats", () => {
  assert.equal(pluginUiInspectEnabled({ PI_DENT_UI_INSPECT: "1" }, "rpc"), true);
  assert.equal(pluginUiInspectEnabled({ PI_DENT_UI_INSPECT: "0" }, "rpc"), false);
  assert.equal(pluginUiInspectEnabled({}, "rpc"), false);
  assert.equal(pluginUiInspectEnabled({ PI_DENT_UI_INSPECT: "1" }, "tui"), false);
  assert.equal(pluginUiInspectEnabled({ PI_DENT_UI_INSPECT: "1" }, "print"), false);
  assert.equal(PLUGIN_UI_EXCLUDED_TOOLS.has("PluginUI"), true);
  assert.match(PLUGIN_UI_TOOL_DESCRIPTION, /live: true.*writes reach the real system/s);
  assert.match(PLUGIN_UI_TOOL_DESCRIPTION, /fixtures module.*replaces tool calls only/s);
});

test("Section 2 & 4: parameter and step validation errors follow the specified order and texts", async () => {
  const env = makeFixtureEnv();
  try {
    const inspect = new PluginUiInspectController({
      pluginIndex: env.pluginIndex,
      cancelCheckCalls: () => {},
    });
    const rec = makeRecorder();
    const ctx = { cwd: env.cwd, agentDir: env.agentDir, setWidget: rec.setWidget };

    const badField = await inspect.execute(
      { action: "shot", plugin: "demo", timeout: 5000, live: true },
      ctx,
    );
    assert.equal(badField.isError, true);
    assert.equal(
      badField.content[0]?.type === "text" ? badField.content[0].text : "",
      'field "timeout" is not valid for action "shot"',
    );

    const unknownPlugin = await inspect.execute({ action: "shot", plugin: "nope" }, ctx);
    assert.equal(unknownPlugin.isError, true);
    assert.equal(
      unknownPlugin.content[0]?.type === "text" ? unknownPlugin.content[0].text : "",
      'unknown plugin "nope"',
    );

    const exclusive = await inspect.execute(
      { action: "check", plugin: "demo", tools: "f.ts", live: true },
      ctx,
    );
    assert.equal(exclusive.isError, true);
    assert.equal(
      exclusive.content[0]?.type === "text" ? exclusive.content[0].text : "",
      "tools and live are mutually exclusive",
    );

    const loadShot = await inspect.execute(
      { action: "check", plugin: "demo", steps: [{ screenshot: "Load" }] },
      ctx,
    );
    assert.equal(loadShot.isError, true);
    assert.match(
      loadShot.content[0]?.type === "text" ? loadShot.content[0].text : "",
      /^steps\[0\]:/,
    );

    const dupShot = await inspect.execute(
      { action: "check", plugin: "demo", steps: [{ screenshot: "One" }, { screenshot: "one" }] },
      ctx,
    );
    assert.equal(dupShot.isError, true);
    assert.match(
      dupShot.content[0]?.type === "text" ? dupShot.content[0].text : "",
      /^steps\[1\]:/,
    );

    const tooManyShots = await inspect.execute(
      {
        action: "check",
        plugin: "demo",
        steps: Array.from({ length: 17 }, (_, i) => ({ screenshot: `s${i}` })),
      },
      ctx,
    );
    assert.equal(tooManyShots.isError, true);
    assert.equal(
      tooManyShots.content[0]?.type === "text" ? tooManyShots.content[0].text : "",
      "at most 16 screenshot steps",
    );

    const missingFixtures = await inspect.execute(
      { action: "check", plugin: "demo", tools: "missing.mjs" },
      ctx,
    );
    assert.equal(missingFixtures.isError, true);
    assert.match(
      missingFixtures.content[0]?.type === "text" ? missingFixtures.content[0].text : "",
      /^fixtures module not readable:/,
    );

    const badFixturesPath = join(env.cwd, "bad-fixtures.mjs");
    writeFileSync(badFixturesPath, "export default { ok: 123 };\n", "utf8");
    const badShape = await inspect.execute(
      { action: "check", plugin: "demo", tools: "bad-fixtures.mjs" },
      ctx,
    );
    assert.equal(badShape.isError, true);
    assert.match(
      badShape.content[0]?.type === "text" ? badShape.content[0].text : "",
      /^fixtures module not loaded:/,
    );
  } finally {
    env.cleanup();
  }
});

test("Section 3 & 6: shot emits inspect/1 record, handles concurrent rejection, attaches PNG, and rewrites paths", async () => {
  const env = makeFixtureEnv();
  try {
    const inspect = new PluginUiInspectController({
      pluginIndex: env.pluginIndex,
      cancelCheckCalls: () => {},
    });
    const ui = new PluginUiController(env.pluginIndex);
    ui.setInspectBridge(inspect);
    const rec = makeRecorder();
    const ctx = { cwd: env.cwd, agentDir: env.agentDir, setWidget: rec.setWidget };

    const pendingShot = inspect.execute({ action: "shot", plugin: "demo" }, ctx);
    const emitted = await rec.waitFor((r) => r.key === PLUGIN_UI_INSPECT_WIDGET_KEY);
    assert.equal(emitted.payload.piDent, "inspect/1");
    assert.equal(emitted.payload.type, "shot");
    assert.equal(emitted.payload.namespace, "demo");
    assert.equal(emitted.payload.root, env.pluginRoot);
    const id = String(emitted.payload.id);
    assert.match(id, /^i\d+-[0-9a-f]{8}$/);
    const outDir = String(emitted.payload.out);
    assert.equal(existsSync(outDir), true);

    // Concurrent call rejected immediately.
    const concurrent = await inspect.execute({ action: "shot", plugin: "demo" }, ctx);
    assert.equal(concurrent.isError, true);
    assert.equal(
      concurrent.content[0]?.type === "text" ? concurrent.content[0].text : "",
      "another PluginUI call is running",
    );

    writeFileSync(join(outDir, "shot.png"), TINY_PNG);
    writeFileSync(
      join(outDir, "report.json"),
      JSON.stringify({ alpha: "inspect/1", screenshot: "shot.png" }),
      "utf8",
    );
    ui.handleCommand(`result ${JSON.stringify({ id, ok: true })}`, {
      cwd: env.cwd,
      setWidget: rec.setWidget,
    });

    const result = await pendingShot;
    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 2);
    const textPart = result.content[0];
    assert.equal(textPart?.type, "text");
    assert.ok(textPart.text.includes(join(outDir, "shot.png")));
    assert.ok(textPart.text.endsWith(`\nFull report: ${join(outDir, "report.json")}`));
    const imgPart = result.content[1];
    assert.equal(imgPart?.type, "image");
    assert.equal(imgPart.mimeType, "image/png");
    assert.equal(imgPart.data, TINY_PNG.toString("base64"));
    assert.deepEqual(result.details, {
      action: "shot",
      plugin: "demo",
      outputDir: outDir,
      reportPath: join(outDir, "report.json"),
      screenshots: [join(outDir, "shot.png")],
      ok: true,
    });
  } finally {
    env.cleanup();
  }
});

test("Section 3 & 5: check with fixtures backend routes tool calls and scratch dent.state, and cleans up on settle", async () => {
  const env = makeFixtureEnv();
  try {
    const fixturesFile = join(env.cwd, "fixtures.mjs");
    writeFileSync(
      fixturesFile,
      `let count = 0;
export default {
  DemoTool: async (args) => ({ count: ++count, echo: args?.x }),
  ShapedTool: () => ({ text: "shaped", details: { ok: true } }),
  Script: () => "must-not-run",
};
`,
      "utf8",
    );
    writeFileSync(
      join(env.pluginRoot, "scripts", "check-probe.mjs"),
      `await dent.state.set("k", "ws-val");
await dent.state.user.set("u", "user-val");
const a = await tools.DemoTool({ x: "first" });
const b = await tools.DemoTool({ x: "second" });
const shaped = await tools.ShapedTool({});
let scriptErr = null;
try {
  await tools.Script({});
} catch (e) {
  scriptErr = e.message;
}
export default {
  a: JSON.parse(a.text),
  b: JSON.parse(b.text),
  shapedText: shaped.text,
  scriptErr,
  wsVal: await dent.state.get("k"),
  userVal: await dent.state.user.get("u"),
  toolTypes: dent.toolTypes(),
};
`,
      "utf8",
    );

    const ui = new PluginUiController(env.pluginIndex);
    const inspect = new PluginUiInspectController({
      pluginIndex: env.pluginIndex,
      cancelCheckCalls: (checkId, reason) => ui.cancelForCheck(checkId, reason),
    });
    ui.setInspectBridge(inspect);
    const rec = makeRecorder();

    const pendingCheck = inspect.execute(
      { action: "check", plugin: "demo", tools: "fixtures.mjs", steps: [{ wait: 10 }] },
      { cwd: env.cwd, agentDir: env.agentDir, setWidget: rec.setWidget },
    );

    const emitted = await rec.waitFor((r) => r.key === PLUGIN_UI_INSPECT_WIDGET_KEY);
    const checkId = String(emitted.payload.id);
    const outDir = String(emitted.payload.out);
    const stateDir = String(emitted.payload.state);
    assert.equal(emitted.payload.type, "check");
    assert.equal("tools" in emitted.payload, false);
    assert.equal("backend" in emitted.payload, false);
    assert.equal(existsSync(stateDir), true);

    // Unknown check rejected on /dent-ui run.
    ui.handleCommand(
      `run ${JSON.stringify({ id: "bad-chk", namespace: "demo", root: env.pluginRoot, path: "scripts/check-probe.mjs", check: "nope" })}`,
      { cwd: env.cwd, setWidget: rec.setWidget },
    );
    const badReply = await rec.waitFor(
      (r) => r.key === PLUGIN_UI_WIDGET_KEY && r.payload.id === "bad-chk",
    );
    assert.equal(badReply.payload.ok, false);
    assert.equal(badReply.payload.error, 'Unknown UI check "nope"');

    // Valid check run uses fixtures worker + scratch state dir.
    ui.handleCommand(
      `run ${JSON.stringify({ id: "probe-1", namespace: "demo", root: env.pluginRoot, path: "scripts/check-probe.mjs", check: checkId })}`,
      { cwd: env.cwd, setWidget: rec.setWidget },
    );
    const probeReply = await rec.waitFor(
      (r) => r.key === PLUGIN_UI_WIDGET_KEY && r.payload.id === "probe-1",
    );
    assert.equal(probeReply.payload.ok, true);
    const val = probeReply.payload.value as Record<string, unknown>;
    assert.deepEqual(val.a, { count: 1, echo: "first" });
    assert.deepEqual(val.b, { count: 2, echo: "second" });
    assert.equal(val.shapedText, "shaped");
    assert.equal(val.scriptErr, "tool Script is unavailable in a plugin UI call");
    assert.equal(val.wsVal, "ws-val");
    assert.equal(val.userVal, "user-val");
    assert.equal(existsSync(join(stateDir, "workspace")), true);
    assert.equal(existsSync(join(stateDir, "user")), true);
    assert.equal(existsSync(join(env.cwd, ".pi", "pi-dent", "state")), false);

    // Settle check with summary.ok === false (still a non-error tool result).
    writeFileSync(
      join(outDir, "report.json"),
      JSON.stringify({
        alpha: "inspect/1",
        screenshots: ["missing.png"],
        summary: { ok: false },
      }),
      "utf8",
    );
    ui.handleCommand(`result ${JSON.stringify({ id: checkId, ok: true })}`, {
      cwd: env.cwd,
      setWidget: rec.setWidget,
    });

    const result = await pendingCheck;
    assert.equal(result.isError, undefined);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.ok(text.includes('"backend": "fixtures"'));
    assert.ok(text.includes(`Not attached: ${join(outDir, "missing.png")}:`));
    assert.equal("ok" in result.details && result.details.ok, false);
    // Scratch state dir removed on settle; outputDir kept.
    assert.equal(existsSync(stateDir), false);
    assert.equal(existsSync(outDir), true);
  } finally {
    env.cleanup();
  }
});

test("Section 3: timeout emits one cancel record and fails with specified message", async () => {
  const env = makeFixtureEnv();
  try {
    const inspect = new PluginUiInspectController({
      pluginIndex: env.pluginIndex,
      cancelCheckCalls: () => {},
      shotWaitMs: 30,
    });
    const rec = makeRecorder();
    const res = await inspect.execute(
      { action: "shot", plugin: "demo" },
      { cwd: env.cwd, agentDir: env.agentDir, setWidget: rec.setWidget },
    );
    assert.equal(res.isError, true);
    assert.equal(
      res.content[0]?.type === "text" ? res.content[0].text : "",
      "Alpha did not answer the UI shot within 30 ms",
    );
    const cancels = rec.records.filter(
      (r) => r.key === PLUGIN_UI_INSPECT_WIDGET_KEY && r.payload.type === "cancel",
    );
    assert.equal(cancels.length, 1);
  } finally {
    env.cleanup();
  }
});

test("Finding #1: concurrent shot while check awaits fixtures worker is rejected immediately without losing results", async () => {
  const env = makeFixtureEnv();
  try {
    const fixturesFile = join(env.cwd, "fixtures.mjs");
    writeFileSync(fixturesFile, "export default { Demo: () => 'ok' };\n", "utf8");

    let releaseWorker: (() => void) | undefined;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });

    const inspect = new PluginUiInspectController({
      pluginIndex: env.pluginIndex,
      cancelCheckCalls: () => {},
      startFixtures: async () => {
        await workerGate;
        return {
          names: ["Demo"],
          call: async () => ({
            ok: true,
            value: {
              text: "ok",
              content: [{ type: "text", text: "ok" }],
              details: undefined,
              structured: undefined,
            },
          }),
          terminate: async () => {},
        };
      },
    });
    const ui = new PluginUiController(env.pluginIndex);
    ui.setInspectBridge(inspect);
    const rec = makeRecorder();
    const ctx = { cwd: env.cwd, agentDir: env.agentDir, setWidget: rec.setWidget };

    const pendingCheck = inspect.execute(
      { action: "check", plugin: "demo", tools: "fixtures.mjs", steps: [{ eval: "1" }] },
      ctx,
    );

    // Concurrent shot arrives while check is awaiting startFixtures.
    const shotResult = await inspect.execute({ action: "shot", plugin: "demo" }, ctx);
    assert.equal(shotResult.isError, true);
    assert.equal(
      shotResult.content[0]?.type === "text" ? shotResult.content[0].text : "",
      "another PluginUI call is running",
    );

    releaseWorker?.();
    const emitted = await rec.waitFor((r) => r.key === PLUGIN_UI_INSPECT_WIDGET_KEY);
    assert.equal(emitted.payload.type, "check");
    const inspectRecords = rec.records.filter((r) => r.key === PLUGIN_UI_INSPECT_WIDGET_KEY);
    assert.equal(inspectRecords.length, 1);

    const checkId = String(emitted.payload.id);
    const outDir = String(emitted.payload.out);
    writeFileSync(
      join(outDir, "report.json"),
      JSON.stringify({ alpha: "inspect/1", screenshots: [], summary: { ok: true } }),
      "utf8",
    );
    ui.handleCommand(`result ${JSON.stringify({ id: checkId, ok: true })}`, {
      cwd: env.cwd,
      setWidget: rec.setWidget,
    });

    const checkResult = await pendingCheck;
    assert.equal(checkResult.isError, undefined);
    assert.equal("ok" in checkResult.details && checkResult.details.ok, true);
  } finally {
    env.cleanup();
  }
});

test("Finding #2: backend none and unexported names in fixtures expose session tool functions that reject as unavailable", async () => {
  const env = makeFixtureEnv();
  try {
    writeFileSync(
      join(env.pluginRoot, "scripts", "probe-tools.mjs"),
      `const mcpType = typeof tools.mcp;
let mcpErr = null;
try {
  await tools.mcp({});
} catch (e) {
  mcpErr = e.message;
}
const bashType = typeof tools.Bash;
let bashErr = null;
try {
  await tools.Bash({ command: "echo hi" });
} catch (e) {
  bashErr = e.message;
}
export default { mcpType, mcpErr, bashType, bashErr, toolTypes: dent.toolTypes() };
`,
      "utf8",
    );
    const fixturesFile = join(env.cwd, "fixtures.mjs");
    writeFileSync(fixturesFile, "export default { Demo: () => 'ok' };\n", "utf8");

    const ui = new PluginUiController(env.pluginIndex, {
      ownedTools: () => [],
      allToolNames: () => ["mcp", "Bash"],
    });
    const inspect = new PluginUiInspectController({
      pluginIndex: env.pluginIndex,
      cancelCheckCalls: (checkId, reason) => ui.cancelForCheck(checkId, reason),
    });
    ui.setInspectBridge(inspect);
    const rec = makeRecorder();
    const emptyDecls = toolDeclarations({ bound: [], unbound: [] });
    try {
      // 1. Backend `none`
      const noneCheck = inspect.execute(
        { action: "check", plugin: "demo", steps: [{ wait: 1 }] },
        { cwd: env.cwd, agentDir: env.agentDir, setWidget: rec.setWidget },
      );
      const noneEmitted = await rec.waitFor((r) => r.key === PLUGIN_UI_INSPECT_WIDGET_KEY);
      const noneId = String(noneEmitted.payload.id);
      const noneOut = String(noneEmitted.payload.out);

      ui.handleCommand(
        `run ${JSON.stringify({ id: "none-probe", namespace: "demo", root: env.pluginRoot, path: "scripts/probe-tools.mjs", check: noneId })}`,
        { cwd: env.cwd, setWidget: rec.setWidget },
      );
      const noneReply = await rec.waitFor(
        (r) => r.key === PLUGIN_UI_WIDGET_KEY && r.payload.id === "none-probe",
      );
      assert.equal(noneReply.payload.ok, true);
      assert.deepEqual(noneReply.payload.value, {
        mcpType: "function",
        mcpErr: "tool mcp is unavailable in a plugin UI call",
        bashType: "function",
        bashErr: "tool Bash is unavailable in a plugin UI call",
        toolTypes: emptyDecls,
      });

      writeFileSync(
        join(noneOut, "report.json"),
        JSON.stringify({ alpha: "inspect/1", screenshots: [], summary: { ok: true } }),
        "utf8",
      );
      ui.handleCommand(`result ${JSON.stringify({ id: noneId, ok: true })}`, {
        cwd: env.cwd,
        setWidget: rec.setWidget,
      });
      await noneCheck;

      // 2. Backend `fixtures` (unexported session tools also reject as unavailable)
      const fixturesCheck = inspect.execute(
        { action: "check", plugin: "demo", tools: "fixtures.mjs", steps: [{ wait: 1 }] },
        { cwd: env.cwd, agentDir: env.agentDir, setWidget: rec.setWidget },
      );
      const fixEmitted = await rec.waitFor(
        (r) => r.key === PLUGIN_UI_INSPECT_WIDGET_KEY && r.payload.id !== noneId,
      );
      const fixId = String(fixEmitted.payload.id);
      const fixOut = String(fixEmitted.payload.out);

      ui.handleCommand(
        `run ${JSON.stringify({ id: "fix-probe", namespace: "demo", root: env.pluginRoot, path: "scripts/probe-tools.mjs", check: fixId })}`,
        { cwd: env.cwd, setWidget: rec.setWidget },
      );
      const fixReply = await rec.waitFor(
        (r) => r.key === PLUGIN_UI_WIDGET_KEY && r.payload.id === "fix-probe",
      );
      assert.equal(fixReply.payload.ok, true);
      assert.deepEqual(fixReply.payload.value, {
        mcpType: "function",
        mcpErr: "tool mcp is unavailable in a plugin UI call",
        bashType: "function",
        bashErr: "tool Bash is unavailable in a plugin UI call",
        toolTypes: emptyDecls,
      });

      writeFileSync(
        join(fixOut, "report.json"),
        JSON.stringify({ alpha: "inspect/1", screenshots: [], summary: { ok: true } }),
        "utf8",
      );
      ui.handleCommand(`result ${JSON.stringify({ id: fixId, ok: true })}`, {
        cwd: env.cwd,
        setWidget: rec.setWidget,
      });
      await fixturesCheck;
    } finally {
      inspect.cancelAll();
    }
  } finally {
    env.cleanup();
  }
});
