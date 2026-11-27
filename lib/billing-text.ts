import {
  type BillingEntry,
  type LimitWindow,
  type ModelRecord,
  type Severity,
  gravity,
  isAlarming,
  isCounted,
  providerState,
} from "./billing-entry.ts";

/**
 * Billing text per specs/billing.md#billing-text, specs/billing.md#guidance-billing, specs/billing.md#billing-report: time zone and time
 * stamps, number rendering, per-model annotations, the billing note, and the
 * `Session` billing report. Everything here is composed from pi-dent's own words,
 * ids, and formatted numbers.
 */

/** Held billing as the text functions read it: one entry per provider, and the local zone. */
export interface BillingView {
  zone: string;
  entries: ReadonlyMap<string, BillingEntry>;
}

// ---------------------------------------------------------------- providers

/** Billing providers of a set of provider components (specs/billing.md#providers): distinct, ascending. */
export function billingProviders(providers: Iterable<string>): string[] {
  return [...new Set(providers)].toSorted(compareAscii);
}

export function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- zone

const ZONE_PATTERN = /^[A-Za-z0-9_+/-]{1,64}$/u;

/** The local zone from a candidate `timeZone` value (specs/billing.md#billing-text); `UTC` when unusable. */
export function localZoneFrom(candidate: unknown): string {
  if (typeof candidate !== "string" || !ZONE_PATTERN.test(candidate)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return "UTC";
  }
}

