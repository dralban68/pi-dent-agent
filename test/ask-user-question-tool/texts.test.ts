import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  askUserRuntime,
  makeAskUserQuestionTool,
  type AskToolResult,
} from "../../lib/ask-user-question-tool.ts";
import { at, must } from "../support/must.ts";
import { fakeUi, params, panelContent, question, questionWorld } from "./support.ts";

/**
 * specs/ask-user-question-tool.md: every literal text is the specification's, verbatim.
 * The test reads the texts out of the specification's own blocks and tables and asserts
 * them on the registered tool, the rendered panel, the dialog calls, and the results.
 */

const specPath = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "specs",
  "ask-user-question-tool.md",
);
const spec = readFileSync(specPath, "utf8");

/** The body of the `index`-th fenced `text` block after `marker`. */
function blockAfter(marker: string, index = 0): string {
  const from = spec.indexOf(marker);
  assert.equal(from >= 0, true, marker);
  let searchFrom = from;
  for (let found = 0; found <= index; found += 1) {
    const open = spec.indexOf("```text\n", searchFrom);
    const close = spec.indexOf("\n```", open);
    assert.equal(open >= 0 && close > open, true, marker);
    if (found === index) return spec.slice(open + "```text\n".length, close);
    searchFrom = close;
  }
  return "";
}

