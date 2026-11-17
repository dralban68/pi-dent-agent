/**
 * The `AskUserQuestion` tool (specs/ask-user-question-tool.md): the registration surface and
 * model-facing texts of Section 1, the execution-time validation of Section 1.2, the question
 * queue of Section 2, the dialog sequence of Section 4 and the question form request of
 * Section 4.4 in RPC mode, the results of Section 6,
 * and the conversation rendering of Section 7. The terminal panel of Section 3 lives in
 * `lib/ask-user-question-panel.ts`, together with the answer model both surfaces share.
 *
 * Everything host-specific is a parameter — the session ID, the run mode, whether the host
 * reports a user interface, the abort signal of the run, and the UI surface — so every rule is
 * testable without a terminal. A call is open from its start until it returns: it registers no
 * task row, and `Task` neither lists nor cancels it.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  ExtensionContext,
  ExtensionToolContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Editor, Text, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  AskQuestionPanel,
  OTHER_ROW_TEXT,
  REVIEW_TITLE,
  answerSummary,
  chosenLabels,
  chooseOption,
  cleanValue,
  emptyAnswer,
  firstLineOf,
  isAnswered,
  normalizeFreeText,
  recordFreeText,
  summaryOf,
  toggleOption,
  type AskAnswer,
  type AskEditorLike,
  type AskOption,
  type AskPanelResult,
  type AskQuestion,
} from "./ask-user-question-panel.ts";
import { isPlainObject } from "./util.ts";

// ---------------------------------------------------------------------------
// Section 1.3: model-facing texts, verbatim
// ---------------------------------------------------------------------------

export const ASK_USER_TOOL_NAME = "AskUserQuestion";

/** The tool's `description` (Section 1.3). */
export const ASK_USER_DESCRIPTION =
  'Ask the user 1 to 4 multiple-choice questions and wait for the answers, instead of ending your turn to ask in prose. Use it when a decision only the user can make blocks your work: a requirement, a preference, or a choice between approaches. Each question has a short header, 2 to 4 options with a label and a description, and multiSelect to allow several options. The user can always answer in their own words instead; do not add an "Other" option. The result lists each answer by question number, as options chosen or as free text.';

/** The tool's `promptSnippet` (Section 1.3). */
export const ASK_USER_PROMPT_SNIPPET =
  "Ask the user multiple-choice questions and wait for the answers";

/** The `description` of each schema property, verbatim from Section 1.3. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  questions: "1 to 4 questions, asked together.",
  question: "The question, one line, ending with a question mark.",
  header: 'A label of at most 12 characters naming the question, e.g. "Auth".',
  options: '2 to 4 distinct options; "Other" is added automatically.',
  label: "The option, 1 to 5 words, at most 60 characters.",
  description: "One line on what choosing this option means.",
  multiSelect: "true lets the user choose several options. Default false.",
} as const;

const DESCRIPTIONS = ASK_USER_PARAMETER_DESCRIPTIONS;

// ---------------------------------------------------------------------------
// Section 1.1: parameter schema
// ---------------------------------------------------------------------------

const askOptionSchema = Type.Object(
  {
    label: Type.String({ description: DESCRIPTIONS.label }),
    description: Type.String({ description: DESCRIPTIONS.description }),
  },
  { additionalProperties: false },
);

const askQuestionSchema = Type.Object(
  {
    question: Type.String({ description: DESCRIPTIONS.question }),
    header: Type.String({ description: DESCRIPTIONS.header }),
    options: Type.Array(askOptionSchema, { description: DESCRIPTIONS.options }),
    multiSelect: Type.Optional(Type.Boolean({ description: DESCRIPTIONS.multiSelect })),
  },
  { additionalProperties: false },
);

export const askUserQuestionParameterSchema = Type.Object(
  {
    questions: Type.Array(askQuestionSchema, { description: DESCRIPTIONS.questions }),
  },
  { additionalProperties: false },
);

export type AskUserQuestionParams = Static<typeof askUserQuestionParameterSchema>;

// ---------------------------------------------------------------------------
// Section 1.2: validation
// ---------------------------------------------------------------------------

export type AskValidation = { ok: true; questions: AskQuestion[] } | { ok: false; error: string };

/** Every string of the call is used with leading and trailing white space removed (Section 1.1). */
function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A string is one line when it holds neither a line feed nor a carriage return (Section 1.1). */
function isOneLine(text: string): boolean {
  return !text.includes("\n") && !text.includes("\r");
}

