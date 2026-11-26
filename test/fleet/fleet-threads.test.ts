/**
 * Boot windows in several worker threads of one process (specs/session-store.md#membership-lifecycle):
 * each keeps its records while its thread lives, and a thread that ends without closing its boot
 * window, by termination or a crash, leaves records the other boot windows delete.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import type {
  FleetThreadCommand,
  FleetThreadData,
  FleetThreadEvent,
} from "../support/fleet-thread.ts";

const WORKER = new URL("../support/fleet-thread.ts", import.meta.url);

interface Thread {
  worker: Worker;
  registered: boolean;
  /** Resolves with the next event of the type. */
  next(type: FleetThreadEvent["type"]): Promise<FleetThreadEvent>;
  command(command: FleetThreadCommand): void;
}

function startThread(data: FleetThreadData): Promise<Thread> {
  const worker = new Worker(WORKER, { workerData: data });
  const events: FleetThreadEvent[] = [];
  const waiters: Array<() => void> = [];
  worker.on("message", (event: FleetThreadEvent) => {
    events.push(event);
    for (const wake of waiters.splice(0)) wake();
  });
  // A crash on purpose surfaces here; the test waits for the exit instead.
  worker.on("error", () => {});
  const next = async (type: FleetThreadEvent["type"]): Promise<FleetThreadEvent> => {
    for (;;) {
      const index = events.findIndex((event) => event.type === type || event.type === "failed");
      if (index >= 0) {
        const [event] = events.splice(index, 1);
        assert.ok(event);
        if (event.type === "failed") throw new Error(`${data.sessionId}: ${event.message}`);
        return event;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return next("ready").then((ready) => ({
    worker,
    registered: ready.type === "ready" && ready.registered,
    next,
    command: (command) => worker.postMessage(command),
  }));
}

async function sweep(thread: Thread): Promise<void> {
  thread.command({ cmd: "sweep" });
  await thread.next("swept");
}

function storeOwners(db: string): string[] {
  const handle = new DatabaseSync(db, { readOnly: true });
  try {
    return handle
      .prepare("SELECT session_id, owner_boot FROM fleet_sessions ORDER BY session_id")
      .all()
      .map((row) => `${String(row.session_id)}@${String(row.owner_boot)}`);
  } finally {
    handle.close();
  }
}

async function withStore(run: (db: string, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-threads-"));
  try {
    await run(join(dir, "fleet.sqlite"), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("boot windows in two threads of one process keep both records and reach each other", async () => {
  await withStore(async (db, dir) => {
    const a = await startThread({ db, dir, sessionId: "session-a", bootId: "aaaaaaaa" });
    const b = await startThread({ db, dir, sessionId: "session-b", bootId: "bbbbbbbb" });
    try {
      assert.ok(a.registered && b.registered);
      assert.deepEqual(storeOwners(db), ["session-a@aaaaaaaa", "session-b@bbbbbbbb"]);
      await sweep(a);
      await sweep(b);
      assert.deepEqual(storeOwners(db), ["session-a@aaaaaaaa", "session-b@bbbbbbbb"]);
      a.command({ cmd: "send", to: "session-b", body: "hello b" });
      assert.deepEqual(await a.next("sent"), { type: "sent", status: "pending" });
      const delivered = await b.next("delivered");
      assert.ok(delivered.type === "delivered" && delivered.text.includes("hello b"));
      b.command({ cmd: "send", to: "session-a", body: "hello a" });
      await b.next("sent");
      const back = await a.next("delivered");
      assert.ok(back.type === "delivered" && back.text.includes("hello a"));
    } finally {
      await a.worker.terminate();
      await b.worker.terminate();
    }
  });
});

test("a boot window holds its boot lock before its constructor returns", async () => {
  await withStore(async (db, dir) => {
    const hold = new SharedArrayBuffer(8);
    const flag = new Int32Array(hold);
    const worker = new Worker(WORKER, {
      workerData: { db, dir, sessionId: "session-a", bootId: "aaaaaaaa", hold },
    });
    try {
      while (Atomics.load(flag, 0) === 0) await new Promise((resolve) => setImmediate(resolve));
      // The thread is blocked right after constructing its coordinator.
      const free = await navigator.locks.request(
        "pi-dent-fleet-boot:aaaaaaaa",
        { ifAvailable: true },
        (lock) => lock !== null,
      );
      assert.equal(free, false);
    } finally {
      Atomics.store(flag, 1, 1);
      Atomics.notify(flag, 1);
      await worker.terminate();
    }
  });
});

test("a terminated thread's record is deleted by the sweep of a surviving thread", async () => {
  await withStore(async (db, dir) => {
    const a = await startThread({ db, dir, sessionId: "session-a", bootId: "aaaaaaaa" });
    const b = await startThread({ db, dir, sessionId: "session-b", bootId: "bbbbbbbb" });
    try {
      await b.worker.terminate();
      assert.deepEqual(storeOwners(db), ["session-a@aaaaaaaa", "session-b@bbbbbbbb"]);
      await sweep(a);
      assert.deepEqual(storeOwners(db), ["session-a@aaaaaaaa"]);
    } finally {
      await a.worker.terminate();
    }
  });
});

test("a crashed thread's record is deleted by the sweep of a surviving thread", async () => {
  await withStore(async (db, dir) => {
    const a = await startThread({ db, dir, sessionId: "session-a", bootId: "aaaaaaaa" });
    const b = await startThread({ db, dir, sessionId: "session-b", bootId: "bbbbbbbb" });
    try {
      const exited = new Promise((resolve) => b.worker.once("exit", resolve));
      b.command({ cmd: "crash" });
      assert.equal(await exited, 1);
      await sweep(a);
      assert.deepEqual(storeOwners(db), ["session-a@aaaaaaaa"]);
    } finally {
      await a.worker.terminate();
    }
  });
});

test("a new boot window deletes a terminated thread's record and registers its session", async () => {
  await withStore(async (db, dir) => {
    const a = await startThread({ db, dir, sessionId: "session-a", bootId: "aaaaaaaa" });
    await a.worker.terminate();
    assert.deepEqual(storeOwners(db), ["session-a@aaaaaaaa"]);
    const c = await startThread({ db, dir, sessionId: "session-a", bootId: "cccccccc" });
    try {
      assert.equal(c.registered, true, "the gone owner does not refuse the registration");
      assert.deepEqual(storeOwners(db), ["session-a@cccccccc"]);
    } finally {
      await c.worker.terminate();
    }
  });
});

test("a boot window alone in its process keeps its record across sweeps", async () => {
  await withStore(async (db, dir) => {
    const a = await startThread({ db, dir, sessionId: "session-a", bootId: "aaaaaaaa" });
    try {
      await sweep(a);
      await sweep(a);
      assert.deepEqual(storeOwners(db), ["session-a@aaaaaaaa"]);
    } finally {
      await a.worker.terminate();
    }
  });
});
