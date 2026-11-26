# Fleet tool specification

This document specifies the `Fleet` tool: the session-coordination surface over the local fleet,
with the actions `list`, `send`, `query`, and `status`. The fleet is local to one machine —
discovery and delivery go through the local session store ([session-store.md](session-store.md)),
which every pi-dent process on the machine shares; there is no network transport and no cross-machine
discovery. The extension MUST register the tool through the host `registerTool` API with `name` and
`label` `"Fleet"` and `renderShell` `"self"`.

## 1. Parameter schema {#parameter-schema}

The parameter schema is a JSON object schema with `type: "object"` and
`additionalProperties: false`, with one required field: `action`, one of `list`, `send`, `query`,
or `status`. All other fields are optional in the schema; each action accepts only its fields
below, and every other action/field combination MUST be rejected as a tool error at execution time.

| Field       | Type                                      | Actions         | Contract                                                                                                                                                                                                                                                  |
| ----------- | ----------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`    | `"list" \| "send" \| "query" \| "status"` | all             | The sub-command to run.                                                                                                                                                                                                                                   |
| `scope`     | `"children" \| "repo" \| "machine"`?      | `list`          | `machine` (default): every fleet session on this machine, across repositories. `repo`: the fleet sessions of the current Git repository only, worktrees shared. `children`: the live child sessions the calling session spawned ([action `list`](#list)). |
| `format`    | `"compact" \| "full" \| "json"`?          | `list`          | `compact` (default): one line per session; `full`: recent turns per session; `json`: structured ([action `list`](#list)).                                                                                                                                 |
| `subject`   | string?                                   | `send`, `query` | Short subject, carried in the message envelope ([delivery modes](#delivery-modes)).                                                                                                                                                                       |
| `body`      | string?                                   | `send`, `query` | Required for `send` and `query` (non-empty after trimming). The message text queued for the target session (or passed as `task` on a `query`).                                                                                                            |
| `target`    | string?                                   | `send`, `query` | One target.                                                                                                                                                                                                                                               |
| `targets`   | string[] (min 1)?                         | `send`          | Several targets; resolved targets are deduplicated.                                                                                                                                                                                                       |
| `broadcast` | `"repo" \| "machine"`?                    | `send`          | Fan-out scope: the sessions a `list` of that scope returns, without the calling session.                                                                                                                                                                  |
| `deliver`   | delivery mode?                            | `send`          | `steer` or `followUp` ([delivery modes](#delivery-modes)). Default `followUp`.                                                                                                                                                                            |
| `abort`     | boolean?                                  | `send`          | `true` is valid only with `deliver: "steer"`, else the call MUST be rejected as a tool error: abort the target's active turn before injecting. `false` (default) is a no-op with any delivery mode.                                                       |
| `messageId` | number?                                   | `status`        | Required for `status`, an integer. The id returned by a prior `send` or `query`. Only messages the caller sent are visible.                                                                                                                               |

The calling session is the session whose tool call invokes `Fleet`; its session ID is the sender of
the call's messages. A `Fleet` call other than `list` MUST fail as a tool error with the error text
`no live session identity for Fleet action "<action>"` when the calling session has no session ID,
or when it is not a child session and has no live session identity here
([session-store.md, membership and lifecycle](session-store.md#membership-lifecycle)). A child session
([session-store.md, membership and lifecycle](session-store.md#membership-lifecycle)) is never refused: it MAY `send`, and its `query`
is a waited query ([waited query](#waited-query)). A `list` of scope `children` also needs the calling session's ID,
and MUST fail with the same error text when it has none.

A `send` MUST provide `body` and exactly one target mode — `target`, `targets`, or `broadcast` —
and MUST omit the other two. A `query` MUST provide `body` and `target` alone (`targets` and
`broadcast` MUST be omitted). A `body` that is empty after trimming MUST be rejected as a tool
error. A `target`, or a `targets` entry, that is empty after trimming MUST be rejected with the
error text `target must be a non-empty string` — as a tool error for `target`, as a failed target
for a `targets` entry ([result](#result)). The schema requires `target` and every `targets` entry to be
a string, so a non-string value is a schema rejection ([task.md, task kinds](task.md#task-kinds)).

A target resolves, after trimming, as an exact session ID or else a unique session-ID prefix
(case-sensitive), among the live fleet sessions and the calling session's own live child sessions
([session-store.md, membership and lifecycle](session-store.md#membership-lifecycle)); a session that has ended, or whose owner process
is gone, is an unknown target. A child session is a candidate only for the session that spawned
it, so it is an unknown target for every other caller. A target MAY resolve to the calling
session. A target that does not resolve is rejected with one of these errors:

| Condition                           | Error text                                         |
| ----------------------------------- | -------------------------------------------------- |
| No session ID equals or extends it  | `unknown target session "<target>"`                |
| More than one session ID extends it | `ambiguous target prefix "<target>" matches <ids>` |

`<ids>` is the matching session IDs in ascending order by the host's default locale-sensitive
string comparison ([action `list`](#list)), joined by `", "`. For a `send` or `query`
the rejection is a tool error carrying that text. Target resolution is shared by `send` and
`query`.

For schema-valid arguments, the tool MUST check action/field combinations first, in the
arguments' property order, rejecting the first invalid field with
`field "<field>" is not valid for action "<action>"`. It MUST then check the calling session's
identity as above, then the action-specific checks in this order, reporting the first failure:

| Action   | Check order                                                                                                   | Error text for a failed check                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`   | Non-empty `body`; `abort` with delivery mode; exactly one target mode; target validation and resolution above | `body is required and must be a non-empty string for action "send"`; `abort: true is valid only with deliver: "steer"`; `send requires exactly one recipient mode: target, targets, or broadcast`; target error above |
| `query`  | Non-empty `body`; non-empty `target`; target resolution above                                                 | `body is required and must be a non-empty string for action "query"`; `target must be a non-empty string`; resolution error above                                                                                     |
| `status` | Present integer `messageId`                                                                                   | `messageId is required and must be an integer for action "status"`                                                                                                                                                    |

