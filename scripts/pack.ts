// Packs pi-dent-agent for npm with its bundled extensions (specs/package.md#package-manifest): every
// pi.extensions entry under ./node_modules/<name>/ is put in bundleDependencies and installed into
// the package, with the native builds of every platform. Prints the tarball path.
// Usage: node scripts/pack.ts [destination directory]
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
/** Optional dependencies left out: recheck falls back to its JavaScript build without them. */
const DROPPED_OPTIONAL = new Set(["recheck"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error(`${path}: not a JSON object`);
  return value;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
  return out;
}

async function sh(cwd: string, file: string, args: string[]): Promise<string> {
  const { stdout } = await run(file, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Every package directory under `modules`, scoped ones included. */
function packageDirs(modules: string): string[] {
  if (!existsSync(modules)) return [];
  const dirs: string[] = [];
  for (const name of readdirSync(modules)) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const sub of readdirSync(join(modules, name))) dirs.push(join(modules, name, sub));
    } else dirs.push(join(modules, name));
  }
  return dirs;
}

const root = resolve(import.meta.dirname, "..");
const destination = resolve(process.argv[2] ?? root);
const work = mkdtempSync(join(tmpdir(), "pi-dent-pack-"));
try {
  const packed = await sh(root, "pnpm", ["pack", "--pack-destination", work]);
  const tarball = packed.split("\n").at(-1) ?? "";
  await sh(work, "tar", ["-xzf", tarball]);
  const stage = join(work, "package");
  const manifestPath = join(stage, "package.json");
  const manifest = readJson(manifestPath);
  const pi = isRecord(manifest.pi) ? manifest.pi : {};
  const entries = Array.isArray(pi.extensions) ? pi.extensions : [];
  const bundled: string[] = [];
  for (const entry of entries) {
    const match =
      typeof entry === "string" ? /^\.\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(entry) : null;
    if (match?.[1] !== undefined) bundled.push(match[1]);
  }
  delete manifest.devDependencies;
  // `prepare` runs scripts/link-local.ts, which is not packed: `npm pack` below would fail on it.
  if (isRecord(manifest.scripts)) delete manifest.scripts.prepare;
  manifest.bundleDependencies = bundled;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await sh(stage, "npm", [
    "install",
    "--omit=dev",
    "--legacy-peer-deps",
    "--ignore-scripts",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
  ]);

  // npm installs only this platform's optional builds; the published package runs on every platform.
  const modules = join(stage, "node_modules");
  const fetchDir = join(work, "optional");
  mkdirSync(fetchDir);
  for (const dir of packageDirs(modules)) {
    // An optional dependency removed below is still in this list.
    if (!existsSync(join(dir, "package.json"))) continue;
    const pkg = readJson(join(dir, "package.json"));
    const optional = stringRecord(pkg.optionalDependencies);
    const name = typeof pkg.name === "string" ? pkg.name : "";
    for (const [dep, range] of Object.entries(optional)) {
      const target = join(modules, dep);
      if (DROPPED_OPTIONAL.has(name)) {
        rmSync(target, { recursive: true, force: true });
        continue;
      }
      if (existsSync(target)) continue;
      const file = await sh(fetchDir, "npm", ["pack", `${dep}@${range}`, "--silent"]);
      mkdirSync(target, { recursive: true });
      await sh(fetchDir, "tar", ["-xzf", file, "-C", target, "--strip-components=1"]);
    }
  }

  mkdirSync(destination, { recursive: true });
  const out = await sh(stage, "npm", ["pack", "--pack-destination", destination, "--silent"]);
  process.stdout.write(`${join(destination, out.split("\n").at(-1) ?? "")}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
