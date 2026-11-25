# `Bash` tool specification

This document specifies the `Bash` tool: execution of one shell command as a task, its inputs,
output capture, results, timeout, termination, and delivery, and the suppression of the host's
built-in `bash` tool. The extension MUST register the tool through the host `registerTool` API
with `name` and `label` `"Bash"`; the host shows a call as a tool card
([tool-card.md](tool-card.md)). The host's built-in `powershell` tool and the host's
user-entered shell commands are not suppressed and register no task.

## 1. Parameter schema

The parameter schema is a JSON object schema with `type: "object"` and
`additionalProperties: false`:

| Field         | Type              | Contract                                                                                                                                                                                                    |
| ------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`     | string (required) | Shell command text: one line or several, passed to the shell unchanged. The schema gives it the `pattern` `\S` (at least one character that is not white space) and the description below.                  |
| `timeout`     | integer?          | Per-call timeout in milliseconds, `1` or more, with no upper bound; a value above `2147483647` imposes no timeout. Omitted gives a foreground call `600000` ms and imposes no timeout on a background call. |
| `cwd`         | string?           | Working directory of the shell: the `cwd` parameter ([task.md](task.md), Section 1.1).                                                                                                                      |
| `background`  | boolean?          | Background delivery (default `false`).                                                                                                                                                                      |
| `description` | string?           | UI label for the call.                                                                                                                                                                                      |

The `command` description MUST be exactly
``Shell command text: one line or several, passed to the shell unchanged. Its output is captured to a file by default: do not cut it with `| tail`, `| head` or `| grep`. At least one character that is not white space.``

An empty or whitespace-only `description` is treated as absent.

The tool's `description` MUST begin with the sentence
`` `Bash` output is captured to a file by default: never cut it with `| tail`, `| head` or `| grep` or redirect it, and `Read` or `rg` that file instead of rerunning the command. ``
It MUST contain the sentence
`Do not start processes with & or nohup: use background: true.`
It MUST also contain the sentence
`Temporary files go under $TMPDIR, the session's tmp folder, never /tmp; create them with mktemp "$TMPDIR/name.XXXXXX", since a bare mktemp may ignore $TMPDIR.`

> Note (non-normative): `timeout` has the unit of `Script`
> ([script-tool.md](script-tool.md), Section 1), without its upper bound, not the seconds of the
> suppressed built-in tool.

## 2. Validation

Validation has two stages. The host validates the call's arguments against the schema of
Section 1 before the tool runs, and rejects a call whose arguments do not satisfy it. That
rejection is a schema rejection ([task.md](task.md), Section 1): it registers no task row, and
no output file is created. The schema constrains the types of Section 1's table, the presence of
`command` and its pattern, the lower bound of `timeout`, and the set of admitted properties;
every other
condition on the arguments is the tool's.

The checks the schema cannot express MUST reject the call as a pre-start rejection (Section 6),
checked in this order, the first failure reported:

- The host session that invoked the call; the failure text is verbatim
  `pi-dent: no live host session for the Bash call`.
- The `cwd` check of [task.md](task.md), Section 1.1.
- A shell that cannot be resolved (Section 3).

## 3. Execution model

- Every call MUST start one new shell process and run `command` in it; no shell state (working
  directory, variables, functions) carries from one call to another. Concurrent calls run
  independently, each in its own shell process.
- The shell executable is the first that applies:
  1. the host setting `shellPath` when set, a value that is `~` or starts with `~/` having that
     `~` replaced by the user's home directory; a path that does not exist is unresolvable and
     nothing further is tried;
  2. on Windows: `%ProgramFiles%\Git\bin\bash.exe`, then `%ProgramFiles(x86)%\Git\bin\bash.exe`,
     when the file exists, then the first `bash.exe` on `PATH`; with none the shell is
     unresolvable;
  3. elsewhere: `/bin/bash` when it exists, then the first `bash` on `PATH`, then `sh`.

  `PATH` here is that of the host process environment, before the change below.

- The shell MUST be invoked with exactly the arguments `-c` and the command text: not a login
  shell, not interactive. The command text is `command`, preceded by the host setting
  `shellCommandPrefix` and one `\n` when that setting is a non-empty string. Both host settings
  are read at each call.
