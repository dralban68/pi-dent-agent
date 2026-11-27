import { readFileSync } from "node:fs";
import type { KeyId } from "@earendil-works/pi-tui";
import { parseModelString } from "./model-string.ts";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  type Diagnostic,
  errorCode,
  errorMessage,
  isNonNegativeInteger,
  isPlainObject,
  parseJsonc,
} from "./util.ts";

/**
 * Layered configuration per specs/config-file.md: optional bundled layer plus global and project
 * JSONC layers, deep merge, `${...}` value substitution at layer read time, and a boot snapshot.
 */

export const SUPPORTED_ROOT_KEYS = [
  "modelClasses",
  "agentLiveness",
  "agents",
  "plugins",
  "modelGuidance",
  "taskBrowser",
  "footer",
  "recapModel",
  "script",
  // Owned by sibling packages (specs/config-file.md#format): pi-dent never validates them.
  "terms",
  "web",
  "webSearch",
] as const;
export type SupportedRootKey = (typeof SUPPORTED_ROOT_KEYS)[number];

export interface LayerRead {
  path: string;
  /** Post-substitution values, restricted to supported root keys. */
  values: Record<string, unknown>;
}

export interface LivenessDeadlines {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
}

export interface BootConfig {
  /** Merged raw values over the supported root keys. */
  merged: Record<string, unknown>;
  layers: {
    bundled?: LayerRead | undefined;
    global?: LayerRead | undefined;
    project?: LayerRead | undefined;
  };
  /** Process working directory at the boot read. */
  projectRoot: string;
  diagnostics: Diagnostic[];
  liveness: LivenessDeadlines;
}

export const ABSENT = Symbol("pi-dent-absent");

function report(diagnostics: Diagnostic[], message: string) {
  diagnostics.push({ level: "warning", message });
}

function substituteString(
  value: string,
  projectRoot: string,
  diagnostics: Diagnostic[],
  keyPath: string,
  file: string,
): string | typeof ABSENT {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const c = value[i];
    if (c === "$" && value[i + 1] === "$") {
      out += "$";
      i += 2;
      continue;
    }
    if (c === "$" && value[i + 1] === "{") {
      const end = value.indexOf("}", i + 2);
      if (end === -1) {
        report(
          diagnostics,
          `config: ${keyPath}: invalid reference \`${value.slice(i)}\` (unterminated \${) (${file})`,
        );
        return ABSENT;
      }
      const token = value.slice(i + 2, end);
      if (token === "project.root") {
        out += projectRoot;
      } else if (token.startsWith("env.") && token.length > 4) {
        const name = token.slice(4);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          report(
            diagnostics,
            `config: ${keyPath}: invalid reference \`\${${token}}\` (invalid environment variable name) (${file})`,
          );
          return ABSENT;
        }
        const envValue = process.env[name];
        if (envValue === undefined) {
          report(
            diagnostics,
            `config: ${keyPath}: \`\${${token}}\` references undefined environment variable ${name} (${file})`,
          );
          return ABSENT;
        }
        out += envValue;
      } else {
        report(
          diagnostics,
          `config: ${keyPath}: invalid reference \`\${${token}}\` (expected \${env.NAME} or \${project.root}) (${file})`,
        );
        return ABSENT;
      }
      i = end + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Path of a value in the layer's root object: dotted keys, array indices in brackets. */
function childPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

function elementPath(parent: string, index: number): string {
  return parent === "" ? `[${index}]` : `${parent}[${index}]`;
}

function substituteValue(
  value: unknown,
  projectRoot: string,
  diagnostics: Diagnostic[],
  keyPath: string,
  file: string,
): unknown {
  if (typeof value === "string") {
    return substituteString(value, projectRoot, diagnostics, keyPath, file);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    value.forEach((element, index) => {
      const substituted = substituteValue(
        element,
        projectRoot,
        diagnostics,
        elementPath(keyPath, index),
        file,
      );
      if (substituted !== ABSENT) out.push(substituted);
    });
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const substituted = substituteValue(
        child,
        projectRoot,
        diagnostics,
        childPath(keyPath, key),
        file,
      );
      if (substituted !== ABSENT) setOwnKey(out, key, substituted);
    }
    return out;
  }
  return value;
}

