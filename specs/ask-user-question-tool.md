# `AskUserQuestion` tool specification

This document specifies the `AskUserQuestion` tool: the surface through which the model of a main
session asks the user one to four multiple-choice questions during an agent run and receives the
answers as the tool result. A call registers no task row ([task.md](task.md), Section 1); `Task`
neither lists nor cancels it. A call is open from its start until it returns.

## 1. Tool registration surface

The extension MUST register the tool in the main session through the host `registerTool` API,
when the extension loads and in every run mode:

| Field           | Value                                  |
| --------------- | -------------------------------------- |
| `name`          | `"AskUserQuestion"`                    |
| `label`         | `"AskUserQuestion"`                    |
| `exposure`      | `"model-only"`                         |
| `description`   | The text of Section 1.3                |
| `promptSnippet` | The text of Section 1.3                |
| `parameters`    | The parameter schema of Section 1.1    |
| `renderShell`   | not set: the host's default tool shell |

`exposure` `"model-only"` declares the tool to the model while it is active and makes it
uncallable from another tool through the host's nested tool calls. A child session never binds
the tool ([agent-tool.md](agent-tool.md), Section 3.1).

> Note (non-normative): a child session has no terminal of its own; the child returns what it
> needs decided in its final answer, and the session that dispatched it asks.

### 1.1 Parameter schema

The parameter schema is a JSON object schema; every object in it has `additionalProperties: false`.

| Field                               | Type     | Contract                                                           |
| ----------------------------------- | -------- | ------------------------------------------------------------------ |
| `questions`                         | object[] | Required. The questions, in the order they are shown and answered. |
| `questions[].question`              | string   | Required. The question text.                                       |
| `questions[].header`                | string   | Required. A short label naming the question.                       |
| `questions[].options`               | object[] | Required. The options the user chooses from, in display order.     |
| `questions[].options[].label`       | string   | Required. The option's name, returned when the user chooses it.    |
| `questions[].options[].description` | string   | Required. What choosing the option means.                          |
| `questions[].multiSelect`           | boolean? | `true` lets the user choose several options. Default `false`.      |

The schema constrains types and admitted properties only. The host validates arguments against it
before execution and rejects a violation with its own error text ([task.md](task.md), Section 1).
Every string of the call is used with leading and trailing white space removed, in the checks of
Section 1.2, in the question panel, in the dialogs, and in the result; the trimmed string is the
field's value below. `<i>` is a question's 1-based position in `questions`, `<m>` the number of
questions, `<j>` an option's 1-based position in its question's `options`, and `<n>` the
question's option count. A string is one line when it contains neither a line feed nor a carriage
return.

### 1.2 Validation

Execution-time validation MUST reject the call as a tool error (`isError: true`) whose text is the
error text of the first failing check, with `details` `{ outcome: "invalid", answers: [] }`, before
anything is shown to the user. Check 1 runs first; then, for each question in array order, checks
2 to 6, then checks 7 to 11 for each of its options in array order, then check 12, before the next
question.

| #   | Check                                                                                                                    | Error text                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | `questions` holds fewer than 1 or more than 4 items                                                                      | `questions must hold 1 to 4 questions`                                     |
| 2   | `question` is empty                                                                                                      | `question <i>: question must be a non-empty string`                        |
| 3   | `question` is not one line                                                                                               | `question <i>: question must be one line`                                  |
| 4   | `header` is empty                                                                                                        | `question <i>: header must be a non-empty string`                          |
| 5   | `header` is not one line or is longer than 12 characters                                                                 | `question <i>: header must be one line of at most 12 characters`           |
| 6   | `options` holds fewer than 2 or more than 4 items                                                                        | `question <i>: options must hold 2 to 4 options`                           |
| 7   | `label` is empty                                                                                                         | `question <i> option <j>: label must be a non-empty string`                |
| 8   | `label` is not one line or is longer than 60 characters                                                                  | `question <i> option <j>: label must be one line of at most 60 characters` |
| 9   | `label` equals `other`, compared case-insensitively                                                                      | `question <i> option <j>: label "Other" is reserved`                       |
| 10  | `label` equals the `label` of an earlier option of the same question, compared exactly after the cleaning of Section 3.3 | `question <i> option <j>: duplicate label "<label>"`                       |
| 11  | `description` is empty or not one line                                                                                   | `question <i> option <j>: description must be a non-empty single line`     |
| 12  | `question` equals the `question` of an earlier question of the call, compared exactly                                    | `question <i>: duplicate question`                                         |

