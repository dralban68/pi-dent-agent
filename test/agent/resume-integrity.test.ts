import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot, type ToolResult } from "../../lib/engine.ts";
import type { AgentDefinition } from "../../lib/catalogs.ts";
import type { HostSession } from "../../lib/host.ts";
import { TaskRegistry } from "../../lib/registry.ts";
import { makeAgentTool, type AgentToolParams } from "../../lib/tools.ts";
import { engineDeps } from "../support/engine-deps.ts";
import { must } from "../support/must.ts";

/**
 * What a continuation inherits and what a result advertises, each through a real child session
 * on a faux provider: the agent record and the model and thinking records
 * (specs/agent-tool.md#resume), the run level (specs/agent-tool.md#model-thinking), the
 * continuation line (specs/agent-tool.md#result-contract), the pre-start checks and their order
 * (specs/agent-tool.md#parameter-schema), and the `Agent` renderers
 * (specs/agent-tool.md#registration). Models: `m` without reasoning, `m2` with reasoning, and
 * `m3` with reasoning but no `minimal`, `low`, `xhigh` or `max`.
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "pi-dent-resume-integrity-"));
roots.push(home);
const agentDir = join(home, "pi-agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 } }),
);
process.env.PI_CODING_AGENT_DIR = agentDir;

const faux = registerFauxProvider({
  models: [{ id: "m" }, { id: "m2", reasoning: true }, { id: "m3", reasoning: true }],
  tokensPerSecond: 1000,
});
after(() => faux.unregister());
// The level map the host and pi-dent read off the inventory model (specs/model-string.md#thinking-precedence).
const levelMap = { minimal: null, low: null };
Object.assign(must(faux.models[2]), { thinkingLevelMap: levelMap });
const descriptor = (id: string, reasoning: boolean) => ({
  id,
  name: id,
  reasoning,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 4096,
});
const realCreate = ModelRuntime.create.bind(ModelRuntime);
ModelRuntime.create = async (options) => {
  const runtime = await realCreate(options);
  runtime.registerProvider(faux.models[0].provider, {
    apiKey: "k",
    baseUrl: "http://faux.invalid",
    api: faux.api as never,
    streamSimple: must(getApiProvider(faux.api as never)).streamSimple as never,
    models: [
      descriptor("m", false),
      descriptor("m2", true),
      { ...descriptor("m3", true), thinkingLevelMap: levelMap },
    ] as never,
  });
  return runtime;
};
const provider = faux.models[0].provider;
const models = faux.models as unknown as never[];

const alpha: AgentDefinition = {
  name: "alpha",
  description: "Alpha agent",
  prompt: "ALPHA PROMPT",
  source: "project",
};
const beta: AgentDefinition = {
  name: "beta",
  description: "Beta agent",
  prompt: "BETA PROMPT",
  source: "project",
};

function boot(agents: AgentDefinition[], retries: number): BootSnapshot {
  return {
    cwd: "/tmp",
    config: {
      merged: {},
      layers: {},
      projectRoot: "/tmp",
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    },
    agents,
    agentIndex: new Map(agents.map((agent) => [agent.name, agent])),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: retries,
    sessionTtlDays: 30,
  } as unknown as BootSnapshot;
}

interface Setup {
  agents?: AgentDefinition[];
  retries?: number;
  /** The dispatching session's model id and thinking level. */
  callerModel?: string;
  callerThinking?: string;
}

/** What one child request saw: its system prompt and its thinking level. */
interface Seen {
  system: string;
  level: string;
  /** The text of the request's last message. */
  last: string;
}

let calls = 0;

