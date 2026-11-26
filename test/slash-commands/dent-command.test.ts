import "../support/isolate-session-store.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { must } from "../support/must.ts";

/**
 * The `/dent` command per specs/slash-commands.md#dent: the info notification
 * with the four counts of the boot snapshot. index.ts is loaded through jiti, as in
 * test/plugins/slash-commands.test.ts, because its module graph is not loadable under
 * native type stripping.
 */

const entryDir = fileURLToPath(new URL(".", import.meta.url));
const jiti = createJiti(import.meta.url);
const factory = (
  await jiti.import<{ default: (pi: ExtensionAPI) => Promise<void> | void }>(
    join(entryDir, "..", "..", "index.ts"),
  )
).default;

interface Notice {
  message: string;
  level: string;
}

interface StubPi {
  pi: ExtensionAPI;
  handlers: Map<string, (event?: unknown, ctx?: unknown) => unknown>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  notices: Notice[];
}

function makeStubPi(): StubPi {
  const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notices: Notice[] = [];
  const pi = {
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) =>
      handlers.set(event, handler),
    registerTool: () => {},
    registerCommand: (
      name: string,
      def: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => commands.set(name, def),
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerShortcut: () => {},
    sendMessage: () => {},
    sendUserMessage: async () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands, notices };
}

interface Fixture {
  root: string;
  globalScope: string;
  globalConf: string;
  restore: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-dent-command-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const confDir = join(home, ".pi", "pi-dent");
  const globalScope = join(confDir, "plugins");
  mkdirSync(globalScope, { recursive: true });
  mkdirSync(join(project, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  const previous = {
    home: process.env.HOME,
    tmpdir: process.env.TMPDIR,
    cwd: process.cwd(),
  };
  process.env.HOME = home;
  process.env.TMPDIR = join(root, "tmp");
  process.chdir(project);
  return {
    root,
    globalScope,
    globalConf: join(confDir, "pi-dent.conf"),
    restore: () => {
      process.chdir(previous.cwd);
      if (previous.home === undefined) delete process.env.HOME;
      else process.env.HOME = previous.home;
      if (previous.tmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous.tmpdir;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One plugin contributing an agent and two skills (specs/plugin.md#catalog-composition). */
function writePlugin(fixture: Fixture): string {
  const root = join(fixture.globalScope, "alpha");
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ name: "alpha" }));
  writeFileSync(join(root, "agents", "reviewer.md"), "---\nname: reviewer\n---\nReview it.\n");
  for (const name of ["first", "second"]) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(
      join(root, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} skill\n---\nBody.\n`,
    );
  }
  return root;
}

const notifyCtx = (notices: Notice[]) => ({
  ui: {
    notify: (message: string, level: string) => {
      notices.push({ message, level });
    },
  },
});

/** The boot window is cached on globalThis; a reload shutdown clears it for the next factory call. */
function clearBootWindow(stub: StubPi): void {
  stub.handlers.get("session_shutdown")?.({ reason: "reload" });
}

test("/dent shows the boot snapshot's agent, skill, plugin, and diagnostic counts", async () => {
  const fixture = makeFixture();
  const stub = makeStubPi();
  try {
    writePlugin(fixture);
    // Two entries that are not directories: two boot diagnostics.
    writeFileSync(
      fixture.globalConf,
      JSON.stringify({
        plugins: {
          alpha: { path: "plugins/alpha" },
          gone: { path: "plugins/gone" },
          missing: { path: "plugins/missing" },
        },
      }),
    );
    await factory(stub.pi);
    const command = must(stub.commands.get("dent"));
    await command.handler("", notifyCtx(stub.notices));
    assert.deepEqual(stub.notices, [
      {
        message: "pi-dent extension is loaded (1 agents, 2 skills, 1 plugins, 2 boot diagnostics)",
        level: "info",
      },
    ]);
  } finally {
    clearBootWindow(stub);
    fixture.restore();
  }
});
