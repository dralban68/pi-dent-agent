/**
 * A worker thread running one fleet boot window with one registered main session, as a host
 * that runs each session in its own worker thread does. Driven by test/fleet/fleet-threads.test.ts.
 * Imported in the main thread it does nothing.
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { BootSnapshot } from "../../lib/engine.ts";
import { FleetCoordinator } from "../../lib/fleet.ts";

export interface FleetThreadData {
  db: string;
  dir: string;
  sessionId: string;
  bootId: string;
  /** Shared flag: the thread blocks right after constructing its coordinator until it is set. */
  hold?: SharedArrayBuffer;
}

export type FleetThreadCommand =
  | { cmd: "sweep" }
  | { cmd: "send"; to: string; body: string }
  | { cmd: "crash" };

export type FleetThreadEvent =
  | { type: "ready"; registered: boolean }
  | { type: "swept" }
  | { type: "sent"; status: string }
  | { type: "delivered"; text: string }
  | { type: "failed"; message: string };

function emptyBoot(cwd: string): BootSnapshot {
  return {
    cwd,
    config: {
      merged: {},
      layers: {},
      projectRoot: cwd,
      diagnostics: [],
      liveness: { idleTimeoutMs: 0, absoluteTimeoutMs: 0 },
    },
    agents: [],
    agentIndex: new Map(),
    skills: [],
    skillIndex: new Map(),
    plugins: [],
    pluginIndex: new Map(),
    diagnostics: [],
    maxRecoveryRetries: 2,
    sessionTtlDays: 30,
  };
}

async function run(data: FleetThreadData, port: NonNullable<typeof parentPort>): Promise<void> {
  const post = (event: FleetThreadEvent) => port.postMessage(event);
  const fleet = new FleetCoordinator(emptyBoot(data.dir), { dbPath: data.db, bootId: data.bootId });
  if (data.hold) {
    const flag = new Int32Array(data.hold);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    Atomics.wait(flag, 1, 0, 2000);
  }
  // As at session start: gone owners are deleted before the session registers.
  await fleet.reapGoneOwners();
  const registered = fleet.registerEndpoint({
    sessionId: data.sessionId,
    agentsDir: data.dir,
    cwd: () => data.dir,
    isIdle: () => true,
    abortTurn: () => {},
    deliverTurn: (text) => post({ type: "delivered", text }),
    notify: () => {},
    runBuiltinCommand: () => false,
    runQuery: async () => ({ text: "", isError: false }),
  });
  post({ type: "ready", registered });
  port.on("message", (command: FleetThreadCommand) => {
    if (command.cmd === "crash") {
      setImmediate(() => {
        throw new Error("fleet thread crashed on purpose");
      });
      return;
    }
    if (command.cmd === "sweep") {
      void fleet.reapGoneOwners().then(
        () => post({ type: "swept" }),
        (error: Error) => post({ type: "failed", message: error.message }),
      );
      return;
    }
    const resolved = fleet.resolveRecipient(command.to, data.sessionId);
    if ("error" in resolved) {
      post({ type: "failed", message: resolved.error });
      return;
    }
    const sent = fleet.enqueueSend({
      senderSessionId: data.sessionId,
      target: resolved.session,
      body: command.body,
      deliver: "followUp",
      abort: false,
    });
    post({ type: "sent", status: sent.status });
  });
}

if (!isMainThread && parentPort) {
  void run(workerData as FleetThreadData, parentPort);
}
