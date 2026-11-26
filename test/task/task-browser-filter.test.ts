import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskRegistry } from "../../lib/registry.ts";
import type { TaskRow } from "../../lib/task-row.ts";
import {
  identityTheme,
  listEntries,
  renderDetails,
  TaskBrowserState,
  type BrowserTheme,
  type TaskBrowserOptions,
} from "../../lib/task-browser.ts";
import { at } from "../support/must.ts";

/** Task browser list filter and `usage` line per specs/task-browser.md#list-page and specs/task-browser.md#agent-details. */

const reg = () => new TaskRegistry(() => undefined);
const addAgent = (r: TaskRegistry, label: string, background = true) =>
  r.register({ kind: "agent", cohort: "c", label, background });
const addScript = (r: TaskRegistry, label: string) =>
  r.register({ kind: "script", cohort: "c", label, background: false });

const stamp = (row: TaskRow, startedAt: number, settledAt?: number): TaskRow =>
  Object.assign(row, settledAt === undefined ? { startedAt } : { startedAt, settledAt });

const dateTime = (ms: number): string => {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
};

/** Selection background becomes a visible marker. */
const marker: BrowserTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => `«${text}»`,
};

const LIST_HINT = "↑↓ select · g/G top/bottom · f running/all · enter details · esc close";

const browser = (options: Partial<TaskBrowserOptions> & { registry: TaskRegistry }) =>
  new TaskBrowserState({
    zone: "UTC",
    now: () => 0,
    height: () => 10,
    theme: identityTheme,
    ...options,
  });

test("filter: a browser opens on all and f switches the content and the title", () => {
  const root = reg();
  const a = addAgent(root, "a");
  const b = addScript(root, "b");
  const c = addAgent(root, "c");
  stamp(a, 0);
  stamp(b, 0);
  stamp(c, 0);
  root.settle(b, { status: "completed" });
  const state = browser({ registry: root, theme: marker });

  let page = state.render(80);
  assert.equal(page[0], "Tasks · 2 running · 3 total");
  assert.equal(at(page, 9), LIST_HINT);
  assert.ok(
    page.some((text) => text.includes(b.taskId)),
    "all shows the settled row",
  );

  state.handleKey("f");
  page = state.render(80);
  assert.equal(page[0], "Tasks · 2 running · 3 total · running only");
  assert.ok(!page.some((text) => text.includes(b.taskId)), "running drops the settled row");
  assert.ok(page.join("\n").includes(a.taskId) && page.join("\n").includes(c.taskId));

  state.handleKey("f");
  page = state.render(80);
  assert.equal(page[0], "Tasks · 2 running · 3 total");
  assert.ok(page.some((text) => text.includes(b.taskId)));
});

test("filter: an empty running content is the single line (no running tasks)", () => {
  const root = reg();
  const a = addScript(root, "a");
  stamp(a, 0);
  root.settle(a, { status: "completed" });
  const state = browser({ registry: root, height: () => 5, theme: marker });

  const all = state.render(80);
  assert.equal(all[0], "Tasks · 0 running · 1 total");
  assert.ok(at(all, 1).includes(a.taskId));

  state.handleKey("f");
  const runningOnly = state.render(80);
  assert.equal(runningOnly[0], "Tasks · 0 running · 1 total · running only");
  assert.equal(runningOnly[1], "(no running tasks)");
  assert.ok(!runningOnly.join("\n").includes(a.taskId));
  assert.equal(at(runningOnly, 4), LIST_HINT);
});

test("filter: a later sibling counts only when it is in the running content", () => {
  const root = reg();
  const parent = addAgent(root, "p");
  stamp(parent, 0);
  const children = reg();
  root.attach(parent, children);
  const kept = addAgent(children, "kept");
  const gone = addScript(children, "gone");
  stamp(kept, 0);
  stamp(gone, 0);
  children.settle(gone, { status: "completed" });

  assert.deepEqual(
    listEntries(root).map((entry) => entry.prefix),
    ["", "├─ ", "└─ "],
    "under all the settled later sibling takes the last-child prefix",
  );
  assert.deepEqual(
    listEntries(root, "running").map((entry) => entry.prefix),
    ["", "└─ "],
    "under running the dropped sibling no longer counts, so the kept one is last",
  );

  const state = browser({ registry: root, theme: marker });
  assert.ok(state.render(80).some((text) => text.includes("├─ ")));
  state.handleKey("f");
  const page = state.render(80);
  assert.ok(page.some((text) => text.includes("└─ ")));
  assert.ok(!page.some((text) => text.includes("├─ ")));
});

