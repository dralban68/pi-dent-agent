import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import type { ToolCallContent, ToolCallReply, ToolCallValue } from "./script-tool-calls.ts";
import { errorMessage, isPlainObject } from "./util.ts";

/**
 * Worker thread hosting one plugin UI check's fixtures module
 * (specs/plugin-ui-tool.md Section 5). Loads the module once, validates its
 * default export shape, and serves tool calls until terminated.
 */

interface FixturesWorkerData {
  modulePath: string;
  cwd: string;
}

interface CallMessage {
  type: "call";
  id: number;
  name: string;
  args: unknown;
}

const ALLOWED_RESULT_KEYS = new Set(["text", "content", "details", "structured"]);

function isCallMessage(value: unknown): value is CallMessage {
  return (
    isPlainObject(value) &&
    value.type === "call" &&
    typeof value.id === "number" &&
    typeof value.name === "string"
  );
}

function normalizeContent(raw: unknown, fallbackText: string): ToolCallContent[] {
  if (!Array.isArray(raw)) return [{ type: "text", text: fallbackText }];
  return raw.map((part): ToolCallContent => {
    if (isPlainObject(part)) {
      if (part.type === "text" && typeof part.text === "string") {
        return { type: "text", text: part.text };
      }
      if (
        part.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string"
      ) {
        return { type: "image", data: part.data, mimeType: part.mimeType };
      }
      return { type: "other", kind: typeof part.type === "string" ? part.type : "" };
    }
    return { type: "other", kind: "" };
  });
}

function normalizeFixtureResult(value: unknown): ToolCallValue {
  if (
    isPlainObject(value) &&
    typeof value.text === "string" &&
    Object.keys(value).every((key) => ALLOWED_RESULT_KEYS.has(key))
  ) {
    return {
      text: value.text,
      content: normalizeContent(value.content, value.text),
      details: value.details,
      structured: value.structured,
    };
  }
  const serialized = JSON.stringify(value) ?? "undefined";
  return {
    text: serialized,
    content: [{ type: "text", text: serialized }],
    details: undefined,
    structured: undefined,
  };
}

function isFixturesWorkerData(value: unknown): value is FixturesWorkerData {
  return (
    isPlainObject(value) && typeof value.modulePath === "string" && typeof value.cwd === "string"
  );
}

function isCallable(value: unknown): value is (args: unknown) => unknown {
  return typeof value === "function";
}

async function main(): Promise<void> {
  const port = parentPort;
  if (!port || !isFixturesWorkerData(workerData)) return;

  try {
    process.chdir(workerData.cwd);
  } catch {
    // Keep inherited cwd if chdir fails.
  }

  let mod: unknown;
  try {
    const url = pathToFileURL(workerData.modulePath);
    mod = await import(`${url.href}?t=${Date.now()}`);
  } catch (error) {
    port.postMessage({ type: "ready", ok: false, error: errorMessage(error) });
    return;
  }

  const exported = isPlainObject(mod) ? mod.default : undefined;
  if (!isPlainObject(exported)) {
    port.postMessage({
      type: "ready",
      ok: false,
      error: "default export must be a plain object mapping tool names to functions",
    });
    return;
  }

  const fixtures = new Map<string, (args: unknown) => unknown>();
  for (const [key, val] of Object.entries(exported)) {
    if (!isCallable(val)) {
      port.postMessage({
        type: "ready",
        ok: false,
        error: `default export property "${key}" must be a function`,
      });
      return;
    }
    fixtures.set(key, val);
  }

  port.on("message", (raw: unknown) => {
    if (!isCallMessage(raw)) return;
    const fn = fixtures.get(raw.name);
    if (!fn) {
      const reply: ToolCallReply = {
        ok: false,
        error: { name: "Error", message: `tool ${raw.name} is unavailable in a plugin UI call` },
      };
      port.postMessage({ type: "reply", id: raw.id, reply });
      return;
    }
    void Promise.resolve()
      .then(() => fn(raw.args))
      .then((result) => {
        const reply: ToolCallReply = { ok: true, value: normalizeFixtureResult(result) };
        port.postMessage({ type: "reply", id: raw.id, reply });
      })
      .catch((error: unknown) => {
        const reply: ToolCallReply = {
          ok: false,
          error: { name: "Error", message: errorMessage(error) },
        };
        port.postMessage({ type: "reply", id: raw.id, reply });
      });
  });

  port.postMessage({ type: "ready", ok: true, names: [...fixtures.keys()] });
}

void main();
