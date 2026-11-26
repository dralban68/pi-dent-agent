import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type CallableTool,
  schemaTypeText,
  selectTools,
  toolDeclarations,
} from "../../lib/script-tool-types.ts";

/** specs/script-tool.md#bound-tools and specs/script-tool.md#tool-declarations: bound tools and tool declarations. */

const cases: [string, unknown, string][] = [
  ["false", false, "never"],
  ["true", true, "Json"],
  ["a value that is not an object", 5, "Json"],
  ["an empty schema", {}, "Json"],
  ["string", { type: "string" }, "string"],
  ["boolean", { type: "boolean" }, "boolean"],
  ["null", { type: "null" }, "null"],
  ["number", { type: "number" }, "number"],
  ["integer", { type: "integer" }, "number"],
  ["an unknown type", { type: "date" }, "Json"],
  ["const string", { const: "a" }, '"a"'],
  ["const object", { const: { a: 1 } }, "Json"],
  ["enum with duplicates", { enum: ["a", 1, null, true, "a"] }, '"a" | 1 | null | true'],
  ["empty enum", { enum: [] }, "never"],
  ["enum of one", { enum: ["x"] }, '"x"'],
  ["const before type", { const: 3, type: "string" }, "3"],
  [
    "anyOf",
    { anyOf: [{ type: "string" }, { type: "integer" }, { type: "number" }] },
    "string | number",
  ],
  ["oneOf", { oneOf: [{ type: "string" }, { type: "null" }] }, "string | null"],
  ["anyOf wins over oneOf", { anyOf: [{ type: "string" }], oneOf: [{ type: "null" }] }, "string"],
  ["empty anyOf", { anyOf: [] }, "never"],
  [
    "union member that is an intersection",
    { anyOf: [{ allOf: [{ type: "string" }, { const: "a" }] }, { type: "null" }] },
    '(string & "a") | null',
  ],
  [
    "allOf with a union member",
    { allOf: [{ type: "object", properties: {} }, { enum: [1, 2] }] },
    "{} & (1 | 2)",
  ],
  ["empty allOf", { allOf: [] }, "Json"],
  [
    "allOf with a single union member keeps its type text unchanged",
    { allOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }] },
    "string | number",
  ],
  [
    "array of a single-member intersection allOf preserves intersection precedence",
    {
      type: "array",
      items: { allOf: [{ allOf: [{ type: "string" }, { const: "a" }] }] },
    },
    '(string & "a")[]',
  ],
  ["type array", { type: ["string", "null"] }, "string | null"],
  ["type array with duplicates", { type: ["integer", "number"] }, "number"],
  ["array without items", { type: "array" }, "Json[]"],
  ["array of strings", { type: "array", items: { type: "string" } }, "string[]"],
  [
    "array of a union",
    { type: "array", items: { type: ["string", "number"] } },
    "(string | number)[]",
  ],
  [
    "array of an intersection",
    { type: "array", items: { allOf: [{ type: "string" }, { type: "string", minLength: 1 }] } },
    "(string & string)[]",
  ],
  ["object with empty properties", { type: "object", properties: {} }, "{}"],
  [
    "object with properties",
    {
      type: "object",
      properties: { a: { type: "string" }, "b-c": { type: "number" }, $d: {} },
      required: ["b-c"],
      additionalProperties: false,
    },
    '{ a?: string; "b-c": number; $d?: Json }',
  ],
  ["object without properties", { type: "object" }, "{ [key: string]: Json }"],
  [
    "closed object without properties",
    { type: "object", additionalProperties: false },
    "{ [key: string]: never }",
  ],
  [
    "object with additionalProperties schema",
    { type: "object", additionalProperties: { type: "integer" } },
    "{ [key: string]: number }",
  ],
  [
    "object with properties and open additionalProperties",
    { type: "object", properties: { a: { type: "string" } }, additionalProperties: true },
    "{ a?: string } /* unsupported: additionalProperties */",
  ],
  [
    "object with non-object properties treats properties as absent",
    { type: "object", properties: [], additionalProperties: true },
    "{ [key: string]: Json }",
  ],
  [
    "unsupported keywords in order, additionalProperties last",
    {
      type: "object",
      properties: {},
      additionalProperties: {},
      unevaluatedItems: false,
      contains: {},
      not: {},
      patternProperties: {},
    },
    "{} /* unsupported: not, patternProperties, contains, unevaluatedItems, additionalProperties */",
  ],
  [
    "unsupported keyword on a string",
    { type: "string", not: { const: "" } },
    "string /* unsupported: not */",
  ],
  [
    "type array carries the marker once",
    { type: ["string", "null"], if: {} },
    "string | null /* unsupported: if */",
  ],
  [
    "other keywords leave the text unchanged",
    { type: "string", format: "uri", minLength: 2 },
    "string",
  ],
];

