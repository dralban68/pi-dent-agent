# `Script` tool specification

This document specifies the `Script` tool: sandboxed execution of agent-authored JavaScript or
TypeScript, its sources, inputs, results, timeout, and delivery. The plugin script it can read is
owned by [plugin.md](plugin.md). The extension MUST register the tool through the host
`registerTool` API with `name` and `label` `"Script"`; the host shows a call as a tool card
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
| `cwd`         | string?  | Working directory the script's paths resolve against (Section 4): the `cwd` parameter ([task.md](task.md), Section 1.1).                    |
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
- An `input` that is not JSON-compatible per Section 6; the failure text is verbatim
  `input must be JSON-compatible`.
- A `plugin` that the plugin catalog does not have ([plugin.md](plugin.md), Section 8).
- With a plugin source, a `path` that does not match the plugin script path pattern of
  [plugin.md](plugin.md), Section 1, or that does not resolve to a contained path
  ([plugin.md](plugin.md), Section 7; root: the plugin root).
- A plugin script file that is missing at call time ([plugin.md](plugin.md), Section 7); the
  failure MUST name the resolved path.

The plugin script file MUST be read fresh at call time per [plugin.md](plugin.md), Section 8.

## 3. Execution model

- A call runs one script as the guest of a sandbox: a QuickJS interpreter compiled to
  WebAssembly, hosted in one worker thread of the host process. The worker is a lifecycle
  boundary; the sandbox is the security boundary. The guest has no Node built-in, no npm
  package, no file-system binding, no process object, no timer, and no child process: every
  effectful operation is one host function of Section 4, which checks its permission before it
  acts and reports a refusal as an error. No external runtime binary is invoked.
- The guest sees the ECMAScript builtins its engine provides, and nothing else ambient: there is
  no `URL`, `AbortController`, `crypto`, `TextEncoder`, `TextDecoder`, `process`, or `require`.
  The host pre-binds `console`, `fetch` (Section 4), the `dent` namespace (Section 4), and
  `input`.
- ESM semantics and TypeScript syntax MUST work with no build step. TypeScript is accepted with
  erasable syntax only: a construct whose removal changes runtime behavior — an `enum`, a
  namespace with runtime code, a parameter property — fails the run with the error text
  `type stripping failed: <message>`, `<message>` being the stripper's message. A stripping
  failure settles the run as any other error (Section 3, below).
- There is no module resolution: a static `import` or `export … from` declaration fails to
  resolve, and the run settles `threw` with the engine's error. A source the host cannot compile
  settles the run the same way.
- Every call compiles its script afresh in a new sandbox: no module instance, no guest state, and
  no host-function memoization is carried across calls.
- `input`, when provided, reaches the script as the top-level `input` binding and
  `globalThis.input`, serialized to JSON and deserialized into the guest. For a plugin script,
  omitted `input` leaves `input` `undefined`; a plugin script
  conventionally treats that as a help request and returns structured help. Explicit `input: {}`
  is execution input. Inline `code` has no help convention.
- The guest runs to completion, top-level `await` included; promise jobs the guest schedules
  advance while the run is live. The guest MUST NOT outlive its run: at settlement the tool
  terminates the sandbox outright (Section 6), and code the script registers afterwards never runs.
- `console.log`, `console.debug`, and `console.info` are captured as `stdout`, `console.warn` and
  `console.error` as `stderr`; each stream is capped at 1 MiB (`1048576` bytes) of its text
  encoded as UTF-8: the first chunk that would exceed the cap is cut at the cap on a character
  boundary and followed by the truncation marker `\n... [truncated] ...\n`, later output of that
  stream is dropped, and the stream is reported in `details.truncated`
  (`{ stdout: boolean, stderr: boolean }`).
- Limits. The enforced bounds live outside the engine:
  - The tool consults the engine's interrupt handler at least every 50 ms, and the engine's heap
    is capped at `536870912` bytes. An engine-level exhaustion or interruption settles the run
    `threw` or `timeout` respectively with the engine's error text. The engine's enforcement of
    both is best-effort; the bounds the tool guarantees are the next two.
  - The hosting worker runs with a V8 old-generation limit of `1024` MiB. A worker that dies
    settles the run `threw` with the message `script worker exited unexpectedly (code <code>)`.
  - A foreground call's deadline is the `timeout` of Section 1, counted from the run's start; the
    tool settles `timeout` no later than `1000` ms after that deadline, terminating the sandbox
    outright if the guest has not stopped. A background call has a deadline only when `timeout`
    is present, with the same `1000` ms bound.
