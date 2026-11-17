import { test } from "node:test";
import assert from "node:assert/strict";
import { shortenSessionDir } from "../../lib/util.ts";

/** Terminal text per specs/agent-tool.md Section 4.2. */

test("render: the agent directory path shows as $PI_DENT_SESSION_DIR, every occurrence", () => {
  const dir = "/home/u/.pi/agent/sessions/--p--/s.agents";
  const text = `Agent a started.\nSession: ${dir}/a-1.jsonl\nFull output: ${dir}/a-1.result.txt`;
  assert.equal(
    shortenSessionDir(text, dir),
    "Agent a started.\nSession: $PI_DENT_SESSION_DIR/a-1.jsonl\nFull output: $PI_DENT_SESSION_DIR/a-1.result.txt",
  );
});

test("render: text is unchanged without an agent directory or without its path", () => {
  assert.equal(shortenSessionDir("Session: /x/a.jsonl", ""), "Session: /x/a.jsonl");
  assert.equal(shortenSessionDir("Session: /x/a.jsonl", "/y"), "Session: /x/a.jsonl");
});
