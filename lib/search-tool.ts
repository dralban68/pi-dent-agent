/**
 * The `Search` tool (specs/search-tool.md): `find` returns compact hits for the
 * transcript items of the call's sessions, `get` returns one item's text with its
 * neighbours, and `sessions` lists sessions. The session tree, the project, the
 * item address, and transcript order are owned by specs/session-transcript.md;
 * the index the tool answers from and its failures by specs/session-index.md; the
 * covering, ordering, matching, and evaluation engine by `lib/search-eval.ts`.
 *
 * Everything host-specific is a parameter — the invoking session's file and agent
 * directory, whether it is a main session, the index path, the clock, and the
 * abort signal — so every rule is testable without the host. Covering and
 * evaluation yield to the event loop between steps, and a regular expression is
 * evaluated in a worker thread the call terminates, so an abort or the end of the
 * time budget returns within 1000 ms (specs/search-tool.md#abort and specs/search-tool.md#evaluation).
 */

import { statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ToolResult } from "./engine.ts";
import { localStamp, parseDateTime } from "./schedule-time.ts";
import {
  compareParts,
  formatItemAddress,
  itemAddress,
  pairedItem,
  parseItemAddress,
  realPath,
  resolveItem,
  sessionItems,
  readSessionHeaderFile,
  sessionTreeAsync,
  projectMembersAsync,
  type ItemAddress,
  type SessionHeader,
  type SessionRead,
  type TranscriptItem,
} from "./session-transcript.ts";
import { openSessionIndex, type CatchUpContinuation, type IndexItemRow } from "./session-index.ts";
import { errorMessage, isPlainObject } from "./util.ts";
import {
  abortedResult,
  addressOf,
  afterSlotOf,
  compareStrings,
  coverDirectly,
  coverSessions,
  coversOf,
  evaluate,
  hitDetails,
  hitLine,
  isAborted,
  isCovered,
  makePacer,
  sessionCount,
  note,
  queryOf,
  readSessionChunked,
  refreshIndexState,
  recoverAfterSession,
  resetStaleRow,
  snippetOf,
  stampOf,
  startContinuation,
  textError,
  uncoveredCount,
  type Call,
  type Cover,
  type FindOutcome,
  type PatternEvaluator,
  type Forest,
  type HitLineParts,
  type Reached,
  type SearchAction,
  type SearchHost,
  type SearchOrder,
  type SearchProgress,
  type SearchScope,
  type Settings,
} from "./search-eval.ts";

/** The invoking session as the host sees it (specs/search-tool.md#reach), re-exported for callers. */
export type { SearchHost, SearchProgress } from "./search-eval.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The tool name (specs/search-tool.md#registration). */
export const SEARCH_TOOL_NAME = "Search";

/** The covering deadline after the call started, in milliseconds (specs/search-tool.md#coverage). */
const COVERING_MS = 3000;

/** The `find` time budget from the call's start, in milliseconds (specs/search-tool.md#evaluation). */
const BUDGET_MS = 5000;

/** The default `get` limit, in characters (specs/search-tool.md#parameter-schema). */
const GET_LIMIT = 10000;

/** The default `sessions` limit (specs/search-tool.md#parameter-schema). */
const SESSIONS_LIMIT = 50;

/** The longest admitted `query`, in characters (specs/search-tool.md#validation, check 3). */
const QUERY_MAX = 1000;

/** The most bytes one chunk of a session listing's preview read consumes. */
const PREVIEW_CHUNK_BYTES = 262144;

/** The number of a session file's first lines a preview reads (specs/search-tool.md#sessions). */
const PREVIEW_LINES = 50;

/** An age: one to nine decimal digits and one of `s,m,h,d` (specs/search-tool.md#candidates). */
const AGE = /^([0-9]{1,9})([smhd])$/;

/** The `action` values (specs/search-tool.md#parameter-schema). */
export const SEARCH_ACTIONS = ["find", "get", "sessions"] as const;

/** The `scope` values (specs/search-tool.md#parameter-schema). */
export const SEARCH_SCOPES = ["session", "tree", "project", "project-trees"] as const;

/** The `order` values (specs/search-tool.md#parameter-schema). */
export const SEARCH_ORDERS = ["newest", "oldest"] as const;

/** The item kinds, in the order of specs/session-transcript.md#transcript-items. */
export const SEARCH_ITEM_KINDS = [
  "user",
  "system",
  "assistant",
  "thinking",
  "tool_call",
  "tool_result",
  "injected",
  "summary",
  "error",
] as const;

// ---------------------------------------------------------------------------
// specs/search-tool.md#model-texts: model-facing texts, verbatim
// ---------------------------------------------------------------------------

/** The tool's `description` (specs/search-tool.md#model-texts). */
export const SEARCH_DESCRIPTION =
  "Look back into session transcripts. find searches earlier messages, tool calls, and tool results and returns compact hits, each starting with an address; get returns one item's full text by its address; sessions lists sessions. find searches this session only unless scope widens it.";

/** The tool's `promptSnippet` (specs/search-tool.md#model-texts). */
export const SEARCH_PROMPT_SNIPPET =
  "Search earlier messages, tool calls, and tool results of this session; with scope, also its child sessions and its project";

/** The `description` of each parameter, verbatim from specs/search-tool.md#model-texts. */
export const SEARCH_PARAMETER_DESCRIPTIONS = {
  action:
    "find: search and return hits with addresses. get: return one item's text by its address. sessions: list sessions.",
  query:
    "For find: the text to look for in an item's text, literal unless regex is true. Omit it to list every item that passes the other filters.",
  regex: "For find: true makes query an ECMAScript regular expression. Default false.",
  caseSensitive: "For find: true matches letter case exactly. Default false.",
  kinds:
    "For find: the item kinds to search: user, system, assistant, thinking, tool_call, tool_result, injected, summary, error. Default: all.",
  tool: "For find: a tool name; only that tool's calls and results match.",
  isError:
    "For find: true matches only tool results that are errors, false only those that are not.",
  since:
    "Lower time bound, inclusive: an RFC 3339 date-time with a time-zone offset, or an age such as 90s, 15m, 2h, or 7d. For sessions it bounds when the session was last written.",
  until:
    "Upper time bound, exclusive: an RFC 3339 date-time with a time-zone offset, or an age such as 90s, 15m, 2h, or 7d. For sessions it bounds when the session was last written.",
  session:
    "For find and sessions: the session to search or list: self (default), the task ID of an Agent or Script call of this session, a session key as shown before the colon of a hit address or at the start of a sessions line, or a session file path.",
  scope:
    "How far to reach: session (one session; default for find), tree (it and the child sessions beneath it; default for sessions), project (this main session and the other sessions of its project), project-trees (those and all their child sessions). sessions takes tree or project only.",
  branches: "For find: true also searches the entries of abandoned branches. Default false.",
  order: "For find: newest (default) or oldest hits first.",
  after:
    'For find: an item address to continue after. Copy it from the "More hits follow" or "Search stopped" line of the previous result.',
  limit:
    "find: the most hits to return, 1 to 100, default 20. get: the most characters of text, 1 to 50000, default 10000. sessions: the most sessions to list, 1 to 200, default 50.",
  address:
    "Required for get: the address that starts a hit line, such as self:1a2b3c4d or self:1a2b3c4d.0.",
  offset:
    'For get: the index of the first character to return, counting from 0. Copy it from the "cut: continue with offset" line to read on.',
  context: "For get: how many neighbouring items to list before and after, 0 to 20. Default 0.",
} as const;

const DESCRIPTIONS = SEARCH_PARAMETER_DESCRIPTIONS;

// ---------------------------------------------------------------------------
// specs/search-tool.md#parameter-schema: parameter schema
// ---------------------------------------------------------------------------

