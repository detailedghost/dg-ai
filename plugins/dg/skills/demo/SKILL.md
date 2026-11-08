---
name: demo
description: Produce a guided demo that plays in a local browser (the default, no extension) — a recorded MP4 of a feature or PR with chapter cards, captions, and a highlight on each target, optionally after preparing authenticated, configured, or seeded setup state. Write a plan, verify it, and run it. Pass --ext to play it through the dg-ai-extension instead. Use when someone asks to demo, show off, walk through, or record a feature in the browser.
---

# Guided-tour demo

Turn a feature or PR into a demo. **Local mode always records.** It has no start
screen, no review, and no walkthrough. Your job: write a plan, verify it, run it,
and report the MP4 path. `--ext` keeps the interactive extension tour.

## Step 1 — Write the plan

Read the relevant code first. Write the tour as a Markdown plan: YAML frontmatter, an
optional `## Setup` list, and a required `## Steps` list. Never hand-write JSON.

```markdown
---
title: How to use Google
startUrl: https://www.google.com
intro: "Demo | How to use Google | A two-minute tour"
outro: "Done | That is the basics | Thanks for watching"
---

## Steps

1. **Welcome to Google** — This quick tour shows the basics. `4s`
2. **The search box** `textarea[name="q"]` @type="cute puppies" — Type a query. `4.5s`
3. **Open results** `a#more` @click → https://www.google.com/search — Navigates, then highlights. `3s`
```

A step is `N. **title** [`selector`] [→ navigate-url] [action] — body [`timing`]`.
The timing is `4s`, `500ms`, or a bare ms count. Keep each body to a sentence or two.
The recorder clicks and types for real. Use `@click` and `@type="..."` for every
interaction. Full grammar: [references/authoring.md](references/authoring.md).

`intro` and `outro` are `"Eyebrow | Title | Detail"`. The intro defaults to the eyebrow
`Demo` and the plan `title`. No outro plays unless you set one.

### Credentials

Type a secret with `@type="$NAME"`. The recorder types the value of environment variable
`NAME`. The plan never holds the value. Logs and results never print it. In a recorded
step, an unset `NAME` refuses with exit 2: `demo: set $NAME or move the login to ## Setup`.

### Setup steps, when the tour needs prerequisite state

Use `## Setup` only for state the tutorial can't reach on its own, such as a login,
seeded records, or a feature flag. Keep `includeSetup: false` (the default) unless the
human asks to show the preparation. Setup runs first in an unrecorded context and hands
its login to the recording. **video narration and capture start only after that handoff**, so a recording
never contains the preparation. With `includeSetup: true`, setup steps become the
leading tutorial steps. The human types credentials, MFA codes, and CAPTCHA answers.
Never put those values in a fill action. Use `@type="$NAME"` for a password instead.

If a setup fill names an unset variable, a headed window opens and shows
"Type it here, then continue." The human types the value there. Then the run goes on
after a navigation, or when the next setup step's selector appears. End setup on the
page after login, for example with a last setup step that targets an element of the
signed-in page. A headless-only plan, such as WSL without `--windows` or
`--wsl-headed`, refuses this case with exit 2.

## Step 2 — Verify, then record

Write the plan to `/tmp/ai/demo/tour.md`. Install the CLI when it is missing:

```bash
dg-skills demo --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg-skills" demo --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

Call `dg-skills` in every later step. If `dg-skills` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg-skills` instead.

On Windows PowerShell, pipe the raw `bootstrap.ps1` to `Invoke-Expression`.
If a step fails, run dg-skills doctor demo install rerun pw.
The `demo doctor` subcommand checks the browser, `ffmpeg`, and `ffprobe`.

Walk the plan first, so you hit a bad selector before the human does.
Run `dg-skills demo --verify /tmp/ai/demo/tour.md`. It drives the recorder in a dry run
and prints `{"ok": boolean, "findings": [...]}`. A finding is `selector-unresolved`,
`env-unset` (it names the variable), `plan-unreadable`, or `harness-error`.
A click that submits a form and navigates is fine. Fix the plan and rerun, at most 3 passes.
If a finding cannot be fixed, surface it to the human.

Then record:

```bash
dg-skills demo /tmp/ai/demo/tour.md
```

Add `-n` only when the human asks for voice. The command starts the recorder and returns.
Run `dg-skills demo status <slug>` until it prints the result. The result holds the MP4
path. Report that path to the human.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--ext` | none | Play through the dg-ai-extension in the human's own browser. Needs the extension. | off (local is the default) |
| `--video` | none | Accepted and ignored. Local mode always records. | off |
| `--narration` | `-n` | Switch, no value. Adds a Kokoro voice (`af_heart`) to the captions. | off (captions only, silent video) |
| `--out <path>` | none | Where the MP4 goes. Must end in `.mp4` and sit outside a git work tree. | `<cacheDir>/demos/<slug>/<slug>-<stamp>.mp4` |
| `--browser <name>` | none | `chrome`, `msedge`, or `chromium`. Skips the browser finder. | first found |
| `--windows` | none | WSL: drive the Windows browser over CDP. | on when a Windows browser exists |
| `--wsl-headed` | none | WSL: headed browser inside WSL (experimental). Agents never pass `--wsl-headed` unless the human asks. | off |
| `--timeout <min>` | none | Minutes before the recorder stops. | 30 |
| `--verify <plan>` | none | Dry-run the plan and print findings JSON. Local unless `--ext`. | off |
| `--print` | none | `--ext` only: print the marker URL. | off |
| `--edit` | none | `--ext` only: open the review panel first. | off |
| `--attach-pr <pr>` | none | Skill flag, not a CLI flag: after the run, attach the video to a GitHub PR. See [references/attach-pr.md](references/attach-pr.md). | off |

Local-only flags with `--ext` fail with exit 1.

## Browser

One finder picks the browser. It checks `DG_BROWSER` (alias `DG_VERIFY_BROWSER`),
Chrome, Edge, Brave, Chromium, Vivaldi, Chrome for Testing on PATH, the usual macOS and
Windows app folders, then the downloaded Chromium. Only then does it suggest
`dg-skills pw install-browser`. Set `DG_BROWSER` to force one.

On WSL, `demo` drives the Windows browser by default and falls back to headless
Chromium inside WSL. The Windows browser opens a remote-debugging port on 127.0.0.1
while the run is live. For a recording with no port, pass `--browser chromium`. See
[ADR 0029](https://github.com/detailedghost/dg-ai/blob/master/docs/adr/0029-local-demo-player-wsl-debug-port.md).

## Output and narration

The output is an MP4: H.264, 1440x810, 30 fps, checked with `ffprobe`. It needs
`ffmpeg`. Without it, the raw webm stays, with a sidecar `.wav` when narrated, and the
CLI prints a warning.

The voice model downloads on the first voiced run (about 86 MB, pinned revision). The
CLI checksum-verifies the asset zip. The recorder makes the voice before the recording,
on a page it controls, so a site Content Security Policy cannot block it. The overlays
are plain DOM, so a strict policy does not block them either. Offline, the run falls
back to captions.

## Replay and extension

Every run saves `<cacheDir>/demos/<slug>/<slug>.demo.md`. Replay it with
`dg-skills rerun <path-to>.demo.md`. Add `--ext` to `demo` or `rerun` to play through
the extension: [references/extension.md](references/extension.md).
