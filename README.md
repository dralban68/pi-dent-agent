# pi-dent

A generic coding agent, built as a pi extension: it registers the `Bash`, `Task`, `Agent`, `Fleet`,
`Script`, `Plugin`, `Skill`, `Session`, `Schedule`, `Search`, `Markdown`, and `AskUserQuestion` tools and the `tasks`, `fleet`, and `dent`
slash commands, replaces the host's built-in `bash` tool, and adds the task browser.
Specifications live in [specs/](specs/AGENTS.md); the formal
source of truth for every behavior.

Requires pi 1.5.2 or later and Node 26.

## Configure pi

Install the package from npm:

```sh
pi install npm:pi-dent-agent   # add it to pi's packages
pi -e npm:pi-dent-agent        # or try it for one run
```

For development, install its dependencies once (needs pnpm), then list the checkout in pi's settings:

```sh
pnpm install   # in this repository
```

`~/.pi/agent/settings.json`:

```json
{
  "packages": ["../../src/pi-dent-agent"]
}
```

Paths in a user-scope `packages` list resolve against `~/.pi/agent`, so `../../src/pi-dent-agent` is
`~/src/pi-dent-agent`; entries in a project's `.pi/settings.json` resolve against that `.pi` directory.
`pi install <source>` and `pi remove <source>` write this list for you; `pi list` shows it, and
`pi config` enables or disables the resources a package declares.

Listing the package is the whole installation. It loads pi-dent and its bundled extensions, each
as its own extension: `pi-dent-purse` (the billing service), `pi-dent-terms` (the `Terms` tool),
`pi-mcp-adapter`, `pi-anthropic-oauth`, and `pi-web-access`, per
[specs/package.md](specs/package.md). Those extensions come from this package, so they must not
also appear in `packages` — a second copy loads twice and its tools collide. Update them with
`pnpm update` in this repository; `pi update` covers pi packages, not bundled dependencies.

Settings, packages, and configuration are read at boot: restart pi, or run `/reload`, after
changing any of them.

For development inside this repository, `pi -ne -e ./` loads only what `package.json` →
`pi.extensions` lists ([docs/development.md](docs/development.md)).

## Configure pi-dent in pi

`pi-dent.conf` is a JSONC file read from at most two layers, the global one and the project one in
pi's working directory:

| Order        | Layer     | Path                             |
| ------------ | --------- | -------------------------------- |
| 1 (base)     | `global`  | `~/.pi/pi-dent/pi-dent.conf`     |
| 2 (priority) | `project` | `<cwd>/.pi/pi-dent/pi-dent.conf` |

Both layers merge deeply and the project layer wins every conflict, so machine-wide models and
guidance go in the global file and repository-specific agents, plugins, and tooling go in the
project one. A missing file contributes nothing, silently. A complete annotated sample with
every root key is in [docs/pi-dent-conf.md](docs/pi-dent-conf.md).

The root keys:

| Key             | Purpose                                                                | Spec                                         |
| --------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| `modelClasses`  | Named classes usable inside any model string, e.g. `"fast:low"`        | [model-string.md](specs/model-string.md)     |
| `modelGuidance` | Which model to use when (the `Agent` description), plus guidance rules | [model-guidance.md](specs/model-guidance.md) |
| `agentLiveness` | `idleTimeoutMs` and `absoluteTimeoutMs` bounding child dispatches      | [agent-tool.md](specs/agent-tool.md)         |
| `agents`        | Prompt overrides for entries of the agent catalog                      | [agent.md](specs/agent.md)                   |
| `plugins`       | Plugin directories by entry key; the namespace is the manifest `name`  | [plugin.md](specs/plugin.md)                 |
| `taskBrowser`   | `shortcut`, the task browser key, default `shift+right`                | [task-browser.md](specs/task-browser.md)     |

`~/.pi/pi-dent/pi-dent.conf`:

```jsonc
{
  // Classes usable in any model string: "fast", "fast:high", ...
  "modelClasses": {
    "fast": "deepseek/deepseek-flash",
    "review": "tl/claude-opus-5-5:high",
  },
  "modelGuidance": {
    "models": {
      "deepseek/deepseek-flash": { "when": "implementation" },
    },
    "rules": [{ "match": "flash", "rule": "verify its output before relying on it" }],
  },
  "agentLiveness": { "idleTimeoutMs": 600000, "absoluteTimeoutMs": 3600000 },
}
```

A `modelGuidance.models` key is a concrete `provider/model-id`, never a class name. Its `when`
texts form the model catalog in the `Agent` tool description; the guidance message carries only
the billing annotations of the guided models, and the rules of matching sessions.

`<repo>/.pi/pi-dent/pi-dent.conf` adds what only that repository needs; `plugins` paths resolve
against the layer directory, so this one is `<repo>/.pi/pi-dent/tools/site`, and `agents` keys must
name entries of the agent catalog:

```jsonc
{
  "agents": { "reviewer": { "prompt": "Review the change and report only real defects." } },
  "plugins": { "site": { "path": "./tools/site" } },
  "taskBrowser": { "shortcut": "ctrl+t" },
}
```

String values may use `${env.NAME}` for an environment variable and `${project.root}` for pi's
working directory; `$$` writes a literal `$`. An undefined variable is a diagnostic, never an
empty string.

An unknown root key, an unreadable file, or a malformed value produces one `pi-dent: …`
notification at start and is ignored; the rest of the configuration still applies. Configuration
changes take effect at the next boot or `/reload`, never mid-window.

A layer directory also holds its `agents/` and `skills/` folders: `~/.pi/pi-dent/agents/`,
`<repo>/.pi/pi-dent/skills/<name>/SKILL.md`, and so on. Agent definitions, skills, plugins, and
every configuration field are specified under [specs/](specs/AGENTS.md).
