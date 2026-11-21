# `Agent` tool implementation specification

This document specifies the `Agent` tool: the public tool surface, dispatch-plan resolution,
execution model, results, recovery, continuation, liveness, cancellation, and observation.

## 1. Tool registration surface

The extension MUST register the `Agent` tool through the host `registerTool` API:

| Field         | Value                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | `"Agent"`                                                                                                                                         |
| `label`       | `"Agent"`                                                                                                                                         |
| `renderShell` | `"self"`                                                                                                                                          |
| `description` | Base description text (+ `"\n\nAvailable agents:\n"` + the agent catalog when non-empty) (+ `"\n\nModels:\n"` + the model catalog when non-empty) |
| `parameters`  | The parameter schema of Section 1.1                                                                                                               |

The base description MUST state the dispatch contract: the child session sees only its system
prompt and `task` and returns its final answer; exactly one of a named definition or an inline
`prompt` is given, with `resume` too; a foreground call blocks until the child finishes;
`background: true` returns a task ID with automatic completion notification; `resume` continues
a retained session in place, by its file path or by task ID; and children sharing a working
directory share its files.

The agent catalog MUST be baked once from the boot snapshot and stay unchanged for the boot
window; when non-empty, the agent catalog lists its entries in agent catalog order, each entry
as stated in [agent.md](agent.md), Section 1. When the agent catalog is empty, the
`"Available agents:"` suffix MUST be omitted.

The model catalog is that of the configured models
([model-guidance.md](model-guidance.md), Section 6); when it is empty, the `"Models:"` suffix
MUST be omitted. In the main session, the extension registers `Agent` at load, without a model
runtime, so with an empty model catalog; on each `session_start` it MUST compute the description
against the configured models and, when the result differs from the registered description,
register `Agent` again through `registerTool` with that description and every other field
unchanged, before the handler returns. A child session's `Agent` description is computed once,
when Section 4.2 creates the child session, a `resume` dispatch included; the dispatch's
recovery attempts keep it.

> Note (non-normative): a model entry or authentication change mid-session reaches the
> description at the next `session_start`, such as a reload or a new session.

`renderCall` MUST show the agent identity and the definition's `description` when
present, falling back to `task`. `renderResult` MUST stream intermediate assistant text as
it is produced and replace it with the final result text (Section 7) at settlement. Visual
layout is the renderer's own; only content is normative.

### 1.1 Parameter schema

The parameter schema is a JSON object schema with `type: "object"` and
`additionalProperties: false`:

