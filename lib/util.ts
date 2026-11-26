import { randomUUID } from "node:crypto";

export type Diagnostic = { level: "warning" | "info"; message: string };

export function shortUuid(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Replace characters that are unsafe in a file name with `_`. */
export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function copyStringLiteral(text: string, start: number, out: (s: string) => void): number {
  // text[start] is the opening quote; returns the index after the closing quote.
  let i = start;
  out(text.charAt(start));
  i++;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "\\") {
      out(c);
      if (i + 1 < text.length) out(text.charAt(i + 1));
      i += 2;
      continue;
    }
    out(c);
    i++;
    if (c === '"') break;
  }
  return i;
}

function stripComments(text: string): string {
  let out = "";
  const emit = (s: string) => {
    out += s;
  };
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '"') {
      i = copyStringLiteral(text, i, emit);
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      // An unterminated block comment is a parse failure, never a silent truncation
      // of the rest of the document (specs/config-file.md#format).
      if (end === -1) throw new SyntaxError("unterminated block comment");
      i = end + 2;
      emit(" ");
      continue;
    }
    emit(c);
    i++;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  const emit = (s: string) => {
    out += s;
  };
  let i = 0;
  // Whether the container or array entry being read holds a value: a comma with none
  // before it is left in place, so `{,}` and `[,]` fail to parse instead of passing.
  let hasValue = false;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '"') {
      i = copyStringLiteral(text, i, emit);
      hasValue = true;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text.charAt(j))) j++;
      if (hasValue && (text[j] === "}" || text[j] === "]")) {
        i++;
        hasValue = false;
        continue;
      }
      emit(c);
      hasValue = false;
      i++;
      continue;
    }
    if (!/\s/.test(c)) hasValue = c !== "{" && c !== "[";
    emit(c);
    i++;
  }
  return out;
}

/** Parse a JSONC document (JSON with comments and trailing commas). Throws on invalid input. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(text)));
}

/** First line of a text, truncated to at most `max` characters. */
export function firstLine(text: string, max = 120): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > max ? line.slice(0, max) : line;
}

/** Text for the terminal, the agent directory's path written as `$PI_DENT_SESSION_DIR` (specs/agent-tool.md#child-session). */
export function shortenSessionDir(text: string, dir = process.env.PI_DENT_SESSION_DIR): string {
  return dir ? text.split(dir).join("$PI_DENT_SESSION_DIR") : text;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): string | undefined {
  return isPlainObject(error) && typeof error.code === "string" ? error.code : undefined;
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