### 1.3 Prompt texts

Each text of this section MUST be registered verbatim; a model reads them to choose and fill a
call.

The `description` is

```text
Ask the user 1 to 4 multiple-choice questions and wait for the answers, instead of ending your turn to ask in prose. Use it when a decision only the user can make blocks your work: a requirement, a preference, or a choice between approaches. Each question has a short header, 2 to 4 options with a label and a description, and multiSelect to allow several options. The user can always answer in their own words instead; do not add an "Other" option. The result lists each answer by question number, as options chosen or as free text.
```

The `promptSnippet` is

```text
Ask the user multiple-choice questions and wait for the answers
```

Each schema property carries this `description`:

| Field                               | `description`                                                        |
| ----------------------------------- | -------------------------------------------------------------------- |
| `questions`                         | `1 to 4 questions, asked together.`                                  |
| `questions[].question`              | `The question, one line, ending with a question mark.`               |
| `questions[].header`                | `A label of at most 12 characters naming the question, e.g. "Auth".` |
| `questions[].options`               | `2 to 4 distinct options; "Other" is added automatically.`           |
| `questions[].options[].label`       | `The option, 1 to 5 words, at most 60 characters.`                   |
| `questions[].options[].description` | `One line on what choosing this option means.`                       |
| `questions[].multiSelect`           | `true lets the user choose several options. Default false.`          |

### 1.4 Activation

A main session is a user session when the host reports a user interface for it, and an agent
session otherwise ([session-tool.md](session-tool.md), Section 3). At every `session_start`,
before the session's first model request, the extension MUST:

- in an agent session, remove `AskUserQuestion` from the session's active tool set through the
  host's active-tool API, leaving every other tool's activity unchanged, so that the tool is not
  declared to the model;
- in a user session, leave the tool's activity as the host set it.

The run mode is fixed for the process, so every `session_start` of a process, a reload's included,
decides the same. A call that reaches an agent session all the same — the tool made active again
by the user or another extension — MUST return the no-UI result (Section 6.2) after validation,
showing nothing.

## 2. Asking

After validation passes, in this order:

1. In a session without a user interface, the call MUST return the no-UI result.
2. When the tool-call signal is already aborted, the call MUST return the aborted result.
3. Otherwise the call joins the session's question queue.

The tool-call signal ([task.md](task.md), Section 5) aborts when the agent run is aborted. The question queue holds a session's open calls that passed step 2, in
the order they reached step 3. Only the first call of the queue is asked; the next call MUST be
asked when the earlier call returns. A call leaves the queue when it returns. A call is asked
through the question panel (Section 3) in terminal mode. In RPC mode it is asked through the
question form request (Section 4.4) when the environment variable `PI_DENT_ASK_FORM` of the pi process
is `1`, and through the dialog sequence (Section 4) otherwise.

A question has no timeout: an open call waits until the user answers or declines, or until
Section 5 ends it.

> Note (non-normative): a `Bash` or `Script` timeout guards against a process that hangs; a
> question waits for a person, and expiring it would answer for them or discard what they typed.

### 2.1 Answers

A question's answer consists of its chosen options and its free-text answer, the text the user
wrote in place of an option; each part can be empty.

- A single-select question (`multiSelect` not `true`) is answered when exactly one option is chosen
  or its free-text answer is present; choosing an option removes the free-text answer, and
  recording a free-text answer un-chooses the option.
- A multi-select question is answered when at least one option is chosen or its free-text answer
  is present; both parts can be present together.

