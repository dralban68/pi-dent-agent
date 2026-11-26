import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_USER_ABORTED_TEXT,
  ASK_USER_DISMISSED_TEXT,
  ASK_USER_NO_UI_TEXT,
  ASK_USER_SHUTDOWN_TEXT,
  ASK_USER_STOPPED_TEXT,
  askUserRuntime,
  type AskInvocation,
} from "../../lib/ask-user-question-tool.ts";
import { fakeUi, params, question, questionWorld } from "./support.ts";

/**
 * specs/ask-user-question-tool.md#asking, specs/ask-user-question-tool.md#no-answers, specs/ask-user-question-tool.md#results, and specs/ask-user-question-tool.md#details: every outcome, its text,
 * its `isError` and `terminate` flags, and its `details`.
 */

const auth = question("Auth", "Which login method should the app use?", [
  ["OAuth", "Use an external provider"],
  ["Password", "Own accounts"],
]);
const targets = question(
  "Targets",
  "Which platforms must it support?",
  [
    ["macOS", "Apple laptops"],
    ["Linux", "Linux desktops"],
  ],
  true,
);

const direct = () => params([{ ...auth }]);

const textOf = (result: { content: { type: string; text?: string }[] }): string => {
  const first = result.content[0];
  return first !== undefined && first.type === "text" ? (first.text ?? "") : "";
};

test("the answered result carries the questions' lines and its details (specs/ask-user-question-tool.md#answered-result)", async () => {
  const harness = questionWorld().startPanel({ params: direct() });
  harness.press("1");
  const result = await harness.result;
  assert.equal(result.details.outcome, "answered");
  assert.equal(result.isError, undefined);
  assert.equal(result.terminate, undefined);
  assert.equal(
    textOf(result),
    "The user answered your questions:\n1. Auth — Which login method should the app use?\n   option: OAuth",
  );
  assert.deepEqual(result.details.answers, [
    {
      header: "Auth",
      question: "Which login method should the app use?",
      options: ["OAuth"],
      text: null,
    },
  ]);
});

test("the answered result lists the free-text lines under `free text:`", async () => {
  const harness = questionWorld().startPanel({ params: params([{ ...targets }]) });
  harness.press("1");
  harness.press("j");
  harness.press("j");
  harness.press("\r");
  harness.editor.type("also FreeBSD,\nif cheap");
  harness.press("\r");
  harness.press("\t");
  harness.press("\r");
  const result = await harness.result;
  assert.equal(result.details.outcome, "answered");
  assert.equal(
    textOf(result),
    [
      "The user answered your questions:",
      "1. Targets — Which platforms must it support?",
      "   option: macOS",
      "   free text:",
      "   > also FreeBSD,",
      "   > if cheap",
    ].join("\n"),
  );
  assert.deepEqual(result.details.answers[0]?.options, ["macOS"]);
  assert.equal(result.details.answers[0]?.text, "also FreeBSD,\nif cheap");
});

test("a session without a user interface returns the no-UI result and shows nothing", async () => {
  const shown: string[] = [];
  const invocation: AskInvocation = {
    sessionId: "no-ui",
    toolCallId: "call-no-ui",
    params: direct(),
    signal: undefined,
    ui: fakeUi({
      custom: async () => {
        shown.push("custom");
        return undefined;
      },
      select: async () => {
        shown.push("select");
        return undefined;
      },
      input: async () => {
        shown.push("input");
        return undefined;
      },
    }),
    mode: "rpc",
    hasUI: false,
  };
  const result = await askUserRuntime().execute(invocation);
  assert.equal(textOf(result), ASK_USER_NO_UI_TEXT);
  assert.equal(result.isError, true);
  assert.equal(result.terminate, undefined);
  assert.deepEqual(result.details, { outcome: "no-ui", answers: [] });
  assert.deepEqual(shown, []);
});

test("an already aborted call returns the aborted result and shows nothing", async () => {
  const shown: string[] = [];
  const invocation: AskInvocation = {
    sessionId: "aborted-before",
    toolCallId: "call-aborted-before",
    params: direct(),
    signal: AbortSignal.abort(),
    ui: fakeUi({
      custom: async () => {
        shown.push("custom");
        return undefined;
      },
      select: async () => {
        shown.push("select");
        return undefined;
      },
      input: async () => {
        shown.push("input");
        return undefined;
      },
    }),
    mode: "tui",
    hasUI: true,
  };
  const result = await askUserRuntime().execute(invocation);
  assert.equal(textOf(result), ASK_USER_ABORTED_TEXT);
  assert.equal(result.isError, true);
  assert.equal(result.terminate, undefined);
  assert.deepEqual(result.details, { outcome: "aborted", answers: [] });
  assert.deepEqual(shown, []);
});

test("an abort while the panel is shown closes it with the aborted result (specs/ask-user-question-tool.md#no-answers)", async () => {
  const controller = new AbortController();
  const harness = questionWorld().startPanel({ params: direct(), signal: controller.signal });
  controller.abort();
  const result = await harness.result;
  assert.equal(textOf(result), ASK_USER_ABORTED_TEXT);
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, { outcome: "aborted", answers: [] });
  // The panel is closed: further keys change nothing.
  harness.press("s");
  harness.press("\r");
  assert.equal(harness.result instanceof Promise, true);
});

test("session_shutdown ends the shown panel with the shutdown result (specs/ask-user-question-tool.md#no-answers)", async () => {
  const world = questionWorld();
  const harness = world.startPanel({ params: direct(), sessionId: "shutdown-panel" });
  world.runtime.sessionShutdown("shutdown-panel");
  const result = await harness.result;
  assert.equal(textOf(result), ASK_USER_SHUTDOWN_TEXT);
  assert.equal(result.isError, true);
  assert.equal(result.terminate, undefined);
  assert.deepEqual(result.details, { outcome: "shutdown", answers: [] });
  assert.deepEqual(harness.lines().length > 0, true);
});

test("the dismissed and stopped results carry their texts and flags", async () => {
  const dismissed = questionWorld().startPanel({ params: direct() });
  dismissed.press("\u001b");
  dismissed.press("s");
  const dismissedResult = await dismissed.result;
  assert.equal(textOf(dismissedResult), ASK_USER_DISMISSED_TEXT);
  assert.equal(dismissedResult.isError, undefined);
  assert.equal(dismissedResult.terminate, undefined);
  assert.deepEqual(dismissedResult.details, { outcome: "dismissed", answers: [] });

  const stopped = questionWorld().startPanel({ params: direct() });
  stopped.press("\u001b");
  stopped.press("x");
  const stoppedResult = await stopped.result;
  assert.equal(textOf(stoppedResult), ASK_USER_STOPPED_TEXT);
  assert.equal(stoppedResult.isError, undefined);
  assert.equal(stoppedResult.terminate, true);
  assert.deepEqual(stoppedResult.details, { outcome: "stopped", answers: [] });
});

test("every result carries the outcome and answers of specs/ask-user-question-tool.md#details", async () => {
  const harness = questionWorld().startPanel({ params: direct() });
  harness.press("1");
  const answered = await harness.result;
  assert.equal(Object.keys(answered.details).toSorted().join(","), "answers,outcome");
  for (const key of Object.keys(answered.details.answers[0] ?? {}).toSorted()) {
    assert.equal(["header", "options", "question", "text"].includes(key), true);
  }
  assert.equal(Array.isArray(answered.details.answers), true);
});
