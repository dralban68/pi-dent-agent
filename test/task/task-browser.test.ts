import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { makeBashTool } from "../../lib/bash-tool.ts";
import type { HostSession } from "../../lib/host.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import type { TaskRow } from "../../lib/task-row.ts";
import {
  deriveSessionEvents,
  identityTheme,
  listEntries,
  renderDetails,
  renderList,
  renderListLine,
  TaskBrowserOverlay,
  TaskBrowserState,
  type BrowserTheme,
  type SessionEvent,
  type TaskBrowserOptions,
} from "../../lib/task-browser.ts";
import { at } from "../support/must.ts";

/** Task browser conformance per specs/task-browser.md. */

const reg = () => new TaskRegistry(() => undefined);
const addAgent = (r: TaskRegistry, label: string, background = true) =>
  r.register({ kind: "agent", cohort: "c", label, background });
const addScript = (r: TaskRegistry, label: string) =>
  r.register({ kind: "script", cohort: "c", label, background: false });
const addBash = (r: TaskRegistry, label: string, background = false) =>
  r.register({ kind: "bash", cohort: "c", label, background, command: label });

const stamp = (row: TaskRow, startedAt: number, settledAt?: number): TaskRow =>
  Object.assign(row, settledAt === undefined ? { startedAt } : { startedAt, settledAt });

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const dateTime = (ms: number): string => {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
};

/** Selection background becomes a visible marker. */
const marker: BrowserTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => `«${text}»`,
};

const T = "2026-01-02T03:04:05.000Z";
const line = (value: unknown): string => JSON.stringify(value);
const event = (role: string, content: unknown, extra: object = {}): string =>
  line({ type: "message", timestamp: T, message: { role, content, ...extra } });

const browser = (options: Partial<TaskBrowserOptions> & { registry: TaskRegistry }) =>
  new TaskBrowserState({
    zone: "UTC",
    now: () => 0,
    height: () => 10,
    theme: identityTheme,
    ...options,
  });

test("list page: title, (no tasks), padding, hint, and the exact row format", () => {
  const empty = renderList({
    entries: [],
    counts: { running: 0, total: 0 },
    now: 0,
    width: 80,
    height: 5,
    theme: identityTheme,
  });
  assert.deepEqual(empty, [
    "Tasks · 0 running · 0 total",
    "(no tasks)",
    "",
    "",
    "↑↓ select · g/G top/bottom · f running/all · enter details · esc close",
  ]);

  const root = reg();
  const a = addAgent(root, "first");
  stamp(a, 0);
  const ca = reg();
  root.attach(a, ca);
  const b = addScript(ca, "second");
  stamp(b, 65_000);
  Object.assign(a, { status: "failed", settledAt: 65_000 });
  const entries = listEntries(root);
  assert.deepEqual(
    entries.map((entry) => entry.prefix),
    ["", "└─ "],
  );
  assert.equal(
    renderListLine(at(entries, 0), 65_000),
    `${clock(0)} · 1m05s · ${a.taskId} · agent · bg · failed · first`,
  );
  assert.equal(
    renderListLine(at(entries, 1), 65_000),
    `└─ ${clock(65_000)} · 0s · ${b.taskId} · script · fg · running · second`,
  );

  const page = renderList({
    entries,
    counts: { running: 1, total: 2 },
    selected: 1,
    now: 0,
    width: 80,
    height: 5,
    theme: marker,
  });
  assert.equal(page[0], "Tasks · 1 running · 2 total");
  assert.ok(at(page, 2).startsWith("«└─ "));
  assert.ok(at(page, 2).includes(b.taskId));
  assert.equal(page.length, 5);
});

test("common rendering: times follow the browser's zone, not the process zone", () => {
  const root = reg();
  const row = addAgent(root, "zoned");
  stamp(row, Date.parse("2026-11-12T07:47:38Z"));
  const kolkata = browser({ registry: root, zone: "Asia/Kolkata" });
  assert.ok(kolkata.render(80).some((text) => text.includes("13:17:38")));
  kolkata.handleKey("\r");
  const details = kolkata.render(80).join("\n");
  assert.ok(details.includes("started: 2026-11-12 13:17:38"), details);
  const utc = browser({ registry: root, zone: "UTC" });
  assert.ok(utc.render(80).some((text) => text.includes("07:47:38")));
});

test("list row: theme colors and stripped row values", () => {
  const theme: BrowserTheme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bg: (_color, text) => text,
  };
  const root = reg();
  const a = addAgent(root, "\x1b[31mred\x1b[0m \x1b]0;t\x07ok\tz\r\nsecond");
  stamp(a, 0);
  a.orphan = true;
  root.amend(a, { model: "m\x1b[31m1" });
  const out = renderListLine({ row: a, prefix: "" }, 0, theme);
  assert.equal(
    out,
    `<muted>${clock(0)}</muted> · <muted>0s</muted> · ${a.taskId} · agent · bg · <warning>orphan</warning> · <accent>running</accent> · m1 · red okz`,
  );
  root.settle(a, { status: "cancelled" });
  assert.match(renderListLine({ row: a, prefix: "" }, 0, theme), /<warning>cancelled<\/warning>/);
});

test("list row: an interrupted row paints warning and is not counted running", () => {
  const root = reg();
  const stuck = addAgent(root, "stuck");
  stamp(stuck, 0, 65_000);
  stuck.status = "interrupted";
  const entries = listEntries(root);
  assert.equal(entries.length, 1);
  assert.equal(
    renderList({
      entries,
      counts: { running: 0, total: 1 },
      now: 1_000_000,
      width: 80,
      height: 5,
      theme: marker,
    })[0],
    "Tasks · 0 running · 1 total",
  );
  const theme: BrowserTheme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bg: (_color, text) => text,
  };
  assert.equal(
    renderListLine({ row: stuck, prefix: "" }, 1_000_000, theme),
    `<muted>${clock(0)}</muted> · <muted>1m05s</muted> · ${stuck.taskId} · agent · bg · <warning>interrupted</warning> · stuck`,
  );
});

test("session events: the derivation table, text rule, and skipped lines", () => {
  const text = [
    line({ type: "session", timestamp: T, id: "s" }),
    "not json",
    line([1]),
    line({ timestamp: T }),
    line({ type: "message", timestamp: "yesterday" }),
    event("assistant", [
      { type: "text", text: "hello\nworld" },
      { type: "thinking", thinking: "\n  deeper" },
      { type: "toolCall", name: "Task", arguments: { a: 1 } },
      { type: "image", source: { x: 1 } },
    ]),
    line({
      type: "message",
      timestamp: T,
      message: {
        role: "toolResult",
        toolName: "Task",
        isError: true,
        content: [{ type: "text", text: "boom" }, { type: "image" }],
      },
    }),
    event("user", "hi\nthere"),
    line({ type: "model_change", timestamp: T, provider: "p" }),
  ].join("\n");
  const events = deriveSessionEvents(text);
  assert.deepEqual(
    events.map(({ key, kind, summary, content, isError }) => ({
      key,
      kind,
      summary,
      content,
      isError,
    })),
    [
      { key: "5:0", kind: "assistant", summary: "hello", content: "hello\nworld", isError: false },
      { key: "5:1", kind: "thinking", summary: "deeper", content: "\n  deeper", isError: false },
      {
        key: "5:2",
        kind: "call Task",
        summary: '{"a":1}',
        content: '{\n  "a": 1\n}',
        isError: false,
      },
      {
        key: "5:3",
        kind: "image",
        summary: "",
        content: JSON.stringify({ type: "image", source: { x: 1 } }, null, 2),
        isError: false,
      },
      { key: "6:0", kind: "result Task", summary: "boom", content: "boom\n[image]", isError: true },
      { key: "7:0", kind: "user", summary: "hi", content: "hi\nthere", isError: false },
      {
        key: "8:0",
        kind: "model_change",
        summary: "",
        content: JSON.stringify({ type: "model_change", timestamp: T, provider: "p" }, null, 2),
        isError: false,
      },
    ],
  );
  assert.ok(events.every((entry) => entry.time === T));
  assert.equal(deriveSessionEvents("").length, 0);
});

