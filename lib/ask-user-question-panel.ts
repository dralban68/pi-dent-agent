/**
 * The question panel of the `AskUserQuestion` tool (specs/ask-user-question-tool.md#question-panel), and the answer model of specs/ask-user-question-tool.md#answers that the dialog sequence (specs/ask-user-question-tool.md#dialog-sequence)
 * shares with it.
 *
 * The panel is a state machine over (questions, answers, page, highlighted rows, text
 * entry, dismissal) rendered on demand inside a border of fixed size (specs/ask-user-question-tool.md#size-border): every
 * rule of specs/ask-user-question-tool.md#size-border, specs/ask-user-question-tool.md#rows-tabs, specs/ask-user-question-tool.md#panel-content, specs/ask-user-question-tool.md#keys, specs/ask-user-question-tool.md#text-entry, specs/ask-user-question-tool.md#dismissal is a pure function of that state and the terminal size, so the
 * panel is testable without a terminal. The host's editor component is injected, and the
 * theme is the host theme, or an identity theme in tests.
 */

import {
  CURSOR_MARKER,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type OverlayOptions,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#answers: answers
// ---------------------------------------------------------------------------

/** One option of a question, after specs/ask-user-question-tool.md#validation validation. */
export interface AskOption {
  label: string;
  description: string;
}

/** One question of a call, after specs/ask-user-question-tool.md#validation validation. */
export interface AskQuestion {
  header: string;
  question: string;
  options: AskOption[];
  multiSelect: boolean;
}

/** One question's answer (specs/ask-user-question-tool.md#answers): chosen option indexes, and the free-text answer. */
export interface AskAnswer {
  /** Indexes into the question's `options`, in option order. */
  chosen: number[];
  /** The free-text answer, or `null` when absent. */
  text: string | null;
}

export function emptyAnswer(): AskAnswer {
  return { chosen: [], text: null };
}

/** A single-select question's answer chooses one option and drops the free-text answer (specs/ask-user-question-tool.md#answers). */
export function chooseOption(answer: AskAnswer, index: number): void {
  answer.chosen = [index];
  answer.text = null;
}

/** A multi-select option toggles; the free-text answer stays (specs/ask-user-question-tool.md#answers). */
export function toggleOption(answer: AskAnswer, index: number): void {
  answer.chosen = answer.chosen.includes(index)
    ? answer.chosen.filter((chosen) => chosen !== index)
    : [...answer.chosen, index].toSorted((left, right) => left - right);
}

/** Records a free-text answer; a single-select question keeps no chosen option (specs/ask-user-question-tool.md#answers). */
export function recordFreeText(
  answer: AskAnswer,
  question: AskQuestion,
  text: string | null,
): void {
  answer.text = text;
  if (!question.multiSelect) answer.chosen = [];
}

/** A question is answered per specs/ask-user-question-tool.md#answers. */
export function isAnswered(question: AskQuestion, answer: AskAnswer): boolean {
  if (answer.text !== null) return true;
  return question.multiSelect ? answer.chosen.length > 0 : answer.chosen.length === 1;
}

/** The labels of the chosen options, in option order. */
export function chosenLabels(question: AskQuestion, answer: AskAnswer): string[] {
  const labels: string[] = [];
  for (const index of answer.chosen.toSorted((left, right) => left - right)) {
    const option = question.options[index];
    if (option !== undefined) labels.push(option.label);
  }
  return labels;
}

/**
 * The answer summary of specs/ask-user-question-tool.md#answers: the labels joined by `, `, then the free-text
 * answer in quotes with ` …` when it has more lines.
 */
export function summaryOf(labels: readonly string[], text: string | null): string {
  const base = labels.join(", ");
  if (text === null) return base;
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const more = lines.length > 1 ? " …" : "";
  const quoted = `"${first}${more}"`;
  return base === "" ? quoted : `${base}, ${quoted}`;
}

export function answerSummary(question: AskQuestion, answer: AskAnswer): string {
  return summaryOf(chosenLabels(question, answer), answer.text);
}

/** A free-text answer as specs/ask-user-question-tool.md#answers records it: CRLF to LF, trimmed, empty records none. */
export function normalizeFreeText(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return normalized === "" ? null : normalized;
}

/** The first line of a text, without truncation. */
export function firstLineOf(text: string): string {
  const end = text.indexOf("\n");
  return end < 0 ? text : text.slice(0, end);
}

/** A call is direct when it has exactly one question and that question is single-select (specs/ask-user-question-tool.md#answers). */
export function isDirectCall(questions: readonly AskQuestion[]): boolean {
  const only = questions[0];
  return questions.length === 1 && only !== undefined && !only.multiSelect;
}

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#panel-content: cleaned values
// ---------------------------------------------------------------------------

/** Where the escape sequence that starts at `start` ends. */
function skipEscape(text: string, start: number): number {
  let index = start + 1;
  const introducer = text.charAt(index);
  if (introducer === "[") {
    // Control sequence: runs to a final byte in 0x40 to 0x7e.
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      index += 1;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return index;
  }
  if (introducer === "]") {
    // Operating system command: runs to BEL, or to the string terminator ESC \.
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x07) return index + 1;
      if (code === 0x1b && text.charAt(index + 1) === "\\") return index + 2;
      index += 1;
    }
    return index;
  }
  // Any other escape: the escape character and the one after it.
  return Math.min(text.length, index + 1);
}

