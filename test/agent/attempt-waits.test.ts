import { test, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  getApiProvider,
  registerFauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot, type ToolResult } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession } from "../../lib/host.ts";
import { at, must } from "../support/must.ts";

/**
 * specs/agent-tool.md Sections 4.2-4.3: an attempt waits while its task registry
 * holds a running row; the completion notification triggers a notification turn.
 * Real child sessions run on a scripted faux provider; the inner background
 * agent blocks on a gate the test opens.
 */

// An isolated pi agent dir whose auth holds a key for the faux provider.
const agentDir = mkdtempSync(join(tmpdir(), "pi-dent-waits-"));
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const faux = registerFauxProvider({ models: [{ id: "m" }], tokensPerSecond: 60 });
after(() => faux.unregister());
const realCreate = ModelRuntime.create.bind(ModelRuntime);
ModelRuntime.create = async (options) => {
  const runtime = await realCreate(options);
  runtime.registerProvider(faux.models[0].provider, {
    apiKey: "k",
    baseUrl: "http://faux.invalid",
    api: faux.api as never,
    streamSimple: must(getApiProvider(faux.api as never)).streamSimple as never,
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
  });
  return runtime;
};

function bootWith(liveness: { idleTimeoutMs: number; absoluteTimeoutMs: number }): BootSnapshot {
  return {
    cwd: "/tmp",
    config: { merged: {}, layers: {}, projectRoot: "/tmp", diagnostics: [], liveness },
    agents: [],
    agentIndex: new Map(),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: 0,
    sessionTtlDays: 30,
  } as unknown as BootSnapshot;
}

const model = faux.getModel();
function makeHost(notifications: string[] = [], tools: string[] = ["Agent"]): HostSession {
  return {
    cwd: () => "/tmp",
    sessionId: () => `sess-${Math.random().toString(36).slice(2)}`,
    sessionFile: () => undefined,
    sessionDir: () => "/tmp",
    model: () => ({ provider: model.provider, id: model.id }),
    thinking: () => undefined,
    activeTools: () => tools,
    inventory: () => [model as never],
    configuredModels: () => [model as never],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: (m) => notifications.push(m),
  };
}

const gateTo = () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return { gate, open };
};

/**
 * Scripts the outer child and the inner background child (system prompt "INNER"); `outer`
 * picks the outer's reply from its turn index and whether the notification arrived.
 */
function script(
  gate: Promise<void> | Promise<void>[],
  outer: (turn: number, notified: boolean) => AssistantMessage,
  innerText = "inner done",
) {
  const gates = Array.isArray(gate) ? gate : [gate];
  let turn = 0;
  let inners = 0;
  const step: FauxResponseStep = async (context) => {
    const first = JSON.stringify(context.messages[0]);
    if (first.includes("INNER")) {
      await gates[Math.min(inners++, gates.length - 1)];
      return fauxAssistantMessage(innerText);
    }
    const last = JSON.stringify(context.messages.at(-1));
    return outer(turn++, last.includes("Background tasks settled"));
  };
  faux.setResponses(Array.from({ length: 12 }, () => step));
}

const startInner = () =>
  fauxAssistantMessage(
    [fauxToolCall("Agent", { prompt: "INNER", task: "wait", background: true })],
    {
      stopReason: "toolUse",
    },
  );
/** Starts the inner task, ends its turn, then answers the notification. */
const startThenWait = (turn: number, notified: boolean) =>
  turn === 0 ? startInner() : fauxAssistantMessage(notified ? "notified" : "started");

const idle = { idleTimeoutMs: 0, absoluteTimeoutMs: 0 };
const dispatch = (engine: DispatchEngine, extra: object = {}) =>
  engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "OUTER", task: "go", background: false },
    host: makeHost(),
    cohortId: "cohort-1",
    ...extra,
  });
const text = (r: { content: { type: string; text?: string }[] }) => r.content[0]?.text ?? "";
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const orphans = (engine: DispatchEngine) => engine.registry.list().filter((row) => row.orphan);

/** Settles `promise` to its value, or "pending" when it does not settle within `ms`. */
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, tick(ms).then(() => "pending" as const)]);

