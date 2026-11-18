---
feature: "Spelling hook locales beyond en-US and en-GB"
feature_snake_case: spelling_locales
date: "2026-10-29"
version: "1.0"
status: deferred
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "spelling-locale-files"
    depends_on: []
    files: ["pkg/skills-cli/src/hooks/defs/spelling.ts", "pkg/skills-cli/src/hooks/data/spelling-pairs.txt", "pkg/skills-cli/src/hooks/manifest.ts", "pkg/skills-cli/__tests__/hooks/spelling.spec.ts", "docs/hooks.md"]
---

# Spelling hook locales beyond en-US and en-GB

## Purpose
The opt-in spelling hook from spec 011_opt_in_hooks ships with one setting, en-US (default) or en-GB, backed by one British/American word-pair table read in either direction. This parked bundle extends it to more English variants (for example en-CA, en-AU) and possibly other languages, without slowing the hook past its 40 ms budget.

## Scope
### Included
- Per-locale word-pair files that the spelling hook loads by the locale setting in the dg config file
- The locale setting accepts every shipped locale; an unknown locale fails `dg-skills hooks set` with the list of valid values
- doctor reports the active locale and whether its word list loads
### Excluded
- Typo detection or a full dictionary engine (decide during the interview when this bundle is picked up)
- Changes to the en-US and en-GB behavior shipped by 011_opt_in_hooks

### Slice 1 — spelling-locale-files

#### Engineering
- [ ] Move the single pair table to one file per locale pair under hooks/data/spelling/, loaded lazily by the active locale
- [ ] Extend the manifest's spelling setting values from the shipped locale files
- [ ] Keep the no-match path under the 40 ms hook budget

#### Testing Criteria
##### Contracts
- [ ] Contract: each shipped locale file parses and has no duplicate pairs
- [ ] Contract: an unknown locale is rejected by `hooks set` with the valid list
- [ ] Budget: the spelling hook no-match path stays under the hook latency budget for every locale

#### Acceptance Criteria
- [ ] Given the locale is set to a new variant, when an edit writes a word from another variant, then the hook flags it and names the preferred spelling
- [ ] Given the locale is en-US, when the hook runs, then its behavior matches 011_opt_in_hooks exactly

## Slice Summaries

## Agent Notes

## Issues Remediation