/**
 * Section 1.2: check 1, then checks 2 to 6 and 7 to 11 and 12 of each question in array
 * order, and the first failing check's error text.
 */
export function validateAskQuestions(params: unknown): AskValidation {
  const record: Record<string, unknown> = isPlainObject(params) ? params : {};
  const rawQuestions = Array.isArray(record.questions) ? record.questions : [];
  if (rawQuestions.length < 1 || rawQuestions.length > 4) {
    return { ok: false, error: "questions must hold 1 to 4 questions" };
  }
  const questions: AskQuestion[] = [];
  const seenQuestions: string[] = [];
  for (const [index, rawQuestion] of rawQuestions.entries()) {
    const i = index + 1;
    const raw: Record<string, unknown> = isPlainObject(rawQuestion) ? rawQuestion : {};
    const question = trimmedString(raw.question);
    if (question === "") {
      return { ok: false, error: `question ${i}: question must be a non-empty string` };
    }
    if (!isOneLine(question)) {
      return { ok: false, error: `question ${i}: question must be one line` };
    }
    const header = trimmedString(raw.header);
    if (header === "") {
      return { ok: false, error: `question ${i}: header must be a non-empty string` };
    }
    if (!isOneLine(header) || header.length > 12) {
      return {
        ok: false,
        error: `question ${i}: header must be one line of at most 12 characters`,
      };
    }
    const rawOptions = Array.isArray(raw.options) ? raw.options : [];
    if (rawOptions.length < 2 || rawOptions.length > 4) {
      return { ok: false, error: `question ${i}: options must hold 2 to 4 options` };
    }
    const options: AskOption[] = [];
    const labels: string[] = [];
    for (const [optionIndex, rawOption] of rawOptions.entries()) {
      const j = optionIndex + 1;
      const option: Record<string, unknown> = isPlainObject(rawOption) ? rawOption : {};
      const label = trimmedString(option.label);
      if (label === "") {
        return { ok: false, error: `question ${i} option ${j}: label must be a non-empty string` };
      }
      if (!isOneLine(label) || label.length > 60) {
        return {
          ok: false,
          error: `question ${i} option ${j}: label must be one line of at most 60 characters`,
        };
      }
      if (label.toLowerCase() === "other") {
        return { ok: false, error: `question ${i} option ${j}: label "Other" is reserved` };
      }
      // Section 1.2 check 10: labels are compared as shown, after the cleaning of Section 3.3.
      if (labels.includes(cleanValue(label))) {
        return { ok: false, error: `question ${i} option ${j}: duplicate label "${label}"` };
      }
      const description = trimmedString(option.description);
      if (description === "" || !isOneLine(description)) {
        return {
          ok: false,
          error: `question ${i} option ${j}: description must be a non-empty single line`,
        };
      }
      labels.push(cleanValue(label));
      options.push({ label, description });
    }
    if (seenQuestions.includes(question)) {
      return { ok: false, error: `question ${i}: duplicate question` };
    }
    seenQuestions.push(question);
    questions.push({ header, question, options, multiSelect: raw.multiSelect === true });
  }
  return { ok: true, questions };
}

// ---------------------------------------------------------------------------
// Sections 6.2 and 6.3: result texts
// ---------------------------------------------------------------------------

/** The no-UI result text (Section 6.2). */
export const ASK_USER_NO_UI_TEXT =
  "AskUserQuestion is unavailable: this session has no interactive terminal UI. Ask in your reply instead.";
/** The dismissed result text (Section 6.2). */
export const ASK_USER_DISMISSED_TEXT =
  "The user declined to answer the questions. Proceed on your own judgement, or ask in your reply.";
/** The stopped result text (Section 6.2). */
export const ASK_USER_STOPPED_TEXT =
  "The user declined to answer the questions and stopped the agent run. Do not assume an answer; end your turn and wait for the user.";
/** The aborted result text (Section 6.2). */
export const ASK_USER_ABORTED_TEXT =
  "The questions were withdrawn because the agent run was aborted; the user did not answer.";
/** The shutdown result text (Section 6.2). */
export const ASK_USER_SHUTDOWN_TEXT =
  "The questions were withdrawn because the session ended or reloaded; the user did not answer.";
/** The first line of the answered result text (Section 6.1). */
export const ASK_USER_ANSWERED_TITLE = "The user answered your questions:";

/** The blocked-on-user message of the panel (Section 3). */
export const ASK_BLOCKED_MESSAGE = "The agent is asking you a question";

