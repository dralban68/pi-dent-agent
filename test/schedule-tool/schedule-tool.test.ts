import { Value } from "typebox/value";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import type { ToolResult } from "../../lib/engine.ts";
import { SCHEDULE_ACTIONS, scheduleParameterSchema } from "../../lib/schedule-tool.ts";
import { localStamp } from "../../lib/schedule-time.ts";
import { isPlainObject } from "../../lib/util.ts";
import {
  fixture,
  listed,
  SESSION,
  START,
  ZONE,
  textOf,
  toolContext,
  type Fixture,
} from "./harness.ts";

const specPath = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "specs",
  "schedule-tool.md",
);
const spec = readFileSync(specPath, "utf8");

/** The body of the first fenced `text` block after `marker`. */
function blockAfter(marker: string): string {
  const from = spec.indexOf(marker);
  assert.equal(from >= 0, true, marker);
  const open = spec.indexOf("```text\n", from);
  const close = spec.indexOf("\n```", open);
  assert.equal(open >= 0 && close > open, true, marker);
  return spec.slice(open + "```text\n".length, close);
}

function idOf(result: ToolResult): string {
  const id = result.details.scheduleId;
  if (typeof id !== "string") throw new Error("the result carries no schedule ID");
  return id;
}

test("Section 1: the tool is Schedule and its description is the text of Section 1", (t) => {
  const { tool } = fixture();
  assert.equal(tool.name, "Schedule");
  assert.equal(tool.label, "Schedule");
  assert.equal(tool.description, blockAfter("The tool `description` MUST be exactly:"));
  t.diagnostic(tool.description);
});

test("Section 1.1: the schema is an object with only action required", () => {
  const raw: Record<string, unknown> = JSON.parse(JSON.stringify(scheduleParameterSchema));
  assert.equal(raw.type, "object");
  assert.equal(raw.additionalProperties, false);
  assert.deepEqual(raw.required, ["action"]);
  const schema = scheduleParameterSchema;
  assert.deepEqual([...SCHEDULE_ACTIONS], ["create", "list", "cancel"]);
  const properties = schema.properties;
  assert.equal(properties.action.type, "string");
  assert.deepEqual(properties.action.enum, ["create", "list", "cancel"]);
  const declared: Record<string, unknown> = JSON.parse(JSON.stringify(properties));
  const branches = (field: string): unknown[] => {
    const entry = declared[field];
    if (!isPlainObject(entry) || !Array.isArray(entry.anyOf)) throw new Error(field);
    return entry.anyOf;
  };
  const types = [
    ["message", "string"],
    ["delaySeconds", "number"],
    ["at", "string"],
    ["everySeconds", "number"],
    ["count", "number"],
    ["scheduleId", "string"],
  ] as const;
  for (const [field, type] of types) {
    assert.deepEqual(branches(field), [{ type }, { type: "null" }], field);
  }
});

test("Section 3.1: create with delaySeconds returns one line and its details", () => {
  const { call } = fixture();
  const result = call({ action: "create", message: "ping", delaySeconds: 60 });
  assert.equal(result.isError, undefined);
  const id = idOf(result);
  assert.match(id, /^[0-9a-f]{8}$/);
  const text = textOf(result);
  assert.ok(!text.includes("\n"));
  assert.equal(
    text,
    `Schedule ${id} created at ${localStamp(START, ZONE)}, due ${localStamp(START + 60_000, ZONE)}; its message will be inserted into this session when due, queued as a follow-up if an agent run is in progress.`,
  );
  assert.deepEqual(result.details, {
    action: "create",
    scheduleId: id,
    createdAt: START,
    dueAt: START + 60_000,
  });
});

test("Section 3.1: the repeat clause of a repeating schedule", () => {
  const { call } = fixture();
  const plain = call({ action: "create", message: "tick", everySeconds: 30 });
  assert.match(
    textOf(plain),
    new RegExp(
      `, due ${localStamp(START + 30_000, ZONE).replaceAll("+", "\\+")}, repeating every 30 s; its message`,
    ),
  );
  assert.deepEqual(plain.details, {
    action: "create",
    scheduleId: idOf(plain),
    createdAt: START,
    dueAt: START + 30_000,
    everySeconds: 30,
  });
  const counted = call({ action: "create", message: "tick", everySeconds: 30, count: 3 });
  assert.match(textOf(counted), /, repeating every 30 s for 3 occurrences; its message/);
  assert.deepEqual(counted.details, {
    action: "create",
    scheduleId: idOf(counted),
    createdAt: START,
    dueAt: START + 30_000,
    everySeconds: 30,
    count: 3,
  });
});

