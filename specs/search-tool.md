# `Search` tool specification

This document specifies the `Search` tool: the read-only surface through which a session looks
back into its own session tree and, for a main session, into the other sessions of its project,
with the actions `find` (search transcript items and return compact hits), `get` (return one
item's text, paged, with its neighbours), and `sessions` (list sessions). The session-file
subset, the transcript item, the item kinds, the current lineage, the session tree, the project,
the session key, the item address, and the transcript order are owned by
[session-transcript.md](session-transcript.md); the session index, its catch-up, and its failures
by [session-index.md](session-index.md).

`Search` registers no task row ([task.md, task kinds](task.md#task-kinds)). A call MUST NOT create, write, or
delete any file or directory other than the session index file, its `-wal` and `-shm`
companions, and the directory that holds them ([session-index.md, location and format](session-index.md#location) and [session-index.md, failures](session-index.md#failures)). An implementation MAY keep data derived from
session files in memory between calls; every call's result MUST still be the one [action `find`](#find), [action `get`](#get), [action `sessions`](#sessions)
define.

## 1. Tool registration surface {#registration}

The extension MUST register the `Search` tool through the host `registerTool` API:

| Field           | Value                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `name`          | `"Search"`                                                                                                      |
| `label`         | `"Search"`                                                                                                      |
| `description`   | The text of [model-facing texts](#model-texts)                                                                  |
| `promptSnippet` | The text of [model-facing texts](#model-texts)                                                                  |
| `parameters`    | The parameter schema of [parameter schema](#parameter-schema), described per [model-facing texts](#model-texts) |

A child session binds `Search` under the rule of [agent-tool.md, tools](agent-tool.md#tools).

### 1.1 Parameter schema {#parameter-schema}

The parameter schema is a JSON object schema with `type: "object"` and
`additionalProperties: false`, with one required field, `action`; every other field is optional
in the schema and admits `null` beside the type in the table, and each action accepts only its
fields below. A field whose value is `null` counts as absent.

| Field           | Type                                                           | Actions            | Contract                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`        | `"find" \| "get" \| "sessions"`                                | all                | The operation to perform.                                                                                                                                                                            |
| `query`         | string? \| null                                                | `find`             | The text to match in an item's text ([matching](#matching)). Absent: every item matches.                                                                                                             |
| `regex`         | boolean? \| null                                               | `find`             | `true`: `query` is a regular expression. Default `false`: `query` is literal text.                                                                                                                   |
| `caseSensitive` | boolean? \| null                                               | `find`             | Default `false`: letter case is ignored.                                                                                                                                                             |
| `kinds`         | item kind[] (min 1)? \| null                                   | `find`             | The item kinds to search ([session-transcript.md, transcript items](session-transcript.md#transcript-items)). Default: every kind.                                                                   |
| `tool`          | string? \| null                                                | `find`             | A tool name: only `tool_call` and `tool_result` items of that tool match ([candidates](#candidates)).                                                                                                |
| `isError`       | boolean? \| null                                               | `find`             | Only `tool_result` items match: `true` those that record a tool error, `false` those that do not.                                                                                                    |
| `since`         | string? \| null                                                | `find`, `sessions` | Lower time bound, inclusive: a date-time or an age ([candidates](#candidates)).                                                                                                                      |
| `until`         | string? \| null                                                | `find`, `sessions` | Upper time bound, exclusive: a date-time or an age ([candidates](#candidates)).                                                                                                                      |
| `session`       | string? \| null                                                | `find`, `sessions` | The session to search or list ([reach and session resolution](#reach)). Default `self`, the invoking session.                                                                                        |
| `scope`         | `"session" \| "tree" \| "project" \| "project-trees"`? \| null | `find`, `sessions` | How far the call reaches ([reach and session resolution](#reach)). Default `session` for `find` and `tree` for `sessions`.                                                                           |
| `branches`      | boolean? \| null                                               | `find`             | `true`: also search off-lineage items. Default `false`: the current lineage only.                                                                                                                    |
| `order`         | `"newest" \| "oldest"`? \| null                                | `find`             | Hit order ([result](#result)). Default `newest`.                                                                                                                                                     |
| `after`         | string? \| null                                                | `find`             | An item address: return only hits that follow that item in the call's order ([result](#result)).                                                                                                     |
| `limit`         | integer? \| null                                               | all                | `find`: the most hits to return, `1` to `100`, default `20`. `get`: the most characters of text, `1` to `50000`, default `10000`. `sessions`: the most sessions to list, `1` to `200`, default `50`. |
| `address`       | string? \| null                                                | `get`              | Required for `get`. The item address ([session-transcript.md, item address](session-transcript.md#item-address)).                                                                                    |
| `offset`        | integer? \| null                                               | `get`              | The index of the first character of text to return, counting from `0`. Default `0`.                                                                                                                  |
| `context`       | integer? \| null                                               | `get`              | The number of neighbouring items to list on each side, `0` to `20`. Default `0`.                                                                                                                     |

The schema constrains the types of the table, the values of `action`, `scope`, `order`, and the
elements of `kinds`, the minimum length of `kinds`, and the set of admitted properties, and
nothing else. The host validates a call's arguments against it before the tool runs; a call it
rejects is a schema rejection ([task.md, task kinds](task.md#task-kinds)).

### 1.2 Validation {#validation}

Execution-time validation MUST reject the call as a tool error (`isError: true`) whose text is
the error text of the first failing check, in this order:

| #   | Check                                                                                                                                             | Error text                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | A field other than `action` that the action does not accept is present (first such field in table order of [parameter schema](#parameter-schema)) | `<field> is not valid for action <action>`                                                          |
| 2   | `find`: `query` is present and is the empty string                                                                                                | `query must be a non-empty string`                                                                  |
| 3   | `find`: `query` is longer than 1000 characters                                                                                                    | `query must be at most 1000 characters`                                                             |
| 4   | `find`: `regex` is `true` and `query` is absent                                                                                                   | `regex requires query`                                                                              |
| 5   | `find`: `regex` is `true` and the pattern of [matching](#matching) is not a valid regular expression                                              | `invalid regular expression: <message>`                                                             |
| 6   | `find`: `tool` is present and empty after trimming                                                                                                | `tool must be a non-empty string`                                                                   |
| 7   | `since` is present and neither a date-time nor an age ([candidates](#candidates))                                                                 | `since must be an RFC 3339 date-time with a time-zone offset or an age such as 90s, 15m, 2h, or 7d` |
| 8   | `until` is present and neither a date-time nor an age                                                                                             | `until must be an RFC 3339 date-time with a time-zone offset or an age such as 90s, 15m, 2h, or 7d` |
| 9   | `since` and `until` are present and the instant of `since` is not earlier than that of `until`                                                    | `since must be earlier than until`                                                                  |
| 10  | `sessions`: `scope` is `session` or `project-trees`                                                                                               | `scope must be tree or project for action sessions`                                                 |
| 11  | `scope` is `project` or `project-trees` and `session` is present and not empty after trimming                                                     | `session is not valid with scope <scope>`                                                           |
| 12  | `find`: `after` is present and, after trimming, not an item address                                                                               | `after must be an item address such as self:1a2b3c4d or self:1a2b3c4d.0`                            |
| 13  | `find`: `limit` is present and not an integer from 1 to 100                                                                                       | `limit must be an integer from 1 to 100`                                                            |
| 14  | `sessions`: `limit` is present and not an integer from 1 to 200                                                                                   | `limit must be an integer from 1 to 200`                                                            |
| 15  | `get`: `address` is absent or, after trimming, not an item address                                                                                | `address must be an item address such as self:1a2b3c4d or self:1a2b3c4d.0`                          |
| 16  | `get`: `offset` is present and not a non-negative integer                                                                                         | `offset must be a non-negative integer`                                                             |
| 17  | `get`: `limit` is present and not an integer from 1 to 50000                                                                                      | `limit must be an integer from 1 to 50000`                                                          |
| 18  | `get`: `context` is present and not an integer from 0 to 20                                                                                       | `context must be an integer from 0 to 20`                                                           |

`<field>`, `<action>`, and `<scope>` are the field name, the action value, and the scope value.
`<message>` is the message of the error the ECMAScript `RegExp` constructor raises for the
pattern. An integer is a number for which ECMAScript `Number.isInteger` holds. A string is an
item address when it matches the `address` production of
[session-transcript.md, item address](session-transcript.md#item-address). The checks of [reach and session resolution](#reach), [result](#result), and
[action `get`](#get), which read the file system, run after these, in the order those sections give. The numbers in the
error texts of checks 13, 14, 17, and 18 are those of the `limit` and `context` rows of [parameter schema](#parameter-schema).

### 1.3 Model-facing texts {#model-texts}

The texts of this section are what a model reads to choose and fill a call; each MUST be
registered verbatim, and none cites a specification.

The `description` is

```text
Look back into session transcripts. find searches earlier messages, tool calls, and tool results and returns compact hits, each starting with an address; get returns one item's full text by its address; sessions lists sessions. find searches this session only unless scope widens it.
```

The `promptSnippet` is

```text
Search earlier messages, tool calls, and tool results of this session; with scope, also its child sessions and its project
```

Each property of the parameter schema carries this `description`:

| Field           | `description`                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`        | `find: search and return hits with addresses. get: return one item's text by its address. sessions: list sessions.`                                                                                                                                                                         |
| `query`         | `For find: the text to look for in an item's text, literal unless regex is true. Omit it to list every item that passes the other filters.`                                                                                                                                                 |
| `regex`         | `For find: true makes query an ECMAScript regular expression. Default false.`                                                                                                                                                                                                               |
| `caseSensitive` | `For find: true matches letter case exactly. Default false.`                                                                                                                                                                                                                                |
| `kinds`         | `For find: the item kinds to search: user, system, assistant, thinking, tool_call, tool_result, injected, summary, error. Default: all.`                                                                                                                                                    |
| `tool`          | `For find: a tool name; only that tool's calls and results match.`                                                                                                                                                                                                                          |
| `isError`       | `For find: true matches only tool results that are errors, false only those that are not.`                                                                                                                                                                                                  |
| `since`         | `Lower time bound, inclusive: an RFC 3339 date-time with a time-zone offset, or an age such as 90s, 15m, 2h, or 7d. For sessions it bounds when the session was last written.`                                                                                                              |
| `until`         | `Upper time bound, exclusive: an RFC 3339 date-time with a time-zone offset, or an age such as 90s, 15m, 2h, or 7d. For sessions it bounds when the session was last written.`                                                                                                              |
| `session`       | `For find and sessions: the session to search or list: self (default), the task ID of an Agent or Script call of this session, a session key as shown before the colon of a hit address or at the start of a sessions line, or a session file path.`                                        |
| `scope`         | `How far to reach: session (one session; default for find), tree (it and the child sessions beneath it; default for sessions), project (this main session and the other sessions of its project), project-trees (those and all their child sessions). sessions takes tree or project only.` |
| `branches`      | `For find: true also searches the entries of abandoned branches. Default false.`                                                                                                                                                                                                            |
| `order`         | `For find: newest (default) or oldest hits first.`                                                                                                                                                                                                                                          |
| `after`         | `For find: an item address to continue after. Copy it from the "More hits follow" or "Search stopped" line of the previous result.`                                                                                                                                                         |
| `limit`         | `find: the most hits to return, 1 to 100, default 20. get: the most characters of text, 1 to 50000, default 10000. sessions: the most sessions to list, 1 to 200, default 50.`                                                                                                              |
| `address`       | `Required for get: the address that starts a hit line, such as self:1a2b3c4d or self:1a2b3c4d.0.`                                                                                                                                                                                           |
| `offset`        | `For get: the index of the first character to return, counting from 0. Copy it from the "cut: continue with offset" line to read on.`                                                                                                                                                       |
| `context`       | `For get: how many neighbouring items to list before and after, 0 to 20. Default 0.`                                                                                                                                                                                                        |

The schema of an element of `kinds`, and of an alternative inside a property, carries no
`description`. The numbers in the `limit` and `context` descriptions are those of the `limit` and
`context` rows of [parameter schema](#parameter-schema).

## 2. Scope {#scope}

### 2.1 Reach and session resolution {#reach}

The invoking session of a call made in a child session is that child session; its session file is
the `sessionFile` of [session-tool.md, result](session-tool.md#result). A call reaches:

- the session tree of the invoking session ([session-transcript.md, session tree](session-transcript.md#session-tree)), always;
- when the invoking session is a main session with a session file, and only on the call's
  request — `scope` `project` or `project-trees`, a session key that starts with `~`, or a
  `session` value that starts with `/` — the project members of the invoking session and their
  session trees ([session-transcript.md, project](session-transcript.md#project)).

Reach is decided by where a session file lies, per those two sections, and by nothing else. A
call MUST NOT read, as a session, a file it does not reach. The session file of the session that
dispatched a child session, and of another session that session dispatched, lies outside the
child's session tree; a session file of another sessions directory lies outside every project.

> Note (non-normative): reach is a navigation boundary, not a confidentiality guarantee: a child
> session with file or shell tools can read any file its process can. The boundary keeps a child
> from being handed its dispatcher's conversation by default, and keeps its searches about its
> own work.

A call that asks for the project — by `scope`, by a `session` value starting with `~`,
or by an `address` or `after` whose session key starts with `~` — MUST be rejected as a tool
error with the text `project scope is available to a main session only` when the invoking session
is a child session, and with `this session has no session file and so no project` when it is a
main session without a session file.

A `session` value resolves, after trimming, by the first rule that applies:

1. `self`, or an absent or empty value: the invoking session.
2. A value starting with `~`: the session with that session key among the project members and
   the members of their session trees.
3. A value equal to the session key of a member of the invoking session's session tree: that
   member.
4. A value starting with `/`: the session the call reaches whose session file's path, with
   symbolic links resolved, equals the value's path with symbolic links resolved; a project
   member or a member of its tree only when the invoking session is a main session with a
   session file.
5. Any other value: the member of the invoking session's session tree whose key's last `<stem>`
   equals the value or ends with `-` followed by the value. A task ID so names the session an
   `Agent` dispatch created, or the tool log of a `Script` run
   ([script-tool.md, tool log](script-tool.md#tool-log)).

A value that resolves to no session MUST be rejected as a tool error with the text
`unknown session "<value>"`; a value that rule 2 or rule 5 matches to more than one session, with
`ambiguous session "<value>" matches <paths>`, `<paths>` being the matching sessions' session
file paths in ascending order by UTF-16 code units, joined by `, `. `<value>` is the trimmed
value. The session key of an `address` or an `after` resolves by rules 1 to 3, with the same two
errors.

With `<session>` the resolved `session`, the sessions of a `find` or `sessions` call are:

| `scope`         | Sessions                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`       | `<session>`.                                                                                                                                                         |
| `tree`          | `<session>` and every member of its session tree beneath it.                                                                                                         |
| `project`       | The invoking session and each of its project members; no session beneath any of them.                                                                                |
| `project-trees` | The invoking session and every member of its session tree beneath it; each of its project members and every member of that project member's session tree beneath it. |

The sessions of a call are found in the file system at each call, per
[session-transcript.md, session tree](session-transcript.md#session-tree) and [session-transcript.md, project](session-transcript.md#project): which files are sessions, and
where each lies in its tree or project, come from the directories and their files, never from the
session index. A call MAY take a file's session header from the file's `files` row rather than
from its first line — the row's `session_id` as the header's session ID, its `started` as the
header's time — and MUST NOT take it from there unless the row's `path` is the file's path with
symbolic links resolved, the row's `consumed` equals the file's size, and the row's `mtime`
equals the file's modification time: the three conditions under which a catch-up of that file is
complete without reading it ([session-index.md, catch-up](session-index.md#catch-up), step 2); otherwise
the call MUST read the file's first line for the header.

> Note (non-normative): those conditions are the index's own evidence that the file's bytes are
> the ones the row describes, so the header they give is the file's. A file rewritten in place
> with its size and modification time unchanged is the one case they cannot tell.

A call MAY reuse an earlier call's discovery while no directory that discovery listed has changed
since, and no file it passed over has become readable as a session file.

### 2.2 Coverage {#coverage}

`find` and `get` answer from the session index where they can and from the session files where
they cannot; the result is the same either way.

- A direct read of a session is a read of its session file by the call itself
  ([session-transcript.md, reading a session file](session-transcript.md#reading)), using no index row.
- A session is covered in a call when the call has every session entry in its file terminated
  at or before that file's read bound ([session-transcript.md, reading a session file](session-transcript.md#reading)). A complete catch-up of the file ([session-index.md, catch-up](session-index.md#catch-up))
  begun after the call started, or a direct read that finished, provides the cover. Any other
  session of the call is uncovered; a session whose direct read did not finish within the call's
  time budget is uncovered. The call MUST NOT use an entry terminated after its file's read
  bound: such an entry yields no candidate, no neighbour, and no listed item.
- A session file that cannot be opened, or is not readable as a session file
  ([session-transcript.md, reading a session file](session-transcript.md#reading)), when the call comes to read it
  directly is not a session of the call, as under catch-up ([session-index.md, catch-up](session-index.md#catch-up)): it is neither covered nor uncovered and counts in neither `<n>` nor `<k>` ([result](#result)). An `address` whose session is so lost is rejected with `unknown session "<key>"`, and an
  `after` with the error of [result](#result).
- A call MUST cover its sessions in this order: the session the key of `after` names, when
  `after` is given ([result](#result)); the invoking session, when it is one of them; then the others
  in descending order of their session files' modification times, equal times by ascending
  session key.
- A call covers a session by catch-up. It covers it by direct read when the index is unusable
  ([session-index.md, failures](session-index.md#failures)), and from the first failed write of the call
  on: the session whose catch-up failed and every session after it are covered by direct read,
  and the call MUST NOT attempt another write of the index. A write transaction that cannot
  begin within the busy timeout is attempted again per [session-index.md, concurrent access](session-index.md#concurrent-access), and is not a failed write.
- Covering MUST end 3000 ms after the call started: a catch-up or a direct read still running
  then is abandoned, and the sessions not covered by then are uncovered. Two sessions are the
  exception — the one session of a call with exactly one, and the session the key of `after`
  names: when the catch-up of such a session is not complete 3000 ms after the call started, the
  call MUST cover it by a direct read, which the call's time budget alone bounds.
- A call MUST take the `files` row of a session covered by catch-up, the `entries` and `items`
  rows it uses of it, and the `item_text` matches it narrows it by, as
  [session-index.md, concurrent access](session-index.md#concurrent-access), requires of a reader.
- A session covered by catch-up loses its cover when the call finds a stale row of it
  ([session-index.md, catch-up](session-index.md#catch-up)); when, as the call reads its rows, its
  `files` row is gone or has a `consumed` smaller than the call's catch-up of it left; and when
  the call can no longer read its rows because the index became unusable or was opened anew
  during the call ([session-index.md, failures](session-index.md#failures)). A reset that fails is a
  failed write of the call.
- A session that loses its cover becomes uncovered for the rest of a `find` call: no further
  item of it is evaluated, hits of it already shown stay shown, and it counts among the
  uncovered sessions. The session the key of `after` names is the exception: the `find` call
  MUST cover it again by a direct read. A `get` call whose session loses its cover MUST cover it
  by a direct read and answer from that.
- The current lineage a call uses for a session
  ([session-transcript.md, current lineage](session-transcript.md#current-lineage)) is that of the session entries
  at or before the file's read bound, in a covered session however it is covered. The `lineage`
  column of the index describes the consumed bytes; where those hold entries beyond the read
  bound, the call MUST NOT take the lineage from the column as it stands.

  > Note (non-normative): an entry appended during the call can start a branch, which moves
  > earlier entries off the lineage the column records; the call still answers for the
  > conversation as it stood at its read bound.

- When a call returns with uncovered sessions, the index is usable, and no write of the call
  failed, the process MUST continue their catch-up after the call has returned, in the same
  order, until each is complete, a write fails, or the boot window ends. For a child session,
  this background catch-up MAY stop when that child's attempt ends. The background catch-up
  MUST NOT hold up a later call: a later call covers its own sessions under the rules above,
  whatever a background catch-up is doing.
- An uncovered session's items are not searched, and the result says so ([result](#result)). A result
  is never silently stale: every entry terminated at or before the file's read bound is in a
  covered session's part of the result.

### 2.3 Abort and responsiveness {#abort}

When the tool-call signal aborts, a call of any action MUST end within 1000 ms as a tool error
with the text `Search aborted`, including while the evaluation of one regular expression on one
item is running. Catch-up transactions it has committed stay
([session-index.md, catch-up](session-index.md#catch-up)). An aborted call MUST NOT start a background
catch-up ([coverage](#coverage)); a background catch-up an earlier call started is not affected.

A `find` call whose evaluation of the query fails for a reason other than the pattern, the
evaluation limit ([evaluation](#evaluation)), the time budget, or an abort MUST end at once as a tool error
with the text `Search failed: <message>`, `<message>` being the failure's message.

A call of any action, and a background catch-up, MUST NOT run longer than 250 ms without
yielding to the process's event loop. One catch-up transaction and one SQLite statement are
excepted: each can run longer, and the yield follows it. At each yield a call MUST check the
tool-call signal and, for `find` and `get`, the covering deadline; a `find` call MUST also check
the time budget; a background catch-up MUST check for the end of the boot window. The evaluation
of the query on one item is not excepted.

> Note (non-normative): discovery, covering, the loading and ordering of rows, and evaluation
> all scale with the sessions searched; without the yield one call freezes the session's user
> interface and every other tool of the process for seconds, and an abort is not seen.

## 3. Action `find` {#find}

### 3.1 Candidates {#candidates}

The candidates are the transcript items of the call's covered sessions that pass every filter:

- Lineage: unless `branches` is `true`, the item is on the current lineage the call uses for
  its session ([coverage](#coverage)).
- Own calls: the item is not a `tool_call` or `tool_result` item whose tool name is exactly
  `Search`, unless `tool` is given and matches `Search`.

  > Note (non-normative): the call's own arguments are already in the invoking session's file and
  > contain the query, so without this rule every search would find itself and its predecessors.

- `kinds`, when given: the item's kind is one of them.
- `tool`, when given: the item is a `tool_call` or `tool_result` item whose tool name equals the
  trimmed `tool`, both compared after converting the letters `A–Z` to lowercase.
- `isError`, when given: the item is a `tool_result` item, and it records a tool error exactly
  when `isError` is `true`.
- `since`, when given: the item's `time` is at or after its instant. `until`, when given: the
  item's `time` is before its instant.
- `query`, when given: the item's text matches ([matching](#matching)).

Filters that no item can pass together (`kinds: ["user"]` with `tool`, for example) are valid and
give no candidate.

A `since` or `until` value is, after trimming, a date-time
([schedule-tool.md, time values](schedule-tool.md#time-values)), naming its instant, or an age: one to nine
decimal digits followed by one of `s`, `m`, `h`, or `d`, naming the instant that many seconds,
minutes (60 s), hours (3600 s), or days (86400 s) before the call started.

### 3.2 Matching {#matching}

A `query` is matched as an ECMAScript regular expression ([ECMA-262]) built from a pattern with
the flag `m`, and the flag `i` unless `caseSensitive` is `true`, and no other flag. With `regex`
`true` the pattern is `query`; otherwise it is `query` with each of the characters
`\ ^ $ . * + ? ( ) [ ] { } |` preceded by `\`, so that the query matches as literal text.

An item matches when the regular expression matches its match text
([session-transcript.md, transcript items](session-transcript.md#transcript-items)); the match position is the index of
the first character of the first match found searching from index `0`. A match of length zero is
a match. Text beyond the match text is never matched.

### 3.3 Evaluation {#evaluation}

The call's order is the reverse of transcript order
([session-transcript.md, transcript order](session-transcript.md#transcript-order)) when `order` is `newest`, and
transcript order when it is `oldest`, session keys being relative to the invoking session. The
hits of a call are its candidates in the call's order, without those at or before the `after`
item when `after` is given ([result](#result)).

- Equivalence: the hits MUST be exactly those that a direct read of every covered session and an
  evaluation of [candidates](#candidates) and [matching](#matching) on every item give, in the same order, together with the
  hits shown from a session before it became uncovered ([coverage](#coverage)), and without the items
  left unmatched by the evaluation limit below. The session index changes how fast a call
  answers and nothing else.
- Narrowing: with `regex` not `true` and a `query` that contains three consecutive characters in
  the range U+0020 to U+007E, a call MUST NOT read from a session file, to evaluate the query,
  an item of a session covered by catch-up that `item_text`
  ([session-index.md, schema](session-index.md#schema)) does not match for one such run of three.
  With `regex` `true`, a call MAY leave out items in the same way, by trigrams that every match
  of the pattern contains.

  > Note (non-normative): the `trigram` tokenizer and the `i` flag fold the letters `A–Z` alike
  > but can differ on other letters, so only runs of these characters are safe to narrow by. A
  > query without such a run — one or two characters, a pattern of wildcards — is evaluated on
  > every item that passes the other filters, in the call's order.

- Evaluation limit: an evaluation of the query on one item that has run 1000 ms MUST be ended.
  The item is then decided and is not a hit, whatever the pattern would have found; it is an
  unmatched item of the call. The limit applies with `regex` `true` and without.
- Prefix: a call MUST NOT show a hit while a hit before it in the call's order is not shown. The
  shown hits are therefore always the first hits of the call, whatever stops it.
- Time budget: a `find` call has a time budget of 5000 ms from its start, covering session
  discovery, covering ([coverage](#coverage)), and evaluation. A call that has neither shown `limit` hits
  and established whether a further hit exists, nor reached the end of its hits, when the budget
  expires is a stopped call. The expiry bound is 1000 ms, inclusive: a stopped call MUST return
  within the expiry bound after the expiry, including when the evaluation of one regular expression
  on one item is still running. The expiry bound is separate from the abort bound of [abort and responsiveness](#abort).
- An item of a covered session is decided when the call has established whether it is a hit:
  by a filter, by the narrowing above, by evaluating the query on it, or by the evaluation
  limit. The stop item of a
  stopped call is the last item, in the call's order, of the longest run of decided items that
  starts at the first item of the covered sessions after the `after` item, or at the first item
  when `after` is absent. Every hit in that run is shown. A stopped call whose first such item is
  not decided has no stop item. A call in which the session the key of `after` names is
  uncovered when the budget expires is a stopped call with no stop item.

  > Note (non-normative): the run is the longest one so that a call which shows no hit still
  > moves the continuation point as far as its time budget reached.

> Note (non-normative): ECMAScript matching backtracks, so one pattern on one long text can run
> for minutes. The evaluation limit passes over such an item, so a call always moves on and a
> continuation never lands on the same item again; the result says how many items were passed
> over. A stopped call hands back the place it reached, so the next call goes on from there
> instead of starting over.

### 3.4 Result {#result}

When `after` is given and the session its key names is not a session of the call, or the trimmed
`after` resolves to no transcript item of that session — any item, whether or not it passes the
filters — the call MUST be rejected as a tool error with the text
`no item <after> in the searched sessions`, `<after>` being the trimmed value. The first `limit`
hits are shown.

The text is these lines, joined by one line feed, each present only under its condition, in this
order:

| Line                                                                                                                                                          | Condition                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<shown> hits, <order> first`                                                                                                                                 | `<shown>` is at least 1                                                                                                                                                  |
| `(no hits)`                                                                                                                                                   | `<shown>` is 0                                                                                                                                                           |
| one hit line per shown hit, in the call's order                                                                                                               | `<shown>` is at least 1                                                                                                                                                  |
| `<s> items were not matched: the pattern ran over 1000 ms on each. Simplify the pattern.`                                                                     | `<s>` is at least 1                                                                                                                                                      |
| `More hits follow: repeat the call with after: "<last>"`                                                                                                      | the call is not stopped and has more than `limit` hits                                                                                                                   |
| `Search stopped after 5000 ms at <stop>: every hit of the searched sessions up to there is shown. Continue with after: "<stop>"`                              | the call is stopped and has a stop item                                                                                                                                  |
| `Search stopped after 5000 ms: the session of after is not indexed yet. Repeat the call later.`                                                               | the call is stopped, has no stop item, the session the key of `after` names is uncovered, the index is usable, and no write of the call failed (the after-session state) |
| `Search stopped after 5000 ms before any item was examined. Repeat the call.`                                                                                 | the call is stopped, has no stop item, the index is usable, no write of the call failed, and the call is not in the after-session state                                  |
| `Search stopped after 5000 ms before any item was examined: a session is too large to read without the search index.`                                         | the call is stopped, has no stop item, and the index is unusable or a write of the call failed                                                                           |
| `<k> of <n> sessions were not searched: the search index is unavailable (<reason>). Narrow the scope.`                                                        | `<k>` is at least 1 and the index is unusable                                                                                                                            |
| `<k> of <n> sessions were not searched: the search index cannot be written (<reason>). Narrow the scope.`                                                     | `<k>` is at least 1, the index is usable, and a write of the call failed                                                                                                 |
| `<k> of <n> sessions are not indexed yet and were not searched; indexing continues in the background. Repeat the call later, without after, to include them.` | `<k>` is at least 1, the index is usable, no write of the call failed, and the call is not in the after-session state                                                    |

The `5000` of the stop lines is the time budget of [evaluation](#evaluation), and the `1000` of the unmatched-items
line is its evaluation limit. `<shown>` is the number of shown hits, `<order>` the `order` value, `<last>` the address of the
last shown hit, `<stop>` the address of the stop item, `<n>` the number of the call's sessions,
`<k>` the number of them that are uncovered, `<s>` the number of the call's unmatched items
([evaluation](#evaluation)), and `<reason>` the reason of
[session-index.md, failures](session-index.md#failures): that of the unusable index, or that of the
call's first failed write. The `<s>` line reads `items`, the `<shown>` line reads `hits`, and the
table's lines that count sessions, the `… <n> more sessions` line included, read `sessions`,
whatever the number is. At most one of the last three lines is present, and exactly one when
`<k>` is at least 1 and the call is not in the after-session state.

> Note (non-normative): a result can carry both an instruction to go on with `after` and the
> instruction to repeat without it. They are alternatives that do not conflict: going on with
> `after` continues through the sessions already searched, and repeating without it starts over
> and takes in the sessions indexed since. In the after-session state only one is offered,
> because the place to continue from is itself in a session not yet indexed.

A continuation by `after` returns the hits that follow, with none left out, among the sessions
covered in both calls. A hit of a session that was uncovered in the first call can lie anywhere
in the order, before the shown hits included, so a continuation does not return it; a call
with uncovered sessions is completed by repeating it, not by continuing it.

A hit line is

```text
<address> · <time> · <kind><label><flags> · <length> chars<at> · <snippet>
```

| Part        | Value                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `<address>` | The item address, relative to the invoking session.                                                                                  |
| `<time>`    | The item's `time` as a local time stamp ([schedule-tool.md, time values](schedule-tool.md#time-values)).                             |
| `<kind>`    | The item kind.                                                                                                                       |
| `<label>`   | Empty when the item has no label; else one space and the label, flattened (below) and cut to its first 60 characters with no marker. |
| `<flags>`   | ` error` for a `tool_result` item that records a tool error, then ` off-lineage` for an off-lineage item; else empty.                |
| `<length>`  | The item's length.                                                                                                                   |
| `<at>`      | With `query`: ` @` and the match position. Without: empty.                                                                           |
| `<snippet>` | `(empty)` when the item's length is 0; else the snippet below.                                                                       |

Flattening a string replaces every maximal run of white space
([session-transcript.md, transcript items](session-transcript.md#transcript-items)) and of the characters U+0000–U+001F
and U+007F–U+009F by one space and then removes a leading and a trailing space. The snippet of
an item with text `T` of length `n` and start position `s` — the match position with `query`,
else `0` — is, with `a` the greater of `0` and `s − 40` and `b` the lesser of `n` and `a + 160`:
`…` when `a` is greater than `0`, then the characters of `T` from index `a` up to, not
including, index `b`, flattened, then `…` when `b` is less than `n`. `…` is U+2026.

`details` is
`{ action: "find", order, more, stopped, next?, sessions, uncovered, unmatched, indexError?, hits: [<hit>…] }`:
`more` is `true` exactly when the `More hits follow` line is present, `stopped` exactly when the
call is stopped, `next` is `<last>` when `more` is `true` and `<stop>` when the call is stopped
with a stop item, and is absent otherwise, `sessions` is `<n>`, `uncovered` is `<k>`, `unmatched` is `<s>`,
`indexError` is `<reason>`, present exactly when the index is unusable or a write of the call
failed, whatever `<k>` is, and `<hit>` is, for each
shown hit in order,
`{ address, session, kind, label?, isError?, offLineage, time, length, at?, snippet }` —
`session` the session key, `isError` present on `tool_result` items, `offLineage` a boolean,
`time` in milliseconds since the Unix epoch, `at` the match position, present with `query`.

## 4. Action `get` {#get}

The call MUST be rejected as a tool error, the first failure reported, when the session key of
the trimmed `address` does not resolve ([reach and session resolution](#reach)), with that section's error; when the address
resolves to no transcript item of that session, on the current lineage or off it, with the text
`no item <address>`; and when `offset` is greater than the item's length, with the text
`offset <offset> is past the end of the text (<length> characters)`.

The call's one session is the addressed session; it is covered under [coverage](#coverage), by a direct
read where that section says so. The result MUST be the one a direct read of that session gives.

With `<end>` the lesser of the item's length and `offset + limit`, the text is these parts,
joined by one line feed, in this order:

1. The hit line of [result](#result) without ` · <snippet>` and with `<at>` empty.
2. For a `tool_call` item, `result: <address>`, the address of its paired `tool_result` item
   ([session-transcript.md, transcript items](session-transcript.md#transcript-items)), or `result: (none)` when it has
   none; for a `tool_result` item, `call: <address>` or `call: (none)` likewise. No such line for
   another kind.
3. `--- text <offset>..<end> of <length> ---`.
4. The characters of the item's text from index `offset` up to, not including, index `<end>`,
   verbatim. This part is absent when `<end>` equals `offset`.
5. `--- end of text ---` when `<end>` equals the item's length, else
   `--- cut: continue with offset <end> ---`.
6. When `context` is at least 1 and an item precedes this one in file order
   ([session-transcript.md, transcript order](session-transcript.md#transcript-order)): the line `Before:`, then the
   hit lines of the up to `context` items directly preceding it, in file order.
7. When `context` is at least 1 and an item follows this one in file order: the line `After:`,
   then the hit lines of the up to `context` items directly following it, in file order.

The neighbours of steps 6 and 7 are the items of the same session of every kind, on the current
lineage or off it, `Search`'s own included; their hit lines have `<at>` empty and the snippet
with start position `0`.

`details` is
`{ action: "get", address, session, kind, label?, isError?, offLineage, time, length, offset, end, paired?, before: [<hit>…], after: [<hit>…] }`:
`end` is `<end>`, `paired` the address of step 2 when there is one, and `before` and `after`
the neighbours as `<hit>` objects of [result](#result) without `at`, empty when `context` is `0`.

## 5. Action `sessions` {#sessions}

The call lists the sessions of [reach and session resolution](#reach) for its `scope` whose session file's modification
time is at or after the instant of `since` and before the instant of `until`, when those are
given ([candidates](#candidates)); a session without a session file passes neither bound. `sessions` reads
session files directly and MUST NOT use or change the session index, the header of [reach and session resolution](#reach)
being its one exception.

- With `scope` `tree`, `<session>` is first, and a session comes before the sessions beneath
  it: each session is followed by its children, most recently modified first — in descending
  order of their session files' modification times, equal times by ascending session key —
  each child followed in turn by its own children in the same way. A child that the `since` or
  `until` bound leaves out is not listed, and its children are still listed in its place.
- With `scope` `project`, the invoking session is first; the project members follow in descending
  order of their session files' modification times, equal times by ascending session key.

The text is one line per session for the first `limit` of them, lines joined by one line feed:

```text
<key> · <started> · <bytes> bytes · modified <modified> · <preview>
```

| Part         | Value                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<key>`      | The session key, relative to the invoking session.                                                                                                                                                                                    |
| `<started>`  | The `time` of the session header ([session-transcript.md, transcript items](session-transcript.md#transcript-items)), as a local time stamp.                                                                                          |
| `<bytes>`    | The session file's size in bytes when the call read it.                                                                                                                                                                               |
| `<modified>` | The session file's modification time as a local time stamp.                                                                                                                                                                           |
| `<preview>`  | The snippet ([result](#result), start position `0`) of the first `user` item, in file order, among the entries of the file's first 50 lines; `(no user message)` when there is none. For a child session it is the start of its task. |

An invoking session without a session file is listed as `self · (no session file)`. When more
than `limit` sessions are to be listed, a last line `… <n> more sessions` follows, `<n>` being
the number not listed; with no session to list, the text is `(no sessions)`. `details` is
`{ action: "sessions", scope, total, sessions: [{ key, path, startedAt, bytes, modifiedAt, preview }…] }`
for the listed sessions: `total` the number of sessions to list, `path` the session file's
absolute path, times in milliseconds since the Unix epoch, and `path`, `startedAt`, `bytes`,
`modifiedAt`, and `preview` `null` for a session without a session file.

## 6. Normative references {#references}

- [ECMA-262] ECMAScript Language Specification, 14th edition (June 2023), Ecma International:
  Regular Expressions (pattern syntax, including Annex B.1.2, the `i` and `m` flags, and the error
  an invalid pattern raises), and `Number.isInteger`.

## 7. Specification gaps {#gaps}

- No time budget bounds `get` or `sessions`; only the abort of [abort and responsiveness](#abort) ends one early. A
  `get` answered from the index reads one line; one answered by direct read reads one session
  file.
- Two project members with the same session key cannot be told apart by it: an `address` or a
  `session` naming that key is rejected as ambiguous, so the items of both are shown as hits but
  cannot be fetched by `get`; the `session` parameter takes the file's path instead.
- A background catch-up that stops at a failed write is not reported until a later call
  itself meets the failed write.
- How fast a call answers is not specified as a number; it depends on the machine. So does
  whether an item whose evaluation takes close to the evaluation limit of [evaluation](#evaluation) is a hit or an unmatched item.
- Whether an unmatched item that a call evaluated beyond the last item it shows or stops at is
  counted in `<s>` is the implementation's; a continuation by `after` can count the same item
  again.
- Which patterns a `regex` call narrows by trigrams is the implementation's: any, provided the
  hits are those of the equivalence rule.
- A cut of a snippet, a label, or a `get` text can separate the two halves of a surrogate pair.
- The files of an agent directory other than session files — result spills, output files, task
  records — are not searched.
- The `details` of a tool result and the bytes of an image are not searchable.
- A session the call does not reach cannot be searched: a session continued by `resume` from
  outside every reached agent directory, the session that dispatched a child session, a session
  of another sessions directory, a session of another machine.
- An item beyond the match text of [session-transcript.md, transcript items](session-transcript.md#transcript-items) cannot be
  found by `query`; `get`
  reads it by `offset`.
- Whether the host, when it validates against the schema of [parameter schema](#parameter-schema), first coerces an
  argument to the type the schema names, and so whether a convertible value of the wrong type
  is admitted rather than rejected as a schema rejection, is the host's.
- The `<message>` of an invalid regular expression is the ECMAScript engine's and differs
  between engine versions.