/** specs/ask-user-question-tool.md#panel-content: ANSI escape sequences and control characters other than the line feed removed. */
export function cleanValue(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      index = skipEscape(text, index);
      continue;
    }
    if (code === 0x0a || (code >= 0x20 && code < 0x7f) || code > 0x9f) {
      out += text.charAt(index);
    }
    index += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#panel-content: the texts the panel shows
// ---------------------------------------------------------------------------

/** The key-hint lines of specs/ask-user-question-tool.md#panel-content, the first that applies. */
export const PANEL_HINTS = {
  armed: "Dismiss the questions? s skip, the agent continues · x stop the agent run · esc back",
  textEntry: "enter save · esc back",
  submit: "enter submit · tab/←→ question · esc dismiss",
  direct: "↑↓ move · enter choose · esc dismiss",
  single: "↑↓ move · enter choose · tab/←→ question · esc dismiss",
  multi: "↑↓ move · space toggle · tab/←→ question · esc dismiss",
} as const;

/** The Other row's text without a free-text answer (specs/ask-user-question-tool.md#panel-content). */
export const OTHER_ROW_TEXT = "Other: type your own answer";
/** The line above the editor in text entry (specs/ask-user-question-tool.md#panel-content). */
export const TEXT_ENTRY_LABEL = "Your answer:";
/** The Submit tab's first line (specs/ask-user-question-tool.md#panel-content). */
export const REVIEW_TITLE = "Review your answers";
/** The Submit tab's line when every question is answered (specs/ask-user-question-tool.md#panel-content). */
export const REVIEW_READY = "Press enter to submit.";
/** The Submit tab's prefix when a question is unanswered (specs/ask-user-question-tool.md#panel-content). */
export const REVIEW_UNANSWERED = "Unanswered: ";
/** A question's line on the Submit tab when it is unanswered (specs/ask-user-question-tool.md#panel-content). */
export const REVIEW_MISSING = "(unanswered)";
/** The Submit tab's label in the tab bar (specs/ask-user-question-tool.md#panel-content). */
export const SUBMIT_TAB_LABEL = "Submit";
/** The tab bar's answered and unanswered marks (specs/ask-user-question-tool.md#panel-content). */
export const TAB_MARK = { answered: "■", unanswered: "□" } as const;

