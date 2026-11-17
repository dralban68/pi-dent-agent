/**
 * Usage sums, the usage tally, and their rendering (specs/agent-tool.md Section 13).
 */

/** A usage sum: token counts, cost in US dollars, and assistant turns. */
export interface UsageSum {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

/** The host `usage` fields of an assistant message that a usage sum reads. */
export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

export function zeroUsageSum(): UsageSum {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/** `sum` plus one assistant message: its usage when it has one, and one turn. */
export function addMessage(sum: UsageSum | undefined, usage: MessageUsage | undefined): UsageSum {
  const base = sum ?? zeroUsageSum();
  return {
    input: base.input + (usage?.input ?? 0),
    output: base.output + (usage?.output ?? 0),
    cacheRead: base.cacheRead + (usage?.cacheRead ?? 0),
    cacheWrite: base.cacheWrite + (usage?.cacheWrite ?? 0),
    cost: base.cost + (usage?.cost.total ?? 0),
    turns: base.turns + 1,
  };
}

/** A token count: `999`, `1.5k`, `15k`, `1.5M`, `15M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

/** The three segments of `<usage>`: turns, tokens, cost. */
function usageSegments(sum: UsageSum): [turns: string, tokens: string, cost: string] {
  const cache =
    (sum.cacheRead === 0 ? "" : ` R${formatTokens(sum.cacheRead)}`) +
    (sum.cacheWrite === 0 ? "" : ` W${formatTokens(sum.cacheWrite)}`);
  return [
    `${sum.turns} ${sum.turns === 1 ? "turn" : "turns"}`,
    `↑${formatTokens(sum.input)} ↓${formatTokens(sum.output)}${cache}`,
    `$${sum.cost.toFixed(3)}`,
  ];
}

/** `<usage>`: `<turns> <unit> · ↑<input> ↓<output><cache> · $<cost>`. */
export function formatUsage(sum: UsageSum): string {
  return usageSegments(sum).join(" · ");
}

/** Host theme colouring of the usage status line. */
export type StatusPaint = (color: "accent" | "dim" | "muted" | "warning", text: string) => string;

const plainPaint: StatusPaint = (_color, text) => text;

/** The usage status line's `setStatus` key. */
export const USAGE_STATUS_KEY = "pi-dent-agents";

/**
 * `<agents>`: `<tasks> <accent>agents</> · <usage>` (`agent` for one), the segment the footer shows and the
 * status line starts with (agent-tool.md Section 13).
 */
export function agentSegment(
  tasks: number,
  sum: UsageSum,
  paint: StatusPaint = plainPaint,
): string {
  const [turns, tokens, cost] = usageSegments(sum);
  const dot = paint("dim", " · ");
  return `${tasks} ${paint("accent", tasks === 1 ? "agent" : "agents")}${dot}${paint("muted", turns)}${dot}${paint(
    "muted",
    tokens,
  )}${dot}${paint("warning", cost)}`;
}

/**
 * The usage tally of one main session: the dispatches counted and the sum of their usage.
 * A throwing listener affects neither the tally nor the caller.
 */
export class UsageTally {
  tasks = 0;
  sum: UsageSum = zeroUsageSum();
  private readonly listeners = new Set<() => void>();

  /** Count one dispatch that passed its pre-start checks. */
  countTask(): void {
    this.tasks += 1;
    this.changed();
  }

  /** Add one assistant message, the same one added to its task row's `usage`. */
  addMessage(usage: MessageUsage | undefined): void {
    this.sum = addMessage(this.sum, usage);
    this.changed();
  }

  /** `tasks` 0 and a zero sum, as at `session_start`. */
  reset(): void {
    this.tasks = 0;
    this.sum = zeroUsageSum();
    this.changed();
  }

  /**
   * The usage status line, or undefined while `tasks` is 0. It ends with ` │`, which sets it
   * apart from the next extension's status on the host's shared line.
   */
  statusText(paint: StatusPaint = plainPaint): string | undefined {
    if (this.tasks === 0) return undefined;
    return `${agentSegment(this.tasks, this.sum, paint)}${paint("dim", " │")}`;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A status line that cannot update leaves the tally intact; no failure is reported
        // (agent-tool.md Section 13).
      }
    }
  }
}
