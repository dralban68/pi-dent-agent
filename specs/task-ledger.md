# Task ledger specification

This document specifies the task ledger: the database in which the pi-dent processes of one
machine keep a permanent history of every task and of each main session's own usage. It owns the
ledger's location, format and version, its two tables, when rows are written, how rows of ended
processes are settled, concurrent access, failures, and the figures derived from the rows. The
task row and task registry are owned by [task-registry.md](task-registry.md); the usage sum by
[agent-tool.md](agent-tool.md), Section 13; the surfaces that show ledger figures by
[task-tool.md](task-tool.md), Section 2.3, and [session-tool.md](session-tool.md), Section 2.

The task ledger is not derived data: no other file holds its rows, so pi-dent never deletes,
resets, or rewrites the file. It is neither a task record ([task-record.md](task-record.md)),
which serves only rebuild and `resume` and is deleted on consume, nor the local session store
([session-store.md](session-store.md)), nor the session index ([session-index.md](session-index.md)).

## 1. Location and format

The task ledger is one SQLite database file in write-ahead-log journal mode, opened with a busy
timeout of 5000 ms. Its path is the value of the environment variable `PI_DENT_TASKS_DB`, used as
given, when set and non-empty, else `~/.pi/pi-dent/tasks-v1.sqlite`, `~` being the user's home
directory. The path is read when the ledger is opened.

The format version is `1` and is recorded as the database's `user_version`. Each extension
instance MUST open the ledger once, at the first `session_start` of its main session, and MUST,
in this order:

1. When the ledger path and the path of the local session store
   ([session-store.md](session-store.md), Section 1) or of the session index
   ([session-index.md](session-index.md), Section 1) name the same file — when both exist, they
   have the same device and inode; otherwise their resolved paths are equal — make the ledger
   unusable (Section 7) without opening the file.
2. Create the file's directory and the file when absent.
3. When `user_version` is `0` and the database holds no table: create the schema of Section 2
   and set `user_version` to `1`, inside one transaction begun with `BEGIN IMMEDIATE`, so that of
   two processes opening an absent file the second finds the first's schema; a creation that
   fails is rolled back whole.
4. When `user_version` is `1`: use the database.
5. Otherwise: leave the file unchanged; the ledger is unusable (Section 7).
6. Run the sweep of Section 4.1.

A ledger file of another format version (`tasks-v<n>.sqlite`) MUST NOT be read, changed, or
deleted. No row is ever deleted: the ledger keeps every row for as long as the file exists.

## 2. Schema

The schema is exactly these statements; the table, column, and index names are normative:

```sql
CREATE TABLE sessions (
  session_id   TEXT    PRIMARY KEY,
  session_file TEXT,
  cwd          TEXT    NOT NULL,
  started_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  input        INTEGER NOT NULL,
  output       INTEGER NOT NULL,
  cache_read   INTEGER NOT NULL,
  cache_write  INTEGER NOT NULL,
  cost         REAL    NOT NULL,
  turns        INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE tasks (
  row_id        TEXT    PRIMARY KEY,
  session_id    TEXT    NOT NULL,
  task_id       TEXT    NOT NULL,
  parent_id     TEXT,
  resumes_id    TEXT,
  fleet_query   INTEGER NOT NULL,
  kind          TEXT    NOT NULL,
  background    INTEGER NOT NULL,
  cwd           TEXT    NOT NULL,
  agent         TEXT,
  label         TEXT    NOT NULL,
  model         TEXT,
  status        TEXT    NOT NULL,
  dispatched    INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  settled_at    INTEGER,
  updated_at    INTEGER NOT NULL,
  owner_pid     INTEGER NOT NULL,
  owner_started INTEGER NOT NULL,
  session_path  TEXT,
  result_path   TEXT,
  input         INTEGER,
  output        INTEGER,
  cache_read    INTEGER,
  cache_write   INTEGER,
  cost          REAL,
  turns         INTEGER
);
CREATE INDEX tasks_session ON tasks (session_id, task_id);
CREATE INDEX tasks_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX tasks_session_path ON tasks (session_path) WHERE session_path IS NOT NULL;
CREATE INDEX tasks_running ON tasks (status) WHERE status = 'running';
```

