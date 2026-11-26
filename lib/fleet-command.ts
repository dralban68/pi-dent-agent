import { type FleetCoordinator, type FleetSessionRecord, formatFleetCompactLine } from "./fleet.ts";
import { errorMessage } from "./util.ts";

/**
 * `/fleet` command logic (specs/slash-commands.md#fleet): list the
 * machine's sibling sessions and query one, either through a `select` +
 * `input` dialog or as `<target> <query>`. Never adds a conversation message
 * or starts a turn; the query reply arrives as a followUp message.
 */

export interface FleetCommandUI {
  /** `ctx.hasUI && ctx.mode === "tui"`: dialogs are only opened with an interactive TUI. */
  interactive: boolean;
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "error"): void;
}

export interface FleetCommandDeps {
  fleet: FleetCoordinator;
  /** The invoking session: excluded from the siblings and the query sender. */
  sessionId: string;
  cwd: string;
  ui: FleetCommandUI;
}

export async function runFleetCommand(args: string, deps: FleetCommandDeps): Promise<void> {
  // The command refuses exactly the caller a `Fleet` call from it refuses: a
  // session with no live session identity in this boot window
  // (specs/session-store.md#membership-lifecycle; specs/fleet-tool.md#parameter-schema;
  // specs/slash-commands.md#fleet). A record this window does not own —
  // another live window's, or one released by a reload — is refused; a child
  // session is not.
  if (deps.fleet.classifyCaller(deps.sessionId) === "foreign") return;
  const trimmed = args.trim();
  if (trimmed === "") {
    await pickAndQuery(deps);
    return;
  }
  const space = trimmed.search(/\s/);
  const target = space === -1 ? trimmed : trimmed.slice(0, space);
  const query = space === -1 ? "" : trimmed.slice(space).trim();
  if (query === "") {
    deps.ui.notify("Usage: /fleet [<target> <query>]", "error");
    return;
  }
  const resolved = deps.fleet.resolveRecipient(target, deps.sessionId);
  if ("error" in resolved) {
    deps.ui.notify(resolved.error, "error");
    return;
  }
  querySession(deps, resolved.session, query);
}

async function pickAndQuery(deps: FleetCommandDeps): Promise<void> {
  const { ui } = deps;
  if (!ui.interactive) return;
  const siblings = deps.fleet
    .listSessions("machine", deps.cwd)
    .filter((session) => session.sessionId !== deps.sessionId);
  if (siblings.length === 0) {
    ui.notify("No sibling sessions.", "info");
    return;
  }
  const options = siblings.map(formatFleetCompactLine);
  const choice = await ui.select(`Fleet · ${siblings.length} sessions`, options);
  const index = choice === undefined ? -1 : options.indexOf(choice);
  if (index === -1) return;
  const session = siblings[index];
  if (!session) return;
  const entry = await ui.input(`Query ${session.sessionId}`);
  const query = entry?.trim() ?? "";
  if (query === "") return;
  querySession(deps, session, query);
}

function querySession(deps: FleetCommandDeps, session: FleetSessionRecord, body: string): void {
  try {
    const queued = deps.fleet.enqueueQuery({
      senderSessionId: deps.sessionId,
      target: session,
      body,
    });
    deps.ui.notify(`Fleet query ${queued.messageId} enqueued to ${queued.target}.`, "info");
  } catch (error) {
    deps.ui.notify(errorMessage(error), "error");
  }
}
