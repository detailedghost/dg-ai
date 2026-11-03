---
feature: "Recommended third-party plugins"
feature_snake_case: "recommended_plugins"
date: "2026-10-29"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/worktrees/dg-ai-recommended_plugins/.agents/spec/012_recommended_plugins"
plan_path: "/home/detailedghost/code/worktrees/dg-ai-recommended_plugins/.agents/spec/012_recommended_plugins/plan.md"
slices:
  - id: 1
    name: "marketplace-pins-and-lint"
    depends_on: []
    files:
      - ".claude-plugin/marketplace.json"
      - "THIRD_PARTY_NOTICES.md"
      - "scripts/bump-plugin-pin.ts"
      - "pkg/skills-test/__tests__/skill-manifests.spec.ts"
      - "pkg/skills-test/__tests__/imported-plugins-optional.spec.ts"
      - "pkg/skills-test/__tests__/plugin-pins.spec.ts"
    agents:
      primary: null
  - id: 2
    name: "install-with-recommended"
    depends_on:
      - 1
    files:
      - "pkg/skills-cli/src/install/recommended-plugins.ts"
      - "pkg/skills-cli/src/install/recommended-skills-only.ts"
      - "pkg/skills-cli/src/commands/install.ts"
      - "pkg/skills-cli/src/commands/skills-only.ts"
      - "pkg/skills-cli/src/doctor/checks.ts"
      - "pkg/skills-cli/src/polish/doctor.ts"
      - "pkg/skills-cli/__tests__/install-recommended.spec.ts"
      - "pkg/skills-cli/__tests__/skills-only-recommended.spec.ts"
      - "plugins/dg/skills/teach/**"
      - "plugins/dg/skills/wait-what/**"
      - "pkg/common/src/node/install-skills.ts"
      - "pkg/common/__tests__/install-skills.spec.ts"
      - "pkg/common/__tests__/installed-skill-files.ts"
      - "pkg/skills-cli/bootstrap.sh"
      - "pkg/skills-cli/bootstrap.ps1"
      - "pkg/skills-cli/__tests__/skills-only-install.spec.ts"
      - "pkg/skills-test/__tests__/skill-index-docs.spec.ts"
      - "pkg/skills-test/__tests__/retired-skills.spec.ts"
    agents:
      primary: null
  - id: 3
    name: "docs-adr-d"
    depends_on:
      - 2
    files:
      - "docs/install.md"
      - "docs/AGENT-INSTALL.md"
      - "docs/adr/0027-optional-third-party-plugins.md"
      - "docs/adr/toc.md"
      - "README.md"
      - "plugins/dg/skills/polish/references/pr.md"
      - "plugins/dg/skills/README.md"
    agents:
      primary: null
---

## Slice Summaries
