# Model string specification

This document specifies the model string: the single string grammar that selects a model
wherever a model is named — the `Agent` call's `model`, agent definitions, `modelClasses`
values, `modelGuidance` keys, and persisted sessions. It covers the grammar, component
validation, model-class configuration, inventory resolution, thinking precedence, and
canonical serialization.

## 1. Grammar {#grammar}

The grammar is ABNF ([RFC 5234]); its quoted strings are matched case-sensitively.

```abnf
model-string     = concrete / class-reference
concrete         = provider "/" model-id [ thinking-suffix ]
class-reference  = class-name [ thinking-suffix ]
thinking-suffix  = ":" thinking-level
class-name       = 1*name-char
provider         = 1*name-char
model-id         = 1*( name-char / "/" / ":" )
name-char        = <any character except whitespace, "/", and ":">
thinking-level   = "off" / "minimal" / "low" / "medium" / "high" / "xhigh" / "max"
```

Whitespace is every character the ECMAScript pattern `\s` matches ([ECMA-262]).

The grammar is closed: every model string parses to exactly one descriptor or fails. A class
name MUST be non-empty and MUST contain no whitespace, `/`, or `:`. `model-id` is further
constrained by Section 2.1. Class names are
dynamic — defined by the configuration of Section 3 — with one reserved name, `fallback`, whose
no-match semantics are specified in Section 4.3.

Disambiguation: a model string containing `/` before the first `:` is concrete; a model string
containing no `/` is a class reference. A model string whose first `/` appears after its first
`:` MUST be rejected with `invalid-plan`.

A model string MUST be a string whose trimmed form is non-empty and contains no internal
whitespace. Leading and trailing whitespace MUST be trimmed before parsing; internal whitespace
MUST be rejected with `invalid-plan`.

| Example                                | Parse                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `anthropic/claude-sonnet-4-5`          | Concrete; no thinking.                                                    |
| `anthropic/claude-sonnet-4-5:high`     | Concrete; thinking `high`.                                                |
| `litellm/anthropic/claude-sonnet-5`    | Concrete; provider `litellm`, model id `anthropic/claude-sonnet-5`.       |
| `balanced`                             | Class reference; no thinking.                                             |
| `balanced:high`                        | Class reference; thinking `high` overrides the class mapping.             |
| `balanced:anthropic/claude-sonnet-4-5` | Rejected with `invalid-plan` (slash after the first colon).               |
| `balanced:fast`                        | Rejected with `invalid-plan` (class name contains `:`).                   |
| `openrouter/qwen/qwen3:free`           | Concrete; id `qwen/qwen3:free`; the colon is model identity, no thinking. |

## 2. Components {#components}

### 2.1 Concrete selector {#concrete-selector}

The provider is the substring before the first `/`; the model id is the remainder. A model id
can itself contain `/` (gateway-qualified selectors) and `:` (identity).

- `provider` MUST be non-empty and MUST contain no whitespace, `/`, or `:`.
- `model-id` MUST be non-empty and MUST contain no whitespace, no leading or trailing `/`, no
  `//`, and no trailing `:`.
