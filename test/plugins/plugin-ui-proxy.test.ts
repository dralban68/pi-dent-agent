import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { defineTool, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { asUiCallableTool, PLUGIN_UI_WIDGET_KEY, PluginUiController } from "../../lib/plugin-ui.ts";
import { PluginUiToolProxy } from "../../lib/plugin-ui-proxy.ts";
import type { PluginEntry } from "../../lib/plugins.ts";

interface ParsedUiRecord {
  piDent: string;
  type: "message" | "reply";
  id: string;
  data?: unknown;
  ok?: boolean;
  value?: unknown;
  error?: string;
}

function makeFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-dent-ui-proxy-")));
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
  const records: ParsedUiRecord[] = [];
  const waiters = new Map<string, Array<(record: ParsedUiRecord) => void>>();
  const setWidget = (key: string, lines: string[] | undefined): void => {
    if (key !== PLUGIN_UI_WIDGET_KEY || !lines || lines.length !== 1 || lines[0] === undefined) {
      return;
    }
    const parsed = JSON.parse(lines[0]) as ParsedUiRecord;
    records.push(parsed);
    if (parsed.type === "reply") {
      const list = waiters.get(parsed.id);
      if (list) {
        waiters.delete(parsed.id);
        for (const resolve of list) resolve(parsed);
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
  return { records, setWidget, waitForReply };
}

test("proxies built-in host tools lazily, declares direct + proxied in dent.toolTypes(), and keeps excluded tools unavailable", async () => {
  const fx = makeFixture();
  let proxyRef: PluginUiToolProxy | undefined;
  try {
    writeFileSync(join(fx.dir, "hello.txt"), "line-one\nline-two\nline-three\n", "utf8");

    const directTool = defineTool({
      name: "DirectEcho",
      label: "DirectEcho",
      description: "Direct pi-dent tool",
      parameters: Type.Object({ msg: Type.String() }),
      async execute(_id, params) {
        return { content: [{ type: "text", text: `direct:${params.msg}` }], details: {} };
      },
    });

    const ctrl = new PluginUiController(fx.pluginIndex, {
      ownedTools: () => [asUiCallableTool(directTool)],
      allTools: () => [
        {
          name: "DirectEcho",
          description: "Direct pi-dent tool",
          parameters: Type.Object({ msg: Type.String() }),
          exposure: "direct",
        },
        {
          name: "read",
          description: "Read a file",
          parameters: Type.Object({
            path: Type.String(),
            limit: Type.Optional(Type.Number()),
          }),
          exposure: "direct",
        },
        {
          name: "bash",
          description: "Inactive built-in bash",
          parameters: Type.Object({ command: Type.String() }),
          exposure: "direct",
        },
        {
          name: "Script",
          description: "Script tool",
          parameters: Type.Object({ code: Type.String() }),
          exposure: "direct",
        },
        {
          name: "AskUserQuestion",
          description: "Ask user",
          parameters: Type.Object({}),
          exposure: "direct",
        },
      ],
      activeToolNames: () => ["DirectEcho", "read", "Script", "AskUserQuestion"],
      createProxy: () => {
        proxyRef = new PluginUiToolProxy({
          cwd: fx.dir,
          isProjectTrusted: true,
          extensions: { sources: [], tools: [] },
          excludeTools: ["bash"],
          builtinExtensions: [],
        });
        return proxyRef;
      },
    });

    // First UI call touches only DirectEcho: proxy must NOT be started.
    fx.writeScript(
      "scripts/direct-only.ts",
      `
      const r = await tools.DirectEcho({ msg: "hi" });
      export default r.text;
      `,
    );
    const feed = makeFeedCollector();
    const ctx = {
      cwd: fx.dir,
      setWidget: feed.setWidget,
      toolContext: {} as ExtensionToolContext,
    };

    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r1", namespace: "demo", root: fx.pluginRoot, path: "scripts/direct-only.ts", data: null })}`,
      ctx,
    );
    const r1 = await feed.waitForReply("r1");
    assert.equal(r1.ok, true);
    assert.equal(r1.value, "direct:hi");
    assert.equal(
      proxyRef,
      undefined,
      "proxy must not be created when only direct tools are called",
    );

    // Second UI call invokes built-in `read` (proxied), checks dent.toolTypes(), and tests excluded tools.
    fx.writeScript(
      "scripts/proxied-read.ts",
      `
      const types = dent.toolTypes();
      const file = await tools.read({ path: "hello.txt", limit: 2 });
      const unavailable: Record<string, string> = {};
      for (const name of ["Script", "AskUserQuestion", "bash"]) {
        try {
          await tools[name]({});
        } catch (err) {
          unavailable[name] = err instanceof Error ? err.message : String(err);
        }
      }
      export default { types, text: file.text, unavailable };
      `,
    );
    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r2", namespace: "demo", root: fx.pluginRoot, path: "scripts/proxied-read.ts", data: null })}`,
      ctx,
    );
    const r2 = await feed.waitForReply("r2");
    assert.equal(r2.ok, true);
    const val = r2.value as {
      types: string;
      text: string;
      unavailable: Record<string, string>;
    };
    assert.match(val.text, /line-one/);
    assert.match(val.text, /line-two/);
    assert.doesNotMatch(val.text, /line-three/);
    assert.match(val.types, /\breadonly DirectEcho:/);
    assert.match(val.types, /\breadonly read:/);
    assert.doesNotMatch(val.types, /\breadonly Script:/);
    assert.doesNotMatch(val.types, /\breadonly AskUserQuestion:/);
    assert.doesNotMatch(val.types, /\breadonly bash:/);
    assert.equal(val.unavailable.Script, "tool Script is unavailable in a plugin UI call");
    assert.equal(
      val.unavailable.AskUserQuestion,
      "tool AskUserQuestion is unavailable in a plugin UI call",
    );
    assert.equal(val.unavailable.bash, "tool bash is unavailable in a plugin UI call");
    assert.ok(proxyRef !== undefined, "proxy should have been created");
    assert.equal((proxyRef as PluginUiToolProxy).isStarted(), true);

    await ctrl.disposeProxy();
  } finally {
    await proxyRef?.dispose();
    fx.cleanup();
  }
});

test("proxy serializes calls in FIFO order, aborts queued calls without running them, and aborts in-flight calls on cancel", async () => {
  const fx = makeFixture();
  let proxy: PluginUiToolProxy | undefined;
  try {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let signalFirstEntered: (() => void) | undefined;
    let firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    let firstAborted = false;

    proxy = new PluginUiToolProxy({
      cwd: fx.dir,
      isProjectTrusted: true,
      extensions: { sources: [], tools: [] },
      builtinExtensions: [],
      extraExtensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "slow_tool",
            label: "slow_tool",
            description: "Slow stand-in tool",
            parameters: Type.Object({ tag: Type.String() }),
            async execute(_id, params, signal) {
              order.push(`start:${params.tag}`);
              if (params.tag === "first") {
                await new Promise<void>((resolve) => {
                  releaseFirst = resolve;
                  signalFirstEntered?.();
                  signal?.addEventListener(
                    "abort",
                    () => {
                      firstAborted = true;
                      resolve();
                    },
                    { once: true },
                  );
                });
              }
              order.push(`end:${params.tag}`);
              return { content: [{ type: "text", text: `ok:${params.tag}` }], details: {} };
            },
          });
        },
      ],
    });

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const ac3 = new AbortController();

    const p1 = proxy.call("slow_tool", { tag: "first" }, ac1.signal);
    const p2 = proxy.call("slow_tool", { tag: "second-aborted" }, ac2.signal);
    const p3 = proxy.call("slow_tool", { tag: "third" }, ac3.signal);

    await firstEntered;

    // Abort queued second call before first finishes
    ac2.abort();
    await assert.rejects(p2, /Tool call aborted/);

    // Release first, third should run next
    releaseFirst?.();
    const [res1, res3] = await Promise.all([p1, p3]);
    assert.equal(res1.isError, false);
    assert.equal(res3.isError, false);
    assert.deepEqual(order, ["start:first", "end:first", "start:third", "end:third"]);
    assert.equal(firstAborted, false);

    // Now test aborting an in-flight call
    releaseFirst = undefined;
    firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const acInFlight = new AbortController();
    const pInFlight = proxy.call("slow_tool", { tag: "first" }, acInFlight.signal);
    await firstEntered;
    acInFlight.abort();
    await assert.rejects(pInFlight, /Tool call aborted/);
    assert.equal(firstAborted, true);

    // Test dispose() rejecting queued calls and aborting in-flight call cleanly
    releaseFirst = undefined;
    firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const pActive = proxy.call("slow_tool", { tag: "first" }, new AbortController().signal);
    const pQueued = proxy.call(
      "slow_tool",
      { tag: "queued-at-dispose" },
      new AbortController().signal,
    );
    await firstEntered;
    const disposePromise = proxy.dispose();
    await assert.rejects(pQueued, /Plugin UI proxy session ended/);
    await disposePromise;
    await pActive.catch(() => {});
  } finally {
    await proxy?.dispose();
    fx.cleanup();
  }
});

