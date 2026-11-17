import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_DIALOG,
  ASK_USER_ABORTED_TEXT,
  ASK_USER_DISMISSED_TEXT,
  ASK_USER_SHUTDOWN_TEXT,
  ASK_USER_STOPPED_TEXT,
} from "../../lib/ask-user-question-tool.ts";
import type { AskToolResult } from "../../lib/ask-user-question-tool.ts";
import { at } from "../support/must.ts";
import { params, question, questionWorld } from "./support.ts";

/**
 * specs/ask-user-question-tool.md Section 4.4: the question form request. With
 * `PI_DENT_ASK_FORM` set to `1` in RPC mode, one `editor` dialog asks the whole call; its text is
 * the form answer, and an invalid text shows the same editor again.
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
const pair = () => params([{ ...auth }, { ...targets }]);

const formWorld = () => questionWorld({ env: { PI_DENT_ASK_FORM: "1" } });

/** The text of a form answer with the given answers, one per question. */
const answered = (answers: unknown[]): string => JSON.stringify({ outcome: "answered", answers });

/** An editor reply per dialog, in order; a missing reply is a cancel. */
const replies =
  (...values: (string | undefined)[]) =>
  (index: number): Promise<string | undefined> =>
    Promise.resolve(values[index]);

const oauthOnly = answered([{ options: ["OAuth"], text: null }]);

/** A reply the test settles itself, after the call has ended. */
function deferred(): {
  promise: Promise<string | undefined>;
  settle: (text: string | undefined) => void;
} {
  let resolve: (text: string | undefined) => void = () => undefined;
  const promise = new Promise<string | undefined>((done) => {
    resolve = done;
  });
  return { promise, settle: (text) => resolve(text) };
}

function textOf(result: AskToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === "text" ? first.text : "";
}

// ---------------------------------------------------------------------------
// The dialog and its payload
// ---------------------------------------------------------------------------

test("the editor is titled AskUserQuestion and prefilled with the form payload", async () => {
  const harness = formWorld().startForm({
    params: pair(),
    toolCallId: "tool-7",
    respond: replies(
      answered([
        { options: ["OAuth"], text: null },
        { options: [], text: "x" },
      ]),
    ),
  });
  const result = await harness.result;
  assert.equal(harness.calls.length, 1);
  const shown = at(harness.calls, 0);
  assert.equal(shown.args.length, 2);
  assert.equal(shown.title, "AskUserQuestion");
  assert.deepEqual(JSON.parse(shown.prefill), {
    piDent: "ask-form/1",
    toolCallId: "tool-7",
    questions: [
      {
        header: "Auth",
        question: "Which login method should the app use?",
        multiSelect: false,
        options: [
          { label: "OAuth", description: "Use an external provider" },
          { label: "Password", description: "Own accounts" },
        ],
      },
      {
        header: "Targets",
        question: "Which platforms must it support?",
        multiSelect: true,
        options: [
          { label: "macOS", description: "Apple laptops" },
          { label: "Linux", description: "Linux desktops" },
        ],
      },
    ],
  });
  assert.equal(result.details.outcome, "answered");
});

test("the form payload carries cleaned values", async () => {
  const harness = formWorld().startForm({
    params: {
      questions: [
        {
          header: "Au\u0007th",
          question: "Which\u001b[1m method?",
          options: [
            { label: "O\u001b[32mAuth", description: "Use \u0007one" },
            { label: "Password", description: "Own accounts" },
          ],
        },
      ],
    },
    respond: replies(oauthOnly),
  });
  await harness.result;
  const payload = JSON.parse(at(harness.calls, 0).prefill);
  assert.equal(payload.questions[0].header, "Auth");
  assert.equal(payload.questions[0].question, "Which method?");
  assert.deepEqual(payload.questions[0].options[0], { label: "OAuth", description: "Use one" });
});

// ---------------------------------------------------------------------------
// Answered, dismissed, and stopped form answers
// ---------------------------------------------------------------------------

test("a single-select answer with an option gives the answered result", async () => {
  const harness = formWorld().startForm({ params: direct(), respond: replies(oauthOnly) });
  const result = await harness.result;
  assert.equal(result.details.outcome, "answered");
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.answers, [
    {
      header: "Auth",
      question: "Which login method should the app use?",
      options: ["OAuth"],
      text: null,
    },
  ]);
  assert.equal(
    textOf(result),
    [
      "The user answered your questions:",
      "1. Auth — Which login method should the app use?",
      "   option: OAuth",
    ].join("\n"),
  );
});

test("a single-select answer with free text only records the text", async () => {
  const harness = formWorld().startForm({
    params: direct(),
    respond: replies(answered([{ options: [], text: "magic link" }])),
  });
  const result = await harness.result;
  assert.equal(result.details.outcome, "answered");
  assert.deepEqual(result.details.answers[0]?.options, []);
  assert.equal(result.details.answers[0]?.text, "magic link");
});