| Field        | Type              | Contract                                                                                                                                                                                                                 |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`      | string?           | The key of an agent definition in the agent catalog (static dispatch; [agent.md](agent.md)). Exactly one of `agent` or `prompt` MUST be provided.                                                                        |
| `prompt`     | string?           | Inline system prompt defining the agent at call time (dynamic dispatch); exclusive with `agent`.                                                                                                                         |
| `task`       | string (required) | Task instructions; becomes the child's user message.                                                                                                                                                                     |
| `model`      | string?           | Model string ([model-string.md](model-string.md)) selecting the child's model and thinking; the call tier of Section 3.3.                                                                                                |
| `resume`     | string?           | In-place continuation: an absolute path to a retained `Agent` session `.jsonl`, or a task ID naming a task of the invoking session's own task registry (Section 9).                                                      |
| `cwd`        | string?           | Child working directory: the `cwd` parameter ([task.md](task.md), Section 1.1). Default: for a `resume` dispatch, the working directory recorded in the source session file (Section 9), else the dispatching session's. |
| `background` | boolean?          | Background dispatch mode (default `false`).                                                                                                                                                                              |

The schema requires `task`, gives it `minLength: 1`, and gives `agent`, `prompt`, `model`, and
`resume` the `pattern` `\S`: at least one character that is not white space. It constrains the
types of the table and the set of admitted properties, and nothing else; a whitespace-only
`task` is valid.

Validation has two stages. The host validates the call's arguments against the schema of this
section before the dispatch begins, and rejects a call whose arguments do not satisfy it. That
rejection is a schema rejection ([task.md](task.md), Section 1): it registers no task row and
creates no file.

The checks the schema cannot express MUST reject the call as a pre-start rejection (Section 4.1;
`failureCode: "invalid-plan"`), checked in this order, the first failure reported:

- `resume` that is a task ID ([task-registry.md](task-registry.md), Section 2) naming no `agent`
  row of the invoking session's own task registry, or naming a row without `sessionPath`; the
  failure MUST carry the received value (Section 9).
- both `agent` and `prompt`, or neither.
- `agent` that names no entry in the agent catalog; the failure MUST list the available agent
  names in agent catalog order, joined by `", "` (`(none)` when the agent catalog is empty).
- `resume` that is not an absolute path; the failure MUST carry the received value.
- `resume` whose path does not exist or cannot be examined; the failure text MUST name
  `PI_DENT_SESSION_TTL_DAYS` and its effective value in days (Section 10), stating that the
  retention sweep can have deleted the file.
- `resume` whose path exists but is not a regular file; the failure text MUST name the path and
  state that it is not a regular file, and MUST NOT name `PI_DENT_SESSION_TTL_DAYS`.
- `resume` whose real path equals the real path of a session file held by a running dispatch of
  this process (Section 9), so a symbolic link or a `..` segment does not hide a held file.
- The `cwd` check of [task.md](task.md), Section 1.1.

## 2. Agent definitions

A dispatch is static or dynamic. A static dispatch resolves its agent from the agent catalog
([agent.md](agent.md)) by key; the catalog key is the agent identity. A dynamic dispatch
defines its agent entirely by the call's `prompt` parameter and uses no definition; its agent
identity is `dynamic`. The definition resource — file format, discovery, catalog composition, and
the `agents` configuration override — is owned by [agent.md](agent.md).

## 3. Dispatch plan

One dispatch plan MUST be resolved once per invocation, before the child starts, and then frozen;
every attempt uses the same plan. The plan carries: agent identity, resolved cwd, effective tool
cap, skill catalog, resolved model and thinking, system prompt, session policy, the dispatching
session's identity, and its agent directory (Section 4.2).

Plan resolution failures are typed errors carrying `failurePhase: "plan-resolution"` and a
`failureCode` from the plan-resolution codes of Section 7.

### 3.1 Tools

- The tool cap is the authority. Every agent inherits the tool cap; there is no per-agent tool
  declaration.
- The effective tool cap is the tool cap restricted to available pi built-ins, pi-dent's in-process
  tools, and tools contributed by the child extensions loaded below, excluding `Schedule`
  ([schedule-tool.md](schedule-tool.md)), `AskUserQuestion`
  ([ask-user-question-tool.md](ask-user-question-tool.md)), and `bash`. The child MUST bind every
  tool of the effective tool cap, including extension-provided tools and MCP gateways and proxies.
  A tool outside the tool cap or named `Schedule`, `AskUserQuestion`, or `bash` MUST NOT be bound.
  The tool-cap name `bash` is dropped, not read as `Bash`: a child's shell tool is `Bash`
  ([bash-tool.md](bash-tool.md), Section 7), bound only when the tool cap names `Bash`.
- Once the child's extensions are bound and before its first prompt, each tool of the effective
  tool cap that the child session has not registered MUST produce a warning to the dispatching
  session naming the tool, and the dispatch MUST continue. A tool an extension registers after that
  point, such as one behind an MCP connection that was still opening, is allowed: the warning of its
  start is not repeated.
- At dispatch, the engine MUST snapshot the distinct extension sources from the dispatching
  session's complete configured tool inventory, including inactive tools, in inventory order:
  absolute file paths and `builtin:<name>` extension paths. Pi's built-in tool paths (such as
  `builtin:read`) are not extension paths. The child MUST load those extension sources, even when
  its working directory differs, preserving file-source order and built-in-source order within
  their respective groups. It MUST NOT discover additional extensions from its own settings or
  working directory. Built-in extensions MUST be enabled explicitly in the child loader, including
  `builtin:mcp` when it sources a parent tool. Extensions provide their own MCP server registrations
  and configuration when loaded in the child. Before its first prompt, the child MUST run the
  loaded extensions' session-start lifecycle with the child's session context, so tools registered
  during that lifecycle are available under the same tool cap. On completion, cancellation, or
  failure, it MUST invoke their session-shutdown lifecycle before disposing the child session.
  It MUST wait at most 1000 ms for shutdown; on reaching that limit it MUST warn the dispatching
  session that extension shutdown timed out and resources may remain active, then dispose the
  session without waiting further.
- The engine MUST exclude pi-dent's own package code before executing any extension factory:
  its package root and descendants, except dependency sources under its `node_modules/` subtree.
  Paths MUST be compared canonically when available. Dependency packages remain eligible for
  inheritance. Pi-dent's child tools MUST remain the in-process definitions; its entry extension
  MUST NOT run again.
- If an inherited extension source fails to load or reports a lifecycle error, the dispatch MUST
  continue with the remaining extensions and MUST send the dispatching session a warning
  notification naming the source path and error. A requested source that the loader omits without
  an error MUST also produce a warning naming the source and stating that it was not loaded. A
  conflict the loader reports for a source that did load MUST produce a warning naming the source
  path and stating the conflict; a conflict is not a load failure. A failure of pi-dent's own inline
  extension MUST produce the warning `pi-dent: extension <path> failed: <error>`, `<path>` being the
  inline extension's path and `<error>` the error's message.
  Unavailable tools from that extension are absent from the effective tool cap. Warnings MUST NOT
  start a model turn: the main session receives a warning-level UI notification, or a warning
  on stderr when no UI is available; a dispatching child receives a displayed message without
  a triggered turn.
- A tool cap without `Agent` MUST fail the plan (`missing-tool-authority`); the check MUST run on
  every dispatch path, including recovery attempts. A dispatch with no live dispatching session
  has no tool cap and fails the same way. A `Fleet` query dispatch is exempt, MUST NOT load
  inherited extension sources, and takes the tool cap of [fleet-tool.md](fleet-tool.md), Section 4.
- The resolved tool cap MUST reach the child in-process; the child MUST NOT select from a
  global inventory.

### 3.2 Skills

The plan's skills are the skill catalog specified in [skill.md](skill.md) when the tool cap
includes `Skill`, and empty otherwise; there is no per-agent skill declaration. Binding of `Skill`
and the `<available_skills>` injection follow [skill-tool.md](skill-tool.md).

### 3.3 Model and thinking

Model precedence:

```text
call  >  agent model (static only)  >  persisted (resume source)  >  dispatching session
```

- A tier supplies a model when it declares one. The call tier is the call's `model` parameter.
  The agent-model tier is the definition's `model` field and exists only on a static dispatch.
  The persisted tier is the persisted model of the `resume` source (Section 9), serialized as
  `<provider>/<modelId>` with no thinking suffix, and exists only on a `resume` dispatch with a
  persisted model. The dispatching-session tier is the dispatching session's current model.
- The highest tier that supplies a model is selected. A model string of the call, agent-model, or
  persisted tier that fails to resolve MUST fail plan resolution with its error code
  ([model-string.md](model-string.md), Section 6); it never falls through to a lower tier. When no
  tier supplies a model, or the dispatching session's model is absent from the inventory, plan
  resolution MUST fail with `missing-model`.
- A model string is parsed and resolved against the inventory per
  [model-string.md](model-string.md): concrete selectors and class references are both valid,
  class references resolving through the active `modelClasses` mapping. Every inventory model
  is dispatchable, not only the configured models, except as bounded by model guidance below.
- Thinking precedence: the selected tier's resolved descriptor thinking
  ([model-string.md](model-string.md), Section 4.4) > the persisted thinking (when the selected
  model matches the persisted `provider/id`) > the dispatching session's thinking (when the
  selected model matches its `provider/id`) > absent (the run sets no level; a continuation
  records it as `off`, Section 9). The result is the effective thinking level. Support for the level is checked when a model string resolves
  ([model-string.md](model-string.md), Section 4.4); a level taken from the persisted
  thinking or the dispatching session is not checked.
- While model guidance is active, plan resolution applies the dispatch restriction of
  [model-guidance.md](model-guidance.md), Section 3.
- The `model` value MUST be the canonical serialization ([model-string.md](model-string.md),
  Section 5) of the resolved model with its effective thinking level. The result MUST record
  `model`, `modelSource` (`call|agent|persisted|inherited`, where `inherited` is the
  dispatching-session tier), and `previousModel`, as `<provider>/<modelId>` with no thinking
  suffix, when a continuation's persisted model was superseded.

### 3.4 Compaction and session policy

- Compaction: the child's compaction settings are the dispatching session's, each field absent
  from them taking its value from the defaults
  `{ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }`. A settings file that
  cannot be read contributes nothing to them, and the dispatching session's UI MUST show one
  warning naming each such file.
- Session policy: `persistent` (fresh session) unless the call gives `resume`, which reopens and
  continues the source session file. The child's working directory is the `cwd` parameter
  (Section 1.1 default included); a `resume` call that gives `cwd` continues the session in that
  resolved working directory.

## 4. Execution model

### 4.1 Invocation lifecycle

One dispatch flows: invocation registration → parameter validation → plan resolution →
foreground or background delivery.

Invocation registration MUST create the task row (`kind: "agent"`) first, before parameter
validation, per [task.md](task.md): every invocation — foreground, background, resumed, or
rejected — has exactly one row, except as [task.md](task.md), Section 1 states, and groups into a
cohort per [task-registry.md](task-registry.md) Section 5. Its initial `label` is
`<agent> — <summary>`, where `<agent>` is the `agent` parameter, else `dynamic`, and `<summary>`
is the named definition's `description` when the agent catalog has that agent and it carries one,
else the first line of `task` when that line is not empty, else the literal `task`. The row is
registered with `task` set to the `task` parameter. Once the plan resolves, the row MUST be
amended with `agent` set to the plan's agent identity, `model` set to the canonical serialization
of the plan's model, and `label` rebuilt the same way from the plan's agent identity; once an
attempt's child session file path is fixed, with `sessionPath`. The row settles with the
`status` of the last result record (Section 7).

A parameter validation failure (Section 1.1), a concurrent-`resume` rejection (Section 9), a
dispatch with no live dispatching session, and a plan-resolution failure (Section 3; includes an
agent-directory creation failure (Section 4.2)) detected before delivery are pre-start rejections:
the row MUST be consumed ([task-registry.md](task-registry.md), Section 5) and settle `failed`, and
the tool call MUST return the error result of
Section 7 in either delivery mode.

A plan-resolution failure detected during delivery — the dispatch-authority check that runs inside
every attempt (Section 3.1), for example — MUST NOT be a pre-start rejection: the row MUST NOT be
consumed by the failure, and the row MUST settle through `settle`
([task-registry.md](task-registry.md), Section 5).

### 4.2 Child session

The child MUST run in-process on the pi SDK:

- A live model runtime sharing the dispatching session's settings and credentials is required;
  absence MUST fail the dispatch (`failurePhase: "startup"`, `failureCode: "missing-runtime"`)
  before a child starts. `missing-runtime` is not a pre-start rejection; under background delivery
  it settles the task row.
- Before it creates the child session, the engine MUST make the child's model runtime hold every
  extension provider of the dispatching session, as the dispatching session's model runtime holds
  it at that moment: its configuration (including its authentication and stream handlers) or its
  provider object. An extension provider is a provider an extension registered, by provider ID. A
  model of such a provider then runs in the child with the stored credentials of the dispatching
  session, even when no inherited extension source (Section 3.1) registers the provider in the
  child. An extension provider that an earlier dispatch added and the dispatching session no longer
  holds MUST be removed from the child's model runtime, unless an inherited extension has
  registered that provider there since. A provider that cannot be added MUST produce the warning
  `pi-dent: provider <id> could not be registered for the child: <error>` through the warning
  channel of Section 3.1, `<id>` being the provider ID and `<error>` the error's message, and the
  dispatch MUST continue. This applies to every dispatch, a `Fleet` query dispatch included.
- A virtual model is an inventory model that routes each request to another model. The host exposes no
  definition of a virtual model, so none is copied to the child. When the plan's model is a virtual
  model that the child's model runtime does not list once the child's extensions are bound, the
  dispatch MUST fail before the first prompt with `failurePhase: "startup"`,
  `failureCode: "missing-model"`, and the error text
  `virtual model <provider>/<modelId> is not available to the child: virtual models are not inherited`.
- Each dispatch MUST run one in-process SDK child session created with explicit boundaries:
  the plan's resolved model and thinking, the effective tool cap, the skill binding and
  injection of Section 3.2, and the resolved cwd. The system prompt is the agent `prompt`, then
  for a dynamic dispatch the session notes (below), then
  the `<available_skills>` injection (Section 3.2), then the plugin context blocks
  ([plugin.md](plugin.md), Section 10), then the session rules for the resolved model
  and, when the effective tool cap includes `Agent`, the child guidance
  ([model-guidance.md](model-guidance.md), Section 4); the non-empty parts MUST be joined by
  `"\n\n"`, and the plugin context blocks form one part, each block separated from the next by
  `"\n\n"`. The session MUST mint a fresh session ID for `persistent` (a `resume` dispatch
  continues under the source session's ID). Every attempt is one prompt of that session,
  followed by its notification model turns (below); a model turn is one request to the model
  and the tool calls it leads to, as the host counts turns.
- An `Agent` dispatch's attempt MUST NOT end while its task registry holds a running row. When a
  model turn of the attempt ends with `stopReason` `stop` and such a row exists, the attempt
  waits; the completion notification of [task-registry.md](task-registry.md) Section 5 then
  triggers a further model turn of the child session, a notification turn, which belongs to the
  same attempt. The attempt ends when a model turn ends with no running row and no completion
  notification awaiting a model turn. A model turn that ends with any other `stopReason`, a
  cancellation (Section 11), and a liveness expiry end the attempt at once. A `Fleet` query
  dispatch's attempt never waits.
- A dispatch MUST NOT settle, and a recovery attempt MUST NOT prompt, while a turn a Fleet delivery
  ([fleet-tool.md](fleet-tool.md), Section 3.2) started is starting or running. While an attempt
  waits for such a turn, the turn is the attempt's: its model turns' usage, trace and terminal
  candidate count toward that attempt, whose result is the last assistant message of the child's
  last turn, whichever turn started it. A turn that runs between attempts, while a recovery attempt
  waits to prompt, counts toward neither. A model turn that ends with a `stopReason` other than
  `stop` ends the attempt at once, even while such a turn is in flight; the attempt then aborts the
  child's run and waits for that turn to settle before the dispatch settles. A Fleet `send` with
  `abort: true` and the `abort` host command both abort the child's running turn
  ([fleet-tool.md](fleet-tool.md), Section 3.2). The message of such a `send` starts the next turn
  after the abort, and that turn supplies the dispatch's result like the child's last turn under
  this section. The `abort` host command carries no message: a dispatch whose last turn was aborted
  that way settles `cancelled` (Section 4.3).
- Each attempt owns its own task registry, attached to the dispatching task row as `children` per
  [task-registry.md](task-registry.md) Section 6; it ends with the attempt and its running and
  unconsumed rows follow [task-registry.md](task-registry.md) Section 4 (adoption, else
  cancellation).
- Every session has an agent directory: `<sessionDir>/<sessionStem>.agents/`, or
  `<tmpdir>/pi-dent-sessions/<sessionId>/` when it has no session file. `<sessionDir>` is the session
  file's directory and `<sessionStem>` its basename without the `.jsonl` extension; `<tmpdir>` is
  the operating system's temporary-directory root. The rule is recursive: a child session's agent
  directory is the one named after its own session file, so it lies inside the agent directory of
  the session that dispatched it. pi-dent MUST create a session's agent directory at the main
  session's start, including after a reload, and before the first prompt of a child session's
  first attempt, and MUST NOT delete it; only the retention sweep (Section 10) removes one.
- `Agent` session files MUST be stored in the dispatching session's agent directory:
  `persistent` attempts write `<safeAgent>-<taskId>.jsonl`; `resume` attempts continue the
  source session file in place wherever it resides — nothing is copied and no new file is
  written. A safe name is the input with every character outside `A–Z`, `a–z`, `0–9`, `.`, `_`,
  and `-` replaced by `_`; `<safeAgent>` is the safe name of the agent identity, and `<taskId>`
  is the task row's task ID.
- The dispatching boot window MUST register the child session of a dispatch in the local session
  store as its child session record ([session-store.md](session-store.md), Section 4), once the
  child session exists and before its first prompt; that section owns the record, its `agents_dir`
  and its lifecycle. A `Fleet` query child ([fleet-tool.md](fleet-tool.md), Section 4) registers
  none. The endpoint that delivers into the child's conversation is held for the record's life
  ([fleet-tool.md](fleet-tool.md), Sections 3.2 and 4). The child stays a child session: it is a
  target only for the session that dispatched it ([fleet-tool.md](fleet-tool.md), Section 1), and
  its own `query` is a waited query ([fleet-tool.md](fleet-tool.md), Section 4.1).
- The child session's Fleet record and its delivery are reported to the dispatching session through
  the warning channel of Section 3.1, with these texts, where `<sessionId>` is the child session's
  ID, `<name>` a host command's name, and `<message>` an error's message:

  | Situation                                            | Warning text                                                                                                            |
  | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
  | the record belongs to another live boot window       | `pi-dent: session <sessionId> is already owned by another live boot window; Fleet delivery to this session is disabled` |
  | the ID is this boot window's own session or endpoint | `pi-dent: session <sessionId> is this boot window's own session; Fleet delivery to this session is disabled`            |
  | the boot window's store is closed                    | `pi-dent: Fleet child registration for session <sessionId> skipped: the local session store is closed`                  |
  | the record's write is refused or fails               | `pi-dent: Fleet child registration failed: <message>`                                                                   |
  | a Fleet-delivered message is refused early           | `pi-dent: Fleet child delivery failed: <message>`                                                                       |
  | a Fleet abort of the child's turn fails              | `pi-dent: Fleet child abort failed: <message>`                                                                          |
  | a host command on the child fails                    | `pi-dent: Fleet child /<name> failed: <message>`                                                                        |
  | the record cannot be removed at settlement           | `pi-dent: Fleet child cleanup failed: <message>`                                                                        |

