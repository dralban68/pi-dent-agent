import Schema from "typebox/schema";
import type { CallableTool } from "./script-tool-types.ts";

/**
 * A nested call of a tool function, host side (specs/script-tool.md#calling-tool, steps 2 to 4).
 * Step 1 runs in the script worker.
 */

/** A `ToolContent` part (specs/script-tool.md#tool-declarations). */
export type ToolCallContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "other"; kind: string };

/** The resolved value of a tool function, before the worker freezes it (specs/script-tool.md#calling-tool). */
export interface ToolCallValue {
  text: string;
  content: ToolCallContent[];
  details: unknown;
  structured: unknown;
}

export type ToolCallReply =
  | { ok: true; value: ToolCallValue }
  | { ok: false; error: { name: string; message: string } };

/** The host's outcome of a nested call, as `ctx.executeTool` resolves it. */
export interface NestedCallOutcome {
  result: { content: readonly unknown[]; details?: unknown; structuredContent?: unknown };
  isError: boolean;
}

export type ExecuteTool = (
  name: string,
  args: unknown,
  options: { signal: AbortSignal },
) => Promise<NestedCallOutcome>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A content part as a `ToolContent` (specs/script-tool.md#calling-tool): text, image, or `other` naming its type. */
function contentPart(part: unknown): ToolCallContent {
  if (!isRecord(part)) return { type: "other", kind: "" };
  if (part.type === "text" && typeof part.text === "string") {
    return { type: "text", text: part.text };
  }
  if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
    return { type: "image", data: part.data, mimeType: part.mimeType };
  }
  return { type: "other", kind: typeof part.type === "string" ? part.type : "" };
}

/** `details` through a JSON round trip; `undefined` when it does not survive one (specs/script-tool.md#calling-tool). */
function jsonDetails(details: unknown): unknown {
  if (details === undefined) return undefined;
  let json: string | undefined;
  try {
    json = JSON.stringify(details);
  } catch {
    // specs/script-tool.md#calling-tool: details that JSON.stringify rejects become undefined.
    return undefined;
  }
  return json === undefined ? undefined : JSON.parse(json);
}

/** Whether `value` validates against a JSON Schema; a schema the validator rejects matches nothing. */
function validates(schema: unknown, value: unknown): boolean {
  if (typeof schema !== "boolean" && (typeof schema !== "object" || schema === null)) return false;
  try {
    return Schema.Check(schema, value);
  } catch {
    // The mismatch rejection reports it to the script (specs/script-tool.md#calling-tool, step 3).
    return false;
  }
}

/** Run one nested call and settle it per specs/script-tool.md#calling-tool, steps 2 to 4. */
export async function callBoundTool(
  tool: CallableTool,
  args: unknown,
  executeTool: ExecuteTool,
  signal: AbortSignal,
): Promise<ToolCallReply> {
  const outcome = await executeTool(tool.name, args, { signal });
  const content = outcome.result.content.map(contentPart);
  const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  if (outcome.isError) {
    return {
      ok: false,
      error: { name: "ToolError", message: text === "" ? `tool ${tool.name} failed` : text },
    };
  }
  const structured = outcome.result.structuredContent;
  if (tool.outputSchema !== undefined) {
    if (structured === undefined || !validates(tool.outputSchema, structured)) {
      return {
        ok: false,
        error: {
          name: "Error",
          message: `tool ${tool.name} returned structured content that does not match its output schema`,
        },
      };
    }
  }
  return {
    ok: true,
    value: {
      text,
      content,
      details: jsonDetails(outcome.result.details),
      structured: tool.outputSchema === undefined ? undefined : structured,
    },
  };
}
