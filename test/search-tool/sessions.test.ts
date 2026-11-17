import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupRoots,
  fixture,
  harness,
  headerLine,
  hitAddresses,
  setMtime,
  stamp,
  userLine,
  writeSession,
  type Fixture,
} from "./support.ts";
import type { SearchHost } from "../../lib/search-tool.ts";

/**
 * specs/search-tool.md Section 5: the `sessions` action, its order, its bounds,
 * its previews, and its details. `sessions` reads session files, and takes a
 * session's header from the index only for a file the index holds unchanged
 * (Section 2.1).
 */

after(cleanupRoots);

interface Project extends Fixture {
  host: SearchHost;
  childFile: string;
  otherFile: string;
}

/** A main session with a child and a second project member. */
function project(prefix = "search-tool-sessions-"): Project {
  const made = fixture(prefix);
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    userLine("u1", null, "first message of the main session", 1),
  );
  const childFile = join(made.agentDir, "kid-task1.jsonl");
  writeSession(
    childFile,
    headerLine("kid-session-id-0002"),
    userLine("k1", null, "the task of the child", 2),
  );
  const otherFile = join(made.sessions, "m2.jsonl");
  writeSession(
    otherFile,
    headerLine("other-session-id-0003"),
    userLine("v1", null, "first message of the other session", 3),
  );
  setMtime(made.mainFile, 1_700_000_003_000);
  setMtime(childFile, 1_700_000_001_000);
  setMtime(otherFile, 1_700_000_002_000);
  return {
    ...made,
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
    childFile,
    otherFile,
  };
}

test("tree order, the line parts, and the details of each session", async () => {
  const made = project();
  const mainBytes = statSync(made.mainFile).size;
  const childBytes = statSync(made.childFile).size;
  const h = harness({ db: made.db });
  const outcome = await h.call(made.host, { action: "sessions" });
  assert.equal(outcome.isError, false);
  assert.deepEqual(outcome.lines, [
    `self \u00b7 2026-01-01T00:00:00+00:00 \u00b7 ${mainBytes} bytes \u00b7 modified 2023-11-14T22:13:23+00:00 \u00b7 first message of the main session`,
    `kid-task1 \u00b7 2026-01-01T00:00:00+00:00 \u00b7 ${childBytes} bytes \u00b7 modified 2023-11-14T22:13:21+00:00 \u00b7 the task of the child`,
  ]);
  assert.equal(outcome.details.action, "sessions");
  assert.equal(outcome.details.scope, "tree");
  assert.equal(outcome.details.total, 2);
  assert.deepEqual(outcome.details.sessions, [
    {
      key: "self",
      path: made.mainFile,
      startedAt: Date.UTC(2026, 0, 1, 0, 0, 0),
      bytes: mainBytes,
      modifiedAt: 1_700_000_003_000,
      preview: "first message of the main session",
    },
    {
      key: "kid-task1",
      path: made.childFile,
      startedAt: Date.UTC(2026, 0, 1, 0, 0, 0),
      bytes: childBytes,
      modifiedAt: 1_700_000_001_000,
      preview: "the task of the child",
    },
  ]);
  // `sessions` never creates or uses the index.
  assert.equal(existsSync(made.db), false);
});

test("the project scope lists the invoking session first, then the members by mtime", async () => {
  const made = project();
  const h = harness({ db: made.db });
  const outcome = await h.call(made.host, { action: "sessions", scope: "project" });
  assert.deepEqual(
    outcome.lines.map((line) => line.slice(0, line.indexOf(" \u00b7 "))),
    ["self", "~other-session"],
  );
  assert.equal(outcome.details.total, 2);
  // A named member's tree.
  const named = await h.call(made.host, { action: "sessions", session: "kid-task1" });
  assert.deepEqual(
    named.lines.map((line) => line.slice(0, line.indexOf(" \u00b7 "))),
    ["kid-task1"],
  );
});

