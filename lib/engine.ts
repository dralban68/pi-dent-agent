import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  type Stats,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  type AgentToolResult,
  type CreateAgentSessionOptions,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type ToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  type AgentDefinition,
  applyAgentsOverride,
  type SkillEntry,
  composePluginCatalogs,
  discoverAgents,
  discoverSkills,
} from "./catalogs.ts";
import { resolveCwdParam } from "./cwd-param.ts";
import { type PluginEntry, appendPluginContext, discoverPlugins } from "./plugins.ts";
import { type BootConfig, parseScript, parseTaskBrowser, readConfig } from "./config.ts";
import type { CompactionSettings, HostSession } from "./host.ts";
import type { BillingService } from "./billing.ts";
import {
  childGuidance,
  guidanceActive,
  guidanceBillingProviders,
  guidedModels,
  isGuidedDispatch,
  modelCatalog,
  parsedModelGuidance,
  sessionRules,
} from "./model-guidance.ts";
import {
  type Descriptor,
  isThinkingLevel,
  ModelStringError,
  resolveContextFromConfig,
  resolveModelString,
  serializeDescriptor,
  type ThinkingLevel,
  modelClassDiagnostics,
} from "./model-string.ts";
import { type FleetCoordinator, ownedElsewhereWarning, ownSessionWarning } from "./fleet.ts";
import { AgentTaskRow, TaskRegistry, type TaskStatus, SPILL_THRESHOLD } from "./registry.ts";
import type { SettleStatus } from "./task-row.ts";
import { rewriteSettledRecord, writeRunningRecord } from "./task-record.ts";
import { addMessage, UsageTally } from "./usage.ts";
import {
  makeAgentTool,
  makeFleetTool,
  makePluginTool,
  makeSessionTool,
  makeSkillTool,
  makeTaskTool,
  CohortTracker,
} from "./tools.ts";
import { makeScriptTool } from "./script-tool.ts";
import { DEFAULT_TOOLS_ALLOW } from "./script-tool-types.ts";
import { registerReadErrorHint } from "./output-file.ts";
import { makeBashTool, type BashSettings } from "./bash-tool.ts";
import { makeSearchTool, searchRuntime } from "./search-tool.ts";
import { makeMarkdownTool, markdownRuntime } from "pi-dent-markdown";
import { readLocalZone } from "./billing-text.ts";
import type { AgentToolParams } from "./tools.ts";
import {
  type Diagnostic,
  errorMessage,
  firstLine,
  isNonNegativeInteger,
  isPlainObject,
  safeName,
} from "./util.ts";

/**
 * Dispatch engine per specs/agent-tool.md: frozen dispatch plans, in-process
 * SDK child sessions, bounded caller-owned recovery, in-place continuation,
 * liveness deadlines, cooperative cancellation, result spill, and observation.
 */

export type StopReason = "stop" | "error" | "aborted" | "timeout";
export type FailurePhase = "plan-resolution" | "startup" | "execution";

/** Failure codes per agent-tool.md Sections 3, 4.2, and 7. */
export type PlanFailureCode =
  | "missing-tool-authority"
  | "missing-model"
  | "missing-model-class"
  | "ambiguous-model"
  | "unsupported-thinking"
  | "unguided-model"
  | "invalid-plan";
export type StartupFailureCode = "missing-runtime";
export type ExecutionFailureCode = "invalid-turn" | "timeout" | "aborted" | "execution-error";
export type FailureCode = PlanFailureCode | StartupFailureCode | ExecutionFailureCode;

export interface TraceEvent {
  kind: "tool_call" | "tool_result";
  agent: string;
  toolCallId: string;
  toolName: string;
  isError?: boolean;
}

export interface UsageAggregate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export function emptyUsage(): UsageAggregate {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export interface AttemptRecord {
  agent: string;
  status: TaskStatus;
  stopReason: StopReason;
  failureCode?: FailureCode | undefined;
  failurePhase?: FailurePhase | undefined;
  model?: string | undefined;
  modelSource?: "call" | "agent" | "persisted" | "inherited" | undefined;
  previousModel?: string | undefined;
  usage: UsageAggregate;
  sessionPath?: string | undefined;
  trace: TraceEvent[];
}

export interface BootSnapshot {
  cwd: string;
  config: BootConfig;
  agents: AgentDefinition[];
  agentIndex: Map<string, AgentDefinition>;
  skills: SkillEntry[];
  skillIndex: Map<string, SkillEntry>;
  plugins: PluginEntry[];
  /** Namespace -> first admitted plugin (specs/plugin.md Section 8). */
  pluginIndex: Map<string, PluginEntry>;
  diagnostics: Diagnostic[];
  maxRecoveryRetries: number;
  sessionTtlDays: number;
}

/** Result shape returned by every pi-dent tool (agent-tool.md Section 7). */
export type ToolResult = AgentToolResult<Record<string, unknown>>;

export type UpdateCallback = (partial: ToolResult) => void;

export interface DispatchCall {
  toolCallId: string;
  params: AgentToolParams;
  signal?: AbortSignal | undefined;
  onUpdate?: UpdateCallback | undefined;
  /** Undefined when no live main session exists: the dispatch has no tool cap (Section 3.1). */
  host: HostSession | undefined;
  cohortId: string;
  /**
   * Restricted plan tool cap (Fleet `query` children, fleet-tool.md Section 4):
   * the exact tools the child binds; dispatch authority still comes from the
   * host tool cap.
   */
  planToolCap?: string[] | undefined;
  /** Set only by the Fleet `query` path: its attempt never waits for running rows (Section 4.2). */
  fleetQuery?: boolean | undefined;
}

export type DispatchFn = (call: DispatchCall) => Promise<ToolResult>;

/** Typed plan-resolution failure (agent-tool.md Section 3). */
class PlanError extends Error {
  readonly phase = "plan-resolution" as const;
  readonly code: PlanFailureCode;

  constructor(code: PlanFailureCode, message: string) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

/** One tool of the dispatching session that an inherited extension source provided. */
export interface InheritedTool {
  readonly name: string;
  readonly source: string;
}

/**
 * The extension sources a child inherits (agent-tool.md Section 3.1), snapshotted
 * from the dispatching session's complete tool inventory before the child starts.
 */
export interface InheritedExtensions {
  /** Sources the child loads: file paths first, then built-ins, each group in inventory order. */
  readonly sources: readonly string[];
  /** The tools those sources provided in the dispatching session, in inventory order. */
  readonly tools: readonly InheritedTool[];
}

export interface ExecutionSnapshot {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly agentsDir: string;
  readonly compaction: CompactionSettings | undefined;
  /** The extension sources the child loads, and the tools they provide (Section 3.1). */
  readonly extensions: InheritedExtensions;
}

export interface DispatchPlan {
  readonly agent: string;
  readonly prompt: string;
  readonly cwd: string;
  tools: readonly string[];
  skills: readonly SkillEntry[];
  readonly model: Model<Api>;
  readonly modelLabel: string;
  readonly thinking?: ThinkingLevel | undefined;
  readonly modelSource: "call" | "agent" | "persisted" | "inherited";
  readonly previousModel?: string | undefined;
  readonly sessionPolicy:
    | { readonly kind: "persistent" }
    | {
        readonly kind: "resume";
        readonly resume: string;
        readonly cwdOverride?: string | undefined;
        /** Persisted facts read at plan time, before the dispatch appends anything (Section 9). */
        readonly persistedModel?: { readonly provider: string; readonly id: string } | undefined;
        readonly persistedThinking?: ThinkingLevel | undefined;
      };
  readonly task: string;
  readonly descriptor: Descriptor;
}

export interface SettledResult {
  isError: boolean;
  text: string;
  records: AttemptRecord[];
}

const REFUSAL_PATTERN = /cannot assist with that request/i;
/** Longest trimmed final text still read as a refusal; a longer one merely quotes the phrase. */
const REFUSAL_MAX_LENGTH = 300;

function isRefusal(text: string): boolean {
  return text.trim().length <= REFUSAL_MAX_LENGTH && REFUSAL_PATTERN.test(text);
}
const TRANSIENT_PATTERN =
  /(\b429\b|\b(500|502|503|504|52\d)\b|rate.?limit|overload|quota|service unavailable|network|timeout|timed out|econn|fetch failed|etimedout|eai_again|retryable)/i;
const NON_TRANSIENT_PATTERN =
  /(\b401\b|\b403\b|unauthorized|forbidden|api key|authentication|invalid request|missing model|not found)/i;

/** Session files held by a running dispatch, shared across every engine (per resolved path). */
const inFlightSessions = new Set<string>();

/**
 * A file's real path, symbolic links and `..` segments resolved (agent-tool.md
 * Section 9); a path that cannot be resolved compares as resolved. Two rows name
 * one session file when this yields one value for both.
 */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function planError(code: PlanFailureCode, message: string): PlanError {
  return new PlanError(code, message);
}

/**
 * A path's `stat`, or none when the path does not exist or cannot be examined.
 * A failure is reported by the caller as its pre-start rejection.
 */
function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/**
 * pi's built-in tool names. The SDK does not export its built-in name set
 * (`allToolNames` in `dist/core/tools/index.js` of @earendil-works/pi-coding-agent
 * 1.5.0 is not re-exported from the package root), so the set is mirrored here
 * from that source.
 */
const PI_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

/**
 * The pi built-in tool names pi-dent deactivates or never binds in a child
 * (agent-tool.md Section 3.1): the tool-cap name `bash`, and `Schedule` and
 * `AskUserQuestion`, which an extension registering them does not make bindable.
 */
const UNBINDABLE_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "Schedule", "AskUserQuestion"]);

/**
 * The MCP resource tool names pi treats as MCP tools (`isMcpToolName` in
 * dist/core/mcp-servers.js), which stay callable without the allowlist naming
 * them.
 */
const MCP_RESOURCE_TOOL_NAMES: readonly string[] = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];

/**
 * Parent inventory names preserve tools registered only at session_start (MCP proxies).
 * The cap remains the authority (agent-tool.md Section 3.1).
 */
export function effectiveToolCap(
  toolCap: readonly string[],
  childTools: readonly { name: string }[],
  inheritedTools: readonly string[],
): string[] {
  const bound = new Set(childTools.map((tool) => tool.name));
  // An in-process definition wins over an extension tool of the same name: pi-dent's
  // child tools remain its own (Section 3.1).
  const external = new Set(inheritedTools.filter((name) => !bound.has(name)));
  return toolCap.filter(
    (name) =>
      !UNBINDABLE_TOOL_NAMES.has(name) &&
      (PI_BUILTIN_TOOL_NAMES.has(name) || bound.has(name) || external.has(name)),
  );
}

/** Prefix of a built-in extension path, `builtin:<name>` (pi's source-info module). */
const BUILTIN_PATH_PREFIX = "builtin:";

/** pi-dent's package directory, whose own code a child never loads again (Section 3.1). */
const PI_DENT_PACKAGE_ROOT = realPath(dirname(dirname(fileURLToPath(import.meta.url))));

/** The subtree under which a dependency source stays eligible for inheritance (Section 3.1). */
const PI_DENT_DEPENDENCY_ROOT = join(PI_DENT_PACKAGE_ROOT, "node_modules");

/**
 * Whether `path` is pi-dent's own code: its package root or a descendant, except the
 * dependency sources under its `node_modules/` subtree (Section 3.1). Paths are
 * compared canonically, so a symbolic link to pi-dent's code is excluded too.
 */
function isPiDentOwnCode(path: string): boolean {
  const canonical = realPath(path);
  if (canonical === PI_DENT_PACKAGE_ROOT) return true;
  if (!canonical.startsWith(`${PI_DENT_PACKAGE_ROOT}${sep}`)) return false;
  return (
    canonical !== PI_DENT_DEPENDENCY_ROOT &&
    !canonical.startsWith(`${PI_DENT_DEPENDENCY_ROOT}${sep}`)
  );
}

/**
 * The extension source a tool's path names, or undefined when it names none: a
 * pi built-in tool (`builtin:read`), an inline extension, or a path in pi-dent's
 * own package. A path outside the package is kept even when it does not exist,
 * so the loader reports it rather than the snapshot dropping it silently.
 */
function extensionSourceOf(path: string): string | undefined {
  if (path.startsWith(BUILTIN_PATH_PREFIX)) {
    const name = path.slice(BUILTIN_PATH_PREFIX.length);
    return PI_BUILTIN_TOOL_NAMES.has(name) ? undefined : path;
  }
  if (!isAbsolute(path) || isPiDentOwnCode(path)) return undefined;
  return path;
}

/**
 * Snapshot the parent inventory (agent-tool.md Section 3.1). Files precede built-ins
 * so file extensions can replace replaceable built-ins, as in the SDK loader.
 */
