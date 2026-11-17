import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Main-session skill binding per specs/skill-tool.md Section 1: with a
 * non-empty skill catalog the extension registers `Skill` and appends the
 * `<available_skills>` injection to the system prompt on every turn while
 * `Skill` is active; with an empty catalog it does neither. index.ts is
 * loaded through jiti, as in test/plugins/slash-commands.test.ts.
 */

const realTmp = tmpdir();
const entryDir = fileURLToPath(new URL(".", import.meta.url));

const jiti = createJiti(import.meta.url);
const factory = (
  await jiti.import<{ default: (pi: ExtensionAPI) => Promise<void> | void }>(
    join(entryDir, "..", "..", "index.ts"),
  )
).default;

type Handler = (event?: unknown, ctx?: unknown) => unknown;

interface StubPi {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  tools: string[];
  active: string[];
}

function makeStubPi(): StubPi {
  const handlers = new Map<string, Handler[]>();
  const tools: string[] = [];
  const stub: StubPi = { pi: undefined as unknown as ExtensionAPI, handlers, tools, active: [] };
  stub.pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerShortcut: () => {},
    getActiveTools: () => stub.active,
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return stub;
}

/** A project with the given skills under its project layer directory; returns a restore function. */
function makeProject(skills: Record<string, string>, pluginContext?: string): () => void {
  const root = mkdtempSync(join(realTmp, "pi-dent-main-skill-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(project, ".pi", "pi-dent", "skills"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  if (pluginContext !== undefined) {
    // A global-layer plugin with a root context.md (plugin.md Section 10).
    const pluginDir = join(home, ".pi", "pi-dent", "plugins", "alpha");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "alpha" }));
    writeFileSync(join(pluginDir, "context.md"), pluginContext);
    writeFileSync(
      join(home, ".pi", "pi-dent", "pi-dent.conf"),
      JSON.stringify({ plugins: { alpha: { path: "plugins/alpha" } } }),
    );
  }
  for (const [name, description] of Object.entries(skills)) {
    const dir = join(project, ".pi", "pi-dent", "skills", name);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}\n`,
    );
  }
  const prevHome = process.env.HOME;
  const prevTmpdir = process.env.TMPDIR;
  const prevCwd = process.cwd();
  process.env.HOME = home;
  process.env.TMPDIR = join(root, "tmp");
  process.chdir(project);
  return () => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmpdir;
    rmSync(root, { recursive: true, force: true });
  };
}

/** The boot window is cached on globalThis; a reload shutdown clears it so the next factory call re-reads. */
function clearBootWindow(stub: StubPi): void {
  for (const handler of stub.handlers.get("session_shutdown") ?? []) handler({ reason: "reload" });
}

test("a non-empty skill catalog registers Skill and injects the catalog while Skill is active", async () => {
  const restore = makeProject({ alpha: "first skill", beta: "second skill" });
  const stub = makeStubPi();
  try {
    await factory(stub.pi);
    assert.ok(stub.tools.includes("Skill"), "Skill is registered in the main session");
    const [inject] = stub.handlers.get("before_agent_start") ?? [];
    assert.ok(inject, "a before_agent_start handler is registered");

    stub.active = ["read", "Skill"];
    assert.deepEqual(await inject({ systemPrompt: "Base" }), {
      systemPrompt:
        "Base\n\n<available_skills>\nalpha — first skill\nbeta — second skill\n</available_skills>",
    });

    stub.active = ["read"];
    assert.equal(
      await inject({ systemPrompt: "Base" }),
      undefined,
      "no injection when Skill is not active",
    );
  } finally {
    clearBootWindow(stub);
    restore();
  }
});

test("plugin context follows the skill catalog, and is appended whether or not Skill is active", async () => {
  const restore = makeProject({ beta: "a skill" }, "Alpha rules.\n");
  const stub = makeStubPi();
  try {
    await factory(stub.pi);
    const handlers = stub.handlers.get("before_agent_start") ?? [];
    assert.equal(handlers.length, 1);
    const [inject] = handlers;
    const block = '\n\n<plugin_context plugin="alpha">\nAlpha rules.\n</plugin_context>';
    stub.active = ["Skill"];
    assert.deepEqual(await inject?.({ systemPrompt: "Base" }), {
      systemPrompt: `Base\n\n<available_skills>\nbeta — a skill\n</available_skills>${block}`,
    });
    stub.active = ["read"];
    assert.deepEqual(await inject?.({ systemPrompt: "Base" }), {
      systemPrompt: `Base${block}`,
    });
  } finally {
    clearBootWindow(stub);
    restore();
  }
});

test("plugin context with an empty skill catalog: no Skill, context still appended", async () => {
  const restore = makeProject({}, "Alpha rules.");
  const stub = makeStubPi();
  try {
    await factory(stub.pi);
    assert.equal(stub.tools.includes("Skill"), false);
    const [inject] = stub.handlers.get("before_agent_start") ?? [];
    assert.ok(inject, "a before_agent_start handler is registered");
    assert.deepEqual(await inject({ systemPrompt: "Base" }), {
      systemPrompt: 'Base\n\n<plugin_context plugin="alpha">\nAlpha rules.\n</plugin_context>',
    });
  } finally {
    clearBootWindow(stub);
    restore();
  }
});

test("an empty skill catalog registers no Skill and no injection", async () => {
  const restore = makeProject({});
  const stub = makeStubPi();
  try {
    await factory(stub.pi);
    assert.equal(stub.tools.includes("Skill"), false);
    // No before_agent_start handler is registered when the skill catalog is empty.
    const handlers = stub.handlers.get("before_agent_start") ?? [];
    stub.active = ["read", "Skill"];
    for (const handler of handlers) {
      const result = await handler(
        { systemPrompt: "Base" },
        {
          sessionManager: { getBranch: () => [] },
        },
      );
      assert.equal(result, undefined);
    }
  } finally {
    clearBootWindow(stub);
    restore();
  }
});
