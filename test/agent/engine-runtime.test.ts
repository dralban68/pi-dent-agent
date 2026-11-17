import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DispatchEngine, type BootSnapshot, type ToolResult } from "../../lib/engine.ts";
import { engineDeps } from "../support/engine-deps.ts";
import type { HostSession } from "../../lib/host.ts";
import { must } from "../support/must.ts";

// --- Section 8: recovery classification, driven through real dispatches ------
//
// A settled attempt is classified by what its child session produced, and the
// classification shows in the dispatch itself: which attempt ran, what it was
// prompted with, and how the dispatch settled. Child sessions run on a
// scripted faux provider.

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "pi-dent-engine-runtime-"));
roots.push(home);
const agentDir = join(home, "pi-agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "k" } }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const faux = registerFauxProvider({ models: [{ id: "m" }], tokensPerSecond: 1000 });
after(() => faux.unregister());
let responseHeaders: Record<string, unknown> = {};
const realCreate = ModelRuntime.create.bind(ModelRuntime);
ModelRuntime.create = async (options) => {
  const runtime = await realCreate(options);
  runtime.registerProvider(faux.models[0].provider, {
    apiKey: "k",
    baseUrl: "http://faux.invalid",
    api: faux.api as never,
    streamSimple: (model, context, requestOptions) =>
      must(getApiProvider(faux.api as never)).streamSimple(model, context, {
        ...requestOptions,
        onResponse: (response, requestModel) =>
          requestOptions?.onResponse?.(
            { ...response, headers: responseHeaders as Record<string, string> },
            requestModel,
          ),
      }),
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
  });
  return runtime;
};

const runModel = faux.getModel();

/** Boot configuration with a recovery bound of `maxRecoveryRetries`. */
function runtimeBoot(maxRecoveryRetries: number): BootSnapshot {
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 10 } }),
  );
  return {
    cwd: "/tmp",
    config: {
      merged: {},
      layers: {},
      projectRoot: "/tmp",
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    },
    agents: [],
    agentIndex: new Map(),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries,
    sessionTtlDays: 30,
  } as unknown as BootSnapshot;
}

/** A fresh temp root holding a main session at `<root>/main/main.jsonl`. */
function newRoot(): { root: string; sessionFile: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dent-engine-runtime-"));
  roots.push(root);
  const dir = join(root, "main");
  mkdirSync(dir, { recursive: true });
  return { root, sessionFile: join(dir, "main.jsonl") };
}

function runtimeHost(sessionFile: string, root: string): HostSession {
  return {
    cwd: () => root,
    sessionId: () => "main-id",
    sessionFile: () => sessionFile,
    sessionDir: () => root,
    model: () => ({ provider: runModel.provider, id: runModel.id }),
    thinking: () => undefined,
    activeTools: () => ["Agent", "Bash"],
    inventory: () => [runModel as never],
    configuredModels: () => [runModel as never],
    contextWindow: () => undefined,
    compaction: () => undefined,
    notify: () => {},
  };
}

function textOf(result: ToolResult): string {
  const part = result.content[0];
  return part?.type === "text" ? part.text : "";
}

interface AttemptLike {
  status?: string | undefined;
  stopReason?: string | undefined;
  failureCode?: string | undefined;
  sessionPath?: string | undefined;
}
interface DetailsLike {
  taskId?: string | undefined;
  results?: AttemptLike[] | undefined;
}
const detailsOf = (result: ToolResult) => result.details as DetailsLike;

/** The text of a message content value: a string or a list of text blocks. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type?: string | undefined; text?: string | undefined } =>
        typeof block === "object" && block !== null,
    )
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

/** The user messages of a child session file, in order. */
function userPrompts(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message)
    .filter(
      (message): message is { role?: string | undefined; content?: unknown } =>
        typeof message === "object" && message !== null,
    )
    .filter((message) => message.role === "user")
    .map((message) => contentText(message.content));
}

