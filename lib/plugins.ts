import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  isDirectory,
  isRegularFile,
  isValidName,
  markdownFileNames,
  parseMarkdown,
  unknownFrontmatterKeys,
} from "./catalogs.ts";
import { attributeKey, type BootConfig, mergedObject, unknownKeysMessage } from "./config.ts";
import { type Diagnostic, errorCode, errorMessage, isPlainObject } from "./util.ts";

/**
 * Plugin discovery, catalog, and argument substitution per specs/plugin.md and
 * specs/plugin-tool.md: configuration-driven discovery from `pi-dent.conf`,
 * manifest validation with skip-and-report rules, namespace identity dedupe, the
 * boot-snapshot catalog of admitted plugins by namespace, command enumeration,
 * and argument tokenization with single-pass argument substitution.
 */

export interface PluginCommand {
  /** Basename of the `commands/*.md` resource without the `.md` extension. */
  name: string;
  description?: string | undefined;
  /** Absolute resource path; the body is read fresh at invocation. */
  file: string;
}

export interface PluginEntry {
  /** The manifest `name`: the plugin identity and `Plugin` tool namespace (plugin.md Section 3). */
  name: string;
  /** Absolute plugin directory (the manifest's parent). */
  root: string;
  commands: PluginCommand[];
  /** The normalized root `context.md` text (plugin.md Section 10); undefined when there is none. */
  context?: string | undefined;
}

export interface PluginCatalog {
  /** Admitted plugins in discovery order. */
  plugins: PluginEntry[];
  /** Namespace -> first admitted plugin (shared namespaces route here). */
  byNamespace: Map<string, PluginEntry>;
}

function skip(diagnostics: Diagnostic[], dir: string, reason: string): void {
  diagnostics.push({ level: "warning", message: `plugins: ${dir}: skipped (${reason})` });
}

const MANIFEST_KEYS = ["name", "description", "version", "author"];

/** The plugin manifest fields of an admitted plugin (plugin.md Section 2), raw: the inventory shapes them. */
export interface PluginManifest {
  name: string;
  /** The manifest `description` verbatim, whatever its type; kept when it is a string. */
  description?: unknown;
  version?: unknown;
  author?: unknown;
}

