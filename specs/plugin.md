# Plugin specification

This document specifies the plugin resource: the plugin layout, plugin manifest, identity, discovery,
the plugin catalog, and the plugin inventory that another program reads. The resource reader tool is owned by [plugin-tool.md](plugin-tool.md);
the script execution tool is owned by [script-tool.md](script-tool.md).

## 1. Plugin layout

A plugin is a directory containing a root `plugin.json` plugin manifest plus optional resource folders.
The plugin root is the plugin directory, the resolved `path` of its `plugins` entry.

| Path                                   | Contract                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `plugin.json`                          | Required. JSON object; the plugin manifest of Section 2.                                            |
| `context.md`                           | Optional. Plugin context per Section 10; not a resource.                                            |
| `commands/*.md`                        | Optional. Markdown resources, one file per resource, flat (no subdirectory traversal).              |
| `agents/*.md`                          | Optional. Markdown resources, one file per resource, flat (no subdirectory traversal).              |
| `skills/<name>/SKILL.md`               | Optional. Skill layout per [skill.md](skill.md), Section 1.                                         |
| `skills/<name>/references/**/*.md`     | Optional. Skill references per [skill.md](skill.md), Section 1.                                     |
| `scripts/**/*.{js,ts,mjs,mts,cjs,cts}` | Optional. JavaScript or TypeScript sources at any depth under `scripts/` (never part of a catalog). |

The resource folders are `commands/`, `agents/`, and `skills/`. `scripts/` holds plugin scripts,
which are not plugin resources.

- Every other entry MUST be ignored; discovery MUST NOT move, rename, or delete anything in a
  plugin directory.
- `context.md` is not a plugin resource: it enters no catalog, and no tool, `Plugin` included,
  serves it. Only Section 10 reads it.

## 2. Plugin manifest

| Field         | Contract                                                                               |
| ------------- | -------------------------------------------------------------------------------------- |
| `name`        | Required, string. The plugin's namespace: non-empty, no whitespace, `:`, or `/`.       |
| `description` | Optional, string; a non-string value is ignored.                                       |
| `version`     | Optional, string; a non-string value is ignored.                                       |
| `author`      | Optional, string or `{ "name"?: string, "email"?: string }`; other values are ignored. |

- `plugin.json` is parsed as JSON ([RFC 8259]); a comment is a parse failure.
- A plugin manifest that fails to parse, or lacks a valid `name`, MUST cause the plugin to
  be skipped with one diagnostic naming the directory.
- Unknown plugin manifest keys follow the unknown-key rule
  ([config-file.md](config-file.md), Section 2).
- An unknown key inside an `author` object follows the unknown-key rule
  ([config-file.md](config-file.md), Section 2) as well; its diagnostic names the plugin manifest.
- A plugin manifest declares no capabilities: a plugin contributes only the Section 1 resources.

## 3. Identity and namespace

- The namespace is the plugin identity. Paths and display fields never determine identity.
- A namespace MUST be admitted at most once per boot snapshot: a later candidate with an admitted
  namespace MUST be skipped with one diagnostic naming the namespace and both plugin roots.

## 4. Discovery

- Plugins are configured under the `plugins` root key of `pi-dent.conf`, which loads and merges per
  the [configuration file specification](config-file.md). The value of `plugins` is an object
  mapping an entry key to `{ "path": string }` (non-empty string naming a plugin directory on the
  local filesystem).
- Merged `plugins` entries are read in lexicographic key order. A relative `path` resolves
  against the layer directory ([config-file.md](config-file.md), Section 1) of the owning layer
  ([config-file.md](config-file.md), Section 4) of `plugins.<key>.path`; `~` is not expanded, so
  a `path` starting with it is relative.
- A non-object `plugins` value, malformed entry, or resolved `path` that does not exist or is not
  a directory MUST be skipped with one diagnostic; each directory without a valid plugin manifest
  is skipped per Section 2.
- Unknown keys in a `plugins` entry follow the unknown-key rule ([config-file.md](config-file.md), Section 2).
- Discovery MUST NOT follow a `path` outside the local filesystem (no remote or URL sources).
- Plugin admission order is the order of admitted candidates in this key order.

## 5. Slash commands

