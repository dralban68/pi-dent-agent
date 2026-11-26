# Skill tool specification

This document specifies the `Skill` tool and `<available_skills>` prompt injection: the
surface through which a session discovers and reads a skill body. The skill
resource itself — file format, discovery, and the skill catalog — is owned by
[skill.md](skill.md).

## 1. Binding and catalog injection {#binding}

Selection is progressive: the model selects from a catalog of names and descriptions, and a
body loads only on demand.

- When the skill catalog of [skill.md](skill.md) is non-empty, the main session MUST register
  the tool with `name` `Skill`, `label` `Skill`, and the parameter schema of [parameter schema](#parameter-schema),
  backed by the boot-snapshot skill catalog. A child session MUST register it when its tool cap
  includes `Skill` ([agent-tool.md, tools](agent-tool.md#tools)).
- A session whose active tools include `Skill` MUST carry, appended to its system prompt after
  a blank line, exactly `<available_skills>\n<lines>\n</available_skills>`, where `<lines>` is
  one `<key> — <description>` line per skill catalog entry ([skill.md, skill files](skill.md#skill-files)),
  `<key>` its catalog key (`name` or `namespace:name`), joined by `\n`. `—` is U+2014 with one
  space on each side. Each run of `\r\n`, `\r` or `\n` in a description is replaced by one
  space. This is appended on every main-session turn and in a child session per
  [agent-tool.md, child session](agent-tool.md#child-session). A session without `Skill` MUST carry no injection.
  Main-session plugin context blocks follow it ([plugin.md, plugin context](plugin.md#plugin-context)).
- A session MUST NOT expose the host's own skill store in its system prompt: on every
  main-session turn, whether or not the skill catalog is empty, pi-dent MUST clear the host's
  skill list from the turn's prompt options before the system prompt is rendered; a child session
  MUST NOT consult the host's own skill store.
- When the skill catalog is empty, a session MUST carry no `<available_skills>` injection and
  `Skill` MUST NOT be bound.

### 1.1 Parameter schema {#parameter-schema}

The parameter schema is a JSON object schema with `type: "object"` and
`additionalProperties: false`:

| Field       | Type              | Contract                                                                          |
| ----------- | ----------------- | --------------------------------------------------------------------------------- |
| `name`      | string (required) | The key of a skill in the skill catalog ([skill.md](skill.md)). Non-empty.        |
| `reference` | string?           | A skill reference of the named skill ([execution contract](#execution-contract)). |

The schema requires `name` as a string and admits no property other than these two, so a call that
omits `name` or gives it a non-string value is a schema rejection ([task.md, task kinds](task.md#task-kinds)).
The tool's own checks MUST reject, as a tool error and in this order: an empty or whitespace-only
`name`; a `name` absent from the catalog; and, when provided, an empty or whitespace-only
`reference`.

## 2. Execution contract {#execution-contract}

- One call loads one skill: the result is the skill body as `content[0].text`, verbatim per
  [skill.md, content rules](skill.md#content-rules); `isError` unset.
- `reference` omitted loads the skill body. When `reference` is present, it resolves
  `references/<reference>.md` under the skill's directory: `.md` is appended when absent; bare
  basenames and `/`-separated sub-paths are accepted. `reference` MUST be a contained path of the
  skill's `references/` folder ([plugin.md, contained paths](plugin.md#contained-paths)); a violation MUST be rejected
  as a tool error.
- A `name` absent from the skill catalog MUST fail as a tool error naming the skill and listing
  the available skill names in skill catalog order, joined by `", "` (`(none)` when empty).
- A missing skill reference MUST fail as a tool error naming the skill and the reference. A skill
  with no `references/` folder fails every `reference` call as a tool error.
- Loading MUST have no side effects: no state changes, no filesystem writes, no tool
  activation beyond the load itself.
- The skill body is the boot-snapshot body, identical for every load within one boot window; a
  skill reference is read fresh at call time.

## 3. Specification gaps {#gaps}

- The exact text and behavior of diagnostics returned by the host when it rejects a tool call are host-defined.
