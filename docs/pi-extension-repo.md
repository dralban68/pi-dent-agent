# pi extension repositories

Non-normative. What a pi extension or library repository (pi-dent, pi-dent-terms, pi-dent-web-fetch, pi-dent-web-search, pi-dent-markdown, pi-dent-purse)
adds to the dev repo standard (`dev:repo-setup`). pi-dent's own manifest rules are in
[specs/package.md](../specs/package.md).

## Pinned pi release

- Every `@earendil-works/*` package is a `devDependencies` entry at the exact version of the pi
  release, `typebox` at the version that release ships, and each is a `peerDependencies` entry `*`.
  The repository compiles against that release; at run time the host supplies them.
- `pnpm-workspace.yaml` `minimumReleaseAgeExclude` lists each `@earendil-works/*` package of that
  release as `<name>@<version>`, so pnpm's release-age gate does not block a fresh pi release.
- Moving to another pi release: bump those versions in `package.json`, update the
  `minimumReleaseAgeExclude` entries, run `pnpm install`, then `pnpm check`. Move all sibling
  repositories together.

## Loading

- pi loads `.ts` sources directly through jiti: no build step, imports carry `.ts`.
- An extension lists its entries in `package.json` → `pi.extensions`. An entry not listed there is
  never loaded. A library has no `pi.extensions`: its consumer imports it and registers what it
  exports.
- A sibling package is consumed from npm at an exact version. pi-dent loads bundled extensions
  from `./node_modules/<package>/…` entries and imports libraries; it never imports an extension
  entry ([specs/package.md](../specs/package.md), Section 4).
- After changing a sibling, publish it, bump its version in the consumer and run `pnpm install`;
  restart pi or `/reload` to load it. To try the change before publishing, use a local link.

## Local links

Rules: [specs/package.md](../specs/package.md), Section 5.

- Create `.local-links` in the consumer's root (gitignored), one `<package name>=<absolute path>`
  per line, for example `pi-dent-terms=<absolute path of the pi-dent-terms checkout>`; `#` starts a comment line.
  Run `node scripts/link-local.ts`: `node_modules/<name>` becomes a symlink to the checkout, and
  edits there are live after `/reload`. Nothing committable changes: no `package.json`,
  `pnpm-workspace.yaml` or lockfile entry.
- To go back to the published version, delete the line (or the file) and run `pnpm install --force`.
- Measured with pnpm 12.18.0: a `pnpm install` that changes something resets the symlink to the
  published version and then runs `prepare`, which links again; a no-op install keeps the symlink
  and does not run `prepare`; `pnpm add` and `pnpm remove` reset it and do not run `prepare`.
  For that last case pi-dent warns at load when a declared link is not in place, and shows
  `local links in use: …` when all are.
- A linked package resolves `@earendil-works/*` and `typebox` from its own `node_modules`, not
  the consumer's: run `pnpm install` in the sibling checkout, on the same pinned pi release.
- `scripts/pack.ts` installs the bundled extensions from npm into a staged copy, so a local link
  never reaches the packed tarball.

## Running

- `pi -ne -e ./` from the repository root: `-ne` disables extension discovery, `-e ./` loads what
  `pi.extensions` lists, in order.
- Extension APIs, UI surfaces and reference code: [development.md](development.md).
