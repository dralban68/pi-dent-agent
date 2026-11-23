import { randomBytes } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { PluginEntry } from "./plugins.ts";
import { startFixturesWorker, type FixturesWorkerHandle } from "./plugin-ui-fixtures.ts";
import { PLUGIN_UI_EXCLUDED_TOOLS } from "./plugin-ui.ts";
import type { ScriptRunTools } from "./script-runner.ts";
import { toolDeclarations } from "./script-tool-types.ts";
import { errorMessage, isPlainObject } from "./util.ts";

/**
 * `PluginUI` tool and inspection controller (specs/plugin-ui-tool.md,
 * specs/plugin-ui.md Sections 7 and 8).
 */

export const PLUGIN_UI_INSPECT_WIDGET_KEY = "pi-dent-ui-inspect";
export const PLUGIN_UI_INSPECT_PROTOCOL = "inspect/1";
export const PLUGIN_UI_INSPECT_RECORD_CAP_BYTES = 262_144;
export const PLUGIN_UI_INSPECT_TEXT_CAP_CHARS = 20_000;
export const PLUGIN_UI_INSPECT_ATTACHMENT_CAP_BYTES = 8_388_608;
export const PLUGIN_UI_SHOT_WAIT_MS = 45_000;
export const PLUGIN_UI_CHECK_DEFAULT_TIMEOUT_MS = 120_000;
export const PLUGIN_UI_CHECK_WAIT_GRACE_MS = 30_000;

export type CheckBackend = "fixtures" | "live" | "none";

export function pluginUiInspectEnabled(
  env: Readonly<Record<string, string | undefined>>,
  mode: string | undefined,
): boolean {
  return mode === "rpc" && env.PI_DENT_UI_INSPECT === "1";
}

export const pluginUiParameterSchema = Type.Object(
  {
    action: StringEnum(["shot", "check"] as const, {
      description:
        "Operation: `shot` captures a screenshot of the plugin UI; `check` runs steps and returns a report.",
    }),
    plugin: Type.String({
      description: "Required. Namespace of an admitted plugin in the plugin catalog.",
    }),
    steps: Type.Optional(
      Type.Array(Type.Object({}, { additionalProperties: true }), {
        maxItems: 100,
        description:
          "For `check` only: ordered page steps (click, type, select, wait, waitFor, scroll, eval, screenshot). Default [].",
      }),
    ),
    tools: Type.Optional(
      Type.String({
        description:
          "For `check` only (exclusive with `live: true`): path to a JS/TS fixtures module replacing tool calls only; relative resolves against session cwd.",
      }),
    ),
    live: Type.Optional(
      Type.Boolean({
        description:
          "For `check` only (exclusive with `tools`): true passes the session's real tools so the page's writes reach the real system. Default false.",
      }),
    ),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1000,
        maximum: 600000,
        description:
          "For `check` only: check limit in milliseconds, 1000 to 600000. Default 120000.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type PluginUiToolParams = Static<typeof pluginUiParameterSchema>;

const CHECK_ONLY_FIELDS = new Set(["steps", "tools", "live", "timeout"]);
const SCREENSHOT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isValidSelector(value: unknown): value is string {
  return (
    typeof value === "string" && value.length >= 1 && value.length <= 4096 && value.trim() !== ""
  );
}

function validateSteps(steps: readonly unknown[]): string | undefined {
  let screenshots = 0;
  const seenScreenshots = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!isPlainObject(step)) return `steps[${i}]: step must be an object`;
    const keys = Object.keys(step);
    if (keys.length !== 1) return `steps[${i}]: step must have exactly one member`;
    const key = keys[0];
    if (key === undefined) return `steps[${i}]: step must have exactly one member`;
    const arg = step[key];
    switch (key) {
      case "click":
      case "waitFor":
        if (!isValidSelector(arg)) {
          return `steps[${i}]: ${key} requires a non-blank selector (1 to 4096 characters)`;
        }
        break;
      case "type":
      case "select":
        if (
          !Array.isArray(arg) ||
          arg.length !== 2 ||
          !isValidSelector(arg[0]) ||
          typeof arg[1] !== "string"
        ) {
          return `steps[${i}]: ${key} requires [selector, string]`;
        }
        break;
      case "wait":
        if (typeof arg !== "number" || !Number.isInteger(arg) || arg < 0 || arg > 60_000) {
          return `steps[${i}]: wait requires an integer from 0 to 60000`;
        }
        break;
      case "scroll":
        if (
          !isValidSelector(arg) &&
          !(typeof arg === "number" && Number.isInteger(arg) && arg >= 0 && arg <= 10_000_000)
        ) {
          return `steps[${i}]: scroll requires a selector or an integer from 0 to 10000000`;
        }
        break;
      case "eval":
        if (typeof arg !== "string" || arg.length < 1 || arg.length > 65_536 || arg.trim() === "") {
          return `steps[${i}]: eval requires a non-blank expression (1 to 65536 characters)`;
        }
        break;
      case "screenshot": {
        if (typeof arg !== "string" || !SCREENSHOT_NAME_RE.test(arg)) {
          return `steps[${i}]: screenshot name must be 1 to 64 characters of A-Z, a-z, 0-9, _, -`;
        }
        const lower = arg.toLowerCase();
        if (lower === "load") return `steps[${i}]: screenshot name cannot be "load"`;
        if (seenScreenshots.has(lower)) {
          return `steps[${i}]: duplicate screenshot name "${arg}"`;
        }
        seenScreenshots.add(lower);
        screenshots++;
        break;
      }
      default:
        return `steps[${i}]: unknown step action "${key}"`;
    }
  }
  if (screenshots > 16) return "at most 16 screenshot steps";
  return undefined;
}

