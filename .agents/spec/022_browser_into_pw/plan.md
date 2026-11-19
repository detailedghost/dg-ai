---
feature: "Fold /dg:browser into /dg:pw"
feature_snake_case: browser_into_pw
date: "2026-11-19"
version: "1.0"
status: in-progress
current_slice: 2
pr_strategy: single
slices:
  - id: 1
    name: "pw-tab-verbs"
    depends_on: []
    files: ["pkg/skills-cli/src/pw/**", "pkg/skills-cli/src/commands/batch-open.ts", "pkg/skills-cli/src/commands/launch.ts", "pkg/skills-cli/src/launch/**", "pkg/skills-cli/src/batch-open/**", "pkg/skills-cli/src/utils/cli-only.ts", "pkg/skills-cli/src/register-all.ts", "pkg/skills-cli/src/completion/**", "pkg/skills-cli/__tests__/pw-batch-open.spec.ts", "pkg/skills-cli/__tests__/pw-launch.spec.ts", "pkg/skills-cli/__tests__/pw/cli.spec.ts", "pkg/skills-cli/__tests__/lazy-commands.spec.ts", "pkg/skills-cli/__tests__/cli-only.spec.ts", "pkg/skills-cli/__tests__/ext-command-harness.ts", "pkg/skills-cli/__tests__/doctor-ext-only.spec.ts", "pkg/skills-test/__tests__/cli-smoke.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
  - id: 2
    name: "skills-docs-move"
    depends_on: [1]
    files: ["plugins/dg/skills/**", "README.md", "docs/**", "pkg/extension/README.md", "pkg/common/src/node/install-skills.ts", "pkg/common/__tests__/installed-skill-files.ts", "pkg/skills-cli/bootstrap.sh", "pkg/skills-cli/bootstrap.ps1", "pkg/skills-cli/src/install/**", "pkg/skills-cli/__tests__/pw-skill.spec.ts", "pkg/skills-test/__tests__/**"]
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
worktree:
  pr_url: https://github.com/detailedghost/dg-ai/pull/236
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
- [x] In pw/cli.ts main, route batch-open and launch before the --ext runExt branch
- [x] Reuse runBatchOpen and runLaunch unchanged; port -R/--repo, -g/--group, --print, -b/--browser, --list, --dry-run, --ext
- [x] pw --help lists both verbs; pw batch-open --help and pw launch --help print usage
- [x] Remove registerBatchOpen and registerLaunch and their completion entries
- [x] Keep the doctor check ids batch-open and launch

#### Testing Criteria
##### Contracts
- [x] pw batch-open <refs...> resolves refs through utils/refs.ts as before; without --ext it opens plain tabs
- [x] --group without --ext prints one stderr notice and still opens plain tabs
- [x] pw batch-open --ext -g X groups the tabs through the extension markers; pw launch --ext keeps the existing exit codes
- [x] A missing ref is a usage error (exit 2)
- [x] A CLI-only install refuses pw launch and pw batch-open --ext with the extension-required message
- [x] dg-skills batch-open and dg-skills launch exit as unknown commands

#### Acceptance Criteria
- [x] The old batch-open and launch tests are ported to the pw entry and pass
- [x] dg-skills batch-open is gone

### Slice 2 — skills-docs-move

#### Engineering
- [x] Delete plugins/dg/skills/browser
- [x] Add a Tab batches section to pw SKILL.md and the detail in pw references/tabs.md
- [x] Every caller changes dg-skills batch-open to dg-skills pw batch-open and dg:browser to /dg:pw
- [x] Rewrite docs/browser.md for pw and update install docs and the extension README
- [x] Confirm install prunes a stale browser skill; extend the existing prune only if it does not
- [x] Add ADR Fold browser skill into pw and its toc entry

#### Testing Criteria
##### Contracts
- [x] The pw tab-batch skill test replaces browser-skill.spec.ts
- [x] The ext-opt-in rule requires --ext for pw batch-open ... --group
- [x] skill-manifests and skill-cli-invocation list no browser skill

#### Acceptance Criteria
- [x] rg 'dg:browser|dg-skills (batch-open|launch)' finds nothing outside docs/adr history and CHANGELOG
- [x] The skills index lists no browser skill; the full test suite passes

## Slice Summaries
Slice 1 (pw-tab-verbs): pw/cli.ts routes batch-open and launch to the new pw/tab-verbs.ts before the --ext relay branch. The commander definitions moved there from commands/batch-open.ts and commands/launch.ts, which are deleted. A CLI-only install refuses pw launch and pw batch-open --ext. pw --help and the completion tree list both verbs under pw. EXT_ONLY_COMMANDS is gone. The batch-open and launch doctor items now check the pw skill files and the pw allow rule. Tests: pw-batch-open.spec.ts and pw-launch.spec.ts (renamed, ported to main), pw/cli.spec.ts, cli-only, lazy-commands, doctor-ext-only, cli-smoke.
Slice 2 (skills-docs-move): deleted plugins/dg/skills/browser. pw SKILL.md has a Tab batches section and a References row, and the detail is in pw/references/tabs.md. Every caller (pushup, sdlc, spec, land, deps-upgrade, doctor, proto) now names dg-skills pw batch-open, the pw tab batch reference or dg-skills install, and their doctor lines name pw or install where the tree calls it. docs/browser.md is rewritten for pw; README, docs/install.md, docs/AGENT-INSTALL.md, docs/pw.md, docs/demo-and-proto.md and pkg/extension/README.md are updated. A skills-only install and both bootstraps prune a stale browser skill whose SKILL.md matches a shipped dg copy (38 hashes, LF and CRLF). ADR 0050 records the decision. Tests: pw-tab-batches-skill.spec.ts replaces browser-skill.spec.ts; ext-opt-in, retired-skills, skill-cli-invocation, land-skill, proto-skill, pw-skill and installed-skill-files updated.

## Agent Notes
(slice 1) Slice 1 also touched src/batch-open/doctor.ts, src/launch/doctor.ts, src/completion/describe.ts and __tests__/doctor-ext-only.spec.ts. Under machine load, worktree.spec fails in the full suite but passes alone.
(slice 2) The plan named pkg/skills-cli/src/utils/installed-skill-files.ts; the real fixture is pkg/common/__tests__/installed-skill-files.ts. The pw SKILL.md line budget rose from 106 to 111 for the Tab batches section.

## Issues Remediation
