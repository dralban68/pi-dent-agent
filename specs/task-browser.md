# Task browser specification

This document specifies the task browser: the full-screen terminal UI listing the task tree of
the main session and showing one task's details. The task row is owned by
[task-registry.md](task-registry.md); the task tree by [task.md](task.md), Section 3.

## 1. Activation

- The extension MUST register the task browser shortcut through the host `registerShortcut` API.
  The shortcut is the `taskBrowser.shortcut` configuration value (Section 1.1).
- The shortcut MUST open the task browser only when the session has an interactive terminal UI;
  otherwise it is a no-op. The shortcut toggles the task browser per
  [browser-navigation.md](browser-navigation.md), Section 2.
- The command `tasks` is specified in [slash-commands.md](slash-commands.md), Section 3.
- The task browser MUST be shown through the host custom UI surface as an overlay covering the
  full terminal width and height. Its navigation keys are those of
  [browser-navigation.md](browser-navigation.md), Section 3, in addition to the keys of its pages.
- It opens on the list page (Section 3) with the last row selected.
- Closing and reload behavior follows [browser-navigation.md](browser-navigation.md), Section 2.
- Execution MUST NOT depend on the task browser. Except for the kill key of Section 4.4, the
  browser MUST NOT `consume`, `cancel`, or otherwise mutate a task row.
- A failure of the browser's own refresh or tick MUST be shown once per opened browser through the
  host `notify` API at level `error`, with the text `pi-dent: task browser: <message>`.

### 1.1 Configuration

The root key `taskBrowser` of the configuration file ([config-file.md](config-file.md)) is an
object:

| Key        | Type    | Contract                                                                 |
| ---------- | ------- | ------------------------------------------------------------------------ |
| `shortcut` | string? | Host key identifier of the task browser shortcut. Default `shift+right`. |

A host key identifier is one key name, optionally preceded by modifier names joined by `+`. The
modifiers are `ctrl`, `shift`, `alt`, and `super`, each used at most once, in any order. A key name
is one of:

- a letter `a`–`z` or a digit `0`–`9`;
- a symbol key `` ` `` `-` `=` `[` `]` `\` `;` `'` `,` `.` `/` `!` `@` `#` `$` `%` `^` `&` `*`
  `(` `)` `_` `+` `|` `~` `{` `}` `:` `<` `>` `?`;
