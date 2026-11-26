/**
 * pi-dent's footer (specs/footer.md): the lines, built from plain inputs, and the component that
 * gathers those inputs from the host.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { agentSegment, formatTokens, partialMarker, type UsageSum } from "./usage.ts";

/** A host theme colour the footer uses. */
export type FooterColor = "accent" | "dim" | "muted" | "warning" | "error";
export type FooterPaint = (color: FooterColor, text: string) => string;

/** One host `usage` field (specs/agent-tool.md#usage). */
export interface EntryUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

/** The parts of a session entry the footer reads (specs/footer.md#stats-line). */
export interface FooterEntry {
  type: string;
  usage?: EntryUsage | undefined;
  message?: { role: string; usage?: EntryUsage | undefined } | undefined;
}

export interface SessionTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** The session totals and the cache-hit rate of the latest assistant message. */
export interface SessionStats {
  totals: SessionTotals;
  cacheHitRate: number | undefined;
}

/**
 * The totals of every session entry that carries a usage, on every branch, and the cache-hit
 * rate of the latest assistant message (specs/footer.md#stats-line).
 */
export function sessionStats(entries: readonly FooterEntry[]): SessionStats {
  const totals: SessionTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let cacheHitRate: number | undefined;
  const add = (usage: EntryUsage): void => {
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost.total;
  };
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type === "usage") {
      if (entry.usage !== undefined) add(entry.usage);
    } else if (entry.type === "message" && message !== undefined) {
      if (message.role === "assistant") {
        if (message.usage === undefined) continue;
        add(message.usage);
        const prompt = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
        cacheHitRate = prompt > 0 ? (message.usage.cacheRead / prompt) * 100 : undefined;
      } else if (message.role === "toolResult" && message.usage !== undefined) {
        add(message.usage);
      }
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      add(entry.usage);
    }
  }
  return { totals, cacheHitRate };
}

export interface FooterModel {
  id: string;
  provider: string;
  contextWindow?: number | undefined;
  reasoning?: boolean | undefined;
}

/** The host's context usage (its `ContextUsage`, minus the token count). */
export interface FooterContextUsage {
  percent: number | null;
  contextWindow: number;
}

/** The usage tally's snapshot (specs/agent-tool.md#usage). */
export interface FooterTally {
  tasks: number;
  sum: UsageSum;
  /** Whether the tally is partial (specs/agent-tool.md#usage); absent counts as not. */
  partial?: boolean | undefined;
}

/** The footer inputs other than the width, the paint, and the host data provider. */
export interface FooterValues {
  cwd: string;
  home: string | undefined;
  sessionName: string | undefined;
  model: FooterModel | undefined;
  thinkingLevel: string | undefined;
  /** Whether the host model registry reports the current model as OAuth-paid. */
  subscription: boolean;
  autoCompact: boolean;
  tally: FooterTally;
}

export interface FooterInput extends FooterValues {
  width: number;
  branch: string | null;
  providerCount: number;
  statuses: ReadonlyMap<string, string>;
  paint: FooterPaint;
  contextUsage: FooterContextUsage | undefined;
  /** The session statistics; computed from `entries` when absent. */
  stats?: SessionStats | undefined;
  entries?: readonly FooterEntry[] | undefined;
}

/** The columns between the left and the right side of the stats line. */
const MIN_PADDING = 2;

const TRUNCATION = "...";

/** The home directory and anything inside it shortened to `~` (specs/footer.md#path-line). */
function shortenHome(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const inside = relative(resolve(home), resolve(cwd));
  if (inside === "") return "~";
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return cwd;
  return `~${sep}${inside}`;
}

/** `<cwd><branch><name>`, truncated to the width with the marker (specs/footer.md#path-line). */
function pathLine(input: FooterInput): string {
  const dir = shortenHome(input.cwd, input.home);
  const branch = input.branch ? ` (${input.branch})` : "";
  const name = input.sessionName ? ` • ${input.sessionName}` : "";
  const text = `${dir}${branch}${name}`;
  return truncateToWidth(input.paint("dim", text), input.width, input.paint("dim", TRUNCATION));
}

/** `<percent>%/<window>` or `?/<window>`, coloured by the usage (specs/footer.md#stats-line). */
function contextSegment(input: FooterInput): string {
  const percent = input.contextUsage?.percent ?? null;
  const window = formatTokens(input.contextUsage?.contextWindow ?? input.model?.contextWindow ?? 0);
  const text = `${percent === null ? "?" : `${percent.toFixed(1)}%`}/${window}${input.autoCompact ? " (auto)" : ""}`;
  if (percent === null) return text;
  if (percent > 90) return input.paint("error", text);
  if (percent > 70) return input.paint("warning", text);
  return text;
}

/** `<provider><model><thinking>` (specs/footer.md#stats-line), with the provider when `withProvider` holds. */
function rightSide(input: FooterInput, withProvider: boolean): string {
  const model = input.model;
  const id = model?.id ?? "no-model";
  let text = id;
  if (model?.reasoning) {
    const level = input.thinkingLevel ? input.thinkingLevel : "off";
    text = level === "off" ? `${id} • thinking off` : `${id} • ${level}`;
  }
  return withProvider && model !== undefined ? `(${model.provider}) ${text}` : text;
}

const fitLeft = (text: string, width: number, paint: FooterPaint): string =>
  visibleWidth(text) > width ? truncateToWidth(text, width, paint("dim", TRUNCATION)) : text;

