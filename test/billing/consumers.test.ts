import assert from "node:assert/strict";
import { test } from "node:test";
import { guidanceToInject } from "../../lib/guidance-inject.ts";
import { BillingService } from "../../lib/billing.ts";
import { buildChildSystemPrompt, dispatchChildGuidance } from "../../lib/engine.ts";
import { AGENT_SESSION_MODE_LINE } from "../../lib/session-kind.ts";
import {
  GUIDANCE_CUSTOM_TYPE,
  billingEnabled,
  childGuidance,
  guidanceBillingProviders,
  guidanceContent,
  parseModelGuidance,
  type ModelGuidance,
} from "../../lib/model-guidance.ts";
import type { BillingReport } from "../../lib/billing-text.ts";
import { makeSessionTool } from "../../lib/tools.ts";
import { FakeBus, FakePurse, FakeTimers, NOW, entry, limit, model, reply, tick } from "./fakes.ts";
import { at, must } from "../support/must.ts";

const guidance: ModelGuidance = {
  entries: [
    { key: "anthropic/opus", provider: "anthropic", id: "opus", when: "hard problems" },
    {
      key: "anthropic/opus:high",
      provider: "anthropic",
      id: "opus",
      thinking: "high",
      when: "very hard",
    },
    { key: "google/flash", provider: "google", id: "flash", when: "quick edits" },
  ],
  rules: [],
};
const inventory = [
  { provider: "anthropic", id: "opus", reasoning: true },
  { provider: "google", id: "flash" },
];

function boot(modelGuidance?: unknown) {
  return {
    cwd: "/w",
    config: {
      merged: modelGuidance === undefined ? {} : { modelGuidance },
      layers: { project: { path: "/proj/pi-dent.conf", values: {} } },
      projectRoot: "/proj",
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    },
    agents: [],
    agentIndex: new Map(),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: 0,
    sessionTtlDays: 30,
  };
}

function held(replyBody: Record<string, unknown>) {
  const bus = new FakeBus();
  const purse = new FakePurse(bus);
  purse.answer = () => replyBody;
  const timers = new FakeTimers();
  const svc = new BillingService({
    bus,
    guidanceProviders: () => ["anthropic", "google"],
    timeZone: "UTC",
    timers,
    now: () => NOW,
  });
  return { bus, purse, svc, timers };
}

const body = () =>
  reply({
    anthropic: entry({ models: { opus: model(5, 25) } }),
    google: entry({ models: { flash: model(0.5, 3) } }),
  });

// ------------------------------------------------------------ configuration

test("modelGuidance.billing: boolean, default true; a non-boolean is diagnosed and ignored", () => {
  assert.equal(billingEnabled(boot().config), true);
  assert.equal(billingEnabled(boot({}).config), true);
  assert.equal(billingEnabled(boot({ billing: true }).config), true);
  assert.equal(billingEnabled(boot({ billing: false }).config), false);
  for (const value of ["false", 0, null, [], {}]) {
    const config = boot({ billing: value }).config;
    assert.equal(billingEnabled(config), true);
    assert.deepEqual(parseModelGuidance(config).diagnostics, [
      "config: modelGuidance.billing must be a boolean; ignored (/proj/pi-dent.conf)",
    ]);
  }
  assert.deepEqual(parseModelGuidance(boot({ billing: false }).config).diagnostics, []);
  assert.equal(billingEnabled(boot("junk").config), true);
});

// ------------------------------------------------------------ guidance message

