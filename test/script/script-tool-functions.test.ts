import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { BootSnapshot, ToolResult } from "../../lib/engine.ts";
import type { HostSession } from "../../lib/host.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import { makeScriptTool } from "../../lib/script-tool.ts";
import { selectTools, toolDeclarations } from "../../lib/script-tool-types.ts";
import { at } from "../support/must.ts";

/**
 * Script tool functions (specs/script-tool.md Section 10.3) through `execute`, against a real
 * worker and a fake host `executeTool`.
 */

interface FakeTool {
  name: string;
  description: string;
  parameters: unknown;
  outputSchema?: unknown;
}

interface Outcome {
  result: { content: unknown[]; details?: unknown; structuredContent?: unknown };
  isError: boolean;
}

interface NestedCall {
  name: string;
  args: unknown;
  signal: AbortSignal | undefined;
}

interface Fixture {
  run: (params: Record<string, unknown>) => Promise<ToolResult>;
  calls: NestedCall[];
  registry: TaskRegistry;
  cleanup: () => void;
}

const objectTool = (name: string, extra: Partial<FakeTool> = {}): FakeTool => ({
  name,
  description: `${name} tool`,
  parameters: { type: "object", properties: { q: { type: "string" } } },
  ...extra,
});

function makeFixture(
  tools: FakeTool[],
  respond: (call: NestedCall) => Promise<Outcome>,
  toolsAllow?: readonly string[],
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-script-tools-"));
  const host = {
    cwd: () => root,
    sessionId: () => "sess-tools",
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
  } as HostSession;
  const registry = new TaskRegistry(() => host);
  const tool = makeScriptTool({
    boot: { pluginIndex: new Map() } as unknown as BootSnapshot,
    registry: () => registry,
    hostProvider: () => host,
    cohortFor: (id) => `cohort-${id}`,
    agentDir: () => join(root, "agent"),
    ...(toolsAllow === undefined ? {} : { toolsAllow: () => toolsAllow }),
  });
  const calls: NestedCall[] = [];
  const ctx = {
    tools: [...tools, objectTool("Script")],
    executeTool: (name: string, args: unknown, options?: { signal?: AbortSignal }) => {
      const call = { name, args, signal: options?.signal };
      calls.push(call);
      return respond(call);
    },
  } as unknown as ExtensionToolContext;
  return {
    run: (params) => tool.execute("call-1", params as never, undefined, undefined, ctx),
    calls,
    registry,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const ok = (text: string, extra: Partial<Outcome["result"]> = {}): Promise<Outcome> =>
  Promise.resolve({ result: { content: [{ type: "text", text }], ...extra }, isError: false });

function returnValue(result: ToolResult): unknown {
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  return (result.details as { returnValue: unknown }).returnValue;
}

function stderrOf(result: ToolResult): string {
  return String((result.details as { stderr: unknown }).stderr);
}

test("tool functions: a nested call resolves to a frozen ToolResult", async () => {
  const f = makeFixture([objectTool("echo"), objectTool("mcp__web__fetch")], () =>
    ok("line 1", {
      content: [
        { type: "text", text: "line 1", extra: true },
        { type: "image", data: "AA==", mimeType: "image/png" },
        { type: "text", text: "line 2" },
        { type: "resource", uri: "file:///x" },
        { type: "text" },
        7,
      ],
      details: { n: 1, skip: undefined },
      structuredContent: { ignored: true },
    }),
  );
  try {
    const result = await f.run({
      code: `
        const r = await tools.echo({ q: "hi" });
        export default {
          keys: Object.keys(tools),
          frozen: Object.isFrozen(tools) && Object.isFrozen(r) && Object.isFrozen(r.content),
          text: r.text,
          content: r.content,
          details: r.details,
          structured: r.structured === undefined,
        };`,
    });
    assert.deepEqual(returnValue(result), {
      keys: ["echo", "mcp__web__fetch"],
      frozen: true,
      text: "line 1\nline 2",
      content: [
        { type: "text", text: "line 1" },
        { type: "image", data: "AA==", mimeType: "image/png" },
        { type: "text", text: "line 2" },
        { type: "other", kind: "resource" },
        { type: "other", kind: "text" },
        { type: "other", kind: "" },
      ],
      details: { n: 1 },
      structured: true,
    });
    assert.deepEqual(
      f.calls.map(({ name, args }) => ({ name, args })),
      [{ name: "echo", args: { q: "hi" } }],
    );
  } finally {
    f.cleanup();
  }
});

test("tool functions: dent.toolTypes() returns the call's declarations", async () => {
  const tools = [objectTool("echo"), objectTool("odd", { parameters: { type: "string" } })];
  const f = makeFixture(tools, () => ok(""));
  try {
    const result = await f.run({ code: "dent.toolTypes()" });
    assert.equal(
      returnValue(result),
      toolDeclarations(selectTools([...tools, objectTool("Script")], ["*"])),
    );
  } finally {
    f.cleanup();
  }
});

test("tool functions: script.tools.allow limits the bound tools", async () => {
  const f = makeFixture([objectTool("echo"), objectTool("mcp__a__x")], () => ok(""), ["mcp__*"]);
  try {
    const result = await f.run({ code: "Object.keys(tools)" });
    assert.deepEqual(returnValue(result), ["mcp__a__x"]);
  } finally {
    f.cleanup();
  }
});

test("tool functions: a nested call with isError rejects with a ToolError", async () => {
  const f = makeFixture([objectTool("fail"), objectTool("silent")], (call) =>
    Promise.resolve({
      result: { content: call.name === "fail" ? [{ type: "text", text: "boom" }] : [] },
      isError: true,
    }),
  );
  try {
    const result = await f.run({
      code: `
        const errors = [];
        for (const name of ["fail", "silent"]) {
          try { await tools[name]({}); } catch (e) { errors.push([e.name, e.message]); }
        }
        export default errors;`,
    });
    assert.deepEqual(returnValue(result), [
      ["ToolError", "boom"],
      ["ToolError", "tool silent failed"],
    ]);
  } finally {
    f.cleanup();
  }
});

test("tool functions: args that are not a JSON-compatible object reject with no nested call", async () => {
  const f = makeFixture([objectTool("echo")], () => ok(""));
  try {
    const result = await f.run({
      code: `
        const messages = [];
        for (const args of [[1], null, "x", new Date(), { f: () => 1 }, { n: NaN }, undefined]) {
          try { await tools.echo(args); } catch (e) { messages.push(e.message); }
        }
        export default messages;`,
    });
    const expected = "tools.echo args must be a JSON-compatible object";
    assert.deepEqual(
      returnValue(result),
      Array.from({ length: 7 }, () => expected),
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test("tool functions: a background run rejects with no nested call", async () => {
  const f = makeFixture([objectTool("echo")], () => ok(""));
  try {
    const started = await f.run({
      background: true,
      code: `try { await tools.echo({}); } catch (e) { console.log(e.message); }`,
    });
    assert.equal(started.isError, undefined);
    const row = at(f.registry.list(), 0);
    const deadline = Date.now() + 10000;
    while (row.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(row.status, "completed");
    assert.match(String(row.result), /^tools\.echo is not available in a background run\n/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test("tool functions: structured content is checked against the output schema", async () => {
  const outputSchema = {
    type: "object",
    properties: { hits: { type: "array", items: { type: "string" } } },
    required: ["hits"],
  };
  const f = makeFixture(
    [
      objectTool("good", { outputSchema }),
      objectTool("bad", { outputSchema }),
      objectTool("none", { outputSchema }),
    ],
    (call) =>
      ok("t", {
        ...(call.name === "good" ? { structuredContent: { hits: ["a"] } } : {}),
        ...(call.name === "bad" ? { structuredContent: { hits: [1] } } : {}),
      }),
  );
  try {
    const result = await f.run({
      code: `
        const out = [(await tools.good({})).structured];
        for (const name of ["bad", "none"]) {
          try { await tools[name]({}); } catch (e) { out.push(e.message); }
        }
        export default out;`,
    });
    assert.deepEqual(returnValue(result), [
      { hits: ["a"] },
      "tool bad returned structured content that does not match its output schema",
      "tool none returned structured content that does not match its output schema",
    ]);
  } finally {
    f.cleanup();
  }
});

test("tool functions: settlement aborts a nested call still running and drops it", async () => {
  const f = makeFixture([objectTool("slow")], () => new Promise<Outcome>(() => {}));
  try {
    const timedOut = await f.run({
      timeout: 500,
      code: `await tools.slow({}); console.log("late");`,
    });
    assert.equal((timedOut.details as { exitReason: unknown }).exitReason, "timeout");
    assert.equal(at(f.calls, 0).signal?.aborted, true);

    const ended = await f.run({ code: `void tools.slow({}); export default "done";` });
    assert.equal(returnValue(ended), "done");
    assert.equal(at(f.calls, 1).signal?.aborted, true);
  } finally {
    f.cleanup();
  }
});

test("tool functions: a script awaiting a never-settling promise still ends unexpectedly", async () => {
  const f = makeFixture([objectTool("echo")], () => ok(""));
  try {
    // The port is referenced only while a nested call is pending.
    const result = await f.run({ code: `await tools.echo({}); await new Promise(() => {});` });
    assert.match(stderrOf(result), /script worker exited unexpectedly/);
  } finally {
    f.cleanup();
  }
});

test("tool functions: the Script tool reaches every tool", () => {
  const tool = makeScriptTool({
    boot: { pluginIndex: new Map() } as unknown as BootSnapshot,
    registry: () => new TaskRegistry(() => undefined),
    hostProvider: () => undefined,
    cohortFor: (id) => id,
    agentDir: () => tmpdir(),
  });
  assert.equal(tool.reachesTools?.({}), "all");
});
