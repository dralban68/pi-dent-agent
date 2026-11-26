import { type BillingEntry, type ReadReply, applyPastReset, readReply } from "./billing-entry.ts";
import {
  type BillingReport,
  type BillingView,
  type ModelRef,
  billingProviders,
  buildBillingReport,
} from "./billing-text.ts";
import { type Diagnostic, errorMessage } from "./util.ts";

/**
 * The billing service client and held billing per specs/billing.md#service-protocol
 * and specs/billing.md#queries. One `BillingService` is one extension instance's billing state: its
 * event bus subscription, held billing, and pending queries. It never throws
 * and never produces a notification or session message; a failure outside a
 * query outcome goes to the diagnostic sink (specs/billing.md#diagnostics).
 */

export const QUERY_CHANNEL = "purse:query:v1";
export const CHANGED_CHANNEL = "purse:changed:v1";
export const REPLY_TIMEOUT_MS = 25_000;
/** The longest a guidance computation waits for its cached query (specs/billing.md#cached-query). */
export const CACHED_WAIT_MS = 500;
/** `maxWaitMs` of a report query (specs/billing.md#request-outcome). */
export const REPORT_MAX_WAIT_MS = 5000;

/** The part of the host event bus pi-dent uses. */
export interface BillingBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Injectable timers (tests use a fake clock). */
/** A started timer: calling `clear` cancels it. */
export interface TimerHandle {
  clear(): void;
}

export interface Timers {
  set(callback: () => void, ms: number): TimerHandle;
  clear(handle: TimerHandle | undefined): void;
}

export const realTimers: Timers = {
  set: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return { clear: () => clearTimeout(timer) };
  },
  clear: (handle) => handle?.clear(),
};

export type Outcome =
  | { status: "ok"; reply: ReadReply }
  | {
      status: "no-service" | "invalid" | "timeout" | "not-ready" | "bad-request" | "cancelled";
    }
  /** Internal: the service was shut down while the query was pending. */
  | { status: "closed" };

export type QueryMode = "cached" | "auto";

export interface StartedQuery {
  /** Settles with the outcome; never rejects. */
  outcome: Promise<Outcome>;
  /** The outcome when it was known without waiting (`no-service` or `invalid`). */
  immediate?: Outcome;
  /** Abandon the query: its timer is cleared and its outcome becomes `closed`. */
  cancel(): void;
}

/** Emit one billing query and track its outcome (specs/billing.md#request-outcome). */
export function startQuery(
  bus: BillingBus,
  providers: readonly string[],
  mode: QueryMode,
  timers: Timers,
  options: { timeoutMs?: number; maxWaitMs?: number } = {},
): StartedQuery {
  const timeoutMs = options.timeoutMs ?? REPLY_TIMEOUT_MS;
  let offering = true;
  let responded = false;
  let replyPromise: unknown;
  const respond = (reply: unknown): boolean => {
    if (!offering || responded) return false;
    responded = true;
    replyPromise = reply;
    return true;
  };
  try {
    bus.emit(QUERY_CHANNEL, {
      providers: [...providers],
      mode,
      ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
      respond,
    });
  } catch {
    // A throw before `respond` is `no-service` (specs/billing.md#request-outcome).
  }
  offering = false;
  const known = (outcome: Outcome): StartedQuery => ({
    outcome: Promise.resolve(outcome),
    immediate: outcome,
    cancel: () => {},
  });
  if (!responded) return known({ status: "no-service" });

  let thenFn: unknown;
  try {
    thenFn =
      typeof replyPromise === "object" && replyPromise !== null
        ? Reflect.get(replyPromise, "then")
        : undefined;
  } catch {
    thenFn = undefined;
  }
  if (typeof thenFn !== "function") return known({ status: "invalid" });

  let finish: (outcome: Outcome) => void = () => {};
  const outcome = new Promise<Outcome>((resolve) => {
    let settled = false;
    let timer: TimerHandle | undefined;
    finish = (result) => {
      if (settled) return;
      settled = true;
      timers.clear(timer);
      resolve(result);
    };
    timer = timers.set(() => finish({ status: "timeout" }), timeoutMs);
    try {
      Reflect.apply(thenFn, replyPromise, [
        (value: unknown) => {
          try {
            const reply = readReply(value, providers);
            if (!reply) finish({ status: "invalid" });
            else if (reply.status === "ok") finish({ status: "ok", reply });
            else finish({ status: reply.status });
          } catch {
            finish({ status: "invalid" });
          }
        },
        () => finish({ status: "invalid" }),
      ]);
    } catch {
      finish({ status: "invalid" });
    }
  });
  return { outcome, cancel: () => finish({ status: "closed" }) };
}

