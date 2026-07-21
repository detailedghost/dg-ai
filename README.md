# 👻 dg

Personal Claude Code plugin for detailedghost. First skill: **browser-batch**.

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
/dg:browser-batch install
```

Open a batch of PRs/URLs in your **default** browser, grouped as tabs:

```text
/dg:browser-batch open work#1517 work#1518
```

Or cold-start a **Chromium** browser (Brave/Edge/Vivaldi) with the extension
pre-loaded — no manual load step (`--list` shows what's installed):

```text
/dg:browser-batch launch --browser brave-beta work#1517 work#1518
```

### 🔗 Ref formats

- Full URL
- `owner/repo#num`
- `alias#num` (aliases defined in `~/.config/browser-batch/config.json`)
- bare `num` with `--repo`

## 🧩 Extension

The companion `dg-ai-browser-batch` extension does the grouping browser-side.
It's built with [WXT](https://wxt.dev) from `extension-src/` and targets Chrome,
Edge, Brave, Vivaldi, and Firefox 139+ (grouping is feature-detected and skipped
where unsupported). Grouping only happens in the profile where it's loaded.

## 🛠 Development

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
