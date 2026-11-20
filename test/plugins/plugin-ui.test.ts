import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { defineTool, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  asUiCallableTool,
  PLUGIN_UI_PAYLOAD_CAP_BYTES,
  PLUGIN_UI_PROTOCOL,
  PLUGIN_UI_WIDGET_KEY,
  PluginUiController,
} from "../../lib/plugin-ui.ts";
import { makeAgentTool } from "../../lib/tools.ts";
import type { BootSnapshot } from "../../lib/engine.ts";
import type { PluginEntry } from "../../lib/plugins.ts";
import { runScript } from "../../lib/script-runner.ts";
import piDentExtension from "../../index.ts";

interface WidgetEvent {
  key: string;
  lines: string[] | undefined;
}

interface ParsedUiRecord {
  piDent: string;
  type: "message" | "reply";
  id: string;
  data?: unknown;
  ok?: boolean;
  value?: unknown;
  error?: string;
}

function makePluginFixture(): {
  dir: string;
  pluginRoot: string;
  pluginIndex: Map<string, PluginEntry>;
  writeScript: (relPath: string, code: string) => void;
  cleanup: () => void;
} {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-dent-plugin-ui-")));
  const pluginRoot = join(dir, "demo-plugin");
  mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
  writeFileSync(join(pluginRoot, "plugin.json"), JSON.stringify({ name: "demo" }));
  const entry: PluginEntry = { name: "demo", root: pluginRoot, commands: [] };
  const pluginIndex = new Map<string, PluginEntry>([["demo", entry]]);
  return {
    dir,
    pluginRoot,
    pluginIndex,
    writeScript(relPath: string, code: string) {
      const full = join(pluginRoot, relPath);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, code, "utf8");
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeFeedCollector() {
  const events: WidgetEvent[] = [];
  const records: ParsedUiRecord[] = [];
  const waiters = new Map<string, Array<(record: ParsedUiRecord) => void>>();

  const setWidget = (key: string, lines: string[] | undefined): void => {
    events.push({ key, lines });
    if (key !== PLUGIN_UI_WIDGET_KEY || !lines || lines.length !== 1 || lines[0] === undefined) {
      return;
    }
    const parsed = JSON.parse(lines[0]) as ParsedUiRecord;
    records.push(parsed);
    if (parsed.type === "reply") {
      const pending = waiters.get(parsed.id);
      if (pending) {
        waiters.delete(parsed.id);
        for (const resolve of pending) resolve(parsed);
      }
    }
  };

  const waitForReply = (id: string): Promise<ParsedUiRecord> => {
    const existing = records.find((r) => r.type === "reply" && r.id === id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const list = waiters.get(id) ?? [];
      list.push(resolve);
      waiters.set(id, list);
    });
  };

  return { events, records, setWidget, waitForReply };
}

test("validates run payloads, namespace, root, path, missing file, and duplicate active id", async () => {
  const fx = makePluginFixture();
  try {
    fx.writeScript("scripts/hold.ts", "await new Promise((r) => setTimeout(r, 60_000));");
    const ctrl = new PluginUiController(fx.pluginIndex);
    const feed = makeFeedCollector();
    const ctx = { cwd: fx.dir, setWidget: feed.setWidget };

    // Malformed payloads or missing id emit nothing.
    ctrl.handleCommand("run not-json", ctx);
    ctrl.handleCommand("run {}", ctx);
    ctrl.handleCommand('run {"id":""}', ctx);
    ctrl.handleCommand("unknown {}", ctx);
    assert.equal(feed.events.length, 0);

    // Unknown namespace
    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r1", namespace: "missing", root: fx.pluginRoot, path: "scripts/hold.ts", data: null })}`,
      ctx,
    );
    const r1 = await feed.waitForReply("r1");
    assert.equal(r1.piDent, PLUGIN_UI_PROTOCOL);
    assert.equal(r1.ok, false);
    assert.match(r1.error ?? "", /Unknown plugin/);

    // Root mismatch
    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r2", namespace: "demo", root: `${fx.pluginRoot}-other`, path: "scripts/hold.ts", data: null })}`,
      ctx,
    );
    const r2 = await feed.waitForReply("r2");
    assert.equal(r2.ok, false);
    assert.match(r2.error ?? "", /root mismatch/i);

    // Invalid script path (outside scripts/ and traversal)
    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r3", namespace: "demo", root: fx.pluginRoot, path: "other/x.ts", data: null })}`,
      ctx,
    );
    const r3 = await feed.waitForReply("r3");
    assert.equal(r3.ok, false);

    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r4", namespace: "demo", root: fx.pluginRoot, path: "scripts/../plugin.json", data: null })}`,
      ctx,
    );
    const r4 = await feed.waitForReply("r4");
    assert.equal(r4.ok, false);

    // Missing script file
    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r5", namespace: "demo", root: fx.pluginRoot, path: "scripts/nope.ts", data: null })}`,
      ctx,
    );
    const r5 = await feed.waitForReply("r5");
    assert.equal(r5.ok, false);
    assert.match(r5.error ?? "", /missing script/i);

    // Duplicate active id refuses the second run without disturbing the first
    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r6", namespace: "demo", root: fx.pluginRoot, path: "scripts/hold.ts", data: null })}`,
      ctx,
    );
    assert.equal(ctrl.activeCount(), 1);
    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r6", namespace: "demo", root: fx.pluginRoot, path: "scripts/hold.ts", data: null })}`,
      ctx,
    );
    const dupReply = await feed.waitForReply("r6");
    assert.equal(dupReply.ok, false);
    assert.match(dupReply.error ?? "", /already running/i);
    assert.equal(ctrl.activeCount(), 1);

    // Clean up the active run
    ctrl.handleCommand(`cancel ${JSON.stringify({ ids: ["r6"] })}`, ctx);
    // Wait until activeCount reaches 0
    while (ctrl.activeCount() > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    fx.cleanup();
  }
});