## 2. Action `list` {#list}

- `list` is read-only: a call MUST NOT change fleet state.
- `list` MUST list only live sessions ([session-store.md, membership and lifecycle](session-store.md#membership-lifecycle)): it
  omits a record whose owner process is gone, without deleting it.
- Scopes `machine` and `repo` list fleet sessions only: a child session record
  ([session-store.md, membership and lifecycle](session-store.md#membership-lifecycle)) is never among them, so a `broadcast` of
  either scope never reaches a child session.
- Scope `children` lists the live child sessions whose parent is the calling session — the agents
  it spawned, whether it is a main session or a child session itself — and applies no repository
  filter. Grandchildren are not in it: a child session's parent is the session that dispatched it.
- Sessions are listed with `running` sessions first, then in ascending session-ID order by the
  host's default locale-sensitive string comparison. The calling session is listed like any other.
- Scope `repo` lists the sessions whose repository root equals the calling session's; when the
  calling session's working directory is in no repository, the sessions whose working directory
  equals it. A session's repository root is derived from its working directory when its record is
  written ([session-store.md, session records](session-store.md#session-records)): the nearest ancestor directory
  containing `.git`; when `.git` is a directory, that ancestor's resolved real path; when `.git` is
  a file `gitdir: <path>` whose directory holds a `commondir` file, the resolved real path of the
  parent of the directory `commondir` names, so that linked worktrees share one root; otherwise the
  ancestor's resolved real path. No `.git` ancestor means no repository root.
- A listed session's `<kind>` is `instance` when its owner process
  ([session-store.md, membership and lifecycle](session-store.md#membership-lifecycle)) is the calling session's process, else
  `machine`.
- Three formats. The snapshot notice is the line
  `(Discovery snapshot — local machine only; carries no authoritative session age.)`:
  - `compact` (default): one line per session `<sessionId> · <kind> · <state> · <cwd> · <summary>`, where
    `<summary>` is the latest turn's goal when non-empty, else its command when non-empty, else
    `(no turns yet)`; then the snapshot notice as the last line.
  - `full`: per session a block of the line `<sessionId> [<state>] kind=<kind> cwd=<cwd>` followed by either
    the line `  (no turns recorded)` or, oldest first, one line per retained turn
    `  turn <n>: command=<command> goal=<goal> files=<files>`, `<n>` counting from 1, `<command>`
    and `<goal>` as JSON string literals, `<files>` the changed files joined by `", "` or `(none)`;
    blocks are separated by one empty line, and the snapshot notice follows the last block after
    one empty line.
  - `json`: a JSON object, indented by 2 spaces, `{ "scope": <scope>, "snapshot": true,
    "sessions": [<session>…] }` with no notice, where `<session>` is `{ "sessionId", "kind", "state",
    "cwd", "repoRoot"?, "parent"?, "turns": [{ "command", "goal", "files", "startedAt" }…] }`; `repoRoot` is
    omitted for a session in no repository. `parent` is present for a child session and is the
    session ID of the session that spawned it.
- When no session is in scope, `compact` and `full` return `(no active sessions in <scope> scope)`,
  one line break, and the snapshot notice; `json` returns its object with `"sessions": []`.
- `details` carries `{ action: "list", scope, format, snapshot: true, sessions }`, `format` being
  the given value or `compact`, `sessions` the `<session>` objects of the `json` format.
- Every listed session is a valid target for `send`.
- A listing is a discovery snapshot, not durable presence: it carries no authoritative session age.

## 3. Action `send` {#send}

### 3.1 Result {#result}

- A unicast enqueues one message and returns its `messageId` (the handle for `status`), the resolved
  target session ID (`target`), the target state at enqueue time (`state`, per
  [session-store.md, session records](session-store.md#session-records)), and the message `status` after the immediate
  delivery attempt of [session-store.md, delivery](session-store.md#delivery) (`pending`, `delivered`, or
  `rejected`).
  - Text, on one line:

    ```text
    Fleet message <messageId> (<status>) to <target> (target state: <state>, deliver: <deliver>). Do not resend — poll Fleet status with messageId <messageId>.
    ```

  - A `rejected` status makes the call a tool error with the text
    `Fleet send to <target> rejected (messageId <messageId>): <reason>`.
  - `details`: `{ action: "send", messageId, target, state, status, deliver, rejectionReason? }`.
- Delivery is asynchronous: a `followUp` behind a running target stays queued until that turn
  ends.
- A child session target is reachable only through `target` or `targets` of the session that
  spawned it: no `broadcast` scope lists one ([action `list`](#list)).
- Fan-out (`targets` or `broadcast`) is independent best-effort: each target resolves and delivers
  on its own, and a target failure is reported — never rolled back, never blocking the other
  targets. The call is a tool error only when no recipient succeeded, that is when every target
  failed and at least one target failed; a partial success is not a tool error.
  - Recipients are the resolved targets, deduplicated by session, in first-occurrence order of
    `targets`, or the sessions of the `broadcast` scope in `list` order without the calling
    session. A `targets` entry that is empty after trimming, or does not resolve, becomes a
    failed target with its error text.
  - A recipient whose status after the immediate delivery attempt is `rejected` becomes a failed
    target with its `messageId` and `rejectionReason`.
  - `failed` lists first the unresolved entries in `targets` order, each `<target>` being the entry
    as given, then the rejected recipients in recipient order, each `<target>` being the resolved
    session ID; a rejected recipient is not in `recipients`.
  - Text: one line `sent messageId=<messageId> target=<target> state=<state> status=<status>` per
    recipient, then one line `failed target=<target>: <error>` per failed target;
    `(no recipients matched)` when both are empty.
  - `details`: `{ action: "send", deliver, recipients: [{ target, messageId, state, status }…],
    failed: [{ target, messageId?, error }…] }`.

### 3.2 Delivery modes {#delivery-modes}

| Mode       | Contract                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steer`    | Injects after the target's current tool batch and before its next model call, without cancelling the turn by default; in-flight work stays intact. On an idle target it starts a turn. `abort: true` discards the active turn first when the target is not idle, and the body is delivered as a new turn once the aborted turn has settled. |
| `followUp` | Waits until the target is idle, then delivers and starts a turn. Never interrupts, never strands.                                                                                                                                                                                                                                           |

A message is delivered to the target as a user message of its conversation. Its text is the
message envelope: the line `[Fleet from <senderSessionId> — <subject>]` (or, when `subject` is
absent or empty, `[Fleet from <senderSessionId>]`), a line break, and the `body`.

A `body` starting with `/` is executed by the target instead, with no envelope; the command token
and argument string split per [slash-commands.md, registration](slash-commands.md#registration). A body whose
token is empty is rejected as `empty slash command "/"`. The target classifies the body
when it processes the message, in its own boot window, without waiting for idleness:

| Command token                                               | Outcome                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<namespace>:<command>` naming a plugin command             | The plugin command is rendered against the target's plugin catalog ([plugin.md, slash commands](plugin.md#slash-commands), [plugin.md, argument substitution](plugin.md#argument-substitution)) with the arguments; the rendered body is delivered as a user message honoring the delivery mode. |
| `compact` or `abort`                                        | The host command is applied to the target directly and starts no turn — with `followUp` only once the target is idle, with `steer` at once. Arguments are ignored.                                                                                                                               |
| empty (no character between `/` and the first U+0020 space) | Rejected: `empty slash command "/"`.                                                                                                                                                                                                                                                             |
| `<namespace>:<command>` naming no plugin command            | Rejected: `unknown plugin slash command "/<token>"`.                                                                                                                                                                                                                                             |
| a plugin command whose rendering fails                      | Rejected: `failed to render "/<token>": <message>`.                                                                                                                                                                                                                                              |
| any other token                                             | Rejected: `unsupported slash command "/<token>"`.                                                                                                                                                                                                                                                |

A rejection makes the message's `status` `rejected` with the quoted `reason`; `<token>` is the
command token. `compact` and `abort` are host commands: slash commands the host itself provides.
The body is classified and rendered once per delivery attempt, and that one rendering is what the
attempt delivers.

- Delivery targets a conversation turn; routing to non-conversation consumers is out of scope.
- `delivered` means the target session accepted the message for its turn (or applied the
  host command), not that it was read, acted on, or answered.
- A child session target ([session-store.md, membership and lifecycle](session-store.md#membership-lifecycle)) receives messages into
  its own conversation, delivered by the boot window that runs its dispatch. The modes mean for it
  what they mean for a main session: `steer` enters the child's running turn or starts one when it
  is idle, and `followUp` waits until the child session is idle. A `followUp` drained at a turn's
  end is accepted when the child takes it, before that turn starts. Its `compact` and `abort` host
  commands apply to the child session; its plugin commands render against the catalog of the boot
  window that runs the child, which is the dispatching session's. The dispatch's wait for such a
  turn, and what a Fleet abort does to it, follow [agent-tool.md, child session](agent-tool.md#child-session).

## 4. Action `query` {#query}

`query` is request/reply over one sibling session — or over a child session of the calling session
— executed by a dispatch on the target:

- The call enqueues the query `body` to the target and returns immediately with the request's
  `messageId` (statusable under [action `status`](#status)), a `correlationId` (`q-` and 8 lowercase hexadecimal
  digits) tying the reply to this query, the resolved target session ID, and the target's state at
  enqueue time (`state`, [result](#result)). The text, on one line, is:

  ```text
  Fleet query <messageId> enqueued to <target> (correlationId: <correlationId>, target state: <state>). Do not poll for the reply — the target will deliver a followUp reply quoting correlationId <correlationId> when its child session settles.
  ```

  `details` is `{ action: "query", messageId, correlationId, target, state }`. The body is never
  parsed as a slash command; the query is delivered immediately, whether the target is running or
  idle, and its `status` becomes `delivered` once the target starts the dispatch.

- On delivery, the target MUST run the query as a dynamic dispatch
  ([agent-tool.md](agent-tool.md)) with `task` set to the `body`, owned by the target session as
  its dispatching session — never as a turn on the target's main conversation. Its task registry
  and completion notifications follow [task-registry.md, ownership](task-registry.md#ownership) and [task-registry.md, cohorts and completion notification](task-registry.md#cohorts).
  Its tool cap is exempt from the `Agent` requirement
  ([agent-tool.md, tools](agent-tool.md#tools)) and MUST contain only the read-only tools
  `read`, `grep`, `find`, and `ls` present in the target's tool cap.
  Its `prompt` is exactly
  `You are answering a Fleet query from a sibling session in an isolated child session. Inspect the workspace and answer concisely.`;
  its model and thinking resolve from the `inherited` tier
  ([agent-tool.md, model and thinking](agent-tool.md#model-thinking)).
- Delivered queries run concurrently, without a per-target limit. A query is delivered and run
  at most once; identical queries are independent, each with its own `messageId` and
  `correlationId`.
- When the dispatch settles, the target MUST send exactly one reply to the querying session. The
  reply is an ordinary `send` from the target to the querying session with `followUp` delivery
  ([action `send`](#send) and [action `status`](#status)), `subject` `Re: <subject>` when the query's `subject` is present and not
  empty, else `Query reply <correlationId>`, and the `body`
  `[Fleet query reply correlationId=<correlationId>]`, a line break, and the reply text. The
  reply text is the dispatch's result text ([agent-tool.md, result contract](agent-tool.md#result-contract): the final
  answer, or the failure result when it did not complete), or `Query error: <message>` when the
  dispatch itself raised an error. Because the body starts with `[`, a reply is never executed as
  a slash command. The reply is never resent, and none is sent when the querying session has no
  record in the local session store: it has ended, or its waited query ([waited query](#waited-query)) has.
- When the dispatch is cancelled because its task registry ends
  ([task-registry.md, ownership](task-registry.md#ownership)), the one reply's text MUST be
  `Query cancelled: the target session ended or reloaded.` A query still `pending` when the target
  reloads stays `pending` and is delivered in the target's next boot window; one still `pending`
  when the target ends becomes `rejected` ([action `status`](#status)). A child session target's record lifetime,
  and the rejection of the queries still pending for it, follow
  [session-store.md, membership and lifecycle](session-store.md#membership-lifecycle).
- When the local session store refuses the reply's write, the target's boot window MUST show the
  `warning` notification `pi-dent: Fleet query reply to <sessionId> failed: <message>`,
  `<sessionId>` being the querying session's ID and `<message>` the error's message, and MUST NOT
  resend the reply.

### 4.1 Waited query {#waited-query}

A `query` whose calling session is a child session is a waited query. It differs from [action `query`](#query) only as follows:

- The calling boot window MUST hold an address for the calling session
  ([session-store.md, membership and lifecycle](session-store.md#membership-lifecycle)) from before the query is enqueued until the
  session's last waited query ends: the child session record of a calling session that has one,
  else a hidden record.
- The call MUST NOT return until the query ends. The reply is not delivered as a turn: the calling
  boot window consumes it, marking it `delivered`, and the call returns the text
  `Fleet query <messageId> to <target> answered (correlationId: <correlationId>).`, a line break,
  and the reply text, with `details`
  `{ action: "query", messageId, correlationId, target, state, reply }`.
- The call MUST fail as a tool error with the text
  `Fleet query <messageId> to <target> failed: <reason>` when no reply can arrive. `<reason>` is
  the query's rejection reason when it becomes `rejected`; `target session ended before replying`
  when the target's record is deleted first; `cancelled` when the tool call is aborted, the
  calling boot window closes, or the dispatch that runs the calling session settles. A query that
  ends `cancelled` while still `pending` MUST be rejected with the reason `cancelled`, so the
  target never runs it. A reply the local session store already holds for the query settles the
  call, even when the target's record is deleted in the same pass.
- If a local session store write is refused or fails before the waited query is enqueued, the call
  MUST return a tool error, not throw an exception, with the text `Fleet query failed: <message>`,
  where `<message>` is the store error's message. The failed wait MUST leave no hidden record or
  poll loop behind; other active waits or registered endpoints MUST remain unaffected.
- A calling child session whose record belongs to another live boot window MUST NOT wait: no reply
  could reach this window, so the call MUST return a tool error with the text
  `Fleet query failed: session <sessionId> is owned by another live boot window`, `<sessionId>`
  being the calling session's ID, and MUST enqueue no query.
- Any other message `pending` for a session with a hidden record MUST be rejected with the reason
  `session takes query replies only`. A calling session that has a child session record instead
  takes its other messages as a session does — its boot window delivers them to its conversation —
  and only the query reply settles the wait.

## 5. Action `status` {#status}

`status` is transport-level only. The call returns, as text, `messageId=<messageId>
status=<status>` followed, for each of the following that is present, by ` target=<target>`,
` deliveredAt=<ms since the Unix epoch>`, and ` reason=<rejection reason>`; and `details`
`{ action: "status", messageId, status, target?, deliveredAt?, rejectionReason? }`.

| Status      | Meaning                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`   | Queued; the target has not consumed it yet.                                                                                                                         |
| `delivered` | Accepted by the target session for its turn — not read, acted on, or answered. `deliveredAt` is set.                                                                |
| `rejected`  | Terminally refused before model delivery, including when the target session ends while the message is still `pending`. `rejectionReason` is set.                    |
| `unknown`   | No such id for this sender — it never existed or its row was cleared at a boot-window boundary; terminal, stop polling. Only `messageId` and `status` are returned. |

A `messageId` that is not an integer MUST be rejected as a tool error. `status` covers messages
sent by the calling session in the caller's current boot window: a
`status` for a message sent in an earlier boot window, or by another session, MUST return
`unknown`. A reload neither ends a session nor cancels a pending message: pending messages to and
from the session keep their delivery contract; a child session record's lifetime follows
[session-store.md, membership and lifecycle](session-store.md#membership-lifecycle).

## 6. Fleet feed {#fleet-feed}

The fleet feed carries a `list` to an RPC client that shows the fleet itself, under the same
announcement as the task feed ([task.md, task feed](task.md#task-feed)): when the main session runs in
pi's RPC mode, `PI_DENT_FEEDS` is `1` at session start, and the session is a member of the fleet
with a live session identity, the extension MUST set the widget `pi-dent-fleet` through the host
widget surface as an array of one string: the JSON text of
`{ "piDent": "fleet/1", "sessionId": <the session's ID>, "sessions": [<session>…] }`, the
`<session>` objects being those of a `json` `list` of scope `machine` ([action `list`](#list)), in its order,
each with one more field, `summary`: the latest turn's goal when non-empty, else its command when
non-empty, else `null`.

- The extension MUST compute the feed at session start and then every 5 seconds, and MUST set it
  only when its text differs from the text set last.
- The computation belongs to the boot window that started it: closing that boot window MUST stop
  it, and ending the main session MUST also clear the widget.
- A failure computing the feed MUST leave the widget as it is and MUST NOT be reported.
- Reading the feed is not a `Fleet` call: it MUST NOT change fleet state.

## 7. Specification gaps {#gaps}

- The conversation rendering associated with `renderShell: "self"` is unspecified.

- The collation of session-ID ordering depends on the host's locale.
- A child session listed by scope `children` shows the dispatch's task as its latest turn and no
  later turn: recording its turns as they happen is not required.
- A waited query has no time limit: it ends only by reply, failure, or abort.
- A delivered `followUp` whose turn never starts, because the host handles the injected message
  without starting one, is not observable: no turn start and no `agent_end` report it, so the
  session keeps refusing later `followUp` deliveries until its next turn start or idle report.