- For a background dispatch, the dispatching session MUST write, rewrite, and delete the task's
  task record in its own agent directory, per [task-record.md](task-record.md), Section 2.
- The task text is the child's user message.
- A session's agent directory is the folder for the files its tools write, and pi-dent MUST expose
  its path as `PI_DENT_SESSION_DIR`. The main session's agent directory MUST be set as
  `PI_DENT_SESSION_DIR` in the process environment its tools inherit; it MUST be unset when the
  session ends. A failure to create it at session start leaves `PI_DENT_SESSION_DIR` unset and does
  not fail the session. A child's `PI_DENT_SESSION_DIR` MUST be the child session's own agent
  directory, visible to the child's tools only, without mutating shared `process.env`; a child's
  tools MUST NOT see the dispatching session's value. A `resume` attempt and every recovery
  attempt use the same agent directory as the child session's earlier attempts, with its files
  intact. A failure to create an agent directory fails the dispatch with
  `failureCode: "invalid-plan"` and `failurePhase: "plan-resolution"`, before any prompt is sent.
- The session notes tell a dynamic dispatch's child what an agent definition would otherwise
  have to: the line `Session notes:`, then these lines in order, each prefixed `- `, a tool's
  line only when the effective tool cap includes every tool the line names:

  | Tool              | Line                                                                                                                                                                                                                                                                                                                                                                                                       |
  | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | —                 | `` `PI_DENT_SESSION_DIR` (<dir>) is this session's own directory, set in your tools' environment. Write temporary files there, never in the project tree. ``                                                                                                                                                                                                                                               |
  | `read`            | ``Read a file with `read` before editing it, not through `Bash`.``                                                                                                                                                                                                                                                                                                                                         |
  | `edit`            | ``Change files with `edit`; use `write` only for new files and full rewrites.``                                                                                                                                                                                                                                                                                                                            |
  | `Script`          | ``Run JavaScript or TypeScript with `Script`, never through `Bash`.``                                                                                                                                                                                                                                                                                                                                      |
  | `Bash`            | ``Run a long-running command with `Bash` and `background: true`, never with `&` or `nohup`.``                                                                                                                                                                                                                                                                                                              |
  | `Bash`            | ``Before every `Bash` call, check the command: if it ends in `\| tail`, `\| head`, `\| grep` or `> file`, delete that ending. `Bash` already returns only the last 50 lines and saves the full output to a file the result names.``                                                                                                                                                                        |
  | `Skill`           | ``Load a `Skill` when the task matches one in `<available_skills>`.``                                                                                                                                                                                                                                                                                                                                      |
  | `Search`, `Agent` | ``Everything an agent you dispatched ran, printed, or said is in its transcript, not only its final message: `Search` `find` with `session` set to its task ID, or to its session file path for a resumed agent, then `get` the hit by its address. A bare `find` searches this session; use it before redoing work and after a summary replaced earlier turns. Never read session files through `Bash`.`` |
  | —                 | `Your final message is the result returned to the caller: make it complete, and claim only what you verified.`                                                                                                                                                                                                                                                                                             |

  `<dir>` is the child session's agent directory path.

