# Plugin UI protocol specification

This document specifies the agent side of the plugin UI protocol: the `dent-ui` extension
command, plugin UI calls, the `dent.ui.send` script binding, and the `pi-dent-ui` widget feed. The
boot snapshot's plugin catalog and plugin script path rules are owned by [plugin.md](plugin.md);
script execution and termination by [script-tool.md](script-tool.md).

## 1. Registration and gating

- The extension MUST register the extension command `dent-ui` ([slash-commands.md](slash-commands.md),
  Section 1) with description `Run and cancel plugin UI script calls, and take UI inspection results`.
  The host lists it in `get_commands` with `name` `dent-ui` and `source` `extension`.
- Outside RPC mode (`mode !== "rpc"`), `/dent-ui` MUST be a no-op: it starts no script and sets
  no widget. Unlike the task and fleet feeds ([task.md](task.md), Section 4.1), it does not
  require `PI_DENT_FEEDS`.
- The argument string ([slash-commands.md](slash-commands.md), Section 1) splits at its first
  whitespace character (ECMAScript `\s`) into `<subcommand>` and `<json>` (trimmed). Any
  subcommand other than `run`, `cancel` or `result` MUST be a no-op.

## 2. `run`

`/dent-ui run <json>` starts one plugin UI call for a plugin script.

- `<json>` MUST be parsed as JSON. When parsing fails, or the value is not a plain object with a
  non-empty string `id`, the command MUST do nothing and start no script.
- Otherwise the command MUST validate, in order, emitting one `reply` with `ok: false` (Section 5)
  and starting no script on the first failure:
  1. `id` is already the `id` of an executing plugin UI call.
  2. `namespace` is not a string, or is not in the boot snapshot's plugin catalog
     ([plugin.md](plugin.md), Section 8).
  3. `root` is not a string, or does not equal the admitted plugin's plugin root.
  4. `check` is present and is not a string, or names no check in progress in this session
     ([plugin-ui-tool.md](plugin-ui-tool.md), Section 3); the reply's `error` is
     `Unknown UI check "<check>"`, or `Invalid UI check` when it is not a string.
  5. `path` is not a non-blank string, or fails the plugin script path check
     ([plugin.md](plugin.md), Section 7; [script-tool.md](script-tool.md), Section 2).
  6. The resolved script file cannot be read as UTF-8.
- Otherwise the command MUST start one plugin UI call without blocking the command handler, and
  execute the plugin script as the `Script` tool executes a foreground call
  ([script-tool.md](script-tool.md), Sections 3 and 6) with:
  - `code` the file's text and `filename` its resolved path,
  - `cwd` the invoking session's working directory,
  - `input` `{ "ui": <data> }`, with absent or `undefined` `data` taken as `null` (the agent
    imposes no payload cap on incoming `run` `data`),
  - the bundled packages available,
  - no time limit,
  - tool functions per Section 4.2,
  - when `check` names a check in progress: tool functions per the check backend of that check
    ([plugin-ui-tool.md](plugin-ui-tool.md), Section 5) instead of Section 4.2, and `dent.state`
    per [plugin-state.md](plugin-state.md), Section 6,
  - no task row in the task registry, task feed, task detail feed, or task browser, and no output
    file or tool log.
- Standard output and standard error of a plugin UI call MUST NOT be sent on the UI feed.

## 3. `cancel`

`/dent-ui cancel <json>` cancels executing plugin UI calls.

- When `<json>` parses as a plain object whose `ids` is an array of strings, for each `id` that
  names an executing plugin UI call the command MUST cancel that call as a `Task` kill cancels a
  `Script` run ([script-tool.md](script-tool.md), Section 6: terminating the worker and its
  spawned process tree).
- The command answers nothing directly. An unknown `id`, or a malformed `<json>`, changes nothing.

## 4. Bindings

### 4.1 The `dent.ui` binding

A JSON value is a JSON-compatible value per [script-tool.md](script-tool.md), Section 5. Its size
is the UTF-8 byte length of its `JSON.stringify` text. The payload cap is 262,144 bytes.

