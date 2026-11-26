import { test } from "node:test";
import assert from "node:assert/strict";
import {
  argumentText,
  contentText,
  entryItems,
  pairedItem,
  sessionItems,
  type SessionEntry,
  type TranscriptEntryRef,
  type TranscriptItem,
} from "../../lib/session-transcript.ts";
import { at } from "../support/must.ts";

/** specs/session-transcript.md#transcript-items: the transcript items an entry yields. */

function ref(value: Record<string, unknown>, line = 1): TranscriptEntryRef {
  return { line, entryId: `e${line}`, time: 1000 + line, value };
}

function itemsOf(value: Record<string, unknown>, line = 1): TranscriptItem[] {
  return entryItems(ref(value, line));
}

function oneItem(value: Record<string, unknown>): TranscriptItem {
  return at(itemsOf(value), 0);
}

function kinds(value: Record<string, unknown>): string[] {
  return itemsOf(value).map((item) => item.kind);
}

test("a user message yields one user item with the content text", () => {
  const item = oneItem({ type: "message", message: { role: "user", content: "hello there" } });
  assert.equal(item.kind, "user");
  assert.equal(item.part, undefined);
  assert.equal(item.text, "hello there");
  assert.equal(item.label, undefined);
  assert.equal(item.toolCallId, undefined);
  assert.equal(item.isError, false);
});

test("the content text of an array joins the texts that give one by a line feed", () => {
  assert.equal(contentText("plain"), "plain");
  assert.equal(
    contentText([
      { type: "text", text: "one" },
      { type: "image", mimeType: "image/png" },
      { type: "image" },
      { type: "text" },
      { type: "text", text: 5 },
      { type: "toolResult", text: "left out" },
      "a bare string is left out",
      42,
      null,
      { type: "text", text: "two" },
    ]),
    "one\n[image image/png]\n[image]\ntwo",
  );
  assert.equal(contentText(7), "");
  assert.equal(contentText(undefined), "");
  assert.equal(contentText([]), "");
});

test("a user item whose text has no character other than white space is not yielded", () => {
  assert.deepEqual(kinds({ type: "message", message: { role: "user", content: " \n\t " } }), []);
  assert.deepEqual(kinds({ type: "message", message: { role: "user", content: "" } }), []);
  assert.deepEqual(kinds({ type: "message", message: { role: "user", content: 7 } }), []);
  assert.deepEqual(kinds({ type: "message", message: { role: "user" } }), []);
  assert.deepEqual(kinds({ type: "message", message: { role: "user", content: [] } }), []);
  assert.deepEqual(kinds({ type: "message", message: { role: "user", content: "\u00a0" } }), []);
});

test("a system message yields a system item with its prompt text", () => {
  const item = oneItem({
    type: "message",
    message: { role: "system", content: "", sections: { preamble: "You are an agent." } },
  });
  assert.equal(item.kind, "system");
  assert.equal(item.part, undefined);
  assert.equal(item.text, "You are an agent.");
  assert.equal(item.label, undefined);
  assert.equal(item.toolCallId, undefined);
  assert.equal(item.isError, false);
});

test("a system item's prompt text joins content and section values by a blank line", () => {
  assert.equal(
    oneItem({
      type: "message",
      message: {
        role: "system",
        content: "Base prompt.",
        sections: { preamble: "Preamble.", rules: "Rules." },
      },
    }).text,
    "Base prompt.\n\nPreamble.\n\nRules.",
  );
  assert.equal(
    oneItem({ type: "message", message: { role: "system", content: "Only content." } }).text,
    "Only content.",
  );
  // A null section value, a non-string one, and an empty part are left out.
  assert.equal(
    oneItem({
      type: "message",
      message: { role: "system", content: "", sections: { a: null, b: 7, c: "", d: "Kept." } },
    }).text,
    "Kept.",
  );
  // A sections that is not an object yields no section values.
  assert.equal(
    oneItem({ type: "message", message: { role: "system", content: "x", sections: 7 } }).text,
    "x",
  );
  assert.equal(oneItem({ type: "message", message: { role: "system", content: "x" } }).text, "x");
});

