import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  assistantLine,
  cleanupRoots,
  compactionLine,
  fixture,
  harness,
  headerLine,
  hitAddresses,
  injectedLine,
  messageLine,
  stamp,
  toolCall,
  toolResultLine,
  userLine,
  writeSession,
  type Fixture,
} from "./support.ts";
import type { SearchHost } from "../../lib/search-tool.ts";

/**
 * specs/search-tool.md#candidates, specs/search-tool.md#matching, specs/search-tool.md#evaluation, specs/search-tool.md#result: the filters, the matching, the
 * orders, the limit and its continuation, the own-calls rule, the lineage, and
 * every scope value.
 */

after(cleanupRoots);

interface Rich extends Fixture {
  host: SearchHost;
  childFile: string;
  otherFile: string;
  deepFile: string;
}

/**
 * A main session with one item of every kind, one off-lineage item, a child
 * session, and a second project member with a child of its own.
 */
function rich(prefix = "search-tool-find-"): Rich {
  const made = fixture(prefix);
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    messageLine("sy0", null, {
      role: "system",
      content: "",
      sections: { preamble: "alpha prompt section" },
    }),
    userLine("u1", "sy0", "alpha one", 1),
    // Off the current lineage: the leaf continues from a1, not from b1.
    userLine("b1", "u1", "alpha branch", 2),
    assistantLine(
      "a1",
      "u1",
      [
        { type: "text", text: "alpha text" },
        toolCall("c1", "Bash", { command: "pnpm build" }),
        toolCall("c2", "Read", { path: "notes.txt" }),
      ],
      3,
    ),
    toolResultLine("r1", "a1", "Bash", "c1", "alpha failed", true, 4),
    toolResultLine("r2", "r1", "Read", "c2", "alpha read", false, 5),
    injectedLine("i1", "r2", "pi-dent-note", "alpha injected", 6),
    compactionLine("s1", "i1", "alpha summary", 7),
    messageLine(
      "e1",
      "s1",
      {
        role: "assistant",
        content: [{ type: "text", text: "beta turn" }],
        errorMessage: "alpha error",
      },
      8,
    ),
    userLine("u2", "e1", "beta two", 9),
  );
  const childFile = join(made.agentDir, "kid-task7.jsonl");
  writeSession(childFile, headerLine("kid-session-id-0002"), userLine("k1", null, "alpha kid", 10));
  const otherFile = join(made.sessions, "m2.jsonl");
  writeSession(
    otherFile,
    headerLine("other-session-id-0003"),
    userLine("v1", null, "alpha other", 11),
  );
  const otherAgent = join(made.sessions, "m2.agents");
  mkdirSync(otherAgent, { recursive: true });
  const deepFile = join(otherAgent, "deep-task9.jsonl");
  writeSession(
    deepFile,
    headerLine("deep-session-id-0004"),
    userLine("d1", null, "alpha deep", 12),
  );
  return {
    ...made,
    host: { sessionFile: made.mainFile, agentDirectory: made.agentDir, main: true },
    childFile,
    otherFile,
    deepFile,
  };
}

/** The addresses of the hits of one call. */
async function addresses(
  made: Rich,
  params: Record<string, unknown>,
  host?: SearchHost,
): Promise<string[]> {
  const h = harness({ db: made.db });
  const outcome = await h.call(host ?? made.host, params);
  assert.equal(outcome.isError, false, outcome.text);
  return hitAddresses(outcome);
}

const LINEAGE = [
  "self:e1.error",
  "self:s1",
  "self:i1",
  "self:r2",
  "self:r1",
  "self:a1.0",
  "self:u1",
  "self:sy0",
];

test("query, newest order, and the on-lineage default", async () => {
  const made = rich();
  assert.deepEqual(await addresses(made, { action: "find", query: "alpha" }), LINEAGE);
  // Without a query every item matches, off-lineage ones excluded.
  const all = await addresses(made, { action: "find", limit: 100 });
  assert.deepEqual(all, [
    "self:u2",
    "self:e1.error",
    "self:e1.0",
    "self:s1",
    "self:i1",
    "self:r2",
    "self:r1",
    "self:a1.2",
    "self:a1.1",
    "self:a1.0",
    "self:u1",
    "self:sy0",
  ]);
});

test("oldest order reverses transcript order, and equal times order by part", async () => {
  const made = rich();
  assert.deepEqual(await addresses(made, { action: "find", order: "oldest" }), [
    "self:sy0",
    "self:u1",
    "self:a1.0",
    "self:a1.1",
    "self:a1.2",
    "self:r1",
    "self:r2",
    "self:i1",
    "self:s1",
    "self:e1.0",
    "self:e1.error",
    "self:u2",
  ]);
});

test("branches adds the off-lineage items", async () => {
  const made = rich();
  assert.deepEqual(await addresses(made, { action: "find", query: "branch" }), []);
  assert.deepEqual(await addresses(made, { action: "find", query: "branch", branches: true }), [
    "self:b1",
  ]);
});

