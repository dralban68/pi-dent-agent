# `Search`: implementation notes

Non-normative. How `Search` is built, why, and what it costs. The specs decide:
[search-tool.md](../specs/search-tool.md), [session-index.md](../specs/session-index.md),
[session-transcript.md](../specs/session-transcript.md).

## Modules

| File                        | Owns                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `lib/session-transcript.ts` | Parsing session files: entries, items, lineage, session trees, project members, addresses, order.        |
| `lib/session-index.ts`      | The SQLite index `~/.pi/pi-dent/search-v2.sqlite` (`PI_DENT_SEARCH_DB`): schema, catch-up, reads, prune. |
| `lib/search-tool.ts`        | Tool schema, validation, scope and session resolution, discovery and its cache, `get`, `sessions`.       |
| `lib/search-eval.ts`        | `find`: covering, candidate sources, filters, matching, merge, stop item, hit lines.                     |
| `lib/search-worker.ts`      | Worker thread for `regex: true`, so a catastrophic pattern is terminated instead of blocking the loop.   |

`index.ts` registers the tool for the main session; `lib/engine.ts` offers it to a child when its
tool cap names it, and runs the index prune after the retention sweep.

## A `find` call

1. **Discover** the call's sessions from the file system. The forest is cached per process and
   reused while no directory it listed has changed; headers come from the index's `files` rows
   for known files, so only new files are opened.
2. **Cover** each session within 3000 ms: an incremental catch-up into the index (one stat for an
   unchanged file), or a direct read when the index is unusable or a write failed. Uncovered
   sessions are reported and continue in the background.
3. **Pull candidates** in the call's order from sources, merged:
   - **Per-session sources** (`FileSource`) when the covered sessions hold at most 200000 lines:
     each session's rows load through the `(file_id, line, part)` index, narrowed by trigrams
     first, so cost follows the scope's own items, not the index's.
   - **One scan source** (`ScanSource`) above that: literal or regex-literal trigram probes (up to
     2000 matches), a chunked collection for sparse filters (`kinds`, `tool`, `isError`), and
     otherwise time-windowed pages restricted to the call's files. A time group above 50000 rows
     is walked file by file in the call's order.
   - **Direct-read sources** (`SlotListSource`) for sessions covered without the index.
4. **Filter and match** each candidate with the same code on every path (`filterSlot`), re-read
   its text from the session file by byte offset, and check the entry ID still matches; a
   mismatch makes the session uncovered for the rest of the call.
5. **Stop** at the limit, the 5000 ms budget, or an abort. A stopped call returns a prefix and a
   stop address; `after` continues from it. Filters applied in SQL count as decided items, so a
   continuation always makes progress.

Every loop yields to the event loop at least every 40 ms and checks the budget and abort; none
depends on the clock advancing to end.

## Testing

- `test/search-tool/oracle.test.ts` computes expected hits straight from session files by the
  spec's rules, using `session-transcript.ts` but none of the evaluation code, and compares `find`
  over 1024 paged runs (scopes × filters × orders × branches × index usable or not × limits),
  plus the scan path, oversized time groups and sessions, `after` inside a time group, and stops
  continued by `after`. Narrowing is asserted by counting items read back (`onItemRead`).
- A test that fails before its fix stays in the suite. Earlier rounds passed their own tests while
  `find` returned wrong hits; only the oracle caught that.
- Run measurement scripts with a timeout and an injected clock that may freeze: an unbounded
  page loop once spun for 1 h 43 min.

## Cost

Repeat calls, real clock, synthetic sessions of 300 items, measured at commit `368856f`.

| Call                                          | 3000 sessions   | 30000 sessions (9.1M items) |
| --------------------------------------------- | --------------- | --------------------------- |
| `project`: common / rare / absent word        | 29 / 17 / 14 ms | 167 / 157 / 139 ms          |
| `project`: regex / `oldest` / no-match filter | 33 / 23 / 51 ms | 164 / 175 / 491 ms          |
| `session` / `tree` of 75000 lines, common     | 4 / 80 ms       | 7 / 91 ms                   |
| deep paging, pages 1–15                       | 18–31 ms        | 148–167 ms                  |
| abort observed                                | ≤ 3 ms          | ≤ 22 ms                     |
| largest event-loop gap                        | 135 ms          | 187 ms                      |

What grows with what, for a call showing 20 hits:

- Sessions in scope: a stat and a `files` row each, about 5 µs.
- Index items: sparse-filter collection, about 50 ns per row warm.
- The scope's own items: loading a large tree.

Index size is about a quarter of the transcripts' (contentless FTS5, `detail=none`).

## Known limits

- A query with no ASCII trigram (one or two characters, non-ASCII only, a regex with no literal
  run) scans to the 5000 ms budget and continues with `after`.
- At 30000–50000 sessions a `project` call costs about 150–250 ms; a no-match filter 0.5–0.8 s,
  and on a cold page cache once 4.8 s.
- A common word in a 75000-line tree takes 80 ms, growing with the tree.
- An index on `items (file_id, time)` was measured and not adopted: it gained nothing for the
  calls above at 13% more disk.