/** Every backticked literal of the paragraph that starts with `marker`. */
function backticksAfter(marker: string): string[] {
  const from = spec.indexOf(marker);
  assert.equal(from >= 0, true, marker);
  const end = spec.indexOf("\n\n", from);
  const slice = spec.slice(from, end < 0 ? spec.length : end);
  const found: string[] = [];
  const pattern = /`([^`]*)`/g;
  for (;;) {
    const match = pattern.exec(slice);
    if (match === null) break;
    found.push(must(match[1]));
  }
  return found;
}

/** Every backticked literal of the table row that starts with `rowStart`, in order. */
function rowLiterals(rowStart: string): string[] {
  const from = spec.indexOf(rowStart);
  assert.equal(from >= 0, true, rowStart);
  const end = spec.indexOf("\n", from);
  const slice = spec.slice(from, end < 0 ? spec.length : end);
  const found: string[] = [];
  const pattern = /`([^`]*)`/g;
  for (;;) {
    const match = pattern.exec(slice);
    if (match === null) break;
    found.push(must(match[1]));
  }
  return found;
}

/** The last cell of every table row between `marker` and the next blank line. */
function lastCellsAfter(marker: string): string[] {
  const from = spec.indexOf(marker);
  assert.equal(from >= 0, true, marker);
  const end = spec.indexOf("\n\n", from);
  const cells: string[] = [];
  for (const line of spec.slice(from, end).split("\n")) {
    if (!line.startsWith("|")) continue;
    const parts = line.split("|").map((part) => part.trim());
    const last = parts[parts.length - 2] ?? "";
    const match = /^`(.*)`$/.exec(last);
    if (match === null) continue;
    cells.push(must(match[1]));
  }
  return cells;
}

/** The value cell of the specs/ask-user-question-tool.md#registration registration table, by field. */
function registrationCell(name: string): string {
  const pattern = new RegExp(`^\\| \`${name}\`\\s+\\| (.*?) \\|$`, "m");
  const match = pattern.exec(spec);
  assert.notEqual(match, null, name);
  return must(match?.[1]).trim();
}

/** The quoted literal of a registration-table cell such as `` `"AskUserQuestion"` ``. */
function quoted(cell: string): string {
  const match = /^`"(.*)"`$/.exec(cell);
  assert.notEqual(match, null, cell);
  return must(match?.[1]);
}

/** The specs/ask-user-question-tool.md#prompt-texts parameter table's `description` column, by schema path. */
function tableDescriptions(): Record<string, string> {
  const from = spec.indexOf("| Field                               | `description`");
  assert.equal(from >= 0, true);
  const to = spec.indexOf("\n\n", from);
  const descriptions: Record<string, string> = {};
  for (const line of spec.slice(from, to).split("\n")) {
    const match = /^\| `([^`]+)`\s+\| `(.*)`\s+\|$/.exec(line);
    if (match === null) continue;
    const key = must(match[1]);
    const description = must(match[2]);
    descriptions[key.replace(/^questions\[\]\./, "").replace(/^options\[\]\./, "")] = description;
  }
  return descriptions;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function field(node: unknown, name: string): unknown {
  return isRecord(node) ? node[name] : undefined;
}

function property(node: unknown, name: string): unknown {
  return field(field(node, "properties"), name);
}

function propertiesOf(node: unknown): Record<string, unknown> {
  const value = field(node, "properties");
  return isRecord(value) ? value : {};
}

function text(node: unknown): string {
  const value = field(node, "description");
  return typeof value === "string" ? value : "";
}

function textOf(result: AskToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === "text" ? first.text : "";
}

/** The panel's content lines inside the border, without terminal sequences. */
const content = (harness: { lines: () => string[] }): string[] => panelContent(harness.lines());

/** The rendered text with the fake theme's highlight marks removed. */
const plain = (line: string): string => line.replace(/«|»/g, "");

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#registration: the registration surface and the schema
// ---------------------------------------------------------------------------

test("the registered tool carries the specification's name, label, exposure, description, and promptSnippet", () => {
  const tool = makeAskUserQuestionTool(askUserRuntime());
  assert.equal(tool.name, quoted(registrationCell("name")));
  assert.equal(tool.label, quoted(registrationCell("label")));
  assert.equal(tool.exposure, quoted(registrationCell("exposure")));
  assert.equal(tool.description, blockAfter("The `description` is"));
  assert.equal(tool.promptSnippet, blockAfter("The `promptSnippet` is"));
  assert.equal(
    tool.renderShell,
    undefined,
    "specs/ask-user-question-tool.md#registration leaves renderShell unset",
  );
});

test("every parameter description is the specification's text, verbatim", () => {
  const schema = makeAskUserQuestionTool(askUserRuntime()).parameters;
  const questions = property(schema, "questions");
  const questionItem = field(questions, "items");
  const optionItem = field(property(questionItem, "options"), "items");
  const table = tableDescriptions();
  assert.equal(text(questions), table.questions);
  assert.equal(text(property(questionItem, "question")), table.question);
  assert.equal(text(property(questionItem, "header")), table.header);
  assert.equal(text(property(questionItem, "options")), table.options);
  assert.equal(text(property(questionItem, "multiSelect")), table.multiSelect);
  assert.equal(text(property(optionItem, "label")), table.label);
  assert.equal(text(property(optionItem, "description")), table.description);
});

test("every schema object admits no other property, and the schema has the specs/ask-user-question-tool.md#parameter-schema fields", () => {
  const schema = makeAskUserQuestionTool(askUserRuntime()).parameters;
  assert.equal(field(schema, "type"), "object");
  assert.equal(field(schema, "additionalProperties"), false);
  assert.deepEqual(field(schema, "required"), ["questions"]);
  const questions = property(schema, "questions");
  const questionItem = field(questions, "items");
  assert.equal(field(questions, "type"), "array");
  assert.equal(field(questionItem, "type"), "object");
  assert.equal(field(questionItem, "additionalProperties"), false);
  assert.deepEqual(field(questionItem, "required"), ["question", "header", "options"]);
  const options = property(questionItem, "options");
  assert.equal(field(options, "type"), "array");
  const option = field(options, "items");
  assert.equal(field(option, "type"), "object");
  assert.equal(field(option, "additionalProperties"), false);
  assert.deepEqual(field(option, "required"), ["label", "description"]);
  assert.equal(field(property(questionItem, "multiSelect"), "type"), "boolean");
  assert.deepEqual(Object.keys(propertiesOf(questionItem)), [
    "question",
    "header",
    "options",
    "multiSelect",
  ]);
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#rows-tabs and specs/ask-user-question-tool.md#panel-content: the panel's texts
// ---------------------------------------------------------------------------

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

test("the key-hint lines are the specification's table, in order", () => {
  const hints = lastCellsAfter("| Page                                      | Key-hint line");
  assert.equal(hints.length, 6, hints.join("\n"));
  const armed = questionWorld().startPanel({ params: direct() });
  armed.press("\u001b");
  const textEntry = questionWorld().startPanel({ params: direct() });
  textEntry.press("3");
  const submitTab = questionWorld().startPanel({ params: pair() });
  submitTab.press("\t");
  submitTab.press("\t");
  const directPage = questionWorld().startPanel({ params: direct() });
  const singlePage = questionWorld().startPanel({ params: pair() });
  const multiPage = questionWorld().startPanel({ params: pair() });
  multiPage.press("\t");

  const pages: [page: string, harness: { lines: () => string[] }][] = [
    ["dismissal armed", armed],
    ["text entry", textEntry],
    ["Submit tab", submitTab],
    ["direct question page", directPage],
    ["single-select question page", singlePage],
    ["multi-select question page", multiPage],
  ];
  pages.forEach(([page, harness], index) => {
    // The hint wraps at the inner width; joining the lines restores the hint text.
    const rendered = content(harness).join(" ").replace(/\s+/g, " ").trim();
    assert.equal(rendered.endsWith(must(hints[index])), true, `${page}: ${rendered}`);
  });
});

test("the panel's texts are the specification's, verbatim", () => {
  const otherRow = must(backticksAfter("The Other row's text is")[0]);
  const textEntryLabel = must(backticksAfter("an empty line, the line")[0]);
  const submitTab = backticksAfter("3. On the Submit tab: the line");
  const tabs = backticksAfter("A question's\n   tab is");
  const answeredMark = must(tabs[0]);
  const unansweredMark = must(tabs[1]);
  const submitLabel = must(tabs[2]);

  const directPage = questionWorld().startPanel({ params: direct() });
  assert.equal(at(content(directPage), 6), `  3. ${otherRow}`);

  const textEntry = questionWorld().startPanel({ params: direct() });
  textEntry.press("3");
  assert.equal(content(textEntry).includes(textEntryLabel), true, textEntryLabel);

  const submitPage = questionWorld().startPanel({ params: pair() });
  submitPage.press("\t");
  submitPage.press("\t");
  const submitBody = content(submitPage);
  assert.equal(at(submitBody, 1), must(submitTab[0]));
  assert.equal(at(submitBody, 3), `Auth: ${must(submitTab[2])}`);
  assert.equal(at(submitBody, 4), `Targets: ${must(submitTab[2])}`);
  assert.equal(at(submitBody, 6), must(submitTab[4]).replace("<headers>", "Auth, Targets"));

  const answered = questionWorld().startPanel({ params: pair() });
  answered.press("1");
  answered.press("1");
  answered.press("\t");
  assert.equal(at(content(answered), 6), must(submitTab[3]));

  const pairTabs = questionWorld().startPanel({ params: pair() });
  assert.equal(
    plain(at(content(pairTabs), 0)),
    [
      unansweredMark.replace("<header>", "Auth"),
      unansweredMark.replace("<header>", "Targets"),
      submitLabel,
    ].join("  "),
  );

  const marked = questionWorld().startPanel({ params: params([{ ...targets }]) });
  marked.press(" ");
  assert.equal(
    plain(at(content(marked), 0)),
    [answeredMark.replace("<header>", "Targets"), submitLabel].join("  "),
  );
});

test("the blocked-on-user report is the specification's (specs/ask-user-question-tool.md#question-panel)", () => {
  const literals = backticksAfter("blocked-on-user report of kind");
  const harness = questionWorld().startPanel({ params: direct() });
  assert.deepEqual(harness.customOptions().blocked, {
    kind: must(literals[0]),
    message: must(literals[1]),
  });
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#dialog-sequence: the dialog texts
// ---------------------------------------------------------------------------

/** The specs/ask-user-question-tool.md#questions question title for a question. */
function dialogTitle(header: string, index: number, count: number, questionText: string): string {
  const pattern = must(backticksAfter("Question `<i>` is asked with a `select` dialog titled")[2]);
  return pattern
    .replace("<header>", header)
    .replace("<i>", String(index))
    .replace("<m>", String(count))
    .replace("<question>", questionText);
}

test("the dialog titles, options, and placeholder are the specification's, verbatim", async () => {
  const singleRow = rowLiterals("| single-select |");
  const multiRow = rowLiterals("| multi-select  |");
  const otherOption = must(singleRow[1]).replace("<n+1>", "3");
  const suffix = must(backticksAfter("followed for a multi-select question by")[0]);
  const doneOption = must(multiRow[4]).replace("<n+2>", "4");
  const placeholder = must(backticksAfter("with the placeholder")[0]);
  const reviewTitle = must(backticksAfter("The review is a `select` dialog titled")[1]);
  const reviewSubmit = must(backticksAfter("with the option strings `Submit`")[0]);
  const dismissal = backticksAfter("The dismissal choice is a `select` dialog titled");

  const single = questionWorld().startDialogs({
    params: direct(),
    script: [
      must(singleRow[0])
        .replace("<j>", "1")
        .replace("<label>", "OAuth")
        .replace("<description>", "Use an external provider"),
    ],
  });
  await single.result;
  const questionCall = at(single.calls, 0);
  assert.equal(questionCall.title, dialogTitle("Auth", 1, 1, auth.question));
  assert.equal(questionCall.options[2], otherOption);

  const multi = questionWorld().startDialogs({
    params: params([{ ...targets }]),
    script: [
      must(multiRow[1])
        .replace("<j>", "1")
        .replace("<label>", "macOS")
        .replace("<description>", "Apple laptops"),
      must(multiRow[3]).replace("<n+1>", "3"),
      "extra",
      doneOption,
      reviewSubmit,
    ],
  });
  await multi.result;
  assert.equal(
    at(multi.calls, 0).title,
    `${dialogTitle("Targets", 1, 1, targets.question)}${suffix}`,
  );
  const inputCall = at(multi.calls, 2);
  assert.equal(inputCall.method, "input");
  assert.equal(inputCall.title, `${dialogTitle("Targets", 1, 1, targets.question)}${suffix}`);
  assert.equal(inputCall.placeholder, placeholder);
  assert.equal(at(multi.calls, 3).options.includes(doneOption), true);
  assert.equal(at(multi.calls, 4).title, reviewTitle);

  const dismissalHarness = questionWorld().startDialogs({
    params: direct(),
    script: [undefined, must(dismissal[2])],
  });
  await dismissalHarness.result;
  const choice = at(dismissalHarness.calls, 1);
  assert.equal(choice.title, must(dismissal[1]));
  assert.deepEqual(choice.options, [must(dismissal[2]), must(dismissal[3]), must(dismissal[4])]);

  const review = questionWorld().startDialogs({
    params: pair(),
    script: [
      must(singleRow[0])
        .replace("<j>", "1")
        .replace("<label>", "OAuth")
        .replace("<description>", "Use an external provider"),
      must(multiRow[1])
        .replace("<j>", "1")
        .replace("<label>", "macOS")
        .replace("<description>", "Apple laptops"),
      doneOption,
      reviewSubmit,
    ],
  });
  await review.result;
  const reviewCall = at(review.calls, 3);
  assert.equal(reviewCall.title, reviewTitle);
  assert.equal(reviewCall.options[0], reviewSubmit);
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#results: the result texts
// ---------------------------------------------------------------------------

test("the answered result is the specification's example, verbatim", async () => {
  const harness = questionWorld().startPanel({ params: pair() });
  harness.press("1");
  harness.press("1");
  harness.press("2");
  harness.press("3");
  harness.editor.type("also FreeBSD,\nif cheap");
  harness.press("\r");
  harness.press("\t");
  harness.press("\r");
  const result = await harness.result;
  assert.equal(result.details.outcome, "answered");
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), blockAfter("### 6.1 Answered result", 1));
});

test("the other results' texts are the specification's table, verbatim", async () => {
  const cells = lastCellsAfter("| Result    | `isError` | `terminate` | Text");
  assert.equal(cells.length, 5, cells.join("\n"));

  const tool = makeAskUserQuestionTool(askUserRuntime());
  const noUiCtx = {
    sessionManager: { getSessionId: () => "texts-session" },
    ui: fakeUi(),
    mode: "print",
    hasUI: false,
  } as unknown as ExtensionToolContext;
  const noUi = await tool.execute("call-no-ui", direct() as never, undefined, undefined, noUiCtx);

  const dismissed = questionWorld().startPanel({ params: direct() });
  dismissed.press("\u001b");
  dismissed.press("s");

  const stopped = questionWorld().startPanel({ params: direct() });
  stopped.press("\u001b");
  stopped.press("x");

  const aborted = questionWorld().startPanel({
    params: direct(),
    signal: AbortSignal.abort(),
  });

  const world = questionWorld();
  const shutdown = world.startPanel({ params: direct(), sessionId: "texts-shutdown" });
  world.runtime.sessionShutdown("texts-shutdown");

  const results = [
    noUi,
    await dismissed.result,
    await stopped.result,
    await aborted.result,
    await shutdown.result,
  ];
  results.forEach((result, index) => {
    assert.equal(textOf(result), must(cells[index]), `result ${index}`);
  });
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#details: details
// ---------------------------------------------------------------------------

test("the answered details hold the header, question, labels, and text of each question", async () => {
  const harness = questionWorld().startPanel({ params: params([{ ...targets }]) });
  // Chosen in reverse order: the details list the labels in option order.
  harness.press("2");
  harness.press("1");
  harness.press("3");
  harness.editor.type("also FreeBSD");
  harness.press("\r");
  harness.press("\t");
  harness.press("\r");
  const result = await harness.result;
  assert.deepEqual(result.details, {
    outcome: "answered",
    answers: [
      {
        header: "Targets",
        question: "Which platforms must it support?",
        options: ["macOS", "Linux"],
        text: "also FreeBSD",
      },
    ],
  });
});