Times are milliseconds since the Unix epoch. A `tasks` row is a ledger row; a `sessions` row is a
ledger session row. The ledger session ID of a session is its own session ID for a main session,
and for a child session the ledger session ID of the session that dispatched it, recursively.

### 2.1 Ledger session row

One per main session, holding the main session's own usage, never that of its tasks:

| Column                                                 | Contract                                                                                                                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_id`                                           | The main session's ID.                                                                                                                                                                                               |
| `session_file`                                         | Absolute path of the main session's session file; null when the session has none (`--no-session`).                                                                                                                   |
| `cwd`                                                  | The main session's working directory.                                                                                                                                                                                |
| `started_at`                                           | Time of the row's insertion; never changed afterwards.                                                                                                                                                               |
| `updated_at`                                           | Time of the row's latest write.                                                                                                                                                                                      |
| `input`, `output`, `cache_read`, `cache_write`, `cost` | The sums of the input, output, cache-read, and cache-write token counts and of the cost of the counted entries' host `usage`, as [footer.md](footer.md), Section 2.2, sums its session totals; `cost` in US dollars. |
| `turns`                                                | The number of counted entries that are assistant messages.                                                                                                                                                           |

The counted entries are the entries of the session, on every branch, as the host holds them,
that [footer.md](footer.md), Section 2.2, sums into its session totals, except:

- A tool result message whose tool name is `Agent`. The usage of an `Agent` dispatch is in its
  ledger row; any host `usage` on its tool result was put there by another extension.
- An entry copied by a fork. When the session header carries a string `parentSession`, the host
  made the session from another session file, keeping the copied entries' `timestamp`s; an entry
  whose `timestamp` is earlier than the header's `timestamp` is then a copied entry. Both
  `timestamp`s are [RFC 3339] date-times, compared as instants.

A tool result that a pi-dent tool returns MUST NOT carry a host `usage`, and pi-dent's handlers of
the host's tool-result event MUST NOT set one. The host adds the `usage` of a nested call's result to
the tool result message of the call that made it, so with this rule a `Script` run's nested
`Agent` calls add nothing to the run's tool result.

> Note (non-normative): the host totals that the footer shows count both exceptions; the ledger
> session row leaves them out so that the session usage of Section 6 counts each message once.

The six usage columns form a usage sum ([agent-tool.md](agent-tool.md), Section 13) whose fields
`input`, `output`, `cacheRead`, `cacheWrite`, `cost`, and `turns` are the columns of those names,
`cache_read` being `cacheRead` and `cache_write` being `cacheWrite`.

### 2.2 Ledger row

One per task row ([task-registry.md](task-registry.md), Section 2) of every task kind,
foreground and background, at any depth of the task tree, a `Fleet` query dispatch's row
included ([task-registry.md](task-registry.md), Section 1). An invocation that registers no task
row ([task.md](task.md), Section 1) has no ledger row; a pre-start rejection, which registers
one, has one.

| Column                                                          | Contract                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `row_id`                                                        | A random UUID, version 4 ([RFC 9562], Section 5.4), in its lowercase hyphenated text form, drawn when the task row is registered.                                                                                                                                                                                   |
| `session_id`                                                    | The ledger session ID of the invoking session ([task.md](task.md), Section 5); for a `Fleet` query dispatch, that of the target session, its dispatching session.                                                                                                                                                   |
| `task_id`                                                       | The task row's task ID. It is not unique: task IDs are unique only within one task tree, and a session's task trees across reloads and processes can repeat one.                                                                                                                                                    |
| `parent_id`                                                     | The `row_id` of the parent row (Section 3.1), else null.                                                                                                                                                                                                                                                            |
| `resumes_id`                                                    | For an `agent` row of a `resume` dispatch, the `row_id` of the row it continues (Section 3.2), else null.                                                                                                                                                                                                           |
| `fleet_query`                                                   | `1` for a `Fleet` query dispatch's row, else `0`.                                                                                                                                                                                                                                                                   |
| `kind`                                                          | The task kind: `agent`, `script`, or `bash`.                                                                                                                                                                                                                                                                        |
| `background`                                                    | `1` when the row's `background` is `true`, else `0`.                                                                                                                                                                                                                                                                |
| `cwd`                                                           | The invoking session's working directory until `dispatched` becomes `1`; then the working directory the task runs in: the dispatch plan's resolved cwd for an `agent` row ([agent-tool.md](agent-tool.md), Section 3), the call's working directory ([task.md](task.md), Section 1.1) for a `script` or `bash` row. |
| `agent`                                                         | The row's agent identity for an `agent` row once set; else null.                                                                                                                                                                                                                                                    |
| `label`                                                         | The row's `label`, unchanged: not the display label.                                                                                                                                                                                                                                                                |
| `model`                                                         | The row's `model` for an `agent` row once set; else null.                                                                                                                                                                                                                                                           |
| `status`                                                        | `running`, `completed`, `failed`, `cancelled`, or `interrupted` (Sections 3.2 and 4).                                                                                                                                                                                                                               |
| `dispatched`                                                    | `0` until the task's pre-start checks have passed, then `1`; a pre-start rejection's row keeps `0`.                                                                                                                                                                                                                 |
| `started_at`                                                    | The row's `startedAt`.                                                                                                                                                                                                                                                                                              |
| `settled_at`                                                    | Null while `status` is `running`; then the settlement time of Sections 3.2 and 4.                                                                                                                                                                                                                                   |
| `updated_at`                                                    | Time of the row's latest write.                                                                                                                                                                                                                                                                                     |
| `owner_pid`                                                     | Process ID of the process that inserted the row.                                                                                                                                                                                                                                                                    |
| `owner_started`                                                 | That process's start time: the current time less the process's uptime, computed once per process.                                                                                                                                                                                                                   |
| `session_path`                                                  | For an `agent` row, its `sessionPath` once set: the session file of the dispatch's child session, the source file of a `resume`. For a `script` row, its tool log path ([script-tool.md](script-tool.md), Section 8.4) once the tool log is created. Else null.                                                     |
| `result_path`                                                   | The row's `resultPath` once settled with one: a result spill ([agent-tool.md](agent-tool.md), Section 7) or an output file ([script-tool.md](script-tool.md), Section 6; [bash-tool.md](bash-tool.md), Section 4). Else null.                                                                                       |
| `input`, `output`, `cache_read`, `cache_write`, `cost`, `turns` | For an `agent` row, the row's usage sum ([agent-tool.md](agent-tool.md), Section 13), mapped to columns as in Section 2.1, a zero usage sum while the row's `usage` is absent; null for a `script` or `bash` row.                                                                                                   |

A task row's ledger row is the one inserted for it (Section 3.2), or, for a row a rebuild inserts,
the one Section 4.2 finds; a task row registered while the ledger was unusable has none.

The task's pre-start checks have passed: for an `agent` row, when the usage tally counts the
dispatch ([agent-tool.md](agent-tool.md), Section 13); for a `script` row, when the call has
passed the checks of [script-tool.md](script-tool.md), Section 2; for a `bash` row, when it has
passed those of [bash-tool.md](bash-tool.md), Section 2.

## 3. Writes

Writes are applied in the process's ledger order (Section 5); a ledger write MUST NOT change the
outcome of any task.

### 3.1 Parent row

The parent row of a task row is, the first rule that applies winning:

1. For a task row registered by a nested call ([script-tool.md](script-tool.md), Section 8) of a
   `Script` run: the run's ledger row. The host reports, for each tool execution started through
   its nested-call function, the tool call ID of the call that started it; pi-dent maps that ID
   to the `Script` row it registered.
2. When the invoking session is a child session: the ledger row of the dispatch whose child
   session it is.
3. Otherwise, none.

Rule 2 covers the rows of an attempt's task registry, whose parent is the row the registry is
attached to ([task-registry.md](task-registry.md), Section 6), and a `Fleet` query dispatch whose
target is a child session. A row's `parent_id` MUST NOT change after insertion: adoption
([task-registry.md](task-registry.md), Section 4) moves the task row, not its ledger row.

### 3.2 Write rules

For every task row registered while the ledger is usable, the extension MUST make these writes,
each setting `updated_at` to the time it is issued:

| Moment                                                                                                                   | Write                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register` ([task-registry.md](task-registry.md), Section 3)                                                             | Insert the ledger row with the columns of Section 2.2, `status` `running`, `dispatched` `0`, and `resumes_id`, `settled_at`, and `result_path` null.                                                                                                                                                                                                                                           |
| An `amend` that changes the row's `label`, `agent`, `model`, or `sessionPath`; the creation of a `script` row's tool log | Set `label`, `agent`, `model`, and `session_path` to their new values.                                                                                                                                                                                                                                                                                                                         |
| The task's pre-start checks pass (Section 2.2)                                                                           | Set `dispatched` to `1` and `cwd` to the working directory the task runs in; for a `resume` dispatch, set `resumes_id`: for a `resume` given as a task ID, the `row_id` of the resolved row; for a path, the `row_id` of the ledger row, other than this one, with the latest `started_at` among those whose `session_path` equals this row's `session_path` as text. Null when there is none. |
| An assistant message is added to the row's `usage` ([agent-tool.md](agent-tool.md), Section 13)                          | Set the six usage columns to the row's usage sum, whatever the ledger row's `status`.                                                                                                                                                                                                                                                                                                          |
| `settle`                                                                                                                 | When the ledger row's `status` is `running`: set `status` to the row's terminal `status`, `settled_at` to its `settledAt`, and `result_path` to its `resultPath`. Otherwise change nothing.                                                                                                                                                                                                    |

