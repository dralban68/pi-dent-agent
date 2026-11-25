import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  createFooterComponent,
  type EntryUsage,
  type FooterComponentHost,
  type FooterEntry,
  type FooterInput,
  type FooterPaint,
  footerLines,
  sanitizeStatus,
  sessionStats,
} from "../../lib/footer.ts";
import { zeroUsageSum } from "../../lib/usage.ts";
import { at } from "../support/must.ts";

/**
 * specs/footer.md Sections 2.1-2.3: the path line, the stats line with its fit rule, the status
 * line, and the session totals they show. The core takes plain inputs, so every test builds them
 * by hand; no host is involved.
 */

const plain: FooterPaint = (_color, text) => text;

/** `paint` that shows which colour a text was drawn in. */
const tagged: FooterPaint = (color, text) => `<${color}>${text}</>`;

/** The visible text of a line: truncation adds reset sequences of its own. */
const shown = (line: string): string => stripTerminalSequences(line);

/** The left and the right side of a padded stats line. */
function sides(line: string): { left: string; right: string } {
  const [left = "", right = ""] = shown(line).split(/\s{2,}/);
  return { left, right };
}

const usage = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  total: number,
): EntryUsage => ({ input, output, cacheRead, cacheWrite, cost: { total } });

function footerInput(overrides: Partial<FooterInput> = {}): FooterInput {
  return {
    width: 120,
    cwd: "/work/project",
    home: "/home/u",
    branch: null,
    sessionName: undefined,
    entries: [],
    contextUsage: undefined,
    model: undefined,
    thinkingLevel: undefined,
    providerCount: 1,
    subscription: false,
    autoCompact: false,
    tally: { tasks: 0, sum: zeroUsageSum() },
    statuses: new Map(),
    paint: plain,
    ...overrides,
  };
}

const pathOf = (overrides: Partial<FooterInput>): string =>
  at(footerLines(footerInput(overrides)), 0);
const statsOf = (overrides: Partial<FooterInput>): string =>
  at(footerLines(footerInput(overrides)), 1);
const leftOf = (overrides: Partial<FooterInput>): string => sides(statsOf(overrides)).left;
const rightOf = (overrides: Partial<FooterInput>): string => sides(statsOf(overrides)).right;
const statusOf = (overrides: Partial<FooterInput>): string | undefined =>
  footerLines(footerInput(overrides))[2];

// --- totals ------------------------------------------------------------------

test("sessionStats sums every entry kind that carries a usage, on every branch", () => {
  const entries: FooterEntry[] = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", usage: usage(1000, 100, 500, 0, 0.01) } },
    { type: "message", message: { role: "toolResult", usage: usage(10, 20, 30, 40, 0.02) } },
    { type: "usage", usage: usage(1, 2, 3, 4, 0.03) },
    { type: "compaction", usage: usage(5, 6, 7, 8, 0.04) },
    { type: "branch_summary", usage: usage(9, 10, 11, 12, 0.05) },
    { type: "message", message: { role: "assistant" } },
    { type: "label" },
    { type: "custom", usage: usage(1000, 1000, 1000, 1000, 1) },
  ];
  const stats = sessionStats(entries);
  assert.deepEqual(stats.totals, {
    input: 1025,
    output: 138,
    cacheRead: 551,
    cacheWrite: 64,
    cost: stats.totals.cost,
  });
  assert.equal(stats.totals.cost.toFixed(3), "0.150");
  assert.equal(stats.cacheHitRate?.toFixed(1), "33.3");
  assert.deepEqual(sessionStats([]), {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    cacheHitRate: undefined,
  });
});

test("the cache-hit rate comes from the latest assistant message and is absent for a zero divisor", () => {
  const entries: FooterEntry[] = [
    { type: "message", message: { role: "assistant", usage: usage(0, 5, 100, 0, 0) } },
    { type: "message", message: { role: "assistant", usage: usage(50, 5, 50, 0, 0) } },
  ];
  assert.equal(sessionStats(entries).cacheHitRate?.toFixed(1), "50.0");
  const zero: FooterEntry[] = [
    { type: "message", message: { role: "assistant", usage: usage(0, 5, 0, 0, 0) } },
  ];
  assert.equal(sessionStats(zero).cacheHitRate, undefined);
});

// --- path line ---------------------------------------------------------------