export const searchParameterSchema = Type.Object(
  {
    action: StringEnum(SEARCH_ACTIONS, { description: DESCRIPTIONS.action }),
    query: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.query }),
    ),
    regex: Type.Optional(
      Type.Union([Type.Boolean(), Type.Null()], { description: DESCRIPTIONS.regex }),
    ),
    caseSensitive: Type.Optional(
      Type.Union([Type.Boolean(), Type.Null()], { description: DESCRIPTIONS.caseSensitive }),
    ),
    kinds: Type.Optional(
      Type.Union([Type.Array(StringEnum(SEARCH_ITEM_KINDS), { minItems: 1 }), Type.Null()], {
        description: DESCRIPTIONS.kinds,
      }),
    ),
    tool: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.tool }),
    ),
    isError: Type.Optional(
      Type.Union([Type.Boolean(), Type.Null()], { description: DESCRIPTIONS.isError }),
    ),
    since: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.since }),
    ),
    until: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.until }),
    ),
    session: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.session }),
    ),
    scope: Type.Optional(
      Type.Union([StringEnum(SEARCH_SCOPES), Type.Null()], { description: DESCRIPTIONS.scope }),
    ),
    branches: Type.Optional(
      Type.Union([Type.Boolean(), Type.Null()], { description: DESCRIPTIONS.branches }),
    ),
    order: Type.Optional(
      Type.Union([StringEnum(SEARCH_ORDERS), Type.Null()], { description: DESCRIPTIONS.order }),
    ),
    after: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.after }),
    ),
    limit: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], { description: DESCRIPTIONS.limit }),
    ),
    address: Type.Optional(
      Type.Union([Type.String(), Type.Null()], { description: DESCRIPTIONS.address }),
    ),
    offset: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], { description: DESCRIPTIONS.offset }),
    ),
    context: Type.Optional(
      Type.Union([Type.Number(), Type.Null()], { description: DESCRIPTIONS.context }),
    ),
  },
  { additionalProperties: false },
);

export type SearchToolParams = Static<typeof searchParameterSchema>;

/** One call of the tool: the invoking session, the parameters, and the abort signal. */
export interface SearchInvocation extends SearchHost {
  params: SearchToolParams;
  signal: AbortSignal | undefined;
}

/** How the tool is driven: the index, the clock, the zone, and the test seam. */
export interface SearchRuntimeOptions {
  /** The index file's path. Default `searchIndexPath()` (specs/session-index.md#location). */
  indexPath?: string | undefined;
  /** The SQLite busy timeout of the index, in milliseconds. Default 1000 (specs/session-index.md#location). */
  busyTimeoutMs?: number | undefined;
  /** The current instant, milliseconds since the Unix epoch. Default `Date.now`. */
  now?: (() => number) | undefined;
  /** The local zone every rendered time stamp is in (specs/billing.md#billing-text). */
  zone: string;
  /** The instant the boot window ends: the bound of a background continuation (specs/search-tool.md#coverage). */
  bootDeadline?: number | undefined;
  /** A test seam: called at the boundaries of a call. */
  progress?: ((event: SearchProgress) => void) | undefined;
  /** A test seam: how a regular-expression evaluator is made (specs/search-tool.md#abort). */
  makeEvaluator?: ((pattern: string, flags: string) => PatternEvaluator) | undefined;
  /** A test seam: called for each item read back from a session file (specs/search-tool.md#evaluation). */
  onItemRead?: (() => void) | undefined;
}

/** The tool of one extension instance. */
export interface SearchRuntime {
  /** One call of the tool (specs/search-tool.md#find, specs/search-tool.md#get, specs/search-tool.md#sessions). */
  execute(invocation: SearchInvocation): Promise<ToolResult>;
  /** Stop every continuation of catch-up the runtime started (specs/search-tool.md#coverage). */
  stop(): void;
  /** Settles when every background continuation this runtime started has ended (specs/search-tool.md#coverage). */
  backgroundDone(): Promise<void>;
}

export interface SearchToolDeps {
  runtime: SearchRuntime;
  /** The invoking session, read at call time. */
  host: (ctx: ExtensionToolContext | undefined) => SearchHost;
}

// ---------------------------------------------------------------------------
// specs/search-tool.md#validation: execution-time validation
// ---------------------------------------------------------------------------

/** The parameter fields in the table order of specs/search-tool.md#parameter-schema, `action` excluded. */
const FIELD_ORDER = [
  "query",
  "regex",
  "caseSensitive",
  "kinds",
  "tool",
  "isError",
  "since",
  "until",
  "session",
  "scope",
  "branches",
  "order",
  "after",
  "limit",
  "address",
  "offset",
  "context",
] as const;

/** The fields each action accepts (specs/search-tool.md#parameter-schema). */
const ACCEPTED_FIELDS: Readonly<Record<SearchAction, ReadonlySet<string>>> = {
  find: new Set([
    "query",
    "regex",
    "caseSensitive",
    "kinds",
    "tool",
    "isError",
    "since",
    "until",
    "session",
    "scope",
    "branches",
    "order",
    "after",
    "limit",
  ]),
  get: new Set(["limit", "address", "offset", "context"]),
  sessions: new Set(["since", "until", "session", "scope", "limit"]),
};

/** A field value that counts as present: neither absent nor `null` (specs/search-tool.md#parameter-schema). */
function present(fields: Record<string, unknown>, name: string): unknown {
  const value = fields[name];
  return value === undefined || value === null ? undefined : value;
}

/** The action a call names, or undefined when it names none of specs/search-tool.md#parameter-schema's. */
function actionOf(value: unknown): SearchAction | undefined {
  for (const action of SEARCH_ACTIONS) {
    if (action === value) return action;
  }
  return;
}

/** The scope a call names, or undefined. */
function scopeOf(value: unknown): SearchScope | undefined {
  for (const scope of SEARCH_SCOPES) {
    if (scope === value) return scope;
  }
  return;
}

/** The order a call names, or undefined. */
function orderOf(value: unknown): SearchOrder | undefined {
  for (const order of SEARCH_ORDERS) {
    if (order === value) return order;
  }
  return;
}

/** The instant a `since` or `until` value names, or undefined when it names none (specs/search-tool.md#candidates). */
function instantOfValue(text: string, started: number): number | undefined {
  const trimmed = text.trim();
  const dateTime = parseDateTime(trimmed);
  if (dateTime !== undefined) return dateTime;
  const age = AGE.exec(trimmed);
  if (age === null) return;
  const digits = age[1];
  const unit = age[2];
  if (digits === undefined || unit === undefined) return;
  const scale = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return started - Number(digits) * scale * 1000;
}

/** The message of the error the pattern raises, or undefined when it is a valid regular expression (specs/search-tool.md#validation, check 5). */
function regexProblem(pattern: string): string | undefined {
  try {
    new RegExp(pattern, "m");
    return;
  } catch (error) {
    return errorMessage(error);
  }
}

type Checked = { kind: "error"; message: string } | { kind: "ok"; settings: Settings };

function invalid(message: string): Checked {
  return { kind: "error", message };
}

