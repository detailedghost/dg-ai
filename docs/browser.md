# Browser tabs and extension

Claude Code uses `/dg:browser`; Codex uses `$dg:browser`.

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

## Ref formats

- Full URL
- `owner/repo#num`
- `alias#num` (aliases defined in `~/.config/browser-batch/config.json`)
- bare `num` with `--repo`

## Extension

The companion `dg-ai-extension` does the grouping browser-side, built with
[WXT](https://wxt.dev) from `pkg/extension/` and targeting Chrome, Edge, Brave,
Vivaldi, and Firefox 139+ (grouping is feature-detected, skipped where absent).

Grouping is **opt-in per batch**: `batch-open`/`launch` append a
`#_tab_group=<name>` marker to each URL, the extension groups those tabs into
`<name>` and strips the marker. Tabs you open by hand are never grouped. Group
color is set in the extension's Options (default blue); the name comes from
`--group` (default `PRs`). `demo` uses a `#_demo=` marker, while `proto` uses a
compressed `#_proto=` marker for its local CLI/extension handoff.

See [installation](install.md) and the [browser skill](../plugins/dg/skills/browser/SKILL.md).
