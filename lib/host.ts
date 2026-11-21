import type { Api } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./model-string.ts";

/** A provider configuration as a model runtime registers it. */
export type ProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];
/** A provider object as a model runtime registers it. */
export type NativeProvider = Parameters<ModelRuntime["registerNativeProvider"]>[0];

/** One extension provider of a session's model runtime (agent-tool.md Section 4.2). */
export type HostExtensionProvider =
  | { readonly id: string; readonly kind: "config"; readonly config: ProviderConfigInput }
  | { readonly id: string; readonly kind: "native"; readonly provider: NativeProvider };

/** The provider reads a model registry and a model runtime both offer. */
export interface ExtensionProviderSource {
  getRegisteredProviderIds(): readonly string[];
  getRegisteredProviderConfig(id: string): ProviderConfigInput | undefined;
  getRegisteredNativeProvider(id: string): NativeProvider | undefined;
}

/** The extension providers `source` holds, in the order it lists their IDs. */
export function extensionProvidersOf(source: ExtensionProviderSource): HostExtensionProvider[] {
  const providers: HostExtensionProvider[] = [];
  for (const id of source.getRegisteredProviderIds()) {
    const provider = source.getRegisteredNativeProvider(id);
    if (provider !== undefined) {
      providers.push({ id, kind: "native", provider });
      continue;
    }
    const config = source.getRegisteredProviderConfig(id);
    if (config !== undefined) providers.push({ id, kind: "config", config });
  }
  return providers;
}

/** Compaction settings shape used for child inheritance (pi `CompactionSettings` subset). */
export interface CompactionSettings {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

/**
 * One tool of a session's complete configured inventory; the engine reads its name
 * and file source path (agent-tool.md Section 3.1).
 */
export interface HostToolInfo {
  readonly name: string;
  readonly sourceInfo?: { readonly path?: string | undefined } | undefined;
}

/**
 * The dispatching ("main") session as seen by the engine: the host extension
 * context for top-level dispatches, the child AgentSession for nested ones.
 */
export interface HostSession {
  cwd(): string;
  sessionId(): string;
  sessionFile(): string | undefined;
  /** Directory of the session file (default session dir when not persisted). */
  sessionDir(): string;
  model(): { provider: string; id: string } | undefined;
  thinking(): ThinkingLevel | undefined;
  /** Live active tool set, in session order (the tool cap). */
  activeTools(): string[];
  /**
   * Every configured tool of the session, active or inactive, in inventory
   * order (agent-tool.md Section 3.1); absent when the host exposes none.
   */
  allTools?(): readonly HostToolInfo[];
  /**
   * The providers extensions registered in the session's model runtime, as it holds
   * them now (agent-tool.md Section 4.2); absent when the host exposes none.
   */
  extensionProviders?(): readonly HostExtensionProvider[];
  /** The host pi runtime's registered model list. */
  inventory(): readonly Model<Api>[];
  /**
   * The configured model list the guidance message is computed from
   * (specs/model-guidance.md Section 2): only models whose provider has
   * authentication configured.
   */
  configuredModels(): readonly Model<Api>[] | undefined;
  contextWindow(): number | undefined;
  /** Effective compaction settings for the session's cwd (undefined when unknown). */
  compaction(): CompactionSettings | undefined;
  notify(message: string): void;
  /**
   * Warn without starting a model turn: the main session's UI (stderr without a
   * UI), or a displayed message in a child (agent-tool.md Section 3.1). Absent
   * on a host that predates the channel, which falls back to `notify`.
   */
  warn?(message: string): void;
}