/** The read outcome of one layer: its state, its values when read, and its own diagnostics. */
export interface LayerLoad {
  /** `missing` (no file, no layer), `dropped` (one diagnostic, no values), or `read`. */
  state: "missing" | "dropped" | "read";
  /** The layer's post-substitution values; present only when `state` is `read`. */
  layer?: LayerRead;
  /** This layer's read diagnostics, in production order (specs/config-file.md#format and specs/config-file.md#value-substitution). */
  diagnostics: string[];
}

/** The configuration read with each layer's outcome kept apart: the plugin inventory's view. */
export interface ConfigRead {
  config: BootConfig;
  /** Per-layer read outcomes (specs/config-file.md#layers), for the plugin inventory (specs/plugin.md#plugin-inventory). */
  layerLoads: { bundled?: LayerLoad | undefined; global: LayerLoad; project: LayerLoad };
  /** Diagnostics from resolving `PI_DENT_BUNDLED_CONF` (specs/config-file.md#layers). */
  bundledEnvDiagnostics: string[];
}

function loadLayer(path: string, projectRoot: string): LayerLoad {
  const collected: Diagnostic[] = [];
  const state = (s: LayerLoad["state"], layer?: LayerRead): LayerLoad => ({
    ...(layer === undefined ? {} : { layer }),
    state: s,
    diagnostics: collected.map((diagnostic) => diagnostic.message),
  });
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return state("missing");
    report(collected, `config: failed to read ${path}: ${code ?? String(error)}`);
    return state("dropped");
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    report(collected, `config: failed to parse ${path}: ${errorMessage(error)}`);
    return state("dropped");
  }
  if (!isPlainObject(parsed)) {
    report(collected, `config: ${path}: root must be an object; layer dropped`);
    return state("dropped");
  }
  const substituted = substituteValue(parsed, projectRoot, collected, "", path);
  if (!isPlainObject(substituted)) {
    report(collected, `config: ${path}: substituted root is not an object; layer dropped`);
    return state("dropped");
  }
  const unknownKeys = Object.keys(substituted).filter(
    (key) => !SUPPORTED_ROOT_KEYS.some((k) => k === key),
  );
  if (unknownKeys.length > 0) {
    report(
      collected,
      `config: ${path}: unknown root keys ${unknownKeys.map((k) => `"${k}"`).join(", ")}; supported keys are ${SUPPORTED_ROOT_KEYS.map((k) => `"${k}"`).join(", ")}`,
    );
    for (const key of unknownKeys) delete substituted[key];
  }
  return state("read", { path, values: substituted });
}

function resolveBundledConfPath(diagnostics: string[]): string | undefined {
  const raw = process.env.PI_DENT_BUNDLED_CONF;
  if (raw === undefined || raw === "") return undefined;
  if (!isAbsolute(raw)) {
    diagnostics.push("config: PI_DENT_BUNDLED_CONF must be an absolute path; ignored");
    return undefined;
  }
  return raw;
}

function loadLayers(cwd: string): {
  layerLoads: { bundled?: LayerLoad | undefined; global: LayerLoad; project: LayerLoad };
  bundledEnvDiagnostics: string[];
} {
  const bundledEnvDiagnostics: string[] = [];
  const bundledPath = resolveBundledConfPath(bundledEnvDiagnostics);
  const paths = configLayerPaths(cwd);
  return {
    layerLoads: {
      ...(bundledPath === undefined ? {} : { bundled: loadLayer(bundledPath, cwd) }),
      global: loadLayer(paths.global, cwd),
      project: loadLayer(paths.project, cwd),
    },
    bundledEnvDiagnostics,
  };
}

/**
 * Set `key` as an ordinary own data property: a JSON `"__proto__"` key must stay
 * an own key so it survives iteration, gets the unknown-key diagnostic, and cannot
 * pollute prototypes (specs/config-file.md#format).
 */
function setOwnKey(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    out[key] = value;
  }
}

function mergeDeep(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      setOwnKey(
        out,
        key,
        Object.hasOwn(base, key) ? mergeDeep(base[key], override[key]) : override[key],
      );
    }
    return out;
  }
  return override;
}

/** An upper bound on a liveness deadline, in milliseconds (specs/agent-tool.md#child-session). */
const MAX_DEADLINE_MS = 2147483647;

/** Whether `value` is an integer from 0 to 2147483647 inclusive (specs/agent-tool.md#child-session). */
function isDeadline(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= MAX_DEADLINE_MS;
}

const DEADLINE_RULE = "must be an integer from 0 to 2147483647; ignored";