- A tool result's text shown in the terminal by the `Agent`, `Task`, `Script`, or `Bash` tool, the
  `Agent` tool's `renderCall` text, a display label shown by the task tree widget or the task
  browser, and a path, an `Error` line, a `Task` line, or a `Command` line shown by the task
  browser MUST show each occurrence of the main session's agent directory path as
  `$PI_DENT_SESSION_DIR`. Text delivered to a model MUST carry the path itself. The call and result
  sections of a `Bash` or `Script` tool card MUST likewise show each occurrence of the main
  session's agent directory path as `$PI_DENT_SESSION_DIR`.
- Liveness deadlines come from the `agentLiveness` configuration
  (`{ idleTimeoutMs?, absoluteTimeoutMs? }`, integers from 0 to 2147483647 inclusive) and the
  environment overrides `PI_DENT_AGENT_IDLE_TIMEOUT_MS` and `PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS`. Per
  field, precedence is the environment override, then the merged configuration value
  ([config-file.md](config-file.md), Section 3), then `0` = disabled. An environment value MUST be
  an integer from 0 to 2147483647 written in decimal digits only; any other value MUST produce one
  diagnostic and be ignored, so the merged configuration value applies. A configuration field that
  is not an integer from 0 to 2147483647 MUST produce one diagnostic and be ignored, so `0` applies
  to it unless an environment override is valid. An unknown `agentLiveness` key follows the
  unknown-key rule ([config-file.md](config-file.md), Section 2). The idle deadline expires when the
  child session emits no event for `idleTimeoutMs`, and MUST NOT run while the attempt waits for a
  running row; the absolute deadline bounds the whole attempt, waiting included. Expiry MUST yield
  `stopReason: "timeout"` and `failureCode: "timeout"`, cancel the child, and is never recovered
  (Section 8).

  > Note (non-normative): the idle deadline pauses while the attempt waits because a wait for
  > running rows emits no child-session event by design; counting it would expire every
  > attempt that waits on a long background task.

