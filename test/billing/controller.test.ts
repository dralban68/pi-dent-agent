import assert from "node:assert/strict";
import { test } from "node:test";
import { GuidanceController, type GuidanceContext } from "../../lib/guidance-controller.ts";
import { GUIDANCE_CUSTOM_TYPE, type ModelGuidance } from "../../lib/model-guidance.ts";
import type { Diagnostic } from "../../lib/util.ts";
import { FakeBus, FakePurse, FakeTimers, NOW, entry, model, reply, tick } from "./fakes.ts";
import { at, must } from "../support/must.ts";

const guidance: ModelGuidance = {
  entries: [
    { key: "anthropic/opus", provider: "anthropic", id: "opus", when: "hard problems" },
    { key: "google/flash", provider: "google", id: "flash", when: "quick edits" },
  ],
  rules: [{ match: /^anthropic\//u, rule: "think twice" }],
};
const inventory = [
  { provider: "anthropic", id: "opus" },
  { provider: "google", id: "flash" },
];
const opus = { provider: "anthropic", id: "opus" };
const flash = { provider: "google", id: "flash" };

interface Branch {
  type: string;
  customType?: string;
  content?: unknown;
}

/** One session: a branch the sent messages land on, as `sendMessage` appends them. */
function setup(
  options: {
    billing?: boolean;
    guidance?: ModelGuidance;
    service?: boolean;
    diagnostics?: (diagnostic: Diagnostic) => void;
    send?: () => void;
  } = {},
) {
  const bus = new FakeBus();
  const purse = new FakePurse(options.service === false ? new FakeBus() : bus);
  const timers = new FakeTimers();
  const branch: Branch[] = [];
  const sent: string[] = [];
  const ctl = new GuidanceController({
    guidance: options.guidance ?? guidance,
    billingEnabled: options.billing ?? true,
    bus,
    timeZone: "UTC",
    timers,
    now: () => NOW,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    send: (message) => {
      assert.equal(message.customType, GUIDANCE_CUSTOM_TYPE);
      assert.equal(message.display, true);
      if (options.send) {
        options.send();
        return;
      }
      sent.push(message.content);
      branch.push({
        type: "custom_message",
        customType: message.customType,
        content: message.content,
      });
    },
  });
  const ctx = (
    modelParam: { provider: string; id: string } | undefined = opus,
  ): GuidanceContext => ({
    model: modelParam,
    sessionManager: { getBranch: () => branch },
    modelRegistry: { getAvailable: () => inventory },
  });
  const billingReply = () =>
    reply({
      anthropic: entry({ models: { opus: model(5, 25) } }),
      google: entry({ models: { flash: model(0.5, 3) } }),
    });
  return { bus, purse, timers, branch, sent, ctl, ctx, billingReply };
}

const PLAIN = "think twice";

// ------------------------------------------------------------ behaviour without purse

test("without purse the guidance text and the injections are those of a session without billing", async () => {
  const s = setup({ service: false });
  s.ctl.sessionStart(s.ctx());
  assert.deepEqual(s.sent, [PLAIN], "synchronously, no delay");
  await s.ctl.sessionCompact(s.ctx());
  assert.equal(s.sent.length, 1, "unchanged content is skipped");
  s.branch.push({ type: "compaction" });
  await s.ctl.sessionCompact(s.ctx());
  assert.deepEqual(s.sent, [PLAIN, PLAIN], "after a compaction it is injected again");
  assert.equal(s.sent.length, 2);
});

test("bad-request, cancelled, invalid, timeout: same text, nothing injected on their account", async () => {
  for (const answer of [
    () => reply({}, { status: "bad-request" }),
    () => reply({}, { status: "cancelled" }),
    () => null,
    () => reply({ anthropic: "junk" }),
  ]) {
    const s = setup();
    s.purse.answer = answer;
    s.ctl.sessionStart(s.ctx());
    await tick();
    assert.deepEqual(s.sent, [PLAIN]);
    await tick();
    assert.deepEqual(s.sent, [PLAIN]);
  }
  const slow = setup();
  slow.purse.mode = "manual";
  slow.ctl.sessionStart(slow.ctx());
  assert.deepEqual(slow.sent, [], "a slow service delays the start-up message");
  slow.timers.advance(25_000);
  await tick();
  assert.deepEqual(slow.sent, [PLAIN], "after the timeout the plain text goes out");
});

test("billing disabled: no emit, no subscription, no held billing", async () => {
  const s = setup({ billing: false });
  assert.equal(s.ctl.billing, undefined);
  assert.equal(s.bus.listenerCount("purse:changed:v1"), 0);
  s.ctl.sessionStart(s.ctx());
  await s.ctl.sessionCompact(s.ctx());
  await s.ctl.modelSelect(s.ctx(), flash);
  s.ctl.shutdown();
  assert.equal(s.bus.requests().length, 0);
  assert.equal(s.bus.emitted.length, 0);
  // The flash model has no rule and, without billing text, no content: nothing more is sent.
  assert.deepEqual(s.sent, [PLAIN]);
});

// ------------------------------------------------------------ session_start

test("session_start: the poll's outcome decides the single injection, with billing text", async () => {
  const s = setup();
  s.purse.mode = "manual";
  s.ctl.sessionStart(s.ctx());
  assert.equal(s.purse.seen.length, 1);
  assert.equal(at(s.purse.seen, 0).mode, "auto");
  assert.deepEqual(s.sent, []);
  at(s.purse.open, 0)(s.billingReply());
  await tick();
  assert.equal(s.sent.length, 1);
  assert.match(
    at(s.sent, 0),
    /^Model billing:\n- anthropic\/opus: \[\$5\/\$25; unknown\]\n- google\/flash: \[\$0\.5\/\$3; unknown\]\n\nChoose by stated use first/u,
  );
  assert.match(at(s.sent, 0), /unknown or untracked\.\n\nthink twice$/u);
});

test("a duplicate session_start injects once, and starts no second poll while one is pending", async () => {
  const s = setup();
  s.purse.mode = "manual";
  s.ctl.sessionStart(s.ctx());
  s.ctl.sessionStart(s.ctx());
  assert.equal(s.purse.seen.length, 1);
  at(s.purse.open, 0)(s.billingReply());
  await tick();
  assert.equal(s.sent.length, 1);
  // A duplicate arriving after the first settled finds the message already on the branch.
  s.purse.mode = "auto";
  s.purse.answer = s.billingReply;
  s.ctl.sessionStart(s.ctx());
  await tick();
  assert.equal(s.sent.length, 1, "same content: skipped");
  assert.equal(s.purse.seen.length, 2, "every session_start polls when due");
});

test("a duplicate session_start without purse injects once through the skip rule", () => {
  const s = setup({ service: false });
  s.ctl.sessionStart(s.ctx());
  s.ctl.sessionStart(s.ctx());
  assert.equal(s.sent.length, 1);
});

test("shutdown cancels the deferred injection and later settlements inject nothing", async () => {
  const s = setup();
  s.purse.mode = "manual";
  s.ctl.sessionStart(s.ctx());
  s.ctl.shutdown();
  at(s.purse.open, 0)(s.billingReply());
  await tick();
  s.timers.advance(60_000);
  await tick();
  assert.deepEqual(s.sent, []);
});

// ------------------------------------------------------------ churn

test("billing data arriving never injects by itself; change notifications only update held billing", async () => {
  const s = setup();
  s.purse.answer = s.billingReply;
  s.ctl.sessionStart(s.ctx());
  await tick();
  assert.equal(s.sent.length, 1);
  s.purse.answer = () =>
    reply(
      { anthropic: entry({ models: { opus: model(1, 2) } }), google: entry() },
      { generatedAt: 5000 },
    );
  s.bus.notify(["anthropic", "google"]);
  await tick();
  assert.equal(must(s.purse.seen.at(-1)).mode, "cached");
  assert.equal(s.sent.length, 1, "no message from a change");
  assert.equal(must(s.ctl.billing).view().entries.get("anthropic")?.models.get("opus")?.input, 1);
});

// ------------------------------------------------------------ compaction and model change

test("session_compact: a cached query first, then the injection with the data it brought", async () => {
  const s = setup();
  s.purse.answer = s.billingReply;
  s.branch.push({ type: "compaction" });
  await s.ctl.sessionCompact(s.ctx());
  assert.equal(s.purse.seen.length, 1);
  assert.equal(at(s.purse.seen, 0).mode, "cached");
  assert.equal(s.sent.length, 1);
  assert.match(at(s.sent, 0), /\[\$5\/\$25; unknown\]/u);
});

test("session_compact waits at most 500 ms for the cached query", async () => {
  const s = setup();
  s.purse.mode = "manual";
  const done = s.ctl.sessionCompact(s.ctx());
  await tick();
  assert.equal(s.sent.length, 0);
  s.timers.advance(500);
  await done;
  assert.deepEqual(s.sent, [PLAIN]);
});

test("session_compact joins a cached query a change notification already started", async () => {
  const s = setup();
  s.purse.answer = () => reply({});
  s.ctl.sessionStart(s.ctx());
  await tick();
  assert.deepEqual(s.sent, [PLAIN], "no billing data yet");
  s.branch.push({ type: "compaction" });
  s.purse.mode = "manual";
  s.bus.notify(["anthropic", "google"]);
  assert.equal(s.purse.seen.length, 2, "the notification's cached query");
  assert.equal(at(s.purse.seen, 1).mode, "cached");
  const done = s.ctl.sessionCompact(s.ctx());
  await tick();
  assert.equal(s.purse.seen.length, 2, "no second query while one is pending");
  assert.deepEqual(s.sent, [PLAIN], "nothing injected while the query is pending");
  at(s.purse.open, 0)(s.billingReply());
  await done;
  assert.equal(s.purse.seen.length, 2, "providers the pending query names start no second query");
  assert.equal(s.sent.length, 2);
  assert.match(at(s.sent, 1), /\[\$5\/\$25; unknown\]/u);
});

test("model_select: re-injects on a change of rules, and again when returning to an earlier state (A to B to A)", async () => {
  const s = setup({
    service: false,
    guidance: {
      ...guidance,
      rules: [...guidance.rules, { match: /^google\//u, rule: "flash rule" }],
    },
  });
  s.ctl.sessionStart(s.ctx(opus));
  assert.equal(s.sent.length, 1);
  await s.ctl.modelSelect(s.ctx(flash), flash);
  assert.equal(s.sent.length, 2, "rules changed");
  assert.equal(s.sent[1], "flash rule");
  await s.ctl.modelSelect(s.ctx(flash), flash);
  assert.equal(s.sent.length, 2, "unchanged");
  await s.ctl.modelSelect(s.ctx(opus), opus);
  assert.equal(s.sent.length, 3);
  assert.equal(s.sent[2], PLAIN);
});

test("model_select with no model uses no rules", async () => {
  const s = setup();
  await s.ctl.modelSelect(s.ctx(opus), null);
  assert.deepEqual(s.sent, [], "no model, no rules, no billing text: nothing");
});

test("a cached query that settles after shutdown injects nothing", async () => {
  const s = setup();
  s.purse.mode = "manual";
  const done = s.ctl.sessionCompact(s.ctx());
  s.ctl.shutdown();
  await done;
  assert.deepEqual(s.sent, []);
});

test("no guided models: no billing queries at all", async () => {
  const s = setup({ guidance: { entries: [], rules: [{ match: /./u, rule: "r" }] } });
  s.ctl.sessionStart(s.ctx());
  await s.ctl.sessionCompact(s.ctx());
  assert.equal(s.purse.seen.length, 0);
  assert.deepEqual(s.sent, ["r"]);
});

test("guidance billing providers follow the inventory at the time of the event", async () => {
  const s = setup();
  s.ctl.sessionStart({ ...s.ctx(), modelRegistry: { getAvailable: () => [at(inventory, 1)] } });
  assert.deepEqual(at(s.purse.seen, 0).providers, ["google"]);
});

test("a change notification for a provider that is not a guidance provider starts no query", () => {
  const s = setup();
  s.ctl.sessionStart(s.ctx());
  const before = s.purse.seen.length;
  s.bus.notify(["openai"]);
  assert.equal(s.purse.seen.length, before);
});

// ------------------------------------------------------------ not-ready start-up

test("a not-ready poll answer keeps the start-up message waiting; a later answer under the change rule releases it", async () => {
  const s = setup();
  s.purse.answer = () => reply({}, { status: "not-ready" });
  s.ctl.sessionStart(s.ctx());
  await tick();
  assert.deepEqual(s.sent, [], "not-ready is not an answer");
  s.timers.advance(60_000);
  await tick();
  assert.deepEqual(s.sent, [], "no timer releases it");
  // purse became ready and announced a change: a poll starts, and its answer releases the message.
  s.purse.answer = (request) =>
    request.mode === "auto" ? s.billingReply() : reply({}, { status: "not-ready" });
  s.bus.notify(["anthropic"]);
  await tick();
  await tick();
  assert.equal(s.sent.length, 1);
  assert.match(
    at(s.sent, 0),
    /- anthropic\/opus: \[\$5\/\$25; unknown\]/u,
    "content computed when the answer arrives",
  );
});

test("a session_start during the wait makes no injection of its own", async () => {
  const s = setup();
  s.purse.answer = () => reply({}, { status: "not-ready" });
  s.ctl.sessionStart(s.ctx());
  await tick();
  s.ctl.sessionStart(s.ctx());
  s.ctl.sessionStart(s.ctx());
  await tick();
  assert.deepEqual(s.sent, []);
  s.purse.answer = s.billingReply;
  s.ctl.sessionStart(s.ctx());
  await tick();
  await tick();
  assert.equal(s.sent.length, 1, "one message once a poll is answered");
});

test("shutdown cancels a start-up message that is waiting on not-ready", async () => {
  const s = setup();
  s.purse.answer = () => reply({}, { status: "not-ready" });
  s.ctl.sessionStart(s.ctx());
  await tick();
  s.ctl.shutdown();
  s.purse.answer = s.billingReply;
  s.bus.notify(["anthropic"]);
  await tick();
  assert.deepEqual(s.sent, []);
});

test("a session_start whose poll answers at once injects once, with its own context", async () => {
  const s = setup({
    guidance: {
      ...guidance,
      rules: [...guidance.rules, { match: /^google\//u, rule: "flash rule" }],
    },
  });
  s.purse.answer = () => reply({}, { status: "not-ready" });
  s.ctl.sessionStart(s.ctx(opus));
  await tick();
  assert.deepEqual(s.sent, [], "the start-up message waits on the not-ready poll");
  // The service is gone, so the next poll's outcome, `no-service`, is known the moment it is
  // emitted, and the deferred injection is released synchronously inside `session_start`.
  s.purse.detach();
  s.ctl.sessionStart(s.ctx(flash));
  assert.deepEqual(s.sent, ["flash rule"], "one injection, computed with the second context");
});

// ------------------------------------------------------------ diagnostics of failures (billing.md 4.5)

test("an unreadable guidance billing provider list is reported as one diagnostic", () => {
  const diagnostics: Diagnostic[] = [];
  // A read of the guidance that throws: the guidance, not the host model list, is hostile here,
  // so the provider read fails on its own and no guidance computation is involved.
  const hostile = {
    entries: [
      {
        get key(): string {
          throw new Error("hostile guidance");
        },
        provider: "anthropic",
        id: "opus",
        when: "hard problems",
      },
    ],
    rules: [],
  } as unknown as ModelGuidance;
  const s = setup({ guidance: hostile, diagnostics: (d) => diagnostics.push(d) });
  s.bus.notify(["anthropic"]);
  assert.equal(diagnostics.length, 1);
  assert.equal(at(diagnostics, 0).level, "warning");
  assert.equal(s.purse.seen.length, 0, "no query for providers that could not be read");
});

test("a deferred injection that throws is reported as one diagnostic", async () => {
  const diagnostics: Diagnostic[] = [];
  const s = setup({
    diagnostics: (d) => diagnostics.push(d),
    send: () => {
      throw new Error("the session is gone");
    },
  });
  s.purse.mode = "manual";
  s.ctl.sessionStart(s.ctx());
  at(s.purse.open, 0)(s.billingReply());
  await tick();
  assert.equal(diagnostics.length, 1);
  assert.equal(at(diagnostics, 0).level, "warning");
});
