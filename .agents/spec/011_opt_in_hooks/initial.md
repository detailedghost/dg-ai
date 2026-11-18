# Opt-in hooks area — Initial Notes

## Purpose
Give dg its own hooks area: a manifest of structured hook definitions, each a TypeScript module run on the pinned runtime as its own lazy chunk, all off by default. `dg-skills hooks list|status|enable <id>|disable <id>` writes and removes entries in each tool's own settings (Claude Code, Codex, OpenCode) and never installs an always-on dispatcher. Hook settings such as the spelling locale live in dg's config.json.

## Scope
### Included
- Manifest and types; hooks: spelling (en-US default or en-GB), format, pr-prose, pr-confirm, spec-plan-lint, daily-prune; internal Codex apply_patch adapter
- `dg-skills hooks run <id>` fast path that skips commander; per-hook latency budget test
- Settings writers for Claude (~/.claude/settings.json), Codex (~/.codex/hooks.json), OpenCode (generated plugin file + opencode.json plugin list) with a command marker so dg edits only its own entries
- hooks skill, retargeted hook-comment-disable skill, docs, ADR 0026
### Excluded
- ai-attention, nodeterm and rtk hooks (stay local or are being removed)
- Other spelling locales than en-US and en-GB (file later)
- Any hooks.json inside the plugin directory