test("a system item whose text has no character other than white space is not yielded", () => {
  assert.deepEqual(
    kinds({ type: "message", message: { role: "system", content: "", sections: {} } }),
    [],
  );
  assert.deepEqual(kinds({ type: "message", message: { role: "system", content: " \n " } }), []);
});

test("a message of another role yields no item", () => {
  assert.deepEqual(kinds({ type: "message", message: { role: "tool", content: "x" } }), []);
  assert.deepEqual(kinds({ type: "message", message: "not an object" }), []);
  assert.deepEqual(kinds({ type: "message" }), []);
});

test("an assistant entry yields one item per content element with its index as part", () => {
  const content: unknown[] = [];
  for (let index = 0; index < 11; index += 1) content.push({ type: "text", text: `t${index}` });
  const items = itemsOf({ type: "message", message: { role: "assistant", content } });
  assert.equal(items.length, 11);
  assert.deepEqual(
    items.map((item) => item.part),
    ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
  );
  assert.equal(at(items, 10).text, "t10");
});

test("assistant text and thinking elements yield items and their non-string texts read empty", () => {
  const items = itemsOf({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "spoken" },
        { type: "thinking", thinking: "thought" },
        { type: "text", text: 5 },
        { type: "thinking", thinking: "   " },
        { type: "other", text: "ignored" },
        "not an object",
        null,
      ],
    },
  });
  assert.deepEqual(
    items.map((item) => [item.kind, item.part, item.text]),
    [
      ["assistant", "0", "spoken"],
      ["thinking", "1", "thought"],
    ],
  );
});

test("a toolCall element yields a tool_call item with its label, ID, and argument text", () => {
  const item = oneItem({
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "Bash",
          arguments: { command: "ls -la\npwd", limit: 5 },
        },
      ],
    },
  });
  assert.equal(item.kind, "tool_call");
  assert.equal(item.part, "0");
  assert.equal(item.label, "Bash");
  assert.equal(item.toolCallId, "call-1");
  assert.equal(item.text, "command: ls -la\npwd\nlimit: 5");
});

test("a tool_call item is yielded whatever its text", () => {
  const items = itemsOf({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "Bash" },
        { type: "toolCall", id: "c2", name: "Bash", arguments: {} },
        { type: "toolCall", id: "c3", name: "Bash", arguments: { note: " " } },
      ],
    },
  });
  assert.deepEqual(
    items.map((item) => [item.text, item.length]),
    [
      ["", 0],
      ["", 0],
      ["note:  ", 7],
    ],
  );
  // A string argument stays its JSON form, which is never white space only.
  assert.equal(
    oneItem({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", arguments: "   " }] },
    }).text,
    '"   "',
  );
});

test("a label that is not a non-empty string is absent", () => {
  assert.equal(
    oneItem({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "" }] },
    }).label,
    undefined,
  );
  assert.equal(
    oneItem({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: 7 }] },
    }).label,
    undefined,
  );
  assert.equal(
    oneItem({ type: "message", message: { role: "assistant", content: [{ type: "toolCall" }] } })
      .toolCallId,
    undefined,
  );
  assert.equal(
    oneItem({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: 7 }] },
    }).toolCallId,
    undefined,
  );
});

test("an assistant content that is not an array yields no element item", () => {
  assert.deepEqual(kinds({ type: "message", message: { role: "assistant", content: "text" } }), []);
  assert.deepEqual(kinds({ type: "message", message: { role: "assistant" } }), []);
});

test("an assistant model error yields one further error item, last", () => {
  const items = itemsOf({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "spoken" }],
      errorMessage: "provider failed",
    },
  });
  assert.deepEqual(
    items.map((item) => [item.kind, item.part, item.text]),
    [
      ["assistant", "0", "spoken"],
      ["error", "error", "provider failed"],
    ],
  );
  assert.deepEqual(
    kinds({ type: "message", message: { role: "assistant", errorMessage: "  " } }),
    [],
  );
  assert.deepEqual(kinds({ type: "message", message: { role: "assistant", errorMessage: 7 } }), []);
});