- A settings file that cannot be read or parsed contributes neither setting and MUST be reported
  as one `warning` naming the file, `pi-dent: <file>: <error>`, through the host `notify` API
  ([config-file.md](config-file.md), Section 6), at most once per boot window per file. The
  project settings file is read whatever its project trust ([config-file.md](config-file.md),
  Section 1).
- The shell's working directory is the resolved `cwd`.
- The shell's standard input MUST be empty: a read from it returns end of input at once.
- The shell's environment is the host process environment at call time, changed as follows:

  | Variable               | Value                                                                                                                                                                                                                                                                                           |
  | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `PATH`                 | Prefixed with the directory `bin` of the host's configuration directory, the one holding the host's global settings file (`~/.pi/agent` by default), unless an entry, split on the platform's path delimiter, equals it as a string; on Windows the variable is matched without regard to case. |
  | `PI_DENT_SESSION_DIR`  | The invoking session's value ([agent-tool.md](agent-tool.md), Section 4.2).                                                                                                                                                                                                                     |
  | `PI_DENT_SESSION_KIND` | The invoking session's value ([session-tool.md](session-tool.md), Section 3.1).                                                                                                                                                                                                                 |
  | `PI_SESSION_ID`        | The invoking session's session ID.                                                                                                                                                                                                                                                              |
  | `PI_SESSION_FILE`      | The invoking session's session file path.                                                                                                                                                                                                                                                       |
  | `PI_PROVIDER`          | The provider of the invoking session's current model.                                                                                                                                                                                                                                           |
  | `PI_MODEL`             | The ID of the invoking session's current model.                                                                                                                                                                                                                                                 |
  | `PI_REASONING_LEVEL`   | The invoking session's thinking level.                                                                                                                                                                                                                                                          |

  A variable of the last seven rows whose value the invoking session lacks MUST be absent, whatever
  the host process environment holds.

- The caller-supplied environment of the tool, when it has one (for a child session,
  [agent-tool.md](agent-tool.md), Section 4.2), is merged last: a variable it names takes its value,
  for every variable of the table above and of this list.
- Session temporary folder: when `PI_DENT_SESSION_DIR` is set and not empty, after that merge, the
  variables `TMPDIR`, `TMP` and `TEMP` take the value `<PI_DENT_SESSION_DIR>/tmp`, unless the
  caller-supplied environment names the variable. The tool MUST create that folder, recursively,
  before the shell is spawned. When the folder cannot be created, the tool MUST NOT fail the call and
  MUST leave absent each of the three variables it would set; no failure is reported. When
  `PI_DENT_SESSION_DIR` is unset or empty, the three variables keep the process's values.

- On a platform other than Windows the shell MUST be started as the leader of a new session, and
  so of a new process group, with no controlling terminal.
- The run starts when the shell process is spawned. The run ends when the shell process has
  exited and the first of these holds: both output pipes (Section 4) have reached their end;
  1000 ms have passed since the exit. When the run ends the tool MUST close its ends of both
  pipes; later output is not captured.
- A leftover process is a process of the shell's process group that is alive when the shell
  process exits. When the shell process exits with `exitReason` `exited` (Section 5), the tool
  MUST, on a platform other than Windows, terminate the shell's process group with the signal
  sequence of Section 6, the first signal sent within 100 ms of the exit. `details.leftover` is
  `true` exactly when that first signal was delivered to at least one process; the body then
  carries the leftover notice (Section 5).

  > Note (non-normative): a process started with `&` or `nohup` outlives the shell and is not
  > supervised by the task; terminating it keeps every process a call starts inside the task's
  > lifetime. `background: true` is the supported way to keep a command running.

## 4. Output capture

- The shell's standard output and standard error MUST each be read through a pipe; output MUST
  NOT reach the host process's own standard output or standard error.
- The captured output is the chunks of both pipes in arrival order. Each pipe is decoded as one
  UTF-8 byte stream: a sequence split between two chunks of one pipe is decoded whole, and a
  sequence that is invalid, or incomplete when the run ends, is decoded as U+FFFD. The captured
  output is not separated into two streams, and no character is removed from it.
