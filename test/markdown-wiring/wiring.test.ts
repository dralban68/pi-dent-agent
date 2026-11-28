import "../support/isolate-session-store.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { effectiveToolCap } from "../../lib/engine.ts";
import { makeMarkdownTool, markdownRuntime } from "pi-dent-markdown";
import { must } from "../support/must.ts";

/**
 * pi-dent-markdown specs/markdown-tool.md Section 1 and specs/agent-tool.md#tools: the
 * extension registers `Markdown` in every run mode, and a child session binds
 * it when the tool cap includes it. index.ts is loaded through jiti, as in
 * test/search-tool/wiring.test.ts.
 */

const entryDir = fileURLToPath(new URL(".", import.meta.url));
const jiti = createJiti(import.meta.url);
const factory = (
  await jiti.import<{ default: (pi: ExtensionAPI) => Promise<void> | void }>(
    join(entryDir, "..", "..", "index.ts"),
  )
).default;

interface StubPi {
  pi: ExtensionAPI;
  tools: { name: string; label?: string; parameters?: unknown; promptSnippet?: string }[];
}

function makeStubPi(): StubPi {
  const stub: StubPi = { pi: undefined as unknown as ExtensionAPI, tools: [] };
  stub.pi = {
    on: () => {},
    registerTool: (tool: { name: string }) => stub.tools.push(tool),
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
  return stub;
}

/** A throwaway home and working directory for the extension's boot snapshot. */
function makeSandbox(): { restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-markdown-wiring-"));
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

test("the extension registers Markdown with its label, promptSnippet, and parameter schema", async () => {
  const sandbox = makeSandbox();
  try {
    const stub = makeStubPi();
    await factory(stub.pi);
    const tools = stub.tools.filter((tool) => tool.name === "Markdown");
    assert.equal(tools.length, 1);
    const tool = must(tools[0]);
    assert.equal(tool.label, "Markdown");
    assert.equal(typeof tool.promptSnippet, "string");
    const schema = tool.parameters as Record<string, unknown>;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["action", "path"]);
    const properties = schema.properties as Record<string, unknown>;
    assert.deepEqual(Object.keys(properties).toSorted(), [
      "action",
      "depth",
      "limit",
      "offset",
      "operations",
      "path",
      "preview",
      "revision",
      "section",
      "sections",
    ]);
  } finally {
    sandbox.restore();
  }
});

test("a child session binds Markdown when the tool cap includes it", () => {
  const tool = makeMarkdownTool(markdownRuntime());
  assert.equal(tool.name, "Markdown");
  assert.deepEqual(effectiveToolCap(["Markdown", "Bash", "Schedule", "read"], [tool], []), [
    "Markdown",
    "read",
  ]);
  assert.deepEqual(effectiveToolCap(["Bash"], [tool], []), []);
});

test("Markdown is neither Schedule nor AskUserQuestion, so the cap keeps it", () => {
  const tool = makeMarkdownTool(markdownRuntime());
  assert.deepEqual(
    effectiveToolCap(["Markdown", "AskUserQuestion", "Schedule", "read"], [tool], []),
    ["Markdown", "read"],
  );
});
