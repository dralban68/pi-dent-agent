import assert from "node:assert/strict";
import { test } from "node:test";
import { BillingService, startQuery } from "../../lib/billing.ts";
import type { Diagnostic } from "../../lib/util.ts";
import { FakeBus, FakePurse, FakeTimers, NOW, entry, limit, model, reply, tick } from "./fakes.ts";
import { at, must } from "../support/must.ts";

// ------------------------------------------------------------ client

test("request: only providers, mode, and respond; providers copied", () => {
  const bus = new FakeBus();
  const purse = new FakePurse(bus);
  const providers = ["a", "b"];
  startQuery(bus, providers, "auto", new FakeTimers());
  const [request] = purse.seen;
  const req = must(request);
  assert.deepEqual(Object.keys(req).toSorted(), ["mode", "providers", "respond"]);
  assert.deepEqual(req.providers, ["a", "b"]);
  assert.notEqual(req.providers, providers);
  assert.equal(req.mode, "auto");
  assert.equal(typeof req.respond, "function");
});

test("respond returns true on its first call and false afterwards", () => {
  const bus = new FakeBus();
  bus.on("purse:query:v1", (data) => {
    const { respond } = data as { respond: (r: unknown) => boolean };
    assert.equal(respond(Promise.resolve(reply({}))), true);
    assert.equal(respond(Promise.resolve(reply({}))), false);
    assert.equal(respond(Promise.resolve(reply({}))), false);
  });
  startQuery(bus, ["a"], "cached", new FakeTimers());
});

test("no-service: nobody responds, or emit throws before respond", async () => {
  const timers = new FakeTimers();
  const q = startQuery(new FakeBus(), ["a"], "cached", timers);
  assert.deepEqual(q.immediate, { status: "no-service" });
  assert.deepEqual(await q.outcome, { status: "no-service" });
  assert.equal(timers.count, 0, "no timer for an unanswered query");

  const throwing = new FakeBus();
  throwing.on("purse:query:v1", () => {
    throw new Error("listener failed");
  });
  assert.deepEqual(startQuery(throwing, ["a"], "cached", timers).immediate, {
    status: "no-service",
  });

  const bus = {
    emit: () => {
      throw new Error("emit failed");
    },
    on: () => () => {},
  };
  assert.deepEqual(startQuery(bus, ["a"], "cached", timers).immediate, { status: "no-service" });
});

test("a respond call after emit returned is refused and the outcome stays no-service", async () => {
  const bus = new FakeBus();
  let late: ((r: unknown) => boolean) | undefined;
  bus.on("purse:query:v1", (data) => {
    late = (data as { respond: (r: unknown) => boolean }).respond;
  });
  const q = startQuery(bus, ["a"], "cached", new FakeTimers());
  assert.deepEqual(await q.outcome, { status: "no-service" });
  assert.equal(must(late)(Promise.resolve(reply({}))), false);
});

test("invalid: the argument is not a thenable, the promise rejects, or the reply is invalid", async () => {
  const outcomeOf = async (offer: unknown) => {
    const bus = new FakeBus();
    bus.on("purse:query:v1", (data) =>
      (data as { respond: (r: unknown) => boolean }).respond(offer),
    );
    return (await startQuery(bus, ["a"], "cached", new FakeTimers()).outcome).status;
  };
  assert.equal(await outcomeOf(undefined), "invalid");
  assert.equal(await outcomeOf(null), "invalid");
  assert.equal(await outcomeOf(reply({})), "invalid", "an object without then");
  // oxlint-disable-next-line unicorn/no-thenable
  assert.equal(await outcomeOf({ then: 5 }), "invalid");
  assert.equal(await outcomeOf("text"), "invalid");
  assert.equal(await outcomeOf(Promise.reject(new Error("no"))), "invalid");
  assert.equal(await outcomeOf(Promise.resolve(null)), "invalid");
  assert.equal(
    await outcomeOf(Promise.resolve({ protocol: 2, status: "ok", generatedAt: 1, providers: {} })),
    "invalid",
  );
  assert.equal(
    await outcomeOf(
      Promise.resolve({ protocol: 1, status: "ok", generatedAt: "1", providers: {} }),
    ),
    "invalid",
  );
  assert.equal(
    await outcomeOf({
      // oxlint-disable-next-line unicorn/no-thenable
      then: () => {
        throw new Error("then threw");
      },
    }),
    "invalid",
  );
  const throwingGetter = {};
  // oxlint-disable-next-line unicorn/no-thenable
  Object.defineProperty(throwingGetter, "then", {
    get() {
      throw new Error("getter");
    },
  });
  assert.equal(await outcomeOf(throwingGetter), "invalid");
  const badReply = reply({});
  Object.defineProperty(badReply, "providers", {
    get() {
      throw new Error("getter");
    },
  });
  assert.equal(await outcomeOf(Promise.resolve(badReply)), "invalid");
  // A thenable calling back several times counts once.
  const twice = {
    // oxlint-disable-next-line unicorn/no-thenable
    then: (ok: (v: unknown) => void) => {
      ok(reply({}));
      ok(null);
    },
  };
  assert.equal(await outcomeOf(twice), "ok");
});

