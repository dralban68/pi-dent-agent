import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { BootConfig } from "./config.ts";
import { attributeKey, configLayerPaths, unknownKeysMessage } from "./config.ts";
import { type Diagnostic, errorCode, errorMessage, isPlainObject } from "./util.ts";

/**
 * Agent definition and skill discovery per specs/agent.md and specs/skill.md:
 * two-directory flat `*.md` agent scans and `<name>/SKILL.md` skill scans in
 * lexicographic order, project shadowing global, skip/warning rules,
 * boot-snapshot catalogs, and the `agents` configuration override. It also holds
 * the Markdown resource read shared with plugin command discovery (lib/plugins.ts).
 */

export interface AgentDefinition {
  name: string;
  description?: string | undefined;
  model?: string | undefined;
  /** System prompt (Markdown body, after the agents override). */
  prompt: string;
  source: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  body: string;
  source: string;
  /** The skill's `references/` directory, when the skill has one (specs/skill-tool.md#execution-contract). */
  referencesDir?: string | undefined;
}

export function isValidName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name !== "" &&
    !/\s/.test(name) &&
    !name.includes(":") &&
    !name.includes("/")
  );
}

/** A resource kind, as the prefix of its diagnostics: agent definitions, skills, and plugin commands. */
export type MarkdownKind = "agents" | "skills" | "commands";

