import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, keyHint, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, TruncatedText } from "@earendil-works/pi-tui";
import type { BootSnapshot, DispatchFn, ToolResult, UpdateCallback } from "./engine.ts";
import type { HostSession } from "./host.ts";
import type { BillingService } from "./billing.ts";
import { type ModelRef, billingReportText } from "./billing-text.ts";
import { killTask, type TaskKind, type TaskRegistry, type TaskRow } from "./registry.ts";
import { formatElapsed, labelText } from "./task-row.ts";
import type { TaskLedger } from "./task-ledger.ts";
import {
  figuresText,
  readSessionUsage,
  readTaskFigures,
  sessionUsageLines,
  type SessionLedgerSource,
  type SessionUsageReport,
} from "./task-ledger-wiring.ts";
import { type SkillEntry, catalogLine } from "./catalogs.ts";
import { errorCode, errorMessage, firstLine, shortenSessionDir } from "./util.ts";
import {
  relativeSegments,
  resolveContainedPath,
  resolvePluginResourcePath,
  substituteArgs,
} from "./plugins.ts";
import { isThinkingLevel, serializeDescriptor, serializeModelClasses } from "./model-string.ts";
import {
  guidanceActive,
  guidedModels,
  modelCatalog,
  parsedModelGuidance,
} from "./model-guidance.ts";
import { mergedObject } from "./config.ts";
import {
  type FleetCoordinator,
  type FleetSessionRecord,
  fleetListSession,
  formatFleetList,
} from "./fleet.ts";

/**
 * Tool surfaces per specs/agent-tool.md, specs/task-tool.md,
 * specs/skill-tool.md, and specs/plugin-tool.md: registration fields,
 * parameter schemas, execution-time validation, the baked agent-catalog
 * description, and result renderers. Parameter types are derived from the
 * schemas (Static), so the normative schema and the code cannot drift.
 */

export const AGENT_PROMPT_SNIPPET =
  "Dispatch an isolated child Agent (requires task plus exactly one of agent or prompt)";

const AGENT_BASE_DESCRIPTION = `Dispatch one agent: an isolated child session with its own context window and session file. Required: \`task\`, plus exactly one of \`agent\` (a named definition from Available agents) or \`prompt\` (an inline system prompt) — never both, never neither, and required with \`resume\` too.

The child sees only its system prompt and \`task\`, nothing of this conversation, and returns its final answer. A foreground call blocks until the child finishes. \`background: true\` returns a task ID at once; a completion notification follows when every background task launched by the same message has settled. \`resume\` continues a retained session file in place, by its file path or by task ID.

Children that share a working directory share its files and Git state.`;

/**
 * Agent description (specs/agent-tool.md Section 1): the base text, the baked
 * boot-snapshot agent catalog, and the model catalog when non-empty.
 */
export function buildAgentDescription(boot: BootSnapshot, models: string): string {
  let description = AGENT_BASE_DESCRIPTION;
  if (boot.agents.length > 0) {
    const lines = boot.agents.map((agent) => catalogLine(agent.name, agent.description));
    description += `\n\nAvailable agents:\n${lines.join("\n")}`;
  }
  if (models !== "") description += `\n\nModels:\n${models}`;
  return description;
}

export const agentParameterSchema = Type.Object(
  {
    agent: Type.Optional(
      Type.String({
        pattern: "\\S",
        description:
          "Required unless `prompt` is set; exclusive with `prompt`. Name of an agent definition listed under Available agents (if none are listed, omit `agent` and pass `prompt`). Non-blank.",
      }),
    ),
    prompt: Type.Optional(
      Type.String({
        pattern: "\\S",
        description:
          "Required unless `agent` is set; exclusive with `agent`. Inline system prompt defining the agent's role and instructions at call time. Non-blank.",
      }),
    ),
    task: Type.String({
      minLength: 1,
      description: "Required. Task instructions; becomes the child's user message. Non-empty.",
    }),
    model: Type.Optional(
      Type.String({
        pattern: "\\S",
        description:
          "The child's model and thinking for this call: provider/id[:<thinking-level>] or a model class. Overrides the agent definition; omitted, the agent definition's model applies, else this session's. Non-blank.",
      }),
    ),
    resume: Type.Optional(
      Type.String({
        pattern: "\\S",
        description:
          "Absolute path to a retained Agent session .jsonl, or a task ID; `task` continues that session. Still requires exactly one of `agent` or `prompt`. Non-blank.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Child working directory; relative resolves against the invoking session's cwd; must exist and be a directory; blank is absent.",
      }),
    ),
    background: Type.Optional(
      Type.Boolean({ description: "Background dispatch mode (default false)." }),
    ),
  },
  { additionalProperties: false },
);
export type AgentToolParams = Static<typeof agentParameterSchema>;

