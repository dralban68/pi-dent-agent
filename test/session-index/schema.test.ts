import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pruneSessionIndex } from "../../lib/session-index.ts";
import { must } from "../support/must.ts";
import {
  assistantLine,
  entryLine,
  fileOf,
  headerLine,
  indexPath,
  itemsOf,
  ok,
  openIndex,
  rawIndex,
  tempDir,
  toolResultLine,
  userLine,
  writeSession,
} from "./support.ts";

/** specs/session-index.md#schema: the schema and the rows it holds. */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const path = tempDir("session-index-schema-");
  roots.push(path);
  return path;
}

/** The statements of specs/session-index.md#schema, as the specification writes them. */
const STATEMENTS: readonly { name: string; sql: string }[] = [
  {
    name: "files",
    sql: `CREATE TABLE files (
  file_id            INTEGER PRIMARY KEY,
  path               TEXT    NOT NULL UNIQUE,
  session_id         TEXT    NOT NULL,
  started            INTEGER NOT NULL,
  consumed           INTEGER NOT NULL,
  lines              INTEGER NOT NULL,
  last_time          INTEGER NOT NULL,
  mtime              INTEGER NOT NULL,
  tail_offset        INTEGER NOT NULL,
  tail_hash          TEXT    NOT NULL,
  session_name       TEXT,
  first_user_message TEXT
)`,
  },
  {
    name: "entries",
    sql: `CREATE TABLE entries (
  file_id   INTEGER NOT NULL,
  line      INTEGER NOT NULL,
  offset    INTEGER NOT NULL,
  bytes     INTEGER NOT NULL,
  entry_id  TEXT    NOT NULL,
  parent_id TEXT,
  time      INTEGER NOT NULL,
  lineage   INTEGER NOT NULL,
  PRIMARY KEY (file_id, line),
  UNIQUE (file_id, entry_id)
) WITHOUT ROWID`,
  },
  {
    name: "items",
    sql: `CREATE TABLE items (
  item_id  INTEGER PRIMARY KEY,
  file_id  INTEGER NOT NULL,
  line     INTEGER NOT NULL,
  part     TEXT    NOT NULL,
  kind     TEXT    NOT NULL,
  tool     TEXT,
  is_error INTEGER NOT NULL,
  call_id  TEXT,
  time     INTEGER NOT NULL,
  UNIQUE (file_id, line, part)
)`,
  },
  { name: "items_time", sql: "CREATE INDEX items_time ON items (time)" },
  {
    name: "items_call",
    sql: "CREATE INDEX items_call ON items (file_id, call_id) WHERE call_id IS NOT NULL",
  },
  {
    name: "item_text",
    sql: `CREATE VIRTUAL TABLE item_text USING fts5 (
  text, content = '', contentless_delete = 1, detail = none, tokenize = 'trigram'
)`,
  },
];

function normalized(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

test("the schema is exactly the statements of specs/session-index.md#schema", () => {
  const root = dir();
  const path = indexPath(root);
  const index = openIndex(path);
  index.close();
  const db = rawIndex(path);
  try {
    for (const statement of STATEMENTS) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(statement.name);
      const sql = must(row).sql;
      assert.equal(typeof sql, "string");
      assert.equal(normalized(sql as string), normalized(statement.sql), statement.name);
    }
  } finally {
    db.close();
  }
});

test("an item's text is held only in the contentless item_text table", async () => {
  const root = dir();
  const path = indexPath(root);
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "findable words here"));
  const index = openIndex(path);
  assert.equal((await index.catchUp(session)).status, "complete");
  index.close();
  const db = rawIndex(path);
  try {
    const items = db
      .prepare("PRAGMA table_info('items')")
      .all()
      .map((row) => row.name);
    assert.deepEqual(items, [
      "item_id",
      "file_id",
      "line",
      "part",
      "kind",
      "tool",
      "is_error",
      "call_id",
      "time",
    ]);
    const entries = db
      .prepare("PRAGMA table_info('entries')")
      .all()
      .map((row) => row.name);
    assert.deepEqual(entries, [
      "file_id",
      "line",
      "offset",
      "bytes",
      "entry_id",
      "parent_id",
      "time",
      "lineage",
    ]);
    // The contentless table returns none of the text it indexed.
    const text = must(db.prepare("SELECT rowid, text FROM item_text").get());
    assert.equal(text.text, null);
    assert.equal(typeof text.rowid, "number");
    const item = must(db.prepare("SELECT item_id, kind FROM items").get());
    assert.equal(text.rowid, item.item_id);
  } finally {
    db.close();
  }
});

