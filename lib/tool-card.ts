import { Text } from "@earendil-works/pi-tui";
import { cardText } from "./task-row.ts";
import { shortenSessionDir } from "./util.ts";

/** The tool card of a `Bash` or `Script` call (tool-card.md). */

const SOURCE_LINES = 5;
const RESULT_LINES = 10;

/** The slice of the host theme the card uses. */
export interface CardTheme {
  fg(color: "toolTitle" | "toolOutput" | "muted", text: string): string;
  bold(text: string): string;
}

/** The slice of the host render context the card uses. */
export interface CardContext {
  expanded: boolean;
  lastComponent?: unknown;
  keyHint(keybinding: "app.tools.expand", description: string): string;
}

export interface CardCall {
  tool: "Bash" | "Script";
  description: unknown;
  background: unknown;
  /** The source text of specs/tool-card.md#call-section; not a string while arguments stream. */
  source: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function lines(value: string): string[] {
  const trimmed = strippedText(value).trimEnd();
  return trimmed === "" ? [] : trimmed.split("\n");
}

/**
 * Card text per specs/tool-card.md#shell: ANSI escape sequences and control characters other than line feeds and
 * tabs removed, then the agent directory substituted (specs/agent-tool.md#child-session).
 */
function strippedText(value: string): string {
  return shortenSessionDir(cardText(value));
}

/** specs/tool-card.md#call-section: the title line, then the source lines. */
export function cardCallLines(
  call: CardCall,
  expanded: boolean,
): { title: string; source: string[] } {
  const firstLine = text(call.description).split("\n", 1)[0] ?? "";
  const description = strippedText(firstLine).trim();
  let title: string = call.tool;
  if (description !== "") title += ` ${description}`;
  if (call.background === true) title += " (background)";
  const all = lines(text(call.source));
  if (expanded || all.length <= SOURCE_LINES) return { title, source: all };
  return {
    title,
    source: [...all.slice(0, SOURCE_LINES), `... (${all.length - SOURCE_LINES} more lines)`],
  };
}

/** specs/tool-card.md#result-section: the count of hidden lines and the shown result lines. */
export function cardResultLines(
  result: { content: readonly { type: string; text?: string }[] },
  expanded: boolean,
): { hidden: number; shown: string[] } {
  const first = result.content[0];
  const all = lines(first?.type === "text" ? text(first.text) : "");
  if (expanded || all.length <= RESULT_LINES) return { hidden: 0, shown: all };
  return { hidden: all.length - RESULT_LINES, shown: all.slice(-RESULT_LINES) };
}

function reuse(last: unknown): Text {
  return last instanceof Text ? last : new Text("", 0, 0);
}

export function renderCardCall(call: CardCall, theme: CardTheme, context: CardContext): Text {
  const { title, source } = cardCallLines(call, context.expanded);
  const head = theme.fg("toolTitle", theme.bold(title));
  const component = reuse(context.lastComponent);
  component.setText([head, ...source.map((line) => theme.fg("toolOutput", line))].join("\n"));
  return component;
}

export function renderCardResult(
  result: { content: readonly { type: string; text?: string }[] },
  theme: CardTheme,
  context: CardContext,
): Text {
  const { hidden, shown } = cardResultLines(result, context.expanded);
  const component = reuse(context.lastComponent);
  if (shown.length === 0) {
    component.setText("");
    return component;
  }
  const out = [""];
  if (hidden > 0) {
    out.push(
      `${theme.fg("muted", `... (${hidden} earlier lines,`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
    );
  }
  out.push(...shown.map((line) => theme.fg("toolOutput", line)));
  component.setText(out.join("\n"));
  return component;
}