- If an attempt completes without a retained session file at its `sessionPath`, it MUST settle as `failed` with `stopReason: "error"`, `failurePhase: "execution"`, and `failureCode: "execution-error"`.

### 4.3 Terminal candidate

The child's final answer is a candidate until admitted. An assistant message is a terminal
candidate when its `stopReason` is `stop`, `error`, or `aborted`, or it carries a non-empty
`errorMessage`, or its content contains no tool call; the text of any other assistant message is
intermediate. A candidate MUST be superseded, and its text flushed as intermediate, by the next
`turn_start` or `tool_execution_end` event of the child session, or by the `message_end` event of
a later assistant message that is a terminal candidate. The terminal candidate of a waiting
attempt is superseded by its notification turn.

An attempt has a committed error when its last assistant message has `stopReason` `error` or
carries a non-empty `errorMessage`; an earlier such message that the child session went on from —
its host retried the request or compacted — commits none. A message whose `stopReason` is `aborted`
commits none, whatever its `errorMessage`: it reports the abort, which is no execution error. The
committed error is that message's `errorMessage` when non-empty, else
`model error (stopReason <stopReason>)`. An attempt with no
committed error whose terminal candidate has `stopReason` `stop` ends `completed`; with
`aborted`, it ends `cancelled`, with `failurePhase: "execution"` and `failureCode: "aborted"`;
with any other `stopReason`, it ends `failed`, with `stopReason: "error"`,
`failurePhase: "execution"`, and `failureCode: "execution-error"`. When an attempt ends
`completed`, its accepted final text MUST be forwarded to the caller with `final: true`. An
attempt that ends with no committed error and no terminal candidate is a protocol fault
(`invalid-turn`), not success.

## 5. Foreground contract

Foreground delivery blocks the tool call:

- Aborting the tool-call signal cancels the dispatch (Section 11).
- Every settled dispatch — success or failure — MUST return the formatted final result of
  Section 7 (`isError: true` on failure, with `details.results` preserved).

## 6. Background contract

`background: true` requests background delivery: unless the call is a pre-start rejection
(Section 4.1), the dispatch MUST keep running after the tool call returns, and the call MUST
return immediately with:

```text
Agent <agent> started in background (taskId <taskId>).
Session: <sessionPath>
```

and details `{ background: true, taskId, agent, sessionPath }`, where `<agent>` / `agent` is the
plan's agent identity and `<sessionPath>` / `sessionPath` is the child session file path of
Section 4.2 (for a `resume` dispatch, the source path).

Task lifetime, cohort completion notification, and consumption follow
[task-registry.md](task-registry.md) Sections 4–5; tasks are inspected or cancelled through the
`Task` tool ([task-tool.md](task-tool.md)).

## 7. Result contract

The tool MUST accumulate one result record per attempt; a pre-start rejection accumulates
one record with no attempt (`status: "failed"`, `stopReason: "error"`, empty usage, no
`sessionPath`). The tool MUST return:

- Success: `content[0].text` is the final assistant text (or `"(no output)"`); `isError` unset.
- Error: `isError: true`; text is `Agent <stopReason>: <message>` with the message fallback
  chain attempt error message → final assistant text → `<stopReason>`, followed, when
  `sessionPath` is present, by `\nSession: <sessionPath>` (a line break, then `Session: `, then
  the path). A result is unsuccessful exactly when its `status` is not `completed`.
- `details.results` carries one record per attempt in execution order; the last record is the
  accepted outcome. Each record carries `agent`, `status`
  (`completed|failed|cancelled`), `stopReason` (`stop|error|aborted|timeout`),
  `failureCode`/`failurePhase`, `model`, `modelSource`, `previousModel`, the attempt's `usage`
  (`input, output, cacheRead, cacheWrite, cost, contextTokens, turns`), `sessionPath`, and a
  content-free `trace` of tool-call/tool-result identities.

| `failurePhase`      | `failureCode` values                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `"plan-resolution"` | `missing-tool-authority`, `missing-model`, `missing-model-class`, `ambiguous-model`, `unsupported-thinking`, `unguided-model`, `invalid-plan` |
| `"startup"`         | `missing-runtime`, `missing-model`                                                                                                            |
| `"execution"`       | `invalid-turn`, `timeout`, `aborted`, `execution-error`                                                                                       |

Malformed `modelClasses` definitions follow [model-string.md](model-string.md), Section 3.

| Outcome                                 | `status`    | `stopReason` | `failurePhase` / `failureCode`           |
| --------------------------------------- | ----------- | ------------ | ---------------------------------------- |
| Success                                 | `completed` | `stop`       | none                                     |
| Cancellation                            | `cancelled` | `aborted`    | `"execution"` / `aborted`                |
| Liveness expiry                         | `failed`    | `timeout`    | `"execution"` / `timeout`                |
| Pre-start rejection                     | `failed`    | `error`      | `"plan-resolution"` / the failure's code |
| Plan-resolution failure during delivery | `failed`    | `error`      | `"plan-resolution"` / its code           |
| Any other failure                       | `failed`    | `error`      | `"startup"` or `"execution"` / its code  |

Details are immediate-caller-private; ancestors see only the projected content-free events.
Per-attempt usage is recorded on the attempt record; the task row's usage and the session-wide
usage tally are those of Section 13.

The task row's `result` MUST hold the full settled result text of this section at settlement;
a rebuilt row carries none ([task-record.md](task-record.md), Section 3). A background
result text longer than 8000 characters is additionally spilled: the tool MUST write the full
text verbatim, once at settlement, to a result spill file `<safeTaskId>.result.md` (the safe name
of Section 4.2 applied to the task ID) in the dispatching session's agent directory, and record
`resultPath` on the task row. A spill write failure MUST leave the row without `resultPath`; no
failure is reported.
Foreground results never spill: the Section 5 tool result is always the full text. `Task` `read`
renders the preview ([task-tool.md](task-tool.md), Section 2.1).

> Note (non-normative): the spill keeps long background results out of the model's context
> until it asks for them; `result` stays complete so that a failed spill loses nothing.

## 8. Recovery

Recovery is bounded, caller-owned re-prompting of the same child session. The number of recovery
attempts of one dispatch, of both classes together, is bounded by `PI_DENT_AGENT_RECOVERY_MAX_RETRIES`
(default 2; a non-negative integer in decimal digits; any other value MUST produce one diagnostic
and the default applies).

1. A settled attempt MUST be classified, first match winning:
   1. A cancellation or a liveness expiry (Section 4.2) is never recovered.
   2. Refusal (`ask-why`): the text of the attempt's terminal candidate matches the ECMAScript
      regular expression `/cannot assist with that request/i` ([ECMA-262]), that text with
      leading and trailing white space removed is at most 300 UTF-16 code units long, and the
      attempt's child session has a session file. A longer text is not a refusal: a report that
      quotes the phrase stands as the attempt's result. The recovery attempt prompts the original `task`, then a
      blank line, then the line `Why did you previously decline? Explain, then complete the task if
      you legitimately can.`
   3. Transient error (`auto-resume`): the attempt ended in an error and the error message —
      the error raised by the attempt's prompt, else its committed error (Section 4.3) — matches
      `/(\b429\b|\b(500|502|503|504|52\d)\b|rate.?limit|overload|quota|service unavailable|network|timeout|timed out|econn|fetch failed|etimedout|eai_again|retryable)/i`
      and does not match
      `/(\b401\b|\b403\b|unauthorized|forbidden|api key|authentication|invalid request|missing model|not found)/i`.
      The recovery attempt prompts the original `task` unchanged.
   4. Any other outcome is not recovered. A plan-resolution or startup failure never reaches an
      attempt and is never recovered.
2. Recovery attempts MUST continue the attempt's produced session in place; one dispatch's
   attempts share one session file.
3. A recovery attempt MUST start only when the classification is `ask-why` or `auto-resume`, fewer
   than the bound have started, the dispatch has not been cancelled, and the task registry
   holding the dispatch's task row is live; otherwise the attempt's outcome stands. The outcome of
   an attempt classified `ask-why` is `failed` with `stopReason: "error"`,
   `failureCode: "execution-error"`, and its terminal candidate's text as the error text: a
   refused task is not done.
4. Usage aggregates across one attempt's model turns; superseded terminal candidates MUST be discarded.
5. Cancellation MUST NOT authorize a recovery attempt. Recovery is caller-owned; there is no
   supervisor restart, and containment follows the task lifetime rule
   ([task.md](task.md), Section 2).

## 9. Continuation (`resume`)

`resume` continues a retained session; the source file MUST exist. A `resume` call MUST still
name `agent` or `prompt`; the continued session takes its system prompt, tool cap, and skills from
this call's plan, and the named agent can differ from the agent that created the source session.

