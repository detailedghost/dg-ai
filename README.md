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

Open a batch of PRs/URLs, grouped as tabs:

```text
/dg:browser-batch open work#1517 work#1518
```

### 🔗 Ref formats

- Full URL
- `owner/repo#num`
- `alias#num` (aliases defined in `~/.config/browser-batch/config.json`)
- bare `num` with `--repo`

The companion `dg-ai-browser-batch` Chrome/Edge extension groups the tabs. Grouping only works in the browser profile where you load that extension.