test("a tool result yields one tool_result item with its label and error flag", () => {
  const item = oneItem({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Bash",
      content: [{ type: "text", text: "ok" }],
      isError: true,
    },
  });
  assert.equal(item.kind, "tool_result");
  assert.equal(item.part, undefined);
  assert.equal(item.text, "ok");
  assert.equal(item.label, "Bash");
  assert.equal(item.toolCallId, "call-1");
  assert.equal(item.isError, true);
  assert.equal(
    oneItem({ type: "message", message: { role: "toolResult", isError: "true" } }).isError,
    false,
  );
  assert.equal(oneItem({ type: "message", message: { role: "toolResult" } }).isError, false);
});

test("a tool_result item is yielded whatever its text", () => {
  const items = itemsOf({ type: "message", message: { role: "toolResult", content: "  \n " } });
  assert.deepEqual(
    items.map((item) => [item.kind, item.text, item.length]),
    [["tool_result", "  \n ", 4]],
  );
});

test("a tool result with no tool name has no label", () => {
  assert.equal(
    oneItem({ type: "message", message: { role: "toolResult", toolName: "" } }).label,
    undefined,
  );
  assert.equal(
    oneItem({ type: "message", message: { role: "toolResult", toolName: 3 } }).label,
    undefined,
  );
});

test("a custom message yields an injected item with its customType as label", () => {
  const item = oneItem({
    type: "custom_message",
    customType: "pi-dent-agent:diagnostics:v1",
    content: [{ type: "text", text: "note" }],
  });
  assert.equal(item.kind, "injected");
  assert.equal(item.text, "note");
  assert.equal(item.label, "pi-dent-agent:diagnostics:v1");
  assert.deepEqual(kinds({ type: "custom_message", customType: "x", content: "" }), []);
  assert.deepEqual(kinds({ type: "custom_message", customType: "x", content: 7 }), []);
  assert.equal(oneItem({ type: "custom_message", content: "note" }).label, undefined);
  assert.equal(
    oneItem({ type: "custom_message", customType: "", content: "note" }).label,
    undefined,
  );
});

test("a compaction yields a summary item with the summary text, else nothing", () => {
  const item = oneItem({ type: "compaction", summary: "what happened" });
  assert.equal(item.kind, "summary");
  assert.equal(item.text, "what happened");
  assert.equal(item.label, undefined);
  assert.deepEqual(kinds({ type: "compaction" }), []);
  assert.deepEqual(kinds({ type: "compaction", summary: 7 }), []);
  assert.deepEqual(kinds({ type: "compaction", summary: "  " }), []);
});

test("an entry of any other type yields no item", () => {
  for (const type of [
    "session",
    "model_change",
    "thinking_level_change",
    "custom",
    "",
    undefined,
    7,
  ]) {
    assert.deepEqual(kinds({ type, message: { role: "user", content: "x" } }), []);
  }
});

test("an item's length is its text in characters and its match text its first 100000", () => {
  const long = "a".repeat(100001);
  const item = oneItem({ type: "message", message: { role: "user", content: long } });
  assert.equal(item.length, 100001);
  assert.equal(item.matchText.length, 100000);
  assert.equal(item.matchText, long.slice(0, 100000));
  const short = oneItem({ type: "message", message: { role: "user", content: "é" } });
  assert.equal(short.length, 1);
});

test("an item carries its entry's line, ID, and time", () => {
  const item = at(itemsOf({ type: "message", message: { role: "user", content: "x" } }, 7), 0);
  assert.equal(item.line, 7);
  assert.equal(item.entryId, "e7");
  assert.equal(item.time, 1007);
});

test("the argument text of an object is one key block per key in Object.keys order", () => {
  assert.equal(
    argumentText({
      command: "ls -la\npwd",
      limit: 5,
      nested: { a: 1 },
      flag: true,
      none: null,
      list: [1, 2],
    }),
    'command: ls -la\npwd\nlimit: 5\nnested: {"a":1}\nflag: true\nnone: null\nlist: [1,2]',
  );
  assert.equal(argumentText({ b: 1, "2": 2, a: 3 }), "2: 2\nb: 1\na: 3");
  assert.equal(argumentText({}), "");
});

