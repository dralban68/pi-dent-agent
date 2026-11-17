import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CapturedOutput,
  DEFAULT_TIMEOUT_MS,
  formatBashOutcome,
  statusLine,
  taskStatusOf,
  type BashRunOutcome,
} from "../../lib/bash-tool.ts";

const OUTPUT = "/tmp/sessions/s.agents/output/task.log";

function captured(...chunks: string[]): CapturedOutput {
  const output = new CapturedOutput();
  for (const chunk of chunks) output.append(chunk, Buffer.byteLength(chunk));
  return output;
}

function outcome(exitReason: BashRunOutcome["exitReason"], rest: Partial<BashRunOutcome> = {}) {
  return { exitReason, leftover: false, durationMs: 0, ...rest } satisfies BashRunOutcome;
}

test("lines: a final newline ends the last line and starts no further one", () => {
  for (const [text, count] of [
    ["a\nb\n", 2],
    ["a\nb", 2],
    ["a\n", 1],
    ["\n", 1],
    ["", 0],
    ["a\n\nb", 3],
  ] as const) {
    assert.equal(captured(text).lineCount(), count);
  }
});

test("progress: one line per newline, plus the unterminated last line at the end", () => {
  const output = new CapturedOutput();
  assert.deepEqual(output.append("a\nb", 3), ["a"]);
  assert.equal(output.pending(), "b");
  assert.deepEqual(output.append("c\nd\n", 5), ["bc", "d"]);
  assert.equal(output.pending(), undefined);
  assert.deepEqual(output.append("", 0), []);
});

test("progress: entries drop one final CR, and the cut counts display text", () => {
  const output = new CapturedOutput();
  assert.deepEqual(output.append("a\r\nb\r\r\n\r\n", 9), ["a", "b\r", ""]);
  assert.deepEqual(output.append("x".repeat(500) + "\r\n", 502), ["x".repeat(500)]);
  assert.deepEqual(output.append("y".repeat(501) + "\r\n", 503), [
    "y".repeat(500) + " … [1 character omitted]",
  ]);
  output.append("z\r", 2);
  assert.equal(output.pending(), "z");
});

test("status lines and task status: every exitReason row", () => {
  const rows = [
    [outcome("exited", { exitCode: 0 }), "completed", undefined],
    [outcome("exited", { exitCode: 2 }), "failed", "Command exited with code 2"],
    [outcome("exited", { exitCode: 130 }), "failed", "Command exited with code 130"],
    [outcome("timeout"), "failed", "Command timed out after 7 ms"],
    [outcome("aborted"), "cancelled", "Command aborted"],
    [outcome("killed"), "cancelled", "Command killed"],
    [
      outcome("spawn-failed", { message: "spawn EACCES" }),
      "failed",
      "Command failed to start: spawn EACCES",
    ],
  ] as const;
  for (const [value, status, line] of rows) {
    assert.equal(statusLine(value, 7), line);
    assert.equal(taskStatusOf(value), status);
  }
});

test("body: excerpt precedes status and leftover notices", () => {
  const formatted = formatBashOutcome(
    outcome("exited", { exitCode: 1, leftover: true, durationMs: 12 }),
    captured("hi\n"),
    OUTPUT,
    1000,
    "echo hi",
  );
  assert.equal(
    formatted.body,
    "hi\n\nCommand exited with code 1\n\nCommand left a process running; it was terminated. Use background: true, not & or nohup.",
  );
  assert.equal(formatted.isError, true);
  assert.deepEqual(formatted.details, {
    exitReason: "exited",
    exitCode: 1,
    truncated: false,
    leftover: true,
    outputPath: OUTPUT,
    durationMs: 12,
  });
});

test("body: truncated excerpts start with the header and join status and leftover notices with exactly one empty line", () => {
  const leftover =
    "Command left a process running; it was terminated. Use background: true, not & or nohup.";
  const repeated = Array.from({ length: 50 }, () => "x").join("\n");
  const cases = [
    {
      text: "x".repeat(501),
      excerpt:
        `[The output's end is shown (1 line, 501 bytes), long lines cut to their last 500 characters; full output: ${OUTPUT}. Search it with rg or Read it.]\n` +
        "… " +
        "x".repeat(500),
    },
    {
      text: "x\n".repeat(51),
      excerpt:
        `[Line 1 of 51 not shown; full output: ${OUTPUT}. Search it with rg or Read it.]\n` +
        repeated,
    },
  ];
  for (const row of cases) {
    const result = formatBashOutcome(
      outcome("exited", { exitCode: 1, leftover: true }),
      captured(row.text),
      OUTPUT,
      undefined,
      "node emit.js",
    );
    assert.equal(result.body, row.excerpt + "\n\nCommand exited with code 1\n\n" + leftover);
    assert.equal(result.details.truncated, true);
  }
});

test("status line: a browser kill names the user", () => {
  assert.equal(
    statusLine(outcome("killed"), 7, true),
    "Command killed by the user from the task browser",
  );
  assert.equal(statusLine(outcome("aborted"), 7, true), "Command aborted");
});

test("body: a defaulted timeout reports 600000 ms", () => {
  const result = formatBashOutcome(
    outcome("timeout"),
    captured(""),
    OUTPUT,
    DEFAULT_TIMEOUT_MS,
    "sleep 9",
  );
  assert.equal(result.body, "Command timed out after 600000 ms");
  assert.equal(result.isError, true);
  assert.equal("exitCode" in result.details, false);
});

test("body: empty output and one empty line use the no-output fallback", () => {
  for (const text of ["", "\n"]) {
    const result = formatBashOutcome(
      outcome("exited", { exitCode: 0 }),
      captured(text),
      OUTPUT,
      undefined,
      "true",
    );
    assert.equal(result.body, "(no output)");
    assert.equal(result.details.truncated, false);
  }
});