/** The first failing check of specs/search-tool.md#validation, or the settings the call runs with. */
function checkCall(
  action: SearchAction,
  fields: Record<string, unknown>,
  started: number,
): Checked {
  const accepted = ACCEPTED_FIELDS[action];
  for (const field of FIELD_ORDER) {
    if (accepted.has(field)) continue;
    if (present(fields, field) !== undefined) {
      return invalid(`${field} is not valid for action ${action}`);
    }
  }
  const settings: Settings = {
    query: undefined,
    regex: false,
    caseSensitive: false,
    kinds: undefined,
    tool: undefined,
    isError: undefined,
    since: undefined,
    until: undefined,
    session: undefined,
    scope: action === "sessions" ? "tree" : "session",
    branches: false,
    order: "newest",
    after: undefined,
    limit: undefined,
    address: undefined,
    offset: 0,
    context: 0,
  };
  // The checks run in the numbered order of specs/search-tool.md#validation, the first failure reported.
  if (action === "find") {
    const rawQuery = present(fields, "query");
    if (rawQuery !== undefined) {
      if (typeof rawQuery !== "string" || rawQuery === "") {
        return invalid("query must be a non-empty string");
      }
      if (rawQuery.length > QUERY_MAX) return invalid("query must be at most 1000 characters");
      settings.query = rawQuery;
    }
    settings.regex = present(fields, "regex") === true;
    if (settings.regex) {
      const pattern = settings.query;
      if (pattern === undefined) return invalid("regex requires query");
      const problem = regexProblem(pattern);
      if (problem !== undefined) return invalid(`invalid regular expression: ${problem}`);
    }
    settings.caseSensitive = present(fields, "caseSensitive") === true;
    const kinds = present(fields, "kinds");
    if (Array.isArray(kinds)) {
      const names: string[] = [];
      for (const kind of kinds) {
        if (typeof kind === "string") names.push(kind);
      }
      settings.kinds = names;
    }
    const rawTool = present(fields, "tool");
    if (rawTool !== undefined) {
      if (typeof rawTool !== "string" || rawTool.trim() === "") {
        return invalid("tool must be a non-empty string");
      }
      settings.tool = rawTool.trim();
    }
    const rawIsError = present(fields, "isError");
    if (typeof rawIsError === "boolean") settings.isError = rawIsError;
    settings.branches = present(fields, "branches") === true;
    const rawOrder = present(fields, "order");
    if (rawOrder !== undefined) {
      const order = orderOf(rawOrder);
      if (order === undefined) return invalid("order must be newest or oldest");
      settings.order = order;
    }
  }

  // 7 and 8: since and until; 9: their order.
  const rawSince = present(fields, "since");
  if (rawSince !== undefined) {
    const instant = typeof rawSince === "string" ? instantOfValue(rawSince, started) : undefined;
    if (instant === undefined) {
      return invalid(
        "since must be an RFC 3339 date-time with a time-zone offset or an age such as 90s, 15m, 2h, or 7d",
      );
    }
    settings.since = instant;
  }
  const rawUntil = present(fields, "until");
  if (rawUntil !== undefined) {
    const instant = typeof rawUntil === "string" ? instantOfValue(rawUntil, started) : undefined;
    if (instant === undefined) {
      return invalid(
        "until must be an RFC 3339 date-time with a time-zone offset or an age such as 90s, 15m, 2h, or 7d",
      );
    }
    settings.until = instant;
  }
  if (settings.since !== undefined && settings.until !== undefined) {
    if (settings.since >= settings.until) return invalid("since must be earlier than until");
  }

  // 10 and 11: the scope of `sessions`, and a session with a project scope.
  if (action === "find" || action === "sessions") {
    const rawSession = present(fields, "session");
    if (typeof rawSession === "string" && rawSession.trim() !== "") {
      settings.session = rawSession.trim();
    }
    const rawScope = present(fields, "scope");
    if (rawScope !== undefined) {
      const scope = scopeOf(rawScope);
      if (scope === undefined) {
        return invalid("scope must be one of session, tree, project, or project-trees");
      }
      settings.scope = scope;
    }
    if (
      action === "sessions" &&
      (settings.scope === "session" || settings.scope === "project-trees")
    ) {
      return invalid("scope must be tree or project for action sessions");
    }
    if (
      (settings.scope === "project" || settings.scope === "project-trees") &&
      settings.session !== undefined
    ) {
      return invalid(`session is not valid with scope ${settings.scope}`);
    }
  }

  // 12 and 13: after and the find limit.
  if (action === "find") {
    const rawAfter = present(fields, "after");
    if (rawAfter !== undefined) {
      if (typeof rawAfter !== "string" || parseItemAddress(rawAfter.trim()) === undefined) {
        return invalid("after must be an item address such as self:1a2b3c4d or self:1a2b3c4d.0");
      }
      settings.after = rawAfter.trim();
    }
    const rawLimit = present(fields, "limit");
    if (rawLimit !== undefined) {
      if (!isIntegerBetween(rawLimit, 1, 100)) {
        return invalid("limit must be an integer from 1 to 100");
      }
      settings.limit = rawLimit;
    }
  }
  // 14: the sessions limit.
  if (action === "sessions") {
    const rawLimit = present(fields, "limit");
    if (rawLimit !== undefined) {
      if (!isIntegerBetween(rawLimit, 1, 200)) {
        return invalid("limit must be an integer from 1 to 200");
      }
      settings.limit = rawLimit;
    }
  }
  // 15 to 18: the address, offset, limit, and context of get.
  if (action === "get") {
    const rawAddress = present(fields, "address");
    if (typeof rawAddress !== "string" || parseItemAddress(rawAddress.trim()) === undefined) {
      return invalid("address must be an item address such as self:1a2b3c4d or self:1a2b3c4d.0");
    }
    settings.address = rawAddress.trim();
    const rawOffset = present(fields, "offset");
    if (rawOffset !== undefined) {
      if (typeof rawOffset !== "number" || !Number.isInteger(rawOffset) || rawOffset < 0) {
        return invalid("offset must be a non-negative integer");
      }
      settings.offset = rawOffset;
    }
    const rawLimit = present(fields, "limit");
    if (rawLimit !== undefined) {
      if (!isIntegerBetween(rawLimit, 1, 50000)) {
        return invalid("limit must be an integer from 1 to 50000");
      }
      settings.limit = rawLimit;
    }
    const rawContext = present(fields, "context");
    if (rawContext !== undefined) {
      if (!isIntegerBetween(rawContext, 0, 20)) {
        return invalid("context must be an integer from 0 to 20");
      }
      settings.context = rawContext;
    }
  }
  return { kind: "ok", settings };
}

/** True when `value` is a number for which `Number.isInteger` holds, between the bounds (specs/search-tool.md#validation). */
function isIntegerBetween(value: unknown, low: number, high: number): value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) return false;
  return value >= low && value <= high;
}

// ---------------------------------------------------------------------------
// specs/search-tool.md#reach: reach and session resolution
// ---------------------------------------------------------------------------

/** A resolved session, or the error text that replaces it (specs/search-tool.md#reach). */
type Resolved = { kind: "session"; session: Reached } | { kind: "error"; message: string };

/**
 * A member below a tree's root, or a project member: discovery admitted it only
 * as a regular file, not a symbolic link (specs/session-transcript.md#session-tree and
 * specs/session-transcript.md#project), so its path with symbolic links resolved is its directory's resolved path
 * and its own name. `realDirs` memoizes the directories of one discovery.
 */
function reachedOf(
  member: {
    key: string;
    path: string;
    header: SessionHeader | undefined;
    stems: string[];
  },
  tree: number,
  realDirs: Map<string, string>,
): Reached {
  const directory = dirname(member.path);
  let realDirectory = realDirs.get(directory);
  if (realDirectory === undefined) {
    realDirectory = realPath(directory);
    realDirs.set(directory, realDirectory);
  }
  return {
    key: member.key,
    path: member.path,
    resolvedPath: join(realDirectory, basename(member.path)),
    header: member.header,
    stems: member.stems,
    tree,
  };
}

/** A forest with no session in it, before discovery runs (specs/search-tool.md#reach). */
function emptyForest(host: SearchHost): Forest {
  const rootPath = host.sessionFile ?? join(host.agentDirectory, "self");
  return {
    trees: [],
    invoking: {
      key: "self",
      path: resolve(rootPath),
      resolvedPath: realPath(resolve(rootPath)),
      header: undefined,
      stems: [],
      tree: 0,
    },
  };
}

/** A `files` row's header and the checks a discovery makes on it (specs/search-tool.md#reach). */
interface HeaderRow {
  sessionId: string;
  started: number;
  consumed: number;
  mtime: number;
}

/**
 * A session header provider that answers a file the index already knows from its
 * `files` row, and reads the headers of every other file (specs/search-tool.md#reach). A row
 * answers only when its `path` is the file's path with symbolic links resolved,
 * its `consumed` is the file's size, and its `mtime` is the file's modification
 * time — the conditions under which the file's catch-up is complete unchanged
 * (specs/session-index.md#catch-up, step 2) — so those checks, and no file read, keep
 * the header the one the file holds. No path is resolved per row: rows are keyed
 * by their resolved path, and a file by its directory's resolved path and name.
 */
function headerProvider(call: Call): (path: string) => SessionHeader | undefined {
  const known = new Map<string, HeaderRow>();
  const index = call.index;
  if (index !== undefined && call.indexUnusable === undefined) {
    const outcome = index.files();
    refreshIndexState(call);
    if (outcome.ok) {
      for (const row of outcome.value) {
        known.set(row.path, {
          sessionId: row.sessionId,
          started: row.started,
          consumed: row.consumed,
          mtime: row.mtime,
        });
      }
    }
  }
  // The index stores paths with symbolic links resolved. A file discovery asks
  // about is resolved through its directory, once per directory: a regular file
  // found so is the index's path; anything else misses and is read from disk.
  const realDirs = new Map<string, string>();
  const read = new Map<string, SessionHeader | undefined>();
  return (path) => {
    const directory = dirname(path);
    let realDirectory = realDirs.get(directory);
    if (realDirectory === undefined) {
      realDirectory = realPath(directory);
      realDirs.set(directory, realDirectory);
    }
    const resolved = join(realDirectory, basename(path));
    if (read.has(resolved)) return read.get(resolved);
    const row = known.get(resolved);
    if (row !== undefined) {
      const stamp = stampOf(path);
      if (stamp !== undefined && stamp.size === row.consumed && stamp.mtime === row.mtime) {
        return { sessionId: row.sessionId, time: row.started, bytes: 0 };
      }
    }
    const header = readSessionHeaderFile(path);
    read.set(resolved, header);
    return header;
  };
}

