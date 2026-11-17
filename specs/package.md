# Package specification

This document specifies the pi-dent package: the manifest that declares which extensions the host
loads, and the bundled extensions installed with pi-dent. Each bundled extension is owned by its
own package; only its membership and entry path are specified here.

## 1. Package manifest

The package name is `pi-dent-agent`. The `pi` key of `package.json` holds the package manifest, whose
`extensions` array is the entry list of Section 2.

- The manifest MUST declare exactly the entries of Section 2, in listed order.
- Every entry MUST be a relative path from the package root resolving to an installed dependency
  file, except `./index.ts`.
- A bundled extension is an entry of Section 2 other than order 1. Each bundled extension MUST
  be listed in `dependencies` under the package name in its entry path, with an exact version.
- The published package MUST list every bundled extension in `bundleDependencies`, each at an
  exact version, so that its entry path resolves under the package's own `node_modules` after an
  npm install.
- `dependencies` MUST NOT contain `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, or `typebox`. Each MUST be a
  `peerDependencies` entry with value `*`.
- Packages importable by name from `Script` ([script-tool.md](script-tool.md), Section 3), and
  `jiti`, MUST be dependencies, never devDependencies.

> Note (non-normative): the host installs the package with its development dependencies omitted.

## 2. Entry list

| Order | Extension          | Entry                                            |
| ----- | ------------------ | ------------------------------------------------ |
| 1     | pi-dent            | `./index.ts`                                     |
| 2     | pi-dent-purse      | `./node_modules/pi-dent-purse/index.ts`          |
| 3     | pi-dent-terms      | `./node_modules/pi-dent-terms/index.ts`          |
| 4     | pi-mcp-adapter     | `./node_modules/pi-mcp-adapter/index.ts`         |
| 5     | pi-anthropic-oauth | `./node_modules/pi-anthropic-oauth/src/index.ts` |
| 6     | pi-web-access      | `./node_modules/pi-web-access/dist/index.js`     |

## 3. Installation

- One installation of the package, and one entry for it in the host's package list, loads every
  entry of Section 2 and no further extension of its own.
- The host loads each entry as a separate extension, with its own factory call and tools.
- Installed under a `node_modules` directory, where Node refuses to strip TypeScript types, every
  worker thread the package or its library dependencies start MUST still load its TypeScript
  modules, with the types stripped as Node strips them elsewhere.

## 4. Bundled extensions

- A bundled extension MUST be loaded from its own entry of Section 2, never imported by another
  entry.
- The bundled extension set MUST be exactly the entries of Section 2 other than order 1.
- A bundled extension MUST NOT register a tool name or command name registered by another entry
  of Section 2.
- A library imported by an entry, such as `pi-dent-markdown`, MUST be a `dependencies` entry and
  MUST NOT have a row in Section 2 or a `pi.extensions` entry.

## 5. Specification gaps

The behavior of `pi update --extensions` on the package's dependencies is not specified, and
neither is the effect of a bundled extension failing to load on the remaining entries.
