# Browser navigation specification

This document specifies how pi-dent's full-screen browsers are reached and navigated from the
keyboard: browser activation keys, the browser stack, and the navigation keys every browser page
answers. The pages and their own keys are owned by the browser's specification
([task-browser.md, activation](task-browser.md#activation)).

## 1. Activation keys {#activation-keys}

pi-dent MUST NOT listen for terminal input outside what the host delivers to keys it registers
itself. Every browser is opened by a host-registered shortcut or extension command only; while open it takes input
through the host's custom UI surface, so input the user types into a host window — the editor, a
selector, or a dialog — always reaches that window.
The host consults these shortcuts only while the editor has focus, so a host window in focus
keeps every key. A browser registers and configures its shortcut per its own specification
([task-browser.md, activation](task-browser.md#activation)).

> Note (non-normative): a key the host binds to one of its own actions makes the host report an
> extension shortcut conflict at load, and the extension then shadows that action; no host default
> action uses `shift+right`. A terminal that reports `shift+right` as plain `right` (no modifier)
> leaves the browser opening on `right` until the configuration changes.

## 2. Browser stack {#browser-stack}

Open browsers form a stack, newest on top.

- Opening a browser while none is open puts it alone on the stack; opening a browser while
  another is open puts it above that browser.
- Closing the top browser (by `left` per [navigation keys](#navigation-keys), or by a key its own specification gives)
  removes it. In a stack of one browser, closing it returns to the editor; above another
  browser, the browser below is then top and rendered again.
- A browser's configured shortcut ([task-browser.md, configuration](task-browser.md#configuration)) MUST toggle
  that browser only: closed, it opens the browser on top; open and top, it closes it; open with
  another browser above it, it has no effect.
- The top browser MUST itself treat a key matching its configured shortcut as the close of that
  toggle, on every page, before the page's own keys.
- Ending the main session or a reload MUST empty the stack.
- While a browser is top it MUST consume all input per its own specification; the listeners of
  the browsers below it MUST NOT handle input.

## 3. Navigation keys {#navigation-keys}

Every browser page MUST answer the keys of the table in addition to the keys its own
specification gives it.

| Key              | Action                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `left`           | Close the top browser unless the page has a left-hand action ([navigation keys](#navigation-keys)). |
| `g`, `G`         | Act as `home` and `end` on this page ([`g` and `G`](#home-end-keys)).                               |
| `right`, `enter` | Perform the page's selection action, per the page's own specification.                              |

- A page has a left-hand action when its own specification gives `left` a behaviour on that
  page; there `left` MUST perform that behaviour and MUST NOT close the browser. The task
  browser's details pages are such pages ([task-browser.md, `agent`](task-browser.md#agent-details) and
  [task-browser.md, `script` and `bash`](task-browser.md#script-bash)); its list page is not.
- A page has a selection action when its own specification gives `right` or `enter` a behaviour
  on that page; a page without one MUST ignore `right` and `enter`. The task browser's list page
  and `agent` details page are such pages ([task-browser.md, list page](task-browser.md#list-page) and
  [task-browser.md, `agent`](task-browser.md#agent-details)); its `script` and `bash` details page is not.

## 4. `g` and `G` {#home-end-keys}

`g` and `G` MUST act on every page whose own specification gives `home` and `end` a behaviour,
and on no other page.

- `g` MUST have the effect of the page's `home` key and `G` the effect of its `end` key, on the
  selection and on the body scroll alike.
- A page without a `home` and `end` behaviour MUST ignore `g` and `G`; its own keys stand.

The task browser's list page ([task-browser.md, list page](task-browser.md#list-page)) and its details
pages ([task-browser.md, `agent`](task-browser.md#agent-details) and [task-browser.md, `script` and `bash`](task-browser.md#script-bash)) are such pages.

## 5. Normative references {#references}

None.

## 6. Specification gaps {#gaps}

- A terminal that reports `G` as `shift+G` with a shift modifier, rather than as the printable
  character, is not distinguished; the host input layer decides what a page receives.
- Whether the configured shortcut is reachable on the user's keyboard layout and terminal is
  not known to pi-dent; a combination the terminal does not report leaves the browser unreachable
  until the configuration changes.
