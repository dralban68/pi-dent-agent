# Live Agent dispatch evaluation

Run from a checkout with dependencies installed. This spends real provider quota.

```sh
node evals/agent-dispatch/run.ts --extension "$PWD" --models all --scenarios 1,2,3,4,5,6,7,8,9 --repetitions 2 --concurrency 2
```

`--concurrency` limits simultaneous parents **per provider**, not globally. Children can add requests. Other options: `--child-model provider/id`, `--timeout-ms 120000`, `--output /absolute/path/results.json`. The output parent directory must exist. Defaults: one Haiku parent, all nine scenarios, three repetitions, two concurrent parents per provider. Model discovery parses `pi --list-models`; it is not a hard-coded inventory.

Each run retains its cwd, sessions, stdout and stderr below `$TMPDIR` (OS temporary directory fallback). The JSON output defaults there too. Remove the printed root directory when no longer needed. No credentials are read by the harness; pi uses existing authentication and model configuration.

Parents run `pi -ne -e <extension> -nc -ns -np --session-dir <isolated dir> --model <parent> --mode json -p <request>`. The requested extension and provider-registering entrypoints from installed npm packages in pi settings load; other package entrypoints, host context files, skills and templates are disabled. Discovery reads package manifests and selects entrypoints containing a direct `registerProvider(` call; wrappers that register indirectly need discovery support before evaluation. In the measured installation this selects only pi-antigravity's `src/index.ts`; pi-codegraph registers no provider. AMD comes from pi's model configuration, not an installed provider extension. Project configuration replaces the global plugin map with an array, intentionally producing a malformed-plugin diagnostic and suppressing global plugins. The project agent catalog contains `reviewer` and `summarizer`, both with brief, tool-free instructions. Existing global agent definitions, if present, remain visible. User provider settings remain in effect. Provider authentication and quota failures retain pi's own error text.

Scenarios are the exact strings in `run.ts`: ad-hoc with a model, ad-hoc without one, named summarizer, ad-hoc followed by continuation, named summarizer with a model, three-worker parallel fan-out, a bare model-name request, continuation on another model, and named-agent continuation. The alternate model defaults to `anthropic/claude-haiku-5-5` (`--alternate-model` overrides it). Children without a requested model inherit normal extension defaults. The default child is `deepseek/deepseek-flash`: direct probes returned `pong` in four of four requests, around one second each. DGX and ZAI also answered four of four; Haiku answered its one probe. These probes do not establish long-term availability.

## Resume interrupted work

Repeat the original options and add `--resume /absolute/path/results.json`. Completed job keys are not repeated. Atomic, serialized checkpoints preserve completed runs; an in-flight job interrupted before checkpointing runs again. Extension, model selection, scenarios, repetitions and child models must match. Do not change the extension build during an invocation or resume.

After a model's first unscored run, pending jobs for that model are recorded as unscored without executing. Up to two probes can already be in flight at concurrency two. This avoids repeated requests to unavailable or non-tool models. Skipped slots have an empty `dir` and retain the triggering reason. Totals count planned slots, not just launched processes.

## Reading results

Only parent transcript `Agent` calls are scored, matched by call ID to results. Schema and plan-resolution failures count as rejected; execution failures after dispatch do not count as argument rejection and remain in each call's error field. First-call and all-call fractions use scored runs as their denominators; unscored runs are separately counted and never pass. Timeout, parent error, nonzero exit, missing calls and missing results produce reasons. Raw evidence remains in each run directory. Rejected calls are grouped by exact error text.

`fieldsCorrect` checks every call: requested model is in `model`, named definition is exactly `summarizer` with no inline prompt, and ad-hoc calls have no named definition. Named continuation may omit the definition; `resumedAsSummarizer` checks result identities. `defaultCalls` and `implicitResumeCalls` count calls omitting both selectors (including rejected calls; inspect acceptance when counting successful reliance). `fanoutCalls` records the number of calls, not whether they were simultaneous. Unrequested model choices are unconstrained. Continuation has a separate `continued` flag; all-call acceptance alone does not prove the parent followed the continuation request. A background launch can be accepted before the child finishes. This measures tool argument acceptance, not task quality, child correctness or full instruction following. Repeated runs are small, correlated samples, not an estimate of production failure prevalence.

The harness is deliberately outside `pnpm check`; validate it with `pnpm exec oxlint evals`, `pnpm exec oxfmt --check evals`, and `pnpm exec tsc --noEmit`. The repository tsconfig does not include evals, so the last command checks only the existing project.