test("guidance message with billing: Model billing lists only the guided models with an annotation", async () => {
  const { svc } = held(body());
  await svc.cachedQueryWait(["anthropic", "google"]);
  await tick();
  // openai/x is guided but has no billing data: it has no line.
  const withUnpriced: ModelGuidance = {
    entries: [
      ...guidance.entries,
      { key: "openai/x", provider: "openai", id: "x", when: "no data" },
    ],
    rules: [{ match: /^anthropic\//u, rule: "think twice" }],
  };
  const content = guidanceContent(
    withUnpriced,
    [...inventory, { provider: "openai", id: "x" }],
    "anthropic/opus",
    svc.view(),
  );
  assert.ok(
    content.startsWith(
      "Model billing:\n- anthropic/opus: [$5/$25; unknown]\n- anthropic/opus:high: [$5/$25; unknown]\n- google/flash: [$0.5/$3; unknown]\n\nChoose by stated use first",
    ),
    content,
  );
  assert.equal(content.includes("openai"), false);
  assert.ok(content.endsWith("\n\nthink twice"), content);
});

test("guidance message without billing: rules only, and nothing when there are none", () => {
  const rulesOnly: ModelGuidance = {
    ...guidance,
    rules: [{ match: /^anthropic\//u, rule: "think twice" }],
  };
  assert.equal(guidanceContent(rulesOnly, inventory, "anthropic/opus"), "think twice");
  assert.equal(guidanceContent(rulesOnly, inventory, "google/flash"), "");
  assert.equal(guidanceToInject(guidance, inventory, "google/flash", []), undefined);
  assert.equal(guidanceToInject(rulesOnly, inventory, "anthropic/opus", []), "think twice");
});

// ------------------------------------------------------------ skip rule

const rulesA: ModelGuidance = {
  ...guidance,
  rules: [
    { match: /^a\//u, rule: "rule A" },
    { match: /^b\//u, rule: "rule B" },
  ],
};
const msg = (content: string) => ({
  type: "custom_message",
  customType: GUIDANCE_CUSTOM_TYPE,
  content,
});

test("skip rule compares only with the latest guidance message after the latest compaction", () => {
  const forA = guidanceToInject(rulesA, inventory, "a/m", []);
  const forB = guidanceToInject(rulesA, inventory, "b/m", []);
  assert.ok(forA !== undefined && forB !== undefined);
  assert.notEqual(forA, forB);
  // A -> B -> A re-injects A because the latest message is B.
  assert.equal(guidanceToInject(rulesA, inventory, "a/m", [msg(forA), msg(forB)]), forA);
  // The latest equals: skipped, even when an earlier one differs.
  assert.equal(guidanceToInject(rulesA, inventory, "a/m", [msg(forB), msg(forA)]), undefined);
  // Other entries after the latest message do not matter.
  assert.equal(
    guidanceToInject(rulesA, inventory, "a/m", [
      msg(forA),
      { type: "message" },
      { type: "custom_message", customType: "other", content: "x" },
    ]),
    undefined,
  );
  // A compaction ends the search.
  assert.equal(
    guidanceToInject(rulesA, inventory, "a/m", [msg(forA), { type: "compaction" }]),
    forA,
  );
  assert.equal(
    guidanceToInject(rulesA, inventory, "a/m", [{ type: "compaction" }, msg(forA)]),
    undefined,
  );
  assert.equal(
    guidanceToInject(rulesA, inventory, "a/m", [msg(forA), { type: "compaction" }, msg(forB)]),
    forA,
  );
});

// ------------------------------------------------------------ guidance content and child text

test("guidance billing providers are the billing providers of the guided models, thinking ignored", () => {
  assert.deepEqual(guidanceBillingProviders(guidance, inventory), ["anthropic", "google"]);
  assert.deepEqual(guidanceBillingProviders({ entries: [], rules: [] }, inventory), []);
  assert.deepEqual(guidanceBillingProviders(guidance, []), [], "no guided model, no providers");
});

test("every distinct provider of the guided models is requested, unfiltered", () => {
  const odd: ModelGuidance = {
    entries: [
      { key: "-x/m", provider: "-x", id: "m", when: "w" },
      { key: "ok/m", provider: "ok", id: "m", when: "w" },
    ],
    rules: [],
  };
  const avail = [
    { provider: "-x", id: "m" },
    { provider: "ok", id: "m" },
  ];
  assert.deepEqual(guidanceBillingProviders(odd, avail), ["-x", "ok"]);
});

test("every thinking level of one provider/id maps to the same record", async () => {
  const { svc } = held(body());
  await svc.cachedQueryWait(["anthropic", "google"]);
  await tick();
  const content = guidanceContent(guidance, inventory, undefined, svc.view());
  assert.match(content, /^Model billing:\n- anthropic\/opus: \[\$5\/\$25; unknown\]\n/u);
  assert.match(content, /\n- anthropic\/opus:high: \[\$5\/\$25; unknown\]\n/u);
});

test("child guidance: sections 1 and 2; billing lines only with billing text; empty without guided models", async () => {
  const { svc } = held(body());
  assert.equal(childGuidance(guidance, inventory, svc.view()), "", "no billing text yet");
  await svc.cachedQueryWait(["anthropic", "google"]);
  await tick();
  const text = childGuidance(guidance, inventory, svc.view());
  assert.ok(
    text.startsWith(
      "Model billing:\n- anthropic/opus: [$5/$25; unknown]\n- anthropic/opus:high: [$5/$25; unknown]\n- google/flash: [$0.5/$3; unknown]\n\nChoose by stated use first",
    ),
    text,
  );
  assert.ok(text.endsWith("unknown or untracked."));
  const rulesOnly: ModelGuidance = { entries: [], rules: [{ match: /./u, rule: "r" }] };
  assert.equal(childGuidance(rulesOnly, inventory, svc.view()), "", "no guided models, nothing");
  assert.equal(childGuidance(guidance, inventory, undefined), "", "no billing, no lines");
});

test("child system prompt: skills, rules, then the child guidance, then session mode line", () => {
  const config = boot({ rules: [{ match: "m", rule: "a rule" }] }).config;
  assert.equal(
    buildChildSystemPrompt("Base", [], { provider: "p", id: "m" }, config, "GUIDANCE"),
    `Base\n\na rule\n\nGUIDANCE\n\n${AGENT_SESSION_MODE_LINE}`,
  );
  assert.equal(
    buildChildSystemPrompt("Base", [], { provider: "p", id: "x" }, config, "GUIDANCE"),
    `Base\n\nGUIDANCE\n\n${AGENT_SESSION_MODE_LINE}`,
  );
  assert.equal(
    buildChildSystemPrompt("Base", [], { provider: "p", id: "m" }, config),
    `Base\n\na rule\n\n${AGENT_SESSION_MODE_LINE}`,
  );
  assert.equal(
    buildChildSystemPrompt("Base", [], { provider: "p", id: "m" }, config, ""),
    `Base\n\na rule\n\n${AGENT_SESSION_MODE_LINE}`,
  );
});

const guidedConfig = () =>
  boot({
    models: {
      "anthropic/opus": { when: "hard problems" },
      "google/flash": { when: "quick edits" },
    },
  }).config;

test("dispatch child guidance: after a cached query on the main service, only for a child with Agent", async () => {
  const config = guidedConfig();
  const { svc, purse } = held(body());
  const withAgent = await dispatchChildGuidance(svc, config, ["read", "Agent"], inventory as never);
  assert.equal(purse.seen.length, 1);
  assert.equal(at(purse.seen, 0).mode, "cached");
  assert.deepEqual(at(purse.seen, 0).providers, ["anthropic", "google"]);
  assert.ok(withAgent?.startsWith("Model billing:\n- anthropic/opus: [$5/$25; unknown]"));
  assert.equal(await dispatchChildGuidance(svc, config, ["read"], inventory as never), undefined);
  assert.equal(purse.seen.length, 1, "no purse query for a child that cannot dispatch");
});

test("dispatch child guidance: nothing when billing is disabled or has no data; nothing without guided models", async () => {
  const config = guidedConfig();
  assert.equal(
    await dispatchChildGuidance(undefined, config, ["Agent"], inventory as never),
    undefined,
    "billing disabled",
  );
  const bus = new FakeBus();
  const svc = new BillingService({
    bus,
    guidanceProviders: () => [],
    timeZone: "UTC",
    timers: new FakeTimers(),
  });
  assert.equal(await dispatchChildGuidance(svc, config, ["Agent"], inventory as never), undefined);
  assert.equal(bus.requests().length, 1, "the cached query was made");
  const noGuidance = boot({ rules: [{ match: ".", rule: "r" }] }).config;
  assert.equal(
    await dispatchChildGuidance(svc, noGuidance, ["Agent"], inventory as never),
    undefined,
  );
  assert.equal(bus.requests().length, 1, "no guided models, no query");
});

test("dispatch child guidance waits at most 500 ms and uses what is held", async () => {
  const config = guidedConfig();
  const { svc, purse, timers } = held(body());
  purse.mode = "manual";
  const got: { text?: string | undefined } = {};
  void dispatchChildGuidance(svc, config, ["Agent"], inventory as never).then(
    (t) => (got.text = t),
  );
  timers.advance(500);
  await tick();
  assert.equal(got.text, undefined, "nothing held after the wait: no billing lines");
});

// ------------------------------------------------------------ Session tool

function stubCtx(sessionId = "s1") {
  return {
    cwd: "/w",
    model: { provider: "anthropic", id: "opus" },
    thinkingLevel: undefined,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    modelRegistry: { getAvailable: () => inventory },
  };
}

function sessionRun(
  svc: BillingService | undefined,
  modelGuidance: unknown,
  signal?: AbortSignal,
  ctx: unknown = stubCtx(),
) {
  const tool = makeSessionTool({
    boot: boot(modelGuidance),
    hostProvider: () => undefined,
    billing: svc,
  });
  return tool.execute("tc", {} as never, signal, undefined, ctx as never);
}

/** `details.billing` of a Session result. */
function billingOf(result: Awaited<ReturnType<typeof sessionRun>>) {
  const details = result.details as { billing: BillingReport | null };
  return details.billing;
}

function textOf(result: Awaited<ReturnType<typeof sessionRun>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

const guided = {
  models: { "anthropic/opus": { when: "hard problems" }, "google/flash": { when: "quick edits" } },
};

test("Session: the report query, details.billing, and the billing text", async () => {
  const { svc, purse } = held(
    reply({
      anthropic: entry({
        plan: { state: "known", value: "Max" },
        limits: { state: "known", value: [limit({ resetsAt: null })] },
        models: { opus: model(5, 25) },
      }),
      google: entry({ models: { flash: model(0.5, 3) } }),
    }),
  );
  const result = await sessionRun(svc, guided);
  assert.equal(purse.seen.length, 1);
  assert.equal(at(purse.seen, 0).mode, "auto");
  assert.deepEqual(at(purse.seen, 0).providers, ["anthropic", "google"]);
  const billing = must(billingOf(result));
  assert.equal(billing.timeZone, "UTC");
  assert.deepEqual(
    billing.providers.map((p) => p.provider),
    ["anthropic", "google"],
  );
  assert.equal(at(billing.providers, 0).state, "critical");
  assert.deepEqual(
    at(billing.providers, 0).models.map((m) => m.model),
    ["anthropic/opus"],
  );
  const text = textOf(result);
  // The guidance section carries no billing annotation; the report follows it.
  assert.ok(
    text.includes(
      "Model guidance:\n- anthropic/opus: hard problems\n- google/flash: quick edits\nbilling (local zone UTC):\n",
    ),
  );
  assert.ok(
    text.includes(
      "anthropic: critical; status ok; plan Max; captured 2026-05-12T20:00:30Z (2026-05-12T20:00:30+00:00)\n  limit 5 hour: 90% used (90/100 percent); critical\n  anthropic/opus: $5/$25, cache $?/$?; ok\ngoogle: unknown; status ok; plan Max; captured",
    ),
  );
  assert.ok(!text.includes("["), "no annotation brackets in the Session text");
  assert.ok(!text.includes("Billing ("), "no billing note in the Session text");
});

test("Session: without guidance the report covers the inventory's providers", async () => {
  const { svc, purse } = held(reply({ google: entry({ models: { flash: model(1, 2) } }) }));
  const result = await sessionRun(svc, undefined);
  assert.deepEqual(at(purse.seen, 0).providers, ["anthropic", "google"]);
  assert.deepEqual(
    billingOf(result)?.providers.map((p) => p.provider),
    ["google"],
  );
});

test("Session: billing null when disabled, without service, or when no record", async () => {
  const off = await sessionRun(undefined, guided);
  assert.equal(billingOf(off), null);
  assert.ok(!textOf(off).includes("billing (local zone"));
  const { svc } = held(reply({}));
  const empty = await sessionRun(svc, guided);
  assert.equal(billingOf(empty), null);
  assert.ok(!textOf(empty).includes("billing (local zone"));
  const bus = new FakeBus();
  const absent = new BillingService({
    bus,
    guidanceProviders: () => [],
    timeZone: "UTC",
    timers: new FakeTimers(),
  });
  assert.equal((await sessionRun(absent, guided)).details.billing, null);
  // No models, no providers, no query.
  const noModels = { ...stubCtx(), modelRegistry: { getAvailable: () => [] } };
  const quiet = held(reply({}));
  await sessionRun(quiet.svc, undefined, undefined, noModels);
  assert.equal(quiet.purse.seen.length, 0);
});

test("Session: abort stops waiting and reports held billing alone", async () => {
  const { svc, purse } = held(body());
  await svc.cachedQueryWait(["anthropic", "google"]);
  purse.mode = "manual";
  const controller = new AbortController();
  const pending = sessionRun(svc, guided, controller.signal);
  await tick();
  controller.abort();
  const result = await pending;
  assert.deepEqual(
    billingOf(result)?.providers.map((p) => p.provider),
    ["anthropic", "google"],
  );
});

test("Session invoked by a child session reports through the main instance's service", async () => {
  const { svc, purse } = held(reply({ anthropic: entry() }));
  const child = { ...stubCtx("child-session"), model: { provider: "google", id: "flash" } };
  const result = await sessionRun(svc, guided, undefined, child);
  assert.equal(result.details.sessionId, "child-session");
  assert.equal(purse.seen.length, 1);
  assert.equal(at(must(billingOf(result)).providers, 0).provider, "anthropic");
});
