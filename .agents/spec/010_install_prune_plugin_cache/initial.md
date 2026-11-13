# Prune old Claude plugin cache versions on install — Initial Notes

## Purpose
Claude Code keeps every dg plugin version under ~/.claude/plugins/cache/<marketplace>/dg/<version>/ and only removes orphaned ones about 14 days after it marks them. `dg-skills install` reclaims that space now: it keeps the version named in installed_plugins.json and any version a session read in the last 24 hours, deletes the rest, and prints what it removed. `--keep-cache` skips the step. Install also tells the user when DG_HOME points somewhere other than the default home.

## Scope
### Included
- pkg/common plugin-cache helper: list versions, read installed_plugins.json, read .in_use markers and .orphaned_at, plan keep/remove
- install runs the prune automatically in every mode except --skills-only; --keep-cache skips it; one summary line
- doctor install check reporting reclaimable versions
- DG_HOME notice on install and a doctor warning when DG_HOME is set
### Excluded
- Other plugins' cache folders
- Marketplace clones under ~/.claude/plugins/marketplaces
- A standalone prune command
