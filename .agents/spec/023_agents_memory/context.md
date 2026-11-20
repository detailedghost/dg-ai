---
feature: ".agents as tracked agent memory"
feature_snake_case: "agents_memory"
date: "2026-11-19"
version: "1.0"
status: "in-progress"
current_slice: 0
pr_strategy: "single"
execution:
  profile: "balance"
bundle: "/home/detailedghost/code/worktrees/dg-ai-agents-memory/.agents/spec/023_agents_memory"
plan_path: "/home/detailedghost/code/worktrees/dg-ai-agents-memory/.agents/spec/023_agents_memory/plan.md"
slices:
  - id: 1
    name: "track-agents-default"
    depends_on: []
    files:
      - "plugins/dg/skills/agent-seed/**"
      - "plugins/dg/skills/spring-break/**"
      - "plugins/dg/skills/spec/SKILL.md"
      - "plugins/dg/skills/spec/references/fast.md"
      - "plugins/dg/skills/spec/references/plan.md"
      - "plugins/dg/skills/kick/SKILL.md"
      - "plugins/dg/skills/pickup/SKILL.md"
      - "plugins/dg/skills/prd/SKILL.md"
      - "plugins/dg/skills/wayfinder/SKILL.md"
      - "plugins/dg/skills/proto/references/local-*.md"
      - "pkg/skills-test/__tests__/spec-bundle-commit.spec.ts"
      - "pkg/skills-test/__tests__/agents-tracked.spec.ts"
    agents:
      primary: "dg:lore"
      complexity: "medium"
      qa:
        - "dg:reviewer"
  - id: 2
    name: "agents-read-agents-folder"
    depends_on:
      - 1
    files:
      - "plugins/dg/agents/*.md"
      - "plugins/dg/skills/agent-seed/references/templates.md"
      - "plugins/dg/skills/sdlc/references/templates/lore.md"
      - "plugins/dg/skills/adr/references/write-decision.md"
      - "plugins/dg/skills/spring-break/references/structure.md"
      - "pkg/skills-test/__tests__/agents-memory.spec.ts"
    agents:
      primary: "dg:lore"
      complexity: "medium"
      qa:
        - "dg:reviewer"
  - id: 3
    name: "adr-lint-decision-size"
    depends_on: []
    files:
      - "pkg/skills-cli/src/adr/lint.ts"
      - "pkg/skills-cli/__tests__/adr-lint*.spec.ts"
      - "plugins/dg/skills/adr/SKILL.md"
    agents:
      primary: "dg:js"
      complexity: "low"
      qa:
        - "dg:qa-code"
---

## Slice Summaries
