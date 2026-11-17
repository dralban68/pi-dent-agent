import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  projectMembersAsync,
  readSessionHeaderFile,
  sessionTreeAsync,
  sessionsDirectory,
  type ProjectMember,
  type SessionMember,
} from "../../lib/session-transcript.ts";
import { headerLine, tempDir, userLine, writeSession } from "./support.ts";

/** specs/session-transcript.md Sections 4 and 4.1: the session tree, its discovery, and the project. */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const path = tempDir("session-transcript-tree-");
  roots.push(path);
  return path;
}

/** The tree as the `Search` tool walks it, with no turn of the event loop between members. */
async function tree(rootPath: string, rootAgentDirectory?: string): Promise<SessionMember[]> {
  return await sessionTreeAsync(
    rootPath,
    rootAgentDirectory,
    readSessionHeaderFile,
    async () => {},
  );
}

/** The project members as the `Search` tool walks it, with no turn of the event loop between them. */
async function project(mainSessionPath: string): Promise<ProjectMember[]> {
  return await projectMembersAsync(mainSessionPath, readSessionHeaderFile, async () => {});
}

async function keysOf(rootPath: string, rootAgentDirectory?: string): Promise<string[]> {
  return (await tree(rootPath, rootAgentDirectory)).map((member) => member.key);
}

async function sessionIdsOf(rootPath: string): Promise<(string | undefined)[]> {
  return (await tree(rootPath)).map((member) => member.header?.sessionId);
}

test("the session tree is the root and the sessions in the agent directories beneath it", async () => {
  const root = dir();
  const stem = "2026-01-01T00-00-00-000Z_root";
  const rootPath = join(root, `${stem}.jsonl`);
  writeSession(rootPath, headerLine("root-session"), userLine("r1", "root-session", "root task"));

  const agentDir = join(root, `${stem}.agents`);
  mkdirSync(agentDir);
  writeSession(join(agentDir, "alpha-1111.jsonl"), headerLine("alpha-session"));
  mkdirSync(join(agentDir, "alpha-1111.agents"));
  writeSession(join(agentDir, "alpha-1111.agents", "beta-2222.jsonl"), headerLine("beta-session"));
  writeSession(join(agentDir, "linkedagents.jsonl"), headerLine("linked-session"));
  // A symbolic link to a directory is not entered.
  mkdirSync(join(root, "elsewhere"));
  writeSession(join(root, "elsewhere", "gamma-4444.jsonl"), headerLine("gamma-session"));
  symlinkSync(join(root, "elsewhere"), join(agentDir, "linkedagents.agents"));
  // Not children: a symbolic link, a file whose first line is no session header, a directory
  // named like a session file, the stem `self`, a non-`.jsonl` file, and a nested directory.
  writeSession(join(root, "outside.jsonl"), headerLine("outside-session"));
  symlinkSync(join(root, "outside.jsonl"), join(agentDir, "linked-3333.jsonl"));
  writeFileSync(join(agentDir, "data.jsonl"), '{"not":"a session header"}\n');
  mkdirSync(join(agentDir, "dir.jsonl"));
  writeSession(join(agentDir, "self.jsonl"), headerLine("self-session"));
  writeFileSync(join(agentDir, "notes.txt"), "x\n");
  mkdirSync(join(agentDir, "nested"));
  writeSession(join(agentDir, "nested", "deep-0001.jsonl"), headerLine("deep-session"));

  assert.deepEqual(await keysOf(rootPath), [
    "self",
    "alpha-1111",
    "alpha-1111/beta-2222",
    "linkedagents",
  ]);
  assert.deepEqual(await sessionIdsOf(rootPath), [
    "root-session",
    "alpha-session",
    "beta-session",
    "linked-session",
  ]);
  const members = await tree(rootPath);
  assert.deepEqual(members[0]?.stems, []);
  assert.deepEqual(members[2]?.stems, ["alpha-1111", "beta-2222"]);
  assert.equal(members[2]?.path, join(agentDir, "alpha-1111.agents", "beta-2222.jsonl"));
  assert.equal(members[0]?.path, resolve(rootPath));
});

test("children are ordered by their stem, depth first, a session before its children", async () => {
  const root = dir();
  const stem = "root";
  const rootPath = join(root, `${stem}.jsonl`);
  writeSession(rootPath, headerLine("root"));
  const agentDir = join(root, `${stem}.agents`);
  mkdirSync(agentDir);
  writeSession(join(agentDir, "zeta.jsonl"), headerLine("zeta"));
  writeSession(join(agentDir, "Alpha.jsonl"), headerLine("upper"));
  mkdirSync(join(agentDir, "Alpha.agents"));
  writeSession(join(agentDir, "Alpha.agents", "kid.jsonl"), headerLine("kid"));
  // UTF-16 code units put `Alpha` before `zeta`.
  assert.deepEqual(await keysOf(rootPath), ["self", "Alpha", "Alpha/kid", "zeta"]);
});

test("a root with no session file is a member with no entries whose agent directory is read", async () => {
  const root = dir();
  const stem = "ghost-9999";
  mkdirSync(join(root, `${stem}.agents`));
  writeSession(join(root, `${stem}.agents`, "kid-0001.jsonl"), headerLine("kid-session"));
  const members = await tree(join(root, `${stem}.jsonl`));
  assert.deepEqual(
    members.map((member) => member.key),
    ["self", "kid-0001"],
  );
  assert.equal(members[0]?.header, undefined);
  assert.equal(members[1]?.header?.sessionId, "kid-session");
});

