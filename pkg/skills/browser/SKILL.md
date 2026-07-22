---
name: browser
description: Open/group GitHub PR & URL tabs and play guided in-browser demo tours, via the companion dg-ai-extension. `install` sets up the extension; `batch-open <url…>` opens a grouped batch in your default browser; `launch` cold-starts a Chromium browser with the extension pre-loaded; `demo <script.json>` plays a guided tour. Grouping/tours are opt-in per invocation via URL markers, so hand-opened tabs are never touched.
argument-hint: "install [chrome|firefox] | batch-open [--group <name>] <url…> | launch [--browser <key>] <url…> | demo <script.json> | rerun <plan.md>"
user-invocable: true
---

# Browser

Open/group GitHub PR & URL tabs and play guided in-browser demo tours, via a
companion `dg-ai-extension` web extension.

All commands run `bun`. If it's missing, `bun --version` fails — tell the user to
install Bun from https://bun.sh instead of surfacing a raw error. The CLI depends
on `commander`; if a run reports it missing, run `bun install` once in
`${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli`.

Run everything through the dispatcher:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/src/index.ts" <command> <args>
```

## Commands

- `install [chrome|firefox] [--local]` — stage the extension for a one-time load.
  Downloads the CI-built asset from the latest GitHub release (or builds locally
  with `--local` / in a source checkout), then prints the browser-specific
  Load-unpacked steps. Relay them. Default target is `chrome` (also serves
  Brave/Edge/Vivaldi). See `references/install.md` for full per-OS detail.

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
  the marker. Authored/driven by the `/dg:demo` skill — see that skill for the
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