/** The call's header provider, built once however many discoveries run (specs/search-tool.md#abort). */
function headerOfCall(call: Call): (path: string) => SessionHeader | undefined {
  call.headerOf ??= headerProvider(call);
  return call.headerOf;
}

/**
 * The invoking session's own session tree (specs/session-transcript.md#session-tree). A
 * session without a session file is the root of its tree with no session
 * entries, and its agent directory is still read for children. The walk yields to
 * the event loop between members (specs/search-tool.md#abort).
 */
async function ownTree(call: Call): Promise<Forest> {
  const host = call.host;
  const rootPath = host.sessionFile ?? join(host.agentDirectory, "self");
  const members = await sessionTreeAsync(
    rootPath,
    host.agentDirectory,
    headerOfCall(call),
    call.pace,
    () => isAborted(call),
  );
  const root = members[0];
  const invoking: Reached = {
    key: "self",
    path: root === undefined ? resolve(rootPath) : root.path,
    resolvedPath: realPath(root === undefined ? resolve(rootPath) : root.path),
    header: root === undefined ? undefined : root.header,
    stems: [],
    tree: 0,
  };
  const own: Reached[] = [invoking];
  const realDirs = new Map<string, string>();
  for (let index = 1; index < members.length; index += 1) {
    const member = members[index];
    if (member === undefined) continue;
    own.push(reachedOf(member, 0, realDirs));
  }
  return { trees: [own], invoking };
}

/**
 * Read the project members and their session trees into the forest (specs/search-tool.md#reach).
 * Only a main session with a session file has a project, and only a call that asks
 * for it reads one.
 */
async function loadProject(call: Call): Promise<void> {
  if (call.projectLoaded) return;
  call.projectLoaded = true;
  const sessionFile = call.host.sessionFile;
  if (sessionFile === undefined) return;
  const forest = await discoverForest(call, true);
  call.forest = {
    trees: [call.forest.trees[0] ?? [], ...forest.trees.slice(1)],
    invoking: call.forest.invoking,
  };
}

/** A discovered forest kept for later calls of this process, with what it is valid for (specs/search-tool.md#abort). */
interface CachedForest {
  forest: Forest;
  /** The directories discovery listed that exist, with their modification times. */
  dirs: Array<{ path: string; stamp: string }>;
  /** The `.jsonl` files discovery passed over because their first line was no session header. */
  misses: string[];
}

/**
 * The forests this process has discovered, keyed by the invoking session and the
 * reach asked, at most `FOREST_CACHE_SIZE` of them, least recently used first out.
 * A directory's modification time changes whenever an entry in it appears, goes,
 * or is renamed, so a forest is reused only while every directory discovery
 * listed is unchanged and every file it passed over for want of a session header
 * still has none: then a fresh discovery would find the same sessions (specs/search-tool.md#reach and specs/search-tool.md#abort). Session files are appended to, never rewritten
 * (specs/session-transcript.md#gaps), so a member's header does not change.
 */
const forestCache = new Map<string, CachedForest>();

/**
 * The most forests kept at once. Every invoking session that calls `Search` adds
 * one, and without a bound each would stay for the life of the process.
 */
const FOREST_CACHE_SIZE = 8;

/** A directory changed this recently, in milliseconds, is not trusted to stay as listed. */
const FOREST_SETTLE_MS = 2000;

/** The modification time of one directory, or undefined when it is absent or not a directory. */
function dirStamp(path: string): string | undefined {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) return;
  return String(stat.mtimeMs);
}

/** The agent directory of a session file: `<stem>.agents` beside it. */
function agentsDirOf(path: string): string {
  const name = basename(path);
  const stem = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
  return join(dirname(path), `${stem}.agents`);
}

/**
 * The directories whose listing a forest depends on: the sessions directory for a
 * project, the invoking session's agent directory, and the agent directory of
 * every other member. One that does not exist is left out, since creating it
 * changes the directory that holds it.
 */
function forestDirs(host: SearchHost, forest: Forest, project: boolean): string[] {
  const dirs = new Set<string>();
  if (project && host.sessionFile !== undefined) dirs.add(dirname(host.sessionFile));
  dirs.add(host.agentDirectory);
  // The invoking session's own agent directory is `host.agentDirectory`.
  if (host.sessionFile !== undefined) dirs.add(dirname(host.agentDirectory));
  for (const tree of forest.trees) {
    for (let index = 0; index < tree.length; index += 1) {
      const member = tree[index];
      if (member === undefined) continue;
      if (member.tree === 0 && index === 0) continue;
      dirs.add(agentsDirOf(member.path));
    }
  }
  return [...dirs];
}

/** True when a cached forest is still the forest a fresh discovery would find. */
function forestValid(cached: CachedForest): boolean {
  for (const dir of cached.dirs) {
    if (dirStamp(dir.path) !== dir.stamp) return false;
  }
  for (const path of cached.misses) {
    if (readSessionHeaderFile(path) !== undefined) return false;
  }
  return true;
}

/**
 * The invoking session's forest, found once and reused while it is valid, so a
 * repeat call does not walk thousands of session files again (specs/search-tool.md#reach and
 * specs/search-tool.md#abort). A forest any of whose directories changed within `FOREST_SETTLE_MS` of
 * its discovery is not kept: an entry made while discovery ran could be missing
 * from it with the directory's time already recorded.
 */
async function discoverForest(call: Call, project: boolean): Promise<Forest> {
  const host = call.host;
  const key = `${host.sessionFile ?? ""}\u0000${host.agentDirectory}\u0000${host.main}\u0000${project ? 1 : 0}`;
  const cached = forestCache.get(key);
  if (cached !== undefined) {
    // Re-inserting keeps the entry the most recently used one.
    forestCache.delete(key);
    if (forestValid(cached)) {
      forestCache.set(key, cached);
      return cached.forest;
    }
  }
  const begun = Date.now();
  const misses: string[] = [];
  const provider = headerOfCall(call);
  call.headerOf = (path) => {
    const header = provider(path);
    if (header === undefined && path.endsWith(".jsonl")) misses.push(path);
    return header;
  };
  let forest: Forest;
  try {
    forest = project ? await projectForest(call) : await ownTree(call);
  } finally {
    call.headerOf = provider;
  }
  if (isAborted(call)) return forest;
  const dirs: Array<{ path: string; stamp: string }> = [];
  let settled = true;
  for (const path of forestDirs(host, forest, project)) {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) continue;
    if (stat.mtimeMs >= begun - FOREST_SETTLE_MS) settled = false;
    dirs.push({ path, stamp: String(stat.mtimeMs) });
  }
  if (settled) {
    forestCache.set(key, { forest, dirs, misses });
    // Bound the cache: the least recently used forest goes first (specs/search-tool.md#abort).
    while (forestCache.size > FOREST_CACHE_SIZE) {
      const oldest = forestCache.keys().next();
      if (oldest.done === true) break;
      forestCache.delete(oldest.value);
    }
  }
  return forest;
}

/** The whole forest of a main session: its own tree and one tree per project member (specs/search-tool.md#reach). */
async function projectForest(call: Call): Promise<Forest> {
  const own = await ownTree(call);
  const trees: Reached[][] = [own.trees[0] ?? []];
  const sessionFile = call.host.sessionFile;
  const realDirs = new Map<string, string>();
  if (sessionFile !== undefined) {
    let tree = 1;
    for (const member of await projectMembersAsync(sessionFile, headerOfCall(call), call.pace, () =>
      isAborted(call),
    )) {
      await call.pace();
      if (isAborted(call)) break;
      trees.push(member.members.map((one) => reachedOf(one, tree, realDirs)));
      tree += 1;
    }
  }
  return { trees, invoking: own.invoking };
}

/** The sessions a call reaches, in forest order. */
function everyReached(trees: readonly Reached[][]): Reached[] {
  const all: Reached[] = [];
  for (const tree of trees) {
    for (const session of tree) all.push(session);
  }
  return all;
}

function oneOf(matches: readonly Reached[], value: string): Resolved {
  const first = matches[0];
  if (first === undefined) return { kind: "error", message: `unknown session "${value}"` };
  if (matches.length > 1) {
    const paths = matches
      .map((session) => session.path)
      .toSorted(compareStrings)
      .join(", ");
    return { kind: "error", message: `ambiguous session "${value}" matches ${paths}` };
  }
  return { kind: "session", session: first };
}

