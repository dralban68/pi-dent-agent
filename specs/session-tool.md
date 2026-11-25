# `Session` tool specification

This document specifies the `Session` tool: a read-only report on the invoking session — its
identity, session file, model, the configured models, model guidance, billing, and usage. Model
strings and the inventory are owned by [model-string.md](model-string.md); the billing report
by [billing.md](billing.md); the usage figures by [task-ledger.md](task-ledger.md).

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
| `ledger`        | string                 | `"ok"`; `"unavailable"` while the task ledger is unusable ([task-ledger.md](task-ledger.md), Section 7); `"busy"` when the read was abandoned at the read deadline ([task-ledger.md](task-ledger.md), Section 5); `"missing"` when the ledger holds no row for the session (below).                                                                                                                  |
| `usage`         | object \| `null`       | `{ own, tasks: { count, usage }, total }` (below) when `ledger` is `"ok"`; else `null`.                                                                                                                                                                                                                                                                                                              |

The text content MUST render the same data, one `<field>: <value>` line per scalar field, in
the order of the table above (`sessionFile: (none)` and `model: (none)` for `null`), then a
`models:` line followed by one model per line, then a `modelClasses:` line followed by one
`<class> → <model>` line per class in ascending ASCII order of class name, then, when the model
catalog of the configured models ([model-guidance.md](model-guidance.md), Section 6) is
non-empty, a `Model guidance:` line followed by that model catalog, then, when `billing` is not
`null`, a `billing (local zone <timeZone>):` line followed by the billing report's text
([billing.md](billing.md), Section 7), then the usage lines.

The usage figures are read from the task ledger once per call, after the session ID check above.
For a main session they come from its ledger session row and its ledger session ID; for a child
session, from the ledger row of the dispatch whose child session it is
([task-ledger.md](task-ledger.md), Section 2.2). `ledger` is `"missing"` when that ledger session
row or ledger row does not exist. Each usage sum is the object
`{ input, output, cacheRead, cacheWrite, cost, turns }`; the figures are those of
[task-ledger.md](task-ledger.md), Section 6:

| Field         | Main session                                       | Child session                                   |
| ------------- | -------------------------------------------------- | ----------------------------------------------- |
| `own`         | The own usage of its ledger session row.           | The own usage of the dispatch's ledger row.     |
| `tasks.count` | The count of the agent figures of the session.     | The count of the agent figures of that row.     |
| `tasks.usage` | The usage sum of the agent figures of the session. | The usage sum of the agent figures of that row. |
| `total`       | The session usage.                                 | The cumulative usage of that row.               |

The usage lines are, when `ledger` is `"ok"`:

```text
usage:
own: <own>
tasks: <count> <noun> · <tasks>
total: <total>
```

`<own>`, `<tasks>`, and `<total>` being `<usage>` of [agent-tool.md](agent-tool.md), Section 13,
of `own`, `tasks.usage`, and `total`; `<count>` being `tasks.count`, and `<noun>` `agent` when
it is 1, else `agents`. Otherwise they are the single line `usage: ledger unavailable`,
`usage: ledger busy`, or `usage: no ledger row`, for `ledger` `"unavailable"`, `"busy"`, and
`"missing"`.

## 3. Specification gaps

None.