- A thrown error or unhandled rejection settles the run with `exitReason: "threw"`, formatting
  the error's `name`, `message`, and `stack` as strings; nested `cause` chains are not
  propagated. The error text — the `stack`, preceded by the line `<name>: <message>` when the
  `stack` has no such line — is appended to `stderr` at settlement, on a new line, and is not
  otherwise written to `stderr`.

## 4. Host functions

The host functions are the guest's only effectful surface. Each is a method of the frozen global
`dent`, except `fetch`, which is a global of its own. A `path` or `name` argument that is not a
string throws `dent.<function> <argument> must be a string`. A host function's failure — a
refusal below, an I/O error, a missing file — throws an `Error` whose message is the failure's
text; a guest `try`/`catch` sees it like any error.

- `dent.readFile(path)` returns the file's text, decoded as UTF-8 with byte sequences that are
  not valid UTF-8 replaced; reading a directory fails with the host's error.
- `dent.writeFile(path, text)` writes `text` encoded as UTF-8, replacing the file's content and
  creating it when absent, without creating intermediate directories.
- `dent.appendFile(path, text)` appends `text` encoded as UTF-8, creating the file when absent.
- `dent.mkdir(path)` creates the directory and every missing intermediate.
- `dent.list(path)` returns the entry names of the directory, as an array of strings, in the
  order the host file system reports.
- `dent.stat(path)` returns `{ size, mtimeMs, isFile, isDirectory }` for a file or directory, and
  `undefined` when no file system entry is at `path`.
- `dent.env(name)` returns the value of the environment variable `name`, or `undefined`.
- `dent.tmpDir()` returns the session temporary folder
  ([bash-tool.md](bash-tool.md), Section 3), or `undefined` when the session has none.
- `fetch(url, init)` fetches a URL. `url` is a string. `init`, when present, is an object whose
  `method`, `headers`, and `body` are honored: `method` a string defaulting to `"GET"`,
  `headers` an object of string names and values, `body` a string. It resolves to a frozen
  response object with `ok`, `status`, `statusText`, `url` (the final URL, after redirects), and
  `headers` (a plain object), and with `text()` resolving the body decoded as UTF-8 with invalid
  sequences replaced, `json()` resolving `JSON.parse` of that text, and `arrayBuffer()`
  resolving a `Uint8Array` of the body's bytes. Redirects are followed to a limit of five
  responses.

Path rules, applied by every `dent` function that takes a `path`:

- A path is resolved host-side: relative against the call's `cwd` (Section 1), a leading `~`
  against the user's home directory. The guest sees no path rewriting.
- A read (`readFile`, `list`, `stat`) is allowed at any path on the local file system.
- A write (`writeFile`, `appendFile`, `mkdir`) is allowed only when the target's real path, with
  symbolic links resolved, lies inside the real path of the `cwd`, or inside the session
  temporary folder. A write outside both is refused with the verbatim text
  `path is outside the write allowlist: <path>`, `<path>` being the argument as given.
- A fetch is refused when the URL's host name does not match an entry of the `script.network.allow`
  configuration (Section 8), compared case-insensitively; the entry `*` matches every host. The
  refusal text is verbatim `fetch to <host> is not allowed`, `<host>` being the URL's host name.
  Each redirect hop is checked the same way; a refused hop fails the fetch with the same text,
  naming the refused hop's host.

## 5. Module contract

- A script declares its return value with a top-level default export (`export default <expr>`).
- Without a default export, the return value is the module body's completion value; it is
  `undefined` when the body contains top-level `await` or does not end with an expression
  statement. Top-level `await` is an `await` expression or a `for await` statement outside every
  function and class body; the word `await` in a comment, a string, a template, a regular
  expression, or a nested function does not make the completion value `undefined`. A body whose
  top level uses the identifier `arguments` MAY have the completion value `undefined`. A missing default export MUST NOT fail the run.
- A script can declare `const`, `let`, `var`, `function`, or `class` for a pre-bound name
  (Section 3), shadowing that binding; with no default export, a script declaring `var` for such
  a name has the completion value `undefined`.
- A return value that cannot be converted to a host value degrades, without failing the run, to
  the string `<non-convertible: <error>>`, `<error>` being the string form of the conversion
  error; that string is then the return value.

## 6. Result contract

- The foreground body (`content[0].text`) is `stdout`, then `\n--- stderr ---\n<stderr>` when
  `stderr` is non-empty, then `\n--- return ---\n<rendered>` when `exitReason` is `ok`, then
  `\nFull return value: <outputPath>` when the return json section applies (Section 6, below), then
  `\n--- exited <exitReason> in <durationMs>ms ---`, then
  `\n--- killed by the user from the task browser ---` when the run ended as a browser kill
  ([task-registry.md](task-registry.md), Section 2), then `\n--- return metadata ---\n<json>` when
  `exitReason` is `ok`. `<rendered>` is the return value
  rendered per the rendering rules below; `<json>` is `details.returnValueRender` serialized as
  single-line JSON.
