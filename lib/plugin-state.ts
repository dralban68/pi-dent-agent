import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { access, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { isJsonCompatible } from "./script-render.ts";
import { errorCode, errorMessage, isPlainObject } from "./util.ts";

/**
 * Durable per-plugin key-value state store (specs/plugin-state.md): shared by
 * pi-dent's `dent.state` script binding and external callers such as Alpha's
 * `alpha.state` host bridge. Plain JSON on disk, atomic per-key writes via
 * async lockfile + rename, cross-process change watching.
 */

export const PLUGIN_STATE_VERSION = 1;
export const PLUGIN_STATE_KEY_MAX_LENGTH = 256;
export const PLUGIN_STATE_VALUE_CAP_BYTES = 262_144;
export const PLUGIN_STATE_SCOPE_CAP_BYTES = 5_242_880;

const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30_000;
const WATCH_POLL_MS = 200;

export type PluginStateScope = "workspace" | "user";

export type PluginStateErrorCode =
  | "INVALID_NAMESPACE"
  | "INVALID_SCOPE"
  | "INVALID_WORKSPACE_ROOT"
  | "INVALID_KEY"
  | "INVALID_VALUE"
  | "VALUE_TOO_LARGE"
  | "STORE_TOO_LARGE"
  | "STORE_UNREADABLE"
  | "STORE_CORRUPT"
  | "LOCK_TIMEOUT";

export class PluginStateError extends Error {
  readonly code: PluginStateErrorCode;

  constructor(code: PluginStateErrorCode, message: string) {
    super(message);
    this.name = "PluginStateError";
    this.code = code;
  }
}

export interface PluginStateTarget {
  namespace: string;
  scope: PluginStateScope;
  /** Required (and must be absolute) when `scope === "workspace"`. */
  workspaceRoot?: string;
  /** Optional override for user-scope base directory (defaults to PI_DENT_STATE_DIR or ~/.pi/pi-dent). */
  userStateRoot?: string;
  /** Optional override for lock acquisition timeout in ms (default 5000). */
  lockTimeoutMs?: number;
}

export interface PluginStatePaths {
  storeDir: string;
  storeFile: string;
  dataDir: string;
  gitignoreFile: string | undefined;
}

export interface PluginStateWatcher {
  /** Resolves once the watcher has taken its initial snapshot. */
  readonly ready: Promise<void>;
  close(): void;
}

export type PluginStateChangeListener = (key: string, value: unknown) => void;

export type PluginStateEntryResult = { found: true; value: unknown } | { found: false };

interface ActiveWatcherEntry {
  ready: Promise<void>;
  refresh: () => Promise<void>;
}

/** Active in-process watchers keyed by `storeFile` so own-process writes notify immediately. */
const inProcessWatchers = new Map<string, Set<ActiveWatcherEntry>>();

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function storeLabel(target: PluginStateTarget): string {
  return `${target.scope}/${target.namespace}`;
}

function isValidNamespace(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !/\s/.test(name) &&
    !name.includes(":") &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

function validateTarget(target: PluginStateTarget): void {
  if (!isPlainObject(target) || !isValidNamespace(target.namespace)) {
    throw new PluginStateError(
      "INVALID_NAMESPACE",
      `Invalid plugin namespace: ${JSON.stringify(isPlainObject(target) ? target.namespace : undefined)}`,
    );
  }
  if (target.scope !== "workspace" && target.scope !== "user") {
    throw new PluginStateError(
      "INVALID_SCOPE",
      `Invalid plugin state scope: ${JSON.stringify(target.scope)}`,
    );
  }
  if (
    target.scope === "workspace" &&
    (typeof target.workspaceRoot !== "string" || !isAbsolute(target.workspaceRoot))
  ) {
    throw new PluginStateError("INVALID_WORKSPACE_ROOT", "Workspace root must be an absolute path");
  }
}

function validateKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new PluginStateError("INVALID_KEY", "State key must be a non-empty string");
  }
  if (key.length > PLUGIN_STATE_KEY_MAX_LENGTH) {
    throw new PluginStateError(
      "INVALID_KEY",
      `State key exceeds ${PLUGIN_STATE_KEY_MAX_LENGTH} characters`,
    );
  }
  if (key.includes("\0")) {
    throw new PluginStateError("INVALID_KEY", "State key must not contain null characters");
  }
  return key;
}