A free-text answer is recorded from the text the user entered with every carriage-return–line-feed
pair replaced by a line feed and leading and trailing white space removed; empty text records none.

A question's answer summary is the chosen options' labels in option order joined by `, `,
followed, when the free-text answer is present, by `, ` when an option is chosen, then `"`, the
free-text answer's first line, ` …` when it has more lines, and `"`.

A call is direct when it has exactly one question and that question is single-select.

## 3. Question panel

The question panel is the interactive view through which the user answers one call in terminal
mode. The panel is drawn inside a border, and its size is fixed while it is open. It MUST be shown
through the host custom UI surface as an overlay centred in the terminal, as wide as the panel and
with the largest page height of Section 3.1 as its maximum height, and with the host's
blocked-on-user report of kind `question` and message
`The agent is asking you a question` for as long as it is open. It MUST take keyboard focus when it
opens and consume all input while it is open. It is not a browser
([browser-navigation.md](browser-navigation.md)): it is not on the browser stack and answers none
of the navigation keys. When it opens while a browser is open it is drawn above that browser;
when it closes, input MUST return to the top browser, else to the editor, whose text is
unchanged.

### 3.1 Size and border

With `W` the terminal width in columns when the panel opens, the panel's width is
`min(100, max(40, W − 4), W)` columns: 100 columns or the terminal width minus 4, whichever is
smaller, but at least 40, and never more than the terminal width. The width is fixed while the
panel is open, and the panel's inner width is its width minus 2 columns.

