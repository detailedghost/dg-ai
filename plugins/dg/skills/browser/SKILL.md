---
name: browser
description: Open PR or URL tabs in the default browser (local mode, the default). Add --ext to group the tabs, cold-start Chromium with launch, or play demo tours through the companion dg-ai-extension; install sets that extension up. Grouping and tours use URL markers, so hand-opened tabs are never touched.
---

# Browser

Open PR and URL tabs in the default browser. Plain tabs open without the
extension. `--ext` is the opt-in for tab groups, `launch`, and demo tours through
the companion `dg-ai-extension`.

Commands run the **compiled `dg-skills` CLI** at `~/.dg/bin/dg-skills` — a
self-contained binary, no Bun needed at runtime. On first use, bootstrap it once
(downloads the binary for your platform from the latest `skills-v*` release):

```bash
~/.dg/bin/dg-skills install --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

If a step fails, run ~/.dg/bin/dg-skills doctor install batch-open launch demo.

On Windows PowerShell, pipe the repository's raw `bootstrap.ps1` to
`Invoke-Expression`.

Then run every command through it:

```bash
~/.dg/bin/dg-skills <command> <args>
```

`install` refreshes the `dg-skills` binary, so re-running it keeps the CLI
current.

## Commands

**Usage:** `/dg:browser batch-open [--ext] [--group <name>] [--repo owner/repo] [--print] <refs>` · `launch --ext [--browser <key>] [--group <name>] [--list] [--dry-run] <refs>` · `install [chrome|firefox] [--local] [--version <x.y.z>]` · `demo --ext [--print] <script.json>` · `rerun --ext [--print] <plan.md>`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--ext` | none | batch-open, launch, demo, rerun: use the dg-ai-extension (tab groups, side-loaded launch, tours). | off (local is the default) |
| `--group <name>` | `-g` | batch-open (with `--ext`) and launch: tab group name. Callers such as pushup pass their own name. | `PRs` |
| `--repo owner/repo` | none | batch-open: repository for bare PR numbers. | current repo |
| `--print` | none | batch-open and demo: print the URLs without opening them. | off |
| `--browser <key>` | none | launch: Chromium browser to start. | first launchable browser |
| `--list` | none | launch: list detected browsers. | off |
| `--dry-run` | none | launch: show what would run without starting the browser. | off |
| `--video` | none | rerun (with `--ext`): record the replay as a video. | off |
| `--local` | none | install: build the extension from source. | off (download the release) |
| `--version <x.y.z>` | none | install: pin the skills-v/daemon-v/agent-v/ext-v release to install, instead of each one's newest. | unset (newest) |

## Local mode

`batch-open <refs…>` resolves refs and opens them as plain tabs in the **default** browser, in the order given. Plain tabs need no extension. `--group` without `--ext` prints one stderr line and opens plain tabs. Add `--print` to emit the URLs without opening them.

Refs: full URL, `owner/repo#num`, `alias#num` (aliases in
`~/.config/browser-batch/config.json`), or bare `num` with `--repo owner/repo`.

## --ext mode

Every command here except `install` needs the extension. See [references/extension.md](references/extension.md) for markers, group color, and the Load-unpacked steps.

- `batch-open --ext --group <name> <refs…>` groups the tabs into `<name>` when the extension is loaded in that profile.
- `launch --ext <refs…>` cold-starts a Chromium browser with the extension side-loaded, then opens the batch.
- `install [chrome|firefox]` stages the extension for a one-time load and refreshes the `dg-skills` binary. Per-OS detail: `references/install.md`.
- `demo --ext <script.json>` and `rerun --ext <plan.md>` play a guided tour through the extension. The demo skill owns the script schema.
