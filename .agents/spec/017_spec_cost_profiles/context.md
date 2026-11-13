---
feature: "/dg:spec cost profiles and greedy parallel build"
feature_snake_case: "spec_cost_profiles"
date: "2026-11-04"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/dg/.agents/spec/017_spec_cost_profiles"
plan_path: "/home/detailedghost/code/dg/.agents/spec/017_spec_cost_profiles/plan.md"
slices:
  - id: 1
    name: "profile-schema-and-cli"
    depends_on: []
    files:
      - "plugins/dg/skills/spec/spec-schema/frontmatter-schema.yaml"
      - "plugins/dg/skills/assign/references/model-tiers.json"
      - "pkg/skills-cli/src/tiers.ts"
      - "pkg/skills-cli/src/assign/**"
      - "pkg/skills-cli/src/spec/fields.ts"
      - "pkg/skills-cli/src/spec/context.ts"
      - "pkg/skills-cli/src/spec/lint-waves.ts"
      - "pkg/skills-cli/src/spec/estimate.ts"
      - "pkg/skills-cli/src/spec/index.ts"
      - "pkg/skills-cli/__tests__/assign-resolve.spec.ts"
      - "pkg/skills-cli/__tests__/tiers.spec.ts"
      - "pkg/skills-cli/__tests__/spec-contracts.spec.ts"
      - "pkg/skills-cli/__tests__/spec-skill-tree.spec.ts"
      - "pkg/skills-cli/__tests__/spec-estimate.spec.ts"
      - "pkg/skills-cli/__tests__/hooks/spec-plan-lint.spec.ts"
      - "pkg/skills-cli/__tests__/fixtures/assign/**"
      - "pkg/skills-cli/__tests__/fixtures/spec/goldens.json"
      - "pkg/skills-cli/src/spec/scaffold.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 2
    name: "greedy-slice-wave-runtime"
    depends_on:
      - 1
    files:
      - "plugins/dg/skills/sdlc/references/templates/slice-wave.workflow.js"
      - "plugins/dg/skills/sdlc/references/engineering.md"
      - "plugins/dg/skills/sdlc/references/setup.md"
      - "plugins/dg/skills/sdlc/SKILL.md"
      - "pkg/skills-cli/__tests__/assign-resolve.spec.ts"
      - "pkg/skills-cli/__tests__/slice-wave-runner.spec.ts"
      - "plugins/dg/skills/sdlc/references/finish.md"
      - "plugins/dg/agents/foreman.md"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 3
    name: "spec-profile-and-proxy-flags"
    depends_on:
      - 1
      - 4
    files:
      - "plugins/dg/skills/spec/SKILL.md"
      - "plugins/dg/skills/spec/references/plan.md"
      - "plugins/dg/skills/spec/references/fast.md"
      - "plugins/dg/skills/spec/references/execute.md"
      - "plugins/dg/skills/spec/references/templates/plan-view.md"
      - "plugins/dg/skills/spec/references/templates/slice-review.md"
      - "pkg/skills-test/__tests__/plan-approval-gate.spec.ts"
      - "pkg/skills-test/__tests__/spec-cost-profiles.spec.ts"
      - "plugins/dg/skills/spec/references/profiles.md"
      - "plugins/dg/skills/spec/references/decision-blob.md"
      - "plugins/dg/skills/spec/references/proxy.md"
    agents:
      primary: "dg:lore"
      qa:
        - "dg:reviewer"
  - id: 4
    name: "assign-complexity-rating"
    depends_on: []
    files:
      - "plugins/dg/skills/assign/SKILL.md"
      - "plugins/dg/skills/assign/references/spec-mode.md"
      - "plugins/dg/skills/assign/references/edge-cases.md"
      - "pkg/skills-test/__tests__/assign-complexity-docs.spec.ts"
    agents:
      primary: "dg:lore"
  - id: 5
    name: "background-execute"
    depends_on:
      - 2
      - 3
    files:
      - "plugins/dg/skills/spec/SKILL.md"
      - "plugins/dg/skills/spec/references/execute.md"
      - "pkg/skills-test/__tests__/spec-bg-execute.spec.ts"
      - "plugins/dg/skills/spec/references/bg.md"
      - "pkg/skills-test/__tests__/spec-cost-profiles.spec.ts"
    agents:
      primary: "dg:lore"
      qa:
        - "dg:reviewer"
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/security.md
- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