function readManifest(dir: string, diagnostics: Diagnostic[]): PluginManifest | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, "plugin.json"), "utf8");
  } catch (error) {
    const code = errorCode(error);
    skip(diagnostics, dir, `plugin.json unreadable: ${code ?? String(error)}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    skip(diagnostics, dir, `plugin.json failed to parse: ${errorMessage(error)}`);
    return undefined;
  }
  if (!isPlainObject(parsed)) {
    skip(diagnostics, dir, "plugin.json is not an object");
    return undefined;
  }
  const unknown = Object.keys(parsed).filter((key) => !MANIFEST_KEYS.includes(key));
  if (unknown.length > 0) {
    diagnostics.push({
      level: "warning",
      message: `plugins: ${join(dir, "plugin.json")}: unknown manifest keys ${unknown.join(", ")} ignored`,
    });
  }
  if (isPlainObject(parsed.author)) {
    const unknownAuthor = Object.keys(parsed.author).filter(
      (key) => key !== "name" && key !== "email",
    );
    if (unknownAuthor.length > 0) {
      diagnostics.push({
        level: "warning",
        message: `plugins: ${join(dir, "plugin.json")}: unknown author keys ${unknownAuthor.join(", ")} ignored`,
      });
    }
  }
  if (!isValidName(parsed.name)) {
    skip(diagnostics, dir, "plugin.json lacks a valid name");
    return undefined;
  }
  return {
    name: parsed.name,
    description: parsed.description,
    version: parsed.version,
    author: parsed.author,
  };
}

function enumerateCommands(root: string, diagnostics: Diagnostic[]): PluginCommand[] {
  const dir = join(root, "commands");
  const commands: PluginCommand[] = [];
  // Only the directory read reports: a command file that cannot be read at boot is still
  // registered, without a description and without a diagnostic (plugin.md Section 5).
  for (const name of markdownFileNames(dir, diagnostics, "commands", "keep")) {
    const cmdName = name.replace(/\.md$/, "");
    if (!isValidName(cmdName)) continue;
    const resolved = resolvePluginResourcePath(root, `commands/${name}`);
    // A name whose own stat failed is still a command; its body read fails at invocation.
    const file = "error" in resolved ? unreadableTarget(root, join(dir, name)) : resolved.path;
    if (file === undefined) continue;
    let description: string | undefined;
    try {
      const { frontmatter } = parseMarkdown(
        readFileSync(file, "utf8"),
        file,
        diagnostics,
        "commands",
      );
      const unknown = unknownFrontmatterKeys(frontmatter, ["description"]);
      if (unknown.length > 0) {
        diagnostics.push({
          level: "warning",
          message: `commands: ${unknownKeysMessage("frontmatter", unknown, () => file)}`,
        });
      }
      if (typeof frontmatter.description === "string") description = frontmatter.description;
    } catch {
      // Unreadable or malformed frontmatter: the body is read fresh (and
      // validated) at invocation; the command is still registered.
    }
    commands.push({ name: cmdName, description, file });
  }
  return commands;
}

/**
 * The path of a command file that cannot be resolved because its own stat fails with a
 * code other than absence (plugin.md Section 5), else undefined: such a command is
 * registered, and one that is not a contained path is skipped.
 */
function unreadableTarget(root: string, file: string): string | undefined {
  try {
    statSync(file);
    return undefined;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
  }
  return leadsInside(root, file) ? file : undefined;
}

/**
 * Whether `file`, which cannot be resolved, leads inside `root`: its link text is followed
 * while it can be read, and the result is judged from the real path of its deepest ancestor
 * that resolves, with the segments below re-appended.
 */
function leadsInside(root: string, file: string): boolean {
  let target = file;
  for (let depth = 0; depth < 40; depth++) {
    let link: string;
    try {
      link = readlinkSync(target);
    } catch {
      // Not a link, or not readable: `target` is as far as the text leads.
      break;
    }
    target = resolve(dirname(target), link);
  }
  let rest: string[] = [];
  let base = target;
  for (;;) {
    let real: string | undefined;
    try {
      real = realpathSync(base);
    } catch {
      // This ancestor does not resolve; the one above it decides.
      real = undefined;
    }
    if (real !== undefined) {
      let rootReal: string;
      try {
        rootReal = realpathSync(root);
      } catch {
        // A root that does not resolve contains nothing.
        return false;
      }
      const full = rest.length === 0 ? real : join(real, ...rest);
      return full === rootReal || full.startsWith(rootReal + sep);
    }
    const parent = dirname(base);
    if (parent === base) return false;
    rest = [basename(base), ...rest];
    base = parent;
  }
}

const CONTEXT_FILE = "context.md";

/**
 * The plugin context of one admitted plugin (plugin.md Section 10): the root `context.md`
 * text, or undefined when the file is absent or skipped with one diagnostic.
 */
function readPluginContext(root: string, diagnostics: Diagnostic[]): string | undefined {
  const file = join(root, CONTEXT_FILE);
  const skipContext = (reason: string): undefined => {
    diagnostics.push({
      level: "warning",
      message: `plugins: ${file}: context skipped (${reason})`,
    });
    return;
  };
  const resolved = resolveContainedPath(root, CONTEXT_FILE);
  if ("error" in resolved) return skipContext(resolved.error);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(resolved.path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    return skipContext(`unreadable: ${errorMessage(error)}`);
  }
  let text: string;
  try {
    // A leading byte-order mark is dropped by the decoder (skill.md Section 2).
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return skipContext("not valid UTF-8");
  }
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized === "") return skipContext("empty");
  return normalized;
}

/**
 * Append each admitted plugin's context block, in the order given (plugin.md Section 10):
 * one block per plugin with a context, each preceded by a blank line.
 */
export function appendPluginContext(prompt: string, plugins: readonly PluginEntry[]): string {
  let out = prompt;
  for (const plugin of plugins) {
    if (plugin.context === undefined) continue;
    out += `\n\n<plugin_context plugin="${plugin.name}">\n${plugin.context}\n</plugin_context>`;
  }
  return out;
}

/** One plugin candidate (plugin.md Section 11): a merged `plugins` entry and what discovery made of it. */
export interface PluginCandidate {
  /** The entry key. */
  key: string;
  /** The owning layer's file path for `plugins.<key>.path` (config-file.md Section 4). */
  configFile: string;
  /** The absolute path the entry's `path` resolves to (plugin.md Section 4); null when malformed or remote. */
  resolvedRoot: string | null;
  /** The admitted plugin; undefined when the candidate was skipped. */
  plugin?: PluginEntry;
  /** The admitted plugin's manifest (plugin.md Section 2); undefined when skipped. */
  manifest?: PluginManifest;
  /** This candidate's diagnostics, in production order (plugin.md Sections 2-5 and 10). */
  diagnostics: Diagnostic[];
}

/** Plugin discovery with the diagnostics grouped per candidate (plugin.md Section 11). */
export interface PluginDiscovery {
  catalog: PluginCatalog;
  /** One candidate per merged `plugins` entry, in lexicographic key order; empty without an object value. */
  candidates: PluginCandidate[];
  /** Diagnostics belonging to no candidate (a non-object `plugins` value). */
  diagnostics: Diagnostic[];
}

/** Discover configured plugins per candidate, keeping each candidate's diagnostics apart. */
export function discoverPluginCandidates(config: BootConfig): PluginDiscovery {
  const plugins: PluginEntry[] = [];
  const byNamespace = new Map<string, PluginEntry>();
  const candidates: PluginCandidate[] = [];
  if (!("plugins" in config.merged) || config.merged.plugins === undefined) {
    return { catalog: { plugins, byNamespace }, candidates, diagnostics: [] };
  }
  const configured = mergedObject(config, "plugins");
  if (!configured) {
    return {
      catalog: { plugins, byNamespace },
      candidates,
      diagnostics: [
        {
          level: "warning",
          message: `plugins: ${attributeKey(config, ["plugins"])}: skipped ("plugins" must be an object)`,
        },
      ],
    };
  }
  for (const key of Object.keys(configured).toSorted()) {
    const value = configured[key];
    const owningFile = attributeKey(config, ["plugins", key, "path"]);
    const candidate: PluginCandidate = {
      key,
      configFile: owningFile,
      resolvedRoot: null,
      diagnostics: [],
    };
    candidates.push(candidate);
    const rawPath = isPlainObject(value) && typeof value.path === "string" ? value.path.trim() : "";
    if (rawPath === "") {
      skip(
        candidate.diagnostics,
        `${owningFile}#plugins.${key}`,
        'malformed value; expected { "path": string }',
      );
      continue;
    }
    const unknown = isPlainObject(value) ? Object.keys(value).filter((k) => k !== "path") : [];
    if (unknown.length > 0) {
      candidate.diagnostics.push({
        level: "warning",
        message: `plugins: ${unknownKeysMessage(`plugins.${key}`, unknown, (field) => attributeKey(config, ["plugins", key, field]))}`,
      });
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rawPath)) {
      skip(
        candidate.diagnostics,
        `${owningFile}#plugins.${key}`,
        `remote or URL source is not supported: ${rawPath}`,
      );
      continue;
    }
    // A relative path resolves against the owning layer directory: the directory of
    // the file that declares plugins.<key>.path (plugin.md Section 4).
    const dir = isAbsolute(rawPath) ? resolve(rawPath) : resolve(dirname(owningFile), rawPath);
    candidate.resolvedRoot = dir;
    if (!isDirectory(dir)) {
      skip(
        candidate.diagnostics,
        dir,
        `configured in ${owningFile}#plugins.${key}: not a directory`,
      );
      continue;
    }
    const manifest = readManifest(dir, candidate.diagnostics);
    if (!manifest) continue;
    const admitted = byNamespace.get(manifest.name);
    if (admitted) {
      skip(
        candidate.diagnostics,
        dir,
        `namespace "${manifest.name}" already admitted from ${admitted.root}`,
      );
      continue;
    }
    const entry: PluginEntry = {
      name: manifest.name,
      root: dir,
      commands: enumerateCommands(dir, candidate.diagnostics),
      context: readPluginContext(dir, candidate.diagnostics),
    };
    candidate.plugin = entry;
    candidate.manifest = manifest;
    plugins.push(entry);
    byNamespace.set(manifest.name, entry);
  }
  return { catalog: { plugins, byNamespace }, candidates, diagnostics: [] };
}