test("details agent: sections, field order, collapsed and expanded events, padding", () => {
  const start = 1_000_000;
  const root = reg();
  const a = addAgent(root, "explore");
  stamp(a, start);
  root.amend(a, { agent: "explorer", model: "anthropic/claude:high", sessionPath: "/tmp/s.jsonl" });
  a.task = "line one\nline two";
  a.orphan = true;
  root.settle(a, { status: "completed", resultPath: "/tmp/r.txt" });
  stamp(a, start, start + 8_000);
  const events = deriveSessionEvents(
    [
      event("assistant", [{ type: "text", text: "hello" }]),
      line({
        type: "message",
        timestamp: T,
        message: {
          role: "toolResult",
          toolName: "Bash",
          isError: true,
          content: [{ type: "text", text: "boom" }],
        },
      }),
    ].join("\n"),
  );
  const expanded = new Map([["1:0", true]]);
  const page = renderDetails({
    row: a,
    events,
    expanded,
    selected: "0:0",
    now: start + 100_000,
    width: 80,
    height: 40,
    theme: identityTheme,
  });
  assert.equal(page.length, 40);
  assert.equal(page[0], `Task ${a.taskId} · agent · completed · 8s`);
  assert.deepEqual(page.slice(1, 18), [
    "Agent",
    "agent: explorer",
    "model: anthropic/claude:high",
    "delivery: bg · orphan",
    `started: ${dateTime(start)}`,
    `settled: ${dateTime(start + 8_000)}`,
    "session: /tmp/s.jsonl",
    "result: /tmp/r.txt",
    "",
    "Task",
    "line one",
    "line two",
    "",
    "Events",
    `▸ ${clock(Date.parse(T))} assistant · hello`,
    `▾ ${clock(Date.parse(T))} result Bash · boom`,
    "  boom",
  ]);
  assert.equal(page[38], "");
  assert.equal(page[39], "↑↓ select · g/G top/bottom · enter expand · e/c all · esc back");
});

test("details agent: absent fields and empty sections", () => {
  const root = reg();
  const bare = addAgent(root, "bare");
  const page = renderDetails({ row: bare, now: 0, width: 80, height: 20, theme: identityTheme });
  const body = page.join("\n");
  for (const name of ["agent: ", "model: ", "settled: ", "session: ", "result: "]) {
    assert.ok(!body.includes(`\n${name}`), name);
  }
  assert.match(body, /\nTask\n\(none\)\n\nEvents\n\(none\)\n/);
});

test("details agent: expanded content indents and wraps, (empty), and the 200-line cap", () => {
  const root = reg();
  const row = addAgent(root, "a");
  const events: SessionEvent[] = [
    { key: "0:0", time: T, kind: "assistant", summary: "s", content: "", isError: false },
    {
      key: "1:0",
      time: T,
      kind: "assistant",
      summary: "s",
      content: Array.from({ length: 250 }, (_, i) => `l${i}`).join("\n"),
      isError: false,
    },
    {
      key: "2:0",
      time: T,
      kind: "assistant",
      summary: "s",
      content: "x".repeat(100),
      isError: false,
    },
  ];
  const expanded = new Map([
    ["0:0", true],
    ["1:0", true],
    ["2:0", true],
  ]);
  const page = renderDetails({
    row,
    events,
    expanded,
    now: 0,
    width: 20,
    height: 260,
    theme: identityTheme,
  });
  const body = page.slice(1, -1);
  const pos = (text: string) => body.indexOf(text);
  assert.ok(pos("  (empty)") > 0);
  const first = pos("  l0");
  assert.equal(first, pos("  (empty)") + 2);
  assert.equal(body[first + 199], "  l199");
  assert.equal(body[first + 200], "  … 50 more lines");
  const wrapped = page.filter((text) => text.startsWith("  x"));
  assert.ok(wrapped.length > 1);
  for (const text of page) assert.ok(visibleWidth(text) <= 20);
});

test("details script: Script fields and one progress line per entry", () => {
  const start = 2_000_000;
  const root = reg();
  const s = addScript(root, "build");
  stamp(s, start);
  s.progress = [
    { at: start + 1_000, line: "one" },
    { at: start + 2_000, line: "two\x1b[31m!\x1b[0m" },
  ];
  const page = renderDetails({
    row: s,
    now: start + 3_000,
    width: 80,
    height: 12,
    theme: identityTheme,
  });
  assert.equal(page[0], `Task ${s.taskId} · script · running · 3s`);
  assert.deepEqual(page.slice(1, 10), [
    "Script",
    "label: build",
    "delivery: fg",
    `started: ${dateTime(start)}`,
    "",
    "Output",
    "one",
    "two!",
    "",
  ]);
  assert.equal(page[11], "↑↓ scroll · g/G top/bottom · esc back");
});

test("details bash: the first section is named Bash, then Command, then Output", () => {
  const start = 2_000_000;
  const root = reg();
  const b = addBash(root, "make test", true);
  stamp(b, start, start + 2_000);
  b.resultPath = "/tmp/sessions/s.agents/output/call-1.log";
  b.progress = [{ at: start + 1_000, line: "$ make test" }];
  const page = renderDetails({
    row: b,
    now: start + 3_000,
    width: 80,
    height: 14,
    theme: identityTheme,
  });
  assert.equal(page[0], `Task ${b.taskId} · bash · running · 2s`);
  assert.deepEqual(page.slice(1, 13), [
    "Bash",
    "label: make test",
    "delivery: bg",
    `started: ${dateTime(start)}`,
    `settled: ${dateTime(start + 2_000)}`,
    "result: /tmp/sessions/s.agents/output/call-1.log",
    "",
    "Command",
    "make test",
    "",
    "Output",
    "$ make test",
  ]);
  assert.equal(page[13], "↑↓ scroll · g/G top/bottom · esc back");
});

