import assert from "node:assert/strict";
import { test } from "node:test";
import { renderGuidanceMessage, type GuidanceTheme } from "../../lib/guidance-render.ts";
import { must } from "../support/must.ts";

const theme: GuidanceTheme = {
  fg: (color, text) => `<${color}>${text}`,
  bold: (text) => `*${text}*`,
};
const options = (expanded: boolean) => ({
  expanded,
  outputPad: 0,
  keyHint: (_key: "app.tools.expand", description: string) => `ctrl+o ${description}`,
});
const message = { customType: "pi-dent-model-guidance", content: "Model billing:\n- a: x\n\nrule" };

test("collapsed: one line with the label, the line count and the expand hint", () => {
  const rendered = must(renderGuidanceMessage(message, options(false), theme)).render(200);
  assert.equal(rendered.length, 1);
  assert.equal(
    rendered[0]?.trimEnd(),
    "<customMessageLabel>*[pi-dent-model-guidance]*<muted> 4 lines (ctrl+o to expand<muted>)",
  );
});

test("collapsed: text content parts are counted together", () => {
  const parts = {
    ...message,
    content: [
      { type: "text", text: "a\nb" },
      { type: "text", text: "c" },
    ],
  };
  const rendered = must(renderGuidanceMessage(parts, options(false), theme)).render(200);
  assert.match(rendered[0] ?? "", / 3 lines \(/);
});

test("expanded: no component, so the host renders the message", () => {
  assert.equal(renderGuidanceMessage(message, options(true), theme), undefined);
});
