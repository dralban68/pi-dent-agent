import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  askUserRuntime,
  validateAskQuestions,
  type AskInvocation,
} from "../../lib/ask-user-question-tool.ts";
import { must } from "../support/must.ts";
import { fakeUi } from "./support.ts";

/**
 * specs/ask-user-question-tool.md#validation: the twelve checks, their exact error
 * texts (read out of the specification's own table), their order, and the invalid
 * result. The trimming rule of specs/ask-user-question-tool.md#parameter-schema is checked on the validated values.
 */

const specPath = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "specs",
  "ask-user-question-tool.md",
);
const spec = readFileSync(specPath, "utf8");

/** The specs/ask-user-question-tool.md#validation table's error text by check number. */
function checkTexts(): Map<number, string> {
  const from = spec.indexOf("| #   | Check");
  assert.equal(from >= 0, true);
  const to = spec.indexOf("\n\n", from);
  const texts = new Map<number, string>();
  for (const line of spec.slice(from, to).split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    const number = Number(cells[1]);
    if (!Number.isInteger(number)) continue;
    const last = cells[cells.length - 2] ?? "";
    const match = /^`(.*)`$/.exec(last);
    if (match === null) continue;
    texts.set(number, must(match[1]));
  }
  return texts;
}

const TEXTS = checkTexts();

interface RawOption {
  label?: unknown;
  description?: unknown;
}

interface RawQuestion {
  header?: unknown;
  question?: unknown;
  options?: RawOption[];
  multiSelect?: unknown;
}

function option(label: unknown, description: unknown = "What it means"): RawOption {
  return { label, description };
}

function okQuestion(overrides: RawQuestion = {}): RawQuestion {
  return {
    header: "Auth",
    question: "Which login method should the app use?",
    options: [option("OAuth", "Use a provider"), option("Password", "Own accounts")],
    ...overrides,
  };
}

function errorOf(questions: RawQuestion[]): string {
  const validation = validateAskQuestions({ questions });
  return validation.ok ? "" : validation.error;
}

/** A distinct valid question, for calls of several questions. */
function nth(index: number): RawQuestion {
  return okQuestion({
    header: `Q${index}`,
    question: `Question number ${index}?`,
    options: [option(`a${index}`), option(`b${index}`)],
  });
}

const expected = (check: number, i = 1, j = 1): string =>
  must(TEXTS.get(check)).replace("<i>", String(i)).replace("<j>", String(j));

// ---------------------------------------------------------------------------
// The twelve checks
// ---------------------------------------------------------------------------

test("check 1: the call holds 1 to 4 questions", () => {
  assert.equal(errorOf([]), expected(1));
  assert.equal(
    errorOf([okQuestion(), okQuestion(), okQuestion(), okQuestion(), okQuestion()]),
    expected(1),
  );
  assert.equal(errorOf([nth(1), nth(2), nth(3), nth(4)]), "");
});

test("check 2: the question is not empty", () => {
  assert.equal(errorOf([okQuestion({ question: "" })]), expected(2));
  assert.equal(errorOf([okQuestion({ question: "   " })]), expected(2));
});

test("check 3: the question is one line", () => {
  assert.equal(errorOf([okQuestion({ question: "one\ntwo" })]), expected(3));
  assert.equal(errorOf([okQuestion({ question: "one\rtwo" })]), expected(3));
});

test("check 4: the header is not empty", () => {
  assert.equal(errorOf([okQuestion({ header: " " })]), expected(4));
});

test("check 5: the header is one line of at most 12 characters", () => {
  assert.equal(errorOf([okQuestion({ header: "1234567890123" })]), expected(5));
  assert.equal(errorOf([okQuestion({ header: "a\nb" })]), expected(5));
  assert.equal(errorOf([okQuestion({ header: "123456789012" })]), "");
});

test("check 6: the question holds 2 to 4 options", () => {
  assert.equal(errorOf([okQuestion({ options: [option("OAuth")] })]), expected(6));
  assert.equal(
    errorOf([
      okQuestion({
        options: [option("a"), option("b"), option("c"), option("d"), option("e")],
      }),
    ]),
    expected(6),
  );
});

test("check 7: the label is not empty", () => {
  assert.equal(errorOf([okQuestion({ options: [option(" "), option("Password")] })]), expected(7));
});

test("check 8: the label is one line of at most 60 characters", () => {
  assert.equal(
    errorOf([okQuestion({ options: [option("a".repeat(61)), option("Password")] })]),
    expected(8),
  );
  assert.equal(
    errorOf([okQuestion({ options: [option("a\nb"), option("Password")] })]),
    expected(8),
  );
  assert.equal(
    errorOf([okQuestion({ options: [option("a".repeat(60)), option("Password")] })]),
    "",
  );
});

test('check 9: the label "Other" is reserved, compared case-insensitively', () => {
  assert.equal(
    errorOf([okQuestion({ options: [option("Other"), option("Password")] })]),
    expected(9),
  );
  assert.equal(
    errorOf([okQuestion({ options: [option("oTHer"), option("Password")] })]),
    expected(9),
  );
});

test("check 10: an option label repeats an earlier label of the question", () => {
  assert.equal(
    errorOf([okQuestion({ options: [option("OAuth"), option("OAuth")] })]),
    `question 1 option 2: duplicate label "OAuth"`,
  );
  assert.equal(errorOf([okQuestion({ options: [option("OAuth"), option("oauth")] })]), "");
});

