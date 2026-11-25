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
 * Plugin slash commands per specs/plugin.md Section 5: the extension
 * factory registers one command per commands/*.md resource of each
 * admitted plugin, invoked as /<namespace>:<command>;
 * the body is read fresh, substituted per plugin.md Section 6, and
 * delivered as exactly one user message. index.ts is loaded through jiti
 * (the loader pi itself uses) because its module graph is not loadable
 * under native type stripping.
 */

const realTmp = tmpdir();
const entryDir = fileURLToPath(new URL(".", import.meta.url));

const jiti = createJiti(import.meta.url);
const factory = (
  await jiti.import<{ default: (pi: ExtensionAPI) => Promise<void> | void }>(
    join(entryDir, "..", "..", "index.ts"),
  )
).default;

interface CommandDef {
  description?: string;
  handler: (
    args: string,
    ctx: { ui: { notify: (message: string, level: string) => void } },
  ) => Promise<void>;
}

interface Notice {
  message: string;
  level: string;
}

interface StubPi {
  pi: ExtensionAPI;
  handlers: Map<string, (event?: unknown, ctx?: unknown) => unknown>;
  commands: Map<string, CommandDef>;
  sent: string[];
  delivered: { text: string; deliverAs: string | undefined }[];
  /** Host state: while streaming, a prompt without a delivery mode is refused. */
  streaming: boolean;
  notices: Notice[];
  entryRenderers: string[];
}

function makeStubPi(): StubPi {
  const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const commands = new Map<string, CommandDef>();
  const sent: string[] = [];
  const delivered: { text: string; deliverAs: string | undefined }[] = [];
  const notices: Notice[] = [];
  const entryRenderers: string[] = [];
  const stub = {
    handlers,
    commands,
    sent,
    delivered,
    notices,
    streaming: false,
    entryRenderers,
    pi: undefined as unknown as ExtensionAPI,
  };
  stub.pi = {
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) =>
      handlers.set(event, handler),
    registerTool: (_tool: unknown) => {},
    registerCommand: (name: string, def: CommandDef) => commands.set(name, def),
    registerMessageRenderer: () => {},
    registerEntryRenderer: (name: string) => {
      entryRenderers.push(name);
    },
    registerShortcut: () => {},
    sendMessage: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    events: { on: () => () => {}, emit: () => {} },
    sendUserMessage: async (text: string, options?: { deliverAs?: string }) => {
      if (stub.streaming && options?.deliverAs === undefined) {
        // The host's own refusal (agent-session.js `_preparePrompt`).
        throw new Error(
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        );
      }
      delivered.push({ text, deliverAs: options?.deliverAs });
      sent.push(text);
    },
  } as unknown as ExtensionAPI;
  return stub;
}

/** A command context that records what the host would show the user. */
function makeCtx(): {
  ctx: { ui: { notify: (message: string, level: string) => void } };
  notices: Notice[];
} {
  const notices: Notice[] = [];
  return {
    ctx: {
      ui: {
        notify: (message: string, level: string) => {
          notices.push({ message, level });
        },
      },
    },
    notices,
  };
}

const ctx = { ui: { notify: (_message: string, _level: string) => {} } };