/**
 * The session a `session` value names, after trimming, by the first rule of
 * specs/search-tool.md#reach that applies. With `keysOnly`, only rules 1 to 3 apply: that is how
 * the session key of an `address` or an `after` resolves.
 */
function resolveSession(forest: Forest, value: string, keysOnly: boolean): Resolved {
  const text = value.trim();
  if (text === "" || text === "self") return { kind: "session", session: forest.invoking };
  if (text.startsWith("~")) {
    const matches = everyReached(forest.trees).filter((session) => session.key === text);
    return oneOf(matches, text);
  }
  const own = forest.trees[0] ?? [];
  const exact = own.find((session) => session.key === text);
  if (exact !== undefined) return { kind: "session", session: exact };
  if (keysOnly) return { kind: "error", message: `unknown session "${text}"` };
  if (text.startsWith("/")) {
    const wanted = realPath(text);
    const found = everyReached(forest.trees).find((session) => session.resolvedPath === wanted);
    if (found === undefined) return { kind: "error", message: `unknown session "${text}"` };
    return { kind: "session", session: found };
  }
  const suffix = `-${text}`;
  const matches = own.filter((session) => {
    const last = session.stems[session.stems.length - 1];
    if (last === undefined) return false;
    return last === text || last.endsWith(suffix);
  });
  return oneOf(matches, text);
}

/** True when `stems` names a member at or beneath `ancestor` in one tree. */
function isBeneath(stems: readonly string[], ancestor: readonly string[]): boolean {
  if (stems.length < ancestor.length) return false;
  for (let index = 0; index < ancestor.length; index += 1) {
    if (stems[index] !== ancestor[index]) return false;
  }
  return true;
}

/** The project members of the forest, in tree order. */
function projectRoots(trees: readonly Reached[][]): Reached[] {
  const roots: Reached[] = [];
  for (const tree of trees.slice(1)) {
    const root = tree[0];
    if (root !== undefined) roots.push(root);
  }
  return roots;
}

/** The sessions of a call, per the table of specs/search-tool.md#reach. */
function callSessions(forest: Forest, scope: SearchScope, resolved: Reached): Reached[] {
  if (scope === "session") return [resolved];
  if (scope === "tree") {
    const tree = forest.trees[resolved.tree] ?? [];
    return tree.filter((session) => isBeneath(session.stems, resolved.stems));
  }
  if (scope === "project") return [forest.invoking, ...projectRoots(forest.trees)];
  // project-trees: the invoking session and its tree, then each project member's tree.
  const all: Reached[] = [];
  for (const tree of forest.trees) {
    for (const session of tree) all.push(session);
  }
  return all;
}

// ---------------------------------------------------------------------------
// specs/search-tool.md#find: the `find` action
// ---------------------------------------------------------------------------

/** True when the call asks for the project: by `scope`, by a `~` session key, or by a `~` address (specs/search-tool.md#reach). */
function asksForProject(call: Call, address: ItemAddress | undefined): boolean {
  const settings = call.settings;
  if (settings.scope === "project" || settings.scope === "project-trees") return true;
  if (settings.session !== undefined && settings.session.startsWith("~")) return true;
  if (address !== undefined && address.sessionKey.startsWith("~")) return true;
  return false;
}

/** The error text of a project request the invoking session cannot make, or undefined (specs/search-tool.md#reach). */
function projectRefusal(call: Call, asks: boolean): string | undefined {
  if (!asks) return;
  if (call.host.main && call.host.sessionFile !== undefined) return;
  if (call.host.main) return "this session has no session file and so no project";
  return "project scope is available to a main session only";
}

/** Resolve the sessions of a `find` or `sessions` call, or the error text (specs/search-tool.md#reach and specs/search-tool.md#result). */
interface ReachedCall {
  sessions: Reached[];
  /** The session the key of `after` names, when it is one of the sessions (specs/search-tool.md#coverage). */
  afterSession: Reached | undefined;
}

async function reachCall(call: Call): Promise<ReachedCall | { error: string }> {
  const settings = call.settings;
  const afterAddress = settings.after === undefined ? undefined : parseItemAddress(settings.after);
  const asks = asksForProject(call, afterAddress);
  const refusal = projectRefusal(call, asks);
  if (refusal !== undefined) return { error: refusal };
  // A project member may be named by its file path (rule 4): the project is read for it too.
  // A child session's reach never includes the project, so a path does not load it there.
  const namesPath =
    call.host.main && settings.session !== undefined && settings.session.startsWith("/");
  const wantsProject = asks || namesPath;
  if (wantsProject) await loadProject(call);
  const resolved = resolveSession(call.forest, settings.session ?? "", false);
  if (resolved.kind === "error") return { error: resolved.message };
  const sessions = callSessions(call.forest, settings.scope, resolved.session);
  let afterSession: Reached | undefined;
  if (afterAddress !== undefined) {
    const afterResolved = resolveSession(call.forest, afterAddress.sessionKey, true);
    if (afterResolved.kind === "error") return { error: afterResolved.message };
    if (!sessions.includes(afterResolved.session)) {
      return { error: `no item ${settings.after ?? ""} in the searched sessions` };
    }
    afterSession = afterResolved.session;
  }
  return { sessions, afterSession };
}

/** The one uncovered-sessions line of a `find` result (specs/search-tool.md#result). */
function uncoveredLine(call: Call, uncovered: number, sessions: number): string {
  if (call.indexUnusable !== undefined) {
    return `${uncovered} of ${sessions} sessions were not searched: the search index is unavailable (${call.indexUnusable}). Narrow the scope.`;
  }
  if (call.failedWrite !== undefined) {
    return `${uncovered} of ${sessions} sessions were not searched: the search index cannot be written (${call.failedWrite}). Narrow the scope.`;
  }
  return `${uncovered} of ${sessions} sessions are not indexed yet and were not searched; indexing continues in the background. Repeat the call later, without after, to include them.`;
}

/** The result of a `find` call (specs/search-tool.md#result): each line under its own condition, in the table's order. */
function findResult(call: Call, evaluation: FindOutcome): ToolResult {
  const shown = evaluation.hits.length;
  const indexError = call.indexUnusable ?? call.failedWrite;
  const sessions = sessionCount(call);
  const uncovered = uncoveredCount(call);
  const stopped = evaluation.stopped;
  const afterState = evaluation.afterUncovered;
  const lines: string[] = [];
  lines.push(shown === 0 ? "(no hits)" : `${shown} hits, ${call.settings.order} first`);
  for (const hit of evaluation.hits) {
    lines.push(
      hitLine(
        {
          address: hit.address,
          time: hit.time,
          kind: hit.kind,
          label: hit.label,
          isError: hit.isError === true,
          offLineage: hit.offLineage,
          length: hit.length,
          at: hit.at,
          snippet: hit.snippet,
        },
        call.zone,
      ),
    );
  }
  if (evaluation.unmatched >= 1) {
    lines.push(
      `${evaluation.unmatched} items were not matched: the pattern ran over 1000 ms on each. Simplify the pattern.`,
    );
  }
  const last = evaluation.hits[evaluation.hits.length - 1];
  let next: string | undefined;
  if (!stopped && evaluation.more && last !== undefined) {
    next = last.address;
    lines.push(`More hits follow: repeat the call with after: "${next}"`);
  }
  if (stopped && evaluation.stop !== undefined) {
    next = evaluation.stop;
    lines.push(
      `Search stopped after 5000 ms at ${evaluation.stop}: every hit of the searched sessions up to there is shown. Continue with after: "${evaluation.stop}"`,
    );
  }
  if (stopped && evaluation.stop === undefined) {
    if (afterState) {
      lines.push(
        "Search stopped after 5000 ms: the session of after is not indexed yet. Repeat the call later.",
      );
    } else if (indexError === undefined) {
      lines.push("Search stopped after 5000 ms before any item was examined. Repeat the call.");
    } else {
      lines.push(
        "Search stopped after 5000 ms before any item was examined: a session is too large to read without the search index.",
      );
    }
  }
  if (uncovered >= 1 && !afterState) lines.push(uncoveredLine(call, uncovered, sessions));
  const details: Record<string, unknown> = {
    action: "find",
    order: call.settings.order,
    more: !stopped && evaluation.more,
    stopped,
    sessions,
    uncovered,
    unmatched: evaluation.unmatched,
    hits: evaluation.hits.map(hitDetails),
  };
  if (next !== undefined) details.next = next;
  if (indexError !== undefined) details.indexError = indexError;
  return { content: [{ type: "text", text: lines.join("\n") }], details };
}

