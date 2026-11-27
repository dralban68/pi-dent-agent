# Live Agent dispatch evaluation

Run from a checkout with dependencies installed. This spends real provider quota.

```sh
node evals/agent-dispatch/run.ts --extension "$PWD" --models all --scenarios 1,2,3,4,5 --repetitions 3 --concurrency 2
```

`--concurrency` limits simultaneous parents **per provider**, not globally. Children can add requests. Other options: `--child-model provider/id`, `--timeout-ms 120000`, `--output /absolute/path/results.json`. The output parent directory must exist. Defaults: one Haiku parent, all five scenarios, three repetitions, two concurrent parents per provider. Model discovery parses `pi --list-models`; it is not a hard-coded inventory.

Each run retains its cwd, sessions, stdout and stderr below `$TMPDIR` (OS temporary directory fallback). The JSON output defaults there too. Remove the printed root directory when no longer needed. No credentials are read by the harness; pi uses existing authentication and model configuration.

Parents run `pi -ne -e <extension> -nc -ns -np --session-dir <isolated dir> --model <parent> --mode json -p <request>`. Only the requested extension loads; host context files, skills and templates are disabled. Project configuration replaces the global plugin map with an array, intentionally producing a malformed-plugin diagnostic and suppressing global plugins. The project agent catalog contains `reviewer` and `summarizer`, both with brief, tool-free instructions. Existing global agent definitions, if present, remain visible. User provider settings remain in effect. Provider extensions disabled by `-ne` are unavailable even if ordinary pi lists their models (notably antigravity); this is reported rather than silently loading extra extensions.

Scenarios are the exact strings in `run.ts`: ad-hoc with a model, ad-hoc without one, named summarizer, ad-hoc followed by continuation, named summarizer with a model. Children without a requested model inherit normal extension defaults. The default child is `deepseek/deepseek-flash`: direct probes returned `pong` in four of four requests, around one second each. DGX and ZAI also answered four of four; Haiku answered its one probe. These probes do not establish long-term availability.

## Reading results

Only parent transcript `Agent` calls are scored, matched by call ID to results. Schema and plan-resolution failures count as rejected; execution failures after dispatch do not count as argument rejection and remain in each call's error field. First-call and all-call fractions use scored runs as their denominators; unscored runs are separately counted and never pass. Timeout, parent error, nonzero exit, missing calls and missing results produce reasons. Raw evidence remains in each run directory. Rejected calls are grouped by exact error text.

`fieldsCorrect` checks every call: requested model is in `model`, named definition is exactly `summarizer` with no inline prompt, and ad-hoc calls have no named definition. Unrequested model choices are unconstrained. Continuation has a separate `continued` flag; all-call acceptance alone does not prove the parent followed the continuation request. A background launch can be accepted before the child finishes. This measures tool argument acceptance, not task quality, child correctness or full instruction following. Repeated runs are small, correlated samples, not an estimate of production failure prevalence.

The harness is deliberately outside `pnpm check`; validate it with `pnpm exec oxlint evals`, `pnpm exec oxfmt --check evals`, and `pnpm exec tsc --noEmit`. The repository tsconfig does not include evals, so the last command checks only the existing project.