test("executes plugin scripts with input.ui, no bound tools, no stdout/stderr leakage, and ordered dent.ui.send messages", async () => {
  const fx = makePluginFixture();
  try {
    fx.writeScript(
      "scripts/echo.ts",
      `
      console.log("stdout should not appear");
      console.error("stderr should not appear");
      dent.ui.send({ step: 1, received: input.ui });
      dent.ui.send("step-2");
      export default {
        ok: true,
        toolKeys: Object.keys(tools),
        hasUiSend: typeof dent.ui?.send === "function",
        uiValue: input.ui,
      };
      `,
    );
    const ctrl = new PluginUiController(fx.pluginIndex);
    const feed = makeFeedCollector();
    const ctx = { cwd: fx.dir, setWidget: feed.setWidget };

    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r1", namespace: "demo", root: fx.pluginRoot, path: "scripts/echo.ts", data: { hello: "world" } })}`,
      ctx,
    );
    const reply = await feed.waitForReply("r1");
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.value, {
      ok: true,
      toolKeys: [],
      hasUiSend: true,
      uiValue: { hello: "world" },
    });

    const forR1 = feed.records.filter((r) => r.id === "r1");
    assert.equal(forR1.length, 3);
    assert.deepEqual(forR1[0], {
      piDent: PLUGIN_UI_PROTOCOL,
      type: "message",
      id: "r1",
      data: { step: 1, received: { hello: "world" } },
    });
    assert.deepEqual(forR1[1], {
      piDent: PLUGIN_UI_PROTOCOL,
      type: "message",
      id: "r1",
      data: "step-2",
    });
    assert.equal(forR1[2]?.type, "reply");
  } finally {
    fx.cleanup();
  }
});

