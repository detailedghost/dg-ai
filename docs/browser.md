# Browser tabs and extension

Tab batches are pw verbs. Ask `/dg:pw` in Claude Code or `$dg:pw` in Codex, or
run the commands below in a terminal.

One-time guided setup of the companion browser extension:

```text
dg-skills install
```

The target (`chrome` or `firefox`), `--local` and `--version <x.y.z>` are in the
pw skill's [tab batch reference](../plugins/dg/skills/pw/references/tabs.md).

Open a batch of PRs/URLs as plain tabs in your **default** browser. No extension needed:

```text
dg-skills pw batch-open work#1517 work#1518
```

Add `--ext` to group them into a named group with the extension:

```text
dg-skills pw batch-open --ext --group "Reviews" work#1517 work#1518
```

Or cold-start a **Chromium** browser (Brave/Edge/Vivaldi) with the extension
pre-loaded — no manual load step (`--list` shows what's installed):

```text
dg-skills pw --ext launch --browser brave-beta --group "PRs" work#1517 work#1518
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

Grouping is **opt-in per batch** with `--ext`: `pw batch-open --ext` and `pw launch` append a
`#_tab_group=<name>` marker to each URL, the extension groups those tabs into
`<name>` and strips the marker. Tabs you open by hand are never grouped.
Group color is set in the extension's Options (default random per group); the name comes from
`--group` (default `PRs`). `demo` uses a `#_demo=` marker, while `proto` uses a
compressed `#_proto=` marker for its local CLI/extension handoff.

Tab groups that `dg-skills pw --ext` makes for an agent take their title from the
agent identity and the first four characters of the session id. They take their
color from the first unused group color. The Options color does not affect them.

See [installation](install.md), the [pw guide](pw.md) and the pw skill's
[tab batch reference](../plugins/dg/skills/pw/references/tabs.md).