export interface RawMarkdown {
  file: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/** One skip line for a malformed or unreadable Markdown resource (specs/agent.md#definition-files). */
function reportMarkdownSkip(
  diagnostics: Diagnostic[] | undefined,
  kind: MarkdownKind | undefined,
  file: string,
  reason: string,
): void {
  if (!diagnostics) return;
  diagnostics.push({
    level: "warning",
    message: `${kind ?? "agents"}: ${file}: skipped (${reason})`,
  });
}

/**
 * One report line for a discovery path whose stat or directory read failed with an error
 * other than absence: the directory, file, or symlink target is lost and says so
 * (specs/skill.md#skill-files, specs/agent.md#definition-files).
 */
function reportMarkdownUnreadable(
  diagnostics: Diagnostic[] | undefined,
  kind: MarkdownKind | undefined,
  path: string,
  error: unknown,
): void {
  if (!diagnostics) return;
  diagnostics.push({
    level: "warning",
    message: `${kind ?? "agents"}: ${path}: unreadable: ${errorCode(error) ?? errorMessage(error)}`,
  });
}

/**
 * A path that does not exist is absent: discovery of an absent folder or file is silent
 * (specs/config-file.md#layers). Every other stat or directory-read failure is reported.
 */
function isAbsentPath(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** A leading byte-order mark removed and line endings normalised to `\n` (specs/skill.md#content-rules). */
function normalizeMarkdown(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/**
 * The frontmatter block and the body after it, with the delimiters checked on whole lines
 * (specs/skill.md#skill-files): opened by a first line `---` and closed by the next line `---`. A
 * file without that pair has no frontmatter, and the whole text is its body.
 */
function delimitFrontmatter(text: string): { block: string; body: string } {
  const normalized = normalizeMarkdown(text);
  const lines = normalized.split("\n");
  if (lines[0] !== "---") return { block: "", body: normalized };
  const close = lines.findIndex((line, index) => index > 0 && line === "---");
  if (close === -1) return { block: "", body: normalized };
  return {
    block: lines.slice(0, close + 1).join("\n"),
    body: lines.slice(close + 1).join("\n"),
  };
}

/**
 * Parse one Markdown resource's text into its frontmatter and body. The frontmatter
 * MUST be a mapping; one that is not MUST produce one diagnostic and MUST be read as
 * empty (specs/skill.md#skill-files, the owning rule). A frontmatter that fails to parse is
 * thrown to the caller, which owns that diagnostic.
 */
export function parseMarkdown(
  text: string,
  file: string,
  diagnostics: Diagnostic[] | undefined,
  kind: MarkdownKind | undefined,
): { frontmatter: Record<string, unknown>; body: string } {
  const { block, body } = delimitFrontmatter(text);
  const trimmedBody = body.trim();
  if (block === "") return { frontmatter: {}, body: trimmedBody };
  const parsed = parseFrontmatter<Record<string, unknown>>(block);
  if (!isPlainObject(parsed.frontmatter)) {
    diagnostics?.push({
      level: "warning",
      message: `${kind ?? "agents"}: ${file}: frontmatter must be a mapping; ignored`,
    });
    return { frontmatter: {}, body: trimmedBody };
  }
  return { frontmatter: parsed.frontmatter, body: trimmedBody };
}

/**
 * Parse one Markdown resource file; missing paths and non-files yield undefined
 * silently (discovery directories are advisory). A stat error other than absence, a
 * read error, or a frontmatter parse error on an existing regular file yields
 * undefined with one report line pushed into `diagnostics` when provided.
 */
export function readMarkdown(
  file: string,
  diagnostics?: Diagnostic[],
  kind?: MarkdownKind,
): RawMarkdown | undefined {
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    if (!isAbsentPath(error)) reportMarkdownUnreadable(diagnostics, kind, file, error);
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    reportMarkdownSkip(diagnostics, kind, file, `unreadable: ${errorMessage(error)}`);
    return undefined;
  }
  try {
    return { file, ...parseMarkdown(text, file, diagnostics, kind) };
  } catch (error) {
    reportMarkdownSkip(diagnostics, kind, file, `malformed frontmatter: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * `*.md` regular-file names in a flat resource directory, in code-unit order, symlinks followed:
 * an entry whose own stat fails is reported and left out, or — with `unreadableEntry` "keep" —
 * kept as a name (specs/plugin.md#slash-commands).
 */
export function markdownFileNames(
  dir: string,
  diagnostics?: Diagnostic[],
  kind?: MarkdownKind,
  unreadableEntry: "report" | "keep" = "report",
): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (!isAbsentPath(error)) reportMarkdownUnreadable(diagnostics, kind, dir, error);
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.name.endsWith(".md") && isFileEntry(dir, entry, diagnostics, kind, unreadableEntry),
    )
    .map((entry) => entry.name)
    .toSorted();
}

function scanMarkdownDir(
  dir: string,
  diagnostics: Diagnostic[],
  kind: MarkdownKind,
): RawMarkdown[] {
  const files: RawMarkdown[] = [];
  for (const name of markdownFileNames(dir, diagnostics, kind)) {
    const raw = readMarkdown(join(dir, name), diagnostics, kind);
    if (raw) files.push(raw);
  }
  return files;
}

function scopePaths(cwd: string, kind: "agents" | "skills"): { global: string; project: string } {
  // The layer directories are the config files' directories (specs/config-file.md#layers).
  const paths = configLayerPaths(cwd);
  return {
    global: join(dirname(paths.global), kind),
    project: join(dirname(paths.project), kind),
  };
}

/** The frontmatter keys a resource kind does not define (specs/config-file.md#format). */
export function unknownFrontmatterKeys(
  frontmatter: Record<string, unknown>,
  known: readonly string[],
): string[] {
  return Object.keys(frontmatter).filter((key) => !known.includes(key));
}

/** Agent definition from one file under specs/agent.md#definition-files skip/warning rules (scope rules excluded). */
export function agentFromMarkdown(
  raw: RawMarkdown,
  diagnostics: Diagnostic[],
): AgentDefinition | undefined {
  const { frontmatter, body, file } = raw;
  const unknown = unknownFrontmatterKeys(frontmatter, ["name", "description", "model"]);
  if (unknown.length > 0) {
    diagnostics.push({
      level: "warning",
      message: `agents: ${unknownKeysMessage("frontmatter", unknown, () => file)}`,
    });
  }
  if (!isValidName(frontmatter.name)) {
    const received = frontmatter.name === undefined ? "none" : JSON.stringify(frontmatter.name);
    diagnostics.push({
      level: "warning",
      message: `agents: ${file}: skipped (frontmatter lacks a valid name; received ${received})`,
    });
    return undefined;
  }
  if (body.trim() === "") {
    diagnostics.push({ level: "warning", message: `agents: ${file}: skipped (empty body)` });
    return undefined;
  }
  if (frontmatter.model !== undefined && typeof frontmatter.model !== "string") {
    diagnostics.push({
      level: "warning",
      message: `agents: ${file}: model must be a string; ignored`,
    });
  }
  if (frontmatter.description !== undefined && typeof frontmatter.description !== "string") {
    diagnostics.push({
      level: "warning",
      message: `agents: ${file}: description must be a string; ignored`,
    });
  }
  return {
    name: frontmatter.name,
    description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
    model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
    prompt: body,
    source: file,
  };
}

/** Skill entry from one file under specs/skill.md#skill-files skip/warning rules (scope rules excluded). */
export function skillFromMarkdown(
  raw: RawMarkdown,
  diagnostics: Diagnostic[],
): SkillEntry | undefined {
  const { frontmatter, body, file } = raw;
  const unknown = unknownFrontmatterKeys(frontmatter, ["name", "description"]);
  if (unknown.length > 0) {
    diagnostics.push({
      level: "warning",
      message: `skills: ${unknownKeysMessage("frontmatter", unknown, () => file)}`,
    });
  }
  if (
    !isValidName(frontmatter.name) ||
    typeof frontmatter.description !== "string" ||
    frontmatter.description === ""
  ) {
    const received = frontmatter.name === undefined ? "none" : JSON.stringify(frontmatter.name);
    diagnostics.push({
      level: "warning",
      message: `skills: ${file}: skipped (frontmatter lacks a valid name and description; name ${received})`,
    });
    return undefined;
  }
  if (body.trim() === "") {
    diagnostics.push({ level: "warning", message: `skills: ${file}: skipped (empty body)` });
    return undefined;
  }
  return { name: frontmatter.name, description: frontmatter.description, body, source: file };
}

/** Pi-dent's own agent definitions (specs/agent.md#definition-files); the override applies after plugin composition. */
export function discoverAgents(cwd: string, diagnostics: Diagnostic[]): AgentDefinition[] {
  const paths = scopePaths(cwd, "agents");
  const byName = new Map<string, AgentDefinition>();
  for (const scope of ["global", "project"] as const) {
    const seen = new Set<string>();
    for (const raw of scanMarkdownDir(paths[scope], diagnostics, "agents")) {
      const definition = agentFromMarkdown(raw, diagnostics);
      if (!definition) continue;
      const { name } = definition;
      if (name === "dynamic") {
        diagnostics.push({
          level: "warning",
          message: `agents: ${raw.file}: skipped (name "dynamic" is reserved for dynamic dispatches)`,
        });
        continue;
      }
      if (seen.has(name)) {
        diagnostics.push({
          level: "warning",
          message: `agents: ${raw.file}: skipped (duplicate name "${name}" in ${scope} scope)`,
        });
        continue;
      }
      seen.add(name);
      byName.set(name, definition);
    }
  }
  return [...byName.values()].toSorted(byNameCodeUnit);
}

/** The `agents` configuration override (specs/agent.md#agents-override) over the composed agent catalog. */
export function applyAgentsOverride(
  config: BootConfig,
  agents: AgentDefinition[],
  diagnostics: Diagnostic[],
): void {
  // Read config.merged.agents directly: mergedObject maps a non-object value to
  // undefined, which must be reported, not silently ignored (specs/config-file.md#attribution).
  const rawOverride = config.merged.agents;
  if (rawOverride === undefined) return;
  if (!isPlainObject(rawOverride)) {
    diagnostics.push({
      level: "warning",
      message: `agents override: ${attributeKey(config, ["agents"])}: "agents" must be an object; ignored`,
    });
    return;
  }
  for (const [name, value] of Object.entries(rawOverride)) {
    const definition = agents.find((agent) => agent.name === name);
    const prompt =
      isPlainObject(value) && typeof value.prompt === "string" ? value.prompt : undefined;
    if (!definition || prompt === undefined || prompt === "") {
      diagnostics.push({
        level: "warning",
        message: `agents override: ${attributeKey(config, ["agents", name])}#agents.${name}: ignored (${definition ? 'malformed value; expected { "prompt": string }' : "unknown agent identity"})`,
      });
      continue;
    }
    const unknown = isPlainObject(value)
      ? Object.keys(value).filter((key) => key !== "prompt")
      : [];
    if (unknown.length > 0) {
      diagnostics.push({
        level: "warning",
        message: `agents override: ${unknownKeysMessage(`agents.${name}`, unknown, (key) => attributeKey(config, ["agents", name, key]))}`,
      });
    }
    definition.prompt = prompt;
  }
}

/**
 * Pi-dent's own skills (specs/skill.md#skill-files): `<name>/SKILL.md` directories in each
 * layer's `skills/` folder. A project skill shadows a global skill of the same name;
 * the directory name makes names unique within a scope.
 */
export function discoverSkills(cwd: string, diagnostics: Diagnostic[]): SkillEntry[] {
  const paths = scopePaths(cwd, "skills");
  const byName = new Map<string, SkillEntry>();
  for (const scope of ["global", "project"] as const) {
    for (const dirName of scanSkillDirs(paths[scope], diagnostics, "skills")) {
      const skill = skillFromDirectory(paths[scope], dirName, diagnostics);
      if (skill) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].toSorted(byNameCodeUnit);
}

/** Minimal plugin shape for catalog composition (specs/plugin.md#catalog-composition). */
export interface PluginCatalogSource {
  /** The plugin's namespace (the manifest `name`). */
  name: string;
  /** Absolute plugin directory. */
  root: string;
}

export function isRegularFile(
  path: string,
  diagnostics?: Diagnostic[],
  kind?: MarkdownKind,
): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (!isAbsentPath(error)) reportMarkdownUnreadable(diagnostics, kind, path, error);
    return false;
  }
}

