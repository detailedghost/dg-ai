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
N. **<title>** [`<css-selector>`] [→ <navigate-url>] [<action>] — <body> [`<timing>`]
```

- `` `<css-selector>` `` — element to spotlight; omit for a centered modal.
- `→ <navigate-url>` — navigate here before showing this step (multi-page).
- `<action>` — an action the **tour itself** performs on the spotlighted
  element: `@click` (clicks it) or `@type="<text>"` (types `<text>` into it —
  a literal `"` or `\` inside `<text>` must be escaped as `\"` / `\\`). Omit
  for no automatic action — the step just spotlights. **Timing is mode-aware:**
  in `video` mode it fires on a short timer right after the callout shows
  (hands-off playback); in `walkthrough` mode it waits for the user to advance
  past the step (Next, or the target click for a `click` timing) so a live
  viewer is never raced ahead of. It's parsed out of whatever comes before the
  em dash regardless of position, but the generator always writes it after the
  selector/navigate, e.g. `` `#save-filter-btn` @click `` or
  `` `input[name=q]` @type="cute puppies" ``.
- `` `<timing>` `` — the `advance` mode: `4s` / `500ms` / a bare ms count
  (auto-advance), or `click` / `next`. Omit for the default. A trailing
  inline `` `code` `` span that isn't a valid timing stays part of the body.

> **Don't confuse the `click` *timing* with the `@click` *action* — this is
> the single most common authoring mistake in this format.** The trailing
> `` `click` `` **timing** means "wait for a **human** to click the target"
> (a user-paced step). The `@click` **action** before the em dash means "the
> **tour** clicks the target." Authoring `` `click` `` when you meant an
> automatic click produces a tour that sits waiting for a user, while the
> user sits waiting for the tour — nothing advances, and it just looks
> broken. For a fully automated step, pair `@click` with a **numeric**
> timing (e.g. `@click` … `` `2s` ``) so the tour clicks, then advances
> itself; the bare `` `click` `` timing is for user-driven walkthrough steps
> where a real person is expected to act, with no `@click`/`@type` involved.
>
> **Vocabulary limit:** `@click` and `@type="..."` are the only two actions
> that exist — there is no hover, drag, select, or keypress action. A step
> that needs one of those can't be automated this way; author it as a
> user-paced step (`click` or `next` timing, no action) and let the person
> perform that interaction themselves.

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
- **`"click"`** — advances when the user clicks the spotlighted target. Pressing
  the callout's **›** instead clicks the target for them, so a step timed this way
  still moves the page when driven from the controls. **Use this only for in-page
  interactions** (toggles, menus, SPA actions). If clicking the element navigates
  to another page, don't rely on `"click"` — keep `"next"` here and put the
  destination in the **next step's `navigate`**. This avoids a race between
  saving progress and the page unloading.
- **`<number>`** — auto-advance after that many milliseconds (hands-off
  playback). In video mode this is dwell time *after* narration — see
  [Video mode](#video-mode).

## Walkthrough controls

Each step's callout shows **« ‹ › »** — jump to first, back one, forward one,
jump to last — each disabled at the end it already points to, so the affordance
never lies about where a jump would land. The single-step pair is tinted
(`‹` accent2, `›` accent) to mark it apart from the jumps. **Done** replaces the
forward controls on the last step, since ending the tour isn't navigation.

**›** is the step's action: it runs an authored `@click`/`@type`, or supplies the
click a `"click"`-timed step is waiting for, before advancing. **‹** and the jump
controls are pure navigation — replaying an action backwards has no meaning.

## Optional setup stage

Use `## Setup` for durable preparation such as signing in, seeding data, or
choosing configuration. It has the same step-line grammar as `## Steps` and is
controlled by `includeSetup` in frontmatter:

```markdown
---
title: Prepared demo
startUrl: http://localhost:4200
includeSetup: false
---

## Setup

1. **Sign in** — Use the demo account. `next`

## Steps

1. **Dashboard** — Now begin the tutorial. `next`
```

With `includeSetup: false`, setup always runs first as a user-paced preparation
phase. It finishes before the walkthrough begins or the video recording prompt
appears, so it is never narrated or captured. Set `includeSetup: true` when the
preparation itself belongs in the demo: setup steps then lead the tutorial and
video in source order.

Setup actions (`@click` / `@type="..."`, see the step-line grammar above) are
stored in the Markdown plan and URL marker. Never put credentials, passwords,
API/session tokens, recovery codes, or MFA/one-time codes in an `@type="..."`
action's value. Leave sensitive fields as manual, user-paced setup steps (no
action, `click` or `next` timing) so the user enters those values directly.
Playback always asks for explicit approval before any authored setup
click/fill action can run.

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
- If a step has an `<action>` and its selector never resolves (slow-loading
  SPA, wrong selector), the action is skipped rather than run against nothing —
  the callout shows a "Target not found" warning and the browser console logs
  it. It never halts the tour, but treat it as a sign to fix the selector or
  give the page more time to render before that step.

## Writing callouts

- One idea per step; one or two sentences per `body`. The card is ~320px wide.
- Lead with the verb ("Click…", "Notice…", "Now the results…").
- Use `title` for the label, `body` for the explanation — don't repeat.

## Video mode

Run `demo --video` (or set `"mode": "video"`) to record instead of a live tour.
The tour auto-plays hands-free. The extension records the tab (tabCapture → an
offscreen MediaRecorder → webm) and saves `dg-demo/<tour>/<tour>.zip` (the video
plus a re-runnable `plan.md`) to the user's **Downloads** folder.

How long each step holds depends on whether it is narrated:

| Step | Hold |
| --- | --- |
| Narrated, no `advance` | clip length + tail |
| Narrated, `advance: 4000` | clip length + tail **+ 4s** |
| Silent (captions-only), `advance: 4000` | 4s |
| Silent, no `advance` | ~3.5s |

On a narrated step a numeric `advance` is **dwell time after the voice finishes**,
not a floor on the whole step. So it always lengthens that step, and you can hold
a beat on an important frame without guessing how long its narration will run.

Because Chrome requires a user gesture to start tab capture, the page shows a
"press to start" modal; the user presses `Alt+Shift+D` (or clicks the DeeGee
toolbar icon) once, then it's fully automatic through to the saved-confirmation
message. Chrome/Edge only — `tabCapture`/`offscreen` aren't available in Firefox.

In video mode the manual Next/Back/jump controls are hidden (there's no one to
click them); an authored action still auto-fires on its short timer as usual.
Use numeric `advance` values to pace important steps.