test("details bash: a long multi-line command shows every line, wrapped, under Command (specs/task-browser.md#script-bash)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-browser-command-"));
  const host = {
    cwd: () => root,
    sessionId: () => "bash-session",
    sessionFile: () => undefined,
    sessionDir: () => root,
    model: () => undefined,
    thinking: () => undefined,
    activeTools: () => ["Bash"],
    inventory: () => [],
    configuredModels: () => [],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  } as unknown as HostSession;
  try {
    const registry = new TaskRegistry(() => host);
    const tool = makeBashTool({
      registry: () => registry,
      hostProvider: () => host,
      cohortFor: (id: string) => `cohort-${id}`,
      agentDir: () => join(root, "agent"),
      settings: () => ({}),
    });
    const long = `echo ${Array.from({ length: 12 }, (_value, index) => `word${index}`).join(" ")}`;
    const command = ["echo first-line", long, "\x1b[32mecho\ttab\there\x1b[0m"].join("\n");
    const result = await tool.execute(
      "call-1",
      { command, background: true } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(result.isError, undefined);
    const row = at(registry.list(), 0);

    const width = 24;
    const page = renderDetails({
      row,
      now: row.startedAt,
      width,
      height: 40,
      theme: identityTheme,
    });
    const heading = page.indexOf("Command");
    const output = page.indexOf("Output");
    assert.ok(heading > 0, page.join("\n"));
    assert.ok(output > heading, page.join("\n"));
    const shown = page.slice(heading + 1, output - 1);

    for (const text of shown) assert.ok(visibleWidth(text) <= width, text);
    assert.ok(!shown.join("\n").includes("\x1b"), "ANSI escapes are removed");
    assert.ok(!shown.join("\n").includes("\t"), "a tab is rendered as spaces");
    assert.ok(shown.length > 3, `the long line wraps: ${shown.join("|")}`);
    assert.equal(
      shown.join(" "),
      ["echo first-line", long, "echo  tab  here"].join(" "),
      "every command line is shown whole, in order",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("details: the status and every session event kind take their theme colours", () => {
  const tagging: BrowserTheme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bg: (color, text) => `<${color}>${text}</${color}>`,
  };
  const root = reg();
  const row = addAgent(root, "coloured");
  stamp(row, 0);
  const events = deriveSessionEvents(
    [
      event("assistant", [{ type: "text", text: "hello" }]),
      event("toolResult", "boom", { toolName: "Bash", isError: true }),
    ].join("\n"),
  );
  const selected = at(events, 0).key;
  const body = renderDetails({
    row,
    events,
    selected,
    now: 0,
    width: 120,
    height: 20,
    theme: tagging,
  }).join("\n");

  assert.ok(
    body.includes(
      "<selectedBg>▸ <muted>03:04:05</muted> <accent>assistant</accent> · hello</selectedBg>",
    ),
    `the selected event carries the selection background: ${body}`,
  );
  assert.ok(
    body.includes("▸ <muted>03:04:05</muted> <error>result Bash</error> · boom"),
    `a failed tool result is coloured error: ${body}`,
  );

  Object.assign(row, { status: "failed", settledAt: 1_000 });
  const title = renderDetails({
    row,
    events,
    selected,
    now: 1_000,
    width: 120,
    height: 20,
    theme: tagging,
  });
  assert.equal(
    at(title, 0),
    `Task ${row.taskId} · agent · <error>failed</error> · <muted>1s</muted>`,
  );
});

test("state: list opens on the last row, navigates, opens details, and closes", () => {
  const root = reg();
  const a = addAgent(root, "a");
  const b = addAgent(root, "b");
  const state = browser({ registry: root, height: () => 6, theme: marker });
  let page = state.render(80);
  assert.equal(page[0], "Tasks · 2 running · 2 total");
  assert.ok(at(page, 2).startsWith("«") && at(page, 2).includes(b.taskId));
  state.handleKey("k");
  page = state.render(80);
  assert.ok(at(page, 1).startsWith("«") && at(page, 1).includes(a.taskId));
  assert.equal(state.handleKey("\r"), undefined);
  page = state.render(80);
  assert.match(at(page, 0), new RegExp(`^Task ${a.taskId} · agent · running · \\d+s$`));
  assert.equal(state.handleKey("\x1b"), undefined);
  page = state.render(80);
  assert.equal(page[0], "Tasks · 2 running · 2 total");
  assert.ok(at(page, 1).startsWith("«") && at(page, 1).includes(a.taskId));
  assert.equal(state.handleKey("q"), "close");
});

test("state: list selection follows the taskId, then the row at its index", () => {
  const root = reg();
  const a = addAgent(root, "a");
  const ca = reg();
  root.attach(a, ca);
  const b = addAgent(ca, "b");
  const c = addAgent(root, "c");
  const state = browser({ registry: root, height: () => 10, theme: marker });
  state.render(80);
  state.handleKey("k");
  state.render(80);
  root.settle(a, { status: "completed" });
  state.refresh();
  const page = state.render(80);
  assert.ok(!page.join("\n").includes(b.taskId));
  assert.ok(at(page, 2).startsWith("«") && at(page, 2).includes(c.taskId));
});

test("state: details keeps a row after it leaves the tree", () => {
  const root = reg();
  const a = addAgent(root, "a");
  const ca = reg();
  root.attach(a, ca);
  const b = addAgent(ca, "b");
  const state = browser({ registry: root, height: () => 10 });
  state.render(80);
  state.handleKey("\r");
  root.settle(a, { status: "completed" });
  state.refresh();
  const page = state.render(80);
  assert.match(at(page, 0), new RegExp(`^Task ${b.taskId} · agent · running · \\d+s$`));
});

test("state: details follows appended session events only while the last is selected", () => {
  const root = reg();
  const row = addAgent(root, "x");
  root.amend(row, { sessionPath: "/tmp/s.jsonl" });
  const session: string[] = [`${event("user", "one")}\n`];
  let reads = 0;
  const state = browser({
    registry: root,
    height: () => 20,
    theme: marker,
    readSession: (path) => {
      reads++;
      assert.equal(path, "/tmp/s.jsonl");
      return session.join("");
    },
  });
  state.render(80);
  assert.equal(reads, 0);
  state.handleKey("\r");
  assert.equal(reads, 1);
  let page = state.render(80);
  assert.ok(page.some((text) => text.startsWith("«") && text.endsWith("user · one»")));

  session.push(`${event("user", "two")}\n`);
  state.tick();
  page = state.render(80);
  assert.ok(page.some((text) => text.includes("«") && text.endsWith("user · two»")));

  state.handleKey("\x1b[A");
  session.push(`${event("user", "three")}\n`);
  state.tick();
  page = state.render(80);
  assert.ok(page.some((text) => text.startsWith("«") && text.endsWith("user · one»")));
  const three = page.findIndex((text) => text.endsWith("user · three"));
  assert.ok(three > 0 && !at(page, three).includes("«"));

  state.handleKey(" ");
  page = state.render(80);
  assert.ok(page.includes("  one"));
  state.handleKey("c");
  page = state.render(80);
  assert.ok(!page.includes("  one") && !page.includes("  three"));
  state.handleKey("e");
  page = state.render(80);
  assert.ok(page.includes("  one") && page.includes("  three"));

  root.settle(row, { status: "completed" });
  const before = reads;
  state.refresh();
  assert.equal(reads, before + 1);
  state.refresh();
  assert.equal(reads, before + 1);
});

test("state: script details open at the bottom and stick there while at the bottom", () => {
  const start = 3_000_000;
  const root = reg();
  const s = addScript(root, "build");
  stamp(s, start);
  s.progress = Array.from({ length: 20 }, (_, i) => ({ at: start + i * 1_000, line: `line ${i}` }));
  const state = browser({ registry: root, height: () => 8 });
  state.render(80);
  state.handleKey("\r");
  let page = state.render(80);
  assert.equal(page.length, 8);
  assert.equal(page[6], "line 19");

  state.handleKey("\x1b[A");
  state.handleKey("\x1b[A");
  s.progress.push({ at: start + 20_000, line: "line 20" });
  state.refresh();
  page = state.render(80);
  assert.equal(page[6], "line 17");

  state.handleKey("\x1b[F");
  page = state.render(80);
  assert.equal(page[6], "line 20");
  s.progress.push({ at: start + 21_000, line: "line 21" });
  state.refresh();
  page = state.render(80);
  assert.equal(page[6], "line 21");
  assert.equal(state.handleKey("\x7f"), undefined);
  assert.match(at(state.render(80), 0), /^Tasks · /);
});

test("state: hasRunning covers the whole tree", () => {
  const root = reg();
  const state = browser({ registry: root, height: () => 5 });
  assert.equal(state.hasRunning(), false);
  const a = addAgent(root, "a");
  const ca = reg();
  root.attach(a, ca);
  addAgent(ca, "b");
  assert.equal(state.hasRunning(), true);
  root.settle(a, { status: "completed" });
  assert.equal(state.hasRunning(), false);
});

const tallTask = Array.from({ length: 40 }, (_, index) => `task line ${index}`).join("\n");

test("details agent: home reaches the top and up on the first event scrolls one line", () => {
  const root = reg();
  const row = addAgent(root, "tall");
  root.amend(row, { sessionPath: "/tmp/s.jsonl", agent: "explorer" });
  row.task = tallTask;
  const text = `${event("user", "one")}\n${event("user", "two")}\n`;
  const state = browser({
    registry: root,
    height: () => 12,
    theme: marker,
    readSession: () => text,
  });
  state.render(80);
  state.handleKey("\r");
  let page = state.render(80);
  assert.ok(!at(page, 1).startsWith("Agent"));
  state.handleKey("\x1b[H");
  page = state.render(80);
  assert.equal(page[1], "Agent");
  state.handleKey("\x1b[F");
  page = state.render(80);
  assert.ok(page.some((entry) => entry.startsWith("«") && entry.endsWith("user · two»")));
  state.handleKey("k");
  page = state.render(80);
  assert.ok(page.some((entry) => entry.startsWith("«") && entry.endsWith("user · one»")));
  const top = page[1];
  state.handleKey("k");
  page = state.render(80);
  assert.notEqual(page[1], top);
  assert.ok(page.some((entry) => entry.startsWith("«") && entry.endsWith("user · one»")));
  for (let press = 0; press < 60; press++) state.handleKey("k");
  page = state.render(80);
  assert.equal(page[1], "Agent");
});

test("details agent: zero session events use the script-page scroll keys", () => {
  const root = reg();
  const row = addAgent(root, "tall");
  root.amend(row, { agent: "explorer" });
  row.task = tallTask;
  const state = browser({ registry: root, height: () => 8 });
  state.render(80);
  state.handleKey("\r");
  let page = state.render(80);
  assert.equal(page[1], "Agent");
  state.handleKey("j");
  assert.equal(state.render(80)[1], "agent: explorer");
  state.handleKey("k");
  assert.equal(state.render(80)[1], "Agent");
  state.handleKey("\x1b[F");
  page = state.render(80);
  assert.equal(page[6], "(none)");
  state.handleKey("\x1b[H");
  assert.equal(state.render(80)[1], "Agent");
  state.handleKey("\x1b[6~");
  assert.equal(state.render(80)[1], "task line 0");
  state.handleKey("\x1b[5~");
  assert.equal(state.render(80)[1], "Agent");
});

test("details agent: pageUp and pageDown move by body height in lines", () => {
  const root = reg();
  const row = addAgent(root, "pages");
  root.amend(row, { sessionPath: "/tmp/s.jsonl" });
  const wide = event(
    "user",
    `b\n${Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")}`,
  );
  const text = [`${event("user", "a")}\n`, `${wide}\n`, `${event("user", "c")}\n`].join("");
  const state = browser({
    registry: root,
    height: () => 20,
    theme: marker,
    readSession: () => text,
  });
  state.render(80);
  state.handleKey("\r");
  state.handleKey("k");
  state.handleKey("\x1b[C");
  state.handleKey("\x1b[H");
  let page = state.render(80);
  assert.ok(page.some((entry) => entry.startsWith("«") && entry.endsWith("user · a»")));
  state.handleKey("\x1b[6~");
  page = state.render(80);
  assert.ok(page.some((entry) => entry.startsWith("«") && entry.endsWith("user · b»")));
  assert.ok(!page.some((entry) => entry.startsWith("«") && entry.endsWith("user · c»")));
  state.handleKey("\x1b[5~");
  page = state.render(80);
  assert.ok(page.some((entry) => entry.startsWith("«") && entry.endsWith("user · a»")));
});

test("details agent: enter, space, right, e, and c toggle expansion", () => {
  const root = reg();
  const row = addAgent(root, "toggle");
  root.amend(row, { sessionPath: "/tmp/s.jsonl" });
  const text = `${event("user", "one")}\n${event("user", "two")}\n`;
  const state = browser({ registry: root, height: () => 20, readSession: () => text });
  state.render(80);
  state.handleKey("\r");
  state.handleKey("\x1b[C");
  let page = state.render(80);
  assert.ok(page.some((entry) => entry.startsWith("▾") && entry.endsWith("user · two")));
  assert.ok(page.includes("  two"));
  state.handleKey(" ");
  page = state.render(80);
  assert.ok(!page.some((entry) => entry.startsWith("▾")) && !page.includes("  two"));
  state.handleKey(" ");
  page = state.render(80);
  assert.ok(page.includes("  two"));
  state.handleKey("e");
  page = state.render(80);
  assert.ok(page.includes("  one") && page.includes("  two"));
  state.handleKey("c");
  page = state.render(80);
  assert.ok(!page.includes("  one") && !page.includes("  two"));
});

test("details agent: wrapped content lines count toward the 200-line cap", () => {
  const row = addAgent(reg(), "cap");
  const content = "x".repeat(5000);
  const events: SessionEvent[] = [
    { key: "0:0", time: T, kind: "assistant", summary: "s", content, isError: false },
  ];
  const width = 20;
  const page = renderDetails({
    row,
    events,
    expanded: new Map([["0:0", true]]),
    now: 0,
    width,
    height: 260,
    theme: identityTheme,
  });
  const body = page.slice(1, -1);
  const first = body.findIndex((text) => text.startsWith("  xxx"));
  assert.ok(first > 0);
  const wrapped = countWrapped(content, width - 2);
  assert.ok(wrapped > 200);
  assert.ok(at(body, first + 199).startsWith("  x"));
  assert.equal(body[first + 200], `  … ${wrapped - 200} more lines`);
});

/** Lines `wrapTextWithAnsi` produces for `text` at `width` (see lib/task-browser.ts). */
const countWrapped = (text: string, width: number): number => wrapTextWithAnsi(text, width).length;

test("state: the list scrolls to keep the selected row visible", () => {
  const root = reg();
  const rows = Array.from({ length: 7 }, (_, index) => addAgent(root, `t${index}`));
  const state = browser({ registry: root, height: () => 5, theme: marker });
  let page = state.render(80);
  assert.equal(page.length, 5);
  assert.ok(at(page, 1).includes(at(rows, 4).taskId) && !at(page, 1).startsWith("«"));
  assert.ok(at(page, 3).startsWith("«") && at(page, 3).includes(at(rows, 6).taskId));
  state.handleKey("\x1b[H");
  page = state.render(80);
  assert.ok(at(page, 1).startsWith("«") && at(page, 1).includes(at(rows, 0).taskId));
  state.handleKey("\x1b[6~");
  page = state.render(80);
  assert.ok(at(page, 3).startsWith("«") && at(page, 3).includes(at(rows, 3).taskId));
  state.handleKey("\x1b[F");
  page = state.render(80);
  assert.ok(at(page, 3).startsWith("«") && at(page, 3).includes(at(rows, 6).taskId));
});

test("state: a list that becomes non-empty selects the last row", () => {
  const root = reg();
  const state = browser({ registry: root, height: () => 6, theme: marker });
  const empty = state.render(80);
  assert.equal(empty[1], "(no tasks)");
  addAgent(root, "a");
  addAgent(root, "b");
  const last = addAgent(root, "c");
  state.refresh();
  const page = state.render(80);
  assert.ok(at(page, 3).startsWith("«") && at(page, 3).includes(last.taskId));
});

test("state: an unrelated registry change never re-reads the session file", () => {
  const root = reg();
  const row = addAgent(root, "reads");
  root.amend(row, { sessionPath: "/tmp/s.jsonl" });
  let reads = 0;
  const state = browser({
    registry: root,
    height: () => 10,
    readSession: () => {
      reads++;
      return `${event("user", "one")}\n`;
    },
  });
  state.render(80);
  state.handleKey("\r");
  assert.equal(reads, 1);
  root.amend(row, { label: "renamed" });
  state.refresh();
  assert.equal(reads, 1);
  addAgent(root, "other");
  state.refresh();
  assert.equal(reads, 1);
  state.tick();
  assert.equal(reads, 2);
});

test("state: registry.settle triggers exactly one final read", () => {
  const root = reg();
  const row = addAgent(root, "settle");
  root.amend(row, { sessionPath: "/tmp/s.jsonl" });
  let reads = 0;
  const state = browser({
    registry: root,
    height: () => 10,
    readSession: () => {
      reads++;
      return `${event("user", "one")}\n`;
    },
  });
  state.render(80);
  state.handleKey("\r");
  assert.equal(reads, 1);
  root.settle(row, { status: "failed" });
  state.refresh();
  assert.equal(reads, 2);
  state.refresh();
  state.tick();
  assert.equal(reads, 2);
});

test("state: session reads are incremental, keep partial lines, and restart on shrink", () => {
  const root = reg();
  const row = addAgent(root, "incr");
  root.amend(row, { sessionPath: "/tmp/s.jsonl" });
  let text = `${event("user", "one")}\n${event("user", "two")}\n`;
  const state = browser({
    registry: root,
    height: () => 40,
    theme: marker,
    readSession: () => text,
  });
  state.render(80);
  state.handleKey("\r");
  let page = state.render(80);
  assert.ok(page.some((entry) => entry.endsWith("user · two»")));

  text += `${event("user", "three")}\n`;
  state.tick();
  page = state.render(80);
  assert.ok(page.some((entry) => entry.endsWith("user · three»")));

  const four = event("user", "four");
  text += four.slice(0, 10);
  state.tick();
  page = state.render(80);
  assert.ok(!page.join("\n").includes("user · four"));
  text += `${four.slice(10)}\n`;
  state.tick();
  page = state.render(80);
  assert.ok(page.some((entry) => entry.endsWith("user · four»")));

  text = `${event("user", "only")}\n`;
  state.tick();
  page = state.render(80);
  const events = page.filter((entry) => entry.includes("user ·"));
  assert.equal(events.length, 1);
  assert.ok(at(events, 0).includes("only"));
});

test("overlay: the timer re-reads only while a task runs and stops on close", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = reg();
  const row = addAgent(root, "over");
  root.amend(row, { sessionPath: "/tmp/s.jsonl" });
  let reads = 0;
  let done = 0;
  const overlay = new TaskBrowserOverlay({
    registry: root,
    zone: "UTC",
    tui: { requestRender: () => undefined, terminal: { rows: 10 } },
    theme: identityTheme,
    shortcut: "alt+t",
    readSession: () => {
      reads++;
      return `${event("user", "one")}\n`;
    },
    done: () => {
      done++;
    },
  });
  overlay.handleInput("\r");
  assert.equal(reads, 1);
  t.mock.timers.tick(1000);
  assert.equal(reads, 2);
  t.mock.timers.tick(1000);
  assert.equal(reads, 3);
  root.settle(row, { status: "completed" });
  await Promise.resolve();
  assert.equal(reads, 4);
  t.mock.timers.tick(10_000);
  assert.equal(reads, 4);
  overlay.handleInput("\x1bt");
  assert.equal(done, 1);
  t.mock.timers.tick(10_000);
  assert.equal(reads, 4);
});

test("overlay: no timer without a running task, and dispose is idempotent", () => {
  const root = reg();
  let reads = 0;
  let disposes = 0;
  let done = 0;
  const overlay = new TaskBrowserOverlay({
    registry: root,
    zone: "UTC",
    tui: { requestRender: () => undefined, terminal: { rows: 8 } },
    theme: identityTheme,
    shortcut: "alt+t",
    readSession: () => {
      reads++;
      return "";
    },
    done: () => {
      done++;
    },
    onDispose: () => {
      disposes++;
    },
  });
  overlay.handleInput("\r");
  assert.equal(reads, 0);
  overlay.dispose();
  overlay.dispose();
  assert.equal(disposes, 1);
  assert.equal(done, 0);
});

/** A registry whose reads all fail once `broken`, to exercise the overlay's error reporting. */
class FlakyRegistry extends TaskRegistry {
  broken = false;

  override list(): TaskRow[] {
    if (this.broken) throw new Error("registry is gone");
    return super.list();
  }
}

test("overlay: a lasting refresh and tick failure is reported once, not swallowed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = new FlakyRegistry(() => undefined);
  const row = addAgent(root, "flaky");
  const errors: string[] = [];
  const overlay = new TaskBrowserOverlay({
    registry: root,
    zone: "UTC",
    tui: { requestRender: () => undefined, terminal: { rows: 10 } },
    theme: identityTheme,
    shortcut: "alt+t",
    readSession: () => "",
    done: () => undefined,
    onError: (message) => errors.push(message),
  });

  root.broken = true;
  t.mock.timers.tick(1000);
  assert.deepEqual(
    errors,
    ["pi-dent: task browser: registry is gone"],
    "the tick reports the failure",
  );

  // The failure lasts: later ticks and the refresh a settlement triggers repeat it no more.
  t.mock.timers.tick(5000);
  root.settle(row, { status: "completed" });
  await Promise.resolve();
  t.mock.timers.tick(1000);
  assert.deepEqual(
    errors,
    ["pi-dent: task browser: registry is gone"],
    "one report per opened browser",
  );
  overlay.dispose();
});