function resolveEnvDeadline(envVar: string, diagnostics: Diagnostic[]): number | undefined {
  const envRaw = process.env[envVar];
  if (envRaw !== undefined && envRaw !== "") {
    const value = Number(envRaw);
    // Decimal digits only, within the deadline range (specs/agent-tool.md#child-session).
    if (!/^\d+$/.test(envRaw) || !isDeadline(value)) {
      report(diagnostics, `config: ${envVar} ${DEADLINE_RULE}`);
    } else {
      return value;
    }
  }
  return undefined;
}

export function configLayerPaths(cwd: string): {
  bundled?: string | undefined;
  global: string;
  project: string;
} {
  const rawBundled = process.env.PI_DENT_BUNDLED_CONF;
  const bundled =
    rawBundled !== undefined && rawBundled !== "" && isAbsolute(rawBundled)
      ? rawBundled
      : undefined;
  return {
    ...(bundled === undefined ? {} : { bundled }),
    global: join(homedir(), ".pi", "pi-dent", "pi-dent.conf"),
    project: join(cwd, ".pi", "pi-dent", "pi-dent.conf"),
  };
}

function attributePath(
  layers: {
    bundled?: LayerRead | undefined;
    global?: LayerRead | undefined;
    project?: LayerRead | undefined;
  },
  projectRoot: string,
  path: string[],
): string {
  for (const layer of [layers.project, layers.global, layers.bundled]) {
    if (!layer) continue;
    let node: unknown = layer.values;
    let found = true;
    for (const segment of path) {
      if (!isPlainObject(node) || !Object.hasOwn(node, segment)) {
        found = false;
        break;
      }
      node = node[segment];
    }
    if (found) return layer.path;
  }
  return (
    layers.project?.path ??
    layers.global?.path ??
    layers.bundled?.path ??
    configLayerPaths(projectRoot).project
  );
}

/** Read all configured layers, substitute, validate, merge, and resolve liveness deadlines. */
export function readConfig(cwd: string): BootConfig {
  return readConfigDetailed(cwd).config;
}

/**
 * `readConfig` with each layer's outcome kept apart: the boot configuration plus, per layer,
 * its state and its own read diagnostics (specs/config-file.md#layers, specs/config-file.md#format and specs/config-file.md#value-substitution). The plugin
 * inventory reads this (specs/plugin.md#plugin-inventory); boot itself needs only `config`.
 */
export function readConfigDetailed(cwd: string): ConfigRead {
  const { layerLoads, bundledEnvDiagnostics } = loadLayers(cwd);
  const diagnostics: Diagnostic[] = [];
  for (const message of bundledEnvDiagnostics) diagnostics.push({ level: "warning", message });
  for (const load of [layerLoads.bundled, layerLoads.global, layerLoads.project]) {
    if (!load) continue;
    for (const message of load.diagnostics) diagnostics.push({ level: "warning", message });
  }
  const bundled = layerLoads.bundled?.layer;
  const global = layerLoads.global.layer;
  const project = layerLoads.project.layer;
  const layers = { bundled, global, project };
  const merged: Record<string, unknown> = {};
  for (const layer of [bundled, global, project]) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer.values)) {
      setOwnKey(merged, key, Object.hasOwn(merged, key) ? mergeDeep(merged[key], value) : value);
    }
  }

  let mergedIdle: number | undefined;
  let mergedAbsolute: number | undefined;
  const rawLiveness = merged.agentLiveness;
  if (rawLiveness !== undefined) {
    if (isPlainObject(rawLiveness)) {
      const unknownKeys = Object.keys(rawLiveness).filter(
        (key) => key !== "idleTimeoutMs" && key !== "absoluteTimeoutMs",
      );
      if (unknownKeys.length > 0) {
        // Exactly one diagnostic per object, each key attributed to its own layer.
        report(
          diagnostics,
          `config: ${unknownKeysMessage("agentLiveness", unknownKeys, (key) => attributePath(layers, cwd, ["agentLiveness", key]))}`,
        );
      }
      for (const field of ["idleTimeoutMs", "absoluteTimeoutMs"] as const) {
        if (Object.hasOwn(rawLiveness, field)) {
          const val = rawLiveness[field];
          if (isDeadline(val)) {
            if (field === "idleTimeoutMs") mergedIdle = val;
            else mergedAbsolute = val;
          } else {
            report(
              diagnostics,
              `config: ${attributePath(layers, cwd, ["agentLiveness", field])}: agentLiveness.${field} ${DEADLINE_RULE}`,
            );
          }
        }
      }
    } else {
      report(
        diagnostics,
        `config: ${attributePath(layers, cwd, ["agentLiveness"])}: agentLiveness must be an object; ignored`,
      );
    }
  }

  if (Object.hasOwn(merged, "recapModel")) {
    try {
      parseModelString(merged.recapModel);
      if (typeof merged.recapModel === "string") merged.recapModel = merged.recapModel.trim();
    } catch {
      report(
        diagnostics,
        `config: ${attributePath(layers, cwd, ["recapModel"])}: recapModel must be a model string; ignored`,
      );
      delete merged.recapModel;
    }
  }

  const envIdle = resolveEnvDeadline("PI_DENT_AGENT_IDLE_TIMEOUT_MS", diagnostics);
  const envAbsolute = resolveEnvDeadline("PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS", diagnostics);

  return {
    config: {
      merged,
      layers,
      projectRoot: cwd,
      diagnostics,
      liveness: {
        idleTimeoutMs: envIdle ?? mergedIdle ?? 0,
        absoluteTimeoutMs: envAbsolute ?? mergedAbsolute ?? 0,
      },
    },
    layerLoads,
    bundledEnvDiagnostics,
  };
}