/** Read the local zone once from the runtime (specs/billing.md#billing-text). */
export function readLocalZone(): string {
  try {
    return localZoneFrom(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "UTC";
  }
}

interface LocalFields {
  date: string;
  hm: string;
  hms: string;
  offset: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Local date, time, and offset of an epoch-millisecond instant in a zone. */
function localFields(ms: number, zone: string): LocalFields {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(zone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const year = parts.year ?? 0;
  const month = parts.month ?? 1;
  const day = parts.day ?? 1;
  const hour = (parts.hour ?? 0) % 24;
  const minute = parts.minute ?? 0;
  const second = parts.second ?? 0;
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.trunc((localAsUtc - Math.floor(ms / 1000) * 1000) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return {
    date: `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
    hm: `${pad(hour)}:${pad(minute)}`,
    hms: `${pad(hour)}:${pad(minute)}:${pad(second)}`,
    offset: `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
  };
}

/** Minute stamp (specs/billing.md#billing-text): the instant rounded up to the minute, UTC with local time. */
export function minuteStamp(ms: number, zone: string): string {
  const rounded = Math.ceil(ms / 60_000) * 60_000;
  const utc = new Date(rounded).toISOString();
  const local = localFields(rounded, zone);
  const localText = local.date === utc.slice(0, 10) ? local.hm : `${local.date}T${local.hm}`;
  return `${utc.slice(0, 16)}Z (${localText}${local.offset})`;
}

/** Local time stamp: the instant rounded down to the second, `YYYY-MM-DDTHH:MM:SS±HH:MM` in `zone`. */
export function localStampIn(ms: number, zone: string): string {
  const rounded = Math.floor(ms / 1000) * 1000;
  const local = localFields(rounded, zone);
  return `${local.date}T${local.hms}${local.offset}`;
}

/** Second stamp (specs/billing.md#billing-text): the instant rounded down to the second, UTC with local time. */
export function secondStamp(ms: number, zone: string): string {
  const rounded = Math.floor(ms / 1000) * 1000;
  const utc = new Date(rounded).toISOString();
  return `${utc.slice(0, 19)}Z (${localStampIn(rounded, zone)})`;
}

// ---------------------------------------------------------------- numbers and text

/** Decimal rendering to `places` places (specs/billing.md#billing-text). */
export function decimal(value: number, places: number): string {
  const rounded = Number(value.toFixed(places));
  if (value > 0 && rounded === 0) return String(Number(`1e-${places}`));
  return String(rounded);
}

function decimalOrQuestion(value: number | null, places: number): string {
  return value === null ? "?" : decimal(value, places);
}

/** Sanitized text (specs/billing.md#billing-text); `null` when empty. */
export function sanitizeText(value: string): string | null {
  let text = value
    .replace(/[^\p{L}\p{N} ._\-/+()]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, 64);
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  text = text.trimEnd();
  return text === "" ? null : text;
}

// ---------------------------------------------------------------- windows

/** Window name (specs/billing.md#billing-text). */
export function windowName(window: LimitWindow): string {
  const d = window.windowSeconds;
  let base: string;
  if (d === null) base = "window";
  else if (d % 86_400 === 0) base = `${d / 86_400}d`;
  else if (d % 3600 === 0) base = `${d / 3600}h`;
  else if (d % 60 === 0) base = `${d / 60}m`;
  else base = `${d}s`;
  switch (window.unit) {
    case "tokens":
      return `${base} tokens`;
    case "requests":
      return `${base} requests`;
    case "credits":
      return `${base} credits`;
    case "currency":
      return `${base} spend`;
    default:
      return base;
  }
}

const WINDOW_MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/u;

function windowClause(window: LimitWindow, zone: string): string {
  const base = `${windowName(window)} ${window.severity}`;
  return window.resetsAt === null ? base : `${base} until ${minuteStamp(window.resetsAt, zone)}`;
}

/** Window clauses of the counted, alarming windows in window-clause order (specs/billing.md#billing-text). */
function alarmingClauses(windows: readonly LimitWindow[], zone: string): string[] {
  return windows
    .filter((w) => isCounted(w) && isAlarming(w.severity))
    .map((w) => ({ w, text: windowClause(w, zone) }))
    .toSorted((a, b) => {
      const g = (gravity(b.w.severity) ?? 0) - (gravity(a.w.severity) ?? 0);
      if (g !== 0) return g;
      const n = compareAscii(windowName(a.w), windowName(b.w));
      if (n !== 0) return n;
      if (a.w.resetsAt !== b.w.resetsAt) {
        if (a.w.resetsAt === null) return 1;
        if (b.w.resetsAt === null) return -1;
        return a.w.resetsAt - b.w.resetsAt;
      }
      return compareAscii(a.text, b.text);
    })
    .map(({ text }) => text);
}

// ---------------------------------------------------------------- annotation

const EMPTY_RECORD: ModelRecord = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  source: null,
  schedule: null,
  severity: "unknown",
};

function ratePair(input: number | null, output: number | null): string {
  return `$${decimalOrQuestion(input, 3)}/$${decimalOrQuestion(output, 3)}`;
}

function price(entry: BillingEntry, record: ModelRecord, zone: string): string | undefined {
  if (providerState(entry) === "free" || record.source === "free") return "free";
  if (record.input === null && record.output === null) return undefined;
  const schedule = record.schedule;
  if (!schedule) return ratePair(record.input, record.output);
  const m = decimal(schedule.multiplier, 3);
  if (schedule.active) {
    const scaled = ratePair(
      record.input === null ? null : record.input * schedule.multiplier,
      record.output === null ? null : record.output * schedule.multiplier,
    );
    const until =
      schedule.changesAt === null ? "" : ` until ${minuteStamp(schedule.changesAt, zone)}`;
    return `${scaled} (×${m})${until}`;
  }
  const pair = ratePair(record.input, record.output);
  return schedule.changesAt === null
    ? pair
    : `${pair}, ×${m} from ${minuteStamp(schedule.changesAt, zone)}`;
}

/** Billing annotation of a guided model (specs/billing.md#billing-annotation); empty when there are no parts. */
export function billingAnnotation(
  entry: BillingEntry | undefined,
  id: string,
  zone: string,
): string {
  if (!entry) return "";
  const parts: string[] = [];
  const priced = price(entry, entry.models.get(id) ?? EMPTY_RECORD, zone);
  if (priced !== undefined) parts.push(priced);
  const state = providerState(entry);
  if (
    state === "untracked" ||
    state === "unknown" ||
    state === "low" ||
    state === "critical" ||
    state === "exhausted"
  ) {
    parts.push(state);
  }
  const providerWide =
    entry.status === "ok" || entry.status === "partial"
      ? alarmingClauses(
          entry.limits.filter((w) => w.models === null),
          zone,
        ).slice(0, 2)
      : [];
  const scoped =
    entry.status === "ok" || entry.status === "partial"
      ? alarmingClauses(
          entry.limits.filter((w) => w.models?.includes(id)),
          zone,
        ).slice(0, 2)
      : [];
  for (const clause of providerWide) parts.push(clause);
  for (const clause of scoped) parts.push(clause);
  return parts.length === 0 ? "" : ` [${parts.join("; ")}]`;
}

// ---------------------------------------------------------------- billing note

/** Billing note (specs/billing.md#billing-note). */
export function billingNote(view: BillingView): string {
  return `Choose by stated use first; among models suited to a task, prefer the cheaper, counting a discount (×) while it lasts. Prices are USD per million input/output tokens; times UTC, local ${view.zone} in parentheses. Requests to an exhausted provider or model fail until its reset. Providers without limit data are marked unknown or untracked.`;
}

// ---------------------------------------------------------------- report

export interface ModelRef {
  provider: string;
  id: string;
}

export interface ReportModel {
  model: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  schedule: { multiplier: number; active: boolean; changesAt: number | null } | null;
  severity: Severity;
}

export interface ReportLimit {
  label: string | null;
  unit: string | null;
  currency: string | null;
  percent: number | null;
  used: number | null;
  limit: number | null;
  resetsAt: number | null;
  windowSeconds: number | null;
  models: string[] | null;
  severity: Severity;
}

export interface ReportRecord {
  provider: string;
  state: string;
  status: string;
  reason: string | null;
  capturedAt: number | null;
  stale: boolean;
  plan: string | null;
  balance: { amount: number; currency: string; gatesUsage: boolean; severity: Severity }[];
  limits: ReportLimit[];
  models: ReportModel[];
}

export interface BillingReport {
  timeZone: string;
  providers: ReportRecord[];
}

const REASON_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** The billing report (specs/billing.md#billing-report); `null` when it would hold no record. */
export function buildBillingReport(
  view: BillingView,
  providers: readonly string[],
  models: readonly ModelRef[],
): BillingReport | null {
  const records: ReportRecord[] = [];
  for (const provider of providers) {
    const entry = view.entries.get(provider);
    if (!entry) continue;
    const reportModels: ReportModel[] = [];
    const refs = [
      ...new Map(
        models
          .filter((m) => m.provider === provider)
          .map((m) => [`${m.provider}/${m.id}`, { ...m, name: `${m.provider}/${m.id}` }]),
      ).values(),
    ].toSorted((a, b) => compareAscii(a.name, b.name));
    for (const ref of refs) {
      const record = entry.models.get(ref.id);
      if (!record) continue;
      reportModels.push({
        model: ref.name,
        input: record.input,
        output: record.output,
        cacheRead: record.cacheRead,
        cacheWrite: record.cacheWrite,
        schedule: record.schedule ? { ...record.schedule } : null,
        severity: record.severity,
      });
    }
    records.push({
      provider,
      state: providerState(entry),
      status: entry.status,
      reason: entry.reason !== null && REASON_PATTERN.test(entry.reason) ? entry.reason : null,
      capturedAt: entry.capturedAt,
      stale: entry.stale,
      plan: entry.plan === null ? null : sanitizeText(entry.plan),
      balance: entry.balance.map((b) => ({ ...b })),
      limits: entry.limits.map((w) => ({
        label: w.label === null ? null : sanitizeText(w.label),
        unit: w.unit,
        currency: w.currency,
        percent: w.percent,
        used: w.used,
        limit: w.limit,
        resetsAt: w.resetsAt,
        windowSeconds: w.windowSeconds,
        models: w.models === null ? null : w.models.filter((m) => WINDOW_MODEL_PATTERN.test(m)),
        severity: w.severity,
      })),
      models: reportModels,
    });
  }
  return records.length === 0 ? null : { timeZone: view.zone, providers: records };
}

function reportModelLine(m: ReportModel, zone: string): string {
  let line = `  ${m.model}: $${decimalOrQuestion(m.input, 3)}/$${decimalOrQuestion(m.output, 3)}, cache $${decimalOrQuestion(m.cacheRead, 3)}/$${decimalOrQuestion(m.cacheWrite, 3)}`;
  const s = m.schedule;
  if (s) {
    const x = decimal(s.multiplier, 3);
    if (s.active) {
      line += `, ×${x} now`;
      if (s.changesAt !== null) line += ` until ${secondStamp(s.changesAt, zone)}`;
    } else if (s.changesAt !== null) {
      line += `, ×${x} from ${secondStamp(s.changesAt, zone)}`;
    }
  }
  return `${line}; ${m.severity}`;
}

function reportLimitLine(w: ReportLimit, zone: string): string {
  const percent = decimalOrQuestion(w.percent, 1);
  let line = `  limit ${w.label ?? "?"}: ${w.percent === null ? percent : `${percent}% used`}`;
  if (w.used !== null) {
    const unit = w.unit === "currency" ? w.currency : w.unit;
    line += ` (${decimal(w.used, 3)}/${decimalOrQuestion(w.limit, 3)}${unit === null ? "" : ` ${unit}`})`;
  }
  if (w.resetsAt !== null) line += `; resets ${secondStamp(w.resetsAt, zone)}`;
  if (w.models !== null && w.models.length > 0) line += `; for ${w.models.join(",")}`;
  return `${line}; ${w.severity}`;
}

/** Text of a billing report (specs/billing.md#billing-report), one block per record. */
export function billingReportText(report: BillingReport): string {
  const lines: string[] = [];
  for (const r of report.providers) {
    let head = `${r.provider}: ${r.state}; status ${r.status}`;
    if (r.reason !== null) head += `; reason ${r.reason}`;
    if (r.plan !== null) head += `; plan ${r.plan}`;
    if (r.capturedAt !== null) head += `; captured ${secondStamp(r.capturedAt, report.timeZone)}`;
    if (r.stale) head += "; stale";
    lines.push(head);
    for (const b of r.balance) {
      lines.push(`  balance ${decimal(b.amount, 2)} ${b.currency} ${b.severity}`);
    }
    for (const w of r.limits) lines.push(reportLimitLine(w, report.timeZone));
    for (const m of r.models) lines.push(reportModelLine(m, report.timeZone));
  }
  return lines.join("\n");
}