test("the outcome is the reply status", async () => {
  for (const status of ["ok", "not-ready", "bad-request", "cancelled"]) {
    const bus = new FakeBus();
    new FakePurse(bus).answer = () => reply({}, { status });
    assert.equal((await startQuery(bus, ["a"], "cached", new FakeTimers()).outcome).status, status);
  }
});

test("timeout: 25 000 ms after the offer; a later settlement is ignored", async () => {
  const bus = new FakeBus();
  const purse = new FakePurse(bus);
  purse.mode = "manual";
  const timers = new FakeTimers();
  const q = startQuery(bus, ["a"], "auto", timers);
  assert.equal(q.immediate, undefined);
  let settled: string | undefined;
  void q.outcome.then((o) => (settled = o.status));
  timers.advance(24_999);
  await tick();
  assert.equal(settled, undefined);
  timers.advance(1);
  await tick();
  assert.equal(settled, "timeout");
  at(purse.open, 0)(reply({ a: entry() }));
  await tick();
  assert.equal(settled, "timeout");
});

test("a reply before the deadline clears the timer", async () => {
  const bus = new FakeBus();
  const timers = new FakeTimers();
  const q = startQuery(bus, ["a"], "cached", timers);
  assert.equal(q.immediate?.status, "no-service");
  const purse = new FakePurse(bus);
  const q2 = startQuery(bus, ["a"], "cached", timers);
  assert.equal(timers.count, 1);
  assert.equal((await q2.outcome).status, "ok");
  assert.equal(timers.count, 0);
  assert.equal(purse.seen.length, 1);
});

// ------------------------------------------------------------ held billing

function service(options: { providers?: string[] } = {}) {
  const bus = new FakeBus();
  const purse = new FakePurse(bus);
  const timers = new FakeTimers();
  let providers = options.providers ?? ["anthropic", "google"];
  const svc = new BillingService({
    bus,
    guidanceProviders: () => providers,
    timeZone: "UTC",
    timers,
    now: () => NOW,
  });
  return { bus, purse, timers, svc, setProviders: (p: string[]) => (providers = p) };
}

test("construction subscribes to purse:changed:v1 once; close unsubscribes", () => {
  const { bus, svc } = service();
  assert.equal(bus.listenerCount("purse:changed:v1"), 1);
  svc.close();
  assert.equal(bus.listenerCount("purse:changed:v1"), 0);
});

test("an ok outcome replaces held entries for requested providers only", async () => {
  const { purse, svc } = service();
  purse.answer = () =>
    reply({
      anthropic: entry({ plan: { state: "known", value: "A" } }),
      google: "broken",
      openai: entry(),
    });
  await svc.cachedQueryWait(["anthropic", "google"]);
  await tick();
  assert.equal(svc.holds(["anthropic"]), true);
  assert.equal(svc.holds(["google"]), false, "an invalid entry is treated as absent");
  assert.equal(svc.holds(["openai"]), false, "an unrequested provider is not stored");
  assert.equal(svc.view().entries.get("anthropic")?.plan, "A");
});