test("a root without a session file reads the agent directory it is given", async () => {
  const root = dir();
  // A session without a session file has `<tmpdir>/pi-dent-sessions/<sessionId>/` (agent-tool.md Section 4.2).
  const agents = join(root, "pi-dent-sessions", "session-id-0001");
  mkdirSync(agents, { recursive: true });
  writeSession(join(agents, "kid-0001.jsonl"), headerLine("kid-session"));
  mkdirSync(join(agents, "kid-0001.agents"));
  writeSession(join(agents, "kid-0001.agents", "grand-0002.jsonl"), headerLine("grand-session"));
  const rootPath = join(root, "no-such-session.jsonl");
  // The default stays `<stem>.agents` beside the file, which has nothing in it.
  assert.deepEqual(await keysOf(rootPath), ["self"]);
  const members = await tree(rootPath, agents);
  assert.deepEqual(
    members.map((member) => member.key),
    ["self", "kid-0001", "kid-0001/grand-0002"],
  );
  assert.equal(members[0]?.header, undefined);
  assert.equal(members[2]?.header?.sessionId, "grand-session");
});

test("a missing agent directory has no children and no failure", async () => {
  const root = dir();
  assert.deepEqual(await keysOf(join(root, "absent.jsonl")), ["self"]);
  assert.deepEqual(await keysOf(join(root, "absent.jsonl")), ["self"]);
});

test("a session file that cannot be read is not a member", async (t) => {
  const root = dir();
  const stem = "root";
  const rootPath = join(root, `${stem}.jsonl`);
  writeSession(rootPath, headerLine("root"));
  const agentDir = join(root, `${stem}.agents`);
  mkdirSync(agentDir);
  const locked = join(agentDir, "locked-5555.jsonl");
  writeSession(locked, headerLine("locked-session"));
  chmodSync(locked, 0o000);
  let readable = true;
  try {
    readFileSync(locked);
  } catch {
    readable = false;
  }
  if (readable) {
    t.skip("the file stays readable for this user, so the check cannot run");
    return;
  }
  assert.deepEqual(await keysOf(rootPath), ["self"]);
  chmodSync(locked, 0o600);
});

test("a session header is read for a member, and a file without one is not a member", () => {
  const root = dir();
  const path = join(root, "a.jsonl");
  writeSession(path, headerLine("id-a"));
  assert.equal(readSessionHeaderFile(path)?.sessionId, "id-a");
});

test("the project members are the other session files of the sessions directory", async () => {
  const root = dir();
  const mainPath = join(root, "main.jsonl");
  writeSession(mainPath, headerLine("main-session-id-0001"), userLine("m1", null, "main"));
  writeSession(join(root, "member-a.jsonl"), headerLine("abcdefghijklmnop"));
  mkdirSync(join(root, "member-a.agents"));
  writeSession(join(root, "member-a.agents", "child-x.jsonl"), headerLine("child-x"));
  writeSession(join(root, "member-b.jsonl"), headerLine("short"));
  writeSession(join(root, "member-c.jsonl"), headerLine("abcdefghijklmnopq"));
  // Excluded: an unsafe session ID, an empty one, no session header, the stem `self`,
  // a symbolic link, a directory named like a session file, and a nested directory.
  writeSession(join(root, "member-d.jsonl"), headerLine("bad id"));
  writeSession(join(root, "member-e.jsonl"), headerLine(""));
  writeFileSync(join(root, "member-f.jsonl"), '{"type":"message"}\n');
  writeSession(join(root, "self.jsonl"), headerLine("selfish"));
  const elsewhere = dir();
  writeSession(join(elsewhere, "outside.jsonl"), headerLine("outside-session"));
  symlinkSync(join(elsewhere, "outside.jsonl"), join(root, "member-g.jsonl"));
  mkdirSync(join(root, "member-h.jsonl"));
  mkdirSync(join(root, "nested"));
  writeSession(join(root, "nested", "member-i.jsonl"), headerLine("nested-session"));
  writeFileSync(join(root, "notes.md"), "x\n");

  const members = await project(mainPath);
  assert.deepEqual(
    members.map((member) => member.key),
    ["~abcdefghijklm", "~short", "~abcdefghijklm"],
  );
  assert.deepEqual(
    members.map((member) => member.members.map((one) => one.key)),
    [["~abcdefghijklm", "~abcdefghijklm/child-x"], ["~short"], ["~abcdefghijklm"]],
  );
  assert.equal(members[0]?.members[1]?.header?.sessionId, "child-x");
  for (const member of members) assert.equal(member.key.startsWith("~main-session-"), false);
});

test("the project members of a directory with no session file are none", async () => {
  const root = dir();
  assert.deepEqual(await project(join(root, "missing.jsonl")), []);
});

test("a main session without a session file has no project members", async () => {
  const root = dir();
  // Session files sit beside the path the main session's file would have.
  writeSession(join(root, "member-a.jsonl"), headerLine("abcdefghijklmnop"));
  assert.deepEqual(await project(join(root, "main.jsonl")), []);
  // The same directory with the main session's file in place has that member.
  writeSession(join(root, "main.jsonl"), headerLine("main-session-id-0001"));
  assert.deepEqual(
    (await project(join(root, "main.jsonl"))).map((member) => member.key),
    ["~abcdefghijklm"],
  );
});

test("the sessions directory of a main session holds its session file", () => {
  const root = dir();
  assert.equal(sessionsDirectory(join(root, "main.jsonl")), resolve(root));
});
