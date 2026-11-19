# Tab batches

`pw batch-open` and `pw launch` open a batch of PR or URL tabs in the human's
browser. They do not start a pw session. Below, `pw` means `dg-skills pw`.

## batch-open

`pw batch-open [--ext] [-g <name>] [-R owner/repo] [--print] <refs…>` resolves
the refs and opens them in the **default** browser, in the order given.

- Without `--ext`, it opens plain tabs and needs no extension.
- `--group` without `--ext` prints one stderr line and still opens plain tabs.
- `--ext -g <name>` groups the tabs into `<name>` (default `PRs`). Grouping
  happens only when the dg-ai-extension is loaded in that browser profile.
- `--print` prints the URLs and opens nothing.
- A missing ref is a usage error (exit 2).

## Refs

A ref is one of:

- a full URL
- `owner/repo#num`
- `alias#num`, with aliases in `~/.config/browser-batch/config.json`
- a bare `num`, with `-R owner/repo`

## launch

`pw --ext launch [-b <key>] [-g <name>] [-R owner/repo] [--list] [--dry-run] <refs…>`
cold-starts a **Chromium** browser (Brave, Edge, Vivaldi) with the extension
side-loaded through `--load-extension`, then opens the batch as a group.

- `launch` always needs `--ext`. Without it, it exits 1.
- `--list` lists the detected browsers. `--dry-run` prints the launch command.
- Close the chosen browser fully first: the flag applies only on a cold start.
- Chrome stable disabled the flag. Use Brave or Edge, or load the extension by
  hand once.
- `launch` does not support Firefox. Use `dg-skills install firefox`.

A CLI-only install refuses `pw launch` and `pw batch-open --ext`, and names
`dg-skills install` as the fix.

## How markers work

`batch-open --ext` and `launch` add a `#_tab_group=<name>` marker to each URL.
The extension groups the marked tabs, then strips the marker. It never touches
tabs you opened by hand.

## Group color

Set the group color in the extension's Options page. The default is a random
color per group. The name comes from `--group`, and the tab order from the ref
order.

## Install the extension

`dg-skills install [chrome|firefox] [--local] [--version <x.y.z>]` stages the
extension for a one-time load and refreshes the `dg-skills` binary. It downloads
the extension zip from the newest `vX.Y.Z` release, or builds it from source with
`--local` (needs Bun from https://bun.sh). `--version` pins a release; a missing
release fails the install before anything changes. The default target `chrome`
also serves Brave, Edge and Vivaldi. Relay the Load-unpacked steps it prints.

Chrome and Edge do not let a CLI install an unpacked extension silently, so
`install` copies the extension to a stable folder and prints the path to load:

| OS | Folder |
|---|---|
| WSL and Windows | `%LOCALAPPDATA%\dg\dg-ai-extension-chrome` |
| Linux | `~/.local/share/dg/dg-ai-extension-chrome` |
| macOS | `~/Library/Application Support/dg/dg-ai-extension-chrome` |

On WSL, load the printed Windows path, not a `\\wsl$` path. A UNC path is slower
and less reliable across reboots.

On native Windows PowerShell, run the installed launcher:

```powershell
$dg = if ($env:DG_HOME) { Join-Path $env:DG_HOME "bin\dg-skills.cmd" } else { Join-Path $env:LOCALAPPDATA "dg\bin\dg-skills.cmd" }
if (-not (Test-Path $dg)) {
 irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
}
& $dg install
```

Then load it once:

1. Open `chrome://extensions` or `edge://extensions`.
1. Turn on **Developer mode**.
1. Click **Load unpacked**.
1. Select the printed folder.

### After the folder move

Releases before the per-OS layout staged the extension in `~/.dg` (or
`%USERPROFILE%\.dg` on Windows). The first install after the move copies it to
the folder above and prints one line. Chrome remembers the old folder, so do this
once: remove the old `dg-ai-extension` entry at `chrome://extensions`, click
**Load unpacked**, and select the new folder. Later installs update that folder in
place, so a reload is enough.

### Updating

When the extension version goes up, run `install` again. It refreshes the copied
files and tells you to click the reload icon for the extension on
`chrome://extensions`.

### Options

The extension's **Options** page sets the URL patterns, group title and color.
The defaults are the pattern `*://github.com/*/*/pull/*` (scope it to your org),
the title `PRs` and a random color per group.

Demo tours belong to `/dg:demo`.
