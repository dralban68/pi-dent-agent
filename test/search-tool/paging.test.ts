import assert from "node:assert/strict";
import { after, test } from "node:test";
import { appendFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  cleanupRoots,
  fixture,
  harness,
  headerLine,
  hitAddresses,
  largestHold,
  testClock,
  threadCpuMs,
  userLine,
  writeSession,
} from "./support.ts";
import type { SearchHost } from "../../lib/search-tool.ts";
import { openSessionIndex } from "../../lib/session-index.ts";

/**
 * specs/search-tool.md#abort, specs/search-tool.md#candidates and specs/search-tool.md#evaluation: how a call pages through
 * candidate rows — a session's own rows whatever the index holds besides, deep
 * paging, a time group above the row cap, the filters a direct read applies, and
 * the bounds a page, a direct read, and a covering under a replaced index keep.
 */

after(cleanupRoots);

/** A project with one small invoking session and many tiny other sessions. */
function crowded(
  sessions: number,
  prefix = "search-tool-fixes-",
): {
  host: SearchHost;
  db: string;
  other: string;
  root: string;
} {
  const made = fixture(prefix);
  writeSession(
    made.mainFile,
    headerLine("main-session-0001"),
    userLine("a", null, "alpha needle a", 1),
    userLine("b", "a", "alpha b", 2),
  );
  const other = join(made.sessions, "m2.jsonl");
  writeSession(other, headerLine("other-session-0002"), userLine("v1", null, "needle other", 1));
  for (let index = 0; index < sessions; index += 1) {
    writeSession(
      join(made.sessions, `z${String(index).padStart(5, "0")}.jsonl`),
      headerLine(`noise-${String(index).padStart(6, "0")}`),
      userLine("n1", null, `noise ${index} haystack`, 2),
    );
  }
  return {
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
    db: made.db,
    other,
    root: made.root,
  };
}

/** Index every session of the fixture, as a warm-up call would. */
async function seed(
  db: string,
  sessionsDirectory: string,
  paths: readonly string[],
): Promise<void> {
  const opened = openSessionIndex({ path: db });
  if (!opened.ok) throw new Error(opened.reason);
  for (const path of paths) await opened.index.catchUp(path);
  opened.index.close();
  void sessionsDirectory;
}

test("a session-scope find does not depend on the other sessions of the index", async () => {
  const made = crowded(2000);
  const paths = [made.host.sessionFile ?? "", made.other];
  await seed(made.db, "", paths);
  const h = harness({ db: made.db });
  // Warm the index over every session first, so the call meets a full index.
  await h.call(made.host, { action: "find", query: "haystack", scope: "project-trees", limit: 1 });
  await h.runtime.backgroundDone();
  const started = Date.now();
  const outcome = await h.call(made.host, { action: "find", query: "needle", scope: "session" });
  const elapsed = Date.now() - started;
  assert.deepEqual(hitAddresses(outcome), ["self:a"]);
  assert.equal(elapsed < 500, true, `session-scope find took ${elapsed} ms`);
});

