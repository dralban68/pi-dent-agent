import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BillingEntry,
  MAX_INSTANT,
  providerState,
  readBillingEntry,
  readReply,
} from "../../lib/billing-entry.ts";
import { entry, limit, model, reply } from "./fakes.ts";
import { at, must } from "../support/must.ts";

function read(value: unknown): BillingEntry {
  const e = readBillingEntry(value);
  assert.ok(e, "entry is valid");
  return e;
}

const limits = (...value: unknown[]) => ({ limits: { state: "known", value } });
const balance = (...value: unknown[]) => ({ balance: { state: "known", value } });

// ------------------------------------------------------------ reply

test("reply validity (Section 2.1)", () => {
  const ok = reply({ a: entry() });
  assert.ok(readReply(ok, ["a"]));
  assert.equal(readReply(null, ["a"]), undefined);
  assert.equal(readReply("ok", ["a"]), undefined);
  assert.equal(readReply([], ["a"]), undefined);
  assert.equal(readReply({ ...ok, protocol: 2 }, ["a"]), undefined);
  assert.equal(readReply({ ...ok, protocol: "1" }, ["a"]), undefined);
  assert.equal(readReply({ ...ok, status: "refresh" }, ["a"]), undefined);
  assert.equal(readReply({ ...ok, status: undefined }, ["a"]), undefined);
  assert.equal(readReply({ ...ok, generatedAt: Number.NaN }, ["a"]), undefined);
  assert.equal(readReply({ ...ok, generatedAt: Infinity }, ["a"]), undefined);
  assert.equal(readReply({ ...ok, generatedAt: "1" }, ["a"]), undefined);
  assert.equal(readReply({ ...ok, generatedAt: undefined }, ["a"]), undefined);
  assert.equal(readReply({ ...ok, providers: [] }, ["a"]), undefined);
  assert.equal(readReply({ ...ok, providers: null }, ["a"]), undefined);
  assert.equal(readReply({ ...ok, providers: undefined }, ["a"]), undefined);
  for (const status of ["ok", "not-ready", "bad-request", "cancelled"]) {
    assert.equal(readReply({ ...ok, status }, ["a"])?.status, status);
  }
  assert.equal(
    readReply({ ...ok, extra: { deep: [] } }, ["a"])?.status,
    "ok",
    "unknown fields ignored",
  );
});

test("unknown fields are ignored at every reply level, without a diagnostic", () => {
  const noisy = readReply(
    reply(
      {
        a: entry({
          unknown: { deep: [1, 2] },
          plan: { state: "known", value: "Max", unknown: "x" },
          limits: { state: "known", unknown: 1, value: [limit({ unknown: "y" })] },
          models: { m: model(1, 2, { unknown: 3 }) },
        }),
        unknownProvider: "ignored",
      },
      { unknown: 4 },
    ),
    ["a"],
  );
  assert.equal(noisy?.status, "ok");
  assert.equal(noisy?.entries.get("a")?.plan, "Max");
  assert.deepEqual([...(noisy?.entries.keys() ?? [])], ["a"]);
});

test("only requested providers with valid entries are read; other statuses carry none", () => {
  const r = readReply(
    reply({ a: entry(), b: entry(), c: "nope", d: [], e: { status: 5 }, f: null }),
    ["a", "c", "d", "e", "f", "missing"],
  );
  assert.ok(r);
  assert.deepEqual([...r.entries.keys()], ["a"]);
  const notReady = readReply(reply({ a: entry() }, { status: "not-ready" }), ["a"]);
  assert.equal(notReady?.entries.size, 0);
});

test("a provider key that is an Object.prototype name is not read from the prototype", () => {
  const r = readReply(reply({}), ["constructor", "toString", "__proto__"]);
  assert.equal(r?.entries.size, 0);
});

// ------------------------------------------------------------ entry

