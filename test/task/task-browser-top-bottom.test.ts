import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TaskRegistry } from "../../lib/registry.ts";
import { TaskBrowserState, type BrowserTheme } from "../../lib/task-browser.ts";
import { at } from "../support/must.ts";

/** `g` and `G` on every page that gives `home` and `end` a behaviour (specs/browser-navigation.md#home-end-keys). */

const HOME = "\x1b[H";
const END = "\x1b[F";
const KILL = "\x0b";

const reg = () => new TaskRegistry(() => undefined);
const addAgent = (r: TaskRegistry, label: string) =>
  r.register({ kind: "agent", cohort: "c", label, background: true });
const addScript = (r: TaskRegistry, label: string) =>
  r.register({ kind: "script", cohort: "c", label, background: false });
const addBash = (r: TaskRegistry, label: string) =>
  r.register({ kind: "bash", cohort: "c", label, background: false, command: label });

const T = "2026-01-02T03:04:05.000Z";
const event = (text: string): string =>
  JSON.stringify({ type: "message", timestamp: T, message: { role: "user", content: text } });

/** Selection background becomes a visible marker. */
const marker: BrowserTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => `«${text}»`,
};

const browser = (registry: TaskRegistry, height: number, text?: string): TaskBrowserState =>
  new TaskBrowserState({
    registry,
    zone: "UTC",
    now: () => 0,
    height: () => height,
    theme: marker,
    readSession: () => text,
  });

/** A details page is opened from the list page with `enter`. */
const open = (state: TaskBrowserState): TaskBrowserState => {
  state.render(80);
  state.handleKey("\r");
  return state;
};

const tall = Array.from({ length: 40 }, (_, index) => `task line ${index}`).join("\n");

/**
 * Two states built alike: one driven by `home` and `end`, one by `g` and `G`. Their renders MUST be
 * the same after every step, top and bottom alternating.
 */
function assertSameAsHomeEnd(build: () => TaskBrowserState): void {
  const viaHome = build();
  const viaLetters = build();
  assert.deepEqual(viaLetters.render(80), viaHome.render(80));
  const steps: [string, string][] = [
    [HOME, "g"],
    [END, "G"],
    [HOME, "g"],
    [END, "G"],
  ];
  for (const [home, letter] of steps) {
    viaHome.handleKey(home);
    viaLetters.handleKey(letter);
    assert.deepEqual(
      viaLetters.render(80),
      viaHome.render(80),
      `${letter} acts as ${home === HOME ? "home" : "end"}`,
    );
  }
}

test("g and G on the list page select the first and the last row", () => {
  const root = reg();
  const a = addAgent(root, "a");
  addAgent(root, "b");
  const c = addAgent(root, "c");
  const build = () => browser(root, 6);
  assertSameAsHomeEnd(build);

  const state = build();
  state.render(80);
  state.handleKey("g");
  assert.ok(at(state.render(80), 1).includes(a.taskId), "g selects the first row");
  state.handleKey("G");
  assert.ok(at(state.render(80), 3).includes(c.taskId), "G selects the last row");
});

test("g and G on the agent details page with session events", () => {
  const root = reg();
  const row = addAgent(root, "events");
  root.amend(row, { sessionPath: "/tmp/s.jsonl" });
  row.task = tall;
  const text = `${[event("one"), event("two"), event("three")].join("\n")}\n`;
  const build = () => open(browser(root, 12, text));
  assertSameAsHomeEnd(build);

  const state = build();
  state.handleKey("g");
  let page = state.render(80);
  assert.equal(page[1], "Agent", "g scrolls the body to its first line");
  state.handleKey("G");
  page = state.render(80);
  assert.ok(
    page.some((line) => line.startsWith("«") && line.endsWith("user · three»")),
    "G selects the last event",
  );
});

