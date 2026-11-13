# 0045 — pw --ext: an "Agent is driving" banner with Stop, and a site allowlist per session

Status: Accepted (implemented)
Date: 2026-11-13

## Context

- Since the 2026-11-05 amendment of [ADR 0035](0035-pw-ext-real-browser.md),
  passing `--ext` is the grant. The browser asks for no approval per call.
- The person at the browser cannot see which tabs an agent drives, and has no
  way to take control back other than closing the tab group.
- An agent can open and act on any site. The person has no say per site.
- The person must be able to end a session's control at once, and a page
  script must not be able to do that for them or read the control.

## Decision

The worker shows an "Agent is driving this tab" banner with a Stop button in
each agent tab (`pwExtBanner` in `pkg/extension/lib/features/pw-ext-banner.ts`).
It runs in the extension's isolated world and puts its text in a closed shadow
root. The banner follows the same lifecycle as the dialog shim of
[ADR 0044](0044-pw-ext-dialogs.md) in `pkg/extension/lib/background/dialog-shim.ts`.
Only a trusted click on Stop sends a message to the worker. The worker accepts
it only from this extension and from a tab. It then stops the session that owns
the tab's group (`stop` in `pkg/extension/lib/background/pw-ext.ts`). Stop marks
the session stopped in `storage.session`, ends its verbs in flight, drops its
unmask and `dg_` grants and allowed sites, and forgets its agent tab record,
which removes the shim and the banner. Each later verb of that session fails
with an error that names Stop, until a new dg session starts.

The first verb on a new http or https origin in a session asks the person in
the approval popup of `pkg/extension/lib/background/approval.ts` to allow that
origin for the session. `open` and `new` ask for their target origin. Reads and
writes both need an allowed origin; `tabs`, `select` and `close` do not. Allowed
origins live per session in `storage.session`
(`pkg/extension/lib/background/session-control.ts`) and end with the session.
The mailbox guard runs first and does not change.

## Consequences

- **Good:** the person sees each agent tab and can end the session's control
  with one click.
- **Good:** the person decides, per site and per session, where an agent may
  read or write.
- **Bad:** the agent waits for a popup on each new site. A long task across
  many sites asks many times.
- **Bad:** a page can remove the banner element from its DOM. The worker shows
  it again on the next load or verb sync. A page cannot press Stop or read the
  banner text through the closed shadow root.
- **Bad:** work that a stopped verb already started in the page, such as a
  click, can still finish; only its result is dropped.
- **Bad:** while a page shows its own modal `<dialog>`, the rest of the page,
  the banner too, is inert, so Stop cannot be clicked until the modal closes.
  Closing the tab or its group still takes the tab back.
- **Bad:** a mailbox tab gets no banner, because the worker never injects into
  a mailbox origin. Only the WebMCP verbs that the mailbox guard lets through
  run there.
- **Neutral:** a Stop holds until the browser ends, so a session id that
  reconnects stays stopped. A new dg session has a new id.
- **Neutral:** no settings page; the allowlist lives only for the session.

## Alternatives considered

- **A settings page with a standing allowlist.** More UI, and a standing list
  outlives the task that needed it.
- **A banner in the page MAIN world.** Page scripts could read and press it.
- **Stop that only cancels the current verb.** The agent would retry at once;
  the person asked for the session to end.

## Diagrams

```mermaid
sequenceDiagram
    participant C as dg-skills pw --ext
    participant W as extension worker
    participant A as approval popup
    participant B as banner in agent tab
    C->>W: snapshot on a new origin
    W->>A: Let the agent use this site?
    A-->>W: Allow
    W-->>C: snapshot
    B->>W: Stop (trusted click)
    W->>W: stop session, drop grants and sites, forget tabs
    C->>W: next verb
    W-->>C: error: the person clicked Stop
```

## References

- `pkg/extension/lib/features/pw-ext-banner.ts`
- `pkg/extension/lib/background/session-control.ts`
- `pkg/extension/lib/background/pw-ext.ts`
- `pkg/extension/lib/background/dialog-shim.ts`
- `pkg/extension/lib/background/daemon-link.ts`
- [ADR 0035](0035-pw-ext-real-browser.md), [ADR 0044](0044-pw-ext-dialogs.md)

## Amended 2026-11-13: Stop in the toolbar popup

A page's own modal `<dialog>` makes the banner inert, so Stop on the page cannot
be clicked. The toolbar popup now lists each session that drives agent tabs,
with its tab count and a Stop button. The popup sends a typed message
(`MSG.pwExtStop`). The worker accepts it only from this extension's own
`popup.html`, by sender id and URL, and only for a session that holds an agent
tab group. It then runs the same `stop` as the banner. The popup shows the
session as stopped after.

- `pkg/extension/lib/features/popup.ts`
- `pkg/extension/lib/background/popup-sender.ts`
