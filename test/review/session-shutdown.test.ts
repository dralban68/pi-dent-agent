import { test } from "node:test";
import assert from "node:assert/strict";
import { shutdownStep } from "../../index.ts";

/**
 * The guarded session shutdown steps of index.ts: a step that throws is reported and the
 * shutdown goes on, so the steps after it are never skipped.
 */

test("a shutdown step that throws is reported with its name and error, and does not throw", () => {
  const reported: string[] = [];
  shutdownStep(
    "stopping Search",
    () => {
      throw new Error("disk gone");
    },
    (message) => reported.push(message),
  );
  assert.deepEqual(reported, ["pi-dent: session shutdown: stopping Search failed: disk gone"]);
});

test("a shutdown step that succeeds reports nothing", () => {
  const reported: string[] = [];
  let ran = false;
  shutdownStep(
    "ending owned tasks",
    () => {
      ran = true;
    },
    (message) => reported.push(message),
  );
  assert.equal(ran, true);
  assert.deepEqual(reported, []);
});

test("a failing step leaves the steps after it running, each reporting only its own failure", () => {
  const ran: string[] = [];
  const reported: string[] = [];
  const report = (message: string): void => {
    reported.push(message);
  };
  shutdownStep(
    "ending owned tasks",
    () => {
      ran.push("tasks");
      throw new Error("tasks broke");
    },
    report,
  );
  shutdownStep(
    "stopping Search",
    () => {
      ran.push("search");
      throw new Error("search broke");
    },
    report,
  );
  shutdownStep(
    "ending the session's schedules",
    () => {
      ran.push("schedules");
    },
    report,
  );
  assert.deepEqual(ran, ["tasks", "search", "schedules"]);
  assert.deepEqual(reported, [
    "pi-dent: session shutdown: ending owned tasks failed: tasks broke",
    "pi-dent: session shutdown: stopping Search failed: search broke",
  ]);
});