test("a call with a clock that never advances still ends, and deep paging reaches the last hit", async () => {
  const made = crowded(400);
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  const first = await h.call(made.host, {
    action: "find",
    query: "haystack",
    scope: "project-trees",
    limit: 100,
  });
  assert.equal(first.isError, false, first.text);
  await h.runtime.backgroundDone();
  // The clock stays where it is: every page must end on the index's own end.
  const noClock = await h.call(made.host, {
    action: "find",
    query: "zzzzabsent",
    scope: "project-trees",
  });
  assert.equal(noClock.isError, false, noClock.text);
  assert.deepEqual(hitAddresses(noClock), []);
  // Deep paging: 200 hits at limit 20, with the cost of page 10 no larger than page 1's.
  const lines: string[] = [headerLine("main-session-0001")];
  let parent: string | null = null;
  for (let index = 0; index < 500; index += 1) {
    const id = `p${index}`;
    lines.push(userLine(id, parent, `alpha page ${index}`, index + 1));
    parent = id;
  }
  writeSession(made.host.sessionFile ?? "", ...lines);
  const h2 = harness({ db: made.db });
  await h2.call(made.host, { action: "find", query: "alpha", scope: "session", limit: 1 });
  let cursor: string | undefined;
  let reached = 0;
  let firstPageMs = 0;
  let lastPageMs = 0;
  for (let page = 0; page < 25; page += 1) {
    const params: Record<string, unknown> = {
      action: "find",
      query: "alpha",
      scope: "session",
      limit: 20,
    };
    if (cursor !== undefined) params.after = cursor;
    const started = threadCpuMs();
    const outcome = await h2.call(made.host, params);
    const elapsed = Math.round(threadCpuMs() - started);
    if (page === 0) firstPageMs = elapsed;
    lastPageMs = elapsed;
    reached += hitAddresses(outcome).length;
    const next = outcome.details.next;
    if (outcome.details.more !== true || typeof next !== "string") break;
    cursor = next;
  }
  assert.equal(reached, 500);
  assert.equal(
    lastPageMs <= Math.max(50, firstPageMs * 4 + 50),
    true,
    `page costs ${firstPageMs} → ${lastPageMs} ms`,
  );
});

test("an abort during paging is observed within 100 ms", async () => {
  const made = crowded(2000);
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  await h.call(made.host, { action: "find", query: "haystack", scope: "project-trees", limit: 1 });
  await h.runtime.backgroundDone();
  const controller = new AbortController();
  const pending = h.call(
    made.host,
    { action: "find", query: "zzzzabsent", scope: "project-trees" },
    controller.signal,
  );
  await new Promise((done) => setTimeout(done, 20));
  const abortedAt = Date.now();
  controller.abort();
  const outcome = await pending;
  const elapsed = Date.now() - abortedAt;
  assert.equal(outcome.text, "Search aborted");
  assert.equal(elapsed < 100, true, `the abort took ${elapsed} ms`);
});

test("a direct read applies every filter of specs/search-tool.md#candidates", async () => {
  const made = fixture("search-tool-fixes-direct-");
  writeSession(
    made.mainFile,
    headerLine("main-session-0001"),
    userLine("u1", null, "alpha one", 1),
    `{"type":"message","id":"a1","parentId":"u1","timestamp":"${new Date(Date.UTC(2026, 0, 1, 0, 0, 2)).toISOString()}","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"Bash","arguments":{"command":"alpha"}}]}}`,
    `{"type":"message","id":"r1","parentId":"a1","timestamp":"${new Date(Date.UTC(2026, 0, 1, 0, 0, 3)).toISOString()}","message":{"role":"toolResult","toolName":"Bash","toolCallId":"c1","isError":true,"content":[{"type":"text","text":"alpha failed"}]}}`,
    userLine("u2", "r1", "alpha two", 4),
  );
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const unusable = made.db.replace("search-v3.sqlite", "unusable.sqlite");
  const handle = new DatabaseSync(unusable);
  handle.exec("PRAGMA user_version = 9;");
  handle.close();
  const h = harness({ db: unusable });
  assert.deepEqual(
    hitAddresses(await h.call(host, { action: "find", query: "alpha", kinds: ["user"] })),
    ["self:u2", "self:u1"],
  );
  assert.deepEqual(
    hitAddresses(await h.call(host, { action: "find", query: "alpha", tool: "bash" })),
    ["self:r1", "self:a1.0"],
  );
  assert.deepEqual(
    hitAddresses(await h.call(host, { action: "find", query: "alpha", isError: true })),
    ["self:r1"],
  );
  assert.deepEqual(
    hitAddresses(await h.call(host, { action: "find", query: "alpha", isError: false })),
    [],
  );
  assert.deepEqual(
    hitAddresses(
      await h.call(host, { action: "find", query: "alpha", since: "2026-01-01T00:00:04Z" }),
    ),
    ["self:u2"],
  );
  assert.deepEqual(
    hitAddresses(
      await h.call(host, { action: "find", query: "alpha", until: "2026-01-01T00:00:02Z" }),
    ),
    ["self:u1"],
  );
});