- A `commands/*.md` file defines one plugin command named by its basename without `.md`.
- Frontmatter carries an optional string `description`; a non-string value is ignored. Unknown
  frontmatter keys follow [config-file.md](config-file.md), Section 2. Non-mapping frontmatter
  follows [skill.md](skill.md), Section 1.
- The command body is the text after the frontmatter ([skill.md](skill.md), Section 1), with the
  leading byte-order mark, the line endings and the trimming of [skill.md](skill.md), Section 2.
- Commands are registered once per boot window from the boot snapshot. A basename that is not a
  valid name (per [agent.md](agent.md), Section 1) is skipped without a diagnostic. A command
  file that cannot be read at boot, or whose frontmatter fails to parse, is still registered,
  without a `description` and without a diagnostic. A command file that cannot be resolved as a
  contained path of the plugin root (Section 7) is skipped without a diagnostic. A `commands/`
  directory that cannot be read MUST produce one diagnostic naming the directory.
- Invocation argument splitting follows [slash-commands.md](slash-commands.md), Section 1.
- The command body is read fresh at invocation and substituted per Section 6. If reading or
  parsing fails, the command MUST show an error notification
  `pi-dent: <namespace>:<command>: <message>` and send no message. Otherwise the substituted body
  MUST be sent as one user message to the current session with the host `deliverAs` option set
  to `"followUp"` ([fleet-tool.md](fleet-tool.md), Section 3.2). The registered description is
  the frontmatter `description` when it is a string; otherwise the host default applies.

> Note (non-normative): naming the delivery is what lets the host queue the message while the agent
> is working; with no delivery named, the host refuses the prompt instead of delivering it.

- The command is reachable only under its `/<namespace>:<command>` spelling; it never shadows
  or collides with a bare host command. Command execution is prompt delivery only; it MUST NOT
  bypass session tool gating.

## 6. Argument substitution

- The argument string—`args` of a `Plugin` call when present, or the argument string defined by
  [slash-commands.md](slash-commands.md), Section 1—is tokenized as maximal runs of non-whitespace
  characters, with no quoting and no escapes.
- Substitution is a single pass over the file text:

| Token        | Expansion                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `$ARGUMENTS` | The full argument string, whatever character follows the token.                                                                             |
| `$N`         | The Nth token, `N` being the longest run of decimal digits after `$` and starting with `1`–`9`; missing indices expand to the empty string. |

- Token positions are 1-based. `$0` and every other `$` sequence stay literal. Token values MUST be
  inserted verbatim: dollar sequences inside them MUST NOT be re-interpreted, and substituted
  text MUST NOT be re-scanned.

## 7. Contained paths

