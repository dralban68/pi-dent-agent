import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupRoots,
  fixture,
  harness,
  headerLine,
  hitAddresses,
  userLine,
  writeSession,
  type Fixture,
} from "./support.ts";
import type { SearchHost } from "../../lib/search-tool.ts";

/**
 * specs/search-tool.md#validation, specs/search-tool.md#reach, specs/search-tool.md#result, and specs/search-tool.md#get: the validation checks, in
 * their order, with their exact error texts, and the file-system checks that
 * follow them.
 */

after(cleanupRoots);

/** A main session with a child session and a second project member. */
function project(): Fixture & { host: SearchHost; childFile: string; otherFile: string } {
  const made = fixture("search-tool-validation-");
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    userLine("u1", null, "alpha one", 1),
    userLine("u2", "u1", "alpha two", 2),
  );
  const childFile = join(made.agentDir, "kid-task7.jsonl");
  writeSession(childFile, headerLine("kid-session-id-0002"), userLine("k1", null, "alpha kid", 3));
  const otherFile = join(made.sessions, "m2.jsonl");
  writeSession(
    otherFile,
    headerLine("other-session-id-0003"),
    userLine("v1", null, "alpha other", 4),
  );
  return {
    ...made,
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
    childFile,
    otherFile,
  };
}

/** The error text of one rejected call. */
async function rejection(params: Record<string, unknown>, host?: SearchHost): Promise<string> {
  const made = project();
  const h = harness({ db: made.db });
  const outcome = await h.call(host ?? made.host, params);
  assert.equal(outcome.isError, true, `expected a tool error for ${JSON.stringify(params)}`);
  return outcome.text;
}

test("check 1: a field the action does not accept is reported in table order", async () => {
  assert.equal(
    await rejection({ action: "find", address: "self:u1" }),
    "address is not valid for action find",
  );
  assert.equal(
    await rejection({ action: "get", address: "self:u1", query: "x" }),
    "query is not valid for action get",
  );
  assert.equal(
    await rejection({ action: "sessions", order: "oldest" }),
    "order is not valid for action sessions",
  );
  // Two invalid fields: the earlier one in the table order of specs/search-tool.md#parameter-schema wins.
  assert.equal(
    await rejection({ action: "get", session: "self", query: "x" }),
    "query is not valid for action get",
  );
  assert.equal(
    await rejection({ action: "sessions", after: "self:u1", branches: true }),
    "branches is not valid for action sessions",
  );
  // A null value counts as absent, so it is not a field the action rejects.
  const made = project();
  const h = harness({ db: made.db });
  const outcome = await h.call(made.host, { action: "find", address: null, query: "alpha" });
  assert.equal(outcome.isError, false);
});

test("checks 2 to 6: query, regex, and tool", async () => {
  assert.equal(await rejection({ action: "find", query: "" }), "query must be a non-empty string");
  assert.equal(
    await rejection({ action: "find", query: "x".repeat(1001) }),
    "query must be at most 1000 characters",
  );
  assert.equal(await rejection({ action: "find", regex: true }), "regex requires query");
  const invalid = await rejection({ action: "find", regex: true, query: "(" });
  assert.equal(invalid.startsWith("invalid regular expression: "), true, invalid);
  assert.equal(invalid.includes("Unterminated group"), true, invalid);
  assert.equal(await rejection({ action: "find", tool: "   " }), "tool must be a non-empty string");
  // A query of exactly 1000 characters passes the length check.
  const made = project();
  const h = harness({ db: made.db });
  const long = await h.call(made.host, { action: "find", query: "x".repeat(1000) });
  assert.equal(long.isError, false);
});

test("checks 7 to 9: since and until", async () => {
  const sinceText =
    "since must be an RFC 3339 date-time with a time-zone offset or an age such as 90s, 15m, 2h, or 7d";
  const untilText =
    "until must be an RFC 3339 date-time with a time-zone offset or an age such as 90s, 15m, 2h, or 7d";
  assert.equal(await rejection({ action: "find", since: "nope" }), sinceText);
  assert.equal(await rejection({ action: "find", until: "nope" }), untilText);
  assert.equal(await rejection({ action: "sessions", since: "1x" }), sinceText);
  assert.equal(
    await rejection({
      action: "find",
      since: "2026-01-01T00:00:02Z",
      until: "2026-01-01T00:00:02Z",
    }),
    "since must be earlier than until",
  );
  assert.equal(
    await rejection({ action: "find", since: "1h", until: "2h" }),
    "since must be earlier than until",
  );
  // Both forms are accepted.
  const made = project();
  const h = harness({ db: made.db });
  const dated = await h.call(made.host, {
    action: "find",
    since: "2026-01-01T00:00:00Z",
    until: "2026-01-01T00:00:05Z",
  });
  assert.equal(dated.isError, false);
  const aged = await h.call(made.host, { action: "find", since: "7d", until: "90s" });
  assert.equal(aged.isError, false);
});

