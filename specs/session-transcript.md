# Session transcript specification

This document specifies the session transcript: the part of a session file pi-dent reads as
searchable content. It owns the subset of the host's session file format that reading relies on,
the transcript item and its kinds, the current lineage, the session tree and its discovery, the
project, the item address, and the transcript order. The `Search` tool
([search-tool.md](search-tool.md)) is the surface over it, and the session index
([session-index.md](session-index.md)) stores what this document derives. The location and naming of session files and agent directories are owned by
[agent-tool.md](agent-tool.md), Section 4.2; the facts a `resume` reads from a session file by
[agent-tool.md](agent-tool.md), Section 9.

The session file format is the host's. This document relies on the subset stated here and on
nothing else; a reader MUST ignore every field and every entry type it does not name.

## 1. Reading a session file {#reading}

A session file is UTF-8 text, read as lines separated by the line feed character (U+000A). A
line's line number counts from 1. A read belongs to one tool call. For each file, its read bound is the file size first observed by
the call when it reads that file.

- A read MUST use every line terminated by a line feed at or before its read bound.
- A read MUST NOT use a last line that no line feed terminates at or before its read bound.
- A line MUST be skipped, with no failure reported, when it is empty, is longer than 16777216
  bytes, is not JSON, or is JSON other than an object. A line longer than 16777216 bytes MUST NOT
  be parsed.
- A session entry is the JSON object of a line that is not skipped.
- A read MUST NOT write to, lock, or otherwise change the session file.

> Note (non-normative): a session being read can be the one the call runs in, to which the host
> appends during the call; the unterminated last line is the write in progress.

The session header is the first line of a file when that line is a session entry with `type`
`"session"` and a string `id`; a session entry of that `type` on any later line is an entry of
an unused type. A file is readable as a session file only when its first line is a session
header. A session entry whose `type` is not a string is an entry of an unused type (Section 2).
Every other session entry this document uses carries:

| Field       | Type           | Contract                                                  |
| ----------- | -------------- | --------------------------------------------------------- |
| `type`      | string         | The entry type (Section 2).                               |
| `id`        | string         | The entry ID.                                             |
| `parentId`  | string \| null | The entry ID of the entry this one continues (Section 3). |
| `timestamp` | string         | The time the entry was recorded (Section 2, `time`).      |

An entry ID is usable when it is a non-empty string of the characters `A–Z`, `a–z`, `0–9`, `_`,
and `-`. An entry whose `id` is not usable, and an entry whose `id` equals that of an entry with
a lower line number in the same file, yields no transcript item and is no member of a lineage.

## 2. Transcript items {#transcript-items}

A transcript item is one searchable piece of a session entry. An entry yields the items of this
table and no other; an entry of any other `type`, and a `message` entry of any other
`message.role`, yields none.

| Entry                                         | Item kind     | Part    | Text                                | Label              |
| --------------------------------------------- | ------------- | ------- | ----------------------------------- | ------------------ |
| `type` `message`, `message.role` `user`       | `user`        | none    | Content text of `message.content`   | none               |
| `type` `message`, `message.role` `system`     | `system`      | none    | Prompt text of `message`            | none               |
| `type` `message`, `message.role` `assistant`  | (per element) | (below) | (below)                             | (below)            |
| `type` `message`, `message.role` `toolResult` | `tool_result` | none    | Content text of `message.content`   | `message.toolName` |
| `type` `custom_message`                       | `injected`    | none    | Content text of `content`           | `customType`       |
| `type` `compaction`                           | `summary`     | none    | `summary` when a string, else empty | none               |

An assistant entry yields one item per element of the array `message.content`, the part being the
element's zero-based index in decimal digits without leading zeros, and one further item for a
model error:

| Source                                | Item kind   | Part    | Text                                 | Label  |
| ------------------------------------- | ----------- | ------- | ------------------------------------ | ------ |
| Element with `type` `text`            | `assistant` | index   | `text` when a string, else empty     | none   |
| Element with `type` `thinking`        | `thinking`  | index   | `thinking` when a string, else empty | none   |
| Element with `type` `toolCall`        | `tool_call` | index   | Argument text of `arguments`         | `name` |
| `message.errorMessage`, when a string | `error`     | `error` | `message.errorMessage`               | none   |

An element of any other `type`, or that is not an object, yields no item. A `message.content`
that is not an array yields no element item.

- The item kinds are `user`, `system`, `assistant`, `thinking`, `tool_call`, `tool_result`,
  `injected`, `summary`, and `error`.