test("the path line shows the cwd, the branch and the session name", () => {
  assert.equal(pathOf({ cwd: "/work/project", home: "/home/u" }), "/work/project");
  assert.equal(pathOf({ cwd: "/home/u/src/pi-dent", home: "/home/u" }), "~/src/pi-dent");
  assert.equal(pathOf({ cwd: "/home/u", home: "/home/u" }), "~");
  assert.equal(pathOf({ cwd: "/work", home: undefined }), "/work");
  assert.equal(pathOf({ cwd: "/home/u/x", home: "/home/u", branch: "main" }), "~/x (main)");
  assert.equal(
    pathOf({ cwd: "/work", home: "/home/u", sessionName: "pi-dent work" }),
    "/work • pi-dent work",
  );
  assert.equal(
    pathOf({ cwd: "/work", home: "/home/u", branch: "footer", sessionName: "pi-dent work" }),
    "/work (footer) • pi-dent work",
  );
});

test("the path line is truncated to the width with the marker", () => {
  const line = pathOf({
    cwd: "/work/a-very-long-directory",
    sessionName: "and a longer name",
    width: 12,
  });
  assert.equal(visibleWidth(line), 12);
  assert.equal(shown(line).endsWith("..."), true, shown(line));
});

// --- stats line segments -----------------------------------------------------

test("each left segment appears only when its condition holds", () => {
  assert.equal(leftOf({}), "?/0");
  const entries: FooterEntry[] = [
    { type: "message", message: { role: "assistant", usage: usage(1500, 200, 4500, 0, 0.042) } },
  ];
  assert.equal(
    leftOf({ entries, contextUsage: { percent: 5, contextWindow: 200000 } }),
    "↑1.5k ↓200 R4.5k CH75.0% $0.042 5.0%/200k",
  );
  const writeOnly: FooterEntry[] = [
    { type: "message", message: { role: "assistant", usage: usage(0, 7, 0, 900, 0) } },
  ];
  assert.equal(
    leftOf({ entries: writeOnly, contextUsage: { percent: null, contextWindow: 100000 } }),
    "↓7 W900 CH0.0% ?/100k",
  );
});

test("no cache-hit rate without a rate, though the cache totals show", () => {
  const entries: FooterEntry[] = [{ type: "usage", usage: usage(0, 0, 40, 0, 0) }];
  assert.equal(leftOf({ entries }), "R40 ?/0");
});

test("the cost segment shows the total with three decimals, and (sub) for a subscription model", () => {
  const entries: FooterEntry[] = [
    { type: "message", message: { role: "assistant", usage: usage(1, 1, 0, 0, 0.042) } },
  ];
  assert.equal(leftOf({ entries }), "↑1 ↓1 $0.042 ?/0");
  assert.equal(leftOf({ subscription: true }), "$0.000 (sub) ?/0");
  assert.equal(leftOf({ entries, subscription: true }), "↑1 ↓1 $0.042 (sub) ?/0");
  assert.equal(leftOf({ subscription: false }), "?/0", "a zero cost is no segment");
});

test("the context segment takes the window from the usage, then from the model, else 0", () => {
  const model = { id: "m", provider: "p", contextWindow: 100000 };
  assert.equal(
    leftOf({ contextUsage: { percent: 55.25, contextWindow: 200000 }, model }),
    "55.3%/200k",
  );
  assert.equal(leftOf({ model }), "?/100k");
  assert.equal(leftOf({ contextUsage: { percent: 1, contextWindow: 0 }, model }), "1.0%/0");
  assert.equal(leftOf({}), "?/0");
  assert.equal(
    leftOf({ contextUsage: { percent: 9, contextWindow: 200000 }, autoCompact: true }),
    "9.0%/200k (auto)",
  );
});

test("the context segment is a warning above 70 % and an error above 90 %", () => {
  const at70 = statsOf({ paint: tagged, contextUsage: { percent: 70, contextWindow: 1000 } });
  assert.equal(at70.includes("<warning>"), false, at70);
  assert.equal(at70.includes("<error>"), false, at70);
  assert.equal(at70.startsWith("<dim>"), true, "the stats line is dimmed");
  for (const [percent, color] of [
    [70.1, "warning"],
    [90, "warning"],
    [90.1, "error"],
  ] as const) {
    const line = statsOf({ paint: tagged, contextUsage: { percent, contextWindow: 1000 } });
    assert.equal(
      line.includes(`<${color}>${percent.toFixed(1)}%/1.0k</>`),
      true,
      `${percent}: ${line}`,
    );
  }
});

// --- right side --------------------------------------------------------------

