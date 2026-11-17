# Model guidance specification

This document specifies model guidance: the `modelGuidance` configuration key naming when to
use which model, the model catalog listing them in the `Agent` tool description, bounding
dispatch to those models, and guidance rules injected into every session whose model they
match. Its effect on the `Session` tool is owned by
[session-tool.md](session-tool.md); billing data in the guidance message by
[billing.md](billing.md).

## 1. Configuration

The `modelGuidance` root key loads and merges per the
[configuration file specification](config-file.md). Its value MUST be a non-array object:

| Field     | Type                        | Contract                                                                          |
| --------- | --------------------------- | --------------------------------------------------------------------------------- |
| `models`  | Record<string, `{ when }`>? | Model guidance keyed by model: when to use the keyed model.                       |
| `rules`   | `{ match, rule }`[]?        | Guidance rules: text injected verbatim into every session whose model they match. |
| `billing` | boolean?                    | Default `true`. `false` disables billing ([billing.md](billing.md), Section 1).   |

| Model entry field | Type   | Contract                                                                       |
| ----------------- | ------ | ------------------------------------------------------------------------------ |
| `when`            | string | Required. Non-empty after trimming; used trimmed: when to use the keyed model. |

| Guidance rule field | Type   | Contract                                                                                         |
| ------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `match`             | string | Required. Regular expression tested against a session's model as canonical `provider/id`.        |
| `rule`              | string | Required. Non-empty after trimming; used trimmed: the text injected into every matching session. |

```jsonc
"modelGuidance": {
  "models": {
    "anthropic/claude-opus-4-5:high": { "when": "design and code review" },
    "google/gemini-3-flash": { "when": "mechanical edits and searches" }
  },
  "rules": [{ "match": "flash|haiku", "rule": "verify its output before relying on it" }]
}
```

- A `models` key MUST be a concrete selector with an optional thinking suffix
  ([model-string.md](model-string.md), Sections 1–2); a class reference is invalid. A key with
  a thinking level guides dispatches at that level only (Section 3) and sets no thinking level;
  a key without one guides its `provider/id` at any level. One model can be keyed at several
  thinking levels.
- Two `models` keys that are equal after trimming name the same model: a key of the project layer
  MUST load before a key of the global layer, and within one layer the first in the object's key
  order MUST load; each other key MUST produce one diagnostic and be skipped
  ([model-string.md](model-string.md), Section 1).
- Regular expressions are ECMAScript regular expressions ([ECMA-262]) compiled with the `u` flag
  and no other flag, and are unanchored: a value matches when the expression matches any
  substring.
- A value that is not a non-array object for `modelGuidance` or `models`, a non-array `rules`, or a non-boolean `billing` value
  MUST produce one diagnostic and be ignored. An unknown field in a model entry or guidance rule
  follows the unknown-key rule ([config-file.md](config-file.md), Section 2) and the entry or
  rule loads. A model entry or guidance rule that is not an object or violates a field contract
  — including an invalid key or a regular expression that fails to compile — MUST produce one
  diagnostic and be skipped; siblings still load.
- Diagnostics are attributed per [config-file.md](config-file.md), Section 4.
- Model guidance MUST NOT affect model-string resolution; it restricts dispatch only per
  Section 3.

Model guidance is active for a model list when it has at least one guided model (Section 2).
Guidance rules apply whether or not model guidance is active.

## 2. Guided models

The guided models of a model list are the model entries whose keyed `provider/id` is the
`provider/id` of at least one model of the list and, when the key carries a thinking level, at
least one such model supports that level, decided per [model-string.md](model-string.md),
Section 4.4. Each guided model is identified by its key in canonical serialization
([model-string.md](model-string.md), Section 5) and carries its entry's `when`; guided models are
ordered by identifier in ascending ASCII order. A model entry failing either condition is
omitted. Without a model runtime the list is empty, so there are no guided models.

The model list is the inventory for the dispatch restriction (Section 3) and the configured
models for the guidance message (Section 5), the model catalog (Section 6), and the `Session` tool
([session-tool.md](session-tool.md)); model guidance is active, or not, separately for each use.
The configured models are the models the host model runtime reports as available: the inventory
models whose provider has authentication configured in the runtime, its authenticated subset. A
model the runtime does not report as available is in the inventory but is not a configured model.

> Note (non-normative): a model entry can therefore restrict dispatch while an unauthenticated
> provider keeps it out of the model catalog.

## 3. Dispatch restriction

While model guidance is active for the inventory, a dispatch is guided when its selected model and effective
thinking level ([agent-tool.md](agent-tool.md), Section 3.3) match a guided model:

- a guided model identified without a thinking level matches its `provider/id` at any
  thinking level, including none;
- a guided model identified with a thinking level matches its `provider/id` at that level
  only.

An unguided dispatch MUST fail plan resolution with `unguided-model`
([agent-tool.md](agent-tool.md), Section 7), naming the model and thinking level and listing
the guided models. The check runs after resolution, including `fallback`
([model-string.md](model-string.md), Section 4.3), and thinking precedence; the check applies
to the `call`, `agent`, and `persisted` tiers; a dispatch whose model is `inherited` from the
dispatching session ([agent-tool.md](agent-tool.md), Section 3.3) MUST NOT fail as unguided.