test("a multi-select answer takes its options in option order and records the free text", async () => {
  const harness = formWorld().startForm({
    params: params([{ ...targets }]),
    respond: replies(answered([{ options: ["Linux", "macOS"], text: "  first\r\nsecond  " }])),
  });
  const result = await harness.result;
  assert.equal(result.details.outcome, "answered");
  assert.deepEqual(result.details.answers[0]?.options, ["macOS", "Linux"]);
  assert.equal(result.details.answers[0]?.text, "first\nsecond");
  assert.equal(
    textOf(result),
    [
      "The user answered your questions:",
      "1. Targets — Which platforms must it support?",
      "   option: macOS",
      "   option: Linux",
      "   free text:",
      "   > first",
      "   > second",
    ].join("\n"),
  );
});

test("a multi-select answer with a blank free text records none", async () => {
  const harness = formWorld().startForm({
    params: params([{ ...targets }]),
    respond: replies(answered([{ options: ["Linux"], text: " \r\n  " }])),
  });
  const result = await harness.result;
  assert.deepEqual(result.details.answers[0]?.options, ["Linux"]);
  assert.equal(result.details.answers[0]?.text, null);
});

test("answers of several questions come in question order", async () => {
  const harness = formWorld().startForm({
    params: pair(),
    respond: replies(
      answered([
        { options: ["Password"], text: null },
        { options: ["Linux", "macOS"], text: null },
      ]),
    ),
  });
  const result = await harness.result;
  assert.deepEqual(
    result.details.answers.map((answer) => answer.options),
    [["Password"], ["macOS", "Linux"]],
  );
});

test("a dismissed form answer gives the dismissed result", async () => {
  const harness = formWorld().startForm({
    params: direct(),
    respond: replies('{"outcome":"dismissed"}'),
  });
  const result = await harness.result;
  assert.equal(result.details.outcome, "dismissed");
  assert.equal(textOf(result), ASK_USER_DISMISSED_TEXT);
  assert.equal(result.isError, undefined);
  assert.equal(result.terminate, undefined);
  assert.equal(harness.calls.length, 1);
});

test("a stopped form answer gives the stopped result", async () => {
  const harness = formWorld().startForm({
    params: direct(),
    respond: replies('{"outcome":"stopped"}'),
  });
  const result = await harness.result;
  assert.equal(result.details.outcome, "stopped");
  assert.equal(textOf(result), ASK_USER_STOPPED_TEXT);
  assert.equal(result.terminate, true);
});

// ---------------------------------------------------------------------------
// Invalid text shows the same editor again
// ---------------------------------------------------------------------------

const validPair = answered([
  { options: ["OAuth"], text: null },
  { options: ["macOS"], text: null },
]);

/** Each invalid text, the call it is sent for, and a valid reply for that call (Section 4.4). */
const invalidAnswers: [name: string, invalid: string, input: () => unknown, valid: string][] = [
  ["bad JSON", "not json", direct, oauthOnly],
  ["a JSON value that is not an object", "[]", direct, oauthOnly],
  ["an unknown outcome", '{"outcome":"maybe"}', direct, oauthOnly],
  ["a wrong number of answers", oauthOnly, pair, validPair],
  ["an answer that is not an object", answered(["OAuth"]), direct, oauthOnly],
  ["an unknown label", answered([{ options: ["Nope"], text: null }]), direct, oauthOnly],
  ["a duplicate label", answered([{ options: ["OAuth", "OAuth"], text: null }]), direct, oauthOnly],
  [
    "a single-select answer with an option and free text",
    answered([{ options: ["OAuth"], text: "also" }]),
    direct,
    oauthOnly,
  ],
  [
    "a single-select answer with two options",
    answered([{ options: ["OAuth", "Password"], text: null }]),
    direct,
    oauthOnly,
  ],
  [
    "an unanswered single-select question",
    answered([{ options: [], text: null }]),
    direct,
    oauthOnly,
  ],
  [
    "an unanswered multi-select question with blank text",
    answered([
      { options: ["OAuth"], text: null },
      { options: [], text: "  " },
    ]),
    pair,
    validPair,
  ],
  ["a text that is not a string", answered([{ options: ["OAuth"], text: 3 }]), direct, oauthOnly],
];

for (const [name, invalid, input, valid] of invalidAnswers) {
  test(`an invalid form answer with ${name} shows the same editor again`, async () => {
    const harness = formWorld().startForm({
      params: input(),
      respond: replies(invalid, valid),
    });
    const result = await harness.result;
    assert.equal(harness.calls.length, 2);
    assert.equal(at(harness.calls, 1).title, "AskUserQuestion");
    assert.equal(at(harness.calls, 1).prefill, at(harness.calls, 0).prefill);
    assert.equal(result.details.outcome, "answered");
  });
}

