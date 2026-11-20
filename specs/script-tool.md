# `Script` tool specification

This document specifies the `Script` tool: in-process execution of agent-authored JavaScript or
TypeScript, its sources, inputs, results, timeout, and delivery, and the typed functions through
which a script calls the session's other tools. The plugin script it can read is owned by
[plugin.md](plugin.md). The extension MUST register the tool through the host `registerTool` API
with `name` and `label` `"Script"`; the host shows a call as a tool card
([tool-card.md](tool-card.md)).

## 1. Parameter schema

The parameter schema is a JSON object schema with `type: "object"` and
`additionalProperties: false`:

| Field         | Type     | Contract                                                                                                                                    |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`        | string?  | Inline JavaScript or TypeScript source.                                                                                                     |
| `plugin`      | string?  | Namespace of the plugin owning the script.                                                                                                  |
| `path`        | string?  | Plugin-relative path matching the plugin script path pattern of [plugin.md](plugin.md), Section 1.                                          |
| `input`       | object?  | JSON-compatible object exposed as the `input` binding (Section 3). The schema admits any object and does not check JSON-compatibility.      |
| `cwd`         | string?  | Working directory observed by the script (Section 3): the `cwd` parameter ([task.md](task.md), Section 1.1).                                |
| `timeout`     | integer? | Per-call timeout in milliseconds, `1` to `600000`. Omitted gives a foreground call `600000` ms and imposes no timeout on a background call. |
| `background`  | boolean? | Background delivery (default `false`).                                                                                                      |
| `description` | string?  | UI label for the call.                                                                                                                      |

The schema requires no field and admits no property other than these eight; it constrains the
types of the table and the `1` to `600000` bounds of `timeout`, and nothing else. The tool treats
a blank `code`, `plugin`, `path`, or `description` as absent (Sections 2 and 6): one that
is empty or has only white space.

## 2. Validation

The host validates the call's arguments against the schema of Section 1 before the tool runs,
and rejects a call whose arguments do not satisfy it. That rejection is a schema rejection
([task.md](task.md), Section 1): it registers no task row, and no output file is created.

The tool's own checks run after the host's, and the first of them precedes the row. After blank
values are treated as absent (Section 1), the call MUST have exactly one source, inline `code`,
or `plugin` together with `path`; a call without one MUST be rejected, before any task row is
registered and with no file created, with one of these two verbatim strings as its text (the
source-shape rejection):

- when `code` is absent and neither `plugin` nor `path` is present, or when `code` is present
  together with any of `plugin` and `path`:
  `exactly one source is required: non-blank code, or non-blank plugin plus non-blank path`
- when `code` is absent and only one of `plugin` and `path` is present:
  `plugin source requires both non-blank plugin and non-blank path`

That rejection is neither a schema rejection, because the text is the tool's, nor a pre-start
rejection, because the call has no row ([task.md](task.md), Section 1).

The remaining checks the schema cannot express MUST reject the call as a pre-start rejection
(Section 6), checked in this order after the row is registered, the first failure reported:

- The host session that invoked the call; the failure text is verbatim
  `pi-dent: no live host session for the Script call`.
- The `cwd` check of [task.md](task.md), Section 1.1.
- A `plugin` that the plugin catalog does not have ([plugin.md](plugin.md), Section 8).
- With a plugin source, a `path` that does not match the plugin script path pattern of
  [plugin.md](plugin.md), Section 1, or that does not resolve to a contained path
  ([plugin.md](plugin.md), Section 7; root: the plugin root).
- A plugin script file that is missing at call time ([plugin.md](plugin.md), Section 7); the
  failure MUST name the resolved path.

The plugin script file MUST be read fresh at call time per [plugin.md](plugin.md), Section 8.

## 3. Execution model

- A call runs one script in an in-process worker thread. The worker is a lifecycle boundary, not a
  sandbox: scripts run with the caller's privileges and full Node capabilities. No external
  runtime binary is invoked.
- ESM semantics, TypeScript syntax, and top-level `await` MUST work with no build step.
- Imports resolve `node:*` builtins and, by name, exactly these bundled packages: `cheerio`,
  `csv-parse`, `csv-stringify`, `fast-xml-parser`, `file-type`, `glob`, `gray-matter`, `ini`,
  `js-yaml`, `jsonc-parser`, `jszip`, `semver`, `smol-toml`. Web globals (`fetch`, `URL`,
  `AbortController`, `TextEncoder`/`TextDecoder`, `crypto`, `Buffer`, `process`, `console`,
  timers), `tools` (Section 8.3), and the frozen global `dent` namespace are pre-bound. Nothing is
  auto-installed: any other bare specifier resolves by Node resolution from the script's file name
  (the plugin script, or `<cwd>/__pi_dent_script__.ts` for inline `code`).
- The frozen global `dent` object holds:
  - `dent.toolTypes()`, returning the tool declarations of the call (Section 8.2), as a string;
  - `dent.ui`, which is `undefined` outside a plugin UI call ([plugin-ui.md](plugin-ui.md),
    Section 4.1);
  - `dent.state`, bound for plugin scripts and `undefined` for inline scripts
    ([plugin-state.md](plugin-state.md), Section 6).
- Every call compiles its script and every module it imports afresh in a new worker: no module
  instance or module state is cached or reused across calls.
- `input`, when provided, reaches the script as the top-level `input` binding and
  `globalThis.input`, isolated from the caller by structured cloning. For a plugin script,
  omitted `input` leaves `input` `undefined`; a plugin script conventionally treats that as a help
  request and returns structured help. Explicit `input: {}` is execution input. Inline `code` has
  no help convention.
- The script's `cwd` MUST be observed by `process.cwd()`, by every relative path argument to
  `node:fs` and `node:fs/promises` functions however imported (a `symlink` target is passed
  unchanged), by `path.resolve`, and as the default working directory of processes started
  through `node:child_process`; other modules use the host process working directory. A glob
  pattern is not a path: `glob`, `globSync`, and the `node:fs/promises` `glob` MUST pass their
  pattern unchanged and MUST resolve a relative or absent `cwd` option against the script `cwd`.
  A relative `cwd` option passed to a `node:child_process` function MUST resolve against the
  script `cwd`.
- A `node:fs` or `node:fs/promises` function patched to observe the script `cwd` MUST keep the
  original's own properties: `realpathSync.native`, `realpath.native`, and the `promisify`
  behavior of `fs.exists` included.
- The worker's `process.env` is the host process environment, with the call's caller-supplied
  environment merged over it, and then the session temporary folder of
  [bash-tool.md](bash-tool.md), Section 3 applied to it. When the session temporary folder of
  [bash-tool.md](bash-tool.md), Section 3 sets `TMPDIR`, `os.tmpdir()` in the script returns it.
- `console.log` / `console.error` are captured as `stdout` / `stderr`, each stream capped at
  1 MiB (`1048576` bytes) of its text encoded as UTF-8: the first chunk that would exceed the cap
  is cut at the cap on a character boundary and followed by the truncation marker
  `\n... [truncated] ...\n`, later output of that stream is dropped, and the stream is reported in
  `details.truncated` (`{ stdout: boolean, stderr: boolean }`).
- `process.exit(code)` inside the worker is intercepted without terminating the host process: it
  settles the run with `exitReason: "exit-called"` and `exitCode: code` (default `0`) and throws an
  error the script can catch in place of returning. The tool MUST drop the script's timers and
  immediates pending at the call, and MUST NOT run one the script registers after it. The worker
  MUST keep its event loop running while a child of the spawned tree lives (Section 6), so the
  children the tool kills at settlement can still be reaped; the script's other pending callbacks —
  an I/O completion, a promise continuation — MAY run until the tool terminates the worker, as MAY
  the code of a script whose run settled for any other `exitReason`.
- A thrown error or unhandled rejection settles the run with `exitReason: "threw"`, formatting
  the error's `name`, `message`, and `stack` as strings; nested `cause` chains are not
  propagated. So does the worker ending without settling, with the message
  `script worker exited unexpectedly (code <code>)`. The error text — the `stack`, preceded by
  the line `<name>: <message>` when the `stack` has no such line — is appended to `stderr` at
  settlement, on a new line, and is not otherwise written to `stderr`.

## 4. Module contract

- A script declares its return value with a top-level default export (`export default <expr>`).
- Without a default export, the return value is the module body's completion value; it is
  `undefined` when the body contains top-level `await` or does not end with an expression
  statement. Top-level `await` is an `await` expression or a `for await` statement outside every
  function and class body; the word `await` in a comment, a string, a template, a regular
  expression, or a nested function does not make the completion value `undefined`. A body whose
  top level uses the identifier `arguments` MAY have the completion value `undefined`. A missing
  default export MUST NOT fail the run.
- When the module body sets `module.exports` to a primitive or `null`, that value is the return
  value: it is used when there is no default export, ahead of the completion value.
- A script can declare `const`, `let`, `var`, `function`, or `class` for a pre-bound name
  (Section 3), shadowing that binding; with no default export, a script declaring `var` for such
  a name has the completion value `undefined`.
- A return value that cannot be structured-cloned degrades, without failing the run, to the
  string `<non-cloneable: <error>>`, `<error>` being the string form of the cloning error; that
  string is then the return value.

## 5. Result contract

- The foreground body (`content[0].text`) is `stdout`, then `\n--- stderr ---\n<stderr>` when
  `stderr` is non-empty, then `\n--- return ---\n<rendered>` when `exitReason` is `ok`, then
  `\nFull return value: <outputPath>` when the return json section applies (Section 5, below), then
  `\n--- exited <exitReason>[ code=<exitCode>] in <durationMs>ms ---`, then
  `\n--- killed by the user from the task browser ---` when the run ended as a browser kill
  ([task-registry.md](task-registry.md), Section 2), then
  `\n--- tool calls: <n>; log: <toolLogPath>; Search it with session <taskId> ---` when the run
  made one or more nested calls (Section 8.4), then `\n--- return metadata ---\n<json>` when
  `exitReason` is `ok`. `<n>` is the number of nested calls the run made. `<rendered>` is the
  return value rendered per the rendering rules below; `<json>` is `details.returnValueRender`
  serialized as single-line JSON; ` code=<exitCode>` is present only when `exitCode` is.
- `details` carries `{ stdout, stderr, returnValue?, returnValueRender?, exitReason, exitCode?,
  truncated: { stdout, stderr }, durationMs, taskId?, outputPath, toolCalls, toolLogPath?,
  background? }`. `outputPath` is present for every call that starts a run (Section 6).
  `toolCalls` is the number of nested calls the run made, `0` when it made none or did not start;
  `toolLogPath` is present exactly when the tool log was created (Section 8.4). `returnValue` and
  `returnValueRender` are present exactly when `exitReason` is `ok`. The run starts when the
  worker is created and ends at settlement; `durationMs` is the whole milliseconds between them,
  rounded down, and `0` when no run started.
- A JSON-compatible value (also called a JSON value in sibling specs) is `null`, a boolean, a
  finite number, a string, a dense array (no missing elements / holes) whose elements are
  JSON-compatible, or a plain object (prototype `Object.prototype` or `null`) whose own enumerable
  values are JSON-compatible, with no cycles.
- A JSON-compatible return value round-trips as `details.returnValue`, a non-cloneable marker
  string (Section 4) included; any other return value, `undefined` included, uses
  `{ type: "non-json-return-value", representation: string }` there, `representation` being
  `<rendered>`.
- `details.returnValueRender` carries `{ stringsOverLimit, truncatedStrings, aggregateTruncated }`.
  `stringsOverLimit` is the number of strings clipped, the length of `truncatedStrings`; each is
  `{ path, originalLength, renderedLength: 500 }`, where `path` is the array of property names
  and indexes from the root `[]`. `aggregateTruncated` is `true` when the aggregate cap applied.
- Rendering rules. A string longer than 500 characters is clipped to its first 500 characters
  followed by `... [truncated]`; the aggregate render is capped at 10000 characters
  (`\n... [aggregate truncated] ...` appended after the first 10000). Values render as:

  | Value                                                  | Rendering                                                                                                                                         |
  | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `null`, `undefined`                                    | `null`, `undefined`.                                                                                                                              |
  | string                                                 | A JSON string literal of the (clipped) string.                                                                                                    |
  | number, boolean                                        | The value's string form.                                                                                                                          |
  | bigint                                                 | The decimal digits followed by `n`.                                                                                                               |
  | function                                               | `[Function <name>]`, `anonymous` for a nameless function.                                                                                         |
  | symbol                                                 | Its string form.                                                                                                                                  |
  | array                                                  | `[]` when empty, else `[`, one member per line indented by 2 spaces per nesting level, members separated by `,`, then `]` at the parent's indent. |
  | plain object (prototype `Object` or `null`)            | `{}` when empty, else the array layout with `<JSON string literal of key>: <value>` members, own enumerable string keys in insertion order.       |
  | array or plain object already being rendered (a cycle) | `[Circular]`; a cyclic value is not JSON-compatible.                                                                                              |
  | any other object                                       | The output of Node.js `util.inspect` with default options; its strings are not clipped.                                                           |

- A JSON-compatible return value whose rendering is clipped (`stringsOverLimit` above `0`, or
  `aggregateTruncated` `true`) has its full value appended to `outputPath` (Section 6) as one
  section, `\n--- return json ---\n<json>`, `<json>` being `JSON.stringify` of the value (single-line,
  unclipped). The section follows the `\n--- return ---` block and precedes the `\n--- exited`
  block. No other return value adds it, and the body does not carry the section. When
  `JSON.stringify` throws for a clipped value, the section does not apply: nothing is written, no
  `Full return value` line is added, and the run is unaffected. When the section applies, the body
  carries the line `Full return value: <outputPath>` after its `\n--- return ---` block: the body's
  only path to the full value. `details` has no path field for it. A failure to write `outputPath`
  MUST NOT fail the call, and no field reports it.
- `exitReason` is one of `running` (initial background return), `ok` (normal completion),
  `exit-called` (`process.exit`), `timeout` (deadline expired), `threw` (uncaught error), `killed`
  (`Task` `kill`), or `aborted` (tool-call signal). The call is an error (`isError: true`)
  unless `exitReason` is `ok`, `exit-called`, or `running`.

## 6. Timeout and delivery

- Every settled run MUST terminate its worker outright (`worker.terminate()`) and, when the
  script has spawned children, MUST first signal the spawned process tree with `SIGTERM`.
  After that signal, the tool MUST drain child exit reports, checking every 25 ms whether
  direct children remain, until a check finds none or 200 ms have elapsed since `SIGTERM`,
  whichever occurs first, then send `SIGKILL` to the remaining tree. After `SIGKILL`, it MUST
  drain again with the same check interval until a check finds no direct children or 100 ms
  have elapsed since `SIGKILL`, whichever occurs first, then terminate the worker.
  This sequence applies including on Windows, retaining exit and reaping ownership.
  That holds for every `exitReason` a settlement carries, `ok` and `exit-called` included. A child
  that has already exited is part of the tree: its process group, which can still hold processes,
  MUST be terminated too. A process group with no members when its leader exits is no longer part
  of the tree, and its pid MUST NOT be signalled at settlement. A child that does not lead its own
  process group MUST be signalled by its process ID alone, never as a group. A foreground call
  MUST NOT move itself to the background. The tool MUST leave no child of the tree that it terminated
  in the host's process table: on a platform where a terminated process stays there until its parent
  reaps it, the worker reaps it before the tool terminates the worker, an `exit-called` settlement
  included.
- Except for the source-shape rejection of Section 2 and a call where [task.md](task.md),
  Section 1 registers no row, every call registers one task row (`kind: "script"`) after the host
  has accepted its arguments and the source shape, and before the remaining checks of Section 2,
  `label` set to `description` when Section 1 does not treat it as absent, else to `path` when
  Section 1 does not treat it as absent, else to the first line of `code` with its leading white
  space, line breaks included, removed, cut to 80 characters (no marker); task lifetime, cohort,
  and completion notification follow [task-registry.md](task-registry.md). The label MUST NOT be
  empty: the source-shape rejection of Section 2 guarantees a present `path` or a `code` with a
  non-white-space first character. The registration sets the row's `code`
  ([task-registry.md](task-registry.md), Section 2): an inline call to the call's `code` text; a
  plugin call, to the file's content once the source resolution of Section 2 has succeeded and
  before the run starts, so a call failing it leaves `code` empty.
- In both foreground and background delivery, the run's stdout and stderr chunks MUST be appended
  to the row's progress projection as they arrive, in arrival order, and not one line per stream,
  with lines formed, and each entry built from its line's display text and cut, as
  [bash-tool.md](bash-tool.md), Section 4 states for progress entries; the unterminated last line
  is appended at settlement.
- A call failing the remaining checks of Section 2 is a pre-start rejection: its row is consumed
  ([task-registry.md](task-registry.md), Section 5) and settles `failed`, and the call returns the
  tool error directly in both foreground and background delivery.
- In a call that passes Section 2, a cancellation before the worker starts, and in a foreground
  call also an abort, a tool-call signal already aborted included, MUST prevent the run; the row
  settles with that outcome's `exitReason`, and its body is the `\n--- exited` block of Section 5
  alone. A background call so prevented still returns the background result below.
- A foreground call aborts when its tool-call signal aborts (`exitReason: "aborted"`). A
  background call MUST ignore the tool-call signal, before and after the call has returned: a
  background call never aborts, and a tool-call signal already aborted MUST NOT prevent the run.
- A foreground call's timeout deadline counts from the run's start and is the timeout of
  Section 1, using that section's default when `timeout` is omitted. A background call has a
  deadline only when `timeout` is present.
- `background: true` returns immediately (`isError` unset) with the text
  `Script started in background (taskId <taskId>).\nTool calls, if the script makes any: <toolLogPath>`
  and `details` `{ taskId, outputPath, background: true, exitReason: "running", stdout: "",
  stderr: "", truncated: { stdout: false, stderr: false }, durationMs: 0, toolCalls: 0 }`.
  `<toolLogPath>` is the path of Section 8.4, named whether or not the log is ever created. In
  both deliveries, the row settles with the Section 5 body as its result text and `outputPath` as
  its `resultPath`.
- In both foreground and background delivery, captured output is appended to `outputPath` as it
  arrives, stdout and stderr chunks interleaved in arrival order without labels. On settlement, the
  `\n--- return ---` block, the `\n--- return json ---` section when Section 5 adds it, and the
  `\n--- exited`, `\n--- killed by the user from the task browser ---`, `\n--- tool calls` and
  `\n--- return metadata ---` blocks of Section 5 are appended to `outputPath`, in that order. The
  `Full return value` line is not appended.
- The output file, `outputPath`, is `<dir>/output/<safeTaskId>.log`, where `<dir>` is the agent
  directory of the session that invoked the task ([agent-tool.md](agent-tool.md), Section 4.2) and
  `<safeTaskId>` is the safe name of that section applied to the task ID. A tool writing the file
  MUST create `<dir>/output/`, and `<dir>` itself when it is absent. The file lives inside `<dir>`
  and is deleted only with it, by the retention sweep ([agent-tool.md](agent-tool.md), Section 10).
- A failure to create or write `outputPath` MUST NOT fail the call, and no failure is reported.
- Output path hint. When a `read` tool result has `isError` `true`, its text contains `ENOENT`, and
  the base name of its `path` argument is `<safe>.log`, where `<safe>` is one or more characters of
  `A–Z`, `a–z`, `0–9`, `.`, `_`, and `-`, the hook MUST search for files of exactly that base name
  under the search root of the session that made the call, as follows:
  - The search root is, for the main session, the directory `PI_DENT_SESSION_DIR` names in the
    process environment, when that variable is set; for a child session, the child's agent
    directory ([agent-tool.md](agent-tool.md), Section 4.2). With no root, the hook does nothing.
    The search MUST NOT walk outside the root.
  - The hook is registered for the main session and for every child session.
  - The search visits the root, and each subdirectory whose name ends in `.agents` or is `output`,
    recursively. It MUST NOT enter any other directory and MUST NOT follow a symbolic link. The root
    is at depth 0; a subdirectory is one level deeper than its parent.
  - The search counts each directory entry it reads, in every visited directory. When the count
    exceeds 10000, or a directory deeper than 16 would be visited, the search stops and the result
    is unchanged.
  - A match is a regular file of that base name directly inside a visited `output` directory.
  - When exactly one match exists, the last text part's text MUST gain `\n` followed by
    `Did you mean <path>?`, `<path>` being the match's absolute path. With zero or several matches,
    the result is unchanged.
  - The hook MUST NOT throw, and MUST NOT change the result of any other tool or of a `read` result
    that is not such an error.
- Inspection and cancellation go through the `Task` tool ([task-tool.md](task-tool.md)); the task
  browser's kill key cancels through the same handler ([task-browser.md](task-browser.md),
  Section 4.4), and the body names a browser kill (Section 5). The task row's cancellation handler
  terminates the worker and its spawned process tree per the termination rule above
  (`exitReason: "killed"`).
- The task settles `cancelled` when `exitReason` is `killed` or `aborted`, `failed` when it is
  `timeout` or `threw`, and `completed` otherwise.
- Child processes spawned by a script are owned by the host runtime; their termination follows the
  worker termination rule above. `Bash` `background: true` ([bash-tool.md](bash-tool.md),
  Section 6) keeps a command running beyond a tool call. A child process spawned with an `env`
  option the script passes that does not name `PI_DENT_SESSION_DIR` MUST still receive the script's
  `PI_DENT_SESSION_DIR` ([agent-tool.md](agent-tool.md), Section 4.2), when set; likewise each of
  `TMPDIR`, `TMP` and `TEMP` that the worker's `process.env` holds and that `env` option does not
  name. A call to `spawnSync`, `execSync`, or `execFileSync` MUST throw an error inside the script;
  uncaught, it settles the run with `exitReason: "threw"`.
- A child process a script spawns MUST NOT receive the host process's standard streams. When its
  `stdio` option is `"inherit"`, or an element of it is `"inherit"`, a numeric file descriptor
  `0`, `1`, or `2`, or the worker's `process.stdin`, `process.stdout`, or `process.stderr`, the
  tool resolves each such element before the spawn: stdin to `"ignore"`, stdout and stderr to
  pipes whose chunks the run appends to its captured output as they arrive, in arrival order,
  like the worker's own writes. A `stdio` element that names a different file descriptor or an
  already-open file passes through unchanged. The resolution applies to `spawn`, `exec`,
  `execFile`, and `fork`, `fork` with `silent` unset or `false` included, whose stdio is
  otherwise inherited. The child's standard streams are therefore never a terminal.

## 7. Configuration

The root key `script` of the configuration file ([config-file.md](config-file.md), Section 2)
configures the `Script` tool:

| Key                    | Type      | Contract                                                                                                            |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| `script`               | object?   | The `Script` options.                                                                                               |
| `script.network`       | object?   | Reserved network options (validated and accepted; no network filter is enforced while scripts run in Node workers). |
| `script.network.allow` | string[]? | Reserved host-name allowlist (validated as a string array; ignored at run time while scripts run in Node workers).  |
| `script.tools`         | object?   | The tool function options.                                                                                          |
| `script.tools.allow`   | string[]? | Names of the tools a script may call (Section 8.1), compared case-sensitively. Default: `["*"]`.                    |

A `script`, `script.network`, or `script.tools` value that is not an object, and an `allow` that
is not an array of strings, MUST produce one diagnostic naming its layer file
([config-file.md](config-file.md), Section 4) and be ignored, so the default applies. Unknown
keys follow the unknown-key rule ([config-file.md](config-file.md), Section 2). The key loads and
merges per [config-file.md](config-file.md), Sections 3 and 7: arrays replace, so a layer
declaring `allow` replaces every lower layer's list whole.

## 8. Tool functions

A script calls the session's other tools through typed functions, one per tool, and never by
passing a tool name as a string. The host gives a running tool the callable tools: the list of
tools it can run on the session's behalf, each with a `name`, a `description`, a `parameters`
JSON Schema, and optionally an `outputSchema` JSON Schema. The host also gives it a function that
runs one callable tool by name with an arguments object, through the same argument validation,
hooks, and permission checks as a call the model issues, and that resolves, without rejecting, to
the tool's result (`content`, `details`, optional `structuredContent`) and an `isError` flag. A
call made that way is a nested call.

### 8.1 Bound tools

- The tool reads the callable tools once per call, after the checks of Section 2 have passed. The
  bound tools are the callable tools of that reading, without:
  - the tool named `Script`;
  - a tool whose name matches no entry of `script.tools.allow` (Section 7). An entry matches a
    name equal to it; an entry ending in `*` matches every name that starts with the text before
    the `*`, so the entry `*` matches every name;
  - a tool whose `parameters` is not an object with `type` equal to `"object"` (an unbindable
    tool).
- The tool registration MUST set the host's `reachesTools` field so that every `Script` call is
  reported as reaching all tools.

> Note (non-normative): `reachesTools` lets an extension that registers tools late, such as one
> whose servers are still connecting, finish before the callable tools are read.

### 8.2 Tool declarations

The tool declarations are one TypeScript text, lines joined by `\n`, with a final `\n`. They are
these lines verbatim, with `<members>` and `<unbound>` replaced as below:

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | { readonly type: "other"; readonly kind: string };
type ToolResult<S = undefined> = {
  readonly text: string;
  readonly content: readonly ToolContent[];
  readonly details: Json | undefined;
  readonly structured: S;
};
declare const tools: {
<members>
};
<unbound>
```