test("ordering by generatedAt: an older reply never replaces a newer entry; equal replaces", async () => {
  const { purse, svc } = service();
  const plan = (v: string) => ({ plan: { state: "known", value: v } });
  const run = async (generatedAt: number, v: string) => {
    purse.answer = () => reply({ anthropic: entry(plan(v)) }, { generatedAt });
    await svc.cachedQueryWait(["anthropic"]);
    await tick();
    return svc.view().entries.get("anthropic")?.plan;
  };
  assert.equal(await run(100, "first"), "first");
  assert.equal(await run(50, "older"), "first");
  assert.equal(await run(100, "same"), "same");
  assert.equal(await run(200, "newer"), "newer");
  assert.equal(await run(199, "stale"), "newer");
});

test("ordering is per provider", async () => {
  const { purse, svc } = service();
  purse.answer = () => reply({ anthropic: entry({ stale: true }) }, { generatedAt: 100 });
  await svc.cachedQueryWait(["anthropic"]);
  purse.answer = () => reply({ anthropic: entry(), google: entry() }, { generatedAt: 50 });
  await svc.cachedQueryWait(["anthropic", "google"]);
  await tick();
  assert.equal(svc.view().entries.get("anthropic")?.stale, true);
  assert.equal(svc.holds(["google"]), true);
});

test("non-ok outcomes never change held billing and held billing is never cleared", async () => {
  const { purse, svc } = service();
  purse.answer = () => reply({ anthropic: entry() });
  await svc.cachedQueryWait(["anthropic"]);
  for (const status of ["not-ready", "bad-request", "cancelled"]) {
    purse.answer = () =>
      reply({ anthropic: entry({ stale: true }) }, { status, generatedAt: 9999 });
    await svc.cachedQueryWait(["anthropic"]);
  }
  purse.answer = () => null;
  await svc.cachedQueryWait(["anthropic"]);
  purse.answer = () => reply({}, { generatedAt: 99_999 });
  await svc.cachedQueryWait(["anthropic"]);
  await tick();
  assert.equal(svc.view().entries.get("anthropic")?.stale, false);
});

// ------------------------------------------------------------ poll

test("a poll is an auto query for the guidance providers; none while one is pending", async () => {
  const { purse, svc, timers } = service();
  purse.mode = "manual";
  svc.startPoll();
  svc.startPoll();
  svc.startPoll();
  assert.equal(purse.seen.length, 1, "no second poll while one is pending");
  assert.equal(at(purse.seen, 0).mode, "auto");
  assert.deepEqual(at(purse.seen, 0).providers, ["anthropic", "google"]);
  assert.ok(svc.pendingPoll());
  at(purse.open, 0)(reply({ anthropic: entry() }));
  await svc.pendingPoll();
  assert.equal(svc.pendingPoll(), undefined);
  assert.equal(svc.holds(["anthropic"]), true);
  svc.startPoll();
  assert.equal(
    purse.seen.length,
    2,
    "a new poll once the previous one settled; no minimum interval",
  );
  timers.advance(100_000);
  svc.startPoll();
  assert.equal(purse.seen.length, 2);
});

test("a poll is not due without guidance billing providers, and an unanswered poll is not pending", () => {
  const empty = service({ providers: [] });
  empty.svc.startPoll();
  assert.equal(empty.purse.seen.length, 0);
  const odd = service({ providers: ["bad provider", "x/y"] });
  odd.svc.startPoll();
  assert.deepEqual(
    at(odd.purse.seen, 0).providers,
    ["bad provider", "x/y"],
    "every provider is requested",
  );

  const bus = new FakeBus();
  const svc = new BillingService({
    bus,
    guidanceProviders: () => ["a"],
    timeZone: "UTC",
    timers: new FakeTimers(),
  });
  svc.startPoll();
  assert.equal(svc.pendingPoll(), undefined, "no-service is known at once");
  assert.equal(bus.requests().length, 1);
  svc.startPoll();
  assert.equal(bus.requests().length, 2, "no retry beyond the occasions of Section 4.2");
});

test("a throwing guidance provider getter is treated as no providers, and reported", () => {
  const bus = new FakeBus();
  const purse = new FakePurse(bus);
  const diagnostics: Diagnostic[] = [];
  const svc = new BillingService({
    bus,
    guidanceProviders: () => {
      throw new Error("ctx is stale");
    },
    timeZone: "UTC",
    diagnostics: (diagnostic) => diagnostics.push(diagnostic),
  });
  svc.startPoll();
  bus.notify(["a"]);
  assert.equal(purse.seen.length, 0);
  assert.equal(diagnostics.length, 2, "one per failed read: the poll and the notification");
  assert.equal(at(diagnostics, 0).level, "warning");
  svc.close();
});