- a named key: `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`,
  `clear`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`, `f1` to `f12`.

Every name is compared exactly, including its letter case. Examples: `shift+right` (the default),
`ctrl+t`, `pageUp`, `+`, `ctrl+shift+p`.

A `taskBrowser` value that is not an object, or a `shortcut` that is not a non-empty string, MUST
produce one diagnostic and the default applies. A `shortcut` that is a non-empty string but not a
host key identifier MUST produce one diagnostic naming its layer file ([config-file.md](config-file.md),
Section 4) and the default applies; its text is
`config: <file>: taskBrowser.shortcut must be a host key identifier; ignored`.

## 2. Common rendering

- Every page renders exactly the terminal height: one title line, the body, one key-hint line.
  A body shorter than its area is padded with empty lines; a longer one scrolls.
- Every line MUST be plain text colored only through the host theme, truncated to the render
  width, never wrapped, except the `Error` and `Task` lines of Section 4.1, the `Command` lines of
  Section 4.2, and the expanded content lines of Section 4.3, which are wrapped to the render
  width. ANSI escape sequences and control characters MUST be removed from every task-row and
  session-file value before rendering.
- `<time>` is a wall-clock time `HH:MM:SS` in the local zone ([billing.md](billing.md),
  Section 5); `<datetime>` is `YYYY-MM-DD HH:MM:SS` in that zone.
- `<elapsed>` is the duration from `startedAt` to `settledAt` for a settled row, or to now
  while the row is `running`, in the format of [task.md](task.md), Section 4.
- `<status>` color: `running` `accent`; `completed` `success`; `failed` `error`; `cancelled`
  `warning`; `interrupted` `warning`. `<time>` and `<elapsed>`: `muted`. `orphan`: `warning`.
- An open page MUST follow the refresh rule of [task-registry.md](task-registry.md), Section 7,
  and MUST NOT run a refresh timer while the task browser is closed.

## 3. List page

- The list page has a filter, `all` or `running`. It is `all` whenever the task browser opens,
  and it is kept while the details page is shown.
- Title line: `Tasks · <running> running · <total> total<filter>`, counting the members of the
  task tree under either filter; `<filter>` is empty under `all` and ` · running only` under
  `running`.
- Content: under `all`, every member of the task tree; under `running`, every member whose
  `status` is `running`. One row per task, depth-first, siblings in registration order; no
  settled result text is shown. With an empty content the body is the single line `(no tasks)`
  under `all` and `(no running tasks)` under `running`.
- Row format:
  `<prefix><time> · <elapsed> · <taskId> · <kind> · <delivery> · <status> · <label>`, with
  `orphan · ` inserted after `<delivery>` for an adopted task row and `<detail> · ` inserted
  before `<label>` when `<detail>` is non-empty, where `<time>` is `startedAt` and `<prefix>`,
  `<delivery>`, `<label>`, and `<detail>` are those of [task.md](task.md), Section 4.
- Exactly one row is selected while the content is non-empty; the selected row MUST be rendered
  with the host theme's selection background. The selection follows its `taskId` across registry
  changes; when that row leaves the content, the row now at its index, else the last row, is selected; when the content becomes non-empty, the last row. The body MUST scroll to keep the selected row visible.

| Key                  | Action                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------- |
| `up`, `k`            | Select the previous row.                                                               |
| `down`, `j`          | Select the next row.                                                                   |
| `pageUp`, `pageDown` | Move the selection by one body height.                                                 |
| `home`, `end`        | Select the first, the last row.                                                        |
| `g`, `G`             | The same as `home`, `end` ([browser-navigation.md](browser-navigation.md), Section 4). |
| `enter`              | Open the details page (Section 4) of the selected row.                                 |
| `f`                  | Switch the filter between `all` and `running`.                                         |
| `escape`, `q`        | Close the task browser.                                                                |

`left`, `right`, `g`, and `G` are the navigation keys of
[browser-navigation.md](browser-navigation.md), Sections 3 and 4; on the list page `right` and
`enter` open the details page of the selected row.

A filter switch changes the content, and the selection follows it by the rule above: a selected
row that stays in the content stays selected.

Key-hint line: `↑↓ select · g/G top/bottom · f running/all · enter details · esc close`.

## 4. Details page

The details page renders one task row. It MUST keep rendering that row after the row leaves the
task tree.

- Title line: `Task <taskId> · <kind> · <status> · <elapsed>`.
- Body: the sections of the row's task kind (Sections 4.1, 4.2), in order, each headed by its
  name on a line of its own and separated from the next by one empty line. A field whose value
  is absent is omitted; a section with no line renders `(none)`.
- `escape`, `backspace`, and `q` return to the list page, selection unchanged.

### 4.1 `agent`

| Section  | Lines                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`  | One `<name>: <value>` line per field, in the order of the table below.                                                                            |
| `Error`  | Only for a `failed` row with a `result`: the row's `result`, one line per text line, each wrapped to the render width.                            |
| `Task`   | The row's `task`: every line of its text, each wrapped to the render width; a tab is rendered as 2 spaces. No line is dropped and none is capped. |
| `Events` | The session events of the row's `sessionPath` (Section 4.3).                                                                                      |

| `<name>`   | `<value>`                                                                       |
| ---------- | ------------------------------------------------------------------------------- |
| `agent`    | The row's `agent`.                                                              |
| `model`    | The row's `model`.                                                              |
| `delivery` | `<delivery>`, followed by ` · orphan` for an adopted task row.                  |
| `started`  | `<datetime>` of `startedAt`.                                                    |
| `settled`  | `<datetime>` of `settledAt`.                                                    |
| `usage`    | `<usage>` of the row's `usage` ([agent-tool.md](agent-tool.md), Section 13).    |
| `session`  | The row's `sessionPath`, shown per [agent-tool.md](agent-tool.md), Section 4.2. |
| `result`   | The row's `resultPath`, shown the same way.                                     |

The `Error` and `Task` lines are shown per [agent-tool.md](agent-tool.md), Section 4.2.

Exactly one session event is selected while there is any; its line MUST be rendered with the
host theme's selection background. Whenever the selection or the expansion of a session event
changes, the body MUST scroll the least needed to make the selected session event's line visible
and, below it, as many of its expanded content lines as fit the body area; the scroll position
MUST NOT move except through the keys below. With no session event, the scroll keys of Section 4.2 apply, `left` and the kill key keep their
behaviour and the key-hint line is the one of the table below, and `enter`, `space`, `right`, `e`, and `c` do
nothing.
The page opens with the last session event selected; while the last one is selected, an appended
session event becomes the selected one, otherwise the selection MUST NOT move.

