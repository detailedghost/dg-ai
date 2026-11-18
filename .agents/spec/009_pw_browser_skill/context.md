---
feature: "pw browser skill in the plugin"
feature_snake_case: "pw_browser_skill"
date: "2026-10-29"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/dg/.agents/spec/009_pw_browser_skill"
plan_path: "/home/detailedghost/code/dg/.agents/spec/009_pw_browser_skill/plan.md"
slices:
  - id: 1
    name: "pw-core-port"
    depends_on: []
    files:
      - "pkg/skills-cli/src/pw/core/**"
      - "pkg/skills-cli/src/pw/commands/**"
      - "pkg/skills-cli/src/pw/code/**"
      - "pkg/skills-cli/src/pw/daemon.ts"
      - "pkg/skills-cli/src/pw/cli.ts"
      - "pkg/skills-cli/src/pw/code-cli.ts"
      - "pkg/skills-cli/src/pw/browsers.ts"
      - "pkg/skills-cli/src/pw/test-support.ts"
      - "pkg/skills-cli/src/commands/pw.ts"
      - "pkg/skills-cli/src/commands/pw-code.ts"
      - "pkg/skills-cli/src/index.ts"
      - "pkg/skills-cli/__tests__/pw/**"
      - "pkg/launcher/__tests__/size-budget.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
        - "dg:security"
  - id: 2
    name: "pw-skill-doctor-docs"
    depends_on:
      - 1
    files:
      - "plugins/dg/skills/pw/**"
      - "plugins/dg/skills/README.md"
      - "pkg/skills-cli/src/pw/doctor.ts"
      - "pkg/skills-cli/src/doctor/registry.ts"
      - "pkg/skills-cli/__tests__/pw-skill-tree.spec.ts"
      - "pkg/skills-test/__tests__/pw-skill.spec.ts"
      - "docs/pw.md"
      - "README.md"
      - "docs/install.md"
    agents:
      primary: "dg:js"
      qa:
        - "dg:lore"
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/security.md
- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
