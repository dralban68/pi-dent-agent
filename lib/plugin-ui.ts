import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import { type JsonObject, type JsonValue, validateToolArguments } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { bundledAliases } from "./bundled.ts";
import type { PluginEntry } from "./plugins.ts";
import { resolvePluginScriptPath } from "./plugins.ts";
import {
  runScript,
  type ScriptRunHandle,
  type ScriptRunResult,
  type ScriptRunTools,
} from "./script-runner.ts";
import { callBoundTool, type NestedCallOutcome } from "./script-tool-calls.ts";
import {
  type CallableTool,
  DEFAULT_TOOLS_ALLOW,
  selectTools,
  toolDeclarations,
} from "./script-tool-types.ts";
import { errorCode, errorMessage, isPlainObject } from "./util.ts";
import type { PluginUiToolProxy } from "./plugin-ui-proxy.ts";
import { buildCheckRunTools, type ActiveUiCheck } from "./plugin-ui-inspect.ts";

/**
 * Plugin UI protocol controller (specs/plugin-ui.md): handles `/dent-ui run`
 * and `/dent-ui cancel`, executes plugin scripts with `dent.ui.send`, pi-dent's
 * own tools, and no time limit, and emits `message` and `reply` records on the
 * `pi-dent-ui` widget feed.
 */

export const PLUGIN_UI_WIDGET_KEY = "pi-dent-ui";
export const PLUGIN_UI_PROTOCOL = "ui/1";
export const PLUGIN_UI_PAYLOAD_CAP_BYTES = 262_144;

/** Tools pi-dent registers that are never callable from a plugin UI call (Section 4.2). */
export const PLUGIN_UI_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "Script",
  "AskUserQuestion",
  "PluginUI",
]);

/** One pi-dent tool adapted for execution from a plugin UI call (Section 4.2). */
export interface UiCallableTool extends CallableTool {
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    ctx: ExtensionToolContext | undefined,
  ): Promise<NestedCallOutcome>;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const item of value) {
      const converted = toJsonValue(item);
      if (converted === undefined) return undefined;
      out.push(converted);
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      const converted = toJsonValue(v);
      if (converted === undefined) return undefined;
      out[k] = converted;
    }
    return out;
  }
  return undefined;
}

function toJsonObject(value: unknown): JsonObject {
  if (!isPlainObject(value)) return {};
  const converted = toJsonValue(value);
  return converted !== undefined && isPlainObject(converted) ? converted : {};
}

/**
 * Adapt a pi `ToolDefinition` for direct execution from a plugin UI call:
 * validates arguments with pi's `validateToolArguments` and normalises the
 * returned `AgentToolResult` into a `NestedCallOutcome`.
 */
export function asUiCallableTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
): UiCallableTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    async execute(toolCallId, params, signal, ctx) {
      const raw = isPlainObject(params) ? params : {};
      const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
      const validated: Static<TParams> = validateToolArguments(
        { name: tool.name, description: tool.description, parameters: tool.parameters },
        { type: "toolCall", id: toolCallId, name: tool.name, arguments: toJsonObject(prepared) },
      );
      if (ctx === undefined) {
        return {
          result: {
            content: [{ type: "text", text: "No host context available for tool call" }],
          },
          isError: true,
        };
      }
      const result = await tool.execute(toolCallId, validated, signal, undefined, ctx);
      const structured = "structuredContent" in result ? result.structuredContent : undefined;
      return {
        result: {
          content: result.content,
          details: result.details,
          ...(structured === undefined ? {} : { structuredContent: structured }),
        },
        isError: "isError" in result && result.isError === true,
      };
    },
  };
}

