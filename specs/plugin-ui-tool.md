# `PluginUI` tool specification

This document specifies the `PluginUI` tool: the surface through which a session looks at a
plugin UI that the host application Alpha shows, by a screenshot (`shot`) or by a scripted run
with a report (`check`). The exchange with the host is owned by [plugin-ui.md](plugin-ui.md),
Sections 7 and 8; the plugin catalog by [plugin.md](plugin.md).

## 1. Registration and gating

- The extension MUST register `PluginUI` through the host `registerTool` API with `name` and
  `label` `"PluginUI"`, only when the host runs in RPC mode (`mode === "rpc"`) and the
  environment variable `PI_DENT_UI_INSPECT` equals `1`. Otherwise the tool MUST NOT be
  registered, so no model is offered a tool that nothing answers.
- A child session ([agent-tool.md](agent-tool.md), Section 3.1) binds `PluginUI` whenever the
  dispatching session's tool cap includes it, sharing the main session's inspection feed and
  single-inspection concurrency limit, with its own working directory and agent directory.
- The tool's description MUST say that `live: true` lets the page's writes reach the real
  system, and that a fixtures module replaces tool calls only (Section 5).

## 2. Parameter schema

The parameter schema is a JSON object schema with `type: "object"` and
`additionalProperties: false`:

| Field     | Type                | Actions | Contract                                                                                                   |
| --------- | ------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `action`  | `"shot" \| "check"` | all     | Required.                                                                                                  |
| `plugin`  | string              | all     | Required. A plugin namespace of the plugin catalog.                                                        |
| `steps`   | object[]? (max 100) | `check` | The steps (Section 4). Default `[]`.                                                                       |
| `tools`   | string?             | `check` | Path of the fixtures module (Section 5); a relative path resolves against the session's working directory. |
| `live`    | boolean?            | `check` | `true` passes the session's real tools to the plugin's scripts (Section 5). Default `false`.               |
| `timeout` | integer?            | `check` | The check limit in milliseconds, `1000` to `600000`. Default `120000`.                                     |

For schema-valid arguments the tool MUST check, in this order, and reject the first failure as a
tool error with the text given:

1. Another `PluginUI` call of this session still executing: `another PluginUI call is running`.
2. A field not valid for the action: `field "<field>" is not valid for action "<action>"`, the
   fields taken in the arguments' property order.
3. `plugin` blank or not in the plugin catalog ([plugin.md](plugin.md), Section 8):
   `unknown plugin "<plugin>"`.
4. `tools` together with `live: true`: `tools and live are mutually exclusive`.
5. A step that is not valid (Section 4): `steps[<i>]: <reason>`, `<i>` counting from 0.
6. More than 16 `screenshot` steps: `at most 16 screenshot steps`.
7. `tools` that does not name a readable regular file:
   `fixtures module not readable: <path>: <reason>`, `<path>` the resolved absolute path.
8. A fixtures module that fails to load or has the wrong shape (Section 5):
   `fixtures module not loaded: <reason>`.

## 3. Execution

- A call that passes Section 2 MUST create the output directory
  `<dir>/output/ui-<id>`, `<dir>` being the agent directory of the invoking session
  ([agent-tool.md](agent-tool.md), Section 4.2) and `<id>` the inspection id, and, for a
  `check` without `live: true`, the scratch state directory `<dir>/output/ui-<id>-state`.
  Both are created empty, before the record is emitted; a failure to create one fails the call
  as a tool error naming it.
- A UI inspection, and for a `check` its check, is in progress from the moment its record is
  emitted until it settles, below.
- The inspection id is `i<n>-<suffix>`, `<n>` counting the process's inspections from 1 and
  `<suffix>` 8 lowercase hexadecimal digits chosen at random.
- The tool MUST then emit one `shot` or `check` record on the inspection feed
  ([plugin-ui.md](plugin-ui.md), Section 7) and wait for the host's result
  ([plugin-ui.md](plugin-ui.md), Section 8).
- The wait limit is `45000` ms for a `shot`, and the check's `timeout` plus `30000` ms for a
  `check`. When it passes, the tool MUST emit a `cancel` record and fail the call with
  `Alpha did not answer the UI <action> within <n> ms`.
- When the tool-call signal aborts, the tool MUST emit a `cancel` record and settle the call as
  aborted.
- When the inspection settles, by a result, the wait limit, an abort, or `session_shutdown`, the
  tool MUST cancel every plugin UI call still executing for the check
  ([plugin-ui.md](plugin-ui.md), Section 3), terminate the check's fixtures worker (Section 5),
  and remove the scratch state directory. The output directory is kept; it lies inside `<dir>`
  and is deleted with it by the retention sweep ([agent-tool.md](agent-tool.md), Section 10).
- A result with `ok: false` fails the call as a tool error whose text is the result's `error`.
- A result with `ok: true` MUST be answered by reading `report.json` of the output directory. A
  report that cannot be read, or does not parse as an object whose `alpha` is `"inspect/1"`,
  fails the call with `UI report not readable: <reason>`.

## 4. Steps

A step is an object with exactly one member:

