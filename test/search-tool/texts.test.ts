import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { makeSearchTool, searchRuntime } from "../../lib/search-tool.ts";
import { must } from "../support/must.ts";

/**
 * specs/search-tool.md#model-texts: the model-facing texts are registered verbatim. The
 * assertions are on the registered tool's fields and parameter schema, and the expected
 * texts are read out of the specification's own table and code blocks.
 */

const specPath = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "specs",
  "search-tool.md",
);
const spec = readFileSync(specPath, "utf8");

/** The body of the first fenced `text` block after `marker`. */
function blockAfter(marker: string): string {
  const from = spec.indexOf(marker);
  assert.equal(from >= 0, true, marker);
  const open = spec.indexOf("```text\n", from);
  const close = spec.indexOf("\n```", open);
  assert.equal(open >= 0 && close > open, true, marker);
  return spec.slice(open + "```text\n".length, close);
}

/** A quoted literal of the specs/search-tool.md#registration registration table, by field. */
function registrationValue(field: string): string {
  const match = new RegExp(`^\\| \`${field}\`\\s+\\| \`"(.*)"\`\\s+\\|$`, "m").exec(spec);
  assert.notEqual(match, null, field);
  return must(match?.[1]);
}

/** The specs/search-tool.md#model-texts parameter table's `description` column, by field. */
function tableDescriptions(): Record<string, string> {
  const from = spec.indexOf("| Field           | `description`");
  assert.equal(from >= 0, true);
  const to = spec.indexOf("\n\n", from);
  const descriptions: Record<string, string> = {};
  for (const line of spec.slice(from, to).split("\n")) {
    const match = /^\| `([a-zA-Z]+)`\s+\| `(.*)`\s+\|$/.exec(line);
    if (match === null) continue;
    const field = match[1];
    const description = match[2];
    if (field === undefined || description === undefined) continue;
    descriptions[field] = description;
  }
  return descriptions;
}

function registeredTool() {
  return makeSearchTool({
    runtime: searchRuntime({ zone: "UTC" }),
    host: () => ({ sessionFile: undefined, agentDirectory: "/tmp/pi-dent-texts", main: false }),
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const schemaProperties = (schema: unknown): Record<string, unknown> => {
  const properties = isRecord(schema) ? schema.properties : undefined;
  return isRecord(properties) ? properties : {};
};

test("the registered Search tool carries the specification's name, label, description, and promptSnippet", () => {
  const tool = registeredTool();
  assert.equal(tool.name, registrationValue("name"));
  assert.equal(tool.label, registrationValue("label"));
  assert.equal(tool.description, blockAfter("The `description` is"));
  assert.equal(tool.promptSnippet, blockAfter("The `promptSnippet` is"));
});

test("every parameter description is the specification's text, verbatim", () => {
  const properties = schemaProperties(registeredTool().parameters);
  const expected = tableDescriptions();
  assert.deepEqual(Object.keys(properties).toSorted(), Object.keys(expected).toSorted());
  for (const [field, description] of Object.entries(expected)) {
    const property = properties[field];
    const actual = isRecord(property) ? property.description : undefined;
    assert.equal(actual, description, field);
  }
});

test("the schema of a kinds element carries no description", () => {
  const kinds = schemaProperties(registeredTool().parameters).kinds;
  const anyOf = isRecord(kinds) ? kinds.anyOf : undefined;
  assert.equal(Array.isArray(anyOf), true, "kinds is a union");
  const alternatives = Array.isArray(anyOf) ? anyOf : [];
  const item = alternatives
    .map((alternative) => (isRecord(alternative) ? alternative.items : undefined))
    .find((items) => isRecord(items));
  assert.notEqual(item, undefined, "kinds carries an element schema");
  assert.equal(isRecord(item) ? item.description : undefined, undefined);
});
