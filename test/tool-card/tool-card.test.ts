import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardCallLines,
  cardResultLines,
  renderCardCall,
  renderCardResult,
  type CardContext,
  type CardTheme,
} from "../../lib/tool-card.ts";
import { makeBashTool } from "../../lib/bash-tool.ts";
import { makeScriptTool } from "../../lib/script-tool.ts";
import { must } from "../support/must.ts";

const theme: CardTheme = { fg: (_color, text) => text, bold: (text) => text };
/** Tags each colour and the bold emphasis, so that a paint can be read off the rendered line. */
const tagging: CardTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<bold>${text}</bold>`,
};
const context = (expanded: boolean): CardContext => ({
  expanded,
  keyHint: (_key, description) => `ctrl+o ${description}`,
});
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const textResult = (text: string) => ({ content: [{ type: "text", text }] });

test("title: tool, first description line, background marker", () => {
  const call = { tool: "Bash", description: " build\nall ", background: true, source: "$ make" };
  assert.deepEqual(cardCallLines({ ...call, tool: "Bash" }, false), {
    title: "Bash build (background)",
    source: ["$ make"],
  });
  assert.equal(
    cardCallLines({ tool: "Script", description: "  ", background: false, source: "1" }, false)
      .title,
    "Script",
  );
});

test("title: the description is its first line with surrounding white space removed", () => {
  assert.equal(
    cardCallLines(
      { tool: "Bash", description: "\nsecond", background: false, source: "$ x" },
      false,
    ).title,
    "Bash",
    "a description whose first line is blank is absent",
  );
  assert.equal(
    cardCallLines(
      { tool: "Bash", description: "first  \nsecond", background: false, source: "$ x" },
      false,
    ).title,
    "Bash first",
  );
});

test("Bash renderCall: a blank command still shows the `$` source line", () => {
  const tool = makeBashTool({} as never);
  const component = must(
    tool.renderCall?.({ command: "" }, theme as never, context(false) as never),
  );
  assert.deepEqual(
    component.render(40).map((line) => line.trimEnd()),
    ["Bash", "$"],
  );
});

test("source: collapsed shows 5 lines and a count, expanded shows all", () => {
  const call = { tool: "Script" as const, description: undefined, background: undefined };
  const five = cardCallLines({ ...call, source: `${numbered(5)}\n\n` }, false);
  assert.equal(five.source.length, 5);
  const seven = cardCallLines({ ...call, source: numbered(7) }, false);
  assert.deepEqual(seven.source.slice(4), ["line 5", "... (2 more lines)"]);
  assert.equal(cardCallLines({ ...call, source: numbered(7) }, true).source.length, 7);
});

test("streaming arguments: non-string values are empty, nothing throws", () => {
  const lines = cardCallLines(
    { tool: "Bash", description: 3, background: "x", source: undefined },
    false,
  );
  assert.deepEqual(lines, { title: "Bash", source: [] });
});

test("result: collapsed shows the last 10 lines, expanded all, empty none", () => {
  assert.deepEqual(cardResultLines(textResult(" \n"), false), { hidden: 0, shown: [] });
  assert.deepEqual(cardResultLines({ content: [] }, false), { hidden: 0, shown: [] });
  assert.equal(cardResultLines(textResult(numbered(10)), false).hidden, 0);
  const collapsed = cardResultLines(textResult(`${numbered(13)}\n`), false);
  assert.equal(collapsed.hidden, 3);
  assert.deepEqual([collapsed.shown[0], collapsed.shown.at(-1)], ["line 4", "line 13"]);
  assert.equal(cardResultLines(textResult(numbered(13)), true).shown.length, 13);
});

test("the agent directory is shown as $PI_DENT_SESSION_DIR", () => {
  const before = process.env.PI_DENT_SESSION_DIR;
  process.env.PI_DENT_SESSION_DIR = "/tmp/agents-x";
  try {
    assert.deepEqual(cardResultLines(textResult("Output: /tmp/agents-x/output/a"), false).shown, [
      "Output: $PI_DENT_SESSION_DIR/output/a",
    ]);
    assert.deepEqual(
      cardCallLines(
        { tool: "Bash", description: "", background: false, source: "$ ls /tmp/agents-x" },
        false,
      ).source,
      ["$ ls $PI_DENT_SESSION_DIR"],
    );
  } finally {
    if (before === undefined) delete process.env.PI_DENT_SESSION_DIR;
    else process.env.PI_DENT_SESSION_DIR = before;
  }
});

test("rendered components: no padding, hint line, blank separator, reuse", () => {
  const call = renderCardCall(
    { tool: "Bash", description: "list", background: false, source: "$ ls" },
    theme,
    context(false),
  );
  assert.deepEqual(
    call.render(40).map((line) => line.trimEnd()),
    ["Bash list", "$ ls"],
  );
  const result = renderCardResult(textResult(numbered(12)), theme, context(false));
  const rendered = result.render(60).map((line) => line.trimEnd());
  assert.deepEqual(rendered.slice(0, 3), ["", "... (2 earlier lines, ctrl+o to expand)", "line 3"]);
  assert.equal(rendered.length, 12);
  const again = renderCardResult(textResult(""), theme, {
    ...context(false),
    lastComponent: result,
  });
  assert.equal(again, result);
  assert.deepEqual(again.render(60), []);
});

test("Bash and Script register with the host's default shell", () => {
  for (const tool of [makeBashTool({} as never), makeScriptTool({} as never)]) {
    assert.equal("renderShell" in tool, false);
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
  }
});

test("terminal escape sequences and control characters other than line feeds and tabs are removed", () => {
  const call = (description: string, source: string) =>
    renderCardCall({ tool: "Bash", description, background: false, source }, theme, context(false))
      .render(80)
      .map((line) => line.trimEnd());

  assert.deepEqual(call("d\x1b]0;pwned\x07", "$ ls"), ["Bash d", "$ ls"], "the title");
  assert.deepEqual(
    cardCallLines(
      {
        tool: "Bash",
        description: "list",
        background: false,
        source: "$ printf '\x1b[2J'\n\tindent\r",
      },
      false,
    ).source,
    ["$ printf ''", "\tindent"],
    "the source keeps its tab and loses its carriage return",
  );
  assert.deepEqual(
    cardResultLines(textResult("ok\x1b]52;c;ZXZpbA==\x07\x1b[2J\rX\nsecond\tline"), false).shown,
    ["okX", "second\tline"],
    "the result text keeps its tab and loses its carriage return",
  );
});

test("colours and emphasis: the title is toolTitle bold, source and result lines toolOutput", () => {
  const call = renderCardCall(
    { tool: "Bash", description: "list", background: false, source: "$ ls" },
    tagging,
    context(false),
  );
  assert.deepEqual(
    call.render(200).map((line) => line.trimEnd()),
    ["<toolTitle><bold>Bash list</bold></toolTitle>", "<toolOutput>$ ls</toolOutput>"],
  );
  const result = renderCardResult(textResult(numbered(12)), tagging, context(false));
  const lines = result.render(200).map((line) => line.trimEnd());
  assert.deepEqual(lines.slice(0, 3), [
    "",
    "<muted>... (2 earlier lines,</muted> ctrl+o to expand<muted>)</muted>",
    "<toolOutput>line 3</toolOutput>",
  ]);
  assert.equal(lines.length, 12);
  assert.equal(lines.at(-1), "<toolOutput>line 12</toolOutput>");
});

test("Script renderCall: a plugin source is plugin:path, a blank plugin falls back to the code", () => {
  const tool = makeScriptTool({} as never);
  const source = (args: { plugin?: string; path?: string; code?: string }) =>
    must(tool.renderCall?.(args, theme as never, context(false) as never))
      .render(60)
      .map((line) => line.trimEnd());

  assert.deepEqual(source({ plugin: " demo ", path: " main.ts" }), ["Script", "demo:main.ts"]);
  assert.deepEqual(source({ plugin: "  ", path: "main.ts", code: "1 + 1" }), ["Script", "1 + 1"]);
});