/**
 * The owning layer of a configuration key path: the highest-priority layer that
 * declares it as an own property. When no layer declares it, the highest-priority
 * existing layer's file path (or the project path when neither exists).
 */
export function attributeKey(config: BootConfig, path: string[]): string {
  return attributePath(config.layers, config.projectRoot, path);
}

/**
 * The one unknown-key diagnostic of an object (specs/config-file.md#format): the object,
 * every unknown key, and each key's owning file (specs/config-file.md#attribution), named once when all keys
 * share one file.
 */
export function unknownKeysMessage(
  object: string,
  keys: readonly string[],
  fileOf: (key: string) => string,
): string {
  const pairs = keys.map((key) => ({ key, file: fileOf(key) }));
  const first = pairs[0];
  if (first !== undefined && pairs.every((pair) => pair.file === first.file)) {
    return `${first.file}: ${object}: unknown keys ${keys.join(", ")} ignored`;
  }
  return `${object}: unknown keys ${pairs.map((pair) => `${pair.key} (${pair.file})`).join(", ")} ignored`;
}

/** The merged value of a supported root key, when it is a plain object. */
export function mergedObject(
  config: BootConfig,
  key: SupportedRootKey,
): Record<string, unknown> | undefined {
  const value = config.merged[key];
  return isPlainObject(value) ? value : undefined;
}

export const DEFAULT_TASK_BROWSER_SHORTCUT = "shift+right";

const KEY_MODIFIERS = ["ctrl", "shift", "alt", "super"];

const SYMBOL_KEY_NAMES = new Set([
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "+",
  "|",
  "~",
  "{",
  "}",
  ":",
  "<",
  ">",
  "?",
]);

const NAMED_KEY_NAMES = new Set([
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageUp",
  "pageDown",
  "up",
  "down",
  "left",
  "right",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
]);

/**
 * Whether `value` is a host key identifier (specs/task-browser.md#configuration): `+`-joined modifier
 * names, each at most once, then one key name. The grammar is the host's `KeyId` type, which
 * ships no runtime validator.
 */
function isKeyId(value: string): value is KeyId {
  let rest = value;
  const used = new Set<string>();
  for (;;) {
    const modifier = KEY_MODIFIERS.find((name) => rest.startsWith(`${name}+`));
    if (modifier === undefined) break;
    if (used.has(modifier)) return false;
    used.add(modifier);
    rest = rest.slice(modifier.length + 1);
  }
  return /^[a-z0-9]$/.test(rest) || SYMBOL_KEY_NAMES.has(rest) || NAMED_KEY_NAMES.has(rest);
}

