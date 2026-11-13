---
feature: "Shared runtime and bundle"
feature_snake_case: "shared_runtime_bundle"
date: "2026-10-29"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/dg/.agents/spec/007_shared_runtime_bundle"
plan_path: "/home/detailedghost/code/dg/.agents/spec/007_shared_runtime_bundle/plan.md"
slices:
  - id: 1
    name: "program-entries-lazy"
    depends_on: []
    files:
      - "pkg/skills-cli/src/index.ts"
      - "pkg/skills-cli/src/main.ts"
      - "pkg/skills-cli/src/commands/**"
      - "pkg/skills-cli/src/utils/legacy-command.ts"
      - "pkg/skills-cli/src/utils/lazy-command.ts"
      - "pkg/skills-cli/__tests__/lazy-commands.spec.ts"
      - "pkg/skills-cli/__tests__/self-command.spec.ts"
      - "pkg/dg-agent/src/index.ts"
      - "pkg/dg-agent/src/main.ts"
      - "pkg/dg-agent/src/start.ts"
      - "pkg/dg-agent/src/phone/migrate.ts"
      - "pkg/dg-agent/src/phone/commands.ts"
      - "pkg/dg-agent/__tests__/**"
      - "pkg/dg-daemon/src/index.ts"
      - "pkg/dg-daemon/src/main.ts"
      - "pkg/common/src/node/self-command.ts"
      - "pkg/common/src/node/program.ts"
      - "pkg/common/src/node/index.ts"
      - "pkg/common/__tests__/program.spec.ts"
    agents:
      primary: "dg:js"
      effort: "xhigh"
      qa:
        - "dg:qa-code"
        - "dg:qa-perf"
        - "dg:reviewer"
  - id: 2
    name: "launcher-bundle-build"
    depends_on:
      - 1
    files:
      - "pkg/launcher/**"
      - "pkg/skills-cli/build.ts"
      - "pkg/skills-cli/package.json"
      - "pkg/dg-agent/package.json"
      - "pkg/dg-daemon/package.json"
      - "pkg/skills-cli/__tests__/compiled-binary.ts"
      - "pkg/skills-cli/__tests__/*-compiled.spec.ts"
      - "pkg/skills-cli/__tests__/build.spec.ts"
      - "package.json"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-perf"
        - "dg:qa-devops"
  - id: 3
    name: "install-runtime-bundle"
    depends_on:
      - 2
    files:
      - "pkg/skills-cli/src/install/**"
      - "pkg/skills-cli/src/commands/install.ts"
      - "pkg/skills-cli/src/commands/phone-listener.ts"
      - "pkg/skills-cli/src/utils/lib.ts"
      - "pkg/skills-cli/src/utils/cli-only.ts"
      - "pkg/skills-cli/src/doctor/shared.ts"
      - "pkg/skills-cli/src/doctor/checks.ts"
      - "pkg/skills-cli/__tests__/install*.spec.ts"
      - "pkg/skills-cli/__tests__/cli-binary-lib.spec.ts"
      - "pkg/skills-cli/__tests__/agent-only-install.spec.ts"
      - "pkg/skills-cli/__tests__/phone-refresh.spec.ts"
      - "pkg/skills-cli/__tests__/fake-cli.ts"
      - "pkg/skills-cli/__tests__/fake-cli.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
        - "dg:security"
  - id: 4
    name: "bootstrap-release-smoke"
    depends_on:
      - 2
    files:
      - "pkg/skills-cli/bootstrap.sh"
      - "pkg/skills-cli/bootstrap.ps1"
      - ".github/workflows/release.yml"
      - ".github/workflows/skills-blt.yml"
      - ".github/workflows/dg-agent-blt.yml"
      - ".github/workflows/dg-daemon-blt.yml"
      - "scripts/bump-runtime.ts"
      - "scripts/release-version.ts"
      - "pkg/skills-test/__tests__/binary-distribution.spec.ts"
      - "pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts"
      - "pkg/skills-test/__tests__/release-workflow.spec.ts"
      - "pkg/skills-test/__tests__/release-listing.spec.ts"
      - "pkg/skills-test/__tests__/retired-binaries.spec.ts"
      - "pkg/skills-test/__tests__/fetch-cli-binary-busy.spec.ts"
      - "pkg/skills-test/__tests__/install-logic.spec.ts"
      - "pkg/skills-test/__tests__/supported-platforms.ts"
      - "pkg/skills-test/__tests__/cli-smoke.spec.ts"
      - "pkg/skills-test/__tests__/dependency-pinning.spec.ts"
    agents:
      primary: "dg:devops"
      qa:
        - "dg:qa-devops"
        - "dg:security"
  - id: 5
    name: "docs-adr-e"
    depends_on:
      - 3
      - 4
    files:
      - "docs/install.md"
      - "docs/AGENT-INSTALL.md"
      - "docs/DEVELOPER.md"
      - "docs/adr/0024-shared-runtime-bundle.md"
      - "docs/adr/toc.md"
      - "README.md"
      - ".mise/config.toml"
    agents:
      primary: "dg:lore"
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/security.md
- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