- `<members>` is one member per bound tool, in ascending order of name. A member is, when its
  doc text is not empty, the line `  /** <doc> */`, then the line
  `  readonly <key>: (args: <A>) => Promise<<R>>;`. With no bound tool, the `<members>` line is
  absent.
  - `<doc>` is the tool's `description` up to its first line break (`\r\n`, `\r`, or `\n`), with
    leading and trailing white space removed, every `*/` replaced by `* /`, cut to its first 200
    characters (no marker).
  - `<key>` is the tool's name when it matches `[A-Za-z_$][A-Za-z0-9_$]*`, else the name as a
    JSON string literal.
  - `<A>` is the type text of `parameters`.
  - `<R>` is `ToolResult` when the tool has no `outputSchema`, else `ToolResult<<S>>`, `<S>`
    being the type text of `outputSchema`.
- `<unbound>` is one line per unbindable tool that is not `Script` and matches
  `script.tools.allow`, in ascending order of name:
  `// not bound: <name>: parameters is not an object schema`. With no such tool, the line is
  absent.

The type text of a schema is given by the first row of this table that applies. A `$defs` or
`definitions` name is looked up in the root schema, the tool's `parameters` or `outputSchema`, and
is all the text of the `$ref` after `#/$defs/` or `#/definitions/`, taken as written with no
unescaping. A schema is being typed from the moment a `$ref` names it until its type text is
complete, so a schema that refers to itself, directly or through others, meets the second `$ref`
row. In every row, an `enum`, `anyOf`, `oneOf`, `allOf`, or `type` array that is empty, and an
`enum`, `anyOf`, `oneOf`, or `allOf` that is not an array, counts as empty; a `properties` that is
not an object, an array included, counts as absent.

