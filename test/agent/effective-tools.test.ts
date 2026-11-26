import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { effectiveToolCap, type BootSnapshot } from "../../lib/engine.ts";
import { makeSkillTool } from "../../lib/tools.ts";
import type { SkillEntry } from "../../lib/catalogs.ts";

/**
 * The effective tool cap per specs/agent-tool.md#tools and specs/agent-tool.md#child-session: the
 * main session's tool cap filtered, in main-session order, to the names the
 * child binds — pi's built-ins, pi-dent's child tools, and the tools the inherited
 * extension sources provided. `Skill` is bound only when the cap includes it
 * (specs/skill-tool.md#binding).
 */

/** The names of the child tool definitions the engine binds (engine.ts childTools). */
const CHILD_TOOL_NAMES = [
  { name: "Bash" },
  { name: "Agent" },
  { name: "Task" },
  { name: "Plugin" },
] as const;

test("cap: filter keeps builtin and child tool names in main-session order, excluding foreign extension names", () => {
  const cap = ["mcp__other__query", "Task", "read", "Fleet", "bash", "Agent", "Script", "Plugin"];
  assert.deepEqual(effectiveToolCap(cap, CHILD_TOOL_NAMES, []), [
    "Task",
    "read",
    "Agent",
    "Plugin",
  ]);
});

test("cap: the deactivated builtin bash is dropped, not read as Bash", () => {
  assert.deepEqual(effectiveToolCap(["bash"], CHILD_TOOL_NAMES, []), []);
  assert.deepEqual(effectiveToolCap(["bash", "Bash"], CHILD_TOOL_NAMES, []), ["Bash"]);
});

test("cap: every pi builtin tool name except bash is bindable", () => {
  const cap = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
  assert.deepEqual(
    effectiveToolCap(cap, [], []),
    cap.filter((name) => name !== "bash"),
  );
});

test("cap: Skill is bound only when the cap includes it and the child binds it", () => {
  const skillTool = [...CHILD_TOOL_NAMES, { name: "Skill" }];
  assert.deepEqual(
    effectiveToolCap(["read", "Bash"], skillTool, []),
    ["read", "Bash"],
    "a cap without Skill never gains it",
  );
  assert.deepEqual(
    effectiveToolCap(["Skill", "read", "Bash"], skillTool, []),
    ["Skill", "read", "Bash"],
    "a cap carrying Skill keeps it in position",
  );
  assert.deepEqual(
    effectiveToolCap(["Skill", "read", "Bash"], CHILD_TOOL_NAMES, []),
    ["read", "Bash"],
    "Skill is dropped when the child does not bind it (empty skill catalog)",
  );
});

test("cap: a child tool absent from the cap is not bound (no tool outside the cap)", () => {
  assert.deepEqual(effectiveToolCap(["read"], CHILD_TOOL_NAMES, []), ["read"]);
});

test("cap: inherited extension tools bind only inside the cap, and never Schedule, AskUserQuestion or bash", () => {
  const inherited = ["Schedule", "AskUserQuestion", "bash", "Probe", "Other"];
  assert.deepEqual(
    effectiveToolCap(
      ["Agent", "Schedule", "AskUserQuestion", "bash", "Probe", "Other"],
      CHILD_TOOL_NAMES,
      inherited,
    ),
    ["Agent", "Probe", "Other"],
    "an extension registering them does not make them bindable",
  );
  assert.deepEqual(
    effectiveToolCap(["Agent", "Probe"], CHILD_TOOL_NAMES, ["Other"]),
    ["Agent"],
    "an inherited tool outside the cap is never added",
  );
  assert.deepEqual(
    effectiveToolCap(["Agent", "Probe"], CHILD_TOOL_NAMES, []),
    ["Agent"],
    "a tool whose source the child did not inherit is unavailable",
  );
});

test("cap: an inherited MCP proxy keeps its tool-cap name, which the source registers only at session start", () => {
  const cap = ["Agent", "Probe", "mcp__fake__proxy"];
  assert.deepEqual(
    effectiveToolCap(cap, CHILD_TOOL_NAMES, ["Probe", "mcp__fake__proxy"]),
    cap,
    "the name comes from the snapshot's records, not from what a source registered on load",
  );
  assert.deepEqual(
    effectiveToolCap(cap, CHILD_TOOL_NAMES, []),
    ["Agent"],
    "without an inherited record the proxy name is a foreign extension name",
  );
});

test("sdk: createAgentSession with the computed allowlist activates Skill; without it, Skill stays inactive", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dent-cap-"));
  try {
    const skill: SkillEntry = { name: "s", description: "d", body: "B", source: "x" };
    const boot = {
      skills: [skill],
      skillIndex: new Map([[skill.name, skill]]),
    } as unknown as BootSnapshot;
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "x",
    });
    await loader.reload();

    // Cap with Skill: the allowlist keeps it, so the child's custom Skill
    // tool activates.
    const withSkills = await createAgentSession({
      cwd,
      // `Bash` is a custom tool of the real child, so only the built-in `read`
      // and the bound `Skill` are registered here.
      tools: effectiveToolCap(["read", "Bash", "Skill"], [{ name: "Bash" }, { name: "Skill" }], []),
      customTools: [makeSkillTool(boot)],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });
    try {
      assert.deepEqual(withSkills.session.getActiveToolNames(), ["read", "Skill"]);
    } finally {
      withSkills.session.dispose();
    }

    // Cap without Skill: it is not in the allowlist, so the SDK's allowlist
    // (which also filters customTools) leaves it inactive.
    const withoutSkills = await createAgentSession({
      cwd,
      tools: effectiveToolCap(["read", "Bash"], [{ name: "Bash" }, { name: "Skill" }], []),
      customTools: [makeSkillTool(boot)],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });
    try {
      const active = withoutSkills.session.getActiveToolNames();
      assert.deepEqual(active, ["read"]);
    } finally {
      withoutSkills.session.dispose();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
