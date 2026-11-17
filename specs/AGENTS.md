# pi-dent specifications

Write and review specs per the `dx:writing-specs` skill. An implementation conforms when it
satisfies every MUST and MUST NOT. This file holds pi-dent's spec list and differences.

## Specs

Each file is `<name>.md`; a tool spec (`<name>-tool.md`) links its resource spec for the shape.

- Dispatch: `agent`, `agent-tool`
- Tasks: `task`, `task-record`, `task-registry`, `task-browser`, `task-tool`
- Sessions: `session-store`, `session-index`, `session-transcript`, `session-tool`
- Skills and plugins: `skill`, `skill-tool`, `plugin`, `plugin-tool`, `package`
- Tools: `bash-tool`, `script-tool`, `search-tool`, `fleet-tool`, `schedule-tool`, `ask-user-question-tool`
- Other: `tool-card`, `footer`, `slash-commands`, `browser-navigation`, `model-string`, `model-guidance`, `billing`
- Configuration: `config-file`

## Differences

- Identifiers are pi-dent's own: `pi-dent.conf`, `~/.pi/pi-dent/`, `PI_DENT_*`.
- Root configuration keys go into `config-file.md`, the only configuration spec. Its Section 2 owns
  the unknown-key policy.
- A length in characters counts UTF-16 code units unless the spec names another unit; a duration
  in whole seconds rounds down.
- Lexicographic and ascending ASCII order compare strings by UTF-16 code unit, unless the spec
  names another collation.
- A tool spec also registers `renderShell` where set.
- Nothing-silent exemption: a spec may leave a skip or failure unreported when its text says so
  outright ("no failure is reported", "without a diagnostic") and the case is: a malformed or
  unreadable line, record or file met while scanning stored data (session files, task records, the
  session index); a failed side write that does not carry the result (task record, output file,
  session temporary folder, agent directory); a failed widget update, host `notify` call, or
  periodic feed, sweep or prune; a billing query outcome; a wrong-typed optional manifest or
  frontmatter field; a dangling symbolic link, an invalid basename, or an unreadable or uncontained
  plugin command file in discovery; a bounded buffer dropping its oldest entries.
- `../docs/concepts.md` is non-normative; a change to a key term or its relationships updates it.

## Terms

The term registry is `../.pi/pi-dent/terms.yaml`, kept with the `Terms` tool.
