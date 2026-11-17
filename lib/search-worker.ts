/**
 * The regular-expression evaluator of the `Search` tool (specs/search-tool.md,
 * Section 3.3): a worker thread that matches one pattern against item match texts
 * and posts each position as soon as it is computed, so the main thread knows
 * exactly which items were decided when a pattern that backtracks without end is
 * terminated mid-item (Section 2.3). The thread is created and terminated by
 * `lib/search-tool.ts`, the way `lib/script-runner.ts` drives its worker.
 *
 * Protocol: a message `{ id, texts }` is answered by one `{ id, index, at }` per
 * text, `at` being the match position or -1 for no match, then `{ id, done }`.
 */

import { parentPort, workerData } from "node:worker_threads";
import { isPlainObject } from "./util.ts";

/** The texts of one request, or undefined when the message does not carry them. */
function textsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return;
  const texts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return;
    texts.push(entry);
  }
  return texts;
}

const data: unknown = workerData;
const pattern = isPlainObject(data) ? data.pattern : undefined;
const flags = isPlainObject(data) ? data.flags : undefined;
if (typeof pattern !== "string" || typeof flags !== "string") {
  throw new Error("search worker: pattern and flags are required");
}
const expression = new RegExp(pattern, flags);
const port = parentPort;

port?.on("message", (message: unknown) => {
  if (port === null || !isPlainObject(message)) return;
  const id = message.id;
  const texts = textsOf(message.texts);
  if (typeof id !== "number" || texts === undefined) return;
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    if (text === undefined) continue;
    // A catastrophic pattern blocks here; the positions of the texts before it
    // have already been posted, so they count as decided in the tool call.
    const match = expression.exec(text);
    port.postMessage({ id, index, at: match === null ? -1 : match.index });
  }
  port.postMessage({ id, done: true });
});