- `outputPath` is the path [script-tool.md](script-tool.md), Section 6 defines for the task's
  session and task ID. The file MUST be created empty before the shell is spawned, in both
  deliveries, and every chunk MUST be appended to it as it arrives, as raw bytes, with nothing
  else written to it. A failure to create or write it MUST NOT fail the call, and no failure is
  reported.
- The lines of the captured output are its parts between `\n` characters; a final `\n` ends the
  last line and starts no further one. Empty output has zero lines. Lines are joined by `\n`,
  without one final `\n` from the captured output.
- A line's display text is the line without one final `\r`, when it has one. The `\r` is the one
  right before the line's `\n`, or the last character of the captured output when the line is not
  yet terminated. The excerpt, the partial results, the budget below and the progress entries use
  display text; the output file keeps every character.
- Each line whose display text is longer than 500 Unicode code points MUST be cut (the line cut) to
  its last 500 code points. A cut line is shown as `…` and one space followed by those code
  points. A line's retained code points are 500 when cut, else its display text's code points. Cuts
  MUST NOT split a surrogate pair. Character counts in this section count Unicode code points,
  overriding the UTF-16 default of [specs/AGENTS.md](AGENTS.md), Differences.
- The excerpt is the tail of the captured output. Its shown lines are the last `S` lines, where `S`
  is the largest number such that all of these hold:
  - `S` is at most 50 (the line bound);
  - `S` is at most the number of lines;
  - the retained code points of those `S` lines total at most 4000 (the character budget).
    One line always satisfies these, so the last line is always shown. Lines not shown are omitted.
- The excerpt is truncated when any line is omitted or any shown line is cut. A truncated excerpt
  MUST begin with one header line, followed by `\n` and then its shown lines. `<total>` is the number
  of captured lines, `<omitted>` the number of lines not shown (`<total>` minus the number shown),
  `<bytes>` the number of bytes the captured output has received, counting every chunk of both pipes
  as received, which equals the output file's size once the file is written, and `<cut>` the line-cut
  length the cut rule above states. The header is one of these three verbatim forms; the dash in the
  first is U+2013:
  - `[Lines 1–<omitted> of <total> not shown; full output: <outputPath>. Search it with rg or Read it.]`
    when lines are omitted and no shown line is cut. When `<omitted>` is 1, the form is
    `[Line 1 of <total> not shown; full output: <outputPath>. Search it with rg or Read it.]`.
  - `[The output's end is shown (<total> lines, <bytes> bytes), long lines cut to their last <cut> characters; full output: <outputPath>. Search it with rg or Read it.]`
    when a shown line is cut and no line is omitted. `lines` reads `line` when `<total>` is 1.
  - `[Lines 1–<omitted> of <total> not shown, long lines cut to their last <cut> characters; full output: <outputPath>. Search it with rg or Read it.]`
    when a shown line is cut and lines are omitted. When `<omitted>` is 1, the form reads
    `[Line 1 of <total> not shown, long lines cut to their last <cut> characters; ...]` with the same
    tail.
- An untruncated excerpt MUST NOT carry a header. The header is part of the body only: neither the
  output file nor a partial result carries it.
- The captured output MUST be appended to the task row's progress projection as it arrives, in
  both deliveries: one entry per line of the captured output once its `\n` has arrived, and the
  unterminated last line, when non-empty, when the run ends. Each entry MUST retain at most the
  first 500 code points of its line's display text; when cut, the entry is those code points followed by one space
  and `… [<n> characters omitted]`, `<n>` being the number of code points removed, with `character`
  when `<n>` is 1 and `characters` otherwise. No header is appended to an entry. Lines are formed on
  the captured output, not on each pipe: a line is the text before the first `\n` character of the
  captured output or between two consecutive `\n` characters of it, in arrival order, so one line can
  start in one pipe and end in the other.

  > Note (non-normative): a progress entry is a live status line and shows the start of its line;
  > the excerpt shows the end, where a finished command's result usually is.

- While a foreground call runs, every change of the captured output MUST reach the host's
  partial-result callback within 1000 ms, as a result whose `content[0].text` is the excerpt at
  that time without the header: its shown lines joined with `\n`, with cut lines as above.