function setup(options: Setup = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-resume-integrity-"));
  roots.push(root);
  mkdirSync(join(root, "main"), { recursive: true });
  const sessionFile = join(root, "main", "main.jsonl");
  const host: HostSession = {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => sessionFile,
    sessionDir: () => root,
    model: () => ({ provider, id: options.callerModel ?? "m" }),
    thinking: () => options.callerThinking as never,
    activeTools: () => ["Agent"],
    inventory: () => models,
    configuredModels: () => models,
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
  const agents = options.agents ?? [alpha, beta];
  const engine = new DispatchEngine(
    boot(agents, options.retries ?? 0),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const tool = makeAgentTool({
    boot: boot(agents, options.retries ?? 0),
    modelCatalog: "",
    dispatch: (call) => engine.dispatch(call),
    hostProvider: () => host,
    cohortFor: () => "cohort-1",
  });
  const seen: Seen[] = [];
  /** A child turn that records what it saw, then answers `text`. */
  const answer =
    (text: string, extra: Parameters<typeof fauxAssistantMessage>[1] = undefined) =>
    (
      context: { messages: { role: string; content?: unknown }[] },
      opts: { reasoning?: string } | undefined,
    ) => {
      const system = context.messages.filter((message) => message.role === "system").at(-1);
      seen.push({
        system: JSON.stringify(system),
        level: opts?.reasoning ?? "off",
        last: JSON.stringify(context.messages.at(-1)),
      });
      return fauxAssistantMessage(text, extra);
    };
  /** One `Agent` call through the registered tool. */
  const call = async (
    params: Partial<AgentToolParams>,
    responses: unknown[] = [answer("done")],
    signal?: AbortSignal,
  ): Promise<ToolResult> => {
    faux.setResponses(responses as never);
    calls += 1;
    return tool.execute(
      `call-${calls}`,
      { task: "go", ...params },
      signal,
      undefined,
      undefined as never,
    ) as Promise<ToolResult>;
  };
  return { root, host, engine, tool, call, seen, answer };
}

const textOf = (result: ToolResult): string => {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
};
interface Details {
  taskId?: string;
  agent?: string;
  results?: { sessionPath?: string; failureCode?: string; model?: string; status?: string }[];
}
const detailsOf = (result: ToolResult): Details => result.details as Details;
const taskIdOf = (result: ToolResult): string => must(detailsOf(result).taskId);
const lastRecord = (result: ToolResult) => must(must(detailsOf(result).results).at(-1));
const sessionPathOf = (result: ToolResult): string => must(lastRecord(result).sessionPath);
const aborted = (): AbortSignal => AbortSignal.abort();

const entries = (path: string): Record<string, unknown>[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const agentRecords = (path: string): unknown[] =>
  entries(path)
    .filter((entry) => entry.type === "custom" && entry.customType === "pi-dent-agent")
    .map((entry) => entry.data);
const ofType = (path: string, type: string) => entries(path).filter((entry) => entry.type === type);
const CONTINUATION = /\n\n\(To continue this agent, call Agent with resume: "([0-9a-f]{8})"\.\)$/;
const UNRESOLVED =
  "Agent error: resume must be an absolute path to an Agent session file or the task ID of an agent task of this session; received";

// --- finding 1: records are written only once a prompt of the dispatch is recorded ----------

// specs/agent-tool.md#resume: a cancelled start records no agent, model or thinking.
test("a resume cancelled before its first prompt records nothing, so the next bare resume keeps the old agent", async () => {
  const { call, seen, answer } = setup();
  const first = await call({ agent: "alpha" });
  const source = sessionPathOf(first);
  const before = readFileSync(source, "utf8");

  const cancelled = await call(
    { resume: source, prompt: "NEVER RAN", model: `${provider}/m2:high` },
    [answer("unused")],
    aborted(),
  );
  assert.equal(lastRecord(cancelled).status, "cancelled", textOf(cancelled));
  assert.equal(readFileSync(source, "utf8"), before, "the source file is unchanged");

  seen.length = 0;
  await call({ resume: source });
  assert.ok(must(seen[0]).system.includes("ALPHA PROMPT"), must(seen[0]).system);
  assert.ok(!must(seen[0]).system.includes("NEVER RAN"), must(seen[0]).system);
});

// specs/agent-tool.md#resume: the records precede the dispatch's first user message on disk.
test("a resume's records sit immediately before its first user message in the file", async () => {
  const { call } = setup();
  const source = sessionPathOf(await call({ agent: "alpha" }));
  const count = entries(source).length;
  await call({ resume: source, prompt: "NEW", model: `${provider}/m2:high`, task: "next" });
  const added = entries(source).slice(count);
  const kinds = added.map((entry) =>
    entry.type === "message"
      ? `message:${(entry.message as { role: string }).role}`
      : String(entry.type),
  );
  const user = kinds.indexOf("message:user");
  assert.deepEqual(kinds.slice(user - 2, user), ["custom", "model_change"], kinds.join(", "));
  // The host records a level it starts a run at itself; the run level is in the file once.
  assert.deepEqual(
    added
      .filter((entry) => entry.type === "thinking_level_change")
      .map((entry) => entry.thinkingLevel),
    ["high"],
  );
});

// specs/agent-tool.md#resume: no record on a pre-start rejection.
test("a resume rejected before start writes no agent record", async () => {
  const { call } = setup();
  const source = sessionPathOf(await call({ agent: "alpha" }));
  const before = readFileSync(source, "utf8");
  const rejected = await call({ resume: source, agent: "alpha", prompt: "P" });
  assert.equal(rejected.isError, true);
  assert.equal(readFileSync(source, "utf8"), before);
});

// specs/agent-tool.md#resume: one record per dispatch, whatever its attempts.
test("a resume with a recovery attempt writes exactly one agent record", async () => {
  const { call, answer } = setup({ retries: 1 });
  const source = sessionPathOf(await call({ agent: "alpha" }));
  const result = await call({ resume: source, prompt: "NEW" }, [
    answer("", { stopReason: "error", errorMessage: "429 rate limit" }),
    answer("recovered"),
  ]);
  assert.equal(detailsOf(result).results?.length, 2, "the recovery attempt ran");
  assert.deepEqual(agentRecords(source), [{ agent: "alpha" }, { prompt: "NEW" }]);
});

// --- finding 2: the continuation line needs an existing session file -----------------------

// specs/agent-tool.md#result-contract and specs/agent-tool.md#resume.
test("a fresh call cancelled before its first prompt advertises no continuation and is not listed", async () => {
  const { call } = setup();
  const result = await call({}, [], aborted());
  assert.equal(lastRecord(result).status, "cancelled", textOf(result));
  assert.ok(!existsSync(sessionPathOf(result)), "no session file was written");
  assert.ok(!CONTINUATION.test(textOf(result)), textOf(result));
  assert.ok(!textOf(result).includes("Session: "), textOf(result));

  const listed = await call({ resume: "latest" });
  assert.equal(
    textOf(listed),
    `${UNRESOLVED} "latest".\nThis session has no resumable agent tasks.`,
  );
});

// --- finding 3: a resume runs, records and reports one clamped level -----------------------

// specs/agent-tool.md#model-thinking: the caller's level on its own model, unsupported there.
test("a resume at the caller's unsupported level runs, records and reports the clamped level", async () => {
  const { call, seen } = setup({ callerModel: "m", callerThinking: "high" });
  // A source on another model, so the caller's tier selects the level.
  const source = sessionPathOf(await call({ model: `${provider}/m2:low` }));
  seen.length = 0;
  const resumed = await call({ resume: source, model: `${provider}/m` });
  assert.equal(must(seen[0]).level, "off", "the request ran at the clamped level");
  assert.equal(ofType(source, "thinking_level_change").at(-1)?.thinkingLevel, "off");
  assert.equal(lastRecord(resumed).model, `${provider}/m:off`);
});

// specs/agent-tool.md#model-thinking: clamping goes up first, then down.
test("a resume clamps an unsupported level up to the next supported one, else down", async () => {
  for (const [callerThinking, expected] of [
    ["minimal", "medium"],
    ["low", "medium"],
    ["xhigh", "high"],
    ["max", "high"],
  ] as const) {
    const { call, seen } = setup({ callerModel: "m3", callerThinking });
    const source = sessionPathOf(await call({ model: `${provider}/m2:low` }));
    seen.length = 0;
    const resumed = await call({ resume: source, model: `${provider}/m3` });
    assert.equal(must(seen[0]).level, expected, `${callerThinking} runs at ${expected}`);
    assert.equal(ofType(source, "thinking_level_change").at(-1)?.thinkingLevel, expected);
    assert.equal(lastRecord(resumed).model, `${provider}/m3:${expected}`);
  }
});

// --- finding 4: a source that cannot be read is a pre-start rejection ----------------------

// specs/agent-tool.md#parameter-schema.
test("a resume whose session file cannot be read is rejected naming the path and the error", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads a file whatever its mode");
    return;
  }
  const { call } = setup();
  const source = sessionPathOf(await call({}));
  chmodSync(source, 0o000);
  try {
    const result = await call({ resume: source, cwd: "missing" });
    assert.equal(result.isError, true);
    assert.match(
      textOf(result),
      new RegExp(`^Agent error: resume source cannot be read: ${source}: .*EACCES`),
    );
    assert.equal(lastRecord(result).failureCode, "invalid-plan");
    assert.equal(lastRecord(result).sessionPath, undefined, "no attempt ran");
  } finally {
    chmodSync(source, 0o600);
  }
});

// --- finding 5: the renderers --------------------------------------------------------------

/** A tool-row render context; `state` is shared by one row's call and result renders. */
const rowContext = (toolCallId: string, state: Record<string, unknown> = {}) =>
  ({ toolCallId, outputPad: 0, state }) as never;

// specs/agent-tool.md#registration: only the line the tool appended is hidden.
test("renderResult keeps a genuine last line that equals a continuation line", () => {
  const { tool } = setup();
  const text = 'answer\n\n(To continue this agent, call Agent with resume: "abcdef01".)';
  const stored: ToolResult = {
    content: [{ type: "text", text }],
    details: { taskId: "abcdef01", agent: "dynamic", results: [{ sessionPath: "/x.jsonl" }] },
  };
  const shown = must(tool.renderResult)(stored, {} as never, {} as never, rowContext("r-1"))
    .render(200)
    .join("\n");
  assert.ok(shown.includes('resume: "abcdef01"'), shown);
});

// specs/agent-tool.md#registration: a resumed call keeps the plan's identity on its card.
test("renderCall of a settled resume keeps the plan's identity however many cards render", () => {
  const { tool } = setup();
  const state = {};
  const call = must(tool.renderCall)(
    { task: "go on", resume: "/x.jsonl" },
    {} as never,
    rowContext("r-mine", state),
  );
  must(tool.renderResult)(
    { content: [{ type: "text", text: "done" }], details: { taskId: "abcdef02", agent: "alpha" } },
    {} as never,
    {} as never,
    rowContext("r-mine", state),
  );
  for (let i = 0; i < 100; i += 1) {
    must(tool.renderResult)(
      { content: [{ type: "text", text: "x" }], details: { agent: "beta" } },
      {} as never,
      {} as never,
      rowContext(`r-other-${i}`),
    );
  }
  assert.match(call.render(200).join(""), /Agent alpha — Alpha agent/);
});

// --- tests the review found missing --------------------------------------------------------

// specs/agent-tool.md#dispatch-plan: the default prompt's exact text.
test("a call with neither agent nor prompt runs the default prompt, verbatim", async () => {
  const { call, seen } = setup();
  await call({});
  assert.ok(
    must(seen[0]).system.includes(
      "You are a general-purpose agent dispatched by another agent to carry out the task in the user message. Work autonomously with your tools, stay within the task's scope, and end with a complete report of what you did and found.",
    ),
    must(seen[0]).system,
  );
});

// specs/agent-tool.md#dispatch-plan: a recorded key runs the definition's current prompt.
test("a bare resume after the named definition's prompt changed runs the current prompt", async () => {
  const before = setup({ agents: [{ ...alpha, prompt: "ALPHA V1" }] });
  const source = sessionPathOf(await before.call({ agent: "alpha" }));
  const later = setup({ agents: [{ ...alpha, prompt: "ALPHA V2" }] });
  await later.call({ resume: source });
  assert.ok(must(later.seen[0]).system.includes("ALPHA V2"), must(later.seen[0]).system);
  assert.ok(!must(later.seen[0]).system.includes("ALPHA V1"), must(later.seen[0]).system);
});

// specs/agent-tool.md#resume: an explicit agent overrides the recorded one and is recorded.
test("a resume with an explicit agent overrides the recorded one for later bare resumes", async () => {
  const { call, seen } = setup();
  const source = sessionPathOf(await call({ agent: "alpha" }));
  const overridden = await call({ resume: source, agent: "beta" });
  assert.equal(detailsOf(overridden).agent, "beta");
  seen.length = 0;
  const later = await call({ resume: source });
  assert.equal(detailsOf(later).agent, "beta");
  assert.ok(must(seen[0]).system.includes("BETA PROMPT"), must(seen[0]).system);
  assert.deepEqual(agentRecords(source), [{ agent: "alpha" }, { agent: "beta" }]);
});

// specs/agent-tool.md#parameter-schema: the pre-start checks report the first failure in order.
test("the pre-start checks report the first failure in the specified order", async () => {
  const { call } = setup();
  const both = await call({ resume: "latest", agent: "alpha", prompt: "P" });
  assert.ok(textOf(both).startsWith(`${UNRESOLVED} "latest".`), textOf(both));

  const unknown = await call({ agent: "zeta", prompt: "P" });
  assert.match(textOf(unknown), /^Agent error: both agent and prompt were provided/);

  const missing = await call({ agent: "zeta", resume: "/nonexistent/x.jsonl" });
  assert.match(textOf(missing), /^Agent error: unknown agent "zeta"/);

  const gone = setup();
  const source = sessionPathOf(await gone.call({ agent: "alpha" }));
  const later = setup({ agents: [beta] });
  const recorded = await later.call({ resume: source, cwd: "missing" });
  assert.match(textOf(recorded), /^Agent error: the resumed session last ran as agent "alpha"/);
});

// specs/agent-tool.md#resume: a stem resolves against the invoking session's own registry only.
test("a stem of another session's task is rejected, a stem of an adopted row resolves", async () => {
  const other = setup();
  const foreign = basename(sessionPathOf(await other.call({})), ".jsonl");
  const { engine, call, root } = setup();
  const rejected = await call({ resume: foreign });
  assert.ok(textOf(rejected).startsWith(`${UNRESOLVED} ${JSON.stringify(foreign)}.`));

  // A row of an attached child registry that the registry's end moves into this one.
  const parent = engine.registry.register({
    kind: "agent",
    cohort: "c-parent",
    label: "parent",
    background: true,
  });
  const children = new TaskRegistry(() => undefined);
  engine.registry.attach(parent, children);
  const row = children.register({ kind: "agent", cohort: "c-child", label: "x", background: true });
  const file = join(root, `dynamic-${row.taskId}.jsonl`);
  writeFileSync(file, readFileSync(sessionPathOf(await other.call({})), "utf8"));
  children.amend(row, { sessionPath: file, agent: "dynamic" });
  children.settle(row, { status: "completed", result: "done" });
  children.end();
  assert.equal(engine.registry.get(row.taskId), row, "the row was adopted");
  const resumed = await call({ resume: `dynamic-${row.taskId}` });
  assert.equal(resumed.isError, undefined, textOf(resumed));
  assert.equal(sessionPathOf(resumed), file);
});

// specs/agent-tool.md#resume: among equal startedAt, the later-registered row is newer.
test("the resumable list puts the later-registered of two equal-time rows first", async () => {
  const { engine, call, root } = setup();
  const now = mock.method(Date, "now", () => 1_700_000_000_000);
  const rows = ["first", "second"].map((label) => {
    const row = engine.registry.register({ kind: "agent", cohort: "c", label, background: true });
    const file = join(root, `dynamic-${row.taskId}.jsonl`);
    writeFileSync(file, "");
    engine.registry.amend(row, { sessionPath: file, agent: "dynamic" });
    engine.registry.settle(row, { status: "completed", result: "done" });
    return row;
  });
  now.mock.restore();
  const listed = await call({ resume: "latest" });
  const lines = textOf(listed).split("\n");
  assert.deepEqual(lines.slice(2), [
    `- ${must(rows[1]).taskId} · dynamic · task`,
    `- ${must(rows[0]).taskId} · dynamic · task`,
  ]);
});

// specs/agent-tool.md#result-contract: the line survives a recovery attempt.
test("a foreground result recovered by a second attempt ends with a continuation line that resumes", async () => {
  const { call, answer } = setup({ retries: 1 });
  const result = await call({}, [
    answer("", { stopReason: "error", errorMessage: "503 overloaded" }),
    answer("recovered"),
  ]);
  const id = must(CONTINUATION.exec(textOf(result))?.[1]);
  assert.equal(id, taskIdOf(result));
  const resumed = await call({ resume: id });
  assert.equal(resumed.isError, undefined, textOf(resumed));
});

// specs/agent-tool.md#result-contract: a child's own Agent call gets the line in its tool result.
test("a nested Agent call's tool result carries the continuation line to the child's model", async () => {
  const { call, seen, answer } = setup();
  await call({}, [
    fauxAssistantMessage([fauxToolCall("Agent", { task: "inner" })]),
    answer("inner done"),
    answer("outer done"),
  ]);
  const toolResult = must(seen.at(-1)).last;
  assert.match(
    toolResult,
    /inner done\\n\\n\(To continue this agent, call Agent with resume: \\"[0-9a-f]{8}\\"\.\)/,
    toolResult,
  );
});