test("overlay: the shortcut closes an open browser", () => {
  const root = reg();
  addAgent(root, "a");
  let disposes = 0;
  let done = 0;
  const overlay = new TaskBrowserOverlay({
    registry: root,
    zone: "UTC",
    tui: { requestRender: () => undefined, terminal: { rows: 8 } },
    theme: identityTheme,
    shortcut: "alt+t",
    readSession: () => undefined,
    done: () => {
      done++;
    },
    onDispose: () => {
      disposes++;
    },
  });
  overlay.handleInput("\x1bt");
  assert.equal(done, 1);
  assert.equal(disposes, 1);
  overlay.dispose();
  assert.equal(disposes, 1);
});

test("session events: string assistant content, role-less message, and tab rendering", () => {
  const text = [
    line({ type: "message", timestamp: T, message: { role: "assistant", content: "alpha\nbeta" } }),
    line({ type: "message", timestamp: T, message: { content: "plain" } }),
    line({
      type: "message",
      timestamp: T,
      message: { role: "assistant", content: [{ type: "text", text: "a\tb" }] },
    }),
  ].join("\n");
  const events = deriveSessionEvents(text);
  assert.deepEqual(
    events.map(({ key, kind, summary, content }) => ({ key, kind, summary, content })),
    [
      { key: "0:0", kind: "assistant", summary: "alpha", content: "alpha\nbeta" },
      { key: "1:0", kind: "message", summary: "plain", content: "plain" },
      { key: "2:0", kind: "assistant", summary: "a\tb", content: "a\tb" },
    ],
  );
  const page = renderDetails({
    row: addAgent(reg(), "tabs"),
    events,
    expanded: new Map([["2:0", true]]),
    now: 0,
    width: 40,
    height: 20,
    theme: identityTheme,
  });
  assert.ok(page.some((entry) => entry === "  a  b"));
  assert.ok(!page.some((entry) => entry.includes("\t")));
});