| Schema                                                                                    | Type text                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `false`                                                                                   | `never`                                                                                                                                                                                                |
| `true`, or a value that is not an object: `null` and an array included                    | `Json`                                                                                                                                                                                                 |
| has `$ref` equal to `#/$defs/<n>` or `#/definitions/<n>`, naming a schema not being typed | The type text of the named schema.                                                                                                                                                                     |
| has any other `$ref`: another form, a missing name, or a schema already being typed       | `Json /* unsupported: $ref */`                                                                                                                                                                         |
| has `const`                                                                               | The literal of the value.                                                                                                                                                                              |
| has `enum`                                                                                | The union of the literals of its values; `never` when empty.                                                                                                                                           |
| has `anyOf` or `oneOf` (`anyOf` when both)                                                | The union of the type texts of its members; `never` when empty.                                                                                                                                        |
| has `allOf`                                                                               | The type texts of its members, each in parentheses when it is a union, joined by an ampersand with one space on each side; `Json` when empty; a single member's type text unchanged when there is one. |
| has `type`, an array                                                                      | The union of the type texts of the schema with `type` replaced by each entry in turn, each computed without the unsupported marker below; `never` when empty.                                          |
| `type` is `"string"`, `"boolean"`, or `"null"`                                            | `string`, `boolean`, `null`.                                                                                                                                                                           |
| `type` is `"number"` or `"integer"`                                                       | `number`                                                                                                                                                                                               |
| `type` is `"array"`                                                                       | `<T>[]`, `<T>` being the type text of `items`, in parentheses when it is a union or an intersection; `Json[]` when `items` is absent.                                                                  |
| `type` is `"object"`, with `properties`                                                   | `{}` when `properties` is empty, else `{ <p>; <p> }`, one `<p>` per property in the schema's order: `<key>: <T>` when `required` names it, else `<key>?: <T>`.                                         |
| `type` is `"object"`, without `properties`                                                | `{ [key: string]: <T> }`, `<T>` being `never` when `additionalProperties` is `false`, `Json` when it is absent, else its type text.                                                                    |
| any other schema                                                                          | `Json`                                                                                                                                                                                                 |

