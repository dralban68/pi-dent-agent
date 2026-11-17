import type { BillingBus, TimerHandle, Timers } from "../../lib/billing.ts";

/** Let pending promise callbacks run (no timers involved). */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface Request {
  providers: string[];
  mode: string;
  respond: (reply: unknown) => boolean;
  [key: string]: unknown;
}

/** An event bus that delivers synchronously, like the host's, and records emits. */
export class FakeBus implements BillingBus {
  readonly listeners = new Map<string, ((data: unknown) => void)[]>();
  readonly emitted: { channel: string; data: unknown }[] = [];

  on(channel: string, handler: (data: unknown) => void): () => void {
    const list = this.listeners.get(channel) ?? [];
    list.push(handler);
    this.listeners.set(channel, list);
    return () => {
      const current = this.listeners.get(channel) ?? [];
      this.listeners.set(
        channel,
        current.filter((h) => h !== handler),
      );
    };
  }

  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    for (const handler of Array.from(this.listeners.get(channel) ?? [])) handler(data);
  }

  listenerCount(channel: string): number {
    return this.listeners.get(channel)?.length ?? 0;
  }

  /** Requests emitted on the query channel. */
  requests(): Request[] {
    return this.emitted.filter((e) => e.channel === "purse:query:v1").map((e) => e.data as Request);
  }

  notify(providers: unknown): void {
    this.emit("purse:changed:v1", { protocol: 1, providers });
  }
}

/** A fake billing service on the bus; `answer` decides each request's reply promise. */
export class FakePurse {
  readonly seen: Request[] = [];
  /** Replies waiting for a manual resolve, in request order. */
  readonly open: ((reply: unknown) => void)[] = [];
  mode: "manual" | "auto" = "auto";
  answer: (request: Request) => unknown = () => reply({});

  readonly bus: FakeBus;
  private readonly off: () => void;

  constructor(bus: FakeBus) {
    this.bus = bus;
    this.off = bus.on("purse:query:v1", (data) => {
      const request = data as Request;
      this.seen.push(request);
      let promise: Promise<unknown>;
      if (this.mode === "manual") {
        promise = new Promise((resolve) => this.open.push(resolve));
      } else {
        promise = Promise.resolve(this.answer(request));
      }
      request.respond(promise);
    });
  }

  /** Leave the bus: the billing service this fake stands for is gone, so queries go unanswered. */
  detach(): void {
    this.off();
  }
}

export class FakeTimers implements Timers {
  now = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  set(callback: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + ms, callback });
    return { clear: () => this.pending.delete(id) };
  }

  clear(handle: TimerHandle | undefined): void {
    handle?.clear();
  }

  get count(): number {
    return this.pending.size;
  }

  /** Advance the clock, firing due timers in order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const pendingEntry of this.pending) {
        if (pendingEntry[1].at <= target && (!next || pendingEntry[1].at < next[1].at))
          next = pendingEntry;
      }
      if (!next) break;
      this.pending.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
    }
    this.now = target;
  }
}

// ------------------------------------------------------------ reply fixtures

export function limit(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "w",
    label: "5 hour",
    unit: "percent",
    used: 90,
    limit: 100,
    percent: 90,
    resetsAt: Date.UTC(2026, 4, 12, 23, 0),
    windowSeconds: 18_000,
    models: null,
    severity: "critical",
    source: "endpoint",
    ...extra,
  };
}

export function entry(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ok",
    reason: null,
    capturedAt: Date.UTC(2026, 4, 12, 20, 0, 30),
    stale: false,
    plan: { state: "known", value: "Max" },
    balance: { state: "not-exposed" },
    limits: { state: "known", value: [] },
    models: {},
    ...extra,
  };
}

export function reply(
  providers: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { protocol: 1, status: "ok", generatedAt: 1000, providers, ...extra };
}

export function model(
  input: number | null,
  output: number | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    price: {
      rates: { input, output, cacheRead: null, cacheWrite: null },
      source: "inventory",
      ...extra,
    },
    severity: "ok",
  };
}

/** A fixed clock before the fixture resets (2026-05-12T20:00:30Z). */
export const NOW = Date.UTC(2026, 4, 12, 20, 0, 30);
