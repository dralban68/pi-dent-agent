import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentTaskRow, TaskRegistry } from "../../lib/registry.ts";
import { rewriteSettledRecord, writeRunningRecord } from "../../lib/task-record.ts";
import { rebuildInterruptedTasks } from "../../lib/task-rebuild.ts";
import { makeTaskTool } from "../../lib/tools.ts";

/** Task `read` per specs/task-tool.md#read. */

const reg = () => new TaskRegistry(() => undefined);

/** An interrupted background `agent` row as a rebuild inserts it. */
function interruptedRow(taskId: string): AgentTaskRow {
  const row = new AgentTaskRow({
    taskId,
    cohort: "c",
    label: "stuck",
    background: true,
    startedAt: 1_000,
  });
  row.status = "interrupted";
  row.settledAt = 6_000;
  return row;
}

/** Rebuild a settled row from a record, as a session reload leaves it. */
function rebuiltSettledRow(resultPath?: string): { registry: TaskRegistry; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "task-tool-read-"));
  const path = writeRunningRecord(dir, {
    taskId: "abcd0001",
    agent: "agent-a",
    label: "a label",
    cohort: "c",
    startedAt: 1_000,
    sessionPath: join(dir, "agent-a-abcd0001.jsonl"),
  });
  rewriteSettledRecord(path, {
    status: "completed",
    settledAt: 2_000,
    ...(resultPath === undefined ? {} : { resultPath }),
  });
  const registry = new TaskRegistry(() => undefined);
  rebuildInterruptedTasks(registry, dir, 5_000);
  return { registry, dir };
}

/** The text of a read result. */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

/** A settled `bash` row whose result carries its header line (specs/bash-tool.md#output-capture). */
function bashRowWithHeader(
  resultPath: string,
  lines: string[],
): { registry: TaskRegistry; taskId: string } {
  const registry = reg();
  const row = registry.register({ kind: "bash", cohort: "c", label: "emit", background: true });
  registry.settle(row, { status: "completed", result: lines.join("\n"), resultPath });
  return { registry, taskId: row.taskId };
}