- Apart from the output file, state retained for the excerpt and pending line MUST be O(1) in
  the captured output's size. Processing a chunk MUST take O(chunk size) time, without
  rescanning previously captured text; producing a partial result MUST take O(1) time in the
  captured output's size. Host callback failures MUST NOT escape output-event handlers.

> Note (non-normative): the tail is kept because the end of a run usually carries the result; the
> header names the file that holds the rest.

## 5. Result contract

- `exitReason` is the first of these outcomes to occur; a later one MUST NOT change it:

  | `exitReason`   | Outcome                                           | Status line                                                                                                                                                      | Task status                                       |
  | -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
  | `exited`       | The shell process exits.                          | `Command exited with code <exitCode>` when `exitCode` is not `0`, else none.                                                                                     | `completed` when `exitCode` is `0`, else `failed` |
  | `timeout`      | The timeout expires.                              | `Command timed out after <timeout> ms`                                                                                                                           | `failed`                                          |
  | `aborted`      | The tool-call signal of a foreground call aborts. | `Command aborted`                                                                                                                                                | `cancelled`                                       |
  | `killed`       | The task row's cancellation handler is invoked.   | `Command killed`, or `Command killed by the user from the task browser` when the row's `browserKill` is `true` ([task-registry.md](task-registry.md), Section 2) | `cancelled`                                       |
  | `spawn-failed` | The shell process cannot be spawned.              | `Command failed to start: <message>`                                                                                                                             | `failed`                                          |

  `running` is the `exitReason` of the initial background return only. `<timeout>` is the timeout
  the call imposes (Section 1) in decimal digits, using that section's default when omitted; `<message>` is the
  spawn error's message.

- `exitCode` is the shell process's exit code, or `128` plus the signal's number when a signal
  ended the shell process. It is present exactly when `exitReason` is `exited`.
- A call is filter-piped when `command` holds at least one top-level `|` and the text after its
  last one, with leading white space removed, begins with `head`, `tail`, or `grep` as a word. A
  `|` is top-level when it is outside single and double quotes, is not escaped by a backslash
  outside single quotes, and is not part of a `||`. The word ends at the end of the text or
  before a character that is not an ASCII letter, a digit, or `_`. The tool MUST NOT block or
  rewrite the command of a filter-piped call.

  > Note (non-normative): a pipe inside `$( )`, a heredoc body, or a `#` comment counts as
  > top-level under this rule, so a call may carry the notice for it.

- A command is file-redirected when, after trailing white space is removed, it ends with a run of top-level redirections of which at least one counts. Every redirection in that run whose target is a file counts: a target of `/dev/null` and a descriptor target of the form `&N` do not count. The redirection operators are exactly `>`, `>>`, `>|`, `&>`, and `&>>`, optionally preceded by any single file descriptor digit; whitespace can occur between an operator and its target, and a quoted target counts as one word. Top-level uses the quoting and escaping rules for `|` above. Redirections inside quotes do not count. The call is stdout-redirected when at least one counted redirection has no descriptor digit, has descriptor digit `1`, or has an operator starting with `&`. The tool MUST NOT block or rewrite the command of a file-redirected call.

  > Note (non-normative): This lexical rule can flag text in comments, heredocs, or command substitutions, and can miss shell syntax whose redirection target is not one word.

- The body is these parts, each present as stated, joined by one empty line (`\n\n`), in the order listed: 1. the excerpt
  (Section 4), when it is non-empty, which begins with its header when truncated; 2. the pipe notice `Note: the saved output holds only what the final pipe printed; rerun without the pipe to keep it all.`
  when the call is filter-piped and the call is not stdout-redirected, whether or not the excerpt is truncated; the pipe notice is omitted when the call is stdout-redirected; 3. the redirect notice `Note: output redirected to a file is not shown or saved by Bash; run the command plainly to have its output saved for Read or rg.` when the call is file-redirected; 4. the status line, when the table gives one; 5. the leftover notice
  `Command left a process running; it was terminated. Use background: true, not & or nohup.` when the run has a
  leftover process (Section 3). With no part present the body is `(no output)`.
- A foreground call returns once the run has ended, with the body as `content[0].text` and
  `isError: true` exactly when the task status is not `completed`.

  > Note (non-normative): a non-zero exit is reported as an error, as the suppressed built-in
  > tool reported it; the status line tells a command that found nothing from one that broke.

