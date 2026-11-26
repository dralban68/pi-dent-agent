import assert from "node:assert/strict";
import { after, test } from "node:test";

import { readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  cleanupRoots,
  fixture,
  harness,
  headerLine,
  hitAddresses,
  largestHold,
  setMtime,
  userLine,
  writeSession,
} from "./support.ts";
import { searchRuntime, type SearchHost } from "../../lib/search-tool.ts";

/**
 * specs/search-tool.md#evaluation: how the candidates of a call are read — the
 * per-session path and its narrowing, the index-wide scan a sparse filter needs,
 * a session's kept discovery, and what happens to a covered session when the
 * index is deleted or its rows go.
 */

after(cleanupRoots);

/** A tree of one big child session, for the narrowing test (specs/search-tool.md#evaluation). */
function bigTree(
  lines: number,
  prefix = "search-tool-r3-narrow-",
): { host: SearchHost; db: string } {
  const made = fixture(prefix);
  writeSession(made.mainFile, headerLine("main-session-0001"), userLine("a", null, "alpha a", 1));
  const kid = join(made.agentDir, "kid-task1.jsonl");
  const content: string[] = [headerLine("kid-session-0002")];
  let parent: string | null = null;
  for (let index = 0; index < lines; index += 1) {
    const id = `k${index}`;
    content.push(userLine(id, parent, `line ${index} of the child`, index + 2));
    parent = id;
  }
  writeSession(kid, ...content);
  return {
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
    db: made.db,
  };
}

test("the per-session path narrows by trigrams: an absent word reads back no item", async () => {
  const made = bigTree(2000);
  let reads = 0;
  const runtime = searchRuntime({
    indexPath: made.db,
    zone: "UTC",
    now: () => Date.UTC(2026, 0, 1),
    onItemRead: () => {
      reads += 1;
    },
  });
  const outcome = await runtime.execute({
    ...made.host,
    params: { action: "find", query: "zqxjv", scope: "tree" } as never,
    signal: undefined,
  });
  await runtime.backgroundDone();
  const text = outcome.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  assert.deepEqual(
    text.split("\n").filter((line) => line.includes(" \u00b7 ")),
    [],
  );
  assert.equal(reads, 0, `${reads} items were read back for a word no item contains`);
});

/**
 * Age every directory under `root`, so a discovery of it is kept for later calls.
 */
function ageDirectories(root: string): void {
  const past = (Date.now() - 60_000) / 1000;
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(path, entry.name));
    }
    utimesSync(path, past, past);
  };
  visit(root);
}

test("a kept discovery gives way to the sessions that search after it", async () => {
  // The number of kept discoveries is the implementation's; this test makes far
  // more calls than any small bound, and checks the bound holds by behaviour: once
  // other sessions have searched, a changed directory is discovered afresh.
  const made = fixture("search-tool-forest-bound-");
  writeSession(
    made.mainFile,
    headerLine("main-session-0001"),
    userLine("a", null, "needle main", 1),
  );
  const member = join(made.sessions, "m2.jsonl");
  writeSession(member, headerLine("member-session-02"), userLine("b", null, "needle member", 2));
  // A whole-second instant in the past, so both writes of it are one stamp.
  const past = Math.floor((Date.now() - 60_000) / 1000) * 1000;
  setMtime(made.sessions, past);
  setMtime(made.agentDir, past);
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const h = harness({ db: made.db });
  const keys = async (): Promise<string[]> => {
    const outcome = await h.call(host, { action: "sessions", scope: "project" });
    assert.equal(outcome.isError, false, outcome.text);
    return outcome.lines.map((line) => line.slice(0, line.indexOf(" \u00b7 ")));
  };
  assert.deepEqual(await keys(), ["self", "~member-sessio"]);
  // The member goes, and the sessions directory's stamp is set back as it was: a
  // fresh discovery would find one session, the kept one still lists two.
  rmSync(member);
  setMtime(made.sessions, past);
  assert.deepEqual(await keys(), ["self", "~member-sessio"]);
  // Sixteen other sessions search, each with a directory of its own, which ages
  // every kept discovery but the most recent ones out of the process.
  for (let index = 0; index < 16; index += 1) {
    const other = fixture(`search-tool-forest-bound-${index}-`);
    writeSession(
      other.mainFile,
      headerLine(`else-session-${index}`),
      userLine("x", null, "needle else", 1),
    );
    setMtime(other.sessions, past);
    setMtime(other.agentDir, past);
    const outcome = await harness({ db: other.db }).call(
      { sessionFile: other.mainFile, agentDirectory: other.agentDir, main: true },
      { action: "sessions", scope: "project" },
    );
    assert.equal(outcome.isError, false, outcome.text);
  }
  // The first session's discovery was dropped, so the removed member is gone.
  assert.deepEqual(await keys(), ["self"]);
});

