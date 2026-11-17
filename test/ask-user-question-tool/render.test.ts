import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import {
  ASK_USER_DISMISSED_TEXT,
  ASK_USER_NO_UI_TEXT,
  askUserRuntime,
  makeAskUserQuestionTool,
  type AskToolResult,
} from "../../lib/ask-user-question-tool.ts";
import { at } from "../support/must.ts";

/**
 * specs/ask-user-question-tool.md Section 7: the call and result components. The lines are
 * the same collapsed and expanded, and carry no padding or background of their own.
 */

const tool = makeAskUserQuestionTool(askUserRuntime());

const theme = {
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
} as unknown as Theme;

const options = (expanded: boolean): ToolRenderResultOptions =>
  ({ expanded, isPartial: false, isError: false }) as unknown as ToolRenderResultOptions;

const callLines = (args: unknown, width = 80): string[] => {
  const render = tool.renderCall;
  assert.notEqual(render, undefined);
  if (render === undefined) return [];
  // The host pads every line to the render width; the component adds no padding of its own.
  return render(args as never, theme, {} as never)
    .render(width)
    .map((line) => line.trimEnd());
};

const resultLines = (result: AskToolResult, expanded: boolean, width = 80): string[] => {
  const render = tool.renderResult;
  assert.notEqual(render, undefined);
  if (render === undefined) return [];
  return render(result, options(expanded), theme, {} as never)
    .render(width)
    .map((line) => line.trimEnd());
};

test("renderCall shows the tool line and one line per question", () => {
  const lines = callLines({
    questions: [
      { header: "Auth", question: "Which login method?", options: [] },
      { header: "Targets", question: "Which platforms?", options: [] },
    ],
  });
  assert.deepEqual(lines, [
    "AskUserQuestion",
    "Auth: Which login method?",
    "Targets: Which platforms?",
  ]);
  // No horizontal padding and no background of its own.
  assert.equal(at(lines, 0).startsWith("AskUserQuestion"), true);
  assert.equal(lines.join("").includes("\u001b"), false);
});

test("renderCall leaves out a question whose header or question is not a string, and never throws", () => {
  assert.deepEqual(callLines({ questions: [{ header: "Auth" }, { question: "Which?" }] }), [
    "AskUserQuestion",
  ]);
  assert.deepEqual(callLines({}), ["AskUserQuestion"]);
  assert.deepEqual(callLines({ questions: "nope" }), ["AskUserQuestion"]);
  assert.deepEqual(callLines({ questions: [null, 3, { header: "Auth", question: "Which?" }] }), [
    "AskUserQuestion",
    "Auth: Which?",
  ]);
  assert.deepEqual(callLines(undefined), ["AskUserQuestion"]);
  assert.deepEqual(callLines(null), ["AskUserQuestion"]);
});

test("renderCall cleans the values it shows", () => {
  assert.deepEqual(
    callLines({ questions: [{ header: "A\u0007uth", question: "Which\u001b[1m?" }] }),
    ["AskUserQuestion", "Auth: Which?"],
  );
});

test("renderResult for an answered call shows one summary line per question", () => {
  const result: AskToolResult = {
    content: [{ type: "text", text: "ignored" }],
    details: {
      outcome: "answered",
      answers: [
        { header: "Auth", question: "Which?", options: ["OAuth"], text: null },
        {
          header: "Targets",
          question: "Which?",
          options: ["macOS", "Linux"],
          text: "FreeBSD\nif cheap",
        },
      ],
    },
  };
  const collapsed = resultLines(result, false);
  assert.deepEqual(collapsed, ["Auth: OAuth", 'Targets: macOS, Linux, "FreeBSD …"']);
  assert.deepEqual(resultLines(result, true), collapsed);
  assert.equal(collapsed.join("").includes("\u001b"), false);
});

test("renderResult for every other outcome shows the result text", () => {
  const noUi: AskToolResult = {
    content: [{ type: "text", text: ASK_USER_NO_UI_TEXT }],
    details: { outcome: "no-ui", answers: [] },
    isError: true,
  };
  // The host's text component wraps to the render width.
  assert.equal(resultLines(noUi, false).join(" "), ASK_USER_NO_UI_TEXT);
  assert.equal(resultLines(noUi, true).join(" "), ASK_USER_NO_UI_TEXT);

  const dismissed: AskToolResult = {
    content: [{ type: "text", text: ASK_USER_DISMISSED_TEXT }],
    details: { outcome: "dismissed", answers: [] },
  };
  assert.equal(resultLines(dismissed, false).join(" "), ASK_USER_DISMISSED_TEXT);
});

test("renderResult falls back to the result text when details are not a result's", () => {
  const bare: AskToolResult = {
    content: [{ type: "text", text: "something else" }],
    details: {} as never,
  };
  assert.deepEqual(resultLines(bare, false), ["something else"]);
});