export function isDirectory(
  path: string,
  diagnostics?: Diagnostic[],
  kind?: MarkdownKind,
): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (!isAbsentPath(error)) reportMarkdownUnreadable(diagnostics, kind, path, error);
    return false;
  }
}

/**
 * Whether a directory entry is a regular file, following a symlink (specs/agent.md#definition-files). A
 * symbolic link whose stat fails with a code other than absence is reported and left out, or —
 * with `unreadableEntry` "keep" — kept (specs/plugin.md#slash-commands).
 */
export function isFileEntry(
  dir: string,
  entry: Dirent,
  diagnostics?: Diagnostic[],
  kind?: MarkdownKind,
  unreadableEntry: "report" | "keep" = "report",
): boolean {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  const path = join(dir, entry.name);
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (isAbsentPath(error)) return false;
    // specs/plugin.md#slash-commands keeps a command file that cannot be read at boot.
    if (unreadableEntry === "keep") return true;
    reportMarkdownUnreadable(diagnostics, kind, path, error);
    return false;
  }
}

/** Whether a directory entry is a directory, following a symlink (specs/skill.md#skill-files). */
function isDirectoryEntry(
  dir: string,
  entry: Dirent,
  diagnostics?: Diagnostic[],
  kind?: MarkdownKind,
): boolean {
  return (
    entry.isDirectory() ||
    (entry.isSymbolicLink() && isDirectory(join(dir, entry.name), diagnostics, kind))
  );
}