export function inheritedExtensions(host: HostSession): InheritedExtensions {
  const files: string[] = [];
  const builtins: string[] = [];
  const tools: InheritedTool[] = [];
  const seen = new Set<string>();
  for (const tool of host.allTools?.() ?? []) {
    const path = tool.sourceInfo?.path;
    if (typeof path !== "string") continue;
    const source = extensionSourceOf(path);
    if (source === undefined) continue;
    if (!seen.has(source)) {
      seen.add(source);
      if (source.startsWith(BUILTIN_PATH_PREFIX)) builtins.push(source);
      else files.push(source);
    }
    tools.push({ name: tool.name, source });
  }
  return { sources: [...files, ...builtins], tools };
}

/** What the loader made of the sources a dispatch requested (agent-tool.md Section 3.1). */
interface InheritedLoadOutcome {
  /** Requested sources the loader neither loaded nor reported an error for. */
  readonly omitted: readonly string[];
  /** Canonical keys of the requested sources whose tools are unavailable. */
  readonly unavailable: ReadonlySet<string>;
  /** Requested sources that reported an error and did not load. */
  readonly failures: readonly { readonly path: string; readonly error: string }[];
  /** Errors of sources that did load: a conflict between extensions (Section 3.1). */
  readonly conflicts: readonly { readonly path: string; readonly error: string }[];
  /** Errors no requested source accounts for: pi-dent's own inline extension factories. */
  readonly others: readonly { readonly path: string; readonly error: string }[];
}

/** The SDK can omit sources without errors, including replaced built-ins. Report those too. */
function inheritedLoadOutcome(
  requested: readonly string[],
  loaded: {
    readonly extensions: readonly { readonly path: string; readonly resolvedPath: string }[];
    readonly errors: readonly { readonly path: string; readonly error: string }[];
  },
): InheritedLoadOutcome {
  const loadedKeys = new Set<string>();
  for (const extension of loaded.extensions) {
    loadedKeys.add(realPath(extension.path));
    loadedKeys.add(realPath(extension.resolvedPath));
  }
  const requestedKeys = new Set(requested.map((source) => realPath(source)));
  const failures: { path: string; error: string }[] = [];
  const conflicts: { path: string; error: string }[] = [];
  const others: { path: string; error: string }[] = [];
  const errorKeys = new Set<string>();
  for (const failure of loaded.errors) {
    const key = realPath(failure.path);
    // A source that did load reports a conflict, not a load failure, and does not
    // hide the warning of a source the loader dropped without an error.
    if (loadedKeys.has(key)) conflicts.push(failure);
    else if (requestedKeys.has(key)) {
      failures.push(failure);
      errorKeys.add(key);
    } else others.push(failure);
  }
  const omitted: string[] = [];
  const unavailable = new Set<string>();
  for (const source of requested) {
    const key = realPath(source);
    if (loadedKeys.has(key)) continue;
    unavailable.add(key);
    if (!errorKeys.has(key)) omitted.push(source);
  }
  return { omitted, unavailable, failures, conflicts, others };
}

/**
 * The tool names the inherited sources make available (agent-tool.md Section
 * 3.1): an unavailable source contributes none, so its tools are absent from the
 * effective tool cap while the rest still load.
 */
function availableInheritedTools(
  extensions: InheritedExtensions,
  unavailable: ReadonlySet<string>,
): string[] {
  if (unavailable.size === 0) return extensions.tools.map((tool) => tool.name);
  return extensions.tools
    .filter((tool) => !unavailable.has(realPath(tool.source)))
    .map((tool) => tool.name);
}

/**
 * The built-in extensions whose tools a child can inherit (agent-tool.md Section
 * 3.1). llama.cpp is absent: it registers commands only, so it sources no tool a
 * snapshot could carry.
 */
export function defaultBuiltinExtensions(): InlineExtension[] {
  return [
    { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
    { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
  ];
}

/** The longest the child's extension shutdown may take (agent-tool.md Section 3.1). */
const EXTENSION_SHUTDOWN_TIMEOUT_MS = 1000;

/** How the child's session-shutdown lifecycle ended (agent-tool.md Section 3.1). */
type ExtensionShutdownOutcome = "done" | "timeout" | { readonly error: unknown };

/**
 * Run the child's session-shutdown lifecycle, waiting at most `deadlineMs`
 * (agent-tool.md Section 3.1). A failure after the deadline is reported to
 * stderr, never left unhandled.
 */
function extensionShutdown(
  session: AgentSession,
  deadlineMs: number,
): Promise<ExtensionShutdownOutcome> {
  return new Promise((complete) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      complete("timeout");
    }, deadlineMs);
    const finish = (outcome: ExtensionShutdownOutcome): void => {
      if (settled) {
        // The deadline already reported; a late failure still reaches stderr.
        if (outcome !== "done" && outcome !== "timeout") {
          process.stderr.write(
            `pi-dent: extension shutdown failed after the deadline: ${errorMessage(outcome.error)}\n`,
          );
        }
        return;
      }
      settled = true;
      clearTimeout(timer);
      complete(outcome);
    };
    try {
      session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).then(
        () => finish("done"),
        (error: unknown) => finish({ error }),
      );
    } catch (error) {
      finish({ error });
    }
  });
}

/** The read-only tools a Fleet `query` child may bind (fleet-tool.md Section 4). */
const QUERY_READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/**
 * The Fleet `query` child's tool cap: exactly the read-only tools present in
 * the target session's tool cap (fleet-tool.md Section 4).
 */
export function queryToolCap(targetTools: readonly string[]): string[] {
  return QUERY_READ_ONLY_TOOLS.filter((name) => targetTools.includes(name));
}

function textOfContent(content: AssistantMessage["content"]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function hasToolCall(content: AssistantMessage["content"]): boolean {
  return content.some((block) => block.type === "toolCall");
}

/** Persisted session facts read from a retained session file. */
interface PersistedSession {
  cwd?: string;
  model?: { provider: string; id: string };
  thinking?: ThinkingLevel;
}

function readPersistedSession(path: string): PersistedSession | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const result: PersistedSession = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(entry)) continue;
    if (entry.type === "session" && typeof entry.cwd === "string") result.cwd = entry.cwd;
    if (
      entry.type === "model_change" &&
      typeof entry.provider === "string" &&
      typeof entry.modelId === "string"
    ) {
      result.model = { provider: entry.provider, id: entry.modelId };
    }
    if (
      entry.type === "thinking_level_change" &&
      typeof entry.thinkingLevel === "string" &&
      isThinkingLevel(entry.thinkingLevel)
    ) {
      result.thinking = entry.thinkingLevel;
    }
  }
  return result;
}

/** Decimal-digit environment count no smaller than `min`; any other value reports one diagnostic and falls back. */
function parseEnvCount(name: string, fallback: number, diagnostics: Diagnostic[], min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !isNonNegativeInteger(value) || value < min) {
    diagnostics.push({
      level: "warning",
      message: `pi-dent: ${name} must be ${min > 0 ? "a positive" : "a non-negative"} integer; using ${fallback}`,
    });
    return fallback;
  }
  return value;
}

/**
 * Append the `<available_skills>` injection to a system prompt after a blank
 * line (skill-tool.md Section 1); the prompt is returned unchanged for an
 * empty skill catalog.
 */
export function appendSkillCatalog(prompt: string, skills: readonly SkillEntry[]): string {
  if (skills.length === 0) return prompt;
  const lines = skills
    .map((skill) => `${skill.name} — ${skill.description.replace(/(?:\r\n|[\r\n])+/g, " ")}`)
    .join("\n");
  return `${prompt}\n\n<available_skills>\n${lines}\n</available_skills>`;
}

const SESSION_NOTE_LINES: readonly (readonly [tools: readonly string[], line: string])[] = [
  [["read"], "Read a file with `read` before editing it, not through `Bash`."],
  [["edit"], "Change files with `edit`; use `write` only for new files and full rewrites."],
  [["Script"], "Run JavaScript or TypeScript with `Script`, never through `Bash`."],
  [
    ["Bash"],
    "Run a long-running command with `Bash` and `background: true`, never with `&` or `nohup`.",
  ],
  [
    ["Bash"],
    "Before every `Bash` call, check the command: if it ends in `| tail`, `| head`, `| grep` or `> file`, delete that ending. `Bash` already returns only the last 50 lines and saves the full output to a file the result names.",
  ],
  [["Skill"], "Load a `Skill` when the task matches one in `<available_skills>`."],
  [
    // A child that can dispatch an agent needs the transcript it can look back into.
    ["Search", "Agent"],
    "Everything an agent you dispatched ran, printed, or said is in its transcript, not only its final message: `Search` `find` with `session` set to its task ID, or to its session file path for a resumed agent, then `get` the hit by its address. A bare `find` searches this session; use it before redoing work and after a summary replaced earlier turns. Never read session files through `Bash`.",
  ],
  [
    [],
    "Your final message is the result returned to the caller: make it complete, and claim only what you verified.",
  ],
];

