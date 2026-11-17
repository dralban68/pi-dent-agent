import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { isPlainObject } from "./util.ts";

export interface RecapTheme {
  fg(color: "customMessageLabel" | "customMessageText", text: string): string;
  bg(color: "customMessageBg", text: string): string;
  bold(text: string): string;
}

/** Custom entries are rendered without Markdown and never become model messages. */
export function renderRecapEntry(
  entry: { data?: unknown },
  _options: unknown,
  theme: RecapTheme,
): Box {
  const text =
    isPlainObject(entry.data) && typeof entry.data.text === "string"
      ? entry.data.text
      : "Recap unavailable: invalid entry data.";
  const body = text
    .split("\n")
    .map((line) => {
      const label = /^(Goal:|Done:|Open:|Next:)/.exec(line)?.[0];
      return theme.fg(
        "customMessageText",
        label ? theme.bold(label) + line.slice(label.length) : line,
      );
    })
    .join("\n");
  const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
  box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("Recap")), 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(new Text(body, 0, 0));
  return box;
}