/** The indent of an option row's description line (specs/ask-user-question-tool.md#size-border: 5 columns). */
const DESCRIPTION_INDENT = "     ";
/** The 2 columns of an option row before its number: `> ` or `  ` (specs/ask-user-question-tool.md#panel-content). */
const ROW_PREFIX = "  ";
/** The multi-select mark of an option row (specs/ask-user-question-tool.md#panel-content: 4 columns). */
const MULTI_MARK = "[ ] ";
/** The digit keys of specs/ask-user-question-tool.md#keys, in order. */
const DIGIT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

// ---------------------------------------------------------------------------
// specs/ask-user-question-tool.md#size-border: size and border
// ---------------------------------------------------------------------------

/** The title in the top border (specs/ask-user-question-tool.md#size-border). */
export const PANEL_TITLE = "Question";
/** The top border before the fill: `┌─ Question ` (specs/ask-user-question-tool.md#size-border). */
export const PANEL_TOP_PREFIX = `┌─ ${PANEL_TITLE} `;
/** The box-drawing characters of specs/ask-user-question-tool.md#size-border. */
export const PANEL_BORDER = {
  topLeft: "┌",
  horizontal: "─",
  topRight: "┐",
  vertical: "│",
  bottomLeft: "└",
  bottomRight: "┘",
} as const;
/** The indicator of a page body taller than the body area: space, U+25B2, U+25BC, space (specs/ask-user-question-tool.md#size-border). */
export const SCROLL_INDICATOR = " ▲▼ ";
/** The last column of a line cut to the inner width: U+2026 (specs/ask-user-question-tool.md#panel-content). */
export const TRUNCATION_MARK = "…";
/** The panel's largest width in columns (specs/ask-user-question-tool.md#size-border). */
export const PANEL_MAX_WIDTH = 100;
/** The panel's smallest width in columns, unless the terminal is narrower (specs/ask-user-question-tool.md#size-border). */
export const PANEL_MIN_WIDTH = 40;
/** The columns the terminal width minus this bound the panel's width (specs/ask-user-question-tool.md#size-border). */
export const PANEL_SIDE_COLUMNS = 4;
/** The panel's smallest height in lines (specs/ask-user-question-tool.md#size-border). */
export const PANEL_MIN_HEIGHT = 3;
/** The editor lines the panel shows in text entry (specs/ask-user-question-tool.md#size-border). */
export const EDITOR_LINES = 3;

/** The panel's width in columns for a terminal width (specs/ask-user-question-tool.md#size-border). */
export function panelWidth(terminalColumns: number): number {
  const columns = Math.max(1, Math.floor(terminalColumns));
  return Math.min(
    PANEL_MAX_WIDTH,
    Math.max(PANEL_MIN_WIDTH, columns - PANEL_SIDE_COLUMNS),
    columns,
  );
}

function wrapLines(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width));
}

/** The tab bar's text without theme colors; the marks have one column each (specs/ask-user-question-tool.md#panel-content). */
function plainTabBar(questions: readonly AskQuestion[]): string {
  const tabs = questions.map((question) => `${TAB_MARK.unanswered} ${cleanValue(question.header)}`);
  tabs.push(SUBMIT_TAB_LABEL);
  return tabs.join("  ");
}

/** An option row as specs/ask-user-question-tool.md#panel-content renders it, in its unhighlighted form: `  2. [ ] label`. */
function optionRowText(question: AskQuestion, index: number, label: string): string {
  const mark = question.multiSelect ? MULTI_MARK : "";
  return `${ROW_PREFIX}${index + 1}. ${mark}${label}`;
}

/** A question page's body lines, text entry included (specs/ask-user-question-tool.md#size-border). */
export function questionBodyHeight(question: AskQuestion, inner: number): number {
  let lines = wrapLines(cleanValue(question.question), inner).length + 1;
  for (const [index, option] of question.options.entries()) {
    // Each option row is counted as specs/ask-user-question-tool.md#panel-content renders it, prefix and mark included.
    lines += wrapLines(optionRowText(question, index, cleanValue(option.label)), inner).length;
    lines += wrapLines(`${DESCRIPTION_INDENT}${cleanValue(option.description)}`, inner).length;
  }
  // The Other row, then the 5 lines of text entry: one empty line, `Your answer:`, 3 editor lines.
  return lines + 1 + 1 + 1 + EDITOR_LINES;
}