test("kinds, tool, and isError, alone and combined", async () => {
  const made = rich();
  assert.deepEqual(await addresses(made, { action: "find", kinds: ["tool_result"] }), [
    "self:r2",
    "self:r1",
  ]);
  assert.deepEqual(await addresses(made, { action: "find", kinds: ["user"] }), [
    "self:u2",
    "self:u1",
  ]);
  assert.deepEqual(await addresses(made, { action: "find", kinds: ["tool_call"] }), [
    "self:a1.2",
    "self:a1.1",
  ]);
  assert.deepEqual(await addresses(made, { action: "find", kinds: ["injected", "summary"] }), [
    "self:s1",
    "self:i1",
  ]);
  // A system item is found by its kind and by a query against its prompt text.
  assert.deepEqual(await addresses(made, { action: "find", kinds: ["system"] }), ["self:sy0"]);
  assert.deepEqual(await addresses(made, { action: "find", query: "prompt section" }), [
    "self:sy0",
  ]);
  // The tool name is compared after lowercasing the letters A-Z.
  assert.deepEqual(await addresses(made, { action: "find", tool: "bash" }), [
    "self:r1",
    "self:a1.1",
  ]);
  assert.deepEqual(await addresses(made, { action: "find", tool: "Bash", query: "alpha" }), [
    "self:r1",
  ]);
  assert.deepEqual(await addresses(made, { action: "find", isError: true }), ["self:r1"]);
  assert.deepEqual(await addresses(made, { action: "find", isError: false }), ["self:r2"]);
  // Filters no item can pass together give no candidate.
  assert.deepEqual(await addresses(made, { action: "find", kinds: ["user"], tool: "bash" }), []);
  assert.deepEqual(
    await addresses(made, { action: "find", kinds: ["tool_result"], isError: true, tool: "read" }),
    [],
  );
  assert.deepEqual(
    await addresses(made, { action: "find", kinds: ["tool_result"], isError: false }),
    ["self:r2"],
  );
});

test("since and until bound the item's time inclusively and exclusively", async () => {
  const made = rich();
  assert.deepEqual(await addresses(made, { action: "find", query: "alpha", since: stamp(5) }), [
    "self:e1.error",
    "self:s1",
    "self:i1",
    "self:r2",
  ]);
  assert.deepEqual(await addresses(made, { action: "find", query: "alpha", until: stamp(5) }), [
    "self:r1",
    "self:a1.0",
    "self:u1",
    "self:sy0",
  ]);
  assert.deepEqual(
    await addresses(made, {
      action: "find",
      query: "alpha",
      since: stamp(4),
      until: stamp(7),
    }),
    ["self:i1", "self:r2", "self:r1"],
  );
  // An age is relative to the call's start: 5 s before it excludes every item.
  const h = harness({ db: made.db });
  const aged = await h.call(made.host, { action: "find", query: "alpha", until: "5s" });
  assert.deepEqual(hitAddresses(aged), []);
  const recent = await h.call(made.host, { action: "find", query: "alpha", since: "5s" });
  assert.deepEqual(hitAddresses(recent), LINEAGE);
});

test("a literal query escapes its metacharacters; a regex query does not", async () => {
  const made = rich();
  assert.deepEqual(await addresses(made, { action: "find", query: "alpha t" }), ["self:a1.0"]);
  // `.` is literal unless regex is true.
  assert.deepEqual(await addresses(made, { action: "find", query: "alpha.txt" }), []);
  assert.deepEqual(await addresses(made, { action: "find", query: "a.*a" }), []);
  assert.deepEqual(await addresses(made, { action: "find", query: "alpha\\s+read", regex: true }), [
    "self:r2",
  ]);
  assert.deepEqual(
    await addresses(made, { action: "find", query: "^alpha", regex: true }),
    LINEAGE,
  );
  assert.deepEqual(
    await addresses(made, { action: "find", query: "^alpha (failed|read)$", regex: true }),
    ["self:r2", "self:r1"],
  );
});

test("the m flag makes ^ and $ match at a line feed", async () => {
  const made = fixture("search-tool-flags-");
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    userLine("u1", null, "first line\nsecond line alpha", 1),
  );
  const h = harness({ db: made.db });
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  assert.deepEqual(
    hitAddresses(await h.call(host, { action: "find", query: "^second", regex: true })),
    ["self:u1"],
  );
  assert.deepEqual(
    hitAddresses(await h.call(host, { action: "find", query: "line$", regex: true })),
    ["self:u1"],
  );
});

test("caseSensitive decides whether the i flag is set", async () => {
  const made = rich();
  assert.deepEqual(await addresses(made, { action: "find", query: "ALPHA" }), LINEAGE);
  assert.deepEqual(
    await addresses(made, { action: "find", query: "ALPHA", caseSensitive: true }),
    [],
  );
  assert.deepEqual(await addresses(made, { action: "find", query: "ALPHA", regex: true }), LINEAGE);
  assert.deepEqual(
    await addresses(made, { action: "find", query: "ALPHA", regex: true, caseSensitive: true }),
    [],
  );
});

