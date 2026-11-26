# A sample `pi-dent.conf`

A complete `pi-dent.conf` covering every root key; read it when writing yours. The format, layers,
merge, diagnostics, and `${…}` substitution are specified in
[specs/config-file.md](../specs/config-file.md); the table of root keys and the layer paths are
in the [README](../README.md#configure-pi-dent-in-pi).

```jsonc
// ~/.pi/pi-dent/pi-dent.conf — the global layer; machine-wide values.
// JSONC: comments and trailing commas allowed. The root must be an object.
{
  // Named classes usable inside any model string ("fast", "fast:high").
  // A value is a concrete provider-qualified model, never a class (no chaining).
  // "fallback" is a reserved class name (specs/model-string.md, Section 4.3).
  "modelClasses": {
    "fast": "deepseek/deepseek-flash",
    "review": { "provider": "anthropic", "id": "claude-opus-5-5", "thinking": "high" },
  },

  // Which model to dispatch to when, and rules injected into matching sessions
  // (specs/model-guidance.md, Section 1). Keys are concrete provider/id strings,
  // with an optional thinking level; a keyed level guides that level only.
  "modelGuidance": {
    "models": {
      "deepseek/deepseek-flash": { "when": "well-specified implementation and tests" },
      "anthropic/claude-opus-5-5:high": { "when": "design and code review" },
    },
    "rules": [{ "match": "flash|haiku", "rule": "verify its output before relying on it" }],
    // "billing": false disables usage billing (specs/billing.md).
  },

  // Liveness deadlines for an Agent dispatch, in milliseconds, 0–2147483647;
  // 0 disables. Environment PI_DENT_AGENT_IDLE_TIMEOUT_MS and
  // PI_DENT_AGENT_ABSOLUTE_TIMEOUT_MS override these (specs/agent-tool.md, Section 4.2).
  "agentLiveness": { "idleTimeoutMs": 600000, "absoluteTimeoutMs": 3600000 },

  // Prompt overrides for entries of the agent catalog, by name or
  // "namespace:name" (specs/agent.md, Section 2).
  "agents": {
    "reviewer": { "prompt": "Review the change and report only real defects." },
  },

  // Plugin directories; a relative path resolves against the directory of the
  // layer that declares it (specs/plugin.md, Section 4).
  "plugins": {
    "site": { "path": "./tools/site" },
  },

  // The key that opens the task browser; default "shift+right"
  // (specs/task-browser.md, Section 1.1).
  "taskBrowser": { "shortcut": "ctrl+t" },

  // Whether pi-dent draws the footer; default true (specs/footer.md, Section 1.1).
  "footer": { "enabled": true },

  // The model /recap uses; a model string (specs/model-string.md, Sections 1–2).
  "recapModel": "zai/glm-5.3-flash",

  // The terms extension's settings (pi-dent-terms, specs/terms-tool.md, Section 4.2).
  "terms": { "checkAfterEdit": true },

  // The web extension's settings (pi-dent-web-fetch, specs/web-fetch.md, Section 8). `cache` is
  // "project" (default, <cwd>/.pi/web-cache), "session" or a folder; PI_DENT_WEB_CACHE_DIR overrides it.
  "web": { "reformat": false, "reformatModel": "fast", "cache": ".cache" },

  // The search extension's settings (pi-dent-web-search, specs/web-search.md, Section 7). API keys
  // fall back to EXA_API_KEY, PERPLEXITY_API_KEY, BRAVE_API_KEY and GEMINI_API_KEY.
  "webSearch": {
    "backend": "auto",
    "order": ["exa", "perplexity", "brave", "google", "duckduckgo"],
  },
}
```

A value can use `${env.NAME}` for an environment variable and `${project.root}` for the working
directory of the boot read; `$$` writes a literal `$`. An undefined variable produces a
diagnostic and the value is absent, so a lower layer's value can stand in
([specs/config-file.md](../specs/config-file.md), Section 7).

`<repo>/.pi/pi-dent/pi-dent.conf` is the project layer and wins every conflict; put what only one
repository needs there, and keep the rest here. The layer directories also hold `agents/` and
`skills/` folders. Diagnostics appear once per boot as `pi-dent: …` notifications; configuration
changes take effect at the next boot or `/reload`, never mid-window
([specs/config-file.md](../specs/config-file.md), Sections 5–6).

## The configuration pi-dent is developed with

The real files this repository is developed with, as of this writing. The global layer carries
what every project on the machine shares; the project layer overrides the `dx` plugin's path
with one relative to its own layer directory, because the layers merge deeply and the project
layer wins every conflict.

`~/.pi/pi-dent/pi-dent.conf`:

```jsonc
{
  // Plugins: shared skills, commands, scripts (plugin.md Section 4).
  "plugins": {
    "dx": { "path": "~/.pi/agent/npm/node_modules/pi-dent-skills" },
  },
  // Model guidance: which models an Agent call may name, and when to pick each.
  // The dispatcher sees these sorted by model id, so each `when` must stand alone.
  "modelGuidance": {
    "models": {
      "anthropic/claude-fable-5-2": {
        "when": "Use for design docs, specifications, and debugging that two implementation attempts already failed to fix.",
      },
      "anthropic/claude-opus-5-5": {
        "when": "Use to review, critique, or verify work another model produced; do not dispatch first-pass implementation here.",
      },
      "anthropic/claude-haiku-5-5": {
        "when": "Use for implementation, refactors, tests, and doc edits when zai/glm-5.3-flash and deepseek/deepseek-flash are unavailable or their attempts failed, and for the implementers beyond the first two of a parallel batch. Alternate with openai-codex/gpt-6-luna from one dispatch to the next so that neither allowance runs out.",
      },
      "amd/DeepSeek-V4.1-Flash": {
        "when": "Use for implementation when zai/glm-5.3-flash, deepseek/deepseek-flash, anthropic/claude-haiku-5-5 and openai-codex/gpt-6-luna are all unavailable. Dispatch at most 2 agents in parallel to it: it is rate limited.",
      },
      "deepseek/deepseek-flash": {
        "when": "Use for implementation, refactors, tests, and doc edits of well-specified tasks as the second implementer of a parallel batch beside zai/glm-5.3-flash, when zai/glm-5.3-flash is unavailable, and for a second attempt on a task where its attempt failed once.",
      },
      "dgx/deepseek-v4-flash": {
        "when": "Slow and free. Use for jobs of low value or low urgency that can run in the background while other work goes on, and for implementation when every other implementation model is unavailable. Do not use it for work that blocks the user. Dispatch at most 2 agents in parallel to it, and merge small edits into one call instead of many.",
      },
      "openai-codex/gpt-6-astra": {
        "when": "Use for a second opinion on work another model produced, and for hard problems earlier attempts failed to solve.",
      },
      "openai-codex/gpt-6.1-sol": {
        "when": "Use as the developer: design and build end to end a feature that still needs design. Do not use it for work a written spec already decides: that goes to an implementer. Its allowance is limited, so run at most one at a time unless the user asks for more.",
      },
      "openai-codex/gpt-6-luna": {
        "when": "Use for implementation of well-specified tasks (refactors, tests, and doc edits) when zai/glm-5.3-flash and deepseek/deepseek-flash are unavailable or their attempts failed, and for the implementers beyond the first two of a parallel batch. Alternate with anthropic/claude-haiku-5-5 from one dispatch to the next so that neither allowance runs out.",
      },
      "zai/glm-5.3": {
        "when": "Use for implementation that is well specified but too large or intricate for a flash-class implementer (many files, concurrency, a subtle refactor), and to redo a task two flash-class attempts failed. Do not use it for mechanical edits.",
      },
      "zai/glm-5.3-flash": {
        "when": "Use as the default implementer: the first choice for implementation, refactors, tests, and doc edits of well-specified tasks.",
      },
    },
    "rules": [
      {
        "match": "^google/gemini-4-",
        "rule": "You are billed per token from a small fixed budget.",
      },
    ],
  },
}
```

`<repo>/.pi/pi-dent/pi-dent.conf`:

```jsonc
{
  "plugins": {
    "dx": {
      // relative to this layer directory (.pi/pi-dent/): the repository's devDependency pi-dent-skills
      "path": "../../node_modules/pi-dent-skills",
    },
  },
}
```