/** The Submit tab's body lines, for the longer of its two submit lines (specs/ask-user-question-tool.md#size-border). */
export function submitBodyHeight(questions: readonly AskQuestion[], inner: number): number {
  const headers = questions.map((question) => cleanValue(question.header)).join(", ");
  const ready = wrapLines(REVIEW_READY, inner).length;
  const unanswered = wrapLines(`${REVIEW_UNANSWERED}${headers}`, inner).length;
  return 1 + 1 + questions.length + 1 + Math.max(ready, unanswered);
}

/** The largest page height of specs/ask-user-question-tool.md#size-border, which caps the overlay and the panel's height. */
export function largestPageHeight(questions: readonly AskQuestion[], width: number): number {
  const inner = Math.max(1, width - 2);
  const direct = isDirectCall(questions);
  const tabLines = direct ? 0 : wrapLines(plainTabBar(questions), inner).length;
  const hintLines = Math.max(
    ...Object.values(PANEL_HINTS).map((hint) => wrapLines(hint, inner).length),
  );
  const bodies = questions.map((question) => questionBodyHeight(question, inner));
  if (!direct) bodies.push(submitBodyHeight(questions, inner));
  return 2 + tabLines + Math.max(0, ...bodies) + hintLines;
}

/** The panel's height for the terminal rows, capped at the rows minus 2 (specs/ask-user-question-tool.md#size-border). */
export function panelHeight(largest: number, terminalRows: number): number {
  return Math.max(PANEL_MIN_HEIGHT, Math.min(largest, Math.floor(terminalRows) - 2));
}

/** The slice of the host theme the panel uses. */
export interface AskPanelTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
}

export const identityPanelTheme: AskPanelTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
};

/** The slice of the host editor component the panel drives (specs/ask-user-question-tool.md#text-entry). */
export interface AskEditorLike {
  handleInput(data: string): void;
  render(width: number): string[];
  setText(text: string): void;
  getText(): string;
  onSubmit?: ((text: string) => void) | undefined;
  focused?: boolean;
}

/** The slice of the host TUI the panel uses: the render request and the terminal size. */
export interface AskPanelTui {
  requestRender(): void;
  terminal: { rows: number; columns: number };
}

/** What the panel returns to the caller (specs/ask-user-question-tool.md#answered-result and specs/ask-user-question-tool.md#other-results). */
export type AskPanelResult =
  | { kind: "answered"; answers: AskAnswer[] }
  | { kind: "dismissed" }
  | { kind: "stopped" }
  | { kind: "aborted" }
  | { kind: "shutdown" };

export interface AskQuestionPanelOptions {
  questions: readonly AskQuestion[];
  tui: AskPanelTui;
  theme: AskPanelTheme;
  editor: AskEditorLike;
  done: (result: AskPanelResult) => void;
}

/** A page body: its lines, and the lines of the highlighted row for scrolling. */
interface Body {
  lines: string[];
  span: { first: number; last: number } | undefined;
}

/** The smallest line offset that shows `span` inside `area` lines (specs/ask-user-question-tool.md#size-border). */
function scrollOffset(span: Body["span"], area: number, total: number): number {
  if (span === undefined || total <= area) return 0;
  const wanted = Math.min(span.first, span.last - area + 1);
  return Math.max(0, Math.min(wanted, total - area));
}

/**
 * The question panel (specs/ask-user-question-tool.md#size-border, specs/ask-user-question-tool.md#rows-tabs, specs/ask-user-question-tool.md#panel-content, specs/ask-user-question-tool.md#keys, specs/ask-user-question-tool.md#text-entry, specs/ask-user-question-tool.md#dismissal). The caller feeds keys through `handleInput`,
 * renders through `render`, and ends the interaction through `finish` when the call is
 * aborted or the session ends (specs/ask-user-question-tool.md#no-answers).
 */
