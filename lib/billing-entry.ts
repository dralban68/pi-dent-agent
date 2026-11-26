/**
 * Billing entries per specs/billing.md#billing-entry: the validated, typed form
 * of one provider's data in a billing query reply, and the values derived from
 * it that need no rendering (provider state, window ordering). Every function
 * here treats its input as untrusted data of unknown type.
 */

export type Severity = "ok" | "low" | "critical" | "exhausted" | "unknown";
export type EntryStatus =
  | "unknown-provider"
  | "free"
  | "no-adapter"
  | "ok"
  | "partial"
  | "unavailable"
  | "not-collected";
export type Unit =
  | "percent"
  | "credits"
  | "tokens"
  | "requests"
  | "concurrent-requests"
  | "currency";

export interface BalanceItem {
  amount: number;
  currency: string;
  gatesUsage: boolean;
  severity: Severity;
}

export interface LimitWindow {
  label: string | null;
  unit: Unit | null;
  used: number | null;
  limit: number | null;
  percent: number | null;
  resetsAt: number | null;
  currency: string | null;
  windowSeconds: number | null;
  models: string[] | null;
  severity: Severity;
}

export interface PriceSchedule {
  multiplier: number;
  active: boolean;
  changesAt: number | null;
}

export interface ModelRecord {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  source: string | null;
  schedule: PriceSchedule | null;
  severity: Severity;
}

export interface BillingEntry {
  status: EntryStatus;
  reason: string | null;
  capturedAt: number | null;
  stale: boolean;
  plan: string | null;
  balance: BalanceItem[];
  limits: LimitWindow[];
  models: Map<string, ModelRecord>;
}

/** Largest instant a billing entry may carry (epoch milliseconds, 9999-01-01T00:00Z). */
export const MAX_INSTANT = 253_370_764_800_000;

const STATUSES: readonly EntryStatus[] = [
  "unknown-provider",
  "free",
  "no-adapter",
  "ok",
  "partial",
  "unavailable",
  "not-collected",
];
const SEVERITIES: readonly Severity[] = ["ok", "low", "critical", "exhausted", "unknown"];
const UNITS: readonly Unit[] = [
  "percent",
  "credits",
  "tokens",
  "requests",
  "concurrent-requests",
  "currency",
];
const CURRENCY = /^[A-Z]{3}$/u;

/** Gravity of a severity; `unknown` has none. */
const GRAVITY: Readonly<Record<string, number>> = { ok: 0, low: 1, critical: 2, exhausted: 3 };

