# pi-dent

A generic coding agent, built as a pi extension. Its consumer is the pi host, which loads `index.ts`.

This repository follows the dx repo standard.

## Read first

| Document                            | Holds, and when to read it                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/pi-extension-repo.md`         | Pi extension specifics: `file:` links into the pinned pi release, release-age exclusions, `pi.extensions`, jiti loading. Read before changing `package.json` dependencies or `pi.extensions`.                             |
| `docs/development.md`               | How UI extensions load, the UI surfaces they get, reference code. Read before touching extensions or widgets.                                                                                                             |
| `docs/concepts.md`                  | Non-normative map of how the key terms relate. Read before renaming or relating key terms; the specs decide.                                                                                                              |
| `docs/search.md`                    | Non-normative notes on how `Search` is built, why, and what it costs. Read before changing search.                                                                                                                        |
| `docs/script-sandboxing.md`         | The sandboxing research for the `Script` tool: options ruled out, the QuickJS-in-WASM recommendation, the engine gaps to verify, the Deno fallback. Read before speccing or changing the `Script` tool's execution model. |
| pi-dent-markdown `docs/markdown.md` | The `Markdown` tool's parser, the micromark pin, and how to lift it. Read before changing `Markdown`.                                                                                                                     |

## Commands

```sh
pnpm check        # the done-set: typecheck, lint, fmt:check, then test
pnpm test         # node --test --test-timeout=30000 test/
pnpm typecheck    # tsc --noEmit
pnpm lint         # oxlint .
pnpm fmt          # oxfmt . (rewrites files, Markdown included)
pnpm fmt:check    # oxfmt --check .
pi -ne -e ./      # run the agent with this repository's extensions only
```

## Rules

- pi-dent owns its identifiers: `pi-dent.conf`, `~/.pi/pi-dent/`, `PI_DENT_*`.
- One host: the pi extension. No embedded-host concepts.
- The entry is `index.ts`, registered under `pi.extensions` in `package.json`.
- Commit no absolute home path or user name: write `<absolute path of …>`. Only `package.json`'s
  publishing fields name the owner's account; `test/repo/no-personal-paths.test.ts` enforces it.
