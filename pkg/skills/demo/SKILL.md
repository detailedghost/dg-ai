---
name: demo
description: Produce a guided in-browser demo of a feature or PR — the dg-ai-extension spotlights each element and injects explanatory text boxes in the user's real browser. Two modes — `walkthrough` (live, user-paced) and `video` (auto-plays and records a webm to Downloads). Compile a tour script, get approval, then play it. Use when someone asks to demo, show off, walk through, or record a feature in the browser.
argument-hint: "[walkthrough|video] [feature description or PR number]"
user-invocable: true
---

# /dg:demo — Guided-tour demo

Turn a feature or PR into a guided tour that plays in the user's real browser: the
companion `dg-ai-extension` spotlights each element and shows an explanatory text box,
step by step. You compile the tour, the user approves it, then hand it off.

Two modes (first arg; default `walkthrough`):

- **`walkthrough`** — live and user-paced. The user clicks Next/Back through the steps.
- **`video`** — auto-plays hands-free and records the tour, saving a `.zip` (the video
  **plus** a re-runnable `plan.md`) to the user's Downloads.

Every run also saves a durable, re-runnable plan under `~/.dg/demos/<slug>/<slug>.demo.md`.
Replay any saved plan with **`rerun`** (see below) — no need to recompile.

**Prerequisite:** the extension must be loaded in the user's browser. If a tour doesn't
play, tell them to run `/dg:browser install` first.

---

## Phase 1 — Understand and script

Read the relevant code (diff, PR, or files) and write a plain-English summary:

1. **What changed** — one short paragraph, no jargon.
2. **What it enables** — the user-visible effect.
3. **Key moments to show** — a numbered list of the interactions worth spotlighting.

This numbered list becomes the tour.

## Phase 2 — Author the tour plan (Markdown)

Write the tour as a Markdown **plan file** — YAML frontmatter plus a `## Steps` list, one
line per step (format + selector guidance in [references/authoring.md](references/authoring.md)).
You never hand-write JSON; the CLI reads this Markdown and generates the runnable script.

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

Each step line is `N. **title** [`selector`] [→ navigate-url] — body [`timing`]`. The trailing
`` `timing` `` is `4s` / `500ms` / a bare ms count for auto-advance, or `click` / `next`.
Keep text to a sentence or two; one idea per step. For **video**, add a `` `Ns` `` timing to
any step that should linger longer than the default (~3.5s).

## Phase 3 — Approval gate (required)

Present the plan as a readable step table — order, target selector, text-box copy, timing —
and **wait for the user's explicit approval**. Do not hand off before they OK it.
Adjust selectors/text on request and re-present.

## Phase 4 — Hand off to the extension

Commands run the compiled `dg-skills` CLI. In a dev checkout, compile the local
source so the demo exercises the latest code — never a stale released binary.
Otherwise fall back to the installed binary at `~/.dg/bin/dg-skills`, bootstrapping
it once if missing:

```bash
DG="$HOME/.dg/bin/dg-skills"
SRC="${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli"
if [ -f "$SRC/package.json" ]; then
  ( cd "$SRC" && bun run build ) && DG="$SRC/dist/dg-skills"   # dev: use freshly-compiled binary
fi
[ -x "$DG" ] || sh "$SRC/bootstrap.sh"                          # else download the release
# Windows PowerShell: & "$SRC/bootstrap.ps1"
```

Write the approved plan to `/tmp/ai/demo/tour.md`, then run the matching command:

**Walkthrough:**

```bash
"$DG" demo /tmp/ai/demo/tour.md
```

**Video:**

```bash
"$DG" demo --video /tmp/ai/demo/tour.md
```

Both open `startUrl` in the user's default browser with the tour encoded in a `_demo` marker;
the extension plays it and strips the marker. (A raw `.json` script is still accepted.)

**Review/edit in the browser (`--edit`):** add `--edit` to open a **stepper** panel instead
of playing. It walks the steps one at a time — spotlighting each target on the live page so
selectors can be verified — and lets the user improve any field (title, selector, body, timing,
navigate). On the final screen they **Download the plan (.md)**, **Play walkthrough**, or
**Record video**. Use this when the user wants to eyeball/tweak the tour before committing.

```bash
"$DG" demo --edit /tmp/ai/demo/tour.md
```

> **Dev checkout:** the browser runs the **extension**, not the CLI. If you changed extension
> code, rebuild + reload it (`bun run --filter='@dg/extension' build`, then reload the unpacked
> extension in `chrome://extensions`) — otherwise you're testing a stale UI.

- For **walkthrough**: confirm the browser opened and the tour is playing.
- For **video**: tell the user to **press `Alt+Shift+D`** (or click the DeeGee toolbar icon)
  **to start recording** — a modal in the page explains this. The tour then auto-plays and
  records; when it finishes, the extension saves
  `dg-demo/<tour>/<tour>.zip` — the video **and** its `plan.md` — to their **Downloads** folder
  and shows a confirmation. Chrome/Edge only (recording uses tabCapture + an offscreen document).
  The **recording mode** is set in the extension Settings page:
  - **Voiceover + captions** (default) — each step's `body` is spoken by local **Kokoro** and the
    text box stays on-screen.
  - **Voiceover only** — the body is spoken, the text box is hidden (the step title stays).
  - **Captions only** — silent; the on-screen text box only (skips Kokoro, no model load).

  Narrated modes speak each step's `body` (voice set in Settings); the first run downloads the
  ~86 MB model. If narration synthesis fails, the video still records silently.

## Replaying a saved demo

Every `demo` run saves `~/.dg/demos/<slug>/<slug>.demo.md`, and every video bundles a copy in its
`.zip`. Replay either without recompiling:

```bash
"$DG" rerun <path-to>.demo.md
# add --video to record the replay
```

The plan `.md` is human-readable; its embedded ```json``` block is the runnable script `rerun` extracts.