test("check 10: labels are compared after the cleaning of specs/ask-user-question-tool.md#panel-content", () => {
  assert.equal(
    errorOf([okQuestion({ options: [option("OAuth"), option("OAuth\u0007")] })]),
    `question 1 option 2: duplicate label "OAuth\u0007"`,
  );
});

test("check 11: the description is a non-empty single line", () => {
  assert.equal(
    errorOf([okQuestion({ options: [option("OAuth", ""), option("Password")] })]),
    expected(11),
  );
  assert.equal(
    errorOf([okQuestion({ options: [option("OAuth", "one\ntwo"), option("Password")] })]),
    expected(11),
  );
});

test("check 12: the question repeats an earlier question of the call", () => {
  assert.equal(
    errorOf([
      okQuestion(),
      okQuestion({ header: "Second", options: [option("macOS"), option("Linux")] }),
    ]),
    expected(12, 2),
  );
});

// ---------------------------------------------------------------------------
// Order of the checks
// ---------------------------------------------------------------------------

test("check 1 runs before every other check", () => {
  assert.equal(
    errorOf([okQuestion({ question: "" }), okQuestion(), okQuestion(), okQuestion(), okQuestion()]),
    expected(1),
  );
});

test("checks 2 to 6 of a question run before its option checks", () => {
  assert.equal(
    errorOf([okQuestion({ header: "1234567890123", options: [option("OAuth")] })]),
    expected(5),
  );
  assert.equal(errorOf([okQuestion({ options: [option("")] })]), expected(6));
});

test("the option checks run in order 7, 8, 9, 10, 11 for each option", () => {
  assert.equal(
    errorOf([okQuestion({ options: [option("other" + "x".repeat(56)), option("b")] })]),
    expected(8),
  );
  assert.equal(
    errorOf([okQuestion({ options: [option("OAuth"), option("OAuth", "")] })]),
    `question 1 option 2: duplicate label "OAuth"`,
  );
  assert.equal(errorOf([okQuestion({ options: [option("OAuth", ""), option("")] })]), expected(11));
});

test("check 12 of a question runs after its option checks", () => {
  assert.equal(
    errorOf([okQuestion(), okQuestion({ options: [option("macOS"), option("macOS")] })]),
    `question 2 option 2: duplicate label "macOS"`,
  );
});

test("every check of a question runs before the next question's checks", () => {
  assert.equal(
    errorOf([
      okQuestion({ options: [option("OAuth"), option("OAuth")] }),
      okQuestion({ header: "", options: [option("macOS"), option("Linux")] }),
    ]),
    `question 1 option 2: duplicate label "OAuth"`,
  );
  assert.equal(
    errorOf([okQuestion({ header: "1234567890123" }), okQuestion({ question: "" })]),
    expected(5),
  );
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#parameter-schema: trimming
// ---------------------------------------------------------------------------

test("every value is used with leading and trailing white space removed", () => {
  const validation = validateAskQuestions({
    questions: [
      {
        header: "  Auth ",
        question: " Which method? ",
        options: [
          { label: " OAuth ", description: " Use a provider " },
          { label: "Password ", description: " Own accounts" },
        ],
        multiSelect: true,
      },
    ],
  });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const question = must(validation.questions[0]);
  assert.equal(question.header, "Auth");
  assert.equal(question.question, "Which method?");
  assert.equal(must(question.options[0]).label, "OAuth");
  assert.equal(must(question.options[0]).description, "Use a provider");
  assert.equal(question.multiSelect, true);
});

test("multiSelect is true only for the boolean true", () => {
  const validation = validateAskQuestions({ questions: [okQuestion({ multiSelect: "yes" })] });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.equal(must(validation.questions[0]).multiSelect, false);
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#validation: the invalid result, before anything is shown
// ---------------------------------------------------------------------------

test("an invalid call is a tool error with the invalid details and shows nothing", async () => {
  const shown: unknown[] = [];
  const invocation: AskInvocation = {
    sessionId: "invalid-session",
    toolCallId: "call-invalid",
    params: { questions: [] },
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
    mode: "tui",
    hasUI: true,
  };
  const result = await askUserRuntime().execute(invocation);
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, { outcome: "invalid", answers: [] });
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", expected(1));
  assert.deepEqual(shown, []);
});

test("validation runs before the no-UI result, and the tool shows nothing without a UI", async () => {
  const shown: unknown[] = [];
  const invalid: AskInvocation = {
    sessionId: "no-ui-session",
    toolCallId: "call-no-ui-session",
    params: { questions: [okQuestion({ question: "" })] },
    signal: undefined,
    ui: fakeUi({
      custom: async () => {
        shown.push("custom");
        return undefined;
      },
      select: async () => undefined,
      input: async () => undefined,
    }),
    mode: "print",
    hasUI: false,
  };
  const invalidResult = await askUserRuntime().execute(invalid);
  assert.equal(invalidResult.details.outcome, "invalid");
  assert.deepEqual(shown, []);

  const valid: AskInvocation = { ...invalid, params: { questions: [okQuestion()] } };
  const noUiResult = await askUserRuntime().execute(valid);
  assert.equal(noUiResult.details.outcome, "no-ui");
  assert.deepEqual(shown, []);
});
