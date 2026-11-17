/**
 * The harness of the specs/ask-user-question-tool.md tests: a fake UI whose `custom`
 * builds the panel component and hands it back for key input, a fake host editor, and a
 * scripted dialog surface for the RPC sequence. No terminal is involved.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { panelWidth } from "../../lib/ask-user-question-panel.ts";
import type {
  AskPanelResult,
  AskQuestion,
  AskQuestionPanel,
} from "../../lib/ask-user-question-panel.ts";
import { askUserRuntime } from "../../lib/ask-user-question-tool.ts";
import type { AskToolResult, AskUi, AskUserRuntime } from "../../lib/ask-user-question-tool.ts";
import { must } from "../support/must.ts";

/** The panel's theme with the selection background made visible. */
export const plainTheme = {
  fg: (_color: string, text: string): string => text,
  bg: (_color: string, text: string): string => `«${text}»`,
};

export interface FakeTui {
  renders: number;
  terminal: { rows: number; columns: number };
  requestRender(): void;
}

export function fakeTui(rows = 24, columns = 80): FakeTui {
  const tui: FakeTui = {
    renders: 0,
    terminal: { rows, columns },
    requestRender: () => {
      tui.renders += 1;
    },
  };
  return tui;
}

/** The host's editor component, replaced by a recorder (Section 3.4). */
export class FakeEditor {
  onSubmit: ((text: string) => void) | undefined;
  focused = false;
  text = "";
  keys: string[] = [];

  handleInput(data: string): void {
    this.keys.push(data);
    if (data === "\r") {
      const value = this.text;
      this.text = "";
      this.onSubmit?.(value);
      return;
    }
    if (data.length === 1 && data !== "\u001b") this.text += data;
  }

  render(_width: number): string[] {
    return this.rendered ?? [`editor: ${this.text}`];
  }

  /** Lines to render instead of the single `editor: <text>` line, for Section 3.5's window. */
  rendered: string[] | undefined;

  setText(text: string): void {
    this.text = text;
  }

  getText(): string {
    return this.text;
  }

  /** Types into the editor, as the keys of Section 3.4 would. */
  type(text: string): void {
    this.text += text;
  }
}

type PanelFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: AskPanelResult) => void,
) => AskQuestionPanel;

export interface PanelHarness {
  runtime: AskUserRuntime;
  tui: FakeTui;
  editor: FakeEditor;
  result: Promise<AskToolResult>;
  /** The `ctx.ui.custom` options the tool passed, its overlay options resolved (Section 3). */
  customOptions(): Record<string, unknown>;
  panel(): AskQuestionPanel;
  lines(width?: number): string[];
  /** The panel's height at the current terminal rows (Section 3.1). */
  height(): number;
  press(data: string): void;
}

export interface DialogRecord {
  method: "select" | "input";
  title: string;
  options: string[];
  placeholder: string | undefined;
  /** The option keys of the dialog options, so a timeout can be ruled out (Section 4). */
  optionKeys: string[];
  signal: AbortSignal | undefined;
}

export interface DialogHarness {
  runtime: AskUserRuntime;
  calls: DialogRecord[];
  result: Promise<AskToolResult>;
}

/** One scripted dialog answer: a value, `undefined` for a cancel, or `"hang"` until aborted. */
export type ScriptedAnswer = string | undefined | "hang";

