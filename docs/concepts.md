# Concepts: how they relate

This document is non-normative: a map of how pi-dent's core concepts connect. The specifications in
[specs/](../specs/) decide; where this map and a spec differ, the spec is right. Term meanings
are in the term registry, [.pi/pi-dent/terms.yaml](../.pi/pi-dent/terms.yaml).

## Tools and what they touch

- Start a task: `Agent` (through a dispatch), `Script`, `Bash`. They share the `cwd` parameter.
- `Bash` and `Script` name the session temporary folder, `PI_DENT_SESSION_DIR/tmp`, in `TMPDIR`,
  `TMP`, and `TEMP`.
- Observe and cancel tasks: `Task`, on the invoking session's own task registry only; the task
  browser shows the whole task tree and its kill key cancels the task whose details page is open,
  in whichever registry of the tree holds it, delivered to the model as that task's settlement.
- Reach another session: `Fleet`. Reach the same session later: `Schedule` (main session only; a
  schedule is neither a task nor a `Fleet` message, and it outlives a reload but not its session).
- Read what the boot snapshot cataloged: `Skill` (skill catalog), `Plugin` (plugin catalog).
- Report on the invoking session, its models, and billing: `Session`.
- Ask the user mid-turn and wait for the answers: `AskUserQuestion` (main session only: a panel
  in the terminal, host dialogs in RPC mode, not offered to the model without a user interface;
  a question is not a task, and a child session never binds it).
- Look back at what was said and done: `Search`, over the invoking session's session tree — its
  own session file and those of the child sessions beneath it — and, for a main session on
  request, the other sessions of its project. It changes nothing but the session index.
- Navigate and restructure a Markdown file by its sections: `Markdown`, beside the host's `read`,
  `edit`, and `write`. Its edits join the host's per-file mutation queue, need the file's
  revision from an earlier `Markdown` result, and keep numbered headings in sequence.
