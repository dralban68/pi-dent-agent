import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootSnapshot, ToolResult } from "../../lib/engine.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { HostSession } from "../../lib/host.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import { makeScriptTool } from "../../lib/script-tool.ts";

/**
 * Module contract (specs/script-tool.md#module-contract): the completion value
 * depends on whether the body has top-level `await` — an `await` outside every
 * function and class body — and not on the word `await` appearing anywhere.
 */

interface Fixture {
  tool: ReturnType<typeof makeScriptTool>;
  registry: TaskRegistry;
  root: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-script-await-"));
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

async function call(fixture: Fixture, code: string): Promise<ToolResult> {
  return fixture.tool.execute("call-1", { code }, undefined, undefined, noCtx);
}

function textOf(result: ToolResult): string {
  const first = result.content[0];
  if (first?.type !== "text") assert.fail("expected text content");
  return first.text;
}

// Bodies with no top-level await keep their completion value even though the
// word `await` appears inside a comment, string, template, regex, or a nested
// async function, arrow, or method.
const NO_TOP_LEVEL_AWAIT: [string, string, unknown][] = [
  ["comment", "// no await here\n1 + 1", 2],
  ["string", 'const s = "await";\ns', "await"],
  ["template", "const t = `await ${1 + 1}`;\nt", "await 2"],
  ["regex", "const re = /await/g;\nre.source", "await"],
  ["nested async function", "async function f() { await 0; return 1; }\ntypeof f", "function"],
  ["nested async arrow", "const g = async () => { await 0; };\ntypeof g", "function"],
  ["nested async method", "const o = { async m() { await 0; } };\ntypeof o.m", "function"],
  ["nested class method", "class C { async m() { await 0; } }\ntypeof C.prototype.m", "function"],
];

for (const [label, code, expected] of NO_TOP_LEVEL_AWAIT) {
  test(`completion value survives await in a ${label}`, async () => {
    const f = makeFixture();
    try {
      const r = await call(f, code);
      assert.equal(r.isError, undefined, textOf(r));
      assert.equal(r.details.exitReason, "ok", textOf(r));
      assert.deepEqual(r.details.returnValue, expected, textOf(r));
    } finally {
      f.cleanup();
    }
  });
}

// Top-level await — every form the probe must recognise — still runs and
// returns its value through a default export (specs/script-tool.md#module-contract).
const TOP_LEVEL_AWAIT: [string, string, unknown][] = [
  ["await expression", "export default await Promise.resolve(7);", 7],
  ["await call", "async function f() { return 8; }\nexport default await f();", 8],
  ["await in parentheses", "async function f() { return 9; }\nexport default await (f)();", 9],
  ["await arrow call", "export default await (async () => 10)();", 10],
  ["await array literal", "const x = await [1];\nexport default x;", [1]],
  ["await regex literal", "export default (await /re/).source;", "re"],
  [
    "for await",
    "const seen = [];\nfor await (const v of [1, 2]) seen.push(v);\nexport default seen;",
    [1, 2],
  ],
];

for (const [label, code, expected] of TOP_LEVEL_AWAIT) {
  test(`top-level ${label} runs in the async wrapper`, async () => {
    const f = makeFixture();
    try {
      const r = await call(f, code);
      assert.equal(r.isError, undefined, textOf(r));
      assert.equal(r.details.exitReason, "ok", textOf(r));
      assert.deepEqual(r.details.returnValue, expected, textOf(r));
    } finally {
      f.cleanup();
    }
  });
}

test("top-level await still yields no completion value", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, "const a = await 1;\na");
    assert.equal(r.details.exitReason, "ok", textOf(r));
    assert.match(textOf(r), /--- return ---\nundefined/);
  } finally {
    f.cleanup();
  }
});

test("a wrong probe guess never costs the completion value of a plain body", async () => {
  const f = makeFixture();
  try {
    // `await` as a property name and in a `for` head of a nested function.
    const r = await call(
      f,
      [
        "const o = { await: 1 };",
        "async function f(xs) { for (const x of xs) await x; }",
        "o.await + 1",
      ].join("\n"),
    );
    assert.equal(r.details.exitReason, "ok", textOf(r));
    assert.equal(r.details.returnValue, 2, textOf(r));
  } finally {
    f.cleanup();
  }
});

test("TypeScript syntax works on the plain-script path", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, "const n: number = 2;\nn");
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.returnValue, 2, textOf(r));
  } finally {
    f.cleanup();
  }
});

test("TypeScript syntax works on the async-wrapper path", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, "const n: number = await Promise.resolve(3);\nexport default n;");
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(r.details.returnValue, 3, textOf(r));
  } finally {
    f.cleanup();
  }
});

test("a comment mentioning await keeps both TypeScript and the completion value", async () => {
  const f = makeFixture();
  try {
    const r = await call(f, "// await is not used here\nconst n: number = 5;\nn");
    assert.equal(r.details.exitReason, "ok", textOf(r));
    assert.equal(r.details.returnValue, 5, textOf(r));
  } finally {
    f.cleanup();
  }
});

for (const [label, code] of [
  ["plain-script path", 'const a = 1;\nconst b = 2;\nthrow new Error("plain boom");'],
  ["async-wrapper path", 'const a = await 1;\nconst b = 2;\nthrow new Error("awaited boom");'],
] as const) {
  test(`a throw on line 3 reports line 3 on the ${label}`, async () => {
    const f = makeFixture();
    try {
      const r = await call(f, code);
      assert.equal(r.details.exitReason, "threw", textOf(r));
      assert.match(textOf(r), /__pi_dent_script__\.ts:3:/);
    } finally {
      f.cleanup();
    }
  });
}
