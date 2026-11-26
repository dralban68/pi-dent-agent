import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { readErrorHint } from "../../lib/output-file.ts";

/**
 * The `read` error hint of specs/script-tool.md#timeout-delivery, through its public
 * function: a failed `read` of a mistyped output path gets a suggestion only when
 * exactly one output file of that base name lies in the agent directory tree.
 */

function withTree(run: (root: string, outside: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "pi-dent-read-hint-"));
  try {
    const root = join(base, "sessions", "main.agents");
    const outside = join(base, "sessions", "other");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    run(root, outside);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function writeOutput(dir: string, name: string): string {
  mkdirSync(join(dir, "output"), { recursive: true });
  const path = join(dir, "output", name);
  writeFileSync(path, "out\n");
  return path;
}

function readFailure(path: string, text = `ENOENT: no such file or directory, access '${path}'`) {
  return {
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "read",
    input: { path },
    content: [{ type: "text", text }],
    details: undefined,
    isError: true,
  } satisfies ToolResultEvent;
}

test("a mistyped output path with one match gets the suggestion", () => {
  withTree((root) => {
    const real = writeOutput(join(root, "dynamic-56ce5485.agents"), "5b40c845.log");
    const wrong = join(root, "output", "5b40c845.log");
    const result = readErrorHint(readFailure(wrong), root);
    const text = result?.content?.[0];
    assert.ok(text?.type === "text");
    assert.equal(text.text.endsWith(`\nDid you mean ${real}?`), true);
    assert.equal(text.text.startsWith("ENOENT"), true);
  });
});

test("two matches get no suggestion", () => {
  withTree((root) => {
    writeOutput(root, "5b40c845.log");
    writeOutput(join(root, "dynamic-56ce5485.agents"), "5b40c845.log");
    const wrong = join(root, "dynamic-other.agents", "output", "5b40c845.log");
    assert.equal(readErrorHint(readFailure(wrong), root), undefined);
  });
});

test("no match gets no suggestion", () => {
  withTree((root) => {
    writeOutput(join(root, "dynamic-56ce5485.agents"), "other.log");
    const wrong = join(root, "output", "5b40c845.log");
    assert.equal(readErrorHint(readFailure(wrong), root), undefined);
  });
});

test("a match outside the agent directory tree is not found", () => {
  withTree((root, outside) => {
    writeOutput(outside, "5b40c845.log");
    const wrong = join(root, "output", "5b40c845.log");
    assert.equal(readErrorHint(readFailure(wrong), root), undefined);
  });
});

test("a tool other than read gets no suggestion", () => {
  withTree((root) => {
    writeOutput(join(root, "dynamic-56ce5485.agents"), "5b40c845.log");
    const event = { ...readFailure(join(root, "output", "5b40c845.log")), toolName: "bash" };
    assert.equal(readErrorHint(event, root), undefined);
  });
});

/** A chain of `levels` nested `.agents` folders; returns the deepest. */
function nestAgents(root: string, levels: number): string {
  let dir = root;
  for (let i = 0; i < levels; i++) dir = join(dir, `d${i}.agents`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("a match in an output folder 16 levels below the root is found", () => {
  withTree((root) => {
    // The deepest .agents folder is at depth 15, so its output folder is at depth 16.
    const real = writeOutput(nestAgents(root, 15), "5b40c845.log");
    const wrong = join(root, "output", "5b40c845.log");
    const text = readErrorHint(readFailure(wrong), root)?.content?.[0];
    assert.ok(text?.type === "text");
    assert.equal(text.text.endsWith(`\nDid you mean ${real}?`), true);
  });
});

test("a folder more than 16 levels below the root stops the scan: no suggestion", () => {
  withTree((root) => {
    writeOutput(root, "5b40c845.log");
    writeOutput(nestAgents(root, 16), "5b40c845.log");
    const wrong = join(root, "output", "5b40c845.log");
    assert.equal(readErrorHint(readFailure(wrong), root), undefined);
  });
});

test("a scan reading 9000 directory entries still suggests", () => {
  withTree((root) => {
    const real = writeOutput(join(root, "dynamic-56ce5485.agents"), "5b40c845.log");
    for (let i = 0; i < 9000; i++) writeFileSync(join(root, `f${i}`), "");
    const wrong = join(root, "output", "5b40c845.log");
    const text = readErrorHint(readFailure(wrong), root)?.content?.[0];
    assert.ok(text?.type === "text");
    assert.equal(text.text.endsWith(`\nDid you mean ${real}?`), true);
  });
});

test("a scan reading more than 10000 directory entries stops: no suggestion", () => {
  withTree((root) => {
    writeOutput(join(root, "dynamic-56ce5485.agents"), "5b40c845.log");
    for (let i = 0; i < 10001; i++) writeFileSync(join(root, `f${i}`), "");
    const wrong = join(root, "output", "5b40c845.log");
    assert.equal(readErrorHint(readFailure(wrong), root), undefined);
  });
});

test("a read error other than ENOENT gets no suggestion", () => {
  withTree((root) => {
    writeOutput(join(root, "dynamic-56ce5485.agents"), "5b40c845.log");
    const wrong = join(root, "output", "5b40c845.log");
    const event = readFailure(wrong, "EACCES: permission denied");
    assert.equal(readErrorHint(event, root), undefined);
  });
});
