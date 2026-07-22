# Browser Extension Install

Chrome and Edge do not allow a CLI to silently install an unpacked
extension. The `install` command copies the extension to a stable directory,
then prints the exact path to select with **Load unpacked**.

## WSL

Run:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/src/index.ts" install
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
bun "%CLAUDE_PLUGIN_ROOT%\skills\browser\bin\browser.ts" install
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
bun "${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/src/index.ts" install
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
bun "${CLAUDE_PLUGIN_ROOT}/pkg/skills-cli/src/index.ts" install
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