- A literal is the value's JSON text when the value is `null`, a boolean, a number, or a string,
  and `Json` otherwise.
- A union is its member type texts joined by a vertical bar with one space on each side, a member
  that is an intersection in parentheses; a member text equal to an earlier one is dropped, and a
  union of one member is that member.
- A property `<key>` follows the member `<key>` rule above.
- A schema with `type` `"object"` and `properties` has a closed type: `additionalProperties` adds
  no index signature.
- When the schema whose type text a row gives has one of the keywords `not`, `if`,
  `prefixItems`, `patternProperties`, `propertyNames`, `dependentSchemas`, `contains`,
  `unevaluatedProperties`, or `unevaluatedItems`, or has both `properties` and an
  `additionalProperties` other than `false`, the type text is followed by
  ` /* unsupported: <keywords> */`, `<keywords>` being those keywords in the order of this
  sentence, `additionalProperties` last, joined by a comma and a space. The marker follows the
  whole type text of that schema: for a `type` array, the union, once; for a `$ref` of the first
  `$ref` row, the named schema's type text, markers of its own included. Every other keyword
  leaves the type text unchanged.

The tool declarations are a reference for whoever writes the script: the tool MUST NOT
type-check a script against them, and a script that misuses a tool function fails at run time
(Section 8.3).

