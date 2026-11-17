# Tool card specification

This document specifies the tool card: what the host's conversation view shows for one call of the
`Bash` tool ([bash-tool.md](bash-tool.md)) or the `Script` tool
([script-tool.md](script-tool.md)).

## 1. Shell

`Bash` and `Script` MUST be registered without `renderShell`, so that the host draws each call in
its default shell: one box per call, holding the call section (Section 2) and, once the call has a
result, the result section (Section 3), with the host's background for a pending, a successful,
and a failed call, and the host's horizontal padding. The components the two tools return from
`renderCall` and `renderResult` MUST carry no horizontal padding and no background of their own.

The text, colours, and emphasis of Sections 2 and 3 are normative. Path substitution in Sections 2
and 3 follows [agent-tool.md](agent-tool.md), Section 4.2. ANSI escape sequences and control
characters other than line feeds and tabs MUST be removed from the `description` argument, the
source, and the result text before they are rendered.

## 2. Call section

The call section is a title line followed by the source lines.

The title line is `<tool>`, then ` <description>` when `description` is present, then
` (background)` when `background` is `true`. `<tool>` is `Bash` or `Script`. `<description>` is
the first line of the `description` argument with its surrounding white space removed; a
`description` the owning tool spec treats as absent, or whose first line is empty after that
removal, is not present.

The source is:

| Call                    | Source                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Bash`                  | `$ ` followed by the `command` text                                                                             |
| `Script` (plugin shape) | `<plugin>:<path>` when [script-tool.md](script-tool.md), Section 1 treats neither `plugin` nor `path` as absent |
| `Script` (otherwise)    | the `code` text                                                                                                 |

The source lines are the source split at line feeds, after its trailing white space is removed.
A collapsed card MUST show the first 5 source lines; when the source has more, the line
`... (<n> more lines)` follows them, `<n>` being the count of source lines not shown. An expanded
card MUST show every source line.

While the host is still receiving the call's arguments, an argument that is absent or not a
string is treated as an empty string; a source that is then empty has no source lines, and
`renderCall` MUST NOT throw.

The title line is drawn in the host theme colour `toolTitle`, bold. Every source line, including the
`... (<n> more lines)` line, is drawn in `toolOutput`.

## 3. Result section

The result text is the text of the result's first content item when that item is a text item,
else empty, with its trailing white space removed. A partial result of a running foreground call
is shown by the same rules as the final one.

- An empty result text has no result section.
- The result lines are the result text split at line feeds. A collapsed card MUST show the last
  10 result lines; when the result has more, they are preceded by the line
  `... (<n> earlier lines, <hint>)`, `<n>` being the count of result lines not shown and `<hint>`
  the host's key hint for its tool-expansion keybinding with the description `to expand`.
- An expanded card MUST show every result line.
- The result lines are drawn in `toolOutput`. The text `... (<n> earlier lines,` and its closing `)`
  are drawn in `muted`, with `<hint>` between them; the card does not recolour `<hint>`.
- The result section is separated from the call section by one blank line.

## 4. Specification gaps

- Whether a card is collapsed or expanded, and what toggles it, is the host's.
- The rendering of a card in the host's HTML export is the host's.
- Wrapping of a line wider than the terminal is the host's.