test("read of an agent row whose result quotes a header keeps its own path and cuts the quoted line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-tool-quoted-"));
  try {
    const resultPath = join(dir, "REAL.result.md");
    const quoted = `[The output's end is shown (2 lines, 9 bytes), long lines cut to their last 500 characters; full output: ${join(dir, "other", "x.log")}. Search it with rg or Read it.]`;
    const registry = reg();
    const row = registry.register({
      kind: "agent",
      cohort: "c",
      label: "quoted",
      background: true,
    });
    registry.settle(row, {
      status: "completed",
      result: ["head", quoted, "tail"].join("\n"),
      resultPath,
    });
    const tool = makeTaskTool({ registry: () => registry });
    const read = await tool.execute(
      "tc",
      { action: "read", taskId: row.taskId } as never,
      undefined,
      undefined,
      undefined as never,
    );
    const lines = textOf(read).split("\n");
    // A quoted header is no exemption: it is cut like any other line (specs/task-tool.md#read).
    assert.equal(lines[1]?.length, 120, textOf(read));
    assert.equal(lines[1], quoted.slice(0, 120), textOf(read));
    // The row's own path is still named.
    assert.equal(lines.at(-1), `Full output: ${resultPath}`, textOf(read));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read of a script row cuts a long line that begins like a marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-tool-quoted-"));
  try {
    const resultPath = join(dir, "REAL.result.md");
    const long = `[Lines 1–1 of 2 not shown; ${"x".repeat(5000)}]`;
    const registry = reg();
    const row = registry.register({
      kind: "script",
      cohort: "c",
      label: "quoted",
      background: true,
    });
    registry.settle(row, { status: "completed", result: long, resultPath });
    const tool = makeTaskTool({ registry: () => registry });
    const read = await tool.execute(
      "tc",
      { action: "read", taskId: row.taskId } as never,
      undefined,
      undefined,
      undefined as never,
    );
    const lines = textOf(read).split("\n");
    assert.equal(lines[0]?.length, 120, textOf(read));
    assert.equal(lines.at(-1), `Full output: ${resultPath}`, textOf(read));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read of a script row keeps its own tool-calls line whole and cuts another row's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-tool-log-line-"));
  try {
    const resultPath = join(dir, "output", "x.log");
    const registry = reg();
    const row = registry.register({ kind: "script", cohort: "c", label: "s", background: true });
    const own = `--- tool calls: 2; log: ${join(dir, "a".repeat(150), "script-x.jsonl")}; Search it with session ${row.taskId} ---`;
    const other = `--- tool calls: 2; log: ${join(dir, "a".repeat(150), "script-y.jsonl")}; Search it with session zzzz0000 ---`;
    registry.settle(row, {
      status: "completed",
      result: ["--- exited ok in 5ms ---", own, other].join("\n"),
      resultPath,
    });
    const tool = makeTaskTool({ registry: () => registry });
    const read = await tool.execute(
      "tc",
      { action: "read", taskId: row.taskId } as never,
      undefined,
      undefined,
      undefined as never,
    );
    const lines = textOf(read).split("\n");
    assert.equal(lines[1], own, textOf(read));
    assert.equal(lines[2], other.slice(0, 120), textOf(read));
    assert.equal(lines.at(-1), `Full output: ${resultPath}`, textOf(read));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read of a settled row returns the header line whole, with no Full output line repeating it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-tool-header-"));
  try {
    const resultPath = join(dir, "output", `${"p".repeat(140)}.log`);
    const header = `[Line 1 of 3 not shown; full output: ${resultPath}. Search it with rg or Read it.]`;
    const { registry, taskId } = bashRowWithHeader(resultPath, [
      header,
      `${"y".repeat(250)}`,
      "tail",
    ]);
    const tool = makeTaskTool({ registry: () => registry });
    const read = await tool.execute(
      "tc",
      { action: "read", taskId } as never,
      undefined,
      undefined,
      undefined as never,
    );
    const lines = textOf(read).split("\n");
    // The header's own text names the file, so the path is not repeated (specs/task-tool.md#read).
    assert.equal(lines[0], header, textOf(read));
    assert.equal(lines.filter((line) => line.startsWith("Full output: ")).length, 0, textOf(read));
    // Every other line is still cut to 120 characters.
    assert.equal(lines[1]?.length, 120, textOf(read));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read of a settled row keeps the cut-and-omitted header whole in the first group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-tool-header-"));
  try {
    const resultPath = join(dir, "output", `${"p".repeat(140)}.log`);
    const header = `[Lines 1–9 of 30 not shown, long lines cut to their last 500 characters; full output: ${resultPath}. Search it with rg or Read it.]`;
    const { registry, taskId } = bashRowWithHeader(resultPath, [
      header,
      ...Array.from({ length: 29 }, (_, i) => `l${i + 1}`),
    ]);
    const tool = makeTaskTool({ registry: () => registry });
    const read = await tool.execute(
      "tc",
      { action: "read", taskId } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(textOf(read).split("\n")[0], header, textOf(read));
    assert.equal(textOf(read).includes("[... 10 lines omitted ...]"), true, textOf(read));
    assert.equal(
      textOf(read)
        .split("\n")
        .filter((line) => line.startsWith("Full output: ")).length,
      0,
      textOf(read),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read of a rebuilt settled row previews the spill file, not empty text", async () => {
  const spill = mkdtempSync(join(tmpdir(), "task-tool-spill-"));
  const resultPath = join(spill, "abcd0001.result.md");
  writeFileSync(resultPath, "line one\nline two\n");
  const { registry, dir } = rebuiltSettledRow(resultPath);
  const tool = makeTaskTool({ registry: () => registry });
  const result = await tool.execute(
    "tc",
    { action: "read", taskId: "abcd0001" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    `line one\nline two\n\nFull output: ${resultPath}`,
  );
  assert.equal(registry.get("abcd0001")?.consumed, true);
  rmSync(dir, { recursive: true, force: true });
  rmSync(spill, { recursive: true, force: true });
});

test("read of a rebuilt settled row without a spill file says the result was not retained", async () => {
  const { registry, dir } = rebuiltSettledRow();
  const tool = makeTaskTool({ registry: () => registry });
  const result = await tool.execute(
    "tc",
    { action: "read", taskId: "abcd0001" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    "(result not retained; resume with Agent resume=abcd0001)",
  );
  assert.equal(registry.get("abcd0001")?.consumed, true);
  rmSync(dir, { recursive: true, force: true });
});

test("read of a settled row without a result file returns its result verbatim and no resultPath", async () => {
  const registry = reg();
  const row = registry.register({ kind: "script", cohort: "c", label: "done", background: true });
  registry.settle(row, { status: "failed", result: "line one\nline two" });
  const tool = makeTaskTool({ registry: () => registry });
  const result = await tool.execute(
    "tc",
    { action: "read", taskId: row.taskId } as never,
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(textOf(result), "line one\nline two");
  assert.deepEqual(result.details, {
    action: "read",
    taskId: row.taskId,
    status: "failed",
  });
  assert.equal(row.consumed, true);
});

test("read details carry the resultPath of a row that has one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-tool-details-"));
  try {
    const resultPath = join(dir, "out.result.md");
    writeFileSync(resultPath, "only line\n");
    const registry = reg();
    const row = registry.register({ kind: "bash", cohort: "c", label: "emit", background: true });
    registry.settle(row, { status: "completed", result: "only line", resultPath });
    const tool = makeTaskTool({ registry: () => registry });
    const result = await tool.execute(
      "tc",
      { action: "read", taskId: row.taskId } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.deepEqual(result.details, {
      action: "read",
      taskId: row.taskId,
      status: "completed",
      resultPath,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read of a rebuilt row whose result file is unreadable is a tool error and consumes nothing", async () => {
  const missing = mkdtempSync(join(tmpdir(), "task-tool-missing-"));
  try {
    const resultPath = join(missing, "gone.result.md");
    const { registry, dir } = rebuiltSettledRow(resultPath);
    try {
      const tool = makeTaskTool({ registry: () => registry });
      const result = await tool.execute(
        "tc",
        { action: "read", taskId: "abcd0001" } as never,
        undefined,
        undefined,
        undefined as never,
      );
      // The path and the read's own error are named (specs/task-tool.md#read).
      assert.equal(result.isError, true);
      const text = textOf(result);
      assert.ok(text.startsWith(`cannot read the result file ${resultPath}: `), text);
      assert.match(text, /ENOENT/);
      assert.equal(registry.get("abcd0001")?.consumed, false, "the row is not consumed");
      assert.equal(existsSync(join(dir, "abcd0001.task.json")), true, "the record survives");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }
});

test("read of an interrupted row returns the resume line and never consumes it", async () => {
  const registry = reg();
  const row = interruptedRow("aaaa0001");
  registry.rebuild([row]);
  const tool = makeTaskTool({ registry: () => registry });
  for (let call = 0; call < 2; call++) {
    const result = await tool.execute(
      "tc",
      { action: "read", taskId: "aaaa0001" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      "(interrupted, resume with Agent resume=aaaa0001)",
    );
    assert.deepEqual(result.details, {
      action: "read",
      taskId: "aaaa0001",
      status: "interrupted",
    });
    assert.equal(row.consumed, false);
  }
});
