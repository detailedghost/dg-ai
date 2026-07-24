---
name: browser
description: Open and group GitHub PR or URL tabs and play guided in-browser demo tours with the companion dg-ai-extension. Use install to set up the extension, batch-open to open grouped tabs in the default browser, launch to cold-start Chromium with the extension, and demo to play a tour. Grouping and tours are opt-in through URL markers, so hand-opened tabs are never touched.
---

# Browser

Open/group GitHub PR & URL tabs and play guided in-browser demo tours, via a
companion `dg-ai-extension` web extension.

Commands run the **compiled `dg-skills` CLI** at `~/.dg/bin/dg-skills` — a
self-contained binary, no Bun needed at runtime. On first use, bootstrap it once
(downloads the binary for your platform from the latest `skills-v*` release):

```bash
DG="$HOME/.dg/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

On Windows PowerShell, run the local `bootstrap.ps1` through
`$env:CLAUDE_PLUGIN_ROOT` when available; otherwise pipe the repository's raw
`bootstrap.ps1` to `Invoke-Expression`.

Then run every command through it:

```bash
"$DG" <command> <args>
```

`install` refreshes both the extension and the `dg-skills` binary, so re-running
it keeps the CLI current. (The `--local` dev path builds the extension from
source and needs Bun from https://bun.sh.)

## Commands

- `install [chrome|firefox] [--local]` — stage the extension for a one-time load
  **and** refresh the compiled `dg-skills` binary. Downloads the CI-built
  extension zip from the latest `ext-v*` release (or builds locally with
  `--local` / in a source checkout) and the platform `dg-skills` binary from the
  latest `skills-v*` release, then prints the browser-specific Load-unpacked
  steps. Relay them. Default target is `chrome` (also serves Brave/Edge/Vivaldi).
  See `references/install.md` for full per-OS detail.

- `batch-open [--group <name>] [--repo owner/repo] [--print] <refs…>` — resolve
  refs and open them in the **default** browser, grouped into `<name>` (default
  `PRs`), in the order the refs are given. Grouping happens only if the extension
  is loaded in that profile.

- `launch [--browser <key>] [--group <name>] [--list] [--dry-run] <refs…>` —
  cold-start a **Chromium** browser (Brave/Edge/Vivaldi) with the extension
  side-loaded via `--load-extension`, then open the batch — no manual
  chrome://extensions step. Use `--list` to see detected browsers. The chosen
  browser must be fully closed first (the flag only applies on a cold start).
  Chrome stable disabled the flag; Firefox isn't supported by `launch` (use
  `install firefox`).

- `demo [--print] <script.json>` — play a guided tour. Encodes the tour script
  into a `#_demo=<base64url>` marker on its `startUrl` and opens it in the default
  browser; the extension spotlights each step and injects text boxes, then strips
  the marker. Authored/driven by the demo skill — see that skill for the
  script schema. `--print` emits the marked URL instead of opening it. Each run
  also saves a re-runnable `~/.dg/demos/<slug>/<slug>.demo.md`.

- `rerun [--video] [--print] <plan.md>` — replay a saved demo plan (written by
  `demo` or bundled in a recording's `.zip`) without recompiling. Extracts the
  runnable script from the plan's ```json``` block and hands it to the extension.

Refs: full URL, `owner/repo#num`, `alias#num` (aliases in
`~/.config/browser-batch/config.json`), or bare `num` with `--repo owner/repo`.

How markers work: `batch-open`/`launch` append a `#_tab_group=<name>` marker to
each URL and the extension groups those tabs; `demo` appends a `#_demo=` marker
and the extension plays the tour. In both cases the extension strips the marker
after acting, and only marked tabs are touched — tabs you open by hand are never
grouped. Group color is set in the extension's Options (default **random** per
group); the name comes from `--group` and the batch order from the ref order.