- In a plugin UI call, and in no other script execution, `dent.ui` MUST be a frozen object with one
  method `send(data)`. Outside a plugin UI call `dent.ui` MUST be `undefined`.
- `dent.state` and `dent.state.user` are bound for the plugin per
  [plugin-state.md](plugin-state.md), Section 6.
- `dent.ui.send(data)` MUST throw an `Error`, sending nothing, when `data` is not a JSON value or
  when its size exceeds the payload cap.
- Otherwise, unless the call has already settled (including after `process.exit`), it MUST emit
  one `message` record on the UI feed (Section 5), in the order `send` was called, before the
  call's `reply`.

### 4.2 Tool functions

- This section binds the tools of a plugin UI call that carries no `check`, and of one whose
  check has the backend `live`. The other backends are owned by
  [plugin-ui-tool.md](plugin-ui-tool.md), Section 5.
- A plugin UI call MUST bind two sets of callable tools, each filtered by `script.tools.allow`
  ([script-tool.md](script-tool.md), Section 7) and the object-schema check
  ([script-tool.md](script-tool.md), Section 8.1), with `Script`, `AskUserQuestion`, and
  `PluginUI` excluded:
  1. **Direct tools** — the active tools pi-dent registers itself (`Agent`, `Bash`, `Fleet`,
     `Markdown`, `Plugin`, `Schedule`, `Search`, `Session`, `Skill` when the boot snapshot holds at
     least one skill, and `Task`), filtered by the host's `getActiveTools()` when reported,
     executed directly in-process and concurrently.
  2. **Proxied tools** — every other callable tool of the session (active `direct` tools and
     registered `codemode` or `deferred` tools reported by the host's `getAllTools()` and
     `getActiveTools()`, including pi's built-in host tools, MCP tools, and other extensions'
     tools), executed through the tool proxy (Section 4.3).
- Calling a bound tool `tools.<Name>(args)` MUST validate `args` against the tool's parameter
  schema and execute the tool with the same resolve and reject behaviour as a `Script` tool call
  ([script-tool.md](script-tool.md), Section 8.3).
- `dent.toolTypes()` MUST declare exactly the bound tools (direct and proxied,
  [script-tool.md](script-tool.md), Section 8.2).
- Every tool listed by the host's `getAllTools()` that is neither direct nor proxied — including
  `Script`, `AskUserQuestion`, `PluginUI`, inactive `direct` tools such as built-in `bash`, tools
  excluded by `script.tools.allow`, and tools without an object parameter schema — MUST be bound
  on `tools` as a function that rejects with an `Error` whose message is
  `tool <Name> is unavailable in a plugin UI call`, and MUST NOT appear in `dent.toolTypes()`.
- Tool calls made by a plugin UI call write no tool log. Tasks dispatched through `Agent` or
  `Bash` register in the session's task registry as usual.
- On settlement (normal completion, `/dent-ui cancel`, or `session_shutdown`), every in-flight
  tool call's abort signal MUST be aborted ([script-tool.md](script-tool.md), Section 8.3). A
  foreground `Agent` or `Bash` call aborts with that signal; a task dispatched with
  `background: true` survives `/dent-ui cancel` and is ended by `session_shutdown`.

### 4.3 Tool proxy

- Proxied tools execute in one lazily created, long-lived in-memory proxy session per parent
  session, started on the first proxied tool call. The proxy uses an in-memory session manager and
  registers no task row, so it writes no session file and never appears in the session list,
  session index, task feed, task detail feed, or task browser.
- The proxy inherits the parent session's non-pi-dent extension sources (including MCP adapters)
  and project trust, and drives each proxied tool call through a scripted `streamSimple` provider
  with no LLM requests, clearing its in-memory message history between calls.
- Proxied calls serialize on a FIFO queue. When a call's abort signal fires while queued, it MUST
  be removed from the queue and rejected without entering the proxy session; when it fires while
  the call is in flight, the proxy MUST abort the active proxy turn.
- If the proxy session fails to start, or the extension supplying a tool fails to load in the
  proxy, the proxied call MUST reject as a `ToolError` naming the cause; a failed startup clears
  the pending startup state so a subsequent proxied call may retry, and direct tools MUST remain
  unaffected.