test("extension load failure in proxy rejects only its tool and does not break direct tools", async () => {
  const fx = makeFixture();
  let proxy: PluginUiToolProxy | undefined;
  try {
    const missingExt = join(fx.dir, "does-not-exist-ext.ts");
    const directTool = defineTool({
      name: "DirectOk",
      label: "DirectOk",
      description: "Direct tool",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "direct-ok" }], details: {} };
      },
    });

    const ctrl = new PluginUiController(fx.pluginIndex, {
      ownedTools: () => [asUiCallableTool(directTool)],
      allTools: () => [
        {
          name: "DirectOk",
          description: "Direct",
          parameters: Type.Object({}),
          exposure: "direct",
        },
        {
          name: "broken_ext_tool",
          description: "From broken ext",
          parameters: Type.Object({}),
          exposure: "direct",
        },
      ],
      activeToolNames: () => ["DirectOk", "broken_ext_tool"],
      createProxy: () => {
        proxy = new PluginUiToolProxy({
          cwd: fx.dir,
          isProjectTrusted: true,
          extensions: {
            sources: [missingExt],
            tools: [{ name: "broken_ext_tool", source: missingExt }],
          },
          builtinExtensions: [],
        });
        return proxy;
      },
    });

    fx.writeScript(
      "scripts/fail-ext.ts",
      `
      let proxyErr = "";
      try {
        await tools.broken_ext_tool({});
      } catch (err) {
        proxyErr = err instanceof Error ? err.message : String(err);
      }
      const direct = await tools.DirectOk({});
      export default { proxyErr, direct: direct.text };
      `,
    );

    const feed = makeFeedCollector();
    ctrl.handleCommand(
      `run ${JSON.stringify({ id: "r-fail", namespace: "demo", root: fx.pluginRoot, path: "scripts/fail-ext.ts", data: null })}`,
      { cwd: fx.dir, setWidget: feed.setWidget, toolContext: {} as ExtensionToolContext },
    );
    const reply = await feed.waitForReply("r-fail");
    assert.equal(reply.ok, true);
    const val = reply.value as { proxyErr: string; direct: string };
    assert.match(val.proxyErr, /Extension for tool "broken_ext_tool" failed to load in proxy/);
    assert.equal(val.direct, "direct-ok");

    await ctrl.disposeProxy();
  } finally {
    await proxy?.dispose();
    fx.cleanup();
  }
});

