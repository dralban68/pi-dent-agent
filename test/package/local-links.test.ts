import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { applyLocalLinks, localLinkDiagnostics } from "../../lib/local-links.ts";

/** Local links of specs/package.md#local-links, each in a temporary package root. */

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN = "node scripts/link-local.ts";

/** A temporary directory holding a package root `root` and sibling checkouts. */
function sandbox(t: TestContext): {
  root: string;
  checkout: (name: string, dir?: string) => string;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-dent-local-links-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "root");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  return {
    root,
    checkout: (name, dir = name.replace("/", "+")) => {
      const path = join(base, "src", dir);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "package.json"), JSON.stringify({ name }));
      return path;
    },
  };
}

/** An installed copy of `name` under the root's node_modules. */
function install(root: string, name: string): string {
  const at = join(root, "node_modules", name);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  return at;
}

function declare(root: string, text: string): void {
  writeFileSync(join(root, ".local-links"), text);
}

test("without .local-links nothing is linked and nothing is reported", (t) => {
  const { root } = sandbox(t);
  const installed = install(root, "one");
  assert.deepEqual(applyLocalLinks(root), []);
  assert.deepEqual(localLinkDiagnostics(root), []);
  assert.equal(lstatSync(installed).isSymbolicLink(), false);
});

test("a file of blank and comment lines declares nothing", (t) => {
  const { root } = sandbox(t);
  declare(root, "\n  # one=/nowhere\n\r\n");
  assert.deepEqual(applyLocalLinks(root), []);
  assert.deepEqual(localLinkDiagnostics(root), []);
});

test("each declared package is replaced by a link to its checkout, and a second run changes nothing", (t) => {
  const { root, checkout } = sandbox(t);
  const one = checkout("one", "has=sign");
  const scoped = checkout("@scope/two");
  install(root, "one");
  declare(root, `# siblings\n\n  one = ${one}  \r\n@scope/two=${scoped}\n`);

  assert.deepEqual(applyLocalLinks(root), [
    `linked one -> ${one}`,
    `linked @scope/two -> ${scoped}`,
  ]);
  assert.equal(lstatSync(join(root, "node_modules", "one")).isSymbolicLink(), true);
  assert.equal(realpathSync(join(root, "node_modules", "one")), one);
  assert.equal(realpathSync(join(root, "node_modules", "@scope", "two")), scoped);

  assert.deepEqual(applyLocalLinks(root), [
    `already linked one -> ${one}`,
    `already linked @scope/two -> ${scoped}`,
  ]);
});

test("a link pointing elsewhere is replaced without touching its old target", (t) => {
  const { root, checkout } = sandbox(t);
  const one = checkout("one");
  const old = checkout("one", "old");
  declare(root, `one=${old}\n`);
  applyLocalLinks(root);
  declare(root, `one=${one}\n`);
  assert.deepEqual(applyLocalLinks(root), [`linked one -> ${one}`]);
  assert.equal(realpathSync(join(root, "node_modules", "one")), one);
  assert.ok(existsSync(join(old, "package.json")));
});

test("an invalid file is refused with the line's error and no link is made", (t) => {
  const { root, checkout } = sandbox(t);
  const one = checkout("one");
  const other = checkout("other");
  const missing = join(root, "missing");
  const cases: [string, string][] = [
    ["one", ".local-links line 3: expected <package name>=<absolute path>"],
    ["one=", ".local-links line 3: expected <package name>=<absolute path>"],
    [`=${one}`, ".local-links line 3: expected <package name>=<absolute path>"],
    [`../one=${one}`, ".local-links line 3: expected <package name>=<absolute path>"],
    [`one=${one}`, ".local-links line 3: duplicate package one"],
    ["other=../other", ".local-links line 3: path is not absolute: ../other"],
    [
      `other=${missing}`,
      `.local-links line 3: ${missing} is not a directory whose package.json names other`,
    ],
    [
      `another=${other}`,
      `.local-links line 3: ${other} is not a directory whose package.json names another`,
    ],
  ];
  const installed = install(root, "one");
  for (const [line, message] of cases) {
    declare(root, `# first\none=${one}\n${line}\n`);
    assert.throws(() => applyLocalLinks(root), { message }, line);
    assert.equal(lstatSync(installed).isSymbolicLink(), false, line);
    assert.deepEqual(
      localLinkDiagnostics(root),
      [
        {
          level: "warning",
          message: `local links: ${message}; correct .local-links, then run ${RUN}`,
        },
      ],
      line,
    );
  }
});

test("the load-time check warns once per link not in place, and lists the links when all are", (t) => {
  const { root, checkout } = sandbox(t);
  const one = checkout("one");
  const two = checkout("two");
  const three = checkout("@scope/three");
  install(root, "one");
  declare(root, `one=${one}\ntwo=${two}\n@scope/three=${three}\n`);
  const notInPlace = (name: string, path: string) => ({
    level: "warning",
    message: `local link ${name} is not in place: node_modules/${name} does not resolve to ${path}; run ${RUN}`,
  });

  assert.deepEqual(localLinkDiagnostics(root), [
    notInPlace("one", one),
    notInPlace("two", two),
    notInPlace("@scope/three", three),
  ]);
  assert.equal(lstatSync(join(root, "node_modules", "one")).isSymbolicLink(), false);

  applyLocalLinks(root);
  assert.deepEqual(localLinkDiagnostics(root), [
    { level: "info", message: "local links in use: one, two, @scope/three" },
  ]);

  // What `pnpm add` does: the link is back to an installed copy.
  rmSync(join(root, "node_modules", "two"));
  install(root, "two");
  assert.deepEqual(localLinkDiagnostics(root), [notInPlace("two", two)]);
});

test("the script prints one line per link, and fails with status 1 on an invalid file", (t) => {
  const { root, checkout } = sandbox(t);
  // The script acts on the package root that holds it: run a copy, never the repository's.
  cpSync(join(repo, "lib"), join(root, "lib"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  cpSync(join(repo, "scripts", "link-local.ts"), join(root, "scripts", "link-local.ts"));
  const run = () =>
    spawnSync(process.execPath, [join(root, "scripts", "link-local.ts")], {
      cwd: tmpdir(),
      encoding: "utf8",
    });

  const absent = run();
  assert.deepEqual([absent.status, absent.stdout, absent.stderr], [0, "", ""]);

  const one = checkout("one");
  declare(root, `one=${one}\n`);
  const linked = run();
  assert.deepEqual(
    [linked.status, linked.stdout, linked.stderr],
    [0, `linked one -> ${one}\n`, ""],
  );
  assert.equal(realpathSync(join(root, "node_modules", "one")), one);
  assert.equal(run().stdout, `already linked one -> ${one}\n`);

  declare(root, "one\n");
  const invalid = run();
  assert.deepEqual(
    [invalid.status, invalid.stdout, invalid.stderr],
    [1, "", "link-local: .local-links line 1: expected <package name>=<absolute path>\n"],
  );
});

test("the repository runs the script on prepare and ignores .local-links", () => {
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(manifest.scripts.prepare, RUN);
  assert.ok(readFileSync(join(repo, ".gitignore"), "utf8").split("\n").includes(".local-links"));
});
