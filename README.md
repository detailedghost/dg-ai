# 👻 DeeGee

Personal Claude Code plugin for detailedghost. Skills: **browser**, **demo**.
Commands live under the `/dg:` namespace; the companion extension is
`dg-ai-extension`.

## ✅ Prerequisites

- [Bun](https://bun.sh) on your `PATH` (the skills shell out to `bun`).

## 📦 Install

```text
/plugin marketplace add ~/code/dg
/plugin install dg@detailedghost
```

For local development:

```bash
claude --plugin-dir ~/code/dg
```

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
[WXT](https://wxt.dev) from `extension-src/` and targeting Chrome, Edge, Brave,
Vivaldi, and Firefox 139+ (grouping is feature-detected, skipped where absent).

Grouping is **opt-in per batch**: `batch-open`/`launch` append a
`#_tab_group=<name>` marker to each URL, the extension groups those tabs into
`<name>` and strips the marker. Tabs you open by hand are never grouped. Group
color is set in the extension's Options (default blue); the name comes from
`--group` (default `PRs`). `demo` works the same way with a `#_demo=` marker.

## 🛠 Development

The `/dg:browser` CLI depends on `commander`, so install its packages once:

```bash
cd skills/browser && bun install
```

Then the extension:

```bash
cd extension-src
bun install
bun run dev            # HMR dev browser
bun run build          # → .output/chrome-mv3
bun run build:firefox  # → .output/firefox-mv2
```

CI (`.github/workflows/build-extension.yml`) rebuilds on changes to the skill or
`extension-src/`, and publishes a **`vX.X.X`** GitHub Release (on a version bump)
whose zipped assets `install` downloads. Build output is never committed.