- White space is every character the ECMAScript pattern `\s` matches ([ECMA-262]). An item of
  kind `user`, `system`, `assistant`, `thinking`, `injected`, `summary`, or `error` whose text
  has no character other than white space MUST NOT be yielded. A `tool_call` and a `tool_result`
  item is yielded whatever its text.
- The prompt text of a `system` message is its content text and the string values of its
  `sections` object, in the order `Object.values` gives for the value `JSON.parse` returns,
  joined by one blank line; a section whose value is not a string, and a part that is the empty
  string, is left out. A `sections` that is not an object yields no section values.
- The content text of a value is: the value itself when it is a string; when it is an array, the
  texts of its elements joined by one line feed, where an object element with `type` `text` and
  a string `text` gives that `text`, an object element with `type` `image` gives
  `[image <mimeType>]` when its `mimeType` is a string and `[image]` otherwise, and any other
  element gives nothing and is left out of the join; otherwise the empty string.
- The argument text of a value is, when the value is an object that is not an array, one block
  per key, in the order `Object.keys` gives for the value `JSON.parse` returns, blocks joined by one line feed, a block being
  `<key>: <value>` where `<value>` is the value verbatim when it is a string and its
  `JSON.stringify` form (single-line) otherwise; for any other value, its `JSON.stringify` form,
  or the empty string when the value is absent.

  > Note (non-normative): a string argument such as a shell command or a task text stays
  > verbatim, so a pattern matches it as written and a reader sees its line breaks.

- A label that is not a non-empty string is absent. The tool name of a `tool_call` or
  `tool_result` item is its label.
- The tool-call ID of a `tool_call` item is the element's `id`, and of a `tool_result` item
  `message.toolCallId`, when a string. A `tool_call` item and a `tool_result` item of one session
  file are paired when their tool-call IDs are equal; when several items of a kind carry the same
  tool-call ID, the first in the order of line number, then part, is the paired one.
- A `tool_result` item records a tool error exactly when `message.isError` is `true`.
- An item's length is the length of its text in characters. Its match text is the first 100000
  characters of its text.
- The `time` of a session entry, the session header included, is the instant its `timestamp`
  names when that is a date-time ([schedule-tool.md](schedule-tool.md), Section 2.2); otherwise
  the instant named by the `timestamp` of the nearest entry with a lower line number in the same
  file whose `timestamp` is a date-time; otherwise the Unix epoch. An item's `time` is its
  entry's.

## 3. Current lineage {#current-lineage}

The entries of a session file form a tree through `parentId`; one path of it is the conversation
the session last continued.

- The leaf of a session file is the session entry with the highest line number that is not the
  session header and has a usable entry ID that no entry with a lower line number carries.
- The current lineage is the leaf, the entry whose `id` equals the leaf's `parentId`, that
  entry's parent likewise, and so on, ending at an entry whose `parentId` is `null`, absent, the
  `id` of no entry, or the `id` of an entry already on the path.
- A transcript item is on the current lineage when its entry is; otherwise it is off-lineage.

An entry a compaction summarized stays on the current lineage: compaction appends an entry and
removes none.

## 4. Session tree {#session-tree}

The session tree of a session is that session and, recursively, every session whose session file
lies in the agent directory of a session of the tree.

- The children of a session are the files directly in its agent directory
  ([agent-tool.md](agent-tool.md), Section 4.2) that are regular files, not symbolic links, named
  `<stem>.jsonl` where `<stem>` is non-empty, consists only of safe-name characters
  ([agent-tool.md](agent-tool.md), Section 4.2), and is not `self`, and that are readable as a
  session file (Section 1). A child's agent directory is `<stem>.agents` beside its file,
  entered only when it is a directory and not a symbolic link; the agent directory of the root
  is entered on the same condition. No other directory is entered.
- A session file an `Agent` `resume` continued from outside the dispatching session's agent
  directory lies in no agent directory of the tree and is not a member.
- A missing or unreadable agent directory has no children; a file that cannot be read is not a
  member. Neither is reported as a failure.
- The stem path of a member other than the root is the `<stem>`s of the files on the path from
  the root's child down to the member, joined by `/`. The session key names a member relative to
  the root: `self` for the root, and the stem path for any other member. The last `<stem>` of a
  key ends, for a session file an `Agent` dispatch created, with `-` and the dispatch's task ID
  ([agent-tool.md](agent-tool.md), Section 4.2), and for the tool log of a `Script` run, with `-`
  and the run's task ID ([script-tool.md](script-tool.md), Section 8.4).
- A root that has no session file is a member with no session entries; its agent directory is
  still read for children.

