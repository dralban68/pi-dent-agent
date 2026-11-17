import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GUIDANCE_CUSTOM_TYPE,
  type ModelGuidance,
  guidanceContent,
} from "../../lib/model-guidance.ts";
import type { InventoryModel } from "../../lib/model-string.ts";
import { guidanceToInject } from "../../lib/guidance-inject.ts";

const guidance: ModelGuidance = {
  entries: [
    {
      key: "anthropic/claude-3-5-haiku",
      provider: "anthropic",
      id: "claude-3-5-haiku",
      when: "quick edits",
    },
  ],
  rules: [
    {
      match: /haiku/u,
      rule: "verify fast model output",
    },
  ],
};

const available: InventoryModel[] = [
  { provider: "anthropic", id: "claude-3-5-haiku" },
  { provider: "google", id: "gemini-flash" },
];

const model = "anthropic/claude-3-5-haiku";

const expectedContent = guidanceContent(guidance, available, model);

test("inactive (no model entries, no matching rules) → undefined", () => {
  const empty: ModelGuidance = { entries: [], rules: [] };
  assert.equal(guidanceToInject(empty, available, model, []), undefined);
  assert.equal(
    guidanceToInject(empty, available, model, [
      { type: "custom_message", customType: GUIDANCE_CUSTOM_TYPE, content: "other" },
    ]),
    undefined,
  );
});

test("rules-only matches session model → content", () => {
  const rulesOnly: ModelGuidance = {
    entries: [],
    rules: [{ match: /haiku/u, rule: "verify fast model output" }],
  };
  assert.equal(
    guidanceToInject(rulesOnly, available, "anthropic/claude-3-5-haiku", []),
    "verify fast model output",
  );
  assert.equal(guidanceToInject(rulesOnly, available, "openai/gpt-4o", []), undefined);
});

test("empty branch → content", () => {
  assert.equal(guidanceToInject(guidance, available, model, []), expectedContent);
});

test("branch with an identical guidance custom_message after the last compaction → undefined", () => {
  const branchWithCompaction = [
    { type: "message" },
    { type: "compaction" },
    { type: "custom_message", customType: GUIDANCE_CUSTOM_TYPE, content: expectedContent },
  ];
  assert.equal(guidanceToInject(guidance, available, model, branchWithCompaction), undefined);

  const branchWithoutCompaction = [
    { type: "message" },
    { type: "custom_message", customType: GUIDANCE_CUSTOM_TYPE, content: expectedContent },
  ];
  assert.equal(guidanceToInject(guidance, available, model, branchWithoutCompaction), undefined);
});

test("identical message only BEFORE the last compaction → content", () => {
  const branch = [
    { type: "custom_message", customType: GUIDANCE_CUSTOM_TYPE, content: expectedContent },
    { type: "compaction" },
    { type: "message" },
  ];
  assert.equal(guidanceToInject(guidance, available, model, branch), expectedContent);
});

test("different content after compaction → content", () => {
  const branch = [
    { type: "compaction" },
    {
      type: "custom_message",
      customType: GUIDANCE_CUSTOM_TYPE,
      content: "Model guidance:\n- old: previous content",
    },
  ];
  assert.equal(guidanceToInject(guidance, available, model, branch), expectedContent);
});

test("array content form compares by joined text", () => {
  const splitIndex = 15;
  const branchMatching = [
    {
      type: "custom_message",
      customType: GUIDANCE_CUSTOM_TYPE,
      content: [
        { type: "text", text: expectedContent.slice(0, splitIndex) },
        { type: "image", data: "ignored" },
        { type: "text", text: expectedContent.slice(splitIndex) },
      ],
    },
  ];
  assert.equal(guidanceToInject(guidance, available, model, branchMatching), undefined);

  const branchNonMatching = [
    {
      type: "custom_message",
      customType: GUIDANCE_CUSTOM_TYPE,
      content: [{ type: "text", text: "different joined text" }],
    },
  ];
  assert.equal(guidanceToInject(guidance, available, model, branchNonMatching), expectedContent);
});

test("no guided model in the inventory: the message carries rules only, with no Model guidance section", () => {
  assert.equal(guidanceToInject(guidance, [], model, []), "verify fast model output");
  assert.equal(guidanceToInject(guidance, [], "google/gemini-flash", []), undefined);
});