> Note (non-normative): the declarations can be narrower or wider than the schema where a marker
> says so; the host's validation of the arguments at call time (Section 8.3) is what holds.

### 8.3 Calling a tool

- `tools` is a frozen object whose own enumerable properties are the bound tools' names, in the
  order of the tool declarations, each a tool function. A tool function takes one argument,
  `args`, and returns a promise.
- A tool function settles by the first of these steps that applies, in foreground and
  background delivery alike:
  1. When `args` is not a plain object that is JSON-compatible (Section 5), it rejects with an
     `Error` whose message is `tools.<name> args must be a JSON-compatible object`.
  2. It starts a nested call of the tool with `args`. When the nested call's `isError` is true,
     it rejects with an `Error` whose `name` is `ToolError` and whose message is the result's
     text, or `tool <name> failed` when that text is empty.
  3. When the tool has an `outputSchema`, and the result has no `structuredContent`, or one that
     does not validate against the `outputSchema`, or the `outputSchema` is one the validator
     cannot evaluate, it rejects with an `Error` whose message is
     `tool <name> returned structured content that does not match its output schema`.
  4. It resolves to a frozen object of the `ToolResult` shape (Section 8.2).
- The result's text is the `text` of the text parts of `content`, joined by `\n`. The resolved
  object has:
  - `text`: the result's text;
  - `content`: one `ToolContent` per part of the result's `content`, in order. A part with
    `type` `"text"` and a string `text`, or with `type` `"image"` and strings `data` and
    `mimeType`, is reduced to those fields. Any other part becomes `{ type: "other", kind }`,
    `kind` being the part's `type` when that is a string, else the empty string;
  - `details`: `JSON.parse(JSON.stringify(details))`, and `undefined` when `details` is
    `undefined`, or `JSON.stringify` throws or returns `undefined`;
  - `structured`: the `structuredContent` when the tool has an `outputSchema`, else `undefined`.
