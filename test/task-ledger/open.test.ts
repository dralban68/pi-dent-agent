import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, linkSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { LEDGER_FILE_NAME, taskLedgerPath, TASKS_DB_ENV } from "../../lib/task-ledger.ts";
import { inserted, openLedger, raw, taskRow, tempDir, userVersionOf } from "./support.ts";

/** specs/task-ledger.md Sections 1, 2 and 7: location, opening, schema, and an unusable ledger. */

test("the ledger path is PI_DENT_TASKS_DB when set and non-empty, else ~/.pi/pi-dent/tasks-v1.sqlite", () => {
  assert.equal(TASKS_DB_ENV, "PI_DENT_TASKS_DB");
  assert.equal(LEDGER_FILE_NAME, "tasks-v1.sqlite");
  assert.equal(taskLedgerPath({ PI_DENT_TASKS_DB: "rel/t.sqlite" }, "/home/u"), "rel/t.sqlite");
  assert.equal(
    taskLedgerPath({ PI_DENT_TASKS_DB: "" }, "/home/u"),
    "/home/u/.pi/pi-dent/tasks-v1.sqlite",
  );
  assert.equal(taskLedgerPath({}, "/home/u"), "/home/u/.pi/pi-dent/tasks-v1.sqlite");
});

test("the first opening creates the directory, the file, the schema and user_version 1 in WAL mode", async () => {
  const dir = tempDir();
  const { ledger, path, notices } = openLedger({ path: join(dir, "a", "b", "tasks.sqlite") });
  await ledger.flushed();
  assert.equal(ledger.unusableReason(), undefined);
  assert.deepEqual(notices, []);
  assert.equal(userVersionOf(path), 1);
  const db = raw(path);
  try {
    const names = db
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type DESC, name",
      )
      .all()
      .map((row) => `${String(row.type)} ${String(row.name)}`);
    assert.deepEqual(names, [
      "table sessions",
      "table tasks",
      "index tasks_parent",
      "index tasks_running",
      "index tasks_session",
      "index tasks_session_path",
    ]);
    const columns = (table: string) =>
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
    assert.deepEqual(columns("sessions"), [
      "session_id",
      "session_file",
      "cwd",
      "started_at",
      "updated_at",
      "input",
      "output",
      "cache_read",
      "cache_write",
      "cost",
      "turns",
    ]);
    assert.deepEqual(columns("tasks"), [
      "row_id",
      "session_id",
      "task_id",
      "parent_id",
      "resumes_id",
      "fleet_query",
      "kind",
      "background",
      "cwd",
      "agent",
      "label",
      "model",
      "status",
      "dispatched",
      "started_at",
      "settled_at",
      "updated_at",
      "owner_pid",
      "owner_started",
      "session_path",
      "result_path",
      "input",
      "output",
      "cache_read",
      "cache_write",
      "cost",
      "turns",
    ]);
    assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  } finally {
    db.close();
  }
  ledger.close();
});

test("an existing version 1 ledger is used with its rows", async () => {
  const first = openLedger();
  const rowId = inserted(first.ledger);
  await first.ledger.flushed();
  first.ledger.close();
  const second = openLedger({ path: first.path });
  await second.ledger.flushed();
  assert.equal(second.ledger.unusableReason(), undefined);
  assert.equal(taskRow(first.path, rowId).task_id, "a1b2c3d4");
  second.ledger.close();
});

test("a ledger path naming the local session store's file is refused without opening it", async () => {
  const dir = tempDir();
  const store = join(dir, "fleet.sqlite");
  writeFileSync(store, "store bytes");
  const { ledger, notices } = openLedger({ path: store, storePath: store });
  await ledger.flushed();
  const reason = "the task ledger file is the local session store file";
  assert.equal(ledger.unusableReason(), reason);
  assert.deepEqual(notices, [
    { message: `pi-dent: task ledger unavailable: ${reason}`, level: "warning" },
  ]);
  assert.equal(readFileSync(store, "utf8"), "store bytes");
});

test("a ledger path that is a hard link to the session index's file is refused", async () => {
  const dir = tempDir();
  const index = join(dir, "search-v2.sqlite");
  writeFileSync(index, "index bytes");
  const link = join(dir, "tasks-v1.sqlite");
  linkSync(index, link);
  const { ledger } = openLedger({ path: link, indexPath: index });
  await ledger.flushed();
  assert.equal(ledger.unusableReason(), "the task ledger file is the session index file");
  assert.equal(readFileSync(index, "utf8"), "index bytes");
});

