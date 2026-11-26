# Skill specification

This document specifies the skill resource: the skill file format, discovery, the skill
catalog, and content rules. The load tool and prompt injection are owned by
[skill-tool.md](skill-tool.md).

## 1. Skill files {#skill-files}

A skill is a directory `<name>/` containing `SKILL.md`, with an optional `references/` folder.
Discovery reads each immediate subdirectory `<name>/` that contains `SKILL.md`, in lexicographic
order of `<name>`; a subdirectory without `SKILL.md` is not a skill. A symlink to a directory
counts as a directory; a dangling symlink is ignored silently. The frontmatter configures the
skill catalog entry; the Markdown body after the frontmatter is the skill body and MUST be
non-empty.

| Scope     | Path                                     |
| --------- | ---------------------------------------- |
| `global`  | `skills/` in the global layer directory  |
| `project` | `skills/` in the project layer directory |

Plugin skills are the `skills/` folder of each plugin root ([plugin.md](plugin.md), Section 1).

| Frontmatter   | Contract                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Required. The skill's name; MUST equal the directory name `<name>`, be non-empty, and contain no whitespace, `:`, or `/`.                                                                                                       |
| `description` | Required. A non-empty string (whitespace-only and multi-line values are accepted), the only selection surface in the skill catalog: the catalog injection renders it on one line per [skill-tool.md](skill-tool.md), Section 1. |

- Frontmatter is a YAML block opened by a first line `---` and closed by the next line `---`; a
  file without one has empty frontmatter. The frontmatter of a skill, agent definition
  ([agent.md](agent.md), Section 1), and plugin command ([plugin.md](plugin.md), Section 5)
  MUST be a mapping; one that is not MUST produce one diagnostic naming the file and MUST be
  read as empty. Parse failure MUST produce one diagnostic naming the file and skip a skill.
- A `SKILL.md` that cannot be read MUST be skipped with one diagnostic naming the file. A skill
  whose frontmatter lacks valid `name` or `description`, whose `name` differs from `<name>`, or
  whose body is empty MUST be skipped with one diagnostic. A skills directory that cannot be read
  MUST produce one diagnostic naming the directory.
- Unknown frontmatter keys follow the unknown-key rule ([config-file.md](config-file.md),
  Section 2).
- Skill references are `.md` files under `<name>/references/`, at any depth; a skill can have
  none ([skill-tool.md](skill-tool.md), Section 2).
- The skill catalog lists layer skills in lexicographic order of `<name>`, whatever their layer;
  a `project` skill shadows a `global` skill of the same `name`. Plugin skills follow layer
  skills, ordered per [plugin.md](plugin.md), Section 9.
- Plugin skill files join the skill catalog as `namespace:name` ([plugin.md](plugin.md),
  Section 9). Shadowing between bare and namespaced catalog entries follows [plugin.md](plugin.md),
  Section 9.
- The skill catalog MUST be built from the boot snapshot.

## 2. Content rules {#content-rules}

Skill references are plain Markdown loaded verbatim. A skill file's leading byte-order mark is
removed before parsing; the skill body is then the text after the frontmatter with line endings
normalized to `\n` and surrounding whitespace trimmed. There is no substitution, no parametrization, and no
configuration inside a skill; a skill is instruction text only.

## 3. Specification gaps {#gaps}

None.
