import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { BootSnapshot } from "./engine.ts";
import { renderPluginCommand } from "./plugins.ts";
import {
  errorCode,
  errorMessage,
  firstLine,
  isPlainObject,
  isPromiseLike,
  shortUuid,
} from "./util.ts";

/**
 * Local fleet coordination per specs/fleet-tool.md over the local session store
 * (specs/session-store.md): repo/machine discovery (`list`), unicast/fan-out `send` with `steer` and
 * `followUp` delivery modes, isolated background `query` with `followUp`
 * reply, waited `query` from a child session (Section 4.1), and
 * boot-window-scoped transport `status`.
 *
 * The store is shared by every pi-dent process on the machine (SQLite, WAL).
 * Sessions are owned by the boot window that registered them: liveness is
 * owner-process liveness (never a quiet-time TTL), a session is drained by at
 * most one live boot window, and a session that ends removes its record and
 * dead-letters its pending inbound messages as `rejected`. A child session is
 * not a fleet member: its child session record gives it an address, makes it
 * reachable by its parent only, and its boot window delivers into its own
 * conversation; a hidden record gives a child session without one an address
 * for a waited-query reply and nothing else (specs/session-store.md, Section 4).
 */

export type FleetAction = "list" | "send" | "query" | "status";
export type FleetScope = "repo" | "machine" | "children";
export type FleetListFormat = "compact" | "full" | "json";
export type FleetDeliverMode = "steer" | "followUp";
export type FleetSessionState = "running" | "idle";
export type FleetTargetState = "running" | "idle";
export type FleetMessageStatus = "pending" | "delivered" | "rejected" | "unknown";

/**
 * The identity of a `Fleet` caller or `/fleet` invoker in this boot window
 * (specs/session-store.md Section 4, specs/fleet-tool.md Section 1).
 */
export type FleetCallerIdentity = "endpoint" | "child" | "foreign";

/**
 * What a child registration did: `refused` when a live boot window owns the record,
 * `own` when the session ID is this boot window's own session or endpoint, `closed`
 * when this boot window's store is gone (specs/session-store.md, Section 4).
 */
export type ChildRegistration = "registered" | "refused" | "own" | "closed";

/**
 * The warning of a session record another live boot window owns (specs/session-store.md,
 * Section 4), without the `pi-dent: ` prefix its channel adds.
 */
export function ownedElsewhereWarning(sessionId: string): string {
  return `session ${sessionId} is already owned by another live boot window; Fleet delivery to this session is disabled`;
}

/** The warning of a child session ID that is this boot window's own session (specs/session-store.md, Section 4). */
export function ownSessionWarning(sessionId: string): string {
  return `session ${sessionId} is this boot window's own session; Fleet delivery to this session is disabled`;
}

export interface FleetTurnRecord {
  command: string;
  goal: string;
  files: string[];
  startedAt: number;
}

export interface FleetSessionRecord {
  sessionId: string;
  cwd: string;
  repoRoot?: string | undefined;
  state: FleetSessionState;
  updatedAt: number;
  turns: FleetTurnRecord[];
  ownerPid: number;
  ownerBoot?: string | undefined;
  ownerStarted: number;
  agentsDir?: string | undefined;
  /** A hidden record: an address for a waited-query reply, never a fleet session. */
  hidden: boolean;
  /** The dispatching session's ID: a child session record (session-store.md, Section 4). */
  parentSessionId?: string | undefined;
}

export interface FleetEndpoint {
  sessionId: string;
  /** The session's agent directory (agent-tool.md Section 4.2), recorded for the retention sweep. */
  agentsDir?: string | undefined;
  cwd(): string;
  isIdle(): boolean;
  abortTurn(): void;
  /** May return a promise; a rejection or throw fails the delivery. */
  deliverTurn(text: string, mode: FleetDeliverMode): void | Promise<void>;
  runBuiltinCommand?: ((name: string, args: string) => boolean) | undefined;
  /**
   * Report a Fleet failure this session's user can act on, as a user-visible
   * message (fleet-tool.md Section 4). A throwing report never fails delivery.
   */
  notify?: ((message: string) => void) | undefined;
  runQuery?:
    | ((query: {
        correlationId: string;
        senderSessionId: string;
        subject?: string | undefined;
        body: string;
      }) => Promise<{ text: string; isError: boolean }>)
    | undefined;
}

/** The store's file name under `~/.pi/pi-dent/` (session-store.md, Section 1). */
const STORE_FILE_NAME = "fleet-v2.sqlite";
/** The format version recorded in `user_version` (session-store.md, Section 1). */
const STORE_FORMAT_VERSION = 2;
/** The store's tables (session-store.md, Sections 2 and 3). */
const STORE_SCHEMA = `
	CREATE TABLE fleet_sessions (
		session_id TEXT PRIMARY KEY,
		cwd TEXT NOT NULL,
		repo_root TEXT,
		state TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		turns_json TEXT NOT NULL,
		owner_pid INTEGER NOT NULL,
		owner_boot TEXT,
		owner_started INTEGER NOT NULL,
		agents_dir TEXT,
		-- 1 for a hidden record: an address for a waited-query reply (session-store.md Section 4).
		hidden INTEGER NOT NULL,
		-- The dispatching session of a child session record; NULL for a fleet session.
		parent_session_id TEXT
	);
	CREATE TABLE fleet_messages (
		message_id INTEGER PRIMARY KEY AUTOINCREMENT,
		sender_session_id TEXT NOT NULL,
		target_session_id TEXT NOT NULL,
		boot_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		subject TEXT,
		body TEXT NOT NULL,
		deliver TEXT NOT NULL,
		abort INTEGER NOT NULL,
		correlation_id TEXT,
		status TEXT NOT NULL,
		rejection_reason TEXT,
		created_at INTEGER NOT NULL,
		delivered_at INTEGER,
		deliver_text TEXT
	);
`;

/** A required integer column of a stored row; any other value is a store that is not this format's. */
function integerColumn(row: Record<string, SQLOutputValue>, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  throw new Error(`session store column ${column} holds no integer`);
}

const BUILTIN_COMMANDS = new Set(["compact", "abort"]);
const MAX_TURNS = 5;
/** Message rows older than this are purged at construction (crashed boot windows never clear themselves). */
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 2000;
const POLL_INTERVAL_MS = 250;
/** A waited-query reply quotes its correlation ID on its first line (fleet-tool.md Section 4.1). */
const QUERY_REPLY_PREFIX = /^\[Fleet query reply correlationId=([^\]]+)\]\n/;

/** Approximate start time of this process, to detect pid reuse. */
const PROCESS_STARTED_MS = Date.now() - Math.round(process.uptime() * 1000);

/** The rejection reason of a host refusal (specs/session-store.md, Section 5). */
function deliveryFailedReason(error: unknown): string {
  return `delivery failed: ${errorMessage(error)}`;
}

/**
 * Boot windows alive in this process (reference counts, by boot ID): a record
 * owned by one of them has a live owner, so it is not gone
 * (specs/session-store.md, Section 4).
 */
const liveBootWindows = new Map<string, number>();

function trackBootWindow(bootId: string): void {
  liveBootWindows.set(bootId, (liveBootWindows.get(bootId) ?? 0) + 1);
}

function untrackBootWindow(bootId: string): void {
  const live = (liveBootWindows.get(bootId) ?? 0) - 1;
  if (live <= 0) {
    liveBootWindows.delete(bootId);
    return;
  }
  liveBootWindows.set(bootId, live);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is not ours. Anything else means it is gone.
    return errorCode(error) === "EPERM";
  }
}

/**
 * Resolve the canonical Git repository root for `cwd` so linked worktrees of
 * the same repository share one identity (specs/session-store.md, Section 2).
 * Not cached: the root is derived when a record is written, so a `git init`
 * after an earlier write is picked up.
 */