async function findAction(
  call: Call,
  register: (continuation: CatchUpContinuation) => void,
): Promise<ToolResult> {
  const reached = await reachCall(call);
  if ("error" in reached) return textError(reached.error);
  call.covers = await coversOf(call, reached.sessions, reached.afterSession);
  call.afterCover =
    reached.afterSession === undefined
      ? undefined
      : call.covers.find((candidate) => candidate.session === reached.afterSession);
  const exceptions: (Reached | undefined)[] = [reached.afterSession];
  if (call.covers.length === 1) {
    const only = call.covers[0];
    if (only !== undefined) exceptions.push(only.session);
  }
  await coverSessions(call, exceptions);
  if (isAborted(call)) return abortedResult();
  const settings = call.settings;
  if (settings.after !== undefined) {
    const address = parseItemAddress(settings.after);
    const cover = call.afterCover;
    if (address === undefined || cover === undefined || cover.state === "lost") {
      return textError(`no item ${settings.after} in the searched sessions`);
    }
    if (!isCovered(cover)) {
      // The session `after` names is uncovered: the call is stopped, with no stop item (specs/search-tool.md#evaluation).
      startContinuation(call, register);
      return findResult(call, {
        kind: "evaluation",
        hits: [],
        more: false,
        stopped: true,
        stop: undefined,
        unmatched: 0,
        // The after-session state of specs/search-tool.md#result needs a usable index and no failed write.
        afterUncovered: call.indexUnusable === undefined && call.failedWrite === undefined,
      });
    }
    let slot = afterSlotOf(call, cover, address);
    if (slot === undefined && cover.state === "catchup") {
      // The rows no longer answer: the after session is covered again by a direct
      // read, and the item is looked up there (specs/search-tool.md#coverage).
      await recoverAfterSession(call, cover, [], false);
      if (!isCovered(cover)) {
        return textError(`no item ${settings.after} in the searched sessions`);
      }
      slot = afterSlotOf(call, cover, address);
    }
    if (slot === undefined) {
      return textError(`no item ${settings.after} in the searched sessions`);
    }
    call.after = slot;
  }
  call.query = queryOf(call);
  const evaluation = await evaluate(call);
  if (evaluation.kind === "aborted") return abortedResult();
  if (evaluation.kind === "failed") return textError(`Search failed: ${evaluation.message}`);
  if (call.afterLost) return textError(`no item ${settings.after ?? ""} in the searched sessions`);
  startContinuation(call, register);
  return findResult(call, evaluation);
}

// ---------------------------------------------------------------------------
// specs/search-tool.md#get: the `get` action
// ---------------------------------------------------------------------------

/** One neighbour of an addressed item. */
interface Neighbour {
  item: TranscriptItem;
  onLineage: boolean;
  address: string;
  sessionKey: string;
}

/** The item a `get` call answers with (specs/search-tool.md#get). */
interface Addressed {
  item: TranscriptItem;
  sessionKey: string;
  onLineage: boolean;
  address: string;
  /** The address of the paired item, when the line of step 2 has one (specs/search-tool.md#get). */
  paired: string | undefined;
  before: Neighbour[];
  after: Neighbour[];
}

/** What the index answered about an addressed item. */
type IndexedItem =
  | { kind: "item"; addressed: Addressed }
  | { kind: "missing" }
  | { kind: "stale"; row: IndexItemRow }
  | { kind: "unreadable" };

/** The partner of one row, when the row is the first of its kind with its tool-call ID (specs/session-transcript.md#transcript-items). */
function partnerRow(rows: readonly IndexItemRow[], row: IndexItemRow): IndexItemRow | undefined {
  const callId = row.callId;
  if (callId === null) return;
  if (row.kind !== "tool_call" && row.kind !== "tool_result") return;
  const own = rows.filter((other) => other.kind === row.kind && other.callId === callId);
  const first = own[0];
  if (first === undefined || first.itemId !== row.itemId) return;
  const otherKind = row.kind === "tool_call" ? "tool_result" : "tool_call";
  return rows.find((other) => other.kind === otherKind && other.callId === callId);
}

/** The address of a row's item, relative to the session key. */
function rowAddress(sessionKey: string, row: IndexItemRow): string {
  return addressOf(sessionKey, row.entryId, row.part === "" ? undefined : row.part);
}

/** The addressed item from the index (specs/search-tool.md#get). */
function addressedFromIndex(call: Call, cover: Cover, address: ItemAddress): IndexedItem {
  const index = call.index;
  if (index === undefined || cover.fileId === undefined) return { kind: "unreadable" };
  const found = index.findItem(cover.fileId, address.entryId, address.part);
  refreshIndexState(call);
  if (!found.ok) return { kind: "unreadable" };
  const row = found.value;
  if (row === undefined) return { kind: "missing" };
  // Only the entries terminated when the call started are used (specs/search-tool.md#coverage).
  const size = cover.size ?? 0;
  if (row.offset + row.bytes + 1 > size) return { kind: "missing" };
  const read = index.readItem(row);
  refreshIndexState(call);
  if (read.status === "stale") return { kind: "stale", row };
  if (read.status !== "item") return { kind: "unreadable" };
  note(call, { phase: "read", key: cover.session.key });
  const listed = index.listItems(cover.fileId);
  refreshIndexState(call);
  if (!listed.ok) return { kind: "unreadable" };
  // specs/session-index.md#concurrent-access: a later read must find the file's rows under the
  // same path, at a `consumed` no smaller than the call's own catch-up left, and the
  // items under the `item_id`s it uses. Rows that do not are no longer this session's,
  // and the call reads the file.
  if (row.path !== cover.session.resolvedPath) return { kind: "unreadable" };
  const floor = cover.consumed ?? 0;
  if (row.consumed < floor) return { kind: "unreadable" };
  let consumed = row.consumed;
  let holdsRow = false;
  for (const other of listed.value) {
    if (other.path !== row.path) return { kind: "unreadable" };
    if (other.consumed < floor) return { kind: "unreadable" };
    if (other.consumed > consumed) consumed = other.consumed;
    // `item_id` alone is a reused rowid: the row this call read is the one on the same
    // line and part, as `probeRows` compares it.
    if (other.itemId === row.itemId && other.line === row.line && other.part === row.part) {
      holdsRow = true;
    }
  }
  if (!holdsRow) return { kind: "unreadable" };
  // The lineage is that of the entries terminated when the call started (specs/search-tool.md#coverage).
  let lineage: ReadonlySet<string> | undefined;
  if (consumed > size || cover.lineageIds !== undefined) {
    if (cover.lineageIds === undefined) {
      const computed = index.lineageWithin(cover.fileId, size);
      refreshIndexState(call);
      if (!computed.ok) return { kind: "unreadable" };
      cover.lineageIds = new Set(computed.value);
    }
    lineage = cover.lineageIds;
  }
  const onLineage = (other: IndexItemRow): boolean =>
    lineage === undefined ? other.lineage : lineage.has(other.entryId);
  const rows = listed.value.filter((other) => other.offset + other.bytes + 1 <= size);
  const position = rows.findIndex((other) => other.itemId === row.itemId);
  const before: Neighbour[] = [];
  const after: Neighbour[] = [];
  const context = call.settings.context;
  if (position >= 0 && context > 0) {
    for (const other of rows.slice(Math.max(0, position - context), position)) {
      const neighbour = index.readItem(other);
      refreshIndexState(call);
      if (neighbour.status === "stale") return { kind: "stale", row: other };
      if (neighbour.status !== "item") return { kind: "unreadable" };
      before.push({
        item: neighbour.item,
        onLineage: onLineage(other),
        address: rowAddress(cover.session.key, other),
        sessionKey: cover.session.key,
      });
    }
    for (const other of rows.slice(position + 1, position + 1 + context)) {
      const neighbour = index.readItem(other);
      refreshIndexState(call);
      if (neighbour.status === "stale") return { kind: "stale", row: other };
      if (neighbour.status !== "item") return { kind: "unreadable" };
      after.push({
        item: neighbour.item,
        onLineage: onLineage(other),
        address: rowAddress(cover.session.key, other),
        sessionKey: cover.session.key,
      });
    }
  }
  const partner = partnerRow(rows, row);
  return {
    kind: "item",
    addressed: {
      item: read.item,
      sessionKey: cover.session.key,
      onLineage: onLineage(row),
      address: rowAddress(cover.session.key, row),
      paired: partner === undefined ? undefined : rowAddress(cover.session.key, partner),
      before,
      after,
    },
  };
}