`resume` MAY instead be a task ID, whose form is owned by [task-registry.md](task-registry.md),
Section 2. A task ID MUST resolve to the `sessionPath` of the `agent` row of the invoking
session's own task registry with that `taskId`; a resolved row that is `running` is left unchanged
and the dispatch is subject to the concurrent-`resume` rejection of this section. The resolved
`sessionPath` is then the source session file, continued exactly as the path form.

A settled row that a `resume` continues MUST be `consume`d ([task-registry.md](task-registry.md),
Section 3), and its task record deleted per [task-record.md](task-record.md), Section 2, once the
dispatch has passed its pre-start checks (Section 4.1) and not before:

- The row a task ID resolved, when that row is settled.
- Every `agent` row of the invoking session's own task registry that is settled, whose `consumed`
  is `false`, and whose `sessionPath` is the same file as the `resume` path: their real paths are
  equal, so symbolic links and `..` segments do not distinguish them, and a path that does not
  exist compares as resolved. Several rows can name one file, and all of them are consumed.

A call whose `resume` the host rejects through the schema of Section 1.1, or that is a pre-start
rejection (Section 4.1), consumes no row, in either form. An adopted row of that task registry
([task-registry.md](task-registry.md), Section 4) matches as any other; a row of an attached
`children` task registry ([task-registry.md](task-registry.md), Section 6) matches only after
adoption has moved it into that registry.

The source session file records, as lines of JSON objects, the facts a continuation reads:

| Persisted fact             | Source                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| persisted model            | `provider` and `modelId` of the last entry of `type` `model_change`.                       |
| persisted thinking         | `thinkingLevel` of the last entry of `type` `thinking_level_change` that is a valid level. |
| recorded working directory | `cwd` of the last entry of `type` `session` that carries a string `cwd`.                   |

A line that is not a JSON object is skipped. The persisted model becomes a precedence tier
(Section 3.3) unless superseded. Before the first prompt of a `resume` dispatch, when the plan's
model differs from the persisted model, or the source has none, pi-dent MUST append a `model_change`
entry for the plan's model to the source session file; when the plan's thinking differs from the
persisted thinking, a `thinking_level_change` entry for it, `off` when the plan's thinking is
absent. A later `resume` so continues with the model and thinking the session last ran with. The
continuation appends to the source session file in place
under its existing session ID: history is never copied and never rewritten, and later `resume`
calls on the same path continue the same lineage. A concurrent `resume` check MUST follow Section 1.1. The `cwd` override
rebinds execution without rewriting source history.

## 10. Retention sweep

The retention sweep runs at most once per boot window: at the window's first `session_start`,
after the starting session's agent directory has been created (Section 4.2) and the session has
registered in the local session store ([session-store.md](session-store.md), Section 4). No timers
run and nothing is deleted at any other time. It MUST delete, with everything in it, each agent
directory found directly under a project directory of the host session store as
`<sessionStem>.agents`, or as a directory directly under `<tmpdir>/pi-dent-sessions/`, whose last
activity is older than `PI_DENT_SESSION_TTL_DAYS` days (default 30), except as follows. The last
activity of an agent directory is the latest modification time among the directory, every entry
inside it at any depth (agent directories of child sessions included), and, for a
`<sessionStem>.agents` directory, the session file `<sessionStem>.jsonl` beside it when it
exists. An agent directory nested in another is never deleted on its own.

The protected agent directories are the non-null `agents_dir` values ([session-store.md](session-store.md),
Section 2) of visible records of live sessions ([session-store.md](session-store.md), Section 4),
whatever their `state`, those of other processes and of this one alike. Hidden records do not block the sweep.
The sweep MUST NOT delete an agent directory that is, or contains, a protected one, however old
its contents; so a live session protects its child sessions' agent directories nested in its
own, and a `--no-session` directory is protected through its recorded path. A record whose owner
process is gone protects nothing. If the store cannot be opened or read, or a record of a live
session has a null `agents_dir`, the sweep MUST delete no agent directory and MUST NOT report
failure. An agent directory whose last activity is not older MUST be left whole, so no file inside
it is deleted. An agent directory the sweep cannot delete MUST be left in place; no failure is
reported.

`Script` output files ([script-tool.md](script-tool.md), Section 6) and `Bash`
output files ([bash-tool.md](bash-tool.md), Section 4) live inside an agent directory, so they are
deleted with it and have no sweep of their own. Nothing else is swept. When the sweep has
finished, whether or not it deleted anything, and at no other time, pi-dent MUST run the index prune
([session-index.md](session-index.md), Section 6), which removes the session index rows of
session files that no longer exist. When a session ends,
or on reload, pi-dent MUST set the modification time of its agent directory to the current time when
it exists, before the session's record is deleted or released, so the directory's age counts from
the end of the session. `PI_DENT_SESSION_TTL_DAYS` MUST be a positive integer in decimal digits; any other value
MUST produce one diagnostic and the default applies.

> Note (non-normative): an agent directory is pruned as a unit because it also holds files its
> tools wrote, which a name pattern cannot recognise; the store, not file ages, says whether a
> session is still live, since an open session can stay idle for longer than the age.

## 11. Cancellation

Cancellation is cooperative, not an OS hard kill:

- A cancellation request — the aborted tool-call signal of a foreground dispatch, the task row's
  cancellation handler (`Task` `kill`, [task-tool.md](task-tool.md)), or the end of the
  dispatching session's task registry when no live attaching registry exists to adopt the row
  ([task-registry.md](task-registry.md), Section 4) — MUST abort the current attempt's child
  session, end the attempt's task registry, release its resources, and settle the dispatch
  `cancelled` unless the task row has already settled; a request after settlement MUST NOT
  rewrite the outcome.

## 12. Observation

- Intermediate assistant text (its first line, cut to at most 120 characters, no marker) and
  projected content-free tool events (`<kind> <toolName>` from `kind`, `agent`, `toolCallId`,
  `toolName`, `isError` — never tool payloads) MUST feed `renderResult` (Section 1) and the task
  row's progress projection ([task-registry.md](task-registry.md), Section 2). The `renderResult`
  projection MUST keep the ten latest lines, the oldest dropped; no failure is reported.
- The child's session file is the inspection source and the single content source for
  transcript reads (tool arguments, results, assistant text).
