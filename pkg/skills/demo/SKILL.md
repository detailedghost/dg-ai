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

## Phase 2 — Compile the tour script

Turn the moments into a `TourScript` (schema + selector guidance in
[references/authoring.md](references/authoring.md)). Each step needs a stable CSS `selector`,
a short `title`, terse `body` text, and an `advance` mode. Use `navigate` for multi-page tours.

Keep text boxes to a sentence or two; keep steps atomic (one idea each). For **video**, set
`advance` to a number (ms) on any step that should linger longer than the default (~3.5s).

## Phase 3 — Approval gate (required)

Present the compiled script as a readable step table — order, target selector, text-box copy,
advance mode — and **wait for the user's explicit approval**. Do not hand off before they OK it.
Adjust selectors/text on request and re-present.

## Phase 4 — Hand off to the extension

Write the approved script to `/tmp/ai/demo/tour.json`, then run the matching command:

**Walkthrough:**

```bash
bun "${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/src/index.ts" demo /tmp/ai/demo/tour.json
```

**Video:**

```bash
bun "${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/src/index.ts" demo --video /tmp/ai/demo/tour.json
```

Both open `startUrl` in the user's default browser with the tour encoded in a `_demo` marker;
the extension plays it and strips the marker.

- For **walkthrough**: confirm the browser opened and the tour is playing.
- For **video**: tell the user to **press `Alt+Shift+D` to start recording** — a modal in the
  page explains this. (The toolbar icon opens Settings, not recording — only the shortcut starts
  capture.) The tour then auto-plays and records; when it finishes, the extension saves
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
bun "${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/src/index.ts" rerun <path-to>.demo.md
# add --video to record the replay
```

The plan `.md` is human-readable; its embedded ```json``` block is the runnable script `rerun` extracts.
