# Development: extensions and widgets

How UI extensions load and get built in this repo. Reference pi docs live under
`~/.pi/agent/install/releases/<ver>/node_modules/@earendil-works/pi-coding-agent/docs/`
(`extensions.md`, `tui.md`).

## How extensions load

pi is launched as `pi -ne -e ./`:

- `-ne` (`--no-extensions`) disables all discovery — `~/.pi/agent/extensions/`
  and project-local `.pi/extensions/` are **not** scanned automatically.
- `-e ./` loads extensions listed in `package.json` → `pi.extensions`. Every
  extension, including files under `.pi/extensions/`, must be listed there
  explicitly, and so must every bundled extension ([specs/package.md](../specs/package.md)).

To add an extension: create the file, add its path to `pi.extensions`, restart
pi. Verify with `pnpm typecheck`.

## UI surfaces (via `ctx.ui`)

| Surface                  | Call                                                 | Placement                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sticky widget            | `setWidget(id, string[] \| undefined)`               | Above the editor — renders **above the working row**; pass `undefined` to clear                                                                                         |
| Widget, custom placement | `setWidget(id, lines, { placement: "belowEditor" })` | Below the editor                                                                                                                                                        |
| Overlay screen           | `custom(factory, { overlay: true, overlayOptions })` | Fullscreen/anchored overlay; factory `(tui, theme, keybindings, done)` returns a pi-tui component; `done()` closes                                                      |
| Command                  | `pi.registerCommand(name, { description, handler })` | Shows in `/` command list                                                                                                                                               |
| Notification             | `notify(message, "info" \| "warning" \| "error")`    | Toast above editor                                                                                                                                                      |
| Footer status            | `setStatus(id, text)`                                | Bottom-most footer line, below the model line — avoid; use a widget instead, except the schedule status line ([schedule-tool.md](../specs/schedule-tool.md), Section 6) |

Component contract (pi-tui): `render(width): string[]` (cache by width),
`invalidate()` (drop cache), `handleInput(data)` (consume keys), optional
`Focusable`. Live UI = `setInterval` → mutate state → `invalidate()` +
`tui.requestRender()`; clear the interval before `done()`. Guard all of the
above with `ctx.hasUI` and `ctx.mode === "tui"`.

## Reference example

A live tree of background/nested agents (one file demonstrating every surface
above) is a good template: scan `<session>.agents/` for session files, show a
sticky widget while agents run, add a `/`-command overlay browser, and start /
clear on `session_start` / `session_shutdown`.

## Conventions

- TypeScript ESM, same imports as the host: `@earendil-works/pi-coding-agent`
  for types/API, `@earendil-works/pi-tui` for components (`truncateToWidth`,
  `matchesKey`, ...).
- One concern per extension file; keep dev tooling under `.pi/extensions/` and
  out of `lib/` unless it is spec'd pi-dent behavior (spec change first).
