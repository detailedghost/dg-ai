---
name: demo
description: Produce a guided in-browser demo of a feature or PR — optionally preparing authenticated, configured, or seeded setup state first — then use the dg-ai-extension to spotlight each element and inject explanatory text boxes in the user's real browser. Write a plan, open it in the extension, and the user picks review / walkthrough / video there. Use when someone asks to demo, show off, walk through, or record a feature in the browser.
---

# Guided-tour demo

Turn a feature or PR into a guided tour that spotlights each element and shows an
explanatory text box, step by step. It plays in a local browser, or with `--ext` in the
user's real browser through the companion `dg-ai-extension`.

**Your job is two steps: write a plan file, then open it.** Everything else — reviewing,
choosing walkthrough vs video, picking the narration voice — the user does on the
start screen. Don't ask them in chat; the browser asks.

By default the tour plays in a local browser the CLI starts, with no extension. Add
`--ext` to play it through the dg-ai-extension in the user's own browser instead.

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

## Step 2 — Open it in a browser

Write the plan to `/tmp/ai/demo/tour.md`. First run: install or refresh the CLI when it is missing or too old. In a dev checkout,
rebuild and reinstall `~/.dg/bin/dg-skills` so the demo and the verify pass below use
the latest code:

```bash
~/.dg/bin/dg-skills demo --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

If a step fails, run ~/.dg/bin/dg-skills doctor demo install rerun.

On Windows PowerShell, pipe the repository's raw `bootstrap.ps1` to `Invoke-Expression`.

### Verify, then correct, then repeat — bounded

Before handing the plan to the user, walk it yourself in a real throwaway browser —
you are the first one to hit a bad selector or an unrecorded navigation, not them:

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

### Open it

Run **one** command — no `--video` flag, because the mode is chosen in the browser:

```bash
~/.dg/bin/dg-skills demo /tmp/ai/demo/tour.md
```

This opens `startUrl` in a browser and shows the **start screen**,
which is the approval gate, then returns. Confirm the `start screen open` line printed, then stop — the
rest is the user's. `dg-skills demo status <slug>` prints the result later. A raw `.json` script is
also accepted.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--ext` | none | Play through the dg-ai-extension in the user's real browser. Needs the extension. | off (local is the default) |
| `--video` | none | Record now with no start screen; works with a headless browser. | off (start screen) |
| `--out <path>` | none | Where the video file goes. | `<state>/demos/<slug>/<slug>-<ts>.webm` |
| `--browser <name>` | none | `chrome`, `msedge` or `chromium`; skips the system-first pick. | first found |
| `--windows` | none | WSL: drive the Windows-side browser over CDP. | on when a Windows browser exists |
| `--wsl-headed` | none | WSL: headed browser inside WSL (experimental). Agents never pass `--wsl-headed` unless the human asks. | off |
| `--verify <plan>` | none | Walk the plan and print findings JSON. Local unless `--ext`. | off |
| `--print` | none | `--ext` only: print the marker URL. | off |
| `--edit` | none | `--ext` only: open the review panel first. | off |

On WSL, the default `demo` uses the Windows browser. The CLI controls it through a
remote-debugging port on 127.0.0.1, and the port stays open while the run is live. To
not open that port, use `--video --browser chromium` for a headless recording inside WSL.
`--video` alone still uses the Windows browser when one is present.
Any local process can attach to that port during the run. See
[ADR 0029](../../../../docs/adr/0029-local-demo-player-wsl-debug-port.md).

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
auto-plays and saves `dg-demo/<tour>/<tour>.webm` and `dg-demo/<tour>/<tour>.demo.md` to
their Downloads. Chrome/Edge only (tabCapture + an offscreen document). The first
narrated run downloads the ~86 MB Kokoro model; if synthesis fails the video still
records silently.

> **Dev checkout:** the browser runs the **extension**, not the CLI. If you changed
> extension code, rebuild and re-stage it (`bun run --filter='@dg/extension' build`, then
> `dg-skills install --local`), and reload it in `chrome://extensions` — otherwise you're
> testing a stale UI. On WSL the loaded copy is the Windows staging dir, not `.output/`.

## Replaying a saved demo

Every run saves `<state>/demos/<slug>/<slug>.demo.md` (older runs sit in `~/.dg/demos`),
and every `--ext` recorded video downloads alongside a copy as `<slug>.demo.md`. Replay either without recompiling:

```bash
~/.dg/bin/dg-skills rerun <path-to>.demo.md
~/.dg/bin/dg-skills rerun --ext <path-to>.demo.md
# add --video to record the replay
```

The first command replays locally. Add `--ext` to replay through the extension.

The plan `.md` is human-readable; its embedded ```json``` block is the runnable script
`rerun` extracts.
