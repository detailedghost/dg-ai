---
feature: "Opt-in hooks area"
feature_snake_case: "opt_in_hooks"
date: "2026-10-29"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/dg/.agents/spec/011_opt_in_hooks"
plan_path: "/home/detailedghost/code/dg/.agents/spec/011_opt_in_hooks/plan.md"
slices:
  - id: 1
    name: "hooks-manifest-runner"
    depends_on: []
    files:
      - "pkg/skills-cli/src/hooks/manifest.ts"
      - "pkg/skills-cli/src/hooks/types.ts"
      - "pkg/skills-cli/src/hooks/run.ts"
      - "pkg/skills-cli/src/hooks/io.ts"
      - "pkg/skills-cli/src/hooks/config.ts"
      - "pkg/skills-cli/src/hooks/defs/**"
      - "pkg/skills-cli/src/hooks/adapters/**"
      - "pkg/skills-cli/src/hooks/data/**"
      - "pkg/skills-cli/src/commands/hooks.ts"
      - "pkg/skills-cli/src/index.ts"
      - "pkg/common/src/node/dg-config.ts"
      - "pkg/common/src/node/index.ts"
      - "pkg/common/__tests__/dg-config.spec.ts"
      - "pkg/skills-cli/__tests__/hooks/**"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
        - "dg:qa-perf"
  - id: 2
    name: "hooks-settings-writers"
    depends_on:
      - 1
    files:
      - "pkg/skills-cli/src/hooks/settings/**"
      - "pkg/skills-cli/src/hooks/cli.ts"
      - "pkg/skills-cli/src/commands/hooks.ts"
      - "pkg/skills-cli/__tests__/hooks-settings/**"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
        - "dg:security"
  - id: 3
    name: "hooks-skill-docs-adr"
    depends_on:
      - 2
    files:
      - "plugins/dg/skills/hooks/**"
      - "plugins/dg/skills/hook-comment-disable/SKILL.md"
      - "plugins/dg/skills/README.md"
      - "pkg/skills-cli/src/hooks/doctor.ts"
      - "pkg/skills-cli/src/doctor/registry.ts"
      - "pkg/skills-test/__tests__/hooks-skill.spec.ts"
      - "docs/hooks.md"
      - "docs/adr/0026-opt-in-hooks.md"
      - "docs/adr/toc.md"
      - "README.md"
    agents:
      primary: "dg:lore"
      qa:
        - "dg:qa-code"
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/security.md
- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
