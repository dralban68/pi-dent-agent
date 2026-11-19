# Plugin UI protocol specification

This document specifies the agent side of the plugin UI protocol: the `dent-ui` extension
command, UI calls, the `dent.ui.send` script binding, and the `pi-dent-ui` widget feed. The
boot snapshot's plugin catalog and plugin script path rules are owned by [plugin.md](plugin.md);
script execution and termination by [script-tool.md](script-tool.md).

## 1. Registration and gating

- The extension MUST register the extension command `dent-ui` ([slash-commands.md](slash-commands.md),
  Section 1) with description `Run and cancel plugin UI script calls`. The host lists it in
  `get_commands` with `name` `dent-ui` and `source` `extension`.
- Outside RPC mode (`mode !== "rpc"`), `/dent-ui` MUST be a no-op: it starts no script and sets
  no widget. Unlike the task and fleet feeds ([task.md](task.md), Section 4.1), it does not
  require `PI_DENT_FEEDS`.
- The argument string ([slash-commands.md](slash-commands.md), Section 1) splits at its first
  whitespace into `<subcommand>` and `<json>` (trimmed). Any subcommand other than `run` or
  `cancel` MUST be a no-op.

## 2. `run`

`/dent-ui run <json>` starts one UI call for a plugin script.

- `<json>` MUST be parsed as JSON. When parsing fails, or the value is not a plain object with a
  non-empty string `id`, the command MUST do nothing and start no script.
- Otherwise the command MUST validate, in order, emitting one `reply` with `ok: false` (Section 5)
  and starting no script on the first failure:
  1. `id` is already the `id` of an executing UI call.
  2. `namespace` is not a string, or is not in the boot snapshot's plugin catalog
     ([plugin.md](plugin.md), Section 3).
  3. `root` is not a string, or does not equal the admitted plugin's plugin root.
  4. `path` is not a non-blank string, or fails the plugin script path check
     ([plugin.md](plugin.md), Section 7; [script-tool.md](script-tool.md), Section 2).
  5. The resolved script file cannot be read as UTF-8.
- Otherwise the command MUST start one UI call without blocking the command handler, and execute
  the plugin script as the `Script` tool executes a foreground call
  ([script-tool.md](script-tool.md), Sections 3 and 6) with:
  - `code` the file's text and `filename` its resolved path,
  - `cwd` the invoking session's working directory,
  - `input` `{ "ui": <data> }`, with absent or `undefined` `data` taken as `null`,
  - the bundled packages available,
  - no time limit,
  - no tool functions bound (`tools` is an empty frozen object and `dent.toolTypes()` returns the
    empty tool declarations),
  - no task row in the task registry, task feed, task detail feed, or task browser, and no output
    file or tool log.
- Standard output and standard error of a UI call MUST NOT be sent on the UI feed.

## 3. `cancel`

`/dent-ui cancel <json>` cancels executing UI calls.

- When `<json>` parses as a plain object whose `ids` is an array of strings, for each `id` that
  names an executing UI call the command MUST cancel that call as a `Task` kill cancels a
  `Script` run ([script-tool.md](script-tool.md), Section 6: terminating the worker and its
  spawned process tree).
- The command answers nothing directly. An unknown `id`, or a malformed `<json>`, changes nothing.

## 4. The `dent.ui` binding

A JSON value is `null`, a boolean, a finite number, a string, an array of JSON values without
holes, or a plain object whose own enumerable values are JSON values, with no cycles. Its size is
the UTF-8 byte length of its `JSON.stringify` text. The payload cap is 262,144 bytes.

- In a UI call, and in no other script execution, `dent.ui` MUST be a frozen object with one
  method `send(data)`. Outside a UI call `dent.ui` MUST be `undefined`.
- `dent.ui.send(data)` MUST throw an `Error`, sending nothing, when `data` is not a JSON value or
  when its size exceeds the payload cap.
- Otherwise, unless the call has already settled (including after `process.exit`), it MUST emit
  one `message` record on the UI feed (Section 5), in the order `send` was called, before the
  call's `reply`.

## 5. UI feed

The UI feed uses the widget key `pi-dent-ui`. Each UI message and each reply MUST be emitted as
one host `setWidget("pi-dent-ui", [line])` call, where `line` is the JSON text of one of:

| `piDent` | `type`    | Other fields                                     |
| -------- | --------- | ------------------------------------------------ |
| `"ui/1"` | `message` | `id`: string; `data`: JSON value.                |
| `"ui/1"` | `reply`   | `id`: string; `ok`: `true`; `value`: JSON value. |
| `"ui/1"` | `reply`   | `id`: string; `ok`: `false`; `error`: string.    |

- Records MUST NOT be coalesced or dropped. Every `message` of a UI call MUST be emitted before
  its `reply`, and a `message` MUST NOT be emitted after its `reply`.
- `data` in a `message` and `value` in a `reply` MUST NOT exceed the payload cap (Section 4).
- Exactly one `reply` MUST be emitted for each `run` command with a non-empty string `id`:

| Outcome                                                               | Reply                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Returns a JSON value with size at most the payload cap.               | `ok: true`, `value` the return value.                              |
| Returns `undefined`, or ends by `process.exit(0)` / `process.exit()`. | `ok: true`, `value: null`.                                         |
| Returns a non-JSON value.                                             | `ok: false`, `error` stating the return value is not a JSON value. |
| Returns a JSON value with size over the payload cap.                  | `ok: false`, `error` stating the return value exceeds the cap.     |
| Throws, is cancelled/killed, exits non-zero, or fails to start.       | `ok: false`, `error` naming the cause.                             |

- A failed `setWidget` call reports no failure (per `specs/AGENTS.md`).

## 6. Lifecycle

On `session_shutdown` (session switch, reload, or quit), every executing UI call MUST be
cancelled as in Section 3. Each cancelled call settles with `ok: false` and an `error` naming the
session shutdown.

## 7. Specification gaps

- Exact wording of `reply` `error` strings is not specified beyond naming the cause and
  distinguishing non-JSON from over-cap return values.
- Whether a UI call will bind session tools if the host later exposes tool execution to extension
  commands is not decided.
- Rate limiting of UI messages is not specified.
