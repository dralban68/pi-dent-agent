import { after, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareFileOrder,
  compareParts,
  compareTranscriptOrder,
  type SessionItem,
  type TranscriptItem,
} from "../../lib/session-transcript.ts";
import { at } from "../support/must.ts";
import { tempDir } from "./support.ts";

/** specs/session-transcript.md#transcript-order: transcript order and file order. */

function item(line: number, part: string | undefined, time = 0): TranscriptItem {
  return {
    kind: part === "error" ? "error" : "assistant",
    part,
    text: "t",
    label: undefined,
    toolCallId: undefined,
    isError: false,
    line,
    entryId: `e${line}`,
    time,
    length: 1,
    matchText: "t",
  };
}

function located(
  sessionKey: string,
  sessionPath: string,
  line: number,
  part: string | undefined,
  time = 0,
): SessionItem {
  return { sessionKey, sessionPath, item: item(line, part, time) };
}

test("file order is by line number, then part as numbers with error last", () => {
  const ordered = [item(1, undefined), item(2, "0"), item(2, "1"), item(2, "10"), item(3, "error")];
  const shuffled = [
    item(3, "error"),
    item(2, "10"),
    item(2, "1"),
    item(2, "0"),
    item(1, undefined),
  ];
  assert.deepEqual(
    shuffled.toSorted(compareFileOrder).map((one) => [one.line, one.part]),
    ordered.map((one) => [one.line, one.part]),
  );
});

test("parts compare as numbers, not as text, and error comes last", () => {
  assert.ok(compareParts("9", "10") < 0);
  assert.ok(compareParts("10", "9") > 0);
  assert.equal(compareParts("0", "0"), 0);
  assert.ok(compareParts("99", "error") < 0);
  assert.ok(compareParts("error", "0") > 0);
  // An item without a part precedes every part; one entry never yields both.
  assert.ok(compareParts(undefined, "0") < 0);
});

test("transcript order is by time, then session key, then session path, then line, then part", () => {
  const ordered = [
    located("self", "/s/self.jsonl", 5, "0", 10),
    located("self", "/s/self.jsonl", 5, "1", 10),
    located("self", "/s/self.jsonl", 6, undefined, 10),
    located("worker", "/s/self.agents/worker.jsonl", 1, undefined, 10),
    located("self", "/s/self.jsonl", 1, undefined, 20),
  ];
  const shuffled = [at(ordered, 4), at(ordered, 3), at(ordered, 2), at(ordered, 1), at(ordered, 0)];
  assert.deepEqual(
    shuffled
      .toSorted(compareTranscriptOrder)
      .map((one) => [one.item.time, one.sessionKey, one.item.line, one.item.part]),
    ordered.map((one) => [one.item.time, one.sessionKey, one.item.line, one.item.part]),
  );
});

test("session keys compare by UTF-16 code units", () => {
  const first = located("Alpha", "/p/a.jsonl", 1, undefined);
  const second = located("alpha", "/p/b.jsonl", 1, undefined);
  const third = located("~abcdefghijklm", "/p/c.jsonl", 1, undefined);
  assert.ok(compareTranscriptOrder(first, second) < 0);
  assert.ok(compareTranscriptOrder(second, third) < 0);
  assert.ok(compareTranscriptOrder(third, first) > 0);
});

test("equal keys of different sessions compare by session file path", () => {
  const first = located("~abcdefghijklm", "/p/a.jsonl", 3, undefined);
  const second = located("~abcdefghijklm", "/p/b.jsonl", 1, undefined);
  assert.ok(compareTranscriptOrder(first, second) < 0);
  assert.ok(compareTranscriptOrder(second, first) > 0);
});

test("items of one session and one entry compare by part, and an item compares equal to itself", () => {
  const zero = located("self", "/s/self.jsonl", 4, "0", 7);
  const two = located("self", "/s/self.jsonl", 4, "2", 7);
  assert.ok(compareTranscriptOrder(zero, two) < 0);
  assert.equal(compareTranscriptOrder(zero, located("self", "/s/self.jsonl", 4, "0", 7)), 0);
});

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("equal keys of different sessions compare by session path with symbolic links resolved", () => {
  const root = tempDir("session-transcript-order-");
  roots.push(root);
  const real = join(root, "z-real.jsonl");
  writeFileSync(real, "");
  const link = join(root, "a-link.jsonl");
  symlinkSync(real, link);
  const plain = join(root, "m-plain.jsonl");
  writeFileSync(plain, "");
  // Lexically `a-link.jsonl` comes first; resolved it is `z-real.jsonl`, which comes after
  // `m-plain.jsonl`.
  const viaLink = located("~same", link, 1, undefined);
  const direct = located("~same", plain, 1, undefined);
  assert.ok(compareTranscriptOrder(direct, viaLink) < 0);
  assert.ok(compareTranscriptOrder(viaLink, direct) > 0);
  // A caller that resolved the path itself gets the same order.
  const resolvedLink = { ...viaLink, resolvedPath: real };
  assert.ok(compareTranscriptOrder(direct, resolvedLink) < 0);
  // Two spellings of one file are one session, so line number decides.
  const later = located("~same", link, 5, undefined);
  const earlier = { ...located("~same", real, 1, undefined) };
  assert.ok(compareTranscriptOrder(earlier, later) < 0);
});