Recovery attempts ([agent-tool.md](agent-tool.md), Section 8) are part of their dispatch's row and
add no ledger row. A `resume` is a new dispatch with its own task ID and ledger row.

> Note (non-normative): a `settle` never overwrites a row the sweep or a rebuild has already made
> `interrupted`, so the order in which an old process's settlement and a new one's rebuild reach
> the file does not matter.

### 3.3 Ledger session row writes

For its main session, the extension MUST write the ledger session row: insert it at
`session_start`, a reload included, when the ledger holds none with that `session_id`, else
update it; and set `session_file`, `cwd`, and the six usage columns to their values of
Section 2.1 at `session_start`, at `session_shutdown`, and each time the host reports the end of a
message or a compaction or branch summary of the main session, issuing the write at that report.
A child session has no ledger session row.

## 4. Settling rows of ended processes

### 4.1 Sweep

The owner of a ledger row is gone when no process with `owner_pid` exists (a permission-denied
probe counts as existing), or when `owner_pid` is the checking process's own and `owner_started`
differs from the checking process's start time by more than 1000 ms.

The sweep MUST set, for every ledger row whose `status` is `running` and whose owner is gone,
`status` to `interrupted` and `settled_at` to the row's `updated_at`, in one transaction. It runs
when the ledger is opened (Section 1), so a row left `running` by a process that ended is settled
by the next opening of the ledger by any pi-dent process, whether or not its session starts again.