- The final `:`-separated segment of a model id MUST NOT be a `thinking-level`: the segment is
  reserved for the thinking suffix and such an id is unrepresentable. A selector violating any
  of these MUST be rejected with `invalid-plan` ("empty provider, model, or thinking
  component", or "reserved thinking suffix").

### 2.2 Thinking suffix {#thinking-suffix}

The thinking suffix is the segment after the last `:` of the model string when that segment is
a `thinking-level`. Any other segment after the last `:` is not a suffix; the colon is part of
the model identity. Exactly one suffix is parsed; after stripping it, the Section 2.1 rules
apply to the remainder.

## 3. Model classes {#model-classes}

Class names are dynamic: the `modelClasses` configuration object defines them, mapping each
class name to a concrete model. `fallback` is one reserved class name with special resolution
semantics (Section 4.3).

- A key defines a class; it MUST be non-empty and contain no whitespace, `/`, or `:`.
- A string value MUST be a concrete provider-qualified model string (it MUST contain `/`) with
  an optional thinking suffix; class references MUST NOT appear as configuration values (no
  chaining).
- An object value MUST have `{ provider, id, thinking? }`; an unknown field follows the
  unknown-key rule ([config-file.md](config-file.md), Section 2). Component rules follow
  Section 2.1, and `thinking` MUST be a valid level.
- A class definition violating any rule above MUST produce one diagnostic at boot and fail with
  `invalid-plan` when a model string naming that class is resolved.
- A `modelClasses` value that is not a non-array object MUST produce one diagnostic and be ignored.
- The `modelClasses` root key loads and merges per the
  [configuration file specification](config-file.md). The active mapping is that specification's
  boot snapshot, so changes take effect only after a restart or reload.

## 4. Resolution {#resolution}

Resolution turns a model string into a descriptor `{ provider, id, thinking? }` against the
inventory: the host pi runtime's registered model list. The inventory is always a list and can
be empty; an empty inventory matches nothing. The inventory is owned by pi — pi-dent registers no
models itself — and membership implies nothing about credentials or provider entitlement.
Resolution has no authorization policy; dispatch can be bounded by model guidance
([model-guidance.md](model-guidance.md), Section 3).

### 4.1 Exact inventory match {#exact-match}

A parsed concrete selector MUST match the inventory exactly on `provider/id`. Exactly one
match is required: zero matches MUST fail with `missing-model` ("does not exactly match the
available model inventory"); more than one MUST fail with `ambiguous-model`, listing the
candidates as `provider/id` pairs. There is no bare-id, prefix, or fuzzy matching, and no
special case for ids that contain `:`.

### 4.2 Class resolution {#class-resolution}

- A class reference MUST resolve through the active `modelClasses` mapping. A class with no
  mapping is a no-match (Section 4.3), naming `modelClasses.<class>`.
- The mapped value then resolves as a concrete selector (Section 4.1), with the inventory rules
  above.
- Only the referenced class is resolved; an unconfigured or invalid sibling class MUST NOT
  block the selection.
- A thinking suffix on the class reference MUST override the mapping's configured thinking.

### 4.3 Fallback {#fallback}

When resolution of a model string ends in a no-match — no inventory match (`missing-model`) or
an unmapped class (`missing-model-class`) — and the `fallback` class is defined, resolution
MUST proceed through the fallback mapping exactly as if `fallback` had been referenced:

- The fallback mapping MUST resolve once, as a concrete selector under Section 4.1; it MUST NOT chain to itself or to another class.
- An explicit thinking suffix on the original string MUST override the fallback mapping's
  configured thinking.
- When `fallback` is not defined, a no-match MUST fail with its original error
  (`missing-model` or `missing-model-class`).
- A `fallback` that itself fails to resolve fails with its own error.
- Fallback applies to no-match outcomes only: grammar violations (`invalid-plan`) and ambiguity
  (`ambiguous-model`) MUST fail without fallback.

### 4.4 Thinking precedence {#thinking-precedence}

Within one model string: explicit string suffix > class mapping's configured thinking > absent
(the level falls to the model default).

A requested thinking level that the resolved model does not support MUST fail at resolution
with `unsupported-thinking`; the level MUST NOT be silently adjusted. The check applies to every
resolved model string that carries a level, whether explicit, from a class mapping, or from the
`fallback` mapping. Support is decided by the resolved model's inventory entry, which carries a
`reasoning` flag and optionally a level map from thinking level to a value or `null`:

| Inventory entry                             | Supported levels                                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| not marked reasoning (flag absent or false) | `off` only.                                                                                                                                                            |
| marked reasoning                            | `off`, `minimal`, `low`, `medium`, `high`, each unless the level map sets it to `null`; `xhigh` and `max` only when the level map defines a non-`null` value for them. |

Precedence across a caller's selection tiers is owned by [agent-tool.md](agent-tool.md),
Section 3.3; this specification fixes precedence only inside one string.

## 5. Canonical serialization {#serialization}

A descriptor MUST serialize as `` `${provider}/${id}` ``, appending `:${level}` when
thinking is present. Parsing a canonical serialization MUST yield the identical
descriptor (round-trip).

## 6. Error codes {#error-codes}

| Code                   | Condition                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-plan`         | Grammar or configuration violation: empty component, internal whitespace, invalid class-name key, invalid thinking level, reserved thinking suffix. |
| `ambiguous-model`      | More than one inventory model matches the resolved `provider/id`.                                                                                   |
| `missing-model`        | No exact inventory match — after the fallback rule of Section 4.3.                                                                                  |
| `missing-model-class`  | Referenced class has no configuration mapping — after the fallback rule of Section 4.3.                                                             |
| `unsupported-thinking` | The resolved model does not support the requested thinking level (Section 4.4).                                                                     |

## 7. Normative references {#references}

- [ECMA-262] ECMAScript Language Specification, 14th edition (June 2023), Ecma International:
  Regular Expressions (the `\s` class), for whitespace in Section 1.
- [RFC 5234] Augmented BNF for Syntax Specifications: ABNF (STD 68), D. Crocker, P. Overell,
  2008: the grammar notation of Section 1.

## 8. Specification gaps {#gaps}

- Malformed model-class diagnostic wording is open: any wording that names the owning file per
  [config-file.md](config-file.md), Section 4, and the affected `modelClasses` key is allowed.