The panel's height is fixed while the panel is open: it is computed when the panel opens and again
only when the terminal rows change, as the smaller of the largest page height and the terminal
rows minus 2, and never fewer than 3 lines. The largest page height is 2 border lines, plus the
tab bar's lines when the call is not direct, plus the largest page body, plus the lines of the
longest key-hint line of Section 3.3, every line count measured at the inner width. A question
page's body is, in lines: its `question` text at the inner width, plus 1 empty line, plus for each
option the lines of its row as Section 3.3 renders it — the 2 columns before its number,
`<number>. `, `[ ] ` when the question is multi-select, and its `label` — plus the lines of its
`description` indented by 5 columns, plus 1 line for the Other row, plus 5 lines of text entry —
one empty line, the line `Your answer:`, and 3 editor lines — which every question page counts
because text entry can open on it. The Submit tab's body is, in lines: 1 for `Review your
answers`, 1 empty line, 1 per question, 1 empty line, and the lines of the submit line, counted
for the longer of `Press enter to submit.` and `Unanswered: <headers>`.

The panel is drawn with the box-drawing characters `┌` `─` `┐` `│` `└` `┘` in the renderer's
border color: the top border is `┌─ Question `, then `─` repeated to fill the row, then `┐`; the
bottom border is `└`, then `─` repeated for the inner width, then `┘`; and every content line is
`│`, the line at the inner width, then `│`. When the current page's body is taller than the body
area, the top border carries the indicator — a space, `▲▼`, and a space — at its right end in
place of 4 columns of the fill. A panel too narrow for the indicator drops it; one too narrow for
the title as well has the top border `┌`, then `─` repeated for the inner width, then `┐`.

The body area is the panel's height minus the 2 border lines, the tab bar's lines, and the current
key-hint line's lines, and never fewer than 0. A page shorter than the body area is padded with
empty lines after its last line, so that the tab bar is the first content line and the key-hint
line is the last. A page body taller than the body area scrolls: it starts at the smallest line
offset that shows the highlighted row's lines, its description line included, inside the body
area; when those lines alone are taller than the body area, the body starts at the row's first
line. On the Submit tab the body does not scroll and starts at its first line. The tab bar and
the key-hint line never scroll. When the tab bar and the key-hint line alone do not fit the
panel, the lines beyond the panel's height are dropped from the bottom.

### 3.2 Rows and tabs

A question's rows are its options in array order, numbered 1 to `<n>`, followed by the Other row,
numbered `<n>` + 1, through which the user writes a free-text answer.

A direct call has one page, the question page of its question. Every other call has one tab per
question, in array order, followed by the Submit tab; the panel opens on the first question's
tab. The tab order is cyclic: the tab after the Submit tab is the first question's, and before the
first question's is the Submit tab.

Each question has one highlighted row, initially row 1, kept while the panel is open.

### 3.3 Panel content

Colors and emphasis are the renderer's own; the text of this section is normative. Every value of
the call and every free-text answer MUST have ANSI escape sequences and control characters other
than the line feed removed before it is shown. A line longer than the inner width wraps, except
the Other row and the Submit tab's question lines, which are cut to the inner width with `…`
(U+2026) as their last column.

Inside the border, from top to bottom, the panel shows:

1. A call that is not direct: the tab bar, one line of tabs separated by two spaces. A question's
   tab is `■ <header>` when the question is answered, else `□ <header>`; the last tab is
   `Submit`. The current tab is highlighted.
2. On a question tab, or for a direct call: the question page.
   - The `question` text, then an empty line.
   - Each row: the prefix `> ` on the highlighted row and two spaces on any other, then
     `<number>. `, then, for a multi-select question, `[x] ` when the row's part of the answer is
     present and `[ ] ` when it is not, then the row text. An option row's text is its `label`,
     followed by a line holding its `description`, indented by 5 columns. The Other row's text is
     `Other: type your own answer` without a free-text answer, else `Other: <first line>`, the
     free-text answer's first line.
   - In text entry (Section 3.5): an empty line, the line `Your answer:`, and 3 lines of the host's
     editor component.
3. On the Submit tab: the line `Review your answers`, an empty line, one line per question in
   array order, `<header>: <summary>` with its answer summary or `(unanswered)`, an empty line,
   then `Press enter to submit.` when every question is answered, else `Unanswered: <headers>`, the
   headers of the unanswered questions in array order joined by `, `.
4. The key-hint line, the first that applies:

| Page                                      | Key-hint line                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| dismissal armed (Section 3.6)             | `Dismiss the questions? s skip, the agent continues · x stop the agent run · esc back` |
| text entry                                | `enter save · esc back`                                                                |
| Submit tab                                | `enter submit · tab/←→ question · esc dismiss`                                         |
| question page of a direct call            | `↑↓ move · enter choose · esc dismiss`                                                 |
| question page of a single-select question | `↑↓ move · enter choose · tab/←→ question · esc dismiss`                               |
| question page of a multi-select question  | `↑↓ move · space toggle · tab/←→ question · esc dismiss`                               |

### 3.4 Keys

Outside text entry and while dismissal is not armed, the panel MUST answer these keys and ignore
every other key:

| Key                 | Question page                                                                   | Submit tab                                                          |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `up`, `k`           | Highlight the previous row; on row 1, nothing.                                  | Nothing.                                                            |
| `down`, `j`         | Highlight the next row; on the Other row, nothing.                              | Nothing.                                                            |
| `1` to `9`          | When a row has that number, highlight it and act as `enter`; otherwise nothing. | Nothing.                                                            |
| `enter`, `space`    | Act on the highlighted row (below).                                             | Submit the call when every question is answered; otherwise nothing. |
| `tab`, `right`      | Move to the next tab; a direct call does nothing.                               | Move to the next tab.                                               |
| `shift+tab`, `left` | Move to the previous tab; a direct call does nothing.                           | Move to the previous tab.                                           |
| `escape`            | Arm dismissal (Section 3.6).                                                    | Arm dismissal.                                                      |

Acting on the highlighted row:

- An option row of a single-select question chooses that option, then advances.
- An option row of a multi-select question toggles whether that option is chosen; the page stays.
- The Other row starts text entry.

Advancing submits a direct call; otherwise it moves to the next tab. Submitting returns the
answered result (Section 6.1) built from the answers at that moment and closes the panel.

> Note (non-normative): `left` moves between tabs and never dismisses, unlike a browser's `left`,
> so that a stray arrow key cannot throw away the user's answers.

### 3.5 Text entry

Text entry edits the free-text answer of the current question in the host's editor component,
which opens holding the current free-text answer, or empty. The panel shows 3 lines of the editor:
when the editor renders more than 3, it shows the 3 rendered lines around the line holding the
editor's cursor mark — that line and up to 2 before it — and the editor's last 3 lines when no line
is marked, so that the editor's content scrolls inside the panel. While in text entry the panel
MUST pass every key to the editor except these:

- `escape` MUST leave text entry and leave the answer unchanged.
- The editor's submit key, `enter` unless the host's keybindings say otherwise, MUST leave text
  entry and record the editor's text as the free-text answer (Section 2.1). When it records none,
  any earlier free-text answer is removed, any chosen option stays, and the page stays. Otherwise,
  on a single-select question the panel then advances (Section 3.4); on a multi-select question the
  page stays.

### 3.6 Dismissal

`escape` outside text entry arms dismissal without changing any answer; the panel keeps its page
and shows the armed key-hint line of Section 3.3. While dismissal is armed:

- `s` MUST end the call with the dismissed result (Section 6.2): the user skips the questions and
  the agent continues its run.
- `x` MUST end the call with the stopped result: the user stops the agent run.
- `escape` MUST disarm dismissal.
- Any other key MUST disarm dismissal and be handled per Section 3.4.

## 4. Dialog sequence

The dialog sequence asks one call in RPC mode through the host's dialog methods: `select`, which
shows a title and a list of option strings and returns the string chosen or nothing when the user
cancels, and `input`, which shows a title and a placeholder and returns the text entered or
nothing when the user cancels. The extension MUST pass every dialog an abort signal that aborts
when the tool-call signal aborts or at `session_shutdown`, and MUST NOT pass a timeout. A value
a dialog returns that is not one of the option strings it was given MUST make the extension show
the same dialog again. Values of the call are cleaned as in Section 3.3.

### 4.1 Questions

The questions are asked in array order. Question `<i>` is asked with a `select` dialog titled
`<header> (<i> of <m>): <question>`, followed for a multi-select question by
` — choose one or more, then Done`. Its option strings are:

| Question      | Option strings, in order                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| single-select | `<j>. <label> — <description>` per option; then `<n+1>. Other: type your own answer`                                                                                                                                                        |
| multi-select  | `<j>. [x] <label> — <description>` per chosen option, `<j>. [ ] <label> — <description>` per other option; then `<n+1>. [x] Other: <first line>` with a free-text answer, else `<n+1>. [ ] Other: type your own answer`; then `<n+2>. Done` |

`<n+1>` and `<n+2>` stand for the numbers `<n>` + 1 and `<n>` + 2.

- Choosing an option of a single-select question chooses it and moves to the next step.
- Choosing an option of a multi-select question toggles it and shows the question again.
- Choosing `Other` of a single-select question shows an `input` dialog titled like the question's
  `select` and with the placeholder `Type your answer`. Text that records a free-text answer
  (Section 2.1) records it and moves to the next step; empty text and a cancelled `input` show
  the question again.
- Choosing `Other` of a multi-select question removes its free-text answer when one is present,
  else shows that `input` dialog; either way the question is then shown again with the result.
- Choosing `Done` moves to the next step when the question is answered; otherwise the question is
  shown again.
- Cancelling the question's `select` starts the dismissal choice (Section 4.3).

The step after question `<i>` is question `<i>` + 1; after the last question, it is submission for a
direct call and the review otherwise.

### 4.2 Review

The review is a `select` dialog titled `Review your answers` with the option strings `Submit`, then
`<i>. <header>: <summary>` per question in array order, with its answer summary. Choosing `Submit`
submits the call with the answered result (Section 6.1). Choosing a question asks that question
again (Section 4.1), whose next step is then the review. Cancelling the review starts the
dismissal choice.

### 4.3 Dismissal choice

The dismissal choice is a `select` dialog titled `Dismiss the questions?` with the option strings
`Skip: let the agent continue without answers`, `Stop: end the agent run`, and
`Back to the questions`. Choosing `Skip` ends the call with the dismissed result, `Stop` with the
stopped result; choosing `Back to the questions` or cancelling shows again the dialog whose
cancellation started the choice, with the answers unchanged.

### 4.4 Question form request

The question form request asks the whole call with one `editor` dialog, for an RPC client that
draws a form of its own and announces it by setting `PI_DENT_ASK_FORM` to `1`. The host's `editor`
shows a title and a prefilled text and returns the text submitted or nothing when the user
cancels; it takes no abort signal and no timeout.

The dialog's title is `AskUserQuestion`; its prefilled text is the form payload, the JSON text of
an object with these fields, values cleaned as in Section 3.3:

| Field                               | Type     | Value                                                     |
| ----------------------------------- | -------- | --------------------------------------------------------- |
| `piDent`                            | string   | `"ask-form/1"`.                                           |
| `toolCallId`                        | string   | The tool call ID the host passes to the tool's execution. |
| `questions`                         | object[] | One object per question, in array order.                  |
| `questions[].header`                | string   | The question's `header`.                                  |
| `questions[].question`              | string   | The question's `question`.                                |
| `questions[].multiSelect`           | boolean  | `true` for a multi-select question, else `false`.         |
| `questions[].options`               | object[] | One object per option, in array order.                    |
| `questions[].options[].label`       | string   | The option's `label`.                                     |
| `questions[].options[].description` | string   | The option's `description`.                               |

The text returned is the form answer, the JSON text of one of these objects:

| Form answer                                                     | Result                             |
| --------------------------------------------------------------- | ---------------------------------- |
| `{ "outcome": "answered", "answers": [{ "options", "text" }] }` | the answered result (Section 6.1)  |
| `{ "outcome": "dismissed" }`                                    | the dismissed result (Section 6.2) |
| `{ "outcome": "stopped" }`                                      | the stopped result (Section 6.2)   |

In an answered form answer, `answers` holds one object per question in array order: `options`,
an array of the labels of the chosen options, each a `label` of that question and none twice;
and `text`, a string or `null`, recorded as the free-text answer as in Section 2.1. The chosen
options are taken in option order. The form answer is valid only when every question is answered
(Section 2.1), a single-select question with exactly one of a chosen option and a free-text
answer.

- A returned text that is not a valid form answer MUST make the extension show the same dialog
  again.
- Cancelling the dialog starts the dismissal choice (Section 4.3), whose `Back to the questions`
  shows the dialog again.
- When Section 5 ends the call while the dialog is shown, the call returns at once; a text the
  dialog returns afterwards MUST be ignored.

## 5. Ending without answers

Each of these ends an open call, closes its question panel or its `select` or `input` dialog
when one is shown, and removes it from the question queue. A question form request's editor
dialog stays open (Section 4.4):

| Event                                                                                 | Result              |
| ------------------------------------------------------------------------------------- | ------------------- |
| The tool-call signal aborts, whether the call is being asked or waits in the queue    | the aborted result  |
| `session_shutdown` of the session, for any reason, a reload included: every open call | the shutdown result |

The next queued call is asked after a dismissed, a stopped, or an aborted result; after
`session_shutdown` none is.

## 6. Results

### 6.1 Answered result

The text is the line `The user answered your questions:`, then, for each question in array order:

```text
<i>. <header> — <question>
```

followed by one line `   option: <label>` for each chosen option in option order, and, when
the free-text answer is present, the line `   free text:` followed by one line `   > <line>` for
each line of the free-text answer. Lines are joined by line feeds; the text has no trailing line
feed. `isError` is unset.

```text
The user answered your questions:
1. Auth — Which login method should the app use?
   option: OAuth
