import "../support/isolate-session-store.ts";
import assert from "node:assert/strict";
import { isolateTaskLedger } from "../support/task-ledger-env.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FakeBus, FakePurse, entry, model, reply } from "./fakes.ts";
import { at } from "../support/must.ts";

/**
 * Extension wiring of specs/billing.md Sections 1 and 4.1: one subscription
 * per factory call on that call's own event bus, none while billing is
 * disabled, and the handlers reach the guidance controller. index.ts is loaded
 * through jiti, as in test/skills/main-session-skill.test.ts.
 */

const entryDir = fileURLToPath(new URL(".", import.meta.url));
const jiti = createJiti(import.meta.url);
const factory = (
  await jiti.import<{ default: (pi: ExtensionAPI) => Promise<void> | void }>(
    join(entryDir, "..", "..", "index.ts"),
  )
).default;

type Handler = (event?: unknown, ctx?: unknown) => unknown;

function makeStubPi(bus: FakeBus) {
  const handlers = new Map<string, Handler[]>();
  const sent: { message: { content: string }; options: unknown }[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerShortcut: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    getAllTools: () => [],
    sendMessage: (message: { content: string }, options: unknown) =>
      sent.push({ message, options }),
    sendUserMessage: async () => {},
    events: bus,
  } as unknown as ExtensionAPI;
  return { pi, handlers, sent };
}

function makeProject(modelGuidance: unknown): () => void {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-billing-wiring-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".pi", "pi-dent"), { recursive: true });
  mkdirSync(join(project, ".pi", "pi-dent"), { recursive: true });
  writeFileSync(join(project, ".pi", "pi-dent", "pi-dent.conf"), JSON.stringify({ modelGuidance }));
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  process.env.HOME = home;
  const restoreLedger = isolateTaskLedger(home);
  process.chdir(project);
  return () => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    restoreLedger();
    rmSync(root, { recursive: true, force: true });
  };
}

/** A reload shutdown clears the cached boot window so the next factory call re-reads. */
async function shutdown(handlers: Map<string, Handler[]>): Promise<void> {
  for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" });
}

const guided = { models: { "anthropic/opus": { when: "hard problems" } } };
const ctx = {
  model: { provider: "anthropic", id: "opus" },
  sessionManager: { getBranch: () => [] },
  modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "opus" }] },
};

interface Notification {
  message: string;
  level: string | undefined;
}

/** A live main-session context of `project` that records every notification (Section 4.5). */
function liveContext(project: string, notifications: Notification[]): Record<string, unknown> {
  return {
    cwd: project,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string, level: string | undefined) =>
        notifications.push({ message, level }),
      setStatus: () => {},
      setWidget: () => {},
      custom: async () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => "billing-main",
      getEntries: () => [],
      getHeader: () => null,
      getSessionFile: () => join(project, "session.jsonl"),
      getSessionDir: () => project,
      getBranch: () => [],
    },
    model: { provider: "anthropic", id: "opus" },
    thinkingLevel: undefined,
    modelRegistry: {
      getAll: () => [],
      getAvailable: () => [{ provider: "anthropic", id: "opus" }],
    },
    isIdle: () => true,
    abort: () => {},
    compact: () => {},
    getContextUsage: () => undefined,
  };
}

function billingNotifications(notifications: Notification[]): Notification[] {
  return notifications.filter((call) => call.message.startsWith("pi-dent: billing: "));
}

test("each factory call subscribes once on its own bus; shutdown unsubscribes", async () => {
  const restore = makeProject(guided);
  const busA = new FakeBus();
  const busB = new FakeBus();
  const a = makeStubPi(busA);
  const b = makeStubPi(busB);
  try {
    await factory(a.pi);
    await factory(b.pi);
    assert.equal(busA.listenerCount("purse:changed:v1"), 1);
    assert.equal(busB.listenerCount("purse:changed:v1"), 1);
    await shutdown(a.handlers);
    assert.equal(busA.listenerCount("purse:changed:v1"), 0);
    assert.equal(busB.listenerCount("purse:changed:v1"), 1, "the other instance is untouched");
  } finally {
    await shutdown(b.handlers);
    restore();
  }
});

test("modelGuidance.billing false: no subscription and no emit", async () => {
  const restore = makeProject({ ...guided, billing: false });
  const bus = new FakeBus();
  new FakePurse(bus);
  const stub = makeStubPi(bus);
  try {
    await factory(stub.pi);
    assert.equal(bus.listenerCount("purse:changed:v1"), 0);
    assert.equal(bus.emitted.length, 0);
  } finally {
    await shutdown(stub.handlers);
    restore();
  }
});

