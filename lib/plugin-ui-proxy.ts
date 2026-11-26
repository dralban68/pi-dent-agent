import { realpathSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type JsonObject,
  type JsonValue,
} from "@earendil-works/pi-ai";
import {
  defaultBuiltinExtensions,
  EXTENSION_SHUTDOWN_TIMEOUT_MS,
  extensionShutdown,
  type InheritedExtensions,
} from "./engine.ts";
import type { NestedCallOutcome } from "./script-tool-calls.ts";
import { errorMessage, isPlainObject } from "./util.ts";

/**
 * Plugin UI tool proxy (specs/plugin-ui.md#tool-proxy): one lazily created,
 * long-lived in-memory proxy `AgentSession` per parent session on a scripted
 * `streamSimple` provider. Executes non-pi-dent tools (built-in host tools,
 * MCP tools, other extensions' tools) through pi's real tool pipeline with
 * zero LLM calls, zero disk/index/task footprint, and FIFO serialization.
 */

const PROXY_PROVIDER = "pi-dent-ui-proxy";
const PROXY_MODEL_ID = "proxy";
const PROXY_API = "pi-dent-ui-proxy-api";

export interface PluginUiToolProxyOptions {
  cwd: string;
  isProjectTrusted: boolean;
  extensions: InheritedExtensions;
  /** Tool names to exclude from the proxy session (e.g. deactivated built-ins like `bash`). */
  excludeTools?: readonly string[];
  /** Built-in extension factories; defaults to `defaultBuiltinExtensions()`. */
  builtinExtensions?: readonly InlineExtension[];
  /** Additional inline extension factories (used by tests to inject stand-in tools/extensions). */
  extraExtensionFactories?: readonly ExtensionFactory[];
  /** Override for bounded extension shutdown wait (defaults to `EXTENSION_SHUTDOWN_TIMEOUT_MS`). */
  shutdownTimeoutMs?: number;
}

interface PendingProxyCall {
  id: string;
  name: string;
  args: JsonObject;
}

interface QueuedProxyItem {
  name: string;
  args: unknown;
  signal: AbortSignal;
  resolve: (outcome: NestedCallOutcome) => void;
  reject: (error: Error) => void;
  onQueuedAbort: () => void;
}

function realPathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function makeAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: PROXY_API,
    provider: PROXY_PROVIDER,
    model: PROXY_MODEL_ID,
    usage: emptyUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function extractOutcomeFromResult(rawResult: unknown, isError: boolean): NestedCallOutcome {
  if (!isPlainObject(rawResult)) {
    return { result: { content: [] }, isError };
  }
  const content = Array.isArray(rawResult.content) ? rawResult.content : [];
  const details = rawResult.details;
  const structuredContent = rawResult.structuredContent;
  return {
    result: {
      content,
      ...(details === undefined ? {} : { details }),
      ...(structuredContent === undefined ? {} : { structuredContent }),
    },
    isError,
  };
}

export class PluginUiToolProxy {
  private readonly options: PluginUiToolProxyOptions;
  private session: AgentSession | undefined;
  private startPromise: Promise<AgentSession> | undefined;
  private failedTools = new Map<string, string>();
  private queue: QueuedProxyItem[] = [];
  private pumping = false;
  private disposed = false;
  private callSeq = 0;

  /** Shared per-turn handoff between `runOne` and the scripted `streamSimple` provider. */
  private pendingCall: PendingProxyCall | undefined;
  private activeCallId: string | undefined;
  private capturedOutcome: NestedCallOutcome | undefined;

  constructor(options: PluginUiToolProxyOptions) {
    this.options = options;
  }

  /** Whether the proxy session has been instantiated. */
  isStarted(): boolean {
    return this.session !== undefined;
  }

