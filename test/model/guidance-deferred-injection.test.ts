import assert from "node:assert/strict";
import { test } from "node:test";
import type { BootConfig } from "../../lib/config.ts";
import { GuidanceController, type GuidanceContext } from "../../lib/guidance-controller.ts";
import {
  GUIDANCE_CUSTOM_TYPE,
  type ModelGuidance,
  parseModelGuidance,
} from "../../lib/model-guidance.ts";
import {
  FakeBus,
  FakePurse,
  FakeTimers,
  NOW,
  entry,
  model,
  reply,
  tick,
} from "../billing/fakes.ts";

/**
 * Model guidance per specs/model-guidance.md#guidance-message: a `session_start` injection deferred until a
 * billing poll has an outcome other than `not-ready` is released with the plain rules when that poll
 * ends without an answer.
 */

/** Parsed guidance of one `modelGuidance` configuration, as the extension builds it at boot. */
function guidanceOf(
  models: Record<string, { when: string }>,
  rules: Array<{ match: string; rule: string }> = [],
): ModelGuidance {
  const config: BootConfig = {
    merged: { modelGuidance: { models, rules } },
    layers: {},
    projectRoot: "/proj",
    diagnostics: [],
    liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
  };
  const { guidance, diagnostics } = parseModelGuidance(config);
  assert.deepEqual(diagnostics, [], JSON.stringify(diagnostics));
  return guidance;
}

const guidance: ModelGuidance = guidanceOf(
  {
    "anthropic/opus": { when: "hard problems" },
    "google/flash": { when: "quick edits" },
  },
  [{ match: "^anthropic/", rule: "think twice" }],
);
const inventory = [
  { provider: "anthropic", id: "opus" },
  { provider: "google", id: "flash" },
];
const opus = { provider: "anthropic", id: "opus" };

const PLAIN = "think twice";

function setup() {
  const bus = new FakeBus();
  const purse = new FakePurse(bus);
  const timers = new FakeTimers();
  const sent: string[] = [];
  const ctl = new GuidanceController({
    guidance,
    billingEnabled: true,
    bus,
    timeZone: "UTC",
    timers,
    now: () => NOW,
    send: (message) => {
      assert.equal(message.customType, GUIDANCE_CUSTOM_TYPE);
      assert.equal(message.display, true);
      sent.push(message.content);
    },
  });
  const ctx = (): GuidanceContext => ({
    model: opus,
    sessionManager: { getBranch: () => [] },
    modelRegistry: { getAvailable: () => inventory },
  });
  const billingReply = () =>
    reply({
      anthropic: entry({ models: { opus: model(5, 25) } }),
      google: entry({ models: { flash: model(0.5, 3) } }),
    });
  return { bus, purse, timers, sent, ctl, ctx, billingReply };
}

test("an immediate poll answer releases a deferred injection that waited on a not-ready poll", async () => {
  const s = setup();
  s.purse.answer = () => reply({}, { status: "not-ready" });
  // session_start registers the deferred injection and a waiter on the pending poll.
  s.ctl.sessionStart(s.ctx());
  await tick();
  assert.deepEqual(s.sent, [], "not-ready is not an answer");

  // The service disappears: the next poll (via change notification) ends immediately
  // without a pending answer. The waiter must still be released with the plain text.
  s.purse.bus.listeners.delete("purse:query:v1");
  s.bus.notify(["anthropic"]);
  await tick();
  assert.deepEqual(s.sent, [PLAIN]);
});