test("an absent ledger path equal to the session index's path is refused and not created", async () => {
  const dir = tempDir();
  const path = join(dir, "same.sqlite");
  const { ledger } = openLedger({ path, indexPath: join(dir, ".", "same.sqlite") });
  await ledger.flushed();
  assert.equal(ledger.unusableReason(), "the task ledger file is the session index file");
  assert.equal(existsSync(path), false);
});

test("a wrong user_version leaves the file unchanged and makes the ledger unusable with one notice", async () => {
  const dir = tempDir();
  const path = join(dir, "tasks-v1.sqlite");
  const db = raw(path);
  db.exec("CREATE TABLE other (a INTEGER); INSERT INTO other VALUES (1); PRAGMA user_version = 7;");
  db.close();
  const before = readFileSync(path);
  const { ledger, notices } = openLedger({ path });
  await ledger.flushed();
  assert.equal(ledger.unusableReason(), "unsupported task ledger version 7");
  assert.equal(readFileSync(path).equals(before), true);
  assert.equal(existsSync(`${path}-wal`), false);
  // Unusable for the rest of the instance: no row, reads unavailable, no second notice.
  assert.equal(
    ledger.insertTask({
      sessionId: "s",
      taskId: "t",
      fleetQuery: false,
      kind: "bash",
      background: false,
      cwd: "/",
      label: "l",
      startedAt: 1,
    }),
    undefined,
  );
  assert.deepEqual(await ledger.readAgentFigures("s"), {
    status: "unavailable",
    reason: "unsupported task ledger version 7",
  });
  assert.deepEqual(notices, [
    {
      message: "pi-dent: task ledger unavailable: unsupported task ledger version 7",
      level: "warning",
    },
  ]);
  assert.equal(readFileSync(path).equals(before), true);
});

test("user_version 0 with a table is unusable and left unchanged", async () => {
  const dir = tempDir();
  const path = join(dir, "tasks-v1.sqlite");
  const db = raw(path);
  db.exec("CREATE TABLE other (a INTEGER);");
  db.close();
  const before = readFileSync(path);
  const { ledger } = openLedger({ path });
  await ledger.flushed();
  assert.equal(ledger.unusableReason(), "unsupported task ledger version 0");
  assert.equal(readFileSync(path).equals(before), true);
});

test("a corrupt file is left unchanged and the ledger is unusable with the corrupt reason", async () => {
  const dir = tempDir();
  const path = join(dir, "tasks-v1.sqlite");
  writeFileSync(path, "this is not a database, it is long enough to look like a header....");
  const before = readFileSync(path);
  const { ledger, notices } = openLedger({ path });
  await ledger.flushed();
  assert.equal(ledger.unusableReason(), "task ledger file is corrupt: file is not a database");
  assert.equal(notices.length, 1);
  assert.equal(readFileSync(path).equals(before), true);
  assert.equal(existsSync(`${path}-wal`), false);
});

test("a directory that cannot be created makes the ledger unusable with the error's message", async () => {
  const dir = tempDir();
  const blocker = join(dir, "file");
  writeFileSync(blocker, "");
  const { ledger } = openLedger({ path: join(blocker, "sub", "tasks.sqlite") });
  await ledger.flushed();
  assert.match(ledger.unusableReason() ?? "", /ENOTDIR|EEXIST/);
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

test("two processes opening an absent file both use one schema", async () => {
  const url = pathToFileURL(join(import.meta.dirname, "..", "..", "lib", "task-ledger.ts")).href;
  for (let round = 0; round < 3; round += 1) {
    const dir = tempDir();
    const path = join(dir, "tasks-v1.sqlite");
    const at = String(Date.now() + 500);
    const outputs = await Promise.all([0, 1, 2].map(() => runChild([url, path, dir, at])));
    assert.deepEqual(outputs, Array(3).fill(JSON.stringify({ reason: null })));
    assert.equal(userVersionOf(path), 1);
    const db = raw(path);
    try {
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()?.n,
        2,
      );
    } finally {
      db.close();
    }
  }
});