test("Section 2.1: an at instant sets the due time, the later of it and the call", () => {
  const later = fixture();
  const future = new Date(START + 120_000).toISOString();
  const next = later.call({ action: "create", message: "late", at: future });
  assert.equal(next.details.dueAt, START + 120_000);

  const past = fixture();
  const earlier = past.call({ action: "create", message: "now", at: "2020-01-01T00:00:00Z" });
  assert.equal(earlier.details.dueAt, START);
});

test("Section 3.2: the message is kept verbatim and previewed by its first line", () => {
  const { call } = fixture();
  const message = "/deploy now\nsecond line";
  const created = call({ action: "create", message, delaySeconds: 10 });
  const id = idOf(created);
  const listedSchedules = listed(call({ action: "list" }));
  assert.equal(listedSchedules.length, 1);
  const only = listedSchedules[0];
  assert.ok(only);
  assert.equal(only.message, message);
  assert.equal(
    textOf(call({ action: "list" })),
    `${id} · due ${localStamp(START + 10_000, ZONE)} · /deploy now`,
  );
});

test("Section 3.2: a preview is cut to 120 characters with no marker", () => {
  const { call } = fixture();
  const message = "x".repeat(200);
  call({ action: "create", message, delaySeconds: 10 });
  const text = textOf(call({ action: "list" }));
  assert.equal(text.split(" · ").at(-1), "x".repeat(120));
});

test("Section 3.2: list with no pending schedule", () => {
  const { call } = fixture();
  const result = call({ action: "list" });
  assert.equal(textOf(result), "(no pending schedules)");
  assert.deepEqual(result.details, { action: "list", schedules: [] });
});

test("Section 2.1: pending schedules are ordered by dueAt, ties by creation order", () => {
  const { call } = fixture();
  const first = idOf(call({ action: "create", message: "a", delaySeconds: 30 }));
  const second = idOf(call({ action: "create", message: "b", delaySeconds: 10 }));
  const third = idOf(call({ action: "create", message: "c", delaySeconds: 10 }));
  const listedSchedules = listed(call({ action: "list" }));
  assert.deepEqual(
    listedSchedules.map((schedule) => schedule.scheduleId),
    [second, third, first],
  );
  const lines = textOf(call({ action: "list" })).split("\n");
  assert.deepEqual(
    lines.map((line) => line.split(" ")[0]),
    [second, third, first],
  );
});

test("Section 2.1: schedule IDs have 8 lowercase hexadecimal digits and stay unique", () => {
  const { call, callIn } = fixture();
  const ids = new Set<string>();
  for (let index = 0; index < 60; index += 1) {
    const result =
      index % 2 === 0
        ? call({ action: "create", message: `m${index}`, delaySeconds: 10 })
        : callIn("session-2", { action: "create", message: `m${index}`, delaySeconds: 10 });
    const id = idOf(result);
    assert.match(id, /^[0-9a-f]{8}$/);
    assert.ok(!ids.has(id), id);
    ids.add(id);
  }
});

test("Section 3.2: list details carry every field in the order of Section 2.1", () => {
  const { call } = fixture();
  const plain = call({ action: "create", message: "one", delaySeconds: 20 });
  const counted = call({
    action: "create",
    message: "two\nmore",
    everySeconds: 5,
    count: 2,
  });
  const repeating = call({ action: "create", message: "three", everySeconds: 7 });
  const listedSchedules = listed(call({ action: "list" }));
  assert.deepEqual(listedSchedules, [
    {
      scheduleId: idOf(counted),
      createdAt: START,
      dueAt: START + 5_000,
      message: "two\nmore",
      everySeconds: 5,
      count: 2,
      occurrences: 0,
      queued: false,
    },
    {
      scheduleId: idOf(repeating),
      createdAt: START,
      dueAt: START + 7_000,
      message: "three",
      everySeconds: 7,
      occurrences: 0,
      queued: false,
    },
    {
      scheduleId: idOf(plain),
      createdAt: START,
      dueAt: START + 20_000,
      message: "one",
      occurrences: 0,
      queued: false,
    },
  ]);
  const lines = textOf(call({ action: "list" })).split("\n");
  assert.equal(
    lines[0],
    `${idOf(counted)} · due ${localStamp(START + 5_000, ZONE)} · every 5 s · 0 fired of 2 · two`,
  );
  assert.equal(
    lines[1],
    `${idOf(repeating)} · due ${localStamp(START + 7_000, ZONE)} · every 7 s · 0 fired · three`,
  );
  assert.equal(lines[2], `${idOf(plain)} · due ${localStamp(START + 20_000, ZONE)} · one`);
});