test("a changed session file gives its own header, not the index's row", async () => {
  const made = project();
  // The first call catches the session up, so the index holds its `files` row.
  const seeded = await harness({ db: made.db }).call(made.host, {
    action: "find",
    query: "first",
    scope: "project",
  });
  assert.equal(seeded.isError, false, seeded.text);
  // The member is rewritten in place under another session ID, and its directory's
  // stamp changes, so the next call discovers the tree afresh (Section 2.1).
  writeSession(
    made.otherFile,
    headerLine("renamed-session-id-0009"),
    userLine("v1", null, "first message of the other session", 3),
  );
  setMtime(made.otherFile, 1_700_000_004_000);
  setMtime(made.sessions, 1_700_000_000_000);
  const outcome = await harness({ db: made.db }).call(made.host, {
    action: "find",
    query: "first message of the other session",
    scope: "project",
  });
  assert.equal(outcome.isError, false, outcome.text);
  // The row describes bytes the file no longer holds, so the file's own header is
  // the one that names and times the session.
  assert.deepEqual(hitAddresses(outcome), ["~renamed-sessi:v1"]);
});

test("since and until bound the session file's modification time", async () => {
  const made = project();
  const h = harness({ db: made.db });
  const recent = await h.call(made.host, {
    action: "sessions",
    scope: "project",
    since: new Date(1_700_000_002_000).toISOString(),
  });
  assert.deepEqual(
    recent.lines.map((line) => line.slice(0, line.indexOf(" \u00b7 "))),
    ["self", "~other-session"],
  );
  const old = await h.call(made.host, {
    action: "sessions",
    scope: "project",
    until: new Date(1_700_000_002_000).toISOString(),
  });
  assert.deepEqual(old.lines, ["(no sessions)"]);
  assert.equal(old.details.total, 0);
  assert.deepEqual(old.details.sessions, []);
});

test("a limit adds the count of sessions not listed", async () => {
  const made = project();
  const h = harness({ db: made.db });
  const outcome = await h.call(made.host, { action: "sessions", scope: "project", limit: 1 });
  assert.deepEqual(outcome.lines, [
    `self \u00b7 2026-01-01T00:00:00+00:00 \u00b7 ${statSync(made.mainFile).size} bytes \u00b7 modified 2023-11-14T22:13:23+00:00 \u00b7 first message of the main session`,
    "\u2026 1 more sessions",
  ]);
  assert.equal(outcome.details.total, 2);
  assert.equal((outcome.details.sessions as unknown[]).length, 1);
});

test("a preview is the first user item among the first 50 lines", async () => {
  const made = fixture("search-tool-preview-");
  const lines: string[] = [headerLine("main-session-id-0001")];
  // 49 entries of a tool result, then a user entry on line 51.
  for (let index = 0; index < 49; index += 1) {
    lines.push(
      `{"type":"message","id":"r${index}","parentId":null,"timestamp":"${stamp(1)}","message":{"role":"toolResult","toolName":"Bash","toolCallId":"c${index}","isError":false,"content":[{"type":"text","text":"output ${index}"}]}}`,
    );
  }
  lines.push(userLine("u1", null, "too late to be previewed", 2));
  writeSession(made.mainFile, ...lines);
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const h = harness({ db: made.db });
  const outcome = await h.call(host, { action: "sessions" });
  assert.equal(
    outcome.lines[0]?.endsWith(" \u00b7 (no user message)"),
    true,
    outcome.lines[0] ?? "",
  );
  // A user entry within the first 50 lines is the preview, flattened and cut.
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    userLine("u1", null, "  the   first\n message  ", 2),
  );
  const previewed = await h.call(host, { action: "sessions" });
  assert.equal(
    previewed.lines[0]?.endsWith(" \u00b7 the first message"),
    true,
    previewed.lines[0] ?? "",
  );
});