export function gravity(severity: Severity): number | undefined {
  return GRAVITY[severity];
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function instant(value: unknown): number | null {
  const n = finite(value);
  return n !== null && n >= 0 && n <= MAX_INSTANT ? n : null;
}

function severityOf(value: unknown): Severity {
  return SEVERITIES.find((s) => s === value) ?? "unknown";
}

function rate(value: unknown): number | null {
  const n = finite(value);
  return n !== null && n >= 0 && n < 1_000_000 ? n : null;
}

function readBalanceItem(value: unknown): BalanceItem | undefined {
  if (!isObj(value)) return undefined;
  const amount = finite(value.amount);
  const currency = value.currency;
  if (amount === null || typeof currency !== "string" || !CURRENCY.test(currency)) {
    return undefined;
  }
  return {
    amount,
    currency,
    gatesUsage: value.gatesUsage === true,
    severity: severityOf(value.severity),
  };
}

function readLimitWindow(value: unknown): LimitWindow | undefined {
  if (!isObj(value)) return undefined;
  const rawModels = value.models;
  let models: string[] | null;
  if (rawModels === null) models = null;
  else if (Array.isArray(rawModels)) {
    models = [];
    for (const m of rawModels) {
      if (typeof m !== "string") return undefined;
      models.push(m);
    }
  } else return undefined;
  const percent = finite(value.percent);
  const windowSeconds = value.windowSeconds;
  return {
    label: typeof value.label === "string" ? value.label : null,
    unit: UNITS.find((u) => u === value.unit) ?? null,
    used: finite(value.used),
    limit: finite(value.limit),
    percent: percent !== null && percent >= 0 ? percent : null,
    resetsAt: instant(value.resetsAt),
    currency:
      typeof value.currency === "string" && CURRENCY.test(value.currency) ? value.currency : null,
    windowSeconds:
      typeof windowSeconds === "number" && Number.isInteger(windowSeconds) && windowSeconds > 0
        ? windowSeconds
        : null,
    models,
    severity: severityOf(value.severity),
  };
}

function readModelRecord(value: unknown): ModelRecord | undefined {
  if (!isObj(value)) return undefined;
  const price = isObj(value.price) ? value.price : undefined;
  const rates = price && isObj(price.rates) ? price.rates : undefined;
  const sched = price && isObj(price.schedule) ? price.schedule : undefined;
  const multiplier = sched ? finite(sched.multiplier) : null;
  return {
    input: rates ? rate(rates.input) : null,
    output: rates ? rate(rates.output) : null,
    cacheRead: rates ? rate(rates.cacheRead) : null,
    cacheWrite: rates ? rate(rates.cacheWrite) : null,
    source: price && typeof price.source === "string" ? price.source : null,
    schedule:
      sched && multiplier !== null && multiplier > 0
        ? {
            multiplier,
            active: sched.active === true,
            changesAt: instant(sched.changesAt),
          }
        : null,
    severity: severityOf(value.severity),
  };
}

function knownFacet(value: unknown): unknown {
  return isObj(value) && value.state === "known" ? value.value : undefined;
}

function readList<T>(facet: unknown, read: (item: unknown) => T | undefined): T[] {
  const list = knownFacet(facet);
  if (!Array.isArray(list)) return [];
  const result: T[] = [];
  for (const item of list) {
    const read1 = read(item);
    if (read1 !== undefined) result.push(read1);
  }
  return result;
}

/** One provider's billing entry; `undefined` when the value is invalid (specs/billing.md#billing-entry). */
export function readBillingEntry(value: unknown): BillingEntry | undefined {
  if (!isObj(value) || typeof value.status !== "string") return undefined;
  const models = new Map<string, ModelRecord>();
  if (isObj(value.models)) {
    for (const key of Object.keys(value.models)) {
      const record = readModelRecord(value.models[key]);
      if (record) models.set(key, record);
    }
  }
  const plan = knownFacet(value.plan);
  return {
    status: STATUSES.find((s) => s === value.status) ?? "unavailable",
    reason: typeof value.reason === "string" ? value.reason : null,
    capturedAt: instant(value.capturedAt),
    stale: value.stale === true,
    plan: typeof plan === "string" ? plan : null,
    balance: readList(value.balance, readBalanceItem),
    limits: readList(value.limits, readLimitWindow),
    models,
  };
}

/** A reply of specs/billing.md#request-outcome reduced to its valid entries for the requested providers. */
export interface ReadReply {
  status: "ok" | "not-ready" | "bad-request" | "cancelled";
  generatedAt: number;
  entries: Map<string, BillingEntry>;
}

/** Validate a reply; `undefined` when it is invalid (specs/billing.md#request-outcome). May throw on hostile input. */
export function readReply(value: unknown, requested: readonly string[]): ReadReply | undefined {
  if (!isObj(value)) return undefined;
  const status = value.status;
  if (
    value.protocol !== 1 ||
    (status !== "ok" &&
      status !== "not-ready" &&
      status !== "bad-request" &&
      status !== "cancelled")
  ) {
    return undefined;
  }
  const generatedAt = finite(value.generatedAt);
  if (generatedAt === null || !isObj(value.providers)) return undefined;
  const entries = new Map<string, BillingEntry>();
  if (status === "ok") {
    for (const provider of requested) {
      if (!Object.hasOwn(value.providers, provider)) continue;
      const entry = readBillingEntry(value.providers[provider]);
      if (entry) entries.set(provider, entry);
    }
  }
  return { status, generatedAt, entries };
}

/** Counted limit window: of unknown length or at least one hour (specs/billing.md#billing-text). */
export function isCounted(window: LimitWindow): boolean {
  return window.windowSeconds === null || window.windowSeconds >= 3600;
}

export function gravestSeverity(severities: Iterable<Severity>): Severity | undefined {
  let best: Severity | undefined;
  for (const severity of severities) {
    const g = gravity(severity);
    if (g === undefined) continue;
    if (best === undefined || g > (gravity(best) ?? -1)) best = severity;
  }
  return best;
}

/** Provider state of an entry (specs/billing.md#billing-text). */
export function providerState(entry: BillingEntry): string {
  switch (entry.status) {
    case "free":
      return "free";
    case "no-adapter":
    case "unknown-provider":
      return "untracked";
    case "ok":
    case "partial":
      return (
        gravestSeverity([
          ...entry.balance.filter((b) => b.gatesUsage).map((b) => b.severity),
          ...entry.limits.filter((w) => isCounted(w) && w.models === null).map((w) => w.severity),
        ]) ?? "unknown"
      );
    default:
      return "unknown";
  }
}

export function isAlarming(severity: Severity): boolean {
  return severity === "low" || severity === "critical" || severity === "exhausted";
}

/**
 * Past reset (specs/billing.md#billing-text): a window whose `resetsAt` is at or before
 * `now` has `used` and `percent` `null` and severity `unknown`.
 */
export function applyPastReset(entry: BillingEntry, now: number): BillingEntry {
  const past = (w: LimitWindow) => w.resetsAt !== null && w.resetsAt <= now;
  if (!entry.limits.some(past)) return entry;
  return {
    ...entry,
    limits: entry.limits.map((w) =>
      past(w) ? { ...w, used: null, percent: null, severity: "unknown" } : w,
    ),
  };
}