/** The addressed item from a direct read of its session (specs/search-tool.md#get). */
function addressedFromRead(call: Call, cover: Cover, address: ItemAddress): Addressed | undefined {
  const items = cover.items ?? [];
  const item = resolveItem(items, address);
  if (item === undefined) return;
  const ordered = items.toSorted((one, other) => {
    if (one.line !== other.line) return one.line - other.line;
    return compareParts(one.part, other.part);
  });
  const position = ordered.findIndex(
    (other) => other.entryId === item.entryId && other.part === item.part,
  );
  const context = call.settings.context;
  const before: Neighbour[] = [];
  const after: Neighbour[] = [];
  if (position >= 0 && context > 0) {
    for (const other of ordered.slice(Math.max(0, position - context), position)) {
      before.push({
        item: other,
        onLineage: cover.onLineage?.has(other.entryId) === true,
        address: formatItemAddress(itemAddress(cover.session.key, other)),
        sessionKey: cover.session.key,
      });
    }
    for (const other of ordered.slice(position + 1, position + 1 + context)) {
      after.push({
        item: other,
        onLineage: cover.onLineage?.has(other.entryId) === true,
        address: formatItemAddress(itemAddress(cover.session.key, other)),
        sessionKey: cover.session.key,
      });
    }
  }
  const partner = pairedItem(item, ordered);
  return {
    item,
    sessionKey: cover.session.key,
    onLineage: cover.onLineage?.has(item.entryId) === true,
    address: formatItemAddress(itemAddress(cover.session.key, item)),
    paired:
      partner === undefined
        ? undefined
        : formatItemAddress(itemAddress(cover.session.key, partner)),
    before,
    after,
  };
}

/** The hit line parts of a neighbour: no `at`, and the snippet with start position 0 (specs/search-tool.md#get). */
function neighbourParts(neighbour: Neighbour): HitLineParts {
  return {
    address: neighbour.address,
    time: neighbour.item.time,
    kind: neighbour.item.kind,
    label: neighbour.item.label,
    isError: neighbour.item.kind === "tool_result" ? neighbour.item.isError : false,
    offLineage: !neighbour.onLineage,
    length: neighbour.item.length,
    at: undefined,
    snippet: snippetOf(neighbour.item.text, 0),
  };
}

/** The `<hit>` object of a neighbour (specs/search-tool.md#get). */
function neighbourDetails(neighbour: Neighbour): Record<string, unknown> {
  return hitDetails({
    address: neighbour.address,
    sessionKey: neighbour.sessionKey,
    kind: neighbour.item.kind,
    label: neighbour.item.label,
    isError: neighbour.item.kind === "tool_result" ? neighbour.item.isError : undefined,
    offLineage: !neighbour.onLineage,
    time: neighbour.item.time,
    length: neighbour.item.length,
    at: undefined,
    snippet: snippetOf(neighbour.item.text, 0),
  });
}

/** The result of a `get` call (specs/search-tool.md#get). */
function getResult(call: Call, addressed: Addressed): ToolResult {
  const item = addressed.item;
  const settings = call.settings;
  const limit = settings.limit ?? GET_LIMIT;
  const offset = settings.offset;
  const end = Math.min(item.length, offset + limit);
  const lines: string[] = [
    hitLine(
      {
        address: addressed.address,
        time: item.time,
        kind: item.kind,
        label: item.label,
        isError: item.kind === "tool_result" ? item.isError : false,
        offLineage: !addressed.onLineage,
        length: item.length,
        at: undefined,
        snippet: undefined,
      },
      call.zone,
    ),
  ];
  if (item.kind === "tool_call") lines.push(`result: ${addressed.paired ?? "(none)"}`);
  if (item.kind === "tool_result") lines.push(`call: ${addressed.paired ?? "(none)"}`);
  lines.push(`--- text ${offset}..${end} of ${item.length} ---`);
  if (end > offset) lines.push(item.text.slice(offset, end));
  lines.push(
    end === item.length ? "--- end of text ---" : `--- cut: continue with offset ${end} ---`,
  );
  if (addressed.before.length > 0) {
    lines.push("Before:");
    for (const neighbour of addressed.before) {
      lines.push(hitLine(neighbourParts(neighbour), call.zone));
    }
  }
  if (addressed.after.length > 0) {
    lines.push("After:");
    for (const neighbour of addressed.after) {
      lines.push(hitLine(neighbourParts(neighbour), call.zone));
    }
  }
  const details: Record<string, unknown> = {
    action: "get",
    address: addressed.address,
    session: addressed.sessionKey,
    kind: item.kind,
    offLineage: !addressed.onLineage,
    time: item.time,
    length: item.length,
    offset,
    end,
    before: addressed.before.map(neighbourDetails),
    after: addressed.after.map(neighbourDetails),
  };
  if (item.label !== undefined) details.label = item.label;
  if (item.kind === "tool_result") details.isError = item.isError;
  if (addressed.paired !== undefined) details.paired = addressed.paired;
  return { content: [{ type: "text", text: lines.join("\n") }], details };
}

/** True when covering found the file not readable as a session file (specs/search-tool.md#coverage). */
function coverLost(cover: Cover): boolean {
  return cover.state === "lost";
}

async function getAction(call: Call, settings: Settings): Promise<ToolResult> {
  const addressText = settings.address ?? "";
  const address = parseItemAddress(addressText);
  if (address === undefined) {
    return textError("address must be an item address such as self:1a2b3c4d or self:1a2b3c4d.0");
  }
  const asks = asksForProject(call, address);
  const refusal = projectRefusal(call, asks);
  if (refusal !== undefined) return textError(refusal);
  if (asks) await loadProject(call);
  const resolved = resolveSession(call.forest, address.sessionKey, true);
  if (resolved.kind === "error") return textError(resolved.message);
  const session = resolved.session;
  call.covers = await coversOf(call, [session]);
  await coverSessions(call, [session]);
  if (isAborted(call)) return abortedResult();
  const cover = call.covers[0];
  if (cover === undefined) return textError(`no item ${addressText}`);
  if (cover.state === "lost") {
    // The file is not a session of the call: its key names no session (specs/search-tool.md#coverage).
    return textError(`unknown session "${address.sessionKey}"`);
  }
  let addressed: Addressed | undefined;
  if (cover.state === "catchup" && !cover.dropped) {
    const outcome = addressedFromIndex(call, cover, address);
    if (outcome.kind === "item") {
      addressed = outcome.addressed;
    } else if (outcome.kind === "missing") {
      return textError(`no item ${addressText}`);
    } else {
      if (outcome.kind === "stale") await resetStaleRow(call, outcome.row);
      // A stale row, or rows the call cannot read: answer from a direct read (specs/search-tool.md#coverage).
      await coverDirectly(call, cover);
      if (isAborted(call)) return abortedResult();
    }
  } else if (cover.state !== "direct" || cover.dropped) {
    await coverDirectly(call, cover);
    if (isAborted(call)) return abortedResult();
  }
  if (addressed === undefined) {
    if (coverLost(cover)) {
      // The file is not readable as a session file: its key names no session (specs/search-tool.md#coverage).
      return textError(`unknown session "${address.sessionKey}"`);
    }
    addressed = addressedFromRead(call, cover, address);
  }
  if (addressed === undefined) return textError(`no item ${addressText}`);
  const item = addressed.item;
  if (settings.offset > item.length) {
    return textError(
      `offset ${settings.offset} is past the end of the text (${item.length} characters)`,
    );
  }
  return getResult(call, addressed);
}

// ---------------------------------------------------------------------------
// specs/search-tool.md#sessions: the `sessions` action
// ---------------------------------------------------------------------------

/** The snippet of the first `user` item among the entries of a file's first 50 lines (specs/search-tool.md#sessions). */
function previewOf(read: SessionRead | undefined): string {
  if (read === undefined) return "(no user message)";
  for (const item of sessionItems(read.entries)) {
    if (item.kind !== "user") continue;
    return snippetOf(item.text, 0);
  }
  return "(no user message)";
}

