import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { call, detailsOf, makeFixture } from "../test/bash-tool/support.ts";

/**
 * The time bounds of the `Bash` tool's leftover termination against a real shell:
 * specs/bash-tool.md#execution-model (the first signal within 100 ms of the exit) and
 * specs/bash-tool.md#timeout-delivery (SIGKILL 200–300 ms after SIGTERM). Each test prints what
 * it measured. The behaviour on the same paths is in test/bash-tool/bash-tool.test.ts.
 */

// specs/bash-tool.md#execution-model: the first signal within 100 ms of the exit;
// specs/bash-tool.md#timeout-delivery: SIGKILL 200–300 ms after SIGTERM.
test("the first leftover signal follows the exit within 100 ms, the SIGKILL 200–300 ms later", async (t) => {
  const f = makeFixture();
  let polling = true;
  let observation: Promise<void> | undefined;
  try {
    const term = join(f.root, "term");
    const kill = join(f.root, "kill");
    // Two group members write a counter every 10 ms: the first dies on SIGTERM,
    // the second ignores it and dies on the SIGKILL. The shell exits only once
    // both have written, so the second has installed its trap.
    const command = [
      `( i=0; while :; do i=$((i+1)); echo $i > ${term}; sleep 0.01; done ) >/dev/null 2>&1 &`,
      `( trap '' TERM; j=0; while :; do j=$((j+1)); echo $j > ${kill}; sleep 0.01; done ) >/dev/null 2>&1 &`,
      `until [ -s ${term} ] && [ -s ${kill} ]; do sleep 0.01; done`,
      // Observe several counter changes before the shell exits.
      "sleep 0.5",
      "echo hi",
    ].join("\n");
    const readOr = (path: string): string => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };
    const last = new Map<string, number>([
      [term, 0],
      [kill, 0],
    ]);
    const seen = new Map<string, string>([
      [term, ""],
      [kill, ""],
    ]);
    let exitAt = Infinity;
    let cadence = 0;
    observation = (async () => {
      while (polling && Date.now() < exitAt + 700 + 2 * cadence) {
        for (const path of [term, kill]) {
          const content = readOr(path);
          // Ignore the empty interval between truncating and writing a counter.
          if (content !== "" && content !== seen.get(path)) {
            const now = Date.now();
            const previous = last.get(path) ?? 0;
            if (now < exitAt && previous !== 0) {
              cadence = Math.max(cadence, now - previous);
            }
            seen.set(path, content);
            last.set(path, now);
          }
        }
        await new Promise((done) => setTimeout(done, 5));
      }
    })();
    const result = await call(f, { command });
    exitAt = Date.now();
    assert.equal(detailsOf(result).leftover, true);
    await observation;
    const termAt = last.get(term) ?? 0;
    const killAt = last.get(kill) ?? 0;
    // The counters show a death up to one write interval late: the slack is the measured
    // write/poll lag, at least the quiet-machine margin.
    const firstSlack = Math.max(100, cadence);
    const earlySlack = Math.max(50, cadence);
    const lateSlack = Math.max(150, cadence);
    const first = termAt - exitAt;
    const grace = killAt - termAt;
    t.diagnostic(`counter cadence: ${cadence} ms`);
    t.diagnostic(`first signal after the exit: ${first} ms (bound 100 ms, slack ${firstSlack} ms)`);
    t.diagnostic(
      `SIGKILL after SIGTERM: ${grace} ms (bound 200–300 ms, slack -${earlySlack}/+${lateSlack} ms)`,
    );
    assert.ok(first <= 100 + firstSlack, `first signal after ${first} ms`);
    assert.ok(killAt > termAt, "the second member survived the SIGTERM");
    // 250 minus the slack: the counter's last write lags the SIGTERM by up to one interval.
    assert.ok(grace >= 250 - earlySlack, `SIGKILL after ${grace} ms`);
    assert.ok(grace <= 300 + lateSlack, `SIGKILL after ${grace} ms`);
  } finally {
    polling = false;
    await observation;
    f.cleanup();
  }
});

// specs/bash-tool.md#execution-model: a leftover holding the pipes ends the run with its SIGKILL
// (specs/bash-tool.md#timeout-delivery), before the 1000 ms after the exit that end it otherwise.
test("a leftover that ignores SIGTERM ends the run with its SIGKILL, before the 1000 ms pipe bound", async (t) => {
  const f = makeFixture();
  try {
    const ready = join(f.root, "ready");
    const started = Date.now();
    const result = await call(f, {
      command: `(trap '' TERM; touch ${ready}; while :; do sleep 0.05; done) & until [ -e ${ready} ]; do sleep 0.01; done; echo hi`,
    });
    const elapsed = Date.now() - started;
    t.diagnostic(`run with a SIGTERM-ignoring leftover: ${elapsed} ms (bound 950 ms)`);
    assert.equal(detailsOf(result).leftover, true);
    assert.ok(elapsed < 950, `took ${elapsed} ms`);
  } finally {
    f.cleanup();
  }
});
