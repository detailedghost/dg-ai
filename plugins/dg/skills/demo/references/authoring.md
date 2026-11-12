# Tour authoring reference

## Plan file (the authoring format)

You author a tour as a Markdown **plan**: YAML frontmatter + a `## Steps`
list. Feed it to `dg-skills demo <plan>.md`; the CLI parses it, generates the
runnable script into a `## Script` fenced block, and plays it. Local play and
`--ext` play the same plan. Local play always records an MP4. `--ext` plays the
interactive tour. Never hand-write the JSON.

```markdown
---
title: Saved filters      # optional — shown in each callout's progress line
startUrl: http://localhost:4200/dashboard   # required — http(s) entry page
mode: walkthrough         # optional — --ext only; local mode always records
intro: "Demo | Saved filters | Keep your views"   # optional — local mode
outro: "Done | That is it | Thanks for watching"   # optional — local mode
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
  element: `@click` (clicks it) or `@type="<text>"` (types `<text>` into it, or the
  value of env var `DG_DEMO_*` when `<text>` is `$DG_DEMO_*`; see [Credentials](#credentials) —
  a literal `"` or `\` inside `<text>` must be escaped as `\"` / `\\`). Omit
  for no automatic action — the step just spotlights. **With `--ext`, timing is mode-aware:**
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

Types mirror `pkg/extension/lib/demo-types.ts`. The plan format and its validation
live in `pkg/common/src/plan-format.ts`.

## Intro and outro

Local mode adds a full-screen chapter card before and after the steps. Set them in
frontmatter as `"Eyebrow | Title | Detail"`:

```yaml
intro: "Demo | Saved filters | Keep your views"
outro: "Done | That is it | Thanks for watching"
```

The intro defaults to the eyebrow `Demo` with the plan `title`. No outro plays unless
you set one. Only local mode uses them.

## Credentials

`@type="$DG_DEMO_VELORA_PW"` types the value of that env var. Only `$DG_DEMO_*`
variables resolve, with names matching `^\$DG_DEMO_[A-Z0-9_]+$`, and only into
`input[type=password]` fields. A value like `$AWS_SECRET_ACCESS_KEY` fails validation,
and a non-password target fails the run. The plan never holds the value, and logs and
results never print it.

- In a recorded step, an unset `NAME` refuses with exit 2:
  `demo: set $DG_DEMO_VELORA_PW or move the login to ## Setup`.
- In `## Setup` with `includeSetup: false`, the login runs in an unrecorded context and
  hands its session to the recording.
- If a setup fill names an unset variable, a headed window opens, shows
  "Type it here, then continue.", and waits for a navigation, for Enter or a blur in
  the filled field, or for the next setup step's selector to appear. After a
  navigation, the run skips each later setup step whose selector does not show within
  2 s and prints `skipped setup step N after the sign-in`.
- On a headless-only plan (WSL without `--windows` or `--wsl-headed`), that case
  refuses with exit 2.
- `demo --verify` reports `env-unset` and names the variable.

## Advance modes (`--ext`)

Local mode ignores `next` and `click` and holds each step for its timing, or the default dwell of about 3.5 s.

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

## Walkthrough controls (`--ext`)

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

With `includeSetup: false`, setup always runs first. In local mode it runs in an
unrecorded context and hands its login to the recording. With `--ext`, it runs as a
user-paced phase before the walkthrough begins or the video recording prompt appears.
Either way, it is never narrated or captured. Set `includeSetup: true` when the
preparation itself belongs in the demo: setup steps then lead the tutorial and
video in source order.

Setup actions (`@click` / `@type="..."`, see the step-line grammar above) are
stored in the Markdown plan and URL marker. Never put credentials, passwords,
API/session tokens, recovery codes, or MFA/one-time codes in an `@type="..."`
action's value. Use `@type="$DG_DEMO_VELORA_PW"` for a password that an env var holds.
With `--ext`, you can also leave sensitive fields as manual, user-paced setup steps
(no action, `click` or `next` timing) so the user enters those values directly.
With `--ext`, playback always asks for explicit approval before any authored setup
click/fill action can run.

## Multi-page tours (`--ext`)

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

## Recording (local mode)

Local mode always records. A Node recorder drives the real UI with Playwright: real
clicks and key-by-key typing. Plain DOM overlays, added through `page.evaluate`, show
a chapter card, a caption bar, and an outline with an arrow on the target. A strict
site Content Security Policy does not block them. The video has no REC badge.

The output is an MP4: H.264, 1440x810, 30 fps. The default path is
`<cacheDir>/demos/<slug>/<slug>-<stamp>.mp4`. `--out` must end in `.mp4` and sit
outside a git work tree. Without `ffmpeg`, the raw webm stays, with a sidecar `.wav`
when narrated, and the CLI warns.

Captions and a silent video are the default. `-n` adds a Kokoro voice, made before the
recording and muxed as AAC. A numeric timing is the dwell after the caption or voice.
There is no start screen, review panel, or walkthrough control in local mode.

Run `dg-skills demo --verify <plan>` first. It drives the same recorder in a dry run,
with no overlays and no holds.

## Video mode (`--ext`)

The sections below apply to `--ext` only. Set `"mode": "video"` to record through the
extension instead of a live tour. See [extension.md](extension.md).

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
"press to start" modal; the user presses `Alt+Shift+D` (or opens the DeeGee
popup and chooses Record demo) once, then it's fully automatic through to the saved-confirmation
message. Chrome/Edge only — `tabCapture`/`offscreen` aren't available in Firefox.

In video mode the manual Next/Back/jump controls are hidden (there's no one to
click them); an authored action still auto-fires on its short timer as usual.
Use numeric `advance` values to pace important steps.
