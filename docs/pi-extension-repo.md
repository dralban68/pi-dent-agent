# pi extension repositories

Non-normative. What a pi extension or library repository (pi-dent, pi-dent-terms, pi-dent-markdown, purse)
adds to the dx repo standard (`dx:repo-setup`). pi-dent's own manifest rules are in
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
  restart pi or `/reload` to load it.

## Running

- `pi -ne -e ./` from the repository root: `-ne` disables extension discovery, `-e ./` loads what
  `pi.extensions` lists, in order.
- Extension APIs, UI surfaces and reference code: [development.md](development.md).