export interface BillingServiceDeps {
  bus: BillingBus;
  /** The guidance billing providers now; MUST NOT throw. */
  guidanceProviders: () => string[];
  timeZone: string;
  timers?: Timers;
  /** The clock for the past-reset rule; defaults to `Date.now`. */
  now?: () => number;
  /** Where a failure that is not a query outcome goes (specs/billing.md#diagnostics). */
  diagnostics?: (diagnostic: Diagnostic) => void;
}

/** Billing state of one extension instance (specs/billing.md#held-billing). */
export class BillingService {
  readonly zone: string;
  private readonly bus: BillingBus;
  private readonly guidanceProviders: () => string[];
  private readonly timers: Timers;
  private readonly held = new Map<string, { entry: BillingEntry; generatedAt: number }>();
  private readonly waitingSet = new Set<string>();
  private readonly cancels = new Set<() => void>();
  private readonly unsubscribe: (() => void) | undefined;
  private readonly now: () => number;
  private readonly diagnostics: ((diagnostic: Diagnostic) => void) | undefined;
  private pollPromise: Promise<void> | undefined;
  private lastPollNotReady = false;
  private changeDuringPoll = false;
  private answerWaiters: (() => void)[] = [];
  private cachedQuery: Promise<void> | undefined;
  /** The providers the pending cached query names; empty when none is pending. */
  private cachedQueryProviders = new Set<string>();
  private shut = false;

