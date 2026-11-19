import { readFileSync } from "node:fs";
import { bundledAliases } from "./bundled.ts";
import type { PluginEntry } from "./plugins.ts";
import { resolvePluginScriptPath } from "./plugins.ts";
import { runScript, type ScriptRunHandle, type ScriptRunResult } from "./script-runner.ts";
import { errorCode, errorMessage, isPlainObject } from "./util.ts";

/**
 * Plugin UI protocol controller (specs/plugin-ui.md): handles `/dent-ui run`
 * and `/dent-ui cancel`, executes plugin scripts with `dent.ui.send` and no
 * time limit or tool functions, and emits `message` and `reply` records on the
 * `pi-dent-ui` widget feed.
 */

export const PLUGIN_UI_WIDGET_KEY = "pi-dent-ui";
export const PLUGIN_UI_PROTOCOL = "ui/1";
export const PLUGIN_UI_PAYLOAD_CAP_BYTES = 262_144;

export interface PluginUiCommandContext {
  cwd: string;
  setWidget(key: string, lines: string[] | undefined): void;
  extraEnv?: Record<string, string>;
}

interface ActiveUiCall {
  handle: ScriptRunHandle;
  cancelReason?: string;
}

function formatThrownError(
  error: { name: string; message: string; stack: string } | undefined,
): string {
  if (!error) return "Script threw an error";
  return error.message === "" ? error.name : `${error.name}: ${error.message}`;
}

export class PluginUiController {
  private readonly pluginIndex: ReadonlyMap<string, PluginEntry>;
  private readonly active = new Map<string, ActiveUiCall>();

  constructor(pluginIndex: ReadonlyMap<string, PluginEntry>) {
    this.pluginIndex = pluginIndex;
  }

  /** Number of UI calls currently executing. */
  activeCount(): number {
    return this.active.size;
  }

  /** Handle one `/dent-ui <args>` command (specs/plugin-ui.md Sections 1-3). */
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
    }
  }

  /** Cancel every executing UI call (specs/plugin-ui.md Section 6). */
  cancelAll(reason = "Session ended"): void {
    for (const entry of this.active.values()) {
      entry.cancelReason = reason;
      entry.handle.cancel("killed");
    }
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
    let handle: ScriptRunHandle;
    try {
      handle = runScript({
        code,
        filename: resolved.path,
        cwd: ctx.cwd,
        input: { ui: data },
        aliases: bundledAliases(),
        uiCall: true,
        ...(ctx.extraEnv && Object.keys(ctx.extraEnv).length > 0 ? { extraEnv: ctx.extraEnv } : {}),
        onUiMessage: (dataJson) => {
          emitMessageJson(dataJson);
        },
      });
    } catch (error) {
      emitReplyError(`Failed to start script: ${errorMessage(error)}`);
      return;
    }

    const entry: ActiveUiCall = { handle };
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