/**
 * Discover configured plugins in lexicographic key order and build the boot-snapshot plugin
 * catalog: the per-candidate discovery flattened, candidate by candidate, into `diagnostics`.
 */
export function discoverPlugins(config: BootConfig, diagnostics: Diagnostic[]): PluginCatalog {
  const result = discoverPluginCandidates(config);
  diagnostics.push(...result.diagnostics);
  for (const candidate of result.candidates) diagnostics.push(...candidate.diagnostics);
  return result.catalog;
}

/**
 * Tokenize a command argument string: its maximal runs of non-whitespace
 * characters, with no quoting and no escapes (plugin.md Section 6).
 */
export function tokenizeArgs(args: string): string[] {
  return args.split(/\s+/).filter((token) => token !== "");
}

const ARGUMENTS_TOKEN = "$ARGUMENTS";
const DIGITS = /[1-9]\d*/y;

/**
 * Substitute argument tokens in one pass over the body (plugin.md Section 6):
 * `$ARGUMENTS` expands to the full args string, `$N` to the Nth 1-based token
 * (digits greedy, missing indices empty); `$0` and every other `$` sequence
 * stay literal. Inserted values are never re-scanned.
 */
export function substituteArgs(body: string, args: string): string {
  const tokens = tokenizeArgs(args);
  let out = "";
  let i = 0;
  while (i < body.length) {
    const c = body.charAt(i);
    if (c !== "$") {
      out += c;
      i++;
      continue;
    }
    if (body.startsWith(ARGUMENTS_TOKEN, i)) {
      out += args;
      i += ARGUMENTS_TOKEN.length;
      continue;
    }
    DIGITS.lastIndex = i + 1;
    const digits = DIGITS.exec(body);
    if (digits) {
      out += tokens[Number.parseInt(digits[0], 10) - 1] ?? "";
      i += 1 + digits[0].length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const RESOURCE_ROOTS = new Set(["commands", "agents", "skills"]);
const SCRIPT_EXTENSION = /\.(js|ts|mjs|mts|cjs|cts)$/;

function isValidResourceShape(segments: readonly string[]): boolean {
  const root = segments[0];
  if (root === "commands" || root === "agents") {
    const name = segments[1];
    return segments.length === 2 && name !== undefined && name.endsWith(".md") && name !== ".md";
  }
  if (root === "skills") {
    if (segments.length === 3 && segments[2] === "SKILL.md") return true;
    // references/**: Markdown only (plugin.md Section 1), at any depth.
    if (segments.length < 4 || segments[2] !== "references") return false;
    const last = segments[segments.length - 1];
    if (last === undefined) return false;
    return last.endsWith(".md") && last !== ".md";
  }
  return false;
}

function isValidScriptShape(segments: readonly string[]): boolean {
  const last = segments.at(-1);
  return (
    segments.length >= 2 &&
    segments[0] === "scripts" &&
    last !== undefined &&
    SCRIPT_EXTENSION.test(last)
  );
}

/**
 * Lexical part of the contained-path rule (plugin.md Section 7): reject an
 * absolute or drive-prefixed path, and a `..` segment (`\` treated as `/`).
 */
export function relativeSegments(path: string): { segments: string[] } | { error: string } {
  // `\` is treated as `/` before any test, so `\foo` and `\\server\share` are absolute too.
  const slashed = path.replace(/\\/g, "/");
  if (path.trim() === "" || slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) {
    return { error: `path must be relative; received ${JSON.stringify(path)}` };
  }
  const segments = slashed.split("/");
  if (segments.includes("..")) {
    return { error: `path must not contain a ".." segment; received ${JSON.stringify(path)}` };
  }
  return { segments };
}

/**
 * The shared contained-path check (plugin.md Section 7) for plugin resources,
 * plugin scripts, and skill references: the path is lexically contained under
 * `root`, and its resolution (symlinks followed) stays inside `root`. An
 * existing target must be a regular file; a missing target resolves to its
 * lexical path so the caller can report it as missing.
 */
export function resolveContainedPath(
  root: string,
  path: string,
): { path: string } | { error: string } {
  const split = relativeSegments(path);
  if ("error" in split) return split;
  return resolveContainedFile(root, split.segments, path);
}

/**
 * The real path of `candidate`'s deepest existing ancestor, with the segments below it
 * re-appended: a dangling link is judged by where it actually leads, not by its text.
 */
function realExistingAncestor(candidate: string): { path: string } | { error: string } {
  let rest: string[] = [];
  let base = candidate;
  for (let depth = 0; depth < 40; depth++) {
    try {
      const real = realpathSync(base);
      return { path: rest.length === 0 ? real : join(real, ...rest) };
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT") return { error: code ?? String(error) };
      const parent = dirname(base);
      if (parent === base) return { error: code };
      rest = [basename(base), ...rest];
      base = parent;
    }
  }
  return { error: "too many symbolic links" };
}

/**
 * Walk `segments` under `root` with per-segment symlink containment: the
 * resolved target must stay inside the root (realpath-checked), and
 * the final segment must name a regular file. A missing final segment is
 * reported as a resolvable path (the caller decides missing-resource).
 */
function resolveContainedFile(
  root: string,
  segments: readonly string[],
  path: string,
): { path: string } | { error: string } {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { error: `root ${root} is not readable` };
  }
  const withinRoot = (candidate: string): boolean =>
    candidate === rootReal || candidate.startsWith(rootReal + sep);

  const resolved = resolve(root, ...segments);
  let current = rootReal;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i] ?? "");
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return { path: resolved };
      return { error: `cannot resolve ${resolved}: ${code ?? String(error)}` };
    }
    if (stat.isSymbolicLink()) {
      try {
        current = realpathSync(current);
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT") {
          let hop = current;
          for (let depth = 0; depth < 40; depth++) {
            // The hop's real ancestor decides containment: a link through a directory link
            // outside the root is not contained, dangling or not.
            const real = realExistingAncestor(hop);
            if ("error" in real) return { error: `cannot resolve ${resolved}: ${real.error}` };
            if (!withinRoot(real.path)) {
              return { error: `path escapes its root; received ${JSON.stringify(path)}` };
            }
            let linkTarget: string;
            try {
              linkTarget = readlinkSync(hop);
            } catch {
              break;
            }
            hop = resolve(dirname(hop), linkTarget);
          }
          return { path: resolved };
        }
        return { error: `cannot resolve ${resolved}: ${code ?? String(error)}` };
      }
      if (!withinRoot(current)) {
        return { error: `path escapes its root; received ${JSON.stringify(path)}` };
      }
    }
    if (i === segments.length - 1 && !isRegularFile(current)) {
      return { error: `path must name a regular file; received ${JSON.stringify(path)}` };
    }
  }
  return { path: current };
}