A contained path is relative to a stated root, has no leading `/`, drive prefix, or `..` segment
(with `\` treated as `/`), and resolves inside the root after symbolic links. The root is compared
by its real path. A path whose first missing segment lies inside the root is contained; the caller
reports it as missing. A symbolic link whose target is outside the root, dangling or not, is not
contained. A contained path naming something other than a regular file is not contained.
A path that is not contained MUST be rejected.

## 8. Plugin catalog

- The plugin catalog is the boot-snapshot index of admitted plugins by namespace. Namespace
  changes, admission, and removal take effect only at the next boot; they MUST NOT be observed
  mid-window.
- A `Plugin` or `Script` call naming a namespace not in the plugin catalog MUST fail as a tool
  error naming the namespace and listing the namespaces in the plugin catalog, sorted in
  ascending ASCII order and joined by `", "` (`(none)` when the catalog is empty).
- Resource file contents and plugin scripts are read fresh at call time when accessed through
  Section 5, [plugin-tool.md](plugin-tool.md), or [script-tool.md](script-tool.md); a file reached
  through `Plugin` is read fresh even when `Skill` serves the same file from the boot snapshot;
  cataloged `agents/*.md` and `skills/<name>/SKILL.md` entries follow the boot-snapshot rules of
  [agent.md](agent.md) and [skill.md](skill.md) when used through `Agent` and `Skill`; skill
  references follow [skill-tool.md](skill-tool.md), Section 2.

## 9. Catalog composition

Plugin resources feed the agent and skill catalogs:

| Resource                 | File contract                  | Catalog entry    |
| ------------------------ | ------------------------------ | ---------------- |
| `agents/*.md`            | [agent.md](agent.md) Section 1 | `namespace:name` |
| `skills/<name>/SKILL.md` | [skill.md](skill.md) Section 1 | `namespace:name` |

- Plugin entries join both catalogs from the boot snapshot. Plugin agents and skills follow
  plugin admission order (Section 4), files in lexicographic order within a plugin; skill ordering
  otherwise follows [skill.md](skill.md), Section 1.
- Namespaced entries never shadow bare entries and vice versa; the key spaces are disjoint.
- A duplicate `namespace:name` is skipped as a duplicate `name` is ([agent.md](agent.md), Section 1).
- Skill references are not catalog entries; they load through [skill-tool.md](skill-tool.md).

## 10. Plugin context

A plugin's context is the text of its root `context.md` file, read once into the boot snapshot.

- Only an admitted plugin (Sections 2–4) is read. A candidate that is skipped is not read and
  contributes no context and no diagnostic about `context.md`.
- The file is read as a contained path of the plugin root ([Section 7](#7-contained-paths)).
  The outcome is:

| Condition                                                                                | Plugin context      | Diagnostic           |
| ---------------------------------------------------------------------------------------- | ------------------- | -------------------- |
| `context.md` missing, or a dangling symbolic link whose target is inside the plugin root | none                | none                 |
| Not contained, not a regular file, or unreadable                                         | none                | one, naming the file |
| Bytes not valid UTF-8                                                                    | none                | one, naming the file |
| Empty after normalization (below)                                                        | none                | one, naming the file |
| Otherwise                                                                                | the normalized text | none                 |

- The normalized text is the decoded file with a leading byte-order mark removed, line endings
  normalized to `\n`, and surrounding whitespace trimmed, as [skill.md](skill.md), Section 2
  defines for skill bodies. There is no size limit; the text is used whole.
- The plugin context is never substituted: no argument substitution applies to it.
- Rendering: the plugin contexts of admitted plugins with a plugin context, in plugin admission
  order (Section 4), are rendered as one block each, every block preceded by a blank line (`\n\n`).
  A block is exactly:

  ```
  <plugin_context plugin="<namespace>">
  <text>
  </plugin_context>
  ```

  where `<namespace>` is the plugin's namespace verbatim and `<text>` its plugin context. No other
  text is added.

- Main session: on every turn, the blocks are appended to the system prompt after the
  `<available_skills>` injection when the main session carries one ([skill-tool.md](skill-tool.md),
  Section 1), and whether or not the main session binds `Skill`. With no blocks, the prompt is
  unchanged.
- Child session: the blocks are appended to the child system prompt after the `<available_skills>`
  injection and before the session rules ([agent-tool.md](agent-tool.md), Section 4.2). This holds for a
  `resume` dispatch too ([agent-tool.md](agent-tool.md), Section 9).
- A plugin context changes no tool surface and no `noContextFiles` setting: a child still receives
  no context file of its own.
- A diagnostic of this section is reported per [config-file.md](config-file.md), Section 6, as a
  plugin discovery diagnostic.

## 11. Plugin inventory

A plugin candidate is one entry of the merged `plugins` object (Section 4), named by its entry
key; discovery admits it as a plugin or skips it. The plugin inventory is the result of running
the rules of Sections 1–10 for one working directory at the moment of a call: the layers, every
plugin candidate with what it contributes or why it was skipped, and the diagnostics. It exists
for a program other than the extension, such as a user interface that lists the plugins; nothing
in the extension's own boot reads it.

- The file `lib/plugin-inventory.ts` of the package MUST export the function
  `readPluginInventory(cwd)`, which takes one string and returns the plugin inventory of
  Section 11.1 as its value, not as a promise.
- `cwd` is the `<cwd>` of [config-file.md](config-file.md), Section 1, and the expansion of
  `${project.root}` ([config-file.md](config-file.md), Section 7); `env.<NAME>` reads the
  environment of the calling process at the call. The function MUST throw an `Error` with the
  message `readPluginInventory: cwd must be an absolute path` when `cwd` is not a string naming
  an absolute path, and MUST throw in no other case: every other failure is a diagnostic of the
  inventory.
- Every call MUST read the layers and the plugin directories anew. It MUST NOT read, create, or
  change a boot snapshot ([config-file.md](config-file.md), Section 5), and MUST NOT report a
  diagnostic through the host ([config-file.md](config-file.md), Section 6): its diagnostics
  are returned and nowhere else.
- A call MUST change nothing on disk, MUST register nothing with the host, and MUST NOT import
  or run a plugin's file.
- The inventory is a second view of the same rules, not a second set of rules. For one state of
  the file system and the environment, the admitted plugins, their order, namespaces, plugin
  roots, registered commands with their descriptions, plugin contexts, and agent and skill
  catalog entries MUST be those a boot with the same `<cwd>` holds. Every diagnostic of that
  boot that Section 11.1 assigns to the inventory or to a candidate MUST be in the inventory
  exactly once, with the same message, and the inventory MUST hold no other diagnostic except
  those of Section 11.2. The boot's diagnostics, their messages and their
  order MUST NOT change because the inventory exists.
- Strings are returned whole: the inventory cuts nothing.

### 11.1 Shape

The plugin inventory is an object:

| Field         | Type             | Value                                                                                                                                   |
| ------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`         | string           | The `cwd` argument, verbatim.                                                                                                           |
| `layers`      | array of layers  | The `global` layer, then the `project` layer, both always present.                                                                      |
| `diagnostics` | array of strings | The messages of the diagnostics that belong to no candidate, in production order.                                                       |
| `candidates`  | array            | One candidate per entry of the merged `plugins` object, in the key order of Section 4; empty when `plugins` is absent or not an object. |

A layer is an object:

| Field   | Type   | Value                                                                                                                                                                                |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `layer` | string | `global` or `project`.                                                                                                                                                               |
| `file`  | string | The absolute path of the layer's `pi-dent.conf` ([config-file.md](config-file.md), Section 1).                                                                                       |
| `state` | string | `missing` when the file is missing and contributes no layer; `dropped` when the layer was dropped with a diagnostic ([config-file.md](config-file.md), Section 2); `read` otherwise. |

A candidate is an object:

| Field         | Type             | Value                                                                                                                                                                    |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key`         | string           | The entry key.                                                                                                                                                           |
| `layer`       | string           | `global` or `project`: the layer whose file [config-file.md](config-file.md), Section 4 names for `plugins.<key>.path`, the owning layer when one declares it.           |
| `configFile`  | string           | The `file` of that layer.                                                                                                                                                |
| `root`        | string or `null` | The absolute path the entry's `path` resolves to per Section 4, whether or not a directory is there; `null` when the entry is malformed or names a remote or URL source. |
| `plugin`      | object or `null` | The admitted plugin, per the next table; `null` when the candidate was skipped.                                                                                          |
| `skip`        | string or `null` | `null` when admitted; otherwise the message of the diagnostic that skipped the candidate (Sections 2–4), which is also the last of `diagnostics`.                        |
| `diagnostics` | array of strings | The messages of the diagnostics that belong to this candidate, in the order below.                                                                                       |

An admitted plugin is an object:

| Field         | Type                     | Value                                                                                                                                                                                                            |
| ------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`   | string                   | The namespace (Section 3).                                                                                                                                                                                       |
| `description` | string or `null`         | The plugin manifest's `description` when it is a string (Section 2); `null` otherwise.                                                                                                                           |
| `version`     | string or `null`         | The plugin manifest's `version` when it is a string; `null` otherwise.                                                                                                                                           |
| `author`      | string, object or `null` | The plugin manifest's `author` when it is a string. When it is an object, an object with exactly `name` and `email`, each that key's value when it is a string and `null` otherwise. `null` in every other case. |
| `context`     | boolean                  | `true` when the plugin has a plugin context (Section 10).                                                                                                                                                        |
| `commands`    | array of resources       | The commands Section 5 registers, in lexicographic order of file name. `name` is the command's name, `file` is `commands/<name>.md`.                                                                             |
| `agents`      | array of resources       | The plugin's entries of the agent catalog (Section 9), in catalog order. `name` is the definition's `name` without the namespace, `file` is `agents/<file name>`.                                                |
| `skills`      | array of resources       | The plugin's entries of the skill catalog (Section 9), in catalog order. `name` is the skill's `name` without the namespace, `file` is `skills/<name>/SKILL.md`.                                                 |
| `scripts`     | array of resources       | The plugin scripts Section 11.2 lists. `name` equals `file`; `description` is `null`.                                                                                                                            |

A resource is an object:

| Field         | Type             | Value                                                                                                                                            |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`        | string           | Per the table above.                                                                                                                             |
| `description` | string or `null` | The description the command is registered with, or the catalog entry's description, verbatim; `null` when there is none.                         |
| `file`        | string           | The path relative to the plugin root of the file the resource was found at in its folder, its segments joined by `/`, no symbolic link resolved. |

- A diagnostic belongs to a candidate when Sections 2–5, 9 or 10 produce it about that
  candidate's `plugins` entry, its directory, its plugin manifest, its `commands/`, `agents/` or
  `skills/` folder or a file in one, or its `context.md`. A candidate's `diagnostics` holds, in
  this order: those of discovery (Sections 2–5 and 10), in the order discovery produces them;
  those of catalog composition (Section 9), in the order composition produces them; those of
  Section 11.2.
- The inventory's `diagnostics` holds the diagnostics of reading each layer
  ([config-file.md](config-file.md), Sections 2 and 7: a failed read or parse, a root that is no
  object, unknown root keys, a failed substitution), then the diagnostic of a `plugins` value
  that is not an object (Section 4). It holds no diagnostic about another root key's value, about
  the layer directories' own agents and skills, about the `agents` override, or about an
  environment value.
- A message is the diagnostic's message without the `pi-dent: ` of its host report
  ([config-file.md](config-file.md), Section 6).
- When both layers have the same `file`, as when `cwd` is the user's home directory, `layer` is
  `project`.

### 11.2 Script listing

No catalog holds plugin scripts, and the `Script` tool lists none: it resolves the one path a
call names ([script-tool.md](script-tool.md), Section 2). The plugin inventory lists them, and
only it does.

- For an admitted plugin, `scripts` MUST hold exactly the files found by walking `scripts/` under the plugin root whose
  path relative to the plugin root matches the plugin script path pattern of Section 1 and is a
  contained path of the plugin root (Section 7), in lexicographic order of `file`. A test file
  or any other file the pattern matches is listed like any other.
- The walk MUST NOT read a directory named `node_modules` and MUST NOT follow a symbolic link to
  a directory. When it leaves out `<n>` such directories, the candidate's `diagnostics` MUST end
  with `scripts: <root>/scripts: <n> directories not listed (node_modules and links)`, `<root>`
  being the plugin root, with `1 directory` when `<n>` is 1. A symbolic link to a file is judged
  by the contained-path rule like any file, and one that is not contained is left out without a
  diagnostic. The walk starts at `scripts/` wherever that resolves, so a `scripts` that is a
  symbolic link to a directory is walked, and the rule against following a symbolic link to a
  directory applies to the entries inside it.
- A directory of the walk whose entries cannot be read MUST add
  `scripts: <dir>: unreadable: <reason>` to the candidate's `diagnostics`, before the line above,
  `<dir>` being its absolute path and `<reason>` the failure's error code, or its message when it
  has no code; the walk continues with the rest. A missing `scripts/`, or one that is not a
  directory, adds nothing.
- A file the listing holds is one a `Script` call naming it would accept at that moment
  ([script-tool.md](script-tool.md), Section 2); the reverse does not hold for a file the walk
  left out. A dangling symbolic link, and an entry whose name contains `\`, which a `Script`
  call resolves as a `/` and therefore as a different file, are left out without a diagnostic.

> Note (non-normative): the two exclusions keep the walk bounded and free of cycles. A script
> under them still runs through `Script`; it is only not listed, and the diagnostic says so.

## 12. Normative references

- [RFC 8259] The JavaScript Object Notation (JSON) Data Interchange Format (STD 90),
  T. Bray, Ed., 2017: the `plugin.json` syntax of Sections 1 and 2.

## 13. Specification gaps

- A plugin command whose frontmatter fails to parse is registered without a description and
  without a diagnostic (Section 5), so the plugin inventory cannot tell it from a command that
  declares no description.
- Whether `readPluginInventory` yields to the event loop is not specified: it returns its value
  directly, so a caller that must stay responsive runs it off its main thread.
- A plugin named `skill` registers `/skill:<command>`, which the host runs before it expands
  `/skill:<name>` for a skill of the skill catalog; the shadowing of the host's skill command is
  not specified.
- A plugin command invoked while the session's compaction is in progress: the host refuses the
  prompt whatever the delivery, and reports the refusal as its own extension error rather than the
  notification of Section 5.
