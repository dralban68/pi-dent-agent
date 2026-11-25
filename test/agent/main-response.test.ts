import "../support/isolate-session-store.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const factory = (
  await jiti.import<{ default: (pi: ExtensionAPI) => void }>(
    new URL("../../index.ts", import.meta.url).pathname,
  )
).default;

test("the main session's own provider response is not forwarded", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-main-response-"));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const observations: unknown[] = [];
  mkdirSync(join(root, ".pi", "pi-dent"), { recursive: true });
  process.env.HOME = root;
  process.chdir(root);
  try {
    factory({
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerTool: () => {},
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      registerEntryRenderer: () => {},
      registerShortcut: () => {},
      events: {
        on: () => () => {},
        emit: (name: string, payload: unknown) => {
          if (name === "purse:observe:v1") observations.push(payload);
        },
      },
    } as unknown as ExtensionAPI);
    for (const handler of handlers.get("after_provider_response") ?? []) {
      await handler(
        { type: "after_provider_response", status: 200, headers: { limit: "42" } },
        { model: { provider: "anthropic" } },
      );
    }
    assert.deepEqual(observations, []);
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler({ reason: "reload" }, {});
    }
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
