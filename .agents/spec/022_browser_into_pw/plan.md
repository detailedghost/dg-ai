---
feature: "Fold /dg:browser into /dg:pw"
feature_snake_case: browser_into_pw
date: "2026-11-19"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "pw-tab-verbs"
    depends_on: []
    files: ["pkg/skills-cli/src/pw/**", "pkg/skills-cli/src/commands/batch-open.ts", "pkg/skills-cli/src/commands/launch.ts", "pkg/skills-cli/src/launch/cli.ts", "pkg/skills-cli/src/utils/cli-only.ts", "pkg/skills-cli/src/register-all.ts", "pkg/skills-cli/src/completion/tree.json", "pkg/skills-cli/__tests__/batch-open.spec.ts", "pkg/skills-cli/__tests__/launch-ext.spec.ts", "pkg/skills-cli/__tests__/lazy-commands.spec.ts", "pkg/skills-cli/__tests__/cli-only.spec.ts", "pkg/skills-cli/__tests__/ext-command-harness.ts", "pkg/skills-cli/__tests__/doctor-command.spec.ts", "pkg/skills-test/__tests__/cli-smoke.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
  - id: 2
    name: "skills-docs-move"
    depends_on: [1]
    files: ["plugins/dg/skills/browser/**", "plugins/dg/skills/pw/**", "plugins/dg/skills/pushup/**", "plugins/dg/skills/sdlc/**", "plugins/dg/skills/spec/**", "plugins/dg/skills/land/**", "plugins/dg/skills/deps-upgrade/**", "plugins/dg/skills/doctor/**", "plugins/dg/skills/overwatch/**", "plugins/dg/skills/channel-review/references/setup.md", "plugins/dg/skills/proto/references/commands.md", "plugins/dg/skills/inbox-cleanup/references/providers.md", "plugins/dg/skills/README.md", "README.md", "docs/**", "pkg/extension/README.md", "pkg/skills-cli/src/utils/installed-skill-files.ts", "pkg/skills-test/__tests__/**"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: medium
      qa: [dg:reviewer]
execution:
  profile: balance
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# Fold /dg:browser into /dg:pw

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

### Slice 1 — pw-tab-verbs

#### Engineering
- [ ] In pw/cli.ts main, route batch-open and launch before the --ext runExt branch
- [ ] Reuse runBatchOpen and runLaunch unchanged; port -R/--repo, -g/--group, --print, -b/--browser, --list, --dry-run, --ext
- [ ] pw --help lists both verbs; pw batch-open --help and pw launch --help print usage
- [ ] Remove registerBatchOpen and registerLaunch and their completion entries
- [ ] Keep the doctor check ids batch-open and launch

#### Testing Criteria
##### Contracts
- [ ] pw batch-open <refs...> resolves refs through utils/refs.ts as before; without --ext it opens plain tabs
- [ ] --group without --ext prints one stderr notice and still opens plain tabs
- [ ] pw batch-open --ext -g X groups the tabs through the extension markers; pw launch --ext keeps the existing exit codes
- [ ] A missing ref is a usage error (exit 2)
- [ ] A CLI-only install refuses pw launch and pw batch-open --ext with the extension-required message
- [ ] dg-skills batch-open and dg-skills launch exit as unknown commands

#### Acceptance Criteria
- [ ] The old batch-open and launch tests are ported to the pw entry and pass
- [ ] dg-skills batch-open is gone

### Slice 2 — skills-docs-move

#### Engineering
- [ ] Delete plugins/dg/skills/browser
- [ ] Add a Tab batches section to pw SKILL.md and the detail in pw references/tabs.md
- [ ] Every caller changes dg-skills batch-open to dg-skills pw batch-open and dg:browser to /dg:pw
- [ ] Rewrite docs/browser.md for pw and update install docs and the extension README
- [ ] Confirm install prunes a stale browser skill; extend the existing prune only if it does not
- [ ] Add ADR Fold browser skill into pw and its toc entry

#### Testing Criteria
##### Contracts
- [ ] The pw tab-batch skill test replaces browser-skill.spec.ts
- [ ] The ext-opt-in rule requires --ext for pw batch-open ... --group
- [ ] skill-manifests and skill-cli-invocation list no browser skill

#### Acceptance Criteria
- [ ] rg 'dg:browser|dg-skills (batch-open|launch)' finds nothing outside docs/adr history and CHANGELOG
- [ ] The skills index lists no browser skill; the full test suite passes

## Slice Summaries

## Agent Notes

## Issues Remediation