- Invoking session: the session whose model made a tool call ([task.md, host terms](../specs/task.md#host-terms)).
- Tool-call signal: the abort signal the host passes to one tool execution.
- Tool error: a tool result with `isError` `true`.

Specs: one `<name>-tool.md` per tool; shared rules in [task.md, task kinds](../specs/task.md#task-kinds).

## Host, boot, and configuration

```text
host (pi) ── boot (process start or reload) ── opens ──> boot window
└─ boot snapshot (one per boot window, shared by every consumer in it)
   ├─ configuration   = global layer merged with project layer
   ├─ plugin catalog  <─ configuration
   ├─ agent catalog   <─ agent definitions of the layer directories and of plugins
   └─ skill catalog   <─ skills of the layer directories and of plugins
```

- A boot window is bounded by boots, not by sessions: a reload keeps the session and replaces the
  boot window, and one boot window can serve several sessions.
- An extension instance is a separate unit: a reload starts a new one, and so does replacing the
  session ([billing.md, extension instance and held billing](../specs/billing.md#held-billing)).

Specs: [config-file.md, layers](../specs/config-file.md#layers), [config-file.md, merge](../specs/config-file.md#merge), [config-file.md, snapshot](../specs/config-file.md#snapshot), and [config-file.md, diagnostics](../specs/config-file.md#diagnostics).

## Models

```text
model string ─┬─ concrete selector ───────────────────────────┬─> inventory match ─> descriptor
              └─ class reference ─> model class (configured) ─┘
                                    a miss ─> `fallback` class, when defined
```

- The configured models are the inventory's authenticated subset, reported by the model runtime.
- Model guidance, computed against a model list, gives the guided models. Against the inventory
  it restricts which models a dispatch can use; against the configured models it feeds the
  model catalog (the `Agent` tool description and `Session`), the billing lines of the guidance
  message (main session), and the child guidance (child session).
- A model entry is one value of the `models` record of model guidance; a guided model is a model
  entry whose key names a model of the list.
- Session rules are the guidance rules whose `match` matches the session's model; they go into the
  guidance message (main session) or the child's system prompt (child session).

Specs: [model-string.md, resolution](../specs/model-string.md#resolution);
[model-guidance.md, guided models](../specs/model-guidance.md#guided-models), [model-guidance.md, dispatch restriction](../specs/model-guidance.md#dispatch-restriction), [model-guidance.md, session rules](../specs/model-guidance.md#session-rules), [model-guidance.md, guidance message](../specs/model-guidance.md#guidance-message), [model-guidance.md, model catalog](../specs/model-guidance.md#model-catalog).

## Dispatch and sessions

```text
dispatch (one `Agent` call of the dispatching session, itself a main session or a child session)
├─ its agent: static dispatch ─> agent definition, by key from the agent catalog
│             dynamic dispatch ─> the call's prompt, no definition
├─ dispatch plan (resolved once, then frozen; every attempt uses it)
└─ child session (in-process, one session file)
   └─ attempt, then recovery attempts in the same child session ──> final answer ──> caller
```

- The tool cap is the dispatching session's; the child binds the effective tool cap, a subset.
  Child extensions come from file and built-in extension sources in the parent's configured tool
  inventory; pi-dent itself stays in-process rather than loading its entry extension again
  ([agent-tool.md, tools](../specs/agent-tool.md#tools)). The child's model runtime gets the dispatching session's extension
  providers as copies, not by loading their extensions ([agent-tool.md, child session](../specs/agent-tool.md#child-session)).
- Recovery re-prompts inside one dispatch. `resume` is a new dispatch that continues a retained
  session file, named by path or by task ID.
- Every session is either a user session (a main session with a user interface: terminal or RPC
  mode) or an agent session (a child session, or a main session without a user interface: print or
  JSON mode). User sessions have user input available; agent sessions do not.
- Every session has an agent directory. It holds the session files of the session's children,
  and so their agent directories, recursively; it also holds task records, result spills, output
  files. Only the retention sweep removes one, whole, and never one that a live
  session's record in the local session store protects.

- The session files reachable this way form the session tree. A session file's entries yield
  transcript items, each with an item address; the entries the session last continued are its
  current lineage. The other session files in a main session's sessions directory are its project
  members, each the root of a session tree of its own.
- A tool-call ID pairs a `tool_call` transcript item with its `tool_result` item.
- The session index is a second shared database beside the local session store: derived from
  session files, brought up to a file by a catch-up that reads only the appended bytes, and
  cleared of deleted files by the index prune after the retention sweep. A `Search` call takes a
  session's entries from the index once its catch-up is complete, and otherwise reads the file.
- The consumed bytes of a session file are the leading bytes that the index has read and describes.

Specs: [agent-tool.md, dispatch plan](../specs/agent-tool.md#dispatch-plan), [agent-tool.md, child session](../specs/agent-tool.md#child-session), [agent-tool.md, recovery](../specs/agent-tool.md#recovery), [agent-tool.md, continuation (`resume`)](../specs/agent-tool.md#resume), and [agent-tool.md, retention sweep](../specs/agent-tool.md#retention-sweep);
[agent.md](../specs/agent.md); [session-tool.md, session kind](../specs/session-tool.md#session-kind);
[session-transcript.md](../specs/session-transcript.md);
[session-index.md](../specs/session-index.md); [search-tool.md, scope](../specs/search-tool.md#scope).

## Tasks and the task registry

```text
session (main or child)
└─ task registry (one live at a time; in memory)
   ├─ task row, kind agent ── children ──> task registry of the current attempt's child session
   │                                       └─ task rows … (recursively)
   ├─ task row, kind script
   └─ task row, kind bash
```

- One task is one task row, identified by its task ID, in one task registry at a time. The task
  tree is the diagram read as a tree: the task tree widget shows its running and interrupted
  part, the task browser all of it and one task's details.
- A schema rejection is the host's and registers no task row; a pre-start rejection is the tool's
  and leaves a task row that settled as failed.
- Foreground delivery returns the result in the tool call. Background delivery returns a task ID;
  the tasks of one assistant message form a cohort, which gets a completion notification.
- A running task row carries a progress projection, read by `Task` and the task browser. A
  settled row can point at a file: a result spill (`Agent`) or an output file (`Script`, `Bash`).
- When a task registry ends (with its attempt, its session, or a reload), running and unconsumed
  rows move by adoption to the nearest live attaching task registry, each marked `orphan`.
- Task registries do not survive a reload; a task record does. A background `agent` task has one,
  and at the main session's start a rebuild turns task records back into task rows. One still
  running becomes an interrupted task, which `Agent` `resume` can continue.
- The task ledger is a third shared database, beside the local session store and the session
  index, and the only one that is a permanent history: one ledger row per task row of every kind,
  linked to its parent row (the dispatch whose child session, or the `Script` run whose nested
  call, registered it), and one ledger session row per main session for the session's own usage.
  Both kinds of row also count tool calls beside the usage; a `bash` row has no count.
  Totals are summed from the rows when read. It seeds the usage tally at `session_start`, and
  `Task` `list` and `Session` show its figures. Unlike a task record, it serves neither rebuild
  nor `resume`, and nothing deletes its rows.
- The browser stack is the open full-screen browsers, newest on top; the task browser is one of
  them, and only the top one takes keys.
- The task browser's list page lists the task tree; `enter` opens the details page of the selected
  row, which renders that row.
- The events on an `agent` row's details page are its session events, each derived from one content
  block of a session entry.
- The watched task is the one task that the `tasks` command names; its details page is the one the
  task detail feed carries.

Specs: [task.md, task kinds](../specs/task.md#task-kinds), [task.md, lifecycle](../specs/task.md#lifecycle), [task.md, task tree](../specs/task.md#task-tree); [task-registry.md, ownership](../specs/task-registry.md#ownership) and [task-registry.md, registry end and adoption](../specs/task-registry.md#registry-end), [task-registry.md, cohorts and completion notification](../specs/task-registry.md#cohorts), [task-registry.md, nesting](../specs/task-registry.md#nesting); [task-record.md](../specs/task-record.md);
[task-ledger.md](../specs/task-ledger.md);
[task-tool.md](../specs/task-tool.md); [task-browser.md](../specs/task-browser.md).

## Fleet and the local session store

```text
pi-dent process A                   local session store                   pi-dent process B
main session ── registers ──> session records, messages <── registers ── main session
   └─ `Fleet` send or query ──> message ──> delivered by the boot window that owns the target
```

- The fleet is the main sessions with a non-hidden record. The process of the boot window that registered a
  record is its owner process; the session is a live session while that process is not gone, and
  it has a live session identity only in that boot window.
- A target is a live session of the fleet, or — for the session that spawned it — a live child
  session; the delivery mode decides whether a message waits for the target to be idle.
- A query makes the target the dispatching session of a dynamic dispatch, whose task row sits in
  a task registry of its own, outside every task tree. When the dispatch settles, the target
  sends one reply to the querying session, as an ordinary message.
- A child session is not a fleet session, and while its dispatch runs it is a live child session:
  its parent lists it (`children` scope), sends to it, and queries it. It can send, and its query
  is a waited query: the tool call returns the reply, addressed through its child session record
  (or a hidden record when it has none).
- A turn is a user message that arrives while none is in progress, the user messages that join
  it, and the agent run that follows; it ends when that agent run ends. A turn record is one
  entry of a session record's `turns_json`, the latest five.
- A model turn is one request to the model and the tool calls it leads to; an agent run, and so a
  turn, holds one or more.
- An agent run is one host agent loop, from a prompt until the agent is idle.

Specs: [fleet-tool.md, parameter schema](../specs/fleet-tool.md#parameter-schema), [fleet-tool.md, action `send`](../specs/fleet-tool.md#send), and [fleet-tool.md, action `query`](../specs/fleet-tool.md#query);
[session-store.md, membership and lifecycle](../specs/session-store.md#membership-lifecycle) and [session-store.md, delivery](../specs/session-store.md#delivery).

## Billing

```text
billing service ── billing reply ──> held billing (per extension instance)
   ^   ^                             ├─> guidance billing text = billing annotations + billing note
   │   └─ billing poll               │   └─> guidance message, child guidance
   └───── report query (`Session`)   └─> billing report ──> `Session` result
```

- Billing hangs on model guidance: a billing annotation ends a guided model's `Model billing:`
  line in the guidance message, and the model guidance configuration can switch billing off.
- A child session uses the held billing of the main session's extension instance.

Specs: [billing.md, billing providers and mapping](../specs/billing.md#providers), [billing.md, queries](../specs/billing.md#queries), [billing.md, guidance billing text](../specs/billing.md#guidance-billing), and [billing.md, billing report](../specs/billing.md#billing-report).

## Plugins, skills, and commands

```text
configuration ── names ──> plugin (directory + plugin manifest ─> namespace) ──> plugin catalog
plugin
├─ plugin resources
│  ├─ plugin command ───> slash command under the namespace
│  ├─ agent definition ─> agent catalog, keyed under the namespace
│  ├─ skill ────────────> skill catalog, keyed under the namespace
│  └─ skill reference ──> no catalog; loaded through `Skill`
├─ plugin context (root `context.md`, not a resource) ──> appended to system prompts
└─ plugin scripts (not plugin resources) ──> run by `Script`
```

- Layer directories feed the same two catalogs under bare names; the two key spaces are disjoint.
- The plugin root is the plugin's directory, the resolved `path` of its `plugins` entry; every plugin
  file lies inside it.
- Plugin admission order is the order of admitted plugins by their `plugins` key; it orders plugin
  skills and other plugin contributions.
- A skill's body is the `SKILL.md` text after its frontmatter, which `Skill` returns.
- Catalogs are fixed for the boot window, but not every file is: which reads come from the boot
  snapshot and which are fresh is in [plugin.md, plugin catalog](../specs/plugin.md#plugin-catalog).
- A slash command is a host command, an extension command (pi-dent's own), or a plugin command.
- The plugin inventory is the same discovery run on request for another program: every plugin
  candidate (a `plugins` entry, admitted or skipped), its resources and plugin scripts, and the
  diagnostics, read from disk at the call and independent of the boot snapshot.

Specs: [plugin.md, plugin layout](../specs/plugin.md#plugin-layout), [plugin.md, slash commands](../specs/plugin.md#slash-commands), [plugin.md, plugin catalog](../specs/plugin.md#plugin-catalog), [plugin.md, catalog composition](../specs/plugin.md#catalog-composition), and [plugin.md, plugin inventory](../specs/plugin.md#plugin-inventory); [skill.md](../specs/skill.md);
[skill-tool.md](../specs/skill-tool.md); [slash-commands.md](../specs/slash-commands.md).