> Note (non-normative): the dispatching session already runs the inherited model, and every
> `Fleet` query dispatch relies on that tier, so exempting it keeps queries working on a main
> model that is not guided.

## 4. Session rules

A session's rules are the `rule` texts, in `rules` order, of the guidance rules whose `match`
matches the session's model as canonical `provider/id`. A session without a model has none.

- Main session: its rules are part of the guidance message (Section 5), against the session's
  current model.
- Child session: its rules are the content defined above; their placement in the child's system prompt is per [agent-tool.md](agent-tool.md), Section 4.2. A child receives no guidance message.
- Child guidance: items 1 and 2 of the guidance message content (Section 5), verbatim, the
  `Model billing:` line included, joined by a blank line and computed after the cached-query wait
  where [billing.md](billing.md), Section 4.3 requires one. Its model list MUST be the configured
  models, the list the guidance message itself is computed from (Section 2), so a child is
  guided exactly as the main session is and never by an unauthenticated provider. When the
  child's effective tool cap includes `Agent`, the child guidance is computed once per dispatch,
  when [agent-tool.md](agent-tool.md), Section 4.2 creates the dispatch's child session, a
  `resume` dispatch included; the dispatch's recovery attempts keep it. A child whose effective
  tool cap lacks `Agent` receives no child guidance. When the computed child guidance is
  non-empty, it MUST be appended to the child's system prompt after its rules, preceded by a
  blank line; otherwise nothing is appended. Later billing changes reach the child only through
  its `Session` tool ([session-tool.md](session-tool.md)).

## 5. Guidance message

The guidance message is the main session's model guidance. Its content is the following
sections, joined by a blank line, each present only when non-empty:

1. while guidance billing text is present ([billing.md](billing.md), Section 6.1) and at least
   one guided model has a non-empty billing annotation ([billing.md](billing.md), Section 6.2):
   the line `Model billing:` followed, per such guided model in the order of Section 2, by
   `- <model>:<annotation>`, `<annotation>` being its billing annotation;
2. while guidance billing text is present: the billing note
   ([billing.md](billing.md), Section 6.3);
3. the main session's rules, each verbatim, joined by a blank line.

The content, and the skip check below, are computed when the injection is made: at the event,
after the cached-query wait where [billing.md](billing.md), Section 4.3 requires one, or, for a
deferred `session_start` injection, when the poll outcome it waits for is known. When it is
non-empty, the extension MUST inject it into the main session with `customType`
`"pi-dent-model-guidance"` and `display: true`, and only on these events:

- `session_start`, for every reason, through the host `sendMessage` API with no turn started;
  when a billing poll is pending once the handler has applied [billing.md](billing.md),
  Section 4.2, the injection is instead deferred until a billing poll has an outcome other than
  `not-ready` — that poll, or a later one [billing.md](billing.md), Section 4.2 starts — and is
  then made through `sendMessage` with no turn started; a `session_shutdown` of the extension
  instance before that outcome cancels the deferred injection, and a `session_start` received
  while a deferred injection is pending makes no injection of its own;
- `session_compact` and `model_select`, through `sendMessage` with no turn started.

A failure of that deferred `session_start` injection is reported per
[billing.md](billing.md), Section 4.5.

An injection MUST be skipped when the latest `pi-dent-model-guidance` message after the session's
latest compaction entry on the session's current branch — or on the whole branch when it has no
compaction entry — has text equal to the content. Earlier `pi-dent-model-guidance` messages are
not compared.

The extension MUST register a host message renderer for `"pi-dent-model-guidance"`. Collapsed, it
renders one line: `[pi-dent-model-guidance]` in the theme colour `customMessageLabel`, bold, then
` <n> lines (` in `muted`, the host's key hint for its tool-expansion keybinding with the
description `to expand`, and `)` in `muted`, where `<n>` is the number of `"\n"`-separated lines
of the message text. Expanded, it renders nothing of its own, so the host renders the message as
it renders a custom message without a renderer.

> Note (non-normative): a change of billing data alone never injects, so the message changes at
> most once per event above; comparing with the latest message only re-injects content that
> returns to an earlier state, such as the rules after a model change from A to B and back.

## 6. Model catalog

The model catalog of a model list is, while model guidance is active for it, one line per guided
model in the order of Section 2, `- <model>: <when>`, the lines joined by `"\n"`; otherwise it
is empty. It carries no billing annotation.

> Note (non-normative): the model catalog changes only with the configuration or the
> authenticated providers, so it can sit in a tool description without breaking the prompt
> cache; billing, which changes during a session, stays in the guidance message.

## 7. Normative references

- [ECMA-262] ECMAScript Language Specification, 14th edition (June 2023), Ecma International:
  Regular Expressions (pattern syntax and the `u` flag).

## 8. Specification gaps

None.
