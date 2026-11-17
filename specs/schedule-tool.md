# `Schedule` tool specification

This document specifies the `Schedule` tool: the surface through which a main session schedules
a message to be inserted into its own conversation at a later due time, once or repeatedly, and
lists and cancels its pending schedules. The extension MUST register the tool in the main session
through the host `registerTool` API with `name` and `label` `"Schedule"`. A schedule is not a
task: `Schedule` registers no task row ([task.md](task.md), Section 1), and `Task` neither lists
nor cancels schedules. A schedule is not a `Fleet` message: it is never written to the local
session store ([session-store.md](session-store.md)) and has no `messageId`.

## 1. Tool surface

The tool `description` MUST be exactly:

```text
Insert a message into this same session when it is due: queued as a follow-up when an agent run is in progress, else starting one. A schedule fires once unless `everySeconds` makes it repeat; a repeating schedule ends at its `count` or on `cancel`, and pending schedules end with the session. `create` one with `message` and one of `delaySeconds`, `at`, or `everySeconds` (with optional `count`), `list` this session's pending schedules, or `cancel` one by `scheduleId`.
```

### 1.1 Parameter schema

The parameter schema is a JSON object schema with `type: "object"` and
`additionalProperties: false`, with one required field, `action`; every other field is optional in
the schema and admits `null` beside the type in the table, and each action accepts only its fields
below.

| Field          | Type                             | Actions  | Contract                                                                                |
| -------------- | -------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `action`       | `"create" \| "list" \| "cancel"` | all      | The operation to perform.                                                               |
| `message`      | string? \| null                  | `create` | Required for `create`. The text to insert, kept verbatim.                               |
| `delaySeconds` | number? \| null                  | `create` | First due time as a delay from the call, in seconds.                                    |
| `at`           | string? \| null                  | `create` | First due time as an absolute instant (Section 2.2).                                    |
| `everySeconds` | number? \| null                  | `create` | Makes the schedule repeating: the interval between due times, in seconds (Section 2.3). |
| `count`        | number? \| null                  | `create` | With `everySeconds` only: the number of occurrences after which the schedule ends.      |
| `scheduleId`   | string? \| null                  | `cancel` | Required for `cancel`. The schedule ID returned by `create`.                            |

The host validates arguments against the parameter schema before execution and rejects a
violation with its own error text; the checks of Section 1.2 run at execution time. A field
whose value is `null` counts as absent. A positive integer is a number for which ECMAScript
`Number.isInteger` holds and which is at least 1.

### 1.2 Validation

Execution-time validation MUST reject the call as a tool error (`isError: true`) whose text is
the error text of the first failing check, in this order, and MUST leave the pending schedules
unchanged:

| #   | Check                                                                                                                   | Error text                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | A field other than `action` that the action does not accept is present (first such field in table order of Section 1.1) | `<field> is not valid for action <action>`                 |
| 2   | `create`: `message` is absent or empty after trimming                                                                   | `message must be a non-empty string`                       |
| 3   | `create`: both `delaySeconds` and `at` are present                                                                      | `create accepts at most one of delaySeconds or at`         |
| 4   | `create`: none of `delaySeconds`, `at`, and `everySeconds` is present                                                   | `create requires delaySeconds, at, or everySeconds`        |
| 5   | `create`: `delaySeconds` is present and not a positive integer                                                          | `delaySeconds must be a positive integer`                  |
| 6   | `create`: `at` is present and not a date-time of Section 2.2                                                            | `at must be an RFC 3339 date-time with a time-zone offset` |
| 7   | `create`: `everySeconds` is present and not a positive integer                                                          | `everySeconds must be a positive integer`                  |
| 8   | `create`: `count` is present and `everySeconds` is absent                                                               | `count requires everySeconds`                              |
| 9   | `create`: `count` is present and not a positive integer                                                                 | `count must be a positive integer`                         |
| 10  | `create`: the first `dueAt` (Section 2.1) is greater than 8640000000000000                                              | `due time is not representable`                            |
| 11  | `cancel`: `scheduleId` is absent or empty after trimming                                                                | `scheduleId must be a non-empty string`                    |
| 12  | `cancel`: the trimmed `scheduleId` names no pending schedule of the session                                             | `no pending schedule "<scheduleId>"`                       |