2. Targets — Which platforms must it support?
   option: macOS
   option: Linux
   free text:
   > also FreeBSD,
   > if cheap
```

### 6.2 Other results

| Result    | `isError` | `terminate` | Text                                                                                                                                 |
| --------- | --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| no-UI     | `true`    | unset       | `AskUserQuestion is unavailable: this session has no interactive terminal UI. Ask in your reply instead.`                            |
| dismissed | unset     | unset       | `The user declined to answer the questions. Proceed on your own judgement, or ask in your reply.`                                    |
| stopped   | unset     | `true`      | `The user declined to answer the questions and stopped the agent run. Do not assume an answer; end your turn and wait for the user.` |
| aborted   | `true`    | unset       | `The questions were withdrawn because the agent run was aborted; the user did not answer.`                                           |
| shutdown  | `true`    | unset       | `The questions were withdrawn because the session ended or reloaded; the user did not answer.`                                       |

`terminate: true` asks the host to skip the next model request after the current batch of tool
calls; the host does so only when every result of the batch asks it.

### 6.3 `details`

Every result carries `details` `{ outcome, answers }`. `outcome` is `"answered"`, `"no-ui"`,
`"dismissed"`, `"stopped"`, `"aborted"`, `"shutdown"`, or `"invalid"` (Section 1.2). For
`"answered"`, `answers` holds one object per question in array order:

| Field      | Type             | Contract                                                          |
| ---------- | ---------------- | ----------------------------------------------------------------- |
| `header`   | string           | The question's `header`.                                          |
| `question` | string           | The question's `question`.                                        |
| `options`  | string[]         | The `label` of each chosen option, in option order; can be empty. |
| `text`     | string \| `null` | The free-text answer; `null` when absent.                         |

For every other outcome `answers` is `[]`.

## 7. Rendering in the conversation

The host draws each call in its default tool shell. The components returned from `renderCall` and
`renderResult` MUST carry no horizontal padding and no background of their own, and MUST show the
same lines whether the host shows the call collapsed or expanded. Values are cleaned as in
Section 3.3.

- `renderCall`: the line `AskUserQuestion`, then one line `<header>: <question>` per question in
  array order. While the host is still receiving the arguments, a question whose `header` or
  `question` is not a string is left out, and `renderCall` MUST NOT throw.
- `renderResult` for `outcome` `"answered"`: one line `<header>: <summary>` per question, with its
  answer summary (Section 2.1).
- `renderResult` for every other outcome: the result text.

## 8. Normative references

None.

## 9. Specification gaps

- Whether the host records the result of a call that returns after its agent run was aborted, or
  after `session_shutdown`, and what it records instead, is the host's.
- Whether the host emits `session_start` before the first model request of a print-mode or
  JSON-mode run is the host's; if it does not, that request can still declare the tool.
- A terminal with fewer than 5 rows cannot hold the panel's 3 lines under the host's cap of the
  terminal rows minus 2; the host's overlay cuts it.
- Whether the host re-reads an overlay's maximum height when the terminal rows change is the
  host's; the panel relies on it to follow a resize.
- The keys of the host's editor component in text entry (new line, paste, cursor movement) are
  the host's, and so is whether it marks the rendered line that holds its cursor.
- Whether the host consults the task browser shortcut or another extension shortcut while the
  panel has focus is the host's; pi-dent registers none for the panel.
- The host's `select` dialog has no per-option description and no multiple choice: the dialog
  sequence carries descriptions inside the option strings and asks a multi-select question as a
  repeated toggle list ending in `Done`, which an RPC client renders as an ordinary list.
- The host's `input` dialog takes no prefilled text, so an RPC free-text answer cannot be edited,
  only removed and written again; whether it accepts several lines is the client's.
- How an RPC client presents a dialog, and whether a person or a program answers it, is the
  client's.
- The host's `editor` takes no abort signal and tells the RPC client nothing when a call ends
  without an answer; a client of the question form request learns it from the call's tool result,
  matched by `toolCallId`.
- Whether and how the host shows the blocked-on-user report of Section 3 is the host's.