  constructor(deps: BillingServiceDeps) {
    this.bus = deps.bus;
    this.guidanceProviders = deps.guidanceProviders;
    this.zone = deps.timeZone;
    this.timers = deps.timers ?? realTimers;
    this.now = deps.now ?? Date.now;
    this.diagnostics = deps.diagnostics;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = this.bus.on(CHANGED_CHANNEL, (payload) => this.onChanged(payload));
    } catch (error) {
      unsubscribe = undefined;
      this.reportFailure(`billing: change notifications are unavailable: ${errorMessage(error)}`);
    }
    this.unsubscribe = unsubscribe;
  }

  /** Report a failure that is not a query outcome (specs/billing.md#diagnostics). */
  private reportFailure(message: string): void {
    this.diagnostics?.({ level: "warning", message });
  }

  get closed(): boolean {
    return this.shut;
  }

  /** Held billing as the text functions read it. */
  view(): BillingView {
    const now = this.now();
    const entries = new Map<string, BillingEntry>();
    for (const [provider, held] of this.held)
      entries.set(provider, applyPastReset(held.entry, now));
    return { zone: this.zone, entries };
  }

  /** Whether held billing has an entry for any of the providers. */
  holds(providers: readonly string[]): boolean {
    return providers.some((p) => this.held.has(p));
  }

  /** `session_shutdown` of the extension instance (specs/billing.md#held-billing). */
  close(): void {
    if (this.shut) return;
    this.shut = true;
    this.waitingSet.clear();
    this.answerWaiters = [];
    for (const cancel of this.cancels) cancel();
    this.cancels.clear();
    try {
      this.unsubscribe?.();
    } catch (error) {
      this.reportFailure(
        `billing: the change subscription could not be cancelled: ${errorMessage(error)}`,
      );
    }
  }

  private safeGuidanceProviders(): string[] {
    try {
      return billingProviders(this.guidanceProviders());
    } catch (error) {
      this.reportFailure(
        `billing: the guidance billing providers are unreadable: ${errorMessage(error)}`,
      );
      return [];
    }
  }

  /** Emit a query; its `ok` outcome updates held billing unless the service is closed. */
  private run(
    providers: readonly string[],
    mode: QueryMode,
    maxWaitMs?: number,
  ): StartedQuery & { applied: Promise<Outcome> } {
    const query = startQuery(
      this.bus,
      providers,
      mode,
      this.timers,
      maxWaitMs === undefined ? {} : { maxWaitMs },
    );
    this.cancels.add(query.cancel);
    const applied = query.outcome.then((outcome) => {
      this.cancels.delete(query.cancel);
      this.apply(outcome);
      return outcome;
    });
    return { ...query, applied };
  }

  private apply(outcome: Outcome): void {
    if (this.shut || outcome.status !== "ok") return;
    const { generatedAt, entries } = outcome.reply;
    for (const [provider, entry] of entries) {
      const current = this.held.get(provider);
      if (current && current.generatedAt > generatedAt) continue;
      this.held.set(provider, { entry, generatedAt });
    }
  }

  // ------------------------------------------------------------ poll (4.2)

  /** Start a billing poll when one is due. */
  startPoll(): void {
    if (this.shut || this.pollPromise) return;
    const providers = this.safeGuidanceProviders();
    if (providers.length === 0) return;
    this.changeDuringPoll = false;
    const query = this.run(providers, "auto");
    if (query.immediate) {
      // An immediate outcome is still an answer other than `not-ready`: a deferred
      // session_start that registered while the last poll was not ready waits on it.
      this.lastPollNotReady = false;
      this.releaseWaiters();
      return;
    }
    const pending = query.applied.then((outcome) => {
      if (this.pollPromise === pending) this.pollPromise = undefined;
      if (this.shut || outcome.status === "closed") return;
      this.lastPollNotReady = outcome.status === "not-ready";
      if (this.lastPollNotReady) {
        if (this.changeDuringPoll) this.startPoll();
        return;
      }
      this.releaseWaiters();
    });
    this.pollPromise = pending;
  }

  /** Fire and clear the `onPollAnswer` callbacks registered so far. */
  private releaseWaiters(): void {
    if (this.shut) return;
    const waiters = this.answerWaiters;
    this.answerWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /**
   * Call `callback` once when a poll has an outcome other than `not-ready`
   * (specs/model-guidance.md#guidance-message); dropped at shutdown.
   */
  onPollAnswer(callback: () => void): void {
    if (!this.shut) this.answerWaiters.push(callback);
  }

  /** The pending poll's settlement, or `undefined` when no poll is pending. */
  pendingPoll(): Promise<void> | undefined {
    return this.pollPromise;
  }

  // ------------------------------------------------------------ cached query (4.3)

  private onChanged(payload: unknown): void {
    if (this.shut) return;
    try {
      if (typeof payload !== "object" || payload === null) return;
      const named = Reflect.get(payload, "providers");
      if (!Array.isArray(named)) return;
      if (this.pollPromise) this.changeDuringPoll = true;
      else if (this.lastPollNotReady) this.startPoll();
      const guided = new Set(this.safeGuidanceProviders());
      for (const provider of named) {
        if (typeof provider === "string" && guided.has(provider)) this.waitingSet.add(provider);
      }
    } catch {
      return;
    }
    this.startCachedQuery();
  }

  /** Start the next cached query for the waiting set when none is pending (specs/billing.md#cached-query). */
  private startCachedQuery(): void {
    if (this.shut || this.cachedQuery || this.waitingSet.size === 0) return;
    const providers = [...this.waitingSet].toSorted();
    this.waitingSet.clear();
    const query = this.run(providers, "cached");
    if (query.immediate) return;
    const pending = query.applied.then(() => {
      if (this.cachedQuery === pending) {
        this.cachedQuery = undefined;
        this.cachedQueryProviders = new Set();
      }
      this.startCachedQuery();
    });
    this.cachedQuery = pending;
    this.cachedQueryProviders = new Set(providers);
  }

  /**
   * The cached-query step of a guidance computation (specs/billing.md#cached-query): the providers
   * no pending cached query names join the waiting set, a cached query starts for
   * it when none is pending, and the call then waits for at most 500 ms until no
   * cached query is pending.
   */
  async cachedQueryWait(providers: readonly string[]): Promise<void> {
    if (this.shut || providers.length === 0) return;
    for (const provider of providers) {
      if (!this.cachedQueryProviders.has(provider)) this.waitingSet.add(provider);
    }
    this.startCachedQuery();
    await this.waitForNoCachedQuery();
  }

  /** Wait for at most 500 ms until no cached query of the instance is pending (specs/billing.md#cached-query). */
  private async waitForNoCachedQuery(): Promise<void> {
    if (this.cachedQuery === undefined) return;
    let timer: TimerHandle | undefined;
    let timedOut = false;
    const deadline = new Promise<void>((resolve) => {
      timer = this.timers.set(() => {
        timedOut = true;
        resolve();
      }, CACHED_WAIT_MS);
    });
    let pending = this.cachedQuery;
    while (pending !== undefined && !timedOut) {
      await Promise.race([pending, deadline]);
      pending = this.cachedQuery;
    }
    this.timers.clear(timer);
  }

  // ------------------------------------------------------------ report (4.4)

  /** The report query of one `Session` call and its billing report (specs/billing.md#billing-report). */
  async report(models: readonly ModelRef[], signal?: AbortSignal): Promise<BillingReport | null> {
    const providers = billingProviders(models.map((m) => m.provider));
    if (!this.shut && providers.length > 0) {
      const query = this.run(providers, "auto", REPORT_MAX_WAIT_MS);
      if (!query.immediate && !signal?.aborted) {
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<void>((resolve) => {
          onAbort = () => resolve();
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        await Promise.race([query.applied, aborted]);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }
    }
    return buildBillingReport(this.view(), providers, models);
  }
}
