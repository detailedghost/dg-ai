---
feature: "Fold /dg:browser into /dg:pw"
feature_snake_case: "browser_into_pw"
date: "2026-11-19"
version: "1.0"
status: "draft"
current_slice: 2
pr_strategy: "single"
execution:
  profile: "balance"
bundle: "/home/detailedghost/code/worktrees/dg-ai-browser-pw/.agents/spec/022_browser_into_pw"
plan_path: "/home/detailedghost/code/worktrees/dg-ai-browser-pw/.agents/spec/022_browser_into_pw/plan.md"
slices:
  - id: 1
    name: "pw-tab-verbs"
    depends_on: []
    files:
      - "pkg/skills-cli/src/pw/**"
      - "pkg/skills-cli/src/commands/batch-open.ts"
      - "pkg/skills-cli/src/commands/launch.ts"
      - "pkg/skills-cli/src/launch/**"
      - "pkg/skills-cli/src/batch-open/**"
      - "pkg/skills-cli/src/utils/cli-only.ts"
      - "pkg/skills-cli/src/register-all.ts"
      - "pkg/skills-cli/src/completion/**"
      - "pkg/skills-cli/__tests__/pw-batch-open.spec.ts"
      - "pkg/skills-cli/__tests__/pw-launch.spec.ts"
      - "pkg/skills-cli/__tests__/pw/cli.spec.ts"
      - "pkg/skills-cli/__tests__/lazy-commands.spec.ts"
      - "pkg/skills-cli/__tests__/cli-only.spec.ts"
      - "pkg/skills-cli/__tests__/ext-command-harness.ts"
      - "pkg/skills-cli/__tests__/doctor-ext-only.spec.ts"
      - "pkg/skills-test/__tests__/cli-smoke.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 2
    name: "skills-docs-move"
    depends_on:
      - 1
    files:
      - "plugins/dg/skills/**"
      - "README.md"
      - "docs/**"
      - "pkg/extension/README.md"
      - "pkg/common/src/node/install-skills.ts"
      - "pkg/common/__tests__/installed-skill-files.ts"
      - "pkg/skills-cli/bootstrap.sh"
      - "pkg/skills-cli/bootstrap.ps1"
      - "pkg/skills-cli/src/install/**"
      - "pkg/skills-cli/__tests__/pw-skill.spec.ts"
      - "pkg/skills-test/__tests__/**"
    agents:
      primary: "dg:lore"
      complexity: "medium"
      qa:
        - "dg:reviewer"
---

## Slice Summaries
Slice 1 (pw-tab-verbs): pw/cli.ts routes batch-open and launch to the new pw/tab-verbs.ts before the --ext relay branch. The commander definitions moved there from commands/batch-open.ts and commands/launch.ts, which are deleted. A CLI-only install refuses pw launch and pw batch-open --ext. pw --help and the completion tree list both verbs under pw. EXT_ONLY_COMMANDS is gone. The batch-open and launch doctor items now check the pw skill files and the pw allow rule. Tests: pw-batch-open.spec.ts and pw-launch.spec.ts (renamed, ported to main), pw/cli.spec.ts, cli-only, lazy-commands, doctor-ext-only, cli-smoke.
Slice 2 (skills-docs-move): deleted plugins/dg/skills/browser. pw SKILL.md has a Tab batches section and a References row, and the detail is in pw/references/tabs.md. Every caller (pushup, sdlc, spec, land, deps-upgrade, doctor, proto) now names dg-skills pw batch-open, the pw tab batch reference or dg-skills install, and their doctor lines name pw or install where the tree calls it. docs/browser.md is rewritten for pw; README, docs/install.md, docs/AGENT-INSTALL.md, docs/pw.md, docs/demo-and-proto.md and pkg/extension/README.md are updated. A skills-only install and both bootstraps prune a stale browser skill whose SKILL.md matches a shipped dg copy (38 hashes, LF and CRLF). ADR 0049 records the decision. Tests: pw-tab-batches-skill.spec.ts replaces browser-skill.spec.ts; ext-opt-in, retired-skills, skill-cli-invocation, land-skill, proto-skill, pw-skill and installed-skill-files updated.
