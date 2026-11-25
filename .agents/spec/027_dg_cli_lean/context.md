---
feature: "Lean dg CLI: latency, binary and download size, skill token weight"
feature_snake_case: "dg_cli_lean"
date: "2026-11-24"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/spec/027_dg_cli_lean/."
plan_path: "/home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/spec/027_dg_cli_lean/./plan.md"
slices:
  - id: 1
    name: "lean-baseline"
    depends_on: []
    files:
      - "scripts/ram-budget.ts"
      - "scripts/ram-budget/**"
      - "scripts/lean-size.ts"
      - "scripts/skill-tokens.ts"
      - "scripts/lean-budgets.json"
      - ".github/workflows/compiled-dg.yml"
      - "pkg/skills-test/__tests__/lean-*.spec.ts"
      - "docs/lean-baseline.md"
    agents:
      primary: "dg:devops"
      qa:
        - "dg:qa-devops"
        - "dg:qa-perf"
  - id: 2
    name: "bundle-cuts"
    depends_on: []
    files:
      - "pkg/launcher/build.ts"
      - "pkg/launcher/__tests__/build*.spec.ts"
      - "package.json"
      - "bun.lock"
      - "pkg/skills-cli/package.json"
      - "pkg/common/package.json"
      - "pkg/dg-agent/package.json"
      - "pkg/dg-daemon/package.json"
      - "pkg/inbox/package.json"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-perf"
  - id: 3
    name: "hot-path-latency"
    depends_on:
      - 2
    files:
      - "pkg/launcher/src/**"
      - "pkg/launcher/__tests__/dispatch*.spec.ts"
      - "pkg/dg/src/**"
      - "pkg/dg/__tests__/**"
      - "pkg/skills-cli/src/hooks/cli.ts"
      - "pkg/skills-cli/src/hooks/run.ts"
      - "pkg/skills-cli/src/hooks/io.ts"
      - "pkg/skills-cli/__tests__/hooks-fast-path*.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-perf"
        - "dg:qa-code"
  - id: 4
    name: "release-download"
    depends_on:
      - 1
      - 3
    files:
      - ".github/workflows/release.yml"
      - "pkg/skills-cli/src/utils/lib.ts"
      - "pkg/skills-cli/src/install/compiled.ts"
      - "pkg/skills-cli/src/install/companion*.ts"
      - "pkg/skills-cli/bootstrap.sh"
      - "pkg/skills-cli/bootstrap.ps1"
      - "pkg/skills-cli/__tests__/install-*.spec.ts"
      - "pkg/skills-cli/__tests__/bootstrap-*.spec.ts"
      - "pkg/skills-test/__tests__/release-*.spec.ts"
      - "pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts"
      - "pkg/launcher/build.ts"
    agents:
      primary: "dg:js"
      effort: "xhigh"
      qa:
        - "dg:qa-devops"
        - "dg:security"
  - id: 5
    name: "skill-diet"
    depends_on: []
    files:
      - "plugins/dg/skills/**"
      - "pkg/skills-test/__tests__/skill-size-cap.spec.ts"
    agents:
      primary: "dg:lore"
      qa:
        - "dg:qa-code"
  - id: 6
    name: "browser-ext-default-flag"
    depends_on: []
    files:
      - "pkg/skills-cli/src/pw/cli.ts"
      - "pkg/skills-cli/src/pw/core/dispatch.ts"
      - "pkg/skills-cli/src/pw/core/spec.ts"
      - "pkg/skills-cli/src/pw/browser-mode.ts"
      - "pkg/skills-cli/__tests__/pw-browser-mode*.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 7
    name: "ext-gap-verbs"
    depends_on:
      - 6
    files:
      - "pkg/extension/lib/**"
      - "pkg/extension/entrypoints/**"
      - "pkg/extension/__tests__/**"
      - "pkg/common/src/pw-ext-format.ts"
      - "pkg/common/__tests__/pw-ext-format*.spec.ts"
      - "pkg/skills-cli/src/pw/ext.ts"
      - "pkg/skills-cli/__tests__/pw-ext*.spec.ts"
    agents:
      primary: "dg:js"
      effort: "xhigh"
      qa:
        - "dg:security"
        - "dg:qa-code"
  - id: 8
    name: "browser-docs-skills"
    depends_on:
      - 5
      - 6
      - 7
    files:
      - "docs/pw.md"
      - "docs/browser.md"
      - "docs/config.md"
      - "docs/demo-and-proto.md"
      - "docs/verify.md"
      - "plugins/dg/skills/pw/**"
      - "plugins/dg/skills/browser/**"
      - "plugins/dg/skills/verify/**"
      - "plugins/dg/skills/demo/**"
      - "plugins/dg/skills/proto/**"
      - "CHANGELOG.md"
    agents:
      primary: "dg:lore"
  - id: 9
    name: "native-front-door"
    depends_on:
      - 3
      - 4
    files:
      - "pkg/front/**"
      - ".github/workflows/front.yml"
    agents:
      primary: "dg:shell"
      effort: "xhigh"
      qa:
        - "dg:qa-perf"
        - "dg:qa-devops"
  - id: 10
    name: "native-long-running"
    depends_on:
      - 9
    files:
      - "pkg/front-daemon/**"
      - ".github/workflows/front-daemon.yml"
    agents:
      primary: "dg:shell"
      effort: "xhigh"
      qa:
        - "dg:qa-perf"
        - "dg:security"
---

## === school pointers ===

- /home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/school/security.md
- /home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/school/performance.md
- /home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/school/engineering.md
- /home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/school/quality.md
- /home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/school/tooling.md

## Slice Summaries
