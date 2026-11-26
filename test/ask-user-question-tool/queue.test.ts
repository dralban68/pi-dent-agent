import { test } from "node:test";
import assert from "node:assert/strict";
import { panelContent, params, question, questionWorld } from "./support.ts";

/**
 * specs/ask-user-question-tool.md#asking: the question queue. Only the first call of a
 * session is asked, the next is asked when the earlier returns, and specs/ask-user-question-tool.md#no-answers says what
 * ends a call.
 */

const first = question("Auth", "Which login method should the app use?", [
  ["OAuth", "Use an external provider"],
  ["Password", "Own accounts"],
]);
const second = question("Targets", "Which platforms must it support?", [
  ["macOS", "Apple laptops"],
  ["Linux", "Linux desktops"],
]);
const third = question("Scope", "How much should ship?", [
  ["Small", "The core only"],
  ["Large", "Everything"],
]);

const call = (q: typeof first) => params([{ ...q }]);
const questionShown = (lines: readonly string[], q: typeof first): boolean =>
  panelContent(lines).includes(q.question);

test("a second call of the session waits until the first returns", async () => {
  const world = questionWorld();
  const one = world.startPanel({ params: call(first), sessionId: "queue" });
  const two = world.startPanel({ params: call(second), sessionId: "queue" });
  // Only the first call's panel exists.
  assert.equal(world.editors.length, 1);
  assert.equal(questionShown(one.lines(), first), true);
  one.press("1");
  await one.result;
  // The next call is asked when the earlier one returns.
  assert.equal(world.editors.length, 2);
  assert.equal(questionShown(two.lines(), second), true);
  two.press("1");
  const result = await two.result;
  assert.deepEqual(result.details.answers[0]?.options, ["macOS"]);
});

test("the queue holds the calls in the order they reached it", async () => {
  const world = questionWorld();
  const one = world.startPanel({ params: call(first), sessionId: "order" });
  const two = world.startPanel({ params: call(second), sessionId: "order" });
  const three = world.startPanel({ params: call(third), sessionId: "order" });
  one.press("1");
  await one.result;
  assert.equal(questionShown(two.lines(), second), true);
  two.press("1");
  await two.result;
  assert.equal(questionShown(three.lines(), third), true);
  three.press("1");
  assert.equal((await three.result).details.outcome, "answered");
});

test("the next call is asked after a dismissed result", async () => {
  const world = questionWorld();
  const one = world.startPanel({ params: call(first), sessionId: "dismissed" });
  const two = world.startPanel({ params: call(second), sessionId: "dismissed" });
  one.press("\u001b");
  one.press("s");
  assert.equal((await one.result).details.outcome, "dismissed");
  assert.equal(world.editors.length, 2);
  assert.equal(questionShown(two.lines(), second), true);
});

test("the next call is asked after a stopped result", async () => {
  const world = questionWorld();
  const one = world.startPanel({ params: call(first), sessionId: "stopped" });
  const next = world.startPanel({ params: call(second), sessionId: "stopped" });
  one.press("\u001b");
  one.press("x");
  assert.equal((await one.result).details.outcome, "stopped");
  assert.equal(world.editors.length, 2);
  assert.equal(questionShown(next.lines(), second), true);
});

test("the next call is asked after an aborted result", async () => {
  const controller = new AbortController();
  const world = questionWorld();
  const one = world.startPanel({
    params: call(first),
    sessionId: "aborted-next",
    signal: controller.signal,
  });
  const two = world.startPanel({ params: call(second), sessionId: "aborted-next" });
  controller.abort();
  assert.equal((await one.result).details.outcome, "aborted");
  assert.equal(world.editors.length, 2);
  assert.equal(questionShown(two.lines(), second), true);
});

test("a queued call whose signal aborts leaves the queue and is never asked", async () => {
  const world = questionWorld();
  const controller = new AbortController();
  const one = world.startPanel({ params: call(first), sessionId: "queued-abort" });
  const two = world.startPanel({
    params: call(second),
    sessionId: "queued-abort",
    signal: controller.signal,
  });
  const three = world.startPanel({ params: call(third), sessionId: "queued-abort" });
  assert.equal(world.editors.length, 1);
  controller.abort();
  assert.equal((await two.result).details.outcome, "aborted");
  // The aborted call was never asked, and the call after it is asked once the first returns.
  assert.equal(world.editors.length, 1);
  one.press("1");
  await one.result;
  assert.equal(world.editors.length, 2);
  assert.equal(questionShown(three.lines(), third), true);
});

test("session_shutdown ends every open call and asks none after it", async () => {
  const world = questionWorld();
  const one = world.startPanel({ params: call(first), sessionId: "shutdown" });
  const two = world.startPanel({ params: call(second), sessionId: "shutdown" });
  world.runtime.sessionShutdown("shutdown");
  assert.equal((await one.result).details.outcome, "shutdown");
  assert.equal((await two.result).details.outcome, "shutdown");
  assert.equal(world.editors.length, 1);
});

test("calls of different sessions are asked at the same time", async () => {
  const world = questionWorld();
  const one = world.startPanel({ params: call(first), sessionId: "session-a" });
  const two = world.startPanel({ params: call(second), sessionId: "session-b" });
  assert.equal(world.editors.length, 2);
  two.press("1");
  assert.equal((await two.result).details.outcome, "answered");
  // The other session's call is still open.
  one.press("1");
  assert.equal((await one.result).details.outcome, "answered");
});

test("a call that reaches a session with no user interface is not queued", async () => {
  const world = questionWorld();
  const one = world.startPanel({ params: call(first), sessionId: "no-ui-queue" });
  const skipped = world.startPanel({
    params: call(second),
    sessionId: "no-ui-queue",
    hasUI: false,
  });
  assert.equal((await skipped.result).details.outcome, "no-ui");
  assert.equal(world.editors.length, 1);
  one.press("1");
  await one.result;
  // The no-UI call left no panel behind.
  assert.equal(world.editors.length, 1);
});
