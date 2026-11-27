# Billing specification

This document specifies how pi-dent consumes the billing service, the bundled pi-dent-purse extension
([package.md, entry list](package.md#entry-list)): the subset of its protocol pi-dent
relies on, when pi-dent queries it, the held billing it keeps, how billing entries map to guided
models, and the billing text placed in the guidance message
([model-guidance.md, guidance message](model-guidance.md#guidance-message)) and in the `Session` tool's billing report
([session-tool.md](session-tool.md)). pi-dent MUST NOT contact a vendor, read a credential, or
derive billing data itself; everything in this document comes from billing query replies.

## 1. Enablement {#enablement}

Billing is enabled unless `modelGuidance.billing` is `false`
([model-guidance.md, configuration](model-guidance.md#configuration)). While billing is disabled, the extension
MUST NOT emit on or subscribe to the channels of [billing service protocol](#service-protocol), holds no billing, and every billing
text of [guidance billing text](#guidance-billing) and [billing report](#billing-report) is absent.

## 2. Billing service protocol {#service-protocol}

The billing service answers on the event bus of the extension instance:
the host's inter-extension bus, which delivers an emitted event synchronously to every listener
during `emit`. pi-dent relies on the following and nothing else.

| Channel            | Direction         | Payload                                                              |
| ------------------ | ----------------- | -------------------------------------------------------------------- |
| `purse:query:v1`   | pi-dent → service | A request ([request and outcome](#request-outcome)).                 |
| `purse:changed:v1` | service → pi-dent | A change notification ([change notification](#change-notification)). |

### 2.1 Request and outcome {#request-outcome}

A billing query emits one request object on `purse:query:v1`:

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `providers` | The billing providers of the query ([billing providers and mapping](#providers)), non-empty.     |
| `mode`      | `"cached"` or `"auto"` ([queries](#queries)); pi-dent MUST NOT send `"refresh"`.                 |
| `maxWaitMs` | `5000` for a report query ([report query](#report-query)); absent for every other billing query. |
| `respond`   | A function returning `true` on its first call during `emit` and `false` on every other call.     |

pi-dent MUST NOT emit a request whose `providers` is empty and MUST NOT set any other field. The
argument of the first `respond` call is a promise; what it settles to is the billing reply. The
outcome of the billing query is the first that applies:

| Outcome      | Condition                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `no-service` | `respond` was not called before `emit` returned or threw.                                                                                |
| `invalid`    | The first `respond` argument is not an object with a `then` function, or the promise rejects, or it settles to an invalid billing reply. |
| `timeout`    | The promise has not settled 25 000 ms after `emit` returned.                                                                             |
| the `status` | The billing reply's `status`: `ok`, `not-ready`, `bad-request`, or `cancelled`.                                                          |

A billing reply is valid when it is an object whose `protocol` is `1`, whose `status` is one of `ok`,
`not-ready`, `bad-request`, `cancelled`, whose `generatedAt` is a finite number, and whose
`providers` is a non-array object. A settlement after `timeout` MUST be ignored. A field of a
billing reply that this specification does not name MUST be ignored at every level and MUST NOT
produce a diagnostic; the unknown-key rule ([config-file.md, format](config-file.md#format)) does not
apply to a billing reply.

> Note (non-normative): the service settles every billing reply within 20 s of the offer, or within
> `maxWaitMs` when that is less, so the 25 s deadline cuts off only a service that breaks that
> promise, and the protocol asks consumers for a deadline of at least 20 s.

Only an `ok` outcome changes held billing ([extension instance and held billing](#held-billing)). No outcome produces a diagnostic, a
notification, or a session message, and billing queries start only by the rules of [queries](#queries). A
failure that is not a query outcome is reported per [diagnostics](#diagnostics).

### 2.2 Billing entry {#billing-entry}

The billing reply's `providers` maps a provider id to its billing entry. pi-dent reads these fields; a
value outside its listed shape is treated as stated in the last column:

| Field        | Shape read                                                                                | Otherwise                                                            |
| ------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `status`     | `unknown-provider`, `free`, `no-adapter`, `ok`, `partial`, `unavailable`, `not-collected` | Any other string: `unavailable`. Not a string: the entry is invalid. |
| `reason`     | string or `null`                                                                          | `null`                                                               |
| `capturedAt` | finite number from 0 to 253 370 764 800 000 inclusive, or `null`                          | `null`                                                               |
| `stale`      | boolean                                                                                   | `false`                                                              |
| `plan`       | `{ state: "known", value: string }`                                                       | No plan.                                                             |
| `balance`    | `{ state: "known", value: BalanceItem[] }`                                                | No balance items.                                                    |
| `limits`     | `{ state: "known", value: LimitWindow[] }`                                                | No limit windows.                                                    |
| `models`     | non-array object mapping a model id to a ModelRecord                                      | No model records.                                                    |

| BalanceItem field | Shape read                   | Otherwise            |
| ----------------- | ---------------------------- | -------------------- |
| `amount`          | finite number                | The item is dropped. |
| `currency`        | string matching `^[A-Z]{3}$` | The item is dropped. |
| `gatesUsage`      | boolean                      | `false`              |
| `severity`        | a severity                   | `unknown`            |

| LimitWindow field | Shape read                                                                    | Otherwise              |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------- |
| `label`           | string                                                                        | `null`                 |
| `unit`            | `percent`, `credits`, `tokens`, `requests`, `concurrent-requests`, `currency` | `null`                 |
| `used`, `limit`   | finite number                                                                 | `null`                 |
| `percent`         | finite number ≥ 0                                                             | `null`                 |
| `resetsAt`        | finite number from 0 to 253 370 764 800 000 inclusive (epoch milliseconds)    | `null`                 |
| `currency`        | string matching `^[A-Z]{3}$`                                                  | `null`                 |
| `windowSeconds`   | integer > 0                                                                   | `null`                 |
| `severity`        | a severity                                                                    | `unknown`              |
| `models`          | array of strings, or `null`                                                   | The window is dropped. |

A `models` array holding any value that is not a string is not a shape read, so the window is
dropped; the window is not narrowed to its string elements.

| ModelRecord field                                           | Shape read                                                 | Otherwise |
| ----------------------------------------------------------- | ---------------------------------------------------------- | --------- |
| `price.rates.input`, `.output`, `.cacheRead`, `.cacheWrite` | finite number ≥ 0 and < 1 000 000 (USD per million tokens) | `null`    |
| `price.source`                                              | string                                                     | `null`    |
| `price.schedule.active`                                     | boolean                                                    | `false`   |
| `price.schedule.multiplier`                                 | finite number > 0                                          | `null`    |
| `price.schedule.changesAt`                                  | finite number from 0 to 253 370 764 800 000 inclusive      | `null`    |
| `severity`                                                  | a severity                                                 | `unknown` |

A severity is one of `ok`, `low`, `critical`, `exhausted`, `unknown`; gravity orders
`ok` < `low` < `critical` < `exhausted`, and `unknown` has no gravity. An entry that is not a
non-array object, or whose `status` is not a string, is invalid and is treated as absent from
the billing reply. A balance item, limit window, or model record that is not a non-array object is
dropped. A model record has a price schedule when its `price.schedule.multiplier` is read as a
number; it then has `active` and `changesAt` as read.

### 2.3 Change notification {#change-notification}

A change notification is a `purse:changed:v1` payload that is an object whose `providers` is an
array; its named providers are the array's string elements. Any other payload MUST be ignored.

## 3. Billing providers and mapping {#providers}

A billing entry is keyed by provider id; a guided model's identifier
([model-guidance.md, guided models](model-guidance.md#guided-models)) parses to a descriptor whose `provider` is
that key and whose `id` keys its model record within the entry. The thinking level of the
identifier MUST be ignored: every thinking level of one `provider/id` maps to the same entry
and model record.

The billing providers of a set of models are the distinct `provider` components of its
models, in ascending ASCII order. A provider id the billing service does not serve gets no entry
in the billing reply, and so no billing text.

- The guidance billing providers are the billing providers of the guided models for the
  configured models ([model-guidance.md, guided models](model-guidance.md#guided-models)) while model guidance
  is active for them, and none otherwise.
- The report billing providers of a `Session` call are the billing providers of its `models`
  ([session-tool.md, result](session-tool.md#result)).

A guided model whose provider has no held billing entry has an empty billing annotation
([billing annotation](#billing-annotation)). For its billing annotation, a guided model
whose `id` has no model record in the held entry is treated as having one with every rate and
`source` `null` and no price schedule.

## 4. Queries {#queries}

### 4.1 Extension instance and held billing {#held-billing}

An extension instance is one call of pi-dent's extension factory; session replacement (`new`,
`resume`, `fork`) and reload start a new one with a new event bus. While billing is enabled,
each extension instance MUST subscribe to `purse:changed:v1` on its own event bus in its
factory call. The host can deliver `session_start` more than once to one extension instance.
Held billing belongs to the extension instance and starts empty.

An `ok` outcome replaces, for each requested provider whose entry in the billing reply is valid, the
held entry with the billing reply's entry, unless the held entry came from a billing reply with a
greater
`generatedAt`. Held billing is never cleared otherwise within the extension instance.

From the extension instance's `session_shutdown` on, the extension MUST start no billing query,
MUST ignore change notifications and settlements, and MUST NOT inject on account of any of them.

### 4.2 Billing poll {#billing-poll}

A billing poll is a billing query with `mode` `"auto"` for the guidance billing providers. A
poll is due when billing is enabled, the guidance billing providers are non-empty, and no poll
of the extension instance is pending. When a poll is due, the extension MUST start one:

- on every `session_start` the extension instance receives, whatever its reason;
- on a change notification, when the latest poll's outcome was `not-ready`;
- when a poll's outcome is `not-ready` and a change notification arrived while it was pending.

The extension MUST NOT start a poll on any other occasion, MUST NOT wait for a poll in any event
handler, and MUST NOT impose a minimum time between polls of its own.

> Note (non-normative): the endpoints' real tolerance is unknown, but the billing service answers
> `auto` from any capture younger than its freshness period (by default 120 s for Anthropic,
> 300 s elsewhere), joins concurrent refreshes, and backs off after HTTP 429, so polling every
> run costs at most about one vendor request per provider per freshness period, half the rate of
> Anthropic's own client, which treats that endpoint's answer as fresh for 60 s. An interval of
> pi-dent's own would add no protection beyond this and only delay guidance; the 429 answers seen
> came from a test run calling the endpoint repeatedly.

### 4.3 Cached query {#cached-query}

A cached query is a billing query with `mode` `"cached"`. Each extension instance keeps a
waiting set of providers, initially empty. Providers join the waiting set on two occasions: on a
change notification ([change notification](#change-notification)), the providers it names that are guidance billing providers;
and, while billing is enabled and the guidance billing providers are non-empty, every guidance
billing provider that no pending cached query of the extension instance names, immediately before
guidance content is computed on `session_compact` and `model_select`
([model-guidance.md, guidance message](model-guidance.md#guidance-message)) and before a child guidance is computed
([model-guidance.md, session rules](model-guidance.md#session-rules)). When the waiting set is non-empty
and no cached query of the extension instance is pending, the extension MUST start a cached query
for the waiting set and empty it; when a cached query settles and the waiting set is non-empty, it
MUST start the next one the same way.

Such a guidance computation MUST then wait, for at most 500 ms from that moment,
until no cached query of the extension instance is pending, and then proceed with held billing as
it stands; an outcome arriving later still applies per [extension instance and held billing](#held-billing). For a child guidance, at any
dispatch depth, the waiting set, the query, and held billing are those of the main session's
extension instance.

> Note (non-normative): a `cached` answer costs no vendor request and carries the price
> schedule's current activity, so a crossing into or out of a discount window shows at the next
> injection rather than one run later.

### 4.4 Report query {#report-query}

While billing is enabled, a `Session` call with non-empty report billing providers MUST make
one billing query with `mode` `"auto"` for them and wait for its outcome before returning,
unless the tool call is aborted first, in which case it stops waiting and [billing report](#billing-report) uses held
billing alone. Its `ok` outcome updates held billing per [extension instance and held billing](#held-billing). Whichever session invokes
`Session`, the report query uses the event bus of the main session's extension instance, and
[billing report](#billing-report) reads that instance's held billing.

### 4.5 Diagnostics {#diagnostics}

Each of these failures MUST produce one diagnostic naming the failure: one message with level
`warning`, reported through the host `notify` API as `pi-dent: <message>`
([config-file.md, diagnostics](config-file.md#diagnostics)).

- subscribing to `purse:changed:v1` throwing, or cancelling that subscription throwing
  ([extension instance and held billing](#held-billing));
- the guidance billing providers ([billing providers and mapping](#providers)) being unreadable;
- injecting a deferred `session_start` guidance message
  ([model-guidance.md, guidance message](model-guidance.md#guidance-message)) throwing.

The diagnostic is reported at once while a session of the extension instance is open, and
otherwise at that instance's next `session_start`. The extension instance then holds what it
held: without the change subscription, with no guidance billing providers for that query or
poll, without that injection. It MUST carry on and MUST NOT let the failure reach the event
handler, timer, or promise callback that runs it.

## 5. Billing text {#billing-text}

Every text of [guidance billing text](#guidance-billing) and [billing report](#billing-report) is composed by pi-dent from the fields of [billing entry](#billing-entry). The only
strings copied from a billing entry are sanitized text, `status` as read, and the values
[billing report](#billing-report) admits by pattern; provider ids and model ids come from pi-dent's own model list.

- Sanitized text: a string with every match of `[^\p{L}\p{N} ._\-/+()]` ([ECMA-262], `u`
  flag) removed, runs of spaces collapsed to one, trimmed, cut to its first 64 characters, and a
  trailing lone surrogate, then trailing spaces, removed; an empty result is `null`. Only `plan` and
  limit window `label` are sanitized text, and they appear only in the billing report
  ([billing report](#billing-report)).
- Decimal rendering to `n` places: the result of `Number.prototype.toFixed(n)` on the value,
  converted back to a Number and written by Number::toString ([ECMA-262]); a positive value
  whose result is 0 renders as the smallest positive multiple of 10⁻ⁿ.
- Local zone: the time zone the extension instance reads once, in its factory call, as
  `timeZone` of `Intl.DateTimeFormat().resolvedOptions()` ([ECMA-402]) when that is a string
  matching `^[A-Za-z0-9_+/-]{1,64}$` that `new Intl.DateTimeFormat("en-US", { timeZone })`
  accepts without error, else `UTC`. The local offset of an instant is the UTC offset [IANA TZ]
  gives the local zone at that instant, truncated toward zero to whole minutes and written
  `±HH:MM`, `+00:00` for zero.
- Minute stamp: an epoch-millisecond instant rounded up to a whole minute (an instant on a whole
  minute is unchanged), written `<utc> (<local>)`: `<utc>` is `YYYY-MM-DDTHH:MMZ` in
  UTC; `<local>` is the same instant in the local zone, `HH:MM` followed by its local offset
  when its local date equals its UTC date, else `YYYY-MM-DDTHH:MM` followed by its local offset.
- Second stamp: an epoch-millisecond instant rounded down to the whole second, written
  `<utc> (<local>)`: `<utc>` is `YYYY-MM-DDTHH:MM:SSZ` in UTC; `<local>` is
  `YYYY-MM-DDTHH:MM:SS` in the local zone followed by its local offset.
- Past reset: a limit window whose `resetsAt` is at or before the instant a text or billing
  report is computed is treated, for that text or report, as having `used` and `percent` `null`
  and severity `unknown`.
- Counted limit window: a limit window whose `windowSeconds` is `null` or at least 3600.
- Window name: from `windowSeconds` `d`: `window` when `null`; else `<d/86400>d` when `d` is a
  multiple of 86 400; else `<d/3600>h` when a multiple of 3600; else `<d/60>m` when a multiple of
  60; else `<d>s`. Followed by ` tokens`, ` requests`, ` credits`, or ` spend` when `unit` is
  `tokens`, `requests`, `credits`, or `currency`; no suffix otherwise.
- Window clause: `<window name> <severity>`, followed by ` until <minute stamp of resetsAt>`
  when `resetsAt` is not `null`. Window clauses are ordered by severity gravity, gravest first,
  then by window name in ascending ASCII order, then by `resetsAt` ascending with `null` last,
  then by the clause's full text in ascending ASCII order.
- Provider state of a billing entry, by `status`: `free` → `free`; `no-adapter` and
  `unknown-provider` → `untracked`; `ok` and `partial` → the gravest severity among the
  entry's balance items whose `gatesUsage` is `true` and its counted limit windows whose
  `models` is `null`, `unknown` when none has a gravity; any other status → `unknown`.

> Note (non-normative): the billing service applies the same past-reset rule when it derives an
> entry; pi-dent applies it again because a held entry can age past a reset between queries.

> Note (non-normative): leaving windows shorter than an hour out of the provider state keeps
> per-minute rate limits from changing the guidance message from one run to the next.

> Note (non-normative): a stamp depends only on the instant and the local zone, and the offset
> is the one in force at the instant itself, so a daylight-saving change before a reset neither
> misstates the reset nor changes the text.

## 6. Guidance billing text {#guidance-billing}

### 6.1 Presence {#presence}

Guidance billing text is present while billing is enabled, model guidance is active for the
configured models ([model-guidance.md, guided models](model-guidance.md#guided-models)), and held billing has an
entry for at least one guidance billing provider. It
is computed from held billing at the moment guidance content or a child guidance is computed
([model-guidance.md, session rules](model-guidance.md#session-rules) and [model-guidance.md, guidance message](model-guidance.md#guidance-message)). Without it — billing disabled, the
billing service absent, or no `ok` outcome yet — the guidance message has no billing lines.

### 6.2 Billing annotation {#billing-annotation}

A guided model's billing annotation is built from the held entry of its provider and that
entry's model record for its `id`. Its parts, in order:

1. the price, when the provider state is `free` or the record's `price.source` is `free`:
   `free`; otherwise, when `input` or `output` is not `null`, the rate pair below; otherwise no
   part;
2. the provider state ([billing text](#billing-text)), when it is `untracked`, `unknown`, `low`, `critical`, or
   `exhausted`;
3. when the entry's `status` is `ok` or `partial`: the first 2 window clauses, in window-clause
   order, of its counted limit windows whose `models` is `null` and whose severity is `low`,
   `critical`, or `exhausted`;
4. when the entry's `status` is `ok` or `partial`: the first 2 window clauses, in window-clause
   order, of its counted limit windows whose `models` contains the guided model's `id` and
   whose severity is `low`, `critical`, or `exhausted`.

The rate pair is `$<input>/$<output>`, each rate in decimal rendering to 3 places and `?` when
`null`. When the record has a price schedule with multiplier `m`:

- while `active` is `true`: the rate pair of the rates multiplied by `m`, then ` (×<m>)`, then
  ` until <minute stamp of changesAt>` when `changesAt` is not `null`;
- while `active` is `false` and `changesAt` is not `null`: the rate pair, then
  `, ×<m> from <minute stamp of changesAt>`;
- otherwise: the rate pair.

`<m>` is in decimal rendering to 3 places. With at least one part, the annotation is a space,
`[`, the parts joined by `; `, and `]`; with none, it is empty. The annotation follows `<model>:`
on the guided model's line of the guidance message ([model-guidance.md, guidance message](model-guidance.md#guidance-message)).

> Note (non-normative): `active` and `changesAt` change only when the schedule crosses into or
> out of a window, and a weekly schedule always has its next crossing within the billing
> service's 7-day horizon, so the annotation changes once per crossing and never in between.

### 6.3 Billing note {#billing-note}

The billing note is the following line, `<zone>` being the local zone ([billing text](#billing-text)):

```text
Choose by stated use first; among models suited to a task, prefer the cheaper, counting a discount (×) while it lasts. Prices are USD per million input/output tokens; times UTC, local <zone> in parentheses. Requests to an exhausted provider or model fail until its reset. Providers without limit data are marked unknown or untracked.
```

Example, local zone `Europe/Prague`, for guided models `anthropic/claude-opus-4-5:high`,
`deepseek/deepseek-v4-pro`, and `google/gemini-3-flash`:

```text
Model billing:
- anthropic/claude-opus-4-5:high: [$5/$25; critical; 5h critical until 2026-05-12T23:00Z (2026-05-13T01:00+02:00); 7d exhausted until 2026-05-14T09:00Z (11:00+02:00)]
- deepseek/deepseek-v4-pro: [$0.217/$0.435 (×0.5) until 2026-05-13T01:00Z (03:00+02:00)]
- google/gemini-3-flash: [$0.5/$3]

Choose by stated use first; among models suited to a task, prefer the cheaper, counting a discount (×) while it lasts. Prices are USD per million input/output tokens; times UTC, local Europe/Prague in parentheses. Requests to an exhausted provider or model fail until its reset. Providers without limit data are marked unknown or untracked.
```

## 7. Billing report {#billing-report}

The billing report of a `Session` call is `null` while billing is disabled or when it would hold
no record; otherwise it is `{ timeZone, providers }`: `timeZone` the local zone ([billing text](#billing-text)), and
`providers` one record per report billing provider with an entry in held billing once the report
query's outcome is known or waiting for it stopped ([report query](#report-query)), in ascending ASCII order of
provider:

| Field        | Type             | Contract                                                                                                                                                                                                                                                                                |
| ------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`   | string           | The provider id.                                                                                                                                                                                                                                                                        |
| `state`      | string           | The provider state ([billing text](#billing-text)).                                                                                                                                                                                                                                     |
| `status`     | string           | `status` as read ([billing entry](#billing-entry)).                                                                                                                                                                                                                                     |
| `reason`     | string \| `null` | `reason` when it matches `^[a-z0-9][a-z0-9-]{0,63}$` ([ECMA-262], `u` flag); else `null`.                                                                                                                                                                                               |
| `capturedAt` | number \| `null` | As read.                                                                                                                                                                                                                                                                                |
| `stale`      | boolean          | As read.                                                                                                                                                                                                                                                                                |
| `plan`       | string \| `null` | The plan value as sanitized text; `null` without a plan.                                                                                                                                                                                                                                |
| `balance`    | object[]         | Per balance item in billing reply order: `{ amount, currency, gatesUsage, severity }`.                                                                                                                                                                                                  |
| `limits`     | object[]         | Per limit window in billing reply order: `{ label, unit, currency, percent, used, limit, resetsAt, windowSeconds, models, severity }`, `label` as sanitized text, `models` keeping only its elements that match `^[A-Za-z0-9._:/-]{1,128}$`.                                            |
| `models`     | object[]         | Per model of the `Session` call's `models` with this provider and a model record, ascending ASCII: `{ model, input, output, cacheRead, cacheWrite, schedule, severity }`, `model` its `provider/id`, `schedule` `{ multiplier, active, changesAt }` or `null` without a price schedule. |

Its text is one block per record, blocks in record order:

1. `<provider>: <state>; status <status>`, then `; reason <reason>` when `reason` is not `null`,
   `; plan <plan>` when `plan` is not `null`, `; captured <second stamp>` when `capturedAt` is
   not `null`, and `; stale` when `stale` is `true`;
2. per balance item: two spaces, `balance <amount> <currency> <severity>`, `amount` in decimal
   rendering to 2 places;
3. per limit window: two spaces, `limit <label>: <percent>%`, then ` used` when `percent` is not
   `null`, then ` (<used>/<limit> <unit>)`
   when `used` is not `null` (`<unit>` being the window's `currency` when `unit` is `currency`,
   and ` <unit>` omitted when that is `null`), then `; resets <second stamp>` when `resetsAt` is
   not `null`, then `; for <models>` when `models` is not `null` and not empty, then
   `; <severity>`; `label` is `?` when `null`, `percent` in decimal rendering to 1 place and `?`
   when `null`, `used` and `limit` in decimal rendering to 3 places and `limit` `?` when `null`,
   `<models>` its elements joined by `,`;
4. per model: two spaces, `<model>: $<input>/$<output>, cache $<cacheRead>/$<cacheWrite>`, then,
   with a schedule whose `active` is `true`, `, ×<multiplier> now` followed by
   ` until <second stamp of changesAt>` when `changesAt` is not `null`, or, with one whose
   `active` is `false` and `changesAt` is not `null`, `, ×<multiplier> from <second stamp of
   changesAt>`; then `; <severity>`; rates and multiplier in decimal rendering to 3 places, `?`
   for `null`.

## 8. Normative references {#references}

- [ECMA-262] ECMAScript Language Specification, 14th edition (June 2023), Ecma International:
  Regular Expressions (pattern syntax and the `u` flag), Number::toString and
  `Number.prototype.toFixed` (decimal rendering).
- [ECMA-402] ECMAScript Internationalization API Specification, 10th edition (June 2023), Ecma
  International: `Intl.DateTimeFormat.prototype.resolvedOptions` (the local zone of [billing text](#billing-text)).
- [IANA TZ] IANA Time Zone Database, any release supported by the host runtime's `Intl` API: the
  zone names and UTC offsets of [billing text](#billing-text).

## 9. Specification gaps {#gaps}

- Whether the host's `emit` propagates an exception thrown by a listener; [request and outcome](#request-outcome) treats a
  throw before `respond` as `no-service` either way.
- The billing service keeps captures per process, so with several main sessions on one machine
  the vendor requests of [billing poll](#billing-poll) scale with the number of processes; a capture shared per
  machine would bound them, and pi-dent takes no measure of its own.
- Whether a vendor model name in a limit window's `models` that equals a guided model's `id`
  denotes that model; [billing annotation](#billing-annotation) treats it as the model.
- [Diagnostics](#diagnostics) diagnostic wording is open: any wording that names the failure is allowed.
