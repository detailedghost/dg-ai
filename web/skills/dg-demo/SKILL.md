---
name: dg-demo
description: Play a guided demo tour as an artifact, with chapter cards, captions and a highlight on each target, over a mock of the UI or uploaded screenshots. Use to demo or walk through a feature.
---

# Guided-tour demo (web)

The chat version of DeeGee's `demo` skill. It plays the tour as an HTML artifact in this
chat. It records no video and opens no browser. Your job: write the plan, build the
stage, fill the player, publish it, and give the plan back.

## Step 1: Pick the stage

Offer the user both stages, and default to the mock when they don't choose:

- **Mock (default).** You rebuild the screens the tour visits as plain HTML and CSS, from
  the code, a description, or screenshots the user shares. The tour clicks and types into
  the mock for real.
- **Screenshots.** The user uploads one screenshot per screen. Each step highlights a
  box on a screenshot. Nothing on the page reacts, so clicks and typing only show as
  highlights.

Read [references/stages.md](references/stages.md) for how to build each one.

## Step 2: Write the plan

Write the tour as a Markdown plan: YAML frontmatter, then a required `## Steps` list.
The grammar is the same one DeeGee's `/dg:demo` reads, so the same plan can be recorded as
a real video later.

```markdown
---
title: Saved filters
startUrl: http://localhost:4200/dashboard
stage: mock
intro: "Demo | Saved filters | Keep your views"
outro: "Done | That is it | Thanks for watching"
---

## Steps

1. **Save a filter** `#save-filter-btn` @click — Keep the current filters. `3s`
2. **Name it** `input[name="filter-name"]` @type="Open bugs" — Type a name. `4s`
3. **Filters page** → http://localhost:4200/filters — It shows up here. `4s`
4. **All done** — A step with no selector dims the page and centers the caption. `next`
```

A step is `N. **title** [`selector`] [→ url] [action] — body [`timing`]`.
Full grammar: [references/plan-format.md](references/plan-format.md). The rules that
matter most:

- `@click` and `@type="..."` are the only actions. The tour performs them.
- The trailing `` `click` `` timing waits for a person to click the target, and `next`
  waits for the › control. A number (`4s`, `500ms`, `2500`) auto-advances.
  Don't write the `click` timing when you meant `@click`.
- One idea per step, one or two sentences of body text. Lead with the verb.
- Use the real app URL as `startUrl` when you know it. When you don't, use
  `http://localhost/` and tell the user to change it before recording for real.
- Never put a password, token, or one-time code in `@type`. This version has no
  `## Setup` stage and no credentials. Show a signed-in mock screen instead.

## Step 3: Fill the player

Copy [assets/tour-player.html](assets/tour-player.html) as the artifact. Don't write a
player from scratch. Then:

1. Replace the `DG:THEME` comment with the full contents of
   [assets/dg-theme.css](assets/dg-theme.css), unchanged.
2. Put the stage into `#dg-stage` (Step 1).
3. Put the plan, verbatim, into `<script type="text/markdown" id="dg-plan-md">`.
4. Convert the plan into the `#dg-tour` JSON. Every field is in
   [references/player.md](references/player.md).
5. Replace `TOUR_TITLE` in `<title>` and in the JSON.

Keep the player's look: the dark recorder panel, a cyan ring and arrow with hard
offset shadows, square corners, uppercase chapter-card headings. Restyle only the mock
stage, so it looks like the product being demoed.

## Step 4: Check it, then hand it over

Before you publish, read the JSON against the stage: every `selector` must match exactly
one element inside the screen that step shows, and every `navigate` URL must match a
section's `data-dg-url`. Fix any mismatch. A step whose target is missing still plays,
but shows "Target not found".

Then publish the artifact and reply with:

- one line on what the tour covers and which stage it uses
- the plan in a fenced `markdown` block, so the user can save it as `<slug>.demo.md`
- one line: the plan also runs with `/dg:demo` in Claude Code or Codex, which records a
  real MP4 against the live app

## Changing the tour

When the user asks for a change, edit the plan first, then the JSON and the stage to
match, and update the same artifact. Don't start a new one. Keep the plan and the JSON in
step.

## What this version leaves out

The video file, narration, `## Setup`, credential variables, `--ext`,
`--attach-pr`, and any browser or command-line step. To use them, run the plan with
`/dg:demo`.
