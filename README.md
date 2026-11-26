# pi-dent

A generic coding agent, built as a [pi](https://pi.dev) extension. It adds the tools an agent needs
to do long, multi-step work without losing track: background tasks, child agents, coordination
between sessions, search over past sessions, and scripted tool calls.

Requires pi 1.5.2 or later and Node 26.

## Why

A plain coding agent does everything in one context window, one tool call at a time. Long work
fills the window, a slow command blocks the user, and a second session cannot see the first.
pi-dent addresses each:

- **Work runs beside the conversation.** A long command, script or child agent runs in the
  background. A completion notification arrives when it settles, so the agent's context holds only
  the result.
- **Delegation keeps context small.** A child agent works in its own context and returns only its
  final answer.
- **Sessions coordinate.** Sessions on one machine can find and message each other instead of
  colliding in shared files.
- **Nothing is lost.** Past sessions stay searchable, so an agent can look up what was said or run
  instead of redoing it.

Every behaviour is specified first, under [specs/](specs/AGENTS.md); the specs are the source of
truth, and this README only summarises them.

## How it works

| Tool                         | What it does                                                                                                                                              | Spec                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Bash`, `Script`             | Run a shell command, or JavaScript/TypeScript that can call other tools, in the foreground or as a background task. `Bash` replaces pi's built-in `bash`. | [bash-tool.md](specs/bash-tool.md), [script-tool.md](specs/script-tool.md)                             |
| `Agent`                      | Dispatch a child session with its own context, tool subset and model, from an agent definition or an inline prompt; `resume` continues it.                | [agent-tool.md](specs/agent-tool.md)                                                                   |
| `Task`                       | List, read, wait for or kill background tasks. The task browser (`shift+right`) shows the task tree.                                                      | [task.md](specs/task.md), [task-tool.md](specs/task-tool.md)                                           |
| `Fleet`, `Schedule`          | List the sessions on this machine and send or query across them; schedule a message to this session later.                                                | [fleet-tool.md](specs/fleet-tool.md), [schedule-tool.md](specs/schedule-tool.md)                       |
| `Search`                     | Find and read earlier messages, tool calls and results across session trees, through a SQLite index of the session files.                                 | [search-tool.md](specs/search-tool.md)                                                                 |
| `Markdown`                   | Outline, read and restructure Markdown files by their headings.                                                                                           | pi-dent-markdown                                                                                       |
| `Skill`, `Plugin`            | Load a skill's instructions; read a plugin's commands, agent definitions and skills.                                                                      | [skill.md](specs/skill.md), [plugin.md](specs/plugin.md)                                               |
| `Session`, `AskUserQuestion` | Report the session's identity and the models it may dispatch; ask the user multiple-choice questions.                                                     | [session-tool.md](specs/session-tool.md), [ask-user-question-tool.md](specs/ask-user-question-tool.md) |

Slash commands: `/tasks`, `/fleet`, `/recap` and `/dent` ([slash-commands.md](specs/slash-commands.md)).

The package also bundles these extensions, each loaded as its own extension
([specs/package.md](specs/package.md)):

- `pi-dent-purse` (billing);
- `pi-dent-terms` (the `Terms` tool);
- `pi-dent-web-fetch` (`WebFetch`);
- `pi-dent-web-search` (`WebSearch`);
- `pi-mcp-adapter`;
- `pi-anthropic-oauth`.

How the terms relate is mapped in [docs/concepts.md](docs/concepts.md).

## Install

```sh
pi install npm:pi-dent-agent   # add it to pi's packages
pi -e npm:pi-dent-agent        # or try it for one run
```

The bundled extensions come with the package, so they must not also be listed in pi's `packages`.
A second copy loads twice and its tools collide.

To develop pi-dent itself:

1. Run `pnpm install` in this repository.
2. List the checkout in `~/.pi/agent/settings.json`: `{ "packages": ["../../src/pi-dent-agent"] }`.
   User-scope paths resolve against `~/.pi/agent`.
3. Run `pi -ne -e ./` to load only this repository's extensions
   ([docs/development.md](docs/development.md)).

## Configure

`pi-dent.conf` is JSONC, read from two layers that merge deeply. The project layer wins every
conflict:

| Layer   | Path                             |
| ------- | -------------------------------- |
| global  | `~/.pi/pi-dent/pi-dent.conf`     |
| project | `<cwd>/.pi/pi-dent/pi-dent.conf` |

```jsonc
{
  "modelClasses": { "fast": "deepseek/deepseek-flash" },
  "plugins": { "dev": { "path": "/absolute/path/to/a/plugin" } },
}
```

- **When it's read:** at start and on `/reload`.
- **Problems:** a bad value produces one `pi-dent: …` notification and is ignored.
- **Reference:** [docs/pi-dent-conf.md](docs/pi-dent-conf.md) is an annotated sample with every root
  key, and [specs/config-file.md](specs/config-file.md) owns the format.

## Documentation

- [specs/](specs/AGENTS.md): the behaviour of every tool and setting.
- [docs/](docs/development.md): how extensions load, search internals, the Script sandbox research.

## License

MIT
