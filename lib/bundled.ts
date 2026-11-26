import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * The fixed implementation-defined set of bundled packages importable by name
 * from Script (specs/script-tool.md#execution-model). They are declared as
 * dependencies (specs/package.md#package-manifest) so scripts can `import` them by
 * name in an install that omits development dependencies; jiti resolves each
 * name to its installed package directory via the `alias` option.
 */
const BUNDLED = [
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
];

/** Documented subpath entries scripts import in addition to the bare names. */
const BUNDLED_SUBPATHS = ["csv-parse/sync", "csv-stringify/sync"];

/**
 * The package root of `name` given the absolute path of one of its entry
 * files: the nearest ancestor directory holding a package.json with a matching
 * name. Resolving `<name>/package.json` directly is not enough — packages whose
 * `exports` map does not export `./package.json` reject that subpath.
 */
function packageRootOf(name: string, entry: string): string | undefined {
  let dir = dirname(entry);
  while (true) {
    try {
      const pkg: { name?: string } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === name) return dir;
    } catch {
      // No package.json at this level; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Package name -> absolute installed package directory, for jiti's `alias`. */
export function bundledAliases(): Record<string, string> {
  const require = createRequire(import.meta.url);
  const aliases: Record<string, string> = {};
  for (const name of BUNDLED) {
    let entry: string;
    try {
      entry = require.resolve(name);
    } catch {
      // A bundled package missing from this install is simply not importable.
      continue;
    }
    const root = packageRootOf(name, entry);
    if (root === undefined) continue;
    const pkg: { main?: string } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    // Packages with `main` resolve from their root. Packages without `main` —
    // ESM-only ones like file-type — do not resolve as a directory, so alias
    // straight to the entry file require.resolve found.
    aliases[name] = pkg.main === undefined ? entry : root;
  }
  // jiti replaces only the bare-name prefix, so a root alias cannot map
  // subpaths; alias each documented subpath to its own resolved entry file.
  for (const subpath of BUNDLED_SUBPATHS) {
    try {
      aliases[subpath] = require.resolve(subpath);
    } catch {
      // Missing subpath: simply not importable from this install.
    }
  }
  return aliases;
}