/** The dialog texts of Sections 4.1 to 4.3. */
export const ASK_DIALOG = {
  /** Section 4.2: the review's title. */
  reviewTitle: REVIEW_TITLE,
  /** Section 4.2: the review's submit option. */
  reviewSubmit: "Submit",
  /** Section 4.3: the dismissal choice's title and options. */
  dismissalTitle: "Dismiss the questions?",
  skip: "Skip: let the agent continue without answers",
  stop: "Stop: end the agent run",
  back: "Back to the questions",
  /** Section 4.1: the `input` placeholder and the multi-select title suffix. */
  inputPlaceholder: "Type your answer",
  multiSelectSuffix: " — choose one or more, then Done",
  /** Section 4.1: the multi-select question's last option. */
  done: "Done",
} as const;

export type AskOutcome =
  | "answered"
  | "no-ui"
  | "dismissed"
  | "stopped"
  | "aborted"
  | "shutdown"
  | "invalid";

const ASK_OUTCOMES: readonly AskOutcome[] = [
  "answered",
  "no-ui",
  "dismissed",
  "stopped",
  "aborted",
  "shutdown",
  "invalid",
];

/** One entry of `details.answers` (Section 6.3). */
export interface AskAnswerDetails {
  header: string;
  question: string;
  options: string[];
  text: string | null;
}

/** The `details` of every result (Section 6.3). */
export type AskDetails = {
  outcome: AskOutcome;
  answers: AskAnswerDetails[];
};

export type AskToolResult = AgentToolResult<AskDetails>;

function textResult(
  text: string,
  outcome: AskOutcome,
  flags: { isError?: true; terminate?: true },
): AskToolResult {
  return { content: [{ type: "text", text }], details: { outcome, answers: [] }, ...flags };
}

function invalidResult(text: string): AskToolResult {
  return textResult(text, "invalid", { isError: true });
}

function noUiResult(): AskToolResult {
  return textResult(ASK_USER_NO_UI_TEXT, "no-ui", { isError: true });
}

function dismissedResult(): AskToolResult {
  return textResult(ASK_USER_DISMISSED_TEXT, "dismissed", {});
}

function stoppedResult(): AskToolResult {
  return textResult(ASK_USER_STOPPED_TEXT, "stopped", { terminate: true });
}

function abortedResult(): AskToolResult {
  return textResult(ASK_USER_ABORTED_TEXT, "aborted", { isError: true });
}

function shutdownResult(): AskToolResult {
  return textResult(ASK_USER_SHUTDOWN_TEXT, "shutdown", { isError: true });
}

function answerAt(answers: readonly AskAnswer[], index: number): AskAnswer {
  return answers[index] ?? emptyAnswer();
}

/** Section 6.1: the answered result text and its `details`. */
export function answeredResult(
  questions: readonly AskQuestion[],
  answers: readonly AskAnswer[],
): AskToolResult {
  const lines: string[] = [ASK_USER_ANSWERED_TITLE];
  const detailsAnswers: AskAnswerDetails[] = [];
  for (const [index, question] of questions.entries()) {
    const answer = answerAt(answers, index);
    const labels = chosenLabels(question, answer);
    lines.push(`${index + 1}. ${question.header} — ${question.question}`);
    for (const label of labels) lines.push(`   option: ${label}`);
    if (answer.text !== null) {
      lines.push("   free text:");
      for (const line of answer.text.split("\n")) lines.push(`   > ${line}`);
    }
    detailsAnswers.push({
      header: question.header,
      question: question.question,
      options: labels,
      text: answer.text,
    });
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { outcome: "answered", answers: detailsAnswers },
  };
}

function isAskOutcome(value: unknown): value is AskOutcome {
  return ASK_OUTCOMES.some((candidate) => candidate === value);
}

function askAnswersOf(value: unknown): AskAnswerDetails[] {
  if (!Array.isArray(value)) return [];
  const answers: AskAnswerDetails[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const header = entry.header;
    const question = entry.question;
    if (typeof header !== "string" || typeof question !== "string") continue;
    const options = Array.isArray(entry.options)
      ? entry.options.filter((option): option is string => typeof option === "string")
      : [];
    const text = entry.text;
    answers.push({
      header,
      question,
      options,
      text: typeof text === "string" ? text : null,
    });
  }
  return answers;
}

function askDetailsOf(value: unknown): AskDetails | undefined {
  if (!isPlainObject(value)) return;
  const outcome = value.outcome;
  if (!isAskOutcome(outcome)) return;
  return { outcome, answers: askAnswersOf(value.answers) };
}

// ---------------------------------------------------------------------------
// Section 2: the question queue
// ---------------------------------------------------------------------------

