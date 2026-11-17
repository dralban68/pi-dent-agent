# Plugin tool specification

This document specifies the `Plugin` tool: the surface through which a session reads one plugin
resource file. The plugin resource itself — layout, manifest, identity, discovery, and the plugin
catalog — is owned by [plugin.md](plugin.md).

## 1. Parameter schema

The extension MUST register `Plugin` through the host `registerTool` API with label `Plugin` and
this parameter schema. The parameter schema is a JSON object schema with `type: "object"` and
`additionalProperties: false`:

| Field    | Type              | Contract                                                                 |
| -------- | ----------------- | ------------------------------------------------------------------------ |
| `plugin` | string (required) | A plugin namespace.                                                      |
| `path`   | string (required) | Relative path inside the plugin root; see Section 2.                     |
| `args`   | string (optional) | Argument string for substitution; see [plugin.md](plugin.md), Section 6. |

The schema requires `plugin` and `path` as strings and admits no other property. Tool checks
MUST reject, in order, as a tool error: empty or whitespace-only `plugin`; unknown `plugin`;
empty or whitespace-only `path`; then invalid path per Section 2.

## 2. Path rules

The root is the plugin root; the first path segment MUST be `commands`, `agents`, or `skills`.
A path matches a resource when it names one of the resource files of [plugin.md](plugin.md),
Section 1: `commands/*.md`, `agents/*.md`, `skills/<name>/SKILL.md` or
`skills/<name>/references/**/*.md`. Execution-time validation MUST reject, as a tool error, a
`path` that:

- is not a contained path of the plugin root ([plugin.md](plugin.md), Section 7),
- matches no resource.

## 3. Execution contract

- One call reads one resource in the named namespace from the boot-snapshot plugin catalog.
- After parameter validation, an unknown `plugin` MUST fail as a tool error.
- A path MUST be contained and match a resource before it is read. A missing resource
  MUST fail as a tool error naming its absolute path.
- The file MUST be read fresh on every call ([plugin.md](plugin.md), Section 8).
- Any matching file in a cataloged plugin is readable; namespace membership is the only
  authorization.
- The whole file, including frontmatter, is returned as `content[0].text`; when `args` is
  omitted, it is verbatim, otherwise substitution follows [plugin.md](plugin.md), Section 6.
  A read has no side effects.
- The tool returns text only; further tool calls are gated by session tools and never executed
  by this tool.

## 4. Specification gaps

None.
