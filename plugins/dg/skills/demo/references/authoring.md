# Tour authoring reference

## Plan file (the authoring format)

You author a tour as a Markdown **plan**: YAML frontmatter + a `## Steps`
list. Feed it to `dg-skills demo <plan>.md`; the CLI parses it, generates
the runnable script into a `## Script` fenced block, and hands it to the
extension. Never hand-write the JSON.

```markdown
---
title: Saved filters      # optional — shown in each callout's progress line
startUrl: http://localhost:4200/dashboard   # required — http(s) entry page
mode: walkthrough         # optional — walkthrough (default) | video
---

## Steps

1. **Save a filter** `#save-filter-btn` — Persist the current filters. `click`
2. **Filters page** → http://localhost:4200/filters — It shows here. `4s`
3. **All done** — Centered step (no selector); dims the page. `next`
```

Step line grammar (everything but the number and body is optional):

```text
N. **<title>** [`<css-selector>`] [→ <navigate-url>] — <body> [`<timing>`]
```

- `` `<css-selector>` `` — element to spotlight; omit for a centered modal.
- `→ <navigate-url>` — navigate here before showing this step (multi-page).
- `` `<timing>` `` — the `advance` mode: `4s` / `500ms` / a bare ms count
  (auto-advance), or `click` / `next`. Omit for the default. A trailing
  inline `` `code` `` span that isn't a valid timing stays part of the body.

## Underlying script schema

The plan generates this shape (also accepted directly as a `.json` file):

```jsonc
{
  // optional — shown in every callout's progress line
  "title": "Saved filters",
  // required — http(s); the entry page opened by the CLI
  "startUrl": "http://localhost:4200/dashboard",
  // required — non-empty array of steps
  "steps": [
    {
      // CSS selector to spotlight; omit → centered modal
      "selector": "#save-filter-btn",
      // optional callout heading
      "title": "Save a filter",
      // required — the callout text
      "body": "Click here to persist the current filter set.",
      // "next" (default) | "click" | <milliseconds>
      "advance": "next",
      // optional — navigate here before showing this step
      "navigate": "http://localhost:4200/filters"
    }
  ],
  // optional — "walkthrough" (default, user-paced) | "video" (auto-play + record)
  "mode": "walkthrough"
}
```

Types mirror `pkg/extension/lib/demo-types.ts` and are validated CLI-side in
`pkg/skills-cli/src/commands/demo.ts`.

## Advance modes

- **`"next"`** (default) — the callout shows a **Next** button; the user drives
  the pace.
- **`"click"`** — advances when the user clicks the spotlighted target. A Next
  button is still shown as a fallback. **Use this only for in-page interactions**
  (toggles, menus, SPA actions). If clicking the element navigates to another
  page, don't rely on `"click"` — instead keep `"next"` here and put the
  destination in the **next step's `navigate`**. This avoids a race between
  saving progress and the page unloading.
- **`<number>`** — auto-advance after that many milliseconds (hands-off
  playback).

## Multi-page tours

Tour state lives in `storage.local`, so it survives navigations. To move to
another page, set `navigate` on the first step that belongs there — the player
navigates, and the destination page's content script resumes at that step.
`navigate` is skipped when you're already on its URL (fragment ignored), so it
won't loop.

## Picking good selectors

- Prefer stable hooks: `data-testid`, `id`, `aria-label`, or a role — not deep
  positional chains (`div > div:nth-child(3)`) that break on markup changes.
- Verify the selector resolves to exactly one visible element. The player waits
  ~1.5s for it to appear, then falls back to a centered modal if it never shows.
- Keep the target reachable — the player calls `scrollIntoView` before
  spotlighting.

## Writing callouts

- One idea per step; one or two sentences per `body`. The card is ~320px wide.
- Lead with the verb ("Click…", "Notice…", "Now the results…").
- Use `title` for the label, `body` for the explanation — don't repeat.

## Video mode

Run `demo --video` (or set `"mode": "video"`) to record instead of a live tour.
The tour auto-plays hands-free: each step is held for ~3.5s, or for a step's
numeric `advance` value if set. The extension records the tab (tabCapture → an
offscreen MediaRecorder → webm) and saves `dg-demo/<tour>/<tour>.zip` (the video
plus a re-runnable `plan.md`) to the user's **Downloads** folder.

Because Chrome requires a user gesture to start tab capture, the page shows a
"press to start" modal; the user presses `Alt+Shift+D` (or clicks the DeeGee
toolbar icon) once, then it's fully automatic through to the saved-confirmation
message. Chrome/Edge only — `tabCapture`/`offscreen` aren't available in Firefox.

In video mode the manual Next/Back controls are hidden (there's no one to click
them); use numeric `advance` values to pace important steps.