test("Section 3.2: list changes no schedule", () => {
  const { call } = fixture();
  call({ action: "create", message: "one", everySeconds: 60, count: 4 });
  const before = listed(call({ action: "list" }));
  call({ action: "list" });
  assert.deepEqual(listed(call({ action: "list" })), before);
});

test("Section 3.3: cancel ends a pending schedule", () => {
  const { call } = fixture();
  const result = call({ action: "create", message: "one", delaySeconds: 10 });
  const id = idOf(result);
  const cancelled = call({ action: "cancel", scheduleId: id });
  assert.equal(cancelled.isError, undefined);
  assert.equal(textOf(cancelled), `Schedule ${id} cancelled.`);
  assert.deepEqual(cancelled.details, { action: "cancel", scheduleId: id });
  assert.deepEqual(listed(call({ action: "list" })), []);
});

test("Section 1.2: every check rejects with its error text and changes nothing", () => {
  const { call, callIn } = fixture();
  const kept = idOf(call({ action: "create", message: "keep", delaySeconds: 600 }));
  const elsewhere = idOf(
    callIn("session-2", { action: "create", message: "x", delaySeconds: 600 }),
  );
  const pending = (): Record<string, unknown>[] => listed(call({ action: "list" }));

  const cases: { params: Parameters<Fixture["call"]>[0]; error: string }[] = [
    {
      params: { action: "cancel", message: "x", scheduleId: kept },
      error: "message is not valid for action cancel",
    },
    {
      params: { action: "list", at: "2026-01-01T00:00:00Z" },
      error: "at is not valid for action list",
    },
    {
      params: { action: "create", message: "x", delaySeconds: 1, scheduleId: kept },
      error: "scheduleId is not valid for action create",
    },
    {
      params: { action: "list", at: "2026-01-01T00:00:00Z", scheduleId: "abc" },
      error: "at is not valid for action list",
    },
    {
      params: { action: "create", message: "x", delaySeconds: 10, count: 2 },
      error: "count requires everySeconds",
    },
    {
      params: { action: "create", message: "x", count: 2 },
      error: "create requires delaySeconds, at, or everySeconds",
    },
    { params: { action: "create", delaySeconds: 10 }, error: "message must be a non-empty string" },
    {
      params: { action: "create", message: "  ", delaySeconds: 10, at: "2027-01-01T00:00:00Z" },
      error: "message must be a non-empty string",
    },
    {
      params: { action: "create", message: "x", delaySeconds: 0, at: "2026-01-01T00:00:00Z" },
      error: "create accepts at most one of delaySeconds or at",
    },
    {
      params: { action: "create", message: "   ", delaySeconds: 10 },
      error: "message must be a non-empty string",
    },
    {
      params: { action: "create", message: "", delaySeconds: 10 },
      error: "message must be a non-empty string",
    },
    {
      params: { action: "create", message: "x", delaySeconds: 10, at: "2026-01-01T00:00:00Z" },
      error: "create accepts at most one of delaySeconds or at",
    },
    {
      params: { action: "create", message: "x" },
      error: "create requires delaySeconds, at, or everySeconds",
    },
    {
      params: { action: "create", message: "x", delaySeconds: 0 },
      error: "delaySeconds must be a positive integer",
    },
    {
      params: { action: "create", message: "x", delaySeconds: 1.5 },
      error: "delaySeconds must be a positive integer",
    },
    {
      params: { action: "create", message: "x", at: "tomorrow" },
      error: "at must be an RFC 3339 date-time with a time-zone offset",
    },
    {
      params: { action: "create", message: "x", at: "2026-01-01T00:00:00" },
      error: "at must be an RFC 3339 date-time with a time-zone offset",
    },
    {
      params: { action: "create", message: "x", everySeconds: 0 },
      error: "everySeconds must be a positive integer",
    },
    {
      params: { action: "create", message: "x", everySeconds: 5, count: 0 },
      error: "count must be a positive integer",
    },
    {
      params: { action: "create", message: "x", everySeconds: 5, count: 2.5 },
      error: "count must be a positive integer",
    },
    {
      params: { action: "create", message: "x", delaySeconds: 8_640_000_000_001 },
      error: "due time is not representable",
    },
    { params: { action: "cancel" }, error: "scheduleId must be a non-empty string" },
    {
      params: { action: "cancel", scheduleId: "  " },
      error: "scheduleId must be a non-empty string",
    },
    { params: { action: "cancel", scheduleId: "nope" }, error: 'no pending schedule "nope"' },
    {
      params: { action: "cancel", scheduleId: elsewhere },
      error: `no pending schedule "${elsewhere}"`,
    },
  ];
  const before = pending();
  for (const { params, error } of cases) {
    const result = call(params);
    assert.equal(result.isError, true, JSON.stringify(params));
    assert.equal(textOf(result), error, JSON.stringify(params));
    assert.deepEqual(pending(), before, JSON.stringify(params));
  }
  assert.deepEqual(
    pending().map((schedule) => schedule.scheduleId),
    [kept],
  );
});

