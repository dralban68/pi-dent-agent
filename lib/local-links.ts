// Local links (specs/package.md, Section 5): symlinks in node_modules to sibling checkouts,
// declared in the gitignored .local-links file of the package root.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { type Diagnostic, errorMessage, isPlainObject } from "./util.ts";

export const LOCAL_LINKS_FILE = ".local-links";
const LINK_COMMAND = "node scripts/link-local.ts";
const PACKAGE_NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

export interface LocalLink {
  name: string;
  path: string;
}

function namesPackage(path: string, name: string): boolean {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  } catch {
    // Missing, unreadable or not JSON: the caller reports the line as invalid.
    return false;
  }
  return isPlainObject(manifest) && manifest.name === name;
}

/** The links `text` declares; throws the Section 5.1 error message of the first invalid line. */
export function parseLocalLinks(text: string): LocalLink[] {
  const links: LocalLink[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const where = `${LOCAL_LINKS_FILE} line ${index + 1}`;
    const cut = line.indexOf("=");
    const name = cut === -1 ? "" : line.slice(0, cut).trim();
    const path = cut === -1 ? "" : line.slice(cut + 1).trim();
    if (path === "" || !PACKAGE_NAME.test(name)) {
      throw new Error(`${where}: expected <package name>=<absolute path>`);
    }
    if (links.some((link) => link.name === name)) {
      throw new Error(`${where}: duplicate package ${name}`);
    }
    if (!isAbsolute(path)) throw new Error(`${where}: path is not absolute: ${path}`);
    if (!namesPackage(path, name)) {
      throw new Error(`${where}: ${path} is not a directory whose package.json names ${name}`);
    }
    links.push({ name, path });
  }
  return links;
}

/** The links declared in `root`, undefined without a .local-links file; throws when it is invalid. */
export function readLocalLinks(root: string): LocalLink[] | undefined {
  const file = join(root, LOCAL_LINKS_FILE);
  if (!existsSync(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`${LOCAL_LINKS_FILE}: ${errorMessage(error)}`, { cause: error });
  }
  return parseLocalLinks(text);
}

function resolved(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    // Absent or dangling: resolves to nothing, so the link is not in place.
    return undefined;
  }
}

export function linkInPlace(root: string, link: LocalLink): boolean {
  const target = resolved(link.path);
  return target !== undefined && resolved(join(root, "node_modules", link.name)) === target;
}

/** Puts every declared link of `root` in place; returns the lines to print. Throws on an invalid file. */
export function applyLocalLinks(root: string): string[] {
  const lines: string[] = [];
  for (const link of readLocalLinks(root) ?? []) {
    if (linkInPlace(root, link)) {
      lines.push(`already linked ${link.name} -> ${link.path}`);
      continue;
    }
    const at = join(root, "node_modules", link.name);
    rmSync(at, { recursive: true, force: true });
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(link.path, at, "dir");
    lines.push(`linked ${link.name} -> ${link.path}`);
  }
  return lines;
}

/** The load-time check of Section 5.3. */
export function localLinkDiagnostics(root: string): Diagnostic[] {
  let links: LocalLink[];
  try {
    links = readLocalLinks(root) ?? [];
  } catch (error) {
    const message = `local links: ${errorMessage(error)}; correct ${LOCAL_LINKS_FILE}, then run ${LINK_COMMAND}`;
    return [{ level: "warning", message }];
  }
  if (links.length === 0) return [];
  const missing = links.filter((link) => !linkInPlace(root, link));
  if (missing.length === 0) {
    const names = links.map((link) => link.name).join(", ");
    return [{ level: "info", message: `local links in use: ${names}` }];
  }
  return missing.map(({ name, path }) => ({
    level: "warning",
    message: `local link ${name} is not in place: node_modules/${name} does not resolve to ${path}; run ${LINK_COMMAND}`,
  }));
}
