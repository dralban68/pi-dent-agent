import assert from "node:assert/strict";
import test from "node:test";
import { ProgressLines, killTreeWindows } from "../../lib/tool-common.ts";

test("progress lines: an entry keeps a long line's first 500 code points and its length", () => {
  const lines = new ProgressLines();
  assert.deepEqual(lines.push(""), [], "no chunk, no entry");
  assert.equal(lines.last(), undefined, "nothing pending yet");
  // The line's parts arrive in whatever chunks the worker posts, across streams.
  assert.deepEqual(lines.push("a".repeat(490) + "b".repeat(30)), [], "no newline, no entry");
  assert.deepEqual(lines.push("c\n"), [
    "a".repeat(490) + "b".repeat(10) + " … [21 characters omitted]",
  ]);
  assert.equal(lines.last(), undefined);
  assert.deepEqual(lines.push("d\n\n"), ["d", ""], "a final newline starts no further line");
  assert.deepEqual(lines.push("tail\nrest"), ["tail"]);
  assert.equal(lines.last(), "rest");
});

test("progress lines: the pending line is bounded, so a chunk costs O(chunk)", () => {
  // 1 MiB of one unterminated line in 20-byte chunks: rescanning the pending
  // line per chunk would burn seconds of host CPU here (Section 4's O(chunk)
  // bound, by script-tool.md Section 6). The bound is wide: the cost is a few
  // tens of milliseconds when the line is kept bounded and seconds when it is not.
  const size = 20;
  const chunks = 52428;
  const lines = new ProgressLines();
  const before = process.cpuUsage();
  for (let n = 0; n < chunks; n++) lines.push("a".repeat(size));
  const used = process.cpuUsage(before);
  const cpuMs = (used.user + used.system) / 1000;
  assert.ok(cpuMs < 1000, `${chunks} chunks of ${size} bytes took ${Math.round(cpuMs)} ms of CPU`);
  assert.equal(
    lines.last(),
    "a".repeat(500) + ` … [${chunks * size - 500} characters omitted]`,
    "the entry is the line's first 500 code points and its cut note",
  );
});

test(
  "killTreeWindows: a taskkill that cannot start does not escape as an uncaught exception",
  { skip: process.platform === "win32" ? "taskkill exists on Windows" : false },
  async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      killTreeWindows(process.pid);
      await new Promise((res) => setTimeout(res, 300));
      assert.deepEqual(uncaught, [], `no uncaught exception: ${String(uncaught[0])}`);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  },
);
