# Session store specification

This document specifies the local session store: the database through which the pi-dent processes
of one machine share session records and messages. It covers the store's location and format,
its two tables, a session's membership and lifecycle, and message delivery. The `Fleet` tool
([fleet-tool.md](fleet-tool.md)) is the surface over it.

## 1. Location and format {#location}

The local session store is one SQLite database file in write-ahead-log journal mode with a busy
timeout of 5000 ms. Its path is the value of the environment variable `PI_DENT_FLEET_DB` when set and
non-empty, else `~/.pi/pi-dent/fleet-v2.sqlite`.

The format version is `2` and is recorded as the database's `user_version`. Opening the store
MUST, in this order:

1. Create the file's directory and the file when absent.
2. When `user_version` is `0` and the database holds no table: create the tables of [session records](#session-records)
   and [messages](#messages), each column `NOT NULL` unless its type says nullable, and set `user_version` to `2`.
3. When `user_version` is `2`: use the database.
4. Otherwise: leave the file unchanged and fail the opening with the error
   `unsupported session store version <user_version>`.

The check of step 2 and the creation MUST happen inside one transaction begun with
`BEGIN IMMEDIATE`, so that of two processes opening an absent file the second finds the first's
tables; a creation that fails is rolled back whole. A file of another format version, such as
`~/.pi/pi-dent/fleet.sqlite`, MUST NOT be read, changed or deleted.

> Note (non-normative): the store holds live coordination state, not history, so a new format
> version starts from an empty file; sessions of processes that use another file are not in this
> one's fleet.

## 2. Session records {#session-records}

Table `fleet_sessions`, one row per session in the fleet, one per child session record, and one per
hidden record ([membership and lifecycle](#membership-lifecycle)):

| Column              | Type              | Contract                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_id`        | text, primary key | The session ID.                                                                                                                                                                                                                                                                    |
| `cwd`               | text              | The session's working directory as an absolute path.                                                                                                                                                                                                                               |
| `repo_root`         | text, nullable    | The repository root of `cwd` ([fleet-tool.md, action `list`](fleet-tool.md#list)), else null.                                                                                                                                                                                      |
| `state`             | text              | `idle` while the session is idle (below), else `running`.                                                                                                                                                                                                                          |
| `updated_at`        | integer           | Time of the last write, milliseconds since the Unix epoch.                                                                                                                                                                                                                         |
| `turns_json`        | text              | JSON array of the latest 5 turn records, oldest first (below).                                                                                                                                                                                                                     |
| `owner_pid`         | integer           | Process ID of the boot window's process.                                                                                                                                                                                                                                           |
| `owner_boot`        | text, nullable    | The owning boot window's ID (8 lowercase hexadecimal digits); null after a reload released it.                                                                                                                                                                                     |
| `owner_started`     | integer           | Approximate start time of the owner process, milliseconds since the Unix epoch.                                                                                                                                                                                                    |
| `agents_dir`        | text, nullable    | The session's agent directory as an absolute path, written at registration and kept across a reload; null for a hidden record ([membership and lifecycle](#membership-lifecycle)). Retention behavior is owned by [agent-tool.md, retention sweep](agent-tool.md#retention-sweep). |
| `hidden`            | integer           | `1` for a hidden record ([membership and lifecycle](#membership-lifecycle)), else `0`.                                                                                                                                                                                             |
| `parent_session_id` | text, nullable    | The session ID of the dispatching session of a child session record ([membership and lifecycle](#membership-lifecycle)); null for a fleet session.                                                                                                                                 |

A turn record is `{ "command": string, "goal": string, "files": string[], "startedAt": number }`:

| Field       | Contract                                                                                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`   | The first line of the text of the user message that started the turn, cut to at most 120 characters.                                                                                                                                                           |
| `goal`      | The turn's goal: the first line, cut to at most 120 characters, of the text of the first assistant message of the turn whose text is not whitespace-only, that text trimmed at its ends before the line is taken; empty until there is one.                    |
| `startedAt` | The time the turn started, milliseconds since the Unix epoch.                                                                                                                                                                                                  |
| `files`     | The paths changed by the turn's successful tool calls, in order, without duplicates: the `path` (else `file_path`) input of `edit` and `write`, and the `path` and `moveTo` of each `details.files` entry of `apply_patch` (tool names compared in lowercase). |

The text of a message is its `message.content` when that is a string; when it is an array, the
`text` of each element with `type` `text` and a string `text`, those texts joined by one line
feed, an element without such a text contributing nothing; otherwise the empty string. This is
text elements only, not the content text of [session-transcript.md, transcript items](session-transcript.md#transcript-items).

A session is idle while the host reports it idle: no agent run and no compaction in progress.
`state` is `running` also from the delivery of a `followUp` message of kind `send` ([delivery](#delivery))
until its turn starts; a delivered `query` ([fleet-tool.md, action `query`](fleet-tool.md#query)) changes no
`state`. The owning boot window MUST update `state` when it finds it out of date, checking at most
250 ms apart.

A turn is a user message that arrives while no turn is in progress, the user messages that
arrive during it, and the agent run that follows; it ends when that agent run ends.

## 3. Messages {#messages}

Table `fleet_messages`, one row per `Fleet` `send` and `query` request
([fleet-tool.md, action `send`](fleet-tool.md#send) and [fleet-tool.md, action `query`](fleet-tool.md#query)); the parameter and result names below are that
tool's:

| Column              | Type                       | Contract                                                                                                                                                                                    |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message_id`        | integer, autoincrement key | The `messageId`.                                                                                                                                                                            |
| `sender_session_id` | text                       | The calling session's ID.                                                                                                                                                                   |
| `target_session_id` | text                       | The resolved target session ID.                                                                                                                                                             |
| `boot_id`           | text                       | The sending boot window's ID; for a query reply ([fleet-tool.md, action `query`](fleet-tool.md#query)), the `boot_id` of its query, so the reply lives as long as the querying boot window. |
| `kind`              | text                       | `send` or `query`.                                                                                                                                                                          |
| `subject`           | text, nullable             | The `subject`, null when absent.                                                                                                                                                            |
| `body`              | text                       | The `body`.                                                                                                                                                                                 |
| `deliver`           | text                       | `steer` or `followUp`; `followUp` for a `query`, whose delivery ignores the `followUp` rules of [delivery](#delivery).                                                                      |
| `abort`             | integer                    | `1` when `abort: true`, else `0`.                                                                                                                                                           |
| `correlation_id`    | text, nullable             | The `correlationId` of a `query`, else null.                                                                                                                                                |
| `status`            | text                       | `pending`, `delivered`, or `rejected` (`unknown` is never stored).                                                                                                                          |
| `rejection_reason`  | text, nullable             | The rejection reason of a `rejected` row.                                                                                                                                                   |
| `created_at`        | integer                    | Enqueue time, milliseconds since the Unix epoch.                                                                                                                                            |
| `delivered_at`      | integer, nullable          | Time the row became `delivered`.                                                                                                                                                            |
| `deliver_text`      | text, nullable             | The envelope text of a `send` whose `body` does not start with `/`, rendered at enqueue; else null ([fleet-tool.md, delivery modes](fleet-tool.md#delivery-modes)).                         |

Rejection reasons are those of [fleet-tool.md, delivery modes](fleet-tool.md#delivery-modes) and [fleet-tool.md, waited query](fleet-tool.md#waited-query), and these:
`target session ended before delivery` ([membership and lifecycle](#membership-lifecycle)), `delivery failed: <message>` (the host refused
the delivery), `target session does not support built-in commands` (a host command the target
cannot apply), and `target session does not support queries` (the target's host offers no query
dispatch).

## 4. Membership and lifecycle {#membership-lifecycle}

A main session registers when it starts in a boot window; a child session registers no record
of its own: the boot window that runs its dispatch writes its child session record ([membership and lifecycle](#membership-lifecycle)),
and a hidden record when it has a waited query and no child session record. A record whose `owner_boot` is set, is not
that boot window's, and whose owner process is not gone refuses the registration: the record is
left unchanged, no message is delivered to the session by this boot window, and the extension
MUST show the `warning` notification
`pi-dent: session <sessionId> is already owned by another live boot window; Fleet delivery to this session is disabled`.
Otherwise the record is written with this boot window as owner and the session's pending messages
are processed ([delivery](#delivery)). The record is rewritten whenever a turn starts, ends, names its goal,
or changes a file, by the boot window that owns it only; a refused session's turns leave the
record unchanged. Registrations of one session by separate boot windows are serialized: each checks the owner and
writes the record in one immediate write transaction. The first to commit owns the session; a later
registration that finds that owner live is refused, and its boot window shows the warning above.

- The owner process of a record is gone when `owner_pid` is set, the record is not owned by the
  checking boot window, and either the process does not exist (a permission-denied probe counts
  as existing), or `owner_pid` is the checking process's own and `owner_started` is more than
  1000 ms earlier than the checking process's start. A record whose `owner_pid` is the checking
  process's own and whose `owner_boot` is set is instead gone exactly when that boot window has
  been torn down in the process.
- The local session store MUST hold a session's record only while the session is in the fleet,
  or while the dispatch that runs it does:
  - A session that ends MUST have its record deleted at once, by the boot window that owns it; a
    boot window whose registration for the session was refused deletes nothing and leaves the
    record and its messages to the owner.
  - A record whose owner process is gone MUST be deleted when that is detected: when a boot
    window opens the store, when target resolution ([fleet-tool.md, parameter schema](fleet-tool.md#parameter-schema))
    reads the record, and at most 2000 ms apart while the boot window has a registered session, a
    hidden record, or a child session record. A session registered by the checking boot window is
    never deleted this way.
  - Deleting a record MUST reject every message still `pending` for that session with the reason
    `target session ended before delivery` ([fleet-tool.md, action `status`](fleet-tool.md#status)).
  - A deletion of a record whose owner process is gone MUST delete the record only as the detection read it: a
    record another boot window registered as its own after that read belongs to that window and
    MUST be left unchanged, with its messages.
  - A `send` or `query` whose target's record the store no longer holds when its row is written
    MUST be written `rejected` with the reason `target session ended before delivery`, never
    `pending`.
  - A reload MUST keep the record, set its `state` to `idle` and its `owner_boot` to null, and
    leave its pending messages untouched. A child session record is not kept: it is deleted with
    its boot window (below). Like deletion, the rule binds the boot window that owns
    the session: a refused registration leaves the record and its messages untouched.
- A live session is a session with a non-hidden record in the local session store whose owner
  process is not gone. Its listing and target-resolution behavior is owned by
  [fleet-tool.md, parameter schema](fleet-tool.md#parameter-schema) and [fleet-tool.md, action `list`](fleet-tool.md#list).
- A session has a live session identity in a boot window when that boot window registered it and
  was not refused; the record's `owner_boot` then names that boot window. It has no live session
  identity in any other boot window, none while its `owner_boot` is null (a reload), none when
  its registration was refused, and none when its record is hidden — a hidden record's session
  is a child session. A child session has no live session identity, even while a child session
  record gives it an address: the boot window that runs its dispatch wrote that record, the
  session itself did not register it.
- A child session record is a non-hidden record whose `parent_session_id` is set. The boot
  window that runs an `Agent` dispatch ([agent-tool.md, child session](agent-tool.md#child-session)) MUST write it
  once the child session exists and before the first prompt of the dispatch, with
  `parent_session_id` set to the dispatching session's ID, `state` `running`, `agents_dir` set to
  the child session's agent directory ([agent-tool.md, child session](agent-tool.md#child-session)), and one turn
  record whose `command` is the first line of the dispatch's task text; it MUST delete the record
  when the dispatch settles, in both delivery modes, and when its boot window closes for any
  reason, a reload included, because the dispatch ends with the window. Recovery attempts continue
  the same child session and keep the record. The record gives the child session an address
  ([delivery](#delivery)) and its session is a target ([fleet-tool.md, parameter schema](fleet-tool.md#parameter-schema)); it is not a
  fleet session, and its listing follows [fleet-tool.md, action `list`](fleet-tool.md#list). Its `state`
  stays `running` for the life of the record.
- A hidden record is a record whose `hidden` is `1`. It gives a child session that has no child
  session record an address for the reply of a waited query ([fleet-tool.md, waited query](fleet-tool.md#waited-query)) and nothing else: its session is not in the fleet, MUST NOT be listed or resolved
  as a target. Its `state` is `running` and its owner columns name the boot window that wrote it,
  which MUST delete it when the session's last waited query ends. The rules above for a gone owner
  process and for deleting a record apply to it unchanged. Retention sweep rules, including
  treatment of a null `agents_dir`, are owned by [agent-tool.md, retention sweep](agent-tool.md#retention-sweep).
- When a boot window opens the store, message rows created more than 7 days earlier are deleted.
  When a boot window with no remaining session closes through quit, every row it sent (`boot_id`)
  is deleted; through reload, those not `pending` are deleted.

## 5. Delivery {#delivery}

A boot window delivers only the messages of sessions it owns. It delivers the messages of a child
session record it wrote into the child's own conversation, under the delivery modes of
[fleet-tool.md, delivery modes](fleet-tool.md#delivery-modes). It processes a session's `pending`
messages in ascending `message_id` order when a message is enqueued, a session registers or turns
idle, and every 250 ms while it has a registered session, a hidden record, or a child session
record. A `followUp` turn
starts only when the target is idle and no earlier `followUp` delivery of the session is awaiting
its turn start. One such processing that applies a `followUp` host command handles no further
`followUp` message of the session in it; `steer` messages are not affected. These `followUp` rules
apply to messages of kind `send` only: a `query` is delivered per [fleet-tool.md, action `query`](fleet-tool.md#query). A message becomes `delivered` once the host accepts it; a host refusal makes it
`rejected` (`delivery failed: <message>`).

A failure inside a periodic pass of the store — the `state` sync, the processing of pending
messages, the waited-query check, and the deletion of records whose owner process is gone
([membership and lifecycle](#membership-lifecycle)) — ends that pass; the work it left is retried by the next pass and no failure is
reported.

> Note (non-normative): deliveries are processed by the owning boot window rather than by the
> sender because only the owner holds the live session to inject into.

## 6. Specification gaps {#gaps}

- Behavior when the local session store cannot be opened, and store write failures other than
  those before a waited query is enqueued.
- A file at the `PI_DENT_FLEET_DB` path that is another application's SQLite database with
  `user_version` `2` is used as the store.
