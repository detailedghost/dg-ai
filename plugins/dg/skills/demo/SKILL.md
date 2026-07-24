---
name: demo
description: Produce a guided in-browser demo of a feature or PR — optionally preparing authenticated, configured, or seeded setup state first — then use the dg-ai-extension to spotlight each element and inject explanatory text boxes in the user's real browser. Supports `walkthrough` (live, user-paced) and `video` (auto-play and recording). Compile a tour script, review and approve it in the extension, then play it. Use when someone asks to demo, show off, walk through, or record a feature in the browser.
---

# Guided-tour demo

Turn a feature or PR into a guided tour that plays in the user's real browser: the
companion `dg-ai-extension` spotlights each element and shows an explanatory text box,
step by step. You compile the tour, then the user reviews and approves it in the
extension before playback.

Two modes (first arg; default `walkthrough`):

- **`walkthrough`** — live and user-paced. The user clicks Next/Back through the steps.
- **`video`** — auto-plays hands-free and records the tour, saving a `.zip` (the video
  **plus** a re-runnable `plan.md`) to the user's Downloads.

Every run also saves a durable, re-runnable plan under `~/.dg/demos/<slug>/<slug>.demo.md`.
Replay any saved plan with **`rerun`** (see below) — no need to recompile.

**Prerequisite:** the extension must be loaded in the user's browser. If a tour
doesn't play, tell them to run the browser skill's `install` command first.

---

## Phase 1 — Understand and script

Read the relevant code (diff, PR, or files) and write a plain-English summary:

1. **What changed** — one short paragraph, no jargon.
2. **What it enables** — the user-visible effect.
3. **Key moments to show** — a numbered list of the interactions worth spotlighting.

Identify any prerequisite state separately from the key moments. The numbered
key-moment list becomes the tutorial.

## Phase 2 — Optional setup (off-demo by default)

Use setup only when the tutorial needs prerequisite state, such as an
authenticated session, sample records, configuration, feature flags, or a
specific page state.

1. List the minimum prerequisites separately from the tutorial.
2. Author reproducible preparation in `## Setup`, using the same grammar as
   tutorial steps.
3. Keep `includeSetup: false` unless the user explicitly asks to show the setup
   as part of the tutorial.
4. Ask the user to enter credentials, MFA codes, CAPTCHA answers, or other
   secrets manually. Never put those values in a fill action.

With `includeSetup: false`, the extension runs setup first as a durable,
user-paced phase, then hands off to the tutorial. Video narration and capture
start only after that handoff. With `includeSetup: true`, setup steps become the
leading tutorial steps and are included in narration, timing, progress, and
recording.

If no preparation is needed, omit both `includeSetup` and `## Setup`.

## Phase 3 — Author the tour plan (Markdown)

Write the tour as a Markdown **plan file** — YAML frontmatter, an optional
`## Setup` list, and a required `## Steps` list, one line per step (format +
selector guidance in [references/authoring.md](references/authoring.md)). You
never hand-write JSON; the CLI reads this Markdown and generates the runnable
script.

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

## Phase 4 — Review and approval in the extension (required)

**Always open a newly authored tour in the extension's stepper editor
immediately after compiling it.** Do not present a chat approval table or wait
for chat approval first. The extension editor is the approval gate for both
Claude Code and Codex: it lets the user verify selectors against the live page,
edit every field, and explicitly choose playback or recording only when the
plan is ready.

Do not launch a new tour directly with `demo` or `demo --video`; those paths
skip the required extension review stage.

Commands run the compiled `dg-skills` CLI. In a dev checkout, compile the local
source so the demo exercises the latest code — never a stale released binary.
Otherwise fall back to the installed binary at `~/.dg/bin/dg-skills`, bootstrapping
it once if missing:

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
  ( cd "$SRC" && bun run build ) && DG="$SRC/dist/dg-skills"   # dev: use freshly-compiled binary
fi
if [ ! -x "$DG" ]; then
  if [ -n "$SRC" ]; then
    sh "$SRC/bootstrap.sh"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

On Windows PowerShell, use the checkout's `bootstrap.ps1` when a local source
tree was found; otherwise pipe the repository's raw `bootstrap.ps1` to
`Invoke-Expression`.

Write the compiled plan to `/tmp/ai/demo/tour.md`, then run the matching command:

**Walkthrough:**

```bash
"$DG" demo --edit /tmp/ai/demo/tour.md
```

**Video:**

```bash
"$DG" demo --video --edit /tmp/ai/demo/tour.md
```

Both open `startUrl` in the user's default browser with the tour encoded in a
`_demo` marker and show the stepper editor. It reviews setup before tutorial
steps, displays whether setup will be included, spotlights targets on the live
page, and lets the user improve every field. On the final screen the user may
toggle setup inclusion, **Download the plan (.md)**, **Play walkthrough**, or
**Record video**. (A raw `.json` script is still accepted.)

> **Dev checkout:** the browser runs the **extension**, not the CLI. If you changed extension
> code, rebuild + reload it (`bun run --filter='@dg/extension' build`, then reload the unpacked
> extension in `chrome://extensions`) — otherwise you're testing a stale UI.

- Confirm that the browser opened to the stepper editor. The user completes the
  review there and chooses **Play walkthrough** or **Record video**.
- For **video**, excluded setup runs before the recording prompt. After setup
  hands off to the tutorial, tell the user to press **`Alt+Shift+D`** (or click
  the DeeGee toolbar icon) **to start recording**. The tour then auto-plays and
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
