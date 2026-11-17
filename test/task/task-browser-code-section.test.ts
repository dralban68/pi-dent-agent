import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TaskRegistry } from "../../lib/registry.ts";
import { identityTheme, renderDetails, TaskBrowserState } from "../../lib/task-browser.ts";

/** The `Code` section of a `script` details page (task-browser.md Section 4.2). */

const reg = () => new TaskRegistry(() => undefined);
const addScript = (r: TaskRegistry, code: string) =>
  r.register({ kind: "script", cohort: "c", label: "demo", background: true, code });
const addBash = (r: TaskRegistry, command: string) =>
  r.register({ kind: "bash", cohort: "c", label: "sh", background: true, command });

/** The body lines of the `Code` section: after its heading, before the blank line that precedes the next heading. */
function codeLinesOf(page: string[]): string[] {
  const start = page.indexOf("Code");
  const end = page.indexOf("Output");
  assert.ok(start >= 0 && end > start, "the page has a Code and an Output section");
  return page.slice(start + 1, end - 1);
}

test("code section: every line of multi-line code is shown, a tab as 2 spaces", () => {
  const root = reg();
  const row = addScript(root, "const a = 1;\n\nif (a) {\n\treturn a;\n}");
  const page = renderDetails({ row, now: 0, width: 80, height: 30, theme: identityTheme });
  assert.deepEqual(codeLinesOf(page), ["const a = 1;", "", "if (a) {", "  return a;", "}"]);
});

test("code section: an over-width line is wrapped to the render width and no word is lost", () => {
  const root = reg();
  const words = Array.from({ length: 40 }, (_, index) => `word${index}`);
  const row = addScript(root, `const x = a ${words.join(" ")} b\nshort`);
  const page = renderDetails({ row, now: 0, width: 30, height: 80, theme: identityTheme });
  const section = codeLinesOf(page);
  assert.ok(section.length > 2, "the long line takes several lines");
  for (const line of section) assert.ok(visibleWidth(line) <= 30, `"${line}" fits 30 columns`);
  assert.deepEqual(
    section
      .join(" ")
      .split(/\s+/)
      .filter((word) => word !== ""),
    ["const", "x", "=", "a", ...words, "b", "short"],
  );
});

test("code section: a long script is never capped; all of its lines are shown", () => {
  const root = reg();
  const lines = Array.from({ length: 300 }, (_, index) => `console.log(${index});`);
  const row = addScript(root, lines.join("\n"));
  const page = renderDetails({ row, now: 0, width: 40, height: 400, theme: identityTheme });
  assert.deepEqual(codeLinesOf(page), lines);
});

test("code section: lines are highlighted through the provided highlighter", () => {
  const root = reg();
  const row = addScript(root, "const a = 1;\nrun(a);");
  const page = renderDetails({
    row,
    now: 0,
    width: 80,
    height: 30,
    theme: identityTheme,
    highlightCode: (code) => code.split("\n").map((line) => `<hl>${line}</hl>`),
  });
  assert.deepEqual(codeLinesOf(page), ["<hl>const a = 1;</hl>", "<hl>run(a);</hl>"]);
});

test("code section: without a highlighter the lines are plain", () => {
  const root = reg();
  const row = addScript(root, "const a = 1;");
  const page = renderDetails({ row, now: 0, width: 80, height: 30, theme: identityTheme });
  assert.deepEqual(codeLinesOf(page), ["const a = 1;"]);
});

test("code section: a bash row keeps Command and has no Code section", () => {
  const root = reg();
  const row = addBash(root, "echo hi");
  const page = renderDetails({ row, now: 0, width: 80, height: 30, theme: identityTheme });
  assert.ok(page.includes("Command"), "the Command section is present");
  assert.ok(!page.includes("Code"), "no Code section");
});

test("code section: the state page highlights a script row's code", () => {
  const root = reg();
  addScript(root, "const a = 1;");
  const state = new TaskBrowserState({
    registry: root,
    zone: "UTC",
    now: () => 0,
    height: () => 12,
    theme: identityTheme,
    highlightCode: (code) => code.split("\n").map((line) => `<hl>${line}</hl>`),
  });
  state.render(80);
  state.handleKey("\r");
  const page = state.render(80);
  assert.ok(
    page.some((line) => line.includes("<hl>const a = 1;</hl>")),
    "highlighted line is shown",
  );
});