/** Sorted ascending by `name` in code-unit order, never by locale collation. */
function byNameCodeUnit(a: { name: string }, b: { name: string }): number {
  if (a.name < b.name) return -1;
  return a.name > b.name ? 1 : 0;
}

/** Plugin `agents/*.md` files in lexicographic order (symlinks to files included, as for commands). */
function scanPluginAgents(root: string, diagnostics: Diagnostic[]): RawMarkdown[] {
  const dir = join(root, "agents");
  const files: RawMarkdown[] = [];
  for (const name of markdownFileNames(dir, diagnostics, "agents")) {
    const raw = readMarkdown(join(dir, name), diagnostics, "agents");
    if (raw) files.push(raw);
  }
  return files;
}

/** Skill directory names under a `skills/` folder in lexicographic order (specs/skill.md#skill-files). */
function scanSkillDirs(
  skillsDir: string,
  diagnostics?: Diagnostic[],
  kind?: MarkdownKind,
): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (!isAbsentPath(error)) reportMarkdownUnreadable(diagnostics, kind, skillsDir, error);
    return [];
  }
  return entries
    .filter((entry) => isDirectoryEntry(skillsDir, entry, diagnostics, kind))
    .map((entry) => entry.name)
    .toSorted();
}

/**
 * One skill from `<skillsDir>/<dirName>/SKILL.md` (specs/skill.md#skill-files): the
 * frontmatter `name` must equal the directory name. The skill carries
 * `referencesDir` when it has a `references/` folder.
 */
function skillFromDirectory(
  skillsDir: string,
  dirName: string,
  diagnostics: Diagnostic[],
): SkillEntry | undefined {
  const dir = join(skillsDir, dirName);
  const raw = readMarkdown(join(dir, "SKILL.md"), diagnostics, "skills");
  if (!raw) return undefined;
  const skill = skillFromMarkdown(raw, diagnostics);
  if (!skill) return undefined;
  if (skill.name !== dirName) {
    diagnostics.push({
      level: "warning",
      message: `skills: ${raw.file}: skipped (frontmatter name "${skill.name}" does not match directory "${dirName}")`,
    });
    return undefined;
  }
  const referencesDir = join(dir, "references");
  return {
    ...skill,
    referencesDir: isDirectory(referencesDir, diagnostics, "skills") ? referencesDir : undefined,
  };
}