/** Build an `ExtensionToolContext` from a command/session `ExtensionContext`. */
export function makeUiToolContext(ctx: ExtensionContext): ExtensionToolContext {
  return {
    ui: ctx.ui,
    mode: ctx.mode,
    hasUI: ctx.hasUI,
    cwd: ctx.cwd,
    sessionManager: ctx.sessionManager,
    modelRegistry: ctx.modelRegistry,
    model: ctx.model,
    scopedModels: ctx.scopedModels,
    ...(ctx.thinkingLevel === undefined ? {} : { thinkingLevel: ctx.thinkingLevel }),
    isIdle: () => ctx.isIdle(),
    isProjectTrusted: () => ctx.isProjectTrusted(),
    signal: ctx.signal,
    abort: () => ctx.abort(),
    hasPendingMessages: () => ctx.hasPendingMessages(),
    shutdown: () => ctx.shutdown(),
    getContextUsage: () => ctx.getContextUsage(),
    compact: (options) => ctx.compact(options),
    getSystemPrompt: () => ctx.getSystemPrompt(),
    tools: [],
    executeTool: async (name) => ({
      toolCall: { type: "toolCall", id: "ui:unsupported", name, arguments: {} },
      result: {
        content: [
          { type: "text", text: "Nested tool calls are not available in a plugin UI call" },
        ],
        details: {},
      },
      isError: true,
    }),
  };
}

/** Minimal shape of a tool from `pi.getAllTools()` needed for proxy binding. */
export interface SessionToolInfo extends CallableTool {
  exposure?: string | undefined;
}

export interface PluginUiToolDeps {
  /** pi-dent's own registered tools eligible for direct execution in UI calls. */
  ownedTools: () => readonly UiCallableTool[];
  /** All tools configured in the session (from `pi.getAllTools()`). */
  allTools?: () => readonly SessionToolInfo[];
  /** Active tool names in the session (from `pi.getActiveTools()`). */
  activeToolNames?: () => readonly string[];
  /** Fallback list of session tool names when `allTools` is omitted (used by unit tests). */
  allToolNames?: () => readonly string[];
  /** `script.tools.allow` (specs/script-tool.md Section 8); absent gives the default. */
  toolsAllow?: () => readonly string[];
  /** Lazily creates the parent session's long-lived tool proxy on the first proxied call. */
  createProxy?: () => PluginUiToolProxy | undefined;
}

export interface PluginUiCommandContext {
  cwd: string;
  setWidget(key: string, lines: string[] | undefined): void;
  toolContext?: ExtensionToolContext;
  extraEnv?: Record<string, string>;
}

interface ActiveUiCall {
  handle: ScriptRunHandle;
  checkId?: string;
  cancelReason?: string;
}

export interface PluginUiInspectBridge {
  getActiveCheck(id: string): ActiveUiCheck | undefined;
  handleResult(rawJson: string): void;
}

function formatThrownError(
  error: { name: string; message: string; stack: string } | undefined,
): string {
  if (!error) return "Script threw an error";
  return error.message === "" ? error.name : `${error.name}: ${error.message}`;
}

export class PluginUiController {
  private readonly pluginIndex: ReadonlyMap<string, PluginEntry>;
  private readonly toolDeps: PluginUiToolDeps | undefined;
  private readonly active = new Map<string, ActiveUiCall>();
  private proxy: PluginUiToolProxy | undefined;
  private inspectBridge: PluginUiInspectBridge | undefined;

  constructor(pluginIndex: ReadonlyMap<string, PluginEntry>, toolDeps?: PluginUiToolDeps) {
    this.pluginIndex = pluginIndex;
    this.toolDeps = toolDeps;
  }

  /** Attach the UI inspection bridge for `check` runs and `/dent-ui result`. */
  setInspectBridge(bridge: PluginUiInspectBridge): void {
    this.inspectBridge = bridge;
  }

  /** Number of UI calls currently executing. */
  activeCount(): number {
    return this.active.size;
  }

  /** Handle one `/dent-ui <args>` command (specs/plugin-ui.md Sections 1-3, 8). */
  handleCommand(args: string, ctx: PluginUiCommandContext): void {
    const trimmed = args.trim();
    if (trimmed === "") return;
    const space = trimmed.search(/\s/);
    const subcommand = space === -1 ? trimmed : trimmed.slice(0, space);
    const payload = space === -1 ? "" : trimmed.slice(space).trim();
    if (subcommand === "run") {
      this.handleRun(payload, ctx);
    } else if (subcommand === "cancel") {
      this.handleCancel(payload);
    } else if (subcommand === "result") {
      this.inspectBridge?.handleResult(payload);
    }
  }

