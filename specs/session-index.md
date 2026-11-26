# Session index specification

This document specifies the session index: the database in which the pi-dent processes of one
machine keep, per session file, where its session entries lie and which transcript items they
yield, so that a search need not read every file. It owns the index's location, format and
version, its rows and their invariants, catch-up, concurrent access, failure handling, and the
index prune, and the session titles read. The session entry, the transcript item, and the current
lineage are owned by [session-transcript.md](session-transcript.md); the `Search` tool
([search-tool.md](search-tool.md)) is the only reader of items, and owns how a query is answered.

The session index is derived data: every row can be rebuilt from session files, and no behavior
other than timing depends on its presence.

## 1. Location and format

The session index is one SQLite database file in write-ahead-log journal mode, opened with a
busy timeout of 1000 ms. Its path is the value of the environment variable `PI_DENT_SEARCH_DB` when
set and non-empty, else `~/.pi/pi-dent/search-v3.sqlite`. It is not the local session store
([session-store.md](session-store.md)) and MUST NOT share a file with it.

> Note (non-normative): the index is hundreds of megabytes, is written in long bursts, and can be
> deleted at any time; the local session store is small, is polled every 250 ms for message
> delivery, and holds state that cannot be rebuilt.

The format version is `3` and is recorded as the database's `user_version`. Opening the index
MUST, in this order:

1. Create the file's directory and the file when absent.
2. When `user_version` is `0` and the database holds no table: create the schema of Section 2 and
   set `user_version` to `3`.
3. When `user_version` is `3`: use the database.
4. Otherwise: leave the file unchanged; the index is unusable (Section 5).

The check of step 2 and the creation MUST happen inside one transaction begun with
`BEGIN IMMEDIATE`, so that of two processes opening an absent file the second finds the first's
schema; a creation that fails is rolled back whole.

A process MUST use the file that is at the path when a call starts: a file deleted or replaced
since the process last used it MUST NOT be used again.

An index file of another format version (`search-v<n>.sqlite`) MUST NOT be read or deleted. The
index file MUST NOT be shrunk: space freed by a reset or a prune is reused, not returned to the file
system.

> Note (non-normative): no file of an earlier version is migrated: version `3` adds
> `session_name` and `first_user_message`, which bytes consumed under version `2` never recorded.

## 2. Schema

The schema is exactly these statements; the index and table names are normative:

```sql
CREATE TABLE files (
  file_id            INTEGER PRIMARY KEY,
  path               TEXT    NOT NULL UNIQUE,
  session_id         TEXT    NOT NULL,
  started            INTEGER NOT NULL,
  consumed           INTEGER NOT NULL,
  lines              INTEGER NOT NULL,
  last_time          INTEGER NOT NULL,
  mtime              INTEGER NOT NULL,
  tail_offset        INTEGER NOT NULL,
  tail_hash          TEXT    NOT NULL,
  session_name       TEXT,
  first_user_message TEXT
);
CREATE TABLE entries (
  file_id   INTEGER NOT NULL,
  line      INTEGER NOT NULL,
  offset    INTEGER NOT NULL,
  bytes     INTEGER NOT NULL,
  entry_id  TEXT    NOT NULL,
  parent_id TEXT,
  time      INTEGER NOT NULL,
  lineage   INTEGER NOT NULL,
  PRIMARY KEY (file_id, line),
  UNIQUE (file_id, entry_id)
) WITHOUT ROWID;
CREATE TABLE items (
  item_id  INTEGER PRIMARY KEY,
  file_id  INTEGER NOT NULL,
  line     INTEGER NOT NULL,
  part     TEXT    NOT NULL,
  kind     TEXT    NOT NULL,
  tool     TEXT,
  is_error INTEGER NOT NULL,
  call_id  TEXT,
  time     INTEGER NOT NULL,
  UNIQUE (file_id, line, part)
);
CREATE INDEX items_time ON items (time);
CREATE INDEX items_call ON items (file_id, call_id) WHERE call_id IS NOT NULL;
CREATE VIRTUAL TABLE item_text USING fts5 (
  text, content = '', contentless_delete = 1, detail = none, tokenize = 'trigram'
);
```

A `files` row describes the consumed bytes of one session file: its first `consumed` bytes,
which always end just after a line feed. Times are milliseconds since the Unix epoch, rounded
down; offsets and lengths are in bytes.