test("an attempt waits for its running task; the notification turn's text is the result", async () => {
  const { gate, open } = gateTo();
  script(gate, startThenWait);
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const p = dispatch(engine);
  assert.equal(await within(p, 700), "pending", "the dispatch must not settle while the task runs");
  open();
  const result = await p;
  assert.equal(result.isError, undefined);
  assert.equal(text(result), "notified");
  const record = at((result.details as { results: { usage: { turns: number } }[] }).results, 0);
  assert.equal(
    record.usage.turns,
    3,
    "usage aggregates the tool turn, the wait turn, and the notification turn",
  );
  assert.equal(orphans(engine).length, 0, "nothing is adopted into the parent registry");
});

test("an attempt with no running row completes after its single turn", async () => {
  script(Promise.resolve(), () => fauxAssistantMessage("plain"));
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await dispatch(engine);
  assert.equal(text(result), "plain");
  assert.equal(
    at((result.details as { results: { usage: { turns: number } }[] }).results, 0).usage.turns,
    1,
  );
});

test("an error turn with a running row ends the attempt at once; the row is adopted", async () => {
  const { gate, open } = gateTo();
  script(gate, (turn) =>
    turn === 0
      ? startInner()
      : fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
  );
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await within(dispatch(engine), 3000);
  assert.notEqual(result, "pending");
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal(orphans(engine).length, 1, "the running row is adopted");
  open();
  await tick(300);
});

test("a cancellation while waiting ends the attempt at once; the row is adopted", async () => {
  const { gate, open } = gateTo();
  script(gate, startThenWait);
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const controller = new AbortController();
  const p = dispatch(engine, { signal: controller.signal });
  assert.equal(await within(p, 700), "pending");
  controller.abort();
  const result = await within(p, 3000);
  assert.notEqual(result, "pending");
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal(orphans(engine).length, 1);
  open();
  await tick(300);
});

