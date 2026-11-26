import assert from "node:assert/strict";
import { test } from "node:test";
import { readBillingEntry, readReply } from "../../lib/billing-entry.ts";
import {
  billingAnnotation,
  billingNote,
  billingProviders,
  billingReportText,
  buildBillingReport,
  decimal,
  localZoneFrom,
  minuteStamp,
  sanitizeText,
  secondStamp,
  windowName,
} from "../../lib/billing-text.ts";
import { guidanceContent, type ModelGuidance } from "../../lib/model-guidance.ts";
import { entry, limit, model } from "./fakes.ts";
import { at, must } from "../support/must.ts";

const PRAGUE = "Europe/Prague";

const limits = (...value: unknown[]) => ({ limits: { state: "known", value } });
const balance = (...value: unknown[]) => ({ balance: { state: "known", value } });

function read(value: Record<string, unknown>) {
  const e = readBillingEntry(value);
  assert.ok(e);
  return e;
}

// ------------------------------------------------------------ zone and stamps

test("local zone: accepted names, unusable names fall back to UTC", () => {
  assert.equal(localZoneFrom("Europe/Prague"), "Europe/Prague");
  assert.equal(localZoneFrom("UTC"), "UTC");
  assert.equal(localZoneFrom("Etc/GMT+5"), "Etc/GMT+5");
  assert.equal(localZoneFrom("Not/AZone"), "UTC", "unknown to Intl");
  assert.equal(localZoneFrom("Europe/Prague\n"), "UTC");
  assert.equal(localZoneFrom("Europe Prague"), "UTC");
  assert.equal(localZoneFrom("a".repeat(65)), "UTC");
  assert.equal(localZoneFrom(""), "UTC");
  assert.equal(localZoneFrom(undefined), "UTC");
  assert.equal(localZoneFrom(42), "UTC");
});

test("minute stamp rounds up to the minute and shows UTC with local time and offset", () => {
  const t = Date.UTC(2026, 4, 14, 9, 0);
  assert.equal(minuteStamp(t, PRAGUE), "2026-05-14T09:00Z (11:00+02:00)");
  assert.equal(minuteStamp(t + 1, PRAGUE), "2026-05-14T09:01Z (11:01+02:00)");
  assert.equal(minuteStamp(t + 59_999, PRAGUE), "2026-05-14T09:01Z (11:01+02:00)");
  assert.equal(minuteStamp(t - 1, "UTC"), "2026-05-14T09:00Z (09:00+00:00)");
});

test("minute stamp: a local date differing from the UTC date is written in full", () => {
  const t = Date.UTC(2026, 4, 12, 23, 0);
  assert.equal(minuteStamp(t, PRAGUE), "2026-05-12T23:00Z (2026-05-13T01:00+02:00)");
  // West of UTC the local date is the earlier one.
  assert.equal(
    minuteStamp(Date.UTC(2026, 4, 12, 1, 30), "America/Los_Angeles"),
    "2026-05-12T01:30Z (2026-05-11T18:30-07:00)",
  );
  // Rounding up crosses the UTC midnight.
  assert.equal(
    minuteStamp(Date.UTC(2026, 4, 12, 23, 59, 30), "UTC"),
    "2026-05-13T00:00Z (00:00+00:00)",
  );
});

test("stamps use the offset in force at the instant itself (daylight-saving change)", () => {
  // Europe/Prague switches to summer time on 2026-03-29 at 01:00Z.
  assert.equal(
    minuteStamp(Date.UTC(2026, 2, 29, 0, 59), PRAGUE),
    "2026-03-29T00:59Z (01:59+01:00)",
  );
  assert.equal(minuteStamp(Date.UTC(2026, 2, 29, 1, 0), PRAGUE), "2026-03-29T01:00Z (03:00+02:00)");
  // A winter instant seen from a summer "now" keeps its own offset; the text depends on the instant only.
  assert.equal(
    secondStamp(Date.UTC(2026, 9, 25, 0, 59, 59), PRAGUE),
    "2026-10-25T00:59:59Z (2026-10-25T02:59:59+02:00)",
  );
  assert.equal(
    secondStamp(Date.UTC(2026, 9, 25, 1, 0, 0), PRAGUE),
    "2026-10-25T01:00:00Z (2026-10-25T02:00:00+01:00)",
  );
});

