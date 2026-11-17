import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatItemAddress,
  itemAddress,
  parseItemAddress,
  resolveItem,
  type ItemAddress,
  type TranscriptItem,
} from "../../lib/session-transcript.ts";
import { at } from "../support/must.ts";

/** specs/session-transcript.md Section 5: the item address grammar, its parsing and formatting. */

function roundTrip(text: string): ItemAddress {
  const address = parseItemAddress(text);
  assert.notEqual(address, undefined);
  const parsed: ItemAddress = address ?? { sessionKey: "", entryId: "" };
  assert.equal(formatItemAddress(parsed), text);
  return parsed;
}

test("an address is the session key, the entry ID, and the part when it has one", () => {
  assert.deepEqual(roundTrip("self:abc123"), { sessionKey: "self", entryId: "abc123" });
  assert.deepEqual(roundTrip("self:abc123.0"), {
    sessionKey: "self",
    entryId: "abc123",
    part: "0",
  });
  assert.deepEqual(roundTrip("self:abc123.10"), {
    sessionKey: "self",
    entryId: "abc123",
    part: "10",
  });
  assert.deepEqual(roundTrip("self:abc123.error"), {
    sessionKey: "self",
    entryId: "abc123",
    part: "error",
  });
});

test("a stem path names a member of a session tree", () => {
  assert.deepEqual(roundTrip("worker-1/sub_2/x.y:entry-1"), {
    sessionKey: "worker-1/sub_2/x.y",
    entryId: "entry-1",
  });
  assert.equal(parseItemAddress("self/child:abc")?.sessionKey, "self/child");
});

test("a project session key is ~ and one to thirteen safe characters and an optional stem path", () => {
  assert.equal(parseItemAddress("~abcdefghijklm:abc")?.sessionKey, "~abcdefghijklm");
  assert.equal(parseItemAddress("~a:abc")?.sessionKey, "~a");
  assert.equal(parseItemAddress("~a.b_c-d/one/two:abc")?.sessionKey, "~a.b_c-d/one/two");
  assert.equal(parseItemAddress("~abcdefghijklmn:abc"), undefined);
  assert.equal(parseItemAddress("~:abc"), undefined);
  assert.equal(parseItemAddress("~abc/:abc"), undefined);
  assert.equal(parseItemAddress("~abc//def:abc"), undefined);
  assert.equal(parseItemAddress("~/def:abc"), undefined);
});

test("an address that matches no production is no address", () => {
  for (const text of [
    "",
    "abc",
    "self",
    ":abc",
    "self:",
    "self:a.b",
    "self:a b",
    "self:a/b",
    "self:a:b",
    "self:a.01",
    "self:a.00",
    "self:a.Error",
    "self:a.0x",
    "self:a.",
    "self:.0",
    "~:x",
    "a//b:x",
    "/a:x",
    "a/:x",
  ]) {
    assert.equal(parseItemAddress(text), undefined, text);
  }
});

test("an address is case-sensitive", () => {
  assert.equal(parseItemAddress("Self:abc")?.sessionKey, "Self");
  assert.equal(parseItemAddress("self:ABC")?.entryId, "ABC");
  assert.notEqual(
    formatItemAddress({ sessionKey: "self", entryId: "ABC" }),
    formatItemAddress({ sessionKey: "self", entryId: "abc" }),
  );
});

test("the quoted strings of the grammar match only as written", () => {
  // `part` has the alternative `error`, so `ERROR` names no part.
  assert.equal(parseItemAddress("self:abc.ERROR"), undefined);
  assert.equal(parseItemAddress("self:abc.Error"), undefined);
  // `SELF` is not the literal `self`; it is a `stem-path` of one stem, so the address parses
  // to that session key and is another address than `self:abc`.
  assert.deepEqual(parseItemAddress("SELF:abc"), { sessionKey: "SELF", entryId: "abc" });
  assert.notEqual(
    formatItemAddress({ sessionKey: "SELF", entryId: "abc" }),
    formatItemAddress({ sessionKey: "self", entryId: "abc" }),
  );
});

test("an item's address is its session key, its entry's ID, and its part", () => {
  assert.equal(formatItemAddress(itemAddress("self", item("e1", "0"))), "self:e1.0");
  assert.equal(formatItemAddress(itemAddress("self", item("e1", undefined))), "self:e1");
  assert.equal(
    formatItemAddress(itemAddress("~abc/child", item("e1", "error"))),
    "~abc/child:e1.error",
  );
});

test("an address resolves to the item it is the address of, or to none", () => {
  const items = [item("e1", undefined), item("e2", "0"), item("e2", "1"), item("e3", "error")];
  assert.equal(resolveItem(items, { sessionKey: "self", entryId: "e2", part: "1" }), at(items, 2));
  assert.equal(resolveItem(items, { sessionKey: "self", entryId: "e1" }), at(items, 0));
  assert.equal(
    resolveItem(items, { sessionKey: "self", entryId: "e3", part: "error" }),
    at(items, 3),
  );
  assert.equal(resolveItem(items, { sessionKey: "self", entryId: "e2" }), undefined);
  assert.equal(resolveItem(items, { sessionKey: "self", entryId: "e9" }), undefined);
  assert.equal(resolveItem(items, { sessionKey: "self", entryId: "e1", part: "0" }), undefined);
});

function item(entryId: string, part: string | undefined): TranscriptItem {
  return {
    kind: "user",
    part,
    text: "t",
    label: undefined,
    toolCallId: undefined,
    isError: false,
    line: 1,
    entryId,
    time: 0,
    length: 1,
    matchText: "t",
  };
}
