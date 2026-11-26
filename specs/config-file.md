# Configuration file specification

This document specifies the layered configuration file: which files are read, in what order,
how they merge, and how failures behave.

## 1. Layers {#layers}

`<cwd>` is the process working directory at the time of the boot read; the resulting snapshot
is shared by every consumer in the boot window regardless of a consumer's own working directory.
The global layer directory is `~/.pi/pi-dent/`; the project layer directory is `<cwd>/.pi/pi-dent/`.
Each layer's `pi-dent.conf` lies directly in its layer directory. Configuration is read from at
most two layers, in merge order:

| Order        | Layer     | Path                             |
| ------------ | --------- | -------------------------------- |
| 1 (base)     | `global`  | `~/.pi/pi-dent/pi-dent.conf`     |
| 2 (priority) | `project` | `<cwd>/.pi/pi-dent/pi-dent.conf` |

A missing file contributes no layer, silently. One layer alone stands as the whole configuration.
pi-dent ignores project trust and trusts the workspace: it reads the project layer whether or not
the host marks the project as trusted.

## 2. Format {#format}

Each layer is a JSONC document ([JSONC]): JSON ([RFC 8259]) with comments and trailing commas. Its root MUST be an
object. A layer whose parse fails or whose root is not an object MUST produce one diagnostic and
be dropped; the remaining layer MUST still provide its values. A file-read failure other than a
missing file MUST produce one diagnostic and the layer dropped.