test("entry: status must be a string; unknown strings become unavailable", () => {
  assert.equal(readBillingEntry(entry({ status: 1 })), undefined);
  assert.equal(readBillingEntry(entry({ status: undefined })), undefined);
  assert.equal(readBillingEntry(entry({ status: null })), undefined);
  assert.equal(readBillingEntry(null), undefined);
  assert.equal(readBillingEntry([]), undefined);
  assert.equal(readBillingEntry("ok"), undefined);
  assert.equal(read(entry({ status: "brand-new" })).status, "unavailable");
  for (const status of [
    "unknown-provider",
    "free",
    "no-adapter",
    "ok",
    "partial",
    "unavailable",
    "not-collected",
  ]) {
    assert.equal(read(entry({ status })).status, status);
  }
});

test("entry: reason, capturedAt, stale, plan read as stated, else defaults", () => {
  const e = read(
    entry({ reason: 5, capturedAt: "x", stale: "yes", plan: { state: "known", value: 3 } }),
  );
  assert.equal(e.reason, null);
  assert.equal(e.capturedAt, null);
  assert.equal(e.stale, false);
  assert.equal(e.plan, null);
  assert.equal(read(entry({ reason: "offline" })).reason, "offline");
  assert.equal(read(entry({ stale: true })).stale, true);
  assert.equal(read(entry({ plan: { state: "unavailable", reason: "x" } })).plan, null);
  assert.equal(read(entry({ plan: "Max" })).plan, null);
  assert.equal(read(entry({ plan: { state: "known" } })).plan, null);
});

test("dates: finite and within 0 to 253 370 764 800 000 inclusive, else null", () => {
  const readAt = (capturedAt: unknown) => read(entry({ capturedAt })).capturedAt;
  assert.equal(readAt(0), 0);
  assert.equal(readAt(MAX_INSTANT), MAX_INSTANT);
  assert.equal(readAt(253_370_764_800_000), 253_370_764_800_000);
  assert.equal(readAt(MAX_INSTANT + 1), null);
  assert.equal(readAt(-1), null);
  assert.equal(readAt(Number.NaN), null);
  assert.equal(readAt(Infinity), null);
  assert.equal(readAt(-Infinity), null);
  assert.equal(readAt(1e300), null);
  assert.equal(readAt("1000"), null);
  assert.equal(readAt(null), null);
  assert.equal(readAt({}), null);
  const reset = (resetsAt: unknown) =>
    at(read(entry(limits(limit({ resetsAt })))).limits, 0).resetsAt;
  assert.equal(reset(MAX_INSTANT), MAX_INSTANT);
  assert.equal(reset(MAX_INSTANT + 1), null);
  assert.equal(reset(-5), null);
  assert.equal(reset(Number.NaN), null);
  const changes = (changesAt: unknown) => {
    const m = must(
      read(
        entry({ models: { m: model(1, 1, { schedule: { multiplier: 2, changesAt } }) } }),
      ).models.get("m"),
    );
    return must(m.schedule).changesAt;
  };
  assert.equal(changes(MAX_INSTANT), MAX_INSTANT);
  assert.equal(changes(MAX_INSTANT + 1), null);
  assert.equal(changes(-1), null);
});

test("balance items: amount and currency required; other fields default", () => {
  const e = read(
    entry(
      balance(
        { amount: 5, currency: "USD", gatesUsage: true, severity: "low" },
        { amount: Number.NaN, currency: "USD" },
        { amount: Infinity, currency: "USD" },
        { amount: "5", currency: "USD" },
        { amount: 5, currency: "usd" },
        { amount: 5, currency: "USDX" },
        { amount: 5, currency: "US" },
        { amount: 5, currency: "USD\n" },
        { amount: 5 },
        "str",
        null,
        [],
        { amount: -2.5, currency: "EUR", gatesUsage: "true", severity: "weird" },
      ),
    ),
  );
  assert.deepEqual(e.balance, [
    { amount: 5, currency: "USD", gatesUsage: true, severity: "low" },
    { amount: -2.5, currency: "EUR", gatesUsage: false, severity: "unknown" },
  ]);
  assert.deepEqual(read(entry({ balance: { state: "known", value: "x" } })).balance, []);
  assert.deepEqual(read(entry({ balance: { state: "not-exposed" } })).balance, []);
  assert.deepEqual(read(entry({ balance: [] })).balance, []);
});