test("the idle deadline does not run while the attempt waits", async () => {
  // The inner task streams for longer than the idle deadline while the outer is
  // silent. An idle deadline that ran during the wait would end the attempt, so
  // the notification's answer is the observable: it can only arrive afterwards.
  script(Promise.resolve(), startThenWait, Array.from({ length: 90 }, (_, i) => `w${i}`).join(" "));
  const engine = new DispatchEngine(
    bootWith({ idleTimeoutMs: 500, absoluteTimeoutMs: 0 }),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await dispatch(engine);
  assert.equal(result.isError, undefined, text(result));
  assert.equal(text(result), "notified", "the attempt outlived the idle deadline while waiting");
});

test("the idle deadline expires on a silent attempt", async () => {
  // The child's first model turn emits no event until the gate opens, which is
  // longer than the idle deadline; the answer then arrives on an aborted attempt.
  const { gate, open } = gateTo();
  const timer = setTimeout(open, 300);
  const step: FauxResponseStep = async () => {
    await gate;
    return fauxAssistantMessage("late");
  };
  faux.setResponses(Array.from({ length: 4 }, () => step));
  const engine = new DispatchEngine(
    bootWith({ idleTimeoutMs: 50, absoluteTimeoutMs: 0 }),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await within(dispatch(engine), 3000);
  clearTimeout(timer);
  assert.notEqual(result, "pending", "an attempt that emits no event is ended by the deadline");
  const settled = result as unknown as ToolResult;
  assert.equal(settled.isError, true);
  const outcomes = settled.details as {
    results: { stopReason?: string; failureCode?: string }[];
  };
  const record = at(outcomes.results, 0);
  assert.equal(record.stopReason, "timeout");
  assert.equal(record.failureCode, "timeout");
  assert.match(text(settled), /idle timeout after 50ms/);
  open();
  await tick(300);
});

test("the absolute deadline bounds the wait", async () => {
  const { gate, open } = gateTo();
  script(gate, startThenWait);
  const engine = new DispatchEngine(
    bootWith({ idleTimeoutMs: 0, absoluteTimeoutMs: 800 }),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await within(dispatch(engine), 4000);
  assert.notEqual(result, "pending");
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(text(result as never), /absolute timeout/);
  open();
  await tick(300);
});

test("a Fleet query dispatch (planToolCap) never waits", async () => {
  const { gate, open } = gateTo();
  script(gate, startThenWait);
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await within(dispatch(engine, { planToolCap: ["Agent"], fleetQuery: true }), 3000);
  assert.notEqual(result, "pending", "the query settles while its task still runs");
  assert.equal(text(result as never), "started");
  open();
  await tick(300);
});

const longText = Array.from({ length: 90 }, (_, i) => `w${i}`).join(" ");

test("a notification arriving while the child streams is taken by the same run", async () => {
  const { gate, open } = gateTo();
  script(gate, (turn, notified) =>
    turn === 0 ? startInner() : fauxAssistantMessage(notified ? "notified" : longText),
  );
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const p = dispatch(engine);
  await tick(400); // the outer is streaming its long second turn
  open();
  const result = await within(p, 5000);
  assert.notEqual(result, "pending");
  assert.equal(text(result as never), "notified");
  assert.equal(orphans(engine).length, 0);
});

test("the renderResult projection keeps the ten latest progress lines", async () => {
  const readCall = () =>
    fauxAssistantMessage([fauxToolCall("read", { path: "/nonexistent/pi-dent-projection" })], {
      stopReason: "toolUse",
    });
  const taskCall = () =>
    fauxAssistantMessage([fauxToolCall("Task", {})], { stopReason: "toolUse" });
  // The first six calls name one tool and the last six another, so the first ten lines
  // and the last ten are distinguishable.
  faux.setResponses([
    ...Array.from({ length: 6 }, () => readCall),
    ...Array.from({ length: 6 }, () => taskCall),
    () => fauxAssistantMessage("done"),
  ]);
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const updates: string[] = [];
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "OUTER", task: "go", background: false },
    host: makeHost([], ["Agent", "read", "Task"]),
    cohortId: "cohort-1",
    onUpdate: (partial) => {
      const part = partial.content[0];
      if (part?.type === "text") updates.push(part.text);
    },
  });
  assert.equal(result.isError, undefined, text(result));
  assert.equal(text(result), "done");
  const projections = updates.map((update) =>
    update.split("\n").filter((line) => line.startsWith("tool_")),
  );
  assert.equal(Math.max(...projections.map((lines) => lines.length)), 10);
  const longest = must(projections.findLast((lines) => lines.length === 10));
  assert.deepEqual(longest, [
    "tool_call Task",
    "tool_result Task",
    "tool_call Task",
    "tool_result Task",
    "tool_call Task",
    "tool_result Task",
    "tool_call Task",
    "tool_result Task",
    "tool_call Task",
    "tool_result Task",
  ]);
  assert.equal(
    must(engine.registry.list()[0]).progress.length,
    24,
    "the task row's progress keeps every line",
  );
});

test("a notification turn that starts another task keeps the attempt waiting", async () => {
  const first = gateTo();
  const second = gateTo();
  const replies = [
    startInner,
    () => "started",
    startInner,
    () => "started again",
    () => "all done",
  ];
  script([first.gate, second.gate], (turn) => {
    const reply = at(replies, turn)();
    return typeof reply === "string" ? fauxAssistantMessage(reply) : reply;
  });
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const p = dispatch(engine);
  first.open();
  assert.equal(await within(p, 1000), "pending", "the second task is still running");
  second.open();
  const result = await within(p, 3000);
  assert.notEqual(result, "pending");
  assert.equal(text(result as never), "all done");
  assert.equal(orphans(engine).length, 0);
});

test("a cancellation during a notification turn records the aborted turn before disposal", async () => {
  const { gate, open } = gateTo();
  script(gate, (turn, notified) =>
    turn === 0 ? startInner() : fauxAssistantMessage(notified ? longText : "started"),
  );
  const engine = new DispatchEngine(
    bootWith(idle),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const controller = new AbortController();
  const p = dispatch(engine, { signal: controller.signal });
  await tick(300);
  open();
  await tick(500); // the notification turn is streaming
  controller.abort();
  const result = (await within(p, 4000)) as Awaited<ReturnType<typeof dispatch>>;
  assert.notEqual(result as unknown, "pending");
  assert.equal(result.isError, true);
  const file = at(
    (result.details as { results: { sessionPath: string }[] }).results,
    0,
  ).sessionPath;
  assert.match(readFileSync(file, "utf8"), /"stopReason":"aborted"/);
});
