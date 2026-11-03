# Browser Extension Install

Chrome and Edge do not allow a CLI to silently install an unpacked
extension. The `install` command copies the extension to a stable directory,
then prints the exact path to select with **Load unpacked**.

## WSL

Run:

```bash
dg-skills install --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
dg-skills install
```

The installer copies the extension to a Windows-native directory:

```text
%LOCALAPPDATA%\dg\dg-ai-extension-chrome
```

Use the printed Windows path in Chrome/Edge. This avoids loading from a
`\\wsl$` UNC path, which can be slower, less reliable across reboots, and
awkward for browser extension reloads.

Then:

1. Open `chrome://extensions` or `edge://extensions`.
1. Enable **Developer mode**.
1. Click **Load unpacked**.
1. Select the printed Windows path.
1. Done.

## Native Windows

Run:

```powershell
$dg = Join-Path $env:LOCALAPPDATA "dg\bin\dg-skills.cmd"
if (-not (Test-Path $dg)) {
 irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
}
& $dg install
```

The installer copies the extension to:

```text
%LOCALAPPDATA%\dg\dg-ai-extension-chrome
```

Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**,
click **Load unpacked**, and select that path.

## Linux

Run:

```bash
dg-skills install --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
dg-skills install
```

The installer copies the extension to:

```text
~/.local/share/dg/dg-ai-extension-chrome
```

Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**,
click **Load unpacked**, and select that path.

## macOS

Run:

```bash
dg-skills install --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
dg-skills install
```

The installer copies the extension to:

```text
~/Library/Application Support/dg/dg-ai-extension-chrome
```

Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**,
click **Load unpacked**, and select that path.

## After the folder move

Releases before the per-OS layout staged the extension in `~/.dg` (or
`%USERPROFILE%\.dg` on Windows). The first install after the move copies it to
the folder above and prints one line. Chrome remembers the old folder, so do
this once: open `chrome://extensions`, remove the old `dg-ai-extension` entry,
click **Load unpacked**, and select the new folder. Later installs update that
folder in place, so a reload is enough.

## Updating

If the vendored extension version increases, rerun `install`. The script
refreshes the copied files and tells you to click the reload icon for the
extension on `chrome://extensions`.

## Options

Open the extension's **Options** page to change URL patterns, group title, or color.

Defaults:

- Pattern: `*://github.com/*/*/pull/*` (scope this to your org in Options)
- Title: `PRs`
- Color: `blue`