test("session_compact reaches the controller: cached query, then sendMessage with no turn", async () => {
  const restore = makeProject(guided);
  const bus = new FakeBus();
  const purse = new FakePurse(bus);
  purse.answer = () => reply({ anthropic: entry({ models: { opus: model(5, 25) } }) });
  const stub = makeStubPi(bus);
  try {
    await factory(stub.pi);
    for (const handler of stub.handlers.get("session_compact") ?? []) await handler({}, ctx);
    assert.equal(purse.seen.at(-1)?.mode, "cached");
    assert.equal(stub.sent.length, 1);
    assert.deepEqual(at(stub.sent, 0).options, { triggerTurn: false });
    assert.match(at(stub.sent, 0).message.content, /\[\$5\/\$25; unknown\]/u);
  } finally {
    await shutdown(stub.handlers);
    restore();
  }
});

test("no before_agent_start guidance handler is registered (once per session)", async () => {
  const restore = makeProject(guided);
  const bus = new FakeBus();
  new FakePurse(bus);
  const stub = makeStubPi(bus);
  try {
    await factory(stub.pi);
    // Only the skill catalog handler may sit here; guidance injects on session events only.
    for (const handler of stub.handlers.get("before_agent_start") ?? []) {
      const result = (await handler({}, ctx)) as { message?: unknown } | undefined;
      assert.equal(result?.message, undefined, "no guidance message on before_agent_start");
    }
  } finally {
    await shutdown(stub.handlers);
    restore();
  }
});

test("a diagnostic with no open session is held until the next session_start (Section 4.5)", async () => {
  const restore = makeProject(guided);
  const bus = new FakeBus();
  new FakePurse(bus);
  // The subscription itself fails: the instance reports it with no session open.
  bus.on = () => {
    throw new Error("the bus is unavailable");
  };
  const stub = makeStubPi(bus);
  const notifications: Notification[] = [];
  const session = liveContext(process.cwd(), notifications) as unknown as ExtensionContext;
  try {
    await factory(stub.pi);
    assert.deepEqual(
      billingNotifications(notifications),
      [],
      "no session is open: nothing is shown",
    );

    for (const handler of stub.handlers.get("session_start") ?? []) {
      await handler({ reason: "startup" }, session);
    }
    const shown = billingNotifications(notifications);
    assert.equal(shown.length, 1, JSON.stringify(notifications));
    assert.equal(
      at(shown, 0).message,
      "pi-dent: billing: change notifications are unavailable: the bus is unavailable",
    );
    assert.equal(at(shown, 0).level, "warning");

    // The hold is emptied by that start: a later session_start repeats nothing.
    for (const handler of stub.handlers.get("session_start") ?? []) {
      await handler({ reason: "startup" }, session);
    }
    assert.equal(billingNotifications(notifications).length, 1);
  } finally {
    await shutdown(stub.handlers);
    restore();
  }
});

test("a diagnostic raised while a session is open is shown at once (Section 4.5)", async () => {
  const restore = makeProject(guided);
  const bus = new FakeBus();
  new FakePurse(bus);
  // Subscribing succeeds; cancelling the subscription fails at the instance's shutdown.
  const subscribe = bus.on.bind(bus);
  bus.on = (channel, handler) => {
    const unsubscribe = subscribe(channel, handler);
    return () => {
      unsubscribe();
      throw new Error("the bus is gone");
    };
  };
  const stub = makeStubPi(bus);
  const notifications: Notification[] = [];
  const session = liveContext(process.cwd(), notifications) as unknown as ExtensionContext;
  try {
    await factory(stub.pi);
    for (const handler of stub.handlers.get("session_start") ?? []) {
      await handler({ reason: "startup" }, session);
    }
    assert.deepEqual(billingNotifications(notifications), [], "nothing has failed yet");

    for (const handler of stub.handlers.get("session_shutdown") ?? []) {
      await handler({ reason: "reload" }, session);
    }
    const shown = billingNotifications(notifications);
    assert.equal(shown.length, 1, JSON.stringify(notifications));
    assert.equal(
      at(shown, 0).message,
      "pi-dent: billing: the change subscription could not be cancelled: the bus is gone",
    );
    assert.equal(at(shown, 0).level, "warning");
  } finally {
    restore();
  }
});
