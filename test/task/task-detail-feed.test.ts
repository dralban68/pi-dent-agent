import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskRegistry } from "../../lib/registry.ts";
import {
  TASK_DETAIL_WIDGET_ID,
  type TaskDetailPayload,
  TaskDetailFeed,
} from "../../lib/task-detail-feed.ts";
import type { AgentTaskRow } from "../../lib/task-row.ts";
import { at, must } from "../support/must.ts";

/** Task detail feed conformance per specs/task.md#task-detail-feed and specs/task-browser.md#session-events. */

type Call = [string, string[] | undefined];

/** A host recording every `setWidget` call. */
function recorder() {
  const calls: Call[] = [];
  return {
    calls,
    host: {
      setWidget(key: string, lines: string[] | undefined) {
        calls.push([key, lines]);
      },
    },
  };
}

/** The payload of the last `pi-dent-task` set: exactly one JSON line. */
function lastPayload(calls: Call[]): TaskDetailPayload {
  const last = must(calls.at(-1));
  assert.equal(last[0], TASK_DETAIL_WIDGET_ID);
  const lines = must(last[1]);
  assert.equal(lines.length, 1);
  return JSON.parse(at(lines, 0)) as TaskDetailPayload;
}

/** A ticker whose timer the test fires by hand, counting starts and stops. */
function fakeTicker() {
  const ticker = {
    starts: 0,
    stops: 0,
    tick: undefined as (() => void) | undefined,
    start(tick: () => void): () => void {
      ticker.starts++;
      ticker.tick = tick;
      return () => {
        ticker.stops++;
        ticker.tick = undefined;
      };
    },
    fire(): void {
      ticker.tick?.();
    },
  };
  return ticker;
}

/** Session files by path, counting every read. */
function sessionFiles() {
  const files = new Map<string, string>();
  const reads = { count: 0 };
  return {
    files,
    reads,
    read(path: string): string | undefined {
      reads.count++;
      return files.get(path);
    },
  };
}

function setup(root = new TaskRegistry(() => undefined)) {
  const rec = recorder();
  const ticker = fakeTicker();
  const session = sessionFiles();
  const feed = new TaskDetailFeed({
    registry: root,
    host: rec.host,
    zone: "UTC",
    readSession: (path) => session.read(path),
    ticker,
  });
  return { root, rec, ticker, session, feed };
}