test("the right side is the model, its thinking level and, with several providers, its provider", () => {
  assert.equal(rightOf({}), "no-model");
  assert.equal(rightOf({ model: { id: "m", provider: "p" } }), "m");
  for (const [level, drawn] of [
    [undefined, "thinking off"],
    ["off", "thinking off"],
    ["high", "high"],
    ["minimal", "minimal"],
  ] as const) {
    const line = rightOf({
      model: { id: "m", provider: "p", reasoning: true },
      thinkingLevel: level,
    });
    assert.equal(line, `m • ${drawn}`, `${String(level)}`);
  }
  assert.equal(
    rightOf({ model: { id: "m", provider: "anthropic" }, providerCount: 2 }),
    "(anthropic) m",
  );
  assert.equal(rightOf({ model: { id: "m", provider: "anthropic" }, providerCount: 1 }), "m");
  assert.equal(rightOf({ providerCount: 2 }), "no-model", "no model has no provider");
});

// --- the fit rule ------------------------------------------------------------

/** The inputs the fit tests share: a left side of known width and a short model ID. */
function fitInput(overrides: Partial<FooterInput> = {}): FooterInput {
  return footerInput({
    entries: [
      { type: "message", message: { role: "assistant", usage: usage(1500, 200, 0, 0, 0.042) } },
    ],
    contextUsage: { percent: 5, contextWindow: 200000 },
    model: { id: "m", provider: "p", contextWindow: 200000 },
    ...overrides,
  });
}

const LEFT = "↑1.5k ↓200 $0.042 5.0%/200k";
const TALLY = { input: 1500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.042, turns: 1 };
const AGENTS = "1 agent · 1 turn · ↑1.5k ↓200 · $0.042";
/** A provider name long enough that the provider step is reached after the agents segment went. */
const LONG = { id: "m", provider: "a-rather-long-provider-name", contextWindow: 200000 };

test("the fit rule's left side is truncated to the width when it is wider", () => {
  const line = statsOf({ width: 8, contextUsage: { percent: 5, contextWindow: 200000 } });
  assert.equal(visibleWidth(line), 8);
  assert.equal(shown(line).endsWith("..."), true, shown(line));
});

test("fit step 1: the agents segment moves to the status line before anything else", () => {
  const width = visibleWidth(AGENTS);
  const lines = footerLines(fitInput({ tally: { tasks: 1, sum: TALLY }, width }));
  assert.equal(sides(at(lines, 1)).left, LEFT, "the stats line keeps its left side");
  assert.equal(sides(at(lines, 1)).right, "m");
  assert.equal(at(lines, 2), AGENTS, "the agents segment is the status line now");
  assert.equal(lines.length, 3);
});

test("fit step 2: the provider goes after the agents segment, and alone without a tally", () => {
  const width = visibleWidth(AGENTS);
  const lines = footerLines(
    fitInput({ tally: { tasks: 1, sum: TALLY }, model: LONG, providerCount: 2, width }),
  );
  assert.equal(sides(at(lines, 1)).left, LEFT);
  assert.equal(sides(at(lines, 1)).right, "m", "the provider went, the model stayed");
  assert.equal(at(lines, 2), AGENTS);
  const withoutTally = sides(statsOf(fitInput({ model: LONG, providerCount: 2, width })));
  assert.equal(withoutTally.left, LEFT);
  assert.equal(withoutTally.right, "m", "without a tally only the provider goes");
});

test("fit step 3: the right side is truncated without a marker to the room left", () => {
  const model = { id: "model-xyz", provider: LONG.provider, contextWindow: 200000 };
  const width = visibleWidth(LEFT) + 2 + 3;
  const line = statsOf(fitInput({ model, providerCount: 2, width }));
  const { left, right } = sides(line);
  assert.equal(left, LEFT);
  assert.equal(right, "mod");
  assert.equal(line.includes("..."), false, "the marker is the left side's alone");
  assert.equal(visibleWidth(line), width);
});

test("fit step 4: the right side is omitted when no columns are left for it", () => {
  assert.equal(statsOf(fitInput({ width: visibleWidth(LEFT) + 1 })), LEFT);
  assert.equal(
    statsOf(fitInput({ width: visibleWidth(LEFT) + 2 })),
    LEFT,
    "two columns of padding alone are no room for the right side",
  );
});

test("a stats line that fits is padded out to the render width", () => {
  const width = visibleWidth(AGENTS);
  const line = statsOf(fitInput({ width }));
  assert.deepEqual(sides(line), { left: LEFT, right: "m" });
  assert.equal(visibleWidth(line), width, "the line ends at the render width");
});

// --- status line -------------------------------------------------------------

test("the status line is the statuses in ascending key order, joined by │", () => {
  const statuses = new Map([
    ["b", "two"],
    ["a", "one"],
    ["C", "three"],
  ]);
  assert.equal(statusOf({ statuses }), "three │ one │ two");
});

