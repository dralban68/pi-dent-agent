# Plugin state specification

This document specifies the durable key-value state store for plugins: its on-disk layout and
format, its Node module API for external callers such as Alpha, and the `dent.state` binding
exposed to plugin scripts. Plugin namespaces are owned by [plugin.md](plugin.md), Section 3;
script execution by [script-tool.md](script-tool.md).

## 1. Scopes, paths, and layout

A plugin state store belongs to one plugin namespace (valid per [plugin.md](plugin.md), Section 2)
and one scope: `workspace` or `user`.

| Scope       | Store directory                                 | Store file                                                 | Data directory                                       |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| `workspace` | `<workspaceRoot>/.pi/pi-dent/state/<namespace>` | `<workspaceRoot>/.pi/pi-dent/state/<namespace>/state.json` | `<workspaceRoot>/.pi/pi-dent/state/<namespace>/data` |
| `user`      | `<userStateRoot>/state/<namespace>`             | `<userStateRoot>/state/<namespace>/state.json`             | `<userStateRoot>/state/<namespace>/data`             |

- `<workspaceRoot>` MUST be an absolute path.
- `<userStateRoot>` is the `userStateRoot` option when provided, else `PI_DENT_STATE_DIR` when
  set and non-empty, else `~/.pi/pi-dent`.
- When creating `<workspaceRoot>/.pi/pi-dent/state` (for a write or data directory creation),
  if `<workspaceRoot>/.pi/pi-dent/state/.gitignore` does not exist, the implementation MUST write
  `*\n` to it. An existing `.gitignore` MUST NOT be overwritten.
- Reads (`get`, `keys`) and `delete` on a missing store file or missing `.pi/` directory MUST NOT
  create any directory or file.
- Writes (`set`) and data directory access (`dir` / `ensurePluginStateDataDir`) MUST create
  missing parent directories lazily and MUST reject or throw the operating system error when the
  target cannot be created (for example on a read-only workspace).

## 2. File format and atomicity

- `state.json` is plain UTF-8 JSON (not intended for secrets) with the shape:
  `{"version":1,"entries":{"<key>":<JSON value>}}`.
- A missing `state.json` (`ENOENT`) counts as empty (`entries: {}`).
- A `state.json` that cannot be read, fails to parse as JSON, is not a plain object with
  `version === 1` and plain-object `entries`, or contains a non-JSON value MUST NOT be silently
  reset or overwritten; every read, list, write, or delete MUST reject with an error naming the
  file path and cause (Section 5).
- Per-key writes (`set` and `delete`) MUST serialize across processes using an exclusive lockfile
  `state.lock` in the store directory (with retry up to 5,000 ms and stale-lock recovery after
  30,000 ms), re-read `state.json` under the lock, apply the single-key change, write a unique
  sibling temporary file, and atomically rename it onto `state.json`. Two concurrent writers
  updating different keys MUST NOT lose each other's write; two concurrent writers updating the
  same key MUST leave one whole value.

## 3. Limits and validation

A JSON value is `null`, a boolean, a finite number, a string, a dense array of JSON values, or a
plain object whose own enumerable values are JSON values, with no cycles.

- **Key**: a non-empty string of 1 to 256 UTF-16 code units containing no U+0000 (`\0`).
- **Value**: a JSON value whose `JSON.stringify` text is at most 262,144 bytes in UTF-8.
  `undefined` is not a JSON value and MUST be rejected on `set`.
- **Scope total**: the serialized `state.json` text MUST be at most 5,242,880 bytes (5 MiB) in
  UTF-8.

## 4. Watching and change notifications

- `watchPluginState(target, listener, onError?)` watches a plugin state store across processes,
  including before `<workspaceRoot>/.pi` exists.
- The watcher MUST report actual value changes made by its own process and by other processes.
  Own-process writes notify active in-process watchers without duplicating on the subsequent file
  system event. Writing a value whose JSON text equals the stored value MUST NOT emit a change.
