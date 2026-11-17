# Task tool specification

This document specifies the `Task` tool: the uniform surface for listing, reading output from,
and cancelling tasks owned by the current session. The task is owned by [task.md](task.md); the
task row, task registry, and completion notification by [task-registry.md](task-registry.md);
how a task runs, produces output, and cancels is
owned by the tool that registered it ([agent-tool.md](agent-tool.md),
[script-tool.md](script-tool.md), [bash-tool.md](bash-tool.md)).

## 1. Tool registration surface

The extension MUST register the `Task` tool through the host `registerTool` API:

| Field         | Value                               |
| ------------- | ----------------------------------- |
| `name`        | `"Task"`                            |
| `label`       | `"Task"`                            |
| `renderShell` | `"self"`                            |
| `parameters`  | The parameter schema of Section 1.1 |

### 1.1 Parameter schema

The parameter schema is a JSON object schema with `type: "object"` and
`additionalProperties: false`:

| Field     | Type                                              | Contract                                                                                                                                                             |
| --------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`  | `"read" \| "kill" \| "list" \| "wait"` (required) | Operation to perform on the session's task registry.                                                                                                                 |
| `taskId`  | string?                                           | Target task ID. Required when `action` is `"read"`, `"kill"`, or `"wait"`; MUST be omitted when `action` is `"list"`.                                                |
| `timeout` | integer?                                          | How long `wait` blocks, in milliseconds, `1` or more; omitted gives `600000`; above `2147483647` imposes no deadline. MUST be omitted when `action` is not `"wait"`. |

The schema gives `taskId` the `pattern` `\S`: at least one character that is not white space.

The host validates the call's arguments against the schema of this section before the tool runs,
and rejects a call whose arguments do not satisfy it ([task.md](task.md), Section 1). `Task`
registers no task row ([task.md](task.md), Section 1), so a schema rejection is a tool error
whose text is the host's.

The checks the schema cannot express MUST reject the call as a tool error (`isError: true`),
checked in this order, the first failure reported:

- `taskId` provided when `action` is `"list"`.
- `taskId` absent when `action` is `"read"`, `"kill"`, or `"wait"`.
- `timeout` provided when `action` is not `"wait"`.
- `taskId` naming no task owned by the invoking session.

## 2. Operations

Every operation except the blocking `wait` of Section 2.4 is non-blocking and scoped strictly to
the task registry of the invoking session ([task-registry.md](task-registry.md), Section 1).

### 2.1 `read`

Returns a point-in-time snapshot of `taskId`:

- While `status` is `"running"`: returns the `line` of each progress projection entry, one line each, or
  `(running, no output yet)` when it is empty.
- While `status` is `"interrupted"`: returns the single line
  `(interrupted, resume with Agent resume=<taskId>)` and MUST NOT `consume` the row.
- When `status` is `"completed" | "failed" | "cancelled"`: returns the row's settled result
  text — verbatim while the row carries no `resultPath`; with one, the preview: the first
  10 and last 10 lines of the text (all lines, with no omission line, when it has at
  most 20), each line cut to its first 120 characters (no marker), except on a `bash` row a line
  that is exactly one of the header forms of [bash-tool.md](bash-tool.md), Section 4, with this
  row's `<resultPath>`, which is returned whole; one `[... <n> lines omitted ...]` line between
  the groups; and a final `Full output: <resultPath>` line, present exactly when no line of the
  preview is such a header line. A read of a rebuilt row previews its `resultPath` file text
  by this same rule.
  A rebuilt row carries no `result` ([task-record.md](task-record.md), Section 3): its text is
  the content of the `resultPath` file when it carries one, and otherwise the single line
  `(result not retained; resume with Agent resume=<taskId>)`.
- When a settled row carries no `result` and its preview needs the text of its `resultPath`
  file, and that file cannot be read, the call MUST return a tool error whose text is
  `cannot read the result file <resultPath>: <error>`, `<error>` being the `message` of the
  error the read threw, or that error converted to a string when it carries no string
  `message`. Such a read MUST NOT `consume` the row.
- Every read that is not an error MUST carry `details` `{ action: "read", taskId, status, resultPath? }`.
  A read of a settled and not `interrupted` row that returns the row's text MUST also `consume` the
  row.

### 2.2 `kill`

Invokes the task row's cancellation handler and MUST `consume` the row, whatever its status:

- If the task is `"running"`, the call requests cancellation and returns immediately with
  `status: "running"`; settlement is asynchronous ([task-registry.md](task-registry.md),
  Section 3).
- If the task has already settled, `kill` is a no-op on its outcome.
- A running row without a cancellation handler is left running.
- The text is `Task <taskId> kill requested (<status>).`, `<status>` being the row's status when
  the call returns.
- `details` MUST carry `{ action: "kill", taskId, status }`.

### 2.3 `list`

Returns all task rows owned by the invoking session in registration order:

- One summary line per task: `<taskId> · <status> · <label>`, where `<label>` is the display
  label ([task-registry.md](task-registry.md), Section 2). When the session owns no tasks, the
  result is the single line `(no tasks)`.
- `details` MUST carry `{ action: "list", tasks: Array<{ taskId, status, label, resultPath? }> }`, `label` being the row's display label ([task-registry.md](task-registry.md), Section 2).

### 2.4 `wait`

Blocks until `taskId` is no longer `running` and returns what a `read` of the row returns at
that moment (Section 2.1), including that section's consuming rule and result-file error; every
wait that is not an error MUST carry `details` `{ action: "wait", taskId, status, resultPath? }`.

- The wait begins when the checks of Section 1 have passed, and its deadline is the `timeout`
  of Section 1.1, that section's default when it is omitted, counted from the moment the wait
  begins. A row that is not `running` when the wait begins returns without waiting. When the
  deadline expires first, the call returns a tool error (`isError: true`) whose text is verbatim
  `Task <taskId> still running after <timeout>ms`, `<timeout>` being the wait's effective timeout
  in milliseconds; the row is left as it was, unconsumed, its completion notification unaffected.
- A tool-call signal that aborts the call ends the wait; the call returns the host's abort
  result, and the row is left as a deadline expiry leaves it.

## 3. Specification gaps

- Whether the host, when it validates against the schema of Section 1.1, first coerces an
  argument to the type the schema names, and so whether a convertible value of the wrong type is
  admitted rather than rejected as a schema rejection, is the host's.
- The error text returned for the tool errors of Section 1, and the `details` those tool
  errors carry, are unspecified.
- The `renderResult` output other than the agent-directory substitution of
  [agent-tool.md](agent-tool.md), Section 4.2, is unspecified.
- The wait deadline of Section 2.4 uses a host timer; delays in servicing it, and in waking the
  call after the row stops running, have no specified upper bound.
