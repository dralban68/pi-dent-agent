import { type Dirent, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  composePluginCatalogsWithResources,
  type AgentDefinition,
  type PluginCatalogSource,
  type SkillEntry,
} from "./catalogs.ts";
import { configLayerPaths, readConfigDetailed } from "./config.ts";
import {
  discoverPluginCandidates,
  resolvePluginScriptPath,
  type PluginCandidate,
} from "./plugins.ts";
import { errorCode, errorMessage, isPlainObject, type Diagnostic } from "./util.ts";

/**
 * The plugin inventory (specs/plugin.md#plugin-inventory): the layers, every plugin candidate with
 * what it contributes or why it was skipped, and the diagnostics, read anew per call. It is a
 * second view of the rules boot applies, sharing their implementation (lib/config.ts,
 * lib/plugins.ts, lib/catalogs.ts); nothing in boot reads it, it touches no boot snapshot, and
 * it never reports through the host.
 */

/** One resource of a plugin, as the inventory lists it (specs/plugin.md#shape). */
export interface InventoryResource {
  name: string;
  description: string | null;
  /** The file's path relative to the plugin root, its segments joined by `/`, links unresolved. */
  file: string;
}

/** A manifest `author` object, `name` and `email` each a string or null (specs/plugin.md#shape). */
export interface InventoryPluginAuthor {
  name: string | null;
  email: string | null;
}

/** One valid plugin-declared HTTPS MCP server in the inventory (specs/plugin.md#shape). */
export interface InventoryMcpServer {
  name: string;
  url: string;
  headerNames: string[];
  auth: "oauth" | null;
  description: string | null;
}

/** An admitted plugin, per specs/plugin.md#shape. */
export interface InventoryPlugin {
  namespace: string;
  description: string | null;
  version: string | null;
  author: string | InventoryPluginAuthor | null;
  /** Whether the plugin has a plugin context (specs/plugin.md#plugin-context). */
  context: boolean;
  commands: InventoryResource[];
  agents: InventoryResource[];
  skills: InventoryResource[];
  scripts: InventoryResource[];
  mcpServers: InventoryMcpServer[];
}

/** One plugin candidate, per specs/plugin.md#shape. */
export interface InventoryCandidate {
  key: string;
  layer: "bundled" | "global" | "project";
  configFile: string;
  root: string | null;
  plugin: InventoryPlugin | null;
  skip: string | null;
  diagnostics: string[];
}

/** One configuration layer, per specs/plugin.md#shape. */
export interface InventoryLayer {
  layer: "bundled" | "global" | "project";
  file: string;
  state: "missing" | "dropped" | "read";
}

/** The plugin inventory of one working directory, per specs/plugin.md#shape. */
export interface PluginInventory {
  cwd: string;
  layers: InventoryLayer[];
  diagnostics: string[];
  candidates: InventoryCandidate[];
}

/** Ascending UTF-16 code-unit order (specs/AGENTS.md), never a locale collation. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A manifest string field: the value when it is a string, null otherwise (specs/plugin.md#shape). */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The manifest `author` shaped per specs/plugin.md#shape: string, `{ name, email }`, or null. */
function authorOf(author: unknown): string | InventoryPluginAuthor | null {
  if (typeof author === "string") return author;
  if (isPlainObject(author)) {
    return { name: stringOrNull(author.name), email: stringOrNull(author.email) };
  }
  return null;
}

/**
 * The plugin scripts of one admitted plugin (specs/plugin.md#script-listing): the files found by
 * walking `scripts/`, without reading a `node_modules` directory and without following a
 * symbolic link to a directory (both counted), each judged by the plugin script path pattern
 * (specs/plugin.md#plugin-layout) and the contained-path rule (specs/plugin.md#contained-paths) exactly as a `Script` call's path check
 * judges it. An entry whose name holds `\`, or whose resolved path does not exist as a regular
 * file at that moment, is left out without a diagnostic. A directory of the walk whose entries
 * cannot be read reports and the walk continues; when directories were left out, the summary
 * line is the last diagnostic.
 */
function listPluginScripts(root: string, diagnostics: Diagnostic[]): InventoryResource[] {
  const scriptsDir = join(root, "scripts");
  const files: string[] = [];
  let leftOut = 0;
  const walk = (dir: string, segments: readonly string[], walkRoot: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      // A missing `scripts/`, or one that is not a directory, adds nothing (specs/plugin.md#script-listing).
      if (walkRoot && (code === "ENOENT" || code === "ENOTDIR")) return;
      diagnostics.push({
        level: "warning",
        message: `scripts: ${dir}: unreadable: ${code ?? errorMessage(error)}`,
      });
      return;
    }
    for (const entry of entries.toSorted((a, b) => byCodeUnit(a.name, b.name))) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          leftOut++;
          continue;
        }
        walk(child, [...segments, entry.name], false);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // A symbolic link to a directory is not followed and is counted; any other link
        // is judged by the contained-path rule like any file (specs/plugin.md#script-listing).
        let target;
        try {
          target = statSync(child);
        } catch {
          target = undefined;
        }
        if (target?.isDirectory()) {
          leftOut++;
          continue;
        }
      }
      // A `\` in a name resolves as a `/` in a `Script` call, a different file: left out.
      if (entry.name.includes("\\")) continue;
      const file = [...segments, entry.name].join("/");
      const resolved = resolvePluginScriptPath(root, file);
      // Not pattern-matched or not contained, or the resolved path missing or not a regular
      // file at that moment (a dangling link): left out without a diagnostic (specs/plugin.md#script-listing).
      if ("error" in resolved) continue;
      let stat;
      try {
        stat = statSync(resolved.path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      files.push(file);
    }
  };
  walk(scriptsDir, ["scripts"], true);
  if (leftOut > 0) {
    diagnostics.push({
      level: "warning",
      message: `scripts: ${scriptsDir}: ${leftOut === 1 ? "1 directory" : `${leftOut} directories`} not listed (node_modules and links)`,
    });
  }
  return files.toSorted(byCodeUnit).map((file) => ({ name: file, description: null, file }));
}

