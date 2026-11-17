import { Text } from "@earendil-works/pi-tui";

/** The guidance message renderer (specs/model-guidance.md Section 5). */

export interface GuidanceTheme {
  fg(color: "customMessageLabel" | "muted", text: string): string;
  bold(text: string): string;
}

export interface GuidanceRenderOptions {
  expanded: boolean;
  outputPad: number;
  keyHint(keybinding: "app.tools.expand", description: string): string;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null && "type" in part && part.type === "text") {
      if ("text" in part && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

/** The collapsed line; `undefined` when expanded, so the host renders the message itself. */
export function renderGuidanceMessage(
  message: { customType: string; content: unknown },
  options: GuidanceRenderOptions,
  theme: GuidanceTheme,
): Text | undefined {
  if (options.expanded) return undefined;
  const count = messageText(message.content).split("\n").length;
  const line = [
    theme.fg("customMessageLabel", theme.bold(`[${message.customType}]`)),
    theme.fg("muted", ` ${count} lines (`),
    options.keyHint("app.tools.expand", "to expand"),
    theme.fg("muted", ")"),
  ].join("");
  return new Text(line, options.outputPad, 0);
}
