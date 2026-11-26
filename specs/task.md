# Task specification

This document specifies the task: the supervised record of one `Agent`, `Script`, or `Bash`
invocation or one `Fleet` query dispatch, its kinds, lifecycle, task tree, and task tree widget. The task
row, its storage, and completion notification are owned by
[task-registry.md](task-registry.md). How a task executes, what it outputs, and how it cancels
belong to the tool that starts it ([agent-tool.md](agent-tool.md),
[script-tool.md](script-tool.md), [bash-tool.md](bash-tool.md), [fleet-tool.md](fleet-tool.md)).
The inspection and cancellation surface is [task-tool.md](task-tool.md); the task browser's
kill key cancels through the same path ([task-browser.md](task-browser.md), Section 4.4). The
permanent history of tasks is the task ledger ([task-ledger.md](task-ledger.md)).

## 1. Task kinds {#task-kinds}

Every `Agent`, `Script`, and `Bash` invocation, foreground or background, including a pre-start
rejection, MUST register exactly one task row before execution begins, except three cases: a
schema rejection, which registers none; a `Script` call whose arguments carry no source shape,
which is checked before the row and fails without one ([script-tool.md](script-tool.md),
Section 2); and an invocation whose task registry is not live, which fails without a row
([task-registry.md](task-registry.md), Section 1). The row's kind is:

| Task kind | Started by                        | Owning contract                                                                             |
| --------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `agent`   | `Agent`; a `Fleet` query dispatch | [agent-tool.md](agent-tool.md); [fleet-tool.md](fleet-tool.md) for a `Fleet` query dispatch |
| `script`  | `Script`                          | [script-tool.md](script-tool.md)                                                            |
| `bash`    | `Bash`                            | [bash-tool.md](bash-tool.md)                                                                |

A schema rejection is a call the host rejects because its arguments do not satisfy the tool's
parameter schema ([bash-tool.md](bash-tool.md), Section 1; [script-tool.md](script-tool.md),
Section 1; [agent-tool.md](agent-tool.md), Section 1.1). The host rejects it before the tool
runs: no task row is registered, no file is created, and the call returns a tool error whose text is the host's.
The tool's own checks run after the host's, and their failures are pre-start rejections
([bash-tool.md](bash-tool.md), Section 2; [script-tool.md](script-tool.md), Section 2;
[agent-tool.md](agent-tool.md), Section 1.1), except the `Script` source-shape check, which
runs before its row is registered and returns the tool's own text without a row
([script-tool.md](script-tool.md), Section 2).

### 1.1 The `cwd` parameter {#cwd-parameter}

A tool that starts a task and takes a working directory takes it as the `cwd` parameter, with
one contract in `Agent`, `Script`, and `Bash`:

- The schema declares `cwd` as an optional string and constrains nothing else about it.
- A `cwd` that is empty or has only white space is treated as absent.
- When `cwd` is absent, the working directory is the invoking session's, unless the tool's spec
  names another default. The invoking session of a call made in a child session is that child
  session.
- A relative `cwd` resolves against the invoking session's working directory; the result is
  the resolved `cwd`, an absolute path.
- A `cwd` that is not absent and whose resolved `cwd` is not an existing directory MUST reject
  the call as a pre-start rejection, with the error text
  `cwd is not an existing directory: <resolved cwd>`. The check's place among a tool's own
  checks is the tool's.

A tool's spec states only what the working directory is used for and any default of its own.

## 2. Lifecycle {#lifecycle}

- A task's `status` is `running` from registration until it settles once to a terminal value.
  The terminal values are `completed`, `failed`, `cancelled`, and `interrupted`; a task is
  settled when its `status` is terminal. The owning contract sets its `label` and maps its
  outcome to `completed`, `failed`, or `cancelled`. A task is `interrupted` only by a rebuild
  ([task-record.md](task-record.md), Section 3) that finds its task record `running`. A task's
  ledger row in the task ledger can also become `interrupted` when the process that ran the task
  ends first ([task-ledger.md](task-ledger.md), Section 4); that changes no task row.
- A task belongs to one task registry at a time; when that registry ends, the task follows
  [task-registry.md](task-registry.md), Section 4.

## 3. Task tree {#task-tree}

The task tree of a session is the set of its task rows:

- Roots: the task rows of the session's task registry.
- Children of a task: the task rows of its attached `children` task registry
  ([task-registry.md](task-registry.md), Section 6), recursively.
- Siblings are ordered by registration.
- An adopted task ([task-registry.md](task-registry.md), Section 4) is a root of the adopting
  task registry, after its existing rows in registration order.
- A row of an ended task registry other than an adopted row is not a member, and a `Fleet`
  query dispatch's row ([task-registry.md](task-registry.md), Section 1) is a member of no task
  tree.

