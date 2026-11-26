import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TaskRegistry } from "../../lib/registry.ts";
import {
  identityTheme,
  renderDetails,
  TaskBrowserState,
  type BrowserTheme,
} from "../../lib/task-browser.ts";

/** The `Task` section of an agent details page (specs/task-browser.md#common-rendering, specs/task-browser.md#agent-details). */

const reg = () => new TaskRegistry(() => undefined);
const addAgent = (r: TaskRegistry, label: string) =>
  r.register({ kind: "agent", cohort: "c", label, background: true });

const T = "2026-01-02T03:04:05.000Z";
const event = (text: string): string =>
  JSON.stringify({ type: "message", timestamp: T, message: { role: "user", content: text } });

/** Selection background becomes a visible marker. */
const marker: BrowserTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => `«${text}»`,
};

/** The body lines of the `Task` section: after its heading, before the blank line that precedes `Events`. */
function taskSection(page: string[]): string[] {
  const start = page.indexOf("Task");
  const end = page.indexOf("Events");
  assert.ok(start >= 0 && end > start, "the page has a Task and an Events section");
  return page.slice(start + 1, end - 1);
}

test("task text: every line of a multi-line task is shown, a tab as 2 spaces", () => {
  const root = reg();
  const row = addAgent(root, "multi");
  row.task = "first line\n\nsecond line\n  indented\tline";
  const page = renderDetails({
    row,
    now: 0,
    width: 80,
    height: 30,
    theme: identityTheme,
  });
  assert.deepEqual(taskSection(page), ["first line", "", "second line", "  indented  line"]);
});

test("task text: an over-width line is wrapped to the render width and no word is lost", () => {
  const root = reg();
  const row = addAgent(root, "wide");
  const words = Array.from({ length: 40 }, (_, index) => `word${index}`);
  row.task = `${words.join(" ")}\nshort`;
  const page = renderDetails({
    row,
    now: 0,
    width: 30,
    height: 80,
    theme: identityTheme,
  });
  const section = taskSection(page);
  assert.ok(section.length > 2, "the long line takes several lines");
  for (const line of section) assert.ok(visibleWidth(line) <= 30, `"${line}" fits 30 columns`);
  assert.deepEqual(
    section
      .join(" ")
      .split(/\s+/)
      .filter((word) => word !== ""),
    [...words, "short"],
  );
  assert.equal(section.at(-1), "short");
});

test("task text: a long task is never capped; all of its lines are shown", () => {
  const root = reg();
  const row = addAgent(root, "long");
  const lines = Array.from({ length: 300 }, (_, index) => `task row ${index}`);
  row.task = lines.join("\n");
  const page = renderDetails({
    row,
    now: 0,
    width: 40,
    height: 400,
    theme: identityTheme,
  });
  assert.deepEqual(taskSection(page), lines);
  assert.ok(!page.some((line) => line.includes("more lines")), "no cut-off marker");
});

test("task text: selection, paging and scroll-into-view of events work below a long task", () => {
  const root = reg();
  const row = addAgent(root, "tall");
  root.amend(row, { sessionPath: "/tmp/s.jsonl" });
  row.task = Array.from(
    { length: 40 },
    (_, index) => `task line ${index} with some extra words to wrap`,
  ).join("\n");
  const text = `${[event("one"), event("two"), event("three")].join("\n")}\n`;
  const state = new TaskBrowserState({
    registry: root,
    zone: "UTC",
    now: () => 0,
    height: () => 12,
    theme: marker,
    readSession: () => text,
  });
  const selected = (page: string[]): string[] => page.filter((line) => line.startsWith("«"));

  state.render(40);
  state.handleKey("\r");
  let page = state.render(40);
  assert.equal(selected(page).length, 1);
  assert.ok(selected(page)[0]?.endsWith("user · three»"), "the last event is selected and shown");

  state.handleKey("\x1b[H");
  page = state.render(40);
  assert.equal(page[1], "Agent", "home scrolls to the first body line");

  // Body height 10 lines; the three events sit about 80 lines down, one line apart.
  state.handleKey("\x1b[6~");
  page = state.render(40);
  assert.ok(selected(page)[0]?.endsWith("user · three»"), "pageDown selects the last event");
  assert.equal(selected(page).length, 1, "the selected event's line is in view");

  state.handleKey("\x1b[5~");
  page = state.render(40);
  assert.ok(selected(page)[0]?.endsWith("user · one»"), "pageUp selects the first event");
  assert.equal(selected(page).length, 1, "the selected event's line is in view");
});