/** One plugin catalog entry as the plugin inventory lists it (specs/plugin.md#shape). */
export interface PluginResourceEntry {
  /** The definition's `name` without the namespace. */
  name: string;
  /** The catalog entry's description, verbatim; undefined when there is none. */
  description?: string | undefined;
  /** The plugin-relative file the entry was found at. */
  file: string;
}

/** The catalog entries one admitted plugin contributes (specs/plugin.md#catalog-composition). */
export interface PluginCatalogEntries {
  agents: PluginResourceEntry[];
  skills: PluginResourceEntry[];
}

/**
 * Catalog composition with each plugin's diagnostics and entries kept apart (specs/plugin.md#catalog-composition and specs/plugin.md#plugin-inventory): append each plugin's `agents/*.md` and `skills/<name>/SKILL.md`
 * entries to the composed catalogs as `namespace:name`, after pi-dent's own entries, in
 * plugin admission order and lexicographic file order within a plugin. A duplicate
 * `namespace:name` within one plugin or a skill whose frontmatter `name` differs from
 * its directory name is skipped with one report line; the reserved `dynamic` rule
 * applies only to bare names. Skills carry `referencesDir` when they have a
 * `references/` folder. Each plugin's diagnostics reach `report` together, after its
 * entries, in production order; the returned map holds, per plugin, the entries that
 * joined the catalogs.
 */
export function composePluginCatalogsWithResources(
  agents: AgentDefinition[],
  skills: SkillEntry[],
  plugins: readonly PluginCatalogSource[],
  report: (plugin: PluginCatalogSource, message: string) => void,
): Map<PluginCatalogSource, PluginCatalogEntries> {
  const entries = new Map<PluginCatalogSource, PluginCatalogEntries>();
  const agentKeys = new Set(agents.map((agent) => agent.name));
  const skillKeys = new Set(skills.map((skill) => skill.name));
  for (const plugin of plugins) {
    const pluginEntries: PluginCatalogEntries = { agents: [], skills: [] };
    entries.set(plugin, pluginEntries);
    const pluginDiagnostics: Diagnostic[] = [];
    for (const raw of scanPluginAgents(plugin.root, pluginDiagnostics)) {
      const definition = agentFromMarkdown(raw, pluginDiagnostics);
      if (!definition) continue;
      const key = `${plugin.name}:${definition.name}`;
      if (agentKeys.has(key)) {
        pluginDiagnostics.push({
          level: "warning",
          message: `agents: ${raw.file}: skipped (duplicate name "${key}")`,
        });
        continue;
      }
      agentKeys.add(key);
      agents.push({ ...definition, name: key });
      pluginEntries.agents.push({
        name: definition.name,
        description: definition.description,
        file: `agents/${basename(raw.file)}`,
      });
    }
    const skillsDir = join(plugin.root, "skills");
    for (const dirName of scanSkillDirs(skillsDir, pluginDiagnostics, "skills")) {
      const skill = skillFromDirectory(skillsDir, dirName, pluginDiagnostics);
      if (!skill) continue;
      const key = `${plugin.name}:${skill.name}`;
      if (skillKeys.has(key)) {
        pluginDiagnostics.push({
          level: "warning",
          message: `skills: ${join(skillsDir, dirName, "SKILL.md")}: skipped (duplicate name "${key}")`,
        });
        continue;
      }
      skillKeys.add(key);
      skills.push({ ...skill, name: key });
      pluginEntries.skills.push({
        name: skill.name,
        description: skill.description,
        file: `skills/${dirName}/SKILL.md`,
      });
    }
    for (const diagnostic of pluginDiagnostics) report(plugin, diagnostic.message);
  }
  return entries;
}

/**
 * Plugin catalog composition (specs/plugin.md#catalog-composition) with the diagnostics flattened into one
 * array, plugin by plugin in admission order: the boot-snapshot path over
 * `composePluginCatalogsWithResources`.
 */
export function composePluginCatalogs(
  agents: AgentDefinition[],
  skills: SkillEntry[],
  plugins: readonly PluginCatalogSource[],
  diagnostics: Diagnostic[],
): void {
  composePluginCatalogsWithResources(agents, skills, plugins, (_plugin, message) => {
    diagnostics.push({ level: "warning", message });
  });
}

/**
 * `name — description` catalog line, or bare `name` when the description is absent or
 * empty; each run of line terminators in the description becomes one space
 * (specs/agent.md#definition-files).
 */
export function catalogLine(name: string, description?: string): string {
  return description ? `${name} — ${description.replace(/(?:\r\n|[\r\n])+/g, " ")}` : name;
}
