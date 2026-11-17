# `Session` tool specification

This document specifies the `Session` tool: a read-only report on the invoking session — its
identity, session file, model, the configured models, model guidance, and billing. Model
strings and the inventory are owned by [model-string.md](model-string.md); the billing report
by [billing.md](billing.md).

## 1. Registration surface

| Field        | Value                                                             |
| ------------ | ----------------------------------------------------------------- |
| `name`       | `"Session"`                                                       |
| `label`      | `"Session"`                                                       |
| `parameters` | `{ type: "object", properties: {}, additionalProperties: false }` |

Any supplied parameter MUST be rejected by the schema, before the tool runs ([task.md](task.md),
Section 1).

## 2. Result

The report describes the invoking session: the main session, or the child session whose tool
call invoked it — never its dispatching session. If the call has no session ID, it MUST
immediately fail as a tool error with the text `no live session identity for Session`, before
gathering other report data. A call MUST NOT change session state; its report query
([billing.md](billing.md), Section 4.4) updates held billing only.

`details` MUST carry:

| Field           | Type                   | Contract                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`     | string                 | The session's UUID.                                                                                                                                                                                                                                                                                                                                                                                  |
| `sessionFile`   | string \| `null`       | Absolute path of the session file; `null` when the session has no persisted session file.                                                                                                                                                                                                                                                                                                            |
| `cwd`           | string                 | The session's working directory.                                                                                                                                                                                                                                                                                                                                                                     |
| `model`         | string \| `null`       | Canonical serialization ([model-string.md](model-string.md), Section 5) of the session's current model and thinking level; `null` when none is selected.                                                                                                                                                                                                                                             |
| `models`        | string[]               | The `provider/id` of each guided model of the configured models ([model-guidance.md](model-guidance.md), Section 2), in that section's order when guidance is active; otherwise every configured model in ascending order by UTF-16 code units. Deduplicate identifiers. `[]` without a model runtime. It is not the set an `Agent` call can dispatch ([agent-tool.md](agent-tool.md), Section 3.3). |
| `modelClasses`  | Record<string, string> | The active `modelClasses` mapping ([model-string.md](model-string.md), Section 3), each value in canonical serialization; `{}` when none is configured.                                                                                                                                                                                                                                              |
| `modelGuidance` | object[] \| `null`     | One `{ model, when }` per guided model of the configured models, in the order of [model-guidance.md](model-guidance.md), Section 2: `model` its identifier, `when` its model entry's `when`; `null` when model guidance is not active for the configured models.                                                                                                                                     |
| `billing`       | object \| `null`       | The billing report ([billing.md](billing.md), Section 7).                                                                                                                                                                                                                                                                                                                                            |

The text content MUST render the same data, one `<field>: <value>` line per scalar field, in
the order of the table above (`sessionFile: (none)` and `model: (none)` for `null`), then a
`models:` line followed by one model per line, then a `modelClasses:` line followed by one
`<class> → <model>` line per class in ascending ASCII order of class name, then, when the model
catalog of the configured models ([model-guidance.md](model-guidance.md), Section 6) is
non-empty, a `Model guidance:` line followed by that model catalog, then, when `billing` is not
`null`, a `billing (local zone <timeZone>):` line followed by the billing report's text
([billing.md](billing.md), Section 7).

## 3. Specification gaps

None.