- A script can have several nested calls running at once; the tool starts each when its tool
  function is called, and the host orders them.
- A nested call runs inside the run's deadline (Section 6). At settlement the tool MUST abort
  the signal it gave every nested call still running, MUST NOT wait for them, and MUST drop their
  outcomes.
- A nested call of a tool that has left the callable tools since they were read fails as the host
  reports it, by step 2.
- The host attaches a record of the nested calls to the `Script` call's result only for calls
  made before that result is returned; the nested calls of a background run, made after its
  call has returned, are in the tool log (Section 8.4) and in no record of the host's.

### 8.4 Tool log

The tool log of a run is a session file that records the run's source and every nested call,
so that `Search` reads it like the session file of an `Agent` dispatch.

- Its path, `<toolLogPath>`, is `<dir>/script-<safeTaskId>.jsonl`, `<dir>` and `<safeTaskId>`
  being those of the output file (Section 6). It lies in the agent directory of the invoking
  session, so it is a member of that session's session tree
  ([session-transcript.md](session-transcript.md), Section 4).
- The tool MUST create the tool log when the run starts its first nested call, before the call
  is started, creating `<dir>` when absent; a run that makes no nested call creates none. The
  log is deleted only with `<dir>`, by the retention sweep ([agent-tool.md](agent-tool.md),
  Section 10).
