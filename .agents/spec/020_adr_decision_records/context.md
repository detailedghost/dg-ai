---
feature: "Decision records tool (/dg:adr + dg-skills adr)"
feature_snake_case: "adr_decision_records"
date: "2026-11-19"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
execution:
  profile: "balance"
bundle: "/home/detailedghost/code/worktrees/dg-ai-adr-plan/.agents/spec/020_adr_decision_records"
plan_path: "/home/detailedghost/code/worktrees/dg-ai-adr-plan/.agents/spec/020_adr_decision_records/plan.md"
slices:
  - id: 1
    name: "adr-cli-core"
    depends_on: []
    files:
      - "pkg/skills-cli/src/adr/**"
      - "pkg/skills-cli/src/commands/adr.ts"
      - "pkg/skills-cli/src/register-all.ts"
      - "pkg/skills-cli/src/utils/frontmatter.ts"
      - "pkg/skills-cli/src/spec/frontmatter.ts"
      - "pkg/skills-cli/src/spec/shared.ts"
      - "pkg/skills-cli/src/completion/**"
      - "pkg/skills-cli/__tests__/adr-core.spec.ts"
      - "pkg/skills-cli/__tests__/adr-fixtures.ts"
      - "pkg/skills-cli/__tests__/utils-frontmatter.spec.ts"
      - "pkg/skills-cli/__tests__/completion.spec.ts"
      - "pkg/skills-cli/__tests__/lazy-commands.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 2
    name: "adr-lint-readability"
    depends_on:
      - 1
    files:
      - "pkg/skills-cli/src/adr/lint.ts"
      - "pkg/skills-cli/src/adr/readability.ts"
      - "pkg/skills-cli/__tests__/adr-lint.spec.ts"
      - "pkg/skills-cli/__tests__/adr-readability.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 3
    name: "adr-skill-and-rules"
    depends_on:
      - 1
    files:
      - "plugins/dg/skills/adr/**"
      - "plugins/dg/skills/grill-me/SKILL.md"
      - "plugins/dg/skills/grill-me/references/decisions.md"
      - "plugins/dg/skills/spec/references/grill.md"
      - "plugins/dg/skills/agent-seed/**"
      - "plugins/dg/skills/spring-break/**"
      - "docs/contributing.md"
      - "plugins/dg/skills/README.md"
      - "README.md"
      - "docs/install.md"
      - "pkg/common/__tests__/installed-skill-files.ts"
      - "pkg/skills-test/__tests__/skill-index-docs.spec.ts"
      - "pkg/skills-test/__tests__/adr-skill.spec.ts"
      - "plugins/dg/skills/grill-me/references/protocol.md"
      - "pkg/skills-cli/src/adr/doctor.ts"
      - "pkg/skills-cli/src/doctor/registry.ts"
    agents:
      primary: "dg:lore"
      complexity: "medium"
  - id: 4
    name: "build-wiring"
    depends_on:
      - 2
      - 3
    files:
      - "plugins/dg/skills/sdlc/**"
      - "plugins/dg/skills/spec/references/execute.md"
      - "plugins/dg/skills/land/**"
      - "pkg/skills-cli/__tests__/assign-resolve.spec.ts"
      - "pkg/skills-test/__tests__/adr-build-wiring.spec.ts"
    agents:
      primary: "dg:lore"
      complexity: "medium"
      qa:
        - "dg:reviewer"
---

## Slice Summaries
