/**
 * pi-dent - a generic coding agent, built as a pi extension.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { highlightCode as hostHighlightCode } from "@earendil-works/pi-coding-agent";
import {
  type BootSnapshot,
  DispatchEngine,
  hostFromContext,
  inheritedExtensions,
  readBootSnapshot,
  agentsDirFor,
  agentDirForHost,
  closeMainSessionDir,
  openMainSessionDir,
  retentionSweep,
  appendSkillCatalog,
} from "./lib/engine.ts";
import type { HostSession } from "./lib/host.ts";
import { extractChangedFiles, FleetCoordinator, ownedElsewhereWarning } from "./lib/fleet.ts";
import { registerReadErrorHint } from "./lib/output-file.ts";
import { runFleetCommand } from "./lib/fleet-command.ts";
import { recapRuntime } from "./lib/recap.ts";
import { renderRecapEntry } from "./lib/recap-render.ts";
import { appendPluginContext, renderPluginCommand } from "./lib/plugins.ts";
import { createPluginMcpRegistrar, pluginMcpExtensionFactory } from "./lib/plugin-mcp.ts";
import {
  asUiCallableTool,
  makeUiToolContext,
  PLUGIN_CATALOG_EVENT,
  PLUGIN_UI_CANCEL_TAG_EVENT,
  PLUGIN_UI_EXCLUDED_TOOLS,
  PluginUiController,
  type UiCallableTool,
} from "./lib/plugin-ui.ts";
import { PluginUiToolProxy } from "./lib/plugin-ui-proxy.ts";
import { type Diagnostic, errorMessage, isPlainObject } from "./lib/util.ts";
import { rebuildInterruptedTasks } from "./lib/task-rebuild.ts";
import {
  AgentToolRegistry,
  CohortTracker,
  makeFleetTool,
  makePluginTool,
  makeSessionTool,
  makeSkillTool,
  makeTaskTool,
} from "./lib/tools.ts";
import { makeScriptTool } from "./lib/script-tool.ts";
import { DEFAULT_TOOLS_ALLOW } from "./lib/script-tool-types.ts";
import { makeBashTool, readBashSettings } from "./lib/bash-tool.ts";
import { makeSearchTool, searchRuntime } from "./lib/search-tool.ts";
import { makeMarkdownTool, markdownRuntime } from "pi-dent-markdown";
import { pruneSessionIndex } from "./lib/session-index.ts";
import { USAGE_STATUS_KEY, UsageTally } from "./lib/usage.ts";
import { openTaskLedger } from "./lib/task-ledger.ts";
import {
  hostSessionFigures,
  LedgerHolder,
  NestedCalls,
  type LedgerScope,
} from "./lib/task-ledger-wiring.ts";
import {
  SCHEDULE_STATUS_KEY,
  SCHEDULE_TOOL_NAME,
  makeScheduleTool,
  scheduleRuntime,
  type ScheduleWindow,
} from "./lib/schedule-tool.ts";
import {
  type SessionKind,
  SESSION_KIND_ENV,
  appendSessionMode,
  sessionKindForMain,
} from "./lib/session-kind.ts";
import {
  ASK_USER_TOOL_NAME,
  askUserRuntime,
  makeAskUserQuestionTool,
} from "./lib/ask-user-question-tool.ts";
import { readFileSync } from "node:fs";
import { parseFooter, parseScript, parseTaskBrowser } from "./lib/config.ts";
import { createFooterComponent } from "./lib/footer.ts";
import { TaskBrowserOverlay } from "./lib/task-browser.ts";
import { startTaskWidget, type TaskPaint, type TaskWidgetHandle } from "./lib/task-widget.ts";
import { feedsAnnounced } from "./lib/feeds.ts";
import { startTaskFeed, type FeedHandle } from "./lib/task-feed.ts";
import {
  openTaskDetailFeed,
  runTasksVerb,
  TASK_DETAIL_INTERVAL_MS,
  type TaskDetailFeed,
} from "./lib/task-detail-feed.ts";
import { startFleetFeed } from "./lib/fleet-feed.ts";
import { GUIDANCE_CUSTOM_TYPE, modelCatalog, parsedModelGuidance } from "./lib/model-guidance.ts";
import { GuidanceController } from "./lib/guidance-controller.ts";
import { renderGuidanceMessage } from "./lib/guidance-render.ts";
import { readLocalZone } from "./lib/billing-text.ts";
import { localLinkDiagnostics } from "./lib/local-links.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The boot snapshot is cached per process so one boot window (process start
 * or pi /reload) serves many sessions; /reload or shutdown invalidates it.
 * The first reader reports the window's layer diagnostics once.
 */
interface BootWindow {
  snapshot: BootSnapshot;
  fleet: FleetCoordinator;
  reported: boolean;
  swept: boolean;
  activeSessions: Set<string>;
  /** The shell-settings files already reported (specs/bash-tool.md#execution-model). */
  settingsWarnings: Set<string>;
}

let activeBootWindow: BootWindow | undefined;

function openBootWindow(): BootWindow {
  if (!activeBootWindow) {
    const snapshot = readBootSnapshot(process.cwd());
    const fleet = new FleetCoordinator(snapshot);
    activeBootWindow = {
      snapshot,
      fleet,
      reported: false,
      swept: false,
      activeSessions: new Set(),
      settingsWarnings: new Set(),
    };
  }
  return activeBootWindow;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isPlainObject(part) && part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .filter((t) => t !== "")
    .join("\n");
}

function reportDiagnostics(ctx: ExtensionContext, window: BootWindow): void {
  if (window.reported) return;
  window.reported = true;
  for (const diagnostic of window.snapshot.diagnostics) {
    ctx.ui.notify(
      `pi-dent: ${diagnostic.message}`,
      diagnostic.level === "info" ? "info" : "warning",
    );
  }
}