test("limit windows: field shapes, defaults, and dropping", () => {
  const e = read(
    entry(
      limits(
        limit({
          label: 5,
          unit: "bananas",
          used: Number.NaN,
          limit: "10",
          percent: -1,
          resetsAt: "soon",
          currency: "usd",
          windowSeconds: 1.5,
          severity: 3,
        }),
        limit({ percent: Infinity, windowSeconds: 0 }),
        limit({ percent: 0, windowSeconds: -60 }),
        limit({ windowSeconds: "60" }),
        limit({
          windowSeconds: Number.MAX_SAFE_INTEGER,
          unit: "concurrent-requests",
          currency: "EUR",
        }),
        limit({ models: undefined }),
        limit({ models: "m" }),
        limit({ models: ["m", 5] }),
        limit({ models: {} }),
        "str",
        null,
        [],
      ),
    ),
  );
  assert.equal(e.limits.length, 5, "windows without models of the allowed shape are dropped");
  assert.deepEqual(e.limits[0], {
    label: null,
    unit: null,
    used: null,
    limit: null,
    percent: null,
    resetsAt: null,
    currency: null,
    windowSeconds: null,
    models: null,
    severity: "unknown",
  });
  assert.equal(at(e.limits, 1).percent, null);
  assert.equal(at(e.limits, 1).windowSeconds, null);
  assert.equal(at(e.limits, 2).percent, 0);
  assert.equal(at(e.limits, 2).windowSeconds, null);
  assert.equal(at(e.limits, 3).windowSeconds, null);
  assert.equal(at(e.limits, 4).windowSeconds, Number.MAX_SAFE_INTEGER);
  assert.equal(at(e.limits, 4).unit, "concurrent-requests");
  assert.equal(at(e.limits, 4).currency, "EUR");
  assert.deepEqual(at(read(entry(limits(limit({ models: ["a", "b"] })))).limits, 0).models, [
    "a",
    "b",
  ]);
  assert.deepEqual(read(entry({ limits: { state: "known", value: {} } })).limits, []);
});

test("model records: rates in [0, 1 000 000), schedule fields, severity", () => {
  const rates = (r: Record<string, unknown>) =>
    must(read(entry({ models: { m: { price: { rates: r } } } })).models.get("m"));
  const m = rates({ input: 0, output: 999_999.5, cacheRead: 1_000_000, cacheWrite: -1 });
  assert.equal(m.input, 0);
  assert.equal(m.output, 999_999.5);
  assert.equal(m.cacheRead, null);
  assert.equal(m.cacheWrite, null);
  const bad = rates({ input: Number.NaN, output: Infinity, cacheRead: "1", cacheWrite: null });
  assert.deepEqual(
    [bad.input, bad.output, bad.cacheRead, bad.cacheWrite],
    [null, null, null, null],
  );
  assert.equal(bad.source, null);
  assert.equal(bad.schedule, null);
  assert.equal(bad.severity, "unknown");

  const sched = (schedule: unknown) =>
    must(read(entry({ models: { m: { price: { schedule } } } })).models.get("m")).schedule;
  assert.deepEqual(sched({ multiplier: 0.5, active: true, changesAt: 5 }), {
    multiplier: 0.5,
    active: true,
    changesAt: 5,
  });
  assert.deepEqual(sched({ multiplier: 2, active: "true" }), {
    multiplier: 2,
    active: false,
    changesAt: null,
  });
  assert.equal(sched({ multiplier: 0, active: true }), null);
  assert.equal(sched({ multiplier: -1 }), null);
  assert.equal(sched({ multiplier: Number.NaN }), null);
  assert.equal(sched({ multiplier: Infinity }), null);
  assert.equal(sched({ multiplier: "2" }), null);
  assert.equal(sched({ active: true }), null);
  assert.equal(sched("x"), null);

  const odd = read(
    entry({
      models: { a: "x", b: null, c: [], d: 5, e: model(1, 2, { source: 7 }), f: model(1, 2) },
    }),
  );
  assert.deepEqual([...odd.models.keys()], ["e", "f"], "non-object records are dropped");
  assert.equal(must(odd.models.get("e")).source, null);
  assert.equal(must(odd.models.get("f")).source, "inventory");
  assert.deepEqual([...read(entry({ models: [] })).models.keys()], []);
  assert.deepEqual([...read(entry({ models: "x" })).models.keys()], []);
});

