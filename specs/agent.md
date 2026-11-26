# Agent definition specification

This document specifies the agent definition resource: the definition file format, discovery,
the agent catalog, and the `agents` configuration override. The dispatch tool itself is owned
by [agent-tool.md](agent-tool.md).

## 1. Definition files {#definition-files}

An agent definition is a top-level `*.md` Markdown file discovered in `agents/` inside each
layer directory ([config-file.md, layers](config-file.md#layers)); it serves static dispatches.
Discovery is flat (subdirectories are not traversed) and reads files in lexicographic filename
order. The agent catalog lists layer definitions in ascending order of `name` by UTF-16 code
unit, whatever their scope; plugin definitions follow per [plugin.md, catalog composition](plugin.md#catalog-composition).
Each entry is shown as `<key> — <description>`, `<key>` being the agent catalog key, with each
run of `\r\n`, `\r`, or `\n` in `description` replaced by one space, or as `<key>` when its
description is absent or empty; entries are joined by `"\n"`. A symlink to a regular file
counts as a file; a dangling symlink is ignored silently. The frontmatter configures the
dispatch; the Markdown body after the frontmatter is the agent's system prompt (`prompt`) and
MUST be non-empty.

| Scope     | Path                                     |
| --------- | ---------------------------------------- |
| `global`  | `agents/` in the global layer directory  |
| `project` | `agents/` in the project layer directory |

| Frontmatter   | Contract                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Required. The agent's name; MUST be non-empty and contain no whitespace, `:`, or `/`.                                                                                               |
| `description` | Optional. A string used as given by the task surfaces; the agent catalog formats it into its entry per the entry rule above. Any other type produces one diagnostic and is ignored. |
| `model`       | Optional. A model string per [model-string.md](model-string.md): a concrete selector or a class reference; any other type produces one diagnostic and is ignored.                   |

- A file whose frontmatter lacks a valid `name`, or whose body is empty after trimming white space, MUST be skipped with
  one diagnostic. A file that cannot be read, or whose frontmatter fails to parse, MUST be skipped with one diagnostic.
- An `agents/` directory that cannot be read MUST produce one diagnostic naming the directory.
- A frontmatter that is not a mapping follows the mapping rule of [skill.md, skill files](skill.md#skill-files).
- Unknown frontmatter keys follow the unknown-key rule ([config-file.md, format](config-file.md#format)).
- Within one scope, a later file declaring a duplicate `name` MUST produce one diagnostic and be
  skipped.
- Layer definitions — those discovered in the layer directories — are referenced by bare `name`; across scopes, a `project` definition
  shadows a `global` definition of the same `name`. The name `dynamic` is reserved for dynamic
  dispatches ([agent-tool.md](agent-tool.md)); a discovered definition with that name MUST produce
  one diagnostic and be skipped.
- Plugin definition files join the agent catalog as `namespace:name`
  ([plugin.md, catalog composition](plugin.md#catalog-composition)); namespaced entries never shadow bare names.
- The agent catalog MUST be built from the boot snapshot.

## 2. The `agents` configuration override {#agents-override}

The `agents` configuration key overrides definitions at boot: it maps an agent catalog key (`name`
or `namespace:name`) to `{ "prompt": string }` (non-empty string), replacing the definition's
prompt (the file body). A `agents` value that is not a non-array object MUST produce one diagnostic and be ignored. An entry naming an unknown agent catalog key or carrying a malformed value
MUST produce one diagnostic and be ignored. An unknown key in an entry follows the unknown-key
rule ([config-file.md, format](config-file.md#format)). The key loads and merges per the
[configuration file specification](config-file.md).

## 3. Specification gaps {#gaps}

None.