test("g and G on the agent details page without session events", () => {
  const root = reg();
  const row = addAgent(root, "no events");
  row.task = tall;
  const build = () => open(browser(root, 8));
  assertSameAsHomeEnd(build);

  const state = build();
  state.handleKey("G");
  let page = state.render(80);
  assert.notEqual(page[1], "Agent", "G scrolls the body to the bottom");
  state.handleKey("g");
  page = state.render(80);
  assert.equal(page[1], "Agent", "g scrolls the body to its first line");
});

test("g and G on a script details page scroll its output to the top and the bottom", () => {
  const root = reg();
  const script = addScript(root, "s");
  for (let index = 0; index < 30; index++)
    script.progress.push({ at: index, line: `out ${index}` });
  const build = () => open(browser(root, 8));
  assertSameAsHomeEnd(build);

  const state = build();
  state.handleKey("g");
  assert.equal(at(state.render(80), 1), "Script", "g shows the top of the page");
  state.handleKey("G");
  assert.equal(state.render(80).at(-2), "out 29", "G shows the last output line");
});

test("g and G on a bash details page scroll like home and end", () => {
  const root = reg();
  const bash = addBash(root, "echo");
  for (let index = 0; index < 30; index++) bash.progress.push({ at: index, line: `out ${index}` });
  const build = () => open(browser(root, 8));
  assertSameAsHomeEnd(build);

  const state = build();
  state.handleKey("g");
  assert.equal(at(state.render(80), 1), "Bash", "g shows the top of the page");
  state.handleKey("G");
  assert.equal(state.render(80).at(-2), "out 29");
});

test("g disarms the kill key like any other key, and does not cancel the row", () => {
  const root = reg();
  const row = addAgent(root, "victim");
  let cancelled = 0;
  row.cancel = () => {
    cancelled++;
  };
  const state = open(browser(root, 8));
  state.handleKey(KILL);
  assert.ok(state.render(80).at(-1)?.includes("again to confirm kill"));
  state.handleKey("g");
  assert.equal(
    state.render(80).at(-1),
    "↑↓ select · g/G top/bottom · enter expand · e/c all · ctrl+k kill · esc back",
  );
  assert.equal(cancelled, 0);
});

test("every key-hint line of every page fits 80 columns", () => {
  const hints: [string, string][] = [];
  // A page with one row, opened from the list page: the row is the selected, last one.
  const pageHints = (label: string, makeRow: (root: TaskRegistry) => void, keys: string[]) => {
    const root = reg();
    makeRow(root);
    const state = open(browser(root, 8));
    for (const key of keys) state.handleKey(key);
    hints.push([label, state.render(80).at(-1) ?? ""]);
  };
  const killableAgent = (root: TaskRegistry): void => {
    root.amend(addAgent(root, "agent"), { sessionPath: "/tmp/s.jsonl" });
  };
  const settledAgent = (root: TaskRegistry): void => {
    root.settle(addAgent(root, "settled"), { status: "completed" });
  };
  const script = (root: TaskRegistry): void => {
    addScript(root, "script");
  };
  const bash = (root: TaskRegistry): void => {
    addBash(root, "bash");
  };

  const list = reg();
  killableAgent(list);
  script(list);
  hints.push(["list", browser(list, 8).render(80).at(-1) ?? ""]);
  pageHints("agent, kill", killableAgent, []);
  pageHints("agent, kill armed", killableAgent, [KILL]);
  pageHints("agent, no kill", settledAgent, []);
  pageHints("script, kill", script, []);
  pageHints("script, kill armed", script, [KILL]);
  pageHints("bash, kill", bash, []);
  pageHints("bash, kill armed", bash, [KILL]);

  assert.equal(hints.length, 8, "the list and seven details states");
  for (const [label, hint] of hints) {
    assert.ok(hint !== "", `${label} has a key-hint line`);
    assert.ok(visibleWidth(hint) <= 80, `${label} hint "${hint}" fits 80 columns`);
  }
});