  /** Cancel every executing UI call belonging to one check (specs/plugin-ui-tool.md Section 3). */
  cancelForCheck(checkId: string, reason = "UI call was cancelled"): void {
    for (const entry of this.active.values()) {
      if (entry.checkId !== checkId) continue;
      entry.cancelReason = reason;
      entry.handle.cancel("killed");
    }
  }

  /** Cancel every executing UI call (specs/plugin-ui.md Section 6). */
  cancelAll(reason = "Session ended"): void {
    for (const entry of this.active.values()) {
      entry.cancelReason = reason;
      entry.handle.cancel("killed");
    }
  }

  /** Dispose the parent session's tool proxy, if one was created (specs/plugin-ui.md Section 4.3). */
  async disposeProxy(): Promise<void> {
    const current = this.proxy;
    this.proxy = undefined;
    if (current) await current.dispose();
  }

  private getOrCreateProxy(): PluginUiToolProxy | undefined {
    if (this.proxy) return this.proxy;
    const created = this.toolDeps?.createProxy?.();
    if (created) this.proxy = created;
    return this.proxy;
  }

  private sessionToolNames(): string[] {
    if (!this.toolDeps) return [];
    const names = new Set<string>();
    for (const tool of this.toolDeps.allTools?.() ?? []) names.add(tool.name);
    for (const name of this.toolDeps.allToolNames?.() ?? []) names.add(name);
    for (const tool of this.toolDeps.ownedTools()) names.add(tool.name);
    return [...names];
  }

