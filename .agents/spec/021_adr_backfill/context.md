---
feature: "ADR backfill: opt dg-ai into dg-skills adr"
feature_snake_case: "adr_backfill"
date: "2026-11-20"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/worktrees/dg-ai-spec-021/.agents/spec/021_adr_backfill"
plan_path: "/home/detailedghost/code/worktrees/dg-ai-spec-021/.agents/spec/021_adr_backfill/plan.md"
slices:
  - id: 1
    name: "opt-in-and-normalize"
    depends_on: []
    files:
      - "docs/adr/toc.md"
      - ".agents/decisions/README.md"
      - "docs/adr/0[0-9][0-9][0-9]-*.md"
    agents:
      primary: "dg:lore"
      complexity: "medium"
  - id: 2
    name: "backfill-0001-0019"
    depends_on:
      - 1
    files:
      - "docs/adr/000*.md"
      - "docs/adr/001*.md"
      - ".agents/decisions/000*.md"
      - ".agents/decisions/001*.md"
    agents:
      primary: "dg:lore"
      complexity: "medium"
  - id: 3
    name: "backfill-0020-0029"
    depends_on:
      - 1
    files:
      - "docs/adr/002*.md"
      - ".agents/decisions/002*.md"
    agents:
      primary: "dg:lore"
      complexity: "medium"
  - id: 4
    name: "backfill-0030-0039"
    depends_on:
      - 1
    files:
      - "docs/adr/003*.md"
      - ".agents/decisions/003*.md"
    agents:
      primary: "dg:lore"
      complexity: "medium"
  - id: 5
    name: "backfill-0040-0051"
    depends_on:
      - 1
    files:
      - "docs/adr/004*.md"
      - "docs/adr/005*.md"
      - ".agents/decisions/004*.md"
      - ".agents/decisions/005*.md"
    agents:
      primary: "dg:lore"
      complexity: "medium"
  - id: 6
    name: "index-tests-verify"
    depends_on:
      - 2
      - 3
      - 4
      - 5
    files:
      - "docs/adr/toc.md"
      - "docs/adr/template.md"
      - ".agents/decisions/README.md"
      - "pkg/skills-test/__tests__/job-model-docs.spec.ts"
      - "pkg/skills-test/__tests__/dg-front-door-docs.spec.ts"
      - "pkg/skills-test/__tests__/outside-services-docs.spec.ts"
      - "pkg/skills-test/__tests__/pairing-docs.spec.ts"
      - "pkg/skills-test/__tests__/demo-skill.spec.ts"
      - "pkg/skills-test/__tests__/blt-gate.spec.ts"
      - "pkg/skills-test/__tests__/agents-memory.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:reviewer"
---

## === school pointers ===

- /home/detailedghost/code/worktrees/dg-ai-spec-021/.agents/school/security.md
- /home/detailedghost/code/worktrees/dg-ai-spec-021/.agents/school/engineering.md
- /home/detailedghost/code/worktrees/dg-ai-spec-021/.agents/school/quality.md
- /home/detailedghost/code/worktrees/dg-ai-spec-021/.agents/school/tooling.md

## Slice Summaries