/** The task browser shortcut (specs/task-browser.md#configuration) with its diagnostics. */
export function parseTaskBrowser(config: BootConfig): {
  shortcut: KeyId;
  diagnostics: string[];
} {
  const raw = config.merged.taskBrowser;
  const out: { shortcut: KeyId; diagnostics: string[] } = {
    shortcut: DEFAULT_TASK_BROWSER_SHORTCUT,
    diagnostics: [],
  };
  if (raw === undefined) return out;
  const where = attributePath(config.layers, config.projectRoot, ["taskBrowser"]);
  if (!isPlainObject(raw)) {
    out.diagnostics.push(`config: ${where}: taskBrowser must be an object; ignored`);
    return out;
  }
  const unknownKeys = Object.keys(raw).filter((key) => key !== "shortcut");
  if (unknownKeys.length > 0) {
    // Exactly one diagnostic per object, each key attributed to its own layer.
    out.diagnostics.push(
      `config: ${unknownKeysMessage("taskBrowser", unknownKeys, (key) => attributePath(config.layers, config.projectRoot, ["taskBrowser", key]))}`,
    );
  }
  if (Object.hasOwn(raw, "shortcut")) {
    const value = raw.shortcut;
    const at = attributePath(config.layers, config.projectRoot, ["taskBrowser", "shortcut"]);
    if (typeof value === "string" && value !== "") {
      if (isKeyId(value)) out.shortcut = value;
      else
        out.diagnostics.push(
          `config: ${at}: taskBrowser.shortcut must be a host key identifier; ignored`,
        );
    } else
      out.diagnostics.push(
        `config: ${at}: taskBrowser.shortcut must be a non-empty string; ignored`,
      );
  }
  return out;
}

/**
 * The `script` configuration (specs/script-tool.md#configuration) with its diagnostics: the allow lists,
 * `undefined` where the key is absent or ignored.
 */
export function parseScript(config: BootConfig): {
  networkAllow: string[] | undefined;
  toolsAllow: string[] | undefined;
  diagnostics: string[];
} {
  const out: {
    networkAllow: string[] | undefined;
    toolsAllow: string[] | undefined;
    diagnostics: string[];
  } = { networkAllow: undefined, toolsAllow: undefined, diagnostics: [] };
  const at = (path: string[]): string => attributePath(config.layers, config.projectRoot, path);
  /** The object at `path` when it is one; a diagnostic when it is present and is not. */
  const object = (
    value: unknown,
    path: string[],
    known: readonly string[],
  ): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    const name = path.join(".");
    if (!isPlainObject(value)) {
      out.diagnostics.push(`config: ${at(path)}: ${name} must be an object; ignored`);
      return undefined;
    }
    const unknownKeys = Object.keys(value).filter((key) => !known.includes(key));
    if (unknownKeys.length > 0) {
      out.diagnostics.push(
        `config: ${unknownKeysMessage(name, unknownKeys, (key) => at([...path, key]))}`,
      );
    }
    return value;
  };
  const allow = (
    parent: Record<string, unknown> | undefined,
    path: string[],
  ): string[] | undefined => {
    if (parent === undefined || !Object.hasOwn(parent, "allow")) return;
    const value = parent.allow;
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
    const full = [...path, "allow"];
    out.diagnostics.push(
      `config: ${at(full)}: ${full.join(".")} must be an array of strings; ignored`,
    );
  };
  const script = object(config.merged.script, ["script"], ["network", "tools"]);
  if (script === undefined) return out;
  const network = object(script.network, ["script", "network"], ["allow"]);
  out.networkAllow = allow(network, ["script", "network"]);
  const tools = object(script.tools, ["script", "tools"], ["allow"]);
  out.toolsAllow = allow(tools, ["script", "tools"]);
  return out;
}

/** The footer configuration (specs/footer.md#configuration) with its diagnostics. */
export function parseFooter(config: BootConfig): { enabled: boolean; diagnostics: string[] } {
  const raw = config.merged.footer;
  const out: { enabled: boolean; diagnostics: string[] } = { enabled: true, diagnostics: [] };
  if (raw === undefined) return out;
  if (!isPlainObject(raw)) {
    out.diagnostics.push(
      `config: ${attributePath(config.layers, config.projectRoot, ["footer"])}: footer must be an object; ignored`,
    );
    return out;
  }
  const unknownKeys = Object.keys(raw).filter((key) => key !== "enabled");
  if (unknownKeys.length > 0) {
    out.diagnostics.push(
      `config: ${unknownKeysMessage("footer", unknownKeys, (key) => attributePath(config.layers, config.projectRoot, ["footer", key]))}`,
    );
  }
  if (Object.hasOwn(raw, "enabled")) {
    const value = raw.enabled;
    if (typeof value === "boolean") out.enabled = value;
    else
      out.diagnostics.push(
        `config: ${attributePath(config.layers, config.projectRoot, ["footer", "enabled"])}: footer.enabled must be a boolean; ignored`,
      );
  }
  return out;
}