/** A fake host UI surface; every method is a no-op unless a test replaces it. */
export interface FakeUiHandlers {
  custom?: (factory: unknown, options?: unknown) => Promise<unknown>;
  select?: (
    title: string,
    options: string[],
    opts?: { signal?: AbortSignal },
  ) => Promise<string | undefined>;
  input?: (
    title: string,
    placeholder?: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<string | undefined>;
  editor?: (...args: unknown[]) => Promise<string | undefined>;
}

export function fakeUi(handlers: FakeUiHandlers = {}): AskUi {
  return {
    custom: handlers.custom ?? (async (): Promise<unknown> => undefined),
    select: handlers.select ?? (async (): Promise<string | undefined> => undefined),
    input: handlers.input ?? (async (): Promise<string | undefined> => undefined),
    editor: handlers.editor ?? (async (): Promise<string | undefined> => undefined),
  } as unknown as AskUi;
}

function hang(signal: AbortSignal | undefined): Promise<undefined> {
  if (signal === undefined) return Promise.resolve(undefined);
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<undefined>((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

/** One `editor` dialog of the question form request, as the host received it. */
export interface FormRecord {
  /** Every argument the tool passed; Section 4.4 passes the title and the payload only. */
  args: unknown[];
  title: string;
  prefill: string;
}

export interface FormHarness {
  runtime: AskUserRuntime;
  calls: FormRecord[];
  /** The `select` dialogs the dismissal choice showed, by title and options. */
  selects: { title: string; options: string[] }[];
  result: Promise<AskToolResult>;
}

/** A runtime plus the fake UI surfaces its calls run against. */
export interface QuestionWorld {
  runtime: AskUserRuntime;
  /** The editor each panel received, in creation order. */
  editors: FakeEditor[];
  tui: FakeTui;
  /** Starts one call in terminal mode; the panel is created synchronously. */
  startPanel(input: {
    params: unknown;
    sessionId?: string;
    signal?: AbortSignal;
    hasUI?: boolean;
  }): PanelHarness;
  /** Starts one call in RPC mode, answering the dialogs from `script`. */
  startDialogs(input: {
    params: unknown;
    script: ScriptedAnswer[];
    sessionId?: string;
    signal?: AbortSignal;
    hasUI?: boolean;
  }): DialogHarness;
  /**
   * Starts one call in RPC mode with the question form request (Section 4.4): `respond` gives
   * the text of each `editor` dialog in turn, `choose` the answer of each dismissal `select`.
   */
  startForm(input: {
    params: unknown;
    respond: (index: number) => Promise<string | undefined>;
    choose?: (title: string, options: string[]) => Promise<string | undefined>;
    toolCallId?: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): FormHarness;
}

/**
 * A question runtime whose panels get a recorder instead of the host's editor component, so
 * text entry of Section 3.4 is driven without a terminal. The environment is empty unless the
 * test names one (Section 2: `PI_DENT_ASK_FORM`).
 */
export function questionWorld(
  options: {
    rows?: number;
    columns?: number;
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): QuestionWorld {
  const editors: FakeEditor[] = [];
  const tui = fakeTui(options.rows ?? 24, options.columns ?? 80);
  const runtime = askUserRuntime({
    editor: () => {
      const editor = new FakeEditor();
      editors.push(editor);
      return editor;
    },
    env: options.env ?? {},
  });

  function startPanel(input: {
    params: unknown;
    sessionId?: string;
    signal?: AbortSignal;
    hasUI?: boolean;
  }): PanelHarness {
    let panel: AskQuestionPanel | undefined;
    let passedOptions: Record<string, unknown> = {};
    const ui = {
      custom: (factory: unknown, passed?: Record<string, unknown>): Promise<unknown> => {
        passedOptions = passed ?? {};
        return new Promise<unknown>((resolve) => {
          const create = factory as PanelFactory;
          panel = create(
            tui as unknown as TUI,
            plainTheme as unknown as Theme,
            {} as unknown as KeybindingsManager,
            resolve,
          );
        });
      },
      select: async (): Promise<string | undefined> => undefined,
      input: async (): Promise<string | undefined> => undefined,
    } as unknown as AskUi;
    const result = runtime.execute({
      sessionId: input.sessionId ?? "question-session",
      toolCallId: "call-panel",
      params: input.params,
      signal: input.signal,
      ui,
      mode: "tui",
      hasUI: input.hasUI ?? true,
    });
    const editor = editors[editors.length - 1] ?? new FakeEditor();
    return {
      runtime,
      tui,
      get editor(): FakeEditor {
        return editors[editors.length - 1] ?? editor;
      },
      result,
      customOptions: () => {
        const resolved: Record<string, unknown> = { ...passedOptions };
        const overlayOptions = passedOptions.overlayOptions;
        if (typeof overlayOptions === "function") {
          resolved.overlayOptions = (overlayOptions as () => unknown)();
        }
        return resolved;
      },
      panel: () => must(panel),
      lines: (width?: number) => must(panel).render(width ?? panelWidth(tui.terminal.columns)),
      height: () => must(panel).height(),
      press: (data) => must(panel).handleInput(data),
    };
  }

  function startDialogs(input: {
    params: unknown;
    script: ScriptedAnswer[];
    sessionId?: string;
    signal?: AbortSignal;
    hasUI?: boolean;
  }): DialogHarness {
    const calls: DialogRecord[] = [];
    const script = [...input.script];
    const ui = {
      custom: async (): Promise<undefined> => undefined,
      select: async (
        title: string,
        choices: string[],
        opts?: { signal?: AbortSignal; timeout?: number },
      ): Promise<string | undefined> => {
        calls.push({
          method: "select",
          title,
          options: [...choices],
          placeholder: undefined,
          optionKeys: Object.keys(opts ?? {}),
          signal: opts?.signal,
        });
        const answer = script.shift();
        if (answer === "hang") return hang(opts?.signal);
        return answer;
      },
      input: async (
        title: string,
        placeholder?: string,
        opts?: { signal?: AbortSignal; timeout?: number },
      ): Promise<string | undefined> => {
        calls.push({
          method: "input",
          title,
          options: [],
          placeholder,
          optionKeys: Object.keys(opts ?? {}),
          signal: opts?.signal,
        });
        const answer = script.shift();
        if (answer === "hang") return hang(opts?.signal);
        return answer;
      },
    } as unknown as AskUi;
    const result = runtime.execute({
      sessionId: input.sessionId ?? "question-session",
      toolCallId: "call-dialogs",
      params: input.params,
      signal: input.signal,
      ui,
      mode: "rpc",
      hasUI: input.hasUI ?? true,
    });
    return { runtime, calls, result };
  }

  function startForm(input: {
    params: unknown;
    respond: (index: number) => Promise<string | undefined>;
    choose?: (title: string, options: string[]) => Promise<string | undefined>;
    toolCallId?: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): FormHarness {
    const calls: FormRecord[] = [];
    const selects: { title: string; options: string[] }[] = [];
    const ui = {
      custom: async (): Promise<undefined> => undefined,
      select: async (title: string, choices: string[]): Promise<string | undefined> => {
        selects.push({ title, options: [...choices] });
        return input.choose?.(title, [...choices]);
      },
      input: async (): Promise<string | undefined> => undefined,
      editor: async (...args: unknown[]): Promise<string | undefined> => {
        const [title, prefill] = args;
        calls.push({
          args,
          title: typeof title === "string" ? title : "",
          prefill: typeof prefill === "string" ? prefill : "",
        });
        return input.respond(calls.length - 1);
      },
    } as unknown as AskUi;
    const result = runtime.execute({
      sessionId: input.sessionId ?? "question-session",
      toolCallId: input.toolCallId ?? "call-form",
      params: input.params,
      signal: input.signal,
      ui,
      mode: "rpc",
      hasUI: true,
    });
    return { runtime, calls, selects, result };
  }

  return { runtime, editors, tui, startPanel, startDialogs, startForm };
}

/** The panel's content lines inside the border, without terminal sequences (Section 3.1). */
export function panelContent(lines: readonly string[]): string[] {
  return lines.slice(1, -1).map((line) => stripTerminalSequences(line.slice(1, -1)).trimEnd());
}

/** A question of a call, as Section 1.2 leaves it. */
export function question(
  header: string,
  text: string,
  options: [label: string, description: string][],
  multiSelect = false,
): AskQuestion {
  return {
    header,
    question: text,
    options: options.map(([label, description]) => ({ label, description })),
    multiSelect,
  };
}

/** The `questions` parameter of a call. */
export function params(
  questions: {
    header: string;
    question: string;
    options: { label: string; description: string }[];
    multiSelect?: boolean;
  }[],
): unknown {
  return { questions };
}
