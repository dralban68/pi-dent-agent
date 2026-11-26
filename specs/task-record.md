# Task record specification

This document specifies the task record: the small JSON file a session writes beside a
background `Agent` task's session file so the task can be rebuilt and resumed after its process
ends or reloads. It owns the record's file format, lifecycle, and rebuild. The task row and task
registry are owned by [task-registry.md](task-registry.md); the `Agent` `resume` surface and
session-file naming by [agent-tool.md](agent-tool.md); the meaning of a task's status by
[task.md](task.md). A task record is not the task's history: that is the task ledger
([task-ledger.md](task-ledger.md)).

## 1. Format {#format}

A task record is one file named `<taskId>.task.json` in the dispatching session's agent directory
([agent-tool.md](agent-tool.md), Section 4.2), where `<taskId>` is the task's task ID. It is a
JSON object:

| Field         | Type                                                  | Contract                                                                                                                                            |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskId`      | string                                                | Task ID; MUST equal the record file's `<taskId>`.                                                                                                   |
| `agent`       | string                                                | Agent identity of the dispatch.                                                                                                                     |
| `label`       | string                                                | The task row's `label`.                                                                                                                             |
| `model`       | string?                                               | Canonical serialization of the dispatch plan's model, when the row records one.                                                                     |
| `cohort`      | string                                                | The task row's cohort ID.                                                                                                                           |
| `startedAt`   | number                                                | Registration time, milliseconds since the Unix epoch.                                                                                               |
| `sessionPath` | string                                                | Absolute path of the child session file.                                                                                                            |
| `status`      | `"running" \| "completed" \| "failed" \| "cancelled"` | `running` until the task settles; the terminal value once settled. A task record's `status` is never `interrupted` ([task.md](task.md), Section 2). |
| `settledAt`   | number?                                               | Settlement time, milliseconds since the Unix epoch; present once settled.                                                                           |
| `resultPath`  | string?                                               | Present once settled with a result spill ([agent-tool.md](agent-tool.md), Section 7).                                                               |

A record MUST NOT carry the task text or the settled result text.

## 2. Lifecycle {#lifecycle}

- A session MUST write one task record for every background `agent` task it dispatches, in the
  session's own agent directory, once the attempt's child session file path is fixed and before
  the first prompt of the first attempt, with `status: "running"` and every field of Section 1
  except `settledAt` and `resultPath`. A foreground task, a `script` task, and a `bash` task MUST
  NOT have a record. A recovery attempt continues the same session file and writes no record.

  > Note (non-normative): a record is what survives a reload or process end, because the task
  > registry is memory-only and a session file's name is not discoverable once the registry is
  > gone.

- The session MUST rewrite the record when the task settles, setting `status` to the terminal
  value, `settledAt`, and `resultPath` when present.
- A task that settles `cancelled` because its task registry ended with no live attaching task
  registry to adopt its row ([task-registry.md](task-registry.md), Section 4) MUST NOT have its
  record rewritten: the record keeps `status: "running"`, so the next start of the same session
  rebuilds the task as `interrupted` (Section 3) whether that settlement came before or after the
  rebuild. Every other settlement, `completed` and `failed` included, follows the rewrite rule
  above.

  > Note (non-normative): a reload or a session end cancels a running task only because its task
  > registry ends, and the interrupted row is the one the user can resume.

- The session MUST delete the record when `Task` `read` or `kill` consumes the task row
  ([task-tool.md](task-tool.md), Section 2) and when a `resume` consumes it
  ([agent-tool.md](agent-tool.md), Section 9). A `consume` of a row that is `running` MUST NOT
  delete the record; the row settles later and its record then follows the rewrite rule above.
  A completion notification ([task-registry.md](task-registry.md), Section 5) leaves the records
  of the rows it consumes in place.

  > Note (non-normative): a settled task can still be rebuilt and resumed after a reload.

- A write, rewrite, or delete failure MUST NOT fail the dispatch, and no failure is reported.

## 3. Rebuild {#rebuild}

- At the main session's start, after its agent directory is created
  ([agent-tool.md](agent-tool.md), Section 4.2), the extension MUST rebuild: scan the session's
  own agent directory for files named `<taskId>.task.json` and `insert` one task row per record
  ([task-registry.md](task-registry.md), Section 3). A record inside a child session's agent
  directory is never read; the interrupted task that dispatched that child is the resumable unit.
- The rebuild happens only when this boot window owns the session ([session-store.md](session-store.md),
  Section 4): a boot window whose registration was refused inserts no row and changes no record.
- A rebuild whose agent directory cannot be read MUST report the failure as one `warning` notice
  naming the directory and the error, `pi-dent: cannot read the task record directory <dir>: <error>`,
  through the host `notify` API ([config-file.md](config-file.md), Section 6), and MUST insert no
  row from it. A directory that does not exist is not a failure.
- For a record with `status: "running"`, the inserted row MUST have `status` `"interrupted"`,
  `kind` `"agent"`, `background` `true`, `settledAt` the rebuild time, `consumed` `false`,
  `orphan` `false`, empty `progress`, `browserKill` `false`, no `result`, no `resultPath`, and the
  record's `taskId`, `agent`, `label`, `model`, `cohort`, `startedAt`, and `sessionPath`.
- For a record with a terminal `status`, the inserted row MUST have that status, `kind` `"agent"`,
  `background` `true`, `settledAt` and `resultPath` from the record, `consumed` `false`,
  `orphan` `false`, empty `progress`, `browserKill` `false`, no `result`, and the record's `taskId`,
  `agent`, `label`, `model`, `cohort`, `startedAt`, and `sessionPath`.
- A record that is not a JSON object, whose `taskId` does not equal the file's `<taskId>`, whose
  `sessionPath` is not a string, whose `status` is not `running` while `settledAt` is absent, or
  whose fields are otherwise not of the declared types MUST be skipped: no row is inserted and no
  failure is reported.
- Rebuilt rows MUST be inserted in ascending `taskId` order and MUST NOT delete the records.
- A rebuild MUST skip a record whose `taskId` is already a row of the task registry.
- The interrupted notification MUST list only the `interrupted` rows the current rebuild inserted,
  never a row an earlier rebuild inserted into the same task registry.
- A rebuild changes the task ledger per [task-ledger.md](task-ledger.md), Section 4.2.
- Inserted `interrupted` rows trigger the interrupted notification of
  [task-registry.md](task-registry.md), Section 5; a rebuilt row never triggers the completion
  notification.

## 4. Specification gaps {#gaps}

- No rule reconciles a record whose child session file was never created or was deleted while
  the record remained.
- Whether a `--no-session` session's records are reachable after the process ends (not a reload),
  the next session having a different ID, is unspecified.
