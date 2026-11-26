import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBrowserState, type BrowserTheme } from "../../lib/task-browser.ts";
import { TaskRegistry } from "../../lib/registry.ts";

/**
 * The task browser per specs/task-browser.md#details-page: a session read that catches up across
 * two reads keeps a multi-byte character split between them intact, and still parses the lines
 * that follow it.
 */

const eventLine = (role: string, content: string): string =>
  JSON.stringify({
    type: "message",
    timestamp: "2026-01-02T03:04:05.000Z",
    message: { role, content },
  });

test("a multi-byte character split across two reads keeps the event text intact", () => {
  const root = new TaskRegistry(() => undefined);
  const row = root.register({ kind: "agent", cohort: "c", label: "mb", background: true });
  const dir = mkdtempSync(join(tmpdir(), "pi-dent-browser-multibyte-"));
  try {
    const sessionPath = join(dir, "s.jsonl");
    root.amend(row, { sessionPath });
    const bytes = Buffer.from(
      `${eventLine("user", "hi 😀 there")}\n${eventLine("user", "two")}\n`,
      "utf8",
    );
    const cut = bytes.indexOf(Buffer.from("😀", "utf8")) + 3; // inside the emoji
    writeFileSync(sessionPath, bytes.subarray(0, cut));

    const marker: BrowserTheme = {
      fg: (_color, text) => text,
      bg: (_color, text) => `«${text}»`,
    };
    const state = new TaskBrowserState({
      zone: "UTC",
      now: () => 0,
      height: () => 40,
      theme: marker,
      registry: root,
      readSession: () => readFileSync(sessionPath, "utf8"),
    });
    state.render(80);
    state.handleKey("\r");
    state.tick();
    appendFileSync(sessionPath, bytes.subarray(cut));
    state.tick();

    const page = state.render(80).join("\n");
    assert.ok(page.includes("hi 😀 there"), `emoji intact, got: ${page}`);
    assert.ok(page.includes("user · two"), "the second line still parses");
    assert.ok(!page.includes("\uFFFD"), "no replacement characters leak into the text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