## 4. Task tree widget {#task-tree-widget}

The extension MUST render the task tree of the main session through the host widget surface
under the key `pi-dent-tasks`, placed above the editor. The task tree widget MUST be rendered only
when the session has an interactive terminal UI.

- Content: every member of the task tree whose `status` is `running`, or whose `status` is
  `interrupted` and whose `consumed` is `false` ([task-registry.md](task-registry.md), Section 2),
  one line per task, depth-first, siblings in registration order.
- Line format: `<prefix><taskId> · <kind> · <delivery> · <status> · <elapsed> · <label>`, with
  `orphan · ` inserted after `<delivery>` for an adopted task row
  ([task-registry.md](task-registry.md), Section 4) and `<detail> · ` inserted before `<label>`
  when `<detail>` is non-empty, where:
  - `<prefix>` is empty for a root; for any other task it is one column per ancestor below the
    root — `│  ` when that ancestor has a later sibling, else three spaces — followed by `├─ `
    when the task has a later sibling, else `└─ `; a later sibling counts only when it is
    included in the content.
  - `<delivery>` is `bg` when `background` is `true`, else `fg`.
  - `<elapsed>` is the duration from `startedAt` to now for a running task, or to `settledAt`
    for an interrupted task, in whole seconds rounded down (never negative), rendered as `<s>s`
    below 60 seconds,
    `<m>m<ss>s` below one hour, else `<h>h<mm>m` (`<ss>` and `<mm>` zero-padded to two digits).
  - `<label>` is the task row's display label ([task-registry.md](task-registry.md), Section 2).
  - `<detail>` is owned by the task kind: for `agent` the row's `model` when present, else
    empty; for `script` and `bash` empty. ANSI escape sequences and control characters are removed.
- Each line MUST be plain text colored only through the host theme — `<status>`: `accent` for
  `running`, `warning` for `interrupted`; `orphan`: `warning`; `<elapsed>`: `muted`;
  `<detail>`: `dim` — truncated to the render width, never wrapped.
- At most 10 lines are rendered: when the content exceeds 10 lines, the first 9 are rendered
  followed by `… <n> more`, `<n>` being the number of lines not rendered.
- When the task tree has no member of the content, the widget MUST be cleared
  (absent, not empty).
- The widget MUST follow the refresh rule of [task-registry.md](task-registry.md), Section 7.
- Ending the main session MUST clear the widget.
- A widget update that fails MUST clear the widget and end its refresh timer; no failure is
  reported.
- Execution MUST NOT depend on the widget.

### 4.1 Task feed {#task-feed}

The task feed carries the task tree to an RPC client that draws it itself
and announces that by setting the environment variable `PI_DENT_FEEDS` to `1`. When the main
session runs in pi's RPC mode and `PI_DENT_FEEDS` is `1` at session start, the extension MUST set
the widget `pi-dent-tasks` through the host widget surface as an array of one string: the JSON text
of `{ "piDent": "tasks/2", "tasks": [<task>…] }`, one `<task>` per member of the task tree
(Section 3), whatever its `status` and `consumed`, depth-first, siblings in registration order,
with no limit on their number:

