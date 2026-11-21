---
feature: "One dg binary and one config file"
feature_snake_case: "one_dg_binary"
date: "2026-11-21"
version: "1.0"
status: "in-progress"
current_slice: 8
pr_strategy: "single"
execution:
  profile: "balance"
bundle: "/home/detailedghost/code/worktrees/dg-ai-config-toml/.agents/spec/026_one_dg_binary"
plan_path: "/home/detailedghost/code/worktrees/dg-ai-config-toml/.agents/spec/026_one_dg_binary/plan.md"
slices:
  - id: 1
    name: "decision-records"
    depends_on: []
    files:
      - "docs/adr/**"
      - ".agents/decisions/**"
    agents:
      primary: "dg:lore"
  - id: 2
    name: "flat-routes"
    depends_on: []
    files:
      - "pkg/dg/src/**"
      - "pkg/dg/__tests__/**"
      - "pkg/dg/package.json"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 3
    name: "compiled-build"
    depends_on:
      - 2
    files:
      - "pkg/launcher/**"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-devops"
        - "dg:qa-perf"
  - id: 4
    name: "compiled-install"
    depends_on:
      - 3
    files:
      - "pkg/skills-cli/src/install/**"
      - "pkg/skills-cli/bootstrap.sh"
      - "pkg/skills-cli/bootstrap.ps1"
      - "pkg/common/src/node/program.ts"
      - "pkg/common/__tests__/program-command.spec.ts"
      - "pkg/skills-cli/__tests__/bootstrap-*.spec.ts"
      - "pkg/skills-cli/__tests__/install-*.spec.ts"
      - "pkg/skills-cli/__tests__/bootstrap-fixtures.ts"
      - "pkg/skills-cli/__tests__/bundle-build.ts"
      - "pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts"
      - "pkg/skills-test/__tests__/remote-install-*.spec.ts"
    agents:
      primary: "dg:js"
      effort: "xhigh"
      qa:
        - "dg:qa-devops"
        - "dg:security"
  - id: 5
    name: "stored-argv-migration"
    depends_on:
      - 4
    files:
      - "pkg/dg-daemon/src/jobs/migrate.ts"
      - "pkg/dg-daemon/src/commands/autostart.ts"
      - "pkg/dg-agent/src/phone/listener.ts"
      - "pkg/dg-daemon/__tests__/jobs/migrate.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/autostart.spec.ts"
      - "pkg/dg-agent/__tests__/phone/listener-argv.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 6
    name: "release-compiled"
    depends_on:
      - 3
    files:
      - ".github/workflows/release.yml"
      - "pkg/skills-test/__tests__/release-*.spec.ts"
    agents:
      primary: "dg:devops"
      qa:
        - "dg:qa-devops"
  - id: 7
    name: "dg-docs"
    depends_on:
      - 2
      - 4
      - 6
    files:
      - "docs/install.md"
      - "docs/DEVELOPER.md"
      - "docs/AGENT-INSTALL.md"
      - "docs/jobs-and-services.md"
      - "docs/phone.md"
      - "docs/pw.md"
      - "README.md"
      - "CHANGELOG.md"
    agents:
      primary: "dg:lore"
  - id: 8
    name: "skill-texts"
    depends_on:
      - 2
    files:
      - "plugins/**"
      - "pkg/skills-test/__tests__/skill-cli-invocation.spec.ts"
      - "pkg/skills-test/__tests__/skill-bootstrap-block.spec.ts"
      - "pkg/skills-test/__tests__/skill-flat-names.spec.ts"
    agents:
      primary: "dg:lore"
      qa:
        - "dg:qa-code"
  - id: 9
    name: "config-core"
    depends_on: []
    files:
      - "pkg/common/src/node/dg-toml.ts"
      - "pkg/common/src/node/dg-paths.ts"
      - "pkg/common/src/node/index.ts"
      - "pkg/common/package.json"
      - "bun.lock"
      - "pkg/common/__tests__/dg-toml*.spec.ts"
      - "pkg/common/__tests__/dg-paths.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
        - "dg:security"
  - id: 10
    name: "config-migrate"
    depends_on:
      - 9
    files:
      - "pkg/common/src/node/dg-toml-migrate.ts"
      - "pkg/common/src/node/dg-toml.ts"
      - "pkg/common/__tests__/dg-toml-migrate*.spec.ts"
    agents:
      primary: "dg:js"
      effort: "xhigh"
      qa:
        - "dg:qa-code"
        - "dg:security"
  - id: 11
    name: "config-command"
    depends_on:
      - 9
    files:
      - "pkg/skills-cli/src/commands/config.ts"
      - "pkg/skills-cli/src/register-all.ts"
      - "pkg/skills-cli/src/completion/tree.json"
      - "pkg/skills-cli/__tests__/config-command*.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 12
    name: "config-consumers"
    depends_on:
      - 10
    files:
      - "pkg/common/src/node/dg-config.ts"
      - "pkg/common/__tests__/dg-config.spec.ts"
      - "pkg/skills-cli/src/hooks/config.ts"
      - "pkg/skills-cli/src/hooks/cli.ts"
      - "pkg/skills-cli/src/utils/cli-only.ts"
      - "pkg/skills-cli/src/utils/refs.ts"
      - "pkg/skills-cli/src/doctor/checks.ts"
      - "pkg/inbox/src/config/**"
      - "pkg/ssms/src/cli/run.ts"
      - "pkg/skills-cli/__tests__/hooks/**"
      - "pkg/skills-cli/__tests__/hooks-settings/**"
      - "pkg/skills-cli/__tests__/doctor-command.spec.ts"
      - "pkg/skills-cli/__tests__/doctor-fixtures.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 13
    name: "config-docs"
    depends_on:
      - 11
      - 12
    files:
      - "docs/config.md"
      - "docs/hooks.md"
      - "docs/inbox-cleanup.md"
      - "docs/ssms.md"
    agents:
      primary: "dg:lore"
---

## === school pointers ===

- /home/detailedghost/code/worktrees/dg-ai-config-toml/.agents/school/security.md
- /home/detailedghost/code/worktrees/dg-ai-config-toml/.agents/school/performance.md
- /home/detailedghost/code/worktrees/dg-ai-config-toml/.agents/school/engineering.md
- /home/detailedghost/code/worktrees/dg-ai-config-toml/.agents/school/quality.md
- /home/detailedghost/code/worktrees/dg-ai-config-toml/.agents/school/tooling.md

## Slice Summaries

- (slice 1, config half) ADR 0054 "One config.toml for dg" and its decision rules; `adr lint --all` exits 0.
- (slice 9) `configTomlPath` in DgPaths; `dg-toml.ts` with readDgToml, setting, writeDgToml, validation with file:line and a next step, secret references; smol-toml 1.9.1 pinned exactly.
- (slice 10) `migrateToToml` and `migrateToTomlSync`: backups as `.pre-toml` (0600), secrets to the credential store, `[meta.migrated]` sha256, idempotent, write nothing on any failure.
- (slice 11) `dg-skills config path|get|set|edit`, a config doctor item, the completion tree.
- (slice 12) hooks, cli-only, refs, doctor, inbox and ssms read config.toml; migration runs after the layout preAction; doctor warns on a changed migrated source.
- (slice 13) docs/config.md plus hooks, inbox and ssms docs; config-docs.spec.ts.