test("handles undefined return, process.exit(0), non-zero exit, thrown errors, non-JSON returns, and payload cap", async () => {
  const fx = makePluginFixture();
  try {
    fx.writeScript("scripts/undef.ts", "const x = 1;");
    fx.writeScript("scripts/exit0.ts", "process.exit(0);");
    fx.writeScript("scripts/exit2.ts", "process.exit(2);");
    fx.writeScript("scripts/throw.ts", 'throw new TypeError("boom");');
    fx.writeScript("scripts/nonjson-fn.ts", "export default () => 42;");
    fx.writeScript("scripts/nonjson-nan.ts", "export default NaN;");
    fx.writeScript(
      "scripts/exact-cap.ts",
      `export default "a".repeat(${PLUGIN_UI_PAYLOAD_CAP_BYTES - 2});`,
    );
    fx.writeScript(
      "scripts/over-cap.ts",
      `export default "a".repeat(${PLUGIN_UI_PAYLOAD_CAP_BYTES - 1});`,
    );
    fx.writeScript(
      "scripts/send-guards.ts",
      `
      const errors: string[] = [];
      for (const bad of [undefined, NaN, () => {}, "x".repeat(${PLUGIN_UI_PAYLOAD_CAP_BYTES - 1})]) {
        try {
          dent.ui.send(bad);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      dent.ui.send("good");
      export default errors;
      `,
    );

    const ctrl = new PluginUiController(fx.pluginIndex);
    const feed = makeFeedCollector();
    const ctx = { cwd: fx.dir, setWidget: feed.setWidget };

    const run = (id: string, path: string) => {
      ctrl.handleCommand(
        `run ${JSON.stringify({ id, namespace: "demo", root: fx.pluginRoot, path })}`,
        ctx,
      );
      return feed.waitForReply(id);
    };

    const [rUndef, rExit0, rExit2, rThrow, rFn, rNan, rExact, rOver, rSend] = await Promise.all([
      run("r-undef", "scripts/undef.ts"),
      run("r-exit0", "scripts/exit0.ts"),
      run("r-exit2", "scripts/exit2.ts"),
      run("r-throw", "scripts/throw.ts"),
      run("r-fn", "scripts/nonjson-fn.ts"),
      run("r-nan", "scripts/nonjson-nan.ts"),
      run("r-exact", "scripts/exact-cap.ts"),
      run("r-over", "scripts/over-cap.ts"),
      run("r-send", "scripts/send-guards.ts"),
    ]);

    assert.equal(rUndef.ok, true);
    assert.equal(rUndef.value, null);

    assert.equal(rExit0.ok, true);
    assert.equal(rExit0.value, null);

    assert.equal(rExit2.ok, false);
    assert.match(rExit2.error ?? "", /code 2/);

    assert.equal(rThrow.ok, false);
    assert.match(rThrow.error ?? "", /TypeError: boom/);

    assert.equal(rFn.ok, false);
    assert.match(rFn.error ?? "", /JSON/i);

    assert.equal(rNan.ok, false);
    assert.match(rNan.error ?? "", /JSON/i);

    assert.equal(rExact.ok, true);
    assert.equal(typeof rExact.value, "string");
    assert.equal((rExact.value as string).length, PLUGIN_UI_PAYLOAD_CAP_BYTES - 2);

    assert.equal(rOver.ok, false);
    assert.match(rOver.error ?? "", /262144/);

    assert.equal(rSend.ok, true);
    assert.equal(Array.isArray(rSend.value), true);
    assert.equal((rSend.value as string[]).length, 4);
    const sentMessages = feed.records.filter((r) => r.id === "r-send" && r.type === "message");
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]?.data, "good");
  } finally {
    fx.cleanup();
  }
});

test("dent.ui is undefined outside a UI call", async () => {
  const handle = runScript({
    code: "export default typeof dent.ui;",
    filename: join(tmpdir(), "non-ui-call.ts"),
    cwd: tmpdir(),
    input: undefined,
    aliases: {},
  });
  const result = await handle.promise;
  assert.equal(result.exitReason, "ok");
  assert.equal(result.returnValue, "undefined");
});

test("cancel and cancelAll terminate executing UI calls and ignore unknown ids", async () => {
  const fx = makePluginFixture();
  try {
    fx.writeScript(
      "scripts/wait.ts",
      `
      dent.ui.send("started");
      await new Promise((r) => setTimeout(r, 60_000));
      `,
    );
    const ctrl = new PluginUiController(fx.pluginIndex);
    const feed = makeFeedCollector();
    const ctx = { cwd: fx.dir, setWidget: feed.setWidget };

    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r-cancel", namespace: "demo", root: fx.pluginRoot, path: "scripts/wait.ts", data: null })}`,
      ctx,
    );
    // Wait for "started" message so the worker is definitely running
    while (!feed.records.some((r) => r.id === "r-cancel" && r.type === "message")) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Unknown id and malformed cancel do nothing
    ctrl.handleCommand('cancel {"ids":["unknown"]}', ctx);
    ctrl.handleCommand("cancel not-json", ctx);
    assert.equal(ctrl.activeCount(), 1);

    ctrl.handleCommand('cancel {"ids":["r-cancel"]}', ctx);
    const cancelledReply = await feed.waitForReply("r-cancel");
    assert.equal(cancelledReply.ok, false);
    assert.match(cancelledReply.error ?? "", /cancel/i);
    assert.equal(ctrl.activeCount(), 0);

    // cancelAll on shutdown
    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r-shutdown", namespace: "demo", root: fx.pluginRoot, path: "scripts/wait.ts", data: null })}`,
      ctx,
    );
    while (!feed.records.some((r) => r.id === "r-shutdown" && r.type === "message")) {
      await new Promise((r) => setTimeout(r, 10));
    }
    ctrl.cancelAll("Session ended");
    const shutdownReply = await feed.waitForReply("r-shutdown");
    assert.equal(shutdownReply.ok, false);
    assert.match(shutdownReply.error ?? "", /Session ended/);
    assert.equal(ctrl.activeCount(), 0);
  } finally {
    fx.cleanup();
  }
});