/** The run mode the host reports (Section 1.4); the host package exports no name for it. */
export type AskRunMode = ExtensionContext["mode"];

/** The slice of the host UI surface the tool drives. */
export type AskUi = Pick<ExtensionUIContext, "custom" | "select" | "input" | "editor">;

/** One call of the tool. */
export interface AskInvocation {
  sessionId: string;
  /** The tool call ID the host passes to the tool's execution (Section 4.4). */
  toolCallId: string;
  params: unknown;
  signal: AbortSignal | undefined;
  ui: AskUi;
  mode: AskRunMode;
  hasUI: boolean;
}

interface PendingCall {
  questions: readonly AskQuestion[];
  signal: AbortSignal | undefined;
  ui: AskUi;
  mode: AskRunMode;
  /** The tool call ID of the call (Section 4.4). */
  toolCallId: string;
  /** Whether an RPC call is asked through the question form request (Section 4.4). */
  askForm: boolean;
  resolve: (result: AskToolResult) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  /** Closes what is shown for this call; the shown panel's own result is then ignored. */
  interrupt: (() => void) | undefined;
  /** Removes the abort listener of the call's signal. */
  detach: () => void;
}

interface AskSession {
  /** The open calls that passed step 2, in the order they reached step 3 (Section 2). */
  queue: PendingCall[];
  asking: PendingCall | undefined;
  /** Aborts when the session ends; every dialog of the session is passed it (Section 4). */
  shutdown: AbortController;
}

export interface AskUserRuntime {
  /** One `AskUserQuestion` call. */
  execute(invocation: AskInvocation): Promise<AskToolResult>;
  /** `session_shutdown`: every open call of the session ends with the shutdown result (Section 5). */
  sessionShutdown(sessionId: string): void;
}

