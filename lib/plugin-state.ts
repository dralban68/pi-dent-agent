import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isValidName } from "./catalogs.ts";
import { isJsonCompatible } from "./script-render.ts";
import { errorCode, errorMessage, isPlainObject } from "./util.ts";

/**
 * Durable per-plugin key-value state store (specs/plugin-state.md): shared by
 * pi-dent's `dent.state` script binding and external callers such as Alpha's
 * `alpha.state` host bridge. Plain JSON on disk, atomic per-key writes via
 * lockfile + rename, cross-process change watching.
 */

export const PLUGIN_STATE_VERSION = 1;
export const PLUGIN_STATE_KEY_MAX_LENGTH = 256;
export const PLUGIN_STATE_VALUE_CAP_BYTES = 262_144;
export const PLUGIN_STATE_SCOPE_CAP_BYTES = 5_242_880;

const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30_000;
const WATCH_POLL_MS = 200;

export type PluginStateScope = "workspace" | "user";

export interface PluginStateTarget {
  namespace: string;
  scope: PluginStateScope;
  /** Required (and must be absolute) when `scope === "workspace"`. */
  workspaceRoot?: string;
  /** Optional override for user-scope base directory (defaults to PI_DENT_STATE_DIR or ~/.pi/pi-dent). */
  userStateRoot?: string;
}

export interface PluginStatePaths {
  storeDir: string;
  storeFile: string;
  dataDir: string;
  gitignoreFile: string | undefined;
}

export interface PluginStateWatcher {
  close(): void;
}

export type PluginStateChangeListener = (key: string, value: unknown) => void;

/** Active in-process watchers keyed by `storeFile` so own-process writes notify immediately. */
const inProcessWatchers = new Map<string, Set<() => void>>();

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateTarget(target: PluginStateTarget): void {
  if (!isPlainObject(target) || !isValidName(target.namespace)) {
    throw new Error(
      `Invalid plugin namespace: ${JSON.stringify(isPlainObject(target) ? target.namespace : undefined)}`,
    );
  }
  if (target.scope !== "workspace" && target.scope !== "user") {
    throw new Error(`Invalid plugin state scope: ${JSON.stringify(target.scope)}`);
  }
  if (
    target.scope === "workspace" &&
    (typeof target.workspaceRoot !== "string" || !isAbsolute(target.workspaceRoot))
  ) {
    throw new Error("Workspace root must be an absolute path");
  }
}

function validateKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("State key must be a non-empty string");
  }
  if (key.length > PLUGIN_STATE_KEY_MAX_LENGTH) {
    throw new Error(`State key exceeds ${PLUGIN_STATE_KEY_MAX_LENGTH} characters`);
  }
  if (key.includes("\0")) {
    throw new Error("State key must not contain null characters");
  }
  return key;
}

function validateValueJson(value: unknown): string {
  if (!isJsonCompatible(value)) {
    throw new Error("State value must be a JSON value");
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error("State value must be a JSON value");
  }
  if (typeof json !== "string") {
    throw new Error("State value must be a JSON value");
  }
  if (Buffer.byteLength(json, "utf8") > PLUGIN_STATE_VALUE_CAP_BYTES) {
    throw new Error(`State value exceeds ${PLUGIN_STATE_VALUE_CAP_BYTES} bytes`);
  }
  return json;
}

function resolveUserStateRoot(override?: string): string {
  if (typeof override === "string" && override.length > 0) return override;
  const envDir = process.env.PI_DENT_STATE_DIR;
  if (typeof envDir === "string" && envDir.length > 0) return envDir;
  return join(homedir(), ".pi", "pi-dent");
}

/** Resolve all on-disk paths for a plugin state target (specs/plugin-state.md Section 1). */
export function pluginStatePaths(target: PluginStateTarget): PluginStatePaths {
  validateTarget(target);
  if (target.scope === "workspace") {
    const stateRoot = join(target.workspaceRoot ?? "", ".pi", "pi-dent", "state");
    const storeDir = join(stateRoot, target.namespace);
    return {
      storeDir,
      storeFile: join(storeDir, "state.json"),
      dataDir: join(storeDir, "data"),
      gitignoreFile: join(stateRoot, ".gitignore"),
    };
  }
  const stateRoot = join(resolveUserStateRoot(target.userStateRoot), "state");
  const storeDir = join(stateRoot, target.namespace);
  return {
    storeDir,
    storeFile: join(storeDir, "state.json"),
    dataDir: join(storeDir, "data"),
    gitignoreFile: undefined,
  };
}