The unknown-key rule covers the keys of an object this folder's specifications define and read
from configuration, frontmatter, and plugin manifests; it does not cover the messages of
external protocols (billing.md states its own rule for a billing reply). An object with unknown
keys MUST produce exactly one diagnostic naming the object, all of its unknown keys, and, for
each key, the file of its owning layer ([attribution](#attribution)); those keys are ignored while the rest of the
object loads. For an object other than a layer's root, its text is
`<file>: <object>: unknown keys <key>, <key> ignored` when one file owns every key, else
`<object>: unknown keys <key> (<file>), <key> (<file>) ignored`. For the root keys of a layer,
the diagnostic also names the file and the supported set.

| Root key        | Contributing spec                                                         |
| --------------- | ------------------------------------------------------------------------- |
| `modelClasses`  | [model-string.md, model classes](model-string.md#model-classes)           |
| `agentLiveness` | [agent-tool.md, child session](agent-tool.md#child-session)               |
| `agents`        | [agent.md, the `agents` configuration override](agent.md#agents-override) |
| `plugins`       | [plugin.md, discovery](plugin.md#discovery)                               |
| `modelGuidance` | [model-guidance.md, configuration](model-guidance.md#configuration)       |
| `taskBrowser`   | [task-browser.md, configuration](task-browser.md#configuration)           |
| `footer`        | [footer.md, configuration](footer.md#configuration)                       |
| `recapModel`    | This section                                                              |
| `script`        | [script-tool.md, configuration](script-tool.md#configuration)             |
| `terms`         | pi-dent-terms `specs/terms-tool.md`, Section 4.2                          |
| `web`           | pi-dent-web-fetch `specs/web-fetch.md`, Section 8                         |
| `webSearch`     | pi-dent-web-search `specs/web-search.md`, Section 7                       |

The root keys `terms`, `web` and `webSearch` are owned by the sibling packages `pi-dent-terms`,
`pi-dent-web-fetch` and `pi-dent-web-search`.
pi-dent MUST accept each as a root key, MUST NOT validate its value or the keys within it, and MUST
NOT report an unknown key within it. Substitution ([value substitution](#value-substitution)) applies to their string values like
any value. Merge ([merge](#merge)) and attribution ([attribution](#attribution)) apply to them like any root key.

`recapModel` optionally selects the model for `/recap` ([slash-commands.md, `recap`](slash-commands.md#recap)). When present it MUST be a model string satisfying [model-string.md, grammar](model-string.md#grammar), [model-string.md, components](model-string.md#components); surrounding whitespace MUST be trimmed. An invalid value MUST produce one boot
diagnostic naming `recapModel` and its owning file ([attribution](#attribution)), and MUST be ignored. Inventory,
class and authentication checks occur on invocation, with fallback per [slash-commands.md, input and model](slash-commands.md#input), not boot diagnostics.

## 3. Merge {#merge}

Layers merge before any consumer validation or defaulting, on raw parsed values:

- Plain objects merge deeply and recursively, key by key.
- Arrays and every other value from the higher-priority layer replace the lower layer's value.
- A key present only in the lower layer is retained unchanged.

The project layer wins every conflict; the global layer supplies only what the project layer
does not declare.

## 4. Attribution {#attribution}

For any configuration key, the owning layer is the highest-priority layer that declares that
key as an own property (its path in the layer's root object). Diagnostics for a key MUST name
the owning layer's file path; when no layer declares the key, diagnostics MUST name the
highest-priority existing layer (or `<cwd>/.pi/pi-dent/pi-dent.conf` when neither file exists).

## 5. Snapshot {#snapshot}

The merged configuration is part of the boot snapshot (alongside the agent catalog, skill
catalog, and plugin catalog). A boot — process start or reload — reads the layers once, and
every consumer inside that boot window reuses the read: the first reader performs the read;
later readers share its result silently. The next boot or reload starts a new window and
re-reads the files. Every boot window reads the layers from disk; there is no retained byte
snapshot.

All consumers inside one window observe the identical configuration image, even when the files
change mid-window. Configuration changes take effect only at the next boot — a restart or
reload — never mid-window, and change between windows is neither detected nor reported. A
window is bounded by boots, not sessions: one session can cross several windows through reload,
and one window can serve many sessions. Replacing the session through the host's `new`, `resume`,
or `fork` opens no window, though it starts a new extension instance
([billing.md, extension instance and held billing](billing.md#held-billing)).

The plugin inventory ([plugin.md, plugin inventory](plugin.md#plugin-inventory)) is no consumer of the snapshot: each
call reads the layers anew, and neither reads nor changes a window's image.

## 6. Diagnostics {#diagnostics}

A diagnostic is one message with level `warning`. Reading the boot snapshot collects
diagnostics from configuration, model classes, model guidance, agent and skill discovery,
plugin discovery, catalog composition, and environment values. The extension MUST report each
diagnostic once per boot window, on `session_start`, through the host `notify` API as
`pi-dent: <message>`. The host `notify` API takes the levels `info`, `warning`, and `error`; a
session without a UI shows none. A diagnostic never fails the boot. The diagnostics of a plugin
inventory are returned to its caller per [plugin.md, plugin inventory](plugin.md#plugin-inventory), and are not
reported here.

## 7. Value substitution {#value-substitution}

String values in a layer can contain placeholders of the form `${token}`. The token set is:

| Token          | Expansion                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `env.<NAME>`   | The value of the environment variable `NAME`.                                                                          |
| `project.root` | The process working directory at the boot read — the same `<cwd>` that resolves the project layer ([layers](#layers)). |

- Substitution runs at layer read time, before validation and merging; substituted values are
  part of the boot snapshot, so later environment or working-directory changes do not
  propagate mid-window.
- Substitution applies to string values only; object keys are never substituted.
- `$$` renders a literal `$` (so `$${env.X}` writes `${env.X}` verbatim); `$$` is the only
  escape.
- `<NAME>` matches `^[A-Za-z_][A-Za-z0-9_]*$`. A `${` with no later `}` is an invalid form. A `$` followed by neither `$` nor `{` is a literal `$`.
- A reference to an undefined environment variable or any other invalid `${...}` form MUST
  produce one diagnostic; the containing value is absent from its layer (an object property is
  absent, an array element removed, merge falls through to lower layers) and MUST NOT expand to
  an empty string.
- A substitution diagnostic MUST name the path of the value in the layer's root object — dotted
  keys, array indices in brackets — and the file path of the layer whose value failed.

## 8. Normative references {#references}

- [JSONC] JSON with Comments (<https://jsonc.org/>): the document syntax of a layer.
- [RFC 8259] The JavaScript Object Notation (JSON) Data Interchange Format (STD 90),
  T. Bray, Ed., 2017.

## 9. Specification gaps {#gaps}

- Configuration-key diagnostic wording is open: any wording that names the file path selected by
  [attribution](#attribution) and the affected key is allowed.