/** The host's editor component, styled like the panel (Section 3.4). */
function hostEditor(tui: TUI, theme: Theme): Editor {
  const editorTheme: EditorTheme = {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
  return new Editor(tui, editorTheme);
}

function panelToolResult(
  result: AskPanelResult | undefined,
  questions: readonly AskQuestion[],
): AskToolResult {
  if (result === undefined) return abortedResult();
  if (result.kind === "answered") return answeredResult(questions, result.answers);
  if (result.kind === "dismissed") return dismissedResult();
  if (result.kind === "stopped") return stoppedResult();
  if (result.kind === "shutdown") return shutdownResult();
  return abortedResult();
}

/** The question title of Section 4.1. */
function questionTitle(question: AskQuestion, index: number, total: number): string {
  const base = `${cleanValue(question.header)} (${index + 1} of ${total}): ${cleanValue(question.question)}`;
  return question.multiSelect ? `${base}${ASK_DIALOG.multiSelectSuffix}` : base;
}

interface DialogEntry {
  text: string;
  kind: "option" | "other" | "done";
  index: number;
}

/** The option strings of Section 4.1, in option order, then Other, then Done. */
function optionEntries(question: AskQuestion, answer: AskAnswer): DialogEntry[] {
  const entries: DialogEntry[] = [];
  for (const [index, option] of question.options.entries()) {
    const mark = question.multiSelect ? (answer.chosen.includes(index) ? "[x] " : "[ ] ") : "";
    entries.push({
      text: `${index + 1}. ${mark}${cleanValue(option.label)} — ${cleanValue(option.description)}`,
      kind: "option",
      index,
    });
  }
  const otherNumber = question.options.length + 1;
  if (!question.multiSelect) {
    entries.push({ text: `${otherNumber}. ${OTHER_ROW_TEXT}`, kind: "other", index: -1 });
    return entries;
  }
  const present = answer.text !== null;
  const mark = present ? "[x] " : "[ ] ";
  const text = present
    ? `${otherNumber}. ${mark}Other: ${firstLineOf(cleanValue(answer.text ?? ""))}`
    : `${otherNumber}. ${mark}${OTHER_ROW_TEXT}`;
  entries.push({ text, kind: "other", index: -1 });
  entries.push({ text: `${otherNumber + 1}. ${ASK_DIALOG.done}`, kind: "done", index: -1 });
  return entries;
}

type Ended = { kind: "ended" } | { kind: "dismissed" } | { kind: "stopped" };
type SelectOutcome = { kind: "value"; value: string } | Ended;
type DismissalOutcome = Ended | { kind: "back" };
type QuestionOutcome = { kind: "next" } | Ended;
type Step =
  | { kind: "question"; index: number; next: Step }
  | { kind: "submit" }
  | { kind: "review" };

/** The signal every dialog of a call gets: the call's, combined with the session's (Section 4). */
function callSignal(session: AskSession, call: PendingCall): AbortSignal {
  return AbortSignal.any([
    session.shutdown.signal,
    ...(call.signal === undefined ? [] : [call.signal]),
  ]);
}

/** The result of a call that ends while it is asked: shutdown when the session ended (Section 5). */
function endedResult(session: AskSession): AskToolResult {
  return session.shutdown.signal.aborted ? shutdownResult() : abortedResult();
}

/** Section 4.3: the dismissal choice; `Back to the questions` and a cancel both come back as `back`. */
async function dismissalChoice(call: PendingCall, signal: AbortSignal): Promise<DismissalOutcome> {
  const options = [ASK_DIALOG.skip, ASK_DIALOG.stop, ASK_DIALOG.back];
  for (;;) {
    const value = await call.ui.select(ASK_DIALOG.dismissalTitle, options, { signal });
    if (signal.aborted) return { kind: "ended" };
    if (value === ASK_DIALOG.skip) return { kind: "dismissed" };
    if (value === ASK_DIALOG.stop) return { kind: "stopped" };
    // Cancelling the choice, and `Back to the questions`, show the cancelled dialog again.
    if (value === ASK_DIALOG.back || value === undefined) return { kind: "back" };
  }
}

/** The value of a dialog that is not awaited any longer because the signal aborted. */
const ABORTED: unique symbol = Symbol("aborted");

/**
 * Resolves with the promise's value, or with `ABORTED` as soon as the signal aborts. A value
 * the promise settles with afterwards is dropped by the caller.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => {
      resolve(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Section 4.4: the title of the question form request's editor. */
export const ASK_FORM_TITLE = "AskUserQuestion";
/** Section 4.4: the `piDent` field of the form payload. */
export const ASK_FORM_VERSION = "ask-form/1";

/** Section 4.4: the form payload, the JSON text of the cleaned call. */
export function formPayload(toolCallId: string, questions: readonly AskQuestion[]): string {
  return JSON.stringify({
    piDent: ASK_FORM_VERSION,
    toolCallId: cleanValue(toolCallId),
    questions: questions.map((question) => ({
      header: cleanValue(question.header),
      question: cleanValue(question.question),
      multiSelect: question.multiSelect,
      options: question.options.map((option) => ({
        label: cleanValue(option.label),
        description: cleanValue(option.description),
      })),
    })),
  });
}

/** A parsed form answer (Section 4.4). */
export type FormAnswer =
  | { kind: "answered"; answers: AskAnswer[] }
  | { kind: "dismissed" }
  | { kind: "stopped" };

/**
 * One question's entry of an answered form answer, or `undefined` when it is not valid for the
 * question (Section 4.4): labels of the question, none twice, a text or `null`, answered per
 * Section 2.1, and a single-select question with exactly one of an option and a free text.
 */
function formAnswerOf(entry: unknown, question: AskQuestion): AskAnswer | undefined {
  if (!isPlainObject(entry)) return undefined;
  const options = entry.options;
  const text = entry.text;
  if (!Array.isArray(options)) return undefined;
  const chosen: number[] = [];
  for (const label of options) {
    if (typeof label !== "string") return undefined;
    const index = question.options.findIndex((option) => cleanValue(option.label) === label);
    if (index < 0 || chosen.includes(index)) return undefined;
    chosen.push(index);
  }
  let freeText: string | null;
  if (text === null) freeText = null;
  else if (typeof text === "string") freeText = normalizeFreeText(text);
  else return undefined;
  const answer: AskAnswer = {
    chosen: chosen.toSorted((left, right) => left - right),
    text: freeText,
  };
  if (!isAnswered(question, answer)) return undefined;
  const parts = answer.chosen.length + (answer.text === null ? 0 : 1);
  if (!question.multiSelect && parts !== 1) return undefined;
  return answer;
}

/** Section 4.4: parses the text the editor returned, or `undefined` when it is not a valid form answer. */
export function parseFormAnswer(
  text: string,
  questions: readonly AskQuestion[],
): FormAnswer | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  if (parsed.outcome === "dismissed") return { kind: "dismissed" };
  if (parsed.outcome === "stopped") return { kind: "stopped" };
  if (parsed.outcome !== "answered") return undefined;
  const entries = parsed.answers;
  if (!Array.isArray(entries) || entries.length !== questions.length) return undefined;
  const answers: AskAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const answer = formAnswerOf(entries[index], question);
    if (answer === undefined) return undefined;
    answers.push(answer);
  }
  return { kind: "answered", answers };
}

