import { appendFileSync, readFileSync } from "node:fs";
import { ledgerDispatched, ledgerToolLog } from "./task-ledger-wiring.ts";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { defineTool, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { BootSnapshot, ToolResult } from "./engine.ts";
import type { HostSession } from "./host.ts";
import type { ScriptTaskRow, TaskRegistry } from "./registry.ts";
import { bundledAliases } from "./bundled.ts";
import { resolveCwdParam } from "./cwd-param.ts";
import { ensureOutputDir, outputPathsFor } from "./output-file.ts";
import { resolvePluginScriptPath } from "./plugins.ts";
import { runScript, type ScriptRunHandle, type ScriptRunResult } from "./script-runner.ts";
import { callBoundTool } from "./script-tool-calls.ts";
import { ScriptToolLog } from "./script-tool-log.ts";
import { DEFAULT_TOOLS_ALLOW, selectTools, toolDeclarations } from "./script-tool-types.ts";
import { type ReturnValueRender } from "./script-render.ts";
import { renderCardCall } from "./tool-card.ts";
import {
  ProgressLines,
  labelFallback,
  rejectCall,
  renderToolCardResult,
  settleBackgroundFailure,
  textError,
} from "./tool-common.ts";
import { errorCode, errorMessage } from "./util.ts";

/**
 * The Script tool (specs/script-tool.md): in-process execution of agent-authored
 * JavaScript or TypeScript, its sources, inputs, results, timeout, and delivery
 * modes, and the tool functions through which a script calls the session's other tools
 * (specs/script-tool.md#tool-functions).
 */

export const scriptParameterSchema = Type.Object(
  {
    code: Type.Optional(
      Type.String({
        description:
          "Required unless plugin + path are given; exclusive with plugin and path. Inline JavaScript or TypeScript source; the run's return value is the top-level default export (export default <expr>), or without one the final top-level expression's value — with top-level await use export default. Blank values are treated as absent.",
      }),
    ),
    plugin: Type.Optional(
      Type.String({
        description:
          "Required with path for a plugin script; exclusive with code. Namespace of the plugin owning the script. Blank values are treated as absent.",
      }),
    ),
    path: Type.Optional(
      Type.String({
        description:
          "Required with plugin for a plugin script; exclusive with code. Plugin-relative path matching scripts/**/*.{js,ts,mjs,mts,cjs,cts}. Blank values are treated as absent.",
      }),
    ),
    input: Type.Optional(
      Type.Object(
        {},
        {
          description:
            "JSON-compatible object exposed as the input binding. A plugin script called without it returns its help.",
        },
      ),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Working directory observed by the script via process.cwd() (relative fs paths resolve against it); no cwd binding is defined. Relative values resolve against the invoking session's cwd; blank is absent; must exist and be a directory.",
      }),
    ),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 600000,
        description:
          "Per-call timeout in milliseconds, 1 to 600000. Omitted gives a foreground call 600000 ms and imposes no timeout on a background call.",
      }),
    ),
    background: Type.Optional(
      Type.Boolean({ description: "Background delivery mode (default false)." }),
    ),
    description: Type.Optional(Type.String({ description: "UI label for the call." })),
  },
  { additionalProperties: false },
);
export type ScriptToolParams = Static<typeof scriptParameterSchema>;

/** The timeout of a foreground call that omits `timeout` (specs/script-tool.md#parameter-schema). */
export const DEFAULT_TIMEOUT_MS = 600000;

/**
 * The timeout a call imposes (specs/script-tool.md#parameter-schema): an omitted `timeout` gives a foreground call
 * `DEFAULT_TIMEOUT_MS` and imposes none on a background call. The schema bounds a present value.
 */
export function resolveScriptTimeout(
  timeout: number | undefined,
  background: boolean,
): number | undefined {
  if (timeout === undefined) return background ? undefined : DEFAULT_TIMEOUT_MS;
  return timeout;
}