const ts = (n: number): string => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
const assistant = (n: number, text: string): string =>
  JSON.stringify({
    type: "message",
    timestamp: ts(n),
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const toolResult = (n: number, text: string, isError: boolean): string =>
  JSON.stringify({
    type: "message",
    timestamp: ts(n),
    message: { role: "toolResult", toolName: "bash", isError, content: text },
  });

function agent(root: TaskRegistry, label = "agent-a", background = true): AgentTaskRow {
  return root.register({ kind: "agent", cohort: "c", label, background });
}

test("watch sets pi-dent-task to one JSON line with the agent payload (specs/task.md#task-detail-feed)", () => {
  const { root, rec, session, feed } = setup();
  const a = root.register({
    kind: "agent",
    cohort: "c",
    label: "explore\x1b[31m docs",
    background: true,
    task: "find\tthe\x07 docs",
  });
  root.amend(a, { agent: "explorer", model: "anthropic/claude:high", sessionPath: "/s/a.jsonl" });
  session.files.set(
    "/s/a.jsonl",
    `${[assistant(1, "\nfirst line\nsecond"), toolResult(2, "ok", false)].join("\n")}\n`,
  );
  root.settle(a, { status: "failed", result: "boom\x1b[0m\nline2" });

  feed.watch(a.taskId);

  const p = lastPayload(rec.calls);
  assert.equal(p.piDent, "task/1");
  assert.equal(p.taskId, a.taskId);
  assert.equal(p.found, true);
  assert.equal(p.kind, "agent");
  assert.equal(p.background, true);
  assert.equal(p.orphan, false);
  assert.equal(p.status, "failed");
  assert.equal(typeof p.startedAt, "number");
  assert.equal(typeof p.settledAt, "number");
  assert.equal(p.label, "explore docs");
  assert.equal(p.killable, false);
  // `delivery` is not a field of the feed; the Agent section's other lines are.
  assert.deepEqual(
    p.fields?.map((field) => field.name),
    ["agent", "model", "started", "settled", "session"],
  );
  assert.equal(p.fields?.[0]?.value, "explorer");
  assert.equal(p.error, "boom\nline2");
  assert.equal(p.task, "find\tthe docs");
  assert.deepEqual(p.output, []);
  assert.deepEqual(p.events, [
    {
      time: ts(1),
      kind: "assistant",
      summary: "first line",
      content: "\nfirst line\nsecond",
      error: false,
    },
    { time: ts(2), kind: "result bash", summary: "ok", content: "ok", error: false },
  ]);
});

test("a failed tool result is an error event; an error is absent unless the row failed", () => {
  const { root, rec, session, feed } = setup();
  const a = agent(root);
  root.amend(a, { sessionPath: "/s/a.jsonl" });
  session.files.set("/s/a.jsonl", `${toolResult(1, "denied", true)}\n`);
  feed.watch(a.taskId);
  const p = lastPayload(rec.calls);
  assert.equal(p.events?.[0]?.error, true);
  assert.equal(p.error, undefined);
  assert.equal(p.task, undefined);
  assert.equal("error" in p, false);
});

test("events keep the latest 200 and each content at most 200 lines (specs/task.md#task-detail-feed)", () => {
  const { root, rec, session, feed } = setup();
  const a = agent(root);
  root.amend(a, { sessionPath: "/s/a.jsonl" });
  const lines: string[] = [];
  for (let n = 0; n < 249; n++) lines.push(assistant(n, `m${n}`));
  const long = Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n");
  lines.push(assistant(249, long));
  session.files.set("/s/a.jsonl", `${lines.join("\n")}\n`);
  feed.watch(a.taskId);
  const p = lastPayload(rec.calls);
  assert.equal(p.events?.length, 200);
  assert.equal(p.events?.[0]?.summary, "m50");
  const last = must(p.events?.at(-1));
  assert.equal(last.content.split("\n").length, 200);
  assert.equal(last.content.split("\n")[0], "row 0");
});

test("a text read from the file is stripped of control characters, not of tabs", () => {
  const { root, rec, session, feed } = setup();
  const a = agent(root);
  root.amend(a, { sessionPath: "/s/a.jsonl" });
  session.files.set("/s/a.jsonl", `${assistant(1, "a\tb\x01\x1b[2Jc")}\n`);
  feed.watch(a.taskId);
  const event = must(lastPayload(rec.calls).events?.[0]);
  assert.equal(event.content, "a\tbc");
  assert.equal(event.summary, "a\tbc");
});

test("a row the tree no longer holds is found once, with the fields it last had", () => {
  const { root, rec, feed } = setup();
  const parent = agent(root, "parent", false);
  const sub = new TaskRegistry(() => undefined);
  root.attach(parent, sub);
  const child = sub.register({ kind: "agent", cohort: "c", label: "child", background: true });
  sub.settle(child, { status: "completed" });
  sub.consume(child);
  feed.watch(child.taskId);
  assert.equal(lastPayload(rec.calls).found, true);
  // Ending the sub-registry drops its consumed settled row from the tree.
  sub.end();
  const p = lastPayload(rec.calls);
  assert.equal(p.found, true);
  assert.equal(p.taskId, child.taskId);
  assert.equal(p.status, "completed");
});

test("an unknown task is found:false and the payload has no other field", () => {
  const { rec, feed } = setup();
  feed.watch("nope");
  const raw = JSON.parse(at(must(must(rec.calls.at(-1))[1]), 0)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw).toSorted(), ["found", "piDent", "taskId"]);
  assert.equal(raw.found, false);
  assert.equal(raw.piDent, "task/1");
  assert.equal(raw.taskId, "nope");
});

test("a script row carries its output's latest 500 lines and no session events", () => {
  const { root, rec, ticker, session, feed } = setup();
  const s = root.register({ kind: "script", cohort: "c", label: "build", background: false });
  for (let n = 0; n < 600; n++) root.progress(s, `l${n}`);
  feed.watch(s.taskId);
  const p = lastPayload(rec.calls);
  assert.equal(p.kind, "script");
  assert.equal(p.output?.length, 500);
  assert.equal(p.output?.[0], "l100");
  assert.equal(p.output?.at(-1), "l599");
  assert.deepEqual(
    p.fields?.map((field) => field.name),
    ["label", "started"],
  );
  assert.equal(p.events?.length, 0);
  assert.equal(p.error, undefined);
  assert.equal(p.task, undefined);
  assert.equal(ticker.starts, 0);
  assert.equal(session.reads.count, 0);
});

test("a bash row has the Bash section fields and the same output cap", () => {
  const { root, rec, feed } = setup();
  const b = root.register({
    kind: "bash",
    cohort: "c",
    label: "ls -la",
    background: true,
    command: "ls -la\n\x1b[31mfind . -name '*.ts'\x1b[0m",
  });
  root.progress(b, "one");
  feed.watch(b.taskId);
  const p = lastPayload(rec.calls);
  assert.equal(p.kind, "bash");
  assert.equal(p.label, "ls -la");
  assert.equal(p.command, "ls -la\nfind . -name '*.ts'");
  assert.deepEqual(p.output, ["one"]);
  assert.deepEqual(
    p.fields?.map((field) => field.name),
    ["label", "started"],
  );
});

test("an agent and a script row carry no `command` (specs/task.md#task-detail-feed)", () => {
  const { root, rec, feed } = setup();
  feed.watch(agent(root).taskId);
  const a = at(must(must(rec.calls.at(-1))[1]), 0);
  assert.equal("command" in (JSON.parse(a) as Record<string, unknown>), false);
  const s = root.register({ kind: "script", cohort: "c", label: "build", background: false });
  feed.watch(s.taskId);
  const raw = at(must(must(rec.calls.at(-1))[1]), 0);
  assert.equal("command" in (JSON.parse(raw) as Record<string, unknown>), false);
});

test("a registry change that changes nothing of the watched task sets nothing", () => {
  const { root, rec, feed } = setup();
  const a = agent(root);
  feed.watch(a.taskId);
  const before = rec.calls.length;
  agent(root, "unrelated");
  assert.equal(rec.calls.length, before);
});

test("a registry change that changes the watched task's text sets the widget", () => {
  const { root, rec, feed } = setup();
  const a = agent(root);
  feed.watch(a.taskId);
  const before = rec.calls.length;
  root.amend(a, { label: "renamed" });
  assert.equal(rec.calls.length, before + 1);
  assert.equal(lastPayload(rec.calls).label, "renamed");
});

test("a running agent row is re-read on each tick, the widget set only on a change", () => {
  const { root, rec, ticker, session, feed } = setup();
  const a = agent(root);
  root.amend(a, { sessionPath: "/s/a.jsonl" });
  session.files.set("/s/a.jsonl", `${assistant(1, "one")}\n`);
  feed.watch(a.taskId);
  assert.equal(ticker.starts, 1);
  assert.equal(session.reads.count, 1);
  const afterWatch = rec.calls.length;

  ticker.fire();
  assert.equal(session.reads.count, 2);
  assert.equal(rec.calls.length, afterWatch, "an unchanged read sets nothing");

  session.files.set("/s/a.jsonl", `${assistant(1, "one")}\n${assistant(2, "two")}\n`);
  ticker.fire();
  assert.equal(session.reads.count, 3);
  assert.equal(rec.calls.length, afterWatch + 1);
  assert.equal(lastPayload(rec.calls).events?.length, 2);
});

test("a registry change while running sets the widget without a file read", () => {
  const { root, rec, session, feed } = setup();
  const a = agent(root);
  root.amend(a, { sessionPath: "/s/a.jsonl" });
  session.files.set("/s/a.jsonl", `${assistant(1, "one")}\n`);
  feed.watch(a.taskId);
  const reads = session.reads.count;
  root.amend(a, { label: "again" });
  assert.equal(session.reads.count, reads);
  assert.equal(lastPayload(rec.calls).label, "again");
});

test("settlement reads the file once, including a trailing line, then the timer stops", () => {
  const { root, rec, ticker, session, feed } = setup();
  const a = agent(root);
  root.amend(a, { sessionPath: "/s/a.jsonl" });
  session.files.set("/s/a.jsonl", `${assistant(1, "one")}\n`);
  feed.watch(a.taskId);
  const reads = session.reads.count;

  session.files.set("/s/a.jsonl", `${assistant(1, "one")}\n${assistant(2, "last")}`);
  root.settle(a, { status: "completed" });
  assert.equal(session.reads.count, reads + 1);
  assert.equal(ticker.stops, 1);
  assert.equal(lastPayload(rec.calls).events?.length, 2);
  assert.equal(lastPayload(rec.calls).status, "completed");

  ticker.fire();
  root.amend(a, { label: "after" });
  assert.equal(session.reads.count, reads + 1, "no read after settlement");
});

test("a settled agent row is read once on watch and never on a tick", () => {
  const { root, ticker, session, feed } = setup();
  const a = agent(root);
  root.amend(a, { sessionPath: "/s/a.jsonl" });
  root.settle(a, { status: "completed" });
  feed.watch(a.taskId);
  assert.equal(session.reads.count, 1);
  assert.equal(ticker.starts, 0);
  ticker.fire();
  assert.equal(session.reads.count, 1);
});

test("an unreadable session file yields no events and no failure", () => {
  const { root, rec, session, feed } = setup();
  const a = agent(root);
  root.amend(a, { sessionPath: "/s/missing.jsonl" });
  feed.watch(a.taskId);
  assert.deepEqual(lastPayload(rec.calls).events, []);
  assert.equal(session.reads.count, 1);
});

test("the kill verb is the confirming press: the row is cancelled and not consumed", () => {
  const { root, rec, feed } = setup();
  const a = agent(root);
  let cancelled = 0;
  a.cancel = () => {
    cancelled++;
  };
  feed.watch(a.taskId);
  assert.equal(lastPayload(rec.calls).killable, true);

  assert.equal(feed.kill(a.taskId), true);
  assert.equal(cancelled, 1);
  assert.equal(a.browserKill, true);
  assert.equal(a.consumed, false);
  assert.equal(a.status, "running", "the cancellation settles later, as the owner does");

  root.settle(a, { status: "cancelled" });
  const p = lastPayload(rec.calls);
  assert.equal(p.status, "cancelled");
  assert.equal(p.killable, false);
});

test("the kill verb reaches a child session's row through the holding registry", () => {
  const { root, feed } = setup();
  const parent = agent(root, "parent", false);
  const sub = new TaskRegistry(() => undefined);
  root.attach(parent, sub);
  const child = sub.register({ kind: "agent", cohort: "c", label: "child", background: true });
  let cancelled = 0;
  child.cancel = () => {
    cancelled++;
  };
  feed.watch(child.taskId);
  assert.equal(feed.kill(child.taskId), true);
  assert.equal(cancelled, 1);
  assert.equal(child.browserKill, true);
  assert.equal(child.consumed, false);
});

test("the kill verb refuses a settled, unknown, or unreachable row", () => {
  const { root, feed } = setup();
  const a = agent(root);
  let cancelled = 0;
  a.cancel = () => {
    cancelled++;
  };
  root.settle(a, { status: "completed" });
  assert.equal(feed.kill(a.taskId), false);
  assert.equal(feed.kill("nope"), false);
  assert.equal(cancelled, 0);
});

test("unwatch clears the widget, stops the timer, and ends the emissions", () => {
  const { root, rec, ticker, session, feed } = setup();
  const a = agent(root);
  root.amend(a, { sessionPath: "/s/a.jsonl" });
  feed.watch(a.taskId);
  assert.equal(ticker.starts, 1);

  feed.unwatch();
  assert.deepEqual(rec.calls.at(-1), [TASK_DETAIL_WIDGET_ID, undefined]);
  assert.equal(ticker.stops, 1);
  const calls = rec.calls.length;
  const reads = session.reads.count;
  ticker.fire();
  root.amend(a, { label: "quiet" });
  assert.equal(rec.calls.length, calls);
  assert.equal(session.reads.count, reads);
});

test("unwatch with nothing watched sets nothing", () => {
  const { rec, feed } = setup();
  feed.unwatch();
  assert.equal(rec.calls.length, 0);
});

test("watching another task replaces the first and restarts the timer rules", () => {
  const { root, rec, ticker, feed } = setup();
  const a = agent(root, "first");
  const b = root.register({ kind: "script", cohort: "c", label: "second", background: false });
  root.amend(a, { sessionPath: "/s/a.jsonl" });
  feed.watch(a.taskId);
  assert.equal(ticker.starts, 1);
  feed.watch(b.taskId);
  assert.equal(lastPayload(rec.calls).taskId, b.taskId);
  assert.equal(ticker.stops, 1);
  root.amend(a, { label: "first renamed" });
  assert.equal(lastPayload(rec.calls).taskId, b.taskId);
});

test("stop clears the widget, ends the watch and the timer, and ignores later calls", () => {
  const { root, rec, ticker, feed } = setup();
  const a = agent(root);
  root.amend(a, { sessionPath: "/s/a.jsonl" });
  feed.watch(a.taskId);
  feed.stop();
  assert.deepEqual(rec.calls.at(-1), [TASK_DETAIL_WIDGET_ID, undefined]);
  assert.equal(ticker.stops, 1);
  const calls = rec.calls.length;
  root.amend(a, { label: "after stop" });
  feed.watch(a.taskId);
  assert.equal(rec.calls.length, calls);
  assert.equal(feed.kill(a.taskId), false);
});

test("stop with nothing set clears nothing", () => {
  const { rec, feed } = setup();
  feed.stop();
  assert.equal(rec.calls.length, 0);
});

test("detail payload carries structured usage when present and omits it otherwise (specs/task.md#task-detail-feed)", () => {
  const { root, rec, feed } = setup();
  const a = agent(root, "worker");
  feed.watch(a.taskId);
  assert.equal(lastPayload(rec.calls).piDent, "task/1");
  assert.equal("usage" in lastPayload(rec.calls), false);

  const usage = {
    input: 900,
    output: 150,
    cacheRead: 200,
    cacheWrite: 50,
    cost: 0.0045,
    turns: 3,
  };
  root.amend(a, { usage });
  const after = lastPayload(rec.calls);
  assert.deepEqual(after.usage, usage);
  assert.ok(after.fields?.some((f) => f.name === "usage"));

  const b = root.register({ kind: "bash", cohort: "c", label: "ls", background: false });
  feed.watch(b.taskId);
  assert.equal("usage" in lastPayload(rec.calls), false);
  feed.stop();
});

test("detail payload carries toolCalls for an agent or script row and none for a bash row (specs/task.md#task-detail-feed)", () => {
  const { root, rec, feed } = setup();
  const a = agent(root, "worker");
  feed.watch(a.taskId);
  assert.equal(lastPayload(rec.calls).toolCalls, 0);
  root.amend(a, { toolCalls: 2 });
  assert.equal(lastPayload(rec.calls).toolCalls, 2);

  const s = root.register({ kind: "script", cohort: "c", label: "run", background: false });
  root.amend(s, { toolCalls: 4 });
  feed.watch(s.taskId);
  assert.equal(lastPayload(rec.calls).toolCalls, 4);

  const b = root.register({ kind: "bash", cohort: "c", label: "ls", background: false });
  feed.watch(b.taskId);
  assert.equal("toolCalls" in lastPayload(rec.calls), false);
  feed.stop();
});