/**
 * Section 4.4: the question form request. One `editor` dialog asks the whole call; its text is
 * parsed as the form answer, and an invalid text shows the same editor again.
 */
async function formRequest(session: AskSession, call: PendingCall): Promise<AskToolResult> {
  const questions = call.questions;
  const signal = callSignal(session, call);
  const payload = formPayload(call.toolCallId, questions);
  for (;;) {
    // `editor` takes no abort signal: the call's signal ends the wait instead (Section 4.4).
    const text = await untilAborted(call.ui.editor(ASK_FORM_TITLE, payload), signal);
    if (text === ABORTED || signal.aborted) return endedResult(session);
    if (text === undefined) {
      const dismissal = await dismissalChoice(call, signal);
      if (dismissal.kind === "ended") return endedResult(session);
      if (dismissal.kind === "dismissed") return dismissedResult();
      if (dismissal.kind === "stopped") return stoppedResult();
      continue;
    }
    const form = parseFormAnswer(text, questions);
    if (form === undefined) continue;
    if (form.kind === "answered") return answeredResult(questions, form.answers);
    return form.kind === "dismissed" ? dismissedResult() : stoppedResult();
  }
}

/**
 * The dialog sequence of Section 4, run for one call in RPC mode. Every dialog gets the
 * call's abort signal combined with the session's, and no timeout (Section 4).
 */
async function dialogSequence(session: AskSession, call: PendingCall): Promise<AskToolResult> {
  const questions = call.questions;
  const answers: AskAnswer[] = questions.map(() => emptyAnswer());
  const signal = callSignal(session, call);
  const only = questions[0];
  const direct = questions.length === 1 && only !== undefined && !only.multiSelect;
  const ended = (): AskToolResult =>
    session.shutdown.signal.aborted ? shutdownResult() : abortedResult();

  async function selectWithDismissal(
    title: string,
    options: readonly string[],
  ): Promise<SelectOutcome> {
    const list = [...options];
    for (;;) {
      const value = await call.ui.select(title, list, { signal });
      if (signal.aborted) return { kind: "ended" };
      if (value === undefined) {
        const dismissal = await dismissalChoice(call, signal);
        if (dismissal.kind === "back") continue;
        return dismissal;
      }
      if (list.includes(value)) return { kind: "value", value };
      // A value that is not one of the option strings shows the same dialog again (Section 4).
    }
  }

  async function inputDialog(
    title: string,
  ): Promise<{ kind: "value"; value: string } | { kind: "ended" }> {
    const value = await call.ui.input(title, ASK_DIALOG.inputPlaceholder, { signal });
    if (signal.aborted) return { kind: "ended" };
    return { kind: "value", value: value ?? "" };
  }

  async function questionStep(index: number): Promise<QuestionOutcome> {
    const question = questions[index];
    if (question === undefined) return { kind: "ended" };
    const answer = answerAt(answers, index);
    for (;;) {
      if (signal.aborted) return { kind: "ended" };
      const title = questionTitle(question, index, questions.length);
      const entries = optionEntries(question, answer);
      const outcome = await selectWithDismissal(
        title,
        entries.map((entry) => entry.text),
      );
      if (outcome.kind !== "value") return outcome;
      const entry = entries.find((candidate) => candidate.text === outcome.value);
      if (entry === undefined) continue;
      if (entry.kind === "option") {
        if (question.multiSelect) {
          toggleOption(answer, entry.index);
          continue;
        }
        chooseOption(answer, entry.index);
        return { kind: "next" };
      }
      if (entry.kind === "done") {
        if (isAnswered(question, answer)) return { kind: "next" };
        continue;
      }
      // Other: a single-select answer replaces the option; a multi-select answer toggles.
      if (question.multiSelect && answer.text !== null) {
        answer.text = null;
        continue;
      }
      const entered = await inputDialog(title);
      if (entered.kind === "ended") return entered;
      const text = normalizeFreeText(entered.value);
      if (!question.multiSelect && text === null) continue;
      recordFreeText(answer, question, text);
      if (!question.multiSelect) return { kind: "next" };
    }
  }

  let step: Step = direct ? { kind: "submit" } : { kind: "review" };
  for (let index = questions.length - 1; index >= 0; index -= 1) {
    step = { kind: "question", index, next: step };
  }

  for (;;) {
    if (signal.aborted) return ended();
    if (step.kind === "submit") return answeredResult(questions, answers);
    if (step.kind === "review") {
      const entries: { text: string; index: number }[] = [
        { text: ASK_DIALOG.reviewSubmit, index: -1 },
      ];
      for (const [index, question] of questions.entries()) {
        const summary = cleanValue(answerSummary(question, answerAt(answers, index)));
        entries.push({
          text: `${index + 1}. ${cleanValue(question.header)}: ${summary}`,
          index,
        });
      }
      const outcome = await selectWithDismissal(
        ASK_DIALOG.reviewTitle,
        entries.map((entry) => entry.text),
      );
      if (outcome.kind === "ended") return ended();
      if (outcome.kind === "dismissed") return dismissedResult();
      if (outcome.kind === "stopped") return stoppedResult();
      const entry = entries.find((candidate) => candidate.text === outcome.value);
      if (entry === undefined) continue;
      if (entry.index < 0) return answeredResult(questions, answers);
      step = { kind: "question", index: entry.index, next: { kind: "review" } };
      continue;
    }
    const outcome = await questionStep(step.index);
    if (outcome.kind === "next") {
      step = step.next;
      continue;
    }
    if (outcome.kind === "ended") return ended();
    return outcome.kind === "dismissed" ? dismissedResult() : stoppedResult();
  }
}