/** Wait until the row with `taskId` leaves `running`. */
async function waitForSettled(engine: DispatchEngine, taskId: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const row = engine.registry.get(taskId);
    if (row !== undefined && row.status !== "running") return row;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${taskId} to settle`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

/** One dispatch of a fresh engine with one scripted answer. */
async function dispatchOnce(
  maxRecoveryRetries: number,
  params: { prompt: string; task: string; background?: boolean },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    runtimeBoot(maxRecoveryRetries),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  return engine.dispatch({
    toolCallId: "call-1",
    params,
    host: runtimeHost(sessionFile, root),
    cohortId: "cohort-1",
    ...(signal === undefined ? {} : { signal }),
  });
}

test("a child forwards exactly one response with string headers for any provider", async () => {
  responseHeaders = { limit: 42, tags: ["one", "two"], remaining: "7" };
  faux.setResponses([() => fauxAssistantMessage("done")]);
  const { root, sessionFile } = newRoot();
  const observations: unknown[] = [];
  const engine = new DispatchEngine(
    runtimeBoot(0),
    () => undefined,
    undefined,
    undefined,
    {
      emit: (name, payload) => observations.push({ name, payload }),
    },
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "observe",
    params: { prompt: "P", task: "go" },
    host: runtimeHost(sessionFile, root),
    cohortId: "observe",
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(observations, [
    {
      name: "purse:observe:v1",
      payload: {
        protocol: 1,
        provider: runModel.provider,
        headers: { limit: "42", tags: "one, two", remaining: "7" },
      },
    },
  ]);
  responseHeaders = {};
});

test("an observation emitter throwing does not fail dispatch", async () => {
  faux.setResponses([() => fauxAssistantMessage("done")]);
  const { root, sessionFile } = newRoot();
  let emitted = false;
  const engine = new DispatchEngine(
    runtimeBoot(0),
    () => undefined,
    undefined,
    undefined,
    {
      emit: () => {
        emitted = true;
        throw new Error("observer unavailable");
      },
    },
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "observe-throw",
    params: { prompt: "P", task: "go" },
    host: runtimeHost(sessionFile, root),
    cohortId: "observe",
  });
  assert.equal(emitted, true);
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done");
});

test("Fleet query children forward their provider responses to the main bus", async () => {
  faux.setResponses([() => fauxAssistantMessage("answer")]);
  const { root, sessionFile } = newRoot();
  const observations: unknown[] = [];
  const engine = new DispatchEngine(
    runtimeBoot(0),
    () => undefined,
    undefined,
    undefined,
    {
      emit: (name, payload) => observations.push({ name, payload }),
    },
    engineDeps(),
  );
  const result = await engine.runIsolatedQuery(runtimeHost(sessionFile, root), {
    correlationId: "query-1",
    senderSessionId: "sibling",
    body: "question",
  });
  assert.equal(result.isError, false, result.text);
  assert.equal(result.text, "answer");
  assert.deepEqual(observations, [
    {
      name: "purse:observe:v1",
      payload: { protocol: 1, provider: runModel.provider, headers: {} },
    },
  ]);
});

test("nested Agent responses use the main session's observation bus", async () => {
  faux.setResponses([
    () =>
      fauxAssistantMessage([fauxToolCall("Agent", { prompt: "INNER", task: "go" })], {
        stopReason: "toolUse",
      }),
    () => fauxAssistantMessage("inner done"),
    () => fauxAssistantMessage("outer done"),
  ]);
  const { root, sessionFile } = newRoot();
  const observations: unknown[] = [];
  const engine = new DispatchEngine(
    runtimeBoot(0),
    () => undefined,
    undefined,
    undefined,
    {
      emit: (name, payload) => observations.push({ name, payload }),
    },
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "nested",
    params: { prompt: "OUTER", task: "go" },
    host: runtimeHost(sessionFile, root),
    cohortId: "nested",
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "outer done");
  assert.deepEqual(
    observations,
    Array.from({ length: 3 }, () => ({
      name: "purse:observe:v1",
      payload: { protocol: 1, provider: runModel.provider, headers: {} },
    })),
  );
});

test("a refusal starts a recovery attempt that asks why it declined", async () => {
  const refusal = "I cannot assist with that request.";
  faux.setResponses([() => fauxAssistantMessage(refusal), () => fauxAssistantMessage("done")]);
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    runtimeBoot(1),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const result = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: runtimeHost(sessionFile, root),
    cohortId: "cohort-1",
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), "done", "the recovery attempt's answer is the result");
  const records = must(detailsOf(result).results);
  assert.equal(records.length, 2, JSON.stringify(records));
  assert.deepEqual(userPrompts(must(records[0]?.sessionPath)), [
    "go",
    "go\n\nWhy did you previously decline? Explain, then complete the task if you legitimately can.",
  ]);
});

test("a long report quoting the refusal phrase stands as the result", async () => {
  const phrase = "I cannot assist with that request.";
  const report = `Report: the test expects "${phrase}" as the error. ${"x".repeat(300)}`;
  faux.setResponses([() => fauxAssistantMessage(report)]);
  const result = await dispatchOnce(0, { prompt: "P", task: "go" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(textOf(result), report);
});

test("a refusal text at the 300-unit bound is a refusal, one unit more is not", async () => {
  const phrase = "I cannot assist with that request.";
  const atBound = `${phrase}${"x".repeat(300 - phrase.length)}`;

  faux.setResponses([() => fauxAssistantMessage(`  ${atBound}\n`)]);
  const refused = await dispatchOnce(0, { prompt: "P", task: "go" });
  assert.equal(refused.isError, true);
  assert.ok(textOf(refused).startsWith(`Agent error: ${atBound}`), textOf(refused));

  faux.setResponses([() => fauxAssistantMessage(`${atBound}x`)]);
  const longer = await dispatchOnce(0, { prompt: "P", task: "go" });
  assert.equal(longer.isError, undefined, textOf(longer));
  assert.equal(textOf(longer), `${atBound}x`);
});

test("a background answer over 8000 characters spills verbatim to the agents directory", async () => {
  const answer = `Full report:\n${"x".repeat(8001)}\nEnd.`;
  faux.setResponses([() => fauxAssistantMessage(answer)]);
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    runtimeBoot(0),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const started = await engine.dispatch({
    toolCallId: "call-spill",
    params: { prompt: "P", task: "go", background: true },
    host: runtimeHost(sessionFile, root),
    cohortId: "cohort-1",
  });
  assert.equal(started.isError, undefined, textOf(started));
  const row = await waitForSettled(engine, must(detailsOf(started).taskId));
  assert.equal(row.status, "completed");
  assert.equal(row.result, answer);
  assert.equal(row.resultPath, join(root, "main", "main.agents", `${row.taskId}.result.md`));
  assert.equal(readFileSync(must(row.resultPath), "utf8"), answer);
});

test("a cancellation after settlement does not rewrite the settled outcome", async () => {
  faux.setResponses([() => fauxAssistantMessage("done")]);
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    runtimeBoot(0),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const started = await engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go", background: true },
    host: runtimeHost(sessionFile, root),
    cohortId: "cohort-1",
  });
  assert.equal(started.isError, undefined, textOf(started));
  const row = await waitForSettled(engine, must(detailsOf(started).taskId));
  assert.equal(row.status, "completed");
  const settledResult = row.result;

  engine.registry.cancel(row);
  assert.equal(row.status, "completed", "a request after settlement changes nothing");
  assert.equal(row.result, settledResult);
});

test("an abort during the attempt settles the record cancelled", async () => {
  faux.setResponses([
    async () => {
      await new Promise((done) => setTimeout(done, 300));
      return fauxAssistantMessage("too late");
    },
  ]);
  const { root, sessionFile } = newRoot();
  const engine = new DispatchEngine(
    runtimeBoot(0),
    () => undefined,
    undefined,
    undefined,
    undefined,
    engineDeps(),
  );
  const controller = new AbortController();
  const pending = engine.dispatch({
    toolCallId: "call-1",
    params: { prompt: "P", task: "go" },
    host: runtimeHost(sessionFile, root),
    cohortId: "cohort-1",
    signal: controller.signal,
  });
  await new Promise((done) => setTimeout(done, 50));
  controller.abort();

  const result = await pending;
  assert.equal(result.isError, true);
  const record = must(detailsOf(result).results?.[0]);
  assert.equal(record.status, "cancelled");
  assert.equal(record.stopReason, "aborted");
  assert.equal(record.failureCode, "aborted");
});
