# 👻 DeeGee

Personal Claude Code plugin for detailedghost. Skills: **browser**, **demo**.
Commands live under the `/dg:` namespace; the companion extension is
`dg-ai-extension`.

## 📦 Install

**As a Claude Code plugin** (the skills self-bootstrap the CLI on first use):

```text
/plugin marketplace add ~/code/dg
/plugin install dg@detailedghost
```

**Standalone — one command installs the `dg-skills` CLI *and* the browser
extension** (compiled binary, no Bun needed):

macOS / Linux (x64 or arm64):

<!-- markdownlint-disable MD013 -->

```bash
curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
```

Windows (x64 or arm64), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.ps1 | iex
```

<!-- markdownlint-enable MD013 -->

Both install `~/.dg/bin/dg-skills`, then run `dg-skills install` to stage the
extension and print the **Load unpacked** steps. Re-run `dg-skills install`
anytime to update. (Building the extension from source with `--local` needs
[Bun](https://bun.sh).)

### 🌐 Supported browsers

- **Chromium** — Chrome, Edge, Brave, Vivaldi, Opera (single build)
- **Firefox** 139+

## 🚀 Usage

One-time guided setup of the companion browser extension:

```text
/dg:browser install
```

Open a batch of PRs/URLs in your **default** browser, grouped into a named group:

```text
/dg:browser batch-open --group "Reviews" work#1517 work#1518
```

Or cold-start a **Chromium** browser (Brave/Edge/Vivaldi) with the extension
pre-loaded — no manual load step (`--list` shows what's installed):

```text
/dg:browser launch --browser brave-beta --group "PRs" work#1517 work#1518
```

Play a **live guided tour** of a feature in your real browser — the extension
spotlights each element and injects explanatory text boxes, step by step:

```text
/dg:demo 1517
```

You review the compiled tour script before it plays. Optional screenshots/video
land in your Downloads folder.

### 🔗 Ref formats

- Full URL
- `owner/repo#num`
- `alias#num` (aliases defined in `~/.config/browser-batch/config.json`)
- bare `num` with `--repo`

## 🧩 Extension

The companion `dg-ai-extension` does the grouping browser-side, built with
[WXT](https://wxt.dev) from `pkg/extension/` and targeting Chrome, Edge, Brave,
Vivaldi, and Firefox 139+ (grouping is feature-detected, skipped where absent).

Grouping is **opt-in per batch**: `batch-open`/`launch` append a
`#_tab_group=<name>` marker to each URL, the extension groups those tabs into
`<name>` and strips the marker. Tabs you open by hand are never grouped. Group
color is set in the extension's Options (default blue); the name comes from
`--group` (default `PRs`). `demo` works the same way with a `#_demo=` marker.

## 📚 References

- [Developer Guide](docs/DEVELOPER.md)
- [Agent Install Guide](docs/AGENT-INSTALL.md)
- [Contributing](docs/contributing.md)
