# Footer specification

This document specifies the footer: the lines pi-dent draws below the editor in place of the host's
built-in footer, so that every extension status is set apart from the next and the usage tally
([agent-tool.md](agent-tool.md), Section 13) sits beside the context segment.

## 1. Activation

- At every `session_start` of the main session, when the session has an interactive terminal UI
  and `footer.enabled` (Section 1.1) is `true`, the extension MUST set the footer through the host
  `setFooter` API. Otherwise it MUST NOT call `setFooter`, and the host draws its own footer.
- At every `session_shutdown`, a reload included, the extension MUST restore the built-in footer
  by calling `setFooter` with no footer, when it set one.
- When the host `setFooter` API throws, the extension MUST show the notification
  `pi-dent: footer could not be set: <error>` at level `error` through the host `notify` API
  ([config-file.md](config-file.md), Section 6); the host's footer stays.
- A render of the footer that throws MUST restore the built-in footer and show the notification
  `pi-dent: footer failed: <error>` at level `error`, once; the footer is not set again until the
  next `session_start`.
- Execution MUST NOT depend on the footer.

### 1.1 Configuration

The root key `footer` of the configuration file ([config-file.md](config-file.md)) is an object:

| Key       | Type     | Contract                                          |
| --------- | -------- | ------------------------------------------------- |
| `enabled` | boolean? | Whether pi-dent draws the footer. Default `true`. |

A `footer` value that is not an object, or an `enabled` that is not a boolean, MUST produce one
diagnostic naming its layer file ([config-file.md](config-file.md), Section 4) and the default
applies; the texts are `config: <file>: footer must be an object; ignored` and
`config: <file>: footer.enabled must be a boolean; ignored`.

## 2. Lines

The footer renders, in order, the path line, the stats line, and, when it is not empty, the
status line. Every line is truncated to the render width, never wrapped, with `...` as the
marker at its end, and is colored only through the host theme. A token count is rendered per
[agent-tool.md](agent-tool.md), Section 13.

The footer MUST reflect a change of any value it shows — a session entry, the model, the
thinking level, the Git branch, the usage tally and the end of its partial state, an extension
status — within 1000 ms.

### 2.1 Path line

`<cwd><branch><name>`:

- `<cwd>` is the session's working directory; when it is the user's home directory or inside it,
  the home directory part is replaced by `~`.
- `<branch>` is ` (<branch name>)` when the host reports a Git branch, else empty.
- `<name>` is ` • <session name>` when the session has a name, else empty.

### 2.2 Stats line

`<left>`, then padding, then `<right>` ending at the render width.

`<left>` is these segments, joined by one space, a segment being omitted when its condition
fails:

| Segment               | Condition                                            | Value                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `↑<input>`            | `input` is not 0                                     | Session total of input tokens.                                                                                                                                                          |
| `↓<output>`           | `output` is not 0                                    | Session total of output tokens.                                                                                                                                                         |
| `R<cacheRead>`        | `cacheRead` is not 0                                 | Session total of cache-read tokens.                                                                                                                                                     |
| `W<cacheWrite>`       | `cacheWrite` is not 0                                | Session total of cache-write tokens.                                                                                                                                                    |
| `CH<rate>%`           | `cacheRead` or `cacheWrite` is not 0, and a rate     | Cache hit rate of the latest assistant message, one decimal: `cacheRead / (input + cacheRead + cacheWrite) × 100` of its usage; no rate when the divisor is 0.                          |
| `$<cost><sub>`        | `cost` is not 0, or the model is subscription-paid   | Session total cost with exactly three decimals; `<sub>` is ` (sub)` when the model is subscription-paid, else empty.                                                                    |
| `<context><auto>`     | always                                               | `<percent>%/<window>`, `<percent>` the context usage with one decimal, or `?/<window>` when the host does not know it; `<auto>` is ` (auto)` when auto-compaction is enabled.           |
| `│ <agents><partial>` | the usage tally's `tasks` is at least 1, and it fits | `<agents>` of the usage tally ([agent-tool.md](agent-tool.md), Section 13); `<partial>` is a space followed by `(partial)` while the usage tally is partial (that section), else empty. |

- The session totals sum the host `usage` of every entry of the session file that carries one:
  an assistant message, a tool result message, a `usage` entry, a `compaction` entry, and a
  `branch_summary` entry, on every branch.
- `<window>` is the context window, as a token count, the host reports with the context usage;
  without one, the current model's; without a model, 0.
- The model is subscription-paid when the host model registry reports that the current model
  authenticates through OAuth.
- Auto-compaction is enabled per the effective compaction settings of the session's working
  directory; unknown settings count as enabled.
- `<right>` is `<provider><model><thinking>`: `<model>` is the current model's ID, or `no-model`;
  `<thinking>` is, for a model that supports reasoning, ` • thinking off` at thinking level `off`
  and else ` • <level>`, and empty for any other model; `<provider>` is `(<provider>) ` when the
  host reports more than one available provider and there is a current model, else empty.
- Fit: with `W` the render width, a `<left>` wider than `W` is truncated to it. When
  `<left>`, 2 columns, and `<right>` together exceed `W`, first the `│ <agents><partial>` segment is
  dropped from `<left>` and rendered on the status line instead (Section 2.3); then `<provider>`
  is dropped; then `<right>` is truncated, with no marker, to the columns left after `<left>` and
  2 columns of padding, and omitted when none is left.

### 2.3 Status line

The status line is the statuses of the host's extension status map, in ascending order of their
keys, each with every line break and tab replaced by a space, runs of spaces collapsed to one,
and leading and trailing spaces removed; a status that is then empty is left out. When the stats
line dropped the `│ <agents><partial>` segment, `<agents><partial>` is the first status. The statuses are joined by
`│`. With no status the line is absent.

## 3. Normative references

None.

## 4. Specification gaps

- The host's built-in footer also shows the model a virtual model routed the latest request to,
  and an experimental-features mark; the host exposes neither to an extension, and the footer
  shows neither.
- A later host release that adds a segment to its built-in footer does not add it to this one.
- A provider that is subscription-paid without OAuth is not marked ` (sub)`.
- The colors of the segments are the implementation's.
- Whether a change of the compaction settings during a session reaches `<auto>` before the next
  `session_start` is unspecified.