test("session events: blank text and thinking blocks yield no event and keep block indexes", () => {
  const text = line({
    type: "message",
    timestamp: T,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "\n\n" },
        { type: "toolCall", name: "bash", arguments: { command: "date" } },
        { type: "text", text: " \t" },
        { type: "text", text: "done" },
      ],
    },
  });
  assert.deepEqual(
    deriveSessionEvents(text).map(({ key, kind }) => ({ key, kind })),
    [
      { key: "0:2", kind: "call bash" },
      { key: "0:4", kind: "assistant" },
    ],
  );
});

test("details agent: expanding the last event shows its content; down scrolls through long content", () => {
  const root = reg();
  const row = addAgent(root, "tall");
  root.amend(row, { sessionPath: "/tmp/s.jsonl", agent: "explorer" });
  row.task = tallTask;
  const long = Array.from({ length: 30 }, (_, index) => `row ${index}`).join("\n");
  const text = `${event("user", "one")}\n${event("user", "short\nsecond")}\n${event("user", long)}\n`;
  const state = browser({
    registry: root,
    height: () => 12,
    theme: marker,
    readSession: () => text,
  });
  state.render(80);
  state.handleKey("\r");
  state.handleKey("k");
  state.handleKey("\r");
  let page = state.render(80);
  assert.ok(page.some((entry) => entry.startsWith("«") && entry.includes("user · short")));
  assert.ok(page.includes("  second"));
  state.handleKey("j");
  state.handleKey("\r");
  page = state.render(80);
  assert.ok(page.some((entry) => entry.startsWith("«") && entry.includes("user · row 0")));
  assert.ok(page.includes("  row 8"));
  assert.ok(!page.includes("  row 29"));
  for (let press = 0; press < 40; press++) state.handleKey("j");
  page = state.render(80);
  assert.equal(page.at(-2), "  row 29");
  state.handleKey("k");
  page = state.render(80);
  assert.equal(page.at(-2), "  row 28");
});

