# 👻 DeeGee

Browser workflow plugin for Codex and Claude Code. Skills: **browser**, **demo**,
and **live-page prototype**. The companion extension is `dg-ai-extension`.

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

### Codex plugin

Install from this repository's Codex marketplace:

```bash
codex plugin marketplace add detailedghost/dg-ai
codex plugin add dg@detailedghost
```

Start a new Codex thread after installation. The shared skills bootstrap the CLI
on first use.

To install the same skills directly into `$CODEX_HOME/skills` without the Codex
plugin, opt in while bootstrapping:

```bash
DG_INSTALL_CODEX=1 curl -fsSL \
  https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
```

PowerShell standalone installation:

```powershell
$env:DG_INSTALL_CODEX = "1"
irm https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.ps1 | iex
```

The standalone path copies the skills to `$CODEX_HOME/skills` (or
`~/.codex/skills`). Start a new Codex thread after either installation method.

### 🌐 Supported browsers

- **Chromium** — Chrome, Edge, Brave, Vivaldi, Opera (single build)
- **Firefox** 139+

## 🚀 Usage

Claude Code invokes these as `/dg:*`; Codex invokes them as `$dg:*`.

One-time guided setup of the companion browser extension:

```text
Claude Code: /dg:browser install
Codex:      $dg:browser install
```

Open a batch of PRs/URLs in your **default** browser, grouped into a named group:

```text
Claude Code: /dg:browser batch-open --group "Reviews" work#1517 work#1518
Codex:      $dg:browser batch-open --group "Reviews" work#1517 work#1518
```

Or cold-start a **Chromium** browser (Brave/Edge/Vivaldi) with the extension
pre-loaded — no manual load step (`--list` shows what's installed):

```text
Claude Code: /dg:browser launch --browser brave-beta --group "PRs" work#1517 work#1518
Codex:      $dg:browser launch --browser brave-beta --group "PRs" work#1517 work#1518
```

Play a **live guided tour** of a feature in your real browser — the extension
spotlights each element and injects explanatory text boxes, step by step:

```text
Claude Code: /dg:demo 1517
Codex:      $dg:demo 1517
```

You review the compiled tour script before it plays. Optional screenshots/video
land in your Downloads folder.

Explore app-native UI approaches directly inside a live page, then export the
one you approve:

```text
Claude Code: /dg:proto
Codex:      $dg:proto
```

The workflow asks for a page and design question, samples the page's visual
styles, presents the proposed comparison, and plants the approved set in the
browser. Run the browser skill's `install` command first to load the companion
extension. For authenticated or private pages, review the privacy warning
before allowing the style scrape. The CLI writes approved answers under
`.agents/prototype/<slug>/` and removes temporary Downloads and scratch files
after export.

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
`--group` (default `PRs`). `demo` uses a `#_demo=` marker, while `proto` uses a
compressed `#_proto=` marker for its local CLI/extension handoff.

## 📚 References

- [Developer Guide](docs/DEVELOPER.md)
- [Agent Install Guide](docs/AGENT-INSTALL.md)
- [Contributing](docs/contributing.md)