  private buildRunTools(id: string, ctx: PluginUiCommandContext): ScriptRunTools | undefined {
    if (!this.toolDeps) return undefined;
    const allow = this.toolDeps.toolsAllow?.() ?? DEFAULT_TOOLS_ALLOW;
    const activeNames = this.toolDeps.activeToolNames?.();
    const activeSet = activeNames ? new Set(activeNames) : undefined;
    const ownedList = this.toolDeps.ownedTools();
    const directCandidates = ownedList.filter(
      (tool) =>
        !PLUGIN_UI_EXCLUDED_TOOLS.has(tool.name) &&
        (activeSet === undefined || activeSet.has(tool.name)),
    );
    const directSelection = selectTools(directCandidates, allow);
    const directMap = new Map<string, UiCallableTool>();
    for (const tool of directSelection.bound) directMap.set(tool.name, tool);

    const allSessionTools = this.toolDeps.allTools?.() ?? [];
    const proxiedMap = new Map<string, CallableTool>();
    if (this.toolDeps.createProxy && allSessionTools.length > 0) {
      const proxiedCandidates = allSessionTools.filter((tool) => {
        if (directMap.has(tool.name) || PLUGIN_UI_EXCLUDED_TOOLS.has(tool.name)) return false;
        const exposure = tool.exposure ?? "direct";
        if (exposure === "codemode" || exposure === "deferred") return true;
        if (exposure === "direct") return activeSet === undefined || activeSet.has(tool.name);
        return false;
      });
      const proxiedSelection = selectTools(proxiedCandidates, allow);
      for (const tool of proxiedSelection.bound) proxiedMap.set(tool.name, tool);
    }

    const combined: CallableTool[] = [...directSelection.bound, ...proxiedMap.values()].toSorted(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    const boundNames = combined.map((tool) => tool.name);
    const boundSet = new Set(boundNames);

    const unavailableSet = new Set<string>();
    for (const tool of allSessionTools) {
      if (!boundSet.has(tool.name)) unavailableSet.add(tool.name);
    }
    for (const name of this.toolDeps.allToolNames?.() ?? []) {
      if (!boundSet.has(name)) unavailableSet.add(name);
    }
    for (const tool of ownedList) {
      if (!boundSet.has(tool.name)) unavailableSet.add(tool.name);
    }
    const unavailableNames = [...unavailableSet].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    let callSeq = 0;
    return {
      names: boundNames,
      unavailableNames,
      declarations: toolDeclarations({ bound: combined, unbound: [] }),
      call: async (name, args, callSignal) => {
        const directTool = directMap.get(name);
        if (directTool !== undefined) {
          const toolCallId = `ui:${id}/${++callSeq}`;
          return callBoundTool(
            directTool,
            args,
            async (_toolName, toolArgs, options) => {
              try {
                return await directTool.execute(
                  toolCallId,
                  toolArgs,
                  options.signal,
                  ctx.toolContext,
                );
              } catch (error) {
                return {
                  result: { content: [{ type: "text", text: errorMessage(error) }] },
                  isError: true,
                };
              }
            },
            callSignal,
          );
        }

        const proxiedTool = proxiedMap.get(name);
        if (proxiedTool !== undefined) {
          const proxy = this.getOrCreateProxy();
          if (proxy === undefined) {
            return {
              ok: false,
              error: { name: "Error", message: "No live host session for proxied tool call" },
            };
          }
          return callBoundTool(
            proxiedTool,
            args,
            async (_toolName, toolArgs, options) => {
              try {
                return await proxy.call(name, toolArgs, options.signal);
              } catch (error) {
                return {
                  result: { content: [{ type: "text", text: errorMessage(error) }] },
                  isError: true,
                };
              }
            },
            callSignal,
          );
        }

        return {
          ok: false,
          error: { name: "Error", message: `tool ${name} is unavailable in a plugin UI call` },
        };
      },
    };
  }

  private handleRun(rawJson: string, ctx: PluginUiCommandContext): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return;
    }
    if (!isPlainObject(parsed) || typeof parsed.id !== "string" || parsed.id === "") {
      return;
    }
    const id = parsed.id;
    const emitLine = (line: string): void => {
      try {
        ctx.setWidget(PLUGIN_UI_WIDGET_KEY, [line]);
      } catch {
        // Widget update failures are unreported per specs/AGENTS.md.
      }
    };
    const emitMessageJson = (dataJson: string): void => {
      emitLine(
        `{"piDent":${JSON.stringify(PLUGIN_UI_PROTOCOL)},"type":"message","id":${JSON.stringify(id)},"data":${dataJson}}`,
      );
    };
    const emitReplyOkJson = (valueJson: string): void => {
      emitLine(
        `{"piDent":${JSON.stringify(PLUGIN_UI_PROTOCOL)},"type":"reply","id":${JSON.stringify(id)},"ok":true,"value":${valueJson}}`,
      );
    };
    const emitReplyError = (error: string): void => {
      emitLine(
        JSON.stringify({
          piDent: PLUGIN_UI_PROTOCOL,
          type: "reply",
          id,
          ok: false,
          error,
        }),
      );
    };

    if (this.active.has(id)) {
      emitReplyError(`UI call "${id}" is already running`);
      return;
    }
    if (typeof parsed.namespace !== "string" || parsed.namespace === "") {
      emitReplyError("Invalid plugin namespace");
      return;
    }
    const plugin = this.pluginIndex.get(parsed.namespace);
    if (!plugin) {
      emitReplyError(`Unknown plugin "${parsed.namespace}"`);
      return;
    }
    if (typeof parsed.root !== "string" || parsed.root !== plugin.root) {
      emitReplyError(`Plugin "${parsed.namespace}" root mismatch`);
      return;
    }
    let activeCheck: ActiveUiCheck | undefined;
    if ("check" in parsed && parsed.check !== undefined) {
      if (typeof parsed.check !== "string") {
        emitReplyError("Invalid UI check");
        return;
      }
      activeCheck = this.inspectBridge?.getActiveCheck(parsed.check);
      if (activeCheck === undefined) {
        emitReplyError(`Unknown UI check "${parsed.check}"`);
        return;
      }
    }
    if (typeof parsed.path !== "string" || parsed.path.trim() === "") {
      emitReplyError("Invalid script path");
      return;
    }
    const resolved = resolvePluginScriptPath(plugin.root, parsed.path);
    if ("error" in resolved) {
      emitReplyError(`plugin "${parsed.namespace}": ${resolved.error}`);
      return;
    }
    let code: string;
    try {
      code = readFileSync(resolved.path, "utf8");
    } catch (error) {
      const codeName = errorCode(error);
      emitReplyError(
        codeName === "ENOENT"
          ? `plugin "${parsed.namespace}": missing script ${resolved.path}`
          : `plugin "${parsed.namespace}": failed to read ${resolved.path}: ${codeName ?? errorMessage(error)}`,
      );
      return;
    }

