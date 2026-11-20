---
feature: "job install"
feature_snake_case: "job_install"
date: "2026-11-18"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
execution:
  profile: "balance"
bundle: "/home/detailedghost/code/dg/.agents/spec/019_job_install"
plan_path: "/home/detailedghost/code/dg/.agents/spec/019_job_install/plan.md"
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
      - "pkg/*/__tests__/test-home-fence-env.spec.ts"
      - "pkg/inbox/test/test-home-fence-env.test.ts"
      - "pkg/common/__tests__/dg-paths-fence.spec.ts"
      - "pkg/dg-daemon/__tests__/utils/daemon-harness-fence.spec.ts"
      - "pkg/skills-test/__tests__/run-in-harness-fence.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 2
    name: "job-paths-and-guard"
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
      complexity: "high"
      qa:
        - "dg:security"
  - id: 3
    name: "layout-stale-daemon"
    depends_on:
      - 1
    files:
      - "pkg/common/src/node/layout.ts"
      - "pkg/common/src/node/layout-work.ts"
      - "pkg/common/src/node/sqlite-unused.ts"
      - "pkg/common/__tests__/layout.spec.ts"
      - "pkg/common/__tests__/layout-stale-daemon.spec.ts"
      - "pkg/skills-cli/__tests__/layout-stale-daemon-compiled.spec.ts"
      - "pkg/dg-daemon/__tests__/main-blocked.spec.ts"
      - "pkg/common/src/errors.ts"
      - "pkg/skills-cli/src/install/doctor.ts"
      - "pkg/skills-cli/__tests__/install-doctor-layout.spec.ts"
      - "pkg/skills-cli/__tests__/layout-fixtures.ts"
      - "pkg/skills-cli/__tests__/clean.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 4
    name: "daemon-autostart"
    depends_on:
      - 1
      - 3
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
      - "pkg/dg-daemon/src/completion-tree.json"
      - "pkg/dg-agent/src/phone/migrate.ts"
      - "pkg/dg-agent/__tests__/phone/migrate.spec.ts"
      - "pkg/common/src/node/process.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:qa-code"
        - "dg:qa-devops"
  - id: 5
    name: "dg-program"
    depends_on:
      - 4
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
        - "dg:reviewer"
  - id: 6
    name: "dg-launcher-install"
    depends_on:
      - 5
    files:
      - "pkg/skills-cli/src/install/shims.ts"
      - "pkg/skills-cli/src/install/cli.ts"
      - "pkg/skills-cli/src/install/skills-only.ts"
      - "pkg/skills-cli/src/commands/install.ts"
      - "pkg/skills-cli/src/install/compat-launchers.ts"
      - "pkg/skills-cli/src/doctor/*.ts"
      - "pkg/skills-cli/bootstrap.sh"
      - "pkg/skills-cli/bootstrap.ps1"
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
      - "pkg/skills-cli/src/completion/tree.json"
      - "pkg/skills-cli/src/completion/files.ts"
      - "pkg/skills-cli/src/completion/**"
      - "pkg/skills-cli/__tests__/completion.spec.ts"
      - "pkg/skills-cli/src/commands/completion.ts"
      - "pkg/skills-cli/__tests__/install-shims.spec.ts"
      - "pkg/skills-cli/__tests__/install-retired-binaries.spec.ts"
      - "pkg/skills-cli/__tests__/install-version-pin.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:qa-devops"
  - id: 7
    name: "dg-front-door-docs"
    depends_on:
      - 2
      - 6
    files:
      - "docs/adr/0020-one-dg-command.md"
      - "docs/adr/toc.md"
      - "docs/install.md"
      - "docs/AGENT-INSTALL.md"
      - "docs/DEVELOPER.md"
      - "README.md"
      - "docs/jobs-and-services.md"
      - "docs/service-api.md"
      - "pkg/skills-test/__tests__/outside-services-docs.spec.ts"
      - "pkg/skills-test/__tests__/dg-front-door-docs.spec.ts"
      - "docs/adr/0043-outside-services.md"
      - "pkg/skills-test/__tests__/docs-help-kit.ts"
    agents:
      primary: "dg:lore"
      complexity: "low"
  - id: 8
    name: "job-config-merge"
    depends_on:
      - 7
    files:
      - "pkg/dg-daemon/src/jobs/config.ts"
      - "pkg/dg-daemon/src/jobs/migrate.ts"
      - "pkg/dg-daemon/src/jobs/launcher.ts"
      - "pkg/dg-daemon/src/jobs/control.ts"
      - "pkg/dg-daemon/src/services/config.ts"
      - "pkg/dg-daemon/src/services/supervisor.ts"
      - "pkg/dg-daemon/src/server/config-store.ts"
      - "pkg/dg-daemon/src/server/http.ts"
      - "pkg/dg-daemon/src/server/bootstrap.ts"
      - "pkg/dg-daemon/src/commands/service.ts"
      - "pkg/dg-daemon/src/commands/start.ts"
      - "pkg/dg-daemon/src/commands/stop.ts"
      - "pkg/common/src/chat-format.ts"
      - "pkg/dg-daemon/__tests__/jobs/config.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/migrate-services.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/launcher.spec.ts"
      - "pkg/dg-daemon/__tests__/services/**"
      - "pkg/dg-daemon/__tests__/server/**"
      - "pkg/dg-daemon/__tests__/commands/service-*.ts"
      - "pkg/dg-daemon/__tests__/commands/start.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/stop.spec.ts"
      - "pkg/skills-test/__tests__/outside-services-docs.spec.ts"
      - "pkg/dg-daemon/__tests__/utils/service-daemon.ts"
      - "pkg/common/__tests__/chat-format.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:qa-code"
  - id: 9
    name: "job-verbs"
    depends_on:
      - 8
    files:
      - "pkg/dg-daemon/src/commands/jobs.ts"
      - "pkg/dg-daemon/src/commands/job-schedule.ts"
      - "pkg/dg-daemon/src/commands/job-support.ts"
      - "pkg/dg-daemon/src/commands/job-logs.ts"
      - "pkg/dg-daemon/src/commands/service.ts"
      - "pkg/dg-daemon/src/completion-tree.json"
      - "pkg/dg-daemon/__tests__/commands/job-verbs.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-logs.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/jobs.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-exec.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-cli-helpers.ts"
      - "pkg/dg-daemon/__tests__/completion-tree.spec.ts"
      - "pkg/dg-daemon/__tests__/command-names-contract.spec.ts"
      - "pkg/common/src/node/log-tail.ts"
      - "pkg/common/src/node/index.ts"
      - "pkg/common/__tests__/node-log-tail.spec.ts"
      - "pkg/channel-review/src/daemon/logs.ts"
      - "pkg/common/src/node/prompt.ts"
      - "pkg/common/__tests__/node-prompt.spec.ts"
      - "pkg/channel-review/__tests__/daemon-logs.spec.ts"
      - "pkg/skills-test/__tests__/outside-services-docs.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:qa-code"
  - id: 10
    name: "job-schedule-merge"
    depends_on:
      - 9
    files:
      - "pkg/dg-daemon/src/commands/job-schedule.ts"
      - "pkg/dg-daemon/src/jobs/runner.ts"
      - "pkg/dg-daemon/src/jobs/launcher.ts"
      - "pkg/dg-daemon/src/jobs/control.ts"
      - "pkg/dg-daemon/src/jobs/migrate.ts"
      - "pkg/dg-daemon/src/jobs/config.ts"
      - "pkg/dg-daemon/src/jobs/idle.ts"
      - "pkg/dg-daemon/src/jobs/parse.ts"
      - "pkg/dg-daemon/src/jobs/cron.ts"
      - "pkg/dg-daemon/src/store/index.ts"
      - "pkg/common/src/node/daemon-schema.ts"
      - "pkg/dg-daemon/src/server/bootstrap.ts"
      - "pkg/dg-daemon/__tests__/jobs/runner.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/tick.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/parse.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/migrate-scheduled.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/launcher.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-exec.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-schedule.spec.ts"
      - "pkg/dg-daemon/__tests__/store/**"
      - "pkg/common/__tests__/node-daemon-db.spec.ts"
      - "pkg/common/__tests__/node-sqlite.spec.ts"
      - "pkg/common/src/node/daemon-db.ts"
      - "pkg/dg-daemon/src/store/schema.ts"
      - "pkg/dg-daemon/__tests__/assets/asset-store.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/jobs.spec.ts"
      - "pkg/dg-daemon/src/commands/jobs.ts"
      - "pkg/dg-daemon/src/commands/job-logs.ts"
      - "pkg/dg-daemon/__tests__/commands/job-verbs.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 11
    name: "job-model-docs"
    depends_on:
      - 10
    files:
      - "docs/adr/*-jobs.md"
      - "docs/adr/0020-one-dg-command.md"
      - "docs/adr/0043-outside-services.md"
      - "docs/adr/toc.md"
      - "docs/jobs-and-services.md"
      - "docs/install.md"
      - "README.md"
      - "plugins/dg/skills/jobs/SKILL.md"
      - "pkg/skills-test/__tests__/outside-services-docs.spec.ts"
      - "pkg/skills-test/__tests__/dg-front-door-docs.spec.ts"
      - "pkg/skills-test/__tests__/job-model-docs.spec.ts"
    agents:
      primary: "dg:lore"
      complexity: "low"
  - id: 12
    name: "job-credential-route"
    depends_on:
      - 11
    files:
      - "pkg/dg-daemon/src/server/job-credentials.ts"
      - "pkg/dg-daemon/src/server/http.ts"
      - "pkg/dg-daemon/src/store/credentials-store.ts"
      - "pkg/common/src/credentials-format.ts"
      - "pkg/common/src/chat-format.ts"
      - "pkg/common/src/node/job-credentials-client.ts"
      - "pkg/common/src/node/index.ts"
      - "pkg/dg-daemon/__tests__/server/job-credentials-route.spec.ts"
      - "pkg/common/__tests__/job-credentials-client.spec.ts"
      - "pkg/common/__tests__/credentials-format.spec.ts"
      - "pkg/skills-test/__tests__/reserved-credential-prefixes.spec.ts"
      - "pkg/dg-daemon/src/server/bootstrap.ts"
      - "pkg/dg-daemon/src/server/capped-body.ts"
      - "pkg/dg-daemon/src/server/service-api.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:security"
  - id: 13
    name: "job-add-git"
    depends_on:
      - 12
    files:
      - "pkg/dg-daemon/src/jobs/sources.ts"
      - "pkg/dg-daemon/src/jobs/declaration.ts"
      - "pkg/dg-daemon/src/commands/job-source.ts"
      - "pkg/dg-daemon/src/commands/jobs.ts"
      - "pkg/dg-daemon/src/completion-tree.json"
      - "pkg/dg-daemon/__tests__/jobs/sources.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/declaration.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-add-git.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-source-kit.ts"
      - "pkg/dg-daemon/__tests__/commands/job-verbs.spec.ts"
      - "pkg/dg-daemon/src/jobs/sanitize.ts"
      - "pkg/dg-daemon/__tests__/jobs/sanitize.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:security"
  - id: 14
    name: "job-update"
    depends_on:
      - 13
    files:
      - "pkg/dg-daemon/src/commands/job-source.ts"
      - "pkg/dg-daemon/src/commands/jobs.ts"
      - "pkg/dg-daemon/src/jobs/sources.ts"
      - "pkg/dg-daemon/src/jobs/declaration.ts"
      - "pkg/dg-daemon/src/completion-tree.json"
      - "pkg/dg-daemon/__tests__/commands/job-update.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-source-kit.ts"
      - "pkg/dg-daemon/__tests__/jobs/sources.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-add-git.spec.ts"
      - "pkg/dg-daemon/src/commands/job-update.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:security"
  - id: 15
    name: "job-setup-wizard"
    depends_on:
      - 14
    files:
      - "pkg/dg-daemon/src/commands/job-setup.ts"
      - "pkg/dg-daemon/src/jobs/setup-answers.ts"
      - "pkg/dg-daemon/src/jobs/secret-sources.ts"
      - "pkg/dg-daemon/src/jobs/sources.ts"
      - "pkg/dg-daemon/src/commands/jobs.ts"
      - "pkg/dg-daemon/src/commands/job-source.ts"
      - "pkg/dg-daemon/src/completion-tree.json"
      - "pkg/common/src/node/prompt.ts"
      - "pkg/common/src/node/index.ts"
      - "pkg/skills-cli/src/credentials/cli.ts"
      - "pkg/skills-cli/src/channel-review/connect.ts"
      - "pkg/dg-daemon/__tests__/jobs/sources.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-setup.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-enable-wizard.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-setup-refresh.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-verbs.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/setup-answers.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/secret-sources.spec.ts"
      - "pkg/common/__tests__/node-prompt.spec.ts"
      - "pkg/dg-daemon/src/services/env-file.ts"
      - "pkg/dg-daemon/__tests__/services/env-file.spec.ts"
      - "pkg/common/package.json"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:security"
  - id: 16
    name: "job-add-local"
    depends_on:
      - 15
    files:
      - "pkg/dg-daemon/src/commands/job-local.ts"
      - "pkg/dg-daemon/src/commands/job-source.ts"
      - "pkg/dg-daemon/src/jobs/sources.ts"
      - "pkg/dg-daemon/src/jobs/declaration.ts"
      - "pkg/dg-daemon/src/commands/jobs.ts"
      - "pkg/dg-daemon/src/completion-tree.json"
      - "pkg/dg-daemon/__tests__/jobs/sources.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-add-local.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-local-change.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-local-headless.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-add-git.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-source-kit.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 17
    name: "job-credential-env"
    depends_on:
      - 16
    files:
      - "pkg/dg-daemon/src/jobs/launcher.ts"
      - "pkg/dg-daemon/src/jobs/runner.ts"
      - "pkg/dg-daemon/src/jobs/control.ts"
      - "pkg/dg-daemon/src/jobs/config.ts"
      - "pkg/dg-daemon/src/jobs/declaration.ts"
      - "pkg/dg-daemon/src/jobs/sources.ts"
      - "pkg/dg-daemon/__tests__/jobs/sources.spec.ts"
      - "pkg/dg-daemon/src/services/supervisor.ts"
      - "pkg/dg-daemon/src/commands/jobs.ts"
      - "pkg/dg-daemon/src/commands/job-local.ts"
      - "pkg/dg-daemon/src/commands/job-source.ts"
      - "pkg/dg-daemon/src/server/bootstrap.ts"
      - "pkg/dg-daemon/src/completion-tree.json"
      - "pkg/dg-daemon/__tests__/jobs/launcher-credential-env.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/launcher.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/config.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/declaration.spec.ts"
      - "pkg/dg-daemon/__tests__/commands/job-credential-env.spec.ts"
      - "pkg/common/src/credentials-format.ts"
      - "pkg/common/__tests__/credentials-format.spec.ts"
      - "pkg/dg-daemon/src/server/credentials.ts"
      - "pkg/dg-daemon/src/commands/job-update.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:security"
  - id: 18
    name: "credential-refresh-api"
    depends_on:
      - 17
    files:
      - "pkg/dg-daemon/src/server/service-api.ts"
      - "pkg/dg-daemon/src/server/http.ts"
      - "pkg/dg-daemon/src/server/bootstrap.ts"
      - "pkg/dg-daemon/src/jobs/credential-refresh.ts"
      - "docs/service-api.md"
      - "pkg/dg-daemon/__tests__/server/service-api.spec.ts"
      - "pkg/dg-daemon/__tests__/server/service-api-refresh.spec.ts"
      - "pkg/dg-daemon/__tests__/jobs/credential-refresh.spec.ts"
      - "pkg/skills-test/__tests__/outside-services-docs.spec.ts"
    agents:
      primary: "dg:js"
      complexity: "high"
      qa:
        - "dg:security"
  - id: 19
    name: "channel-review-export"
    depends_on:
      - 11
    files:
      - "pkg/skills-cli/src/channel-review/cli.ts"
      - "pkg/skills-cli/src/channel-review/export.ts"
      - "pkg/skills-cli/__tests__/channel-review-export.spec.ts"
      - "pkg/skills-cli/__tests__/channel-review-cli.spec.ts"
      - "plugins/dg/skills/channel-review/references/commands.md"
      - "pkg/skills-test/__tests__/channel-review-skill.spec.ts"
      - "pkg/skills-cli/src/completion/tree.json"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:qa-code"
  - id: 20
    name: "job-source-docs"
    depends_on:
      - 18
      - 19
    files:
      - "docs/adr/*-job-sources-and-credentials.md"
      - "docs/adr/toc.md"
      - "docs/jobs-and-services.md"
      - "docs/service-api.md"
      - "docs/channel-review.md"
      - "SECURITY.md"
      - "plugins/dg/skills/jobs/SKILL.md"
      - "pkg/skills-test/__tests__/outside-services-docs.spec.ts"
      - "pkg/skills-test/__tests__/dg-front-door-docs.spec.ts"
      - "pkg/skills-test/__tests__/job-source-docs.spec.ts"
      - "docs/adr/0043-outside-services.md"
    agents:
      primary: "dg:lore"
      complexity: "low"
  - id: 21
    name: "remove-channel-review"
    depends_on:
      - 20
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
      - "pkg/dg-daemon/src/commands/service.ts"
      - "pkg/dg-daemon/src/commands/jobs.ts"
      - "pkg/dg-daemon/src/commands/job-schedule.ts"
      - "pkg/dg-daemon/src/commands/stop.ts"
      - "pkg/dg-daemon/src/main.ts"
      - "pkg/dg-daemon/src/server/http.ts"
      - "pkg/dg-daemon/src/completion-tree.json"
      - "pkg/dg-agent/src/completion-tree.json"
      - "pkg/skills-cli/src/completion/tree.json"
      - "pkg/common/src/chat-format.ts"
      - "pkg/dg-daemon/__tests__/**"
      - "pkg/skills-cli/src/completion/describe.ts"
    agents:
      primary: "dg:js"
      complexity: "medium"
      qa:
        - "dg:reviewer"
---

## === school pointers ===

- /home/detailedghost/code/dg/.agents/school/security.md
- /home/detailedghost/code/dg/.agents/school/engineering.md
- /home/detailedghost/code/dg/.agents/school/quality.md

## Slice Summaries
