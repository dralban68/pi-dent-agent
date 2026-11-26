# Task registry specification

This document specifies the task registry: the per-session and per-`Fleet`-query store of task
rows, its operations, ordering, settlement, completion notification, interrupted notification,
nesting, and registry changes. Task kinds, status meaning, and the task tree are owned by
[task.md](task.md); the inspection surface by [task-tool.md](task-tool.md).

## 1. Ownership {#ownership}

- A main session MUST own exactly one live task registry at a time, created with the session. A
  child session MUST own exactly one while an attempt runs in it, created for that attempt
  ([nesting](#nesting)). A task registry is kept in extension memory and never persisted; the task ledger
  ([task-ledger.md](task-ledger.md)) keeps a history of its rows.
- `Agent`, `Script`, and `Bash` MUST register into the task registry of the invoking session; `Task`
  MUST operate only on it.
- A main session's task registry is live from its creation until its session ends or a reload;
  the session continuing after a reload gets a new task registry. A child session's is live from
  its creation until its attempt ends ([nesting](#nesting)). Registering into a task registry that is not
  live MUST fail the invocation as a tool error whose text is
  `<Tool> error: task registry is not live: the owning session has ended`, `<Tool>` being `Agent`,
  `Script`, or `Bash`.
- A `Fleet` query dispatch ([fleet-tool.md, action `query`](fleet-tool.md#query)) MUST register its row
  (`kind` `agent`, `background` `false`) in a task registry of its own, attached to no row; it
  is a row of no session's task registry and of no task tree ([task.md, task tree](task.md#task-tree)).
  That task registry MUST end when the dispatch settles, when the target session ends, or on
  reload ([registry end and adoption](#registry-end)); a running row is then cancelled.

## 2. Task row {#task-row}

| Field         | Type                                                                   | Contract                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskId`      | string                                                                 | Task ID: 8 lowercase hexadecimal characters, unique among the rows of every task registry of one task tree, adopted rows included.                                    |
| `kind`        | `"agent" \| "script" \| "bash"`                                        | Task kind ([task.md, task kinds](task.md#task-kinds)).                                                                                                                |
| `background`  | boolean                                                                | `true` for background delivery, `false` for foreground delivery and for a `Fleet` query row.                                                                          |
| `cohort`      | string                                                                 | Cohort ID ([cohorts and completion notification](#cohorts)).                                                                                                          |
| `label`       | string                                                                 | Initial value set at `register`; replaced by `amend`.                                                                                                                 |
| `status`      | `"running" \| "completed" \| "failed" \| "cancelled" \| "interrupted"` | `running` at registration; the terminal values are per [task.md, lifecycle](task.md#lifecycle).                                                                       |
| `startedAt`   | number                                                                 | Registration time, milliseconds since the Unix epoch.                                                                                                                 |
| `settledAt`   | number?                                                                | Settlement time, milliseconds since the Unix epoch; present once settled.                                                                                             |
| `resultPath`  | string?                                                                | Result file, set by the owning contract at settlement.                                                                                                                |
| `progress`    | `Array<{ at: number; line: string }>`                                  | Progress projection entries, in append order; at most the latest 1000, the progress cap. `at` is the append time, milliseconds since the Unix epoch.                  |
| `result`      | string?                                                                | The full settled result text; present once settled and not `interrupted`, except that a rebuilt row carries none ([task-record.md, rebuild](task-record.md#rebuild)). |
| `consumed`    | boolean                                                                | Whether the completion is consumed ([cohorts and completion notification](#cohorts)).                                                                                 |
| `orphan`      | boolean                                                                | `false` at registration; `true` once adopted ([registry end and adoption](#registry-end)).                                                                            |
| `cancel`      | cancellation handler?                                                  | Set by the owning contract; present while running.                                                                                                                    |
| `browserKill` | boolean                                                                | `false` at registration; `true` once a cancel is a browser kill ([task-browser.md, kill key](task-browser.md#kill-key)).                                              |

A row carries the common fields above plus exactly the kind-specific fields of its task kind:

| Task kind | Field         | Type           | Contract                                                                                                                                                                                     |
| --------- | ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`   | `model`       | string?        | Canonical serialization ([model-string.md, canonical serialization](model-string.md#serialization)) of the dispatch plan's model; set by the owning contract.                                |
| `agent`   | `agent`       | string?        | Agent identity of the dispatch; set by the owning contract.                                                                                                                                  |
| `agent`   | `task`        | string?        | Task text of the dispatch; set by the owning contract.                                                                                                                                       |
| `agent`   | `sessionPath` | string?        | Session file of the current attempt's child session; set by the owning contract.                                                                                                             |
| `agent`   | `usage`       | usage sum?     | The usage sum of the dispatch ([agent-tool.md, usage](agent-tool.md#usage)); absent until its first assistant message ends, and on a rebuilt row.                                            |
| `agent`   | `toolCalls`   | number?        | The number of tool calls of the assistant messages added to `usage` ([agent-tool.md, usage](agent-tool.md#usage)); `0` at `register`; absent on a rebuilt row.                               |
| `agent`   | `children`    | task registry? | Attached task registry ([nesting](#nesting)).                                                                                                                                                |
| `script`  | `code`        | string         | The script source of the call: the inline `code`, or the plugin script file's content; set by the owning contract ([script-tool.md, timeout and delivery](script-tool.md#timeout-delivery)). |
| `script`  | `toolCalls`   | number         | The number of nested calls the run has started ([script-tool.md, tool log](script-tool.md#tool-log)); `0` at `register`.                                                                     |
| `bash`    | `command`     | string         | The command text of the call, unchanged; set by the owning contract.                                                                                                                         |

The display label of a task row is the first line of `label` with ANSI escape sequences and
control characters removed; the task tree widget, `Task` `list`, and the completion notification
MUST render the display label, never the raw `label`.

Rows MUST be kept in registration order and MUST NOT be removed while the task registry
exists; `end` moves running and unconsumed rows out by adoption ([registry end and adoption](#registry-end)).

## 3. Operations {#operations}

| Operation   | Contract                                                                                                                                                                                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`  | Appends a `running` row with a fresh `taskId`, the `label` given by the owning contract, `startedAt`, empty `progress`, and `consumed` per [cohorts and completion notification](#cohorts); returns it. MUST precede execution of the invocation.                                                                |
| `insert`    | Appends unchanged a row built by a rebuild ([task-record.md, rebuild](task-record.md#rebuild)); the row counts as registered at insertion.                                                                                                                                                                       |
| `settle`    | Sets `status` (terminal), `result`, `resultPath?`, and `settledAt`; clears `cancel` and `children`. A no-op on a settled row.                                                                                                                                                                                    |
| `progress`  | Appends one entry, `at` set to now, to `progress`, dropping the oldest entry beyond the progress cap of [task row](#task-row). A no-op on a settled row.                                                                                                                                                         |
| `consume`   | Sets `consumed` to `true`.                                                                                                                                                                                                                                                                                       |
| `cancel`    | Sets `browserKill` when the cancel is a browser kill ([task-browser.md, kill key](task-browser.md#kill-key)), then invokes the row's cancellation handler when `running`; a no-op on a settled row. Settlement remains the owning contract's and asynchronous: `cancelled` unless another outcome commits first. |
| `cancelAll` | Invokes `cancel` on every running row, not as a browser kill.                                                                                                                                                                                                                                                    |
| `attach`    | Sets or replaces `children` of a running `agent` row ([nesting](#nesting)); the row's task registry becomes the attaching task registry of the attached one.                                                                                                                                                     |
| `amend`     | Replaces `label` and kind-specific fields other than `children` of a running row; a no-op on a settled row.                                                                                                                                                                                                      |
| `end`       | Stops the task registry from being live; adopts every running and every unconsumed row into the nearest live attaching task registry ([registry end and adoption](#registry-end)); `cancelAll` when none exists.                                                                                                 |
| `get`       | Returns the row with a given `taskId`, or none.                                                                                                                                                                                                                                                                  |
| `list`      | Returns every row in registration order.                                                                                                                                                                                                                                                                         |
| `subscribe` | Registers a listener for registry changes ([registry changes](#registry-changes)); returns an unsubscribe handle.                                                                                                                                                                                                |

`settle` is the only operation that changes `status`, and it MUST change it at most once: the
first committed outcome is preserved.

## 4. Registry end and adoption {#registry-end}

- `end` stops the task registry from being live. Every running row and every unconsumed row is
  adopted: it moves, in registration order, into the nearest live task registry among its own attaching task registry,
  that registry's attaching task registry, and so on, keeping `taskId`, `cohort`, and
  `consumed`, marked `orphan`, appended after the adopting registry's existing rows. An adopted row
  counts as registered at adoption. With no live task registry among them, `end` MUST `cancelAll`
  instead. Consumed settled rows stay in the ended task registry.
- An adopted `agent` row keeps its `children`; the adopting registry becomes their attaching
  task registry.
- When the owning session ends — replacement, close, or host shutdown — or on reload, its task
  registry MUST `end`.
- Adoption is a registry change of the adopting registry. `settle` and `progress` on an adopted
  row are registry changes of the adopting registry; the completion notification of its cohort is
  governed by the adopting registry ([cohorts and completion notification](#cohorts)).

## 5. Cohorts and completion notification {#cohorts}

- Every row registered from one assistant message MUST carry that message's first tool-call ID
  as its cohort ID; a registration with no originating assistant message MUST get a fresh
  unique cohort ID.
- `register` MUST set `consumed` to `true` for a foreground row and to `false` for a background
  row. A pre-start rejection MUST be consumed before it settles.
- The first time `settle` or adoption leaves no running row in a cohort, every unconsumed background
  row of the cohort whose status is `completed`, `failed`, or `cancelled` MUST be listed, one
  summary line per row ([task-tool.md, `list`](task-tool.md#list)), using each row's
  display label ([task row](#task-row)), in registration order, after the line `Background tasks settled:`,
  as one completion notification;
  a row whose `browserKill` is `true` and whose `status` is `cancelled` MUST have its line
  followed by ` · killed by the user from the task browser`; no message is sent when no row is
  unconsumed. A row already `consumed` is never consumed or listed by a notification again.
  A cohort produces no further completion notification until `register` of a
  background row into it re-opens it.
- The rows a completion notification lists MUST be consumed only once the host has accepted
  the message, and the cohort counts as notified only then. When the session's task registry has
  no host, or the host's send throws, the rows MUST stay unconsumed and the cohort MUST stay
  unnotified, so the next `settle` or adoption that leaves no running row in it lists them
  again.
- A completion or interrupted notification the host refuses, or that has no host, MUST be
  reported as one `warning` with the text `pi-dent: task notification was not delivered: <error>`
  through the host UI of the main session's boot window: at most once per cohort for a completion
  notification, and once for the interrupted notification. A task registry with no such UI, a
  child session's, reports nothing itself and its rows stay unconsumed.
- A session's task registry sends a completion notification into that session's conversation
  through the host `sendMessage` API with `customType` `"pi-dent-tasks"`, `display: true`,
  `deliverAs: "followUp"`, and `triggerTurn: true`. A `Fleet` query dispatch's task registry and a
  task registry that is not live MUST send none.
- After a rebuild ([task-record.md, rebuild](task-record.md#rebuild)), the session's task registry MUST
  send one interrupted notification when the rebuild inserted one or more `interrupted` rows: a
  message listing those rows in registration order, one summary line per row
  ([task-tool.md, `list`](task-tool.md#list)), after the line
  `Interrupted tasks (resume with Agent resume=<taskId>):` (`<taskId>` literally), through the same
  `sendMessage` call shape as the completion notification. The interrupted notification MUST NOT
  consume the rows.
- A `Task` `read` or `kill` follows [task-tool.md, operations](task-tool.md#operations). A browser kill follows
  [task-browser.md, kill key](task-browser.md#kill-key).

## 6. Nesting {#nesting}

- While an `agent` row's attempt runs, its `children` MUST be the task registry of that
  attempt's child session, which attaches to the row's task registry; each attempt attaches its
  own. Recovery attempts replace it.
- When an attempt ends, the attempt's task registry ends and adopts per [registry end and adoption](#registry-end) before the next
  attempt attaches. An attempt that ends normally holds no running row
  ([agent-tool.md, child session](agent-tool.md#child-session)), so only a failed, cancelled, or timed-out
  attempt leaves rows to adopt.
- `script` and `bash` rows MUST NOT have `children`.

## 7. Registry changes {#registry-changes}

A registry change is any `register`, `insert`, `settle`, `progress`, `amend`, `attach`, a `consume` that
changes `consumed`, or adoption, and any registry change in an attached `children` task
registry, recursively. Each listener MUST
be called synchronously once per registry change, after the change is applied. A throwing
listener MUST NOT affect the operation or other listeners.

A surface that renders task rows MUST reflect every registry change and advance the shown
duration within 1000 ms, and MUST NOT run a refresh timer while no row of its content is
running.

## 8. Specification gaps {#gaps}

- No rule removes an interrupted row that neither `Task` `kill` nor a `resume` of its session file
  acts on, so the row can stay in the task tree widget for the session's whole life.
- A host send into a child session can fail after it was accepted: the host's message call returns
  before the message is enqueued, so [cohorts and completion notification](#cohorts)'s acceptance rule cannot make the asynchronous
  refusal of that call leave the rows unconsumed.
- Whether task IDs are unique across reloads of one process and the task records retained in the
  agent directory is unspecified.
