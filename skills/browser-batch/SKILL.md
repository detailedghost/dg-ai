---
name: browser-batch
description: Open a batch of GitHub PRs or URLs in the browser and auto-group the resulting tabs. `install` sets up the companion Chrome/Edge/Firefox extension; `open <url…>` opens a batch in your default browser; `launch` cold-starts a selectable Chromium browser with the extension pre-loaded.
argument-hint: "install [chrome|firefox] | open <url…> | launch [--browser <key>] <url…>"
user-invocable: true
---

# Browser Batch

Open a batch of GitHub PRs/URLs and auto-group the tabs, via a companion
`dg-ai-browser-batch` web extension.

All commands run `bun`. If it's missing, `bun --version` fails — tell the user to
install Bun from https://bun.sh instead of surfacing a raw error.

Run everything through the dispatcher:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/browser-batch/bin/browser-batch.ts" <command> <args>
```

## Commands

- `install [chrome|firefox] [--local]` — stage the extension for a one-time load.
  Downloads the CI-built asset from the latest GitHub release (or builds locally
  with `--local` / in a source checkout), then prints the browser-specific
  Load-unpacked steps. Relay them. Default target is `chrome` (also serves
  Brave/Edge/Vivaldi). See `references/install.md` for full per-OS detail.

- `open <refs…>` — resolve refs and open them in the **default** browser. Grouping
  happens only if the extension is already loaded in that browser's profile.

- `launch [--browser <key>] [--list] <refs…>` — cold-start a **Chromium** browser
  (Brave/Edge/Vivaldi) with the extension side-loaded via `--load-extension`, then
  open the batch — no manual chrome://extensions step. Use `--list` to see detected
  browsers and their launchability. The chosen browser must be fully closed first
  (the flag only applies on a cold start). Chrome stable disabled the flag; Firefox
  isn't supported by `launch` (use `install firefox`).

Refs: full URL, `owner/repo#num`, `alias#num` (aliases in
`~/.config/browser-batch/config.json`), or bare `num` with `--repo owner/repo`.

Note: tabs group only in the browser profile where the extension is loaded.