function validateValueJson(value: unknown): string {
  if (!isJsonCompatible(value)) {
    throw new PluginStateError("INVALID_VALUE", "State value must be a JSON value");
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new PluginStateError("INVALID_VALUE", "State value must be a JSON value");
  }
  if (typeof json !== "string") {
    throw new PluginStateError("INVALID_VALUE", "State value must be a JSON value");
  }
  if (Buffer.byteLength(json, "utf8") > PLUGIN_STATE_VALUE_CAP_BYTES) {
    throw new PluginStateError(
      "VALUE_TOO_LARGE",
      `State value exceeds ${PLUGIN_STATE_VALUE_CAP_BYTES} bytes`,
    );
  }
  return json;
}

function resolveUserStateRoot(override?: string): string {
  if (typeof override === "string" && override.length > 0) return resolvePath(override);
  const envDir = process.env.PI_DENT_STATE_DIR;
  if (typeof envDir === "string" && envDir.length > 0) return resolvePath(envDir);
  return join(homedir(), ".pi", "pi-dent");
}

/** Resolve all on-disk paths for a plugin state target (specs/plugin-state.md Section 1). */
export function pluginStatePaths(target: PluginStateTarget): PluginStatePaths {
  validateTarget(target);
  if (target.scope === "workspace") {
    const stateRoot = join(resolvePath(target.workspaceRoot ?? ""), ".pi", "pi-dent", "state");
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

function ensureStoreParentAndGitignoreSync(paths: PluginStatePaths): void {
  mkdirSync(paths.storeDir, { recursive: true });
  if (paths.gitignoreFile !== undefined) {
    try {
      writeFileSync(paths.gitignoreFile, "*\n", { flag: "wx", encoding: "utf8" });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
}

async function ensureStoreParentAndGitignore(paths: PluginStatePaths): Promise<void> {
  await mkdir(paths.storeDir, { recursive: true });
  if (paths.gitignoreFile !== undefined) {
    try {
      await writeFile(paths.gitignoreFile, "*\n", { flag: "wx", encoding: "utf8" });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
}

/** Ensure the per-plugin `data/` directory exists and return its absolute path (scripts only). */
export function ensurePluginStateDataDir(target: PluginStateTarget): string {
  const paths = pluginStatePaths(target);
  ensureStoreParentAndGitignoreSync(paths);
  mkdirSync(paths.dataDir, { recursive: true });
  return paths.dataDir;
}

interface ParsedStore {
  exists: boolean;
  entries: Record<string, unknown>;
}

async function readStoreFileRaw(storeFile: string, label: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await readFile(storeFile, "utf8");
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return undefined;
      if (attempt === 0 && (code === "EPERM" || code === "EBUSY")) continue;
      throw new PluginStateError(
        "STORE_UNREADABLE",
        `Plugin state store unreadable (${label}): ${code ?? errorMessage(error)}`,
      );
    }
  }
  return undefined;
}

async function readStoreEntries(storeFile: string, label: string): Promise<ParsedStore> {
  const raw = await readStoreFileRaw(storeFile, label);
  if (raw === undefined) {
    return { exists: false, entries: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PluginStateError(
      "STORE_CORRUPT",
      `Plugin state store is corrupt (${label}): ${errorMessage(error)}`,
    );
  }
  if (!isPlainObject(parsed) || parsed.version !== PLUGIN_STATE_VERSION) {
    throw new PluginStateError(
      "STORE_CORRUPT",
      `Plugin state store is corrupt (${label}): expected version ${PLUGIN_STATE_VERSION} object`,
    );
  }
  if (!isPlainObject(parsed.entries)) {
    throw new PluginStateError(
      "STORE_CORRUPT",
      `Plugin state store is corrupt (${label}): entries must be a plain object`,
    );
  }
  const entries: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.entries)) {
    if (!isJsonCompatible(v)) {
      throw new PluginStateError(
        "STORE_CORRUPT",
        `Plugin state store is corrupt (${label}): entry ${JSON.stringify(k)} is not a JSON value`,
      );
    }
    entries[k] = v;
  }
  return { exists: true, entries };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withStoreLock<T>(
  paths: PluginStatePaths,
  label: string,
  lockTimeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureStoreParentAndGitignore(paths);
  const lockPath = join(paths.storeDir, "state.lock");
  const deadline = Date.now() + lockTimeoutMs;
  let acquired = false;

  while (!acquired) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try {
            await unlink(lockPath);
          } catch {
            // Another process removed it first.
          }
          continue;
        }
      } catch (statError) {
        if (errorCode(statError) === "ENOENT") {
          // Lock disappeared between open and stat; retry immediately.
          continue;
        }
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new PluginStateError(
          "LOCK_TIMEOUT",
          `Timed out waiting for plugin state lock (${label})`,
        );
      }
      await sleep(5 + Math.floor(Math.random() * 15));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await unlink(lockPath);
    } catch {
      // Best effort.
    }
  }
}