/** The preview of one session, read from its file's first 50 lines (specs/search-tool.md#sessions). */
async function previewAt(call: Call, path: string, size: number): Promise<string> {
  const outcome = await readSessionChunked(path, {
    to: size,
    maxLines: PREVIEW_LINES,
    chunkBytes: PREVIEW_CHUNK_BYTES,
    call,
    key: path,
  });
  if (outcome.kind !== "read") return "(no user message)";
  return previewOf(outcome.read);
}

/**
 * The sessions of a `tree` listing in the order of specs/search-tool.md#sessions: the resolved
 * session first, then each session's children by descending modification time and
 * ascending key, each child followed in turn by its own children.
 */
function treeListing(
  sessions: readonly Reached[],
  root: Reached,
  mtimes: ReadonlyMap<string, number | undefined>,
): Reached[] {
  const childrenOf = (parent: Reached): Reached[] => {
    const children = sessions.filter(
      (session) =>
        session.stems.length === parent.stems.length + 1 && isBeneath(session.stems, parent.stems),
    );
    return children.toSorted((one, other) => {
      const delta = (mtimes.get(other.path) ?? 0) - (mtimes.get(one.path) ?? 0);
      if (delta !== 0) return delta;
      return compareStrings(one.key, other.key);
    });
  };
  const ordered: Reached[] = [];
  const visit = (session: Reached): void => {
    ordered.push(session);
    for (const child of childrenOf(session)) visit(child);
  };
  visit(root);
  return ordered;
}

/** The result of a `sessions` call (specs/search-tool.md#sessions). */
async function sessionsAction(call: Call, settings: Settings): Promise<ToolResult> {
  const value = settings.session;
  const asks = settings.scope === "project" || (value !== undefined && value.startsWith("~"));
  const refusal = projectRefusal(call, asks);
  if (refusal !== undefined) return textError(refusal);
  const namesPath = call.host.main && value !== undefined && value.startsWith("/");
  if (asks || namesPath) await loadProject(call);
  const resolved = resolveSession(call.forest, settings.session ?? "", false);
  if (resolved.kind === "error") return textError(resolved.message);
  const sessions = callSessions(call.forest, settings.scope, resolved.session);
  const mtimes = new Map<string, number | undefined>();
  for (const session of sessions) {
    const stamp = stampOf(session.path);
    mtimes.set(session.path, stamp === undefined ? undefined : stamp.mtime);
  }
  let ordered: Reached[];
  if (settings.scope === "project") {
    const first = sessions[0];
    const rest = sessions.slice(1).toSorted((one, other) => {
      const delta = (mtimes.get(other.path) ?? 0) - (mtimes.get(one.path) ?? 0);
      if (delta !== 0) return delta;
      return compareStrings(one.key, other.key);
    });
    ordered = first === undefined ? rest : [first, ...rest];
  } else {
    // specs/search-tool.md#sessions: the session first, then each session's children by descending
    // modification time, ties by ascending key, each child followed by its own.
    ordered = treeListing(sessions, resolved.session, mtimes);
  }
  const kept: Reached[] = [];
  for (const session of ordered) {
    const mtime = mtimes.get(session.path);
    if (mtime === undefined) {
      if (settings.since === undefined && settings.until === undefined) kept.push(session);
      continue;
    }
    if (settings.since !== undefined && mtime < settings.since) continue;
    if (settings.until !== undefined && mtime >= settings.until) continue;
    kept.push(session);
  }
  const limit = settings.limit ?? SESSIONS_LIMIT;
  const listed = kept.slice(0, limit);
  const lines: string[] = [];
  const entries: Record<string, unknown>[] = [];
  for (const session of listed) {
    const stamp = stampOf(session.path);
    const header = session.header;
    if (stamp === undefined || header === undefined) {
      lines.push(`${session.key} \u00b7 (no session file)`);
      entries.push({
        key: session.key,
        path: null,
        startedAt: null,
        bytes: null,
        modifiedAt: null,
        preview: null,
      });
      continue;
    }
    const preview = await previewAt(call, session.path, stamp.size);
    if (isAborted(call)) return abortedResult();
    lines.push(
      `${session.key} \u00b7 ${localStamp(header.time, call.zone)} \u00b7 ${stamp.size} bytes \u00b7 modified ${localStamp(stamp.mtime, call.zone)} \u00b7 ${preview}`,
    );
    entries.push({
      key: session.key,
      path: session.path,
      startedAt: header.time,
      bytes: stamp.size,
      modifiedAt: stamp.mtime,
      preview,
    });
  }
  if (kept.length > listed.length) {
    lines.push(`\u2026 ${kept.length - listed.length} more sessions`);
  }
  const text = lines.length === 0 ? "(no sessions)" : lines.join("\n");
  return {
    content: [{ type: "text", text }],
    details: {
      action: "sessions",
      scope: settings.scope,
      total: kept.length,
      sessions: entries,
    },
  };
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

/** The `Search` tool of one extension instance. */
export function searchRuntime(options: SearchRuntimeOptions): SearchRuntime {
  const now = options.now ?? (() => Date.now());
  const running = new Set<Promise<unknown>>();

  async function execute(invocation: SearchInvocation): Promise<ToolResult> {
    const fields: Record<string, unknown> = isPlainObject(invocation.params)
      ? invocation.params
      : {};
    const started = now();
    const action = actionOf(fields.action);
    if (action === undefined) {
      return textError("action must be one of find, get, or sessions");
    }
    const checked = checkCall(action, fields, started);
    if (checked.kind === "error") return textError(checked.message);
    const call: Call = {
      settings: checked.settings,
      action,
      host: invocation,
      zone: options.zone,
      now,
      pace: makePacer(),
      progress: options.progress,
      signal: invocation.signal,
      started,
      coveringDeadline: started + COVERING_MS,
      budgetDeadline: started + BUDGET_MS,
      indexPath: options.indexPath,
      busyTimeoutMs: options.busyTimeoutMs,
      bootDeadline: options.bootDeadline,
      forest: emptyForest(invocation),
      index: undefined,
      indexUnusable: undefined,
      failedWrite: undefined,
      covers: [],
      query: undefined,
      after: undefined,
      afterCover: undefined,
      afterLost: false,
      afterRecovered: false,
      sources: [],
      evaluator: undefined,
      headerOf: undefined,
      onItemRead: options.onItemRead,
      projectLoaded: false,
      knownVersion: undefined,
      makeEvaluator: options.makeEvaluator,
      continuation: undefined,
    };
    note(call, { phase: "start" });
    if (action !== "sessions") {
      const opened = openSessionIndex({ path: call.indexPath, busyTimeoutMs: call.busyTimeoutMs });
      if (opened.ok) call.index = opened.index;
      else call.indexUnusable = opened.reason;
    }
    const forest = await discoverForest(call, false);
    call.forest = forest;
    const register = (continuation: CatchUpContinuation): void => {
      continuations.add(continuation);
      const settled = continuation.done.then((outcome) => {
        continuations.delete(continuation);
        running.delete(settled);
        call.index?.close();
        return outcome;
      });
      running.add(settled);
    };
    try {
      if (isAborted(call)) return abortedResult();
      if (action === "sessions") return await sessionsAction(call, checked.settings);
      if (action === "get") return await getAction(call, checked.settings);
      return await findAction(call, register);
    } finally {
      call.evaluator?.close();
      if (call.continuation === undefined) call.index?.close();
    }
  }

  const continuations = new Set<CatchUpContinuation>();

  return {
    execute,
    /** Stop every continuation of catch-up: the boot window ends (specs/search-tool.md#coverage). */
    stop(): void {
      for (const continuation of continuations) continuation.stop();
      continuations.clear();
    },
    async backgroundDone(): Promise<void> {
      await Promise.allSettled(running);
    },
  };
}

/** The `Search` tool definition the host registers (specs/search-tool.md#registration). */
export function makeSearchTool(deps: SearchToolDeps) {
  return defineTool({
    name: SEARCH_TOOL_NAME,
    label: SEARCH_TOOL_NAME,
    description: SEARCH_DESCRIPTION,
    promptSnippet: SEARCH_PROMPT_SNIPPET,
    parameters: searchParameterSchema,
    async execute(
      _toolCallId: string,
      params: SearchToolParams,
      signal: AbortSignal | undefined,
      _onUpdate: ((partial: ToolResult) => void) | undefined,
      ctx: ExtensionToolContext,
    ): Promise<ToolResult> {
      const host = deps.host(ctx);
      return deps.runtime.execute({ ...host, params, signal });
    },
  });
}