- `details` carries `{ stdout, stderr, returnValue?, returnValueRender?, exitReason, truncated:
  { stdout, stderr }, durationMs, taskId?, outputPath, background? }`. `outputPath` is present
  for every call that starts a run (Section 7).
  `returnValue` and `returnValueRender` are present exactly when `exitReason` is `ok`. The run
  starts when the sandbox is created and ends at settlement; `durationMs` is the whole
  milliseconds between them, rounded down, and `0` when no run started.
- A value is JSON-compatible when it is `null`, a boolean, a finite number, a string, or an array
  or plain object whose members are all JSON-compatible; an array with missing elements (a hole)
  is not JSON-compatible.
- A JSON-compatible return value round-trips as `details.returnValue`, a non-convertible marker
  string (Section 5) included; any other return value, `undefined` included, uses
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
  `aggregateTruncated` `true`) has its full value appended to `outputPath` (Section 7) as one
  section, `\n--- return json ---\n<json>`, `<json>` being `JSON.stringify` of the value (single-line,
  unclipped). The section follows the `\n--- return ---` block and precedes the `\n--- exited`
  block. No other return value adds it, and the body does not carry the section. When
  `JSON.stringify` throws for a clipped value, the section does not apply: nothing is written, no
  `Full return value` line is added, and the run is unaffected. When the section applies, the body
  carries the line `Full return value: <outputPath>` after its `\n--- return ---` block: the body's
  only path to the full value. `details` has no path field for it. A failure to write `outputPath`
  MUST NOT fail the call, and no field reports it.
- `exitReason` is one of `running` (initial background return), `ok` (normal completion),
  `timeout` (deadline expired), `threw` (uncaught error), `killed` (`Task` `kill`), or `aborted`
  (tool-call signal). The call is an error (`isError: true`) unless `exitReason` is `ok` or
  `running`.

## 7. Timeout and delivery

- Every settled run MUST terminate its sandbox outright. No child process exists: there is no
  process tree to signal, and the tool MUST leave no engine worker, timer, or pending job running
  after termination. A foreground call MUST NOT move itself to the background.
- Except for the source-shape rejection of Section 2 and a call where [task.md](task.md),
  Section 1 registers no row, every call registers one task row (`kind: "script"`) after the host
  has accepted its arguments and the source shape, and before the remaining checks of Section 2, `label` set
  to `description` when Section 1 does not treat it as absent, else to `path` when Section 1 does
  not treat it as absent, else to the first line of `code` with its leading white space, line
  breaks included, removed, cut to 80 characters (no marker); task lifetime, cohort, and
  completion notification follow [task-registry.md](task-registry.md). The label MUST NOT be
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
- In a call that passes Section 2, a cancellation before the sandbox starts, and in a foreground
  call also an abort, a tool-call signal already aborted included, MUST prevent the run; the row
  settles with that outcome's `exitReason`, and its body is the `\n--- exited` block of Section 6
  alone. A background call so prevented still returns the background result below.
- A foreground call aborts when its tool-call signal aborts (`exitReason: "aborted"`). A
  background call MUST ignore the tool-call signal, before and after the call has returned: a
  background call never aborts, and a tool-call signal already aborted MUST NOT prevent the run.
- `background: true` returns immediately (`isError` unset) with the text
  `Script started in background (taskId <taskId>).` and `details` `{ taskId, outputPath,
  background: true, exitReason: "running", stdout: "", stderr: "", truncated: { stdout: false,
  stderr: false }, durationMs: 0 }`. In both deliveries, the row settles with the Section 6 body as its result text and `outputPath` as
  its `resultPath`.
- In both foreground and background delivery, captured output is appended to `outputPath` as it
  arrives, stdout and stderr chunks interleaved in arrival order without labels. On settlement, the
  `\n--- return ---` block, the `\n--- return json ---` section when Section 6 adds it, and the
  `\n--- exited`, `\n--- killed by the user from the task browser ---` and `\n--- return metadata ---`
  blocks of Section 6 are appended to `outputPath`, in that order. The `Full return value` line is not
  appended.
- The output file, `outputPath`, is `<dir>/output/<safeTaskId>.log`, where `<dir>` is the agent directory of the session that
  invoked the task ([agent-tool.md](agent-tool.md), Section 4.2) and `<safeTaskId>` is the safe
  name of that section applied to the task ID. A tool writing the file MUST create
  `<dir>/output/`, and `<dir>` itself when it is absent. The file lives inside `<dir>` and is
  deleted only with it, by the retention sweep ([agent-tool.md](agent-tool.md), Section 10).