test("second stamp rounds down and always writes the local date", () => {
  const t = Date.UTC(2026, 4, 12, 20, 0, 30, 999);
  assert.equal(secondStamp(t, PRAGUE), "2026-05-12T20:00:30Z (2026-05-12T22:00:30+02:00)");
  assert.equal(secondStamp(0, "UTC"), "1970-01-01T00:00:00Z (1970-01-01T00:00:00+00:00)");
});

test("offsets with half hours, negative offsets, and truncation to whole minutes", () => {
  assert.equal(
    minuteStamp(Date.UTC(2026, 0, 1, 12, 0), "Asia/Kolkata"),
    "2026-01-01T12:00Z (17:30+05:30)",
  );
  assert.equal(
    minuteStamp(Date.UTC(2026, 0, 1, 12, 0), "America/St_Johns"),
    "2026-01-01T12:00Z (08:30-03:30)",
  );
});

// ------------------------------------------------------------ numbers and text

test("decimal rendering", () => {
  assert.equal(decimal(5, 3), "5");
  assert.equal(decimal(0.217, 3), "0.217");
  assert.equal(decimal(0.4349, 3), "0.435");
  assert.equal(decimal(1.2345678, 1), "1.2");
  assert.equal(decimal(0, 3), "0", "zero stays zero");
  assert.equal(decimal(0.0001, 3), "0.001", "a positive value never renders as 0");
  assert.equal(decimal(0.0004, 2), "0.01");
  assert.equal(decimal(0.04, 1), "0.1");
  assert.equal(decimal(-0.0001, 2), "0");
  assert.equal(
    decimal(-12.345, 2),
    "-12.35",
    "toFixed rounds the stored value; the render is its own",
  );
  assert.equal(decimal(123456.789, 2), "123456.79");
});

test("sanitized text", () => {
  assert.equal(sanitizeText("Max 5x"), "Max 5x");
  assert.equal(sanitizeText("  Pro   plan  "), "Pro plan");
  assert.equal(sanitizeText(`${"a".repeat(63)} b`), "a".repeat(63));
  assert.equal(sanitizeText("A<script>alert(1)</script>b"), "Ascriptalert(1)/scriptb");
  assert.equal(sanitizeText("line1\nline2\u0000x"), "line1line2x");
  assert.equal(sanitizeText("a:b;c,d"), "abcd");
  assert.equal(sanitizeText("a_b-c/d+e.f (g)"), "a_b-c/d+e.f (g)");
  assert.equal(sanitizeText("Über Plan 日本"), "Über Plan 日本");
  assert.equal(sanitizeText("!!!"), null);
  assert.equal(sanitizeText(""), null);
  assert.equal(sanitizeText("x".repeat(100)), "x".repeat(64));
  // A cut splitting an astral letter leaves no lone surrogate.
  assert.equal(sanitizeText(`${"x".repeat(63)}𝐀`), "x".repeat(63));
  assert.equal(sanitizeText(`${"x".repeat(62)}𝐀`), `${"x".repeat(62)}𝐀`);
});

test("billing providers: distinct and ascending, none filtered", () => {
  assert.deepEqual(billingProviders(["google", "anthropic", "google"]), ["anthropic", "google"]);
  assert.deepEqual(billingProviders(["x/y", "a b", "-x", "é"]), ["-x", "a b", "x/y", "é"]);
  assert.deepEqual(billingProviders([]), []);
});

test("window name", () => {
  const w = (windowSeconds: number | null, unit: string | null = null) =>
    windowName(
      at(
        read(entry({ limits: { state: "known", value: [limit({ windowSeconds, unit })] } })).limits,
        0,
      ),
    );
  assert.equal(w(null), "window");
  assert.equal(w(604_800), "7d");
  assert.equal(w(86_400), "1d");
  assert.equal(w(18_000), "5h");
  assert.equal(w(7200), "2h");
  assert.equal(w(5400), "90m");
  assert.equal(w(60), "1m");
  assert.equal(w(90), "90s");
  assert.equal(w(18_000, "tokens"), "5h tokens");
  assert.equal(w(18_000, "requests"), "5h requests");
  assert.equal(w(18_000, "credits"), "5h credits");
  assert.equal(w(18_000, "currency"), "5h spend");
  assert.equal(w(null, "tokens"), "window tokens");
  assert.equal(w(18_000, "percent"), "5h");
  assert.equal(w(18_000, "concurrent-requests"), "5h");
});