function ensureStoreParentAndGitignore(paths: PluginStatePaths): void {
  mkdirSync(paths.storeDir, { recursive: true });
  if (paths.gitignoreFile !== undefined) {
    try {
      writeFileSync(paths.gitignoreFile, "*\n", { flag: "wx", encoding: "utf8" });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
}

/** Ensure the per-plugin `data/` directory exists and return its absolute path. */
export function ensurePluginStateDataDir(target: PluginStateTarget): string {
  const paths = pluginStatePaths(target);
  ensureStoreParentAndGitignore(paths);
  mkdirSync(paths.dataDir, { recursive: true });
  return paths.dataDir;
}

interface ParsedStore {
  exists: boolean;
  entries: Record<string, unknown>;
}

function readStoreFileRaw(storeFile: string): string | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return readFileSync(storeFile, "utf8");
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return undefined;
      if (attempt === 0 && (code === "EPERM" || code === "EBUSY")) continue;
      throw new Error(`Plugin state store unreadable (${storeFile}): ${errorMessage(error)}`);
    }
  }
  return undefined;
}

function readStoreEntries(storeFile: string): ParsedStore {
  const raw = readStoreFileRaw(storeFile);
  if (raw === undefined) {
    return { exists: false, entries: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Plugin state store is corrupt (${storeFile}): ${errorMessage(error)}`);
  }
  if (!isPlainObject(parsed) || parsed.version !== PLUGIN_STATE_VERSION) {
    throw new Error(
      `Plugin state store is corrupt (${storeFile}): expected version ${PLUGIN_STATE_VERSION} object`,
    );
  }
  if (!isPlainObject(parsed.entries)) {
    throw new Error(`Plugin state store is corrupt (${storeFile}): entries must be a plain object`);
  }
  const entries: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.entries)) {
    if (!isJsonCompatible(v)) {
      throw new Error(
        `Plugin state store is corrupt (${storeFile}): entry ${JSON.stringify(k)} is not a JSON value`,
      );
    }
    entries[k] = v;
  }
  return { exists: true, entries };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withStoreLock<T>(paths: PluginStatePaths, fn: () => T): Promise<T> {
  ensureStoreParentAndGitignore(paths);
  const lockPath = join(paths.storeDir, "state.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;

  while (!acquired) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${process.pid}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      acquired = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Another process removed it first.
          }
          continue;
        }
      } catch {
        // Lock disappeared between open and stat; retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for plugin state lock (${paths.storeFile})`);
      }
      await sleep(5 + Math.floor(Math.random() * 15));
    }
  }

  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort.
    }
  }
}

