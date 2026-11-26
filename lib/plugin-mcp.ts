import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PluginEntry } from "./plugins.ts";
import { type Diagnostic, errorMessage } from "./util.ts";

/**
 * Plugin-declared HTTPS MCP server registration (specs/plugin.md#mcp-servers).
 * Registers admitted plugins' valid `mcpServers` with `pi-mcp-adapter` over the
 * host event bus (`pi-mcp-adapter:runtime-register:v1`) at session start and
 * disposes them on session shutdown.
 */

export const MCP_RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1" as const;
const MCP_RUNTIME_REGISTER_VERSION = 1;

export interface McpRuntimeOAuthConfig {
  clientId: string;
  scope?: string;
  redirectUri?: string;
}

export interface McpRuntimeServerDefinition {
  url: string;
  headers?: Record<string, string>;
  auth?: "oauth";
  oauth?: McpRuntimeOAuthConfig;
  description?: string;
}

export interface McpServerRegistrationHandle {
  dispose(): Promise<void>;
}

export interface McpRuntimeRegistrationRequest {
  version: number;
  name: string;
  definition: McpRuntimeServerDefinition;
  result?: { ok: true; registration: McpServerRegistrationHandle } | { ok: false; error: Error };
}

export interface PluginMcpEventBus {
  emit(channel: string, data: unknown): void;
}

export interface PluginMcpHandle {
  /** Register all admitted plugins' MCP servers once per active session. */
  register(): void;
  /** Dispose all active registrations so a later session can register cleanly. */
  dispose(): Promise<void>;
}

export function createPluginMcpRegistrar(
  events: PluginMcpEventBus,
  plugins: readonly PluginEntry[],
  reportDiagnostic: (diagnostic: Diagnostic) => void,
): PluginMcpHandle {
  let registered = false;
  const handles: McpServerRegistrationHandle[] = [];

  return {
    register(): void {
      if (registered) return;
      registered = true;
      let missingAdapterReported = false;
      for (const plugin of plugins) {
        for (const server of plugin.mcpServers ?? []) {
          const qualifiedName = `${plugin.name}:${server.name}`;
          const oauth: McpRuntimeOAuthConfig | undefined =
            server.oauth === undefined
              ? undefined
              : {
                  clientId: server.oauth.clientId,
                  ...(server.oauth.scope === undefined ? {} : { scope: server.oauth.scope }),
                  ...(server.oauth.callbackUrl === undefined
                    ? {}
                    : { redirectUri: server.oauth.callbackUrl }),
                };
          const definition: McpRuntimeServerDefinition = {
            url: server.url,
            ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
            ...(server.auth === undefined ? {} : { auth: server.auth }),
            ...(oauth === undefined ? {} : { oauth }),
            ...(server.description === undefined ? {} : { description: server.description }),
          };
          const request: McpRuntimeRegistrationRequest = {
            version: MCP_RUNTIME_REGISTER_VERSION,
            name: qualifiedName,
            definition,
          };
          try {
            events.emit(MCP_RUNTIME_REGISTER_EVENT, request);
          } catch (error) {
            reportDiagnostic({
              level: "warning",
              message: `plugins: MCP server "${qualifiedName}" failed to register: ${errorMessage(error)}`,
            });
            continue;
          }
          if (request.result === undefined) {
            if (!missingAdapterReported) {
              missingAdapterReported = true;
              reportDiagnostic({
                level: "warning",
                message: `plugins: MCP server "${qualifiedName}" skipped (pi-mcp-adapter is not loaded)`,
              });
            }
            continue;
          }
          if (!request.result.ok) {
            reportDiagnostic({
              level: "warning",
              message: `plugins: MCP server "${qualifiedName}" skipped (${errorMessage(request.result.error)})`,
            });
            continue;
          }
          handles.push(request.result.registration);
        }
      }
    },

    async dispose(): Promise<void> {
      registered = false;
      const active = handles.splice(0);
      for (const handle of active) {
        try {
          await handle.dispose();
        } catch (error) {
          reportDiagnostic({
            level: "warning",
            message: `plugins: failed to dispose MCP server registration: ${errorMessage(error)}`,
          });
        }
      }
    },
  };
}

/**
 * Inline extension factory that registers admitted plugins' `mcpServers` into
 * an isolated `AgentSession` (child session or plugin UI tool proxy) that loads
 * `pi-mcp-adapter` without loading `pi-dent-agent` itself (specs/plugin.md#mcp-servers).
 */
export function pluginMcpExtensionFactory(
  plugins: readonly PluginEntry[],
  reportDiagnostic: (diagnostic: Diagnostic) => void,
): ExtensionFactory {
  return (pi) => {
    const registrar = createPluginMcpRegistrar(pi.events, plugins, reportDiagnostic);
    pi.on("session_start", () => {
      registrar.register();
    });
    pi.on("session_shutdown", async () => {
      await registrar.dispose();
    });
  };
}