/**
 * The plugin inventory (specs/plugin.md#shape and specs/plugin.md#script-listing) of `cwd`, read anew: the layers with
 * their states, the merged `plugins` entries as candidates with their diagnostics, and the
 * diagnostics belonging to no candidate. Synchronous; changes nothing on disk, registers
 * nothing with the host, imports and runs no plugin file, and reports nothing through the host.
 */
export function readPluginInventory(cwd: string): PluginInventory {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error("readPluginInventory: cwd must be an absolute path");
  }
  const paths = configLayerPaths(cwd);
  const { config, layerLoads, bundledEnvDiagnostics } = readConfigDetailed(cwd);
  const diagnostics: string[] = [
    ...bundledEnvDiagnostics,
    ...(layerLoads.bundled === undefined ? [] : layerLoads.bundled.diagnostics),
    ...layerLoads.global.diagnostics,
    ...layerLoads.project.diagnostics,
  ];
  const discovery = discoverPluginCandidates(config);
  for (const diagnostic of discovery.diagnostics) diagnostics.push(diagnostic.message);

  // Catalog composition (specs/plugin.md#catalog-composition) over empty base catalogs: bare keys are disjoint
  // from `namespace:name` keys (specs/plugin.md#catalog-composition), so the plugin entries composed, their order, and
  // their diagnostics are those a boot with the same `<cwd>` composes.
  const agents: AgentDefinition[] = [];
  const skills: SkillEntry[] = [];
  const candidateOfPlugin = new Map<PluginCatalogSource, PluginCandidate>();
  for (const candidate of discovery.candidates) {
    if (candidate.plugin !== undefined) candidateOfPlugin.set(candidate.plugin, candidate);
  }
  const composed = composePluginCatalogsWithResources(
    agents,
    skills,
    discovery.catalog.plugins,
    (plugin, message) => {
      const candidate = candidateOfPlugin.get(plugin);
      if (candidate === undefined) {
        throw new Error(`plugin inventory: no candidate for plugin ${plugin.name}`);
      }
      candidate.diagnostics.push({ level: "warning", message });
    },
  );

  const candidates: InventoryCandidate[] = discovery.candidates.map((candidate) => {
    const layer: "bundled" | "global" | "project" =
      candidate.configFile === paths.project
        ? "project"
        : candidate.configFile === paths.global
          ? "global"
          : "bundled";
    if (candidate.plugin === undefined || candidate.manifest === undefined) {
      const skip = candidate.diagnostics.at(-1);
      if (skip === undefined) {
        throw new Error(
          `plugin inventory: candidate ${candidate.key} skipped without a diagnostic`,
        );
      }
      return {
        key: candidate.key,
        layer,
        configFile: candidate.configFile,
        root: candidate.resolvedRoot,
        plugin: null,
        skip: skip.message,
        diagnostics: candidate.diagnostics.map((diagnostic) => diagnostic.message),
      };
    }
    const plugin = candidate.plugin;
    const entries = composed.get(plugin);
    if (entries === undefined) {
      throw new Error(`plugin inventory: no catalog entries for plugin ${plugin.name}`);
    }
    // specs/plugin.md#script-listing's diagnostics are the candidate's last (specs/plugin.md#shape).
    const scripts = listPluginScripts(plugin.root, candidate.diagnostics);
    return {
      key: candidate.key,
      layer,
      configFile: candidate.configFile,
      root: candidate.resolvedRoot,
      skip: null,
      plugin: {
        namespace: plugin.name,
        description: stringOrNull(candidate.manifest.description),
        version: stringOrNull(candidate.manifest.version),
        author: authorOf(candidate.manifest.author),
        context: plugin.context !== undefined,
        commands: plugin.commands.map((command) => ({
          name: command.name,
          description: command.description ?? null,
          file: `commands/${command.name}.md`,
        })),
        agents: entries.agents.map((agent) => ({
          name: agent.name,
          description: agent.description ?? null,
          file: agent.file,
        })),
        skills: entries.skills.map((skill) => ({
          name: skill.name,
          description: skill.description ?? null,
          file: skill.file,
        })),
        scripts,
        mcpServers: (plugin.mcpServers ?? []).map((server) => ({
          name: server.name,
          url: server.url,
          headerNames:
            server.headers === undefined ? [] : Object.keys(server.headers).toSorted(byCodeUnit),
          auth: server.auth ?? null,
          description: server.description ?? null,
        })),
      },
      diagnostics: candidate.diagnostics.map((diagnostic) => diagnostic.message),
    };
  });

  const layers: InventoryLayer[] = [];
  if (paths.bundled !== undefined && layerLoads.bundled !== undefined) {
    layers.push({ layer: "bundled", file: paths.bundled, state: layerLoads.bundled.state });
  }
  layers.push(
    { layer: "global", file: paths.global, state: layerLoads.global.state },
    { layer: "project", file: paths.project, state: layerLoads.project.state },
  );

  return {
    cwd,
    layers,
    diagnostics,
    candidates,
  };
}