- Each line is one JSON object followed by a line feed, written in this order:
  1. The session header: `type` `"session"`, `id` the task ID, `timestamp` the run's start as an
     [RFC 3339] date-time in UTC, and `cwd` the run's resolved `cwd`.
  2. One `message` entry whose `message` is `{ role: "user", content: <source> }`, `<source>`
     being the row's `code` ([task-registry.md](task-registry.md), Section 2).
  3. Per nested call, when the tool starts it, one `message` entry whose `message` has `role`
     `"assistant"` and `content` `[{ type: "toolCall", id: <callId>, name: <name>, arguments:
     <args> }]`, `<name>` being the tool's name and `<args>` the arguments the script passed.
  4. Per nested call, when it settles, one `message` entry whose `message` has `role`
     `"toolResult"`, `toolCallId` `<callId>`, `toolName` `<name>`, the result's `content` and
     `details` as the host returned them, and `isError` the outcome's `isError`. A nested call
     still running when the run settles is logged as settled at that moment, with `content`
     `[{ type: "text", text: "aborted: the script run settled" }]` and `isError` `true`. A
     nested call the host fails to run, rejecting instead of resolving to an outcome, is logged
     with `content` `[{ type: "text", text: <message> }]`, `<message>` being the rejection's
     message, and `isError` `true`.
