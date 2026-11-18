---
feature: "service install"
feature_snake_case: "service_install"
date: "2026-11-14"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
execution:
  profile: "balance"
bundle: "/home/detailedghost/code/dg/.agents/spec/018_service_install"
plan_path: "/home/detailedghost/code/dg/.agents/spec/018_service_install/plan.md"
slices:
  - id: 1
    name: "test-home-fence"
    depends_on: []
    files:
      - "bunfig.toml"
      - "pkg/*/bunfig.toml"
      - "pkg/skills-cli/__tests__/test-home-fence.ts"
      - "pkg/skills-cli/__tests__/home-fence.spec.ts"
      - "pkg/skills-test/__tests__/test-support.ts"
      - "pkg/skills-test/__tests__/home-fence-reach.spec.ts"
      - "pkg/common/src/node/dg-paths.ts"
      - "pkg/common/__tests__/dg-paths.spec.ts"
      - "pkg/*/__tests__/**/*.ts"
      - "pkg/inbox/test/**/*.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 2
    name: "service-install-core"
    depends_on:
      - 13
    files:
      - "pkg/dg-daemon/src/services/packages.ts"
      - "pkg/dg-daemon/src/services/defaults.ts"
      - "pkg/dg-daemon/src/commands/service.ts"
      - "pkg/dg-daemon/src/commands/service-package.ts"
      - "pkg/dg-daemon/src/commands/service-support.ts"
      - "pkg/dg-daemon/__tests__/services/packages.spec.ts"
      - "pkg/dg-daemon/__tests__/services/defaults.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/service-install.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/service-package-kit.ts"
    agents:
      primary: "dg:js"
      effort: "xhigh"
      complexity: "high"
      qa:
        - "dg:security"
        - "dg:qa-code"
  - id: 3
    name: "daemon-autostart"
    depends_on:
      - 1
      - 4
    files:
      - "pkg/common/src/node/autostart.ts"
      - "pkg/common/src/node/index.ts"
      - "pkg/common/__tests__/node-autostart.spec.ts"
      - "pkg/dg-agent/src/phone/autostart.ts"
      - "pkg/dg-agent/src/phone/commands.ts"
      - "pkg/dg-agent/src/phone/store.ts"
      - "pkg/dg-agent/__tests__/phone/autostart.spec.ts"
      - "pkg/dg-agent/__tests__/phone/listener-stale.spec.ts"
      - "pkg/dg-daemon/src/commands/autostart.ts"
      - "pkg/dg-daemon/src/main.ts"
      - "pkg/dg-daemon/__tests__/commands/autostart.spec.ts"
      - "pkg/dg-daemon/__tests__/main.spec.ts"
      - "pkg/dg-daemon/src/commands/start.ts"
      - "pkg/dg-daemon/src/commands/stop.ts"
      - "pkg/dg-daemon/__tests__/commands/start.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/stop.spec.ts"
      - "pkg/common/src/node/daemon-start.ts"
      - "pkg/common/__tests__/node-daemon-start.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:qa-devops"
  - id: 4
    name: "layout-stale-daemon"
    depends_on:
      - 1
    files:
      - "pkg/common/src/node/layout.ts"
      - "pkg/common/src/node/layout-work.ts"
      - "pkg/common/src/node/sqlite-unused.ts"
      - "pkg/common/__tests__/tree-copy.spec.ts"
      - "pkg/common/__tests__/layout.spec.ts"
      - "pkg/common/__tests__/layout-stale-daemon.spec.ts"
      - "pkg/skills-cli/__tests__/layout-stale-daemon-compiled.spec.ts"
      - "pkg/dg-daemon/__tests__/main-blocked.spec.ts"
      - "pkg/common/src/errors.ts"
      - "pkg/skills-cli/src/install/doctor.ts"
      - "pkg/skills-cli/__tests__/install-doctor-layout.spec.ts"
      - "pkg/skills-cli/__tests__/layout-fixtures.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:qa-code"
  - id: 5
    name: "service-update"
    depends_on:
      - 2
    files:
      - "pkg/dg-daemon/src/commands/service-package.ts"
      - "pkg/dg-daemon/src/services/packages.ts"
      - "pkg/dg-daemon/src/services/defaults.ts"
      - "pkg/dg-daemon/__tests__/commands/service-update.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/service-package-kit.ts"
      - "pkg/dg-daemon/__tests__/services/packages.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:security"
  - id: 6
    name: "service-label-verbs"
    depends_on:
      - 2
      - 3
    files:
      - "pkg/dg-daemon/src/commands/service.ts"
      - "pkg/dg-daemon/src/commands/service-logs.ts"
      - "pkg/dg-daemon/__tests__/commands/service-verbs.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/service-logs.spec.ts"
      - "pkg/common/src/node/log-tail.ts"
      - "pkg/common/src/node/index.ts"
      - "pkg/common/__tests__/node-log-tail.spec.ts"
      - "pkg/channel-review/src/daemon/logs.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 7
    name: "channel-review-export"
    depends_on:
      - 13
    files:
      - "pkg/skills-cli/src/channel-review/cli.ts"
      - "pkg/skills-cli/src/channel-review/export.ts"
      - "pkg/skills-cli/__tests__/channel-review-export.spec.ts"
      - "pkg/skills-cli/__tests__/channel-review-cli.spec.ts"
      - "plugins/dg/skills/channel-review/references/commands.md"
      - "pkg/skills-test/__tests__/channel-review-skill.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 8
    name: "service-docs"
    depends_on:
      - 4
      - 5
      - 6
      - 7
    files:
      - "docs/adr/*-service-packages.md"
      - "docs/adr/toc.md"
      - "docs/jobs-and-services.md"
      - "docs/service-api.md"
      - "docs/install.md"
      - "docs/channel-review.md"
      - "SECURITY.md"
      - "plugins/dg/skills/jobs/SKILL.md"
      - "pkg/skills-test/__tests__/outside-services-docs.spec.ts"
      - "pkg/skills-test/__tests__/service-install-docs.spec.ts"
    agents:
      primary: "dg:lore"
      complexity: "low"
      qa:
        - "dg:reviewer"
  - id: 9
    name: "dg-program"
    depends_on:
      - 4
      - 5
      - 6
      - 7
    files:
      - "pkg/common/src/node/program.ts"
      - "pkg/common/src/node/self-command.ts"
      - "pkg/common/__tests__/program-command.spec.ts"
      - "pkg/dg/**"
      - "pkg/launcher/src/dg.ts"
      - "pkg/launcher/src/programs/dg.ts"
      - "pkg/launcher/package.json"
      - "pkg/launcher/__tests__/*.ts"
      - "bun.lock"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:qa-code"
  - id: 10
    name: "dg-launcher-install"
    depends_on:
      - 9
    files:
      - "pkg/skills-cli/src/install/shims.ts"
      - "pkg/skills-cli/src/install/cli.ts"
      - "pkg/skills-cli/src/install/skills-only.ts"
      - "pkg/skills-cli/src/commands/install.ts"
      - "pkg/skills-cli/src/install/compat-launchers.ts"
      - "pkg/skills-cli/src/doctor/*.ts"
      - "pkg/skills-cli/bootstrap.sh"
      - "pkg/skills-cli/bootstrap.ps1"
      - "pkg/skills-cli/__tests__/install*.spec.ts"
      - "pkg/skills-cli/__tests__/compat-launchers.spec.ts"
      - "pkg/skills-cli/__tests__/clean*.spec.ts"
      - "pkg/skills-cli/__tests__/bootstrap-fixtures.ts"
      - "pkg/skills-cli/__tests__/agent-only-install.spec.ts"
      - "pkg/skills-cli/__tests__/skills-only*.spec.ts"
      - "pkg/skills-cli/__tests__/doctor-*.spec.ts"
      - "pkg/skills-cli/__tests__/doctor-fixtures.ts"
      - "pkg/skills-test/__tests__/binary-distribution.spec.ts"
      - "pkg/skills-test/__tests__/cli-smoke.spec.ts"
      - "pkg/skills-test/__tests__/retired-binaries.spec.ts"
      - "pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts"
      - ".github/workflows/release.yml"
      - ".github/workflows/skills-blt.yml"
      - "pkg/skills-cli/src/install/clean.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:qa-devops"
  - id: 11
    name: "dg-front-door-docs"
    depends_on:
      - 8
      - 10
    files:
      - "docs/adr/0020-one-dg-command.md"
      - "docs/adr/toc.md"
      - "docs/jobs-and-services.md"
      - "docs/install.md"
      - "docs/AGENT-INSTALL.md"
      - "docs/DEVELOPER.md"
      - "README.md"
      - "pkg/skills-test/__tests__/outside-services-docs.spec.ts"
      - "pkg/skills-test/__tests__/service-install-docs.spec.ts"
      - "pkg/skills-test/__tests__/dg-front-door-docs.spec.ts"
    agents:
      primary: "dg:lore"
      complexity: "low"
  - id: 12
    name: "remove-channel-review"
    depends_on:
      - 11
    files:
      - "pkg/channel-review/**"
      - "pkg/skills-cli/src/channel-review/**"
      - "pkg/skills-cli/src/commands/channel-review.ts"
      - "pkg/skills-cli/src/register-all.ts"
      - "pkg/skills-cli/src/doctor/registry.ts"
      - "pkg/skills-cli/src/credentials/cli.ts"
      - "pkg/skills-cli/package.json"
      - "pkg/skills-cli/README.md"
      - "pkg/skills-cli/__tests__/**"
      - "bun.lock"
      - "pkg/common/src/node/daemon-schema.ts"
      - "pkg/common/src/node/daemon-db.ts"
      - "pkg/common/src/node/install-skills.ts"
      - "pkg/common/__tests__/**"
      - "pkg/dg-daemon/__tests__/store/**"
      - "pkg/dg-daemon/__tests__/server/credentials-frame.spec.ts"
      - "plugins/dg/skills/channel-review/**"
      - "plugins/dg/skills/jobs/SKILL.md"
      - "plugins/dg/skills/doctor/SKILL.md"
      - "plugins/dg/skills/thrash/SKILL.md"
      - "plugins/dg/skills/README.md"
      - "pkg/skills-test/__tests__/**"
      - "docs/**"
      - "README.md"
      - "SECURITY.md"
      - ".env.example"
      - ".gitleaks.toml"
      - ".mise/config.toml"
      - ".github/workflows/skills-blt.yml"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:dba"
        - "dg:qa-devops"
        - "dg:reviewer"
  - id: 13
    name: "service-paths-and-guard"
    depends_on:
      - 1
    files:
      - "pkg/common/src/node/dg-paths.ts"
      - "pkg/common/__tests__/dg-paths.spec.ts"
      - "pkg/common/src/node/fs.ts"
      - "pkg/common/__tests__/node-fs.spec.ts"
      - "pkg/channel-review/src/address.ts"
      - "pkg/channel-review/__tests__/core-address.spec.ts"
      - "pkg/dg-daemon/src/services/supervisor.ts"
      - "pkg/dg-daemon/__tests__/services/supervisor-state-dir.spec.ts"
      - "pkg/dg-daemon/__tests__/services/supervisor-kit.ts"
      - "pkg/dg-daemon/__tests__/services/supervisor.spec.ts"
      - "pkg/dg-daemon/__tests__/services/supervisor-service-api.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/security.md
- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
