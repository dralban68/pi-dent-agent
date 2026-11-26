/**
 * The tool functions' pure side (specs/script-tool.md Sections 10.1 and 10.2): which callable
 * tools a call binds, and the TypeScript declarations of the bound tools.
 */

/** A callable tool as the host lists it (AgentTool's fields the tool functions read). */
export interface CallableTool {
  name: string;
  description?: string | undefined;
  parameters: unknown;
  outputSchema?: unknown;
}

export interface ToolSelection<T extends CallableTool> {
  /** Bound tools, in ascending order of name. */
  bound: T[];
  /** Unbindable tools that are not `Script` and match the allow list, in ascending order of name. */
  unbound: T[];
}

/** Default of `script.tools.allow` (specs/script-tool.md#tool-functions). */
export const DEFAULT_TOOLS_ALLOW: readonly string[] = ["*"];

/** Whether an allow entry admits `name` (Section 10.1): equal, or a `*`-terminated prefix. */
export function allowMatches(allow: readonly string[], name: string): boolean {
  return allow.some((entry) =>
    entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : entry === name,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a tool's `parameters` is an object schema (Section 10.1). */
function isBindable(tool: CallableTool): boolean {
  return isObject(tool.parameters) && tool.parameters.type === "object";
}

const byName = (a: CallableTool, b: CallableTool): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** The bound and unbound tools of one reading of the callable tools (Section 10.1). */
export function selectTools<T extends CallableTool>(
  callable: readonly T[],
  allow: readonly string[],
): ToolSelection<T> {
  const bound: T[] = [];
  const unbound: T[] = [];
  for (const tool of callable) {
    if (tool.name === "Script" || !allowMatches(allow, tool.name)) continue;
    (isBindable(tool) ? bound : unbound).push(tool);
  }
  return { bound: bound.toSorted(byName), unbound: unbound.toSorted(byName) };
}

/** A type text and whether it is a union or an intersection at its top level. */
interface Typed {
  text: string;
  kind: "union" | "intersection" | "atom";
}

const atom = (text: string): Typed => ({ text, kind: "atom" });

const UNSUPPORTED_KEYWORDS = [
  "not",
  "if",
  "prefixItems",
  "patternProperties",
  "propertyNames",
  "dependentSchemas",
  "contains",
  "unevaluatedProperties",
  "unevaluatedItems",
];

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A member or property key (Section 10.2). */
function keyText(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown): string {
  return value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
    ? JSON.stringify(value)
    : "Json";
}

/** A union of member texts: duplicates dropped, intersections parenthesized; `never` when empty. */
function union(members: readonly Typed[]): Typed {
  const kept: Typed[] = [];
  for (const member of members) {
    if (!kept.some((k) => k.text === member.text)) kept.push(member);
  }
  const [only] = kept;
  if (only === undefined) return atom("never");
  if (kept.length === 1) return only;
  const texts = kept.map((m) => (m.kind === "intersection" ? `(${m.text})` : m.text));
  return { text: texts.join(" | "), kind: "union" };
}

function unsupportedSuffix(schema: Record<string, unknown>): string {
  const found = UNSUPPORTED_KEYWORDS.filter((key) => Object.hasOwn(schema, key));
  if (
    isObject(schema.properties) &&
    Object.hasOwn(schema, "additionalProperties") &&
    schema.additionalProperties !== false
  ) {
    found.push("additionalProperties");
  }
  return found.length === 0 ? "" : ` /* unsupported: ${found.join(", ")} */`;
}

const REF = /^#\/(\$defs|definitions)\/(.+)$/;

interface TypingContext {
  root: unknown;
  /** Named schemas being typed, against `$ref` cycles. */
  typing: Set<unknown>;
}

function refTarget(ref: unknown, ctx: TypingContext): unknown {
  if (typeof ref !== "string") return undefined;
  const match = REF.exec(ref);
  if (match === null || !isObject(ctx.root)) return undefined;
  const [, section = "", name = ""] = match;
  const defs = ctx.root[section];
  if (!isObject(defs) || !Object.hasOwn(defs, name)) return undefined;
  const target = defs[name];
  return ctx.typing.has(target) ? undefined : target;
}

function arrayOf(schema: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = schema[key];
  return Array.isArray(value) ? value : undefined;
}

/** The type text of a schema without its unsupported-keyword suffix. */
function baseType(schema: Record<string, unknown>, ctx: TypingContext): Typed {
  if (Object.hasOwn(schema, "$ref")) {
    const target = refTarget(schema.$ref, ctx);
    if (target === undefined) return atom("Json /* unsupported: $ref */");
    ctx.typing.add(target);
    try {
      return typeOf(target, ctx);
    } finally {
      ctx.typing.delete(target);
    }
  }
  if (Object.hasOwn(schema, "const")) return atom(literal(schema.const));
  if (Object.hasOwn(schema, "enum")) {
    return union((arrayOf(schema, "enum") ?? []).map((value) => atom(literal(value))));
  }
  const anyOf = Object.hasOwn(schema, "anyOf") ? "anyOf" : "oneOf";
  if (Object.hasOwn(schema, anyOf)) {
    return union((arrayOf(schema, anyOf) ?? []).map((member) => typeOf(member, ctx)));
  }
  if (Object.hasOwn(schema, "allOf")) {
    const members = (arrayOf(schema, "allOf") ?? []).map((member) => typeOf(member, ctx));
    const [only] = members;
    if (only === undefined) return atom("Json");
    if (members.length === 1) return only;
    const texts = members.map((m) => (m.kind === "union" ? `(${m.text})` : m.text));
    return { text: texts.join(" & "), kind: "intersection" };
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    // Each member is typed without the suffix, which the whole union carries once.
    return union(type.map((entry) => baseType({ ...schema, type: entry }, ctx)));
  }
  if (type === "string" || type === "boolean" || type === "null") return atom(type);
  if (type === "number" || type === "integer") return atom("number");
  if (type === "array") {
    if (!Object.hasOwn(schema, "items")) return atom("Json[]");
    const items = typeOf(schema.items, ctx);
    return atom(items.kind === "atom" ? `${items.text}[]` : `(${items.text})[]`);
  }
  if (type === "object") {
    const properties = schema.properties;
    if (isObject(properties)) {
      const names = Object.keys(properties);
      if (names.length === 0) return atom("{}");
      const required = arrayOf(schema, "required") ?? [];
      const members = names.map(
        (name) =>
          `${keyText(name)}${required.includes(name) ? "" : "?"}: ${typeOf(properties[name], ctx).text}`,
      );
      return atom(`{ ${members.join("; ")} }`);
    }
    const additional = schema.additionalProperties;
    const value =
      additional === false
        ? "never"
        : additional === undefined
          ? "Json"
          : typeOf(additional, ctx).text;
    return atom(`{ [key: string]: ${value} }`);
  }
  return atom("Json");
}

function typeOf(schema: unknown, ctx: TypingContext): Typed {
  if (schema === false) return atom("never");
  if (!isObject(schema)) return atom("Json");
  const base = baseType(schema, ctx);
  return { text: base.text + unsupportedSuffix(schema), kind: base.kind };
}

/** The type text of a root schema: a tool's `parameters` or `outputSchema` (Section 10.2). */
export function schemaTypeText(schema: unknown): string {
  return typeOf(schema, { root: schema, typing: new Set() }).text;
}

/** A tool's doc text (Section 10.2): first line, trimmed, `*\/` defused, 200 characters. */
function docText(description: string | undefined): string {
  const first = (description ?? "").split(/\r\n|\r|\n/, 1)[0] ?? "";
  return first.trim().replaceAll("*/", "* /").slice(0, 200);
}

const PREAMBLE = [
  "type Json = null | boolean | number | string | Json[] | { [key: string]: Json };",
  "type ToolContent =",
  '  | { readonly type: "text"; readonly text: string }',
  '  | { readonly type: "image"; readonly data: string; readonly mimeType: string }',
  '  | { readonly type: "other"; readonly kind: string };',
  "type ToolResult<S = undefined> = {",
  "  readonly text: string;",
  "  readonly content: readonly ToolContent[];",
  "  readonly details: Json | undefined;",
  "  readonly structured: S;",
  "};",
  "declare const tools: {",
];

/** The tool declarations of a selection (Section 10.2). */
export function toolDeclarations(selection: ToolSelection<CallableTool>): string {
  const lines = [...PREAMBLE];
  for (const tool of selection.bound) {
    const doc = docText(tool.description);
    if (doc !== "") lines.push(`  /** ${doc} */`);
    const result =
      tool.outputSchema === undefined
        ? "ToolResult"
        : `ToolResult<${schemaTypeText(tool.outputSchema)}>`;
    lines.push(
      `  readonly ${keyText(tool.name)}: (args: ${schemaTypeText(tool.parameters)}) => Promise<${result}>;`,
    );
  }
  lines.push("};");
  for (const tool of selection.unbound) {
    lines.push(`// not bound: ${tool.name}: parameters is not an object schema`);
  }
  return `${lines.join("\n")}\n`;
}
