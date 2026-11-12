---
feature: "Review pipeline: investigate, group, verify, consolidate"
feature_snake_case: "review_pipeline"
date: "2026-11-10"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
execution:
  profile: "balance"
bundle: "/home/detailedghost/code/dg/.agents/spec/013_review_pipeline"
plan_path: "/home/detailedghost/code/dg/.agents/spec/013_review_pipeline/plan.md"
slices:
  - id: 1
    name: "checkout-and-file-fetch"
    depends_on: []
    files:
      - "pkg/skills-cli/src/thrash/checkout.ts"
      - "pkg/skills-cli/src/thrash/index.ts"
      - "pkg/skills-cli/src/thrash/core.ts"
      - "pkg/skills-cli/src/thrash/action/index.ts"
      - "pkg/skills-cli/src/provider/types.ts"
      - "pkg/skills-cli/src/provider/github.ts"
      - "pkg/skills-cli/src/provider/gitlab.ts"
      - "pkg/skills-cli/__tests__/thrash-checkout.spec.ts"
      - "pkg/skills-cli/__tests__/thrash.spec.ts"
      - "pkg/skills-cli/__tests__/thrash-core.spec.ts"
      - "pkg/skills-cli/__tests__/thrash-action-cli.spec.ts"
      - "pkg/skills-cli/__tests__/provider-github.spec.ts"
      - "pkg/skills-cli/__tests__/provider-gitlab.spec.ts"
      - "pkg/skills-cli/__tests__/provider-types.spec.ts"
      - "docs/adr/0041-thrash-review-checkout.md"
      - "docs/adr/toc.md"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:security"
        - "dg:qa-code"
  - id: 2
    name: "investigate-and-bundles"
    depends_on:
      - 1
    files:
      - "pkg/skills-cli/src/erd/graph.ts"
      - "pkg/skills-cli/src/thrash/investigate.ts"
      - "pkg/skills-cli/src/thrash/bundles.ts"
      - "pkg/skills-cli/src/thrash/core.ts"
      - "pkg/skills-cli/src/thrash/index.ts"
      - "pkg/skills-cli/__tests__/erd-graph.spec.ts"
      - "pkg/skills-cli/__tests__/thrash-investigate.spec.ts"
      - "pkg/skills-cli/__tests__/thrash-bundles.spec.ts"
      - "pkg/skills-cli/__tests__/thrash.spec.ts"
      - "pkg/skills-test/__tests__/cli-smoke.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:qa-code"
  - id: 3
    name: "triage-and-finding-schema"
    depends_on:
      - 2
    files:
      - "pkg/skills-cli/src/thrash/triage.ts"
      - "pkg/skills-cli/src/thrash/core.ts"
      - "pkg/skills-cli/src/thrash/index.ts"
      - "pkg/skills-cli/__tests__/thrash-triage.spec.ts"
      - "pkg/skills-cli/__tests__/thrash-core.spec.ts"
      - "pkg/skills-cli/__tests__/thrash.spec.ts"
      - "pkg/skills-test/__tests__/cli-smoke.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:qa-code"
  - id: 4
    name: "personas-and-thrash-skill"
    depends_on:
      - 3
    files:
      - "plugins/dg/agents/thrash.md"
      - "plugins/dg/agents/thrash-verify.md"
      - "plugins/dg/agents/thrash-consolidate.md"
      - ".claude-plugin/plugin.json"
      - "plugins/dg/skills/assign/references/model-tiers.json"
      - "pkg/skills-cli/src/proxy/packaged-personas.ts"
      - "pkg/skills-cli/__tests__/packaged-personas.spec.ts"
      - "pkg/skills-cli/__tests__/skills-only.spec.ts"
      - "pkg/skills-cli/__tests__/skills-only-install.spec.ts"
      - "plugins/dg/skills/thrash/SKILL.md"
      - "plugins/dg/skills/thrash/references/agent-prompt.md"
      - "plugins/dg/skills/thrash/references/details.md"
      - "pkg/skills-test/__tests__/thrash-pipeline-skill.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:reviewer"
  - id: 5
    name: "refactor-investigate-verify"
    depends_on:
      - 4
    files:
      - "plugins/dg/skills/refactor/SKILL.md"
      - "plugins/dg/skills/refactor/references/discovery.md"
      - "pkg/skills-test/__tests__/refactor-skill.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "low"
  - id: 7
    name: "docs"
    depends_on:
      - 5
    files:
      - "docs/DEVELOPER.md"
      - "pkg/skills-cli/README.md"
      - "plugins/dg/skills/README.md"
      - "README.md"
    agents:
      primary: "dg:lore"
      complexity: "low"
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/security.md
- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
