# Recommended third-party plugins — Initial Notes

## Purpose
Treat imported third-party skills as optional extras that dg pins but does not maintain, with unslop and mattpocock/skills as the two examples. The marketplace is the single list; a bump script moves a pin; `dg-skills install --with-recommended` installs them for Claude Code through the plugin CLI and copies them for Codex and OpenCode through `--skills-only --dest`; a lint proves no dg skill requires any of them.

## Scope
### Included
- marketplace.json entry for mattpocock-skills pinned to a sha; unslop entry kept
- scripts/bump-plugin-pin.ts and the documented bump flow
- install --with-recommended for Claude Code (claude plugin CLI) and for skills-only destinations (git fetch at the pinned sha, copy declared skill dirs, skip name collisions)
- Lint: every mention of an imported plugin in plugins/dg carries the optional guard sentence
- THIRD_PARTY_NOTICES update, docs, ADR 0027, removal list for the user's private copies
### Excluded
- Vendoring upstream skills into plugins/dg
- Automatic scheduled bumps (a manual script only)
- Retiring dg's grill-me or wayfinder copies (dg:spec and dg:grill-me link to /dg:wayfinder, and wayfinder runs dg:grill-me)