test("checks 10 and 11: scope of sessions, and session with a project scope", async () => {
  assert.equal(
    await rejection({ action: "sessions", scope: "session" }),
    "scope must be tree or project for action sessions",
  );
  assert.equal(
    await rejection({ action: "sessions", scope: "project-trees" }),
    "scope must be tree or project for action sessions",
  );
  assert.equal(
    await rejection({ action: "find", scope: "project", session: "self" }),
    "session is not valid with scope project",
  );
  assert.equal(
    await rejection({ action: "sessions", scope: "project", session: " m2 " }),
    "session is not valid with scope project",
  );
});

test("checks 12 to 14: after and the limits", async () => {
  assert.equal(
    await rejection({ action: "find", after: "zzz" }),
    "after must be an item address such as self:1a2b3c4d or self:1a2b3c4d.0",
  );
  assert.equal(
    await rejection({ action: "find", limit: 0 }),
    "limit must be an integer from 1 to 100",
  );
  assert.equal(
    await rejection({ action: "find", limit: 101 }),
    "limit must be an integer from 1 to 100",
  );
  assert.equal(
    await rejection({ action: "find", limit: 1.5 }),
    "limit must be an integer from 1 to 100",
  );
  assert.equal(
    await rejection({ action: "sessions", limit: 201 }),
    "limit must be an integer from 1 to 200",
  );
});

test("checks 15 to 18: address, offset, limit, and context of get", async () => {
  const addressText = "address must be an item address such as self:1a2b3c4d or self:1a2b3c4d.0";
  assert.equal(await rejection({ action: "get" }), addressText);
  assert.equal(await rejection({ action: "get", address: "zzz" }), addressText);
  assert.equal(
    await rejection({ action: "get", address: "self:u1", offset: -1 }),
    "offset must be a non-negative integer",
  );
  assert.equal(
    await rejection({ action: "get", address: "self:u1", offset: 1.5 }),
    "offset must be a non-negative integer",
  );
  assert.equal(
    await rejection({ action: "get", address: "self:u1", limit: 0 }),
    "limit must be an integer from 1 to 50000",
  );
  assert.equal(
    await rejection({ action: "get", address: "self:u1", limit: 50001 }),
    "limit must be an integer from 1 to 50000",
  );
  assert.equal(
    await rejection({ action: "get", address: "self:u1", context: 21 }),
    "context must be an integer from 0 to 20",
  );
  assert.equal(
    await rejection({ action: "get", address: "self:u1", context: -1 }),
    "context must be an integer from 0 to 20",
  );
});

test("specs/search-tool.md#reach: unknown and ambiguous sessions, and the project refusal", async () => {
  assert.equal(
    await rejection({ action: "find", query: "alpha", session: "nope" }),
    'unknown session "nope"',
  );
  assert.equal(
    await rejection({ action: "find", query: "alpha", session: " nope " }),
    'unknown session "nope"',
  );
  assert.equal(await rejection({ action: "get", address: "nope:u1" }), 'unknown session "nope"');
  // Two project members whose session IDs share their first 13 characters.
  const made = fixture("search-tool-ambiguous-");
  writeSession(made.mainFile, headerLine("main-session-id-0001"), userLine("u1", null, "alpha", 1));
  writeSession(
    join(made.sessions, "m2.jsonl"),
    headerLine("abcdefghijklm-one"),
    userLine("v1", null, "alpha other", 2),
  );
  writeSession(
    join(made.sessions, "m3.jsonl"),
    headerLine("abcdefghijklm-two"),
    userLine("w1", null, "alpha third", 3),
  );
  const h = harness({ db: made.db });
  const host = { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true };
  const ambiguous = await h.call(host, {
    action: "find",
    query: "alpha",
    session: "~abcdefghijklm",
  });
  assert.equal(ambiguous.isError, true);
  assert.equal(
    ambiguous.text,
    `ambiguous session "~abcdefghijklm" matches ${join(made.sessions, "m2.jsonl")}, ${join(made.sessions, "m3.jsonl")}`,
  );
  // Rule 5 ambiguity: two members whose last stem ends with `-x`.
  writeSession(
    join(made.agentDir, "a-x.jsonl"),
    headerLine("kid-a-0000000000"),
    userLine("x1", null, "alpha a", 4),
  );
  writeSession(
    join(made.agentDir, "b-x.jsonl"),
    headerLine("kid-b-0000000000"),
    userLine("x2", null, "alpha b", 5),
  );
  const suffix = await h.call(host, { action: "find", query: "alpha", session: "x" });
  assert.equal(suffix.isError, true);
  assert.equal(
    suffix.text,
    `ambiguous session "x" matches ${join(made.agentDir, "a-x.jsonl")}, ${join(made.agentDir, "b-x.jsonl")}`,
  );
});