`<field>` and `<action>` are the field name and the action value; `<scheduleId>` is the trimmed
value. A `scheduleId` that names a schedule that has ended or belongs to another session fails
check 12.

> Note (non-normative): 8640000000000000 ms after the Unix epoch is the latest instant an
> ECMAScript `Date` represents.

## 2. Schedules

### 2.1 Schedule

A schedule is held by the session whose `Schedule` call created it and carries:

| Field          | Contract                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| `scheduleId`   | 8 lowercase hexadecimal digits, unique among the schedules created in the process.                     |
| `message`      | The `message` argument verbatim.                                                                       |
| `createdAt`    | The time the `create` call executed, milliseconds since the Unix epoch.                                |
| `dueAt`        | The next due time, milliseconds since the Unix epoch; first value below, later values per Section 2.3. |
| `everySeconds` | The `everySeconds` argument; absent for a one-off schedule.                                            |
| `count`        | The `count` argument; absent when not given.                                                           |
| `occurrences`  | The number of times the schedule has fired; `0` at `create`.                                           |
| `queued`       | Whether an occurrence of the schedule is queued (Section 4.2); `false` at `create`.                    |

The first `dueAt` is `createdAt + delaySeconds × 1000` with `delaySeconds`; the later of the `at`
instant and `createdAt` with `at`; otherwise `createdAt + everySeconds × 1000`. An `at` earlier
than the call therefore makes the schedule due at once.

A schedule is pending from `create` until it ends: a one-off schedule ends when it fires, a
repeating schedule per Section 2.3, and any schedule on `cancel` (Section 3.3) or when its
session ends (Section 5). Pending schedules are ordered by ascending `dueAt`, ties by creation
order.

### 2.2 Time values

A date-time of this section is a string that matches the `date-time` production of [RFC 3339],
Section 5.6, names a valid calendar date ([RFC 3339], Section 5.7), and has a second value below
`60`. `T` and `Z` are accepted in either case; the offset `-00:00` denotes UTC. Fractional seconds
are truncated to whole milliseconds.

A local time stamp renders an instant, in whole seconds rounded down, as
`YYYY-MM-DDTHH:MM:SS±HH:MM`: the date and 24-hour time in the local zone, the year in at least
four digits, followed by its local offset, both per [billing.md](billing.md), Section 5. Every time
in the tool's text, the scheduled message, and the schedule status line is a local time stamp.

### 2.3 Repeating schedules

A schedule created with `everySeconds` is a repeating schedule; `e` below is
`everySeconds × 1000`. Each firing of a repeating schedule, and each skip (Section 4.1), at check
time `t` with due time `d` MUST, in this order:

1. On a firing, add 1 to `occurrences`.
2. End the schedule after a firing when `occurrences` equals `count`.
3. Otherwise set `dueAt` to `d + e × (⌊(t − d) ÷ e⌋ + 1)`, the first due time on the schedule's
   grid later than `t`; when that value is greater than 8640000000000000, end the schedule.

Due times thus stay on the grid of the first due time, and every grid due time that passed while
the schedule could not fire collapses into the one firing or skip. A repeating schedule without
`count` fires until it is cancelled or the session ends (Section 5).

## 3. Actions

### 3.1 `create`

The call adds one pending schedule and returns at once. The text, on one line, is

```text
Schedule <scheduleId> created at <createdAt>, due <dueAt><repeat>; its message will be inserted into this session when due, queued as a follow-up if an agent run is in progress.
```

where `<repeat>` is empty for a one-off schedule, `, repeating every <everySeconds> s` for a
repeating schedule without `count`, and `, repeating every <everySeconds> s for <count> occurrences`
with it. `<createdAt>` and `<dueAt>` are local time stamps. `details` is
`{ action: "create", scheduleId, createdAt, dueAt, everySeconds?, count? }`, times in milliseconds
since the Unix epoch.

### 3.2 `list`

The call returns the session's pending schedules in the order of Section 2.1, one line each:

```text
<scheduleId> · due <dueAt><repeat> · <preview>
```