async function writeStoreAtomic(
  paths: PluginStatePaths,
  entries: Record<string, unknown>,
): Promise<void> {
  const serialized = JSON.stringify({ version: PLUGIN_STATE_VERSION, entries });
  if (Buffer.byteLength(serialized, "utf8") > PLUGIN_STATE_SCOPE_CAP_BYTES) {
    throw new PluginStateError(
      "STORE_TOO_LARGE",
      `State store exceeds ${PLUGIN_STATE_SCOPE_CAP_BYTES} bytes`,
    );
  }
  const tmpName = `.state.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = join(paths.storeDir, tmpName);
  try {
    await writeFile(tmpPath, serialized, "utf8");
    await rename(tmpPath, paths.storeFile);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      // Best effort.
    }
    throw error;
  }
}

async function waitForInProcessWatchersReady(storeFile: string): Promise<void> {
  const watchers = inProcessWatchers.get(storeFile);
  if (!watchers) return;
  await Promise.all([...watchers].map((entry) => entry.ready));
}

async function notifyInProcessWatchers(storeFile: string): Promise<void> {
  const watchers = inProcessWatchers.get(storeFile);
  if (!watchers) return;
  await Promise.all([...watchers].map((entry) => entry.refresh()));
}

/** Read one entry, distinguishing absent keys from stored values (specs/plugin-state.md Section 5). */
export async function readPluginStateEntry(
  target: PluginStateTarget,
  key: string,
): Promise<PluginStateEntryResult> {
  const paths = pluginStatePaths(target);
  const validKey = validateKey(key);
  const { entries } = await readStoreEntries(paths.storeFile, storeLabel(target));
  if (!Object.hasOwn(entries, validKey)) return { found: false };
  return { found: true, value: entries[validKey] };
}

/** Read one key from a plugin state store; returns `defaultValue` by identity when absent. */
export async function getPluginState(
  target: PluginStateTarget,
  key: string,
  defaultValue?: unknown,
): Promise<unknown> {
  const entry = await readPluginStateEntry(target, key);
  return entry.found ? entry.value : defaultValue;
}

/** Set one key atomically in a plugin state store (specs/plugin-state.md Sections 2-3). */
export async function setPluginState(
  target: PluginStateTarget,
  key: string,
  value: unknown,
): Promise<void> {
  const paths = pluginStatePaths(target);
  const label = storeLabel(target);
  const validKey = validateKey(key);
  const valueJson = validateValueJson(value);
  await waitForInProcessWatchersReady(paths.storeFile);
  const timeoutMs = target.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  await withStoreLock(paths, label, timeoutMs, async () => {
    const { entries } = await readStoreEntries(paths.storeFile, label);
    entries[validKey] = JSON.parse(valueJson);
    await writeStoreAtomic(paths, entries);
  });
  await notifyInProcessWatchers(paths.storeFile);
}

/** Delete one key atomically from a plugin state store (specs/plugin-state.md Sections 1-2). */
export async function deletePluginState(target: PluginStateTarget, key: string): Promise<void> {
  const paths = pluginStatePaths(target);
  const label = storeLabel(target);
  const validKey = validateKey(key);
  // Missing store file creates nothing (Section 1).
  try {
    await access(paths.storeFile);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
  }
  await waitForInProcessWatchersReady(paths.storeFile);
  const timeoutMs = target.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  let changed = false;
  await withStoreLock(paths, label, timeoutMs, async () => {
    const { exists, entries } = await readStoreEntries(paths.storeFile, label);
    if (!exists || !Object.hasOwn(entries, validKey)) return;
    delete entries[validKey];
    await writeStoreAtomic(paths, entries);
    changed = true;
  });
  if (changed) await notifyInProcessWatchers(paths.storeFile);
}

/** List all keys in ascending UTF-16 code-unit order (specs/plugin-state.md Section 6). */
export async function listPluginStateKeys(target: PluginStateTarget): Promise<string[]> {
  const paths = pluginStatePaths(target);
  const { entries } = await readStoreEntries(paths.storeFile, storeLabel(target));
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
 * Invalid targets and non-function listeners throw synchronously. Existing keys
 * at watch start are snapshotted and not emitted; subsequent changes from both
 * own-process and cross-process writes emit in ascending UTF-16 code-unit order.
 */
export function watchPluginState(
  target: PluginStateTarget,
  listener: PluginStateChangeListener,
  onError?: (error: Error) => void,
): PluginStateWatcher {
  const paths = pluginStatePaths(target);
  if (typeof listener !== "function") {
    throw new TypeError("onChange listener must be a function");
  }
  const label = storeLabel(target);

  let snapshot = new Map<string, string>();
  let initialized = false;
  let closed = false;
  let fsWatcher: FSWatcher | undefined;
  let runningPromise: Promise<void> | undefined;
  let pendingRefresh = false;

  const runRefresh = async (): Promise<void> => {
    if (closed) return;
    let next: Map<string, string>;
    try {
      next = snapshotOf((await readStoreEntries(paths.storeFile, label)).entries);
    } catch (error) {
      initialized = true;
      onError?.(error instanceof Error ? error : new Error(errorMessage(error)));
      return;
    }
    if (closed) return;
    if (!initialized) {
      initialized = true;
      snapshot = next;
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

  const triggerRefresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (runningPromise) {
      pendingRefresh = true;
      return runningPromise;
    }
    runningPromise = (async () => {
      try {
        do {
          pendingRefresh = false;
          await runRefresh();
        } while (pendingRefresh && !closed);
      } finally {
        runningPromise = undefined;
      }
    })();
    return runningPromise;
  };

  const attachFsWatch = (): void => {
    if (closed || fsWatcher !== undefined) return;
    if (!existsSync(paths.storeDir)) return;
    try {
      const watcher = watch(paths.storeDir, { persistent: false }, () => {
        triggerRefresh();
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

  // Take the initial snapshot asynchronously so watch start never blocks the event loop.
  const ready = triggerRefresh();
  attachFsWatch();
  const poll = setInterval(() => {
    if (closed) return;
    attachFsWatch();
    void triggerRefresh();
  }, WATCH_POLL_MS);
  poll.unref();

  const entry: ActiveWatcherEntry = { ready, refresh: triggerRefresh };
  let bucket = inProcessWatchers.get(paths.storeFile);
  if (!bucket) {
    bucket = new Set();
    inProcessWatchers.set(paths.storeFile, bucket);
  }
  bucket.add(entry);

  return {
    ready,
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
        set.delete(entry);
        if (set.size === 0) inProcessWatchers.delete(paths.storeFile);
      }
    },
  };
}