test("state: list page answers right to open the selected row's details", () => {
  const root = reg();
  const a = addAgent(root, "a");
  addAgent(root, "b");
  const state = browser({ registry: root, height: () => 6, theme: marker });
  state.render(80);
  state.handleKey("k");
  assert.equal(state.handleKey("\x1b[C"), undefined);
  const page = state.render(80);
  assert.match(at(page, 0), new RegExp(`^Task ${a.taskId} · agent · running`));
});

test("state: g and G select the first and the last row of the list", () => {
  const root = reg();
  const a = addAgent(root, "a");
  addAgent(root, "b");
  const c = addAgent(root, "c");
  const state = browser({ registry: root, height: () => 10, theme: marker });
  let page = state.render(80);
  assert.ok(at(page, 3).startsWith("«") && at(page, 3).includes(c.taskId));
  state.handleKey("g");
  page = state.render(80);
  assert.ok(at(page, 1).startsWith("«") && at(page, 1).includes(a.taskId));
  state.handleKey("G");
  page = state.render(80);
  assert.ok(at(page, 3).startsWith("«") && at(page, 3).includes(c.taskId));
});

test("state: left on an agent details page returns to the list page", () => {
  const root = reg();
  const a = addAgent(root, "a");
  root.amend(a, { sessionPath: "/tmp/s.jsonl" });
  const text = `${event("user", "one")}\n${event("user", "two")}\n`;
  const state = browser({
    registry: root,
    height: () => 10,
    theme: marker,
    readSession: () => text,
  });
  state.render(80);
  state.handleKey("\r");
  state.handleKey("\x1b[C");
  assert.ok(state.render(80).includes("  two"));
  assert.equal(state.handleKey("\x1b[D"), undefined);
  const page = state.render(80);
  assert.equal(page[0], "Tasks · 1 running · 1 total");
  assert.ok(page.some((entry) => entry.startsWith("«") && entry.includes(a.taskId)));
});

test("state: left on an agent details page without a session event returns to the list", () => {
  const root = reg();
  const a = addAgent(root, "a");
  const state = browser({ registry: root, height: () => 10, theme: marker });
  state.render(80);
  state.handleKey("\r");
  assert.equal(state.handleKey("\x1b[D"), undefined);
  const page = state.render(80);
  assert.equal(page[0], "Tasks · 1 running · 1 total");
  assert.ok(at(page, 1).startsWith("«") && at(page, 1).includes(a.taskId));
});

test("state: left on a script details page returns to the list page", () => {
  const root = reg();
  const s = addScript(root, "s");
  const state = browser({ registry: root, height: () => 6, theme: marker });
  state.render(80);
  state.handleKey("\r");
  assert.equal(state.handleKey("\x1b[D"), undefined);
  const page = state.render(80);
  assert.equal(page[0], "Tasks · 1 running · 1 total");
  assert.ok(at(page, 1).startsWith("«") && at(page, 1).includes(s.taskId));
});

test("state: right does nothing on a page without a selection action", () => {
  const root = reg();
  addScript(root, "s");
  const state = browser({ registry: root, height: () => 6, theme: marker });
  state.render(80);
  state.handleKey("\r");
  const before = state.render(80);
  state.handleKey("\x1b[C");
  assert.deepEqual(state.render(80), before);
});

test("details: a failed agent row shows its result in an Error section, others none", () => {
  const root = reg();
  const failed = addAgent(root, "boom");
  root.settle(failed, {
    status: "failed",
    result: "Agent error: 424: rate limited\nSession: /x/a.jsonl",
  });
  const page = renderDetails({ row: failed, now: 0, width: 80, height: 30, theme: identityTheme });
  const errorAt = page.indexOf("Error");
  assert.ok(errorAt > page.indexOf("Agent") && errorAt < page.indexOf("Task", 1));
  assert.deepEqual(page.slice(errorAt, errorAt + 3), [
    "Error",
    "Agent error: 424: rate limited",
    "Session: /x/a.jsonl",
  ]);
  const narrow = renderDetails({
    row: failed,
    now: 0,
    width: 12,
    height: 30,
    theme: identityTheme,
  });
  assert.ok(narrow.includes("Agent error:"));
  const ok = addAgent(root, "fine");
  root.settle(ok, { status: "completed", result: "done" });
  assert.ok(
    !renderDetails({ row: ok, now: 0, width: 80, height: 30, theme: identityTheme }).includes(
      "Error",
    ),
  );
});

