import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import type { BootSnapshot, ToolResult } from "../../lib/engine.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { HostSession } from "../../lib/host.ts";
import type { PluginEntry } from "../../lib/plugins.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import { renderReturn } from "../../lib/script-render.ts";
import { makeScriptTool, scriptParameterSchema } from "../../lib/script-tool.ts";

/**
 * Script tool return-value classification and timeout schema conformance per
 * specs/script-tool.md Section 5 and Section 1, and the registered term
 * "JSON-compatible value".
 */

interface Fixture {
  tool: ReturnType<typeof makeScriptTool>;
  registry: TaskRegistry;
  root: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-script-render-"));
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

function renderOf(result: ToolResult): Record<string, unknown> {
  return (result.details.returnValueRender ?? {}) as Record<string, unknown>;
}

test("return classification: non-JSON values yield non-json-return-value with no JSON section", async () => {
  const f = makeFixture();
  try {
    const cases: { code: string; name: string }[] = [
      { code: `export default { n: NaN };`, name: "NaN" },
      { code: `export default { u: undefined };`, name: "undefined" },
      { code: `export default new Date(0);`, name: "1970" },
      { code: `export default new Map([[1, 2]]);`, name: "Map" },
    ];
    for (const c of cases) {
      const r = await call(f, { code: c.code });
      assert.equal(r.isError, undefined, c.code);
      const rv = r.details.returnValue as { type: string; representation: string };
      assert.equal(rv.type, "non-json-return-value", c.code);
      assert.match(rv.representation, new RegExp(c.name), c.code);
    }
  } finally {
    f.cleanup();
  }
});

test("return classification: plain nested object round-trips, unclipped, with no JSON section", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, {
      code: `export default { a: { b: [1, 2, { c: "x" }] }, d: true, e: null };`,
    });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.details.returnValue, { a: { b: [1, 2, { c: "x" }] }, d: true, e: null });
    const render = renderOf(r);
    assert.equal("jsonPath" in render, false, "no jsonPath in details");
    const log = readFileSync(String((r.details as Record<string, unknown>).outputPath), "utf8");
    assert.doesNotMatch(log, /--- return json ---/);
  } finally {
    f.cleanup();
  }
});

test("a JSON-compatible value carries its single-line JSON (Section 5)", () => {
  const render = renderReturn({ a: 1, note: "kept" });
  assert.equal(render.json, `{"a":1,"note":"kept"}`);
  assert.match(render.rendered, /"note": "kept"/);
  assert.deepEqual(render.jsonValue, { a: 1, note: "kept" });
});

test("a value whose JSON cannot be produced renders with no json and no failure (Section 5)", () => {
  // The getter throws only while JSON.stringify reads it: a stand-in for a serialisation failure.
  const value: Record<string, unknown> = {};
  Object.defineProperty(value, "a", {
    enumerable: true,
    get() {
      if (new Error().stack?.includes("JSON.stringify")) throw new RangeError("too long");
      return 1;
    },
  });
  const render = renderReturn(value);
  assert.equal(render.json, undefined);
  assert.match(render.rendered, /"a": 1/);
});

test("cyclic return: is not JSON-compatible and renders a [Circular] marker", () => {
  const a: Record<string, unknown> = { name: "a" };
  a.self = a;
  const r = renderReturn(a);
  assert.equal(r.jsonValue, undefined, "a cyclic value is not JSON-compatible");
  assert.equal(r.json, undefined, "a cyclic value has no JSON");
  assert.match(r.rendered, /\[Circular\]/);
  assert.match(r.rendered, /"name": "a"/);
  assert.doesNotMatch(r.rendered, /"self": \{/, "the cycle is cut, not expanded");
});

test("cyclic array: is not JSON-compatible and renders a [Circular] marker", () => {
  const a: unknown[] = [1];
  a.push(a);
  const r = renderReturn(a);
  assert.equal(r.jsonValue, undefined);
  assert.match(r.rendered, /\[Circular\]/);
});

test("shared reference: a DAG value renders fully at both positions and stays JSON-compatible", () => {
  const shared = { v: 1 };
  const r = renderReturn({ x: shared, y: shared });
  assert.doesNotMatch(r.rendered, /\[Circular\]/);
  assert.equal(r.rendered.split('"v": 1').length - 1, 2, "rendered twice");
  assert.deepEqual(r.jsonValue, { x: { v: 1 }, y: { v: 1 } });
});

test("cyclic return through the tool: settles ok with a non-json-return-value", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, { code: `const a = {}; a.self = a; export default a;` });
    assert.equal(r.isError, undefined, JSON.stringify(r.details));
    assert.equal(r.details.exitReason, "ok");
    const rv = r.details.returnValue as { type: string; representation: string };
    assert.equal(rv.type, "non-json-return-value");
    assert.match(rv.representation, /\[Circular\]/);
  } finally {
    f.cleanup();
  }
});

test("timeout schema: rejects non-integers and out-of-range, accepts bounds", () => {
  for (const bad of [0, 1.5, -1, 600001]) {
    assert.equal(Value.Check(scriptParameterSchema, { timeout: bad }), false, `reject ${bad}`);
  }
  for (const good of [1, 600000]) {
    assert.equal(Value.Check(scriptParameterSchema, { timeout: good }), true, `accept ${good}`);
  }
  const description = (
    scriptParameterSchema as unknown as {
      properties: { timeout: { description: string } };
    }
  ).properties.timeout.description;
  assert.match(description, /Omitted gives a foreground call 600000 ms/);
  assert.doesNotMatch(description, /Omitted imposes no timeout/);
  assert.doesNotMatch(description, /30000/);
});