/**
 * The stats line and, when the line had to give it up, the `│ <agents>` segment that moves to
 * the status line (specs/footer.md#stats-line).
 */
function statsLine(
  input: FooterInput,
  stats: SessionStats,
): { line: string; movedAgents: string | undefined } {
  const { paint, width } = input;
  const totals = stats.totals;
  const segments: string[] = [];
  if (totals.input !== 0) segments.push(`↑${formatTokens(totals.input)}`);
  if (totals.output !== 0) segments.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead !== 0) segments.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite !== 0) segments.push(`W${formatTokens(totals.cacheWrite)}`);
  if ((totals.cacheRead !== 0 || totals.cacheWrite !== 0) && stats.cacheHitRate !== undefined) {
    segments.push(`CH${stats.cacheHitRate.toFixed(1)}%`);
  }
  if (totals.cost !== 0 || input.subscription) {
    segments.push(`$${totals.cost.toFixed(3)}${input.subscription ? " (sub)" : ""}`);
  }
  segments.push(contextSegment(input));
  const withoutAgents = segments.join(" ");

  const agents =
    input.tally.tasks >= 1
      ? `${agentSegment(input.tally.tasks, input.tally.sum, paint)}${partialMarker(input.tally.partial === true, paint)}`
      : undefined;
  let left = fitLeft(
    agents === undefined ? withoutAgents : `${withoutAgents} ${paint("dim", "│")} ${agents}`,
    width,
    paint,
  );
  let right = rightSide(input, input.providerCount > 1);
  const overflows = (): boolean => visibleWidth(left) + MIN_PADDING + visibleWidth(right) > width;

  // The fit rule, in order: the agents segment, then the provider, then the right side itself.
  let movedAgents: string | undefined;
  if (agents !== undefined && overflows()) {
    movedAgents = agents;
    left = fitLeft(withoutAgents, width, paint);
  }
  if (input.providerCount > 1 && input.model !== undefined && overflows()) {
    right = rightSide(input, false);
  }
  if (overflows()) {
    const room = width - visibleWidth(left) - MIN_PADDING;
    right = room > 0 ? truncateToWidth(right, room, "") : "";
  }

  if (right === "") return { line: paint("dim", left), movedAgents };
  const padding = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
  return {
    line: paint("dim", left) + paint("dim", `${" ".repeat(padding)}${right}`),
    movedAgents,
  };
}

/** One status text on a single line: no breaks or tabs, single spaces, no outer spaces. */
export function sanitizeStatus(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/** The status line, or nothing when it would be empty (specs/footer.md#status-line). */
function statusLine(input: FooterInput, movedAgents: string | undefined): string | undefined {
  const texts = [...input.statuses.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, text]) => sanitizeStatus(text))
    .filter((text) => text !== "");
  if (movedAgents !== undefined) texts.unshift(movedAgents);
  if (texts.length === 0) return undefined;
  return truncateToWidth(
    texts.join(input.paint("dim", " │ ")),
    input.width,
    input.paint("dim", TRUNCATION),
  );
}

/** The footer's lines (specs/footer.md#lines): the path line, the stats line, and, when not empty, the status line. */
export function footerLines(input: FooterInput): string[] {
  const stats = input.stats ?? sessionStats(input.entries ?? []);
  const { line, movedAgents } = statsLine(input, stats);
  const status = statusLine(input, movedAgents);
  const lines = [pathLine(input), line];
  if (status !== undefined) lines.push(status);
  return lines;
}

/** The fields of the host footer data provider the footer reads. */
export interface FooterData {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
}

/** The host surface the footer component needs. */
export interface FooterComponentHost {
  paint: FooterPaint;
  footerData: FooterData;
  /**
   * The session and model state the cached values depend on. Every append moves the leaf, so a
   * render with an unchanged key reuses the totals instead of scanning the session again.
   */
  sessionKey(): string;
  /** The session's entries, read only when `sessionKey` changes. */
  entries(): readonly FooterEntry[];
  /** The host's context usage, read only when `sessionKey` changes. */
  contextUsage(): FooterContextUsage | undefined;
  /** The remaining inputs, read at every render. */
  values(): FooterValues;
  /** A render that threw: the footer reports it and renders no more lines. */
  failed(error: unknown): void;
  /** The host dropped the component. */
  disposed(): void;
}

export interface FooterComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose(): void;
}

/** The footer's component (specs/footer.md#activation): the lines of `footerLines`, cached per session state. */
export function createFooterComponent(host: FooterComponentHost): FooterComponent {
  let cache:
    | { key: string; stats: SessionStats; contextUsage: FooterContextUsage | undefined }
    | undefined;
  let failed = false;
  return {
    render(width: number): string[] {
      if (failed) return [];
      try {
        const key = host.sessionKey();
        if (cache?.key !== key) {
          cache = { key, stats: sessionStats(host.entries()), contextUsage: host.contextUsage() };
        }
        return footerLines({
          ...host.values(),
          width,
          branch: host.footerData.getGitBranch(),
          providerCount: host.footerData.getAvailableProviderCount(),
          statuses: host.footerData.getExtensionStatuses(),
          paint: host.paint,
          contextUsage: cache.contextUsage,
          stats: cache.stats,
        });
      } catch (error) {
        failed = true;
        host.failed(error);
        return [];
      }
    },
    invalidate(): void {
      cache = undefined;
    },
    dispose(): void {
      host.disposed();
    },
  };
}