export class AskQuestionPanel implements Component, Focusable {
  private readonly questions: readonly AskQuestion[];
  private readonly answers: AskAnswer[];
  /** A direct call has one page, the question page of its question (specs/ask-user-question-tool.md#answers). */
  private readonly direct: boolean;
  private readonly tui: AskPanelTui;
  private readonly theme: AskPanelTheme;
  private readonly editor: AskEditorLike;
  private readonly done: (result: AskPanelResult) => void;
  /** The highlighted row of each question, initially row 1 (specs/ask-user-question-tool.md#rows-tabs). */
  private readonly highlighted: number[];
  /** The width fixed when the panel opens (specs/ask-user-question-tool.md#size-border). */
  private readonly windowWidth: number;
  /** The largest page height, which does not change while the panel is open (specs/ask-user-question-tool.md#size-border). */
  private readonly largestHeight: number;
  /** The current tab: a question index, or the Submit tab at `questions.length`. */
  private tab = 0;
  private textEntry = false;
  private armed = false;
  private focusState = false;
  private closed = false;
  private cache: { height: number; lines: string[] } | undefined;

  constructor(options: AskQuestionPanelOptions) {
    this.questions = options.questions;
    this.answers = options.questions.map(() => emptyAnswer());
    this.direct = isDirectCall(options.questions);
    this.tui = options.tui;
    this.theme = options.theme;
    this.editor = options.editor;
    this.done = options.done;
    this.highlighted = options.questions.map(() => 0);
    this.windowWidth = panelWidth(options.tui.terminal.columns);
    this.largestHeight = largestPageHeight(options.questions, this.windowWidth);
    this.editor.onSubmit = (text) => {
      this.recordTextEntry(text);
    };
  }

  get focused(): boolean {
    return this.focusState;
  }

  set focused(value: boolean) {
    this.focusState = value;
    this.editor.focused = value;
  }

  /** The host overlay options of specs/ask-user-question-tool.md#question-panel: centred, as wide as the panel, capped by its largest page height. */
  overlayOptions(): OverlayOptions {
    return {
      anchor: "center",
      width: this.windowWidth,
      maxHeight: this.largestHeight,
      margin: 0,
    };
  }

  /** The panel's height at the current terminal rows (specs/ask-user-question-tool.md#size-border). */
  height(): number {
    return panelHeight(this.largestHeight, this.tui.terminal.rows);
  }

  /** The answers at this moment, for the answered result (specs/ask-user-question-tool.md#answered-result). */
  answersNow(): AskAnswer[] {
    return this.answers.map((answer) => ({ chosen: [...answer.chosen], text: answer.text }));
  }

  /** Ends the interaction; the first call wins and later ones do nothing. */
  finish(result: AskPanelResult): void {
    if (this.closed) return;
    this.closed = true;
    this.cache = undefined;
    this.done(result);
  }

  invalidate(): void {
    this.cache = undefined;
  }