test("a kept discovery still finds every session added, removed, or completed since", async () => {
  const made = fixture("search-tool-r3-forest-");
  writeSession(
    made.mainFile,
    headerLine("main-session-0001"),
    userLine("a", null, "needle main", 1),
  );
  const memberPath = join(made.sessions, "m2.jsonl");
  writeSession(
    memberPath,
    headerLine("member-session-02"),
    userLine("b", null, "needle member", 2),
  );
  // A `.jsonl` file whose header is not written yet: not a session, for now.
  const late = join(made.sessions, "m3.jsonl");
  writeFileSync(late, "");
  ageDirectories(made.root);
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const h = harness({ db: made.db });
  const keys = async (scope: string): Promise<string[]> => {
    const outcome = await h.call(host, { action: "find", query: "needle", scope });
    assert.equal(outcome.isError, false, outcome.text);
    return hitAddresses(outcome).toSorted();
  };
  assert.deepEqual(await keys("project-trees"), ["self:a", "~member-sessio:b"]);
  // The forest is kept now; each change below must show in the next call.
  writeSession(
    join(made.agentDir, "kid-task1.jsonl"),
    headerLine("kid-session-0003"),
    userLine("c", null, "needle kid", 3),
  );
  assert.deepEqual(await keys("tree"), ["kid-task1:c", "self:a"]);
  assert.deepEqual(await keys("project-trees"), ["kid-task1:c", "self:a", "~member-sessio:b"]);
  ageDirectories(made.root);
  await keys("project-trees");
  // A header written into a file passed over, with no directory changed.
  writeFileSync(
    late,
    `${headerLine("late-session-0004")}\n${userLine("d", null, "needle late", 4)}\n`,
  );
  assert.deepEqual(await keys("project"), ["self:a", "~late-session-:d", "~member-sessio:b"]);
  ageDirectories(made.root);
  await keys("project");
  rmSync(memberPath);
  assert.deepEqual(await keys("project"), ["self:a", "~late-session-:d"]);
});

test("an index file deleted during covering keeps the sessions covered", async () => {
  const made = fixture("search-tool-r3-deleted-");
  writeSession(
    made.mainFile,
    headerLine("main-session-0001"),
    userLine("a", null, "needle main", 1),
  );
  for (let index = 2; index <= 5; index += 1) {
    writeSession(
      join(made.sessions, `m${index}.jsonl`),
      headerLine(`member-${index}-session`),
      userLine(`v${index}`, null, `needle ${index}`, index),
    );
  }
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const h = harness({ db: made.db });
  await h.call(host, { action: "find", query: "warmup", scope: "project" });
  await h.runtime.backgroundDone();
  let covers = 0;
  const coveredAfter: string[] = [];
  h.hook((event) => {
    if (event.phase !== "cover") return;
    covers += 1;
    if (covers > 2 && event.key !== undefined) coveredAfter.push(event.key);
    if (covers === 2) {
      rmSync(made.db, { force: true });
      rmSync(`${made.db}-wal`, { force: true });
      rmSync(`${made.db}-shm`, { force: true });
    }
  });
  const outcome = await h.call(host, { action: "find", query: "needle", scope: "project" });
  h.hook(undefined);
  assert.equal(outcome.isError, false, outcome.text);
  // The two sessions covered before the deletion lose their cover: the index was
  // opened anew (specs/search-tool.md#coverage). The three covered after it are caught up into the
  // new file before the fast path is tried, so they stay covered.
  assert.equal(outcome.details.uncovered, 2, outcome.text);
  assert.equal(coveredAfter.length, 3);
  assert.deepEqual(
    hitAddresses(outcome)
      .map((address) => address.slice(0, address.indexOf(":")))
      .toSorted(),
    coveredAfter.toSorted(),
    outcome.text,
  );
});