test("the argument text of any other value is its JSON form, and empty when absent", () => {
  assert.equal(argumentText(undefined), "");
  assert.equal(argumentText("cmd"), '"cmd"');
  assert.equal(argumentText(["a"]), '["a"]');
  assert.equal(argumentText(null), "null");
  assert.equal(argumentText(7), "7");
  assert.equal(argumentText(true), "true");
});

test("a tool_call and a tool_result item pair when their tool-call IDs are equal", () => {
  const entries: SessionEntry[] = [
    sessionEntry("m1", 1, {
      type: "message",
      id: "m1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "Bash", arguments: {} }],
      },
    }),
    sessionEntry("m2", 2, {
      type: "message",
      id: "m2",
      message: { role: "toolResult", toolCallId: "c1", toolName: "Bash", content: "ok" },
    }),
  ];
  const items = sessionItems(entries);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["tool_call", "tool_result"],
  );
  assert.equal(pairedItem(at(items, 0), items), at(items, 1));
  assert.equal(pairedItem(at(items, 1), items), at(items, 0));
});

test("only the first item of a kind with a tool-call ID is the paired one", () => {
  const entries: SessionEntry[] = [
    sessionEntry("m1", 1, {
      type: "message",
      id: "m1",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "Bash", arguments: { n: 1 } },
          { type: "toolCall", id: "c1", name: "Bash", arguments: { n: 2 } },
        ],
      },
    }),
    sessionEntry("m2", 2, {
      type: "message",
      id: "m2",
      message: { role: "toolResult", toolCallId: "c1", toolName: "Bash", content: "first" },
    }),
    sessionEntry("m3", 3, {
      type: "message",
      id: "m3",
      message: { role: "toolResult", toolCallId: "c1", toolName: "Bash", content: "second" },
    }),
  ];
  const items = sessionItems(entries);
  assert.equal(pairedItem(at(items, 0), items), at(items, 2));
  assert.equal(pairedItem(at(items, 1), items), undefined);
  assert.equal(pairedItem(at(items, 2), items), at(items, 0));
  assert.equal(pairedItem(at(items, 3), items), undefined);
});

test("an item without a tool-call ID, of another kind, or without a partner is paired with none", () => {
  const entries: SessionEntry[] = [
    sessionEntry("m1", 1, { type: "message", id: "m1", message: { role: "user", content: "x" } }),
    sessionEntry("m2", 2, {
      type: "message",
      id: "m2",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c9", name: "Bash" }] },
    }),
    sessionEntry("m3", 3, {
      type: "message",
      id: "m3",
      message: { role: "assistant", content: [{ type: "toolCall", name: "Bash" }] },
    }),
    sessionEntry("m4", 4, {
      type: "message",
      id: "m4",
      message: { role: "toolResult", content: "no call id" },
    }),
  ];
  const items = sessionItems(entries);
  for (const item of items) assert.equal(pairedItem(item, items), undefined);
});

test("session items are in file order", () => {
  const entries: SessionEntry[] = [
    sessionEntry("m1", 1, { type: "message", id: "m1", message: { role: "user", content: "one" } }),
    sessionEntry("m2", 2, {
      type: "message",
      id: "m2",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "toolCall", id: "c1", name: "Bash" },
        ],
        errorMessage: "boom",
      },
    }),
    sessionEntry("m3", 3, {
      type: "message",
      id: "m3",
      message: { role: "toolResult", content: "done" },
    }),
  ];
  assert.deepEqual(
    sessionItems(entries).map((item) => [item.line, item.part, item.kind]),
    [
      [1, undefined, "user"],
      [2, "0", "thinking"],
      [2, "1", "tool_call"],
      [2, "error", "error"],
      [3, undefined, "tool_result"],
    ],
  );
});

function sessionEntry(entryId: string, line: number, value: Record<string, unknown>): SessionEntry {
  return {
    line,
    entryId,
    time: line,
    value,
    type: "message",
    parentId: null,
    offset: 0,
    bytes: 0,
  };
}
