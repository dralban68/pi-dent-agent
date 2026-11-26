import { test } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  PANEL_HINTS,
  REVIEW_MISSING,
  REVIEW_READY,
  REVIEW_TITLE,
  REVIEW_UNANSWERED,
  SCROLL_INDICATOR,
  TEXT_ENTRY_LABEL,
  OTHER_ROW_TEXT,
  cleanValue,
  panelWidth,
  summaryOf,
} from "../../lib/ask-user-question-panel.ts";
import { at } from "../support/must.ts";
import { params, question, questionWorld } from "./support.ts";

/**
 * specs/ask-user-question-tool.md#question-panel: the question panel. Keys are driven into the
 * component through the injected UI and the rendered lines are asserted; the terminal size is
 * the fake TUI's. No terminal is involved.
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
const longTargets = question(
  "Targets",
  "Which platforms must it support?",
  [
    [
      "macOS",
      "Apple laptops and desktops that run the full desktop operating system and its tools",
    ],
    ["Linux", "Linux desktops and servers"],
  ],
  true,
);

const direct = () => params([{ ...auth }]);
const pair = () => params([{ ...auth }, { ...targets }]);
const tallPair = () => params([{ ...auth }, { ...longTargets }]);
const multi = () => params([{ ...targets }]);

/** The content lines inside the border, without terminal sequences and trailing padding. */
const content = (lines: readonly string[]): string[] =>
  lines.slice(1, -1).map((line) => stripTerminalSequences(line.slice(1, -1)).trimEnd());

/** The content line that holds `text`. */
const contentWith = (lines: readonly string[], text: string): string | undefined =>
  content(lines).find((line) => line.includes(text));

const topBorder = (lines: readonly string[]): string => lines[0] ?? "";
const bottomBorder = (lines: readonly string[]): string => lines[lines.length - 1] ?? "";

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#size-border: size and border
// ---------------------------------------------------------------------------

test("the panel is drawn inside a border whose top line carries the title", () => {
  const harness = questionWorld().startPanel({ params: direct() });
  const lines = harness.lines();
  const width = panelWidth(80);
  assert.equal(width, 76);
  assert.equal(topBorder(lines), `┌─ Question ${"─".repeat(76 - 13)}┐`);
  assert.equal(bottomBorder(lines), `└${"─".repeat(74)}┘`);
  for (const line of lines) assert.equal(visibleWidth(line), width);
  for (const line of lines.slice(1, -1)) {
    assert.equal(line.startsWith("│"), true);
    assert.equal(line.endsWith("│"), true);
  }
});

test("the overlay is centred, as wide as the panel, and capped by its largest page height", () => {
  const harness = questionWorld().startPanel({ params: pair() });
  const options = harness.customOptions();
  assert.equal(options.overlay, true);
  assert.deepEqual(options.overlayOptions, {
    anchor: "center",
    width: 76,
    maxHeight: 17,
    margin: 0,
  });
  assert.deepEqual(options.blocked, {
    kind: "question",
    message: "The agent is asking you a question",
  });
  assert.equal(harness.height(), 17);
});

test("the panel's width follows the terminal width and never passes 100 columns", () => {
  const widths: [columns: number, width: number][] = [
    [30, 30],
    [40, 40],
    [44, 40],
    [50, 46],
    [80, 76],
    [104, 100],
    [120, 100],
  ];
  for (const [columns, width] of widths) {
    const harness = questionWorld({ columns }).startPanel({ params: direct() });
    const lines = harness.lines();
    assert.equal(visibleWidth(topBorder(lines)), width, `columns ${columns}`);
    for (const line of lines) assert.equal(visibleWidth(line), width, `columns ${columns}`);
  }
});