interface ScriptToolDeps {
  boot: BootSnapshot;
  registry: () => TaskRegistry;
  hostProvider: () => HostSession | undefined;
  cohortFor: (toolCallId: string) => string;
  /**
   * The agent directory of the session that invokes the task (specs/agent-tool.md#child-session); output files go under its `output/` (specs/script-tool.md#timeout-delivery).
   */
  agentDir: (host: HostSession) => string;
  /** Extra environment variables for the script worker, merged over process.env (never mutating it). */
  extraEnv?: () => Record<string, string> | undefined;
  /** `script.tools.allow` (specs/script-tool.md#configuration); absent gives the default. */
  toolsAllow?: () => readonly string[];
}

interface ResolvedSource {
  code: string;
  filename: string;
}

/** A value the tool treats as present (specs/script-tool.md#parameter-schema: blank values are absent). */
function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** The source shape of a call: inline `code`, or `plugin` with `path` (specs/script-tool.md#validation). */
type SourceShape =
  | { kind: "inline"; code: string }
  | { kind: "plugin"; plugin: string; path: string };

/**
 * specs/script-tool.md#validation: the source-shape check. It runs before the task row is registered,
 * so a call without exactly one source leaves no row and creates no file.
 */
function scriptSourceShape(params: ScriptToolParams): SourceShape | { error: string } {
  const code = isPresent(params.code) ? params.code : undefined;
  const plugin = isPresent(params.plugin) ? params.plugin : undefined;
  const path = isPresent(params.path) ? params.path : undefined;
  if ((code !== undefined) === (plugin !== undefined || path !== undefined)) {
    return {
      error:
        "exactly one source is required: non-blank code, or non-blank plugin plus non-blank path",
    };
  }
  if (code !== undefined) return { kind: "inline", code };
  if (plugin === undefined || path === undefined) {
    return { error: "plugin source requires both non-blank plugin and non-blank path" };
  }
  return { kind: "plugin", plugin, path };
}

function resolveScriptSource(
  shape: SourceShape,
  boot: BootSnapshot,
  cwd: string,
): ResolvedSource | { error: string } {
  if (shape.kind === "inline") {
    return { code: shape.code, filename: join(cwd, "__pi_dent_script__.ts") };
  }
  const plugin = boot.pluginIndex.get(shape.plugin);
  if (!plugin) {
    const namespaces = [...boot.pluginIndex.keys()].toSorted();
    return {
      error: `unknown plugin "${shape.plugin}". Known namespaces: ${
        namespaces.length > 0 ? namespaces.join(", ") : "(none)"
      }`,
    };
  }
  const resolved = resolvePluginScriptPath(plugin.root, shape.path);
  if ("error" in resolved) return { error: `plugin "${shape.plugin}": ${resolved.error}` };
  let code: string;
  try {
    code = readFileSync(resolved.path, "utf8");
  } catch (error) {
    const errCode = errorCode(error);
    return {
      error:
        errCode === "ENOENT"
          ? `plugin "${shape.plugin}": missing script ${resolved.path}`
          : `plugin "${shape.plugin}": failed to read ${resolved.path}: ${errCode ?? errorMessage(error)}`,
    };
  }
  return { code, filename: resolved.path };
}

/**
 * The row label of the call (specs/script-tool.md#timeout-delivery): `description`, else the plugin `path`,
 * else the first line of `code` without its leading white space. The source
 * shape of specs/script-tool.md#validation makes the fallback non-empty.
 */
function scriptLabel(params: ScriptToolParams, shape: SourceShape): string {
  if (isPresent(params.description)) return params.description;
  if (shape.kind === "plugin") return shape.path;
  return labelFallback(shape.code);
}

/** specs/script-tool.md#result-contract body layout. */
function buildBody(opts: {
  stdout: string;
  stderr: string;
  rendered?: string | undefined;
  exitReason: string;
  exitCode?: number | undefined;
  durationMs: number;
  renderJson?: string | undefined;
  browserKill?: boolean | undefined;
  /** The full JSON of a clipped return value; only the output file carries it (specs/script-tool.md#result-contract). */
  returnJson?: string | undefined;
  /** The output file path, when the body names the full return value (specs/script-tool.md#result-contract). */
  fullValuePath?: string | undefined;
  /** The `--- tool calls` block's line, when the run made nested calls (specs/script-tool.md#result-contract). */
  toolCallsLine?: string | undefined;
}): string {
  let text = opts.stdout;
  if (opts.stderr !== "") text += `\n--- stderr ---\n${opts.stderr}`;
  if (opts.rendered !== undefined) text += `\n--- return ---\n${opts.rendered}`;
  if (opts.fullValuePath !== undefined) text += `\nFull return value: ${opts.fullValuePath}`;
  if (opts.returnJson !== undefined) text += `\n--- return json ---\n${opts.returnJson}`;
  text += `\n--- exited ${opts.exitReason}${opts.exitCode === undefined ? "" : ` code=${opts.exitCode}`} in ${opts.durationMs}ms ---`;
  // A browser kill names its author in the body the model reads (specs/script-tool.md#result-contract).
  if (opts.browserKill === true) text += "\n--- killed by the user from the task browser ---";
  if (opts.toolCallsLine !== undefined) text += `\n${opts.toolCallsLine}`;
  if (opts.renderJson !== undefined) text += `\n--- return metadata ---\n${opts.renderJson}`;
  return text;
}

function isErrorExit(reason: string): boolean {
  return reason !== "ok" && reason !== "exit-called" && reason !== "running";
}

/** Task row status per specs/script-tool.md#timeout-delivery. */
function settleStatus(exitReason: string): "cancelled" | "failed" | "completed" {
  if (exitReason === "killed" || exitReason === "aborted") return "cancelled";
  if (exitReason === "timeout" || exitReason === "threw") return "failed";
  return "completed";
}

/**
 * specs/script-tool.md#execution-model error text for a `threw` settlement: `Name: message` and the stack,
 * each emitted once (a V8 stack already carries the header, though a script
 * compiled by the worker can put a source line before it). A settlement with no
 * stack still shows name and message.
 */
function thrownText(error: { name: string; message: string; stack: string } | undefined): string {
  if (error === undefined) return "";
  const header = `${error.name}: ${error.message}`;
  if (error.stack === "") return `${header}\n`;
  // A V8 stack of an error thrown from a compiled script can begin with the source
  // line, so the header is looked for anywhere in it, not just at its start.
  const hasHeader = error.stack.includes(header);
  return `${hasHeader ? error.stack : `${header}\n${error.stack}`}\n`;
}

/** Format a settled run into the specs/script-tool.md#result-contract body, details, and background suffix. */
function formatResult(
  result: ScriptRunResult,
  outputPath: string,
  toolCalls: { count: number; logPath: string; createdLogPath: string | undefined; taskId: string },
  browserKill = false,
): {
  text: string;
  details: Record<string, unknown>;
  isError: boolean;
  suffix: string;
  thrown: string;
} {
  const valueExported = result.exitReason === "ok";
  // A `threw` settlement's error text is appended to stderr (specs/script-tool.md#execution-model), whether
  // it came from the script body, an unhandled rejection, or the worker's death.
  const errorText = result.exitReason === "threw" ? thrownText(result.error) : "";
  const thrown =
    errorText !== "" && result.stderr !== "" && !result.stderr.endsWith("\n")
      ? `\n${errorText}`
      : errorText;
  const stderr = result.stderr + thrown;
  let rendered: string | undefined;
  let render: ReturnValueRender | undefined;
  let returnValue: unknown;
  if (valueExported) {
    // The worker rendered the return value BEFORE structured cloning (specs/script-tool.md#result-contract): a class instance would clone to a plain object and lose its `P { }`
    // rendering, and the JSON must come from the un-cloned value.
    rendered = result.rendered;
    render = result.render;
    returnValue = result.returnValue;
    if (returnValue === undefined) {
      returnValue = { type: "non-json-return-value", representation: rendered };
    }
  }
  const renderJson = render === undefined ? undefined : JSON.stringify(render);
  const clipped =
    render !== undefined && (render.stringsOverLimit > 0 || render.aggregateTruncated);
  const returnJson = clipped ? result.json : undefined;
  const toolCallsLine =
    toolCalls.count === 0
      ? undefined
      : `--- tool calls: ${toolCalls.count}; log: ${toolCalls.logPath}; Search it with session ${toolCalls.taskId} ---`;
  const text = buildBody({
    stdout: result.stdout,
    stderr,
    rendered,
    exitReason: result.exitReason,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    renderJson,
    browserKill,
    fullValuePath: returnJson === undefined ? undefined : outputPath,
    toolCallsLine,
  });
  const details: Record<string, unknown> = {
    stdout: result.stdout,
    stderr,
    exitReason: result.exitReason,
    truncated: result.truncated,
    durationMs: result.durationMs,
    toolCalls: toolCalls.count,
  };
  if (toolCalls.createdLogPath !== undefined) details.toolLogPath = toolCalls.createdLogPath;
  if (returnValue !== undefined) details.returnValue = returnValue;
  if (render !== undefined) details.returnValueRender = render;
  if (result.exitCode !== undefined) details.exitCode = result.exitCode;
  const suffix = buildBody({
    stdout: "",
    stderr: "",
    rendered,
    exitReason: result.exitReason,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    renderJson,
    browserKill,
    returnJson,
    toolCallsLine,
  });
  return { text, details, isError: isErrorExit(result.exitReason), suffix, thrown };
}

export function makeScriptTool(deps: ScriptToolDeps) {
  return defineTool({
    name: "Script",
    label: "Script",
    description:
      "Run one JavaScript or TypeScript program in a fresh worker thread with the caller's privileges and full Node capabilities: ESM, TypeScript syntax, top-level await, no build step, no state kept between calls. Source: inline `code`, or a plugin script (`plugin` + `path`). Imports: node:* builtins and the bundled cheerio, csv-parse, csv-stringify, fast-xml-parser, file-type, glob, gray-matter, ini, js-yaml, jsonc-parser, jszip, semver, smol-toml; any other package resolves from `cwd`, or for a plugin script from its own location. fetch and the other web globals are available; console output is captured. Child processes: use async `spawn`, `exec`, or `execFile` with `await`; `spawnSync`, `execSync`, and `execFileSync` throw. Every settled run terminates every process it spawned, so start a process that must outlive the run with `Bash` `background: true`. `tools.<Name>(args)` calls another tool of the session, MCP tools included, and resolves to `{ text, content, details, structured }` or rejects with the tool's error; `dent.toolTypes()` returns their TypeScript declarations. Tool calls are logged to a session file that `Search` reads by the run's task ID. `background: true` returns a task ID at once with a completion notification; in a user session, prefer it for long-running scripts so you do not block user input.",
    promptSnippet: "Run an in-process JavaScript or TypeScript program",
    parameters: scriptParameterSchema,
    // specs/script-tool.md#bound-tools: a call can reach every callable tool.
    reachesTools: () => "all",
    async execute(
      toolCallId: string,
      params: ScriptToolParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext | undefined,
    ): Promise<ToolResult> {
      const registry = deps.registry();
      // specs/script-tool.md#validation: the source shape is checked before the row is registered,
      // so a call without exactly one source leaves no row and creates no file.
      const shape = scriptSourceShape(params);
      if ("error" in shape) return textError(shape.error);

      const background = params.background === true;

      // Exactly one row per invocation, registered before execution begins
      // (specs/task.md#task-kinds); registration into a registry that is not live
      // fails the invocation as a tool error (specs/task-registry.md#ownership).
      let row: ScriptTaskRow;
      try {
        row = registry.register({
          kind: "script",
          cohort: deps.cohortFor(toolCallId),
          label: scriptLabel(params, shape),
          background,
          ...(shape.kind === "inline" ? { code: shape.code } : {}),
          toolCallId,
        });
      } catch (error) {
        return textError(`Script error: ${errorMessage(error)}`);
      }
      // A validation failure is a pre-start rejection: one failed row,
      // consumed (foreground rows are born consumed), tool error returned.
      const reject = (message: string): ToolResult => rejectCall(registry, row, message);

      // specs/script-tool.md#timeout-delivery: a cancellation before the worker starts must prevent the run, so
      // the handler is installed at registration; the run takes it over once it exists.
      let runCancel: (() => void) | undefined;
      let killedBeforeRun = false;
      row.cancel = () => {
        if (runCancel === undefined) killedBeforeRun = true;
        else runCancel();
      };

      const host = deps.hostProvider();
      if (!host) return reject("pi-dent: no live host session for the Script call");

      // specs/script-tool.md#validation, in order: cwd (specs/task.md#cwd-parameter), then the plugin source.
      const resolvedCwd = resolveCwdParam(params.cwd, host.cwd());
      if ("error" in resolvedCwd) return reject(resolvedCwd.error);
      const cwd = resolvedCwd.cwd ?? host.cwd();

      // Source resolution (specs/script-tool.md#validation).
      const source = resolveScriptSource(shape, deps.boot, cwd);
      if ("error" in source) return reject(source.error);
      // specs/task-registry.md#task-row: the row's code is the resolved source, the
      // plugin file's content included (specs/script-tool.md#result-contract).
      row.code = source.code;
      // The checks of specs/script-tool.md#validation passed (specs/task-ledger.md#ledger-row).
      ledgerDispatched(row, cwd);

      // Timeout (specs/script-tool.md#parameter-schema): 1..600000; omitted defaults for foreground only.
      const timeoutMs = resolveScriptTimeout(params.timeout, background);

      const agentDir = deps.agentDir(host);
      const { outputPath } = outputPathsFor(agentDir, row.taskId);

      // specs/script-tool.md#timeout-delivery: a kill that arrived before the run started settles `killed` with no
      // run; it takes the same settlement path as a run, so the output file gets its block.
      const notRun: ScriptRunResult = {
        stdout: "",
        stderr: "",
        truncated: { stdout: false, stderr: false },
        exitReason: "killed",
        durationMs: 0,
      };

      // An unexpected failure after registration must settle the row, never
      // leave it running (specs/script-tool.md#timeout-delivery).
      const failRun = (error: unknown): ToolResult =>
        reject(`Script error: ${errorMessage(error)}`);

      // specs/script-tool.md#tool-log: the tool log, created at the run's first nested call.
      let runHandle: ScriptRunHandle | undefined;
      const toolLog = new ScriptToolLog({
        agentDir,
        taskId: row.taskId,
        cwd,
        source: source.code,
        runStart: () => runHandle?.startedAt() ?? Date.now(),
        // Writes happen only while a nested call is open, and every open call is logged
        // when the run settles, before its result is built: the line always lands.
        reportFailure: (line) => void runHandle?.stderrLine(line),
        // The tool log's path is the row's session_path (specs/task-ledger.md#ledger-row).
        onCreated: (path) => ledgerToolLog(row, path),
      });
      const toolCallsOf = () => ({
        count: toolLog.calls,
        logPath: toolLog.path,
        createdLogPath: toolLog.createdPath,
        taskId: row.taskId,
      });

      try {
        ensureOutputDir(agentDir);
        const request: Parameters<typeof runScript>[0] = {
          code: source.code,
          filename: source.filename,
          cwd,
          input: params.input,
          aliases: bundledAliases(),
          ...(shape.kind === "plugin"
            ? { pluginNamespace: shape.plugin, stateWorkspaceRoot: host.cwd() }
            : {}),
        };
        if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;
        if (!background && signal !== undefined) request.signal = signal;
        // specs/script-tool.md#bound-tools: the callable tools are read once, after the checks of specs/script-tool.md#validation.
        const selection = selectTools(ctx?.tools ?? [], deps.toolsAllow?.() ?? DEFAULT_TOOLS_ALLOW);
        request.tools = {
          names: selection.bound.map((tool) => tool.name),
          declarations: toolDeclarations(selection),
          call: async (name, args, callSignal) => {
            const tool = selection.bound.find((candidate) => candidate.name === name);
            if (tool === undefined || ctx === undefined)
              throw new Error(`tool ${name} is not bound`);
            const callId = toolLog.start(name, args);
            // specs/script-tool.md#tool-log: the row's count of the nested calls the run has started.
            registry.amend(row, { toolCalls: toolLog.calls });
            // The run's settlement aborts the call: it is logged as aborted at that moment.
            const onAbort = (): void => toolLog.abort(callId);
            callSignal.addEventListener("abort", onAbort, { once: true });
            try {
              return await callBoundTool(
                tool,
                args,
                async (toolName, toolArgs, options) => {
                  try {
                    const outcome = await ctx.executeTool(toolName, toolArgs, options);
                    toolLog.settle(callId, {
                      content: outcome.result.content,
                      details: outcome.result.details,
                      isError: outcome.isError,
                    });
                    return outcome;
                  } catch (error) {
                    toolLog.settle(callId, {
                      content: [{ type: "text", text: errorMessage(error) }],
                      isError: true,
                    });
                    throw error;
                  }
                },
                callSignal,
              );
            } finally {
              callSignal.removeEventListener("abort", onAbort);
            }
          },
        };
        const extra = deps.extraEnv?.();
        if (extra !== undefined && Object.keys(extra).length > 0) request.extraEnv = extra;
        // The run's chunks feed the row's progress projection line by line, in
        // arrival order, with lines formed as specs/bash-tool.md#output-capture states for
        // the captured output (specs/script-tool.md#timeout-delivery): a line may start on one stream and
        // end on the other, and each entry is that line's display text, cut.
        // specs/script-tool.md#timeout-delivery: the output file takes the output in both deliveries. A write
        // failure (e.g. the session's directory was already removed) never fails
        // the call, and never throws out of the worker's message handler.
        const appendOutput = (text: string): void => {
          try {
            appendFileSync(outputPath, text);
          } catch {
            // Best effort.
          }
        };
        const splitter = new ProgressLines();
        request.onOutput = (_stream, chunk) => {
          appendOutput(chunk);
          for (const entry of splitter.push(chunk)) registry.progress(row, entry);
        };
        const flushProgress = (): void => {
          const last = splitter.last();
          if (last !== undefined) registry.progress(row, last);
        };
        // The error text of a `threw` settlement is stderr output like any other (specs/script-tool.md#execution-model).
        const emitThrown = (thrown: string): void => {
          if (thrown !== "") request.onOutput?.("stderr", thrown);
          flushProgress();
        };
        const handle: ScriptRunHandle = killedBeforeRun
          ? {
              promise: Promise.resolve(notRun),
              cancel: (): void => {},
              startedAt: (): undefined => {},
              stderrLine: () => false,
            }
          : runScript(request);
        runHandle = handle;

        // Task-based cancellation (specs/script-tool.md#timeout-delivery) applies to foreground rows too:
        // hard-terminating the worker settles the run with exitReason "killed".
        runCancel = () => handle.cancel("killed");

        if (!background) {
          const result = await handle.promise;
          const formatted = formatResult(result, outputPath, toolCallsOf(), row.browserKill);
          emitThrown(formatted.thrown);
          appendOutput(formatted.suffix);
          registry.settle(row, {
            status: settleStatus(result.exitReason),
            result: formatted.text,
            resultPath: outputPath,
          });
          return {
            content: [{ type: "text", text: formatted.text }],
            details: { taskId: row.taskId, outputPath, ...formatted.details },
            ...(formatted.isError ? { isError: true } : {}),
          };
        }

        void handle.promise
          .then((result) => {
            const formatted = formatResult(result, outputPath, toolCallsOf(), row.browserKill);
            emitThrown(formatted.thrown);
            appendOutput(formatted.suffix);
            registry.settle(row, {
              status: settleStatus(result.exitReason),
              result: formatted.text,
              resultPath: outputPath,
            });
          })
          .catch((error: unknown) => {
            // No unhandled rejection from a background run.
            settleBackgroundFailure(registry, row, "Script", error);
          });
        return {
          content: [
            {
              type: "text",
              text: `Script started in background (taskId ${row.taskId}).\nTool calls, if the script makes any: ${toolLog.path}`,
            },
          ],
          details: {
            taskId: row.taskId,
            outputPath,
            background: true,
            exitReason: "running",
            stdout: "",
            stderr: "",
            truncated: { stdout: false, stderr: false },
            durationMs: 0,
            toolCalls: 0,
          },
        };
      } catch (error) {
        return failRun(error);
      }
    },
    renderCall(args: Partial<ScriptToolParams> | undefined, theme, context) {
      const plugin = typeof args?.plugin === "string" ? args.plugin.trim() : "";
      const path = typeof args?.path === "string" ? args.path.trim() : "";
      return renderCardCall(
        {
          tool: "Script",
          description: args?.description,
          background: args?.background,
          source: plugin !== "" && path !== "" ? `${plugin}:${path}` : args?.code,
        },
        theme,
        context,
      );
    },
    renderResult: renderToolCardResult,
  });
}