test("limit stops at the first hits, and a continuation by after returns exactly the rest", async () => {
  const made = rich();
  const h = harness({ db: made.db });
  const first = await h.call(made.host, { action: "find", query: "alpha", limit: 3 });
  assert.deepEqual(hitAddresses(first), ["self:e1.error", "self:s1", "self:i1"]);
  assert.equal(first.lines[0], "3 hits, newest first");
  assert.equal(first.lines.at(-1), 'More hits follow: repeat the call with after: "self:i1"');
  assert.equal(first.details.more, true);
  assert.equal(first.details.stopped, false);
  assert.equal(first.details.next, "self:i1");
  const rest = await h.call(made.host, {
    action: "find",
    query: "alpha",
    limit: 10,
    after: "self:i1",
  });
  assert.deepEqual(hitAddresses(rest), ["self:r2", "self:r1", "self:a1.0", "self:u1", "self:sy0"]);
  assert.equal(rest.details.more, false);
  assert.equal(rest.details.next, undefined);
  // The limit exactly at the number of hits has no `More hits follow` line.
  const exact = await h.call(made.host, { action: "find", query: "alpha", limit: 8 });
  assert.equal(
    exact.lines.some((line) => line.startsWith("More hits follow")),
    false,
  );
  assert.equal(exact.details.more, false);
});

test("the own-calls rule hides Search's own items unless the tool filter names Search", async () => {
  const made = fixture("search-tool-own-calls-");
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    assistantLine("a1", null, [toolCall("c1", "Search", { query: "alpha" })], 1),
    toolResultLine("r1", "a1", "Search", "c1", "alpha hits", false, 2),
    userLine("u1", "r1", "alpha after", 3),
  );
  const h = harness({ db: made.db });
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  assert.deepEqual(hitAddresses(await h.call(host, { action: "find", query: "alpha" })), [
    "self:u1",
  ]);
  assert.deepEqual(
    hitAddresses(await h.call(host, { action: "find", query: "alpha", tool: "search" })),
    ["self:r1", "self:a1.0"],
  );
});

test("each scope value, including the project scopes of a main session", async () => {
  const made = rich();
  assert.equal((await addresses(made, { action: "find", query: "alpha" })).length, 8);
  assert.deepEqual(await addresses(made, { action: "find", query: "kid", scope: "tree" }), [
    "kid-task7:k1",
  ]);
  assert.deepEqual(await addresses(made, { action: "find", query: "alpha", scope: "tree" }), [
    "kid-task7:k1",
    ...LINEAGE,
  ]);
  assert.deepEqual(await addresses(made, { action: "find", query: "alpha", scope: "project" }), [
    "~other-session:v1",
    ...LINEAGE,
  ]);
  // project-trees adds the invoking session's own tree and the project members' trees.
  assert.deepEqual(
    await addresses(made, { action: "find", query: "alpha", scope: "project-trees" }),
    ["~other-session/deep-task9:d1", "~other-session:v1", "kid-task7:k1", ...LINEAGE],
  );
  // The tree of a named member, and a session named by its key, by a stem, and by its path.
  assert.deepEqual(
    await addresses(made, { action: "find", query: "alpha", session: "kid-task7" }),
    ["kid-task7:k1"],
  );
  assert.deepEqual(
    await addresses(made, { action: "find", query: "alpha", session: "~other-session" }),
    ["~other-session:v1"],
  );
  assert.deepEqual(
    await addresses(made, { action: "find", query: "alpha", session: made.childFile }),
    ["kid-task7:k1"],
  );
  // A task ID names the session its dispatch created: the stem ends with `-<task ID>`.
  assert.deepEqual(await addresses(made, { action: "find", query: "alpha", session: "task7" }), [
    "kid-task7:k1",
  ]);
  // The invoking session itself.
  assert.deepEqual(
    await addresses(made, { action: "find", query: "alpha", session: "self" }),
    LINEAGE,
  );
});

test("a symbolic-link agent directory and a symbolic-link session file are not entered", async () => {
  const made = fixture("search-tool-symlink-");
  writeSession(
    made.mainFile,
    headerLine("main-session-id-0001"),
    userLine("u1", null, "alpha main", 1),
  );
  const childFile = join(made.agentDir, "kid-task1.jsonl");
  writeSession(childFile, headerLine("kid-session-id-0002"), userLine("k1", null, "alpha kid", 2));
  // The child's own agent directory is a symbolic link: it is not entered.
  const elsewhere = join(made.root, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  writeSession(
    join(elsewhere, "hidden.jsonl"),
    headerLine("hidden-session-0003"),
    userLine("h1", null, "alpha hidden", 3),
  );
  symlinkSync(elsewhere, join(made.agentDir, "kid-task1.agents"));
  // A session file that is a symbolic link is no child either.
  symlinkSync(join(elsewhere, "hidden.jsonl"), join(made.agentDir, "linked.jsonl"));
  const h = harness({ db: made.db });
  const host: SearchHost = {
    sessionFile: made.mainFile,
    agentDirectory: made.agentDir,
    main: true,
  };
  const outcome = await h.call(host, { action: "find", query: "alpha", scope: "tree" });
  assert.deepEqual(hitAddresses(outcome), ["kid-task1:k1", "self:u1"]);
});