- `details` carries `{ taskId, exitReason, exitCode?, truncated, leftover, outputPath, durationMs, background? }`:
  `truncated` is whether the excerpt is truncated, `leftover` is per Section 3 (`false` for any
  other `exitReason`), `durationMs` the whole milliseconds, rounded
  down, from the run's start to its end (`0` when no run started), and `background` is present,
  `true`, only in the initial background return.

## 6. Timeout, termination, and delivery

- Except where [task.md](task.md), Section 1 registers no row, every call registers one task
  row (`kind: "bash"`) after the host has accepted its arguments and before the checks of
  Section 2, `label` set to `description` when Section 1 does not treat it as absent, else to the
  first line of `command` with its leading white space, line breaks included, removed, cut to 80
  characters (no marker), and `command` set to the call's `command`, unchanged
  ([task-registry.md](task-registry.md), Section 2); task lifetime, cohort, and completion
  notification follow [task-registry.md](task-registry.md). The row's cancellation handler is
  set before the shell is spawned.
- A call failing Section 2 is a pre-start rejection: its row is consumed
  ([task-registry.md](task-registry.md), Section 5) and settles `failed`
  with the error text as its result, no file is created, and the call returns the tool error
  (`isError: true`) directly in both foreground and background delivery.
- In a call that passes Section 2, a cancellation that occurs before the shell is spawned, and in
  a foreground call also an abort, a tool-call signal already aborted included, MUST prevent the
  spawn: the row settles with that outcome's `exitReason`, and its body is the status line.
- The `timeout` deadline counts from the run's start, in both deliveries; its value is the one
  Section 1 resolves, using that section's default for a foreground call that omits `timeout`.
- At timeout expiry, foreground abort, or cancellation, when it sets `exitReason` (Section 5),
  the tool MUST terminate the shell's process tree: on a platform other than Windows, `SIGTERM`
  to the shell's process group, then `SIGKILL` to the same group no sooner than 200 ms and no
  later than 300 ms after it, a signal to a group with no process left being no failure; on
  Windows, forced termination of the shell process and all its descendants at once. The first
  signal MUST be sent within 100 ms of timeout expiry, and before the cancellation handler
  returns. The run then ends per Section 3. An expiry, abort, or cancellation that does not set
  `exitReason` terminates nothing.
- A background call MUST ignore the tool-call signal, before and after the call has returned: a
  background call never aborts, and a tool-call signal already aborted MUST NOT prevent the spawn.
- A foreground call MUST NOT move itself to the background.
- `background: true` returns once the spawn has been attempted, without waiting for the run
  (`isError` unset), with the text
  `Command started in background (taskId <taskId>).\nOutput: <outputPath>` and `details`
  `{ taskId, outputPath, background: true, exitReason: "running", truncated: false, leftover: false, durationMs: 0 }`.
  A `spawn-failed` background call returns the same and settles its row.
- When the run ends, or on `spawn-failed`, the row settles in both deliveries with the task
  status of Section 5, the body as its result text, and `outputPath` as its `resultPath`.
- Inspection and cancellation go through the `Task` tool ([task-tool.md](task-tool.md)); the task
  browser's kill key cancels through the same handler ([task-browser.md](task-browser.md),
  Section 4.4), and its body carries the status line of Section 5.
- When the task registry holding a running row ends, the row follows
  [task-registry.md](task-registry.md), Section 4; the shell of an adopted row keeps running.

## 7. Suppression of the built-in tool

The host offers a tool to the model only while the tool's name is in the session's active tool
set, and it ships a built-in tool named `bash`, active by default. `Bash` and `bash` are
different names to the host, which compares tool names exactly.

- On every `session_start` the extension instance receives, whatever its reason, the extension
  MUST, before its handler returns, set the main session's active tool set to its current value
  without the name `bash`; every other name stays, in its order.
- The extension MUST block, through the host's `tool_call` interception, every call in the main
  session to a tool named `bash`, with the reason text
  ``The `bash` tool is disabled: use `Bash`.``; a blocked call runs no process and registers
  no task.