test("proxies a real stdio MCP server through pi-mcp-adapter loaded via DefaultResourceLoader", async () => {
  const fx = makeFixture();
  let proxy: PluginUiToolProxy | undefined;
  try {
    // Minimal real JSON-RPC 2.0 MCP server over stdio.
    const serverPath = join(fx.dir, "echo-mcp-server.mjs");
    writeFileSync(
      serverPath,
      `
      import { createInterface } from "node:readline";
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const req = JSON.parse(line);
        if (req.method === "initialize") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "echo-mcp", version: "1.0.0" },
            },
          }) + "\\n");
        } else if (req.method === "tools/list") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              tools: [{
                name: "ping",
                description: "Echo a message",
                inputSchema: {
                  type: "object",
                  properties: { msg: { type: "string" } },
                  required: ["msg"],
                },
              }],
            },
          }) + "\\n");
        } else if (req.method === "tools/call") {
          const msg = req.params?.arguments?.msg ?? "";
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { content: [{ type: "text", text: "pong:" + msg }] },
          }) + "\\n");
        }
      });
      `,
      "utf8",
    );

    // User-global MCP config under an isolated PI_CODING_AGENT_DIR so pi-mcp-adapter
    // connects to the real stdio MCP server without needing interactive project approval.
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    const tempAgentDir = join(fx.dir, "agent-dir");
    mkdirSync(tempAgentDir, { recursive: true });
    writeFileSync(
      join(tempAgentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: {
            command: process.execPath,
            args: [serverPath],
            lifecycle: "eager",
          },
        },
      }),
      "utf8",
    );
    process.env.PI_CODING_AGENT_DIR = tempAgentDir;

    try {
      const mcpAdapterPath = join(process.cwd(), "node_modules", "pi-mcp-adapter", "index.ts");

      const ctrl = new PluginUiController(fx.pluginIndex, {
        ownedTools: () => [],
        allTools: () => [
          {
            name: "mcp",
            description: "MCP gateway",
            parameters: Type.Object({
              tool: Type.Optional(Type.String()),
              server: Type.Optional(Type.String()),
              args: Type.Optional(Type.Object({})),
            }),
            exposure: "direct",
          },
        ],
        activeToolNames: () => ["mcp"],
        createProxy: () => {
          proxy = new PluginUiToolProxy({
            cwd: fx.dir,
            isProjectTrusted: true,
            extensions: {
              sources: [mcpAdapterPath],
              tools: [{ name: "mcp", source: mcpAdapterPath }],
            },
            builtinExtensions: [],
          });
          return proxy;
        },
      });

      fx.writeScript(
        "scripts/call-mcp.ts",
        `
        const res = await tools.mcp({ server: "echo", tool: "ping", args: { msg: "from-ui" } });
        export default res.text;
        `,
      );

      const feed = makeFeedCollector();
      ctrl.handleCommand(
        `run ${JSON.stringify({ id: "r-mcp", namespace: "demo", root: fx.pluginRoot, path: "scripts/call-mcp.ts", data: null })}`,
        { cwd: fx.dir, setWidget: feed.setWidget, toolContext: {} as ExtensionToolContext },
      );

      const reply = await feed.waitForReply("r-mcp");
      assert.equal(reply.ok, true, `expected ok reply, got: ${JSON.stringify(reply)}`);
      assert.match(String(reply.value), /pong:from-ui/);

      await ctrl.disposeProxy();
    } finally {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
  } finally {
    await proxy?.dispose();
    fx.cleanup();
  }
});
