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

## 5. Local links

A local link is a symbolic link `node_modules/<name>` under the package root that points at a
development checkout of the package `<name>`, in place of its installed version. Local links are
declared in the file `.local-links` in the package root. The repository MUST ignore `.local-links`
in git, and nothing in this section writes a file outside `node_modules/`.

### 5.1 File format

`.local-links` is UTF-8 text read line by line; a line ends at LF or CRLF. Each line is trimmed of
leading and trailing whitespace. An empty line and a line starting with `#` declare nothing. Every
other line declares one local link as `<name>=<path>`, split at its first `=`, both sides trimmed.

The file is invalid when it cannot be read or a line fails a check below. Lines are checked in file
order, each against the checks in listed order; the first failure gives the file's error message,
where `<n>` is the 1-based line number.

| Check                                                                                      | Error message                                                                      |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| The file exists and cannot be read                                                         | `.local-links: <the host's error message>`                                         |
| The line has no `=`, `<path>` is empty, or `<name>` is not an npm package name (see below) | `.local-links line <n>: expected <package name>=<absolute path>`                   |
| An earlier line declares the same `<name>`                                                 | `.local-links line <n>: duplicate package <name>`                                  |
| `<path>` is not an absolute path                                                           | `.local-links line <n>: path is not absolute: <path>`                              |
| `<path>` is not a directory holding a `package.json` whose `name` is the string `<name>`   | `.local-links line <n>: <path> is not a directory whose package.json names <name>` |

An npm package name here matches `^(@[a-z0-9~-][a-z0-9._~-]*/)?[a-z0-9~-][a-z0-9._~-]*$`.

A local link is in place when `node_modules/<name>` and `<path>` resolve, symbolic links followed,
to the same existing directory.

### 5.2 Link script

`node scripts/link-local.ts`, run from any directory, acts on the package root that holds it. The
`prepare` script of `package.json` MUST be exactly that command.

- No `.local-links`: it MUST print nothing, change nothing, and exit with status 0.
- Invalid file: it MUST write `link-local: <error message>` and a newline to standard error, exit
  with status 1, and create or remove nothing, whichever line is at fault.
- Otherwise, for each declared link in file order: when the link is in place it MUST print
  `already linked <name> -> <path>` to standard output and leave it unchanged; when not, it MUST
  remove whatever is at `node_modules/<name>` (a symbolic link itself, never its target), create
  missing parent directories, create there a symbolic link to `<path>` as written, and print
  `linked <name> -> <path>`. Each line ends with a newline. It exits with status 0.
- A filesystem operation that fails MUST end the script with a non-zero status and the host's
  error on standard error; links made before it stay.

### 5.3 Load-time check

Each time the host calls the factory of `./index.ts`, pi-dent checks the `.local-links` of its own
package root and reports the outcome as a host UI notification of the level below, the message
prefixed `pi-dent: `. A notification raised while no session is open MUST be shown at the next
`session_start`.

| Case                                   | Level     | Message                                                                                                             |
| -------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| No `.local-links`, or no link declared | none      | none                                                                                                                |
| Invalid file                           | `warning` | `local links: <error message>; correct .local-links, then run node scripts/link-local.ts`                           |
| A declared link is not in place        | `warning` | `local link <name> is not in place: node_modules/<name> does not resolve to <path>; run node scripts/link-local.ts` |
| Every declared link is in place        | `info`    | `local links in use: <names>`                                                                                       |

The not-in-place warning is raised once per such link, in file order, and the info message is then
omitted. `<names>` is the declared names in file order, joined by `, `. The check MUST NOT create
or change a link.

> Note (non-normative): a package manager command can reset a link to the installed version
> without running `prepare`, so the load-time check is what tells the user.

## 6. Specification gaps

The behavior of `pi update --extensions` on the package's dependencies is not specified, and
neither is the effect of a bundled extension failing to load on the remaining entries.