test("filter: the selection follows its taskId across a switch", () => {
  const root = reg();
  const a = addAgent(root, "a");
  const b = addAgent(root, "b");
  const c = addScript(root, "c");
  for (const row of [a, b, c]) stamp(row, 0);
  const state = browser({ registry: root, theme: marker });
  state.render(80);

  state.handleKey("g");
  let page = state.render(80);
  assert.ok(at(page, 1).startsWith("«") && at(page, 1).includes(a.taskId));

  state.handleKey("f");
  page = state.render(80);
  assert.ok(at(page, 1).startsWith("«") && at(page, 1).includes(a.taskId), "still selected");

  state.handleKey("f");
  page = state.render(80);
  assert.ok(at(page, 1).startsWith("«") && at(page, 1).includes(a.taskId));
});

test("filter: a selected row that leaves running hands over to the row now at its index", () => {
  const root = reg();
  const a = addAgent(root, "a");
  const b = addScript(root, "b");
  const c = addAgent(root, "c");
  const d = addAgent(root, "d");
  for (const row of [a, b, c, d]) stamp(row, 0);
  root.settle(b, { status: "completed" });
  const state = browser({ registry: root, theme: marker });
  state.render(80);

  // The list opens on the last row; two steps up is index 1, the settled row, not the last.
  state.handleKey("k");
  state.handleKey("k");
  let page = state.render(80);
  assert.ok(at(page, 2).startsWith("«") && at(page, 2).includes(b.taskId));

  state.handleKey("f");
  page = state.render(80);
  assert.ok(at(page, 2).startsWith("«") && at(page, 2).includes(c.taskId), "the row at index 1");
});

test("filter: it survives a details visit and a newly opened browser is all again", () => {
  const root = reg();
  const a = addAgent(root, "a");
  const b = addScript(root, "b");
  stamp(a, 0);
  stamp(b, 0);
  root.settle(b, { status: "completed" });
  const state = browser({ registry: root, theme: marker });
  state.render(80);

  state.handleKey("f");
  state.handleKey("\r");
  assert.match(at(state.render(80), 0), /^Task .* · agent · running · \d+s$/);
  state.handleKey("\x1b");
  assert.equal(state.render(80)[0], "Tasks · 1 running · 2 total · running only");

  const fresh = browser({ registry: root, theme: marker });
  assert.equal(fresh.render(80)[0], "Tasks · 1 running · 2 total");
});

test("usage: the Agent section shows the usage line after settled, and omits it when absent", () => {
  const root = reg();
  const row = addAgent(root, "spent");
  stamp(row, 0, 8_000);
  root.amend(row, {
    sessionPath: "/tmp/s.jsonl",
    usage: {
      input: 182_000,
      output: 9_600,
      cacheRead: 1_200_000,
      cacheWrite: 88_000,
      cost: 0.214,
      turns: 41,
    },
  });
  Object.assign(row, { status: "completed" });

  const page = renderDetails({ row, now: 0, width: 80, height: 30, theme: identityTheme });
  const body = page.join("\n");
  assert.ok(
    body.includes(
      `settled: ${dateTime(8_000)}\nusage: 41 turns · ↑182k ↓9.6k R1.2M W88k · $0.214\nsession: /tmp/s.jsonl`,
    ),
    body,
  );

  const bare = addAgent(root, "bare");
  const barePage = renderDetails({
    row: bare,
    now: 0,
    width: 80,
    height: 30,
    theme: identityTheme,
  });
  assert.ok(!barePage.join("\n").includes("\nusage: "));
});

test("usage: the details page of a running row shows the usage gathered so far", () => {
  const root = reg();
  const row = addAgent(root, "live");
  stamp(row, 0);
  root.amend(row, {
    usage: { input: 999, output: 1_500, cacheRead: 0, cacheWrite: 0, cost: 0.042, turns: 1 },
  });
  const state = browser({ registry: root, theme: marker });
  state.render(80);
  state.handleKey("\r");
  assert.ok(state.render(80).includes("usage: 1 turn · ↑999 ↓1.5k · $0.042"));
});