- A failure to create or write `outputPath` MUST NOT fail the call, and no failure is reported.
- Output path hint. When a `read` tool result has `isError` `true`, its text contains `ENOENT`, and
  the base name of its `path` argument is `<safe>.log`, where `<safe>` is one or more characters of
  `A–Z`, `a–z`, `0–9`, `.`, `_`, and `-`, the hook MUST search for files of exactly that base name
  under the search root of the session that made the call, as follows:
  - The search root is, for the main session, the directory `PI_DENT_SESSION_DIR` names in the process
    environment, when that variable is set; for a child session, the child's agent directory
    ([agent-tool.md](agent-tool.md), Section 4.2). With no root, the hook does nothing. The search
    MUST NOT walk outside the root.
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
  Section 4.4), and the body names a browser kill (Section 6). The task row's cancellation handler
  terminates the sandbox outright (`exitReason: "killed"`).
- The task settles `cancelled` when `exitReason` is `killed` or `aborted`, `failed` when
  it is `timeout` or `threw`, and `completed` otherwise.

## 8. Configuration

The root key `script` of the configuration file ([config-file.md](config-file.md), Section 2)
configures the sandbox:

| Key                    | Type      | Contract                                                                                                                                     |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `script`               | object?   | The sandbox options.                                                                                                                         |
| `script.network`       | object?   | The network options.                                                                                                                         |
| `script.network.allow` | string[]? | Host names `fetch` may reach, exact match compared case-insensitively; the entry `*` allows every host. Default: `fetch` refuses every host. |

A `script` or `script.network` value that is not an object, and an `allow` that is not an array
of strings, MUST produce one diagnostic naming its layer file
([config-file.md](config-file.md), Section 4) and be ignored, so the default applies. Unknown
keys follow the unknown-key rule ([config-file.md](config-file.md), Section 2). The key loads and
merges per [config-file.md](config-file.md), Sections 3 and 7: arrays replace, so a layer
declaring `allow` replaces every lower layer's list whole.

## 9. Capability boundary

The guest's only effectful surface is the host functions of Section 4. The sandbox MUST expose no
binding through which a script can dispatch an agent, load a skill, call an MCP tool, run a
process, or reach the host's module system; it has no host bridge.

## 10. Specification gaps

- The engine's memory-limit enforcement is incomplete: several allocations escape it, so a guest
  can hold far more than its heap cap before the engine refuses (quickjs-emscripten issues #271
  and #255). The enforced bound is the hosting worker's V8 limit (Section 3); how much a guest can
  allocate past the engine cap before that limit, or the deadline, stops it is unspecified.
- The engine's interrupt handler is not consulted inside long-running built-ins, so a deadline can
  be exceeded before the guest stops on its own (quickjs-emscripten issue #219). The bound the
  tool guarantees is the `1000` ms termination of Section 3; the actual overshoot below it is
  unspecified.
- The engine's error texts — a compile failure, an import that cannot resolve, an engine heap
  exhaustion, an engine interruption — are the engine's and differ between engine versions; their
  exact texts are unspecified.
- Whether the guest engine exposes timers, `URL`, `TextEncoder`, `TextDecoder`, `crypto`, or
  `AbortController` is unspecified: the host pre-binds none of them (Section 3), and an engine
  that provides one changes what a script can call. A script MUST NOT rely on any of them.
- How a guest value converts to a host value (Section 5) is the engine's conversion: which values
  convert, and what a function, a symbol, or a proxy becomes, is the engine's and unspecified
  beyond the non-convertible degradation.
- A body whose top level uses the identifier `arguments` can have the completion value
  `undefined` (Section 5); which such bodies do is unspecified.
- The texts of pre-start rejections beyond what Section 2 requires, and the `details` of a
  pre-start rejection, are unspecified.
- A fetch whose URL host is an IP literal, or whose host name resolves differently for the host
  than for a redirecter (DNS rebinding), is matched by host name only (Section 4); the address a
  name resolves to is not checked, and that gap is unspecified further.
- A fetch response body is bounded only by the guest's heap (Section 4): whether a body larger
  than the engine cap fails the fetch, and how, is unspecified.
- Whether the host, when it validates against the schema of Section 1, first coerces an argument
  to the type the schema names, and so whether a convertible value of the wrong type is admitted
  rather than rejected as a schema rejection, is the host's.
- A returned value of the last row of Section 6's rendering table renders as Node.js `util.inspect`
  with default options; that output varies between Node.js versions, so the exact text for a given
  value is unspecified.
- Delays in servicing host timers — the interrupt consultation, the `1000` ms termination bound,
  the delivery of output chunks — have no specified upper bound.
