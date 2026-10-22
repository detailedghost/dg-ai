# Browser Extension Install

Chrome and Edge do not allow a CLI to silently install an unpacked
extension. The `install` command copies the extension to a stable directory,
then prints the exact path to select with **Load unpacked**.

## WSL

Run:

```bash
~/.dg/bin/dg-skills install --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.0/pkg/skills-cli/bootstrap.sh | sh
~/.dg/bin/dg-skills install
```

The installer copies the extension to a Windows-native directory:

```text
%USERPROFILE%\.dg\dg-ai-extension-chrome
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
$dg = Join-Path $env:USERPROFILE ".dg\bin\dg-skills.exe"
if (-not (Test-Path $dg)) {
 irm https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.0/pkg/skills-cli/bootstrap.ps1 | iex
}
& $dg install
```

The installer copies the extension to:

```text
%USERPROFILE%\.dg\dg-ai-extension-chrome
```

Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**,
click **Load unpacked**, and select that path.

## Linux

Run:

```bash
~/.dg/bin/dg-skills install --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.0/pkg/skills-cli/bootstrap.sh | sh
~/.dg/bin/dg-skills install
```

The installer copies the extension to:

```text
~/.dg/dg-ai-extension-chrome
```

Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**,
click **Load unpacked**, and select that path.

## macOS

Run:

```bash
~/.dg/bin/dg-skills install --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.0/pkg/skills-cli/bootstrap.sh | sh
~/.dg/bin/dg-skills install
```

The installer copies the extension to:

```text
~/.dg/dg-ai-extension-chrome
```

Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**,
click **Load unpacked**, and select that path.

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