test("extension registers dent-ui command and gates execution to RPC mode", async () => {
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const piStub = {
    registerCommand(
      name: string,
      options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, options);
    },
    registerTool() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    on() {},
    events: { on() {}, emit() {} },
    getActiveTools: () => [],
    setActiveTools() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
  };

  piDentExtension(piStub as never);

  const cmd = commands.get("dent-ui");
  assert.ok(cmd, "dent-ui command must be registered");
  assert.equal(cmd.description, "Run and cancel plugin UI script calls");

  // Outside RPC mode: no-op
  const tuiWidgets: WidgetEvent[] = [];
  await cmd.handler('run {"id":"r1","namespace":"none","root":"/x","path":"scripts/a.ts"}', {
    mode: "tui",
    cwd: tmpdir(),
    ui: {
      setWidget(key: string, lines: string[] | undefined) {
        tuiWidgets.push({ key, lines });
      },
    },
  });
  assert.equal(tuiWidgets.length, 0);

  // In RPC mode (without PI_DENT_FEEDS): runs and replies on pi-dent-ui
  const rpcFeed = makeFeedCollector();
  await cmd.handler(
    'run {"id":"r1","namespace":"definitely-not-a-plugin","root":"/x","path":"scripts/a.ts"}',
    {
      mode: "rpc",
      cwd: tmpdir(),
      ui: { setWidget: rpcFeed.setWidget },
    },
  );
  const reply = await rpcFeed.waitForReply("r1");
  assert.equal(reply.ok, false);
  assert.match(reply.error ?? "", /Unknown plugin/);
});

test("binds pi-dent-agent tools, validates args, declares only bound tools, and rejects unavailable session tools", async () => {
  const fx = makePluginFixture();
  try {
    const bootStub = {
      agents: [],
      agentIndex: new Map(),
      skills: [],
      plugins: [],
      pluginIndex: fx.pluginIndex,
      diagnostics: [],
      config: {},
      sessionTtlDays: 7,
    } as unknown as BootSnapshot;

    const dispatched: Array<{ toolCallId: string; task: string; prompt?: string }> = [];
    const agentTool = makeAgentTool({
      boot: bootStub,
      modelCatalog: "",
      hostProvider: () => undefined,
      cohortFor: (id) => `cohort:${id}`,
      dispatch: async (call) => {
        dispatched.push({
          toolCallId: call.toolCallId,
          task: call.params.task,
          ...(call.params.prompt === undefined ? {} : { prompt: call.params.prompt }),
        });
        if (call.params.task === "fail-me") {
          return {
            content: [{ type: "text", text: "agent failed on request" }],
            details: { reason: "requested" },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `done: ${call.params.task}` }],
          details: { taskId: "a1", cohort: call.cohortId },
        };
      },
    });

    const echoTool = defineTool({
      name: "Echo",
      label: "Echo",
      description: "Echo text",
      parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: params.text }],
          details: { echoed: params.text },
        };
      },
    });

    const fakeToolCtx = {} as ExtensionToolContext;
    const ctrl = new PluginUiController(fx.pluginIndex, {
      ownedTools: () => [asUiCallableTool(agentTool), asUiCallableTool(echoTool)],
      allToolNames: () => ["Agent", "Echo", "Script", "AskUserQuestion", "read", "mcp"],
    });

    fx.writeScript(
      "scripts/call-tools.ts",
      `
      const types = dent.toolTypes();
      const agentRes = await tools.Agent({ prompt: "be brief", task: "hello" });
      dent.ui.send({ phase: "agent-done", text: agentRes.text });

      let validationErr = "";
      try {
        await tools.Echo({ text: "" });
      } catch (err) {
        validationErr = err instanceof Error ? err.name + ": " + err.message : String(err);
      }

      let toolErr = "";
      try {
        await tools.Agent({ prompt: "be brief", task: "fail-me" });
      } catch (err) {
        toolErr = err instanceof Error ? err.name + ": " + err.message : String(err);
      }

      const unavailable: Record<string, string> = {};
      for (const name of ["read", "mcp", "Script", "AskUserQuestion"]) {
        try {
          await tools[name]({});
        } catch (err) {
          unavailable[name] = err instanceof Error ? err.message : String(err);
        }
      }

      export default {
        types,
        agentText: agentRes.text,
        agentDetails: agentRes.details,
        validationErr,
        toolErr,
        unavailable,
      };
      `,
    );

    const feed = makeFeedCollector();
    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r-tools", namespace: "demo", root: fx.pluginRoot, path: "scripts/call-tools.ts", data: null })}`,
      { cwd: fx.dir, setWidget: feed.setWidget, toolContext: fakeToolCtx },
    );

    const reply = await feed.waitForReply("r-tools");
    assert.equal(reply.ok, true);
    const val = reply.value as {
      types: string;
      agentText: string;
      agentDetails: { taskId: string; cohort: string };
      validationErr: string;
      toolErr: string;
      unavailable: Record<string, string>;
    };

    assert.equal(val.agentText, "done: hello");
    assert.equal(val.agentDetails.taskId, "a1");
    assert.match(val.agentDetails.cohort, /^cohort:ui:r-tools\//);
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0]?.prompt, "be brief");

    // dent.toolTypes() declares bound tools only, not unavailable ones.
    assert.match(val.types, /\breadonly Agent:/);
    assert.match(val.types, /\breadonly Echo:/);
    assert.doesNotMatch(val.types, /\breadonly read:/);
    assert.doesNotMatch(val.types, /\breadonly mcp:/);
    assert.doesNotMatch(val.types, /\breadonly Script:/);
    assert.doesNotMatch(val.types, /\breadonly AskUserQuestion:/);

    // Schema validation error and tool isError both reject as ToolError.
    assert.match(val.validationErr, /^ToolError: Validation failed for tool "Echo"/);
    assert.equal(val.toolErr, "ToolError: agent failed on request");

    // Unavailable session tools reject with the exact unavailable message.
    assert.equal(val.unavailable.read, "tool read is unavailable in a plugin UI call");
    assert.equal(val.unavailable.mcp, "tool mcp is unavailable in a plugin UI call");
    assert.equal(val.unavailable.Script, "tool Script is unavailable in a plugin UI call");
    assert.equal(
      val.unavailable.AskUserQuestion,
      "tool AskUserQuestion is unavailable in a plugin UI call",
    );

    // UI message arrived before reply.
    const msgs = feed.records.filter((r) => r.id === "r-tools" && r.type === "message");
    assert.deepEqual(msgs[0]?.data, { phase: "agent-done", text: "done: hello" });
  } finally {
    fx.cleanup();
  }
});