/** Theme paint for the task tree widget (specs/task.md#task-tree-widget). */
export function themePaint(theme: { fg(name: string, text: string): string }): TaskPaint {
  return {
    status: (text, status) => theme.fg(status === "interrupted" ? "warning" : "accent", text),
    orphan: (text) => theme.fg("warning", text),
    elapsed: (text) => theme.fg("muted", text),
    detail: (text) => theme.fg("dim", text),
  };
}

/**
 * Run one session shutdown step: a step that throws is reported and the shutdown goes on, so no
 * step after it is left undone.
 */
export function shutdownStep(
  what: string,
  run: () => void,
  report: (message: string) => void,
): void {
  try {
    run();
  } catch (error) {
    report(`pi-dent: session shutdown: ${what} failed: ${errorMessage(error)}`);
  }
}

/** specs/bash-tool.md#builtin-suppression: the block reason for a built-in `bash` call. */
const BASH_BLOCKED_REASON = "The `bash` tool is disabled: use `Bash`.";

/** specs/bash-tool.md#builtin-suppression: the warning of a selection with no shell tool. */
const NO_SHELL_NOTICE =
  "pi-dent: the tool selection names `bash`, which is disabled, and omits `Bash`: the session has no shell tool";

/**
 * specs/ask-user-question-tool.md#activation: in a session without a user interface the
 * tool leaves the active tool set before the session's first model request, every
 * other tool's activity unchanged; with one, its activity stays as the host set it.
 */
function hideAskUserQuestionWithoutUi(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (ctx.hasUI) return;
  const active = pi.getActiveTools();
  if (!active.includes(ASK_USER_TOOL_NAME)) return;
  pi.setActiveTools(active.filter((name) => name !== ASK_USER_TOOL_NAME));
}

/**
 * specs/schedule-tool.md#activation: in an agent session (no user interface) `Schedule`
 * leaves the active tool set before the session's first model request, every other
 * tool's activity unchanged; in a user session, its activity stays as the host set it.
 */
function hideScheduleWithoutUi(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (ctx.hasUI) return;
  const active = pi.getActiveTools();
  if (!active.includes(SCHEDULE_TOOL_NAME)) return;
  pi.setActiveTools(active.filter((name) => name !== SCHEDULE_TOOL_NAME));
}

/**
 * specs/bash-tool.md#builtin-suppression: every session_start deactivates the built-in `bash`,
 * and a selection that still names it while omitting `Bash` leaves the session
 * without a shell tool.
 */
function deactivateBuiltinBash(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const active = pi.getActiveTools();
  pi.setActiveTools(active.filter((name) => name !== "bash"));
  if (!active.includes("bash")) return;
  if (pi.getAllTools().some((tool) => tool.name === "Bash")) return;
  ctx.ui.notify(NO_SHELL_NOTICE, "warning");
}