| Field        | Type    | Value                                                                                                                                                                                           |
| ------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskId`     | string  | The task ID.                                                                                                                                                                                    |
| `depth`      | number  | 0 for a root, else one more than its parent's.                                                                                                                                                  |
| `kind`       | string  | `agent`, `script`, or `bash`.                                                                                                                                                                   |
| `background` | boolean | The row's `background`.                                                                                                                                                                         |
| `status`     | string  | The row's `status`.                                                                                                                                                                             |
| `orphan`     | boolean | `true` for an adopted task row.                                                                                                                                                                 |
| `startedAt`  | number  | The row's `startedAt`, milliseconds since the Unix epoch.                                                                                                                                       |
| `settledAt`  | number? | The row's `settledAt`, present once the task has settled.                                                                                                                                       |
| `detail`     | string  | `<detail>` of Section 4.                                                                                                                                                                        |
| `label`      | string  | The display label, with the agent-directory substitution of [agent-tool.md](agent-tool.md), Section 4.2.                                                                                        |
| `usage`      | object? | The row's `usage` ([agent-tool.md](agent-tool.md), Section 13) — `{ input, output, cacheRead, cacheWrite, cost, turns }`, own usage only — when present; absent for a row without usage.        |
| `toolCalls`  | number? | The row's `toolCalls` ([task-registry.md](task-registry.md), Section 2), own calls only, when present; absent for a `bash` row and for a rebuilt row, which has none, never `0` in their place. |

- The client computes elapsed times itself: the feed MUST be set on a registry change
  ([task-registry.md](task-registry.md), Section 7) that changes its text, and MUST NOT be set
  again with an unchanged text nor on a timer.
- While the task tree has no member the widget MUST NOT be set, and when it comes to have none
  the widget MUST be cleared; ending the main session MUST clear it.
- In RPC mode without `PI_DENT_FEEDS` set to `1`, and in any other mode, the extension MUST NOT set
  `pi-dent-tasks` as an array of strings.
- A feed that fails to read the task tree or to set the widget leaves the widget as it is, and no
  failure is reported.
- Execution MUST NOT depend on the feed.

### 4.2 Task detail feed {#task-detail-feed}

The task detail feed carries the details page of one task ([task-browser.md](task-browser.md),
Section 4) to an RPC client, under the same announcement as the task feed (Section 4.1). The
watched task is the one the command `tasks` names ([slash-commands.md](slash-commands.md),
Section 3); there is at most one. While there is one, the extension MUST set the widget
`pi-dent-task` through the host widget surface as an array of one string: the JSON text of an object
with these fields, every string with ANSI escape sequences and control characters other than line
breaks and tabs removed:

| Field        | Type     | Value                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `piDent`     | string   | `"task/1"`.                                                                                                                                                                                                                                                                                                                                                              |
| `taskId`     | string   | The task ID.                                                                                                                                                                                                                                                                                                                                                             |
| `found`      | boolean  | `false` when no row of the task tree, nor a row the task tree once held, has the task ID; every field below is then absent.                                                                                                                                                                                                                                              |
| `kind`       | string   | `agent`, `script`, or `bash`.                                                                                                                                                                                                                                                                                                                                            |
| `background` | boolean  | The row's `background`.                                                                                                                                                                                                                                                                                                                                                  |
| `orphan`     | boolean  | The row's `orphan`.                                                                                                                                                                                                                                                                                                                                                      |
| `status`     | string   | The row's `status`.                                                                                                                                                                                                                                                                                                                                                      |
| `startedAt`  | number   | The row's `startedAt`.                                                                                                                                                                                                                                                                                                                                                   |
| `settledAt`  | number?  | The row's `settledAt`, when present.                                                                                                                                                                                                                                                                                                                                     |
| `label`      | string   | The `label` field of Section 4.1.                                                                                                                                                                                                                                                                                                                                        |
| `usage`      | object?  | The `usage` field of Section 4.1, when present.                                                                                                                                                                                                                                                                                                                          |
| `toolCalls`  | number?  | The `toolCalls` field of Section 4.1, when present.                                                                                                                                                                                                                                                                                                                      |
| `killable`   | boolean  | Whether the kill key applies to the row ([task-browser.md](task-browser.md), Section 4.4).                                                                                                                                                                                                                                                                               |
| `fields`     | object[] | One `{ name, value }` per line of the `Agent`, `Script`, or `Bash` section of its details page, in order, other than `delivery`.                                                                                                                                                                                                                                         |
| `error`      | string?  | The `Error` section's text of an `agent` row, when present.                                                                                                                                                                                                                                                                                                              |
| `task`       | string?  | The `Task` section's text of an `agent` row, when present.                                                                                                                                                                                                                                                                                                               |
| `command`    | string?  | The `Command` section's text of a `bash` row ([task-browser.md](task-browser.md), Section 4.2); absent for a row of another kind.                                                                                                                                                                                                                                        |
| `output`     | string[] | The `Output` section's lines of a `script` or `bash` row, at most the latest 500; empty for an `agent` row.                                                                                                                                                                                                                                                              |
| `events`     | object[] | For an `agent` row, its session events (task-browser.md, Section 4.3), at most the latest 200, each `{ time, kind, summary, content, error }`: `time` is the session entry's timestamp as read; `content` is its expanded content, the first 200 unwrapped lines with no omission marker; `error` `true` for a `toolResult` with `isError` `true`; empty for other rows. |

- The feed MUST be set when the task is watched, on a registry change that changes its text, and,
  for a running `agent` row, after each read of the session file, which follows the reading rule
  of task-browser.md, Section 4.3; it MUST NOT be set again with an unchanged text.
- Ending the watch MUST clear the widget; closing the boot window and ending the main session
  MUST end it.
- Without the announcement, or outside RPC mode, `pi-dent-task` MUST NOT be set.
- A read of the watched row's session file that fails yields no events, and a feed that fails to
  set the widget leaves the widget as it is; no failure is reported.

## 5. Host terms {#host-terms}

- A tool error is a tool result with `isError: true`.
- The tool-call signal is the abort signal the host passes to one tool execution.
- The invoking session is the session whose model made the tool call.
- An agent run is one host agent loop, from a prompt until the agent is idle.

## 6. Specification gaps {#gaps}

- The marker, if any, and the handling of wide characters when a line is truncated to the render
  width are the terminal toolkit's.
