---
name: demo
description: Produce a demo of a feature or PR. The local mode, which is the default, drives a real Chromium through `dg-skills pw` to record a video and a light/dark before/after screenshot pair — no browser extension needed. Add `--ext` to hand the plan to the dg-ai-extension instead: it spotlights each element and injects explanatory text boxes in the user's real browser, and the user picks review / walkthrough / video on its start screen. Either mode can attach its output to a PR with --attach-pr. Use when someone asks to demo, show off, walk through, or record a feature. Flags: --ext, --video, --print, --edit, --verify, --attach-pr.
---

# Guided-tour demo

Turn a feature or PR into a guided tour: a spotlight on each element with an
explanatory text box, step by step, from one shared plan format.

**Your job is two steps: write a plan file, then play it.** Local mode (the default)
records it unattended — no further input needed. `--ext` opens the user's real browser
instead; everything else there — reviewing, choosing walkthrough vs video, picking the
narration voice — the user does on the extension's start screen. Don't ask them in
chat; the browser asks.

---

## Flags

**Usage:** `~/.dg/bin/dg-skills demo <plan.md> [--ext [--video] [--print] [--edit]] [--verify <plan>] [--attach-pr <ref>]`

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--ext` | none | Hand the plan to the dg-ai-extension instead of recording it locally. Needs the extension loaded in the user's browser. | off (local is the default) |
| `--video` | none | `--ext` only: accepted for compatibility; the mode is actually chosen on the extension's start screen. | off |
| `--print` | none | `--ext` only: print the marked URL instead of opening it. | off |
| `--edit` | none | `--ext` only: open a review/edit panel in the browser before playing or recording. | off |
| `--verify <plan>` | none | Walk the plan in a real throwaway browser and print findings as JSON, instead of playing it. | off |
| `--attach-pr <ref>` | none | Hand this run's recorded files to the given PR/MR number or URL. There is no authenticated upload path yet (it waits for an upload spike), so this never changes the PR — it reports the files and the PR link, or reports GitLab as unsupported, and stops. | off |

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
`click` / `next`. `mode:` controls local mode directly (`video` also records; otherwise
it still walks and screenshots the steps without a video) — with `--ext` it is only the
default, since the user picks the real mode on the start screen there. Keep each body to
a sentence or two, one idea per step. For a video, add a `` `Ns` `` timing to any step
that should linger longer than the default (~3.5s); it is added *after* narration
finishes in `--ext` mode, so it is dwell time on the frame that matters.

Full grammar, selector guidance, and the `click`-timing-vs-`@click`-action distinction:
[references/authoring.md](references/authoring.md).

### Setup steps, when the tour needs prerequisite state

Use `## Setup` only for state the tutorial can't reach on its own — an authenticated
session, seeded records, configuration, a feature flag, a specific page state. Same line
grammar as tutorial steps.

Keep `includeSetup: false` (the default) unless the user asks to show the preparation as
part of the demo. In `--ext` mode, excluded setup runs first as a user-paced phase, then
hands off to the tutorial; **video narration and capture start only after that handoff**,
so a recording never contains the preparation. **Local mode has no live user, so
excluded setup never runs at all** — if the tutorial needs it, either set
`includeSetup: true` or have the user reach that state first and use `--ext`.
With `includeSetup: true`, setup steps simply become the leading tutorial steps, in
either mode.

Ask the user to type credentials, MFA codes, and CAPTCHA answers themselves. Never put
those values in a fill action.

First run: install or refresh the CLI when it is missing or too old. In a dev checkout,
rebuild and reinstall `~/.dg/bin/dg-skills` so the demo and the verify pass below use
the latest code:

```bash
~/.dg/bin/dg-skills demo --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.0/pkg/skills-cli/bootstrap.sh | sh
```

If a step fails, run ~/.dg/bin/dg-skills doctor demo install pw rerun.

On Windows PowerShell, pipe the repository's raw `bootstrap.ps1` to `Invoke-Expression`.

### Verify, then correct, then repeat — bounded

Before playing the plan for real, walk it yourself in a real throwaway browser — you
are the first one to hit a bad selector or an unrecorded navigation, not the user:

```bash
~/.dg/bin/dg-skills demo --verify /tmp/ai/demo/tour.md
```

This prints `{"ok": boolean, "findings": [...]}` to stdout. Each finding names a step
and what's wrong: `selector-unresolved` (nothing on the page matches that selector),
`unrecorded-navigation` (a click moved the page to a URL the plan never recorded), or
`page-mismatch` (the step landed somewhere other than its authored `navigate` URL).

If `findings` is non-empty, fix the plan — correct the selector, add the missing
`navigate` line — and run `--verify` again. **Attempt at most 3 correction passes.** If
a finding still cannot be resolved after 3 passes, stop: surface that finding to the
user rather than looping forever or handing off a plan you know is broken. A clean run
(`ok: true`, empty `findings`) is what clears the plan for the next step.

## Step 2 — Play it

### Local (the default)

Write the plan to `/tmp/ai/demo/tour.md`, then run it with no flags:

```bash
~/.dg/bin/dg-skills demo /tmp/ai/demo/tour.md
```

`dg-skills pw` drives a real Chromium: it renders each step's spotlight and callout
through the same overlay the extension uses (`pkg/common/src/tour-overlay.ts`), records
a video when the plan's `mode` is `video`, and always takes a light/dark before/after
screenshot pair. It prints the artifact paths and the command to replay it — nothing
more to do. Owned-artifact cleanup runs automatically against a snapshot taken before
the run, so a crash never leaves a stray recording file in the working tree, and it
never touches anything that was already dirty or untracked before the run started.

### --ext: Open it in the extension

**Your job is two steps: write a plan file, then open it in the extension.** Everything
else — reviewing, choosing walkthrough vs video, picking the narration voice — the user
does on the extension's start screen. Don't ask them in chat; the browser asks.

**Prerequisite:** the extension must be loaded in the user's browser. If a tour doesn't
play, tell them to run the browser skill's `install` command first.

Run **one** command — no `--video` flag, because the mode is chosen in the browser:

```bash
~/.dg/bin/dg-skills demo --ext --edit /tmp/ai/demo/tour.md
```

This opens `startUrl` with the tour in a `_demo` marker and shows the **start screen**,
which is the approval gate. Confirm the browser reached it, then stop — the rest is the
user's. A raw `.json` script is also accepted.

## What the user sees on the start screen (--ext mode)

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
auto-plays and saves `dg-demo/<tour>/<tour>.webm` and `dg-demo/<tour>/<tour>.demo.md` to
their Downloads. Chrome/Edge only (tabCapture + an offscreen document). The first
narrated run downloads the ~86 MB Kokoro model; if synthesis fails the video still
records silently.

> **Dev checkout:** `--ext` runs the browser **extension**, not the CLI. If you changed
> extension code, rebuild and re-stage it (`bun run --filter='@dg/extension' build`, then
> `dg-skills install --local`), and reload it in `chrome://extensions` — otherwise you're
> testing a stale UI. On WSL the loaded copy is the Windows staging dir, not `.output/`.
> Local mode always runs the current build — there's no separate install step for it.

## Attaching to a PR

`--attach-pr <ref>` (a PR/MR number or URL) works after either mode finishes. There is
no authenticated upload path yet — that is a planned follow-up spike — so today it only
ever reports, never mutates:

- **GitLab**: reports attachment as unsupported and stops, before touching anything.
- **GitHub**: hands back the recorded files (local mode) or a note that recording
  happens in the browser (`--ext`), plus the PR's URL, and leaves the PR exactly as it
  was. Attach the files yourself.

## Replaying a saved demo

Every run saves `~/.dg/demos/<slug>/<slug>.demo.md` — local mode saves it directly;
`--ext` saves it alongside every recorded video it downloads, as `<slug>.demo.md`.
Replay either without recompiling:

```bash
~/.dg/bin/dg-skills rerun <path-to>.demo.md
# add --video to record the replay
```

The plan `.md` is human-readable; its embedded ```json``` block is the runnable script
`rerun` extracts.