  // -------------------------------------------------------------------------
  // specs/ask-user-question-tool.md#keys and specs/ask-user-question-tool.md#dismissal: keys
  // -------------------------------------------------------------------------

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.textEntry) {
      // specs/ask-user-question-tool.md#text-entry: every key goes to the editor except `escape`.
      if (matchesKey(data, "escape")) {
        this.leaveTextEntry();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }
    if (this.armed) {
      this.armed = false;
      if (matchesKey(data, "s")) {
        this.finish({ kind: "dismissed" });
        return;
      }
      if (matchesKey(data, "x")) {
        this.finish({ kind: "stopped" });
        return;
      }
      if (matchesKey(data, "escape")) {
        this.refresh();
        return;
      }
    }
    this.key(data);
    this.refresh();
  }

  private key(data: string): void {
    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.moveTab(1);
      return;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
      this.moveTab(-1);
      return;
    }
    if (matchesKey(data, "escape")) {
      this.armed = true;
      return;
    }
    if (this.onSubmitTab()) {
      if (matchesKey(data, "enter") || matchesKey(data, "space")) this.submit();
      return;
    }
    const question = this.questions[this.tab];
    if (question === undefined) return;
    const rows = question.options.length + 1;
    const current = this.highlighted[this.tab] ?? 0;
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (current > 0) this.highlighted[this.tab] = current - 1;
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      if (current < rows - 1) this.highlighted[this.tab] = current + 1;
      return;
    }
    const digit = DIGIT_KEYS.findIndex((candidate) => matchesKey(data, candidate));
    if (digit >= 0) {
      if (digit < rows) {
        this.highlighted[this.tab] = digit;
        this.act(this.tab, question);
      }
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "space")) this.act(this.tab, question);
  }

  private onSubmitTab(): boolean {
    return !this.direct && this.tab >= this.questions.length;
  }

  /** The tab order is cyclic, the Submit tab included (specs/ask-user-question-tool.md#rows-tabs). */
  private moveTab(delta: number): void {
    if (this.direct) return;
    const total = this.questions.length + 1;
    this.tab = (this.tab + delta + total) % total;
  }

  /** Acting on the highlighted row (specs/ask-user-question-tool.md#keys). */
  private act(index: number, question: AskQuestion): void {
    const answer = this.answers[index];
    if (answer === undefined) return;
    const row = this.highlighted[index] ?? 0;
    if (row >= question.options.length) {
      this.startTextEntry();
      return;
    }
    if (question.multiSelect) {
      toggleOption(answer, row);
      return;
    }
    chooseOption(answer, row);
    this.advance();
  }

  /** Advancing submits a direct call; otherwise it moves to the next tab (specs/ask-user-question-tool.md#keys). */
  private advance(): void {
    if (this.direct) {
      this.submit();
      return;
    }
    this.moveTab(1);
  }

  private submit(): void {
    const answered = this.questions.every((question, index) => {
      const answer = this.answers[index];
      return answer !== undefined && isAnswered(question, answer);
    });
    if (!answered) return;
    this.finish({ kind: "answered", answers: this.answersNow() });
  }

  // -------------------------------------------------------------------------
  // specs/ask-user-question-tool.md#text-entry: text entry
  // -------------------------------------------------------------------------

  private startTextEntry(): void {
    this.textEntry = true;
    this.editor.setText(this.answers[this.tab]?.text ?? "");
    this.editor.focused = this.focusState;
    this.refresh();
  }

  private leaveTextEntry(): void {
    this.textEntry = false;
    this.editor.setText("");
    this.refresh();
  }

  private recordTextEntry(value: string): void {
    if (this.closed || !this.textEntry) return;
    const question = this.questions[this.tab];
    const answer = this.answers[this.tab];
    this.textEntry = false;
    if (question === undefined || answer === undefined) {
      this.refresh();
      return;
    }
    const text = normalizeFreeText(value);
    if (text === null) {
      // specs/ask-user-question-tool.md#text-entry: recording none removes the earlier free-text answer and keeps the choice.
      answer.text = null;
      this.refresh();
      return;
    }
    recordFreeText(answer, question, text);
    if (question.multiSelect) {
      this.refresh();
      return;
    }
    this.advance();
    this.refresh();
  }

  private refresh(): void {
    if (this.closed) return;
    this.cache = undefined;
    this.tui.requestRender();
  }

  // -------------------------------------------------------------------------
  // specs/ask-user-question-tool.md#size-border and specs/ask-user-question-tool.md#panel-content: the panel's lines
  // -------------------------------------------------------------------------

  render(width: number): string[] {
    const panelColumns = Math.min(this.windowWidth, Math.max(1, Math.floor(width)));
    const height = this.height();
    if (this.cache !== undefined && this.cache.height === height) return this.cache.lines;
    const lines = this.build(panelColumns, height);
    this.cache = { height, lines };
    return lines;
  }

  private build(width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const tabLines = this.direct ? [] : wrapLines(this.tabBar(), inner);
    const hintLines = wrapLines(this.hint(), inner);
    const area = Math.max(0, height - 2 - tabLines.length - hintLines.length);
    const body = this.body(inner);
    const scrolled = body.lines.length > area;
    const offset = this.onSubmitTab() ? 0 : scrollOffset(body.span, area, body.lines.length);
    const shown: string[] = [];
    for (let row = 0; row < area; row += 1) shown.push(body.lines[offset + row] ?? "");
    const content = [...tabLines, ...shown, ...hintLines].slice(0, Math.max(0, height - 2));
    const border = PANEL_BORDER;
    return [
      this.topBorder(width, scrolled),
      ...content.map(
        (line) =>
          `${border.vertical}${truncateToWidth(line, inner, TRUNCATION_MARK, true)}${border.vertical}`,
      ),
      this.bottomBorder(width),
    ];
  }

  /** The top border of specs/ask-user-question-tool.md#size-border: the title, the fill, and the scroll indicator. */
  private topBorder(width: number, scrolled: boolean): string {
    const inner = Math.max(1, width - 2);
    const border = PANEL_BORDER;
    const indicator = scrolled ? SCROLL_INDICATOR : "";
    const prefix = PANEL_TOP_PREFIX;
    if (width >= prefix.length + indicator.length + 1) {
      const fill = width - prefix.length - indicator.length - 1;
      return this.theme.fg(
        "border",
        `${prefix}${border.horizontal.repeat(fill)}${indicator}${border.topRight}`,
      );
    }
    if (width >= prefix.length + 1) {
      const fill = width - prefix.length - 1;
      return this.theme.fg(
        "border",
        `${prefix}${border.horizontal.repeat(fill)}${border.topRight}`,
      );
    }
    return this.theme.fg(
      "border",
      `${border.topLeft}${border.horizontal.repeat(inner)}${border.topRight}`,
    );
  }

  private bottomBorder(width: number): string {
    const inner = Math.max(1, width - 2);
    const border = PANEL_BORDER;
    return this.theme.fg(
      "border",
      `${border.bottomLeft}${border.horizontal.repeat(inner)}${border.bottomRight}`,
    );
  }

  /** The tab bar of specs/ask-user-question-tool.md#panel-content: one line of tabs separated by two spaces. */
  private tabBar(): string {
    const tabs: string[] = [];
    for (const [index, question] of this.questions.entries()) {
      const answer = this.answers[index];
      const answered = answer !== undefined && isAnswered(question, answer);
      const mark = answered ? TAB_MARK.answered : TAB_MARK.unanswered;
      const text = `${mark} ${cleanValue(question.header)}`;
      if (index === this.tab) tabs.push(this.theme.bg("selectedBg", text));
      else tabs.push(this.theme.fg(answered ? "success" : "muted", text));
    }
    const submit =
      this.tab >= this.questions.length
        ? this.theme.bg("selectedBg", SUBMIT_TAB_LABEL)
        : this.theme.fg("dim", SUBMIT_TAB_LABEL);
    tabs.push(submit);
    return tabs.join("  ");
  }

  /** The current page's body (specs/ask-user-question-tool.md#panel-content). */
  private body(inner: number): Body {
    if (this.onSubmitTab()) return { lines: this.reviewLines(inner), span: undefined };
    return this.questionBody(inner);
  }

  private questionBody(inner: number): Body {
    const question = this.questions[this.tab];
    const answer = this.answers[this.tab];
    if (question === undefined || answer === undefined) return { lines: [], span: undefined };
    const lines = wrapLines(cleanValue(question.question), inner);
    lines.push("");
    const highlighted = this.highlighted[this.tab] ?? 0;
    let span: Body["span"];
    for (let row = 0; row < question.options.length + 1; row += 1) {
      const first = lines.length;
      const option = question.options[row];
      const mark = question.multiSelect
        ? this.rowPresent(question, answer, row)
          ? "[x] "
          : MULTI_MARK
        : "";
      const prefix = row === highlighted ? "> " : ROW_PREFIX;
      const text = option === undefined ? this.otherRowText(answer) : cleanValue(option.label);
      const plain = `${prefix}${row + 1}. ${mark}${text}`;
      const painted = row === highlighted ? this.theme.fg("accent", plain) : plain;
      // The Other row is cut to the inner width; an option row wraps (specs/ask-user-question-tool.md#panel-content).
      if (option === undefined) lines.push(truncateToWidth(painted, inner, TRUNCATION_MARK));
      else lines.push(...wrapLines(painted, inner));
      if (option !== undefined) {
        lines.push(
          ...wrapLines(
            this.theme.fg("muted", `${DESCRIPTION_INDENT}${cleanValue(option.description)}`),
            inner,
          ),
        );
      }
      if (row === highlighted) span = { first, last: lines.length - 1 };
    }
    if (this.textEntry) {
      lines.push("");
      lines.push(TEXT_ENTRY_LABEL);
      lines.push(...this.editorWindow(inner));
    }
    return { lines, span };
  }

  /** The Submit tab of specs/ask-user-question-tool.md#panel-content; its question lines are cut to the inner width. */
  private reviewLines(inner: number): string[] {
    const lines = [REVIEW_TITLE, ""];
    const missing: string[] = [];
    for (const [index, question] of this.questions.entries()) {
      const answer = this.answers[index];
      const answered = answer !== undefined && isAnswered(question, answer);
      const header = cleanValue(question.header);
      if (!answered) missing.push(header);
      const summary =
        answered && answer !== undefined
          ? cleanValue(answerSummary(question, answer))
          : REVIEW_MISSING;
      lines.push(truncateToWidth(`${header}: ${summary}`, inner, TRUNCATION_MARK));
    }
    lines.push("");
    if (missing.length === 0) lines.push(...wrapLines(REVIEW_READY, inner));
    else lines.push(...wrapLines(`${REVIEW_UNANSWERED}${missing.join(", ")}`, inner));
    return lines;
  }

  /**
   * specs/ask-user-question-tool.md#text-entry: 3 lines of the editor, around the line holding its cursor mark, else its
   * last 3; the content scrolls inside the panel.
   */
  private editorWindow(inner: number): string[] {
    const rendered = this.editor.render(inner);
    if (rendered.length <= EDITOR_LINES) return rendered;
    const marked = rendered.findIndex((line) => line.includes(CURSOR_MARKER));
    const start =
      marked < 0
        ? rendered.length - EDITOR_LINES
        : Math.max(0, Math.min(marked - (EDITOR_LINES - 1), rendered.length - EDITOR_LINES));
    return rendered.slice(start, start + EDITOR_LINES);
  }

  private rowPresent(question: AskQuestion, answer: AskAnswer, row: number): boolean {
    if (row >= question.options.length) return answer.text !== null;
    return answer.chosen.includes(row);
  }

  private otherRowText(answer: AskAnswer): string {
    if (answer.text === null) return OTHER_ROW_TEXT;
    return `Other: ${firstLineOf(cleanValue(answer.text))}`;
  }

  /** The key-hint line of specs/ask-user-question-tool.md#panel-content, the first that applies. */
  private hint(): string {
    if (this.armed) return PANEL_HINTS.armed;
    if (this.textEntry) return PANEL_HINTS.textEntry;
    if (this.onSubmitTab()) return PANEL_HINTS.submit;
    if (this.direct) return PANEL_HINTS.direct;
    const question = this.questions[this.tab];
    return question !== undefined && question.multiSelect ? PANEL_HINTS.multi : PANEL_HINTS.single;
  }
}