- Both rules apply to the name `bash`, whatever registered the tool.
- `Bash` MUST be registered unconditionally at extension load, active on registration like
  every pi-dent tool. The extension MUST NOT activate `Bash` because a host tool selection names
  `bash`: whether `Bash` is active follows the host's rules for an extension tool alone.

  | Host tool selection at start                                            | `bash`                  | `Bash`                                                    |
  | ----------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------- |
  | No list of plain tool names (the default tools, with or without `bash`) | Deactivated when active | Active                                                    |
  | A list of plain tool names that includes `Bash`                         | Deactivated when named  | Active                                                    |
  | A list of plain tool names without `Bash`, with or without `bash`       | Deactivated when named  | Not registered by the host: the session has no shell tool |

- When a `session_start` handler removes `bash` from the active tool set and `Bash` is not
  among the tools the host registered for the session, the extension MUST show, once for that
  `session_start`, the notification
  ``pi-dent: the tool selection names `bash`, which is disabled, and omits `Bash`: the session has no shell tool``
  at level `warning` through the host `notify` API ([config-file.md](config-file.md),
  Section 6). No notification is shown in any other case.
- A child session binds `Bash` and never `bash`, per [agent-tool.md](agent-tool.md),
  Section 3.1; its `Bash` calls register into the attempt's task registry and observe the child
  session's working directory and environment values (Section 3).
- `Script` keeps its own child-process rules ([script-tool.md](script-tool.md), Section 6).

## 8. Specification gaps

- On Windows, shell resolution is unverified: whether `%ProgramFiles%\Git\bin\bash.exe`,
  `%ProgramFiles(x86)%\Git\bin\bash.exe`, or the first `bash.exe` on `PATH` is found, and what
  the tool does when none of them is, is unspecified.
- On Windows, a `bash.exe` that is the legacy WSL launcher does not accept the command text as an
  argument; its invocation is unspecified.
- On Windows, the `shellPath` forms are unverified: whether a value naming a Git for Windows
  `bash.exe`, a `~` or `~/` form, or a path that does not exist is treated as Section 3 states, is
  unspecified.
- On Windows, the `PATH` environment variable is unverified: whether it is matched without regard
  to case, as Section 3 requires, is unspecified.
- On Windows, termination of the shell's process tree is unverified at all three events that
  trigger it — timeout expiry, `Task` `kill`, and foreground abort: whether the shell process and
  all its descendants are terminated, and within the bound of Section 6, is unspecified.
- On Windows, a leftover process has no definition, because the shell is not started as a group
  leader there; whether one is terminated, and the value of `details.leftover`, are unspecified.
- On Windows, `exitCode` is unverified: no signal ends the shell process there, so the
  `128`-plus-signal form of Section 5 is unreachable, and the `exitCode` of a shell the host
  terminated is unspecified.
- On Windows, the end of the run is unverified: whether the pipes of an exited shell reach their
  end, and so whether the pipe end or the 1000 ms bound of Section 3 ends the run first, is
  unspecified.
- A process that leaves the shell's process group (a new session or group) is not reached by
  termination; whether it survives is the operating system's.
- When the host process exits within the 200 ms between `SIGTERM` and `SIGKILL`, or is itself
  killed, no `SIGKILL` is sent and a shell may outlive it.
- A `bash` that another extension or the user activates after `session_start` stays offered to
  the model until the next `session_start`.
- Whether a host codemode script can call the deactivated `bash`, and whether such a call
  passes the `tool_call` interception, is unspecified.
- A model request the host sends before delivering `session_start` is not covered.
- Whether a host tool selection entry that removes `Bash` from the default tools (`-Bash`)
  leaves it inactive is the host's.
- Whether a later descriptor duplication redirects stdout to another stream, and whether the
  pipe notice is omitted in that case, is unspecified.
- `shellPath` or `shellCommandPrefix` values that are not strings are unspecified.
- The header and the row's `resultPath` name `outputPath` even when the file could not be created
  or written.
- A relative `shellPath`, and one starting with `~` followed by a user name, are unspecified.
- The texts of pre-start rejections, beyond what Section 2 requires, and the `details` of a
  pre-start rejection and of a partial result are unspecified.
- Whether the host, when it validates against the schema of Section 1, first coerces an argument
  to the type the schema names, and so whether a convertible value of the wrong type is admitted
  rather than rejected as a schema rejection, is the host's.