// ------------------------------------------------------------ annotation

test("annotation: price, schedule, and model-scoped windows", () => {
  const rec = (m: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    read(entry({ models: { m }, ...extra }));
  assert.equal(billingAnnotation(undefined, "m", PRAGUE), "");
  assert.equal(billingAnnotation(rec(model(5, 25)), "m", PRAGUE), " [$5/$25; unknown]");
  assert.equal(billingAnnotation(rec(model(0.5, null)), "m", PRAGUE), " [$0.5/$?; unknown]");
  assert.equal(billingAnnotation(rec(model(null, 3)), "m", PRAGUE), " [$?/$3; unknown]");
  assert.equal(
    billingAnnotation(rec(model(null, null)), "m", PRAGUE),
    " [unknown]",
    "no rate, no part",
  );
  assert.equal(
    billingAnnotation(rec(model(5, 25)), "other", PRAGUE),
    " [unknown]",
    "no record, no rates",
  );
  assert.equal(
    billingAnnotation(rec(model(5, 25, { source: "free" })), "m", PRAGUE),
    " [free; unknown]",
  );
  assert.equal(
    billingAnnotation(read(entry({ status: "free", models: { m: model(5, 25) } })), "m", PRAGUE),
    " [free]",
  );
  assert.equal(
    billingAnnotation(read(entry({ status: "free" })), "unlisted", PRAGUE),
    " [free]",
    "free state without a record",
  );
  const changesAt = Date.UTC(2026, 4, 13, 1, 0);
  const active = model(0.434, 0.87, { schedule: { multiplier: 0.5, active: true, changesAt } });
  assert.equal(
    billingAnnotation(rec(active), "m", PRAGUE),
    " [$0.217/$0.435 (×0.5) until 2026-05-13T01:00Z (03:00+02:00); unknown]",
  );
  const activeOpen = model(1, 2, { schedule: { multiplier: 2, active: true, changesAt: null } });
  assert.equal(billingAnnotation(rec(activeOpen), "m", PRAGUE), " [$2/$4 (×2); unknown]");
  const inactive = model(1, 2, { schedule: { multiplier: 0.5, active: false, changesAt } });
  assert.equal(
    billingAnnotation(rec(inactive), "m", PRAGUE),
    " [$1/$2, ×0.5 from 2026-05-13T01:00Z (03:00+02:00); unknown]",
  );
  const inactiveOpen = model(1, 2, {
    schedule: { multiplier: 0.5, active: false, changesAt: null },
  });
  assert.equal(billingAnnotation(rec(inactiveOpen), "m", PRAGUE), " [$1/$2; unknown]");
  // An active schedule scales only known rates.
  const partial = model(1, null, { schedule: { multiplier: 3, active: true, changesAt: null } });
  assert.equal(billingAnnotation(rec(partial), "m", PRAGUE), " [$3/$? (×3); unknown]");
});

test("annotation: at most two provider-wide window clauses, the first two in clause order", () => {
  const win = (severity: string, windowSeconds: number) =>
    limit({ models: null, severity, windowSeconds, resetsAt: null });
  const e = read(
    entry({
      models: { m: model(1, 2) },
      limits: {
        state: "known",
        value: [win("low", 18_000), win("critical", 604_800), win("exhausted", 86_400)],
      },
    }),
  );
  assert.equal(
    billingAnnotation(e, "m", "UTC"),
    " [$1/$2; exhausted; 1d exhausted; 7d critical]",
    "the third window, 5h low, is past the cap of two",
  );
});

test("annotation: model-scoped windows, first two in clause order, alarming and counted only", () => {
  const windows = [
    limit({
      models: ["m"],
      windowSeconds: 604_800,
      severity: "exhausted",
      resetsAt: Date.UTC(2026, 4, 14, 9),
    }),
    limit({ models: ["m"], windowSeconds: 18_000, severity: "low", resetsAt: null }),
    limit({
      models: ["m"],
      windowSeconds: 86_400,
      severity: "critical",
      resetsAt: Date.UTC(2026, 4, 13, 9),
    }),
    limit({ models: ["m"], windowSeconds: 1800, severity: "exhausted" }),
    limit({ models: ["m"], windowSeconds: 7200, severity: "ok" }),
    limit({ models: ["m"], windowSeconds: 7200, severity: "unknown" }),
    limit({ models: ["x"], windowSeconds: 7200, severity: "exhausted" }),
    limit({ models: null, windowSeconds: 7200, severity: "exhausted" }),
  ];
  const e = read(entry({ limits: { state: "known", value: windows } }));
  assert.equal(
    billingAnnotation(e, "m", PRAGUE),
    " [exhausted; 2h exhausted until 2026-05-12T23:00Z (2026-05-13T01:00+02:00); 7d exhausted until 2026-05-14T09:00Z (11:00+02:00); 1d critical until 2026-05-13T09:00Z (11:00+02:00)]",
  );
  assert.equal(billingAnnotation(e, "x", PRAGUE).startsWith(" [exhausted"), true);
  // Unavailable status: windows are not shown, price still is.
  const partialStatus = read(
    entry({
      status: "partial",
      limits: { state: "known", value: windows },
      models: { m: model(1, 2) },
    }),
  );
  assert.equal(
    billingAnnotation(partialStatus, "m", PRAGUE).startsWith(" [$1/$2; exhausted"),
    true,
  );
  const unavailable = read(
    entry({
      status: "unavailable",
      limits: { state: "known", value: windows },
      models: { m: model(1, 2) },
    }),
  );
  assert.equal(billingAnnotation(unavailable, "m", PRAGUE), " [$1/$2; unknown]");
});

test("window clause order: gravity, then name, then reset with null last", () => {
  const w = (name: number, severity: string, resetsAt: number | null) =>
    limit({ models: ["m"], windowSeconds: name, severity, resetsAt });
  const e = read(
    entry({
      limits: {
        state: "known",
        value: [
          w(18_000, "critical", null),
          w(18_000, "critical", Date.UTC(2026, 4, 13, 9)),
          w(7200, "critical", Date.UTC(2026, 4, 13, 9)),
          w(3600, "low", null),
        ],
      },
    }),
  );
  // Only the first two appear in the annotation.
  assert.equal(
    billingAnnotation(e, "m", "UTC"),
    " [unknown; 2h critical until 2026-05-13T09:00Z (09:00+00:00); 5h critical until 2026-05-13T09:00Z (09:00+00:00)]",
  );
});

// ------------------------------------------------------------ the spec example

const guidance: ModelGuidance = {
  entries: [
    {
      key: "anthropic/claude-opus-4-5:high",
      provider: "anthropic",
      id: "claude-opus-4-5",
      thinking: "high",
      when: "design and code review",
    },
    {
      key: "deepseek/deepseek-v4-pro",
      provider: "deepseek",
      id: "deepseek-v4-pro",
      when: "bulk refactors",
    },
    {
      key: "google/gemini-3-flash",
      provider: "google",
      id: "gemini-3-flash",
      when: "mechanical edits and searches",
    },
  ],
  rules: [],
};
const available = [
  // The keyed level is supported only while specs/model-string.md#thinking-precedence says so.
  { provider: "anthropic", id: "claude-opus-4-5", reasoning: true },
  { provider: "deepseek", id: "deepseek-v4-pro" },
  { provider: "google", id: "gemini-3-flash" },
];

function exampleEntries() {
  const okWindow = limit({ windowSeconds: 18_000, severity: "ok", resetsAt: null });
  return new Map([
    [
      "anthropic",
      read(
        entry({
          limits: {
            state: "known",
            value: [
              limit({
                models: ["claude-opus-4-5"],
                windowSeconds: 604_800,
                severity: "exhausted",
                resetsAt: Date.UTC(2026, 4, 14, 9),
              }),
              limit({ windowSeconds: 18_000, severity: "critical" }),
            ],
          },
          models: { "claude-opus-4-5": model(5, 25) },
        }),
      ),
    ],
    [
      "deepseek",
      read(
        entry({
          limits: { state: "known", value: [okWindow] },
          models: {
            "deepseek-v4-pro": model(0.434, 0.87, {
              schedule: { multiplier: 0.5, active: true, changesAt: Date.UTC(2026, 4, 13, 1) },
            }),
          },
        }),
      ),
    ],
    [
      "google",
      read(
        entry({
          limits: { state: "known", value: [okWindow] },
          models: { "gemini-3-flash": model(0.5, 3) },
        }),
      ),
    ],
  ]);
}

test("the guidance message of the specification's example, verbatim", () => {
  const text = guidanceContent(guidance, available, undefined, {
    zone: PRAGUE,
    entries: exampleEntries(),
  });
  assert.equal(
    text,
    [
      "Model billing:",
      "- anthropic/claude-opus-4-5:high: [$5/$25; critical; 5h critical until 2026-05-12T23:00Z (2026-05-13T01:00+02:00); 7d exhausted until 2026-05-14T09:00Z (11:00+02:00)]",
      "- deepseek/deepseek-v4-pro: [$0.217/$0.435 (×0.5) until 2026-05-13T01:00Z (03:00+02:00)]",
      "- google/gemini-3-flash: [$0.5/$3]",
      "",
      "Choose by stated use first; among models suited to a task, prefer the cheaper, counting a discount (×) while it lasts. Prices are USD per million input/output tokens; times UTC, local Europe/Prague in parentheses. Requests to an exhausted provider or model fail until its reset. Providers without limit data are marked unknown or untracked.",
    ].join("\n"),
  );
});

test("guidance without billing text carries no model lines", () => {
  const plain = guidanceContent(guidance, available, undefined);
  assert.equal(plain, "");
  assert.equal(
    guidanceContent(guidance, available, undefined, { zone: "UTC", entries: new Map() }),
    plain,
  );
  // Entries for providers that are not guided do not make billing text present.
  assert.equal(
    guidanceContent(guidance, available, undefined, {
      zone: "UTC",
      entries: new Map([["openai", read(entry())]]),
    }),
    plain,
  );
});

test("billing note is the single line of specs/billing.md#billing-note", () => {
  assert.equal(
    billingNote({ zone: "UTC", entries: new Map() }),
    "Choose by stated use first; among models suited to a task, prefer the cheaper, counting a discount (×) while it lasts. Prices are USD per million input/output tokens; times UTC, local UTC in parentheses. Requests to an exhausted provider or model fail until its reset. Providers without limit data are marked unknown or untracked.",
  );
  assert.equal(
    billingNote({ zone: PRAGUE, entries: new Map() }),
    "Choose by stated use first; among models suited to a task, prefer the cheaper, counting a discount (×) while it lasts. Prices are USD per million input/output tokens; times UTC, local Europe/Prague in parentheses. Requests to an exhausted provider or model fail until its reset. Providers without limit data are marked unknown or untracked.",
  );
});

// ------------------------------------------------------------ report

test("billing report: records, sanitization, filters, and text", () => {
  const e = read(
    entry({
      status: "partial",
      reason: "http-429",
      stale: true,
      plan: { state: "known", value: "Max <b>5x</b>" },
      balance: {
        state: "known",
        value: [{ amount: 12.345, currency: "USD", gatesUsage: true, severity: "low" }],
      },
      limits: {
        state: "known",
        value: [
          limit({
            label: "5 hour\nwindow!",
            used: 0.12345,
            limit: 1,
            percent: 12.34,
            models: ["claude-opus-4-5", "bad model", "x".repeat(129), "ok:v1/2"],
            severity: "low",
          }),
          limit({
            label: null,
            unit: "currency",
            currency: "USD",
            used: 1,
            limit: 10,
            percent: null,
            resetsAt: null,
            windowSeconds: null,
            severity: "ok",
          }),
          limit({ used: null, unit: null, percent: 50, resetsAt: null }),
        ],
      },
      models: {
        "claude-opus-4-5": model(5, 25, {
          schedule: { multiplier: 0.5, active: false, changesAt: Date.UTC(2026, 4, 13, 1) },
        }),
        "claude-haiku-4-5": model(1, 5),
        "not-listed": model(1, 1),
      },
    }),
  );
  const report = buildBillingReport(
    { zone: PRAGUE, entries: new Map([["anthropic", e]]) },
    ["anthropic", "google"],
    [
      { provider: "anthropic", id: "claude-opus-4-5" },
      { provider: "anthropic", id: "claude-haiku-4-5" },
      { provider: "anthropic", id: "claude-opus-4-5" },
      { provider: "anthropic", id: "no-record" },
      { provider: "google", id: "gemini" },
    ],
  );
  assert.ok(report);
  assert.equal(report.timeZone, PRAGUE);
  assert.equal(report.providers.length, 1);
  const r = at(report.providers, 0);
  assert.deepEqual(
    { ...r, balance: undefined, limits: undefined, models: undefined },
    {
      provider: "anthropic",
      state: "critical",
      status: "partial",
      reason: "http-429",
      capturedAt: Date.UTC(2026, 4, 12, 20, 0, 30),
      stale: true,
      plan: "Max b5x/b",
      balance: undefined,
      limits: undefined,
      models: undefined,
    },
  );
  assert.deepEqual(r.balance, [
    { amount: 12.345, currency: "USD", gatesUsage: true, severity: "low" },
  ]);
  assert.deepEqual(r.limits[0], {
    label: "5 hourwindow",
    unit: "percent",
    currency: null,
    percent: 12.34,
    used: 0.12345,
    limit: 1,
    resetsAt: Date.UTC(2026, 4, 12, 23),
    windowSeconds: 18_000,
    models: ["claude-opus-4-5", "ok:v1/2"],
    severity: "low",
  });
  assert.deepEqual(
    r.models.map((m) => m.model),
    ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-5"],
    "ascending, deduplicated, only with a record",
  );
  assert.deepEqual(r.models[1], {
    model: "anthropic/claude-opus-4-5",
    input: 5,
    output: 25,
    cacheRead: null,
    cacheWrite: null,
    schedule: { multiplier: 0.5, active: false, changesAt: Date.UTC(2026, 4, 13, 1) },
    severity: "ok",
  });
  assert.equal(at(r.models, 0).schedule, null);
  assert.equal(
    billingReportText(report),
    [
      "anthropic: critical; status partial; reason http-429; plan Max b5x/b; captured 2026-05-12T20:00:30Z (2026-05-12T22:00:30+02:00); stale",
      "  balance 12.35 USD low",
      "  limit 5 hourwindow: 12.3% (0.123/1 percent); resets 2026-05-12T23:00:00Z (2026-05-13T01:00:00+02:00); for claude-opus-4-5,ok:v1/2; low",
      "  limit ?: ?% (1/10 USD); ok",
      "  limit 5 hour: 50%; critical",
      "  anthropic/claude-haiku-4-5: $1/$5, cache $?/$?; ok",
      "  anthropic/claude-opus-4-5: $5/$25, cache $?/$?, ×0.5 from 2026-05-13T01:00:00Z (2026-05-13T03:00:00+02:00); ok",
    ].join("\n"),
  );
});

test("billing report: active schedule text, reason pattern, and no record", () => {
  const e = read(
    entry({
      reason: "Bad Reason!",
      models: {
        m: model(1, 2, {
          schedule: { multiplier: 2, active: true, changesAt: Date.UTC(2026, 0, 1) },
        }),
        n: model(1, 2, { schedule: { multiplier: 2, active: true, changesAt: null } }),
      },
    }),
  );
  const view = { zone: "UTC", entries: new Map([["p", e]]) };
  const report = buildBillingReport(
    view,
    ["p"],
    [
      { provider: "p", id: "m" },
      { provider: "p", id: "n" },
    ],
  );
  assert.ok(report);
  assert.equal(at(report.providers, 0).reason, null);
  assert.equal(
    billingReportText(report).split("\n").slice(1).join("\n"),
    [
      "  p/m: $1/$2, cache $?/$?, ×2 now until 2026-01-01T00:00:00Z (2026-01-01T00:00:00+00:00); ok",
      "  p/n: $1/$2, cache $?/$?, ×2 now; ok",
    ].join("\n"),
  );
  assert.equal(buildBillingReport(view, ["q"], []), null, "no entry, no record");
  assert.equal(buildBillingReport(view, [], []), null);
});

// ------------------------------------------------------------ purse-shaped replies

test("a reply built like purse's reads into the same entry", () => {
  const parsed = readReply(
    { protocol: 1, status: "ok", generatedAt: 5, providers: { a: entry() } },
    ["a"],
  );
  assert.ok(parsed);
  assert.equal(parsed.entries.get("a")?.plan, "Max");
});

// ------------------------------------------------------------ provider state (6.2 parts 2 to 4)

test("annotation: provider state follows the price and precedes window clauses", () => {
  const ann = (extra: Record<string, unknown>, id = "m") =>
    billingAnnotation(read(entry({ models: { m: model(1, 2) }, ...extra })), id, "UTC");
  const win = (extra: Record<string, unknown>) => limit({ resetsAt: null, ...extra });
  // Provider-wide exhaustion reaches every model line.
  assert.equal(ann(limits(win({ severity: "exhausted" }))), " [$1/$2; exhausted; 5h exhausted]");
  assert.equal(ann(limits(win({ severity: "exhausted" })), "other"), " [exhausted; 5h exhausted]");
  // Followed by a lesser model-scoped clause.
  assert.equal(
    ann(limits(win({ severity: "exhausted" }), win({ severity: "critical", models: ["m"] }))),
    " [$1/$2; exhausted; 5h exhausted; 5h critical]",
  );
  // A model-scoped window alone changes no provider state.
  assert.equal(
    ann(limits(win({ severity: "exhausted", models: ["m"] }))),
    " [$1/$2; unknown; 5h exhausted]",
  );
  // Gating balance counts; a non-gating one does not.
  const b = (gatesUsage: boolean) =>
    balance({ amount: 0, currency: "USD", gatesUsage, severity: "exhausted" });
  assert.equal(ann(b(true)), " [$1/$2; exhausted]");
  assert.equal(ann(b(false)), " [$1/$2; unknown]");
  // Windows shorter than an hour and other statuses are ignored; purse's model severity is not used.
  assert.equal(
    ann(limits(win({ severity: "exhausted", windowSeconds: 600 }))),
    " [$1/$2; unknown]",
  );
  assert.equal(
    ann({ status: "unavailable", ...limits(win({ severity: "exhausted" })) }),
    " [$1/$2; unknown]",
  );
  assert.equal(
    ann({ models: { m: { ...model(1, 2), severity: "exhausted" } } }),
    " [$1/$2; unknown]",
  );
  assert.equal(
    ann(limits(win({ severity: "exhausted", models: ["x"] }))),
    " [$1/$2; unknown]",
    "another model's window",
  );
  assert.equal(
    ann({ status: "partial", ...limits(win({ severity: "exhausted" })) }),
    " [$1/$2; exhausted; 5h exhausted]",
  );
});

// ------------------------------------------------------------ report limit line (7)

test("report limit line: usage with a missing limit, and the models of a scoped window", () => {
  const e = read(
    entry(
      limits(
        limit({ used: 12.5, limit: null, percent: null, resetsAt: null, models: ["a", "b"] }),
        limit({
          used: null,
          limit: 10,
          percent: 5,
          resetsAt: Date.UTC(2026, 4, 12, 23),
          models: [],
        }),
        limit({ used: 0, limit: 0, percent: 0, resetsAt: null, unit: null, models: null }),
      ),
    ),
  );
  const report = buildBillingReport({ zone: "UTC", entries: new Map([["p", e]]) }, ["p"], []);
  assert.deepEqual(billingReportText(must(report)).split("\n").slice(1), [
    "  limit 5 hour: ?% (12.5/? percent); for a,b; critical",
    "  limit 5 hour: 5%; resets 2026-05-12T23:00:00Z (2026-05-12T23:00:00+00:00); critical",
    "  limit 5 hour: 0% (0/0); critical",
  ]);
});
