---
feature: "Velora dg fixes"
feature_snake_case: "velora_dg_fixes"
date: "2026-11-20"
version: "1.0"
status: "in-progress"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/worktrees/dg-ai-spec-025/.agents/spec/025_velora_dg_fixes"
plan_path: "/home/detailedghost/code/worktrees/dg-ai-spec-025/.agents/spec/025_velora_dg_fixes/plan.md"
slices:
  - id: 1
    name: "verify-saved-sign-in"
    depends_on: []
    files:
      - "pkg/skills-cli/src/verify/**"
      - "pkg/skills-cli/__tests__/verify-*.spec.ts"
      - "plugins/dg/skills/verify/**"
      - "docs/verify.md"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:security"
        - "dg:qa-code"
  - id: 2
    name: "prototype-sign-in-and-timeout"
    depends_on:
      - 1
      - 4
    files:
      - "pkg/skills-cli/src/prototype/**"
      - "pkg/skills-cli/__tests__/prototype-*.spec.ts"
      - "plugins/dg/skills/proto/references/local-ui.md"
      - "plugins/dg/skills/proto/references/local-formats.md"
      - "docs/demo-and-proto.md"
      - "pkg/skills-cli/src/completion/tree.json"
      - "plugins/dg/skills/proto/references/local-build.md"
      - "plugins/dg/skills/proto/assets/README.md"
      - "pkg/skills-test/__tests__/proto-skill.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 3
    name: "thrash-nested-run"
    depends_on: []
    files:
      - "plugins/dg/skills/thrash/SKILL.md"
      - "plugins/dg/skills/thrash/references/**"
      - "plugins/dg/skills/address/SKILL.md"
      - "plugins/dg/skills/address/references/workflow.md"
      - "plugins/dg/skills/review-loop/SKILL.md"
      - "pkg/skills-test/__tests__/thrash-pipeline-skill.spec.ts"
      - "pkg/skills-test/__tests__/thrash-nested-run.spec.ts"
    agents:
      primary: "dg:lore"
      complexity: "low"
      qa:
        - "dg:reviewer"
  - id: 4
    name: "stat-archive-and-bg-cwd"
    depends_on: []
    files:
      - "pkg/skills-cli/src/stat/**"
      - "pkg/skills-cli/src/bg/jobs.ts"
      - "pkg/skills-cli/__tests__/stat-*.spec.ts"
      - "pkg/skills-cli/__tests__/bg-jobs.spec.ts"
      - "plugins/dg/skills/stat/**"
      - "plugins/dg/skills/bg/references/job-management.md"
      - "pkg/skills-cli/src/completion/tree.json"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 5
    name: "legacy-launcher-removal"
    depends_on: []
    files:
      - "pkg/skills-cli/src/install/compat-launchers.ts"
      - "pkg/skills-cli/__tests__/compat-launchers.spec.ts"
      - "docs/install.md"
    agents:
      primary: "dg:js"
      complexity: "low"
      qa:
        - "dg:qa-code"
  - id: 6
    name: "update-doctor-failures"
    depends_on: []
    files:
      - "pkg/skills-cli/src/update/run.ts"
      - "pkg/skills-cli/src/doctor/runner.ts"
      - "pkg/skills-cli/__tests__/update.spec.ts"
      - "pkg/skills-cli/__tests__/doctor-runner.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "low"
      qa:
        - "dg:qa-code"
---

## === school pointers ===

- /home/detailedghost/code/worktrees/dg-ai-spec-025/.agents/school/security.md
- /home/detailedghost/code/worktrees/dg-ai-spec-025/.agents/school/infrastructure.md
- /home/detailedghost/code/worktrees/dg-ai-spec-025/.agents/school/engineering.md
- /home/detailedghost/code/worktrees/dg-ai-spec-025/.agents/school/quality.md
- /home/detailedghost/code/worktrees/dg-ai-spec-025/.agents/school/tooling.md

## Slice Summaries