test("Section 1.2: a cancelled schedule is no pending schedule", () => {
  const { call } = fixture();
  const id = idOf(call({ action: "create", message: "one", delaySeconds: 10 }));
  call({ action: "cancel", scheduleId: id });
  const result = call({ action: "cancel", scheduleId: id });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), `no pending schedule "${id}"`);
});

test("Section 3.3: the trimmed scheduleId names the schedule", () => {
  const { call } = fixture();
  const id = idOf(call({ action: "create", message: "one", delaySeconds: 10 }));
  const result = call({ action: "cancel", scheduleId: `  ${id}\n` });
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), `Schedule ${id} cancelled.`);
});

test("Section 3: the tool call runs against the session of its context", async () => {
  const { tool, call } = fixture();
  const context = toolContext(SESSION);
  const created = await tool.execute(
    "call-1",
    { action: "create", message: "from the tool", delaySeconds: 15 },
    undefined,
    undefined,
    context,
  );
  assert.equal(created.isError, undefined);
  assert.equal(listed(call({ action: "list" })).length, 1);

  const other = await tool.execute(
    "call-2",
    { action: "list" },
    undefined,
    undefined,
    toolContext("session-2"),
  );
  assert.equal(textOf(other), "(no pending schedules)");
});

test("Section 1.2: a field whose value is null counts as absent", () => {
  const { call } = fixture();
  const future = new Date(START + 90_000).toISOString();
  const created = call({
    action: "create",
    message: "x",
    delaySeconds: null,
    at: future,
    count: null,
    scheduleId: null,
  });
  assert.equal(created.isError, undefined);
  assert.equal(created.details.dueAt, START + 90_000);
  assert.deepEqual(Object.keys(created.details).toSorted(), [
    "action",
    "createdAt",
    "dueAt",
    "scheduleId",
  ]);
  assert.equal(
    textOf(call({ action: "list", message: null, scheduleId: null })).split("\n").length,
    1,
  );
  const cancelled = call({ action: "cancel", message: null, scheduleId: idOf(created) });
  assert.equal(cancelled.isError, undefined);
  const absent = call({ action: "cancel", scheduleId: null });
  assert.equal(absent.isError, true);
  assert.equal(textOf(absent), "scheduleId must be a non-empty string");
});

test("Section 1.1: the schema accepts null for every optional field", () => {
  for (const field of ["message", "delaySeconds", "at", "everySeconds", "count", "scheduleId"]) {
    assert.equal(
      Value.Check(scheduleParameterSchema, { action: "create", [field]: null }),
      true,
      `${field}: null`,
    );
    assert.equal(
      Value.Check(scheduleParameterSchema, { action: "create", [field]: [] }),
      false,
      `${field}: an array`,
    );
  }
  assert.equal(Value.Check(scheduleParameterSchema, { action: "list" }), true);
  assert.equal(Value.Check(scheduleParameterSchema, { action: "list", extra: 1 }), false);
});

test("Section 1.1: the schema rejects an action outside the three", () => {
  for (const params of [{ action: "update" }, {}, { action: 3 }]) {
    assert.equal(Value.Check(scheduleParameterSchema, params), false, JSON.stringify(params));
  }
});