interface Fixture {
  globalConf: string;
  projectConf: string;
  globalScope: string;
  projectScope: string;
  restore: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(realTmp, "pi-dent-slash-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const globalConfDir = join(home, ".pi", "pi-dent");
  const projectConfDir = join(project, ".pi", "pi-dent");
  const globalScope = join(globalConfDir, "plugins");
  const projectScope = join(projectConfDir, "plugins");
  mkdirSync(globalScope, { recursive: true });
  mkdirSync(projectScope, { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  const prevHome = process.env.HOME;
  const prevTmpdir = process.env.TMPDIR;
  const prevCwd = process.cwd();
  process.env.HOME = home;
  process.env.TMPDIR = join(root, "tmp");
  process.chdir(project);
  return {
    globalConf: join(globalConfDir, "pi-dent.conf"),
    projectConf: join(projectConfDir, "pi-dent.conf"),
    globalScope,
    projectScope,
    restore: () => {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdir;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Declare plugin entries in a layer's pi-dent.conf (specs/plugin.md Section 4).
 * Global-layer relative paths resolve against the global base directory; the
 * project layer may use absolute paths.
 */
function declarePlugins(
  fixture: Fixture,
  layer: "global" | "project",
  entries: Record<string, { path: string }>,
): void {
  const conf = layer === "global" ? fixture.globalConf : fixture.projectConf;
  writeFileSync(conf, JSON.stringify({ plugins: entries }));
}

/** The boot window is cached on globalThis; a reload shutdown clears it so the next factory call re-reads. */
function clearBootWindow(stub: StubPi): void {
  stub.handlers.get("session_shutdown")?.({ reason: "reload" });
}

function writePlugin(
  scope: string,
  dir: string,
  name: string,
  commands: Record<string, string>,
): string {
  const root = join(scope, dir);
  mkdirSync(root);
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ name }));
  for (const [file, text] of Object.entries(commands)) {
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(root, "commands", file), text);
  }
  return root;
}

test("registers one command per commands/*.md, named <namespace>:<command>, non-markdown entries ignored", async () => {
  const fixture = makeFixture();
  const stub = makeStubPi();
  try {
    const root = writePlugin(fixture.globalScope, "alpha", "alpha", {
      "greet.md": "---\ndescription: Say hi\nfuture: ignored key\n---\n\nHello $1\n",
      "plain.md": "No frontmatter here $ARGUMENTS\n",
      "notes.txt": "not a command\n",
    });
    mkdirSync(join(root, "commands", "sub"), { recursive: true });
    writeFileSync(join(root, "commands", "sub", "deep.md"), "nested, not flat\n");
    declarePlugins(fixture, "global", { alpha: { path: "plugins/alpha" } });
    await factory(stub.pi);
    assert.deepEqual([...stub.commands.keys()].toSorted(), [
      "alpha:greet",
      "alpha:plain",
      "dent",
      "dent-ui",
      "fleet",
      "recap",
      "tasks",
    ]);
    assert.equal(must(stub.commands.get("recap")).description, "Recap the current session");
    assert.ok(stub.entryRenderers.includes("pi-dent-recap"));
    assert.equal(must(stub.commands.get("alpha:greet")).description, "Say hi");
    assert.equal(
      "description" in must(stub.commands.get("alpha:plain")),
      false,
      "no description key when frontmatter lacks one",
    );
  } finally {
    clearBootWindow(stub);
    fixture.restore();
  }
});

test("delivers the rendered body as exactly one user message per invocation", async () => {
  const fixture = makeFixture();
  const stub = makeStubPi();
  try {
    writePlugin(fixture.globalScope, "alpha", "alpha", {
      "greet.md": "---\ndescription: d\n---\n\nHello $1\n",
    });
    declarePlugins(fixture, "global", { alpha: { path: "plugins/alpha" } });
    await factory(stub.pi);
    const greet = must(stub.commands.get("alpha:greet"));
    await greet.handler("World", ctx);
    assert.deepEqual(stub.sent, ["Hello World"]);
    await greet.handler("Again", ctx);
    assert.deepEqual(stub.sent, ["Hello World", "Hello Again"]);
  } finally {
    clearBootWindow(stub);
    fixture.restore();
  }
});

test("reads the command body fresh at each invocation", async () => {
  const fixture = makeFixture();
  const stub = makeStubPi();
  try {
    const root = writePlugin(fixture.globalScope, "alpha", "alpha", {
      "greet.md": "---\ndescription: d\n---\n\nHello $1\n",
    });
    declarePlugins(fixture, "global", { alpha: { path: "plugins/alpha" } });
    await factory(stub.pi);
    const greet = must(stub.commands.get("alpha:greet"));
    await greet.handler("World", ctx);
    assert.equal(stub.sent[0], "Hello World");
    writeFileSync(join(root, "commands", "greet.md"), "---\ndescription: d\n---\n\nHi $1\n");
    await greet.handler("World", ctx);
    assert.equal(stub.sent[1], "Hi World");
  } finally {
    clearBootWindow(stub);
    fixture.restore();
  }
});

test("substitutes the invocation argument string per the token rules; no arguments substitute empties", async () => {
  const fixture = makeFixture();
  const stub = makeStubPi();
  try {
    writePlugin(fixture.globalScope, "alpha", "alpha", {
      "args.md": "a=$1 second=$2 none=$@ raw=$ARGUMENTS\n",
    });
    declarePlugins(fixture, "global", { alpha: { path: "plugins/alpha" } });
    await factory(stub.pi);
    const args = must(stub.commands.get("alpha:args"));
    await args.handler('x "y z" w', ctx);
    // No quoting: the tokens are `x`, `"y`, `z"`, `w`; `$@` stays literal; the body is trimmed.
    assert.equal(stub.sent[0], 'a=x second="y none=$@ raw=x "y z" w');
    // The host always passes a string: an invocation without arguments passes "".
    await args.handler("", ctx);
    assert.equal(stub.sent[1], "a= second= none=$@ raw=");
  } finally {
    clearBootWindow(stub);
    fixture.restore();
  }
});

test("a command run while the agent is working is queued as a followUp message", async () => {
  const fixture = makeFixture();
  const stub = makeStubPi();
  try {
    writePlugin(fixture.globalScope, "alpha", "alpha", {
      "greet.md": "---\ndescription: d\n---\n\nHello $1\n",
    });
    declarePlugins(fixture, "global", { alpha: { path: "plugins/alpha" } });
    await factory(stub.pi);
    stub.streaming = true;
    const notices = makeCtx();
    await must(stub.commands.get("alpha:greet")).handler("World", notices.ctx);
    assert.deepEqual(stub.delivered, [{ text: "Hello World", deliverAs: "followUp" }]);
    assert.deepEqual(notices.notices, []);
  } finally {
    clearBootWindow(stub);
    fixture.restore();
  }
});

test("a command body that fails to read at invocation shows an error notification and sends nothing", async () => {
  const fixture = makeFixture();
  const stub = makeStubPi();
  try {
    const root = writePlugin(fixture.globalScope, "alpha", "alpha", {
      "greet.md": "---\ndescription: d\n---\n\nHello $1\n",
    });
    declarePlugins(fixture, "global", { alpha: { path: "plugins/alpha" } });
    await factory(stub.pi);
    const greet = must(stub.commands.get("alpha:greet"));
    rmSync(join(root, "commands", "greet.md"));
    const shown = makeCtx();
    await greet.handler("World", shown.ctx);
    assert.deepEqual(stub.sent, []);
    assert.equal(shown.notices.length, 1);
    assert.equal(shown.notices[0]?.level, "error");
    assert.match(must(shown.notices[0]?.message), /^pi-dent: alpha:greet: /u);
  } finally {
    clearBootWindow(stub);
    fixture.restore();
  }
});

test("a command body whose frontmatter fails to parse at invocation shows an error notification", async () => {
  const fixture = makeFixture();
  const stub = makeStubPi();
  try {
    const root = writePlugin(fixture.globalScope, "alpha", "alpha", {
      "greet.md": "---\ndescription: d\n---\n\nHello $1\n",
    });
    declarePlugins(fixture, "global", { alpha: { path: "plugins/alpha" } });
    await factory(stub.pi);
    const greet = must(stub.commands.get("alpha:greet"));
    writeFileSync(join(root, "commands", "greet.md"), "---\ndescription: [unclosed\n---\nbody\n");
    const shown = makeCtx();
    await greet.handler("World", shown.ctx);
    assert.deepEqual(stub.sent, []);
    assert.equal(shown.notices.length, 1);
    assert.match(must(shown.notices[0]?.message), /^pi-dent: alpha:greet: /u);
  } finally {
    clearBootWindow(stub);
    fixture.restore();
  }
});
