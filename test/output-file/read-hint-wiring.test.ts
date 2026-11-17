import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

/**
 * specs/script-tool.md Section 6: the main session registers the read hint on
 * `tool_result`, rooted at the `PI_DENT_SESSION_DIR` of the process environment.
 * index.ts is loaded through jiti, as in test/markdown-wiring/wiring.test.ts.
 */

const entryDir = fileURLToPath(new URL(".", import.meta.url));
const jiti = createJiti(import.meta.url);
const factory = (
  await jiti.import<{ default: (pi: ExtensionAPI) => Promise<void> | void }>(
    join(entryDir, "..", "..", "index.ts"),
  )
).default;

type Handler = (event: ToolResultEvent, ctx: unknown) => unknown;

function makeStubPi(handlers: Handler[]): ExtensionAPI {
  return {
    on: (name: string, handler: Handler) => {
      if (name === "tool_result") handlers.push(handler);
    },
    registerTool: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerShortcut: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    sendMessage: () => {},
    sendUserMessage: async () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
}

/** A throwaway home and working directory for the extension's boot snapshot. */
function makeSandbox(): { restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-read-hint-wiring-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(project, ".pi", "pi-dent"), { recursive: true });
  const previous = { home: process.env.HOME, cwd: process.cwd() };
  process.env.HOME = home;
  process.chdir(project);
  return {
    restore: () => {
      process.chdir(previous.cwd);
      if (previous.home === undefined) delete process.env.HOME;
      else process.env.HOME = previous.home;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the main session's read hint searches PI_DENT_SESSION_DIR", async () => {
  const sandbox = makeSandbox();
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-dent-read-hint-session-"));
  const previous = process.env.PI_DENT_SESSION_DIR;
  try {
    const real = join(sessionDir, "dynamic-56ce5485.agents", "output", "5b40c845.log");
    mkdirSync(join(sessionDir, "dynamic-56ce5485.agents", "output"), { recursive: true });
    writeFileSync(real, "out\n");
    process.env.PI_DENT_SESSION_DIR = sessionDir;
    const handlers: Handler[] = [];
    await factory(makeStubPi(handlers));
    assert.ok(handlers.length > 0, "a tool_result hook is registered");
    const event = {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "read",
      input: { path: join(sessionDir, "output", "5b40c845.log") },
      content: [{ type: "text", text: "ENOENT: no such file or directory" }],
      details: undefined,
      isError: true,
    } satisfies ToolResultEvent;
    const results = await Promise.all(handlers.map((handler) => handler(event, undefined)));
    const parts = results.flatMap((result) =>
      typeof result === "object" && result !== null && "content" in result
        ? (result.content as { type: string; text?: string }[])
        : [],
    );
    const hinted = parts.find(
      (part) => part.type === "text" && part.text?.endsWith(`\nDid you mean ${real}?`),
    );
    assert.ok(hinted, "the main session gets the hint");
  } finally {
    if (previous === undefined) delete process.env.PI_DENT_SESSION_DIR;
    else process.env.PI_DENT_SESSION_DIR = previous;
    rmSync(sessionDir, { recursive: true, force: true });
    sandbox.restore();
  }
});