export function resolveRepoRoot(cwd: string): string | undefined {
  let current = resolve(cwd);
  while (true) {
    const dotGit = join(current, ".git");
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) {
        return realpathSync(current);
      }
      if (stat.isFile()) {
        const raw = readFileSync(dotGit, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/i.exec(raw);
        if (match?.[1]) {
          const gitDir = resolve(current, match[1].trim());
          const commonFile = join(gitDir, "commondir");
          if (existsSync(commonFile)) {
            const commonRel = readFileSync(commonFile, "utf8").trim();
            const commonGitDir = resolve(gitDir, commonRel);
            return realpathSync(dirname(commonGitDir));
          }
        }
        // Any other `.git` file marks this ancestor as the root (fleet-tool.md Section 2).
        return realpathSync(current);
      }
    } catch {
      // Continue walking upward.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

interface StoredMessageRow {
  message_id: number;
  sender_session_id: string;
  target_session_id: string;
  boot_id: string;
  kind: "send" | "query";
  subject: string | null;
  body: string;
  deliver: FleetDeliverMode;
  abort: number;
  correlation_id: string | null;
  status: "pending" | "delivered" | "rejected";
  rejection_reason: string | null;
  created_at: number;
  delivered_at: number | null;
  /** Precomputed text to inject, when present; NULL rows are classified and rendered at delivery. */
  deliver_text: string | null;
}

function toMessageRow(row: Record<string, SQLOutputValue>): StoredMessageRow {
  return {
    message_id: typeof row.message_id === "number" ? row.message_id : Number(row.message_id),
    sender_session_id: typeof row.sender_session_id === "string" ? row.sender_session_id : "",
    target_session_id: typeof row.target_session_id === "string" ? row.target_session_id : "",
    boot_id: typeof row.boot_id === "string" ? row.boot_id : "",
    kind: row.kind === "query" ? "query" : "send",
    subject: typeof row.subject === "string" ? row.subject : null,
    body: typeof row.body === "string" ? row.body : "",
    deliver: row.deliver === "steer" ? "steer" : "followUp",
    abort: typeof row.abort === "number" ? row.abort : 0,
    correlation_id: typeof row.correlation_id === "string" ? row.correlation_id : null,
    status:
      row.status === "delivered" ? "delivered" : row.status === "rejected" ? "rejected" : "pending",
    rejection_reason: typeof row.rejection_reason === "string" ? row.rejection_reason : null,
    created_at: typeof row.created_at === "number" ? row.created_at : 0,
    delivered_at: typeof row.delivered_at === "number" ? row.delivered_at : null,
    deliver_text: typeof row.deliver_text === "string" ? row.deliver_text : null,
  };
}

const SESSION_COLUMNS =
  "session_id, cwd, repo_root, state, updated_at, turns_json, owner_pid, owner_boot, owner_started, agents_dir, hidden, parent_session_id";

/** What a send row delivers: injected turn text, a built-in command, or a terminal rejection. */
type PreparedDelivery =
  | { kind: "turn"; text: string }
  | { kind: "builtin"; name: string; args: string }
  | { kind: "rejected"; reason: string };

/** One outstanding waited query (fleet-tool.md, Section 4.1). */
interface QueryWaiter {
  correlationId: string;
  /** `fleet_messages.message_id` of the query row, once enqueued. */
  queryMessageId: number;
  targetSessionId: string;
  settled: boolean;
  resolve(text: string): void;
  reject(error: Error): void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/** How a wait ends: the reply text, or the failure reason the tool reports. */
type QueryWaiterOutcome = { reply: string } | { reason: string };

/** What enqueueing a query reports: the row, its correlation ID, and the target's state. */
interface QueuedQuery {
  messageId: number;
  correlationId: string;
  target: string;
  state: FleetTargetState;
}

export class FleetCoordinator {
  readonly dbPath: string;
  readonly bootId: string;
  private readonly boot: BootSnapshot;
  private readonly db: DatabaseSync;
  private readonly endpoints = new Map<string, FleetEndpoint>();
  /**
   * The child sessions this boot window runs, by session ID — the dispatches it
   * started. Kept apart from `endpoints`, whose sessions are fleet members with a
   * live session identity: a child session stays a `child` caller even while its
   * child session record gives it an address (session-store.md, Section 4).
   */
  private readonly childEndpoints = new Map<string, FleetEndpoint>();
  /**
   * Child sessions whose registration another live boot window refused. They are
   * child sessions all the same: their `Fleet` calls are never refused
   * (specs/fleet-tool.md, Section 1).
   */
  private readonly refusedChildren = new Set<string>();
  /**
   * Sessions whose hidden record this boot window wrote as a waited-query
   * address: only such a record is deleted with the session's last wait, never a
   * child session record (fleet-tool.md, Section 4.1).
   */
  private readonly hiddenOwned = new Set<string>();
  /**
   * Session IDs this boot window tried to register as main sessions through
   * `registerEndpoint`, whether or not that succeeded (session-store.md, Section 4).
   * Forgotten when the session ends.
   */
  private readonly mainSessionIds = new Set<string>();
  private readonly deliveringFollowUp = new Set<string>();
  private readonly turnStarted = new Set<string>();
  private readonly inFlightMessages = new Set<number>();
  /** Send rows whose steer abort was already requested; delivery retries on the poll loop. */
  private readonly abortRequested = new Set<number>();
  private readonly inFlightQueries = new Map<
    string,
    Set<{
      correlationId: string;
      row: StoredMessageRow;
      endpoint: FleetEndpoint;
      replied: boolean;
    }>
  >();
  /**
   * Outstanding waited queries, by waiting session ID then correlation ID
   * (fleet-tool.md Section 4.1). A session with an entry here has a hidden
   * record; the entry goes when its last wait ends.
   */
  private readonly queryWaiters = new Map<string, Map<string, QueryWaiter>>();
  private pollTimer: NodeJS.Timeout | undefined;
  private lastSweep = 0;
  private closed = false;

  constructor(
    boot: BootSnapshot,
    opts: { dbPath?: string | undefined; bootId?: string | undefined } = {},
  ) {
    this.boot = boot;
    this.bootId = opts.bootId ?? shortUuid();
    this.dbPath =
      opts.dbPath ||
      process.env.PI_DENT_FLEET_DB ||
      join(homedir(), ".pi", "pi-dent", STORE_FILE_NAME);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.openFormat();
      // After the version check: a file of another format is left unchanged (Section 1).
      this.db.exec("PRAGMA journal_mode = WAL;");
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.purgeAncientRows();
    trackBootWindow(this.bootId);
    this.sweepDeadOwners();
  }

  /**
   * Create the tables of an empty file, use a file of this format version, and
   * refuse any other, the check and the creation in one transaction
   * (specs/session-store.md, Section 1).
   */
  private openFormat(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const versionRow = this.db.prepare("PRAGMA user_version").get();
      const version = typeof versionRow?.user_version === "number" ? versionRow.user_version : 0;
      const tables = this.db
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'")
        .get();
      if (version === 0 && tables?.n === 0) {
        this.db.exec(STORE_SCHEMA);
        this.db.exec(`PRAGMA user_version = ${STORE_FORMAT_VERSION};`);
      } else if (version !== STORE_FORMAT_VERSION) {
        throw new Error(`unsupported session store version ${version}`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private purgeAncientRows(): void {
    const cutoff = Date.now() - RETENTION_MS;
    this.db.prepare("DELETE FROM fleet_messages WHERE created_at < ?").run(cutoff);
  }

  /**
   * Register or update a live session endpoint in this boot window. Returns
   * false when a live boot window already owns the session — the caller must
   * not deliver to it (specs/session-store.md, Section 4: one live owner).
   */
  registerEndpoint(endpoint: FleetEndpoint, initialState: FleetSessionState = "idle"): boolean {
    this.markMainSession(endpoint.sessionId);
    if (this.closed) return false;
    const claimed = this.claimRecord(() => {
      const existing = this.getSession(endpoint.sessionId);
      if (
        existing &&
        existing.ownerBoot !== undefined &&
        existing.ownerBoot !== this.bootId &&
        !this.ownerIsGone(existing)
      ) {
        return false;
      }
      if (initialState === "idle") {
        this.deliveringFollowUp.delete(endpoint.sessionId);
        this.turnStarted.delete(endpoint.sessionId);
      }
      this.upsertSessionRow({
        sessionId: endpoint.sessionId,
        cwd: endpoint.cwd(),
        state: initialState,
        agentsDir: endpoint.agentsDir,
      });
      this.endpoints.set(endpoint.sessionId, endpoint);
      return true;
    });
    if (!claimed) return false;
    this.ensurePollLoop();
    this.drainForTarget(endpoint.sessionId);
    return true;
  }

  /**
   * Run one ownership claim in an immediate write transaction (specs/session-store.md,
   * Section 4). The claim returns false to roll back and give up; true commits. A
   * rollback that fails throws an aggregate of the claim's error and the rollback's.
   */
  private claimRecord(claim: () => boolean): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    let claimed = false;
    try {
      claimed = claim();
      this.db.exec(claimed ? "COMMIT" : "ROLLBACK");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `claim failed (${errorMessage(error)}) and its rollback failed`,
        );
      }
      throw error;
    }
    return claimed;
  }

  /**
   * Register a child session this boot window runs — one `Agent` dispatch —
   * before its first prompt, and report `refused` when the record belongs to
   * another live boot window, `closed` when this window's store is gone
   * (specs/session-store.md, Section 4). The record carries the dispatch's task
   * as its one turn, keeps `running` for its life, gives the child an address and
   * makes it reachable by `parentSessionId` only. Its endpoint is kept apart from
   * `endpoints`: the session has no live session identity
   * (specs/session-store.md, Section 4).
   */
  registerChild(parentSessionId: string, endpoint: FleetEndpoint, task: string): ChildRegistration {
    if (this.closed) return "closed";
    // A main session or a registered endpoint of this window is no child session: its
    // record stays the session's own (specs/session-store.md, Section 4).
    if (this.mainSessionIds.has(endpoint.sessionId) || this.endpoints.has(endpoint.sessionId)) {
      return "own";
    }
    const claimed = this.claimRecord(() => {
      const existing = this.getSessionIncludingHidden(endpoint.sessionId);
      if (
        existing &&
        existing.ownerBoot !== undefined &&
        existing.ownerBoot !== this.bootId &&
        !this.ownerIsGone(existing)
      ) {
        return false;
      }
      // One turn record, always this dispatch's task — a recovery attempt
      // continues the same child session and rewrites the same one turn
      // (specs/session-store.md, Section 4).
      this.upsertSessionRow({
        sessionId: endpoint.sessionId,
        cwd: endpoint.cwd(),
        state: "running",
        turns: [{ command: firstLine(task), goal: "", files: [], startedAt: Date.now() }],
        agentsDir: endpoint.agentsDir,
        parentSessionId,
      });
      return true;
    });
    if (!claimed) {
      // Refused, but still a child session: the session itself is never refused send
      // or query (specs/fleet-tool.md, Section 1).
      this.refusedChildren.add(endpoint.sessionId);
      return "refused";
    }
    // Only a committed record has a runnable child behind it (Section 4).
    this.childEndpoints.set(endpoint.sessionId, endpoint);
    this.refusedChildren.delete(endpoint.sessionId);
    // Its child session record is the session's address now: it is not a hidden
    // record this boot window deletes with a wait (Section 4.1).
    this.hiddenOwned.delete(endpoint.sessionId);
    this.ensurePollLoop();
    this.drainForTarget(endpoint.sessionId);
    return "registered";
  }

  /**
   * Delete a child session's record when its dispatch settles, in either
   * delivery mode, and reject every message still queued for it
   * (specs/session-store.md, Section 4).
   */
  unregisterChild(sessionId: string): void {
    this.refusedChildren.delete(sessionId);
    if (!this.childEndpoints.delete(sessionId)) return;
    this.deliveringFollowUp.delete(sessionId);
    this.turnStarted.delete(sessionId);
    // No reply can reach a wait of the child when its address goes.
    this.failSessionWaiters(sessionId, "cancelled");
    this.cancelInFlightQueries(sessionId);
    if (this.closed) return;
    this.deleteSession(sessionId, "target session ended before delivery");
    this.stopPollLoopIfIdle();
  }

  private cancelInFlightQueries(sessionId: string): void {
    const inFlight = this.inFlightQueries.get(sessionId);
    if (!inFlight || inFlight.size === 0) return;
    this.inFlightQueries.delete(sessionId);
    for (const query of inFlight) {
      if (query.replied) continue;
      query.replied = true;
      try {
        this.replyToSender(
          query.endpoint,
          query.correlationId,
          query.row,
          "Query cancelled: the target session ended or reloaded.",
        );
      } catch (error) {
        // A failed reply is spent, never retried (fleet-tool.md, Section 4).
        this.reportReplyFailure(query.endpoint, query.row, error);
      }
    }
  }

  /**
   * Report a reply the store refused to the target's user (fleet-tool.md, Section
   * 4). The reply itself is spent: it is never resent.
   */
  private reportReplyFailure(endpoint: FleetEndpoint, row: StoredMessageRow, error: unknown): void {
    try {
      endpoint.notify?.(
        `pi-dent: Fleet query reply to ${row.sender_session_id} failed: ${errorMessage(error)}`,
      );
    } catch {
      // A host that cannot notify reports nothing; the reply is still not resent.
    }
  }

  /**
   * Record a session as this boot window's main session, before anything in its start can
   * fail: a main session is never a child, registered or not (session-store.md, Section 4).
   */
  markMainSession(sessionId: string): void {
    this.mainSessionIds.add(sessionId);
  }

  /** Unregister a session endpoint on shutdown; pending inbound messages are dead-lettered. */
  unregisterEndpoint(sessionId: string): void {
    this.mainSessionIds.delete(sessionId);
    this.cancelInFlightQueries(sessionId);
    // A refused registration holds no endpoint: the record and its messages
    // belong to the boot window that owns the session, which alone deletes
    // them (specs/session-store.md, Section 4).
    if (!this.endpoints.delete(sessionId)) return;
    this.deliveringFollowUp.delete(sessionId);
    this.turnStarted.delete(sessionId);
    if (this.closed) return;
    this.deleteSession(sessionId, "target session ended before delivery");
    this.stopPollLoopIfIdle();
  }

  /**
   * Release a session for a `/reload` (specs/session-store.md, Section 4): ownership
   * is dropped so a new boot window can re-register the session ID, but the
   * session stays a live fleet member and its pending queues are untouched.
   */
  releaseEndpointForReload(sessionId: string): void {
    this.cancelInFlightQueries(sessionId);
    // A refused registration holds no endpoint: only the owning boot window
    // releases ownership, so a live owner keeps the session exclusively
    // (specs/session-store.md, Section 4).
    if (!this.endpoints.delete(sessionId)) return;
    this.deliveringFollowUp.delete(sessionId);
    this.turnStarted.delete(sessionId);
    if (this.closed) return;
    this.db
      .prepare(
        "UPDATE fleet_sessions SET state = 'idle', owner_boot = NULL, updated_at = ? WHERE session_id = ? AND owner_boot = ?",
      )
      .run(Date.now(), sessionId, this.bootId);
    this.stopPollLoopIfIdle();
  }

  /**
   * Clear sent-message rows from this boot window (specs/session-store.md, Section 4).
   * With `keepPending`, rows still `pending` survive the boundary: a `/reload`
   * neither ends a session nor cancels a pending message.
   */
  clearBootWindow(opts: { keepPending?: boolean } = {}): void {
    if (this.closed) return;
    // A child session record goes with the boot window that ran its dispatch
    // (specs/session-store.md, Section 4): the dispatch cannot outlive it.
    this.releaseChildSessions();
    const sql = opts.keepPending
      ? "DELETE FROM fleet_messages WHERE boot_id = ? AND status != 'pending'"
      : "DELETE FROM fleet_messages WHERE boot_id = ?";
    this.db.prepare(sql).run(this.bootId);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Delete the child session records this boot window wrote, in the same way a
   * settled dispatch does: each with its queued messages dead-lettered.
   */
  private releaseChildSessions(): void {
    for (const sessionId of this.childEndpoints.keys()) {
      this.unregisterChild(sessionId);
    }
  }

  /** Close the underlying SQLite connection at boot-window teardown. */
  close(opts: { keepPending?: boolean } = {}): void {
    for (const sessionId of this.inFlightQueries.keys()) {
      this.cancelInFlightQueries(sessionId);
    }
    for (const sessionId of this.queryWaiters.keys()) {
      this.failSessionWaiters(sessionId, "cancelled");
    }
    this.clearBootWindow(opts);
    if (this.closed) return;
    this.closed = true;
    untrackBootWindow(this.bootId);
    try {
      this.db.close();
    } catch {
      // Best effort.
    }
  }

  /** Upsert a session record in the local store. */
  upsertSession(input: {
    sessionId: string;
    cwd: string;
    state: FleetSessionState;
    turns?: FleetTurnRecord[] | undefined;
  }): void {
    if (this.closed) return;
    if (input.state === "idle") {
      this.deliveringFollowUp.delete(input.sessionId);
      this.turnStarted.delete(input.sessionId);
    }
    this.upsertSessionRow(input);
    if (input.state === "idle") {
      this.drainForTarget(input.sessionId);
    }
  }

  private upsertSessionRow(input: {
    sessionId: string;
    cwd: string;
    state: FleetSessionState;
    turns?: FleetTurnRecord[] | undefined;
    agentsDir?: string | undefined;
    /** Write a hidden record: a child session's address for a waited query (fleet-tool.md 4.1). */
    hidden?: boolean | undefined;
    /** Written for a child session record (session-store.md, Section 4). */
    parentSessionId?: string | undefined;
  }): void {
    const existing = this.getSessionIncludingHidden(input.sessionId);
    const agentsDir =
      input.agentsDir ?? this.endpointFor(input.sessionId)?.agentsDir ?? existing?.agentsDir;
    const cwd = resolve(input.cwd);
    const repoRoot = resolveRepoRoot(cwd);
    const turns = (input.turns ?? existing?.turns ?? []).slice(-MAX_TURNS);
    this.db
      .prepare(
        `INSERT INTO fleet_sessions (${SESSION_COLUMNS})
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
				   cwd = excluded.cwd,
				   repo_root = excluded.repo_root,
				   state = excluded.state,
				   updated_at = excluded.updated_at,
				   turns_json = excluded.turns_json,
				   owner_pid = excluded.owner_pid,
				   owner_boot = excluded.owner_boot,
				   owner_started = excluded.owner_started,
				   agents_dir = excluded.agents_dir,
				   hidden = excluded.hidden,
				   parent_session_id = excluded.parent_session_id`,
      )
      .run(
        input.sessionId,
        cwd,
        repoRoot ?? null,
        input.state,
        Date.now(),
        JSON.stringify(turns),
        process.pid,
        this.bootId,
        PROCESS_STARTED_MS,
        agentsDir ?? null,
        input.hidden === true ? 1 : 0,
        // Each writer states the column: a later upsert without a parent keeps none,
        // never another record's (session-store.md, Section 2).
        input.parentSessionId ?? null,
      );
  }

  /**
   * Record a user message on `sessionId`: it starts a turn unless one is in
   * progress, which it joins (specs/session-store.md Section 2). A turn is
   * tracked apart from `state`: the host already reports a run when the user
   * message that starts the turn arrives. Only a session this boot window holds
   * an endpoint for is recorded: a refused session's record belongs to its live
   * owner and MUST be left unchanged (specs/session-store.md Section 4).
   */
  recordTurnStart(sessionId: string, cwd: string, command: string, goal = ""): void {
    if (!this.endpoints.has(sessionId)) return;
    const existing = this.getSession(sessionId);
    const alreadyInTurn = this.turnStarted.has(sessionId);
    const turns = alreadyInTurn
      ? (existing?.turns ?? [])
      : [
          ...(existing?.turns ?? []),
          {
            command: firstLine(command),
            goal: firstLine(goal),
            files: [],
            startedAt: Date.now(),
          },
        ].slice(-MAX_TURNS);
    this.turnStarted.add(sessionId);
    // The delivered followUp turn has started, so it is no longer awaiting its
    // turn start and stops gating later deliveries (session-store.md Section 5).
    this.deliveringFollowUp.delete(sessionId);
    this.upsertSession({ sessionId, cwd, state: "running", turns });
  }

  /**
   * A turn of a child session this boot window runs has started: a delivered
   * `followUp` no longer awaits its turn start and stops gating later deliveries
   * (specs/session-store.md Section 5). Its record keeps its one turn.
   */
  recordChildTurnStart(sessionId: string): void {
    if (!this.childEndpoints.has(sessionId)) return;
    this.deliveringFollowUp.delete(sessionId);
  }

  /** Update the stated goal of the latest turn on `sessionId`. */
  recordTurnGoal(sessionId: string, goal: string): void {
    if (!this.endpoints.has(sessionId)) return;
    const existing = this.getSession(sessionId);
    if (!existing || existing.turns.length === 0) return;
    const turns = [...existing.turns];
    const last = turns[turns.length - 1];
    if (last === undefined) return;
    if (last.goal === "" && goal.trim() !== "") {
      turns[turns.length - 1] = { ...last, goal: firstLine(goal.trim()) };
      this.upsertSession({
        sessionId,
        cwd: existing.cwd,
        state: existing.state,
        turns,
      });
    }
  }

  /** Record a changed file path on the latest turn of `sessionId`. */
  recordTurnFile(sessionId: string, filePath: string): void {
    if (!this.endpoints.has(sessionId)) return;
    const existing = this.getSession(sessionId);
    if (!existing || existing.turns.length === 0) return;
    const turns = [...existing.turns];
    const last = turns[turns.length - 1];
    if (last === undefined) return;
    if (!last.files.includes(filePath)) {
      turns[turns.length - 1] = { ...last, files: [...last.files, filePath] };
      this.upsertSession({
        sessionId,
        cwd: existing.cwd,
        state: existing.state,
        turns,
      });
    }
  }

  /** Mark a session as idle and drain any queued followUp messages. */
  recordTurnEnd(sessionId: string): void {
    if (this.childEndpoints.has(sessionId)) {
      this.deliveringFollowUp.delete(sessionId);
      this.drainForTarget(sessionId);
      return;
    }
    if (!this.endpoints.has(sessionId)) return;
    const existing = this.getSession(sessionId);
    if (!existing) return;
    this.upsertSession({
      sessionId,
      cwd: existing.cwd,
      state: "idle",
      turns: existing.turns,
    });
  }

  /**
   * Classify the caller of a `Fleet` call or the `/fleet` command
   * (specs/session-store.md Section 4, specs/fleet-tool.md Section 1):
   * `endpoint` when this boot window registered the session and was not
   * refused, `child` when it runs the session's dispatch, when the store holds no
   * visible record of it, or when its record is hidden (whose session is a child
   * session), and it is not one of this boot window's main sessions, and
   * `foreign` when a visible record exists that this boot window does not own —
   * or when a main session this boot window tried to register has no record, so
   * it has no live session identity here.
   */
  classifyCaller(sessionId: string): FleetCallerIdentity {
    if (this.endpoints.has(sessionId)) return "endpoint";
    // A child session record gives the session an address, not a live session
    // identity: the boot window that runs its dispatch still sees it as a child
    // (specs/session-store.md, Section 4). A child whose record another live boot
    // window refused is a child session too, never a foreign session
    // (specs/fleet-tool.md, Section 1).
    if (this.childEndpoints.has(sessionId) || this.refusedChildren.has(sessionId)) return "child";
    if (this.getSession(sessionId) === undefined) {
      return this.mainSessionIds.has(sessionId) ? "foreign" : "child";
    }
    return "foreign";
  }

  /** A fleet session by ID. A hidden record is not a session (session-store.md Section 4). */
  getSession(sessionId: string): FleetSessionRecord | undefined {
    return this.selectSession(sessionId, { includeHidden: false });
  }

  /**
   * Internal lookup that also sees hidden records: only the query-reply path
   * needs one, so a reply can be addressed to a waiting child session.
   */
  private getSessionIncludingHidden(sessionId: string): FleetSessionRecord | undefined {
    return this.selectSession(sessionId, { includeHidden: true });
  }

  private selectSession(
    sessionId: string,
    opts: { includeHidden: boolean },
  ): FleetSessionRecord | undefined {
    if (this.closed) return undefined;
    const filter = opts.includeHidden ? "" : " AND hidden = 0";
    const row = this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM fleet_sessions WHERE session_id = ?${filter}`)
      .get(sessionId);
    return row ? this.hydrateSession(row) : undefined;
  }

  /**
   * List sessions in the store, grouped with `running` sessions first (Section 2). Read-only.
   *
   * `machine` and `repo` list fleet sessions only — never a child session record
   * — while `children` lists the live child sessions of `callerSessionId`, with
   * no repository filter (specs/fleet-tool.md, Section 2).
   */
  listSessions(
    scope: FleetScope,
    callerCwd: string,
    callerSessionId?: string,
  ): FleetSessionRecord[] {
    if (this.closed) return [];
    const rows = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM fleet_sessions`).all();
    // A record whose owner process is gone is omitted, never deleted here, and a
    // hidden record is not a session at all (session-store.md Section 4).
    let sessions = rows
      .map((row) => this.hydrateSession(row))
      .filter((s) => !s.hidden && !this.isGone(s));
    if (scope === "children") {
      // Grandchildren are not in it: a child session's parent is the session that
      // dispatched it (fleet-tool.md Section 2).
      sessions = sessions.filter(
        (session) =>
          session.parentSessionId !== undefined && this.isTargetCandidate(session, callerSessionId),
      );
    } else {
      // Scope `machine` and `repo` list fleet sessions only, so no `broadcast` of
      // either reaches a child session (fleet-tool.md Sections 2 and 3.1).
      sessions = sessions.filter((session) => session.parentSessionId === undefined);
      if (scope === "repo") {
        const callerRepo = resolveRepoRoot(callerCwd);
        const normalizedCallerCwd = resolve(callerCwd);
        sessions = sessions.filter((session) =>
          callerRepo === undefined
            ? session.cwd === normalizedCallerCwd
            : session.repoRoot === callerRepo,
        );
      }
    }
    sessions.sort((a, b) => {
      if (a.state !== b.state) return a.state === "running" ? -1 : 1;
      return a.sessionId.localeCompare(b.sessionId);
    });
    return sessions;
  }

  /**
   * A child session is a target only for the session that spawned it, so it is an
   * unknown target for every other caller (specs/fleet-tool.md, Section 1).
   */
  private isTargetCandidate(
    session: FleetSessionRecord,
    callerSessionId: string | undefined,
  ): boolean {
    if (session.parentSessionId === undefined) return true;
    return callerSessionId !== undefined && session.parentSessionId === callerSessionId;
  }

  /**
   * Resolve a recipient token among live sessions: exact session ID first,
   * then unique session-ID prefix (specs/fleet-tool.md Section 1). A session
   * that has ended is an unknown target, and so is one whose owner process is
   * gone: its record is deleted here (specs/session-store.md Section 4). A child
   * session of another session's is filtered out before ambiguity is decided, so
   * it neither resolves nor makes a prefix ambiguous.
   */
  resolveRecipient(
    rawTarget: string,
    callerSessionId?: string,
  ): { session: FleetSessionRecord } | { error: string } {
    if (this.closed) return { error: "fleet store is closed" };
    const target = rawTarget.trim();
    // A caller checks emptiness first, so this is the spec's own error for a
    // target no session ID extends (fleet-tool.md, Section 1).
    if (target === "") return { error: 'unknown target session ""' };
    const exact = this.getSession(target);
    if (exact && !this.reapIfGone(exact) && this.isTargetCandidate(exact, callerSessionId)) {
      return { session: exact };
    }
    const escaped = target.replace(/[\\%_]/g, "\\$&");
    const rows = this.db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM fleet_sessions WHERE session_id LIKE ? ESCAPE '\\' AND hidden = 0`,
      )
      .all(`${escaped}%`);
    const matches = rows
      .map((row) => this.hydrateSession(row))
      .filter(
        (s) =>
          s.sessionId.startsWith(target) &&
          this.isTargetCandidate(s, callerSessionId) &&
          !this.reapIfGone(s),
      );
    if (matches.length === 1) {
      const session = matches[0];
      if (session === undefined) return { error: "target session disappeared" };
      return { session };
    }
    if (matches.length > 1) {
      // The host's default locale-sensitive comparison, as the listing order of
      // fleet-tool.md Section 2 states; code-unit order would differ.
      const ids = matches.map((m) => m.sessionId);
      ids.sort((a, b) => a.localeCompare(b));
      return {
        error: `ambiguous target prefix "${target}" matches ${ids.join(", ")}`,
      };
    }
    return { error: `unknown target session "${target}"` };
  }

  /**
   * Enqueue a `send` message to one resolved recipient session. Plain-text
   * bodies are enveloped once here; slash-command bodies are stored raw and
   * classified and rendered by the target at delivery time, against the
   * delivering coordinator's plugin catalog (specs/fleet-tool.md Section 3.2).
   */
  enqueueSend(input: {
    senderSessionId: string;
    target: FleetSessionRecord;
    subject?: string | undefined;
    body: string;
    deliver: FleetDeliverMode;
    abort: boolean;
    /** A query reply carries its query's boot id (session-store.md Section 3). */
    bootId?: string | undefined;
  }): {
    messageId: number;
    target: string;
    state: FleetTargetState;
    status: "pending" | "delivered" | "rejected";
    rejectionReason?: string | undefined;
  } {
    const state = this.targetStateOf(input.target);
    const deliverText = input.body.startsWith("/")
      ? null
      : this.formatEnvelope(input.senderSessionId, input.subject, input.body);
    let pending = false;
    let messageId: number;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // The target's record can be deleted between resolution and this write
      // (session-store.md, Section 4): read and insert in one immediate
      // transaction, so the row never waits for a session that is gone.
      pending = this.hasSessionRecord(input.target.sessionId);
      const result = this.db
        .prepare(
          `INSERT INTO fleet_messages
				 (sender_session_id, target_session_id, boot_id, kind, subject, body, deliver, abort, correlation_id, status, rejection_reason, created_at, delivered_at, deliver_text)
				 VALUES (?, ?, ?, 'send', ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?)`,
        )
        .run(
          input.senderSessionId,
          input.target.sessionId,
          input.bootId ?? this.bootId,
          input.subject ?? null,
          input.body,
          input.deliver,
          input.abort ? 1 : 0,
          pending ? "pending" : "rejected",
          pending ? null : "target session ended before delivery",
          Date.now(),
          deliverText,
        );
      messageId = Number(result.lastInsertRowid);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Transaction already gone.
      }
      throw error;
    }
    if (pending) this.drainForTarget(input.target.sessionId);
    const current = this.getMessageById(messageId);
    return {
      messageId,
      target: input.target.sessionId,
      state,
      status: current?.status ?? "pending",
      rejectionReason: current?.rejection_reason ?? undefined,
    };
  }

  /** Enqueue a `query` request to one resolved recipient session (Section 4). */
  enqueueQuery(input: {
    senderSessionId: string;
    target: FleetSessionRecord;
    subject?: string | undefined;
    body: string;
    /** Pre-issued by `queryAndWait`, which must know it before the row exists. */
    correlationId?: string | undefined;
  }): QueuedQuery {
    const state = this.targetStateOf(input.target);
    const correlationId = input.correlationId ?? `q-${shortUuid()}`;
    let pending = false;
    let messageId: number;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // As for a send: a target whose record is gone cannot run the query
      // (session-store.md, Section 4).
      pending = this.hasSessionRecord(input.target.sessionId);
      const result = this.db
        .prepare(
          `INSERT INTO fleet_messages
				 (sender_session_id, target_session_id, boot_id, kind, subject, body, deliver, abort, correlation_id, status, rejection_reason, created_at, delivered_at, deliver_text)
				 VALUES (?, ?, ?, 'query', ?, ?, 'followUp', 0, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          input.senderSessionId,
          input.target.sessionId,
          this.bootId,
          input.subject ?? null,
          input.body,
          correlationId,
          pending ? "pending" : "rejected",
          pending ? null : "target session ended before delivery",
          Date.now(),
        );
      messageId = Number(result.lastInsertRowid);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Transaction already gone.
      }
      throw error;
    }
    if (pending) this.drainForTarget(input.target.sessionId);
    return {
      messageId,
      correlationId,
      target: input.target.sessionId,
      state,
    };
  }

  /**
   * Enqueue a `query` for a calling session this boot window holds no endpoint
   * for — a child session — and block until its reply arrives
   * (specs/fleet-tool.md Section 4.1). The address written first gives the reply
   * somewhere to go: its child session record when it has one, else a hidden
   * record this boot window owns. This boot window consumes the reply itself and
   * deletes a hidden record when the session's last wait ends
   * (session-store.md Section 4).
   */
  queryAndWait(input: {
    senderSessionId: string;
    cwd: string;
    target: FleetSessionRecord;
    subject?: string | undefined;
    body: string;
    signal?: AbortSignal | undefined;
  }): QueuedQuery & { reply: Promise<string> } {
    // A child session whose record another live boot window owns takes no wait of
    // this one: the reply would arrive in that window's conversation, and this wait
    // could never end (fleet-tool.md, Section 4.1).
    if (this.refusedChildren.has(input.senderSessionId)) {
      throw new Error(`session ${input.senderSessionId} is owned by another live boot window`);
    }
    this.ensureWaitAddress(input.senderSessionId, input.cwd);
    const correlationId = `q-${shortUuid()}`;
    let resolveReply: (text: string) => void = () => {};
    let rejectReply: (error: Error) => void = () => {};
    const reply = new Promise<string>((resolveReplyFn, rejectReplyFn) => {
      resolveReply = resolveReplyFn;
      rejectReply = rejectReplyFn;
    });
    const waiter: QueryWaiter = {
      correlationId,
      queryMessageId: 0,
      targetSessionId: input.target.sessionId,
      settled: false,
      resolve: resolveReply,
      reject: rejectReply,
      signal: input.signal,
      onAbort: undefined,
    };
    let byCorrelation = this.queryWaiters.get(input.senderSessionId);
    if (!byCorrelation) {
      byCorrelation = new Map();
      this.queryWaiters.set(input.senderSessionId, byCorrelation);
    }
    byCorrelation.set(correlationId, waiter);
    this.ensurePollLoop();
    let queued: QueuedQuery;
    try {
      queued = this.enqueueQuery({
        senderSessionId: input.senderSessionId,
        target: input.target,
        subject: input.subject,
        body: input.body,
        correlationId,
      });
    } catch (error) {
      // No row, so no reply can end this wait: undo the registration instead of leaving it.
      this.abandonWaiter(input.senderSessionId, waiter);
      throw error;
    }
    waiter.queryMessageId = queued.messageId;
    // A target that ended before its row was written leaves nothing to wait for
    // (session-store.md, Section 4): the wait ends now, not on the next poll.
    const enqueued = this.getMessageById(waiter.queryMessageId);
    if (enqueued?.status === "rejected") {
      this.settleWaiter(input.senderSessionId, waiter, {
        reason: enqueued.rejection_reason ?? "query rejected",
      });
    }
    const sessionId = input.senderSessionId;
    const onAbort = (): void => {
      this.settleWaiter(sessionId, waiter, { reason: "cancelled" });
    };
    if (input.signal?.aborted === true) {
      onAbort();
    } else if (input.signal !== undefined && !waiter.settled) {
      waiter.onAbort = onAbort;
      input.signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
      messageId: queued.messageId,
      correlationId,
      target: queued.target,
      state: queued.state,
      reply,
    };
  }

  /**
   * Give a waiting child session an address before its query is enqueued: its
   * own child session record when it has one, else a hidden record this boot
   * window writes and therefore owns (fleet-tool.md Section 4.1). A record that
   * is not hidden belongs to the session and is left to it.
   */
  private ensureWaitAddress(sessionId: string, cwd: string): void {
    if (this.childEndpoints.has(sessionId)) return;
    const existing = this.getSessionIncludingHidden(sessionId);
    // The session's own record — a fleet session's, or its child session record —
    // is left to it; a hidden record another boot window wrote is rewritten as
    // this boot window's, which then deletes it with the session's last wait
    // (fleet-tool.md, Section 4.1).
    if (existing !== undefined && !existing.hidden) return;
    this.upsertSessionRow({ sessionId, cwd, state: "running", hidden: true });
    this.hiddenOwned.add(sessionId);
  }

  /**
   * Settle one waited query. A hidden record exists only while the session has a
   * wait, so the last settlement deletes that record — which also dead-letters
   * any row still queued for the address (session-store.md Section 4). A child
   * session record is not the wait's to delete: it goes with its dispatch.
   */
  private settleWaiter(sessionId: string, waiter: QueryWaiter, outcome: QueryWaiterOutcome): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    this.releaseWaiter(sessionId, waiter);
    if ("reply" in outcome) {
      waiter.resolve(outcome.reply);
      return;
    }
    if (outcome.reason === "cancelled") this.cancelPendingQueryRow(waiter);
    waiter.reject(new Error(outcome.reason));
  }

  /**
   * Drop one wait's registration; a hidden record this boot window wrote goes
   * with the session's last wait, and an idle coordinator stops polling
   * (Section 4.1).
   */
  private releaseWaiter(sessionId: string, waiter: QueryWaiter): void {
    const byCorrelation = this.queryWaiters.get(sessionId);
    byCorrelation?.delete(waiter.correlationId);
    if (byCorrelation !== undefined && byCorrelation.size > 0) return;
    this.queryWaiters.delete(sessionId);
    if (this.hiddenOwned.delete(sessionId)) {
      this.deleteSession(sessionId, "target session ended before delivery");
    }
    this.stopPollLoopIfIdle();
  }

  /** Drop a wait whose query row was never written: nothing to settle, nothing to reply to. */
  private abandonWaiter(sessionId: string, waiter: QueryWaiter): void {
    waiter.settled = true;
    this.releaseWaiter(sessionId, waiter);
  }

  /** A cancelled query must never run, so reject its row unless the target already took it. */
  private cancelPendingQueryRow(waiter: QueryWaiter): void {
    if (waiter.queryMessageId === 0) return;
    this.markRejected(waiter.queryMessageId, "cancelled");
  }

  /** Fail every wait of one session with `reason` (boot-window close, Section 4.1). */
  private failSessionWaiters(sessionId: string, reason: string): void {
    const byCorrelation = this.queryWaiters.get(sessionId);
    if (!byCorrelation) return;
    // Deleting the current entry while iterating a Map is well defined.
    for (const waiter of byCorrelation.values()) {
      this.settleWaiter(sessionId, waiter, { reason });
    }
  }

  /**
   * Consume pending rows addressed to a session with a waited query
   * (Section 4.1): a query reply settles its wait. Any other message is rejected
   * when the address is a hidden record — that exists only for replies — and is
   * left to the endpoint's delivery when the session has a child session record,
   * which takes its messages as a session does.
   */
  private consumePendingReplies(sessionId: string): void {
    if (!this.queryWaiters.has(sessionId)) return;
    const rows = this.db
      .prepare(
        "SELECT * FROM fleet_messages WHERE target_session_id = ? AND status = 'pending' ORDER BY message_id ASC",
      )
      .all(sessionId)
      .map(toMessageRow);
    for (const row of rows) {
      const byCorrelation = this.queryWaiters.get(sessionId);
      if (!byCorrelation) return;
      const match = QUERY_REPLY_PREFIX.exec(row.body);
      const correlationId = match?.[1];
      const waiter = correlationId === undefined ? undefined : byCorrelation.get(correlationId);
      if (match !== null && waiter !== undefined) {
        if (this.markDelivered(row.message_id)) {
          this.settleWaiter(sessionId, waiter, { reply: row.body.slice(match[0].length) });
        }
        continue;
      }
      // A child session that has its own record takes this message into its
      // conversation; only the query reply settles the wait (fleet-tool.md 4.1).
      if (this.childEndpoints.has(sessionId)) continue;
      this.markRejected(row.message_id, "session takes query replies only");
    }
  }

  /**
   * Fail waits no reply can end (Section 4.1): the query row is `rejected`, or
   * the target's record is gone. The target's existence is read before pending
   * replies are consumed, so a reply that arrived — even one written together
   * with the deletion of the target's record — always wins over the failure, and
   * a waiter a reply settled is never failed.
   */
  private checkWaiterFailures(): void {
    if (this.queryWaiters.size === 0) return;
    for (const sessionId of this.queryWaiters.keys()) {
      const byCorrelation = this.queryWaiters.get(sessionId);
      if (!byCorrelation) continue;
      const targetGone = new Map<string, boolean>();
      for (const waiter of byCorrelation.values()) {
        targetGone.set(waiter.targetSessionId, !this.hasSessionRecord(waiter.targetSessionId));
      }
      this.consumePendingReplies(sessionId);
      const remaining = this.queryWaiters.get(sessionId);
      if (!remaining) continue;
      for (const waiter of remaining.values()) {
        if (waiter.settled) continue;
        const row = this.getMessageById(waiter.queryMessageId);
        if (row?.status === "rejected") {
          this.settleWaiter(sessionId, waiter, {
            reason: row.rejection_reason ?? "query rejected",
          });
          continue;
        }
        if (targetGone.get(waiter.targetSessionId) === true) {
          this.settleWaiter(sessionId, waiter, { reason: "target session ended before replying" });
        }
      }
    }
  }

  /** True when any record — hidden or not — exists for the session ID. */
  private hasSessionRecord(sessionId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM fleet_sessions WHERE session_id = ?")
      .get(sessionId);
    return row !== undefined;
  }

  /** Read transport status of a message sent by `callerSessionId` in this boot window (Section 5). */
  getMessageStatus(
    callerSessionId: string,
    messageId: number,
  ): {
    messageId: number;
    status: FleetMessageStatus;
    target?: string | undefined;
    deliveredAt?: number | undefined;
    rejectionReason?: string | undefined;
  } {
    const row = this.getMessageById(messageId);
    if (!row || row.sender_session_id !== callerSessionId || row.boot_id !== this.bootId) {
      return { messageId, status: "unknown" };
    }
    return {
      messageId,
      status: row.status,
      target: row.target_session_id,
      ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
      ...(row.rejection_reason === null ? {} : { rejectionReason: row.rejection_reason }),
    };
  }

  /**
   * The endpoint this boot window delivers to for `sessionId`: a session it
   * registered, or a child session whose dispatch it runs (session-store.md,
   * Section 5).
   */
  private endpointFor(sessionId: string): FleetEndpoint | undefined {
    return this.endpoints.get(sessionId) ?? this.childEndpoints.get(sessionId);
  }

  /**
   * Deliver any pending messages for `targetSessionId` if its endpoint is
   * registered here. A waited query is consumed first: its reply settles the
   * call rather than becoming a turn (fleet-tool.md, Section 4.1).
   */
  drainForTarget(targetSessionId: string): void {
    if (this.closed) return;
    if (this.queryWaiters.has(targetSessionId)) this.consumePendingReplies(targetSessionId);
    const endpoint = this.endpointFor(targetSessionId);
    if (!endpoint) return;
    const pending = this.db
      .prepare(
        "SELECT * FROM fleet_messages WHERE target_session_id = ? AND status = 'pending' ORDER BY message_id ASC",
      )
      .all(targetSessionId)
      .map(toMessageRow);
    this.processPendingRows(endpoint, pending);
  }

  /** Drain every locally-owned target or hidden record with pending rows (one query per tick). */
  private drainPending(): void {
    const rows = this.db
      .prepare("SELECT DISTINCT target_session_id FROM fleet_messages WHERE status = 'pending'")
      .all();
    for (const row of rows) {
      const targetId = row.target_session_id;
      if (typeof targetId !== "string") continue;
      try {
        this.drainForTarget(targetId);
      } catch {
        // One failing target never stops the others; a periodic pass reports no
        // failure (session-store.md, Section 5).
      }
    }
  }

  private processPendingRows(endpoint: FleetEndpoint, rows: StoredMessageRow[]): void {
    // A followUp host command ends the pass for its session: later followUp
    // rows wait for the next pass (specs/session-store.md, Section 5).
    let followUpHostApplied = false;
    for (const row of rows) {
      if (this.endpointFor(row.target_session_id) !== endpoint) return;
      if (this.inFlightMessages.has(row.message_id)) continue;
      // `rows` is a snapshot: a re-entrant drain may have settled this row already.
      if (this.getMessageById(row.message_id)?.status !== "pending") continue;
      if (row.kind === "query") {
        this.deliverQueryRow(endpoint, row);
        continue;
      }
      if (row.deliver === "steer") {
        if (row.abort === 1 && !this.endpointIsIdle(endpoint)) {
          // Abort the active turn first; the message stays pending and starts
          // a new turn once the aborted turn has settled (spec 3.2). The poll
          // loop retries; the abort is requested once per message.
          if (!this.abortRequested.has(row.message_id)) {
            this.abortRequested.add(row.message_id);
            try {
              endpoint.abortTurn();
            } catch (error) {
              // A stale host context cannot abort: the row is refused
              // (session-store.md Section 5) and its request is dropped.
              this.abortRequested.delete(row.message_id);
              this.failDelivery(endpoint.sessionId, row, "steer", error);
            }
          }
          continue;
        }
        this.abortRequested.delete(row.message_id);
        // A slash body is classified once, for both modes: a rejection carries the bare
        // reason and a built-in applies directly (fleet-tool.md Section 3.2).
        const steerPrepared = this.prepareDelivery(row);
        if (steerPrepared.kind !== "turn") {
          this.applyTerminal(endpoint, row, steerPrepared);
          continue;
        }
        this.injectTurn(endpoint, row, "steer", steerPrepared.text);
        continue;
      }
      // followUp: waits until the target is idle, then delivers one turn at a time.
      if (followUpHostApplied) continue;
      const prepared = this.prepareDelivery(row);
      if (prepared.kind === "rejected") {
        this.markRejected(row.message_id, prepared.reason);
        continue;
      }
      const busy =
        !this.endpointIsIdle(endpoint) || this.deliveringFollowUp.has(endpoint.sessionId);
      if (prepared.kind === "builtin") {
        // Built-ins apply directly and never start a turn, but followUp still
        // waits for idle (spec 3.2: idle-gated followUp built-ins).
        if (busy) continue;
        followUpHostApplied = this.applyTerminal(endpoint, row, prepared);
        continue;
      }
      if (busy) continue;
      this.deliveringFollowUp.add(endpoint.sessionId);
      this.writeState(endpoint.sessionId, "running");
      this.injectTurn(endpoint, row, "followUp", prepared.text);
    }
  }

  /**
   * Apply a prepared outcome that starts no turn: a rejection with its bare
   * reason (fleet-tool.md Section 3.2), or a host command. Shared by both modes.
   */
  private applyTerminal(
    endpoint: FleetEndpoint,
    row: StoredMessageRow,
    prepared: Exclude<PreparedDelivery, { kind: "turn" }>,
  ): boolean {
    if (prepared.kind === "rejected") {
      this.markRejected(row.message_id, prepared.reason);
      return false;
    }
    let handled = false;
    try {
      handled = endpoint.runBuiltinCommand?.(prepared.name, prepared.args) === true;
    } catch (error) {
      // A stale host context refuses the command: reject this row only.
      this.markRejected(row.message_id, deliveryFailedReason(error));
      return false;
    }
    if (handled) {
      this.markDelivered(row.message_id);
    } else {
      this.markRejected(row.message_id, "target session does not support built-in commands");
    }
    return handled;
  }

  /**
   * An endpoint's idle report. A stale host context throws instead of reporting,
   * so an unknown state counts as `running` (session-store.md Section 2): no
   * caller throws either way.
   */
  private endpointIsIdle(endpoint: FleetEndpoint): boolean {
    try {
      return endpoint.isIdle();
    } catch {
      return false;
    }
  }

  /**
   * Resolve what a send row delivers: an injectable turn text, a built-in
   * command for the caller to apply, or a terminal rejection. Pure — built-ins
   * are applied by the caller at the right point of the delivery flow (spec 3.2
   * idle gating). Plugin commands render here, at delivery, against this
   * coordinator's plugin catalog (the target's, per Section 3.2).
   */
  private prepareDelivery(row: StoredMessageRow): PreparedDelivery {
    if (row.deliver_text !== null) return { kind: "turn", text: row.deliver_text };
    const check = this.validateBodyCommand(row.body);
    if (check.kind === "builtin") return { kind: "builtin", name: check.name, args: check.args };
    if (check.kind === "rejected") return { kind: "rejected", reason: check.reason };
    return { kind: "turn", text: check.rendered };
  }

  /** Inject one turn text; sync throws and promise rejections fail the message. */
  private injectTurn(
    endpoint: FleetEndpoint,
    row: StoredMessageRow,
    mode: FleetDeliverMode,
    text: string,
  ): void {
    // A re-entrant drain (the host pumping its own queue from inside `deliverTurn`)
    // must not inject the same row twice (session-store.md Section 5).
    if (this.inFlightMessages.has(row.message_id)) return;
    let outcome: void | Promise<void>;
    try {
      this.inFlightMessages.add(row.message_id);
      outcome = endpoint.deliverTurn(text, mode);
    } catch (error) {
      this.inFlightMessages.delete(row.message_id);
      this.failDelivery(endpoint.sessionId, row, mode, error);
      return;
    }
    if (isPromiseLike(outcome)) {
      void Promise.resolve(outcome).then(
        () => {
          this.inFlightMessages.delete(row.message_id);
          this.markDelivered(row.message_id);
        },
        (error) => {
          this.inFlightMessages.delete(row.message_id);
          this.failDelivery(endpoint.sessionId, row, mode, error);
        },
      );
    } else {
      this.inFlightMessages.delete(row.message_id);
      this.markDelivered(row.message_id);
    }
  }

  /** A delivery attempt failed: release the followUp lock and reject the message terminally. */
  private failDelivery(
    targetSessionId: string,
    row: StoredMessageRow,
    mode: FleetDeliverMode,
    error: unknown,
  ): void {
    if (mode === "followUp") {
      this.deliveringFollowUp.delete(targetSessionId);
      this.writeState(targetSessionId, "idle");
    }
    this.markRejected(row.message_id, deliveryFailedReason(error));
  }

  /**
   * Write a session's `state`. A child session record's stays `running` for its
   * life (session-store.md, Section 4).
   */
  private writeState(sessionId: string, state: FleetSessionState): void {
    if (this.childEndpoints.has(sessionId)) return;
    this.db
      .prepare("UPDATE fleet_sessions SET state = ?, updated_at = ? WHERE session_id = ?")
      .run(state, Date.now(), sessionId);
  }

  private deliverQueryRow(endpoint: FleetEndpoint, row: StoredMessageRow): void {
    if (!endpoint.runQuery) {
      this.markRejected(row.message_id, "target session does not support queries");
      return;
    }
    if (!this.markDelivered(row.message_id)) return;
    const correlationId = row.correlation_id ?? `q-${row.message_id}`;
    let inFlight = this.inFlightQueries.get(endpoint.sessionId);
    if (!inFlight) {
      inFlight = new Set();
      this.inFlightQueries.set(endpoint.sessionId, inFlight);
    }
    const queryHandle = {
      correlationId,
      row,
      endpoint,
      replied: false,
    };
    inFlight.add(queryHandle);

    // Exactly one reply (fleet-tool.md Section 4): settle the dispatch through
    // the two-argument `then` so a failure is never routed into both reply
    // paths, and swallow any throw from the reply itself — a failed reply is
    // spent, never retried as a second reply.
    const reply = (text: string): void => {
      if (queryHandle.replied) return;
      queryHandle.replied = true;
      inFlight.delete(queryHandle);
      if (inFlight.size === 0) {
        this.inFlightQueries.delete(endpoint.sessionId);
      }
      try {
        this.replyToSender(endpoint, correlationId, row, text);
      } catch (error) {
        // The reply itself failed; never rethrow into the failure reply, and
        // never retry it: the target's user learns instead (fleet-tool.md, Section 4).
        this.reportReplyFailure(endpoint, row, error);
      }
    };
    const runQuery = endpoint.runQuery;
    let dispatch: Promise<{ text: string; isError: boolean }>;
    try {
      dispatch = runQuery({
        correlationId,
        senderSessionId: row.sender_session_id,
        subject: row.subject ?? undefined,
        body: row.body,
      });
    } catch (error) {
      // A stale host context throws instead of rejecting: the querier still
      // gets its one reply, with the same text (fleet-tool.md Section 4).
      reply(`Query error: ${errorMessage(error)}`);
      return;
    }
    void dispatch.then(
      (settled) => reply(settled.text),
      (error: unknown) => reply(`Query error: ${errorMessage(error)}`),
    );
  }

  private replyToSender(
    endpoint: FleetEndpoint,
    correlationId: string,
    row: StoredMessageRow,
    text: string,
  ): void {
    if (this.closed) return;
    // A waiting child session has no endpoint, only a hidden record.
    const senderRecord = this.getSessionIncludingHidden(row.sender_session_id);
    if (!senderRecord) return;
    this.enqueueSend({
      senderSessionId: endpoint.sessionId,
      target: senderRecord,
      subject: row.subject ? `Re: ${row.subject}` : `Query reply ${correlationId}`,
      body: `[Fleet query reply correlationId=${correlationId}]\n${text}`,
      deliver: "followUp",
      abort: false,
      bootId: row.boot_id,
    });
  }

  private validateBodyCommand(
    body: string,
  ):
    | { kind: "plugin"; rendered: string }
    | { kind: "builtin"; name: string; args: string }
    | { kind: "rejected"; reason: string } {
    // The command token ends at the first U+0020 space (slash-commands.md Section 1).
    const firstSpace = body.indexOf(" ");
    const token = (firstSpace === -1 ? body.slice(1) : body.slice(1, firstSpace)).trim();
    const args = firstSpace === -1 ? "" : body.slice(firstSpace + 1).trim();
    if (token === "") {
      return { kind: "rejected", reason: 'empty slash command "/"' };
    }
    const colon = token.indexOf(":");
    if (colon !== -1) {
      const namespace = token.slice(0, colon);
      const cmdName = token.slice(colon + 1);
      const plugin = this.boot.pluginIndex.get(namespace);
      const cmd = plugin?.commands.find((c) => c.name === cmdName);
      if (!plugin || !cmd) {
        return { kind: "rejected", reason: `unknown plugin slash command "/${token}"` };
      }
      try {
        const rendered = renderPluginCommand(plugin.root, cmd.name, args);
        return { kind: "plugin", rendered };
      } catch (error) {
        return { kind: "rejected", reason: `failed to render "/${token}": ${errorMessage(error)}` };
      }
    }
    if (BUILTIN_COMMANDS.has(token)) {
      return { kind: "builtin", name: token, args };
    }
    return { kind: "rejected", reason: `unsupported slash command "/${token}"` };
  }

  private formatEnvelope(
    senderSessionId: string,
    subject: string | null | undefined,
    body: string,
  ): string {
    const header = subject
      ? `[Fleet from ${senderSessionId} — ${subject}]`
      : `[Fleet from ${senderSessionId}]`;
    return `${header}\n${body}`;
  }

  private markDelivered(messageId: number): boolean {
    const res = this.db
      .prepare(
        "UPDATE fleet_messages SET status = 'delivered', delivered_at = ? WHERE message_id = ? AND status = 'pending'",
      )
      .run(Date.now(), messageId);
    return Number(res.changes) > 0;
  }

  private markRejected(messageId: number, reason: string): boolean {
    const res = this.db
      .prepare(
        "UPDATE fleet_messages SET status = 'rejected', rejection_reason = ? WHERE message_id = ? AND status = 'pending'",
      )
      .run(reason, messageId);
    return Number(res.changes) > 0;
  }

  /** Delete a session record and reject every message still queued for it (session-store.md, Section 4). */
  private deleteSession(sessionId: string, reason: string): void {
    this.db.prepare("DELETE FROM fleet_sessions WHERE session_id = ?").run(sessionId);
    this.deadLetterPending(sessionId, reason);
  }

  /**
   * Delete only the record a read found, and reject its pending messages with it,
   * in one immediate transaction (session-store.md, Section 4). A record another
   * boot window registered as its own after that read matches neither condition,
   * so it and its messages are left alone; true when the row was deleted.
   */
  private deleteIfUnchanged(
    sql: string,
    params: (string | number | null)[],
    sessionId: string,
  ): boolean {
    if (this.closed) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const deleted = Number(this.db.prepare(sql).run(...params).changes) > 0;
      if (deleted) this.deadLetterPending(sessionId, "target session ended before delivery");
      this.db.exec("COMMIT");
      return deleted;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Transaction already gone.
      }
      throw error;
    }
  }

  /** Terminally reject every message still queued for a session that can no longer consume them. */
  private deadLetterPending(sessionId: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE fleet_messages SET status = 'rejected', rejection_reason = ? WHERE target_session_id = ? AND status = 'pending'",
      )
      .run(reason, sessionId);
  }

  private getMessageById(messageId: number): StoredMessageRow | undefined {
    const row = this.db.prepare("SELECT * FROM fleet_messages WHERE message_id = ?").get(messageId);
    return row ? toMessageRow(row) : undefined;
  }

  private targetStateOf(session: FleetSessionRecord): FleetTargetState {
    const endpoint = this.endpoints.get(session.sessionId);
    if (endpoint) {
      // A delivered followUp still awaiting its turn start makes the session
      // running, as its record and the listing read it (session-store.md, Section 2).
      return !this.endpointIsIdle(endpoint) || this.deliveringFollowUp.has(session.sessionId)
        ? "running"
        : "idle";
    }
    // No local endpoint: report the record's own state (fleet-tool.md Section 3.1).
    return session.state;
  }

  /** True when the session's owning boot window verifiably no longer exists. */
  private ownerIsGone(session: {
    ownerPid: number;
    ownerBoot?: string | undefined;
    ownerStarted: number;
  }): boolean {
    if (session.ownerBoot === this.bootId) return false; // owned by this live coordinator
    if (session.ownerPid === process.pid) {
      // Same pid: a boot window of this process (live, or released without a
      // session_shutdown), or a recycled pid from before this process started.
      if (session.ownerBoot !== undefined) return !liveBootWindows.has(session.ownerBoot);
      return session.ownerStarted < PROCESS_STARTED_MS - 1000;
    }
    return !isPidAlive(session.ownerPid);
  }

  /** True when the record is not this boot window's and its owner process is gone. */
  private isGone(session: FleetSessionRecord): boolean {
    return this.endpointFor(session.sessionId) === undefined && this.ownerIsGone(session);
  }

  /**
   * Delete a record whose owner process is gone, rejecting its pending messages.
   * True when the row was deleted: false when it was not gone, or when a later
   * registration replaced it, whose session the caller may then treat as live.
   */
  private reapIfGone(session: FleetSessionRecord): boolean {
    if (!this.isGone(session)) return false;
    // Only the record that was read: a session that re-registered since the
    // sweep's snapshot keeps its record and its queued messages (session-store.md, Section 4).
    return this.deleteIfUnchanged(
      "DELETE FROM fleet_sessions WHERE session_id = ? AND owner_pid IS ? AND owner_boot IS ? AND owner_started IS ?",
      [session.sessionId, session.ownerPid, session.ownerBoot ?? null, session.ownerStarted],
      session.sessionId,
    );
  }

  /**
   * Delete sessions whose owner is verifiably gone (dead process, recycled pid,
   * or our own previous boot window) and dead-letter their queues. Liveness is
   * owner liveness, never a quiet-time TTL.
   */
  private sweepDeadOwners(): void {
    if (this.closed) return;
    const rows = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM fleet_sessions`).all();
    for (const row of rows) {
      this.reapIfGone(this.hydrateSession(row));
    }
  }

  /**
   * The agent directories of live sessions: records whose owner process is not
   * gone (agent-tool.md Section 10). Undefined when the store cannot be read or
   * a live record has no recorded directory — the caller must then delete nothing.
   */
  liveAgentDirs(): string[] | undefined {
    if (this.closed) return undefined;
    try {
      const dirs: string[] = [];
      for (const row of this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM fleet_sessions`).all()) {
        const session = this.hydrateSession(row);
        // A hidden record has no agent directory and is not a live session; it
        // must not disable the sweep (session-store.md Section 4).
        if (session.hidden) continue;
        if (this.isGone(session)) continue;
        if (!session.agentsDir) return undefined;
        dirs.push(session.agentsDir);
      }
      return dirs;
    } catch {
      return undefined;
    }
  }

  private hydrateSession(row: Record<string, SQLOutputValue>): FleetSessionRecord {
    const sessionId = typeof row.session_id === "string" ? row.session_id : "";
    const cwd = typeof row.cwd === "string" ? row.cwd : "";
    const repoRoot = typeof row.repo_root === "string" ? row.repo_root : undefined;
    const rawTurns = typeof row.turns_json === "string" ? row.turns_json : "[]";
    let turns: FleetTurnRecord[] = [];
    try {
      const parsed = JSON.parse(rawTurns);
      if (Array.isArray(parsed)) {
        turns = parsed
          .filter((item): item is Record<string, unknown> => isPlainObject(item))
          .flatMap((item): FleetTurnRecord[] =>
            typeof item.startedAt === "number"
              ? [
                  {
                    command: typeof item.command === "string" ? item.command : "",
                    goal: typeof item.goal === "string" ? item.goal : "",
                    files: Array.isArray(item.files)
                      ? item.files.filter((f): f is string => typeof f === "string")
                      : [],
                    startedAt: item.startedAt,
                  },
                ]
              : [],
          );
      }
    } catch {
      turns = [];
    }
    const endpoint = this.endpoints.get(sessionId);
    const parentSessionId =
      typeof row.parent_session_id === "string" ? row.parent_session_id : undefined;
    // A hidden record and a child session record stay `running` for their life
    // (specs/session-store.md, Section 4).
    const state: FleetSessionState =
      row.hidden === 1 || parentSessionId !== undefined
        ? "running"
        : endpoint
          ? !this.endpointIsIdle(endpoint) || this.deliveringFollowUp.has(sessionId)
            ? "running"
            : "idle"
          : row.state === "running"
            ? "running"
            : "idle";
    return {
      sessionId,
      cwd,
      repoRoot,
      state,
      updatedAt: typeof row.updated_at === "number" ? row.updated_at : 0,
      turns,
      ownerPid: integerColumn(row, "owner_pid"),
      ownerBoot: typeof row.owner_boot === "string" ? row.owner_boot : undefined,
      ownerStarted: integerColumn(row, "owner_started"),
      agentsDir: typeof row.agents_dir === "string" ? row.agents_dir : undefined,
      hidden: row.hidden === 1,
      parentSessionId,
    };
  }

  /**
   * Record each owned session's condition as its `state`, so other boot windows
   * see a run no user message started and a compaction outside a turn
   * (specs/session-store.md Section 2).
   */
  private syncStates(): void {
    for (const [sessionId, endpoint] of this.endpoints) {
      const state: FleetSessionState =
        !this.endpointIsIdle(endpoint) || this.deliveringFollowUp.has(sessionId)
          ? "running"
          : "idle";
      const row = this.db
        .prepare("SELECT state FROM fleet_sessions WHERE session_id = ?")
        .get(sessionId);
      if (!row || row.state === state) continue;
      this.db
        .prepare("UPDATE fleet_sessions SET state = ?, updated_at = ? WHERE session_id = ?")
        .run(state, Date.now(), sessionId);
    }
  }

  private ensurePollLoop(): void {
    if (this.pollTimer || this.closed) return;
    this.pollTimer = setInterval(() => {
      this.runPollTick();
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  /**
   * One poll tick. A tick never throws, and a failing step or endpoint never
   * stops the rest of the tick (session-store.md Section 5).
   */
  private runPollTick(): void {
    if (this.closed) return;
    this.pollStep(() => {
      this.syncStates();
    });
    this.pollStep(() => {
      this.drainPending();
    });
    this.pollStep(() => {
      this.checkWaiterFailures();
    });
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    this.pollStep(() => {
      this.sweepDeadOwners();
    });
  }

  private pollStep(run: () => void): void {
    try {
      run();
    } catch {
      // The next tick retries it; a periodic pass reports no failure
      // (session-store.md, Section 5).
    }
  }

  /**
   * Stop the poll loop only when this boot window has nothing left to poll for:
   * no registered session, no child session and no outstanding waited query
   * (Section 4.1).
   */
  private stopPollLoopIfIdle(): void {
    if (this.endpoints.size > 0 || this.childEndpoints.size > 0 || this.queryWaiters.size > 0)
      return;
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}

/**
 * A listed session's kind, relative to the listing process: `instance` when
 * this process owns it, else `machine` (specs/fleet-tool.md Section 2).
 */
export function fleetSessionKind(session: FleetSessionRecord): "instance" | "machine" {
  return session.ownerPid === process.pid ? "instance" : "machine";
}

/** The `json` list's `<session>` object of one session (specs/fleet-tool.md Section 2). */
export function fleetListSession(s: FleetSessionRecord): {
  sessionId: string;
  kind: "instance" | "machine";
  state: FleetSessionState;
  cwd: string;
  repoRoot?: string;
  parent?: string;
  turns: FleetTurnRecord[];
} {
  return {
    sessionId: s.sessionId,
    kind: fleetSessionKind(s),
    state: s.state,
    cwd: s.cwd,
    ...(s.repoRoot === undefined ? {} : { repoRoot: s.repoRoot }),
    // A child session names the session that spawned it (fleet-tool.md Section 2).
    ...(s.parentSessionId === undefined ? {} : { parent: s.parentSessionId }),
    turns: s.turns,
  };
}

export function formatFleetList(
  sessions: readonly FleetSessionRecord[],
  scope: FleetScope,
  format: FleetListFormat | undefined,
): string {
  const caveat = "(Discovery snapshot — local machine only; carries no authoritative session age.)";
  if (format === "json") {
    return JSON.stringify(
      {
        scope,
        snapshot: true,
        sessions: sessions.map(fleetListSession),
      },
      null,
      2,
    );
  }
  if (sessions.length === 0) {
    return `(no active sessions in ${scope} scope)\n${caveat}`;
  }
  if (format === "full") {
    const blocks = sessions.map((s) => {
      const header = `${s.sessionId} [${s.state}] kind=${fleetSessionKind(s)} cwd=${s.cwd}`;
      if (s.turns.length === 0) return `${header}\n  (no turns recorded)`;
      const turnLines = s.turns.map((t, idx) => {
        const files = t.files.length > 0 ? t.files.join(", ") : "(none)";
        return `  turn ${idx + 1}: command=${JSON.stringify(t.command)} goal=${JSON.stringify(t.goal)} files=${files}`;
      });
      return [header, ...turnLines].join("\n");
    });
    return [...blocks, caveat].join("\n\n");
  }
  // Default format: compact (specs/fleet-tool.md Section 2).
  const lines = sessions.map(formatFleetCompactLine);
  return [...lines, caveat].join("\n");
}

/** The `compact` line of one session (specs/fleet-tool.md Section 2). */
export function formatFleetCompactLine(session: FleetSessionRecord): string {
  const last = session.turns[session.turns.length - 1];
  const summary = last?.goal || last?.command || "(no turns yet)";
  return `${session.sessionId} · ${fleetSessionKind(session)} · ${session.state} · ${session.cwd} · ${summary}`;
}

export function extractChangedFiles(
  toolName: string,
  input: unknown,
  details: unknown,
  isError: boolean,
): string[] {
  if (isError) return [];
  const lower = toolName.toLowerCase();
  const out: string[] = [];
  if (isPlainObject(input)) {
    if (lower === "edit" || lower === "write") {
      const p =
        typeof input.path === "string"
          ? input.path
          : typeof input.file_path === "string"
            ? input.file_path
            : undefined;
      if (p) out.push(p);
    }
  }
  if (lower === "apply_patch") {
    if (isPlainObject(details) && Array.isArray(details.files)) {
      for (const item of details.files) {
        if (isPlainObject(item)) {
          if (typeof item.path === "string") out.push(item.path);
          if (typeof item.moveTo === "string") out.push(item.moveTo);
        }
      }
    }
  }
  return out;
}
