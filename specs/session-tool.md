# `Session` tool specification

This document specifies the `Session` tool: a read-only report on the invoking session — its
identity, session kind and user-input availability, session file, model, the configured models,
model guidance, billing, and usage — together with the session kind classification, environment
variable, and system prompt mode line. Model strings and the inventory are owned by
[model-string.md](model-string.md); the billing report by [billing.md](billing.md); the usage
figures by [task-ledger.md](task-ledger.md).

## 1. Registration surface {#registration}

| Field        | Value                                                             |
| ------------ | ----------------------------------------------------------------- |
| `name`       | `"Session"`                                                       |
| `label`      | `"Session"`                                                       |
| `parameters` | `{ type: "object", properties: {}, additionalProperties: false }` |

Any supplied parameter MUST be rejected by the schema, before the tool runs ([task.md, task kinds](task.md#task-kinds)).

## 2. Result {#result}

The report describes the invoking session: the main session, or the child session whose tool
call invoked it — never its dispatching session. If the call has no session ID, it MUST
immediately fail as a tool error with the text `no live session identity for Session`, before
gathering other report data. A call MUST NOT change session state; its report query
([billing.md, report query](billing.md#report-query)) updates held billing only.

`details` MUST carry:

| Field           | Type                   | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`     | string                 | The session's UUID.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sessionKind`   | `"user" \| "agent"`    | `"user"` for a user session, `"agent"` for an agent session ([session kind](#session-kind)).                                                                                                                                                                                                                                                                                                                                                 |
| `userInput`     | boolean                | `true` for a user session, `false` for an agent session ([session kind](#session-kind)).                                                                                                                                                                                                                                                                                                                                                     |
| `sessionFile`   | string \| `null`       | Absolute path of the session file; `null` when the session has no persisted session file.                                                                                                                                                                                                                                                                                                                                                    |
| `cwd`           | string                 | The session's working directory.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `model`         | string \| `null`       | Canonical serialization ([model-string.md, canonical serialization](model-string.md#serialization)) of the session's current model and thinking level; `null` when none is selected.                                                                                                                                                                                                                                                         |
| `models`        | string[]               | The `provider/id` of each guided model of the configured models ([model-guidance.md, guided models](model-guidance.md#guided-models)), in that section's order when guidance is active; otherwise every configured model in ascending order by UTF-16 code units. Deduplicate identifiers. `[]` without a model runtime. It is not the set an `Agent` call can dispatch ([agent-tool.md, model and thinking](agent-tool.md#model-thinking)). |
| `modelClasses`  | Record<string, string> | The active `modelClasses` mapping ([model-string.md, model classes](model-string.md#model-classes)), each value in canonical serialization; `{}` when none is configured.                                                                                                                                                                                                                                                                    |
| `modelGuidance` | object[] \| `null`     | One `{ model, when }` per guided model of the configured models, in the order of [model-guidance.md, guided models](model-guidance.md#guided-models): `model` its identifier, `when` its model entry's `when`; `null` when model guidance is not active for the configured models.                                                                                                                                                           |
| `billing`       | object \| `null`       | The billing report ([billing.md, billing report](billing.md#billing-report)).                                                                                                                                                                                                                                                                                                                                                                |
| `ledger`        | string                 | `"ok"`; `"unavailable"` while the task ledger is unusable ([task-ledger.md, failures](task-ledger.md#failures)); `"busy"` when the read was abandoned at the read deadline ([task-ledger.md, concurrent access](task-ledger.md#concurrent-access)); `"missing"` when the ledger holds no row for the session (below).                                                                                                                        |
| `usage`         | object \| `null`       | `{ own, tasks: { count, usage }, total }` (below) when `ledger` is `"ok"`; else `null`.                                                                                                                                                                                                                                                                                                                                                      |

The text content MUST render the same data, one `<field>: <value>` line per scalar field, in
the order of the table above (`sessionFile: (none)` and `model: (none)` for `null`), then a
`models:` line followed by one model per line, then a `modelClasses:` line followed by one
`<class> → <model>` line per class in ascending ASCII order of class name, then, when the model
catalog of the configured models ([model-guidance.md, model catalog](model-guidance.md#model-catalog)) is
non-empty, a `Model guidance:` line followed by that model catalog, then, when `billing` is not
`null`, a `billing (local zone <timeZone>):` line followed by the billing report's text
([billing.md, billing report](billing.md#billing-report)), then the usage lines.

The usage figures are read from the task ledger once per call, after the session ID check above.
For a main session they come from its ledger session row and its ledger session ID; for a child
session, from the ledger row of the dispatch whose child session it is
([task-ledger.md, ledger row](task-ledger.md#ledger-row)). `ledger` is `"missing"` when that ledger session
row or ledger row does not exist. Each usage sum is the object
`{ input, output, cacheRead, cacheWrite, cost, turns }`; the figures are those of
[task-ledger.md, derived figures](task-ledger.md#derived-figures):

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

`<own>`, `<tasks>`, and `<total>` being `<usage>` of [agent-tool.md, usage](agent-tool.md#usage),
of `own`, `tasks.usage`, and `total`; `<count>` being `tasks.count`, and `<noun>` `agent` when
it is 1, else `agents`. Otherwise they are the single line `usage: ledger unavailable`,
`usage: ledger busy`, or `usage: no ledger row`, for `ledger` `"unavailable"`, `"busy"`, and
`"missing"`.

## 3. Session kind {#session-kind}

Every session is either a user session or an agent session:

- A **user session** is a main session for which the host reports a user interface (terminal mode
  or RPC mode). Its `sessionKind` is `"user"` and its `userInput` is `true`.
- An **agent session** is a child session ([agent-tool.md, child session](agent-tool.md#child-session), including a
  `Fleet` query child per [fleet-tool.md, action `query`](fleet-tool.md#query)), or a main session for which
  the host reports no user interface (print mode or JSON mode). Its `sessionKind` is `"agent"` and
  its `userInput` is `false`.

### 3.1 Environment variable {#environment-variable}

pi-dent MUST expose the invoking session's kind as `PI_DENT_SESSION_KIND`, with value `"user"` for
a user session and `"agent"` for an agent session:

- At a main session's `session_start`, pi-dent MUST set `PI_DENT_SESSION_KIND` in the process
  environment its tools inherit to the session's kind; at `session_shutdown`, pi-dent MUST unset
  it when it still holds that session's value.
- A child session's `PI_DENT_SESSION_KIND` MUST be `"agent"`, visible to the child's tools only,
  without mutating shared `process.env`; a child's tools MUST NOT see the dispatching session's
  value.

### 3.2 System prompt mode line {#prompt-mode}

Every session's system prompt MUST include its session mode line as its final part, joined to any
preceding text by `"\n\n"`:

| Session kind  | Mode line                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user session  | `Session mode: user session (user input is available; run long-running or substantial tools with background: true and end your turn with no tool calls so you do not block user input — never call Task wait when you can simply end your turn, as notifications arrive automatically).`                                                                                                                |
| agent session | `Session mode: agent session (no user input is available; do not ask the user questions or wait for user confirmation — complete the task autonomously or report blockers in your final response; never call Task wait when you can simply end your turn, as ending your turn with no tool calls pauses the session until background tasks finish and delivers their notifications in your next turn).` |

For a main session, pi-dent MUST append the mode line on `before_agent_start`, after the skill
catalog ([skill-tool.md, binding and catalog injection](skill-tool.md#binding)) and plugin context blocks
([plugin.md, plugin context](plugin.md#plugin-context)). For a child session, the mode line is the final part of the
child's system prompt ([agent-tool.md, child session](agent-tool.md#child-session)).

## 4. Specification gaps {#gaps}

None.