test("details: paths under the agent directory show it as $PI_DENT_SESSION_DIR", () => {
  const root = reg();
  const row = addAgent(root, "paths");
  const dir = "/tmp/pi-dent-shown.agents";
  root.amend(row, { sessionPath: `${dir}/a.jsonl` });
  root.settle(row, { status: "completed", resultPath: `${dir}/a.result.txt` });
  const before = process.env.PI_DENT_SESSION_DIR;
  process.env.PI_DENT_SESSION_DIR = dir;
  try {
    const page = renderDetails({ row, now: 0, width: 80, height: 20, theme: identityTheme });
    assert.ok(page.includes("session: $PI_DENT_SESSION_DIR/a.jsonl"));
    assert.ok(page.includes("result: $PI_DENT_SESSION_DIR/a.result.txt"));
    const labelled = addAgent(root, `read ${dir}/brief.md`);
    assert.ok(labelled.renderLine(0).endsWith("read $PI_DENT_SESSION_DIR/brief.md"));
    assert.ok(root.listLine(labelled).endsWith(`read ${dir}/brief.md`));

    // The Command lines of a bash row take the same substitution (specs/task-browser.md#script-bash).
    const bash = root.register({
      kind: "bash",
      cohort: "c",
      label: "write",
      background: false,
      command: `cat ${dir}/out.md > ${dir}/in.md`,
    });
    const bashPage = renderDetails({
      row: bash,
      now: 0,
      width: 80,
      height: 20,
      theme: identityTheme,
    });
    assert.ok(bashPage.includes("cat $PI_DENT_SESSION_DIR/out.md > $PI_DENT_SESSION_DIR/in.md"));
    assert.ok(!bashPage.join("\n").includes(dir), "the raw directory path is not shown");
  } finally {
    if (before === undefined) delete process.env.PI_DENT_SESSION_DIR;
    else process.env.PI_DENT_SESSION_DIR = before;
  }
});

test("kill key: the hint carries the segment only where the key applies (specs/task-browser.md#agent-details, specs/task-browser.md#script-bash, specs/task-browser.md#kill-key)", () => {
  const hint = (row: TaskRow, killable: boolean, armed = false): string => {
    const page = renderDetails({
      row,
      killable,
      armed,
      now: 0,
      width: 80,
      height: 6,
      theme: identityTheme,
    });
    return page.at(-1) ?? "";
  };
  const root = reg();
  const agent = addAgent(root, "a");
  const script = addScript(root, "s");
  const bash = addBash(root, "b");

  assert.equal(
    hint(agent, true),
    "↑↓ select · g/G top/bottom · enter expand · e/c all · ctrl+k kill · esc back",
  );
  assert.equal(
    hint(agent, true, true),
    "↑↓ select · enter expand · e/c all · ctrl+k again to confirm kill · esc back",
  );
  assert.equal(
    hint(agent, false),
    "↑↓ select · g/G top/bottom · enter expand · e/c all · esc back",
  );
  assert.equal(hint(script, true), "↑↓ scroll · g/G top/bottom · ctrl+k kill · esc back");
  assert.equal(
    hint(script, true, true),
    "↑↓ scroll · g/G top/bottom · ctrl+k again to confirm kill · esc back",
  );
  assert.equal(hint(script, false), "↑↓ scroll · g/G top/bottom · esc back");
  assert.equal(hint(bash, true), "↑↓ scroll · g/G top/bottom · ctrl+k kill · esc back");
  assert.equal(
    hint(bash, true, true),
    "↑↓ scroll · g/G top/bottom · ctrl+k again to confirm kill · esc back",
  );
  assert.equal(hint(bash, false), "↑↓ scroll · g/G top/bottom · esc back");
});

test("kill key: the first press arms and cancels nothing, the second cancels without consuming (specs/task-browser.md#kill-key)", () => {
  const root = reg();
  const row = addAgent(root, "victim");
  let cancelled = 0;
  row.cancel = () => {
    cancelled++;
  };
  const state = browser({ registry: root, height: () => 8, theme: identityTheme });
  state.render(80);
  state.handleKey("\r");
  assert.equal(
    state.render(80).at(-1),
    "↑↓ select · g/G top/bottom · enter expand · e/c all · ctrl+k kill · esc back",
  );

  state.handleKey("\x0b");
  assert.equal(cancelled, 0, "the first press cancels nothing");
  assert.equal(row.consumed, false, "the first press consumes nothing");
  assert.equal(row.status, "running");
  assert.equal(
    state.render(80).at(-1),
    "↑↓ select · enter expand · e/c all · ctrl+k again to confirm kill · esc back",
  );

  state.handleKey("\x0b");
  assert.equal(cancelled, 1, "the second press invokes the cancellation handler");
  assert.equal(row.browserKill, true, "the cancel is recorded as a browser kill");
  assert.equal(row.consumed, false, "a browser kill does not consume the row");
  assert.equal(
    state.render(80).at(-1),
    "↑↓ select · g/G top/bottom · enter expand · e/c all · ctrl+k kill · esc back",
    "the cancelling press disarms the key",
  );
});

test("kill key: any other key disarms it and is handled per its own rule (specs/task-browser.md#kill-key)", () => {
  const root = reg();
  const row = addAgent(root, "victim");
  let cancelled = 0;
  row.cancel = () => {
    cancelled++;
  };
  const state = browser({ registry: root, height: () => 8, theme: identityTheme });
  state.render(80);
  state.handleKey("\r");
  state.handleKey("\x0b");
  state.handleKey("j");
  assert.equal(
    state.render(80).at(-1),
    "↑↓ select · g/G top/bottom · enter expand · e/c all · ctrl+k kill · esc back",
    "another key disarms the kill key",
  );
  state.handleKey("\x0b");
  assert.equal(cancelled, 0, "the re-armed key needs a second press again");
  state.handleKey("\x0b");
  assert.equal(cancelled, 1);
});

test("kill key: a settled row shows no segment and ignores the key (specs/task-browser.md#kill-key)", () => {
  const root = reg();
  const row = addAgent(root, "done");
  root.settle(row, { status: "completed", result: "fine" });
  let cancelled = 0;
  row.cancel = () => {
    cancelled++;
  };
  const state = browser({ registry: root, height: () => 8, theme: identityTheme });
  state.render(80);
  state.handleKey("\r");
  assert.equal(
    state.render(80).at(-1),
    "↑↓ select · g/G top/bottom · enter expand · e/c all · esc back",
  );
  state.handleKey("\x0b");
  assert.equal(
    state.render(80).at(-1),
    "↑↓ select · g/G top/bottom · enter expand · e/c all · esc back",
  );
  state.handleKey("\x0b");
  assert.equal(cancelled, 0);
  assert.equal(row.status, "completed");
  assert.equal(row.result, "fine");
});

test("kill key: a child session's task is killed in the registry that holds it (specs/task-browser.md#kill-key)", () => {
  const root = reg();
  const parent = addAgent(root, "parent");
  const child = reg();
  root.attach(parent, child);
  // A grandchild registry, two levels below the browser's own.
  const grandparent = child.register({
    kind: "agent",
    cohort: "c",
    label: "inner",
    background: true,
  });
  const grandchild = reg();
  child.attach(grandparent, grandchild);
  const deep = grandchild.register({
    kind: "script",
    cohort: "c",
    label: "deep",
    background: true,
  });
  let cancelled = 0;
  deep.cancel = () => {
    cancelled++;
  };
  const state = browser({ registry: root, height: () => 8, theme: identityTheme });
  state.render(80);
  // The list opens on the last row, which is the child's child's task.
  state.handleKey("\r");
  assert.match(at(state.render(80), 0), / · script · running · /);
  assert.equal(state.render(80).at(-1), "↑↓ scroll · g/G top/bottom · ctrl+k kill · esc back");
  state.handleKey("\x0b");
  state.handleKey("\x0b");
  assert.equal(cancelled, 1, "the row is cancelled in the registry that holds it");
  assert.equal(deep.browserKill, true);
  assert.equal(deep.consumed, false, "the browser kill does not consume the row");

  // Adoption into the browser's own registry keeps the page's row killable.
  deep.cancel = () => {
    cancelled++;
  };
  grandchild.end();
  state.refresh();
  assert.equal(deep.orphan, true);
  assert.equal(state.render(80).at(-1), "↑↓ scroll · g/G top/bottom · ctrl+k kill · esc back");
  state.handleKey("\x0b");
  state.handleKey("\x0b");
  assert.equal(cancelled, 2);
});