| Table       | Column               | Contract                                                                                                                                             |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`     | `file_id`            | Assigned by the database at insertion.                                                                                                               |
| `files`     | `path`               | The session file's absolute path with symbolic links resolved.                                                                                       |
| `files`     | `session_id`         | The `id` of the session header.                                                                                                                      |
| `files`     | `started`            | The `time` of the session header.                                                                                                                    |
| `files`     | `consumed`           | The number of consumed bytes.                                                                                                                        |
| `files`     | `lines`              | The number of lines in the consumed bytes.                                                                                                           |
| `files`     | `last_time`          | The `time` of the last session entry in the consumed bytes.                                                                                          |
| `files`     | `mtime`              | The file's modification time as observed by the catch-up that last changed the row (Section 3).                                                      |
| `files`     | `tail_offset`        | The offset of the first byte of the last line of the consumed bytes.                                                                                 |
| `files`     | `tail_hash`          | The SHA-256 digest ([FIPS 180-4]), in lowercase hexadecimal, of the bytes from `tail_offset` up to, not including, `consumed`.                       |
| `files`     | `session_name`       | The session name of the consumed bytes, else null.                                                                                                   |
| `files`     | `first_user_message` | The first user line of the consumed bytes, else null.                                                                                                |
| `entries`   | (row)                | One per session entry in the consumed bytes that is not the session header and has a usable entry ID that no entry with a lower line number carries. |
| `entries`   | `line`               | The entry's line number.                                                                                                                             |
| `entries`   | `offset`             | The offset of the first byte of the entry's line.                                                                                                    |
| `entries`   | `bytes`              | The length of the entry's line, its line feed not counted.                                                                                           |
| `entries`   | `entry_id`           | The entry ID.                                                                                                                                        |
| `entries`   | `parent_id`          | `parentId` when a string, else null.                                                                                                                 |
| `entries`   | `time`               | The entry's `time`.                                                                                                                                  |
| `entries`   | `lineage`            | `1` when the entry is on the current lineage of the consumed bytes taken as a whole session file, else `0`.                                          |
| `items`     | (row)                | One per transcript item of an `entries` row.                                                                                                         |
| `items`     | `item_id`            | Assigned by the database at insertion.                                                                                                               |
| `items`     | `line`               | The line number of the item's entry.                                                                                                                 |
| `items`     | `part`               | The item's part, or the empty string when it has none.                                                                                               |
| `items`     | `kind`               | The item kind.                                                                                                                                       |
| `items`     | `tool`               | For a `tool_call` or `tool_result` item with a tool name, that name with the letters `A–Z` converted to lowercase; else null.                        |
| `items`     | `is_error`           | `1` for a `tool_result` item that records a tool error, else `0`.                                                                                    |
| `items`     | `call_id`            | The item's tool-call ID, else null.                                                                                                                  |
| `items`     | `time`               | The item's `time`.                                                                                                                                   |
| `item_text` | (row)                | One per `items` row, its `rowid` the `item_id` and its `text` the item's match text ([session-transcript.md](session-transcript.md), Section 2).     |

The terms of the table — session header, usable entry ID, line number, `time`, part, tool name,
and tool-call ID — are those of [session-transcript.md](session-transcript.md), Sections 1 and 2;
tool error is that of [task.md](task.md), Section 5. `file_id` in `entries` and `items` is the
`file_id` of the `files` row.

In the rules below, white space is that of [session-transcript.md](session-transcript.md),
Section 2, and a session entry counts whatever its `id`, also when that is not usable or repeats
an earlier one.

- The session name of the consumed bytes is taken from their last session entry with `type`
  `session_info`: its `name` with white space trimmed from both ends, when `name` is a string
  and the result is not empty. There is none when that entry's `name` is absent, not a string,
  or only white space, or when no such entry exists.
- The text parts of a session entry with `type` `message` and `message.role` `user` are
  `message.content` when it is a string, else the string `text` of each object element of the
  array `message.content` whose `type` is `text`, in order; every other element is left out.
  Its user line is the first line, the text parts joined by one line feed and split at each line
  feed, that has a character other than white space, with white space trimmed from both ends and
  then cut to its first 80 Unicode code points. An entry with no such line has no user line.
- The first user line of the consumed bytes is the user line of their first session entry with
  `type` `message`, `message.role` `user`, and a user line; there is none when no entry has one.
  A later entry never replaces it.

Every committed transaction MUST leave, for each `files` row, exactly the `entries`, `items`, and
`item_text` rows the table gives for its consumed bytes, and none for a `file_id` without a
`files` row. The index MUST NOT hold an item's text in any other form: `item_text` is contentless
and returns none.

> Note (non-normative): text is read back from the session file by `offset` and `bytes`, so the
> index stays near a quarter of the transcripts' size instead of exceeding it; `detail = none`
> drops token positions, which a search that verifies every candidate does not need.

## 3. Catch-up

A catch-up brings the rows of one session file up to the file. It applies to a file readable as
a session file ([session-transcript.md](session-transcript.md), Section 1) and MUST proceed as
follows, `<size>` and `<mtime>` being the file's size and modification time read once, before
any other step:

1. With no `files` row for the file's `path`: insert one whose consumed bytes are the session
   header's line, and continue at step 4.
2. With a row whose `consumed` equals `<size>` and whose `mtime` equals `<mtime>`: change
   nothing; the catch-up is complete.
3. With a row whose `consumed` is greater than `<size>`, or whose `tail_hash` is not the digest
   of the file's bytes from `tail_offset` up to `consumed`: reset the file — delete the row and
   every row of its `file_id` — and continue as with no row.
4. Extend the consumed bytes by the lines that follow them and end with a line feed at or before
   offset `<size>`, in order, and set `mtime` to `<mtime>`. A line that
   [session-transcript.md](session-transcript.md), Section 1, skips is consumed and yields no
   row. A transaction MUST derive `session_name` and `first_user_message` from the row's values
   and the lines it adds, without reading bytes consumed before.

- A file that is absent, or not readable as a session file, has no catch-up: every row of its
  `path` MUST be deleted, in one transaction.
- One transaction MUST extend the consumed bytes by at most 8388608 bytes, or by one line when
  that line alone is longer; a catch-up with more to consume uses further transactions.
- A catch-up is complete when a transaction of it leaves no line feed between `consumed` and
  `<size>`. A catch-up that stops earlier — by a deadline, an abort, a failed write, or the end
  of the process — leaves its committed transactions in place, and a later catch-up continues
  from them.
- An `entries` row is stale when the line read back by its `offset` and `bytes` cannot be read
  or is not a JSON object whose `id` equals the row's `entry_id`. An `items` row is stale when
  its `entries` row is, and when the line read back, though it is that entry, does not yield a
  transcript item with the row's `part` and `kind`. A reader that finds a stale
  row and may still write the index ([search-tool.md](search-tool.md), Section 2.2) MUST reset
  the file as in step 3, in one transaction, when the file's `files` row still has the
  `consumed` and `tail_hash` the reader read, and MUST change nothing when the row is gone, has
  another `consumed` or `tail_hash`, or the reader may no longer write the index. Either way the
  file's catch-up is not complete for that reader; what its tool call then returns is owned by
  [search-tool.md](search-tool.md), Section 2.2.

  > Note (non-normative): a reader works from a snapshot; the condition keeps it from deleting
  > rows that another process rebuilt after the snapshot was taken.

> Note (non-normative): the session files of the subset are appended to and never rewritten, so
> the digest of one line is enough to tell an appended file from a replaced or truncated one
> without reading the consumed bytes again.

## 4. Concurrent access

Several processes, and several sessions of one process, read and write the index at once.

- Every change MUST be made in a transaction begun with `BEGIN IMMEDIATE`, and a catch-up
  transaction MUST read the file's `files` row inside the transaction that changes it. Two
  catch-ups of one file are thereby serialized: the second finds the first's consumed bytes and
  adds none twice.
- A catch-up or reset transaction that cannot begin within the busy timeout is not a failed
  write: the writer MUST attempt it again until it begins or the catch-up is stopped by a
  deadline, an abort, or the end of the boot window. Between two attempts, and between two
  transactions of one catch-up, the writer MUST yield to the process's event loop, so that an
  abort is observed and other work of the process proceeds. The transaction that creates the
  schema is not attempted again (Section 5).
- A reader MUST take what it uses of one session file — the `files` row, the `entries` and
  `items` rows, and the `item_text` matches — from one read transaction, or from several when
  each later one finds the `files` row with the same `path` and a `consumed` no smaller, and the
  same items under the `item_id`s it uses, so that each such read sees the file's rows as one
  committed transaction left them. A reader that finds the `files` row gone,
  or its `consumed` smaller than the reader's own catch-up of the file left, MUST NOT use the
  file's rows; what its tool call then returns is owned by [search-tool.md](search-tool.md),
  Section 2.2.
- A reader MUST NOT hold a read transaction open after its tool call returns.

## 5. Failures

| Condition                                                                                                                                                                  | Outcome                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The file is absent                                                                                                                                                         | It is created (Section 1); every session file then awaits its first catch-up.                                                                                                                                                                                            |
| SQLite reports that the file is not a database or is malformed, at opening or in any statement                                                                             | The process MUST delete the file and its `-wal` and `-shm` companions and open the index anew, once per tool call; a second such report in the call makes the index unusable, with the reason `index file is corrupt: <message>`, `<message>` being the error's message. |
| `user_version` is neither `0` with no table nor `3`                                                                                                                        | The index is unusable, with the reason `unsupported index version <user_version>`; the file MUST NOT be changed.                                                                                                                                                         |
| The file cannot be opened or created                                                                                                                                       | The index is unusable, with the reason the error's message.                                                                                                                                                                                                              |
| The index path and local session store path name the same file (Section 1): when both exist, they have the same device and inode; otherwise their resolved paths are equal | The index is unusable, with the reason `the index file is the session store file`; the file MUST NOT be opened.                                                                                                                                                          |
| A catch-up or reset transaction cannot begin within the busy timeout                                                                                                       | It is attempted again (Section 4).                                                                                                                                                                                                                                       |
| A write transaction fails otherwise (a full disk, a read-only file)                                                                                                        | A failed write, with the reason the error's message: the transaction is rolled back and that catch-up stops, not complete; reading the index continues.                                                                                                                  |
| Any other SQLite error, at opening, in creating the schema, or in a read, a busy error on a read included                                                                  | The index is unusable, with the reason the error's message.                                                                                                                                                                                                              |

An unusable index is unusable for the tool call that found it so and is opened anew by the next.
No failure of the index is a tool error by itself: what a call returns without a complete
catch-up is owned by [search-tool.md](search-tool.md), Section 2.2.

## 6. Index prune

The index prune deletes, for every `files` row whose `path` is not an existing regular file,
the row and every row of its `file_id`, in transactions of at most 100 `files` rows each. The
prune runs when [agent-tool.md](agent-tool.md), Section 10 says. A prune that fails, cannot
begin a transaction within the busy timeout, or finds the index unusable or its file not a
database or malformed MUST stop without reporting a failure and without deleting the file. The
prune MUST NOT create the index file when it is absent.

A session file deleted between prunes keeps its rows until the next prune; they are never
returned, because a search takes its sessions from the file system
([search-tool.md](search-tool.md), Section 2.1).

## 7. Session titles

The session title of a session file is its session name and first user line (Section 2) as its
`files` row holds them. The index provides a batch read of session titles, for applications other
than pi-dent, as this method of `SessionIndex`:

```ts
export interface SessionTitle {
  sessionName: string | null;
  firstUserMessage: string | null;
  complete: boolean;
}
titles(paths: readonly string[]): ReadOutcome<Map<string, SessionTitle>>;
```

- Each given path is resolved against the process's working directory with its symbolic links
  resolved, and matched to the `files` row of that `path`. A path that cannot be resolved, or
  has no row, has no key in the map; that is not a failure.
- Every other path is a key of the map exactly as given, once however often it is given, in the
  order of its first occurrence. Its value holds the row's `session_name` as `sessionName` and
  its `first_user_message` as `firstUserMessage`. `complete` is `true` when the row's `consumed`
  equals the file's current size and its `mtime` the file's current modification time, read as
  in Section 3, and `false` otherwise, a file whose size cannot be read included.
- The read MUST take every row from one read transaction, MUST NOT catch up or otherwise
  change the index, and MUST look rows up through the `path` index, so that its cost grows with
  the number of paths given, not with the number of rows.
- A failure of the index is returned as `{ ok: false, reason }`, `reason` being the reason of
  Section 5, and is not thrown.

## 8. Normative references

- [FIPS 180-4] Secure Hash Standard (SHS), National Institute of Standards and Technology,
  August 2015: the SHA-256 algorithm.

## 9. Specification gaps

- The SQLite file format, the FTS5 extension, its `trigram` tokenizer and that tokenizer's case
  folding are SQLite's.
- A session file changed anywhere before its last consumed line, with that line left as it was
  at `tail_offset` and the file no shorter than `consumed`, is not detected as changed by a
  catch-up, whatever its size and modification time; only a stale row found later reveals it.
- A file at the `PI_DENT_SEARCH_DB` path that is a valid SQLite database of another application
  with `user_version` `3` is used as an index.
- Rows written by a process that ended inside a transaction are SQLite's to roll back.