test("a time group above the row cap is walked in the call's order without repeats", async () => {
  const made = fixture("search-tool-fixes-group-");
  const lines: string[] = [headerLine("main-session-0001")];
  let parent: string | null = null;
  for (let index = 0; index < 50100; index += 1) {
    const id = `h${index}`;
    lines.push(userLine(id, parent, `alpha huge ${index}`, 1));
    parent = id;
  }
  writeSession(made.mainFile, ...lines);
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const h = harness({ db: made.db });
  const outcome = await h.call(host, {
    action: "find",
    query: "alpha",
    limit: 100,
    order: "oldest",
  });
  const addresses = hitAddresses(outcome);
  assert.equal(addresses.length, 100);
  assert.deepEqual(
    addresses,
    Array.from({ length: 100 }, (_, index) => `self:h${index}`),
  );
  assert.equal(new Set(addresses).size, 100);
});

test("discovery and a sparse filter scan do not hold the event loop for 250 ms", async () => {
  const made = crowded(2000);
  const h = harness({ db: made.db });
  const gap = await largestHold(async () => {
    // The first call discovers every session and the second runs a filter that
    // matches nothing, which scans the whole candidate order.
    await h.call(made.host, { action: "find", query: "needle", scope: "project-trees", limit: 1 });
    await h.runtime.backgroundDone();
    await h.call(made.host, { action: "find", isError: true, scope: "project-trees" });
  });
  assert.equal(gap < 250, true, `the event loop was held for ${gap} ms`);
});

test("get answered from the index uses only entries within the call-start size", async () => {
  const made = fixture("search-tool-fixes-get-");
  writeSession(
    made.mainFile,
    headerLine("main-session-0001"),
    userLine("u1", null, "alpha one", 1),
    userLine("u2", "u1", "alpha two", 2),
  );
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  let appended = false;
  h.hook((event) => {
    if (event.phase !== "sizes" || appended) return;
    appended = true;
    // An entry written after the call started: it must be no neighbour and no pair.
    appendFileSync(made.mainFile, `${userLine("u9", "u2", "alpha late", 9)}\n`);
  });
  const outcome = await h.call(host, { action: "get", address: "self:u2", context: 2 });
  assert.equal(outcome.isError, false, outcome.text);
  assert.equal(outcome.lines.includes("After:"), false, outcome.text);
  assert.equal(outcome.text.includes("self:u9"), false, outcome.text);
  // The same address in a later call, whose start is after the append, does show it.
  const later = await harness({ db: made.db }).call(host, {
    action: "get",
    address: "self:u2",
    context: 2,
  });
  assert.equal(later.text.includes("self:u9"), true, later.text);
});

test("an index replaced during covering keeps the sessions covered", async () => {
  const made = crowded(0);
  const sessions = [made.host.sessionFile ?? "", made.other];
  await seed(made.db, "", sessions);
  const copy = `${made.db}.copy`;
  copyFileSync(made.db, copy);
  const clock = testClock();
  const h = harness({ db: made.db, clock });
  let replaced = false;
  h.hook((event) => {
    if (event.phase !== "cover" || replaced) return;
    replaced = true;
    // The index file is replaced while the call covers its sessions.
    rmSync(made.db);
    copyFileSync(copy, made.db);
  });
  const outcome = await h.call(made.host, { action: "find", query: "needle", scope: "project" });
  assert.equal(outcome.details.uncovered, 0, outcome.text);
  assert.deepEqual(hitAddresses(outcome), ["~other-session:v1", "self:a"]);
});