/** Active check context exposed to `PluginUiController` for `/dent-ui run` with `check`. */
export interface ActiveUiCheck {
  readonly id: string;
  readonly backend: CheckBackend;
  readonly stateDir: string | undefined;
  readonly fixtures: FixturesWorkerHandle | undefined;
}

interface PendingInspection {
  readonly id: string;
  readonly action: "shot" | "check";
  readonly backend: CheckBackend | undefined;
  readonly outputDir: string;
  readonly stateDir: string | undefined;
  readonly fixtures: FixturesWorkerHandle | undefined;
  readonly setWidget: (key: string, lines: string[] | undefined) => void;
  cancelSent: boolean;
  settled: boolean;
  resolveResult: (outcome: InspectionOutcome) => void;
}

type InspectionOutcome =
  | { kind: "result"; ok: true }
  | { kind: "result"; ok: false; error: string }
  | { kind: "timeout"; ms: number }
  | { kind: "aborted" }
  | { kind: "session-ended" };

export interface PluginUiInspectDeps {
  readonly pluginIndex: ReadonlyMap<string, PluginEntry>;
  readonly cancelCheckCalls: (checkId: string, reason: string) => void;
  readonly shotWaitMs?: number;
  readonly checkWaitGraceMs?: number;
}

export interface PluginUiInspectContext {
  readonly cwd: string;
  readonly agentDir: string;
  readonly setWidget: (key: string, lines: string[] | undefined) => void;
  readonly signal?: AbortSignal | undefined;
}

interface PluginUiResultDetails {
  action: "shot" | "check";
  plugin: string;
  outputDir: string;
  reportPath: string;
  screenshots: string[];
  ok: boolean;
}

type ToolContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface PluginUiToolResult {
  content: ToolContentPart[];
  details: PluginUiResultDetails | Record<string, never>;
  isError?: boolean;
}