- For every provider response received by a session pi-dent creates, including nested `Agent`
  dispatches and Fleet `query` children, pi-dent MUST emit exactly one `purse:observe:v1` event
  on the main session's `pi.events`, for every provider. The payload MUST be
  `{ protocol: 1, provider: string, headers: Record<string, string> }`, with `provider` the
  child's current model provider and `headers` the response headers. Header arrays MUST be
  joined with `", "`; other non-string values MUST be converted with `String(value)`.
  This implements pi-dent-purse's query protocol (its `specs/query-protocol.md`), Section 7.
  pi-dent MUST NOT forward the main session's own responses, which the host already delivers
  to pi-dent-purse. A throw from `emit` MUST be ignored and MUST NOT fail the dispatch.

## 13. Usage

The usage of an assistant message is its host `usage`: the token counts `input`, `output`,
`cacheRead`, and `cacheWrite`, and the cost `cost.total` in US dollars. A usage sum has the fields
`input`, `output`, `cacheRead`, `cacheWrite`, `cost`, and `turns`, all 0 at first; adding an
assistant message to it adds the message's four token counts and its cost to the fields of the
same name and 1 to `turns`. An assistant message without a host `usage` adds only the 1.

- For every assistant message that ends in the child session of a dispatch while its task row is
  `running` — in any attempt, and in a turn between two attempts — the tool MUST add the message
  to the task row's `usage` ([task-registry.md](task-registry.md), Section 2) through `amend`,
  the row's `usage` being a zero usage sum while absent. Unlike the attempt record's `usage`
  (Section 7), the row's `usage` is never reset.
- The usage tally is one count `tasks` and one usage sum, kept in memory per main session. At
  every `session_start` of the main session, a reload included, `tasks` is 0 and the usage sum is
  zero.
- `tasks` MUST increase by 1 for every dispatch that is not a pre-start rejection, once its
  pre-start checks pass: an `Agent` call of the main session, an `Agent` call of a child session
  at any depth, a `resume`, and a `Fleet` query dispatch alike. A recovery attempt is no new
  dispatch.
- Every assistant message added to the task row's `usage` of such a dispatch MUST be added to the
  usage tally's usage sum at the same time. The usage of a child session's own dispatches is in
  their rows, never in the row of the dispatch that started the child session, so the tally
  counts each message once.

While pi-dent draws the footer, the footer shows the usage tally ([footer.md](footer.md),
Section 2.2) and the key `pi-dent-agents` MUST NOT be set. While the main session has an interactive
terminal UI, pi-dent does not draw the footer, and the usage tally's `tasks` is at least 1, the
extension MUST show the usage status line through the host `setStatus` API under the key
`pi-dent-agents`:

```text
<agents> │
```

The line is that text, coloured only through the host theme. Its last character is `│`
(U+2502).

> Note (non-normative): the host joins every extension's status on one line with a single space;
> the closing `│` sets this one apart from the next.

- `<agents>` is `<tasks> <noun> · <usage>` of the usage tally: `<noun>` is `agent` when `tasks` is
  1, else `agents`.
- `<usage>` is `<turns> <unit> · ↑<input> ↓<output><cache> · $<cost>` of a usage sum, here the
  usage tally's: `<unit>` is `turn` when `turns` is 1, else `turns`; `<cache>` is ` R<cacheRead>`
  when `cacheRead` is not 0, followed by ` W<cacheWrite>` when `cacheWrite` is not 0, else empty.
- A token count `n` is rendered as: `n` in decimal below 1000; `n / 1000` with one decimal and
  `k` below 10000 (`1.5k`); `n / 1000` rounded to the nearest integer and `k` below 1000000
  (`15k`); `n / 1000000` with one decimal and `M` below 10000000 (`1.5M`); else `n / 1000000`
  rounded to the nearest integer and `M`.
- `<cost>` is `cost` with exactly three decimals, rounded to the nearest (`0.042`).
- The line MUST reflect every change of the usage tally within 1000 ms. At every
  `session_shutdown`, a reload included, the extension MUST clear the key.
- When the host `setStatus` API throws, the dispatch and the usage tally are unaffected and no
  failure is reported.

Example: `3 agents · 41 turns · ↑182k ↓9.6k R1.2M W88k · $0.214 │`.

## 14. Normative references

- [ECMA-262] ECMAScript Language Specification, 14th edition (June 2023), Ecma International:
  Regular Expressions (pattern syntax and the `i` flag).

## 15. Specification gaps

- Inheritance of extensions that register only hooks, flags, commands, or providers (Section 4.2
  copies the providers, not the extension); inline `-e` factories;
  and tools without an absolute file or `builtin:<name>` extension source path. The host's public
  tool inventory does not expose reloadable extension sources for these cases.
- Deadlines and cancellation behavior while an inherited extension factory or session-start
  handler remains unresolved.
- Cleanup of extension factory side effects when SDK session creation fails before session start.
- The base description's wording is open: any wording that states every dispatch-contract fact
  listed in Section 1 is allowed.
- A `resume` of a session file held by a running dispatch of another process is not detected:
  only this process's running dispatches are checked (Section 1.1).
- Behavior when `resume` names a regular file that is not an `Agent` session file.
- A record whose owner process ID was reused by another live process is judged live, so its
  agent directory is kept; the store cannot tell the two processes apart.
- Behavior when the recorded working directory of a `resume` source no longer exists or is not a
  directory; it is not validated.
- A `<tmpdir>/pi-dent-scripts/` tree an earlier version wrote is neither read nor swept, and what
  the operating system does with it is the system's.
- Whether the host, when it validates against the schema of Section 1.1, first coerces an
  argument to the type the schema names, and so whether a convertible value of the wrong type is
  admitted rather than rejected as a schema rejection, is the host's.
- A per-model compaction override (`compaction.modelOverrides`) of the child's working directory is
  outside Section 3.4, which names the three fields: the settings layer merge can carry it into the
  child session.
- The usage tally is not stored: the usage of the dispatches before a reload or in an earlier
  process of the same session is in no total.
- Usage the host charges a child session outside its assistant messages (a compaction or branch
  summary) is in no usage sum.
