import { test } from "node:test";
import assert from "node:assert/strict";
import { ASK_DIALOG } from "../../lib/ask-user-question-tool.ts";
import { OTHER_ROW_TEXT, REVIEW_TITLE } from "../../lib/ask-user-question-panel.ts";
import { at } from "../support/must.ts";
import { params, question, questionWorld } from "./support.ts";

/**
 * specs/ask-user-question-tool.md#dialog-sequence: the dialog sequence in RPC mode. The host
 * dialog methods are scripted, and every title, option string, and result is asserted.
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

const authTitle = "Auth (1 of 1): Which login method should the app use?";
const authPairTitle = "Auth (1 of 2): Which login method should the app use?";
const targetsPairTitle =
  "Targets (2 of 2): Which platforms must it support? — choose one or more, then Done";

const direct = () => params([{ ...auth }]);
const pair = () => params([{ ...auth }, { ...targets }]);

const multiOptions = (mark: string, other: string) => [
  `${mark === "x" ? "1. [x]" : "1. [ ]"} macOS — Apple laptops`,
  "2. [ ] Linux — Linux desktops",
  other,
  "4. Done",
];

const otherEmptyMarked = `3. [ ] ${OTHER_ROW_TEXT}`;
const otherExtra = "3. [x] Other: extra";

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#questions: questions
// ---------------------------------------------------------------------------

test("a single-select question is asked with the description in each option string", async () => {
  const world = questionWorld();
  const harness = world.startDialogs({
    params: direct(),
    script: ["1. OAuth — Use an external provider"],
  });
  const result = await harness.result;
  assert.equal(harness.calls.length, 1);
  const call = at(harness.calls, 0);
  assert.equal(call.method, "select");
  assert.equal(call.title, authTitle);
  assert.deepEqual(call.options, [
    "1. OAuth — Use an external provider",
    "2. Password — Own accounts",
    `3. ${OTHER_ROW_TEXT}`,
  ]);
  assert.equal(result.details.outcome, "answered");
  assert.deepEqual(result.details.answers[0]?.options, ["OAuth"]);
  assert.equal(result.details.answers[0]?.text, null);
});

test("choosing Other of a single-select question asks for the answer, then moves on", async () => {
  const harness = questionWorld().startDialogs({
    params: direct(),
    script: [`3. ${OTHER_ROW_TEXT}`, "magic link"],
  });
  const result = await harness.result;
  assert.equal(harness.calls.length, 2);
  const input = at(harness.calls, 1);
  assert.equal(input.method, "input");
  assert.equal(input.title, authTitle);
  assert.equal(input.placeholder, ASK_DIALOG.inputPlaceholder);
  assert.deepEqual(result.details.answers[0]?.options, []);
  assert.equal(result.details.answers[0]?.text, "magic link");
});

test("empty and cancelled answers show the question again", async () => {
  const empty = questionWorld().startDialogs({
    params: direct(),
    script: [`3. ${OTHER_ROW_TEXT}`, "", "1. OAuth — Use an external provider"],
  });
  assert.equal((await empty.result).details.answers[0]?.options.join(","), "OAuth");
  assert.deepEqual(
    empty.calls.map((call) => call.method),
    ["select", "input", "select"],
  );

  const cancelled = questionWorld().startDialogs({
    params: direct(),
    script: [`3. ${OTHER_ROW_TEXT}`, undefined, "2. Password — Own accounts"],
  });
  assert.equal((await cancelled.result).details.answers[0]?.options.join(","), "Password");
  assert.equal(at(cancelled.calls, 2).title, authTitle);
});

test("a multi-select question toggles, ends on Done, and carries marks and the suffix", async () => {
  const harness = questionWorld().startDialogs({
    params: params([{ ...targets }]),
    script: [
      "1. [ ] macOS — Apple laptops",
      otherEmptyMarked,
      "extra",
      "4. Done",
      ASK_DIALOG.reviewSubmit,
    ],
  });
  const result = await harness.result;
  const titles = harness.calls.map((call) => call.title);
  assert.deepEqual(titles, [
    `Targets (1 of 1): Which platforms must it support?${ASK_DIALOG.multiSelectSuffix}`,
    `Targets (1 of 1): Which platforms must it support?${ASK_DIALOG.multiSelectSuffix}`,
    `Targets (1 of 1): Which platforms must it support?${ASK_DIALOG.multiSelectSuffix}`,
    `Targets (1 of 1): Which platforms must it support?${ASK_DIALOG.multiSelectSuffix}`,
    REVIEW_TITLE,
  ]);
  assert.deepEqual(at(harness.calls, 0).options, multiOptions(" ", otherEmptyMarked));
  assert.deepEqual(at(harness.calls, 1).options, multiOptions("x", otherEmptyMarked));
  assert.equal(at(harness.calls, 2).method, "input");
  assert.deepEqual(at(harness.calls, 3).options, multiOptions("x", otherExtra));
  assert.deepEqual(at(harness.calls, 4).options, [
    ASK_DIALOG.reviewSubmit,
    '1. Targets: macOS, "extra"',
  ]);
  assert.equal(result.details.outcome, "answered");
  assert.deepEqual(result.details.answers[0]?.options, ["macOS"]);
  assert.equal(result.details.answers[0]?.text, "extra");
});

test("choosing Other of a multi-select question again removes its free-text answer", async () => {
  const harness = questionWorld().startDialogs({
    params: params([{ ...targets }]),
    script: [
      "1. [ ] macOS — Apple laptops",
      otherEmptyMarked,
      "extra",
      otherExtra,
      "4. Done",
      ASK_DIALOG.reviewSubmit,
    ],
  });
  const result = await harness.result;
  assert.equal(at(harness.calls, 4).options[2], otherEmptyMarked);
  assert.deepEqual(result.details.answers[0]?.options, ["macOS"]);
  assert.equal(result.details.answers[0]?.text, null);
});

test("Done with an unanswered question shows it again", async () => {
  const harness = questionWorld().startDialogs({
    params: params([{ ...targets }]),
    script: ["4. Done", "2. [ ] Linux — Linux desktops", "4. Done", ASK_DIALOG.reviewSubmit],
  });
  const result = await harness.result;
  assert.equal(at(harness.calls, 1).title, at(harness.calls, 0).title);
  assert.deepEqual(result.details.answers[0]?.options, ["Linux"]);
});

test("questions are asked in array order, then the review", async () => {
  const harness = questionWorld().startDialogs({
    params: pair(),
    script: [
      "1. OAuth — Use an external provider",
      "1. [ ] macOS — Apple laptops",
      "4. Done",
      ASK_DIALOG.reviewSubmit,
    ],
  });
  const result = await harness.result;
  assert.deepEqual(
    harness.calls.map((call) => call.title),
    [authPairTitle, targetsPairTitle, targetsPairTitle, REVIEW_TITLE],
  );
  assert.deepEqual(at(harness.calls, 3).options, [
    ASK_DIALOG.reviewSubmit,
    "1. Auth: OAuth",
    "2. Targets: macOS",
  ]);
  assert.equal(result.details.outcome, "answered");
});

test("choosing a question in the review asks it again, and the review follows it", async () => {
  const harness = questionWorld().startDialogs({
    params: pair(),
    script: [
      "1. OAuth — Use an external provider",
      "1. [ ] macOS — Apple laptops",
      "4. Done",
      "1. Auth: OAuth",
      "2. Password — Own accounts",
      ASK_DIALOG.reviewSubmit,
    ],
  });
  const result = await harness.result;
  assert.equal(at(harness.calls, 4).title, authPairTitle);
  assert.equal(at(harness.calls, 5).title, REVIEW_TITLE);
  assert.deepEqual(result.details.answers[0]?.options, ["Password"]);
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#dismissal-choice: dismissal choice
// ---------------------------------------------------------------------------

test("cancelling a question starts the dismissal choice, and Skip dismisses", async () => {
  const harness = questionWorld().startDialogs({
    params: direct(),
    script: [undefined, ASK_DIALOG.skip],
  });
  const result = await harness.result;
  const choice = at(harness.calls, 1);
  assert.equal(choice.title, ASK_DIALOG.dismissalTitle);
  assert.deepEqual(choice.options, [ASK_DIALOG.skip, ASK_DIALOG.stop, ASK_DIALOG.back]);
  assert.equal(result.details.outcome, "dismissed");
  assert.equal(result.terminate, undefined);
  assert.equal(result.isError, undefined);
});

test("Stop ends the run with the stopped result", async () => {
  const harness = questionWorld().startDialogs({
    params: pair(),
    script: [undefined, ASK_DIALOG.stop],
  });
  const result = await harness.result;
  assert.equal(result.details.outcome, "stopped");
  assert.equal(result.terminate, true);
});

test("Back to the questions shows the cancelled dialog again, answers unchanged", async () => {
  const harness = questionWorld().startDialogs({
    params: pair(),
    script: [
      "1. OAuth — Use an external provider",
      "1. [ ] macOS — Apple laptops",
      undefined,
      ASK_DIALOG.back,
      "4. Done",
      ASK_DIALOG.reviewSubmit,
    ],
  });
  const result = await harness.result;
  assert.equal(at(harness.calls, 4).title, targetsPairTitle);
  assert.deepEqual(at(harness.calls, 4).options, multiOptions("x", otherEmptyMarked));
  assert.deepEqual(result.details.answers[0]?.options, ["OAuth"]);
  assert.deepEqual(result.details.answers[1]?.options, ["macOS"]);
});

test("cancelling the dismissal choice shows the cancelled dialog again", async () => {
  const harness = questionWorld().startDialogs({
    params: direct(),
    script: [undefined, undefined, "2. Password — Own accounts"],
  });
  const result = await harness.result;
  assert.deepEqual(
    harness.calls.map((call) => call.method),
    ["select", "select", "select"],
  );
  assert.equal(at(harness.calls, 2).title, authTitle);
  assert.equal(result.details.answers[0]?.options.join(","), "Password");
});

test("cancelling the review starts the dismissal choice", async () => {
  const harness = questionWorld().startDialogs({
    params: pair(),
    script: [
      "1. OAuth — Use an external provider",
      "1. [ ] macOS — Apple laptops",
      "4. Done",
      undefined,
      ASK_DIALOG.skip,
    ],
  });
  const result = await harness.result;
  assert.equal(at(harness.calls, 4).title, ASK_DIALOG.dismissalTitle);
  assert.equal(result.details.outcome, "dismissed");
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#dialog-sequence: values the dialog does not offer, abort signal, no timeout
// ---------------------------------------------------------------------------

test("a value that is not one of the option strings shows the same dialog again", async () => {
  const harness = questionWorld().startDialogs({
    params: direct(),
    script: ["bogus", "1. OAuth — Use an external provider"],
  });
  const result = await harness.result;
  assert.equal(harness.calls.length, 2);
  assert.equal(at(harness.calls, 1).title, authTitle);
  assert.equal(result.details.answers[0]?.options.join(","), "OAuth");
});

test("a value the dismissal choice does not offer shows it again", async () => {
  const harness = questionWorld().startDialogs({
    params: direct(),
    script: [undefined, "nope", ASK_DIALOG.stop],
  });
  const result = await harness.result;
  assert.equal(at(harness.calls, 2).title, ASK_DIALOG.dismissalTitle);
  assert.equal(result.details.outcome, "stopped");
});

test("every dialog gets an abort signal and no timeout", async () => {
  const harness = questionWorld().startDialogs({
    params: pair(),
    script: [
      "1. OAuth — Use an external provider",
      "1. [ ] macOS — Apple laptops",
      "4. Done",
      ASK_DIALOG.reviewSubmit,
    ],
  });
  await harness.result;
  for (const call of harness.calls) {
    assert.deepEqual(call.optionKeys, ["signal"]);
    assert.equal(call.signal instanceof AbortSignal, true);
  }
});

test("the call's abort ends a shown dialog with the aborted result", async () => {
  const controller = new AbortController();
  const harness = questionWorld().startDialogs({
    params: direct(),
    script: ["hang"],
    signal: controller.signal,
  });
  controller.abort();
  const result = await harness.result;
  assert.equal(result.details.outcome, "aborted");
  assert.equal(result.isError, true);
  assert.equal(at(harness.calls, 0).signal?.aborted, true);
});

test("session_shutdown ends a shown dialog with the shutdown result", async () => {
  const world = questionWorld();
  const harness = world.startDialogs({
    params: direct(),
    script: ["hang"],
    sessionId: "shutdown-session",
  });
  world.runtime.sessionShutdown("shutdown-session");
  const result = await harness.result;
  assert.equal(result.details.outcome, "shutdown");
  assert.equal(result.isError, true);
  assert.equal(at(harness.calls, 0).signal?.aborted, true);
});

test("the dialogs show cleaned values (specs/ask-user-question-tool.md#dialog-sequence)", async () => {
  const harness = questionWorld().startDialogs({
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
    script: ["1. OAuth — Use one"],
  });
  await harness.result;
  assert.equal(at(harness.calls, 0).title, "Auth (1 of 1): Which method?");
  assert.equal(at(harness.calls, 0).options[0], "1. OAuth — Use one");
});