/**
 * Execution-time path validation (plugin-tool.md Section 2, plugin.md
 * Sections 1 and 7): the path must be a contained path of the plugin root
 * and match the `commands/*.md`, `agents/*.md`, `skills/<name>/SKILL.md`, or
 * `skills/<name>/references/**` shapes.
 */
export function resolvePluginResourcePath(
  root: string,
  path: string,
): { path: string } | { error: string } {
  const split = relativeSegments(path);
  if ("error" in split) return split;
  const { segments } = split;
  if (!RESOURCE_ROOTS.has(segments[0] ?? "")) {
    return {
      error: `path must start with commands, agents, or skills; received ${JSON.stringify(path)}`,
    };
  }
  if (segments.includes("") || segments.includes(".") || !isValidResourceShape(segments)) {
    return {
      error: `path must match commands/*.md, agents/*.md, skills/<name>/SKILL.md, or skills/<name>/references/**/*.md; received ${JSON.stringify(path)}`,
    };
  }
  return resolveContainedFile(root, segments, path);
}

/**
 * Execution-time path validation for plugin scripts (script-tool.md
 * Section 2, plugin.md Sections 1 and 7): the path must be a contained path of
 * the plugin root and match the scripts glob shape (any depth under scripts/,
 * ending in a JS/TS extension).
 */