test("kill key: a running row whose registry the tree no longer holds is not killable (specs/task-browser.md#kill-key)", () => {
  const root = reg();
  const parent = addAgent(root, "parent");
  const child = reg();
  root.attach(parent, child);
  const inner = child.register({ kind: "script", cohort: "c", label: "inner", background: true });
  let cancelled = 0;
  inner.cancel = () => {
    cancelled++;
  };
  const state = browser({ registry: root, height: () => 8, theme: identityTheme });
  state.render(80);
  state.handleKey("\r");
  assert.equal(state.render(80).at(-1), "↑↓ scroll · g/G top/bottom · ctrl+k kill · esc back");

  // Settling the parent detaches the child registry while its row is still running.
  root.settle(parent, { status: "completed" });
  state.refresh();
  assert.equal(state.render(80).at(-1), "↑↓ scroll · g/G top/bottom · esc back");
  state.handleKey("\x0b");
  state.handleKey("\x0b");
  assert.equal(cancelled, 0, "a registry outside the task tree is not reachable");
  assert.equal(inner.browserKill, false);
});

test("kill key: the same key kills a script and a bash row (specs/task-browser.md#kill-key)", () => {
  const root = reg();
  const script = addScript(root, "s");
  const bash = addBash(root, "b");
  let killed = 0;
  script.cancel = () => {
    killed++;
  };
  bash.cancel = () => {
    killed++;
  };
  const state = browser({ registry: root, height: () => 8, theme: identityTheme });
  state.render(80);
  state.handleKey("\r");
  assert.match(at(state.render(80), 0), / · bash · running · /);
  state.handleKey("\x0b");
  state.handleKey("\x0b");
  assert.equal(killed, 1);
  state.handleKey("\x1b");
  state.render(80);
  state.handleKey("k");
  state.handleKey("\r");
  assert.match(at(state.render(80), 0), / · script · running · /);
  state.handleKey("\x0b");
  state.handleKey("\x0b");
  assert.equal(killed, 2);
});

test("overlay: a browser kill is reflected without a further key press (specs/task-browser.md#kill-key)", async () => {
  const root = reg();
  const row = addAgent(root, "victim");
  row.cancel = () => root.settle(row, { status: "cancelled", result: "Command killed" });
  let renders = 0;
  const overlay = new TaskBrowserOverlay({
    registry: root,
    zone: "UTC",
    tui: {
      requestRender: () => {
        renders++;
      },
      terminal: { rows: 8 },
    },
    theme: identityTheme,
    shortcut: "alt+t",
    readSession: () => undefined,
    done: () => undefined,
  });
  overlay.handleInput("\r");
  overlay.handleInput("\x0b");
  overlay.handleInput("\x0b");
  await Promise.resolve();
  const page = overlay.render(80);
  assert.match(at(page, 0), new RegExp(`^Task ${row.taskId} · agent · cancelled · `));
  assert.equal(page.at(-1), "↑↓ select · g/G top/bottom · enter expand · e/c all · esc back");
  assert.ok(renders > 0, "the registry change requested a render");
  overlay.dispose();
});

test("kill key: a background kill is delivered as the completion notification naming the user (specs/task-browser.md#kill-key)", () => {
  const messages: string[] = [];
  const root = new TaskRegistry(
    () =>
      ({
        notify: (message: string) => {
          messages.push(message);
        },
      }) as unknown as HostSession,
  );
  const row = root.register({ kind: "script", cohort: "c", label: "watcher", background: true });
  row.cancel = () => root.settle(row, { status: "cancelled", result: "cancelled" });
  const state = browser({ registry: root, height: () => 8, theme: identityTheme });
  state.render(80);
  state.handleKey("\r");
  state.handleKey("\x0b");
  assert.deepEqual(messages, [], "the first press delivers nothing");
  assert.equal(row.consumed, false);
  state.handleKey("\x0b");
  assert.equal(row.status, "cancelled");
  assert.deepEqual(messages, [
    `Background tasks settled:\n${root.listLine(row)} · killed by the user from the task browser`,
  ]);
  assert.equal(row.consumed, true, "the completion notification consumes the row");
});

test("kill key: a child session's foreground bash is cancelled and the child goes on (specs/task-browser.md#kill-key)", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-browser-"));
  const messages: string[] = [];
  const host = {
    cwd: () => root,
    sessionId: () => "child-session",
    sessionFile: () => undefined,
    sessionDir: () => root,
    model: () => undefined,
    thinking: () => undefined,
    activeTools: () => ["Bash"],
    inventory: () => [],
    configuredModels: () => [],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: (message: string) => {
      messages.push(message);
    },
  } as unknown as HostSession;
  try {
    const main = reg();
    const parent = addAgent(main, "worker");
    const child = new TaskRegistry(() => host);
    main.attach(parent, child);
    const agentDir = join(root, "agent");
    const tool = makeBashTool({
      registry: () => child,
      hostProvider: () => host,
      cohortFor: (id: string) => `cohort-${id}`,
      agentDir: () => agentDir,
      settings: () => ({}),
    });

    // A foreground bash call of the child session, stuck in its shell.
    const pending = tool.execute(
      "call-1",
      { command: "sleep 5" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    const stuck = at(child.list(), 0);
    assert.equal(stuck.status, "running");

    const state = browser({ registry: main, height: () => 10, theme: identityTheme });
    state.render(80);
    // The list opens on the last row, the child's bash task.
    state.handleKey("\r");
    assert.match(at(state.render(80), 0), / · bash · running · /);
    assert.equal(state.render(80).at(-1), "↑↓ scroll · g/G top/bottom · ctrl+k kill · esc back");
    state.handleKey("\x0b");
    state.handleKey("\x0b");

    const result = await pending;
    assert.equal(result.isError, true);
    assert.ok(
      textOf(result).endsWith("Command killed by the user from the task browser"),
      textOf(result),
    );
    assert.equal(stuck.status, "cancelled");
    assert.equal(stuck.browserKill, true);
    assert.equal(
      stuck.result,
      "Command killed by the user from the task browser",
      "the row carries the same text the child's tool call returned",
    );

    // The child session goes on with its turn: its next foreground call runs.
    const next = await tool.execute(
      "call-2",
      { command: "echo after" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(next.isError, undefined);
    assert.equal(textOf(next), "after");
    assert.equal(child.live, true);

    // A background task of the child is delivered to the child's own conversation.
    const watcher = child.register({
      kind: "script",
      cohort: "c2",
      label: "watcher",
      background: true,
    });
    watcher.cancel = () => child.settle(watcher, { status: "cancelled", result: "cancelled" });
    state.handleKey("\x1b");
    state.render(80);
    state.handleKey("G");
    state.handleKey("\r");
    assert.equal(state.render(80).at(-1), "↑↓ scroll · g/G top/bottom · ctrl+k kill · esc back");
    state.handleKey("\x0b");
    state.handleKey("\x0b");
    assert.deepEqual(messages, [
      `Background tasks settled:\n${child.listLine(watcher)} · killed by the user from the task browser`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The single text block of a tool result. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = at(result.content, 0);
  return first.type === "text" ? (first.text ?? "") : "";
}