    const data = parsed.data === undefined ? null : parsed.data;
    const nonLiveCheck =
      activeCheck !== undefined && activeCheck.backend !== "live" ? activeCheck : undefined;
    const tools =
      nonLiveCheck === undefined
        ? this.buildRunTools(id, ctx)
        : buildCheckRunTools(nonLiveCheck, this.sessionToolNames());
    const stateWorkspaceRoot =
      nonLiveCheck?.stateDir === undefined ? ctx.cwd : join(nonLiveCheck.stateDir, "workspace");
    const stateUserRoot =
      nonLiveCheck?.stateDir === undefined ? undefined : join(nonLiveCheck.stateDir, "user");
    let handle: ScriptRunHandle;
    try {
      handle = runScript({
        code,
        filename: resolved.path,
        cwd: ctx.cwd,
        input: { ui: data },
        aliases: bundledAliases(),
        uiCall: true,
        pluginNamespace: plugin.name,
        stateWorkspaceRoot,
        ...(stateUserRoot === undefined ? {} : { stateUserRoot }),
        ...(tools === undefined ? {} : { tools }),
        ...(ctx.extraEnv && Object.keys(ctx.extraEnv).length > 0 ? { extraEnv: ctx.extraEnv } : {}),
        onUiMessage: (dataJson) => {
          emitMessageJson(dataJson);
        },
      });
    } catch (error) {
      emitReplyError(`Failed to start script: ${errorMessage(error)}`);
      return;
    }

    const entry: ActiveUiCall = {
      handle,
      ...(activeCheck === undefined ? {} : { checkId: activeCheck.id }),
    };
    this.active.set(id, entry);

    void handle.promise
      .then((result) => {
        this.active.delete(id);
        this.emitSettlementReply(result, entry, emitReplyOkJson, emitReplyError);
      })
      .catch((error: unknown) => {
        this.active.delete(id);
        emitReplyError(errorMessage(error));
      });
  }

  private emitSettlementReply(
    result: ScriptRunResult,
    entry: ActiveUiCall,
    emitOkJson: (valueJson: string) => void,
    emitError: (error: string) => void,
  ): void {
    switch (result.exitReason) {
      case "ok":
        if (result.uiReturn?.ok === true) {
          emitOkJson(result.uiReturn.json);
        } else if (result.uiReturn?.ok === false) {
          emitError(result.uiReturn.error);
        } else {
          emitOkJson("null");
        }
        return;
      case "exit-called":
        if ((result.exitCode ?? 0) === 0) {
          emitOkJson("null");
        } else {
          emitError(`Script exited with code ${result.exitCode}`);
        }
        return;
      case "threw":
        emitError(formatThrownError(result.error));
        return;
      case "killed":
      case "aborted":
        emitError(entry.cancelReason ?? "UI call was cancelled");
        return;
      case "timeout":
        emitError("UI call timed out");
        return;
    }
  }

  private handleCancel(rawJson: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return;
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.ids)) return;
    for (const id of parsed.ids) {
      if (typeof id !== "string") continue;
      const entry = this.active.get(id);
      if (!entry) continue;
      entry.cancelReason = "UI call was cancelled";
      entry.handle.cancel("killed");
    }
  }
}