`<dueAt>` is a local time stamp; `<repeat>` is empty for a one-off schedule and, for a repeating
schedule, ` · every <everySeconds> s · <occurrences> fired`, followed by ` of <count>` when it has
a `count`, followed by ` · queued` when `queued` is `true`; `<preview>` is the first line of
`message`, cut to its first 120 characters with no marker. With no pending schedule the text is
`(no pending schedules)`. `details` is
`{ action: "list", schedules: [{ scheduleId, createdAt, dueAt, message, everySeconds?, count?, occurrences, queued }…] }`
in the same order, times in milliseconds since the Unix epoch. `list` MUST NOT change any
schedule.

### 3.3 `cancel`

The call ends the pending schedule named by the trimmed `scheduleId`; it fires no more. The text is
`Schedule <scheduleId> cancelled.` and `details` is `{ action: "cancel", scheduleId }`. Cancelling
does not withdraw an occurrence already queued (Section 4.2); the host still inserts it.

## 4. Firing

An agent run is in progress while the host's extension context exposes an abort signal for the
current run. The session is idle per [session-store.md](session-store.md), Section 2. A schedule
is due once the system clock reads at or after its `dueAt`.

### 4.1 Checks

While the session has a pending schedule, the extension MUST check for due schedules at most
1000 ms apart. At a check, in the order of Section 2.1:

- A due repeating schedule whose `queued` is `true` is skipped: it does not fire and its `dueAt`
  advances per Section 2.3.
- When an agent run is in progress or the session is idle, every other due schedule fires
  (Section 4.2). Otherwise — a compaction outside an agent run, or the moment an agent run starts
  or settles — they wait for a later check.

A due schedule MUST fire within 1000 ms after the first instant at which it is due, is not
skipped, and an agent run is in progress or the session is idle. A schedule fires at most once
per check and MUST NOT fire before it is due.

### 4.2 Insertion

The schedules firing at one check fire together: the extension hands one scheduled message to the
host `sendMessage` API with `customType` `"pi-dent-schedule"`, `display: true`, `triggerTurn: true`,
`deliverAs: "followUp"`, and the `content` and `details` below. The host routes it:

- During an agent run it queues the message as a follow-up: the message is inserted when the run
  would otherwise stop, and the run continues with it.
- While the session is idle the message is inserted at once and starts an agent run.

Firing is the hand-off; a one-off schedule ends with it and is never fired again. Each firing
occurrence is queued from the hand-off until either the host emits `message_start` for the
scheduled message carrying it, which inserts it, or a later check finds the session idle without
that event, which means the host discarded it — for example when the user aborts the run and the
host clears its queues. While a repeating schedule has a queued occurrence its `queued` is `true`.
A discarded occurrence MUST NOT be handed to the host again; a one-off schedule whose occurrence is
discarded has ended, and a repeating schedule keeps its `dueAt` and `occurrences`.

When the host `sendMessage` API throws, the hand-off has not happened: the extension MUST leave
the schedules that were to fire unchanged — a one-off schedule keeps its `dueAt` and fires again,
and a repeating schedule keeps its `dueAt`, `occurrences`, and `queued` — and MUST show, for each
of them, the notification

```text
pi-dent: schedule <scheduleId> was not delivered: <error>; it stays pending
```

at level `error` through the host `notify` API ([config-file.md](config-file.md), Section 6).
`<error>` is the `message` of the thrown value when it is an `Error`, else its text. The next
check fires those schedules again per Section 4.1. A schedule whose hand-off fails with the
`<error>` of its last notification MUST NOT show that notification again; a hand-off of that
schedule that succeeds clears the record.

> Note (non-normative): checks repeat within Section 4.1's bound, so without that record a host
> that keeps refusing the hand-off would repeat the notification up to once a second.

The `content` is one text string: one block per firing schedule in the order of Section 2.1,
blocks joined by one empty line. Each block is the schedule header

```text
[Scheduled message <scheduleId> — set by you at <createdAt>, due <dueAt><repeat>; not from the user]
```

with `<createdAt>` and `<dueAt>` (the due time that fired) as local time stamps, a line break, and
the schedule's `message` verbatim. `<repeat>` is empty for a one-off schedule and, for a repeating
schedule, `; occurrence <occurrences>, every <everySeconds> s` with `occurrences` after this firing,
followed by one final marker when this firing ends the schedule under Section 2.3, the first that
applies:

| Condition                     | Final marker                               |
| ----------------------------- | ------------------------------------------ |
| `occurrences` equals `count`  | `, final: count reached`                   |
| the next due time is too late | `, final: next due time not representable` |

A `message` starting with `/` is inserted like any other and never executed as a slash command.
The scheduled message is inserted in the user role; its schedule header text is the only thing
marking it as the session's own scheduled message rather than the user speaking.
`details` is `{ schedules: [{ scheduleId, createdAt, dueAt, occurrence? }…] }` in the same order,
`occurrence` being `occurrences` after this firing for a repeating schedule, times in milliseconds
since the Unix epoch.

## 5. Lifecycle

- Pending schedules are held in the memory of the process, keyed by session ID. The extension
  MUST NOT write a schedule to the session file or any other file; only an inserted scheduled
  message enters the session file, through the host.
- A reload MUST NOT fire, cancel, or change a pending schedule, except that an occurrence still
  queued at the reload counts as discarded (Section 4.2). The ending boot window MUST stop
  checking at its `session_shutdown`; the next boot window MUST resume checking the same session's
  schedules at its `session_start`, firing or skipping those already due per Section 4. The
  schedule status line follows Section 6: it is cleared at that `session_shutdown` and, when a
  schedule is still pending, set again at that `session_start`.
- Compaction and navigation within the session's tree MUST NOT change a pending schedule.
- When the session ends — `session_shutdown` with reason `quit`, `new`, `resume`, or `fork` — its
  pending schedules MUST end without firing. A session started afterwards, including one resuming
  the same session file, has no pending schedule.
- A child session never binds `Schedule` ([agent-tool.md](agent-tool.md), Section 3.1).

> Note (non-normative): a child session ends with its attempt, so a schedule in it would fire into
> a session no attempt is waiting on.

## 6. Schedule status line

While the main session has an interactive terminal UI and at least one pending schedule, the
extension MUST show the schedule status line through the host `setStatus` API under the key
`pi-dent-schedule`:

```text
schedule: <n> pending<repeating> · next <dueAt>
```

`<n>` is the number of pending schedules; `<repeating>` is empty when none of them repeats, else
` (<r> repeating)` with `<r>` the number of pending repeating schedules; `<dueAt>` is the local
time stamp of the first pending schedule in the order of Section 2.1. The line MUST reflect each
`create`, `cancel`, firing, skip, and end of a schedule, and the session start after a reload,
within 1000 ms. With no pending schedule, and at every `session_shutdown` — a reload included —
the extension MUST clear the key; the next boot window then reflects the line at its
`session_start` per the rule above.

When the host `setStatus` API throws while a `create` or `cancel` call refreshes the line, the call
MUST still return its result of Section 3.1 or 3.3, the schedule it created or cancelled stays
created or cancelled, and the extension MUST show the notification

```text
pi-dent: schedule status line could not be updated: <error>
```

at level `error` through the host `notify` API ([config-file.md](config-file.md), Section 6),
`<error>` as in Section 4.2. At a check, no failure is reported when the host `setStatus` API
throws.

When a check's host `isRunning` or `isIdle` API call throws, the schedules are left unchanged and
the extension MUST show the notification

```text
pi-dent: schedule check failed: <error>
```

at level `error` through the host `notify` API, `<error>` as in Section 4.2. The same `<error>` MUST
NOT be shown again at a later check until a check completes without it.

When the host `notify` API itself throws while showing a notification of this section or of
Section 4.2, the call or check MUST carry on as if the notification had been shown; no failure is
reported.

## 7. Normative references

- [RFC 3339] Date and Time on the Internet: Timestamps, G. Klyne and C. Newman, 2002: Section 5.6
  (the `date-time` and `time-offset` productions) and Section 5.7 (date validity).

## 8. Specification gaps

- Which of a scheduled message and a user prompt submitted at the same instant the session becomes
  idle starts the agent run is the host's.
- When the host defers a hand-off made while its agent run is settling, a check can find the
  session idle before the deferred message starts, so an occurrence counted as discarded is
  inserted after all.
- Whether the host `sendMessage` API reports a failure after it returns is the host's; the
  extension relies on a throw, and a failure it reports no other way is not seen.