/** The question queue of Section 2 and the endings of Section 5. */
export interface AskUserRuntimeOptions {
  /** Creates the panel's editor: the host's editor component, or a recorder in tests. */
  editor?: (tui: TUI, theme: Theme) => AskEditorLike;
  /**
   * The environment of the pi process, read at each call; `PI_DENT_ASK_FORM` `1` selects the
   * question form request in RPC mode (Section 2). Defaults to `process.env`.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

export function askUserRuntime(options: AskUserRuntimeOptions = {}): AskUserRuntime {
  const createEditor = options.editor ?? hostEditor;
  const sessions = new Map<string, AskSession>();

  function sessionOf(sessionId: string): AskSession {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: AskSession = {
      queue: [],
      asking: undefined,
      shutdown: new AbortController(),
    };
    sessions.set(sessionId, created);
    return created;
  }

  function startNext(session: AskSession): void {
    if (session.asking !== undefined) return;
    if (session.shutdown.signal.aborted) return;
    const call = session.queue[0];
    if (call === undefined) return;
    session.asking = call;
    void run(session, call);
  }

  async function run(session: AskSession, call: PendingCall): Promise<void> {
    try {
      let result: AskToolResult;
      if (call.mode === "tui") result = await throughPanel(session, call);
      else if (call.askForm) result = await formRequest(session, call);
      else result = await dialogSequence(session, call);
      settle(session, call, result);
    } catch (error) {
      // A host surface that fails is not one of the endings of Section 5: the call rejects, and
      // the host reports its own error result for the call.
      fail(session, call, error);
    }
  }

  function detachCall(session: AskSession, call: PendingCall): (() => void) | undefined {
    call.settled = true;
    call.detach();
    const interrupt = call.interrupt;
    call.interrupt = undefined;
    const index = session.queue.indexOf(call);
    if (index >= 0) session.queue.splice(index, 1);
    if (session.asking === call) session.asking = undefined;
    return interrupt;
  }

  function fail(session: AskSession, call: PendingCall, error: unknown): void {
    if (call.settled) return;
    const interrupt = detachCall(session, call);
    interrupt?.();
    call.reject(error);
    if (!session.shutdown.signal.aborted) startNext(session);
  }

  function settle(session: AskSession, call: PendingCall, result: AskToolResult): void {
    if (call.settled) return;
    const interrupt = detachCall(session, call);
    call.resolve(result);
    interrupt?.();
    // The next queued call is asked after a dismissed, a stopped, or an aborted result;
    // after `session_shutdown` none is (Section 5).
    if (!session.shutdown.signal.aborted) startNext(session);
  }

  /** Section 3: the panel, as an overlay centred in the terminal (Section 3.1). */
  async function throughPanel(session: AskSession, call: PendingCall): Promise<AskToolResult> {
    let panel: AskQuestionPanel | undefined;
    const result = await call.ui.custom<AskPanelResult>(
      (tui, theme, _keybindings, done) => {
        const created = new AskQuestionPanel({
          questions: call.questions,
          tui,
          theme,
          editor: createEditor(tui, theme),
          done,
        });
        panel = created;
        if (call.settled) {
          // The call ended before the host built the panel: close it at once (Section 5).
          created.finish({ kind: session.shutdown.signal.aborted ? "shutdown" : "aborted" });
          return created;
        }
        call.interrupt = () => {
          created.finish({ kind: session.shutdown.signal.aborted ? "shutdown" : "aborted" });
        };
        return created;
      },
      {
        overlay: true,
        overlayOptions: () => panel?.overlayOptions() ?? { anchor: "center" },
        blocked: { kind: "question", message: ASK_BLOCKED_MESSAGE },
      },
    );
    return panelToolResult(result, call.questions);
  }