- Each change invokes `listener(key, value)`, where `value` is `undefined` for a deletion and the
  stored JSON value for an addition or update.
- Changes observed in one diff MUST be delivered in ascending UTF-16 code-unit order of `key`.
  An exception thrown by a listener MUST NOT stop later listeners or crash the watcher.
- When `state.json` is corrupt or unreadable during a watch read, the watcher MUST invoke
  `onError(error)` if provided and MUST keep its previous snapshot without resetting it.

## 5. Module API (`lib/plugin-state.ts`) and error texts

`lib/plugin-state.ts` MUST export:

- Constants: `PLUGIN_STATE_VERSION` (`1`), `PLUGIN_STATE_KEY_MAX_LENGTH` (`256`),
  `PLUGIN_STATE_VALUE_CAP_BYTES` (`262144`), `PLUGIN_STATE_SCOPE_CAP_BYTES` (`5242880`).
- Functions:
  - `pluginStatePaths(target)`
  - `ensurePluginStateDataDir(target)`
  - `getPluginState(target, key, defaultValue?)`
  - `setPluginState(target, key, value)`
  - `deletePluginState(target, key)`
  - `listPluginStateKeys(target)`
  - `watchPluginState(target, listener, onError?)`

Validation and runtime errors MUST use these verbatim texts:

| Condition                    | Error message                                           |
| ---------------------------- | ------------------------------------------------------- |
| Invalid namespace            | `Invalid plugin namespace: <JSON.stringify(namespace)>` |
| Invalid scope                | `Invalid plugin state scope: <JSON.stringify(scope)>`   |
| Missing/relative workspace   | `Workspace root must be an absolute path`               |
| Key not a non-empty string   | `State key must be a non-empty string`                  |
| Key length > 256             | `State key exceeds 256 characters`                      |
| Key contains `\0`            | `State key must not contain null characters`            |
| Value not a JSON value       | `State value must be a JSON value`                      |
| Value size > 262,144 bytes   | `State value exceeds 262144 bytes`                      |
| Store size > 5,242,880 bytes | `State store exceeds 5242880 bytes`                     |
| Unreadable store file        | `Plugin state store unreadable (<path>): <cause>`       |
| Corrupt store file           | `Plugin state store is corrupt (<path>): <reason>`      |
| Lock timeout                 | `Timed out waiting for plugin state lock (<path>)`      |

## 6. The `dent.state` binding

- In every execution of a plugin script — both `Script` tool calls with `plugin` and `path`
  ([script-tool.md](script-tool.md), Section 2) and plugin UI calls
  ([plugin-ui.md](plugin-ui.md), Section 2) — `dent.state` MUST be a frozen object for the
  plugin's `workspace` scope (using the script's session `cwd` as `workspaceRoot`) with a frozen
  `dent.state.user` property for the plugin's `user` scope.
- Outside a plugin script (inline `Script` calls with `code`), `dent.state` MUST be `undefined`.
- Both `dent.state` and `dent.state.user` MUST expose:
  - `get(key, defaultValue?)` -> `Promise<unknown>`
  - `set(key, value)` -> `Promise<void>`
  - `delete(key)` -> `Promise<void>`
  - `keys()` -> `Promise<string[]>` (ascending UTF-16 code-unit order)
  - `onChange(listener)` -> `() => void` (synchronous; throws `TypeError("onChange listener must be a function")` when `listener` is not a function)
  - `dir` (getter returning the absolute path of the scope's `data` directory, creating it lazily
    on first access).
- Active `onChange` watchers in a script MUST be closed automatically when the script settles and
  MUST NOT keep a finished script's worker alive.

## 7. Specification gaps

- Rapid cross-process writes faster than file-system watch delivery may coalesce intermediate
  values into the latest state on disk.
- No encryption or secret storage is provided; `state.json` is plain JSON on disk.