test("a filter no item passes ends unstopped and yields to the event loop", async () => {
  const made = fixture("search-tool-r3-sparse-");
  writeSession(made.mainFile, headerLine("main-session-0001"), userLine("a", null, "alpha", 1));
  // 400 project members of 600 items each: 240000 lines, above the per-session bound.
  for (let member = 0; member < 400; member += 1) {
    const lines = [headerLine(`member-${String(member).padStart(4, "0")}-sess`)];
    let parent: string | null = null;
    for (let index = 0; index < 600; index += 1) {
      const id = `m${member}x${index}`;
      lines.push(userLine(id, parent, `plain text ${index}`, 10 + index));
      parent = id;
    }
    writeSession(join(made.sessions, `p${member}.jsonl`), ...lines);
  }
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const h = harness({ db: made.db });
  await h.call(host, { action: "find", query: "warmup", scope: "project" });
  await h.runtime.backgroundDone();
  const gap = await largestHold(async () => {
    for (const params of [
      { isError: true },
      { tool: "Bash" },
      { kinds: ["summary"] },
      { isError: true, query: "plain text" },
    ]) {
      const outcome = await h.call(host, { action: "find", scope: "project", ...params });
      assert.equal(outcome.isError, false, outcome.text);
      assert.equal(outcome.details.stopped, false, outcome.text);
      assert.deepEqual(hitAddresses(outcome), [], JSON.stringify(params));
    }
  });
  assert.ok(gap < 250, `the event loop was held for ${gap} ms`);
});

test("rows gone between a session's load and its narrowing probe take its cover away", async () => {
  const made = fixture("search-tool-r3-probe-");
  // The searched session: 1000 items, every 100th with the word.
  const lines = [headerLine("main-session-0001")];
  let parent: string | null = null;
  for (let index = 0; index < 1000; index += 1) {
    const id = `s${index}`;
    lines.push(userLine(id, parent, index % 100 === 0 ? `needle ${index}` : `hay ${index}`, index));
    parent = id;
  }
  writeSession(made.mainFile, ...lines);
  // A project member with 2500 matches, so the index-wide lookup overflows.
  const bulk = [headerLine("bulk-session-0002")];
  parent = null;
  for (let index = 0; index < 2500; index += 1) {
    const id = `b${index}`;
    bulk.push(userLine(id, parent, `needle bulk ${index}`, index));
    parent = id;
  }
  writeSession(join(made.sessions, "m2.jsonl"), ...bulk);
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const h = harness({ db: made.db });
  await h.call(host, { action: "find", query: "warmup", scope: "project" });
  await h.runtime.backgroundDone();
  const all = await h.call(host, { action: "find", query: "needle", scope: "session" });
  assert.equal(hitAddresses(all).length, 10, all.text);
  let deleted = false;
  h.hook((event) => {
    if (event.phase !== "decide" || deleted) return;
    deleted = true;
    // Another process resets the session's rows after its first probe.
    const db = new DatabaseSync(made.db);
    const row = db.prepare("SELECT file_id FROM files WHERE path LIKE '%/m1.jsonl'").get() as {
      file_id: number;
    };
    db.prepare("DELETE FROM items WHERE file_id = ?").run(row.file_id);
    db.close();
  });
  const outcome = await h.call(host, { action: "find", query: "needle", scope: "session" });
  h.hook(undefined);
  assert.equal(outcome.isError, false, outcome.text);
  const shown = hitAddresses(outcome);
  assert.deepEqual(shown, hitAddresses(all).slice(0, shown.length));
  assert.ok(shown.length < 10, outcome.text);
  assert.equal(outcome.details.uncovered, 1, outcome.text);
});
