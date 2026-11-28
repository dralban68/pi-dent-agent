# Live `Search` recall evaluation

Measures whether a model running pi with pi-dent reaches for `Search` to recall what an earlier session of the same project, or the current session before compaction, recorded. Run from a checkout with dependencies installed. This spends real provider quota.

```sh
node evals/search-recall/run.ts --extension /path/to/pi-dent-agent --models zai/glm-5.3-flash,antigravity/gemini-3.8-flash --repetitions 3
```

Options: `--extension` (default `.`), `--models` (comma list or `all`, parsed from `pi --list-models`; default `zai/glm-5.3-flash`), `--scenarios` (comma list of ids; default all), `--repetitions` (default 3), `--concurrency` (simultaneous runs **per provider**; default 2), `--timeout-ms` (per run; default 180000), `--output` (results file; its parent must exist), `--resume /absolute/path/results.json`, `--seed-model` (default `zai/glm-5.3-flash`), `--system-prompt <file>`.

Each invocation keeps its root below `$TMPDIR` (OS temporary directory fallback): seeds, one directory per run with cwd, sessions, stdout and stderr, and `results.json` by default. Remove the printed root when no longer needed.

## Setup

Runs use `pi -ne -e <extension> <provider extensions> -nc -ns -np --approve --session-dir <run>/sessions --model <m> --mode json -p <prompt>`, as in [agent-dispatch](../agent-dispatch/README.md): provider-registering npm entrypoints from pi settings load, other extensions, context files, skills and templates do not; the run's cwd is `<run>/cwd` beside `<run>/sessions` (so session files are not inside the cwd), with `.pi/pi-dent/pi-dent.conf` containing `{"plugins": []}` and `PI_DENT_*` databases and state in `<run>`. `--approve` trusts `<run>/cwd/.pi/settings.json`, which only P4 writes. Each cwd also holds `config.json` with `{"stagingPort": 7341}`.

Earlier sessions are real pi sessions. Once per invocation, `--seed-model` answers three one-turn prompts, each ending "Reply with OK only.", in a seed cwd: a distractor (`utils` renamed to `lib`), the port decision (7341, because 8080 collides with the VPN client) and the deploy fix (`ERR_LOCKFILE_STALE`, delete `.deploy/lock`). A seed run that does not produce exactly one session file fails the invocation. The three files are copied into every run's sessions directory before it starts, so they are project members of the run's session: membership depends only on lying in the same sessions directory, not on the header's cwd, and the seed cwd differs from every run's. A resume reuses the seeds.

`--system-prompt <file>` passes `--system-prompt <file>` to pi, which replaces the default system prompt with the file's contents the way a project's `.pi/SYSTEM.md` does, without depending on project trust. pi then leaves tool snippets and guidelines out, so the model sees only the tool descriptions and the file. Each run checks the session's system message preamble against the file and is unscored with `system prompt not applied` otherwise.

## Scenarios

| Id  | Kind                      | Prompt                                                                                     | Expected in final answer |
| --- | ------------------------- | ------------------------------------------------------------------------------------------ | ------------------------ |
| P1  | past, explicit            | Last time we settled which port the staging server listens on. Which port was it, and why? | `7341`                   |
| P2  | past, implicit            | Why is stagingPort 7341 in config.json rather than 8080?                                   | `VPN`, any case          |
| P3  | past, recurring           | The deploy script failed again with the same error as before. What fixed it last time?     | `.deploy/lock`           |
| P4  | current, after compaction | What exactly did that command print? Do not run it again.                                  | the run's token          |
| N1  | negative                  | Create hello.txt containing the word hi.                                                   | none                     |
| N2  | negative                  | Which port does config.json set for staging?                                               | `7341`                   |

P4 drives pi in RPC mode (`--mode rpc`). The harness writes a fresh random token to `<run>/token.txt`, outside the cwd. Turn 1 asks the model to `cat` that file and reply "done" without repeating it; the harness then deletes the file, so rerunning the command cannot recover the token. It sends `compact` with instructions to write one sentence and omit every identifier and command output; the run's `.pi/settings.json` sets `compaction.keepRecentTokens` to 0 so the whole history is summarized. Turn 2 is the prompt above. A summary containing the token makes the run unscored (`token survived compaction`), and turn 2 is not sent; so do a token in the entries the compaction keeps verbatim (`token kept after compaction`) and a turn 1 whose tool results never show the token (`turn 1 did not print the token`). For P4, only entries after the compaction are scored. Extension UI dialogs in RPC mode are answered as cancelled.

## Scoring

The run's own session file is parsed; tool calls are matched to results by call ID. Per run:

- `searchCalls`: each `Search` call's arguments, whether its result was an error, and the error text.
- `reachedProject`: a non-error `Search` call with `scope` `project` or `project-trees`, a `session`, `address` or `after` starting with `~`, or a `session` path starting with `/`.
- `searchedSelf`: a non-error `find` with `session` absent, empty or `self` and `scope` absent, `session` or `tree`.
- `answered`: the last assistant text contains the expected substring; `null` for N1.
- `bypass`: another tool's JSON arguments contain the run's sessions directory (as given, with symbolic links resolved, or `../sessions`), pi's default sessions directory (when the invocation root does not lie inside it), or `.jsonl`.
- `askedUser`: no tool call and not answered.
- `pass`: P1–P3 `reachedProject && answered`; P4 `searchedSelf && answered`; N1 no `Search` call; N2 no `Search` call and answered.

A non-null `reason` makes a run unscored: timeout, a provider error in an assistant message, nonzero exit, a missing session file, an unapplied system prompt, or a P4 reason above. After a model's first unscored run, its pending jobs are recorded unscored without running (`not attempted after unavailable run: ...`); the three P4 reasons are scenario outcomes and do not trigger this. The table has a row per model and scenario and a total per model: runs, pass, searched (any `Search` call) and answered over scored runs, bypass count, unscored count and reasons. `results.json` keeps every run's directory, session file, final text, token and compaction summary.

## Resume

Repeat the original options and add `--resume /absolute/path/results.json`. Completed jobs are not repeated; an in-flight job interrupted before checkpointing runs again. Extension, models, scenarios, repetitions, seed model and system prompt must match. Do not change the extension during an invocation or resume.

## Limits

`pass` measures reaching for `Search` and finding the fact, not answer quality. A model that finds the fact some other way (guessing, or a shell search that names neither the sessions directory nor `.jsonl`) answers without passing; `bypass` flags only reads that name the sessions directory or a `.jsonl` file. The seeds are three tiny sessions, so a search for nearly any word finds them; real projects hold many more. P4's compaction summary comes from the run's model and may ignore the instructions. Repetitions are small, correlated samples.

The harness is outside `pnpm check`; validate it with `pnpm exec oxlint evals` and `pnpm exec oxfmt --check evals`.
