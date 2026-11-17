import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { entryItems } from "../../lib/session-transcript.ts";
import { deriveSessionEvents } from "../../lib/task-browser.ts";
import { buildRecapInput } from "../../lib/recap.ts";
import { renderRecapEntry } from "../../lib/recap-render.ts";
import { guidanceToInject } from "../../lib/guidance-inject.ts";
import { GUIDANCE_CUSTOM_TYPE, type ModelGuidance } from "../../lib/model-guidance.ts";

const text = "Goal: ship\nDone: code\nOpen: tests\nNext: verify";
const entry = {
  type: "custom",
  customType: "pi-dent-recap",
  data: { text },
  id: "recap-1",
  parentId: null,
  timestamp: "2026-11-15T10:00:00.000Z",
};

test("recap follows the custom-entry rule: no Search item, one generic task-browser event", () => {
  assert.deepEqual(
    entryItems({ line: 1, entryId: entry.id, time: Date.parse(entry.timestamp), value: entry }),
    [],
  );
  const events = deriveSessionEvents(JSON.stringify(entry));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "custom");
  assert.equal(events[0]?.summary, "");
  assert.equal(events[0]?.content, JSON.stringify(entry, null, 2));
  assert.equal(buildRecapInput([entry]), "");
});

test("host retains recap entries on the branch without adding them to model context", () => {
  const session = SessionManager.inMemory("/project");
  session.appendMessage({ role: "user", content: "ship", timestamp: 0 });
  const before = session.buildSessionContext().messages;
  session.appendCustomEntry("pi-dent-recap", { text });
  const persisted = session.getBranch().at(-1);
  assert.equal(persisted?.type, "custom");
  if (persisted?.type === "custom") {
    assert.equal(persisted.customType, "pi-dent-recap");
    assert.deepEqual(persisted.data, { text });
  }
  assert.deepEqual(session.buildSessionContext().messages, before);
  assert.equal(buildRecapInput(session.buildContextEntries()), "user:\nship");
});

test("recap persists and renders after reopening without changing the model conversation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-recap-persist-"));
  try {
    const session = SessionManager.create(dir, dir);
    session.appendMessage({ role: "user", content: "ship", timestamp: 0 });
    session.appendCustomEntry("pi-dent-recap", { text });
    const file = session.getSessionFile();
    assert.ok(file);
    const reopened = SessionManager.open(file);
    const recap = reopened.getBranch().at(-1);
    assert.equal(recap?.type, "custom");
    assert.ok(recap?.type === "custom");
    assert.deepEqual(recap.data, { text });
    const rendered = renderRecapEntry(
      recap,
      {},
      {
        fg: (_color, value) => value,
        bg: (_color, value) => value,
        bold: (value) => value,
      },
    )
      .render(100)
      .map((line) => stripVTControlCharacters(line).trim());
    assert.ok(rendered.includes("Recap"));
    assert.ok(rendered.includes("Next: verify"));
    assert.deepEqual(
      reopened.buildSessionContext().messages,
      session.buildSessionContext().messages,
    );
    assert.equal(buildRecapInput(reopened.buildContextEntries()), "user:\nship");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recap entries neither replace nor suppress guidance's latest-message comparison", () => {
  const guidance: ModelGuidance = {
    entries: [],
    rules: [{ match: /model/u, rule: "verify output" }],
  };
  const previous = {
    type: "custom_message",
    customType: GUIDANCE_CUSTOM_TYPE,
    content: "verify output",
  };
  assert.equal(guidanceToInject(guidance, [], "provider/model", [previous, entry]), undefined);
  assert.equal(guidanceToInject(guidance, [], "provider/model", [entry]), "verify output");
  assert.equal(
    guidanceToInject(guidance, [], "provider/model", [{ ...previous, content: "old rule" }, entry]),
    "verify output",
  );
});