test("a change subscription the host refuses is reported as one diagnostic", () => {
  const diagnostics: Diagnostic[] = [];
  const bus = new FakeBus();
  const svc = new BillingService({
    bus: {
      emit: (channel, data) => bus.emit(channel, data),
      on: () => {
        throw new Error("the bus is closed");
      },
    },
    guidanceProviders: () => ["a"],
    timeZone: "UTC",
    diagnostics: (diagnostic) => diagnostics.push(diagnostic),
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(at(diagnostics, 0).level, "warning");
  svc.startPoll();
  assert.equal(bus.requests().length, 1, "queries still run without change notifications");
});

test("a change subscription that cannot be cancelled is reported as one diagnostic", () => {
  const diagnostics: Diagnostic[] = [];
  const bus = new FakeBus();
  const svc = new BillingService({
    bus: {
      emit: (channel, data) => bus.emit(channel, data),
      on: () => () => {
        throw new Error("the bus is gone");
      },
    },
    guidanceProviders: () => ["a"],
    timeZone: "UTC",
    diagnostics: (diagnostic) => diagnostics.push(diagnostic),
  });
  assert.equal(diagnostics.length, 0, "nothing to report while the subscription is live");
  svc.close();
  assert.equal(diagnostics.length, 1);
  assert.equal(at(diagnostics, 0).level, "warning");
});

// ------------------------------------------------------------ change notifications (2.3)

test("change notifications: guidance providers join the waiting set; one query at a time, coalesced", async () => {
  const { bus, purse, svc } = service();
  purse.mode = "manual";
  bus.notify(["anthropic", "openai", 5, null]);
  assert.equal(purse.seen.length, 1);
  assert.equal(at(purse.seen, 0).mode, "cached");
  assert.deepEqual(at(purse.seen, 0).providers, ["anthropic"], "only guidance providers");
  bus.notify(["google"]);
  bus.notify(["google", "anthropic"]);
  bus.notify(["anthropic"]);
  assert.equal(purse.seen.length, 1, "no second query while one is pending");
  at(purse.open, 0)(reply({ anthropic: entry() }));
  await tick();
  assert.equal(purse.seen.length, 2);
  assert.deepEqual(at(purse.seen, 1).providers, ["anthropic", "google"], "the waiting set, once");
  at(purse.open, 1)(reply({ anthropic: entry(), google: entry() }));
  await tick();
  assert.equal(purse.seen.length, 2, "an emptied waiting set starts nothing");
  assert.equal(svc.holds(["anthropic", "google"]), true);
});

test("malformed change notifications are ignored", () => {
  const { bus, purse } = service();
  for (const payload of [
    null,
    undefined,
    "x",
    5,
    [],
    {},
    { providers: "anthropic" },
    { providers: {} },
    { providers: [] },
    { providers: [1, {}] },
    { providers: ["openai"] },
  ]) {
    bus.emit("purse:changed:v1", payload);
  }
  assert.equal(purse.seen.length, 0);
});

test("a cached query from a change notification with no service or a failing outcome is not retried", async () => {
  const bus = new FakeBus();
  const svc = new BillingService({
    bus,
    guidanceProviders: () => ["a"],
    timeZone: "UTC",
    timers: new FakeTimers(),
  });
  bus.notify(["a"]);
  await tick();
  assert.equal(bus.requests().length, 1);
  await tick();
  assert.equal(bus.requests().length, 1);
  svc.close();
});

// ------------------------------------------------------------ cached query (4.3)

test("a guidance computation's cached query is awaited for at most 500 ms; a late outcome still applies", async () => {
  const { purse, svc, timers } = service();
  purse.mode = "manual";
  let done = false;
  void svc.cachedQueryWait(["anthropic"]).then(() => (done = true));
  assert.equal(at(purse.seen, 0).mode, "cached");
  await tick();
  assert.equal(done, false);
  timers.advance(499);
  await tick();
  assert.equal(done, false);
  timers.advance(1);
  await tick();
  assert.equal(done, true);
  assert.equal(svc.holds(["anthropic"]), false);
  at(purse.open, 0)(reply({ anthropic: entry() }));
  await tick();
  assert.equal(svc.holds(["anthropic"]), true, "the outcome after the 500 ms still applies");
});

test("the cached-query wait returns as soon as the outcome is known and leaves no timer behind", async () => {
  const { purse, svc, timers } = service();
  purse.answer = () => reply({ anthropic: entry() });
  await svc.cachedQueryWait(["anthropic"]);
  assert.equal(svc.holds(["anthropic"]), true);
  assert.equal(timers.count, 0);
});

test("without a service the wait returns at once; without providers it starts no query and waits for nothing", async () => {
  const bus = new FakeBus();
  const timers = new FakeTimers();
  const svc = new BillingService({ bus, guidanceProviders: () => [], timeZone: "UTC", timers });
  await svc.cachedQueryWait(["a"]);
  assert.equal(timers.count, 0);
  const before = bus.requests().length;
  await svc.cachedQueryWait([]);
  assert.equal(bus.requests().length, before);
});

test("a cached query started by a notification is waited for, not duplicated, by a guidance computation", async () => {
  const { bus, purse, svc, timers } = service();
  purse.mode = "manual";
  bus.notify(["anthropic"]);
  assert.equal(purse.seen.length, 1);
  let done = false;
  void svc.cachedQueryWait(["anthropic", "google"]).then(() => (done = true));
  await tick();
  assert.equal(purse.seen.length, 1, "no second query while one is pending");
  assert.equal(done, false, "the wait does not end while the query is pending");
  timers.advance(500);
  await tick();
  assert.equal(done, true, "the wait ends after 500 ms even with a query pending");
  at(purse.open, 0)(reply({ anthropic: entry() }));
  await tick();
  assert.equal(purse.seen.length, 2, "the providers it added start the next query");
  assert.equal(at(purse.seen, 1).mode, "cached");
  assert.deepEqual(
    at(purse.seen, 1).providers,
    ["google"],
    "a provider the pending query names does not join the waiting set",
  );
  at(purse.open, 1)(reply({ google: entry() }));
  await tick();
  assert.equal(purse.seen.length, 2, "an emptied waiting set starts nothing");
  assert.equal(svc.holds(["anthropic", "google"]), true);
});

// ------------------------------------------------------------ report

test("report: an auto query for the report providers, waited for; entries and models from held billing", async () => {
  const { purse, svc } = service();
  purse.answer = () =>
    reply(
      { anthropic: entry({ models: { opus: model(5, 25) } }), google: entry() },
      { generatedAt: 7 },
    );
  const report = await svc.report([
    { provider: "google", id: "g" },
    { provider: "anthropic", id: "opus" },
    { provider: "bad provider", id: "x" },
  ]);
  assert.equal(at(purse.seen, 0).mode, "auto");
  assert.deepEqual(at(purse.seen, 0).providers, ["anthropic", "bad provider", "google"]);
  assert.equal(at(purse.seen, 0).maxWaitMs, 5000);
  assert.deepEqual(
    report?.providers.map((p) => p.provider),
    ["anthropic", "google"],
  );
  assert.equal(at(at(must(report).providers, 0).models, 0).model, "anthropic/opus");
  assert.equal(report?.timeZone, "UTC");
});

test("report: null without providers, without records, or without a service", async () => {
  const { purse, svc } = service();
  assert.equal(await svc.report([]), null);
  assert.equal(purse.seen.length, 0, "no query for no providers");
  assert.equal(
    await svc.report([{ provider: "anthropic", id: "x" }]),
    null,
    "empty answer: no record",
  );
  const bus = new FakeBus();
  const lone = new BillingService({ bus, guidanceProviders: () => [], timeZone: "UTC" });
  assert.equal(await lone.report([{ provider: "anthropic", id: "x" }]), null);
});

test("report: abort stops waiting and the report uses held billing alone", async () => {
  const { purse, svc } = service();
  purse.answer = () => reply({ anthropic: entry({ plan: { state: "known", value: "Held" } }) });
  await svc.cachedQueryWait(["anthropic"]);
  purse.mode = "manual";
  const controller = new AbortController();
  const got: { report?: Awaited<ReturnType<typeof svc.report>> } = {};
  void svc
    .report([{ provider: "anthropic", id: "x" }], controller.signal)
    .then((r) => (got.report = r));
  await tick();
  assert.equal("report" in got, false, "still waiting");
  controller.abort();
  await tick();
  assert.equal(at(must(got.report).providers, 0).plan, "Held");
  // The outcome that arrives afterwards still updates held billing.
  at(
    purse.open,
    0,
  )(
    reply({ anthropic: entry({ plan: { state: "known", value: "Late" } }) }, { generatedAt: 5000 }),
  );
  await tick();
  assert.equal(svc.view().entries.get("anthropic")?.plan, "Late");
});

test("report: an already aborted call does not wait", async () => {
  const { purse, svc } = service();
  purse.mode = "manual";
  const controller = new AbortController();
  controller.abort();
  const report = await svc.report([{ provider: "anthropic", id: "x" }], controller.signal);
  assert.equal(report, null);
});

test("report: the 25 s timeout ends the wait", async () => {
  const { purse, svc, timers } = service();
  purse.mode = "manual";
  let done = false;
  void svc.report([{ provider: "anthropic", id: "x" }]).then(() => (done = true));
  timers.advance(24_999);
  await tick();
  assert.equal(done, false);
  timers.advance(1);
  await tick();
  assert.equal(done, true);
});

// ------------------------------------------------------------ shutdown

test("from shutdown on: no query, notifications and settlements ignored", async () => {
  const { bus, purse, svc, timers } = service();
  purse.mode = "manual";
  svc.startPoll();
  const waiting = svc.cachedQueryWait(["anthropic"]);
  const reporting = svc.report([{ provider: "anthropic", id: "x" }]);
  assert.equal(purse.seen.length, 3);
  svc.close();
  await Promise.all([waiting, reporting]);
  assert.equal(timers.count, 0, "pending timers are cleared");
  at(purse.open, 0)(reply({ anthropic: entry() }));
  await tick();
  assert.equal(svc.holds(["anthropic"]), false, "settlements are ignored");
  svc.startPoll();
  await svc.cachedQueryWait(["anthropic"]);
  assert.equal(await svc.report([{ provider: "anthropic", id: "x" }]), null);
  bus.notify(["anthropic"]);
  bus.emit("purse:changed:v1", { providers: ["anthropic"] });
  assert.equal(purse.seen.length, 3, "nothing started after shutdown");
  assert.equal(svc.closed, true);
});

test("a window fixture round-trips through held billing into the report", async () => {
  const { purse, svc } = service();
  purse.answer = () =>
    reply({
      anthropic: entry({
        limits: { state: "known", value: [limit({ severity: "critical" })] },
      }),
    });
  const report = await svc.report([{ provider: "anthropic", id: "x" }]);
  assert.equal(at(must(report).providers, 0).state, "critical");
});

// ------------------------------------------------------------ maxWaitMs (2.1)

test("maxWaitMs is sent by the report query only", async () => {
  const { bus, purse, svc } = service();
  purse.answer = () => reply({ anthropic: entry() });
  svc.startPoll();
  await svc.pendingPoll();
  await svc.cachedQueryWait(["anthropic"]);
  bus.notify(["anthropic"]);
  await tick();
  await svc.report([{ provider: "anthropic", id: "x" }]);
  assert.deepEqual(
    purse.seen.map((r) => "maxWaitMs" in r),
    [false, false, false, true],
  );
  assert.deepEqual(Object.keys(at(purse.seen, 3)).toSorted(), [
    "maxWaitMs",
    "mode",
    "providers",
    "respond",
  ]);
});

// ------------------------------------------------------------ not-ready polls (4.2)

test("a change notification starts a poll when the latest poll answered not-ready", async () => {
  const { bus, purse, svc } = service();
  purse.answer = () => reply({}, { status: "not-ready" });
  svc.startPoll();
  await svc.pendingPoll();
  assert.equal(purse.seen.length, 1);
  bus.notify(["anthropic"]);
  await tick();
  const modes = purse.seen.map((r) => r.mode);
  assert.deepEqual(
    modes.slice(0, 2),
    ["auto", "auto"],
    "the poll starts first, then the cached query",
  );
  // Once a poll is answered ok, a further notification starts no poll.
  purse.answer = () => reply({ anthropic: entry() });
  bus.notify(["anthropic"]);
  await tick();
  await tick();
  const before = purse.seen.filter((r) => r.mode === "auto").length;
  bus.notify(["anthropic"]);
  await tick();
  assert.equal(purse.seen.filter((r) => r.mode === "auto").length, before);
});

test("a change notification during a pending poll never starts a second one, but a not-ready answer then does", async () => {
  const { bus, purse, svc } = service();
  purse.mode = "manual";
  svc.startPoll();
  bus.notify(["google"]);
  bus.notify(["google"]);
  assert.equal(purse.seen.filter((r) => r.mode === "auto").length, 1);
  at(purse.open, 0)(reply({}, { status: "not-ready" }));
  await tick();
  assert.equal(purse.seen.filter((r) => r.mode === "auto").length, 2, "exactly one new poll");
  // Answering ok with no change during the pending poll starts nothing more.
  at(purse.open, purse.open.length - 1)(reply({ anthropic: entry() }));
  await tick();
  assert.equal(purse.seen.filter((r) => r.mode === "auto").length, 2);
});

test("a not-ready answer without a change notification during the poll starts no poll", async () => {
  const { purse, svc } = service();
  purse.answer = () => reply({}, { status: "not-ready" });
  svc.startPoll();
  await svc.pendingPoll();
  await tick();
  assert.equal(purse.seen.length, 1, "no retry");
});

test("poll answer waiters run on an outcome other than not-ready, once", async () => {
  const { bus, purse, svc } = service();
  purse.mode = "manual";
  let ran = 0;
  svc.startPoll();
  svc.onPollAnswer(() => ran++);
  at(purse.open, 0)(reply({}, { status: "not-ready" }));
  await tick();
  assert.equal(ran, 0);
  bus.notify(["anthropic"]);
  await tick();
  assert.equal(ran, 0, "the new poll is pending");
  assert.equal(at(purse.seen, 1).mode, "auto");
  at(purse.open, 1)(reply({}, { status: "bad-request" }));
  await tick();
  assert.equal(ran, 1);
});

// ------------------------------------------------------------ past reset (5)

test("past reset: a window at or before the clock reads as used/percent null and severity unknown", async () => {
  const { purse, svc } = service();
  const reset = Date.UTC(2026, 4, 12, 23);
  purse.answer = () =>
    reply({
      anthropic: entry({
        limits: {
          state: "known",
          value: [limit({ resetsAt: reset }), limit({ resetsAt: reset + 1000, severity: "low" })],
        },
      }),
    });
  await svc.cachedQueryWait(["anthropic"]);
  await tick();
  const clock = { now: NOW };
  const timers = new FakeTimers();
  // Build the aged service from the same reply through its own bus.
  const bus2 = new FakeBus();
  const purse2 = new FakePurse(bus2);
  purse2.answer = purse.answer;
  const svc2 = new BillingService({
    bus: bus2,
    guidanceProviders: () => ["anthropic"],
    timeZone: "UTC",
    timers,
    now: () => clock.now,
  });
  await svc2.cachedQueryWait(["anthropic"]);
  await tick();
  const held = () => must(svc2.view().entries.get("anthropic"));
  const before = held().limits;
  assert.deepEqual(
    [at(before, 0).used, at(before, 0).percent, at(before, 0).severity],
    [90, 90, "critical"],
  );
  clock.now = reset;
  const after = held().limits;
  assert.deepEqual(
    [at(after, 0).used, at(after, 0).percent, at(after, 0).severity],
    [null, null, "unknown"],
  );
  assert.equal(at(after, 0).limit, 100, "limit is kept");
  assert.equal(at(after, 1).severity, "low", "a later reset is untouched");
  clock.now = reset - 1;
  assert.equal(at(held().limits, 0).severity, "critical");
  // The report, details included, shows the aged window.
  clock.now = reset + 5;
  const report = await svc2.report([{ provider: "anthropic", id: "x" }]);
  const rp = must(report);
  const firstLimit = at(at(rp.providers, 0).limits, 0);
  assert.deepEqual(
    [firstLimit.used, firstLimit.percent, firstLimit.severity],
    [null, null, "unknown"],
  );
  assert.equal(at(rp.providers, 0).state, "low", "state counts the aged window as unknown");
});