test("specs/search-tool.md#reach: a child session, and a main session without a file, are refused the project", async () => {
  const made = project();
  const h = harness({ db: made.db });
  const childHost: SearchHost = {
    sessionFile: made.childFile,
    agentDirectory: join(made.agentDir, "kid-task7.agents"),
    main: false,
  };
  for (const params of [
    { action: "find", query: "alpha", scope: "project" },
    { action: "find", query: "alpha", scope: "project-trees" },
    { action: "find", query: "alpha", session: "~other-session" },
    { action: "find", query: "alpha", after: "~other-session:v1" },
    { action: "get", address: "~other-session:v1" },
    { action: "sessions", scope: "project" },
  ]) {
    const outcome = await h.call(childHost, params);
    assert.equal(outcome.isError, true, JSON.stringify(params));
    assert.equal(outcome.text, "project scope is available to a main session only");
  }
  const noFile: SearchHost = { sessionFile: undefined, agentDirectory: made.agentDir, main: true };
  for (const params of [
    { action: "find", query: "alpha", scope: "project" },
    { action: "sessions", scope: "project" },
    { action: "get", address: "~other-session:v1" },
  ]) {
    const outcome = await h.call(noFile, params);
    assert.equal(outcome.isError, true, JSON.stringify(params));
    assert.equal(outcome.text, "this session has no session file and so no project");
  }
});

test("specs/search-tool.md#result: after must name a session of the call and an item of that session", async () => {
  const made = project();
  const h = harness({ db: made.db });
  // The child session is not a session of a `session`-scope call.
  assert.equal(
    (await h.call(made.host, { action: "find", query: "alpha", after: "kid-task7:k1" })).text,
    "no item kid-task7:k1 in the searched sessions",
  );
  // The item does not exist, on the lineage or off it.
  assert.equal(
    (await h.call(made.host, { action: "find", query: "alpha", after: "self:nope" })).text,
    "no item self:nope in the searched sessions",
  );
  assert.equal(
    (await h.call(made.host, { action: "find", query: "alpha", after: "self:u1.7" })).text,
    "no item self:u1.7 in the searched sessions",
  );
  // A session the call cannot resolve is its own error.
  assert.equal(
    (await h.call(made.host, { action: "find", query: "alpha", after: "nope:u1" })).text,
    'unknown session "nope"',
  );
});

test("specs/search-tool.md#get: an address that does not resolve, and an offset past the end", async () => {
  const made = project();
  const h = harness({ db: made.db });
  assert.equal(
    (await h.call(made.host, { action: "get", address: "self:nope" })).text,
    "no item self:nope",
  );
  assert.equal(
    (await h.call(made.host, { action: "get", address: "self:u1.3" })).text,
    "no item self:u1.3",
  );
  assert.equal(
    (await h.call(made.host, { action: "get", address: "self:u1", offset: 10 })).text,
    "offset 10 is past the end of the text (9 characters)",
  );
  // An offset equal to the length is admitted.
  const atEnd = await h.call(made.host, { action: "get", address: "self:u1", offset: 9 });
  assert.equal(atEnd.isError, false);
  assert.equal(atEnd.lines.includes("--- text 9..9 of 9 ---"), true, atEnd.text);
  assert.equal(atEnd.lines.includes("--- end of text ---"), true, atEnd.text);
});