/** The session notes of a dynamic dispatch (agent-tool.md Section 4.2). */
export function sessionNotes(dir: string, tools: readonly string[]): string {
  const lines = [
    `\`PI_DENT_SESSION_DIR\` (${dir}) is this session's own directory, set in your tools' environment. Write temporary files there, never in the project tree.`,
    ...SESSION_NOTE_LINES.filter(([required]) =>
      required.every((tool) => tools.includes(tool)),
    ).map(([, line]) => line),
  ];
  return `Session notes:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

/**
 * Build child session system prompt per specs/agent-tool.md Section 4.2, specs/plugin.md
 * Section 10, and specs/model-guidance.md Section 4: prompt, skill catalog, plugin context,
 * session rules, child guidance.
 */
export function buildChildSystemPrompt(
  prompt: string,
  skills: readonly SkillEntry[],
  model: { provider: string; id: string },
  config: BootConfig,
  childGuidanceText?: string,
  plugins: readonly PluginEntry[] = [],
): string {
  const { guidance } = parsedModelGuidance(config);
  const childRules = sessionRules(guidance, `${model.provider}/${model.id}`);
  const promptWithSkills = appendPluginContext(appendSkillCatalog(prompt, skills), plugins);
  const withRules =
    childRules.length > 0
      ? `${promptWithSkills}${childRules.map((r) => `\n\n${r}`).join("")}`
      : promptWithSkills;
  return childGuidanceText ? `${withRules}\n\n${childGuidanceText}` : withRules;
}

/**
 * The child guidance of one dispatch (model-guidance.md Section 4): only for a
 * child whose tool cap includes `Agent`, after the cached query on the main
 * session's billing service where billing.md Section 4.3 requires one.
 */
export async function dispatchChildGuidance(
  billing: BillingService | undefined,
  config: BootConfig,
  tools: readonly string[],
  configuredModels: readonly Model<Api>[],
): Promise<string | undefined> {
  if (!tools.includes("Agent")) return undefined;
  const { guidance } = parsedModelGuidance(config);
  if (billing) await billing.cachedQueryWait(guidanceBillingProviders(guidance, configuredModels));
  const text = childGuidance(guidance, configuredModels, billing?.view());
  return text === "" ? undefined : text;
}

/** Read the boot snapshot: configuration, agent, skill, and plugin catalogs. */
export function readBootSnapshot(cwd = process.cwd()): BootSnapshot {
  const config = readConfig(cwd);
  const diagnostics = [...config.diagnostics];
  for (const message of modelClassDiagnostics(config)) {
    diagnostics.push({ level: "warning", message });
  }
  for (const message of parseTaskBrowser(config).diagnostics) {
    diagnostics.push({ level: "warning", message });
  }
  for (const message of parseScript(config).diagnostics) {
    diagnostics.push({ level: "warning", message });
  }
  for (const message of parsedModelGuidance(config).diagnostics) {
    diagnostics.push({ level: "warning", message });
  }
  const agents = discoverAgents(cwd, diagnostics);
  const skills = discoverSkills(cwd, diagnostics);
  const pluginCatalog = discoverPlugins(config, diagnostics);
  // Plugin entries join after pi-dent's own (plugin.md Section 9); the `agents`
  // override applies over the composed catalog, so `namespace:name` keys are
  // overridable (agent.md Section 2).
  composePluginCatalogs(agents, skills, pluginCatalog.plugins, diagnostics);
  applyAgentsOverride(config, agents, diagnostics);
  return {
    cwd,
    config,
    agents,
    agentIndex: new Map(agents.map((agent) => [agent.name, agent])),
    skills,
    skillIndex: new Map(skills.map((skill) => [skill.name, skill])),
    plugins: pluginCatalog.plugins,
    pluginIndex: pluginCatalog.byNamespace,
    diagnostics,
    maxRecoveryRetries: parseEnvCount("PI_DENT_AGENT_RECOVERY_MAX_RETRIES", 2, diagnostics),
    sessionTtlDays: parseEnvCount("PI_DENT_SESSION_TTL_DAYS", 30, diagnostics, 1),
  };
}

/**
 * Whether any of `dir`, every entry inside it at any depth, or `extra` paths has a
 * modification time of `cutoff` or later. Stops at the first one; symlinks are not
 * followed; unreadable entries count as old.
 */
function isActiveSince(dir: string, cutoff: number, extra: readonly string[] = []): boolean {
  const recent = (path: string): boolean => {
    try {
      return lstatSync(path).mtimeMs >= cutoff;
    } catch {
      return false;
    }
  };
  const visit = (path: string): boolean => {
    if (recent(path)) return true;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((entry) => {
      const child = join(path, entry.name);
      return entry.isDirectory() ? visit(child) : recent(child);
    });
  };
  if (visit(dir)) return true;
  return extra.some(recent);
}

/**
 * The retention sweep (agent-tool.md Section 10): at boot-window start only,
 * delete each top-level agent directory (`<stem>.agents` in a session-store
 * project directory, or a directory under `<tmpdir>/pi-dent-sessions/`) whose
 * last activity is older than `PI_DENT_SESSION_TTL_DAYS` days, whole, unless it is
 * or contains the agent directory of a live session (`liveDirs`; undefined —
 * the store was unreadable — deletes no agent directory). Output files have no
 * sweep of their own: they are deleted only with their agent directory. Nothing
 * else is deleted.
 */
export function retentionSweep(ttlDays: number, liveDirs: readonly string[] | undefined): void {
  const cutoff = Date.now() - ttlDays * 86_400_000;
  const live = (liveDirs ?? []).map((dir) => resolve(dir));
  const pruneIfOld = (path: string, sessionFile?: string) => {
    if (liveDirs === undefined) return;
    const top = resolve(path);
    if (live.some((dir) => dir === top || dir.startsWith(top + sep))) return;
    try {
      if (!isActiveSince(path, cutoff, sessionFile ? [sessionFile] : [])) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Best effort.
    }
  };
  const sweepAgentsDirs = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.endsWith(".agents")) {
        const stem = entry.name.slice(0, -".agents".length);
        pruneIfOld(join(dir, entry.name), join(dir, `${stem}.jsonl`));
      }
    }
  };
  try {
    for (const entry of readdirSync(join(tmpdir(), "pi-dent-sessions"), { withFileTypes: true })) {
      if (entry.isDirectory()) pruneIfOld(join(tmpdir(), "pi-dent-sessions", entry.name));
    }
  } catch {
    // No fallback root.
  }
  try {
    const sessionsRoot = join(getAgentDir(), "sessions");
    for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (project.isDirectory()) sweepAgentsDirs(join(sessionsRoot, project.name));
    }
  } catch {
    // No sessions root.
  }
}

/** A session's agent directory: `<sessionDir>/<sessionStem>.agents/`, else under `<tmpdir>/pi-dent-sessions/`. */
export function agentsDirFor(sessionFile: string | undefined, sessionId: string): string {
  if (sessionFile) {
    const stem = basename(sessionFile).replace(/\.jsonl$/, "");
    return join(dirname(sessionFile), `${stem}.agents`);
  }
  return join(tmpdir(), "pi-dent-sessions", sessionId);
}

/**
 * The agent directory of the session a host adapter speaks for (agent-tool.md
 * Section 4.2): the value `openMainSessionDir` creates and exposes, computed
 * from the host rather than read from the environment, so a child session's
 * tools never resolve the main session's directory.
 */
export function agentDirForHost(host: HostSession): string {
  return agentsDirFor(host.sessionFile(), host.sessionId());
}

/**
 * Create the main session's agent directory and expose it as `PI_DENT_SESSION_DIR`
 * in the process environment (agent-tool.md Section 4.2). A failure leaves the
 * variable unset.
 */
export function openMainSessionDir(sessionFile: string | undefined, sessionId: string): void {
  const dir = agentsDirFor(sessionFile, sessionId);
  try {
    mkdirSync(dir, { recursive: true });
    process.env.PI_DENT_SESSION_DIR = dir;
  } catch {
    delete process.env.PI_DENT_SESSION_DIR;
  }
}

/**
 * Refresh the directory's modification time (the end of the session, agent-tool.md
 * Section 10) and unset `PI_DENT_SESSION_DIR`; never removes the directory.
 */
export function closeMainSessionDir(sessionFile: string | undefined, sessionId: string): void {
  const dir = agentsDirFor(sessionFile, sessionId);
  if (process.env.PI_DENT_SESSION_DIR === dir) delete process.env.PI_DENT_SESSION_DIR;
  try {
    const now = new Date();
    utimesSync(dir, now, now);
  } catch {
    // Absent or unwritable.
  }
}

/** Host adapter over the main session's extension context. */
export function hostFromContext(
  pi: Pick<ExtensionAPI, "getActiveTools" | "sendMessage"> &
    Partial<Pick<ExtensionAPI, "getAllTools">>,
  ctx: ExtensionContext,
): HostSession {
  return {
    cwd: () => ctx.cwd,
    sessionId: () => ctx.sessionManager.getSessionId(),
    sessionFile: () => ctx.sessionManager.getSessionFile(),
    sessionDir: () => ctx.sessionManager.getSessionDir(),
    model: () => (ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined),
    thinking: () => ctx.thinkingLevel,
    activeTools: () => pi.getActiveTools(),
    allTools: () => pi.getAllTools?.() ?? [],
    inventory: () => ctx.modelRegistry.getAll(),
    configuredModels: () => ctx.modelRegistry.getAvailable() ?? [],
    contextWindow: () => ctx.model?.contextWindow,
    compaction: () => {
      const { compaction, errors } = readMainCompaction(ctx.cwd);
      // Each settings file that cannot be read contributes nothing and is named
      // in one warning (Section 3.4).
      for (const error of errors) ctx.ui.notify(error, "warning");
      return compaction;
    },
    // Completion notification: into the conversation, followUp (task-registry.md Section 5).
    notify: (message) => {
      pi.sendMessage(
        { customType: "pi-dent-tasks", content: message, display: true },
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
    warn: (message) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else process.stderr.write(`${message}\n`);
    },
  };
}

/** Send one completion notification into a child session; `token` identifies it in `details`. */
function sendNotification(session: AgentSession, token: number, message: string): Promise<void> {
  return session.sendCustomMessage(
    { customType: "pi-dent-tasks", content: message, display: true, details: { token } },
    { deliverAs: "followUp", triggerTurn: true },
  );
}

/** The token a notification carries in its `details`, or -1. */
function notificationToken(details: unknown): number {
  if (typeof details !== "object" || details === null || !("token" in details)) return -1;
  return typeof details.token === "number" ? details.token : -1;
}

/** Host adapter over a child AgentSession (nested dispatch authority). */
export function hostFromSessionBox(
  box: { current?: AgentSession | undefined },
  hooks?: { sent: (token: number, message: string) => void; failed: (token: number) => void },
): HostSession {
  const session = () => box.current;
  let nextToken = 0;
  return {
    cwd: () => session()?.sessionManager.getCwd() ?? process.cwd(),
    sessionId: () => session()?.sessionId ?? "",
    sessionFile: () => session()?.sessionFile,
    sessionDir: () => session()?.sessionManager.getSessionDir() ?? "",
    model: () => {
      const model = session()?.model;
      return model ? { provider: model.provider, id: model.id } : undefined;
    },
    thinking: () => session()?.thinkingLevel,
    activeTools: () => session()?.getActiveToolNames() ?? [],
    allTools: () => session()?.getAllTools() ?? [],
    inventory: () => session()?.modelRuntime.getModels() ?? [],
    configuredModels: () => session()?.modelRuntime.getAvailableSnapshot() ?? [],
    contextWindow: () => session()?.model?.contextWindow,
    compaction: () => {
      // The compaction the child session actually runs with, which a nested dispatch
      // inherits (Section 3.4); reading it back cannot fail.
      const current = session();
      return current ? current.settingsManager.getSettings().compaction : undefined;
    },
    // Completion notification: into the child conversation, followUp (task-registry.md Section 5).
    notify: (message) => {
      const current = session();
      // Rows are consumed only once the host accepted the message, so a missing child
      // session fails the send and leaves the rows unconsumed (Section 5).
      if (!current) throw new Error("no live child session for the completion notification");
      const token = nextToken++;
      hooks?.sent(token, message);
      void sendNotification(current, token, message).catch(() => {
        // The child session may be gone; settlement stands.
        hooks?.failed(token);
      });
    },
    // A warning into the child conversation: displayed, with no triggered turn and no
    // completion bookkeeping (agent-tool.md Section 3.1).
    warn: (message) => {
      const current = session();
      if (!current) throw new Error("no live child session for the warning");
      void current
        .sendCustomMessage(
          { customType: "pi-dent-warning", content: message, display: true },
          { deliverAs: "followUp", triggerTurn: false },
        )
        .catch((error: unknown) => {
          process.stderr.write(`${message} (warning not delivered: ${errorMessage(error)})\n`);
        });
    },
  };
}

let modelRuntimePromise: Promise<ModelRuntime> | undefined;

/** Live model runtime shared with the main session's settings and credentials. */
function sharedModelRuntime(): Promise<ModelRuntime> {
  if (!modelRuntimePromise) {
    modelRuntimePromise = ModelRuntime.create({ refreshOnCreate: false }).catch(
      (error: unknown) => {
        modelRuntimePromise = undefined;
        throw error;
      },
    );
  }
  return modelRuntimePromise;
}

/** The compaction defaults of agent-tool.md Section 3.4 (pi's own defaults). */
const COMPACTION_DEFAULTS: Required<CompactionSettings> = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/**
 * The child's compaction settings (agent-tool.md Section 3.4): the dispatching
 * session's, each field it leaves out taking the default. The child's own
 * working directory contributes none of them.
 */
function childCompaction(inherited: CompactionSettings | undefined): Required<CompactionSettings> {
  return {
    enabled: inherited?.enabled ?? COMPACTION_DEFAULTS.enabled,
    reserveTokens: inherited?.reserveTokens ?? COMPACTION_DEFAULTS.reserveTokens,
    keepRecentTokens: inherited?.keepRecentTokens ?? COMPACTION_DEFAULTS.keepRecentTokens,
  };
}

/**
 * The main session's compaction settings (agent-tool.md Section 3.4): the settings
 * files of its working directory, and one warning text per file that cannot be read.
 */
function readMainCompaction(cwd: string): {
  compaction: CompactionSettings | undefined;
  errors: string[];
} {
  const manager = SettingsManager.create(cwd, getAgentDir());
  const errors = manager
    .drainErrors()
    .map((failure) =>
      failure.path === undefined
        ? `pi-dent: ${failure.scope} settings: ${failure.error.message}`
        : `pi-dent: ${failure.path}: ${failure.error.message}`,
    );
  return { compaction: manager.getSettings().compaction, errors };
}

export interface TerminalCandidate {
  text: string;
  stopReason: string;
  errorMessage?: string | undefined;
}

interface AttemptState {
  candidate: TerminalCandidate | null;
  committedError?: string | undefined;
  usage: UsageAggregate;
  trace: TraceEvent[];
  streamText: string;
  projection: string[];
}

/** A Fleet-delivered message waiting for the child session to accept it (fleet-tool.md, Section 3.2). */
interface TurnAcceptance {
  resolve: () => void;
  reject: (error: unknown) => void;
}

export interface AttemptOutcome {
  status: SettleStatus;
  stopReason: StopReason;
  failureCode?: FailureCode | undefined;
  failurePhase?: FailurePhase | undefined;
  errorMessage?: string | undefined;
  finalText?: string | undefined;
  retry?: "ask-why" | "auto-resume" | undefined;
}

export function classifyAttempt(
  candidate: TerminalCandidate | null,
  committedError: string | undefined,
  hasSessionFile: boolean,
  abortedDuringRun: boolean,
  promptError: string | undefined,
  timedOut = false,
  timedOutWhy = "",
): AttemptOutcome {
  if (abortedDuringRun && !timedOut) {
    return {
      status: "cancelled",
      stopReason: "aborted",
      failureCode: "aborted",
      failurePhase: "execution",
    };
  }
  if (timedOut) {
    return {
      status: "failed",
      stopReason: "timeout",
      failureCode: "timeout",
      failurePhase: "execution",
      errorMessage: timedOutWhy || "liveness deadline expired",
    };
  }
  const finalText = candidate?.text ?? "";
  if (isRefusal(finalText) && hasSessionFile) {
    return {
      status: "failed",
      stopReason: "error",
      failureCode: "execution-error",
      failurePhase: "execution",
      // Section 8 item 3: the refusal text is the error text, even when the
      // candidate also carries an error message.
      errorMessage: finalText,
      finalText,
      retry: "ask-why",
    };
  }
  if (promptError !== undefined) {
    return {
      status: "failed",
      stopReason: "error",
      failureCode: "execution-error",
      failurePhase: "execution",
      errorMessage: promptError,
      finalText,
      retry: isTransient(promptError) ? "auto-resume" : undefined,
    };
  }
  if (committedError !== undefined) {
    return {
      status: "failed",
      stopReason: "error",
      failureCode: "execution-error",
      failurePhase: "execution",
      errorMessage: committedError,
      finalText,
      retry: isTransient(committedError) ? "auto-resume" : undefined,
    };
  }
  if (candidate) {
    const stopReason = mapStopReason(candidate.stopReason);
    if (stopReason === "stop") {
      return { status: "completed", stopReason: "stop", finalText };
    }
    if (stopReason === "aborted") {
      return {
        status: "cancelled",
        stopReason: "aborted",
        failureCode: "aborted",
        failurePhase: "execution",
        finalText,
      };
    }
    return {
      status: "failed",
      stopReason: "error",
      failureCode: "execution-error",
      failurePhase: "execution",
      finalText,
    };
  }
  return {
    status: "failed",
    stopReason: "error",
    failureCode: "invalid-turn",
    failurePhase: "execution",
    errorMessage: "the run closed with no committed error and no terminal candidate",
  };
}

function mapStopReason(raw: string | undefined): StopReason {
  if (raw === "stop") return "stop";
  if (raw === "aborted") return "aborted";
  return "error";
}

function isTransient(message: string): boolean {
  if (NON_TRANSIENT_PATTERN.test(message)) return false;
  return TRANSIENT_PATTERN.test(message);
}

/**
 * The task row label of agent-tool.md Section 4.1: `<agent> — <summary>`, the summary being
 * the definition's `description` when the catalog has the agent and it carries one, else the
 * first line of `task` when that line is not empty, else the literal `task`.
 */
function rowLabel(agent: string, definition: AgentDefinition | undefined, task: string): string {
  const firstTaskLine = task.split("\n", 1)[0] ?? "";
  const summary = definition?.description ?? (firstTaskLine === "" ? "task" : firstTaskLine);
  return `${agent} — ${summary}`;
}

/**
 * What the extension instance supplies the engine beyond its boot snapshot (index.ts): the
 * dependencies its child sessions and its task registry need.
 */
export interface EngineDeps {
  /**
   * The Bash settings dependency the child sessions call through (bash-tool.md Section 3): the
   * boot window's reporter and warned set, so a settings file that cannot be read is reported
   * once per boot window per file whichever session calls `Bash` first.
   */
  bashSettings: (cwd: string) => BashSettings;
  /**
   * Reports a task notification the host did not deliver (task-registry.md Section 5) through the
   * boot window's UI. A child session's registry gets none and reports nothing.
   */
  reportNotification?: ((message: string) => void) | undefined;
  /** Boot-window warnings, shared with child engines without enabling registry reports. */
  reportWarning?: ((message: string) => void) | undefined;
  /**
   * The main session's usage tally (agent-tool.md Section 13), shared with every child and
   * query engine so each assistant message is counted once. A new tally when absent.
   */
  usageTally?: UsageTally | undefined;
  /**
   * The child's extension-shutdown deadline in milliseconds (agent-tool.md Section
   * 3.1); a test shortens it so reaching the limit costs no wall time.
   */
  extensionShutdownTimeoutMs?: number | undefined;
  /**
   * The built-in extension descriptors a child loads for the `builtin:<name>` sources of
   * its inherited extensions (agent-tool.md Section 3.1). Defaults to the SDK's
   * tool-sourcing built-ins; a test supplies its own.
   */
  builtinExtensions?: readonly InlineExtension[] | undefined;
}

export class DispatchEngine {
  readonly boot: BootSnapshot;
  readonly fleet?: FleetCoordinator | undefined;
  private readonly queryEngines = new Set<DispatchEngine>();
  private readonly hostProvider: () => HostSession | null | undefined;
  private readonly responseBus: Pick<ExtensionAPI["events"], "emit"> | undefined;
  private readonly deps: EngineDeps;
  /**
   * The Bash settings dependency of the session's children (bash-tool.md Section 3): the
   * extension instance's reader, so one warning per boot window per file appears whichever
   * session calls `Bash` first.
   */
  private readonly bashSettings: (cwd: string) => BashSettings;
  private current: TaskRegistry;

  /** The main session's billing service, shared by every child engine (billing.md Section 4). */
  readonly billing?: BillingService | undefined;

  /** The main session's usage tally, shared by every child engine (agent-tool.md Section 13). */
  readonly usageTally: UsageTally;

  constructor(
    boot: BootSnapshot,
    hostProvider: () => HostSession | null | undefined,
    fleet: FleetCoordinator | undefined,
    billing: BillingService | undefined,
    responseBus: Pick<ExtensionAPI["events"], "emit"> | undefined,
    deps: EngineDeps,
  ) {
    this.responseBus = responseBus;
    this.billing = billing;
    this.usageTally = deps.usageTally ?? new UsageTally();
    this.boot = boot;
    this.hostProvider = hostProvider;
    this.deps = { ...deps, reportWarning: deps.reportWarning ?? deps.reportNotification };
    this.bashSettings = deps.bashSettings;
    this.current = new TaskRegistry(hostProvider, undefined, deps.reportNotification);
    this.fleet = fleet;
  }

  /** The session's current task registry. */
  get registry(): TaskRegistry {
    return this.current;
  }

  /** Replace the registry with a new, empty, live one (task-registry.md Section 4). */
  resetRegistry(): void {
    if (this.current.live) this.current.end();
    this.current = new TaskRegistry(this.hostProvider, undefined, this.deps.reportNotification);
  }

  /** Cancel all owned tasks and any in-flight Fleet query child sessions. */
  cancelAll(): void {
    this.registry.cancelAll();
    for (const qEngine of this.queryEngines) {
      qEngine.registry.end();
    }
    this.queryEngines.clear();
  }

  /**
   * Run a Fleet `query` in an isolated child session owned by this session,
   * with local completion notification suppressed and isolated from the
   * session's public Task list (specs/fleet-tool.md Section 4).
   */
  async runIsolatedQuery(
    host: HostSession,
    query: {
      correlationId: string;
      senderSessionId: string;
      subject?: string | undefined;
      body: string;
    },
  ): Promise<{ text: string; isError: boolean }> {
    const queryEngine = new DispatchEngine(
      this.boot,
      () => null,
      this.fleet,
      this.billing,
      this.responseBus,
      // A query's registry sends no notification (task-registry.md Section 5); its Bash reads the
      // boot window's settings.
      {
        bashSettings: this.bashSettings,
        reportWarning: this.deps.reportWarning,
        builtinExtensions: this.deps.builtinExtensions,
        // A query counts in the main session's tally, like the dispatch it is (Section 13).
        usageTally: this.usageTally,
      },
    );
    this.queryEngines.add(queryEngine);
    const queryHost: HostSession = {
      ...host,
      activeTools: () => {
        const tools = host.activeTools();
        return tools.includes("Agent") ? tools : [...tools, "Agent"];
      },
      notify: () => {},
    };
    try {
      const result = await queryEngine.dispatch({
        toolCallId: `query-${query.correlationId}`,
        params: {
          prompt:
            "You are answering a Fleet query from a sibling session in an isolated child session. Inspect the workspace and answer concisely.",
          task: query.body,
          background: false,
        },
        host: queryHost,
        cohortId: `query-${query.correlationId}`,
        planToolCap: queryToolCap(host.activeTools()),
        fleetQuery: true,
      });
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      return { text, isError: result.isError === true };
    } finally {
      queryEngine.registry.end();
      this.queryEngines.delete(queryEngine);
    }
  }

  /** One Agent invocation: validation, plan freeze, registration, delivery. */
  async dispatch(call: DispatchCall): Promise<ToolResult> {
    const { host } = call;
    // Reassignable so a `resume` task ID can be replaced by its session path (Section 9).
    let params = call.params;
    // The registry registered into, kept even if the session's registry is replaced.
    const registry = this.registry;
    const agentIdentity = params.agent ?? "dynamic";
    const definition = params.agent ? this.boot.agentIndex.get(params.agent) : undefined;
    // One row per invocation, registered before execution begins (Section 4.1);
    // registration into a registry that is not live fails the invocation
    // (task-registry.md Section 1).
    let row: AgentTaskRow;
    try {
      row = registry.register({
        kind: "agent",
        cohort: call.cohortId,
        label: rowLabel(agentIdentity, definition, params.task),
        background: params.background === true,
        task: params.task,
      });
    } catch (error) {
      return {
        content: [{ type: "text", text: `Agent error: ${errorMessage(error)}` }],
        details: {},
        isError: true,
      };
    }

    const rejection = (message: string, code: FailureCode = "invalid-plan"): ToolResult => {
      // Pre-start rejection rows suppress the completion notification.
      registry.consume(row);
      const record: AttemptRecord = {
        agent: agentIdentity,
        status: "failed",
        stopReason: "error",
        failureCode: code,
        failurePhase: "plan-resolution",
        usage: emptyUsage(),
        trace: [],
      };
      registry.settle(row, {
        status: "failed",
        result: `Agent error: ${message}`,
      });
      return {
        content: [{ type: "text", text: `Agent error: ${message}` }],
        details: { taskId: row.taskId, agent: agentIdentity, results: [record] },
        isError: true,
      };
    };

    // A `resume` task ID resolves to the session file of that agent row; every
    // settled `agent` row naming that file, the resolved one included, is
    // consumed, so the two forms consume alike (Section 9). Rows are consumed
    // only once the dispatch passes its pre-start checks, so a rejection
    // consumes none.
    const consumeResumed: AgentTaskRow[] = [];
    let resumeSource: string | undefined;
    if (typeof params.resume === "string" && /^[0-9a-f]{8}$/.test(params.resume)) {
      const resumed = registry.get(params.resume);
      if (!(resumed instanceof AgentTaskRow) || resumed.sessionPath === undefined) {
        return rejection(
          `resume must name an agent task with a session file; received ${JSON.stringify(params.resume)}`,
        );
      }
      resumeSource = resumed.sessionPath;
      // The resolved row is consumed even when it already is: a consumed row's
      // record outlives the completion notification and is deleted here.
      if (resumed.status !== "running") consumeResumed.push(resumed);
      // A running row is left unchanged, so the in-flight check still applies.
      params = { ...params, resume: resumeSource };
    } else if (typeof params.resume === "string") {
      resumeSource = params.resume;
    }
    if (resumeSource !== undefined) {
      // Real paths are compared, so a symbolic link or a `..` segment does not
      // hide the row a continuation by another name would leave behind.
      const sourcePath = realPath(resumeSource);
      for (const candidate of registry.list()) {
        if (
          candidate instanceof AgentTaskRow &&
          candidate.status !== "running" &&
          !candidate.consumed &&
          candidate.sessionPath !== undefined &&
          realPath(candidate.sessionPath) === sourcePath &&
          !consumeResumed.includes(candidate)
        ) {
          consumeResumed.push(candidate);
        }
      }
    }

    const validation = this.validateParams(params, host);
    if ("error" in validation) return rejection(validation.error);

    // A dispatch with no live main session has no tool cap and fails the
    // plan the same way as a tool cap without Agent (Section 3.1).
    if (!host) {
      return rejection(
        "no live main session for the dispatch: there is no tool cap, so Agent authority cannot be established",
        "missing-tool-authority",
      );
    }

    let plan: DispatchPlan;
    try {
      plan = this.resolvePlan(params, host, call.planToolCap, validation.cwd);
    } catch (error) {
      if (error instanceof ModelStringError) return rejection(error.message, error.code);
      if (error instanceof PlanError) return rejection(error.message, error.code);
      // Unexpected engine bugs still reject the launch, as invalid-plan.
      return rejection(errorMessage(error), "invalid-plan");
    }

    plan.skills = Object.freeze([...plan.skills]);
    plan.tools = Object.freeze([...plan.tools]);
    Object.freeze(plan);

    let snapshot: ExecutionSnapshot;
    try {
      const sessionId = host.sessionId();
      const sessionFile = host.sessionFile();
      const compaction = host.compaction();
      const agentsDir = agentsDirFor(sessionFile, sessionId);
      // The extension sources the child loads are frozen with the snapshot, before
      // any asynchronous dispatch starts (Section 3.1). A Fleet query child loads none
      // and does not read the inventory (Section 3.1, fleet-tool.md Section 4).
      const extensions =
        call.fleetQuery === true ? { sources: [], tools: [] } : inheritedExtensions(host);
      mkdirSync(agentsDir, { recursive: true });
      snapshot = { sessionId, sessionFile, agentsDir, compaction, extensions };
    } catch (error) {
      return rejection(`snapshot failed: ${errorMessage(error)}`, "invalid-plan");
    }

    // The child's agent directory (Sections 4.1 and 4.2) is a pre-start step,
    // the dispatch's only creation of it: it is created here, before any row is
    // consumed and before a background call reports startup, so a failure rejects
    // the dispatch as pre-start.
    const childSessionPath =
      plan.sessionPolicy.kind === "persistent"
        ? join(snapshot.agentsDir, `${safeName(plan.agent)}-${row.taskId}.jsonl`)
        : plan.sessionPolicy.resume;
    try {
      mkdirSync(agentsDirFor(childSessionPath, row.taskId), { recursive: true });
    } catch (error) {
      return rejection(`agent directory failed: ${errorMessage(error)}`, "invalid-plan");
    }

    // Consuming a settled resumed row deletes its record; a rejected resume keeps it.
    for (const resumed of consumeResumed) registry.consume(resumed);

    // Every pre-start check passed, so this dispatch counts in the usage tally
    // (agent-tool.md Section 13); a recovery attempt of it does not count again.
    this.usageTally.countTask();

    registry.amend(row, {
      label: rowLabel(plan.agent, definition, plan.task),
      agent: plan.agent,
      model: plan.modelLabel,
    });

    if (params.background === true) {
      void this.runDispatch(registry, row, plan, host, snapshot, {
        fleetQuery: call.fleetQuery,
      }).catch((error) =>
        this.settleExecutionFailure(registry, row, plan, errorMessage(error), snapshot.agentsDir),
      );
      // The child session file path is known before the child opens it, so it
      // matches what runDispatch opens (Section 6).
      const sessionPath = childSessionPath;
      return {
        content: [
          {
            type: "text",
            text: `Agent ${plan.agent} started in background (taskId ${row.taskId}).\nSession: ${sessionPath}`,
          },
        ],
        details: {
          background: true,
          taskId: row.taskId,
          agent: plan.agent,
          sessionPath,
        },
      };
    }

    try {
      return await this.runDispatch(registry, row, plan, host, snapshot, {
        signal: call.signal,
        onUpdate: call.onUpdate,
        fleetQuery: call.fleetQuery,
      });
    } catch (error) {
      // Every settled dispatch returns the formatted Section 7 result.
      return this.settleExecutionFailure(
        registry,
        row,
        plan,
        errorMessage(error),
        snapshot.agentsDir,
      );
    }
  }

  /**
   * Parameter validation ([agent-tool.md](../specs/agent-tool.md), Section 1.1),
   * ending with the `cwd` check of [task.md](../specs/task.md), Section 1.1. The
   * resolved `cwd` is returned so the plan carries it without resolving twice.
   * The check needs a live session to resolve a relative path; a dispatch with
   * no live session is rejected before its plan is resolved.
   */
  private validateParams(
    params: AgentToolParams,
    host: HostSession | undefined,
  ): { error: string } | { cwd: string | undefined } {
    const error = this.validateParamValues(params);
    if (error !== undefined) return { error };
    if (host === undefined) return { cwd: undefined };
    return resolveCwdParam(params.cwd, host.cwd());
  }

  private validateParamValues(params: AgentToolParams): string | undefined {
    const hasAgent = params.agent !== undefined;
    const hasPrompt = params.prompt !== undefined;
    if (hasAgent === hasPrompt) return "exactly one of agent or prompt must be provided";
    if (params.agent !== undefined && !this.boot.agentIndex.has(params.agent)) {
      const available = this.boot.agents.map((agent) => agent.name);
      return `unknown agent "${params.agent}". Available agents: ${
        available.length > 0 ? available.join(", ") : "(none)"
      }`;
    }
    if (params.resume !== undefined) {
      if (!isAbsolute(params.resume)) {
        return `resume must be an absolute path; received ${JSON.stringify(params.resume)}`;
      }
      // One `stat` decides both checks: a path that cannot be examined is the
      // not-found rejection, so no failure escapes a dispatch that already
      // registered its row (Section 4.1).
      const source = statOrUndefined(params.resume);
      if (source === undefined) {
        return `resume source not found: ${params.resume}. The retention sweep may have deleted it (PI_DENT_SESSION_TTL_DAYS=${this.boot.sessionTtlDays}).`;
      }
      if (!source.isFile()) {
        return `resume source is not a regular file: ${params.resume}`;
      }
      // Real paths are compared at check time: a held file may not have existed when claimed.
      const resumeReal = realPath(params.resume);
      if ([...inFlightSessions].some((held) => realPath(held) === resumeReal)) {
        return `session already has an in-flight dispatch: ${resolve(params.resume)}`;
      }
    }
    return undefined;
  }

  private resolvePlan(
    params: AgentToolParams,
    host: HostSession,
    planToolCap: string[] | undefined,
    resolvedCwd: string | undefined,
  ): DispatchPlan {
    // Tool authority: the main session's live active tool set.
    if (!host.activeTools().includes("Agent")) {
      throw planError(
        "missing-tool-authority",
        "the main session's tool cap does not include Agent; dispatch is not authorized",
      );
    }

    // A restricted plan tool cap (Fleet `query` child) narrows only the tools
    // the child binds; the authority check above still comes from the host cap
    // (fleet-tool.md Section 4). A restricted child carries no skills.
    const tools = planToolCap ?? host.activeTools();

    const definition = params.agent ? this.boot.agentIndex.get(params.agent) : undefined;
    const prompt = definition?.prompt ?? params.prompt;
    if (prompt === undefined) {
      // Unreachable after validateParams; guarded so no cast is needed.
      throw planError("invalid-plan", "exactly one of agent or prompt must be provided");
    }

    let cwd = resolvedCwd;

    let sessionPolicy: DispatchPlan["sessionPolicy"];
    let persisted: PersistedSession | undefined;
    if (params.resume === undefined) {
      sessionPolicy = { kind: "persistent" };
    } else {
      const resumePath = resolve(params.resume);
      persisted = readPersistedSession(resumePath);
      sessionPolicy = {
        kind: "resume",
        resume: resumePath,
        cwdOverride: cwd,
        persistedModel: persisted?.model,
        persistedThinking: persisted?.thinking,
      };
    }
    if (cwd === undefined) {
      cwd = sessionPolicy.kind === "resume" ? (persisted?.cwd ?? host.cwd()) : host.cwd();
    }

    // Model precedence: call > agent model (static only) > persisted (resume source) > main session.
    // The inventory is the registered model list (possibly empty); exact matching always applies.
    const inventory = host.inventory() ?? [];
    const resolveCtx = resolveContextFromConfig(this.boot.config, inventory);
    let selected:
      | {
          descriptor: Descriptor;
          model: Model<Api>;
          thinking?: ThinkingLevel | undefined;
          source: "call" | "agent" | "persisted" | "inherited";
        }
      | undefined;

    if (params.model !== undefined) {
      // A call model that fails to resolve fails the plan; it never falls through.
      const resolved = resolveModelString(params.model, resolveCtx);
      selected = {
        descriptor: resolved.descriptor,
        model: resolved.model,
        thinking: resolved.descriptor.thinking,
        source: "call",
      };
    }
    if (!selected && definition?.model !== undefined) {
      const resolved = resolveModelString(definition.model, resolveCtx);
      selected = {
        descriptor: resolved.descriptor,
        model: resolved.model,
        thinking: resolved.descriptor.thinking,
        source: "agent",
      };
    }
    if (!selected && sessionPolicy.kind === "resume" && persisted?.model) {
      // Section 3.3: a level taken from the persisted thinking is not checked,
      // so the persisted tier resolves from the bare persisted model below;
      // the persisted level is applied by the thinking-precedence branch.
      const raw = serializeDescriptor({
        provider: persisted.model.provider,
        id: persisted.model.id,
      });
      const resolved = resolveModelString(raw, resolveCtx);
      selected = {
        descriptor: resolved.descriptor,
        model: resolved.model,
        thinking: resolved.descriptor.thinking,
        source: "persisted",
      };
    }
    if (!selected) {
      const mainModel = host.model();
      if (!mainModel) {
        throw planError(
          "missing-model",
          "no model available: the agent definition, the resumed session, and the main session supply no model",
        );
      }
      const model = inventory.find(
        (candidate) => candidate.provider === mainModel.provider && candidate.id === mainModel.id,
      );
      if (model === undefined) {
        throw planError(
          "missing-model",
          `main session model "${mainModel.provider}/${mainModel.id}" is not in the model inventory`,
        );
      }
      selected = {
        descriptor: { provider: mainModel.provider, id: mainModel.id },
        model,
        source: "inherited",
      };
    }

    // Thinking precedence: selected tier > persisted (same model) > main (same model) > absent.
    let thinking = selected.thinking;
    if (
      thinking === undefined &&
      persisted?.model &&
      persisted.thinking !== undefined &&
      persisted.model.provider === selected.descriptor.provider &&
      persisted.model.id === selected.descriptor.id
    ) {
      thinking = persisted.thinking;
    }
    if (thinking === undefined) {
      const mainThinking = host.thinking();
      const mainModel = host.model();
      if (
        mainThinking !== undefined &&
        mainModel &&
        mainModel.provider === selected.descriptor.provider &&
        mainModel.id === selected.descriptor.id
      ) {
        thinking = mainThinking;
      }
    }

    const previousModel =
      sessionPolicy.kind === "resume" &&
      persisted?.model &&
      (selected.descriptor.provider !== persisted.model.provider ||
        selected.descriptor.id !== persisted.model.id)
        ? `${persisted.model.provider}/${persisted.model.id}`
        : undefined;
    // The canonical model label carries the final thinking level (Section 5 serialization).
    const finalDescriptor: Descriptor = {
      provider: selected.descriptor.provider,
      id: selected.descriptor.id,
      thinking,
    };

    // The inherited tier is the dispatching session's own model and is never unguided (model-guidance.md Section 3).
    const { guidance } = parsedModelGuidance(this.boot.config);
    const guided = guidedModels(guidance, inventory);
    if (
      selected.source !== "inherited" &&
      guidanceActive(guidance, inventory) &&
      !isGuidedDispatch(guided, selected.descriptor.provider, selected.descriptor.id, thinking)
    ) {
      const attempted = serializeDescriptor(finalDescriptor);
      const guidedList = guided.map((g) => g.model).join(", ");
      throw planError(
        "unguided-model",
        `model "${attempted}" is not a guided model; guided models: ${guidedList}`,
      );
    }

    return {
      agent: definition ? definition.name : "dynamic",
      prompt,
      cwd,
      tools,
      // Skills follow the tool cap: no `Skill` in the cap, no skills (Section 3.2).
      skills: tools.includes("Skill") ? this.boot.skills : [],
      model: selected.model,
      modelLabel: serializeDescriptor(finalDescriptor),
      thinking,
      modelSource: selected.source,
      previousModel,
      sessionPolicy,
      task: params.task,
      descriptor: finalDescriptor,
    };
  }

  /** Settle a row after an engine-level failure outside the attempt loop. */
  private settleExecutionFailure(
    registry: TaskRegistry,
    row: AgentTaskRow,
    plan: DispatchPlan,
    message: string,
    agentsDir?: string,
  ): ToolResult {
    // The row object is held by the dispatch, so adoption into another registry
    // cannot hide it from settlement (task-registry.md Section 4).
    if (row.status !== "running") {
      const text = `Agent error: ${message}`;
      return {
        content: [{ type: "text", text }],
        details: { taskId: row.taskId, agent: plan.agent },
        isError: true,
      };
    }
    return this.failureResult(
      registry,
      row,
      plan,
      "execution-error",
      "execution",
      message,
      agentsDir,
    );
  }

  /**
   * Run one dispatch to settlement: child session creation, the attempt loop
   * with bounded caller-owned recovery, liveness deadlines, cooperative
   * cancellation, result formatting, and the result spill.
   */
  private async runDispatch(
    registry: TaskRegistry,
    registryRow: AgentTaskRow,
    plan: DispatchPlan,
    host: HostSession,
    snapshot: ExecutionSnapshot,
    opts: {
      signal?: AbortSignal | undefined;
      onUpdate?: UpdateCallback | undefined;
      /**
       * The dispatch is a Fleet `query` child: its attempt never waits for running rows
       * and it registers no child session record (agent-tool.md Section 4.2).
       */
      fleetQuery?: boolean | undefined;
    } = {},
  ): Promise<ToolResult> {
    const agentsDir = snapshot.agentsDir;
    const resumeKey = plan.sessionPolicy.kind === "resume" ? plan.sessionPolicy.resume : undefined;
    const claimedSessions: string[] = [];
    // A running dispatch holds its session file, so a concurrent resume is rejected (Section 9).
    const claimSessionFile = (path: string | undefined) => {
      if (!path) return;
      const key = resolve(path);
      inFlightSessions.add(key);
      claimedSessions.push(key);
    };
    claimSessionFile(resumeKey);

    const controller = new AbortController();
    let abortRequested = false;
    let cancelCause: "requested" | "registry-end" | undefined;
    let timedOut = false;
    let timedOutWhy = "";
    const sessionBox: { current?: AgentSession | undefined } = {};
    let session: AgentSession | undefined;
    let fleetChildId: string | undefined;
    /** Whether the store holds this child's record: only then may its turns be recorded. */
    let childRegistered = false;
    // The dispatching session's warning channel: its UI where it has one, a displayed
    // message where it is a child, and never a triggered model turn (Section 3.1).
    const warningChannel = host.warn ?? host.notify;
    const emitWarning = (channel: (text: string) => void, text: string): void => {
      try {
        channel(text);
      } catch (error) {
        process.stderr.write(`${text} (warning failed: ${errorMessage(error)})\n`);
      }
    };
    const notifyWarning = (message: string): void => {
      emitWarning(warningChannel, `pi-dent: ${message}`);
    };
    // A Fleet child warning (Section 4.2): the boot window's reporter where it has one,
    // else the dispatching session's warning channel.
    const warnFleet = (message: string): void => {
      emitWarning(this.deps.reportWarning ?? warningChannel, `pi-dent: ${message}`);
    };
    let childEngine: DispatchEngine | undefined;
    let unsubscribe: (() => void) | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let absoluteTimer: NodeJS.Timeout | undefined;
    // The attempt's Search runtime: its continuation of catch-up ends with the attempt
    // (search-tool.md Section 2.2; a child's boot window is its attempt).
    const searchRuntimeForChild = searchRuntime({ zone: readLocalZone() });

    registryRow.cancel = () => {
      // Why the attempt is being cancelled decides the record rule (task-record.md
      // Section 2): only a cancellation the registry's own end asked for keeps the
      // record `running`. The first request names the cause; a later one does not
      // take it over.
      if (cancelCause === undefined) {
        cancelCause = registry.holderLive(registryRow) ? "requested" : "registry-end";
      }
      controller.abort();
    };
    // Wakes the wait for running rows; `waiting` suspends the idle deadline meanwhile.
    let wake: (() => void) | undefined;
    const poke = () => wake?.();
    let waiting = false;
    /** Notifications sent into the child and not yet in a turn, by token (per attempt). */
    const pending = new Map<number, string>();
    /**
     * Fleet-delivered turns of the child that are starting or running: each
     * settles at that turn's end. A dispatch MUST NOT settle, and a recovery
     * attempt MUST NOT prompt, while one is in flight (Section 4.2).
     */
    const fleetTurns = new Set<Promise<void>>();
    /**
     * Delivered turns the child has not accepted yet: each settles at the child's next
     * turn start, or rejects with the early error of its send (fleet-tool.md, Section
     * 3.2). Kept apart from `fleetTurns`, which the dispatch waits for.
     */
    const accepting = new Set<TurnAcceptance>();
    /** Stops the idle deadline while the attempt waits (Section 4.2). */
    const suspendIdle = (): void => {
      waiting = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    // The abort listener is attached before the outer signal is inspected and is
    // never reset, so a cancellation requested during startup is honoured (Section 11).
    controller.signal.addEventListener("abort", () => {
      abortRequested = true;
      poke();
      const child = sessionBox.current;
      if (child) void child.abort();
    });
    const onOuterAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    }

    // The attempt's child-session task registry ends with the attempt
    // (task-registry.md Sections 4 and 6): no further registration, and every
    // still-running nested row is adopted into this registry or cancelled.
    const endAttemptRegistry = () => {
      childEngine?.registry.end();
    };

    const liveness = this.boot.config.liveness;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (waiting || liveness.idleTimeoutMs <= 0) return;
      idleTimer = setTimeout(() => {
        timedOut = true;
        timedOutWhy = `idle timeout after ${liveness.idleTimeoutMs}ms`;
        controller.abort();
      }, liveness.idleTimeoutMs);
      idleTimer.unref?.();
    };

    const state: AttemptState = {
      candidate: null,
      usage: emptyUsage(),
      trace: [],
      streamText: "",
      projection: [],
    };
    const sendUpdate = () => {
      if (!opts.onUpdate) return;
      const proj = state.projection.join("\n");
      let text = proj;
      if (state.streamText !== "") {
        text = proj === "" ? state.streamText : `${proj}\n${state.streamText}`;
      }
      opts.onUpdate({
        content: [{ type: "text", text }],
        details: { taskId: registryRow.taskId, agent: plan.agent, streaming: true },
      });
    };
    const pushProgress = (line: string) => {
      registry.progress(registryRow, line);
      state.projection.push(line);
      if (state.projection.length > 10) state.projection.shift();
      sendUpdate();
    };
    const flushIntermediate = (text: string) => {
      if (text !== "") pushProgress(firstLine(text));
    };
    const supersede = () => {
      if (state.candidate) {
        flushIntermediate(state.candidate.text);
        state.candidate = null;
      }
    };
    const childCohorts = new CohortTracker();
    const records: AttemptRecord[] = [];
    let sessionPath: string | undefined;

    try {
      // Startup: a live model runtime is required before any child starts.
      let runtime: ModelRuntime;
      try {
        runtime = await sharedModelRuntime();
      } catch (error) {
        return this.failureResult(
          registry,
          registryRow,
          plan,
          "missing-runtime",
          "startup",
          `no live model runtime: ${errorMessage(error)}`,
          agentsDir,
        );
      }

      const manager =
        plan.sessionPolicy.kind === "persistent"
          ? SessionManager.open(
              join(agentsDir, `${safeName(plan.agent)}-${registryRow.taskId}.jsonl`),
              agentsDir,
              plan.cwd,
            )
          : SessionManager.open(
              plan.sessionPolicy.resume,
              undefined,
              plan.sessionPolicy.cwdOverride,
            );
      sessionPath = manager.getSessionFile();
      claimSessionFile(sessionPath);

      // A continuation records the model and thinking it runs with, so a later
      // `resume` without them continues what the session last ran with (Section 9).
      // Once per dispatch: a recovery attempt continues this same file.
      if (plan.sessionPolicy.kind === "resume") {
        const persistedModel = plan.sessionPolicy.persistedModel;
        const sameModel =
          persistedModel !== undefined &&
          persistedModel.provider === plan.model.provider &&
          persistedModel.id === plan.model.id;
        if (!sameModel) manager.appendModelChange(plan.model.provider, plan.model.id);
        const persistedThinking = plan.sessionPolicy.persistedThinking;
        if (plan.thinking !== undefined) {
          if (plan.thinking !== persistedThinking) manager.appendThinkingLevelChange(plan.thinking);
        } else if (persistedThinking !== undefined && persistedThinking !== "off") {
          manager.appendThinkingLevelChange("off");
        }
      }

      // The child's own agent directory (Section 4.2), exposed to its tools as
      // PI_DENT_SESSION_DIR; a resumed session maps to the same directory. It was
      // created before delivery, so a creation failure is a pre-start rejection.
      const childDir = agentsDirFor(sessionPath, manager.getSessionId());

      // The task record (task-record.md Section 2): written once per task, for a
      // background task, once its child session file path is fixed and before
      // the first prompt. The host creates the file itself at the first message,
      // so only the path is known here. A record failure MUST NOT fail the
      // dispatch.
      if (
        sessionPath !== undefined &&
        registryRow.background &&
        registryRow instanceof AgentTaskRow &&
        !registryRow.recordPath
      ) {
        try {
          registryRow.recordPath = writeRunningRecord(agentsDir, {
            taskId: registryRow.taskId,
            agent: plan.agent,
            label: registryRow.label,
            model: plan.modelLabel,
            cohort: registryRow.cohort,
            startedAt: registryRow.startedAt,
            sessionPath,
          });
        } catch {
          // A record failure MUST NOT fail the dispatch.
        }
      }

      const settingsManager = SettingsManager.create(plan.cwd, getAgentDir());
      const childGuidanceText = await dispatchChildGuidance(
        this.billing,
        this.boot.config,
        plan.tools,
        host.configuredModels() ?? [],
      );
      // The child's Agent description, computed once with the child session (agent-tool.md Section 1).
      const childModelCatalog = modelCatalog(
        parsedModelGuidance(this.boot.config).guidance,
        host.configuredModels() ?? [],
      );
      const systemPrompt = buildChildSystemPrompt(
        plan.agent === "dynamic"
          ? `${plan.prompt}\n\n${sessionNotes(childDir, plan.tools)}`
          : plan.prompt,
        plan.skills,
        plan.model,
        this.boot.config,
        childGuidanceText,
        this.boot.plugins,
      );
      const loader = new DefaultResourceLoader({
        cwd: plan.cwd,
        agentDir: getAgentDir(),
        settingsManager,
        noExtensions: true,
        // The inherited sources, in the parent inventory's order (Section 3.1): file
        // paths first, then `builtin:<name>` paths, each enabled explicitly. The
        // child discovers no extensions from its own settings or working directory.
        additionalExtensionPaths: [...snapshot.extensions.sources],
        extensionFactories: [
          // The built-in extensions supply the code of the `builtin:<name>` sources.
          ...(this.deps.builtinExtensions ?? defaultBuiltinExtensions()),
          // The read hint searches the child's own agent directory (Section 6).
          (pi) => registerReadErrorHint(pi, () => childDir),
          (pi) => {
            pi.on("after_provider_response", (event, ctx) => {
              const headers: Record<string, string> = {};
              for (const [name, value] of Object.entries(event.headers)) {
                headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
              }
              try {
                this.responseBus?.emit("purse:observe:v1", {
                  protocol: 1,
                  provider: ctx.model?.provider ?? plan.model.provider,
                  headers,
                });
              } catch {
                // Observation cannot fail a dispatch.
              }
            });
          },
        ],
        noSkills: true,
        // An inherited extension may discover resources; the child's skill catalog is
        // the plan's, so what the SDK would load is dropped (Sections 3.1 and 3.2).
        skillsOverride: () => ({ skills: [], diagnostics: [] }),
        promptsOverride: () => ({ prompts: [], diagnostics: [] }),
        themesOverride: () => ({ themes: [], diagnostics: [] }),
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt,
      });
      await loader.reload();
      const loaded = loader.getExtensions();
      const loadOutcome = inheritedLoadOutcome(snapshot.extensions.sources, loaded);
      // An inherited source that fails to load, a source the loader drops without an
      // error, a conflict between loaded sources, and a failing inline factory are each
      // named to the dispatching session; its tools are unavailable and the remaining
      // sources still load (Section 3.1).
      for (const failure of loadOutcome.failures) {
        notifyWarning(`extension ${failure.path} failed to load: ${failure.error}`);
      }
      for (const conflict of loadOutcome.conflicts) {
        notifyWarning(`extension ${conflict.path} reported a conflict: ${conflict.error}`);
      }
      for (const failure of loadOutcome.others) {
        notifyWarning(`extension ${failure.path} failed: ${failure.error}`);
      }
      for (const source of loadOutcome.omitted) {
        notifyWarning(`extension ${source} was not loaded`);
      }

      const childHost = hostFromSessionBox(sessionBox, {
        sent: (token, message) => {
          pending.set(token, message);
        },
        failed: (token) => {
          pending.delete(token);
          poke();
        },
      });
      // Each attempt below creates its own child DispatchEngine; the child
      // tools dereference it dynamically so nested Agent/Script/Task calls
      // always register into the CURRENT attempt's registry (Section 6).
      const childEngineOrThrow = (): DispatchEngine => {
        if (!childEngine) throw new Error("child engine not initialized");
        return childEngine;
      };
      const childTools: ToolDefinition[] = [
        makeBashTool({
          registry: () => childEngineOrThrow().registry,
          hostProvider: () => childHost,
          cohortFor: (toolCallId) => childCohorts.cohortFor(toolCallId),
          agentDir: () => childDir,
          extraEnv: () => ({ PI_DENT_SESSION_DIR: childDir }),
          settings: this.bashSettings,
        }),
        makeAgentTool({
          boot: this.boot,
          modelCatalog: childModelCatalog,
          dispatch: (call) => childEngineOrThrow().dispatch(call),
          hostProvider: () => childHost,
          cohortFor: (toolCallId) => childCohorts.cohortFor(toolCallId),
        }),
        makeTaskTool({ registry: () => childEngineOrThrow().registry }),
        makePluginTool(this.boot),
        makeSessionTool({ boot: this.boot, hostProvider: () => childHost, billing: this.billing }),
        makeScriptTool({
          boot: this.boot,
          registry: () => childEngineOrThrow().registry,
          hostProvider: () => childHost,
          cohortFor: (toolCallId) => childCohorts.cohortFor(toolCallId),
          agentDir: () => childDir,
          extraEnv: () => ({ PI_DENT_SESSION_DIR: childDir }),
          toolsAllow: () => parseScript(this.boot.config).toolsAllow ?? DEFAULT_TOOLS_ALLOW,
        }),
        // A child session binds `Search` when the tool cap includes it
        // (agent-tool.md Section 3.1); its own session file is the invoking one.
        makeSearchTool({
          runtime: searchRuntimeForChild,
          host: () => ({
            sessionFile: childHost.sessionFile(),
            agentDirectory: childDir,
            main: false,
          }),
        }),
        // A child session binds `Markdown` when the tool cap includes it
        // (agent-tool.md Section 3.1, pi-dent-markdown specs/markdown-tool.md Section 1).
        makeMarkdownTool(markdownRuntime()),
      ];
      if (this.fleet)
        childTools.push(makeFleetTool({ fleet: this.fleet, hostProvider: () => childHost }));
      if (plan.skills.length > 0) childTools.push(makeSkillTool(this.boot));

      // The child binds exactly the names of the effective tool cap (Section 3.1);
      // the allowlist also gates customTools in the SDK.
      const cap = effectiveToolCap(
        plan.tools,
        childTools,
        availableInheritedTools(snapshot.extensions, loadOutcome.unavailable),
      );
      // The SDK keeps an MCP tool callable without the allowlist naming it, so the
      // ones outside the cap are excluded explicitly: every resource tool, and every
      // proxy when the cap names none (Section 3.1).
      const excludedToolNames = MCP_RESOURCE_TOOL_NAMES.filter((name) => !cap.includes(name));
      if (!cap.some((name) => name.startsWith("mcp__"))) excludedToolNames.push("mcp__*");
      const sessionOptions: CreateAgentSessionOptions = {
        cwd: plan.cwd,
        modelRuntime: runtime,
        model: plan.model,
        ...(plan.thinking === undefined ? {} : { thinkingLevel: plan.thinking }),
        tools: cap,
        excludeTools: excludedToolNames,
        customTools: childTools,
        resourceLoader: loader,
        sessionManager: manager,
        settingsManager,
      };
      // The child's compaction is the dispatching session's, completed from the
      // defaults; the child's own working directory contributes none of it
      // (Section 3.4). Applied after the loader's reload, which re-reads the settings
      // files and would drop the override.
      settingsManager.applyOverrides({ compaction: childCompaction(snapshot.compaction) });
      const created = await createAgentSession(sessionOptions);
      session = created.session;
      sessionBox.current = session;
      // The inherited extensions get the session start the parent's host gives them, so
      // one that registers its tools then (an MCP proxy) declares them before the first
      // prompt (Section 3.1). A lifecycle error is named to the dispatching session.
      await session.bindExtensions({
        onError: (event) => {
          notifyWarning(
            `extension ${event.extensionPath} failed in ${event.event}: ${event.error}`,
          );
        },
      });
      // A tool of the cap that no child extension registered is named to the dispatching
      // session; one an extension registers later is allowed (Section 3.1).
      const boundTools = new Set(session.getActiveToolNames());
      for (const name of cap) {
        if (!boundTools.has(name))
          notifyWarning(`tool ${name} of the effective tool cap is not registered`);
      }
      if (this.fleet && !opts.fleetQuery) {
        const currentChild = (): AgentSession => {
          const current = sessionBox.current;
          if (!current) throw new Error("no live child session for Fleet delivery");
          return current;
        };
        fleetChildId = session.sessionId;
        try {
          const registration = this.fleet.registerChild(
            host.sessionId(),
            {
              sessionId: session.sessionId,
              agentsDir: childDir,
              cwd: () => childHost.cwd(),
              // A Fleet-delivered turn is starting or running: the dispatch does
              // not settle meanwhile, so the child is busy (Section 4.2).
              isIdle: () => fleetTurns.size === 0 && currentChild().isIdle,
              abortTurn: () => {
                void currentChild()
                  .abort()
                  .catch((error: unknown) => {
                    warnFleet(`Fleet child abort failed: ${errorMessage(error)}`);
                  });
              },
              // Resolves when the child takes the message for a turn — at its turn
              // start, or at once for a steer into the streaming turn — and rejects on
              // an early error, which leaves the message undelivered (Section 4.2).
              // The turn's end is tracked apart, because the dispatch waits for the
              // turn, not for the message's outcome (fleet-tool.md, Section 3.2). A
              // followUp the host defers settles before any turn starts: the child has
              // taken it, which is its acceptance (fleet-tool.md, Section 3.2).
              deliverTurn: (text, mode) => {
                const child = currentChild();
                const acceptance: TurnAcceptance = { resolve: () => {}, reject: () => {} };
                const accepted = new Promise<void>((accept, refuse) => {
                  acceptance.resolve = accept;
                  acceptance.reject = refuse;
                });
                accepting.add(acceptance);
                const settleAcceptance = (error?: unknown): void => {
                  if (!accepting.delete(acceptance)) return;
                  if (error === undefined) acceptance.resolve();
                  else acceptance.reject(error);
                };
                // Compaction keeps the session busy without streaming: a prompt sent
                // then is refused, so only a streaming turn has taken the message.
                if (mode === "steer" && child.isStreaming) settleAcceptance();
                const turn = child
                  .sendUserMessage(text, { deliverAs: mode })
                  .catch((error: unknown) => {
                    warnFleet(`Fleet child delivery failed: ${errorMessage(error)}`);
                    settleAcceptance(error);
                  })
                  .finally(() => {
                    fleetTurns.delete(turn);
                    // A followUp whose prompt the host deferred starts no turn here, so
                    // its followUp lock must not outlive the message (fleet-tool.md,
                    // Section 3.2).
                    if (mode === "followUp" && childRegistered && fleetChildId) {
                      this.fleet?.recordChildTurnStart(fleetChildId);
                    }
                    settleAcceptance();
                    poke();
                  });
                fleetTurns.add(turn);
                poke();
                return accepted;
              },
              runBuiltinCommand: (name) => {
                const current = currentChild();
                if (name !== "compact" && name !== "abort") return false;
                const operation = name === "compact" ? current.compact() : current.abort();
                void operation.catch((error: unknown) => {
                  warnFleet(`Fleet child /${name} failed: ${errorMessage(error)}`);
                });
                return true;
              },
              runQuery: (query) => this.runIsolatedQuery(childHost, query),
              // A warning of the boot window that runs the child: displayed, and never
              // a triggered model turn (Section 3.1).
              notify: (text) => emitWarning(warningChannel, text),
            },
            plan.task,
          );
          if (registration === "refused") {
            warnFleet(ownedElsewhereWarning(session.sessionId));
          } else if (registration === "own") {
            warnFleet(ownSessionWarning(session.sessionId));
          } else if (registration === "closed") {
            warnFleet(
              `Fleet child registration for session ${session.sessionId} skipped: the local session store is closed`,
            );
          } else {
            childRegistered = true;
          }
        } catch (error) {
          warnFleet(`Fleet child registration failed: ${errorMessage(error)}`);
        }
      }
      sessionPath = session.sessionFile;
      if (sessionPath) registry.amend(registryRow, { sessionPath });

      unsubscribe = session.subscribe((event) => {
        switch (event.type) {
          case "agent_start":
            if (childRegistered && fleetChildId) {
              this.fleet?.recordChildTurnStart(fleetChildId);
            }
            // The child took every message still awaiting a turn for this one.
            for (const acceptance of accepting) acceptance.resolve();
            accepting.clear();
            waiting = false;
            armIdle();
            break;
          case "agent_settled":
            if (childRegistered && fleetChildId) this.fleet?.recordTurnEnd(fleetChildId);
            poke();
            break;
          case "message_start":
            // The completion notification entered a turn.
            if (event.message.role === "custom" && event.message.customType === "pi-dent-tasks")
              pending.delete(notificationToken(event.message.details));
            if (event.message.role === "assistant") {
              state.streamText = "";
              childCohorts.onMessageStartAssistant();
            }
            armIdle();
            break;
          case "message_update": {
            if (
              event.message.role === "assistant" &&
              event.assistantMessageEvent.type === "text_delta"
            ) {
              state.streamText += event.assistantMessageEvent.delta;
              sendUpdate();
            }
            armIdle();
            break;
          }
          case "message_end": {
            const message = event.message;
            if (message.role === "assistant") {
              const text = textOfContent(message.content);
              const usage = message.usage;
              if (usage) {
                state.usage.input += usage.input;
                state.usage.output += usage.output;
                state.usage.cacheRead += usage.cacheRead;
                state.usage.cacheWrite += usage.cacheWrite;
                state.usage.cost += usage.cost.total;
                state.usage.contextTokens = Math.max(state.usage.contextTokens, usage.totalTokens);
              }
              state.usage.turns += 1;
              // Section 13: the row's usage sums every attempt's assistant messages and is
              // never reset; the tally takes the same message.
              if (registryRow.status === "running") {
                registry.amend(registryRow, {
                  usage: addMessage(registryRow.usage, message.usage),
                });
                this.usageTally.addMessage(message.usage);
              }
              // Section 4.3: the attempt's committed error comes from the
              // LAST assistant message — an earlier one the child went on
              // from (its host retried the request or compacted) commits
              // none. An empty errorMessage falls back to the model error. An
              // `aborted` turn's message reports the abort, which is no
              // execution error: the attempt settles `cancelled` instead
              // (Section 4.2).
              const messageError = message.errorMessage ?? "";
              state.committedError =
                message.stopReason === "aborted"
                  ? undefined
                  : message.stopReason === "error" || messageError !== ""
                    ? messageError === ""
                      ? `model error (stopReason ${message.stopReason})`
                      : messageError
                    : undefined;
              const eligible =
                message.stopReason === "stop" ||
                message.stopReason === "error" ||
                message.stopReason === "aborted" ||
                (message.errorMessage ?? "") !== "" ||
                !hasToolCall(message.content);
              if (eligible) {
                supersede();
                state.candidate = {
                  text,
                  stopReason: message.stopReason,
                  errorMessage: message.errorMessage,
                };
              } else {
                flushIntermediate(text);
              }
            }
            armIdle();
            break;
          }
          case "turn_start":
            supersede();
            armIdle();
            break;
          case "tool_execution_start":
            childCohorts.onToolExecutionStart(event.toolCallId, event.toolName);
            state.trace.push({
              kind: "tool_call",
              agent: plan.agent,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            });
            pushProgress(`tool_call ${event.toolName}`);
            armIdle();
            break;
          case "tool_execution_end":
            state.trace.push({
              kind: "tool_result",
              agent: plan.agent,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              isError: event.isError,
            });
            pushProgress(`tool_result ${event.toolName}`);
            supersede();
            armIdle();
            break;
          default:
            armIdle();
            break;
        }
      });

      // Attempt loop with bounded caller-owned recovery.
      const sessionFile = () => session?.sessionFile;
      let retriesLeft = this.boot.maxRecoveryRetries;
      let taskText = plan.task;
      let outcome: AttemptOutcome | undefined;

      const buildRecord = (result: AttemptOutcome): AttemptRecord => ({
        agent: plan.agent,
        status: result.status,
        stopReason: result.stopReason,
        failureCode: result.failureCode,
        failurePhase: result.failurePhase,
        model: plan.modelLabel,
        modelSource: plan.modelSource,
        previousModel: plan.previousModel,
        usage: { ...state.usage },
        sessionPath: sessionFile(),
        trace: [...state.trace],
      });

      const classify = (
        promptError: string | undefined,
        abortedDuringRun: boolean,
      ): AttemptOutcome =>
        classifyAttempt(
          state.candidate,
          state.committedError,
          Boolean(sessionFile()),
          abortedDuringRun,
          promptError,
          timedOut,
          timedOutWhy,
        );

      // Waits while the registry holds a running row, a notification awaits its turn, or a
      // Fleet-delivered turn is starting or running; a non-`stop` turn, cancellation, or
      // liveness expiry ends the attempt at once.
      const waitForTasks = async (current: AgentSession, tasks: TaskRegistry) => {
        const unwatch = tasks.subscribe(poke);
        try {
          while (!abortRequested && !timedOut) {
            // A model turn that ended in anything but `stop` ends the attempt at once,
            // even while a Fleet-delivered turn is in flight (Section 4.2).
            if (state.candidate !== null && state.candidate.stopReason !== "stop") break;
            if (fleetTurns.size > 0) {
              // The child is idle until the Fleet turn's preflight sets it running:
              // treat both windows as busy, so the attempt does not end early.
              suspendIdle();
            } else if (current.isIdle) {
              if (state.candidate?.stopReason !== "stop") break;
              if (pending.size > 0) {
                if (current.agent.hasQueuedMessages()) {
                  // Left on the SDK followUp queue after the run settled: deliver it as a new run.
                  current.agent.clearFollowUpQueue();
                  for (const [token, message] of pending) {
                    void sendNotification(current, token, message).catch(() => {
                      pending.delete(token);
                      poke();
                    });
                  }
                } else {
                  // Yield past a deferred send, then drop notifications that never arrived.
                  await new Promise((done) => setImmediate(done));
                  if (current.isIdle && !current.agent.hasQueuedMessages()) pending.clear();
                }
                continue;
              }
              if (tasks.runningCount === 0) break;
              suspendIdle();
            }
            await new Promise<void>((done) => {
              wake = done;
            });
            wake = undefined;
          }
          // Let an aborted notification turn reach the session file before disposal.
          if (!current.isIdle) {
            let grace: NodeJS.Timeout | undefined;
            await Promise.race([
              current.abort(),
              new Promise((done) => {
                grace = setTimeout(done, 2000);
              }),
            ]);
            clearTimeout(grace);
          }
        } finally {
          unwatch();
          wake = undefined;
          waiting = false;
        }
      };

      /**
       * Wait until no Fleet-delivered turn of the child is starting or running. The
       * wait suspends the idle deadline, as the wait for running rows does: a turn
       * the user is answering through Fleet is not the attempt being idle.
       */
      const waitForFleetTurns = async (): Promise<void> => {
        if (fleetTurns.size === 0) return;
        suspendIdle();
        while (fleetTurns.size > 0 && !abortRequested && !timedOut) {
          await new Promise<void>((done) => {
            wake = done;
          });
          wake = undefined;
        }
        waiting = false;
      };

      /**
       * End the Fleet turns still in flight once a non-`stop` turn has ended the attempt:
       * abort the child's run and wait for them to settle, so none starts in a session
       * that is being shut down (Section 4.2).
       */
      const endFleetTurns = async (): Promise<void> => {
        if (fleetTurns.size === 0) return;
        const child = sessionBox.current;
        if (child) {
          try {
            await child.abort();
          } catch (error) {
            warnFleet(`Fleet child abort failed: ${errorMessage(error)}`);
          }
        }
        while (fleetTurns.size > 0 && !timedOut) {
          await new Promise<void>((done) => {
            wake = done;
          });
          wake = undefined;
        }
      };

      /**
       * Start an attempt from no candidate, usage, trace or notification (Section 7). It
       * never clears a liveness expiry: `timedOut` stays the attempt's until the loop
       * settles on it.
       */
      const resetAttempt = (): void => {
        state.candidate = null;
        state.committedError = undefined;
        state.trace = [];
        state.streamText = "";
        state.usage = emptyUsage();
        pending.clear();
        waiting = false;
      };

      for (let attempt = 1; ; attempt++) {
        resetAttempt();

        // The dispatch-authority check runs on every dispatch path. It reads
        // no attempt state, but the recorded failure must not repeat any
        // previous attempt's usage or trace (Section 7), so the reset above
        // comes first.
        if (!host.activeTools().includes("Agent")) {
          outcome = {
            status: "failed",
            stopReason: "error",
            failureCode: "missing-tool-authority",
            failurePhase: "plan-resolution",
            errorMessage: "the main session's tool cap no longer includes Agent",
          };
          records.push(buildRecord(outcome));
          break;
        }

        // A cancellation requested while the dispatch was starting settles without
        // prompting an attempt (Section 11).
        if (abortRequested) {
          outcome = {
            status: "cancelled",
            stopReason: "aborted",
            failureCode: "aborted",
            failurePhase: "execution",
          };
          records.push(buildRecord(outcome));
          break;
        }

        // End the previous attempt's registry, then give this attempt its own child
        // engine and attach its registry; recovery attempts replace it (Section 6).
        endAttemptRegistry();
        childEngine = new DispatchEngine(
          this.boot,
          () => (sessionBox.current ? childHost : undefined),
          this.fleet,
          this.billing,
          this.responseBus,
          // A child's registry has no boot-window UI, so it reports no notification failure
          // (task-registry.md Section 5); its Bash calls the boot window's settings reader.
          {
            bashSettings: this.bashSettings,
            reportWarning: this.deps.reportWarning,
            builtinExtensions: this.deps.builtinExtensions,
            // The child's messages count in the main session's tally (Section 13).
            usageTally: this.usageTally,
          },
        );
        registry.attach(registryRow, childEngine.registry);
        // A Fleet-delivered turn of the previous attempt may still be starting or
        // running: the host refuses a prompt while it is, so the attempt waits for
        // it first, exactly as it waits for its running rows (Section 4.2). A
        // cancellation or liveness expiry during that wait settles now, before the
        // reset would drop what it recorded.
        await waitForFleetTurns();
        if (abortRequested || timedOut) {
          outcome = classify(undefined, abortRequested);
          records.push(buildRecord(outcome));
          break;
        }
        // The attempt starts fresh: that turn's usage, trace and candidate are no
        // attempt's.
        resetAttempt();

        armIdle();
        if (liveness.absoluteTimeoutMs > 0) {
          absoluteTimer = setTimeout(() => {
            timedOut = true;
            timedOutWhy = `absolute timeout after ${liveness.absoluteTimeoutMs}ms`;
            controller.abort();
          }, liveness.absoluteTimeoutMs);
          absoluteTimer.unref?.();
        }

        let promptError: string | undefined;
        let abortedDuringRun = false;
        try {
          await session.prompt(taskText, { expandPromptTemplates: false });
          if (opts.fleetQuery !== true) await waitForTasks(session, childEngine.registry);
          abortedDuringRun = abortRequested;
        } catch (error) {
          abortedDuringRun = abortRequested;
          promptError = errorMessage(error);
        }
        // A non-`stop` turn can end the attempt with a Fleet turn still in flight; it
        // must not start in a session that is being shut down (Section 4.2). The
        // liveness deadlines still bound this wait.
        await endFleetTurns();
        if (idleTimer) clearTimeout(idleTimer);
        if (absoluteTimer) clearTimeout(absoluteTimer);
        idleTimer = undefined;
        absoluteTimer = undefined;

        outcome = classify(promptError, abortedDuringRun);
        records.push(buildRecord(outcome));
        endAttemptRegistry();

        const canRetry =
          outcome.retry !== undefined &&
          retriesLeft > 0 &&
          !abortRequested &&
          !timedOut &&
          registry.holderLive(registryRow);
        if (!canRetry) break;
        retriesLeft -= 1;
        taskText =
          outcome.retry === "ask-why"
            ? `${plan.task}\n\nWhy did you previously decline? Explain, then complete the task if you legitimately can.`
            : plan.task;
      }

      if (!outcome) throw new Error("attempt loop exited without an outcome");
      let final = outcome;
      if (final.status === "completed") {
        const file = session.sessionFile;
        if (!file || !existsSync(file) || !statSync(file).isFile()) {
          final = {
            status: "failed",
            stopReason: "error",
            failureCode: "execution-error",
            failurePhase: "execution",
            errorMessage: "attempt completed without a retained session file (contract violation)",
          };
          const record = buildRecord(final);
          records[records.length - 1] = record;
        }
      }

      return this.settleAndFormat(
        registry,
        registryRow,
        plan,
        final,
        records,
        sessionPath,
        agentsDir,
        cancelCause === "registry-end",
      );
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (absoluteTimer) clearTimeout(absoluteTimer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
      for (const key of claimedSessions) inFlightSessions.delete(key);
      registryRow.cancel = undefined;
      unsubscribe?.();
      searchRuntimeForChild.stop();
      endAttemptRegistry();
      if (fleetChildId) {
        try {
          this.fleet?.unregisterChild(fleetChildId);
        } catch (error) {
          warnFleet(`Fleet child cleanup failed: ${errorMessage(error)}`);
        }
      }
      if (session) {
        // The child's extensions get their session shutdown before the session goes
        // away, so a connection one opened (an MCP server) is closed, but never for
        // longer than the deadline (Section 3.1).
        const shutdownMs = this.deps.extensionShutdownTimeoutMs ?? EXTENSION_SHUTDOWN_TIMEOUT_MS;
        const shutdown = await extensionShutdown(session, shutdownMs);
        if (shutdown === "timeout") {
          notifyWarning(
            `extension shutdown timed out after ${shutdownMs}ms; resources may remain active`,
          );
        } else if (shutdown !== "done") {
          notifyWarning(`extension session shutdown failed: ${errorMessage(shutdown.error)}`);
        }
      }
      try {
        session?.dispose();
      } catch {
        // Best effort.
      }
      sessionBox.current = undefined;
    }
  }

  private failureResult(
    registry: TaskRegistry,
    row: AgentTaskRow,
    plan: DispatchPlan,
    code: FailureCode,
    phase: FailurePhase,
    message: string,
    agentsDir?: string,
  ): ToolResult {
    const record: AttemptRecord = {
      agent: plan.agent,
      status: "failed",
      stopReason: "error",
      failureCode: code,
      failurePhase: phase,
      model: plan.modelLabel,
      modelSource: plan.modelSource,
      previousModel: plan.previousModel,
      usage: emptyUsage(),
      trace: [],
    };
    return this.settleAndFormat(
      registry,
      row,
      plan,
      {
        status: "failed",
        stopReason: "error",
        failureCode: code,
        failurePhase: phase,
        errorMessage: message,
      },
      [record],
      undefined,
      agentsDir,
    );
  }

  /** Format the settled result and settle the row. */
  private settleAndFormat(
    registry: TaskRegistry,
    row: AgentTaskRow,
    plan: DispatchPlan,
    outcome: AttemptOutcome,
    records: AttemptRecord[],
    sessionPath: string | undefined,
    agentsDir: string | undefined,
    registryEndCancellation = false,
  ): ToolResult {
    const isError = outcome.status !== "completed";
    const finalText = outcome.finalText ?? "";
    let text: string;
    if (isError) {
      // An empty error message carries no information (Section 4.3); the
      // final text and the stop reason follow.
      const message =
        (outcome.errorMessage === "" ? undefined : outcome.errorMessage) ??
        (finalText === "" ? undefined : finalText) ??
        outcome.stopReason;
      text = `Agent ${outcome.stopReason}: ${message}`;
      if (sessionPath) text += `\nSession: ${sessionPath}`;
    } else {
      text = finalText === "" ? "(no output)" : finalText;
    }

    // Result spill for background tasks above the threshold (Section 7).
    let resultPath: string | undefined;
    if (row.background && text.length > SPILL_THRESHOLD && agentsDir) {
      try {
        const spillPath = join(agentsDir, `${safeName(row.taskId)}.result.md`);
        writeFileSync(spillPath, text, "utf8");
        resultPath = spillPath;
      } catch {
        resultPath = undefined;
      }
    }

    registry.settle(row, {
      status: outcome.status,
      result: text,
      resultPath,
    });
    // Rewrite the task record with the terminal status (task-record.md Section 2).
    // A cancellation that the task registry's own end caused leaves the record
    // running, so the next start's rebuild reports the task interrupted, whatever
    // the order of the settlement and the rebuild; a cancellation requested before
    // the registry ended (`Task` `kill`) is rewritten like any other settlement.
    // A rewrite failure MUST NOT fail the dispatch.
    const cancelledByEnd = outcome.status === "cancelled" && registryEndCancellation;
    if (row.background && row.recordPath && !cancelledByEnd) {
      try {
        rewriteSettledRecord(row.recordPath, {
          status: outcome.status,
          settledAt: row.settledAt ?? Date.now(),
          resultPath,
        });
      } catch {
        // A record failure MUST NOT fail the dispatch.
      }
    }
    return {
      content: [{ type: "text", text }],
      details: {
        taskId: row.taskId,
        agent: plan.agent,
        results: records,
        final: !isError || undefined,
      },
      ...(isError ? { isError: true } : {}),
    };
  }
}
