# Fold /dg:browser into /dg:pw — Initial Notes

## Purpose
The /dg:browser skill is a thin layer over the top-level batch-open and launch commands. Tab work belongs with /dg:pw, which already drives the real browser. Move batch-open and launch into pw verbs, delete the browser skill, remove the old top-level commands with no aliases, and point every caller at dg-skills pw.

## Scope
### Included
- pw batch-open and pw launch verbs routed before the --ext relay branch
- remove dg-skills batch-open and dg-skills launch, their completion entries, no aliases
- delete plugins/dg/skills/browser and move its detail into pw references/tabs.md
- update every caller skill, docs, tests and an ADR
### Excluded
- dg-skills install, demo and rerun stay top-level
- doctor check ids batch-open and launch stay
- no new stale-skill prune mechanism