test("a session without a session file is listed without one", async () => {
  const made = fixture("search-tool-no-file-");
  const host: SearchHost = { sessionFile: undefined, agentDirectory: made.agentDir, main: true };
  const h = harness({ db: made.db });
  const outcome = await h.call(host, { action: "sessions" });
  assert.deepEqual(outcome.lines, ["self \u00b7 (no session file)"]);
  assert.deepEqual(outcome.details.sessions, [
    { key: "self", path: null, startedAt: null, bytes: null, modifiedAt: null, preview: null },
  ]);
  assert.equal(outcome.details.total, 1);
  // A session without a session file passes neither bound.
  const bounded = await h.call(host, { action: "sessions", since: "1d" });
  assert.deepEqual(bounded.lines, ["(no sessions)"]);
});

test("tree order puts each session before its children, children by modification time", async () => {
  const made = fixture("search-tool-session-order-");
  writeSession(made.mainFile, headerLine("main-session-0001"), userLine("u1", null, "the root", 1));
  const agentDir = made.agentDir;
  writeSession(
    join(agentDir, "a-old.jsonl"),
    headerLine("kid-old-0002"),
    userLine("k1", null, "old child", 2),
  );
  writeSession(
    join(agentDir, "b-new.jsonl"),
    headerLine("kid-new-0003"),
    userLine("k2", null, "new child", 3),
  );
  setMtime(join(agentDir, "a-old.jsonl"), 1_700_000_001_000);
  setMtime(join(agentDir, "b-new.jsonl"), 1_700_000_009_000);
  // A child of the old child, older still, and a child of it.
  mkdirSync(join(agentDir, "a-old.agents"), { recursive: true });
  writeSession(
    join(agentDir, "a-old.agents", "deep.jsonl"),
    headerLine("deep-child-0004"),
    userLine("d1", null, "deep child", 4),
  );
  setMtime(join(agentDir, "a-old.agents", "deep.jsonl"), 1_700_000_000_500);
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const h = harness({ db: made.db });
  const outcome = await h.call(host, { action: "sessions" });
  assert.deepEqual(
    outcome.lines.map((line) => line.slice(0, line.indexOf(" \u00b7 "))),
    ["self", "b-new", "a-old", "a-old/deep"],
  );
  // A child the bound leaves out is not listed, and its children are listed in its place.
  const bounded = await h.call(host, {
    action: "sessions",
    until: new Date(1_700_000_005_000).toISOString(),
  });
  assert.deepEqual(
    bounded.lines.map((line) => line.slice(0, line.indexOf(" \u00b7 "))),
    ["a-old", "a-old/deep"],
  );
});

test("a `~` session key is resolved in the project, and a child is refused it", async () => {
  const made = project("search-tool-session-project-");
  const h = harness({ db: made.db });
  const main = await h.call(made.host, { action: "sessions", session: "~other-session" });
  assert.equal(main.isError, false, main.text);
  assert.deepEqual(
    main.lines.map((line) => line.slice(0, line.indexOf(" \u00b7 "))),
    ["~other-session"],
  );
  const childHost: SearchHost = {
    sessionFile: made.childFile,
    agentDirectory: join(made.agentDir, "kid-task1.agents"),
    main: false,
  };
  const child = await h.call(childHost, { action: "sessions", session: "~other-session" });
  assert.equal(child.text, "project scope is available to a main session only");
  // A project member may be named by its file path.
  const byPath = await h.call(made.host, { action: "sessions", session: made.otherFile });
  assert.deepEqual(
    byPath.lines.map((line) => line.slice(0, line.indexOf(" \u00b7 "))),
    ["~other-session"],
  );
  // A child does not reach a project member through its path, for either action.
  const childByPath = await h.call(childHost, { action: "sessions", session: made.otherFile });
  assert.equal(childByPath.isError, true);
  assert.doesNotMatch(childByPath.text, /other-session/);
  const childFind = await h.call(childHost, { action: "find", session: made.otherFile });
  assert.equal(childFind.isError, true);
  assert.doesNotMatch(childFind.text, /other-session/);
});