test("the item columns carry the part, kind, tool name, error flag, call ID, and time", async () => {
  const root = dir();
  const path = indexPath(root);
  const session = join(root, "s.jsonl");
  writeSession(
    session,
    headerLine(),
    assistantLine("a1", "session-one", [
      { type: "text", text: "a text" },
      { type: "thinking", thinking: "a thought" },
      { type: "toolCall", id: "c1", name: "Web-Search", arguments: { query: "x" } },
    ]),
    toolResultLine("a2", "a1", "Web-Search", "c1", "an error result", true),
    toolResultLine("a3", "a2", "Bash", "c2", "a plain result"),
  );
  const index = openIndex(path);
  assert.equal((await index.catchUp(session)).status, "complete");
  const rows = itemsOf(index, session).map((row) => ({
    line: row.line,
    part: row.part,
    kind: row.kind,
    tool: row.tool,
    isError: row.isError,
    callId: row.callId,
    time: row.time,
  }));
  const stamp = Date.parse("2026-01-01T00:00:00.000Z");
  assert.deepEqual(rows, [
    {
      line: 2,
      part: "0",
      kind: "assistant",
      tool: null,
      isError: false,
      callId: null,
      time: stamp,
    },
    { line: 2, part: "1", kind: "thinking", tool: null, isError: false, callId: null, time: stamp },
    {
      line: 2,
      part: "2",
      kind: "tool_call",
      tool: "web-search",
      isError: false,
      callId: "c1",
      time: stamp,
    },
    {
      line: 3,
      part: "",
      kind: "tool_result",
      tool: "web-search",
      isError: true,
      callId: "c1",
      time: stamp,
    },
    {
      line: 4,
      part: "",
      kind: "tool_result",
      tool: "bash",
      isError: false,
      callId: "c2",
      time: stamp,
    },
  ]);
  index.close();
});

test("a model error is an item of part error, last in its entry's parts", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(
    session,
    headerLine(),
    assistantLine("a1", "session-one", [{ type: "text", text: "a text" }]),
    entryLine({
      type: "message",
      id: "a2",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "before the error" }],
        errorMessage: "the model failed",
      },
    }),
  );
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.deepEqual(
    itemsOf(index, session).map((row) => [row.entryId, row.part, row.kind]),
    [
      ["a1", "0", "assistant"],
      ["a2", "0", "assistant"],
      ["a2", "error", "error"],
    ],
  );
  index.close();
});

test("no committed transaction leaves a row for a file_id without a files row", async () => {
  const root = dir();
  const path = indexPath(root);
  const session = join(root, "s.jsonl");
  writeSession(
    session,
    headerLine(),
    userLine("a1", "session-one", "first text"),
    assistantLine("a2", "a1", [
      { type: "text", text: "a text" },
      { type: "toolCall", id: "c1", name: "Bash", arguments: { command: "x" } },
    ]),
  );
  const index = openIndex(path);
  assert.equal((await index.catchUp(session)).status, "complete");
  // A reset removes the file's rows with its own row.
  writeSession(session, headerLine());
  assert.equal((await index.catchUp(session)).status, "complete");
  index.close();
  const db = rawIndex(path);
  try {
    for (const table of ["entries", "items"]) {
      const orphans = must(
        db
          .prepare(
            `SELECT count(*) AS n FROM ${table} WHERE file_id NOT IN (SELECT file_id FROM files)`,
          )
          .get(),
      );
      assert.equal(orphans.n, 0, table);
    }
    const text = must(
      db
        .prepare(
          "SELECT count(*) AS n FROM item_text WHERE rowid NOT IN (SELECT item_id FROM items)",
        )
        .get(),
    );
    assert.equal(text.n, 0);
    assert.equal(must(db.prepare("SELECT count(*) AS n FROM items").get()).n, 0);
  } finally {
    db.close();
  }
});

test("the FTS rows are deleted together with their items", async () => {
  const root = dir();
  const path = indexPath(root);
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine(), userLine("a1", "session-one", "searchable phrase"));
  const index = openIndex(path);
  assert.equal((await index.catchUp(session)).status, "complete");
  assert.equal(ok(index.matchingItemIds(["sea"]))?.size, 1);
  rmSync(session);
  const pruned = await pruneSessionIndex({ path });
  assert.equal(pruned.files, 1);
  assert.equal(ok(index.matchingItemIds(["sea"]))?.size, 0);
  index.close();
  const db = rawIndex(path);
  try {
    assert.equal(must(db.prepare("SELECT count(*) AS n FROM item_text").get()).n, 0);
    assert.equal(must(db.prepare("SELECT count(*) AS n FROM items").get()).n, 0);
  } finally {
    db.close();
  }
});

test("the files row keeps the columns specs/session-index.md#schema gives it", async () => {
  const root = dir();
  const session = join(root, "s.jsonl");
  writeSession(session, headerLine("session-one"), userLine("a1", "session-one", "text"));
  const index = openIndex(indexPath(root));
  assert.equal((await index.catchUp(session)).status, "complete");
  const file = fileOf(index, session);
  assert.deepEqual(Object.keys(file).toSorted(), [
    "consumed",
    "fileId",
    "firstUserMessage",
    "lastTime",
    "lines",
    "mtime",
    "path",
    "sessionId",
    "sessionName",
    "started",
    "tailHash",
    "tailOffset",
  ]);
  assert.equal(file.sessionName, null);
  assert.equal(file.firstUserMessage, "text");
  index.close();
});
