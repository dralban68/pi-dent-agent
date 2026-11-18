import { inspect } from "node:util";

/**
 * Section 5 return rendering: JSON-compatibility detection, the rendered
 * return string with 500-character string clipping, the 10000-character
 * aggregate cap, and the single-line JSON of a JSON-compatible value.
 */

const MAX_STRING = 500;
const MAX_AGGREGATE = 10000;

export interface TruncatedString {
  path: (string | number)[];
  originalLength: number;
  renderedLength: number;
}

export interface ReturnValueRender {
  stringsOverLimit: number;
  truncatedStrings: TruncatedString[];
  aggregateTruncated: boolean;
}

export interface RenderedReturn {
  /** The rendered return text (for the `--- return ---` block). */
  rendered: string;
  /** The JSON-compatible value for details.returnValue, or undefined when not compatible. */
  jsonValue?: unknown;
  /** The single-line JSON of a JSON-compatible value (Section 5). */
  json?: string | undefined;
  render: ReturnValueRender;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isJsonCompatible(value: unknown, ancestors: Set<object> = new Set()): boolean {
  if (value === null) return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return true;
  if (Array.isArray(value) || (typeof value === "object" && isPlainObject(value))) {
    // A cycle is not JSON-compatible: JSON.stringify cannot express it.
    if (ancestors.has(value)) return false;
    // An array with missing elements (a hole) is not JSON-compatible: the
    // members check skips holes, but JSON.stringify renders them as `null`,
    // which does not round-trip (Section 5).
    if (Array.isArray(value) && Object.keys(value).length !== value.length) return false;
    ancestors.add(value);
    const members = Array.isArray(value) ? value : Object.values(value);
    const compatible = members.every((member) => isJsonCompatible(member, ancestors));
    ancestors.delete(value);
    return compatible;
  }
  return false;
}

interface RenderState {
  stringsOverLimit: number;
  truncatedStrings: TruncatedString[];
}

function renderValue(
  value: unknown,
  path: (string | number)[],
  state: RenderState,
  indent: number,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    if (value.length > MAX_STRING) {
      state.stringsOverLimit++;
      state.truncatedStrings.push({
        path: [...path],
        originalLength: value.length,
        renderedLength: MAX_STRING,
      });
      return JSON.stringify(`${value.slice(0, MAX_STRING)}... [truncated]`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${String(value)}n`;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (ancestors.has(value)) return "[Circular]";
    ancestors.add(value);
    const pad = "  ".repeat(indent + 1);
    const closePad = "  ".repeat(indent);
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      parts.push(`${pad}${renderValue(value[i], [...path, i], state, indent + 1, ancestors)}`);
    }
    ancestors.delete(value);
    return `[\n${parts.join(",\n")}\n${closePad}]`;
  }
  if (typeof value === "object") {
    if (isPlainObject(value)) {
      const entries = Object.entries(value);
      if (entries.length === 0) return "{}";
      if (ancestors.has(value)) return "[Circular]";
      ancestors.add(value);
      const pad = "  ".repeat(indent + 1);
      const closePad = "  ".repeat(indent);
      const parts: string[] = [];
      for (const [key, val] of entries) {
        parts.push(
          `${pad}${JSON.stringify(key)}: ${renderValue(val, [...path, key], state, indent + 1, ancestors)}`,
        );
      }
      ancestors.delete(value);
      return `{\n${parts.join(",\n")}\n${closePad}}`;
    }
    // Non-plain object (Date, Map, Set, class instance, ...): render meaningfully.
    return inspect(value);
  }
  return String(value);
}

/** The single-line JSON of `value`, or `undefined` when `JSON.stringify` throws (Section 5). */
function jsonOf(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function renderReturn(value: unknown): RenderedReturn {
  const state: RenderState = { stringsOverLimit: 0, truncatedStrings: [] };
  const rendered = renderValue(value, [], state, 0, new Set());
  let finalRendered = rendered;
  let aggregateTruncated = false;
  if (rendered.length > MAX_AGGREGATE) {
    finalRendered = `${rendered.slice(0, MAX_AGGREGATE)}\n... [aggregate truncated] ...`;
    aggregateTruncated = true;
  }
  const render: ReturnValueRender = {
    stringsOverLimit: state.stringsOverLimit,
    truncatedStrings: state.truncatedStrings,
    aggregateTruncated,
  };
  let jsonValue: unknown;
  let json: string | undefined;
  if (isJsonCompatible(value)) {
    jsonValue = value;
    json = jsonOf(value);
  }
  return { rendered: finalRendered, jsonValue, json, render };
}
