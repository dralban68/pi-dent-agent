import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Package manifest of specs/package.md Sections 1 and 2: the declared entry
 * list resolves to existing files, and each bundled extension is a dependency.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  pi: { extensions: string[] };
};

const HOST_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

/** specs/package.md Section 2: the entry list, in order. */
const SECTION_2_ENTRIES = [
  "./index.ts",
  "./node_modules/pi-dent-purse/index.ts",
  "./node_modules/pi-dent-terms/index.ts",
  "./node_modules/pi-dent-web/index.ts",
  "./node_modules/pi-mcp-adapter/index.ts",
  "./node_modules/pi-anthropic-oauth/src/index.ts",
  "./node_modules/pi-web-access/dist/index.js",
];

test("the package is pi-dent and declares exactly the Section 2 entries, in order, each resolving on disk", () => {
  assert.equal(manifest.name, "pi-dent-agent");
  assert.deepEqual(manifest.pi.extensions, SECTION_2_ENTRIES);
  for (const entry of manifest.pi.extensions) {
    assert.ok(existsSync(join(root, entry)), `${entry} does not resolve`);
  }
});

test("every bundled extension is a dependency reached under node_modules", () => {
  const bundled = manifest.pi.extensions.filter((entry) => entry !== "./index.ts");
  assert.ok(bundled.length > 0);
  for (const entry of bundled) {
    const name = dependencyName(entry);
    assert.ok(name in manifest.dependencies, `${name} is not a dependency`);
    assert.ok(entry.startsWith(`./node_modules/${name}/`), `${entry} is not under ${name}`);
  }
});

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

test("each bundled extension dependency is an exact version", () => {
  const bundled = manifest.pi.extensions.filter((entry) => entry !== "./index.ts");
  assert.ok(bundled.length > 0);
  for (const entry of bundled) {
    const name = dependencyName(entry);
    const spec = manifest.dependencies[name];
    assert.equal(typeof spec, "string", `${name} has a dependency spec`);
    const value = String(spec);
    assert.ok(EXACT_VERSION.test(value), `${name}: "${value}" is not an exact version`);
  }
});

test("a bundled library is a dependency with no pi.extensions entry", () => {
  assert.equal(typeof manifest.dependencies["pi-dent-markdown"], "string");
  assert.equal(
    manifest.pi.extensions.some((entry) => entry.includes("pi-dent-markdown")),
    false,
    "pi-dent-markdown has a pi.extensions entry",
  );
});

test("host packages are peers, never dependencies", () => {
  for (const name of HOST_PACKAGES) {
    assert.equal(manifest.dependencies[name], undefined, `${name} is a dependency`);
    assert.equal(manifest.peerDependencies[name], "*", `${name} is not a peer`);
  }
});

/** The packages Script imports by name (specs/script-tool.md Section 3), plus its loader. */
const SCRIPT_PACKAGES = [
  "cheerio",
  "csv-parse",
  "csv-stringify",
  "fast-xml-parser",
  "file-type",
  "glob",
  "gray-matter",
  "ini",
  "js-yaml",
  "jsonc-parser",
  "jszip",
  "semver",
  "smol-toml",
  "jiti",
];

test("Script's bundled packages and jiti are dependencies, never development dependencies", () => {
  // The host installs the package with its development dependencies omitted
  // (package.md Section 1), so each of these must survive an install.
  for (const name of SCRIPT_PACKAGES) {
    assert.equal(typeof manifest.dependencies[name], "string", `${name} is not a dependency`);
    assert.equal(manifest.devDependencies[name], undefined, `${name} is a devDependency`);
  }
});

/** The package name an entry path under node_modules belongs to. */
function dependencyName(entry: string): string {
  const segments = entry.split("/");
  assert.equal(segments[1], "node_modules");
  const [first = "", second = ""] = segments.slice(2);
  return first.startsWith("@") ? `${first}/${second}` : first;
}