| Key                  | Action                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up`, `k`            | Scroll the body up one line while the selected session event's line is above the body area; otherwise select the previous session event; on the first, scroll the body up one line. |
| `down`, `j`          | Scroll the body down one line while the selected session event's last expanded content line is below the body area; otherwise select the next session event.                        |
| `pageUp`, `pageDown` | Move the selection by one page, per the paging rule below.                                                                                                                          |
| `home`, `end`        | Scroll the body to its first line and select the first session event; select the last.                                                                                              |
| `g`, `G`             | The same as `home`, `end`.                                                                                                                                                          |
| `enter`, `space`     | Toggle the selected session event between collapsed and expanded.                                                                                                                   |
| `right`              | Expand the selected session event.                                                                                                                                                  |
| `left`               | Return to the list page, equal to `escape`.                                                                                                                                         |
| `e`, `c`             | Expand, collapse every session event.                                                                                                                                               |
| `ctrl+k`             | Kill the shown task, per Section 4.4.                                                                                                                                               |

Paging rule: the page size P is the number of body lines shown, the page height less the
title and key-hint lines, and at least 1. Let `h` be the body line of the selected event's
collapsed line, counted from the first body line over all sections (the wrapped `Task` lines included),
and `T` be `h - P` for `pageUp` and `h + P` for
`pageDown`; the body scroll position does not enter `T`. The selected event becomes the last event
whose collapsed line is at or before `T`; when no event's line is at or before `T`, the first event
becomes selected. Paging never selects past either end. The body then scrolls as Section 4.1 requires
for a changed selection.

Key-hint line, per the state of the kill key (Section 4.4):

| State                     | Key-hint line                                                                  |
| ------------------------- | ------------------------------------------------------------------------------ |
| kill key applies, unarmed | `↑↓ select · g/G top/bottom · enter expand · e/c all · ctrl+k kill · esc back` |
| kill key armed            | `↑↓ select · enter expand · e/c all · ctrl+k again to confirm kill · esc back` |
| otherwise                 | `↑↓ select · g/G top/bottom · enter expand · e/c all · esc back`               |

The armed line has no `g/G top/bottom` segment, so that every key-hint line of the task browser
fits 80 columns.

### 4.2 `script` and `bash`

| Section                           | Lines                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Script`; `Bash` for a `bash` row | `label: <label>`, then the `delivery`, `started`, `settled`, and `result` lines of 4.1.                                                                                                                                                                                                                                        |
| `Command`                         | Only for a `bash` row: the row's `command`, one line per text line, each wrapped to the render width; a tab is rendered as 2 spaces.                                                                                                                                                                                           |
| `Code`                            | Only for a `script` row whose `code` is not empty: the row's `code`, one line per text line, each wrapped to the render width; a tab is rendered as 2 spaces. Each line is syntax-highlighted as TypeScript through the highlighter the extension instance passes to the browser; where it provides none, the lines are plain. |
| `Output`                          | The task's output as it arrives: the `line` of each progress projection entry, in append order ([script-tool.md](script-tool.md), Section 6; [bash-tool.md](bash-tool.md), Section 4).                                                                                                                                         |

The `Command` lines are shown per [agent-tool.md](agent-tool.md), Section 4.2. The `Code` lines
are shown the same way.

| Key                    | Action                                      |
| ---------------------- | ------------------------------------------- |
| `up`, `k`, `down`, `j` | Scroll the body by one line.                |
| `pageUp`, `pageDown`   | Scroll the body by one body height.         |
| `home`, `end`          | Scroll to the top, the bottom.              |
| `g`, `G`               | The same as `home`, `end`.                  |
| `ctrl+k`               | Kill the shown task, per Section 4.4.       |
| `left`                 | Return to the list page, equal to `escape`. |

While the body is scrolled to the bottom, appended lines MUST keep it at the bottom; otherwise
the scroll position MUST NOT move. The page opens scrolled to the bottom.

Key-hint line, per the state of the kill key (Section 4.4):

| State                     | Key-hint line                                                          |
| ------------------------- | ---------------------------------------------------------------------- |
| kill key applies, unarmed | `↑↓ scroll · g/G top/bottom · ctrl+k kill · esc back`                  |
| kill key armed            | `↑↓ scroll · g/G top/bottom · ctrl+k again to confirm kill · esc back` |
| otherwise                 | `↑↓ scroll · g/G top/bottom · esc back`                                |

### 4.3 Session events

The session events of a session file are derived from its lines in file order. Each line is one
JSON object, an entry, with `type` and a `timestamp` in the date-time format of [ISO 8601]; a line
that is not such an object and the entry of `type` `session` are skipped, and no failure is
reported for them. Each remaining entry yields:

| Entry                                         | Session events                   | `<kind>`            | `<summary>`                        | Expanded content                         |
| --------------------------------------------- | -------------------------------- | ------------------- | ---------------------------------- | ---------------------------------------- |
| `type` `message`, `message.role` `assistant`  | One per `message.content` block: |                     |                                    |                                          |
| — block `type` `text`                         |                                  | `assistant`         | First non-empty line of `text`     | `text`                                   |
| — block `type` `thinking`                     |                                  | `thinking`          | First non-empty line of `thinking` | `thinking`                               |
| — block `type` `toolCall`                     |                                  | `call <name>`       | `arguments` as single-line JSON    | `arguments` as JSON indented by 2 spaces |
| — any other block                             |                                  | `<block type>`      | Empty                              | The block as JSON indented by 2 spaces   |
| `type` `message`, `message.role` `toolResult` | One                              | `result <toolName>` | First non-empty line of the text   | The text                                 |
| `type` `message`, any other `message.role`    | One                              | `<role>`            | First non-empty line of the text   | The text                                 |
| Any other `type`                              | One                              | `<type>`            | Empty                              | The entry as JSON indented by 2 spaces   |

- An assistant `message.content` that is a string is one `text` block; a `message` without a
  string `role` has `<kind>` `message`.
- A `text` or `thinking` block whose `text` or `thinking` is empty or only whitespace yields no
  session event; the block index of the other blocks is unchanged.
- The text of a message is its `content` when a string, else its `text` blocks joined by line
  breaks, every other block contributing the line `[<block type>]`.
- A collapsed session event is one line: `<mark> <time> <kind> · <summary>`, `<time>` the
  entry's `timestamp`, ` · <summary>` omitted when `<summary>` is empty; `<mark>` is `▸`
  collapsed, `▾` expanded. `<kind>`: `accent`; `error` for a `toolResult` with `isError` `true`.
- An expanded session event is its collapsed line followed by its expanded content, each line
  indented by 2 columns and wrapped to the render width;
  a tab is rendered as 2 spaces; empty content renders `(empty)`. At most 200 wrapped content lines are rendered, followed by
  `… <n> more lines` when lines are dropped.
- Session events are collapsed when first read. Expansion state belongs to the open details
  page and is keyed by entry position and block index.
- The session file MUST be read when the details page opens and re-read, while the row is `running`, once per 1000 ms and on no other occasion, and once at its settlement. A read failure or an
  absent `sessionPath` yields no session events, and no failure is reported for it. The task
  browser MUST NOT write a session file.

### 4.4 Kill key

The kill key of every details page is `ctrl+k`.

- At the time of a press, the key applies to the shown row exactly while the row is `running`
  and a task registry that holds it is reachable from the browser's registry through the task
  tree ([task.md](task.md), Section 3): the session's own registry, or the registry of a child
  session at any depth, through the attached `children` registries
  ([task-registry.md](task-registry.md), Section 6).
- A task the browser cannot reach MUST NOT be killed from it: a `Fleet` query dispatch's row sits
  in a task registry attached to no row and is a member of no task tree
  ([task-registry.md](task-registry.md), Section 1), so no page shows it and the key never applies
  to it.
- For a row the key does not apply to, a press MUST do nothing, and the key-hint line MUST NOT
  carry the segment (Sections 4.1 and 4.2).
- The first press on a row the key applies to MUST arm the key without cancelling anything; the
  key-hint line then carries the confirming segment. The next press MUST cancel the row in the
  registry that holds it, by the cancellation `Task` `kill` performs there
  ([task-tool.md](task-tool.md), Section 2.2), and disarm the key. A browser kill is the cancel
  performed by the kill key's confirming press. A browser kill MUST NOT `consume` the row
  ([task-registry.md](task-registry.md), Section 5): the settlement is delivered as any other
  settled task of the row's delivery mode is — a completion notification for a background row,
  the tool result of the call for a foreground row. For a `bash` or `script` row the result text
  names the browser kill ([bash-tool.md](bash-tool.md), Section 5;
  [script-tool.md](script-tool.md), Section 5); an `agent` row's result text is the cancellation
  result of [agent-tool.md](agent-tool.md), Section 7, unchanged. Any other key MUST disarm it
  and be handled per its own rule. Arming also ends when the page is left and when the shown row
  settles.
- After the cancelling press, the page MUST show the row's new status through the refresh rule
  of Section 2, with no further key press.

## 5. Normative references

- [ISO 8601] Date and time — Representations for information interchange (ISO 8601-1): the
  date-time format of an entry's `timestamp`.

## 6. Specification gaps

- The marker, if any, and the handling of wide characters when a line is truncated to the render
  width are the terminal toolkit's.
- The session file entry and message schemas beyond the fields named in Section 4.3 are the
  host's and unspecified.
- A `shortcut` that is a host key identifier but collides with a host key binding, or names a key
  the terminal never sends, is unspecified.
- A terminal that reports `ctrl+k` as `ctrl+shift+k`, or does not report it, leaves the kill key
  unreachable; the host input layer decides what a page receives.
