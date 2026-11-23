import { Worker } from "node:worker_threads";
import type { ToolCallContent, ToolCallReply } from "./script-tool-calls.ts";
import { errorMessage, isPlainObject } from "./util.ts";
import { typeStrippingOptions } from "./worker-options.ts";

function isToolCallContent(value: unknown): value is ToolCallContent {
  if (!isPlainObject(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "image") {
    return typeof value.data === "string" && typeof value.mimeType === "string";
  }
  if (value.type === "other") return typeof value.kind === "string";
  return false;
}

function isToolCallReply(value: unknown): value is ToolCallReply {
  if (!isPlainObject(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) {
    return (
      isPlainObject(value.value) &&
      typeof value.value.text === "string" &&
      Array.isArray(value.value.content) &&
      value.value.content.every(isToolCallContent)
    );
  }
  return (
    isPlainObject(value.error) &&
    typeof value.error.name === "string" &&
    typeof value.error.message === "string"
  );
}

/**
 * Host handle to a check's fixtures worker (specs/plugin-ui-tool.md Section 5).
 */

export interface FixturesWorkerHandle {
  readonly names: readonly string[];
  call(name: string, args: unknown, signal?: AbortSignal): Promise<ToolCallReply>;
  terminate(): Promise<void>;
}

const WORKER_URL = new URL("./plugin-ui-fixtures-worker.ts", import.meta.url);

export async function startFixturesWorker(
  modulePath: string,
  cwd: string,
): Promise<FixturesWorkerHandle> {
  const worker = new Worker(WORKER_URL, {
    ...typeStrippingOptions(WORKER_URL),
    workerData: { modulePath, cwd },
  });

  let nextId = 0;
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (reply: ToolCallReply) => void; cleanup: () => void }
  >();

  const failAllPending = (message: string): void => {
    for (const entry of pending.values()) {
      entry.cleanup();
      entry.resolve({ ok: false, error: { name: "Error", message } });
    }
    pending.clear();
  };

  const names = await new Promise<string[]>((resolveReady, rejectReady) => {
    let settled = false;
    const onMessage = (raw: unknown): void => {
      if (!isPlainObject(raw)) return;
      if (raw.type === "ready" && !settled) {
        settled = true;
        if (raw.ok === true && Array.isArray(raw.names)) {
          const validNames = raw.names.filter((n): n is string => typeof n === "string");
          resolveReady(validNames);
        } else {
          const reason = typeof raw.error === "string" ? raw.error : "unknown error";
          void worker.terminate();
          rejectReady(new Error(reason));
        }
        return;
      }
      if (raw.type === "reply" && typeof raw.id === "number") {
        const entry = pending.get(raw.id);
        if (!entry) return;
        pending.delete(raw.id);
        entry.cleanup();
        if (isToolCallReply(raw.reply)) {
          entry.resolve(raw.reply);
        } else {
          entry.resolve({
            ok: false,
            error: { name: "Error", message: "Invalid reply from fixtures worker" },
          });
        }
      }
    };
    const onError = (error: Error): void => {
      closed = true;
      const msg = errorMessage(error);
      if (!settled) {
        settled = true;
        rejectReady(new Error(msg));
      }
      failAllPending(msg);
    };
    const onExit = (code: number): void => {
      closed = true;
      const msg = `fixtures worker exited (code ${code})`;
      if (!settled) {
        settled = true;
        rejectReady(new Error(msg));
      }
      failAllPending(msg);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });

  return {
    names,
    call(name: string, args: unknown, signal?: AbortSignal): Promise<ToolCallReply> {
      if (closed) {
        return Promise.resolve({
          ok: false,
          error: { name: "Error", message: "fixtures worker is closed" },
        });
      }
      if (signal?.aborted) {
        return Promise.resolve({
          ok: false,
          error: { name: "AbortError", message: "Tool call aborted" },
        });
      }
      const id = ++nextId;
      return new Promise<ToolCallReply>((resolve) => {
        const onAbort = (): void => {
          pending.delete(id);
          resolve({ ok: false, error: { name: "AbortError", message: "Tool call aborted" } });
        };
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        pending.set(id, {
          resolve,
          cleanup: () => {
            if (signal) signal.removeEventListener("abort", onAbort);
          },
        });
        try {
          worker.postMessage({ type: "call", id, name, args });
        } catch (error) {
          pending.delete(id);
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve({ ok: false, error: { name: "Error", message: errorMessage(error) } });
        }
      });
    },
    async terminate(): Promise<void> {
      if (closed) return;
      closed = true;
      failAllPending("fixtures worker terminated");
      try {
        await worker.terminate();
      } catch {
        // Already terminated.
      }
    },
  };
}