export default function (pi: ExtensionAPI) {
  const window = openBootWindow();
  const boot = window.snapshot;
  const fleet = window.fleet;
  const { guidance, billing } = parsedModelGuidance(boot.config);
  // The local zone is read once here (specs/billing.md#billing-text) and shared by every
  // text that renders local time.
  const zone = readLocalZone();
  // specs/billing.md#diagnostics: a diagnostic is shown at once while a session of this
  // instance is open, and held for the next session_start otherwise.
  let sessionUi: ExtensionContext["ui"] | undefined;
  const heldDiagnostics: Diagnostic[] = [];
  const showDiagnostic = (diagnostic: Diagnostic): void => {
    sessionUi?.notify(`pi-dent: ${diagnostic.message}`, diagnostic.level);
  };
  const reportDiagnostic = (diagnostic: Diagnostic): void => {
    if (sessionUi !== undefined) {
      showDiagnostic(diagnostic);
      return;
    }
    heldDiagnostics.push(diagnostic);
  };
  // specs/package.md#load-time-check: a declared local link that is missing, or in use, is told at load.
  for (const diagnostic of localLinkDiagnostics(dirname(fileURLToPath(import.meta.url)))) {
    reportDiagnostic(diagnostic);
  }
  // specs/footer.md#configuration: the configuration is read once per boot window, and its diagnostics
  // hold until the session's UI shows them.
  const footerSettings = parseFooter(boot.config);
  for (const message of footerSettings.diagnostics) {
    reportDiagnostic({ level: "warning", message });
  }
  // One per extension instance: subscribes to the billing service's change
  // channel on this instance's own event bus (specs/billing.md#held-billing).
  const guidanceCtl = new GuidanceController({
    guidance,
    timeZone: zone,
    billingEnabled: billing,
    bus: pi.events,
    send: (message) => pi.sendMessage(message, { triggerTurn: false }),
    diagnostics: reportDiagnostic,
  });
  pi.registerMessageRenderer(GUIDANCE_CUSTOM_TYPE, renderGuidanceMessage);
  pi.registerEntryRenderer("pi-dent-recap", renderRecapEntry);

  let currentHost: HostSession | undefined;
  let currentSessionKind: SessionKind | undefined;
  // specs/bash-tool.md#execution-model: one settings reader per boot window, shared by the main session's
  // Bash and every child session's, so each unreadable file is reported once per boot window.
  const bashSettings = (cwd: string) =>
    readBashSettings(
      cwd,
      (message) => reportDiagnostic({ level: "warning", message }),
      window.settingsWarnings,
    );
  // One per main session: every dispatch, child and Fleet query of it adds to this tally
  // (specs/agent-tool.md#usage), whose status line follows it while an interactive TUI is open.
  const usageTally = new UsageTally();
  // specs/task-ledger.md#location: one task ledger per extension instance, opened at its main
  // session's first session_start and shared with every child and query engine.
  const ledgerHolder = new LedgerHolder();
  // The main session's identity and nested calls, as its rows are filed (specs/task-ledger.md#ledger-row and specs/task-ledger.md#parent-row).
  let ledgerSessionId: string | undefined;
  let ledgerCwd: string | undefined;
  const mainCalls = new NestedCalls();
  const ledgerScope: LedgerScope = {
    holder: ledgerHolder,
    sessionId: () => ledgerSessionId,
    cwd: () => currentHost?.cwd() ?? ledgerCwd,
    calls: mainCalls,
  };
  /** specs/task-ledger.md#session-row-writes: the main session's ledger session row, from the host's entries and header. */
  const writeSessionRow = (ctx: ExtensionContext | undefined, ended?: unknown): void => {
    const ledger = ledgerHolder.ledger;
    if (ledger === undefined || ctx === undefined) return;
    try {
      const manager = ctx.sessionManager;
      const { usage, toolCalls } = hostSessionFigures(manager, ended);
      ledger.writeSession({
        sessionId: manager.getSessionId(),
        sessionFile: manager.getSessionFile() ?? null,
        cwd: ctx.cwd,
        usage,
        toolCalls,
      });
    } catch (error) {
      reportDiagnostic({
        level: "warning",
        message: `task ledger session row not written: ${errorMessage(error)}`,
      });
    }
  };
  const engine = new DispatchEngine(
    boot,
    () => currentHost,
    fleet,
    guidanceCtl.billing,
    pi.events,
    {
      bashSettings,
      // specs/task-registry.md#cohorts: a notification the host did not deliver is shown once.
      reportNotification: (message) => reportDiagnostic({ level: "warning", message }),
      usageTally,
      ledger: ledgerScope,
    },
  );
  const cohorts = new CohortTracker();
  const ownedUiTools = new Map<string, UiCallableTool>();
  const registerOwnedTool = <TParams extends TSchema, TDetails = unknown>(
    tool: ToolDefinition<TParams, TDetails>,
  ): void => {
    pi.registerTool(tool);
    if (!PLUGIN_UI_EXCLUDED_TOOLS.has(tool.name)) {
      ownedUiTools.set(tool.name, asUiCallableTool(tool));
    }
  };
  // The Agent tool is registered at load with an empty model catalog; session_start refreshes it.
  const agentTool = new AgentToolRegistry(
    {
      boot,
      dispatch: (call) => {
        currentHost = call.host;
        return engine.dispatch(call);
      },
      hostProvider: () => currentHost,
      cohortFor: (toolCallId) => cohorts.cohortFor(toolCallId),
    },
    (tool) => registerOwnedTool(tool),
  );
  agentTool.refresh("");
  // Schedules live in the process, keyed by session ID, and survive a reload
  // (specs/schedule-tool.md#lifecycle).
  const schedules = scheduleRuntime({ zone });
  // The search tool answers from the shared session index, one call at a time
  // (specs/search-tool.md#registration and specs/search-tool.md#coverage).
  const search = searchRuntime({ zone });
  // The questions of the main session, one call at a time (specs/ask-user-question-tool.md#asking).
  const questions = askUserRuntime();
  const recap = recapRuntime(boot.config, (data) => pi.appendEntry("pi-dent-recap", data));
  const scriptToolsAllow = parseScript(boot.config).toolsAllow ?? DEFAULT_TOOLS_ALLOW;
  let currentProjectTrusted = false;
  const pluginUi = new PluginUiController(
    boot.pluginIndex,
    {
      ownedTools: () => [...ownedUiTools.values()],
      allTools: () => (typeof pi.getAllTools === "function" ? pi.getAllTools() : []),
      activeToolNames: () => (typeof pi.getActiveTools === "function" ? pi.getActiveTools() : []),
      toolsAllow: () => scriptToolsAllow,
      createProxy: () => {
        const host = currentHost;
        if (!host) return;
        const active = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
        const excludeTools = active.includes("bash") ? [] : ["bash"];
        const hasPluginMcp = boot.plugins.some((p) => (p.mcpServers?.length ?? 0) > 0);
        return new PluginUiToolProxy({
          cwd: host.cwd(),
          isProjectTrusted: currentProjectTrusted,
          extensions: inheritedExtensions(host),
          excludeTools,
          ...(hasPluginMcp
            ? {
                extraExtensionFactories: [
                  pluginMcpExtensionFactory(boot.plugins, reportDiagnostic),
                ],
              }
            : {}),
        });
      },
    },
    pi.events,
  );
  // specs/plugin-ui.md#extension-event-seam: UI-agnostic extension event seam.
  if (typeof pi.events?.on === "function") {
    try {
      pi.events.on(PLUGIN_UI_CANCEL_TAG_EVENT, (raw: unknown) => {
        if (!isPlainObject(raw) || typeof raw.check !== "string") return;
        const reason = typeof raw.reason === "string" ? raw.reason : undefined;
        pluginUi.cancelForCheck(raw.check, reason);
      });
      pi.events.on(PLUGIN_CATALOG_EVENT, (raw: unknown) => {
        if (!isPlainObject(raw)) return;
        raw.plugins = boot.plugins.map((plugin) => ({
          namespace: plugin.name,
          root: plugin.root,
        }));
      });
    } catch (error) {
      reportDiagnostic({
        level: "warning",
        message: `plugin-ui: failed to subscribe to extension events: ${errorMessage(error)}`,
      });
    }
  }
  let taskWidget: TaskWidgetHandle | undefined;
  // Feeds for an RPC client (specs/task.md#task-feed, specs/fleet-tool.md#fleet-feed).
  let taskFeed: FeedHandle | undefined;
  let fleetFeed: FeedHandle | undefined;
  // The watched task's details feed (specs/task.md#task-detail-feed), announced sessions only.
  let taskDetail: TaskDetailFeed | undefined;
  let closeTaskBrowser: (() => void) | undefined;
  // The usage status line's subscription, one per open main session.
  let stopUsageStatus: (() => void) | undefined;
  // specs/footer.md#activation: how to take pi-dent's footer down again, while one is set.
  let stopFooter: (() => void) | undefined;

  /**
   * specs/agent-tool.md#usage: the usage status line and its redraws, for a session pi-dent draws no
   * footer for. A UI that cannot set the text reports nothing.
   */
  const followTallyStatus = (ui: ExtensionContext["ui"]): (() => void) => {
    const update = (): void => {
      try {
        ui.setStatus(
          USAGE_STATUS_KEY,
          usageTally.statusText((color, text) => ui.theme.fg(color, text)),
        );
      } catch {
        // The dispatch and the tally are unaffected and no failure is reported (specs/agent-tool.md#usage).
      }
    };
    const unsubscribe = usageTally.subscribe(update);
    update();
    return unsubscribe;
  };

  /**
   * specs/footer.md#activation: draw pi-dent's footer for this session and return whether it is
   * pi-dent's. A host that refuses it keeps its own footer and is told so.
   */
  const installFooter = (ctx: ExtensionContext): boolean => {
    const ui = ctx.ui;
    // specs/footer.md#stats-line: the effective compaction settings of the session's working directory; unknown
    // settings count as enabled. Read once, so a render never touches the settings files.
    let autoCompact = true;
    try {
      autoCompact = currentHost?.compaction()?.enabled ?? true;
    } catch (error) {
      reportDiagnostic({
        level: "warning",
        message: `footer: compaction settings unreadable, counted as enabled: ${errorMessage(error)}`,
      });
    }
    const home = process.env.HOME || process.env.USERPROFILE;
    const stops: Array<() => void> = [];
    let redraw = (): void => {};
    let stopped = false;
    const stop = (): void => {
      stopped = true;
      redraw = () => {};
      for (const unsubscribe of stops.splice(0)) {
        try {
          unsubscribe();
        } catch {
          // A listener that cannot be removed leaves the footer as it is.
        }
      }
    };
    const fail = (error: unknown): void => {
      if (stopped) return;
      stop();
      stopFooter = undefined;
      // specs/footer.md#activation: the built-in footer comes back and the failure is shown once. pi-dent no longer
      // draws the footer, so the tally's status line takes over (specs/agent-tool.md#usage).
      try {
        ui.notify(`pi-dent: footer failed: ${errorMessage(error)}`, "error");
        ui.setFooter(undefined);
      } catch {
        // The UI is gone; the built-in footer or the process's exit covers the rest.
      }
      stopUsageStatus?.();
      stopUsageStatus = followTallyStatus(ui);
    };
    try {
      ui.setFooter((tui, theme, footerData) => {
        const component = createFooterComponent({
          paint: (color, text) => theme.fg(color, text),
          footerData,
          // Every append moves the leaf, so this key changes whenever the cached values can.
          sessionKey: () =>
            [
              ctx.sessionManager.getSessionId(),
              ctx.sessionManager.getLeafId() ?? "",
              ctx.model?.id ?? "",
              String(ctx.model?.contextWindow ?? 0),
            ].join("\u0000"),
          entries: () => ctx.sessionManager.getEntries(),
          contextUsage: () => ctx.getContextUsage(),
          values: () => ({
            cwd: ctx.cwd,
            home,
            sessionName: ctx.sessionManager.getSessionName(),
            model: ctx.model,
            thinkingLevel: pi.getThinkingLevel(),
            subscription: ctx.model !== undefined && ctx.modelRegistry.isUsingOAuth(ctx.model),
            autoCompact,
            tally: { tasks: usageTally.tasks, sum: usageTally.sum, partial: usageTally.partial },
          }),
          failed: fail,
          // The host dropped the footer: it is not ours to restore any more.
          disposed: () => {
            stop();
            stopFooter = undefined;
          },
        });
        redraw = (): void => {
          try {
            tui.requestRender();
          } catch {
            // The TUI is gone; the next session sets a footer of its own.
          }
        };
        stops.push(footerData.onBranchChange(() => redraw()));
        return component;
      });
    } catch (error) {
      stop();
      ui.notify(`pi-dent: footer could not be set: ${errorMessage(error)}`, "error");
      return false;
    }
    // specs/agent-tool.md#usage: the key stays clear while the footer shows the tally.
    try {
      ui.setStatus(USAGE_STATUS_KEY, undefined);
    } catch {
      // Nothing to clear on a UI that is already gone.
    }
    stops.push(usageTally.subscribe(() => redraw()));
    stopFooter = () => {
      stop();
      ui.setFooter(undefined);
    };
    return true;
  };

  const pluginMcp = createPluginMcpRegistrar(pi.events, boot.plugins, reportDiagnostic);

  pi.on("message_start", async (event, ctx) => {
    const scheduleSessionId = ctx?.sessionManager?.getSessionId?.() ?? currentHost?.sessionId();
    if (scheduleSessionId) {
      schedules.messageStarted({ sessionId: scheduleSessionId, message: event.message });
    }
    if (event.message?.role === "assistant") {
      cohorts.onMessageStartAssistant();
    } else if (event.message?.role === "user") {
      const sid = ctx?.sessionManager?.getSessionId?.() ?? currentHost?.sessionId();
      const cwd = ctx?.cwd ?? currentHost?.cwd() ?? process.cwd();
      if (sid) fleet.recordTurnStart(sid, cwd, messageText(event.message.content));
    }
  });

  pi.on("message_end", async (event, ctx) => {
    // specs/task-ledger.md#session-row-writes: every message end of the main session rewrites its row. The
    // host saves the message only after this event; the row counts it all the same.
    writeSessionRow(ctx, event.message);
    if (event.message?.role === "assistant") {
      const sid = ctx?.sessionManager?.getSessionId?.() ?? currentHost?.sessionId();
      if (sid) fleet.recordTurnGoal(sid, messageText(event.message.content));
    }
  });

  pi.on("tool_execution_start", async (event) => {
    cohorts.onToolExecutionStart(event.toolCallId, event.toolName);
    // specs/task-ledger.md#parent-row, rule 1: the calling tool call of a nested call.
    mainCalls.started(event.toolCallId, event.parentToolCallId);
  });

  pi.on("tool_execution_end", async (event) => {
    mainCalls.ended(event.toolCallId);
  });

  registerReadErrorHint(pi, () => process.env.PI_DENT_SESSION_DIR);

  pi.on("tool_result", async (event, ctx) => {
    const sid = ctx?.sessionManager?.getSessionId?.() ?? currentHost?.sessionId();
    if (!sid) return;
    for (const file of extractChangedFiles(
      event.toolName,
      event.input,
      "details" in event ? event.details : undefined,
      event.isError,
    )) {
      fleet.recordTurnFile(sid, file);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const sid = ctx?.sessionManager?.getSessionId?.() ?? currentHost?.sessionId();
    if (sid) fleet.recordTurnEnd(sid);
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    return { block: true, reason: BASH_BLOCKED_REASON };
  });

  pi.on("session_start", async (event, ctx) => {
    recap.abort();
    pluginUi.cancelAll("Session ended");
    await pluginUi.disposeProxy();
    currentProjectTrusted =
      typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
    // specs/billing.md#diagnostics: the diagnostics held with no open session go out first.
    sessionUi = ctx.ui;
    for (const diagnostic of heldDiagnostics.splice(0)) showDiagnostic(diagnostic);
    // specs/plugin.md#mcp-servers: register admitted plugins' HTTPS MCP servers with pi-mcp-adapter.
    pluginMcp.register();
    // specs/bash-tool.md#builtin-suppression: removed before the handler returns, whatever fails later.
    deactivateBuiltinBash(pi, ctx);
    // specs/ask-user-question-tool.md#activation and specs/schedule-tool.md#activation:
    // hidden in print and JSON mode (agent sessions) before the first model request.
    hideAskUserQuestionWithoutUi(pi, ctx);
    hideScheduleWithoutUi(pi, ctx);
    // specs/session-tool.md#environment-variable: expose the main session's kind in process.env.
    currentSessionKind = sessionKindForMain(ctx.hasUI);
    process.env[SESSION_KIND_ENV] = currentSessionKind;
    agentTool.refresh(modelCatalog(guidance, ctx.modelRegistry?.getAvailable() ?? []));
    currentHost = hostFromContext(pi, ctx);
    engine.resetRegistry();
    // specs/agent-tool.md#usage and specs/footer.md#activation: the tally restarts with the session.
    // While pi-dent draws the footer the tally is one of its segments and the key stays clear;
    // otherwise the status line follows every change while an interactive terminal UI is open.
    // The reset fires the listener installed here, which clears the key when there is no tally.
    stopUsageStatus?.();
    stopUsageStatus = undefined;
    // A footer the previous session's shutdown could not take down comes down here.
    if (stopFooter) {
      const previous = stopFooter;
      stopFooter = undefined;
      try {
        previous();
      } catch (error) {
        reportDiagnostic({
          level: "warning",
          message: `footer: the previous session's footer could not be restored: ${errorMessage(error)}`,
        });
      }
    }
    const interactive = ctx.hasUI && ctx.mode === "tui";
    const drewFooter = interactive && footerSettings.enabled ? installFooter(ctx) : false;
    if (interactive && !drewFooter) stopUsageStatus = followTallyStatus(ctx.ui);
    const sessionId = ctx.sessionManager.getSessionId();
    // specs/task-ledger.md#location: opened once per extension instance, before its first read or
    // write; an unusable ledger is told once through the session's UI.
    ledgerHolder.ledger ??= openTaskLedger({
      notify: (message) =>
        reportDiagnostic({ level: "warning", message: message.replace(/^pi-dent: /, "") }),
    });
    const ledger = ledgerHolder.ledger;
    ledgerSessionId = sessionId;
    ledgerCwd = ctx.cwd;
    writeSessionRow(ctx);
    // specs/agent-tool.md#usage: the tally restarts partial and is seeded by a read issued now,
    // applied in the ledger order; a read that is not ok leaves it partial.
    const seed = usageTally.reset();
    void ledger.readAgentFigures(sessionId).then((read) => {
      if (read.status === "ok") seed(read.value);
    });
    window.activeSessions.add(sessionId);
    fleet.markMainSession(sessionId);
    // specs/schedule-tool.md#firing and specs/schedule-tool.md#schedule-status-line: wired before any step that may throw,
    // so a reload's pending schedules resume even when a later step fails. The
    // window reads live host state, so it is dropped at session_shutdown.
    const scheduleWindow: ScheduleWindow = {
      send: (message) => pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" }),
      setStatus: (text) => ctx.ui.setStatus(SCHEDULE_STATUS_KEY, text),
      notify: (text) => ctx.ui.notify(text, "error"),
      get interactive() {
        return ctx.hasUI && ctx.mode === "tui";
      },
      isRunning: () => ctx.signal !== undefined,
      isIdle: () => ctx.isIdle(),
    };
    schedules.sessionStart({ sessionId, reason: event.reason, window: scheduleWindow });
    openMainSessionDir(ctx.sessionManager.getSessionFile(), sessionId);
    const agentsDir = agentsDirFor(ctx.sessionManager.getSessionFile(), sessionId);
    const registered = fleet.registerEndpoint(
      {
        sessionId,
        agentsDir,
        cwd: () => ctx.cwd,
        isIdle: () => ctx.isIdle(),
        abortTurn: () => ctx.abort(),
        deliverTurn: (text, mode) => pi.sendUserMessage(text, { deliverAs: mode }),
        notify: (message) => ctx.ui.notify(message, "warning"),
        runBuiltinCommand: (name) => {
          if (name === "compact") {
            ctx.compact();
            return true;
          }
          if (name === "abort") {
            ctx.abort();
            return true;
          }
          return false;
        },
        runQuery: (query) =>
          currentHost
            ? engine.runIsolatedQuery(currentHost, query, ledgerScope)
            : Promise.resolve({ text: "no live host session for the query", isError: true }),
      },
      ctx.isIdle() ? "idle" : "running",
    );
    if (registered) {
      // specs/task-record.md#rebuild: the rebuild belongs to the boot window that owns
      // the session; a refused registration inserts no row and changes no record.
      rebuildInterruptedTasks(
        engine.registry,
        agentsDir,
        undefined,
        (message) => ctx.ui.notify(message, "warning"),
        // specs/task-ledger.md#rebuild: each inserted row finds its ledger row.
        { ledger, sessionId },
      );
    } else {
      ctx.ui.notify(`pi-dent: ${ownedElsewhereWarning(sessionId)}`, "warning");
    }
    // The retention sweep runs once per boot window, after this session's agent
    // directory exists and its record is written (specs/agent-tool.md#retention-sweep).
    if (!window.swept) {
      window.swept = true;
      retentionSweep(boot.sessionTtlDays, fleet.liveAgentDirs());
      // The index prune runs after the sweep, whether or not it deleted anything
      // (specs/agent-tool.md#retention-sweep; specs/session-index.md#index-prune).
      void pruneSessionIndex().catch(() => {
        // A prune that fails reports nothing and deletes no file.
      });
    }
    // Task tree widget (specs/task.md#task-tree-widget): only with an interactive TUI,
    // placed above the editor; stopping clears it.
    closeTaskBrowser?.();
    taskWidget?.stop();
    if (ctx.hasUI && ctx.mode === "tui") {
      const ui = ctx.ui;
      taskWidget = startTaskWidget(engine.registry, {
        setWidget: (key, factory) => {
          if (factory)
            ui.setWidget(key, (tui, theme) => factory(tui, themePaint(theme)), {
              placement: "aboveEditor",
            });
          else ui.setWidget(key, undefined);
        },
      });
    } else {
      taskWidget = undefined;
    }
    taskFeed?.stop();
    fleetFeed?.stop();
    taskDetail?.stop();
    taskFeed = undefined;
    fleetFeed = undefined;
    taskDetail = undefined;
    if (feedsAnnounced({ env: process.env, hasUI: ctx.hasUI, mode: ctx.mode })) {
      const ui = ctx.ui;
      const host = {
        setWidget: (key: string, lines: string[] | undefined) => ui.setWidget(key, lines),
      };
      taskFeed = startTaskFeed(engine.registry, host);
      fleetFeed = startFleetFeed({ fleet, sessionId, cwd: ctx.cwd, host });
    }
    taskDetail = openTaskDetailFeed(
      { env: process.env, hasUI: ctx.hasUI, mode: ctx.mode },
      {
        registry: engine.registry,
        host: { setWidget: (key, lines) => ctx.ui.setWidget(key, lines) },
        zone,
        readSession: (path) => {
          try {
            return readFileSync(path, "utf8");
          } catch {
            return;
          }
        },
        ticker: {
          start: (tick) => {
            const handle = setInterval(tick, TASK_DETAIL_INTERVAL_MS);
            return () => clearInterval(handle);
          },
        },
      },
    );
    reportDiagnostics(ctx, window);
    guidanceCtl.sessionStart(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    // specs/task-ledger.md#session-row-writes: a compaction summary rewrites the ledger session row; the host
    // saved the compaction entry before this event, as it saves a branch summary's below.
    writeSessionRow(ctx);
    await guidanceCtl.sessionCompact(ctx);
  });

  pi.on("session_tree", async (event, ctx) => {
    // specs/task-ledger.md#session-row-writes: so does a branch summary.
    if (event.summaryEntry !== undefined) writeSessionRow(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    await guidanceCtl.modelSelect(ctx, event.model ?? ctx.model ?? null);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    recap.abort();
    await pluginMcp.dispose();
    // Every open question ends with the shutdown result (specs/ask-user-question-tool.md#no-answers), whatever fails later in this handler.
    const questionSessionId = ctx?.sessionManager?.getSessionId?.() ?? currentHost?.sessionId();
    if (questionSessionId) questions.sessionShutdown(questionSessionId);
    guidanceCtl.shutdown();
    // Ending the main session clears the widget (specs/task.md#task-tree-widget); the UI
    // may already be gone at shutdown.
    // Each stop runs on its own, so a failing one cannot leave the fleet feed's timer running.
    for (const stop of [
      () => fleetFeed?.stop(),
      () => taskFeed?.stop(),
      () => taskDetail?.stop(),
      () => closeTaskBrowser?.(),
      () => taskWidget?.stop(),
    ]) {
      try {
        stop();
      } catch {
        // Best effort.
      }
    }
    taskWidget = undefined;
    taskFeed = undefined;
    fleetFeed = undefined;
    // specs/agent-tool.md#usage: the usage status line ends with the session, a reload's too.
    stopUsageStatus?.();
    stopUsageStatus = undefined;
    try {
      ctx?.ui?.setStatus(USAGE_STATUS_KEY, undefined);
    } catch {
      // The UI may already be gone at shutdown; no failure is reported (specs/agent-tool.md#usage).
    }
    taskDetail = undefined;
    // Owned tasks live and die with the main session. Each step runs on its own and reports its
    // failure, so a throwing step cannot leave a task run, a search continuation, or a schedule
    // behind.
    const reportShutdown = (message: string): void => {
      ctx?.ui?.notify(message, "warning");
    };
    // specs/footer.md#activation: the built-in footer comes back with the session, a reload's too.
    if (stopFooter) {
      const restore = stopFooter;
      stopFooter = undefined;
      shutdownStep("restoring the built-in footer", restore, reportShutdown);
    }
    shutdownStep("ending owned tasks", () => engine.registry.end(), reportShutdown);
    shutdownStep("cancelling owned task runs", () => engine.cancelAll(), reportShutdown);
    // specs/task-ledger.md#session-row-writes, then specs/task-ledger.md#concurrent-access: the connection closes once the writes issued so
    // far are applied; a settlement issued later opens it again.
    shutdownStep("writing the task ledger session row", () => writeSessionRow(ctx), reportShutdown);
    shutdownStep("closing the task ledger", () => ledgerHolder.ledger?.close(), reportShutdown);
    shutdownStep(
      "cancelling plugin UI calls",
      () => pluginUi.cancelAll("Session ended"),
      reportShutdown,
    );
    try {
      await pluginUi.disposeProxy();
    } catch (error) {
      reportShutdown(`pi-dent: disposing plugin UI tool proxy failed: ${errorMessage(error)}`);
    }
    // The Search tool's continuations of catch-up end with the boot window
    // (specs/search-tool.md#coverage).
    shutdownStep("stopping Search", () => search.stop(), reportShutdown);
    const sid = ctx?.sessionManager?.getSessionId?.() ?? currentHost?.sessionId();
    if (sid) {
      window.activeSessions.delete(sid);
      shutdownStep(
        "ending the session's schedules",
        () => schedules.sessionShutdown({ sessionId: sid, reason: event.reason }),
        reportShutdown,
      );
      // Refresh the directory's age before the record leaves the store (specs/agent-tool.md#retention-sweep).
      closeMainSessionDir(ctx?.sessionManager?.getSessionFile?.(), sid);
      if (event.reason === "reload") {
        // A reload neither ends the session nor cancels pending messages
        // (specs/fleet-tool.md#status): release ownership, keep queues.
        fleet.releaseEndpointForReload(sid);
      } else {
        fleet.unregisterEndpoint(sid);
      }
    }
    if (event.reason === "reload" || event.reason === "quit") {
      if (activeBootWindow === window) {
        activeBootWindow = undefined;
      }
      if (window.activeSessions.size === 0) {
        fleet.close(event.reason === "reload" ? { keepPending: true } : undefined);
      }
    }
    // specs/session-tool.md#environment-variable: unset PI_DENT_SESSION_KIND when it still holds this session's value.
    if (currentSessionKind !== undefined && process.env[SESSION_KIND_ENV] === currentSessionKind) {
      delete process.env[SESSION_KIND_ENV];
    }
    currentSessionKind = undefined;
    // The pi ctx behind the host is stale from here on.
    currentHost = undefined;
    // specs/billing.md#diagnostics: the next diagnostic waits for the next session_start.
    sessionUi = undefined;
  });

  // Task browser (task-browser.md): the shortcut opens the overlay; the overlay closes itself on it.
  const taskBrowserShortcut = parseTaskBrowser(boot.config).shortcut;
  const toggleTaskBrowser = async (ctx: ExtensionContext): Promise<void> => {
    if (closeTaskBrowser) {
      closeTaskBrowser();
      return;
    }
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const registry = engine.registry;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          const overlay = new TaskBrowserOverlay({
            registry,
            zone,
            tui,
            theme,
            shortcut: taskBrowserShortcut,
            highlightCode: hostHighlightCode,
            readSession: (path) => {
              try {
                return readFileSync(path, "utf8");
              } catch {
                return;
              }
            },
            done: () => done(),
            // The host may dispose the component without calling `done`.
            onDispose: () => {
              closeTaskBrowser = undefined;
            },
            onError: (message) => ctx.ui.notify(message, "error"),
          });
          closeTaskBrowser = () => overlay.close();
          return overlay;
        },
        {
          overlay: true,
          overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
        },
      );
    } finally {
      closeTaskBrowser = undefined;
    }
  };
  pi.registerShortcut(taskBrowserShortcut, {
    description: "Open the task browser",
    handler: toggleTaskBrowser,
  });
  pi.registerCommand("recap", {
    description: "Recap the current session",
    handler: async (_args, ctx) => recap.run(ctx),
  });

  pi.registerCommand("tasks", {
    description: "Open the task browser",
    handler: async (args, ctx) => {
      // With arguments the verbs serve an RPC client (specs/slash-commands.md#tasks).
      if (args.trim() === "") return toggleTaskBrowser(ctx);
      runTasksVerb(args, {
        feed: taskDetail,
        error: (message) => ctx.ui.notify(message, "error"),
      });
    },
  });
  pi.registerCommand("fleet", {
    description: "List sibling sessions and query one",
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? currentHost?.sessionId();
      // A session without a live identity has no siblings and no sender
      // (specs/slash-commands.md#fleet).
      if (!sessionId) return;
      await runFleetCommand(args, {
        fleet,
        sessionId,
        cwd: ctx.cwd ?? currentHost?.cwd() ?? process.cwd(),
        ui: {
          interactive: ctx.hasUI && ctx.mode === "tui",
          select: (title, options) => ctx.ui.select(title, options),
          input: (title) => ctx.ui.input(title),
          notify: (message, level) => ctx.ui.notify(message, level),
        },
      });
    },
  });
  registerOwnedTool(
    makeTaskTool({ registry: () => engine.registry, ledger: () => ledgerHolder.ledger }),
  );
  registerOwnedTool(makePluginTool(boot));
  registerOwnedTool(makeFleetTool({ fleet, hostProvider: () => currentHost }));
  registerOwnedTool(
    makeSessionTool({
      boot,
      hostProvider: () => currentHost,
      billing: guidanceCtl.billing,
      ledger: { holder: ledgerHolder },
    }),
  );
  // The main session binds `Skill` and carries the skill catalog like any
  // child whose tool cap includes it, clearing the host's own skill list on
  // every turn (specs/skill-tool.md#binding). Plugin context blocks follow the
  // skill catalog on every turn (specs/plugin.md#plugin-context).
  if (boot.skills.length > 0) registerOwnedTool(makeSkillTool(boot));
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.systemPromptOptions?.skills) event.systemPromptOptions.skills.length = 0;
    const basePrompt = event.systemPrompt;
    const withSkills =
      boot.skills.length > 0 && pi.getActiveTools().includes("Skill")
        ? appendSkillCatalog(basePrompt, boot.skills)
        : basePrompt;
    const withPlugins = appendPluginContext(withSkills, boot.plugins);
    const kind = ctx?.hasUI === undefined ? currentSessionKind : sessionKindForMain(ctx.hasUI);
    const systemPrompt = kind === undefined ? withPlugins : appendSessionMode(withPlugins, kind);
    return systemPrompt === basePrompt ? undefined : { systemPrompt };
  });
  pi.registerTool(
    makeScriptTool({
      boot,
      registry: () => engine.registry,
      hostProvider: () => currentHost,
      cohortFor: (toolCallId) => cohorts.cohortFor(toolCallId),
      agentDir: agentDirForHost,
      // specs/script-tool.md#configuration; its diagnostics are boot diagnostics.
      toolsAllow: () => scriptToolsAllow,
    }),
  );
  registerOwnedTool(
    makeBashTool({
      registry: () => engine.registry,
      hostProvider: () => currentHost,
      cohortFor: (toolCallId) => cohorts.cohortFor(toolCallId),
      agentDir: agentDirForHost,
      // specs/bash-tool.md#execution-model: a settings file that cannot be read is reported once
      // per boot window through this instance's diagnostics.
      settings: bashSettings,
    }),
  );
  // The main session schedules into itself; a child never binds Schedule
  // (specs/agent-tool.md#tools).
  registerOwnedTool(makeScheduleTool(schedules));
  // The main session asks the user; a child never binds AskUserQuestion
  // (specs/agent-tool.md#tools).
  pi.registerTool(makeAskUserQuestionTool(questions));
  // `Search` is registered for the main session, which reaches its own session
  // tree and, on request, its project (specs/search-tool.md#registration).
  registerOwnedTool(
    makeSearchTool({
      runtime: search,
      host: (ctx) => {
        const sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? currentHost?.sessionFile();
        const sessionId = ctx?.sessionManager?.getSessionId?.() ?? currentHost?.sessionId() ?? "";
        return { sessionFile, agentDirectory: agentsDirFor(sessionFile, sessionId), main: true };
      },
    }),
  );
  // `Markdown` reads and restructures one Markdown file by its headings
  // (pi-dent-markdown specs/markdown-tool.md Section 1); a child session binds it under the tool cap
  // (specs/agent-tool.md#tools).
  registerOwnedTool(makeMarkdownTool(markdownRuntime()));

  // Plugin slash commands (specs/plugin.md#slash-commands): one command per
  // commands/*.md resource of the first-admitted plugin per namespace,
  // invoked as /<namespace>:<command>; the body is read fresh, substituted,
  // and delivered as one user message.
  for (const plugin of boot.pluginIndex.values()) {
    for (const command of plugin.commands) {
      pi.registerCommand(`${plugin.name}:${command.name}`, {
        ...(command.description === undefined ? {} : { description: command.description }),
        handler: async (args, ctx) => {
          let body: string;
          try {
            body = renderPluginCommand(plugin.root, command.name, args);
          } catch (error) {
            ctx.ui.notify(
              `pi-dent: ${plugin.name}:${command.name}: ${errorMessage(error)}`,
              "error",
            );
            return;
          }
          await pi.sendUserMessage(body, { deliverAs: "followUp" });
        },
      });
    }
  }

  pi.registerCommand("dent-ui", {
    description: "Run and cancel plugin UI script calls",
    handler: async (args, ctx) => {
      if (ctx.mode !== "rpc") return;
      pluginUi.handleCommand(args, {
        cwd: ctx.cwd ?? currentHost?.cwd() ?? process.cwd(),
        setWidget: (key, lines) => ctx.ui.setWidget(key, lines),
        toolContext: makeUiToolContext(ctx),
      });
    },
  });

  pi.registerCommand("dent", {
    description: "Confirm the pi-dent extension is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `pi-dent extension is loaded (${boot.agents.length} agents, ${boot.skills.length} skills, ${boot.plugins.length} plugins, ${boot.diagnostics.length} boot diagnostics)`,
        "info",
      );
    },
  });
}