export const taskParameterSchema = Type.Object(
  {
    action: StringEnum(["read", "kill", "list", "wait"], {
      description: "Operation to perform on the session's task registry.",
    }),
    taskId: Type.Optional(
      Type.String({
        pattern: "\\S",
        description:
          "Target task ID; required for read, kill, and wait, rejected for list. At least one character that is not white space.",
      }),
    ),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "How long wait blocks, in milliseconds, 1 or more; omitted gives 600000; above 2147483647 imposes no deadline. MUST be omitted when action is not wait.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type TaskToolParams = Static<typeof taskParameterSchema>;

export const skillParameterSchema = Type.Object(
  {
    name: Type.String({ description: "The name of a skill in the skill catalog." }),
    reference: Type.Optional(
      Type.String({
        description:
          "A reference document under the named skill's references/ folder: a bare basename or /-separated sub-path, with .md appended when absent.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type SkillToolParams = Static<typeof skillParameterSchema>;

export const pluginParameterSchema = Type.Object(
  {
    plugin: Type.String({ description: "A namespace in the plugin catalog." }),
    path: Type.String({
      description:
        "Relative path inside the plugin root; the first segment must be commands, agents, or skills; no absolute paths or .. segments.",
    }),
    args: Type.Optional(
      Type.String({
        description:
          "Argument string for substitution ($ARGUMENTS, $N); omitted returns the body verbatim.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type PluginToolParams = Static<typeof pluginParameterSchema>;

export const fleetParameterSchema = Type.Object(
  {
    action: StringEnum(["list", "send", "query", "status"] as const, {
      description: "The sub-command to run.",
    }),
    scope: Type.Optional(
      StringEnum(["children", "repo", "machine"] as const, {
        description:
          "For list only: machine (default; fleet sessions on this machine), repo (fleet sessions of the current Git repository, worktrees shared), or children (the live agents this session spawned).",
      }),
    ),
    format: Type.Optional(
      StringEnum(["compact", "full", "json"] as const, {
        description:
          "For list only: compact (default; one line per session), full (detailed activity), or json (machine-readable).",
      }),
    ),
    subject: Type.Optional(
      Type.String({
        description: "For send and query: short subject for the message envelope.",
      }),
    ),
    body: Type.Optional(
      Type.String({
        description:
          "Required for send and query (non-empty). The message text queued for the target session (or passed as task on a query).",
      }),
    ),
    target: Type.Optional(
      Type.String({
        description:
          "Required for query; for send, pass exactly one of target, targets, or broadcast. One recipient session ID or unique session-ID prefix.",
      }),
    ),
    targets: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 1,
        description:
          "For send only (exclusive with target and broadcast): several recipient session IDs or unique session-ID prefixes; resolved recipients are deduplicated.",
      }),
    ),
    broadcast: Type.Optional(
      StringEnum(["repo", "machine"] as const, {
        description:
          "For send only (exclusive with target and targets): fan-out scope across the current repo or every session on this machine.",
      }),
    ),
    deliver: Type.Optional(
      StringEnum(["steer", "followUp"] as const, {
        description: "For send only: steer or followUp (default followUp).",
      }),
    ),
    abort: Type.Optional(
      Type.Boolean({
        description:
          "For send only: abort the target's active turn before injecting; true is valid only with deliver: steer, false (default) is a no-op with any delivery mode.",
      }),
    ),
    messageId: Type.Optional(
      Type.Number({
        description:
          "Required for status: the messageId returned by a prior send or query. Only messages the caller sent are visible.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type FleetToolParams = Static<typeof fleetParameterSchema>;

/**
 * Cohort grouping (agent-tool.md Section 4.1): background Agent calls from one
 * assistant message share the first such call's tool-call ID as cohort ID.
 */
export class CohortTracker {
  private anchor: string | undefined;
  private readonly map = new Map<string, string>();

  onMessageStartAssistant(): void {
    this.anchor = undefined;
  }

  onToolExecutionStart(toolCallId: string, _toolName?: string): void {
    if (this.anchor === undefined) this.anchor = toolCallId;
    this.map.set(toolCallId, this.anchor);
  }

  cohortFor(toolCallId: string): string {
    return this.map.get(toolCallId) ?? `cohort-${toolCallId}`;
  }
}

interface AgentToolDeps {
  boot: BootSnapshot;
  /** The model catalog of the configured models (model-guidance.md Section 6); empty for none. */
  modelCatalog: string;
  dispatch: DispatchFn;
  hostProvider: () => HostSession | undefined;
  cohortFor: (toolCallId: string) => string;
}

function textError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

/** Live result panel components keyed by tool-call id (renderer state fallback). */
const resultPanels = new Map<string, Text>();

/**
 * The main session's `Agent` registration (agent-tool.md Section 1): registered
 * with the model catalog of each refresh, and again only when its description
 * differs from the registered one; every other field is unchanged.
 */
export class AgentToolRegistry {
  private readonly deps: Omit<AgentToolDeps, "modelCatalog">;
  private readonly register: (tool: ReturnType<typeof makeAgentTool>) => void;
  private description: string | undefined;

  constructor(
    deps: Omit<AgentToolDeps, "modelCatalog">,
    register: (tool: ReturnType<typeof makeAgentTool>) => void,
  ) {
    this.deps = deps;
    this.register = register;
  }

  refresh(models: string): void {
    const description = buildAgentDescription(this.deps.boot, models);
    if (description === this.description) return;
    this.description = description;
    this.register(makeAgentTool({ ...this.deps, modelCatalog: models }));
  }
}

export function makeAgentTool(deps: AgentToolDeps) {
  const description = buildAgentDescription(deps.boot, deps.modelCatalog);
  return defineTool({
    name: "Agent",
    label: "Agent",
    renderShell: "self",
    description,
    promptSnippet: AGENT_PROMPT_SNIPPET,
    parameters: agentParameterSchema,
    async execute(
      toolCallId: string,
      params: AgentToolParams,
      signal: AbortSignal | undefined,
      onUpdate: UpdateCallback | undefined,
    ): Promise<ToolResult> {
      // A missing host (no live main session) flows through dispatch, which
      // registers the pre-start rejection row and fails the plan with
      // missing-tool-authority (agent-tool.md Sections 3.1 and 4.1).
      return deps.dispatch({
        toolCallId,
        params,
        signal,
        onUpdate,
        host: deps.hostProvider(),
        cohortId: deps.cohortFor(toolCallId),
      });
    },
    // The host already separates tool blocks with a blank line, so the
    // components carry no vertical padding of their own.
    renderCall(args: AgentToolParams, _theme, context) {
      const identity = args.agent ?? "dynamic";
      const definition = args.agent ? deps.boot.agentIndex.get(args.agent) : undefined;
      const subtitle =
        definition?.description ?? (typeof args.task === "string" ? firstLine(args.task, 500) : "");
      return new TruncatedText(
        subtitle ? `Agent ${identity} — ${shortenSessionDir(subtitle)}` : `Agent ${identity}`,
        context.outputPad,
      );
    },
    renderResult(result: ToolResult, _options, _theme, context) {
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "";
      let panel = resultPanels.get(context.toolCallId);
      if (!panel) {
        // Bounded cache: panels are stateless between renders (text is
        // always re-set), so dropping old entries is harmless.
        if (resultPanels.size >= 64) resultPanels.clear();
        panel = new Text("", context.outputPad, 0);
        resultPanels.set(context.toolCallId, panel);
      }
      panel.setPaddingX(context.outputPad);
      // Intermediate assistant text streams into the panel as it is
      // produced; settlement replaces the stream with the final text.
      panel.setText(shortenSessionDir(text));
      return panel;
    },
  });
}

export interface TaskToolView {
  registry: () => TaskRegistry;
  /** The extension instance's task ledger, for `list` (task-tool.md Section 2.3). */
  ledger?: (() => TaskLedger | undefined) | undefined;
}

/** The header forms of a Bash excerpt, up to its path ([bash-tool.md](../specs/bash-tool.md) Section 4). */
const HEADER_FORMS = [
  /^\[Lines 1–\d+ of \d+ not shown$/,
  /^\[Line 1 of \d+ not shown$/,
  /^\[The output's end is shown \(\d+ lines?, \d+ bytes\), long lines cut to their last 500 characters$/,
  /^\[Lines 1–\d+ of \d+ not shown, long lines cut to their last 500 characters$/,
  /^\[Line 1 of \d+ not shown, long lines cut to their last 500 characters$/,
];

/**
 * Whether `line` is exactly a header line of a `bash` row for `resultPath`
 * (task-tool.md Section 2.1); no other row kind and no other path qualifies.
 */
function isOwnHeaderLine(line: string, resultPath: string): boolean {
  const tail = `; full output: ${resultPath}. Search it with rg or Read it.]`;
  if (!line.endsWith(tail)) return false;
  const head = line.slice(0, line.length - tail.length);
  return HEADER_FORMS.some((form) => form.test(head));
}

/** Whether `line` is exactly a `--- tool calls` line of a `script` row for `taskId` (script-tool.md Section 6). */
function isOwnToolCallsLine(line: string, taskId: string): boolean {
  const tail = `; Search it with session ${taskId} ---`;
  return /^--- tool calls: \d+; log: ./.test(line) && line.endsWith(tail);
}

/**
 * The preview of a settled result that spilled (task-tool.md Section 2.1): each line cut
 * to 120 characters, but a `bash` row's own header line and a `script` row's own tool-calls
 * line kept whole, and no `Full output:` line when the preview already carries that header line.
 */
function previewSpill(text: string, kind: TaskKind, resultPath: string, taskId: string): string {
  const header = (line: string) => kind === "bash" && isOwnHeaderLine(line, resultPath);
  const whole = (line: string) =>
    header(line) || (kind === "script" && isOwnToolCallsLine(line, taskId));
  const truncate = (line: string) =>
    line.length > 120 && !whole(line) ? line.slice(0, 120) : line;
  const lines = text.split("\n");
  const shown =
    lines.length <= 20
      ? lines.map(truncate)
      : [
          ...lines.slice(0, 10).map(truncate),
          `[... ${lines.length - 20} lines omitted ...]`,
          ...lines.slice(-10).map(truncate),
        ];
  return [...shown, ...(shown.some(header) ? [] : [`Full output: ${resultPath}`])].join("\n");
}

/** The previewed text: the row's result, or the spill file's content for a rebuilt row. */
function spillText(row: TaskRow, resultPath: string): { text: string } | { error: string } {
  if (row.result !== undefined) return { text: row.result };
  try {
    return { text: readFileSync(resultPath, "utf8") };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function taskRead(registry: TaskRegistry, row: TaskRow): ToolResult {
  let text: string;
  if (row.status === "interrupted") {
    // An interrupted task is resumed, not read: the single resume line, and the
    // row is never consumed (task-tool.md Section 2.1).
    return {
      content: [{ type: "text", text: `(interrupted, resume with Agent resume=${row.taskId})` }],
      details: { action: "read", taskId: row.taskId, status: row.status },
    };
  }
  if (row.status === "running") {
    text =
      row.progress.length > 0
        ? row.progress.map((entry) => entry.line).join("\n")
        : "(running, no output yet)";
  } else if (row.resultPath) {
    const spill = spillText(row, row.resultPath);
    // An unreadable result file is reported rather than previewed, and the row keeps its
    // record: it is not consumed (task-tool.md Section 2.1).
    if ("error" in spill) {
      return textError(`cannot read the result file ${row.resultPath}: ${spill.error}`);
    }
    text = previewSpill(spill.text, row.kind, row.resultPath, row.taskId);
  } else {
    // A rebuilt settled row keeps no result (task-record.md Section 3).
    text = row.result ?? `(result not retained; resume with Agent resume=${row.taskId})`;
  }
  // Reading a settled background task consumes its pending completion notification.
  if (row.status !== "running") registry.consume(row);
  const details: Record<string, unknown> = {
    action: "read",
    taskId: row.taskId,
    status: row.status,
  };
  if (row.resultPath) details.resultPath = row.resultPath;
  return { content: [{ type: "text", text }], details };
}

/**
 * What a `wait` returns for a row that has stopped running (task-tool.md Section 2.4): exactly
 * the read result of Section 2.1 — its consuming rule and result-file error included — with
 * `wait` in place of `read` in the details.
 */
function taskWaitResult(registry: TaskRegistry, row: TaskRow): ToolResult {
  const read = taskRead(registry, row);
  if (read.isError) return read;
  return { ...read, details: { ...read.details, action: "wait" } };
}

/** The default wait deadline of task-tool.md Section 1.1, and the largest delay setTimeout accepts. */
const WAIT_DEFAULT_TIMEOUT = 600_000;
const MAX_SETTIMEOUT_DELAY = 2_147_483_647;

/** The tool error for a `timeout` paired with a non-`wait` action (task-tool.md Section 1). */
const TIMEOUT_ONLY_WITH_WAIT = 'timeout is only valid when action is "wait"';

/** The host's result for an aborted tool call. */
const abortResult = (): ToolResult => textError("Operation aborted");

/**
 * `wait` per task-tool.md Section 2.4: the first of the row's settlement, the deadline, or
 * the call's abort ends the wait. The row is touched only through the read path, so an
 * expiry or abort leaves it unconsumed and its completion notification unaffected.
 */
function taskWait(
  registry: TaskRegistry,
  row: TaskRow,
  timeout: number,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (build: () => ToolResult): void => {
      if (done) return;
      done = true;
      if (deadline !== undefined) clearTimeout(deadline);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      try {
        resolve(build());
      } catch (error) {
        resolve(textError(errorMessage(error)));
      }
    };
    const onDeadline = (): void =>
      finish(() => textError(`Task ${row.taskId} still running after ${timeout}ms`));
    // Above 2147483647 there is no deadline: setTimeout would overflow (Section 1.1).
    const deadline = timeout <= MAX_SETTIMEOUT_DELAY ? setTimeout(onDeadline, timeout) : undefined;
    const onAbort = (): void => finish(abortResult);
    const unsubscribe = registry.subscribe(() => {
      if (row.status !== "running") finish(() => taskWaitResult(registry, row));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    // A row that is not running returns without waiting; the subscription is in place
    // first, so a settlement between the check and it cannot be missed.
    if (row.status !== "running") finish(() => taskWaitResult(registry, row));
    else if (signal?.aborted === true) finish(abortResult);
  });
}

function taskKill(registry: TaskRegistry, row: TaskRow): ToolResult {
  // The same cancellation path the task browser's kill key uses (task-browser.md Section 4.4).
  killTask(registry, row);
  const details: Record<string, unknown> = {
    action: "kill",
    taskId: row.taskId,
    status: row.status,
  };
  return {
    content: [{ type: "text", text: `Task ${row.taskId} kill requested (${row.status}).` }],
    details,
  };
}

/** `list` (task-tool.md Section 2.3): one ledger read for every row, none without rows. */
async function taskList(
  registry: TaskRegistry,
  ledger: TaskLedger | undefined,
): Promise<ToolResult> {
  const rows = registry.list();
  if (rows.length === 0) {
    return {
      content: [{ type: "text", text: "(no tasks)" }],
      details: { action: "list", tasks: [] },
    };
  }
  const read = await readTaskFigures(ledger, rows);
  const now = Date.now();
  const lines: string[] = [];
  const tasks = rows.map((row) => {
    const durationMs = Math.max(0, row.elapsedMs(now));
    const { text, figures } = figuresText(row, read);
    const label = labelText(row.label);
    lines.push(
      [
        row.taskId,
        row.status,
        formatElapsed(durationMs),
        ...(text === "" ? [] : [text]),
        label,
      ].join(" · "),
    );
    const entry: Record<string, unknown> = {
      taskId: row.taskId,
      status: row.status,
      label,
    };
    if (row.resultPath) entry.resultPath = row.resultPath;
    entry.durationMs = durationMs;
    if (figures !== undefined) {
      entry.usage = figures.own;
      entry.total = figures.total;
      entry.descendantMs = figures.descendantMs;
      // task-tool.md Section 2.3: absent for a bash row, never 0 in its place.
      if (figures.toolCalls !== undefined) entry.toolCalls = figures.toolCalls;
    }
    return entry;
  });
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { action: "list", ledger: read.status, tasks },
  };
}

export function makeTaskTool(view: TaskToolView) {
  return defineTool({
    name: "Task",
    label: "Task",
    renderShell: "self",
    description:
      "Inspect or cancel this session's tasks: `list` them, `read` a task's output so far or its result once settled, `kill` a running task, or `wait` for one to settle.",
    promptSnippet: "Inspect, wait for, or cancel a task by taskId",
    parameters: taskParameterSchema,
    async execute(
      _toolCallId: string,
      params: TaskToolParams,
      signal: AbortSignal | undefined,
    ): Promise<ToolResult> {
      const registry = view.registry();
      const action = params.action;
      // The checks of Section 1, in this order, the first failure reported.
      if (action === "list") {
        if (params.taskId !== undefined) {
          return textError('taskId must be omitted when action is "list"');
        }
        if (params.timeout !== undefined) {
          return textError(TIMEOUT_ONLY_WITH_WAIT);
        }
        return taskList(registry, view.ledger?.());
      }
      const taskId = params.taskId;
      if (taskId === undefined) {
        return textError(`taskId is required when action is "${action}"`);
      }
      if (action !== "wait" && params.timeout !== undefined) {
        return textError(TIMEOUT_ONLY_WITH_WAIT);
      }
      const row = registry.get(taskId);
      if (!row) {
        return textError(`no task "${taskId}" is owned by this session`);
      }
      if (action === "wait") {
        return taskWait(registry, row, params.timeout ?? WAIT_DEFAULT_TIMEOUT, signal);
      }
      return action === "read" ? taskRead(registry, row) : taskKill(registry, row);
    },
    // The host's own result layout (preview of 10 lines, expandable), over shortened paths.
    renderResult(result: ToolResult, options, theme) {
      const first = result.content[0];
      const lines = shortenSessionDir(first?.type === "text" ? first.text : "").split("\n");
      const shown = options.expanded ? lines : lines.slice(0, 10);
      const remaining = lines.length - shown.length;
      let text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
      if (remaining > 0) {
        text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
      }
      return new Text(text, 0, 0);
    },
  });
}

/** Load one skill reference (skill-tool.md Section 2); the reference must be a contained path of `references/` (plugin.md Section 7). */
function loadSkillReference(name: string, skill: SkillEntry, reference: string): ToolResult {
  if (reference.trim() === "") {
    return textError("reference must be non-empty when provided");
  }
  const missingDir = `skill "${name}": no references/ directory; cannot load reference "${reference}"`;
  if (!skill.referencesDir) return textError(missingDir);
  // The lexical rule applies to the reference as given, before `.md` is appended.
  const given = relativeSegments(reference);
  if ("error" in given) return textError(`skill "${name}": ${given.error}`);
  const file = reference.endsWith(".md") ? reference : `${reference}.md`;
  const target = resolveContainedPath(skill.referencesDir, file);
  if ("error" in target) return textError(`skill "${name}": ${target.error}`);
  let body: string;
  try {
    body = readFileSync(target.path, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return textError(
        `skill "${name}": missing reference "${reference}" (resolved ${target.path})`,
      );
    }
    return textError(
      `skill "${name}": failed to read reference "${reference}": ${code ?? errorMessage(error)}`,
    );
  }
  return { content: [{ type: "text", text: body }], details: {} };
}

export const sessionParameterSchema = Type.Object({}, { additionalProperties: false });

export interface SessionToolDeps {
  boot: BootSnapshot;
  hostProvider: () => HostSession | undefined;
  /** The main session's billing service; absent while billing is disabled (billing.md Section 1). */
  billing?: BillingService | undefined;
  /** Where the usage figures are read (session-tool.md Section 2); `ledger` unavailable without. */
  ledger?: SessionLedgerSource | undefined;
}

/** The `Session` tool (session-tool.md): a read-only report on the invoking session. */
export function makeSessionTool(deps: SessionToolDeps) {
  const { guidance } = parsedModelGuidance(deps.boot.config);
  return defineTool({
    name: "Session",
    label: "Session",
    description:
      "Report the current session: session ID, session file, cwd, model, the models an Agent call may name, model classes, and model guidance.",
    promptSnippet:
      "Report the current session's ID, session file, configured models, and model guidance",
    parameters: sessionParameterSchema,
    async execute(
      _toolCallId: string,
      _params: Record<string, unknown>,
      signal,
      _onUpdate,
      ctx,
    ): Promise<ToolResult> {
      const host = deps.hostProvider();
      const sessionId = ctx?.sessionManager?.getSessionId?.() ?? host?.sessionId();
      if (!sessionId) return textError("no live session identity for Session");
      // The ledger read is issued once, after the identity check; it is awaited with the rest.
      const unread: SessionUsageReport = { ledger: "unavailable", usage: null };
      const usageRead = deps.ledger
        ? readSessionUsage(deps.ledger, sessionId)
        : Promise.resolve(unread);
      const sessionFile = (ctx ? ctx.sessionManager.getSessionFile() : host?.sessionFile()) ?? null;
      const cwd = ctx?.cwd ?? host?.cwd() ?? process.cwd();
      const active = ctx ? ctx.model : host?.model();
      const level = ctx ? ctx.thinkingLevel : host?.thinking();
      const model = active
        ? serializeDescriptor({
            provider: active.provider,
            id: active.id,
            thinking: level !== undefined && isThinkingLevel(level) ? level : undefined,
          })
        : null;
      // The inventory is always a list; a missing one matches nothing (model-string.md Section 4).
      const available = ctx?.modelRegistry?.getAvailable() ?? [];
      const isActive = guidanceActive(guidance, available);
      const guided = isActive ? guidedModels(guidance, available) : [];
      const catalog = modelCatalog(guidance, available);
      // Guided models keep the order of model-guidance.md Section 2: re-sorting
      // provider/id would reorder them (`-` sorts before `:`).
      const models = isActive
        ? [...new Set(guided.map((g) => `${g.provider}/${g.id}`))]
        : [
            ...new Set(
              available.map((entry) =>
                serializeDescriptor({ provider: entry.provider, id: entry.id }),
              ),
            ),
          ].toSorted();
      const modelClasses = serializeModelClasses(mergedObject(deps.boot.config, "modelClasses"));
      // session-tool.md Section 1: `details.modelGuidance` carries `model` and `when` only.
      const report = isActive
        ? guided.map((item) => ({ model: item.model, when: item.when }))
        : null;
      // Provider and id of each listed model, for the billing report (billing.md Section 7).
      const refs: ModelRef[] = isActive
        ? guided.map((g) => ({ provider: g.provider, id: g.id }))
        : available.map((entry) => ({ provider: entry.provider, id: entry.id }));
      const billingReport = deps.billing ? await deps.billing.report(refs, signal) : null;
      const usage = await usageRead;
      const text = [
        `sessionId: ${sessionId}`,
        `sessionFile: ${sessionFile ?? "(none)"}`,
        `cwd: ${cwd}`,
        `model: ${model ?? "(none)"}`,
        `ledger: ${usage.ledger}`,
        "models:",
        ...models,
        "modelClasses:",
        // Sorted explicitly: integer-like keys enumerate numerically in a plain object.
        ...Object.keys(modelClasses)
          .toSorted()
          .map((name) => `${name} → ${modelClasses[name]}`),
        ...(catalog === "" ? [] : [`Model guidance:\n${catalog}`]),
        ...(billingReport
          ? [`billing (local zone ${billingReport.timeZone}):`, billingReportText(billingReport)]
          : []),
        ...sessionUsageLines(usage),
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          sessionId,
          sessionFile,
          cwd,
          model,
          models,
          modelClasses,
          modelGuidance: report,
          billing: billingReport,
          ledger: usage.ledger,
          usage: usage.usage,
        },
      };
    },
  });
}

export function makeSkillTool(boot: BootSnapshot) {
  return defineTool({
    name: "Skill",
    label: "Skill",
    description:
      "Load a skill's instructions by name, or with `reference` one document from its references/ folder. The system prompt's <available_skills> lists every skill as `name — description`.",
    parameters: skillParameterSchema,
    async execute(_toolCallId: string, params: SkillToolParams): Promise<ToolResult> {
      const name = params.name;
      if (name.trim() === "") {
        return textError("name is required and must be non-empty");
      }
      const skill = boot.skillIndex.get(name);
      if (!skill) {
        const available = boot.skills.map((entry) => entry.name);
        return textError(
          `unknown skill "${name}". Available skills: ${available.length > 0 ? available.join(", ") : "(none)"}`,
        );
      }
      if (params.reference === undefined) {
        return { content: [{ type: "text", text: skill.body }], details: {} };
      }
      return loadSkillReference(name, skill, params.reference);
    },
  });
}

export function makePluginTool(boot: BootSnapshot) {
  return defineTool({
    name: "Plugin",
    label: "Plugin",
    description:
      "Read one file of a plugin (under commands/, agents/, or skills/), optionally substituting arguments. Returns the text and runs nothing: carry out its instructions with this session's own tools.",
    parameters: pluginParameterSchema,
    async execute(_toolCallId: string, params: PluginToolParams): Promise<ToolResult> {
      const name = params.plugin;
      if (name.trim() === "") {
        return textError("plugin is required and must be non-empty");
      }
      const plugin = boot.pluginIndex.get(name);
      if (!plugin) {
        const namespaces = [...boot.pluginIndex.keys()].toSorted();
        return textError(
          `unknown plugin "${name}". Known namespaces: ${namespaces.length > 0 ? namespaces.join(", ") : "(none)"}`,
        );
      }
      const path = params.path;
      if (path.trim() === "") {
        return textError("path is required and must be a relative path inside the plugin root");
      }
      const target = resolvePluginResourcePath(plugin.root, path);
      if ("error" in target) {
        return textError(`plugin "${name}": ${target.error}`);
      }
      let text: string;
      try {
        text = readFileSync(target.path, "utf8");
      } catch (error) {
        const code = errorCode(error);
        return textError(
          code === "ENOENT"
            ? `plugin "${name}": missing resource ${target.path}`
            : `plugin "${name}": failed to read ${target.path}: ${code ?? errorMessage(error)}`,
        );
      }
      if (typeof params.args === "string") text = substituteArgs(text, params.args);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}

const FLEET_ALLOWED_FIELDS: Record<string, ReadonlySet<string>> = {
  list: new Set(["action", "scope", "format"]),
  send: new Set([
    "action",
    "subject",
    "body",
    "target",
    "targets",
    "broadcast",
    "deliver",
    "abort",
  ]),
  query: new Set(["action", "subject", "body", "target"]),
  status: new Set(["action", "messageId"]),
};

export interface FleetToolDeps {
  fleet: FleetCoordinator;
  hostProvider: () => HostSession | undefined;
}

export function makeFleetTool(deps: FleetToolDeps) {
  return defineTool({
    name: "Fleet",
    label: "Fleet",
    renderShell: "self",
    description:
      "Coordinate with the other sessions on this machine and the agents you spawned: `list` sessions and their recent activity; `send` a message to one, several, or all (`followUp` waits until the target is idle, `steer` enters its running turn); `query` one, where an isolated child session of the target answers and the reply arrives later as a message here; `status` reports delivery of a message you sent.",
    promptSnippet:
      "List, message, query, or check delivery status across local sessions and your agents",
    parameters: fleetParameterSchema,
    async execute(
      _toolCallId: string,
      params: FleetToolParams,
      signal: AbortSignal | undefined,
      _onUpdate,
      ctx,
    ): Promise<ToolResult> {
      const { fleet } = deps;
      const action = params.action;
      const allowed = typeof action === "string" ? FLEET_ALLOWED_FIELDS[action] : undefined;
      if (!allowed) {
        return textError(
          `action must be one of "list", "send", "query", or "status"; received ${JSON.stringify(action)}`,
        );
      }
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && !allowed.has(key)) {
          return textError(`field "${key}" is not valid for action "${action}"`);
        }
      }

      const host = deps.hostProvider();
      const callerSessionId = ctx?.sessionManager?.getSessionId?.() ?? host?.sessionId();
      const callerCwd = ctx?.cwd ?? host?.cwd() ?? process.cwd();
      if (!callerSessionId && (action !== "list" || params.scope === "children")) {
        return textError(`no live session identity for Fleet action "${action}"`);
      }
      // The identity of the caller decides what it may do (specs/session-store.md
      // Section 4; specs/fleet-tool.md Section 1): a session this boot window did
      // not register is refused every action but `list`; a child session
      // may `send` and its `query` waits for the reply
      // (Section 4.1).
      const identity = fleet.classifyCaller(callerSessionId);
      if (action !== "list" && identity === "foreign") {
        return textError(`no live session identity for Fleet action "${action}"`);
      }

      if (action === "list") {
        const scope = params.scope ?? "machine";
        if (scope !== "children" && scope !== "repo" && scope !== "machine") {
          return textError(
            `scope must be "children", "repo", or "machine"; received ${JSON.stringify(params.scope)}`,
          );
        }
        const format = params.format;
        if (
          format !== undefined &&
          format !== "compact" &&
          format !== "full" &&
          format !== "json"
        ) {
          return textError(
            `format must be "compact", "full", or "json"; received ${JSON.stringify(format)}`,
          );
        }
        const sessions =
          scope === "children"
            ? fleet.listSessions(scope, callerCwd, callerSessionId)
            : fleet.listSessions(scope, callerCwd);
        const text = formatFleetList(sessions, scope, format);
        return {
          content: [{ type: "text", text }],
          details: {
            action: "list",
            scope,
            format: format ?? "compact",
            snapshot: true,
            sessions: sessions.map((session) => fleetListSession(session)),
          },
        };
      }

      if (action === "send") {
        if (typeof params.body !== "string" || params.body.trim() === "") {
          return textError('body is required and must be a non-empty string for action "send"');
        }
        if (params.subject !== undefined && typeof params.subject !== "string") {
          return textError("subject must be a string when provided");
        }
        const deliver = params.deliver ?? "followUp";
        if (deliver !== "steer" && deliver !== "followUp") {
          return textError(
            `deliver must be "steer" or "followUp"; received ${JSON.stringify(params.deliver)}`,
          );
        }
        if (params.abort !== undefined && typeof params.abort !== "boolean") {
          return textError("abort must be a boolean when provided");
        }
        if (params.abort === true && deliver !== "steer") {
          return textError('abort: true is valid only with deliver: "steer"');
        }
        const abort = params.abort === true;

        const hasTarget = params.target !== undefined;
        const hasTargets = params.targets !== undefined;
        const hasBroadcast = params.broadcast !== undefined;
        if (Number(hasTarget) + Number(hasTargets) + Number(hasBroadcast) !== 1) {
          return textError(
            "send requires exactly one recipient mode: target, targets, or broadcast",
          );
        }

        if (hasTarget) {
          if (typeof params.target !== "string" || params.target.trim() === "") {
            return textError("target must be a non-empty string");
          }
          const resolved = fleet.resolveRecipient(params.target, callerSessionId);
          if ("error" in resolved) return textError(resolved.error);
          const sent = fleet.enqueueSend({
            senderSessionId: callerSessionId,
            target: resolved.session,
            subject: params.subject,
            body: params.body,
            deliver,
            abort,
          });
          const text =
            sent.status === "rejected"
              ? `Fleet send to ${sent.target} rejected (messageId ${sent.messageId}): ${sent.rejectionReason ?? "rejected"}`
              : `Fleet message ${sent.messageId} (${sent.status}) to ${sent.target} (target state: ${sent.state}, deliver: ${deliver}). Do not resend — poll Fleet status with messageId ${sent.messageId}.`;
          return {
            content: [{ type: "text", text }],
            details: {
              action: "send",
              messageId: sent.messageId,
              target: sent.target,
              state: sent.state,
              status: sent.status,
              deliver,
              ...(sent.rejectionReason === undefined
                ? {}
                : { rejectionReason: sent.rejectionReason }),
            },
            ...(sent.status === "rejected" ? { isError: true } : {}),
          };
        }

        // Fan-out: targets or broadcast.
        const resolvedRecipients: FleetSessionRecord[] = [];
        const seenSessionIds = new Set<string>();
        const failed: Array<{ target: string; messageId?: number; error: string }> = [];

        if (hasTargets) {
          if (!Array.isArray(params.targets) || params.targets.length === 0) {
            return textError("targets must be a non-empty array of recipient strings");
          }
          for (const raw of params.targets) {
            if (typeof raw !== "string" || raw.trim() === "") {
              failed.push({ target: String(raw), error: "target must be a non-empty string" });
              continue;
            }
            const res = fleet.resolveRecipient(raw, callerSessionId);
            if ("error" in res) {
              failed.push({ target: raw, error: res.error });
              continue;
            }
            if (!seenSessionIds.has(res.session.sessionId)) {
              seenSessionIds.add(res.session.sessionId);
              resolvedRecipients.push(res.session);
            }
          }
        } else {
          const bScope = params.broadcast;
          if (bScope !== "repo" && bScope !== "machine") {
            return textError(
              `broadcast must be "repo" or "machine"; received ${JSON.stringify(bScope)}`,
            );
          }
          for (const session of fleet.listSessions(bScope, callerCwd)) {
            if (session.sessionId === callerSessionId) continue;
            if (!seenSessionIds.has(session.sessionId)) {
              seenSessionIds.add(session.sessionId);
              resolvedRecipients.push(session);
            }
          }
        }

        const recipients: Array<{
          target: string;
          messageId: number;
          state: string;
          status: string;
        }> = [];
        for (const recipient of resolvedRecipients) {
          const sent = fleet.enqueueSend({
            senderSessionId: callerSessionId,
            target: recipient,
            subject: params.subject,
            body: params.body,
            deliver,
            abort,
          });
          if (sent.status === "rejected") {
            failed.push({
              target: sent.target,
              messageId: sent.messageId,
              error: sent.rejectionReason ?? "rejected",
            });
            continue;
          }
          recipients.push({
            target: sent.target,
            messageId: sent.messageId,
            state: sent.state,
            status: sent.status,
          });
        }

        const lines = [
          ...recipients.map(
            (r) =>
              `sent messageId=${r.messageId} target=${r.target} state=${r.state} status=${r.status}`,
          ),
          ...failed.map((f) => `failed target=${f.target}: ${f.error}`),
        ];
        return {
          content: [
            { type: "text", text: lines.length > 0 ? lines.join("\n") : "(no recipients matched)" },
          ],
          details: {
            action: "send",
            deliver,
            recipients,
            failed,
          },
          // Best-effort fan-out: only a call where every recipient failed is a tool error.
          ...(recipients.length === 0 && failed.length > 0 ? { isError: true } : {}),
        };
      }

      if (action === "query") {
        if (typeof params.body !== "string" || params.body.trim() === "") {
          return textError('body is required and must be a non-empty string for action "query"');
        }
        if (typeof params.target !== "string" || params.target.trim() === "") {
          return textError("target must be a non-empty string");
        }
        if (params.subject !== undefined && typeof params.subject !== "string") {
          return textError("subject must be a string when provided");
        }
        const resolved = fleet.resolveRecipient(params.target, callerSessionId);
        if ("error" in resolved) return textError(resolved.error);
        if (identity === "child") {
          // A child session's query waits for the reply (fleet-tool.md Section 4.1).
          let waited: ReturnType<FleetCoordinator["queryAndWait"]>;
          try {
            waited = fleet.queryAndWait({
              senderSessionId: callerSessionId,
              cwd: callerCwd,
              target: resolved.session,
              subject: params.subject,
              body: params.body,
              signal,
            });
          } catch (error) {
            return textError(`Fleet query failed: ${errorMessage(error)}`);
          }
          const headline = `Fleet query ${waited.messageId} to ${waited.target}`;
          try {
            const reply = await waited.reply;
            return {
              content: [
                {
                  type: "text",
                  text: `${headline} answered (correlationId: ${waited.correlationId}).\n${reply}`,
                },
              ],
              details: {
                action: "query",
                messageId: waited.messageId,
                correlationId: waited.correlationId,
                target: waited.target,
                state: waited.state,
                reply,
              },
            };
          } catch (error) {
            return textError(`${headline} failed: ${errorMessage(error)}`);
          }
        }
        const queued = fleet.enqueueQuery({
          senderSessionId: callerSessionId,
          target: resolved.session,
          subject: params.subject,
          body: params.body,
        });
        const text = `Fleet query ${queued.messageId} enqueued to ${queued.target} (correlationId: ${queued.correlationId}, target state: ${queued.state}). Do not poll for the reply — the target will deliver a followUp reply quoting correlationId ${queued.correlationId} when its child session settles.`;
        return {
          content: [{ type: "text", text }],
          details: {
            action: "query",
            messageId: queued.messageId,
            correlationId: queued.correlationId,
            target: queued.target,
            state: queued.state,
          },
        };
      }

      // action === "status"
      if (typeof params.messageId !== "number" || !Number.isInteger(params.messageId)) {
        return textError('messageId is required and must be an integer for action "status"');
      }
      const status = fleet.getMessageStatus(callerSessionId, params.messageId);
      const parts = [`messageId=${status.messageId}`, `status=${status.status}`];
      if (status.target !== undefined) parts.push(`target=${status.target}`);
      if (status.deliveredAt !== undefined) parts.push(`deliveredAt=${status.deliveredAt}`);
      if (status.rejectionReason !== undefined) parts.push(`reason=${status.rejectionReason}`);
      return {
        content: [{ type: "text", text: parts.join(" ") }],
        details: {
          action: "status",
          ...status,
        },
      };
    },
  });
}

/** Re-exported for engine wiring (customTools arrays). */
export type AnyTool = ToolDefinition;