test("model ids that are prototype names are plain keys", () => {
  const e = read(
    entry({
      models: JSON.parse('{"__proto__": {"price":{"rates":{"input":1}}}, "constructor": {}}'),
    }),
  );
  assert.equal(must(e.models.get("__proto__")).input, 1);
  assert.ok(e.models.has("constructor"));
  assert.equal(e.models.has("toString"), false);
});

test("hostile objects: a throwing getter makes the reply unreadable, never a throw out of the client", () => {
  const hostile = reply({});
  Object.defineProperty(hostile, "providers", {
    get() {
      throw new Error("boom");
    },
  });
  assert.throws(() => readReply(hostile, ["a"]));
});

test("oversized arrays are read in full without error", () => {
  const many = Array.from({ length: 20_000 }, (_, i) => limit({ windowSeconds: 3600 + i }));
  const e = read(entry(limits(...many)));
  assert.equal(e.limits.length, 20_000);
});

// ------------------------------------------------------------ provider state

test("provider state by status", () => {
  assert.equal(providerState(read(entry({ status: "free" }))), "free");
  assert.equal(providerState(read(entry({ status: "no-adapter" }))), "untracked");
  assert.equal(providerState(read(entry({ status: "unknown-provider" }))), "untracked");
  assert.equal(providerState(read(entry({ status: "unavailable" }))), "unknown");
  assert.equal(providerState(read(entry({ status: "not-collected" }))), "unknown");
  assert.equal(providerState(read(entry({ status: "weird" }))), "unknown");
  assert.equal(providerState(read(entry())), "unknown", "ok without data has no gravity");
});

test("provider state of ok and partial: gravest of gating balances and counted unscoped windows", () => {
  const state = (status: string, extra: Record<string, unknown>) =>
    providerState(read(entry({ status, ...extra })));
  const win = (severity: string, extra: Record<string, unknown> = {}) =>
    limit({ severity, ...extra });
  assert.equal(state("ok", limits(win("ok"))), "ok");
  assert.equal(state("partial", limits(win("low"), win("ok"))), "low");
  assert.equal(state("ok", limits(win("exhausted"), win("critical"))), "exhausted");
  assert.equal(state("ok", limits(win("unknown"), win("ok"))), "ok", "unknown has no gravity");
  assert.equal(state("ok", limits(win("unknown"))), "unknown");
  assert.equal(
    state("ok", limits(win("exhausted", { windowSeconds: 3599 }))),
    "unknown",
    "short windows do not count",
  );
  assert.equal(state("ok", limits(win("exhausted", { windowSeconds: 3600 }))), "exhausted");
  assert.equal(state("ok", limits(win("exhausted", { windowSeconds: null }))), "exhausted");
  assert.equal(
    state("ok", limits(win("exhausted", { models: ["m"] }), win("ok"))),
    "ok",
    "scoped windows do not count",
  );
  const b = (gatesUsage: boolean, severity: string) => ({
    amount: 1,
    currency: "USD",
    gatesUsage,
    severity,
  });
  assert.equal(state("ok", balance(b(true, "critical"))), "critical");
  assert.equal(
    state("ok", balance(b(false, "exhausted"))),
    "unknown",
    "non-gating balance does not count",
  );
  assert.equal(state("ok", { ...balance(b(true, "low")), ...limits(win("critical")) }), "critical");
});