function writeStoreAtomic(paths: PluginStatePaths, entries: Record<string, unknown>): void {
  const serialized = JSON.stringify({ version: PLUGIN_STATE_VERSION, entries });
  if (Buffer.byteLength(serialized, "utf8") > PLUGIN_STATE_SCOPE_CAP_BYTES) {
    throw new Error(`State store exceeds ${PLUGIN_STATE_SCOPE_CAP_BYTES} bytes`);
  }
  const tmpName = `.state.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = join(paths.storeDir, tmpName);
  try {
    writeFileSync(tmpPath, serialized, "utf8");
    renameSync(tmpPath, paths.storeFile);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort.
    }
    throw error;
  }
}

function notifyInProcessWatchers(storeFile: string): void {
  const watchers = inProcessWatchers.get(storeFile);
  if (!watchers) return;
  for (const refresh of watchers) {
    refresh();
  }
}

/** Read one key from a plugin state store (specs/plugin-state.md Sections 1-3). */
export async function getPluginState(
  target: PluginStateTarget,
  key: string,
  defaultValue?: unknown,
): Promise<unknown> {
  const paths = pluginStatePaths(target);
  const validKey = validateKey(key);
  const { entries } = readStoreEntries(paths.storeFile);
  if (!Object.hasOwn(entries, validKey)) return defaultValue;
  return entries[validKey];
}

/** Set one key atomically in a plugin state store (specs/plugin-state.md Sections 2-3). */
export async function setPluginState(
  target: PluginStateTarget,
  key: string,
  value: unknown,
): Promise<void> {
  const paths = pluginStatePaths(target);
  const validKey = validateKey(key);
  const valueJson = validateValueJson(value);
  await withStoreLock(paths, () => {
    const { entries } = readStoreEntries(paths.storeFile);
    entries[validKey] = JSON.parse(valueJson);
    writeStoreAtomic(paths, entries);
  });
  notifyInProcessWatchers(paths.storeFile);
}

/** Delete one key atomically from a plugin state store (specs/plugin-state.md Sections 1-2). */
export async function deletePluginState(target: PluginStateTarget, key: string): Promise<void> {
  const paths = pluginStatePaths(target);
  const validKey = validateKey(key);
  // Missing store file creates nothing (Section 1).
  if (!existsSync(paths.storeFile)) return;
  let changed = false;
  await withStoreLock(paths, () => {
    const { exists, entries } = readStoreEntries(paths.storeFile);
    if (!exists || !Object.hasOwn(entries, validKey)) return;
    delete entries[validKey];
    writeStoreAtomic(paths, entries);
    changed = true;
  });
  if (changed) notifyInProcessWatchers(paths.storeFile);
}

/** List all keys in ascending UTF-16 code-unit order (specs/plugin-state.md Section 6). */
export async function listPluginStateKeys(target: PluginStateTarget): Promise<string[]> {
  const paths = pluginStatePaths(target);
  const { entries } = readStoreEntries(paths.storeFile);
  return Object.keys(entries).toSorted(byCodeUnit);
}

function snapshotOf(entries: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(entries)) {
    map.set(k, JSON.stringify(v));
  }
  return map;
}

/**
 * Watch a plugin state store across processes (specs/plugin-state.md Section 4).
 * Reports actual value changes from both own-process and cross-process writes in
 * ascending UTF-16 code-unit order of key.
 */
export function watchPluginState(
  target: PluginStateTarget,
  listener: PluginStateChangeListener,
  onError?: (error: Error) => void,
): PluginStateWatcher {
  if (typeof listener !== "function") {
    throw new TypeError("onChange listener must be a function");
  }
  const paths = pluginStatePaths(target);
  let snapshot = new Map<string, string>();
  try {
    snapshot = snapshotOf(readStoreEntries(paths.storeFile).entries);
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(errorMessage(error)));
  }

  let closed = false;
  let fsWatcher: FSWatcher | undefined;

  const refresh = (): void => {
    if (closed) return;
    let next: Map<string, string>;
    try {
      next = snapshotOf(readStoreEntries(paths.storeFile).entries);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(errorMessage(error)));
      return;
    }
    const allKeys = [...new Set([...snapshot.keys(), ...next.keys()])].toSorted(byCodeUnit);
    const changes: Array<{ key: string; nextJson: string | undefined }> = [];
    for (const key of allKeys) {
      const prevJson = snapshot.get(key);
      const nextJson = next.get(key);
      if (prevJson !== nextJson) {
        changes.push({ key, nextJson });
      }
    }
    snapshot = next;
    for (const change of changes) {
      if (closed) break;
      try {
        listener(
          change.key,
          change.nextJson === undefined ? undefined : JSON.parse(change.nextJson),
        );
      } catch {
        // Listener errors must not stop subsequent notifications (Section 4).
      }
    }
  };

  const attachFsWatch = (): void => {
    if (closed || fsWatcher !== undefined) return;
    if (!existsSync(paths.storeDir)) return;
    try {
      const watcher = watch(paths.storeDir, { persistent: false }, () => {
        refresh();
      });
      watcher.on("error", () => {
        try {
          watcher.close();
        } catch {
          // Best effort.
        }
        if (fsWatcher === watcher) fsWatcher = undefined;
      });
      fsWatcher = watcher;
    } catch {
      // Directory may have vanished; poll will retry.
    }
  };

  attachFsWatch();
  const poll = setInterval(() => {
    if (closed) return;
    attachFsWatch();
    refresh();
  }, WATCH_POLL_MS);
  poll.unref();

  let bucket = inProcessWatchers.get(paths.storeFile);
  if (!bucket) {
    bucket = new Set();
    inProcessWatchers.set(paths.storeFile, bucket);
  }
  bucket.add(refresh);

  return {
    close(): void {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      if (fsWatcher) {
        try {
          fsWatcher.close();
        } catch {
          // Best effort.
        }
        fsWatcher = undefined;
      }
      const set = inProcessWatchers.get(paths.storeFile);
      if (set) {
        set.delete(refresh);
        if (set.size === 0) inProcessWatchers.delete(paths.storeFile);
      }
    },
  };
}