test("a session that is not a session file is not read as one", async () => {
  const made = fixture("search-tool-not-session-");
  writeSession(made.mainFile, headerLine("main-session-id-0001"), userLine("u1", null, "alpha", 1));
  // A `.jsonl` file whose first line is not a session header is no session.
  writeFileSync(join(made.agentDir, "data.jsonl"), `${JSON.stringify({ hello: "world" })}\n`);
  mkdirSync(join(made.agentDir, "nested.agents"), { recursive: true });
  const h = harness({ db: made.db });
  const host = { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true };
  const outcome = await h.call(host, { action: "sessions" });
  assert.deepEqual(
    outcome.lines.map((line) => line.slice(0, line.indexOf(" \u00b7 "))),
    ["self"],
  );
  const injected = await h.call(host, { action: "find", query: "alpha" });
  assert.deepEqual(hitAddresses(injected), ["self:u1"]);
});

test("specs/search-tool.md#validation: the checks run in the numbered order, the earlier error winning", async () => {
  const cases: { params: Record<string, unknown>; error: string }[] = [
    // 1 before 2
    {
      params: { action: "find", address: "self:u1", query: "" },
      error: "address is not valid for action find",
    },
    // 2 before 3: an empty query is not also a long one; the length case is check 3's own.
    { params: { action: "find", query: "" }, error: "query must be a non-empty string" },
    // 3 before 5: a long invalid pattern is reported as too long.
    {
      params: { action: "find", query: "(".repeat(1002), regex: true },
      error: "query must be at most 1000 characters",
    },
    // 4 before 5
    { params: { action: "find", regex: true }, error: "regex requires query" },
    // 5 before 6
    { params: { action: "find", query: "(", regex: true, tool: "  " }, error: null as never },
    // 6 before 7
    {
      params: { action: "find", tool: "  ", since: "bad" },
      error: "tool must be a non-empty string",
    },
    // 7 before 8
    {
      params: { action: "find", since: "bad", until: "worse" },
      error:
        "since must be an RFC 3339 date-time with a time-zone offset or an age such as 90s, 15m, 2h, or 7d",
    },
    // 8 before 9
    {
      params: { action: "find", since: "2026-01-01T00:00:02Z", until: "bad" },
      error:
        "until must be an RFC 3339 date-time with a time-zone offset or an age such as 90s, 15m, 2h, or 7d",
    },
    // 9 before 10
    {
      params: { action: "sessions", since: "1h", until: "2h", scope: "session" },
      error: "since must be earlier than until",
    },
    // 10 before 11
    {
      params: { action: "sessions", scope: "session", session: "x" },
      error: "scope must be tree or project for action sessions",
    },
    // 11 before 12
    {
      params: { action: "find", scope: "project", session: "x", after: "bad" },
      error: "session is not valid with scope project",
    },
    // 12 before 13
    {
      params: { action: "find", after: "bad", limit: 0 },
      error: "after must be an item address such as self:1a2b3c4d or self:1a2b3c4d.0",
    },
    // 13: the find limit (14 is the sessions limit, another action's check)
    { params: { action: "find", limit: 0 }, error: "limit must be an integer from 1 to 100" },
    // 14: the sessions limit
    { params: { action: "sessions", limit: 0 }, error: "limit must be an integer from 1 to 200" },
    // 15 before 16
    {
      params: { action: "get", address: "bad", offset: -1 },
      error: "address must be an item address such as self:1a2b3c4d or self:1a2b3c4d.0",
    },
    // 16 before 17
    {
      params: { action: "get", address: "self:u1", offset: -1, limit: 0 },
      error: "offset must be a non-negative integer",
    },
    // 17 before 18
    {
      params: { action: "get", address: "self:u1", limit: 0, context: 21 },
      error: "limit must be an integer from 1 to 50000",
    },
  ];
  const made = project();
  const h = harness({ db: made.db });
  for (const item of cases) {
    const outcome = await h.call(made.host, item.params);
    assert.equal(outcome.isError, true, JSON.stringify(item.params));
    if (item.error === null) {
      // Check 5's message is the engine's; it must still win over check 6.
      assert.equal(outcome.text.startsWith("invalid regular expression: "), true, outcome.text);
      continue;
    }
    assert.equal(outcome.text, item.error, JSON.stringify(item.params));
  }
});