test("cancel aborts an in-flight foreground tools.Agent call while background dispatches survive cancel", async () => {
  const fx = makePluginFixture();
  try {
    const bootStub = {
      agents: [],
      agentIndex: new Map(),
      skills: [],
      plugins: [],
      pluginIndex: fx.pluginIndex,
      diagnostics: [],
      config: {},
      sessionTtlDays: 7,
    } as unknown as BootSnapshot;

    let fgAborted = false;
    let bgAborted = false;
    let fgStartedResolve: (() => void) | undefined;
    const fgStarted = new Promise<void>((resolve) => {
      fgStartedResolve = resolve;
    });

    const agentTool = makeAgentTool({
      boot: bootStub,
      modelCatalog: "",
      hostProvider: () => undefined,
      cohortFor: (id) => `cohort:${id}`,
      dispatch: async (call) => {
        if (call.params.background === true) {
          call.signal?.addEventListener("abort", () => {
            bgAborted = true;
          });
          return {
            content: [{ type: "text", text: "Dispatched background agent (taskId bg1)" }],
            details: { taskId: "bg1" },
          };
        }
        fgStartedResolve?.();
        return await new Promise((resolve) => {
          call.signal?.addEventListener(
            "abort",
            () => {
              fgAborted = true;
              resolve({
                content: [{ type: "text", text: "aborted" }],
                details: {},
                isError: true,
              });
            },
            { once: true },
          );
        });
      },
    });

    const ctrl = new PluginUiController(fx.pluginIndex, {
      ownedTools: () => [asUiCallableTool(agentTool)],
      allToolNames: () => ["Agent"],
    });

    fx.writeScript(
      "scripts/bg-then-fg.ts",
      `
      const bg = await tools.Agent({ prompt: "bg", task: "stay alive", background: true });
      dent.ui.send({ bg: bg.text });
      await tools.Agent({ prompt: "fg", task: "wait forever" });
      `,
    );

    const feed = makeFeedCollector();
    const ctx = {
      cwd: fx.dir,
      setWidget: feed.setWidget,
      toolContext: {} as ExtensionToolContext,
    };
    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r-abort", namespace: "demo", root: fx.pluginRoot, path: "scripts/bg-then-fg.ts", data: null })}`,
      ctx,
    );

    await fgStarted;
    ctrl.handleCommand('cancel {"ids":["r-abort"]}', ctx);
    const reply = await feed.waitForReply("r-abort");
    assert.equal(reply.ok, false);
    assert.equal(fgAborted, true);
    assert.equal(bgAborted, false);
  } finally {
    fx.cleanup();
  }
});