export function resolvePluginScriptPath(
  root: string,
  path: string,
): { path: string } | { error: string } {
  const split = relativeSegments(path);
  if ("error" in split) return split;
  const { segments } = split;
  if (segments[0] !== "scripts") {
    return { error: `path must start with scripts; received ${JSON.stringify(path)}` };
  }
  if (segments.includes("") || segments.includes(".") || !isValidScriptShape(segments)) {
    return {
      error: `path must match scripts/**/*.{js,ts,mjs,mts,cjs,cts}; received ${JSON.stringify(path)}`,
    };
  }
  return resolveContainedFile(root, segments, path);
}

/** Read a command body fresh (re-validating containment) and apply invocation arguments (Section 5). */
export function renderPluginCommand(root: string, commandName: string, args: string): string {
  const resolved = resolvePluginResourcePath(root, `commands/${commandName}.md`);
  if ("error" in resolved) throw new Error(resolved.error);
  // The host parser drops the byte-order mark and normalises line endings; the trim
  // completes the skill.md Section 2 normalisation when no frontmatter block closes.
  const text = readFileSync(resolved.path, "utf8");
  const { body } = parseMarkdown(text, resolved.path, undefined, "commands");
  const normalized = body.trim();
  return substituteArgs(normalized, args.trim());
}