> Note (non-normative): `updated_at` is the last moment the row is known to have been running;
> the time of the sweep would count the time no process ran.

### 4.2 Rebuild

For each row a rebuild inserts ([task-record.md](task-record.md), Section 3), the extension MUST
find its ledger row: the one with the session's ledger session ID, the record's `taskId` as
`task_id`, and the record's `startedAt` as `started_at`. When the inserted row is `interrupted`
and the ledger row's `status` is `running` or `cancelled`, the extension MUST set `status` to
`interrupted`, keeping `settled_at` when it is not null, else setting it to the row's
`updated_at`. A rebuild inserts no ledger row: a record with no matching ledger row has none.

> Note (non-normative): a reload settles a running background task `cancelled` as its task
> registry ends ([task-record.md](task-record.md), Section 2); the rebuild that follows makes it
> `interrupted`, as the user sees it.

### 4.3 Session end and reload

A reload, a session replacement, and a host shutdown end the task registry, whose running rows
settle per [task-registry.md](task-registry.md), Section 4; each settlement writes per
Section 3.2. Writes the process's ledger order still holds when the process ends are lost, with no
failure reported, and the rows they would have settled are settled by the sweep.

## 5. Concurrent access

Several processes, and several extension instances of one process, read and write the ledger at
once. Child sessions run in the process of their main session, so a process writes the rows of
its own main sessions' task trees and their `Fleet` query dispatches, and the sweep writes rows of
gone processes.