- The proxy runs without an interactive UI, so an MCP server requiring interactive sign-in cannot
  prompt and fails with the adapter's authentication error rather than hanging.
- On `session_start` (when a previous proxy exists) and on `session_shutdown`, the proxy MUST
  reject queued calls, abort any in-flight call, wait up to `1000` ms for inherited extensions to
  complete `session_shutdown`, and dispose its proxy session so inherited extensions (including
  MCP server connections) shut down cleanly.

## 5. UI feed

The UI feed uses the widget key `pi-dent-ui`. Each UI message and each reply MUST be emitted as
one host `setWidget("pi-dent-ui", [line])` call, where `line` is the JSON text of one of:

| `piDent` | `type`    | Other fields                                     |
| -------- | --------- | ------------------------------------------------ |
| `"ui/1"` | `message` | `id`: string; `data`: JSON value.                |
| `"ui/1"` | `reply`   | `id`: string; `ok`: `true`; `value`: JSON value. |
| `"ui/1"` | `reply`   | `id`: string; `ok`: `false`; `error`: string.    |

- Records MUST NOT be coalesced or dropped. Every `message` of a plugin UI call MUST be emitted
  before its `reply`, and a `message` MUST NOT be emitted after its `reply`.
- `data` in a `message` and `value` in a `reply` MUST NOT exceed the payload cap (Section 4.1).
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

On `session_start` (when a prior session's calls or proxy remain) and on `session_shutdown`
(session switch, reload, or quit), every executing plugin UI call MUST be cancelled as in
Section 3, and any active tool proxy MUST be disposed as in Section 4.3. Each cancelled plugin UI
call settles with `ok: false` and an `error` naming the session shutdown. Every UI inspection in
progress settles too: its tool call fails with `Session ended`, and a `cancel` record is emitted
for it.

## 7. Inspection feed

The inspection feed uses the widget key `pi-dent-ui-inspect`. Each record MUST be emitted as one
host `setWidget("pi-dent-ui-inspect", [line])` call, where `line` is the JSON text of one of:

| `piDent`      | `type`   | Other fields                                                                                    |
| ------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `"inspect/1"` | `shot`   | `id`, `namespace`, `root`, `out`.                                                               |
| `"inspect/1"` | `check`  | `id`, `namespace`, `root`, `out`, `steps`, `timeout`, and `state` unless the backend is `live`. |
| `"inspect/1"` | `cancel` | `id`.                                                                                           |

- `id` is the inspection id; `namespace` and `root` the admitted plugin's namespace and plugin
  root; `out` the absolute path of the output directory; `state` the absolute path of the
  scratch state directory; `steps` and `timeout` the call's, defaults applied
  ([plugin-ui-tool.md](plugin-ui-tool.md), Sections 2 and 3).
- A record carries no field beside these: in particular neither the backend nor the fixtures
  module's path.
- Records MUST NOT be coalesced or dropped. A `cancel` MUST be emitted at most once per `id`, and
  never after that inspection's result was taken.
- A failed `setWidget` call of a `shot` or `check` record fails the tool call with
  `UI inspection request not sent: <reason>`; this is no case of the nothing-silent exemption for
  widget updates, since the record carries the call.

## 8. `result`

`/dent-ui result <json>` is the host's answer to one `shot` or `check` record.

- When `<json>` parses as a plain object whose `id` is the id of an inspection that waits for its
  result and whose `ok` is `true`, or whose `ok` is `false` with a string `error`, the command
  MUST settle that inspection with it ([plugin-ui-tool.md](plugin-ui-tool.md), Section 3).
- Any other `<json>`, an unknown `id` and a second result for one `id` included, changes nothing.
  The command answers nothing directly.

## 9. Specification gaps

- Exact wording of `reply` `error` strings is not specified beyond naming the cause and
  distinguishing non-JSON from over-cap return values.
- Interactive OAuth sign-in for an MCP server cannot prompt inside the headless tool proxy; the
  user must sign in through the host session first.
- Proxied tools do not declare or validate `outputSchema` / `structured` content because the host's
  `getAllTools()` metadata does not expose `outputSchema`.
- Rate limiting of UI messages is not specified.