test("an unanswered multi-select question with no option or text is asked again", async () => {
  const harness = formWorld().startForm({
    params: params([{ ...targets }]),
    respond: replies(
      answered([{ options: [], text: null }]),
      answered([{ options: ["Linux"], text: null }]),
    ),
  });
  const result = await harness.result;
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(result.details.answers[0]?.options, ["Linux"]);
});

// ---------------------------------------------------------------------------
// Cancel, the dismissal choice, and Back
// ---------------------------------------------------------------------------

test("cancelling the editor starts the dismissal choice, and Skip dismisses", async () => {
  const harness = formWorld().startForm({
    params: direct(),
    respond: replies(undefined),
    choose: async () => ASK_DIALOG.skip,
  });
  const result = await harness.result;
  assert.equal(harness.calls.length, 1);
  assert.equal(at(harness.selects, 0).title, ASK_DIALOG.dismissalTitle);
  assert.deepEqual(at(harness.selects, 0).options, [
    ASK_DIALOG.skip,
    ASK_DIALOG.stop,
    ASK_DIALOG.back,
  ]);
  assert.equal(result.details.outcome, "dismissed");
});

test("cancelling the editor and choosing Stop gives the stopped result", async () => {
  const harness = formWorld().startForm({
    params: direct(),
    respond: replies(undefined),
    choose: async () => ASK_DIALOG.stop,
  });
  const result = await harness.result;
  assert.equal(result.details.outcome, "stopped");
  assert.equal(result.terminate, true);
});

test("Back to the questions shows the editor again", async () => {
  const harness = formWorld().startForm({
    params: direct(),
    respond: replies(undefined, oauthOnly),
    choose: async () => ASK_DIALOG.back,
  });
  const result = await harness.result;
  assert.equal(harness.calls.length, 2);
  assert.equal(at(harness.calls, 1).title, "AskUserQuestion");
  assert.equal(result.details.outcome, "answered");
  assert.deepEqual(result.details.answers[0]?.options, ["OAuth"]);
});

test("cancelling the dismissal choice shows the editor again", async () => {
  const choices = ["x", undefined];
  const harness = formWorld().startForm({
    params: direct(),
    respond: replies(undefined, oauthOnly),
    choose: async () => choices.shift(),
  });
  const result = await harness.result;
  assert.equal(harness.calls.length, 2);
  assert.equal(result.details.outcome, "answered");
});

// ---------------------------------------------------------------------------
// Section 5: the abort signal and session shutdown end a shown editor
// ---------------------------------------------------------------------------

test("the call's abort ends a shown editor with the aborted result, and a late text is ignored", async () => {
  const controller = new AbortController();
  const late = deferred();
  const harness = formWorld().startForm({
    params: direct(),
    respond: () => late.promise,
    signal: controller.signal,
  });
  assert.equal(harness.calls.length, 1);
  controller.abort();
  const result = await harness.result;
  assert.equal(result.details.outcome, "aborted");
  assert.equal(result.isError, true);
  assert.equal(result.terminate, undefined);
  assert.equal(textOf(result), ASK_USER_ABORTED_TEXT);
  assert.deepEqual(result.details.answers, []);
  late.settle(oauthOnly);
  await late.promise;
  // The late text neither re-asks nor changes the result.
  assert.equal(harness.calls.length, 1);
  assert.equal((await harness.result).details.outcome, "aborted");
});

test("session_shutdown ends a shown editor with the shutdown result", async () => {
  const world = formWorld();
  const harness = world.startForm({
    params: direct(),
    respond: () => new Promise<string | undefined>(() => undefined),
    sessionId: "form-shutdown",
  });
  world.runtime.sessionShutdown("form-shutdown");
  const result = await harness.result;
  assert.equal(result.details.outcome, "shutdown");
  assert.equal(result.isError, true);
  assert.equal(textOf(result), ASK_USER_SHUTDOWN_TEXT);
});

// ---------------------------------------------------------------------------
// Without the announcement, the dialog sequence is used
// ---------------------------------------------------------------------------

test("without PI_DENT_ASK_FORM set to 1 the dialog sequence is used", async () => {
  for (const env of [{}, { PI_DENT_ASK_FORM: "0" }, { PI_DENT_ASK_FORM: "true" }]) {
    const harness = questionWorld({ env }).startDialogs({
      params: direct(),
      script: ["1. OAuth — Use an external provider"],
    });
    const result = await harness.result;
    assert.deepEqual(
      harness.calls.map((call) => call.method),
      ["select"],
    );
    assert.equal(result.details.outcome, "answered");
  }
});