- The process's ledger order: the extension MUST apply the ledger reads and writes of one
  process in the order they are issued, across every extension instance of the process, so that
  a read sees every write issued before it. A write issued by an extension instance that has
  since ended is still applied. An extension instance's opening (Section 1) precedes its other
  operations in that order.
- No task waits for the ledger: registration, every task registry operation, a dispatch, and the
  tool call that starts a task MUST proceed without waiting for a ledger read or write. Only the
  reads of Section 6 by a surface wait, for at most the read deadline below.
- Every write MUST be made in a transaction begun with `BEGIN IMMEDIATE`. Consecutive writes MAY
  share a transaction. Each write MUST be committed within 1000 ms of being issued, unless it or
  an operation before it in the process's ledger order waits for a transaction that cannot begin
  within the busy timeout.
- A transaction that cannot begin within the busy timeout is not a failure: it MUST be attempted
  again until it begins, and the operations behind it in the process's ledger order wait for it.
  Between two attempts the extension MUST yield to the process's event loop.
- The read deadline is 2000 ms: a surface's read that has not completed 2000 ms after it is
  issued is abandoned, and the surface shows the ledger as busy, in the text its spec gives.

## 6. Derived figures

Totals are derived when read and never stored. For a ledger row `R`:

- The descendants of `R` are the ledger rows whose `parent_id` is `R`'s `row_id`, and their
  descendants, recursively. A row whose `parent_id` names no ledger row is the descendant of no
  row; its own descendants are still its descendants.
- The own usage of `R` is the usage sum of its six usage columns; a zero usage sum when they are
  null.
- The cumulative usage of `R` is its own usage plus the own usage of every descendant, field by
  field.
- The wall time of `R` is `settled_at` minus `started_at`, or, while `R` is `running`, the time
  of the read minus `started_at`; never negative.
- The descendant time of `R` is the sum of the wall times of its descendants. Because
  descendants run in parallel and inside one another, it can exceed `R`'s wall time.
- The agent figures of `R` are the number of its descendants with `kind` `agent` and
  `dispatched` `1`, and the sum of the own usage of its descendants.

For a ledger session ID `S`:

- The session usage of `S` is the own usage of its ledger session row, a zero usage sum when it
  has none, plus the own usage of every ledger row whose `session_id` is `S`.
- The agent figures of `S` are the number of ledger rows with `session_id` `S`, `kind` `agent`,
  and `dispatched` `1`, and the sum of the own usage of every ledger row with `session_id` `S`
  and `kind` `agent`.

Times read from the ledger are in milliseconds; a surface that renders one in whole seconds
rounds down. A sum of `cost` values is the floating-point sum of the stored values.

## 7. Failures

The ledger becomes unusable for an extension instance when, in that instance:

| Condition                                                                                                                                  | Reason                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| The ledger path names the local session store's file (Section 1, step 1)                                                                   | `the task ledger file is the local session store file`                           |
| The ledger path names the session index's file (Section 1, step 1)                                                                         | `the task ledger file is the session index file`                                 |
| The directory or the file cannot be created or opened                                                                                      | The error's message.                                                             |
| `user_version` is neither `0` with no table nor `1`                                                                                        | `unsupported task ledger version <user_version>`                                 |
| SQLite reports that the file is not a database or is malformed, at opening or in any statement                                             | `task ledger file is corrupt: <message>`, `<message>` being the error's message. |
| Any other SQLite error, at opening, in creating the schema, in the sweep, in a read, or in a write, other than a busy database (Section 5) | The error's message.                                                             |

- A file that is corrupt or of another version MUST NOT be changed, deleted, or replaced; a
  write that fails is rolled back.
- The first time the ledger becomes unusable in an extension instance, the extension MUST show
  one `warning` notice `pi-dent: task ledger unavailable: <reason>` through the host `notify` API
  ([config-file.md](config-file.md), Section 6), and none again in that instance.
- An unusable ledger stays unusable for the rest of the extension instance: the instance makes
  no further ledger read or write, its queued reads and writes are dropped, and its surfaces show the ledger as
  unavailable, in the text their specs give, never zero figures. The next extension instance
  opens the ledger anew.
- No ledger failure fails, cancels, or delays a task or a tool call.

## 8. Normative references

- [RFC 3339] Date and Time on the Internet: Timestamps, G. Klyne, C. Newman, July 2002:
  Section 5.6, the date-time form of a session header's and a session entry's `timestamp`.

- [RFC 9562] Universally Unique IDentifiers (UUIDs), K. Davis, B. Peabody, P. Leach, May 2024:
  Section 5.4, UUID version 4, and its text form.

## 9. Specification gaps

- An `owner_pid` reused by another live process makes a dead owner look alive, so its `running`
  rows stay `running` until that process ends.
- A lock that another process holds indefinitely stalls the process's ledger order: writes wait
  in memory without bound and every surface read shows the ledger as busy.
- Two processes running one main session ID, such as a boot window whose session-store
  registration was refused, both write its ledger session row; the last write wins.
- A session forked without a session file (`--no-session`) has no `parentSession` in its header,
  so the entries the fork copied count in its ledger session row.
- A system clock set back after a fork can give an entry added after the fork a `timestamp`
  earlier than the header's, so that entry is not counted.
- Another extension's tool-result handler that sets a host `usage` on a nested call's result adds
  it to the calling tool's result message; when that nested call is an `Agent` call of a `Script`
  run, its usage counts twice in the session usage, because the host's record of the run's
  nested calls does not say which call each part of the `usage` came from. A `Fleet` tool result
  given a host `usage` that way counts in the querying session, while the query's usage is also in
  the target session's ledger rows.
- A rebuilt row whose ledger row is missing (written while the ledger was unusable, or by an
  earlier pi-dent) is not added to the ledger.
- A `resume` given as a path matches earlier rows by the path's text only: a symbolic link or a
  `..` segment leaves `resumes_id` null.
- Usage a child session's host charges outside its assistant messages, a host `usage` on its tool
  results included, is in no ledger row ([agent-tool.md](agent-tool.md), Section 15).
- `session_path` and `result_path` can name files the retention sweep
  ([agent-tool.md](agent-tool.md), Section 10) has since deleted, and the file grows without
  bound.
- No surface lists ledger rows of ended sessions or of other sessions; they are read with SQL.
- The task browser ([task-browser.md](task-browser.md)) and the task feeds
  ([task.md](task.md), Section 4) show no ledger figure.
- Whether the host reports the calling tool call of a nested call that a background `Script` run
  makes after its tool call has returned is the host's; without it, rule 1 of Section 3.1 does not
  apply to the row that call registers.
- A file at the ledger path that is another application's SQLite database with `user_version`
  `1` is used as the ledger.
- The SQLite file format is SQLite's.