test("a status is sanitized to one line and an empty status is left out", () => {
  assert.equal(sanitizeStatus("  a\n\tb   c  "), "a b c");
  assert.equal(sanitizeStatus(" \n\t "), "");
  const statuses = new Map([
    ["b", " \n "],
    ["a", "one\ttwo\r\nthree"],
  ]);
  assert.equal(statusOf({ statuses }), "one two three");
  assert.equal(statusOf({ statuses: new Map([["a", " \n "]]) }), undefined);
});

test("no status line when the map is empty", () => {
  assert.equal(footerLines(footerInput({})).length, 2);
  assert.equal(statusOf({}), undefined);
});

test("a status keeps its own colours", () => {
  const red = "\u001b[31mred\u001b[0m";
  assert.equal(statusOf({ statuses: new Map([["a", red]]) }), red);
});

test("the status line is truncated to the width with the marker", () => {
  const line = statusOf({ statuses: new Map([["a", "x".repeat(50)]]), width: 10 });
  assert.equal(visibleWidth(line ?? ""), 10);
  assert.equal(shown(line ?? "").endsWith("..."), true, shown(line ?? ""));
});

test("the agents segment is the first status when the stats line gave it up", () => {
  const width = visibleWidth(AGENTS);
  const lines = footerLines(
    fitInput({
      tally: { tasks: 1, sum: TALLY },
      statuses: new Map([["a", "one"]]),
      width: width + 6,
    }),
  );
  assert.equal(at(lines, 2), `${AGENTS} │ one`);
});

test("the agents segment sits in the stats line while it fits", () => {
  const line = statsOf(fitInput({ tally: { tasks: 1, sum: TALLY }, width: 120 }));
  assert.equal(sides(line).left, `${LEFT} │ ${AGENTS}`);
});

test("a partial tally carries the (partial) marker, in the stats line and on the status line", () => {
  const partial = { tasks: 1, sum: TALLY, partial: true };
  const line = statsOf(fitInput({ tally: partial, width: 120 }));
  assert.equal(sides(line).left, `${LEFT} │ ${AGENTS} (partial)`);
  const width = visibleWidth(`${AGENTS} (partial)`);
  const lines = footerLines(fitInput({ tally: partial, width }));
  assert.equal(at(lines, 2), `${AGENTS} (partial)`, "the moved segment keeps its marker");
  const ended = statsOf(fitInput({ tally: { ...partial, partial: false }, width: 120 }));
  assert.equal(sides(ended).left, `${LEFT} │ ${AGENTS}`, "gone once the seed read completed");
});

// --- the component -----------------------------------------------------------

/** The smallest host the component needs; every part is a test's own. */
function componentHost(overrides: Partial<FooterComponentHost> = {}): FooterComponentHost {
  return {
    paint: plain,
    footerData: {
      getGitBranch: () => null,
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 1,
    },
    sessionKey: () => "session",
    entries: () => [],
    contextUsage: () => undefined,
    values: () => ({
      cwd: "/work",
      home: undefined,
      sessionName: undefined,
      model: undefined,
      thinkingLevel: undefined,
      subscription: false,
      autoCompact: false,
      tally: { tasks: 0, sum: zeroUsageSum() },
    }),
    failed: () => {},
    disposed: () => {},
    ...overrides,
  };
}

test("the component scans the session again only when its key changes", () => {
  let key = "a";
  let scans = 0;
  const component = createFooterComponent(
    componentHost({
      sessionKey: () => key,
      entries: () => {
        scans += 1;
        return [];
      },
    }),
  );
  component.render(80);
  component.render(80);
  assert.equal(scans, 1);
  key = "b";
  component.render(80);
  assert.equal(scans, 2);
  component.invalidate();
  component.render(80);
  assert.equal(scans, 3);
});

test("a render that throws reports once and draws nothing more", () => {
  const errors: unknown[] = [];
  let renders = 0;
  const component = createFooterComponent(
    componentHost({
      sessionKey: () => {
        renders += 1;
        throw new Error("no session");
      },
      failed: (error) => errors.push(error),
    }),
  );
  assert.deepEqual(component.render(80), []);
  assert.deepEqual(component.render(80), []);
  assert.equal(renders, 1, "the footer did not try again");
  assert.equal(errors.length, 1, "one report");
});

test("the lines are the path line, the stats line and the status line, in that order", () => {
  const lines = footerLines(footerInput({ statuses: new Map([["pi-dent-tasks", "3 running"]]) }));
  assert.equal(lines.length, 3);
  assert.equal(at(lines, 0), "/work/project");
  assert.deepEqual(sides(at(lines, 1)), { left: "?/0", right: "no-model" });
  assert.equal(at(lines, 2), "3 running");
});