> Note (non-normative): the first-line check keeps a `.jsonl` data file that a tool wrote into
> the agent directory out of the tree.

### 4.1 Project {#project}

The sessions directory of a main session is the directory that holds its session file
(`<sessionDir>` of [agent-tool.md](agent-tool.md), Section 4.2). A child session, and a main
session without a session file, has none. The project of a main session is that session and its
project members, with their session trees.

- The project members of a main session are the files directly in its sessions directory, other
  than its own session file, that are regular files, not symbolic links, named `<stem>.jsonl`
  with a `<stem>` as Section 4 requires of a child, that are readable as a session file
  (Section 1), and whose session ID — the session header's `id` — is non-empty and consists only
  of safe-name characters. Each is the session file of another session of the same project, and
  the root of a session tree of its own.
- The session key of a project member is `~` followed by the first 13 characters of its session
  ID, or by the whole session ID when that is shorter. The session key of a member of a project
  member's session tree other than its root is the project member's key, `/`, and the member's
  stem path in that tree.
- Two project members can have the same key; a key then names both, and what a tool does with
  such a key is the tool's.
- No file outside the session tree of the main session and the session trees of its project
  members belongs to its project: not a session file of another sessions directory, and not one
  of another machine.

> Note (non-normative): the host keeps the session files of the sessions started in one working
> directory together in one directory; the 13 characters are the part of a session ID that
> differs between sessions started a millisecond apart.

## 5. Item address {#item-address}

An item address names one transcript item relative to a session — the root of a session tree,
and for a project member's items the main session whose project it belongs to — in the
notation of [RFC 5234]:

```abnf
address     = session-key ":" entry-id [ "." part ]
session-key = "self" / stem-path / ( "~" 1*13safe [ "/" stem-path ] )
stem-path   = stem *( "/" stem )
stem        = 1*safe
safe        = ALPHA / DIGIT / "." / "_" / "-"
entry-id    = 1*( ALPHA / DIGIT / "_" / "-" )
part        = "0" / ( %x31-39 *DIGIT ) / "error"
```

The address of an item is its session's key, `:`, its entry's `id`, and, exactly when the item
has a part (Section 2), `.` and the part. An address is case-sensitive — the grammar's quoted
strings match only as written, unlike in [RFC 5234] — and resolves to the item
it is the address of, or to none. An address is meaningful only to the session it is relative
to: the same item has another address for a child session and for another main session of the
project. It stays valid for that session while the session file keeps its name and the entry.

## 6. Transcript order {#transcript-order}

Transcript order is the total order of a set of items, each with a session key relative to one
session, by ascending `time` (Section 2); among equal times by ascending session key, compared
by UTF-16 code units; among equal keys of different sessions by ascending session file path with
symbolic links resolved, compared the same way; within one session by ascending line number; within one entry by ascending part, compared as numbers, the
part `error` last. File order is the order of one session's items by line number, then part the
same way.

## 7. Normative references {#references}

- [ECMA-262] ECMAScript Language Specification, 14th edition (June 2023), Ecma International:
  Regular Expressions (the character class escape `\s`), the property order `Object.keys` gives
  for an ordinary object, and `JSON.stringify`.
- [RFC 5234] Augmented BNF for Syntax Specifications: ABNF (STD 68), D. Crocker, Ed., and
  P. Overell, 2008: the grammar notation of Section 5 and its core rules `ALPHA` and `DIGIT`.

## 8. Specification gaps {#gaps}

- The host's session file format beyond the subset of Sections 1 and 2 is the host's: other
  entry types, other fields, other `message.content` element types, and the header's `version`,
  which is not checked. A host release that changes the subset is not detected.
- That entry IDs are unique within a file, that every entry other than the first carries the
  `parentId` of an earlier one, and that the host terminates each entry with a line feed in one
  write, are properties of the host inferred from session files, not guaranteed here.
- That the host keeps one directory of session files per working directory, and names each
  file so that its `<stem>` has only safe-name characters, is inferred from the directories of
  one machine. The header's `cwd` is not compared, so a session file moved into a sessions
  directory is a project member.
- An entry the host holds in memory and has not yet written to the session file is not read.
- After the host moves a session to an earlier entry and before it appends the next entry, the
  leaf of Section 3 is still the abandoned path's last entry.
- An entry the host has excluded from the model's context without removing it from the file is
  read like any other.
- What one read of a session file returns when the file is truncated, replaced, or deleted
  while that read is in progress.
- The item's `time` is the time the host recorded the entry, which for a tool result is its end,
  not its start.