test("a terminal narrower than the smallest width gives the panel the terminal width", () => {
  const harness = questionWorld({ columns: 30 }).startPanel({ params: direct() });
  assert.equal(visibleWidth(topBorder(harness.lines())), 30);
  // The title still fits at 30 columns.
  assert.equal(topBorder(harness.lines()).startsWith("┌─ Question "), true);
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#size-border: fixed height, padding, scrolling, indicator
// ---------------------------------------------------------------------------

test("the panel has the same height on every tab, row, text entry, and dismissal state", () => {
  const world = questionWorld();
  const harness = world.startPanel({ params: pair() });
  const height = harness.height();
  assert.equal(height, 17);
  const heights = new Set<number>([harness.lines().length]);
  for (let step = 0; step < 3; step += 1) {
    harness.press("j");
    heights.add(harness.lines().length);
  }
  harness.press("\t");
  heights.add(harness.lines().length);
  harness.press("j");
  heights.add(harness.lines().length);
  harness.press("\t");
  heights.add(harness.lines().length);
  harness.press("\t");
  heights.add(harness.lines().length);
  harness.press("\t");
  harness.press("3");
  heights.add(harness.lines().length);
  harness.press("\u001b");
  heights.add(harness.lines().length);
  harness.press("\u001b");
  heights.add(harness.lines().length);
  assert.deepEqual([...heights], [17]);
});

test("a call with a taller page keeps the same height everywhere, larger than a short call", () => {
  const short = questionWorld().startPanel({ params: pair() });
  const tall = questionWorld().startPanel({ params: tallPair() });
  assert.equal(short.height(), 17);
  assert.equal(tall.height(), 18);
  const heights = new Set<number>([tall.lines().length]);
  tall.press("\t");
  heights.add(tall.lines().length);
  tall.press("\t");
  heights.add(tall.lines().length);
  tall.press("\t");
  tall.press("3");
  heights.add(tall.lines().length);
  assert.deepEqual([...heights], [18]);
});

test("the height is capped at the terminal rows minus 2 and never below 3 lines", () => {
  const short = questionWorld({ rows: 10 }).startPanel({ params: pair() });
  assert.equal(short.height(), 8);
  assert.equal(short.lines().length, 8);
  const tiny = questionWorld({ rows: 4 }).startPanel({ params: pair() });
  assert.equal(tiny.height(), 3);
  assert.equal(tiny.lines().length, 3);
});

test("a page shorter than the body area is padded, with the hint on the last content line", () => {
  const harness = questionWorld().startPanel({ params: pair() });
  harness.press("\t");
  harness.press("\t");
  const lines = harness.lines();
  const body = content(lines);
  assert.equal(at(body, 0), `□ Auth  □ Targets  «Submit»`);
  assert.equal(at(body, 1), REVIEW_TITLE);
  assert.equal(at(body, body.length - 1), PANEL_HINTS.submit);
  // The Submit tab's body is 6 lines; the rest of the body area is empty.
  assert.deepEqual(body.slice(7, body.length - 1), Array(body.length - 8).fill(""));
});

test("a page body taller than the body area scrolls the least needed for the highlighted row", () => {
  const harness = questionWorld({ rows: 10 }).startPanel({ params: pair() });
  const lines = harness.lines();
  assert.equal(lines.length, 8);
  // Row 1: the first lines are visible.
  assert.equal(contentWith(lines, "> 1. OAuth"), "> 1. OAuth");
  // Row 3, the Other row: the body scrolls until it is visible.
  harness.press("j");
  harness.press("j");
  const scrolled = harness.lines();
  assert.equal(contentWith(scrolled, `> 3. ${OTHER_ROW_TEXT}`), `> 3. ${OTHER_ROW_TEXT}`);
  // The tab bar and the key-hint line never scroll.
  assert.equal(at(content(scrolled), 0), "«□ Auth»  □ Targets  Submit");
  assert.equal(at(content(scrolled), content(scrolled).length - 1), PANEL_HINTS.single);
  assert.equal(scrolled.length, 8);
});

test("the top border carries the scroll indicator only while the body scrolls", () => {
  const wide = questionWorld().startPanel({ params: pair() });
  assert.equal(topBorder(wide.lines()).includes("▲▼"), false);
  const short = questionWorld({ rows: 10 }).startPanel({ params: pair() });
  assert.equal(topBorder(short.lines()).includes("▲▼"), true);
  assert.equal(topBorder(short.lines()).endsWith(`${SCROLL_INDICATOR}┐`), true);
  assert.equal(visibleWidth(topBorder(short.lines())), 76);
});

test("an option row is counted with its prefix, so a long label does not scroll the panel", () => {
  // Two 51- and 54-character labels wrap at the inner width of 54, but the terminal has room.
  const longRows = params([
    {
      header: "Hosts",
      question: "Which hosts do you build?",
      options: [
        { label: "macOS laptops and desktops, Intel and Apple silicon", description: "Apple" },
        {
          label: "Linux desktops and servers, every distribution you run",
          description: "Linux",
        },
      ],
    },
  ]);
  const harness = questionWorld({ rows: 60, columns: 60 }).startPanel({ params: longRows });
  harness.press("3");
  harness.editor.rendered = ["e1", `e2${CURSOR_MARKER}`, "e3"];
  harness.panel().invalidate();
  const lines = harness.lines();
  assert.equal(topBorder(lines).includes(SCROLL_INDICATOR), false);
  assert.deepEqual(
    content(lines).filter((line) => /^e\d$/.test(line)),
    ["e1", "e2", "e3"],
  );
});

test("a resize recomputes the height and keeps the width taken when the panel opened", () => {
  const world = questionWorld();
  const harness = world.startPanel({ params: pair() });
  assert.equal(harness.lines().length, 17);
  world.tui.terminal.rows = 10;
  assert.equal(harness.height(), 8);
  assert.equal(harness.lines().length, 8);
  world.tui.terminal.rows = 24;
  world.tui.terminal.columns = 200;
  assert.equal(harness.height(), 17);
  assert.equal(harness.lines().length, 17);
  for (const line of harness.lines()) assert.equal(visibleWidth(line), 76);
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#panel-content: content
// ---------------------------------------------------------------------------

test("a direct call shows the question, its rows, the Other row, and the direct-call hint", () => {
  const harness = questionWorld().startPanel({ params: direct() });
  const body = content(harness.lines());
  assert.deepEqual(body.slice(0, 7), [
    "Which login method should the app use?",
    "",
    "> 1. OAuth",
    "     Use an external provider",
    "  2. Password",
    "     Own accounts",
    `  3. ${OTHER_ROW_TEXT}`,
  ]);
  assert.equal(at(body, body.length - 1), PANEL_HINTS.direct);
});

test("a multi-select row carries its mark, and the tab bar marks answered questions", () => {
  const harness = questionWorld().startPanel({ params: multi() });
  assert.equal(at(content(harness.lines()), 0), "«□ Targets»  Submit");
  assert.equal(contentWith(harness.lines(), "1. [ ] macOS"), "> 1. [ ] macOS");
  harness.press(" ");
  assert.equal(contentWith(harness.lines(), "1. [x] macOS"), "> 1. [x] macOS");
  assert.equal(at(content(harness.lines()), 0), "«■ Targets»  Submit");
});

test("values are cleaned of ANSI escape sequences and control characters (specs/ask-user-question-tool.md#panel-content)", () => {
  const harness = questionWorld().startPanel({
    params: {
      questions: [
        {
          header: "A\u0007uth",
          question: "Which\u001b[31m method?",
          options: [
            { label: "O\u001b[32mAuth", description: "Use \u0007one" },
            { label: "Password", description: "Own accounts" },
          ],
        },
      ],
    },
  });
  assert.equal(contentWith(harness.lines(), "Which method?"), "Which method?");
  assert.equal(contentWith(harness.lines(), "1. OAuth"), "> 1. OAuth");
  assert.equal(contentWith(harness.lines(), "Use one"), "     Use one");
  assert.equal(cleanValue("a\u0000b\u0009c\nd"), "abc\nd");
});

test("a line longer than the inner width wraps, except the Other row and the Submit tab's lines", () => {
  const width = panelWidth(50);
  assert.equal(width, 46);
  // The question text and the descriptions wrap at the inner width of 44.
  const wrapped = questionWorld({ columns: 50 }).startPanel({ params: tallPair() });
  wrapped.press("\t");
  const body = content(wrapped.lines());
  assert.equal(at(body, 1), "Which platforms must it support?");
  const first = body.findIndex((line) => line.startsWith("     Apple laptops"));
  assert.equal(first > 0, true);
  assert.equal(at(body, first + 1).includes("tools"), true);
  // The Other row with a long free text is cut to the inner width with `…`.
  const harness = questionWorld({ columns: 50 }).startPanel({ params: multi() });
  harness.press("3");
  harness.editor.type("a free text long enough to pass the inner width of the panel, twice over");
  harness.press("\r");
  const row = contentWith(harness.lines(), "Other:");
  assert.notEqual(row, undefined);
  assert.equal(row?.endsWith("…"), true);
  assert.equal(visibleWidth(row ?? ""), 44);
});

test("the Submit tab's question lines are cut to the inner width with …", () => {
  const harness = questionWorld({ columns: 50 }).startPanel({ params: multi() });
  harness.press("3");
  harness.editor.type("a free text long enough to pass the inner width of the panel, twice over");
  harness.press("\r");
  harness.press("\t");
  const line = contentWith(harness.lines(), "Targets:");
  assert.notEqual(line, undefined);
  assert.equal(line?.endsWith("…"), true);
  assert.equal(visibleWidth(line ?? ""), 44);
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#text-entry: text entry
// ---------------------------------------------------------------------------

test("the Other row starts text entry with the label and the editor", () => {
  const harness = questionWorld().startPanel({ params: direct() });
  harness.press("3");
  const body = content(harness.lines());
  const label = body.indexOf(TEXT_ENTRY_LABEL);
  assert.equal(label > 0, true);
  assert.equal(at(body, label - 1), "");
  assert.equal(at(body, label + 1), "editor:");
  assert.equal(at(body, body.length - 1), PANEL_HINTS.textEntry);
});

test("text entry shows 3 editor lines around the cursor mark, else the last 3", () => {
  const harness = questionWorld().startPanel({ params: direct() });
  harness.press("3");
  harness.editor.rendered = ["l1", "l2", "l3", `l4${CURSOR_MARKER}`, "l5", "l6"];
  harness.panel().invalidate();
  const marked = content(harness.lines()).filter((line) => line.startsWith("l"));
  assert.deepEqual(marked, ["l2", "l3", "l4"]);

  harness.editor.rendered = ["m1", "m2", "m3", "m4", "m5"];
  harness.panel().invalidate();
  const unmarked = content(harness.lines()).filter((line) => line.startsWith("m"));
  assert.deepEqual(unmarked, ["m3", "m4", "m5"]);

  harness.editor.rendered = ["only"];
  harness.panel().invalidate();
  const short = content(harness.lines()).filter((line) => line.startsWith("only"));
  assert.deepEqual(short, ["only"]);
});

test("text entry passes every key to the editor, and escape leaves the answer unchanged", () => {
  const harness = questionWorld().startPanel({ params: direct() });
  harness.press("3");
  harness.press("a");
  harness.press("\u001b[A");
  assert.deepEqual(harness.editor.keys, ["a", "\u001b[A"]);
  harness.press("\u001b");
  assert.equal(contentWith(harness.lines(), "3. "), `> 3. ${OTHER_ROW_TEXT}`);
  assert.equal(
    at(content(harness.lines()), content(harness.lines()).length - 1),
    PANEL_HINTS.direct,
  );
});

test("the editor's submit key records the free-text answer and advances a single-select question", async () => {
  const harness = questionWorld().startPanel({ params: direct() });
  harness.press("3");
  harness.press("h");
  harness.press("i");
  harness.press("\r");
  const result = await harness.result;
  assert.equal(result.details.outcome, "answered");
  assert.deepEqual(result.details.answers[0]?.options, []);
  assert.equal(result.details.answers[0]?.text, "hi");
});

test("a multi-select question records free text and keeps its page", () => {
  const harness = questionWorld().startPanel({ params: multi() });
  harness.press("3");
  harness.editor.type("also FreeBSD,\nif cheap");
  harness.press("\r");
  assert.equal(
    contentWith(harness.lines(), "Other: also FreeBSD,"),
    "> 3. [x] Other: also FreeBSD,",
  );
  assert.equal(
    at(content(harness.lines()), content(harness.lines()).length - 1),
    PANEL_HINTS.multi,
  );
  harness.press("\t");
  assert.equal(contentWith(harness.lines(), "Targets:"), 'Targets: "also FreeBSD, …"');
});

test("empty text removes an earlier free-text answer and the page stays", () => {
  const harness = questionWorld().startPanel({ params: multi() });
  harness.press("3");
  harness.editor.type("first");
  harness.press("\r");
  assert.equal(contentWith(harness.lines(), "Other:"), "> 3. [x] Other: first");
  harness.press("\r");
  harness.editor.setText("");
  harness.press("\r");
  assert.equal(contentWith(harness.lines(), "Other:"), `> 3. [ ] ${OTHER_ROW_TEXT}`);
});

test("empty text on a single-select question keeps its chosen option", async () => {
  const harness = questionWorld().startPanel({ params: pair() });
  // Choose OAuth on Auth, come back to it, and save empty text on its Other row.
  harness.press("1");
  harness.press("\u001b[Z");
  harness.press("3");
  harness.press("\r");
  assert.equal(at(content(harness.lines()), 0), "«■ Auth»  □ Targets  Submit");
  // The answer still carries the chosen option, and no free text.
  harness.press("\t");
  harness.press(" ");
  harness.press("\t");
  harness.press("\r");
  const result = await harness.result;
  assert.equal(result.details.outcome, "answered");
  assert.deepEqual(result.details.answers[0]?.options, ["OAuth"]);
  assert.equal(result.details.answers[0]?.text, null);
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#keys and specs/ask-user-question-tool.md#dismissal: keys, dismissal
// ---------------------------------------------------------------------------

test("up and down move the highlight and stop at the ends", () => {
  const harness = questionWorld().startPanel({ params: direct() });
  harness.press("\u001b[A");
  assert.equal(contentWith(harness.lines(), "1. OAuth"), "> 1. OAuth");
  harness.press("j");
  assert.equal(contentWith(harness.lines(), "2. Password"), "> 2. Password");
  harness.press("j");
  assert.equal(contentWith(harness.lines(), "3. Other"), `> 3. ${OTHER_ROW_TEXT}`);
  harness.press("j");
  assert.equal(contentWith(harness.lines(), "3. Other"), `> 3. ${OTHER_ROW_TEXT}`);
  harness.press("k");
  assert.equal(contentWith(harness.lines(), "2. Password"), "> 2. Password");
});

test("enter chooses the highlighted option of a single-select question and submits a direct call", async () => {
  const harness = questionWorld().startPanel({ params: direct() });
  harness.press("\u001b[B");
  harness.press("\r");
  const result = await harness.result;
  assert.equal(result.details.outcome, "answered");
  assert.equal(result.details.answers[0]?.options.join(","), "Password");
});

test("space acts as enter, and a digit key highlights its row and acts", async () => {
  const first = questionWorld().startPanel({ params: direct() });
  first.press(" ");
  assert.deepEqual((await first.result).details.answers[0]?.options, ["OAuth"]);

  const second = questionWorld().startPanel({ params: direct() });
  second.press("2");
  assert.deepEqual((await second.result).details.answers[0]?.options, ["Password"]);

  const third = questionWorld().startPanel({ params: direct() });
  third.press("5");
  assert.equal(contentWith(third.lines(), "1. OAuth"), "> 1. OAuth");
});

test("an option row of a multi-select question toggles and the page stays", () => {
  const harness = questionWorld().startPanel({ params: multi() });
  harness.press("\r");
  assert.equal(contentWith(harness.lines(), "macOS"), "> 1. [x] macOS");
  harness.press("j");
  harness.press("\r");
  assert.equal(contentWith(harness.lines(), "Linux"), "> 2. [x] Linux");
});

test("tab and the arrows move between tabs cyclically, and do nothing on a direct call", () => {
  const harness = questionWorld().startPanel({ params: pair() });
  assert.equal(at(content(harness.lines()), 0), "«□ Auth»  □ Targets  Submit");
  harness.press("\t");
  assert.equal(at(content(harness.lines()), 0), "□ Auth  «□ Targets»  Submit");
  harness.press("\u001b[C");
  assert.equal(at(content(harness.lines()), 0), "□ Auth  □ Targets  «Submit»");
  harness.press("\t");
  assert.equal(at(content(harness.lines()), 0), "«□ Auth»  □ Targets  Submit");
  harness.press("\u001b[Z");
  assert.equal(at(content(harness.lines()), 0), "□ Auth  □ Targets  «Submit»");
  harness.press("\u001b[D");
  assert.equal(at(content(harness.lines()), 0), "□ Auth  «□ Targets»  Submit");

  const single = questionWorld().startPanel({ params: direct() });
  single.press("\t");
  single.press("\u001b[C");
  assert.equal(
    contentWith(single.lines(), "Which login method"),
    "Which login method should the app use?",
  );
});

test("the Submit tab lists every question and the unanswered headers", () => {
  const harness = questionWorld().startPanel({ params: pair() });
  harness.press("\t");
  harness.press("\t");
  const body = content(harness.lines());
  assert.equal(at(body, 1), REVIEW_TITLE);
  assert.equal(at(body, 3), `Auth: ${REVIEW_MISSING}`);
  assert.equal(at(body, 4), `Targets: ${REVIEW_MISSING}`);
  assert.equal(at(body, 6), `${REVIEW_UNANSWERED}Auth, Targets`);
  assert.equal(at(body, body.length - 1), PANEL_HINTS.submit);
});

test("enter on the Submit tab submits only when every question is answered", async () => {
  const harness = questionWorld().startPanel({ params: pair() });
  harness.press("\r");
  assert.equal(at(content(harness.lines()), 0), "■ Auth  «□ Targets»  Submit");
  harness.press("\t");
  assert.equal(at(content(harness.lines()), 6), `${REVIEW_UNANSWERED}Targets`);
  harness.press("\r");
  assert.equal(at(content(harness.lines()), 1), REVIEW_TITLE);
  harness.press("\t");
  harness.press("\t");
  harness.press("\r");
  harness.press("\t");
  assert.equal(at(content(harness.lines()), 6), REVIEW_READY);
  harness.press("\r");
  const result = await harness.result;
  assert.equal(result.details.outcome, "answered");
  assert.deepEqual(result.details.answers[0]?.options, ["OAuth"]);
  assert.deepEqual(result.details.answers[1]?.options, ["macOS"]);
});

test("escape arms dismissal, and s ends the call with the dismissed result", async () => {
  const harness = questionWorld().startPanel({ params: direct() });
  harness.press("\u001b");
  const body = content(harness.lines());
  assert.equal(body.slice(-2).join(" "), PANEL_HINTS.armed);
  harness.press("s");
  const result = await harness.result;
  assert.equal(result.details.outcome, "dismissed");
  assert.equal(result.isError, undefined);
  assert.equal(result.terminate, undefined);
});

test("x while dismissal is armed ends the call with the stopped result", async () => {
  const harness = questionWorld().startPanel({ params: pair() });
  harness.press("\u001b");
  harness.press("x");
  const result = await harness.result;
  assert.equal(result.details.outcome, "stopped");
  assert.equal(result.terminate, true);
});

test("escape disarms dismissal, and any other key disarms it and is handled", () => {
  const harness = questionWorld().startPanel({ params: direct() });
  harness.press("\u001b");
  harness.press("\u001b");
  assert.equal(contentWith(harness.lines(), "move"), PANEL_HINTS.direct);
  harness.press("\u001b");
  harness.press("j");
  assert.equal(contentWith(harness.lines(), "2. Password"), "> 2. Password");
  assert.equal(contentWith(harness.lines(), "move"), PANEL_HINTS.direct);
});

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#answers and specs/ask-user-question-tool.md#question-panel: the answer summary, focus
// ---------------------------------------------------------------------------

test("the answer summary joins labels, then the quoted first line with an ellipsis", () => {
  assert.equal(summaryOf([], null), "");
  assert.equal(summaryOf(["a", "b"], null), "a, b");
  assert.equal(summaryOf([], "one"), '"one"');
  assert.equal(summaryOf(["a"], "one\ntwo"), 'a, "one …"');
});

test("the panel is focusable and hands focus to its editor", () => {
  const harness = questionWorld().startPanel({ params: direct() });
  const component = harness.panel();
  assert.equal(component.focused, false);
  component.focused = true;
  assert.equal(harness.editor.focused, true);
});