  /** Execute one proxied tool call on the FIFO queue (specs/plugin-ui.md#tool-proxy). */
  call(name: string, args: unknown, signal: AbortSignal): Promise<NestedCallOutcome> {
    if (this.disposed) {
      return Promise.reject(new Error("Plugin UI proxy session ended"));
    }
    if (signal.aborted) {
      return Promise.reject(new Error("Tool call aborted"));
    }
    return new Promise<NestedCallOutcome>((resolve, reject) => {
      const item: QueuedProxyItem = {
        name,
        args,
        signal,
        resolve,
        reject,
        onQueuedAbort: () => {
          const idx = this.queue.indexOf(item);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(new Error("Tool call aborted"));
          }
        },
      };
      signal.addEventListener("abort", item.onQueuedAbort, { once: true });
      this.queue.push(item);
      void this.pump();
    });
  }

  /** Abort any in-flight call, reject queued calls, and shut down the proxy session. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const queued = this.queue.splice(0);
    for (const item of queued) {
      item.signal.removeEventListener("abort", item.onQueuedAbort);
      item.reject(new Error("Plugin UI proxy session ended"));
    }
    const pendingStart = this.startPromise;
    const session = this.session;
    this.session = undefined;
    if (session) {
      await this.shutdownSession(session, true);
    } else if (pendingStart) {
      // Wait for an in-flight startSession() to observe `this.disposed` and shut down cleanly.
      await pendingStart.catch(() => {});
    }
  }

  private async shutdownSession(session: AgentSession, extensionsBound: boolean): Promise<void> {
    try {
      await session.abort();
    } catch {
      // Best effort.
    }
    if (extensionsBound) {
      await extensionShutdown(
        session,
        this.options.shutdownTimeoutMs ?? EXTENSION_SHUTDOWN_TIMEOUT_MS,
      );
    }
    try {
      session.dispose();
    } catch {
      // Best effort.
    }
  }

  private async ensureStarted(): Promise<AgentSession> {
    if (this.disposed) throw new Error("Plugin UI proxy session ended");
    if (this.session) return this.session;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startSession().catch((error: unknown) => {
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  private async startSession(): Promise<AgentSession> {
    const { cwd, isProjectTrusted, extensions } = this.options;
    const settingsManager = SettingsManager.create(cwd, getAgentDir());
    settingsManager.setProjectTrusted(isProjectTrusted);

    const providerFactory: ExtensionFactory = (pi) => {
      pi.registerProvider(PROXY_PROVIDER, {
        baseUrl: "http://127.0.0.1:0",
        api: PROXY_API,
        apiKey: "unused",
        models: [
          {
            id: PROXY_MODEL_ID,
            name: PROXY_MODEL_ID,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
        streamSimple: (_model, context) => {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            const last = context.messages[context.messages.length - 1];
            if (last && last.role === "toolResult") {
              if (this.capturedOutcome === undefined) {
                this.capturedOutcome = extractOutcomeFromResult(last, last.isError);
              }
              stream.push({
                type: "done",
                reason: "stop",
                message: makeAssistantMessage([{ type: "text", text: "ok" }], "stop"),
              });
              return;
            }
            const call = this.pendingCall;
            this.pendingCall = undefined;
            if (!call) {
              stream.push({
                type: "done",
                reason: "stop",
                message: makeAssistantMessage([{ type: "text", text: "noop" }], "stop"),
              });
              return;
            }
            stream.push({
              type: "done",
              reason: "toolUse",
              message: makeAssistantMessage(
                [{ type: "toolCall", id: call.id, name: call.name, arguments: call.args }],
                "toolUse",
              ),
            });
          });
          return stream;
        },
      });
    };

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: [...extensions.sources],
      extensionFactories: [
        ...(this.options.builtinExtensions ?? defaultBuiltinExtensions()),
        ...(this.options.extraExtensionFactories ?? []),
        providerFactory,
      ],
      noSkills: true,
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      promptsOverride: () => ({ prompts: [], diagnostics: [] }),
      themesOverride: () => ({ themes: [], diagnostics: [] }),
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "Plugin UI tool proxy.",
    });

    await loader.reload();
    const loaded = loader.getExtensions();
    this.recordLoadFailures(extensions, loaded);

    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const sessionManager = SessionManager.inMemory(cwd);
    const created = await createAgentSession({
      cwd,
      modelRuntime: runtime,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      ...(this.options.excludeTools && this.options.excludeTools.length > 0
        ? { excludeTools: [...this.options.excludeTools] }
        : {}),
    });
    const session = created.session;
    if (this.disposed) {
      await this.shutdownSession(session, false);
      throw new Error("Plugin UI proxy session ended");
    }

    let extensionsBound = false;
    try {
      await session.bindExtensions({});
      extensionsBound = true;
      const proxyModel = session.modelRuntime
        .getModels()
        .find((m) => m.provider === PROXY_PROVIDER && m.id === PROXY_MODEL_ID);
      if (!proxyModel) {
        throw new Error("Proxy provider model was not registered");
      }
      await session.setModel(proxyModel);

      // Subscribe to tool_execution_end to capture full result including structuredContent,
      // filtered strictly to the active proxied toolCallId.
      session.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolCallId === this.activeCallId) {
          this.capturedOutcome = extractOutcomeFromResult(event.result, event.isError);
        }
      });

      if (this.disposed) {
        throw new Error("Plugin UI proxy session ended");
      }
    } catch (error) {
      await this.shutdownSession(session, extensionsBound);
      throw error;
    }

    this.session = session;
    return session;
  }

  private recordLoadFailures(
    extensions: InheritedExtensions,
    loaded: {
      readonly extensions: readonly { readonly path: string; readonly resolvedPath: string }[];
      readonly errors: readonly { readonly path: string; readonly error: string }[];
    },
  ): void {
    const loadedKeys = new Set<string>();
    for (const ext of loaded.extensions) {
      loadedKeys.add(realPathSafe(ext.path));
      loadedKeys.add(realPathSafe(ext.resolvedPath));
    }
    const sourceErrors = new Map<string, string>();
    for (const err of loaded.errors) {
      const key = realPathSafe(err.path);
      if (!loadedKeys.has(key) && !sourceErrors.has(key)) {
        sourceErrors.set(key, err.error);
      }
    }
    for (const source of extensions.sources) {
      const key = realPathSafe(source);
      if (!loadedKeys.has(key) && !sourceErrors.has(key)) {
        sourceErrors.set(key, `extension "${source}" was not loaded`);
      }
    }
    this.failedTools.clear();
    for (const tool of extensions.tools) {
      const err = sourceErrors.get(realPathSafe(tool.source));
      if (err !== undefined) {
        this.failedTools.set(tool.name, err);
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.disposed && this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;
        item.signal.removeEventListener("abort", item.onQueuedAbort);
        if (item.signal.aborted) {
          item.reject(new Error("Tool call aborted"));
          continue;
        }
        try {
          const outcome = await this.runOne(item);
          item.resolve(outcome);
        } catch (error) {
          item.reject(error instanceof Error ? error : new Error(errorMessage(error)));
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runOne(item: QueuedProxyItem): Promise<NestedCallOutcome> {
    let session: AgentSession;
    try {
      session = await this.ensureStarted();
    } catch (error) {
      throw new Error(`Proxy session failed to start: ${errorMessage(error)}`);
    }

    const failedExtError = this.failedTools.get(item.name);
    if (failedExtError !== undefined) {
      return {
        result: {
          content: [
            {
              type: "text",
              text: `Extension for tool "${item.name}" failed to load in proxy: ${failedExtError}`,
            },
          ],
        },
        isError: true,
      };
    }

    if (this.disposed) throw new Error("Plugin UI proxy session ended");
    if (item.signal.aborted) throw new Error("Tool call aborted");

    const callId = `ui-proxy-${++this.callSeq}`;
    this.pendingCall = { id: callId, name: item.name, args: toJsonObject(item.args) };
    this.activeCallId = callId;
    this.capturedOutcome = undefined;

    const onAbort = (): void => {
      void session.abort();
    };
    item.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await session.prompt(`proxy:${callId}`);
    } catch (error) {
      if (item.signal.aborted) throw new Error("Tool call aborted");
      throw error;
    } finally {
      item.signal.removeEventListener("abort", onAbort);
      this.pendingCall = undefined;
      this.activeCallId = undefined;
      try {
        session.agent.state.messages = [];
      } catch {
        // Best effort history reset.
      }
    }

    if (item.signal.aborted) throw new Error("Tool call aborted");
    if (this.capturedOutcome !== undefined) {
      return this.capturedOutcome;
    }
    return {
      result: {
        content: [{ type: "text", text: `Proxy tool "${item.name}" produced no result` }],
      },
      isError: true,
    };
  }
}