- `<callId>` is `call-<k>`, `<k>` counting the run's nested calls from `1` in the order they
  start. Entries of several nested calls interleave in the order of these events.
- Every entry other than the header carries `type`, an `id` unique in the file and usable
  ([session-transcript.md](session-transcript.md), Section 1), a `parentId` equal to the `id` of
  the entry on the line before it (`null` for the first entry after the header), and a
  `timestamp` of the moment it is written, as an [RFC 3339] date-time in UTC.
- A nested call counts toward `toolCalls` and the `--- tool calls` block of Section 5 when it
  starts, whether or not the log could be written.
- A failure to create or write the tool log MUST NOT fail the run or the call. The first such
  failure of a run appends the line `pi-dent: tool log write failed: <message>` to the run's
  `stderr`, `<message>` being the error's message, and the tool writes no further line to that
  log. When the failure was the creation, `details.toolLogPath` is absent, and the
  `--- tool calls` block of Section 5 still names `<toolLogPath>`.

## 9. Normative references

- [RFC 3339]: Date and Time on the Internet: Timestamps, Section 5.6, for the `timestamp` of a
  tool log header and entry.

## 10. Specification gaps

- The size of a tool log is unbounded: results, image data included, are written as the host
  returned them.
- Whether the host can open a tool log as a session of its own, beyond what `Search` reads
  ([session-transcript.md](session-transcript.md)), is unspecified.
- The dialect of JSON Schema the host's tools use, and so the meaning of a keyword whose meaning
  differs between dialects, is unspecified; Section 8.2 reads the keywords it names and no other.
- Which tools the host makes callable, how it validates arguments, which hooks and permission
  checks it applies to a nested call, its error texts, and how it orders concurrent nested calls
  are the host's.
- What the host records of a nested call, in the transcript and in its events, is the host's.
- The number of nested calls one run can make has no specified bound.
- The texts of pre-start rejections beyond what Section 2 requires, and the `details` of a
  pre-start rejection, are unspecified.
- A body whose top level uses the identifier `arguments` can have the completion value
  `undefined` (Section 4); which such bodies do is unspecified.
- The grace periods of Section 6 use host timers; delays in servicing those timers, and in
  starting worker termination after draining, have no specified upper bound.
- Windows: the termination of a script's spawned process tree (Section 6) is unverified, the
  claim "including on Windows" included; `SIGTERM` and `SIGKILL` have no Windows form, so
  whether the tree is terminated, and within the bounds stated there, is unspecified.
- Whether a child of the tree is reaped (Section 6) when the script blocks its thread in a system
  call that the worker's termination cannot interrupt — a read from a pipe with no writer, say — is
  unspecified.
- A child of the tree that exits more than 100 ms after the `SIGKILL` of Section 6 — one stuck in
  uninterruptible I/O, say — dies after the worker's drain has ended, so whether it leaves the
  host's process table before the worker is terminated is unspecified.
- An `input` object that is not JSON-compatible is unspecified: neither the schema nor the tool
  checks it, so whether such a call fails, and how, is the worker's structured clone's.
- Whether the host, when it validates against the schema of Section 1, first coerces an argument
  to the type the schema names, and so whether a convertible value of the wrong type is admitted
  rather than rejected as a schema rejection, is the host's.
- A returned value of the last row of Section 5's rendering table renders as Node.js `util.inspect`
  with default options; that output varies between Node.js versions, so the exact text for a given
  value is unspecified.
- A script that catches the error `process.exit` throws (Section 3) keeps running until the worker
  is terminated, after the run has settled; what it does in that time, and how far it gets, is
  unspecified.