| Action       | Argument                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `click`      | A selector: a string of 1 to 4,096 characters, not only white space.                                                        |
| `type`       | `[selector, text]`, `text` a string; the element is an `input` or a `textarea`.                                             |
| `select`     | `[selector, value]`, `value` a string.                                                                                      |
| `wait`       | An integer from `0` to `60000`: milliseconds.                                                                               |
| `waitFor`    | A selector.                                                                                                                 |
| `scroll`     | A selector (a string), or an integer from `0` to `10000000`: a vertical offset in CSS pixels.                               |
| `eval`       | A JavaScript expression: a string of 1 to 65,536 characters, not only white space.                                          |
| `screenshot` | A name of 1 to 64 characters of `A–Z`, `a–z`, `0–9`, `_`, `-`; not `load`; unique in the call without regard to ASCII case. |

The tool validates the steps and passes them to the host unchanged. What each does in the page
is the host's: it carries them out in order inside the plugin frame, stops at the first that
fails, and writes a screenshot named `load` before the first step. A `scroll` step scrolls the
element into view, or the document to the offset, and its result is the document's scroll
position `{ x, y }` afterwards; a screenshot shows the frame's viewport only. The record's JSON text MUST
NOT exceed 262,144 bytes in UTF-8; a call whose record would is rejected with
`steps exceed <cap> bytes`, checked after Section 2, item 6.

## 5. Backend of a check

A check has one of three check backends, which decides what `tools.<Name>(args)` does in every plugin
UI call that carries the check's id ([plugin-ui.md](plugin-ui.md), Section 4.2):

| Backend    | Chosen by    | Tool functions                                                                                      |
| ---------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `fixtures` | `tools`      | Each name the fixtures module exports calls that export; every other name rejects as unavailable.   |
| `live`     | `live: true` | As in any plugin UI call ([plugin-ui.md](plugin-ui.md), Section 4.2): writes reach the real system. |
| `none`     | neither      | Every name rejects as unavailable.                                                                  |

- "Rejects as unavailable" is an `Error` whose message is
  `tool <Name> is unavailable in a plugin UI call`. `Script`, `AskUserQuestion` and `PluginUI`
  reject so in every backend, also when the fixtures module exports them.
- A backend replaces the tool functions and, with the scratch state directory, `dent.state`, and
  nothing else: a plugin script of a check runs with the caller's privileges in the session's
  working directory, and what it does to files, processes or the network by itself, without a
  tool, is the same in every backend.
- The fixtures module MUST default-export a plain object whose own keys are strings and whose
  values are functions; anything else is the wrong shape (Section 2, item 8).
- The fixtures module MUST be loaded once per check, in a worker of its own, the fixtures worker,
  when the call is validated, and MUST stay loaded until the check settles, so that a fixture can
  keep state between the calls of one check. It runs with the caller's privileges, as a `Script`
  call does ([script-tool.md](script-tool.md), Section 3).
- A fixture is called with `args` after the check of [script-tool.md](script-tool.md),
  Section 8.3, step 1. Its return value, awaited, is the tool function's result when it is an
  object with a string `text` and no key other than `text`, `content`, `details` and
  `structured`; any other value `v` becomes
  `{ text: JSON.stringify(v), content: [{ type: "text", text: JSON.stringify(v) }], details: undefined, structured: undefined }`.
  A fixture that throws or rejects rejects the tool function with an `Error` of the same message.
- In the backends `fixtures` and `none`, `dent.toolTypes()` returns the tool declarations
  ([script-tool.md](script-tool.md), Section 8.2) with no member and no unbound line.
- In the backends `fixtures` and `none`, `dent.state` and `dent.state.user` of the check's plugin
  UI calls are bound to the scratch state directory ([plugin-state.md](plugin-state.md),
  Section 6). In the backend `live` they are the plugin's own stores.
- The host is told neither the backend nor the fixtures module's path.

## 6. Result

- The result's text is the report rendered as `JSON.stringify(<report>, null, 2)`, after these
  changes to the object read from `report.json`: every screenshot file name (`screenshot`,
  `screenshots`, and the `result` of a `screenshot` step) replaced by its absolute path in the
  output directory; for a `check`, the member `backend` added (`"fixtures"`, `"live"` or
  `"none"`). A text longer than 20,000 characters is cut to its first 20,000 and followed by
  `\n... [truncated] ...`. The last line of the text, after one `\n`, is
  `Full report: <outputDir>/report.json`.
- After the text part, `content` carries one image part per screenshot, in the report's order,
  each `{ type: "image", data: <base64 of the file>, mimeType: "image/png" }`, while the files
  attached so far total at most 8,388,608 bytes. A screenshot not attached for that bound, or
  because its file cannot be read, is named in the text by one line before the `Full report`
  line: `Not attached: <path>: <reason>`, `<reason>` being `over the attachment bound` or the
  read failure's message.
- `details` carries `{ action, plugin, outputDir, reportPath, screenshots, ok }`: `screenshots`
  the absolute paths in the report's order; `ok` the report's `summary.ok` for a `check` and
  `true` for a `shot`.
- A `check` whose report has `summary.ok` `false` is a successful call (`isError` unset): the
  tool worked, and the report says what failed.

## 7. Specification gaps

- What a step does in the page, the layout of the report, and every `error` text of the host are
  the host's.
- A `cancel` record whose `setWidget` call fails is not sent again: the host then carries its
  inspection on to its own limit.
- The attachment bound is a first value; no provider limit was measured.
