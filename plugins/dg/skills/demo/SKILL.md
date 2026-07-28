---
name: demo
description: Produce a guided in-browser demo of a feature or PR — optionally preparing authenticated, configured, or seeded setup state first — then use the dg-ai-extension to spotlight each element and inject explanatory text boxes in the user's real browser. Write a plan, open it in the extension, and the user picks review / walkthrough / video there. Use when someone asks to demo, show off, walk through, or record a feature in the browser.
---

# Guided-tour demo

Turn a feature or PR into a guided tour that plays in the user's real browser: the
companion `dg-ai-extension` spotlights each element and shows an explanatory text box,
step by step.

**Your job is two steps: write a plan file, then open it.** Everything else — reviewing,
choosing walkthrough vs video, picking the narration voice — the user does on the
extension's start screen. Don't ask them in chat; the browser asks.

**Prerequisite:** the extension must be loaded in the user's browser. If a tour doesn't
play, tell them to run the browser skill's `install` command first.

---

## Step 1 — Write the plan

Read the relevant code (diff, PR, or files) first, then write the tour as a Markdown
plan file: YAML frontmatter, an optional `## Setup` list, and a required `## Steps`
list, one line per step. You never hand-write JSON — the CLI compiles this Markdown.

```markdown
---
title: How to use Google
startUrl: https://www.google.com
mode: video
---

## Steps

1. **Welcome to Google** — This quick tour shows the basics. `4s`
2. **The search box** `textarea[name="q"]` — Click here and type. `4.5s`
3. **Open results** `a#more` → https://www.google.com/search — Navigates, then highlights. `3s`
```

Each step line is `N. **title** [`selector`] [→ navigate-url] [action] — body [`timing`]`.
The trailing `` `timing` `` is `4s` / `500ms` / a bare ms count for auto-advance, or
`click` / `next`. `mode:` is only the default — the user picks the real mode on the start
screen. Keep each body to a sentence or two, one idea per step. For a video, add a
`` `Ns` `` timing to any step that should linger longer than the default (~3.5s); it is
added *after* the narration finishes, so it is dwell time on the frame that matters.

Full grammar, selector guidance, and the `click`-timing-vs-`@click`-action distinction:
[references/authoring.md](references/authoring.md).

### Setup steps, when the tour needs prerequisite state

Use `## Setup` only for state the tutorial can't reach on its own — an authenticated
session, seeded records, configuration, a feature flag, a specific page state. Same line
grammar as tutorial steps.

Keep `includeSetup: false` (the default) unless the user asks to show the preparation as
part of the demo. Excluded setup runs first as a user-paced phase, then hands off to the
tutorial; **video narration and capture start only after that handoff**, so a recording
never contains the preparation. With `includeSetup: true`, setup steps simply become the
leading tutorial steps.

Ask the user to type credentials, MFA codes, and CAPTCHA answers themselves. Never put
those values in a fill action.

## Step 2 — Open it in the extension

Write the plan to `/tmp/ai/demo/tour.md` and run **one** command — no `--video` flag,
because the mode is chosen in the browser:

```bash
"$DG" demo --edit /tmp/ai/demo/tour.md
```

Resolve `$DG` first. In a dev checkout, compile the local source so the demo exercises
the latest code rather than a stale released binary:

```bash
DG="$HOME/.dg/bin/dg-skills"
SRC=""
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] &&
  [ -f "$CLAUDE_PLUGIN_ROOT/pkg/skills-cli/package.json" ]; then
  SRC="$CLAUDE_PLUGIN_ROOT/pkg/skills-cli"
elif [ -f "$PWD/pkg/skills-cli/package.json" ]; then
  SRC="$PWD/pkg/skills-cli"
fi
if [ -n "$SRC" ]; then
  ( cd "$SRC" && bun run build ) && DG="$SRC/dist/dg-skills"   # dev: freshly-compiled
fi
if [ ! -x "$DG" ]; then
  if [ -n "$SRC" ]; then
    sh "$SRC/bootstrap.sh"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

On Windows PowerShell use the checkout's `bootstrap.ps1`, or pipe the repository's raw
`bootstrap.ps1` to `Invoke-Expression`.

This opens `startUrl` with the tour in a `_demo` marker and shows the **start screen**,
which is the approval gate. Confirm the browser reached it, then stop — the rest is the
user's. A raw `.json` script is also accepted.

## What the user sees on the start screen

- **Narration** and **Voice** selects — the recording mode, saved to their settings:
  - **Voiceover + captions** (default) — the body is spoken by local **Kokoro** and the
    text box stays on-screen.
  - **Voiceover only** — the body is spoken, the text box hidden (the step title stays).
  - **Captions only** — silent; on-screen text only, skipping Kokoro and its model load.
- **Include N setup step(s)** — the `includeSetup` toggle, when the plan has setup.
- **🔍 Review the plan step by step** — the stepper: verify selectors against the live
  page, edit any field, **✓ Approve** to come back here.
- **▶ Play walkthrough** — user-paced. Step with **‹ ›**, jump with **« »**; **›** also
  performs the step's action.
- **⏺ Record video** — auto-plays and records.
- **⬇ Download plan (.md)** — save the plan as authored.

For a video, excluded setup runs first; once it hands off, the user presses
**`Alt+Shift+D`** (or clicks the DeeGee toolbar icon) to start recording. The tour then
auto-plays and saves `dg-demo/<tour>/<tour>.zip` — the video **and** its `plan.md` — to
their Downloads. Chrome/Edge only (tabCapture + an offscreen document). The first
narrated run downloads the ~86 MB Kokoro model; if synthesis fails the video still
records silently.

> **Dev checkout:** the browser runs the **extension**, not the CLI. If you changed
> extension code, rebuild and re-stage it (`bun run --filter='@dg/extension' build`, then
> `dg-skills install --local`), and reload it in `chrome://extensions` — otherwise you're
> testing a stale UI. On WSL the loaded copy is the Windows staging dir, not `.output/`.

## Replaying a saved demo

Every run saves `~/.dg/demos/<slug>/<slug>.demo.md`, and every video bundles a copy in
its `.zip`. Replay either without recompiling:

```bash
"$DG" rerun <path-to>.demo.md
# add --video to record the replay
```

The plan `.md` is human-readable; its embedded ```json``` block is the runnable script
`rerun` extracts.