function errorResult(message: string): PluginUiToolResult {
  return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

function unavailableReply(name: string) {
  return {
    ok: false as const,
    error: { name: "Error", message: `tool ${name} is unavailable in a plugin UI call` },
  };
}

/** Build `ScriptRunTools` for a non-live check backend (`fixtures` or `none`). */
export function buildCheckRunTools(check: ActiveUiCheck): ScriptRunTools {
  const declarations = toolDeclarations({ bound: [], unbound: [] });
  if (check.backend === "none" || !check.fixtures) {
    return {
      names: [],
      unavailableNames: [],
      declarations,
      call: async (name) => unavailableReply(name),
    };
  }
  const fixtures = check.fixtures;
  const allowed = fixtures.names.filter((name) => !PLUGIN_UI_EXCLUDED_TOOLS.has(name));
  const allowedSet = new Set(allowed);
  const excluded = fixtures.names.filter((name) => PLUGIN_UI_EXCLUDED_TOOLS.has(name));
  return {
    names: allowed,
    unavailableNames: excluded,
    declarations,
    call: async (name, args, signal) => {
      if (!allowedSet.has(name)) return unavailableReply(name);
      return fixtures.call(name, args, signal);
    },
  };
}

function rewriteReportScreenshots(report: Record<string, unknown>, outputDir: string): string[] {
  const screenshots: string[] = [];
  if (typeof report.screenshot === "string") {
    const abs = resolve(outputDir, report.screenshot);
    report.screenshot = abs;
    screenshots.push(abs);
  }
  if (Array.isArray(report.screenshots)) {
    const rewritten: unknown[] = [];
    for (const item of report.screenshots) {
      if (typeof item === "string") {
        const abs = resolve(outputDir, item);
        rewritten.push(abs);
        if (!screenshots.includes(abs)) screenshots.push(abs);
      } else {
        rewritten.push(item);
      }
    }
    report.screenshots = rewritten;
  }
  if (Array.isArray(report.steps)) {
    for (const step of report.steps) {
      if (!isPlainObject(step)) continue;
      const isShotStep =
        step.action === "screenshot" || step.type === "screenshot" || step.step === "screenshot";
      if (isShotStep && typeof step.result === "string") {
        step.result = resolve(outputDir, step.result);
      }
    }
  }
  return screenshots;
}

export class PluginUiInspectController {
  private readonly deps: PluginUiInspectDeps;
  private seq = 0;
  private pending: PendingInspection | undefined;

  constructor(deps: PluginUiInspectDeps) {
    this.deps = deps;
  }

  /** Return the active check if `id` names a `check` inspection in progress. */
  getActiveCheck(id: string): ActiveUiCheck | undefined {
    if (!this.pending || this.pending.action !== "check" || this.pending.id !== id) {
      return undefined;
    }
    if (this.pending.backend === undefined) return undefined;
    return {
      id: this.pending.id,
      backend: this.pending.backend,
      stateDir: this.pending.stateDir,
      fixtures: this.pending.fixtures,
    };
  }

  /** Handle `/dent-ui result <json>` (specs/plugin-ui.md Section 8). */
  handleResult(rawJson: string): void {
    const current = this.pending;
    if (!current || current.settled) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return;
    }
    if (!isPlainObject(parsed) || parsed.id !== current.id) return;
    if (parsed.ok === true) {
      current.resolveResult({ kind: "result", ok: true });
    } else if (parsed.ok === false && typeof parsed.error === "string") {
      current.resolveResult({ kind: "result", ok: false, error: parsed.error });
    }
  }

  /** Settle any in-progress inspection on session end/switch (specs/plugin-ui.md Section 6). */
  cancelAll(): void {
    const current = this.pending;
    if (!current || current.settled) return;
    current.resolveResult({ kind: "session-ended" });
  }

  /** Execute one `PluginUI` tool call (specs/plugin-ui-tool.md Sections 2, 3, 4, 5, 6). */
  async execute(
    params: PluginUiToolParams,
    ctx: PluginUiInspectContext,
  ): Promise<PluginUiToolResult> {
    // 1. Concurrent inspection check.
    if (this.pending !== undefined) {
      return errorResult("another PluginUI call is running");
    }

    const action =
      params.action === "check" ? "check" : params.action === "shot" ? "shot" : undefined;
    if (action === undefined) {
      return errorResult(`unknown action "${String(params.action)}"`);
    }

    // 2. Action-specific field check, in arguments' property order.
    if (action === "shot") {
      for (const [key, val] of Object.entries(params)) {
        if (val !== undefined && CHECK_ONLY_FIELDS.has(key)) {
          return errorResult(`field "${key}" is not valid for action "shot"`);
        }
      }
    }

    // 3. Plugin lookup.
    const plugin =
      params.plugin.trim() === "" ? undefined : this.deps.pluginIndex.get(params.plugin);
    if (!plugin) {
      return errorResult(`unknown plugin "${params.plugin}"`);
    }

    // 4. `tools` and `live: true` mutual exclusion.
    if (params.tools !== undefined && params.live === true) {
      return errorResult("tools and live are mutually exclusive");
    }

    const steps = params.steps ?? [];
    const timeout = params.timeout ?? PLUGIN_UI_CHECK_DEFAULT_TIMEOUT_MS;

    // 5 & 6. Steps and screenshot count validation.
    if (action === "check") {
      const stepError = validateSteps(steps);
      if (stepError !== undefined) return errorResult(stepError);
    }

    const id = `i${++this.seq}-${randomBytes(4).toString("hex")}`;
    const outputDir = join(ctx.agentDir, "output", `ui-${id}`);
    const backend: CheckBackend | undefined =
      action === "check"
        ? params.tools === undefined
          ? params.live === true
            ? "live"
            : "none"
          : "fixtures"
        : undefined;
    const stateDir =
      action === "check" && backend !== "live"
        ? join(ctx.agentDir, "output", `ui-${id}-state`)
        : undefined;

    const record =
      action === "shot"
        ? {
            piDent: PLUGIN_UI_INSPECT_PROTOCOL,
            type: "shot",
            id,
            namespace: plugin.name,
            root: plugin.root,
            out: outputDir,
          }
        : {
            piDent: PLUGIN_UI_INSPECT_PROTOCOL,
            type: "check",
            id,
            namespace: plugin.name,
            root: plugin.root,
            out: outputDir,
            steps,
            timeout,
            ...(stateDir === undefined ? {} : { state: stateDir }),
          };
    const recordLine = JSON.stringify(record);

    // 6b. Record byte-size cap (Section 4).
    if (
      action === "check" &&
      Buffer.byteLength(recordLine, "utf8") > PLUGIN_UI_INSPECT_RECORD_CAP_BYTES
    ) {
      return errorResult(`steps exceed ${PLUGIN_UI_INSPECT_RECORD_CAP_BYTES} bytes`);
    }

    // 7 & 8. Fixtures module readability and load.
    let fixtures: FixturesWorkerHandle | undefined;
    if (action === "check" && params.tools !== undefined) {
      const resolvedPath = resolve(ctx.cwd, params.tools);
      try {
        const st = statSync(resolvedPath);
        if (!st.isFile()) {
          return errorResult(`fixtures module not readable: ${resolvedPath}: not a regular file`);
        }
        accessSync(resolvedPath, constants.R_OK);
      } catch (error) {
        return errorResult(`fixtures module not readable: ${resolvedPath}: ${errorMessage(error)}`);
      }
      try {
        fixtures = await startFixturesWorker(resolvedPath, ctx.cwd);
      } catch (error) {
        return errorResult(`fixtures module not loaded: ${errorMessage(error)}`);
      }
    }

    // Create output directory (and scratch state directory when non-live check).
    try {
      mkdirSync(outputDir, { recursive: true });
    } catch (error) {
      await fixtures?.terminate();
      return errorResult(`failed to create output directory ${outputDir}: ${errorMessage(error)}`);
    }
    if (stateDir !== undefined) {
      try {
        mkdirSync(stateDir, { recursive: true });
      } catch (error) {
        await fixtures?.terminate();
        return errorResult(
          `failed to create scratch state directory ${stateDir}: ${errorMessage(error)}`,
        );
      }
    }

    const emitCancel = (entry: PendingInspection): void => {
      if (entry.cancelSent) return;
      entry.cancelSent = true;
      try {
        entry.setWidget(PLUGIN_UI_INSPECT_WIDGET_KEY, [
          JSON.stringify({ piDent: PLUGIN_UI_INSPECT_PROTOCOL, type: "cancel", id: entry.id }),
        ]);
      } catch {
        // Section 7 gap: a failed cancel setWidget is not retried.
      }
    };

    let resolveOutcome: (outcome: InspectionOutcome) => void = () => {};
    const outcomePromise = new Promise<InspectionOutcome>((res) => {
      resolveOutcome = res;
    });

    const entry: PendingInspection = {
      id,
      action,
      backend,
      outputDir,
      stateDir,
      fixtures,
      setWidget: ctx.setWidget,
      cancelSent: false,
      settled: false,
      resolveResult(outcome) {
        if (entry.settled) return;
        entry.settled = true;
        resolveOutcome(outcome);
      },
    };
    this.pending = entry;

    // Emit the shot/check record.
    try {
      ctx.setWidget(PLUGIN_UI_INSPECT_WIDGET_KEY, [recordLine]);
    } catch (error) {
      this.pending = undefined;
      entry.settled = true;
      await this.cleanupCheck(entry, "UI inspection request not sent");
      return errorResult(`UI inspection request not sent: ${errorMessage(error)}`);
    }

    const waitMs =
      action === "shot"
        ? (this.deps.shotWaitMs ?? PLUGIN_UI_SHOT_WAIT_MS)
        : timeout + (this.deps.checkWaitGraceMs ?? PLUGIN_UI_CHECK_WAIT_GRACE_MS);

    const timer = setTimeout(() => {
      entry.resolveResult({ kind: "timeout", ms: waitMs });
    }, waitMs);

    const onAbort = (): void => {
      entry.resolveResult({ kind: "aborted" });
    };
    if (ctx.signal?.aborted) {
      onAbort();
    } else if (ctx.signal) {
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    const outcome = await outcomePromise;
    clearTimeout(timer);
    if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
    if (this.pending === entry) this.pending = undefined;

    if (outcome.kind !== "result") {
      emitCancel(entry);
    }

    const cancelReason =
      outcome.kind === "session-ended"
        ? "Session ended"
        : outcome.kind === "aborted"
          ? "UI check aborted"
          : outcome.kind === "timeout"
            ? "UI check timed out"
            : "UI check finished";
    await this.cleanupCheck(entry, cancelReason);

    if (outcome.kind === "session-ended") {
      return errorResult("Session ended");
    }
    if (outcome.kind === "aborted") {
      return errorResult("Aborted");
    }
    if (outcome.kind === "timeout") {
      return errorResult(`Alpha did not answer the UI ${action} within ${outcome.ms} ms`);
    }
    if (!outcome.ok) {
      return errorResult(outcome.error);
    }

    return this.buildSuccessResult(action, plugin.name, outputDir, backend);
  }

  private async cleanupCheck(entry: PendingInspection, reason: string): Promise<void> {
    if (entry.action === "check") {
      this.deps.cancelCheckCalls(entry.id, reason);
    }
    if (entry.fixtures) {
      await entry.fixtures.terminate();
    }
    if (entry.stateDir !== undefined) {
      try {
        rmSync(entry.stateDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of scratch state directory.
      }
    }
  }

  private buildSuccessResult(
    action: "shot" | "check",
    pluginName: string,
    outputDir: string,
    backend: CheckBackend | undefined,
  ): PluginUiToolResult {
    const reportPath = join(outputDir, "report.json");
    let rawText: string;
    try {
      rawText = readFileSync(reportPath, "utf8");
    } catch (error) {
      return errorResult(`UI report not readable: ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      return errorResult(`UI report not readable: ${errorMessage(error)}`);
    }
    if (!isPlainObject(parsed) || parsed.alpha !== PLUGIN_UI_INSPECT_PROTOCOL) {
      return errorResult(
        `UI report not readable: expected object with alpha "${PLUGIN_UI_INSPECT_PROTOCOL}"`,
      );
    }

    const screenshots = rewriteReportScreenshots(parsed, outputDir);
    if (action === "check" && backend !== undefined) {
      parsed.backend = backend;
    }

    const imageParts: ToolContentPart[] = [];
    const notAttached: string[] = [];
    let attachedBytes = 0;
    for (const shotPath of screenshots) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(shotPath);
      } catch (error) {
        notAttached.push(`Not attached: ${shotPath}: ${errorMessage(error)}`);
        continue;
      }
      if (attachedBytes + bytes.byteLength > PLUGIN_UI_INSPECT_ATTACHMENT_CAP_BYTES) {
        notAttached.push(`Not attached: ${shotPath}: over the attachment bound`);
        continue;
      }
      attachedBytes += bytes.byteLength;
      imageParts.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: "image/png",
      });
    }

    let text = JSON.stringify(parsed, null, 2);
    if (text.length > PLUGIN_UI_INSPECT_TEXT_CAP_CHARS) {
      text = `${text.slice(0, PLUGIN_UI_INSPECT_TEXT_CAP_CHARS)}\n... [truncated] ...`;
    }
    for (const line of notAttached) {
      text += `\n${line}`;
    }
    text += `\nFull report: ${reportPath}`;

    const ok =
      action === "shot" ? true : isPlainObject(parsed.summary) && parsed.summary.ok === true;

    return {
      content: [{ type: "text", text }, ...imageParts],
      details: {
        action,
        plugin: pluginName,
        outputDir,
        reportPath,
        screenshots,
        ok,
      },
    };
  }
}

export const PLUGIN_UI_TOOL_DESCRIPTION = `Inspect a plugin UI rendered by Alpha: capture a screenshot (\`action: "shot"\`) or run scripted page steps with a report (\`action: "check"\`).

For \`check\`:
- Default (\`live: false\`, no \`tools\`): backend is \`none\` (all tool calls reject as unavailable; \`dent.state\` uses an isolated scratch store).
- \`tools: "<path>"\`: loads a fixtures module that replaces tool calls only (and \`dent.state\` uses an isolated scratch store); the plugin's own script code still runs with caller privileges.
- \`live: true\`: passes the session's real tools and real plugin state so the page's writes reach the real system. Exclusive with \`tools\`.`;

export function makePluginUiTool(
  controller: PluginUiInspectController,
  resolveContext: (
    ctx: { cwd: string; ui: { setWidget(key: string, lines: string[] | undefined): void } },
    signal: AbortSignal | undefined,
  ) => PluginUiInspectContext,
): ToolDefinition<typeof pluginUiParameterSchema> {
  return defineTool({
    name: "PluginUI",
    label: "PluginUI",
    description: PLUGIN_UI_TOOL_DESCRIPTION,
    promptSnippet: "Inspect a plugin UI in Alpha (screenshot or scripted check)",
    parameters: pluginUiParameterSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return controller.execute(params, resolveContext(ctx, signal));
    },
  });
}