  function ask(
    invocation: AskInvocation,
    questions: readonly AskQuestion[],
    askForm: boolean,
  ): Promise<AskToolResult> {
    const session = sessionOf(invocation.sessionId);
    return new Promise<AskToolResult>((resolve, reject) => {
      const signal = invocation.signal;
      const onAbort = (): void => {
        settle(session, call, abortedResult());
      };
      const call: PendingCall = {
        questions,
        signal,
        ui: invocation.ui,
        mode: invocation.mode,
        toolCallId: invocation.toolCallId,
        askForm,
        resolve,
        reject,
        settled: false,
        interrupt: undefined,
        detach: () => {
          signal?.removeEventListener("abort", onAbort);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      session.queue.push(call);
      startNext(session);
    });
  }

  async function execute(invocation: AskInvocation): Promise<AskToolResult> {
    const validation = validateAskQuestions(invocation.params);
    if (!validation.ok) return invalidResult(validation.error);
    // Section 2, step 1: a session without a user interface shows nothing.
    if (!invocation.hasUI) return noUiResult();
    // Section 2, step 2.
    if (invocation.signal?.aborted === true) return abortedResult();
    // Section 2, step 3: the form request replaces the dialog sequence when announced.
    const env = options.env ?? process.env;
    return ask(invocation, validation.questions, env.PI_DENT_ASK_FORM === "1");
  }

  function sessionShutdown(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session === undefined) return;
    sessions.delete(sessionId);
    session.shutdown.abort();
    // Settle from the end so each removal keeps the remaining indexes valid.
    for (let index = session.queue.length - 1; index >= 0; index -= 1) {
      const call = session.queue[index];
      if (call !== undefined) settle(session, call, shutdownResult());
    }
  }

  return { execute, sessionShutdown };
}

// ---------------------------------------------------------------------------
// Section 7: rendering in the conversation
// ---------------------------------------------------------------------------

/** Section 7: the call's line and one line per question, while the arguments stream. */
function callLines(args: unknown, theme: Theme): string {
  const questions = isPlainObject(args) && Array.isArray(args.questions) ? args.questions : [];
  const lines = [theme.fg("toolTitle", theme.bold(ASK_USER_TOOL_NAME))];
  for (const entry of questions) {
    if (!isPlainObject(entry)) continue;
    const header = entry.header;
    const question = entry.question;
    if (typeof header !== "string" || typeof question !== "string") continue;
    lines.push(`${cleanValue(header.trim())}: ${cleanValue(question.trim())}`);
  }
  return lines.join("\n");
}

/** The `AskUserQuestion` tool definition the host registers (Section 1). */
export function makeAskUserQuestionTool(runtime: AskUserRuntime) {
  return defineTool({
    name: ASK_USER_TOOL_NAME,
    label: ASK_USER_TOOL_NAME,
    exposure: "model-only",
    description: ASK_USER_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    parameters: askUserQuestionParameterSchema,
    async execute(
      toolCallId: string,
      params: AskUserQuestionParams,
      signal: AbortSignal | undefined,
      _onUpdate: ((partial: AskToolResult) => void) | undefined,
      ctx: ExtensionToolContext,
    ): Promise<AskToolResult> {
      return runtime.execute({
        sessionId: ctx.sessionManager.getSessionId(),
        toolCallId,
        params,
        signal,
        ui: ctx.ui,
        mode: ctx.mode,
        hasUI: ctx.hasUI,
      });
    },
    renderCall(args, theme) {
      return new Text(callLines(args, theme), 0, 0);
    },
    renderResult(result) {
      const details = askDetailsOf(result.details);
      if (details !== undefined && details.outcome === "answered") {
        const lines = details.answers.map(
          (answer) =>
            `${cleanValue(answer.header)}: ${cleanValue(summaryOf(answer.options, answer.text))}`,
        );
        return new Text(lines.join("\n"), 0, 0);
      }
      const first = result.content[0];
      const text = first !== undefined && first.type === "text" ? first.text : "";
      return new Text(cleanValue(text), 0, 0);
    },
  });
}
