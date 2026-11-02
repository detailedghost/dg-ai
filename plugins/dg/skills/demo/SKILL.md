---
name: demo
description: Produce a guided demo that plays in a local browser (the default, no extension) — a tour of a feature or PR that spotlights each element and shows an explanatory text box, optionally after preparing authenticated, configured, or seeded setup state. Write a plan, open it, and the human picks review, walkthrough, or video on the start screen. Pass --ext to play it through the dg-ai-extension instead. Use when someone asks to demo, show off, walk through, or record a feature in the browser.
---

# Guided-tour demo

Turn a feature or PR into a guided tour. **Your job is two steps: write a plan file,
then open it.** The human picks review, walkthrough, video, and narration on the
start screen. Don't ask them in chat.

## Step 1 — Write the plan

Read the relevant code first. Write the tour as a Markdown plan: YAML frontmatter, an
optional `## Setup` list, and a required `## Steps` list. Never hand-write JSON.

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

A step is `N. **title** [`selector`] [→ navigate-url] [action] — body [`timing`]`.
The timing is `4s`, `500ms`, a bare ms count, `click`, or `next`. `mode:` is only a
default; the human picks the real mode. Keep each body to a sentence or two. Add a
`Ns` timing to a video step that needs more than the default dwell (about 3.5 s).
Full grammar: [references/authoring.md](references/authoring.md).

### Setup steps, when the tour needs prerequisite state

Use `## Setup` only for state the tutorial can't reach on its own, such as a login,
seeded records, or a feature flag. Keep `includeSetup: false` (the default) unless the
human asks to show the preparation. **video narration and capture start only after that handoff**, so a recording
never contains the preparation. With `includeSetup: true`, setup steps become the
leading tutorial steps. The human types credentials, MFA codes, and CAPTCHA answers.
Never put those values in a fill action.

## Step 2 — Open it in a browser

Write the plan to `/tmp/ai/demo/tour.md`. Install the CLI when it is missing:

```bash
~/.dg/bin/dg-skills demo --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

On Windows PowerShell, pipe the raw `bootstrap.ps1` to `Invoke-Expression`.
If a step fails, run ~/.dg/bin/dg-skills doctor demo install rerun.

Walk the plan yourself first, so you hit a bad selector before the human does.
Run `~/.dg/bin/dg-skills demo --verify /tmp/ai/demo/tour.md`. It prints `{"ok": boolean, "findings": [...]}`. A finding is `selector-unresolved`,
`unrecorded-navigation`, or `page-mismatch`. Fix the plan and rerun, at most 3 passes.
If a finding cannot be fixed, surface it to the human.

Run one command, with no `--video` flag, because the mode is chosen in the browser:

```bash
~/.dg/bin/dg-skills demo /tmp/ai/demo/tour.md
```

It opens `startUrl` in a local browser and shows the **start screen**, which is the approval gate, then returns.
Confirm the `start screen open` line printed, then stop. `dg-skills demo status <slug>` prints the result later.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--ext` | none | Play through the dg-ai-extension in the human's own browser. Needs the extension. | off (local is the default) |
| `--video` | none | Record now with no start screen. Works with a headless browser. | off (start screen) |
| `--narration <mode>` | none | With `--video`: `both`, `voice`, or `captions`. | saved start-screen choice |
| `--out <path>` | none | Where the `.webm` goes. | `<state>/demos/<slug>/<slug>-<ts>.webm` |
| `--browser <name>` | none | `chrome`, `msedge`, or `chromium`. Skips the system-first pick. | first found |
| `--windows` | none | WSL: drive the Windows browser over CDP. | on when a Windows browser exists |
| `--wsl-headed` | none | WSL: headed browser inside WSL (experimental). Agents never pass `--wsl-headed` unless the human asks. | off |
| `--timeout <min>` | none | Minutes to wait for the human before the player stops. | 30 |
| `--verify <plan>` | none | Walk the plan and print findings JSON. Local unless `--ext`. | off |
| `--print` | none | `--ext` only: print the marker URL. | off |
| `--edit` | none | `--ext` only: open the review panel first. | off |

On WSL, `demo` drives the Windows browser by default and falls back to headless
Chromium inside WSL, like the [`pw` skill](../pw/SKILL.md). Headless needs `--video`.
The Windows browser opens a remote-debugging port on 127.0.0.1 while the run is live.
For a recording with no port, pass `--video --browser chromium`. See
[ADR 0029](https://github.com/detailedghost/dg-ai/blob/master/docs/adr/0029-local-demo-player-wsl-debug-port.md).

## Narration

The voice model downloads on the first voiced run (about 86 MB, pinned revision). The
CLI checksum-verifies the asset zip. `ffmpeg` is optional. Without it, the CLI keeps a
sidecar `.wav` beside the video. Offline, the run falls back to captions. A site
Content Security Policy can block the in-page voice. The run then records without
voice and says why.

## Replay and extension

Every run saves `<state>/demos/<slug>/<slug>.demo.md`. Replay it with
`~/.dg/bin/dg-skills rerun <path-to>.demo.md`. Add `--video` to record the replay.
Add `--ext` to `demo` or `rerun` to play through the extension:
[references/extension.md](references/extension.md).