for (const [name, schema, expected] of cases) {
  test(`type text: ${name}`, () => {
    assert.equal(schemaTypeText(schema), expected);
  });
}

test("type text: $ref to $defs and definitions resolves in the root schema", () => {
  const schema = {
    type: "object",
    properties: { a: { $ref: "#/$defs/name" }, b: { $ref: "#/definitions/count" } },
    required: ["a", "b"],
    $defs: { name: { type: "string" } },
    definitions: { count: { type: "integer" } },
  };
  assert.equal(schemaTypeText(schema), "{ a: string; b: number }");
});

test("type text: an unsupported $ref is Json with its marker", () => {
  const root = (ref: string) => ({
    type: "object",
    properties: { a: { $ref: ref } },
    required: ["a"],
    $defs: { node: { type: "string" } },
  });
  for (const ref of ["#/$defs/missing", "https://example.com/s.json", "#", "#/properties/x"]) {
    assert.equal(schemaTypeText(root(ref)), "{ a: Json /* unsupported: $ref */ }", ref);
  }
});

test("type text: a recursive $ref stops at the schema already being typed", () => {
  const schema = {
    $ref: "#/$defs/node",
    $defs: {
      node: {
        type: "object",
        properties: { next: { $ref: "#/$defs/node" } },
      },
    },
  };
  assert.equal(schemaTypeText(schema), "{ next?: Json /* unsupported: $ref */ }");
});

const tool = (name: string, extra: Partial<CallableTool> = {}): CallableTool => ({
  name,
  description: `${name} tool`,
  parameters: { type: "object", properties: {} },
  ...extra,
});

test("bound tools: Script, disallowed and unbindable tools are left out, sorted by name", () => {
  const callable = [
    tool("Script"),
    tool("read"),
    tool("Bash"),
    tool("mcp__docs__search"),
    tool("mcp__web__fetch"),
    tool("bad", { parameters: { type: "string" } }),
    tool("worse", { parameters: true }),
  ];
  const all = selectTools(callable, ["*"]);
  assert.deepEqual(
    all.bound.map((t) => t.name),
    ["Bash", "mcp__docs__search", "mcp__web__fetch", "read"],
  );
  assert.deepEqual(
    all.unbound.map((t) => t.name),
    ["bad", "worse"],
  );
  const some = selectTools(callable, ["mcp__docs__*", "read", "bad", "Script"]);
  assert.deepEqual(
    some.bound.map((t) => t.name),
    ["mcp__docs__search", "read"],
  );
  assert.deepEqual(
    some.unbound.map((t) => t.name),
    ["bad"],
  );
  assert.deepEqual(selectTools(callable, []), { bound: [], unbound: [] });
  // Names compare case-sensitively.
  assert.deepEqual(
    selectTools(callable, ["bash"]).bound.map((t) => t.name),
    [],
  );
});

const PREAMBLE = `type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | { readonly type: "other"; readonly kind: string };
type ToolResult<S = undefined> = {
  readonly text: string;
  readonly content: readonly ToolContent[];
  readonly details: Json | undefined;
  readonly structured: S;
};
declare const tools: {
`;

test("declarations: no bound tool leaves the members line out", () => {
  assert.equal(toolDeclarations({ bound: [], unbound: [] }), `${PREAMBLE}};\n`);
});

test("declarations: members, doc lines, keys, output schemas and not-bound lines", () => {
  const selection = selectTools(
    [
      tool("read", {
        description: "  Read a file. */ done  \nSecond line",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }),
      tool("mcp-search", {
        description: "",
        outputSchema: {
          type: "object",
          properties: { hits: { type: "array", items: { type: "string" } } },
          required: ["hits"],
        },
      }),
      tool("long", { description: "x".repeat(250) }),
      tool("odd", { parameters: { type: "array" } }),
      tool("Script"),
    ],
    ["*"],
  );
  assert.equal(
    toolDeclarations(selection),
    `${PREAMBLE}  /** ${"x".repeat(200)} */
  readonly long: (args: {}) => Promise<ToolResult>;
  readonly "mcp-search": (args: {}) => Promise<ToolResult<{ hits: string[] }>>;
  /** Read a file. * / done */
  readonly read: (args: { path: string }) => Promise<ToolResult>;
};
// not bound: odd: parameters is not an object schema
`,
  );
});
