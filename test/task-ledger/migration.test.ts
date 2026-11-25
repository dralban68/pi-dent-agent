import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createFormat1, Format1Writer } from "./format-1.ts";
import {
  ok,
  openLedger,
  raw,
  sessionRow,
  taskRow,
  tempDir,
  usage,
  userVersionOf,
} from "./support.ts";

/** specs/task-ledger.md Sections 1 and 2.3: the migration of a format version 1 file. */

/** Every column, index, and trigger of the file, as SQLite describes them. */
function schemaOf(path: string): unknown {
  const db = raw(path);
  try {
    const columns = (table: string) =>
      db
        .prepare(`PRAGMA table_xinfo(${table})`)
        .all()
        .map((row) => ({ ...row }));
    const objects = db
      .prepare(
        "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY name",
      )
      .all()
      .map((row) => ({ ...row }));
    const indexes = (table: string) =>
      db
        .prepare(`PRAGMA index_list(${table})`)
        .all()
        .map((row) => ({
          ...row,
          columns: db.prepare(`PRAGMA index_info(${String(row.name)})`).all(),
        }));
    const triggerSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((row) => String(row.sql));
    return {
      sessions: columns("sessions"),
      tasks: columns("tasks"),
      objects,
      sessionIndexes: indexes("sessions"),
      taskIndexes: indexes("tasks"),
      triggerSql,
    };
  } finally {
    db.close();
  }
}

test("a version 1 file with rows migrates in place to version 2, keeping every row with null counts", async () => {
  const dir = tempDir();
  const path = join(dir, "tasks-v1.sqlite");
  createFormat1(path);
  const old = new Format1Writer(path);
  old.insertAgent("row-1", "a1b2c3d4", 0);
  old.setUsage("row-1", 3);
  old.insertAgent("row-2", "b1b2c3d4", 0);
  // Settled, so the sweep that follows the opening leaves them as they are.
  old.settle("row-1");
  old.settle("row-2");
  old.writeSession("main-old", 5);
  old.close();
  const before = { one: taskRow(path, "row-1"), two: taskRow(path, "row-2") };
  const beforeSession = sessionRow(path, "main-old");

  const { ledger, notices } = openLedger({ path });
  await ledger.flushed();
  assert.equal(ledger.unusableReason(), undefined);
  assert.deepEqual(notices, []);
  assert.equal(userVersionOf(path), 2);
  assert.deepEqual(taskRow(path, "row-1"), { ...before.one, tool_calls: null });
  assert.deepEqual(taskRow(path, "row-2"), { ...before.two, tool_calls: null });
  assert.deepEqual(sessionRow(path, "main-old"), { ...beforeSession, tool_calls: null });
  const db = raw(path);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get()?.n, 2, "no row added");
  db.close();
  // An unknown count is no figure, never 0.
  const figures = ok(await ledger.readRowFigures(["row-1"])).get("row-1");
  assert.equal(figures?.toolCalls, undefined);
  assert.equal(figures?.own.turns, 3);
  ledger.close();

  // The same schema as a file created at format version 2.
  const fresh = openLedger();
  await fresh.ledger.flushed();
  fresh.ledger.close();
  assert.deepEqual(schemaOf(path), schemaOf(fresh.path));
});

test("a migration that fails is rolled back whole and leaves the ledger unusable", async () => {
  const dir = tempDir();
  const path = join(dir, "tasks-v1.sqlite");
  createFormat1(path);
  const db = raw(path);
  db.exec("DROP TABLE tasks;");
  db.close();
  const { ledger, notices } = openLedger({ path });
  await ledger.flushed();
  assert.equal(ledger.unusableReason(), "no such table: tasks");
  assert.equal(notices.length, 1);
  assert.equal(userVersionOf(path), 1);
  const after = raw(path);
  try {
    const columns = after
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name);
    assert.equal(columns.includes("tool_calls"), false, "the first statement was rolled back");
    assert.equal(
      after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get()?.n,
      0,
    );
  } finally {
    after.close();
  }
});

test("a format 1 process writing after the migration leaves null counts, never a stale one", async () => {
  const dir = tempDir();
  const path = join(dir, "tasks-v1.sqlite");
  createFormat1(path);
  // The old process opened the ledger before the migration and keeps its connection.
  const old = new Format1Writer(path);
  old.writeSession("shared", 1);
  const { ledger } = openLedger({ path });
  await ledger.flushed();
  assert.equal(userVersionOf(path), 2);
  ledger.writeSession({
    sessionId: "shared",
    sessionFile: null,
    cwd: "/w",
    usage: usage(1, 1, 0.1, 2),
    toolCalls: 5,
  });
  await ledger.flushed();
  assert.equal(sessionRow(path, "shared")?.tool_calls, 5);

  old.insertAgent("old-row", "c1b2c3d4", 0);
  old.setUsage("old-row", 4);
  old.writeSession("shared", 9);
  old.writeSession("old-only", 2);
  old.close();
  // Closed and opened again without reading user_version, as a 0.2.27 instance does.
  const reopened = new Format1Writer(path);
  reopened.setUsage("old-row", 6);
  reopened.close();

  assert.deepEqual(
    [taskRow(path, "old-row").turns, taskRow(path, "old-row").tool_calls],
    [6, null],
  );
  assert.deepEqual(
    [sessionRow(path, "shared")?.turns, sessionRow(path, "shared")?.tool_calls],
    [9, null],
    "the old update of turns made the count unknown",
  );
  assert.equal(sessionRow(path, "old-only")?.tool_calls, null);

  ledger.writeSession({
    sessionId: "shared",
    sessionFile: null,
    cwd: "/w",
    usage: usage(1, 1, 0.1, 10),
    toolCalls: 6,
  });
  await ledger.flushed();
  assert.deepEqual(
    [sessionRow(path, "shared")?.turns, sessionRow(path, "shared")?.tool_calls],
    [10, 6],
  );
  ledger.close();
});

const CHILD = `
const [url, path, dir, at] = process.argv.slice(1);
const { openTaskLedger } = await import(url);
const keepAlive = setInterval(() => {}, 1000);
while (Date.now() < Number(at)) {}
const ledger = openTaskLedger({
  path, storePath: dir + "/fleet.sqlite", indexPath: dir + "/search.sqlite", notify: () => {},
});
await ledger.flushed();
console.log(JSON.stringify({ reason: ledger.unusableReason() ?? null }));
ledger.close();
clearInterval(keepAlive);
`;

function runChild(args: string[]): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun(out.trim());
      else reject(new Error(`child exited ${code}: ${err}`));
    });
  });
}

test("processes racing to open a version 1 file migrate it once", async () => {
  const url = pathToFileURL(join(import.meta.dirname, "..", "..", "lib", "task-ledger.ts")).href;
  const dir = tempDir();
  const path = join(dir, "tasks-v1.sqlite");
  createFormat1(path);
  const old = new Format1Writer(path);
  old.insertAgent("row-1", "a1b2c3d4", 2);
  old.close();
  const at = String(Date.now() + 500);
  const outputs = await Promise.all([0, 1, 2].map(() => runChild([url, path, dir, at])));
  // A second migration would fail on the column the first added.
  assert.deepEqual(outputs, Array(3).fill(JSON.stringify({ reason: null })));
  assert.equal(userVersionOf(path), 2);
  assert.equal(taskRow(path, "row-1").tool_calls, null);
  const db = raw(path);
  try {
    const toolCalls = db
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .filter((row) => row.name === "tool_calls");
    assert.equal(toolCalls.length, 1);
  } finally {
    db.close();
  }
});
