---
feature: "job install"
feature_snake_case: job_install
date: "2026-11-18"
version: "1.0"
status: draft
current_slice: 1
pr_strategy: single
slices:
  - id: 1
    name: "test-home-fence"
    depends_on: []
    files: ["bunfig.toml", "pkg/*/bunfig.toml", "pkg/skills-cli/__tests__/test-home-fence.ts", "pkg/skills-cli/__tests__/home-fence.spec.ts", "pkg/skills-test/__tests__/test-support.ts", "pkg/skills-test/__tests__/home-fence-reach.spec.ts", "pkg/common/src/node/dg-paths.ts", "pkg/common/__tests__/dg-paths.spec.ts", "pkg/*/__tests__/**/*.ts", "pkg/inbox/test/**/*.ts", "pkg/*/__tests__/test-home-fence-env.spec.ts", "pkg/inbox/test/test-home-fence-env.test.ts", "pkg/common/__tests__/dg-paths-fence.spec.ts", "pkg/dg-daemon/__tests__/utils/daemon-harness-fence.spec.ts", "pkg/skills-test/__tests__/run-in-harness-fence.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
  - id: 2
    name: "job-paths-and-guard"
    depends_on: [1]
    files: ["pkg/common/src/node/dg-paths.ts", "pkg/common/__tests__/dg-paths.spec.ts", "pkg/common/src/node/fs.ts", "pkg/common/__tests__/node-fs.spec.ts", "pkg/channel-review/src/address.ts", "pkg/channel-review/__tests__/core-address.spec.ts", "pkg/dg-daemon/src/services/supervisor.ts", "pkg/dg-daemon/__tests__/services/supervisor-state-dir.spec.ts", "pkg/dg-daemon/__tests__/services/supervisor-kit.ts", "pkg/dg-daemon/__tests__/services/supervisor.spec.ts", "pkg/dg-daemon/__tests__/services/supervisor-service-api.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:security]
  - id: 3
    name: "layout-stale-daemon"
    depends_on: [1]
    files: ["pkg/common/src/node/layout.ts", "pkg/common/src/node/layout-work.ts", "pkg/common/src/node/sqlite-unused.ts", "pkg/common/__tests__/layout.spec.ts", "pkg/common/__tests__/layout-stale-daemon.spec.ts", "pkg/skills-cli/__tests__/layout-stale-daemon-compiled.spec.ts", "pkg/dg-daemon/__tests__/main-blocked.spec.ts", "pkg/common/src/errors.ts", "pkg/skills-cli/src/install/doctor.ts", "pkg/skills-cli/__tests__/install-doctor-layout.spec.ts", "pkg/skills-cli/__tests__/layout-fixtures.ts", "pkg/skills-cli/__tests__/clean.spec.ts", "pkg/dg-daemon/src/server/config-store.ts", "pkg/dg-daemon/src/commands/service.ts", "pkg/dg-daemon/__tests__/crypto/keychain-step.spec.ts", "pkg/dg-daemon/__tests__/server/config-store.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
  - id: 4
    name: "daemon-autostart"
    depends_on: [1, 3]
    files: ["pkg/common/src/node/autostart.ts", "pkg/common/src/node/index.ts", "pkg/common/__tests__/node-autostart.spec.ts", "pkg/dg-agent/src/phone/autostart.ts", "pkg/dg-agent/src/phone/commands.ts", "pkg/dg-agent/src/phone/store.ts", "pkg/dg-agent/__tests__/phone/autostart.spec.ts", "pkg/dg-agent/__tests__/phone/listener-stale.spec.ts", "pkg/dg-daemon/src/commands/autostart.ts", "pkg/dg-daemon/src/main.ts", "pkg/dg-daemon/__tests__/commands/autostart.spec.ts", "pkg/dg-daemon/__tests__/main.spec.ts", "pkg/dg-daemon/src/commands/start.ts", "pkg/dg-daemon/src/commands/stop.ts", "pkg/dg-daemon/__tests__/commands/start.spec.ts", "pkg/dg-daemon/__tests__/commands/stop.spec.ts", "pkg/common/src/node/daemon-start.ts", "pkg/common/__tests__/node-daemon-start.spec.ts", "pkg/dg-daemon/src/completion-tree.json", "pkg/dg-agent/src/phone/migrate.ts", "pkg/dg-agent/__tests__/phone/migrate.spec.ts", "pkg/common/src/node/process.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:qa-code, dg:qa-devops]
  - id: 5
    name: "dg-program"
    depends_on: [4]
    files: ["pkg/common/src/node/program.ts", "pkg/common/src/node/self-command.ts", "pkg/common/__tests__/program-command.spec.ts", "pkg/dg/**", "pkg/launcher/src/dg.ts", "pkg/launcher/src/programs/dg.ts", "pkg/launcher/package.json", "pkg/launcher/__tests__/*.ts", "bun.lock"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:reviewer]
  - id: 6
    name: "dg-launcher-install"
    depends_on: [5]
    files: ["pkg/skills-cli/src/install/shims.ts", "pkg/skills-cli/src/install/cli.ts", "pkg/skills-cli/src/install/skills-only.ts", "pkg/skills-cli/src/commands/install.ts", "pkg/skills-cli/src/install/compat-launchers.ts", "pkg/skills-cli/src/doctor/*.ts", "pkg/skills-cli/bootstrap.sh", "pkg/skills-cli/bootstrap.ps1", "pkg/skills-cli/__tests__/compat-launchers.spec.ts", "pkg/skills-cli/__tests__/clean*.spec.ts", "pkg/skills-cli/__tests__/bootstrap-fixtures.ts", "pkg/skills-cli/__tests__/agent-only-install.spec.ts", "pkg/skills-cli/__tests__/skills-only*.spec.ts", "pkg/skills-cli/__tests__/doctor-*.spec.ts", "pkg/skills-cli/__tests__/doctor-fixtures.ts", "pkg/skills-test/__tests__/binary-distribution.spec.ts", "pkg/skills-test/__tests__/cli-smoke.spec.ts", "pkg/skills-test/__tests__/retired-binaries.spec.ts", "pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts", ".github/workflows/release.yml", ".github/workflows/skills-blt.yml", "pkg/skills-cli/src/install/clean.ts", "pkg/skills-cli/src/completion/tree.json", "pkg/skills-cli/src/completion/files.ts", "pkg/skills-cli/src/completion/**", "pkg/skills-cli/__tests__/completion.spec.ts", "pkg/skills-cli/src/commands/completion.ts", "pkg/skills-cli/__tests__/install-shims.spec.ts", "pkg/skills-cli/__tests__/install-retired-binaries.spec.ts", "pkg/skills-cli/__tests__/install-version-pin.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:qa-devops]
  - id: 7
    name: "dg-front-door-docs"
    depends_on: [2, 6]
    files: ["docs/adr/0020-one-dg-command.md", "docs/adr/toc.md", "docs/install.md", "docs/AGENT-INSTALL.md", "docs/DEVELOPER.md", "README.md", "docs/jobs-and-services.md", "docs/service-api.md", "pkg/skills-test/__tests__/outside-services-docs.spec.ts", "pkg/skills-test/__tests__/dg-front-door-docs.spec.ts", "docs/adr/0043-outside-services.md", "pkg/skills-test/__tests__/docs-help-kit.ts"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: low
  - id: 8
    name: "job-config-merge"
    depends_on: [7]
    files: ["pkg/dg-daemon/src/jobs/config.ts", "pkg/dg-daemon/src/jobs/migrate.ts", "pkg/dg-daemon/src/jobs/launcher.ts", "pkg/dg-daemon/src/jobs/control.ts", "pkg/dg-daemon/src/services/config.ts", "pkg/dg-daemon/src/services/supervisor.ts", "pkg/dg-daemon/src/server/config-store.ts", "pkg/dg-daemon/src/server/http.ts", "pkg/dg-daemon/src/server/bootstrap.ts", "pkg/dg-daemon/src/commands/service.ts", "pkg/dg-daemon/src/commands/start.ts", "pkg/dg-daemon/src/commands/stop.ts", "pkg/common/src/chat-format.ts", "pkg/dg-daemon/__tests__/jobs/config.spec.ts", "pkg/dg-daemon/__tests__/jobs/migrate-services.spec.ts", "pkg/dg-daemon/__tests__/jobs/launcher.spec.ts", "pkg/dg-daemon/__tests__/services/**", "pkg/dg-daemon/__tests__/server/**", "pkg/dg-daemon/__tests__/commands/service-*.ts", "pkg/dg-daemon/__tests__/commands/start.spec.ts", "pkg/dg-daemon/__tests__/commands/stop.spec.ts", "pkg/skills-test/__tests__/outside-services-docs.spec.ts", "pkg/dg-daemon/__tests__/utils/service-daemon.ts", "pkg/common/__tests__/chat-format.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:qa-code]
  - id: 9
    name: "job-verbs"
    depends_on: [8]
    files: ["pkg/dg-daemon/src/commands/jobs.ts", "pkg/dg-daemon/src/commands/job-schedule.ts", "pkg/dg-daemon/src/commands/job-support.ts", "pkg/dg-daemon/src/commands/job-logs.ts", "pkg/dg-daemon/src/commands/service.ts", "pkg/dg-daemon/src/completion-tree.json", "pkg/dg-daemon/__tests__/commands/job-verbs.spec.ts", "pkg/dg-daemon/__tests__/commands/job-logs.spec.ts", "pkg/dg-daemon/__tests__/commands/jobs.spec.ts", "pkg/dg-daemon/__tests__/commands/job-exec.spec.ts", "pkg/dg-daemon/__tests__/commands/job-cli-helpers.ts", "pkg/dg-daemon/__tests__/completion-tree.spec.ts", "pkg/dg-daemon/__tests__/command-names-contract.spec.ts", "pkg/common/src/node/log-tail.ts", "pkg/common/src/node/index.ts", "pkg/common/__tests__/node-log-tail.spec.ts", "pkg/channel-review/src/daemon/logs.ts", "pkg/common/src/node/prompt.ts", "pkg/common/__tests__/node-prompt.spec.ts", "pkg/channel-review/__tests__/daemon-logs.spec.ts", "pkg/skills-test/__tests__/outside-services-docs.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:qa-code]
  - id: 10
    name: "job-schedule-merge"
    depends_on: [9]
    files: ["pkg/dg-daemon/src/commands/job-schedule.ts", "pkg/dg-daemon/src/jobs/runner.ts", "pkg/dg-daemon/src/jobs/launcher.ts", "pkg/dg-daemon/src/jobs/control.ts", "pkg/dg-daemon/src/jobs/migrate.ts", "pkg/dg-daemon/src/jobs/config.ts", "pkg/dg-daemon/src/jobs/idle.ts", "pkg/dg-daemon/src/jobs/parse.ts", "pkg/dg-daemon/src/jobs/cron.ts", "pkg/dg-daemon/src/store/index.ts", "pkg/common/src/node/daemon-schema.ts", "pkg/dg-daemon/src/server/bootstrap.ts", "pkg/dg-daemon/__tests__/jobs/runner.spec.ts", "pkg/dg-daemon/__tests__/jobs/tick.spec.ts", "pkg/dg-daemon/__tests__/jobs/parse.spec.ts", "pkg/dg-daemon/__tests__/jobs/migrate-scheduled.spec.ts", "pkg/dg-daemon/__tests__/jobs/launcher.spec.ts", "pkg/dg-daemon/__tests__/commands/job-exec.spec.ts", "pkg/dg-daemon/__tests__/commands/job-schedule.spec.ts", "pkg/dg-daemon/__tests__/store/**", "pkg/common/__tests__/node-daemon-db.spec.ts", "pkg/common/__tests__/node-sqlite.spec.ts", "pkg/common/src/node/daemon-db.ts", "pkg/dg-daemon/src/store/schema.ts", "pkg/dg-daemon/__tests__/assets/asset-store.spec.ts", "pkg/dg-daemon/__tests__/commands/jobs.spec.ts", "pkg/dg-daemon/src/commands/jobs.ts", "pkg/dg-daemon/src/commands/job-logs.ts", "pkg/dg-daemon/__tests__/commands/job-verbs.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
  - id: 11
    name: "job-model-docs"
    depends_on: [10]
    files: ["docs/adr/*-jobs.md", "docs/adr/0020-one-dg-command.md", "docs/adr/0043-outside-services.md", "docs/adr/toc.md", "docs/jobs-and-services.md", "docs/install.md", "README.md", "plugins/dg/skills/jobs/SKILL.md", "pkg/skills-test/__tests__/outside-services-docs.spec.ts", "pkg/skills-test/__tests__/dg-front-door-docs.spec.ts", "pkg/skills-test/__tests__/job-model-docs.spec.ts"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: low
  - id: 12
    name: "job-credential-route"
    depends_on: [11]
    files: ["pkg/dg-daemon/src/server/job-credentials.ts", "pkg/dg-daemon/src/server/http.ts", "pkg/dg-daemon/src/store/credentials-store.ts", "pkg/common/src/credentials-format.ts", "pkg/common/src/chat-format.ts", "pkg/common/src/node/job-credentials-client.ts", "pkg/common/src/node/index.ts", "pkg/dg-daemon/__tests__/server/job-credentials-route.spec.ts", "pkg/common/__tests__/job-credentials-client.spec.ts", "pkg/common/__tests__/credentials-format.spec.ts", "pkg/skills-test/__tests__/reserved-credential-prefixes.spec.ts", "pkg/dg-daemon/src/server/bootstrap.ts", "pkg/dg-daemon/src/server/capped-body.ts", "pkg/dg-daemon/src/server/service-api.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:security]
  - id: 13
    name: "job-add-git"
    depends_on: [12]
    files: ["pkg/dg-daemon/src/jobs/sources.ts", "pkg/dg-daemon/src/jobs/declaration.ts", "pkg/dg-daemon/src/commands/job-source.ts", "pkg/dg-daemon/src/commands/jobs.ts", "pkg/dg-daemon/src/completion-tree.json", "pkg/dg-daemon/__tests__/jobs/sources.spec.ts", "pkg/dg-daemon/__tests__/jobs/declaration.spec.ts", "pkg/dg-daemon/__tests__/commands/job-add-git.spec.ts", "pkg/dg-daemon/__tests__/commands/job-source-kit.ts", "pkg/dg-daemon/__tests__/commands/job-verbs.spec.ts", "pkg/dg-daemon/src/jobs/sanitize.ts", "pkg/dg-daemon/__tests__/jobs/sanitize.spec.ts", "pkg/dg-daemon/__tests__/commands/job-source.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:security]
  - id: 14
    name: "job-update"
    depends_on: [13]
    files: ["pkg/dg-daemon/src/commands/job-source.ts", "pkg/dg-daemon/src/commands/jobs.ts", "pkg/dg-daemon/src/jobs/sources.ts", "pkg/dg-daemon/src/jobs/declaration.ts", "pkg/dg-daemon/src/completion-tree.json", "pkg/dg-daemon/__tests__/commands/job-update.spec.ts", "pkg/dg-daemon/__tests__/commands/job-source-kit.ts", "pkg/dg-daemon/__tests__/jobs/sources.spec.ts", "pkg/dg-daemon/__tests__/commands/job-add-git.spec.ts", "pkg/dg-daemon/src/commands/job-update.ts", "pkg/dg-daemon/__tests__/commands/job-update-git.spec.ts", "pkg/dg-daemon/__tests__/commands/job-source.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:security]
  - id: 15
    name: "job-setup-wizard"
    depends_on: [14]
    files: ["pkg/dg-daemon/src/commands/job-setup.ts", "pkg/dg-daemon/src/jobs/setup-answers.ts", "pkg/dg-daemon/src/jobs/secret-sources.ts", "pkg/dg-daemon/src/jobs/sources.ts", "pkg/dg-daemon/src/commands/jobs.ts", "pkg/dg-daemon/src/commands/job-source.ts", "pkg/dg-daemon/src/completion-tree.json", "pkg/common/src/node/prompt.ts", "pkg/common/src/node/index.ts", "pkg/skills-cli/src/credentials/cli.ts", "pkg/skills-cli/src/channel-review/connect.ts", "pkg/dg-daemon/__tests__/jobs/sources.spec.ts", "pkg/dg-daemon/__tests__/commands/job-setup.spec.ts", "pkg/dg-daemon/__tests__/commands/job-enable-wizard.spec.ts", "pkg/dg-daemon/__tests__/commands/job-setup-refresh.spec.ts", "pkg/dg-daemon/__tests__/commands/job-verbs.spec.ts", "pkg/dg-daemon/__tests__/jobs/setup-answers.spec.ts", "pkg/dg-daemon/__tests__/jobs/secret-sources.spec.ts", "pkg/common/__tests__/node-prompt.spec.ts", "pkg/dg-daemon/src/services/env-file.ts", "pkg/dg-daemon/__tests__/services/env-file.spec.ts", "pkg/common/package.json", "pkg/dg-daemon/src/commands/job-schedule.ts", "pkg/dg-daemon/src/commands/job-source.ts", "pkg/dg-daemon/__tests__/commands/job-setup-kit.ts", "pkg/dg-daemon/__tests__/job-command-tree.spec.ts", ".agents/school/engineering.md"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:security]
  - id: 16
    name: "job-add-local"
    depends_on: [15]
    files: ["pkg/dg-daemon/src/commands/job-local.ts", "pkg/dg-daemon/src/commands/job-source.ts", "pkg/dg-daemon/src/jobs/sources.ts", "pkg/dg-daemon/src/jobs/declaration.ts", "pkg/dg-daemon/src/commands/jobs.ts", "pkg/dg-daemon/src/completion-tree.json", "pkg/dg-daemon/__tests__/jobs/sources.spec.ts", "pkg/dg-daemon/__tests__/commands/job-add-local.spec.ts", "pkg/dg-daemon/__tests__/commands/job-local-change.spec.ts", "pkg/dg-daemon/__tests__/commands/job-local-headless.spec.ts", "pkg/dg-daemon/__tests__/commands/job-add-git.spec.ts", "pkg/dg-daemon/__tests__/commands/job-source-kit.ts", "pkg/dg-daemon/src/commands/job-update.ts", "pkg/dg-daemon/src/commands/job-setup.ts", "pkg/dg-daemon/__tests__/commands/job-source.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
  - id: 17
    name: "job-credential-env"
    depends_on: [16]
    files: ["pkg/dg-daemon/src/jobs/launcher.ts", "pkg/dg-daemon/src/jobs/runner.ts", "pkg/dg-daemon/src/jobs/control.ts", "pkg/dg-daemon/src/jobs/config.ts", "pkg/dg-daemon/src/jobs/declaration.ts", "pkg/dg-daemon/src/jobs/sources.ts", "pkg/dg-daemon/__tests__/jobs/sources.spec.ts", "pkg/dg-daemon/src/services/supervisor.ts", "pkg/dg-daemon/src/commands/jobs.ts", "pkg/dg-daemon/src/commands/job-local.ts", "pkg/dg-daemon/src/commands/job-source.ts", "pkg/dg-daemon/src/server/bootstrap.ts", "pkg/dg-daemon/src/completion-tree.json", "pkg/dg-daemon/__tests__/jobs/launcher-credential-env.spec.ts", "pkg/dg-daemon/__tests__/jobs/launcher.spec.ts", "pkg/dg-daemon/__tests__/jobs/config.spec.ts", "pkg/dg-daemon/__tests__/jobs/declaration.spec.ts", "pkg/dg-daemon/__tests__/commands/job-credential-env.spec.ts", "pkg/common/src/credentials-format.ts", "pkg/common/__tests__/credentials-format.spec.ts", "pkg/dg-daemon/src/server/credentials.ts", "pkg/dg-daemon/src/commands/job-update.ts", "pkg/dg-daemon/src/commands/job-schedule.ts", "pkg/dg-daemon/__tests__/jobs/runner.spec.ts", "pkg/dg-daemon/__tests__/services/supervisor-kit.ts", "pkg/dg-daemon/__tests__/services/supervisor.spec.ts", "pkg/dg-daemon/__tests__/server/job-credentials-route.spec.ts", "pkg/dg-daemon/__tests__/commands/job-verbs.spec.ts", "pkg/dg-daemon/__tests__/commands/job-add-local.spec.ts", "pkg/dg-daemon/src/commands/job-source.ts", "pkg/common/src/credentials-format.ts", ".agents/school/security.md"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:security]
  - id: 18
    name: "credential-refresh-api"
    depends_on: [17]
    files: ["pkg/dg-daemon/src/server/service-api.ts", "pkg/dg-daemon/src/server/http.ts", "pkg/dg-daemon/src/server/bootstrap.ts", "pkg/dg-daemon/src/jobs/credential-refresh.ts", "docs/service-api.md", "pkg/dg-daemon/__tests__/server/service-api.spec.ts", "pkg/dg-daemon/__tests__/server/service-api-refresh.spec.ts", "pkg/dg-daemon/__tests__/jobs/credential-refresh.spec.ts", "pkg/skills-test/__tests__/outside-services-docs.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:security]
  - id: 19
    name: "channel-review-export"
    depends_on: [11]
    files: ["pkg/skills-cli/src/channel-review/cli.ts", "pkg/skills-cli/src/channel-review/export.ts", "pkg/skills-cli/__tests__/channel-review-export.spec.ts", "pkg/skills-cli/__tests__/channel-review-cli.spec.ts", "plugins/dg/skills/channel-review/references/commands.md", "pkg/skills-test/__tests__/channel-review-skill.spec.ts", "pkg/skills-cli/src/completion/tree.json"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
  - id: 20
    name: "job-source-docs"
    depends_on: [18, 19]
    files: ["docs/adr/*-job-sources-and-credentials.md", "docs/adr/toc.md", "docs/jobs-and-services.md", "docs/service-api.md", "docs/channel-review.md", "SECURITY.md", "plugins/dg/skills/jobs/SKILL.md", "pkg/skills-test/__tests__/outside-services-docs.spec.ts", "pkg/skills-test/__tests__/dg-front-door-docs.spec.ts", "pkg/skills-test/__tests__/job-source-docs.spec.ts", "docs/adr/0043-outside-services.md"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: low
  - id: 21
    name: "remove-channel-review"
    depends_on: [20]
    files: ["pkg/channel-review/**", "pkg/skills-cli/src/channel-review/**", "pkg/skills-cli/src/commands/channel-review.ts", "pkg/skills-cli/src/register-all.ts", "pkg/skills-cli/src/doctor/registry.ts", "pkg/skills-cli/src/credentials/cli.ts", "pkg/skills-cli/package.json", "pkg/skills-cli/README.md", "pkg/skills-cli/__tests__/**", "bun.lock", "pkg/common/src/node/daemon-schema.ts", "pkg/common/src/node/daemon-db.ts", "pkg/common/src/node/install-skills.ts", "pkg/common/__tests__/**", "pkg/dg-daemon/__tests__/store/**", "pkg/dg-daemon/__tests__/server/credentials-frame.spec.ts", "plugins/dg/skills/channel-review/**", "plugins/dg/skills/jobs/SKILL.md", "plugins/dg/skills/doctor/SKILL.md", "plugins/dg/skills/thrash/SKILL.md", "plugins/dg/skills/README.md", "pkg/skills-test/__tests__/**", "docs/**", "README.md", "SECURITY.md", ".env.example", ".gitleaks.toml", ".mise/config.toml", ".github/workflows/skills-blt.yml", "pkg/dg-daemon/src/commands/service.ts", "pkg/dg-daemon/src/commands/jobs.ts", "pkg/dg-daemon/src/commands/job-schedule.ts", "pkg/dg-daemon/src/commands/stop.ts", "pkg/dg-daemon/src/main.ts", "pkg/dg-daemon/src/server/http.ts", "pkg/dg-daemon/src/completion-tree.json", "pkg/dg-agent/src/completion-tree.json", "pkg/skills-cli/src/completion/tree.json", "pkg/common/src/chat-format.ts", "pkg/dg-daemon/__tests__/**", "pkg/skills-cli/src/completion/describe.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:reviewer]
execution:
  profile: balance
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
worktree:
  pr_url: https://github.com/detailedghost/dg-ai/pull/227
---

# job install

## Purpose
Make `job` the one noun for each program that dg-daemon runs: a continuous job or a scheduled job, from a command, a local script or folder, or a git repository. `dg job add` registers a job, `dg job enable` collects its credentials one time, stores them, grants them and starts the job, and `dg job setup` changes them later. Add `dg` as the entry command and a login unit for the daemon, fix two defects (tests that write into the real dg home, and a layout migration that leaves a stale daemon folder in use), then remove channel review from dg in a major release. The work ships as four PRs: PR 1 is slices 1 to 7 (the fixes and the `dg` program), PR 2 is slices 8 to 11 (the jobs merge and its migration), PR 3 is slices 12 to 20 (repository jobs, local jobs, the setup wizard, the credential refresh and the export), then an operator gate, then PR 4 is slice 21 (the major removal).

## Scope
### Included
- PR 1 (minor), slices 1 to 7: the test home fence, the job paths and the delete guard, the layout fix, `dg-daemon autostart`, the `dg` program, its launcher, and their documents
- PR 2 (minor), slices 8 to 11: one `jobs` table, the two migrations at daemon start, the `job` verbs, scheduled jobs on the same launcher, and the job model documents
- PR 3 (minor), slices 12 to 20: the credential route, `dg job add` for a git repository and for a local path, `update`, the setup wizard, credentials as environment variables, the service API operation `refresh`, the channel-review export, and their documents
- OPERATOR GATE after PR 3: the owner confirms that each bot job runs from `dg job add` and `dg job enable` before PR 4 starts
- PR 4 (major), slice 21: the removal of channel review, of the `dg-daemon service` group and of the alias forms
- The test home fence in each package, with an error when a DG path leaves it
- The paths `<data>/jobs/<source>`, `<data>/jobs/sources.json` and `<state>/jobs/<name>`; `removeInside` and `insideRoot` in pkg/common/src/node/fs.ts
- The injected key `DG_SERVICE_STATE_DIR`, an addition to service API v1, and `DG_HOME` of the daemon in the environment of each job
- The layout fix for the `daemon` entry, and a block when two daemon folders hold data
- `dg-daemon autostart install|remove|status`, with the autostart module moved to pkg/common; the phone listener keeps its unit
- `dg-daemon start` and `dg-daemon restart` through the service manager when a login unit is installed
- The `dg` program: `ProgramName`, the package pkg/dg, the launcher entry, a fourth launcher, the bootstrap scripts, one doctor check, and shell completion with `dg completion <shell>`
- The groups `dg job` and `dg autostart`; the mounts `dg skills`, `dg agent` and `dg daemon`; the aliases `dg extension`, `dg install`, `dg upgrade` and `dg doctor`
- One `jobs` table in `<state>/daemon/config.json` with one mode key for each entry: `continuous`, `schedule` or `every`; `enabled` replaces `autostart`
- The move of each `services` entry and of each scheduled row to the `jobs` table at daemon start, with the backup `config.json.pre-jobs`
- The verbs `dg job add|enable|disable|start|stop|restart|setup|update|remove|logs|status|list`
- The alias forms `dg-daemon service …`, `--label`, `--cron`, `--pass-env`, `rm`, `run` and `exec` until the major release
- One question at the first `enable` in a terminal: install the dg-daemon login unit
- `dg job add <git-url>[@ref]` with a pinned commit, a request text, a consent step and `--yes`; `dg job add <path>` for a script file or a folder, with no clone and no question
- The `dg` block of a package.json: `jobs`, `credentials`, `requires` and `build`
- The owner-token route `POST /jobs/<name>/credentials`: write-only for the credential prefix of one job
- The setup wizard of `enable` and `setup`: a hidden prompt and AWS Secrets Manager as sources, `--setup <file or ->`, and `setup --refresh`
- The operation `refresh` of service API v1: a job that runs asks the daemon to fetch one of its credentials again from its declared source
- `--credential <name>=<NAME>`: a credential as an environment variable of the job
- `dg-skills channel-review export --env <env> --label <label>`, which writes `<state>/jobs/<label>/import.json`
- The job model record and the job sources record in docs/adr, the amendment of ADR 0020, docs/jobs-and-services.md and the jobs skill
- The removal of channel review from dg (slice 21, its own PR, a major release, behind the operator gate)
- One dated line in ADR 0043 in each of PR 1, PR 2 and PR 3 for the additions to service API v1: the injected keys, the noun `job`, and the operation `refresh`
### Excluded
- The review bot repository; it has its own spec bundle
- One merged binary and the `dg-v<x>` release tag of ADR 0020
- A `dg review` group and a `dg service` group
- Jobs in `<config>/config.json`; the `jobs` table stays in `<state>/daemon/config.json`
- A git command in the daemon process
- `passEnv`, `cwd`, `grant` and `enabled` as keys of a repository block
- A secret source that is a command of the repository
- Azure Key Vault as a secret source; a later bundle adds it
- A source in a `refresh` request; the daemon fetches only from the recorded source of the job
- The answer of `--yes` to the question for a credential prefix that already holds credentials; that question needs one `y` at a terminal
- A file watcher, a content hash of a local script, and a `--watch` flag
- A wizard for the plain lines of an env file; the env file stays a manual step
- Two repositories that share one credential prefix
- The delete of stored credentials, grants or job state folders by `job remove`
- A `pattern` key or a live check of a credential value
- A move of the folder pkg/dg-daemon/src/services, of the pid files or of the log files
- A `--credential` flag or a login unit key in the `--setup` file
- A change of the usage lines or error prefixes of the mounted programs
- `dg` names in SKILL.md files; the skills keep `dg-skills`, `dg-agent` and `dg-daemon`
- An `--accept` option
- A merge of two daemon folders or of a stale `config.json`
- A change of `dg-agent start`; it starts a detached daemon as before
- A second run of the old `build` after a failed `update`
- `CHANGELOG.md` and the version stamps; .github/workflows/release.yml writes them
- A guard for a scheduled run that starts while `update` changes the clone [DECIDED — gaps pass O9 (b): a known gap]

### Slice 1 — test-home-fence

#### Engineering
- [x] A part of this slice is built and not committed in the worktree of the branch `feature/service_install` (31 changed files): first compare each line of this list with that work, keep what passes, and build the remainder
- [x] Move that work in two steps: the owner first saves it (a WIP commit on `feature/service_install`, or a patch in the state directory), so the worktree does not hold the only copy; PR 1 then starts in a new worktree from master and gets the work from `git diff` plus a copy of the 25 untracked files
- [x] Reproduce the leak first: on master, `bun test` in pkg/dg-daemon, pkg/common and pkg/skills-test runs with the `DG_HOME` and `HOME` of the shell, because only the root bunfig.toml and pkg/skills-cli/bunfig.toml preload the fence, and CI and `bun run test:all` run `bun test` in each package directory
- [x] In pkg/skills-cli/__tests__/test-home-fence.ts, set `process.env.DG_PATH_FENCE` to `os.tmpdir()`, not to the fence home: about 300 `mkdtempSync(join(tmpdir(), …))` calls in about 170 spec files make their homes as siblings of the fence home, and pkg/skills-cli/__tests__/home-fence.spec.ts already uses `os.tmpdir()` as the limit; the PR body gives the search command and its result, not a fixed number
- [x] Do not move the temp homes of the specs below the fence home
- [x] In `resolveDgPaths` of pkg/common/src/node/dg-paths.ts, read `DG_PATH_FENCE` from the same `env` object that gives the roots (`seams.env ?? process.env`)
- [x] When `DG_PATH_FENCE` is not empty and one of the six roots or `legacyHome` is not below that directory, throw an `Error` with the text `dg path fence: <role> <path> is outside <fence> (unset DG_PATH_FENCE to turn the fence off)`
- [x] Compare paths by segment with the path module of the call (`win32` or `posix`, as `resolveDgPaths` selects it), so the fence `/f` does not accept `/f2`
- [x] On win32, compare with no letter case
- [x] Resolve the two sides with that path module before the compare
- [x] A path that is equal to the fence is inside the fence
- [x] Accept a path below the fence or below `realpathSync(<fence>)`: on macOS `os.tmpdir()` is below `/var`, which is a link to `/private/var`
- [x] When the fence folder does not exist, use the fence as given
- [x] Run the fence check before the memo lookup, so a cached result of a call with no fence cannot pass a later call with a fence
- [x] A call that throws adds nothing to the path cache
- [x] Add `pkg/<name>/bunfig.toml` with `[test] preload = ["../skills-cli/__tests__/test-home-fence.ts"]` for each package that has a `test` script and no bunfig.toml: channel-review, common, dg-agent, extension, inbox, launcher, pages, skills-test, ssms, tour-ui
- [x] In pkg/dg-daemon/bunfig.toml, put the fence first in `preload`; keep the two other entries and `timeout = 15000`
- [x] Do not change the preload lists of the root bunfig.toml and pkg/skills-cli/bunfig.toml
- [x] `runInHarness` in pkg/skills-test/__tests__/test-support.ts spreads `process.env`, so its child has the fenced `HOME` and `DG_PATH_FENCE`; it needs no change, only the spec of the `runInHarness` Happy path line
- [x] Find each spawn in a spec or a test helper that does not spread `process.env`: search for `env:` next to `Bun.spawn` or `spawn(` in each `__tests__` folder
- [x] Make each such spawn give the child a `HOME` below `os.tmpdir()` and the `DG_PATH_FENCE` of the parent
- [x] For each spec that the fence stops, change only its environment setup or its `seams`; do not change its assertions
- [x] Search the specs for `delete process.env.DG_HOME` and for `resolveDgPaths()` calls that pass the real `homedir()`
- [x] List each spec that the fence stopped, and each changed spawn, in the PR body
- [x] A spec that tests the default roots passes `seams.homeDir` and `seams.env`; it does not delete `process.env.DG_HOME` and then call `resolveDgPaths()` with no seams, because `os.homedir()` of bun keeps the real home after `HOME` changes
- [x] Add pkg/skills-test/__tests__/home-fence-reach.spec.ts: it reads each pkg/*/package.json and fails when a package with a `test` script has no bunfig.toml that preloads the fence
- [x] The reach spec parses the `[test] preload` list of each bunfig.toml, resolves each entry from the package folder, and compares the real path with pkg/skills-cli/__tests__/test-home-fence.ts
- [x] The reach spec checks only packages whose `test` script runs `bun test`; it also checks the root bunfig.toml
- [x] Write no file below the repository root and no file below the real home in a test
- [x] The fence guards `resolveDgPaths` only; code that calls `os.homedir()` directly is not in the fence (install-skills.ts, scratch-paths.ts, hooks/cli.ts, db/credentials.ts, the unit writers of slice 4)
- [x] Do not make this slice wider for that code; state the limit in the PR body
- [x] State in the PR body that the fence is as tight as `TMPDIR`
- [x] State in the PR body that a product process with `DG_PATH_FENCE` set and a root outside it stops with the fence error
- [x] Give each Contract its spec: the `resolveDgPaths` Contracts are in pkg/common/__tests__/dg-paths-fence.spec.ts; the `subprocessEnv` Contract is in pkg/dg-daemon/__tests__/utils/daemon-harness-fence.spec.ts; the Happy path for each package directory is in test-home-fence-env.spec.ts of each package (pkg/inbox/test/test-home-fence-env.test.ts for inbox); the Happy path and the Error of `runInHarness` are in pkg/skills-test/__tests__/run-in-harness-fence.spec.ts
- [x] A relative `DG_PATH_FENCE` throws `Error` with `dg path fence: <fence> is not absolute`; do not resolve it against the current directory

#### Testing Criteria
##### Contracts
- [x] Contract: `resolveDgPaths({ env: { DG_PATH_FENCE: "/f", DG_HOME: "/f/x" } })` returns the paths below `/f/x`
- [x] Contract: `resolveDgPaths({ env: { DG_PATH_FENCE: "/f", DG_HOME: "/g" } })` throws an `Error` whose message starts with `dg path fence:`, holds `is outside /f`, and ends with `(unset DG_PATH_FENCE to turn the fence off)`
- [x] Contract: `resolveDgPaths({ env: { DG_PATH_FENCE: "/f", DG_HOME: "/f2/x" } })` throws
- [x] Contract: with no `DG_PATH_FENCE` in `env`, `resolveDgPaths` returns the same object as before this change for each platform in pkg/common/__tests__/dg-paths.spec.ts
- [x] Contract: a call with an explicit `seams.env` that has no `DG_PATH_FENCE` does not throw when `process.env.DG_PATH_FENCE` is set
- [x] Contract: `resolveDgPaths({ env: { DG_HOME: "/g" } })` returns; the same call with `DG_PATH_FENCE: "/f"` added then throws
- [x] Contract: a root that is equal to `DG_PATH_FENCE` does not throw
- [x] Contract: `resolveDgPaths({ platform: "win32", env: { DG_PATH_FENCE: "C:\\f", DG_HOME: "C:\\f2\\x" } })` throws
- [x] Contract: the same win32 call with `DG_HOME: "c:\\F\\x"` returns
- [x] Contract: in pkg/dg-daemon, the env object of `subprocessEnv` has no `XDG_CONFIG_HOME`, and its `HOME` is below `os.tmpdir()`; this holds because `subprocessEnv` spreads `process.env` after the preload ran; add no env filter to `subprocessEnv`, because the subprocess specs of start.spec.ts and stop.spec.ts in slice 4 use this behavior
- [x] Contract (red step, by hand): before the bunfig edits, home-fence-reach.spec.ts fails and names all eleven packages: channel-review, common, dg-agent, dg-daemon, extension, inbox, launcher, pages, skills-test, ssms and tour-ui (on master no bunfig.toml of these packages preloads the fence); record the failing names in the PR body; after the change it passes
- [x] Happy path: in each package directory, a spec sees `process.env.DG_HOME`, `process.env.HOME` and `process.env.USERPROFILE` below `os.tmpdir()`
- [x] Happy path: a child of `runInHarness` with no `env` override resolves each DG root below `os.tmpdir()`
- [x] Happy path: a daemon that `spawnServe` starts in a `freshDgHome()` folder boots with the inherited `DG_PATH_FENCE`
- [x] Error: a child that `runInHarness` starts with a script that calls `resolveDgPaths()`, with `DG_HOME=<a directory outside the fence>` and the `DG_PATH_FENCE` of the parent, exits with a code that is not 0, and stderr holds `dg path fence:`; do not use the `dg-daemon` entry for this test
- [x] Error: in a fenced spec, `delete process.env.DG_HOME` and then `resolveDgPaths()` throws the fence error
- [x] Check: set `HOME` and `DG_HOME` of the shell to two empty sentinel directories, run `bun test` in each package directory, and list the sentinels; they hold no file
- [x] Regression: `bun test` passes at the root and in each package directory; `bun run lint` passes in pkg/common and pkg/skills-test
- [x] Contract: `resolveDgPaths({ env: { DG_PATH_FENCE: "", DG_HOME: "/g" } })` returns the same object as the call with no `DG_PATH_FENCE`
- [x] Contract: the fence `/f/` accepts `/f/x` and refuses `/f2/x`
- [x] Contract: with a fence that is a symbolic link, a root below `realpathSync(<fence>)` returns
- [x] Contract: a fence folder that does not exist is used as given: a root below it returns, and a root outside it throws
- [x] Contract: `resolveDgPaths({ env: { DG_PATH_FENCE: "f", DG_HOME: "/f/x" } })` throws with `is not absolute`

#### Acceptance Criteria
- [x] Given a shell that exports `DG_HOME` and `HOME`, when `bun test` runs in pkg/dg-daemon, pkg/common, pkg/dg-agent or pkg/skills-test, then no file below those two directories is created or changed through a DG path
- [x] Given a spec that resolves a DG path outside the fence, when the spec runs, then it fails with `dg path fence:` and names the path
- [x] Given a new package with a `test` script and no fence preload, when pkg/skills-test runs, then home-fence-reach.spec.ts fails and names the package
- [x] Given a process with no `DG_PATH_FENCE`, when it resolves the DG paths, then the result is the same as before this change

### Slice 2 — job-paths-and-guard

#### Engineering
- [x] Add to `DgPaths` in pkg/common/src/node/dg-paths.ts the strings `jobsDir` = `<dataDir>/jobs`, `jobSourcesPath` = `<dataDir>/jobs/sources.json` and `jobStateRoot` = `<stateDir>/jobs`
- [x] Export from dg-paths.ts the helpers `jobSourceDir(paths, source)` = `<paths.jobsDir>/<source>` and `jobStateDir(paths, name)` = `<paths.jobStateRoot>/<name>`
- [x] `DgPaths` holds strings only; add no function member
- [x] Move `insideRoot(root, dir)` from pkg/channel-review/src/address.ts to pkg/common/src/node/fs.ts and export it
- [x] Add `removeInside(root: string, dir: string): void` to fs.ts: it throws `Error` with `refused to delete <dir>: it is not inside <root>` when `insideRoot` is false; otherwise it calls `rmSync(dir, { recursive: true, force: true })`
- [x] In address.ts, `removeCloneDir` checks `insideRoot` first, keeps its `refused to delete` warning and returns; then it calls `removeInside` inside the try/catch that exists, so `removeCloneDir` never throws and keeps its two warning texts; delete the local `insideRoot`
- [x] Move the `insideRoot` test (five expects) of pkg/channel-review/__tests__/core-address.spec.ts as written to pkg/common/__tests__/node-fs.spec.ts; add there the two `removeInside` throw cases and the delete case; remove `insideRoot` from the import line of core-address.spec.ts
- [x] In `serviceEnv` of pkg/dg-daemon/src/services/supervisor.ts, where `DG_SERVICE_LABEL` and `DG_DAEMON_URL` are set (not in `launch`), add `DG_SERVICE_STATE_DIR=<jobStateDir(paths, label)>` to the injected keys of each service
- [x] In `serviceEnv`, put `DG_SERVICE_STATE_DIR` after the `envFile` and `passEnv` values in the environment of the child, where `DG_SERVICE_LABEL` is
- [x] Add `jobStateRoot` to the `paths` pick of `SupervisorDeps`; edit the two builders that exist: the fixture builder in pkg/dg-daemon/__tests__/services/supervisor-kit.ts and the `createSupervisor` literal in pkg/dg-daemon/__tests__/services/supervisor.spec.ts; add no third builder
- [x] In the supervisor `preflight`, create the state folder with `ensurePrivateDir` after the grant check and before `checkExecutableResolves`, so a missing `cwd` still gives its own text first; when the create fails, `start` returns the kind `invalid` and no process starts
- [x] `preflight` returns the text `cannot create the state folder <path>: <reason>`; the HTTP 400 comes from the existing `invalid` kind; add no route and change no route
- [x] The five keys of service API v1 do not change; the new key is an addition; it changes no key of v1 in place (ADR 0043), and slice 7 records it in ADR 0043 with one dated line
- [x] In pkg/dg-daemon/__tests__/services/supervisor-service-api.spec.ts, change the test names that say `the three keys` and `the five keys`, so that they give no count that is now wrong; change no assertion: no assertion in pkg/dg-daemon/__tests__/services compares the full child environment or counts its keys (checked with a search for `DG_SERVICE_LABEL|Object.keys`)
- [x] Extend the existing test that the injected keys win for the order Contract; add no new rig
- [x] Do not edit pkg/dg-daemon/src/server/bootstrap.ts: it gives `createSupervisor` the full paths object
- [x] Do not edit pkg/dg-daemon/src/commands/service.ts, pkg/dg-daemon/src/main.ts, pkg/common/src/node/index.ts or pkg/dg-daemon/__tests__/utils/daemon-harness.ts
- [x] This slice lands before slice 21 deletes pkg/channel-review/src/address.ts
- [x] The folders have the word `jobs`, because slice 8 makes `job` the one noun; the injected key keeps the name `DG_SERVICE_STATE_DIR`, because the key names of service API v1 keep the word `SERVICE`
- [x] Do not move `<state>/daemon/services/<label>.pid` and do not rename `<log>/service-<label>.log`: the supervisor uses the pid file to find an instance that still runs after a daemon crash
- [x] When the environment of the daemon has `DG_HOME`, `serviceEnv` adds `DG_HOME` with that value to the environment of each child, after the `envFile` and `passEnv` values, where `DG_SERVICE_LABEL` is; the child gets `process.env.DG_HOME` of the daemon as it is, because `normalizeDgHome` already made it absolute; a daemon with no `DG_HOME` adds no `DG_HOME`
- [x] In address.ts, remove the `resolve` and `sep` imports of `node:path` when no code uses them, and import `insideRoot` and `removeInside` from `@dg/common/node`
- [x] `removeInside` also compares `realpathSync` of the parent of `dir` with `realpathSync(root)` when the two exist, and throws the same text when the real parent is not inside the real root [DECIDED — gaps pass O1 (b)]
- [x] Export `isJobName(name: string): boolean` from dg-paths.ts with the rule `^[a-z0-9][a-z0-9-]{0,63}$`; it is the one name rule for a job and for a source, and slices 8 and 19 import it
- [x] `jobSourceDir` and `jobStateDir` throw `Error` with `dg paths: "<name>" is not a valid job or source name` for a name that fails `isJobName`; `DgPaths` stays strings only
- [x] State the limit in the PR body: the daemon gives a child its `DG_HOME` only; a daemon whose roots come from `XDG_*_HOME`, `LOCALAPPDATA` or `APPDATA` gives the child none of them
- [x] `preflight` makes the state folder only in `start`: a folder that the owner deletes while the job runs is not made again at a restart (accepted); state it in the PR body
- [x] Create pkg/dg-daemon/__tests__/services/supervisor-state-dir.spec.ts for the Contracts on the environment, the mode 0700, HTTP 400, `service stop` and `service rm`, `service add`, the pid and log paths and `DG_HOME`; only the order Contract extends supervisor-service-api.spec.ts
- [x] Move `withDaemonEnv` to pkg/dg-daemon/__tests__/services/supervisor-kit.ts
- [x] After the change of supervisor-kit.ts, run the three specs that import it: supervisor-service-api.spec.ts, supervisor-env.spec.ts and supervisor-stop.spec.ts
- [x] Do not edit pkg/skills-cli/__tests__/layout-fixtures.ts or bundle-build.ts: slice 3 builds with them at the same time
- [x] `insideRoot` uses the path module of the host; it does not call the segment compare of slice 1, which is private to dg-paths.ts because it needs the `win32` or `posix` seam

#### Testing Criteria
##### Contracts
- [x] Contract: with `DG_HOME=/d`, `paths.jobsDir` is `/d/data/jobs`, `paths.jobSourcesPath` is `/d/data/jobs/sources.json`, `paths.jobStateRoot` is `/d/state/jobs`, `jobSourceDir(paths, "bot")` is `/d/data/jobs/bot`, and `jobStateDir(paths, "bot-dev")` is `/d/state/jobs/bot-dev`
- [x] Contract: each value of the `DgPaths` object is a string
- [x] Contract: `removeInside("/a/root", "/a/root")`, `removeInside("/a/root", "/a/root/../other")` and `removeInside("/a/root", "/a/rootless/x")` throw and delete nothing
- [x] Contract: `removeInside(root, <a directory inside root>)` deletes that directory and keeps its siblings
- [x] Contract (environment): each service gets `DG_SERVICE_STATE_DIR` equal to `<state>/jobs/<label>`; the folder exists with mode 0700 when the child starts (POSIX; skip the mode assertion on win32); the mode of the parent folder is not a contract
- [x] Contract (order): the `DG_SERVICE_STATE_DIR` of the daemon wins over a line with the same name in `envFile` and over `passEnv`
- [x] Contract: `service stop` and `service rm` do not delete the state folder
- [x] Contract: when the state folder cannot be created, `POST /services/<label>/start` gives HTTP 400 with `cannot create the state folder <path>: <reason>`, and no process starts; the spec has two causes: `jobStateRoot` is a regular file, and the folder has no write permission; `<reason>` is the `describeError` text of the error
- [x] Contract: with `DG_PATH_FENCE` set, `jobsDir` and the state folder of a label resolve below the fence; a `DG_HOME` outside the fence throws the fence error
- [x] Edge: a service of `service add` also gets `DG_SERVICE_STATE_DIR`
- [x] Regression: `bun test` passes in pkg/common, pkg/channel-review and pkg/dg-daemon; `bun run lint` passes in the three packages
- [x] Contract: a daemon with `DG_HOME=/d` gives each child `DG_HOME=/d`; a line `DG_HOME=/x` in `envFile` does not win; a daemon with no `DG_HOME` in its environment adds no `DG_HOME` to the child
- [x] Contract: after this slice, the pid file of a service is `<state>/daemon/services/<label>.pid` and its log file is `<log>/service-<label>.log`, as on master
- [x] Contract: the test `refuses the root itself and a path outside it` of pkg/channel-review/__tests__/core-address.spec.ts passes with no change: two warnings and no throw
- [x] Contract: with `<root>/x` a link to a folder outside the root, `removeInside(root, "<root>/x/sub")` throws and deletes nothing [DECIDED — gaps pass O1 (b)]
- [x] Contract: `jobStateDir(paths, name)` and `jobSourceDir(paths, name)` throw for `""`, `"."`, `".."`, `"a/b"` and `"A"`
- [x] Contract: after a crash, the supervisor starts the child again with the same `DG_SERVICE_STATE_DIR` and the same `DG_HOME`
- [x] Contract: `preflight` accepts a state folder that exists with mode 0700 and holds a file (for example `import.json`), and the file does not change

#### Acceptance Criteria
- [x] Given a directory outside `<data>/jobs`, when a removal runs, then `removeInside` refuses and deletes nothing
- [x] Given a running service, when it reads `DG_SERVICE_STATE_DIR`, then the value is its own state folder and the folder exists
- [x] Given a service that calls `dg-skills` or `dg-agent`, when the daemon runs with a `DG_HOME`, then that call uses the same dg home as the daemon

### Slice 3 — layout-stale-daemon

#### Engineering
- [x] Reproduce first in pkg/common/__tests__/layout-stale-daemon.spec.ts: the legacy folder `<legacy>/daemon` holds a used `daemon.db`, and `<state>/daemon` holds only a `config.json`; on master the plan gives `keepUsed` for the entry `daemon`, because `unused: "folder"` accepts only an empty target, so the legacy data never moves, and the next daemon start makes a new empty `daemon.db` in the kept target
- [x] Change the `daemon` entry of `LAYOUT_TABLE` in pkg/common/src/node/layout.ts, and the decision in pkg/common/src/node/layout-work.ts when the entry needs it, so that the plan of the `daemon` entry follows the seven rules below; keep `unused: "folder"` on the entry (layout.spec.ts asserts it, and clean.ts reads `entry.unused`), and add a separate key, for example `usedBy`, for the new rule; do not edit pkg/skills-cli/src/install/clean.ts
- [x] A `daemon` folder is used when it holds a `key`, a `credentials.db` or a used `daemon.db`; other files, such as `config.json`, do not make it used; the rule is the same for the legacy folder and for the target `<state>/daemon`
- [x] A `daemon.db` that a daemon opened one time holds one `crypto_meta` row, so it is used; dg does not decide that a `key` or that row has no value
- [x] Rule 1: no legacy folder gives `absent`
- [x] Rule 2: a legacy folder and no target gives `move`, as on master
- [x] Rule 3: a legacy folder and an empty target gives `setAside`, as on master
- [x] Rule 4: a used legacy folder and a target that holds files and is not used gives `setAside`; this is the stale case of the Reproduce step
- [x] Rule 5: a used legacy folder and a used target gives `{ kind: "block", reason: "two-used" }`, not `keepUsed`; add `"two-used"` to `BlockReason` in pkg/common/src/node/layout.ts
- [x] Rule 6: a legacy folder that is not used and a target that holds files and is not used gives `keepUsed`, as on master
- [x] Rule 7: a legacy folder that is not used and a used target gives `keepUsed`, as on master
- [x] A pending record of `.pending-removal.json` is read first, as on master
- [x] Add `daemonFolderUnused(dir): boolean` to pkg/common/src/node/sqlite-unused.ts for the new rule, with `lstat`: a missing path, a file and a link give `true`; an empty folder and a folder that holds only `config.json` give `true`; a folder that holds `key`, `key.dpapi`, `credentials.db` or a used `daemon.db` gives `false`; a folder that cannot be read gives `false` and does not throw; do not change `folderUnused`, because `dg-skills clean` uses it to delete set-aside folders
- [x] Keep the existing set-aside path: the old target goes to a set-aside folder, the output names it, and `DAEMON_ASIDE_MARK` is written
- [x] Keep the `live` and `stop` rules of the entry: a live daemon in the legacy folder is stopped through `daemon.stop` before the move, or the entry blocks
- [x] No other entry of `LAYOUT_TABLE` changes its plan, except `sessions`, `assets`, `daemon-logs` and `personas` (the parent of `agents/sessions`) when the `daemon` entry is `two-used`
- [x] The entries `sessions`, `assets` and `daemon-logs` are before `daemon` in `LAYOUT_TABLE` and share its `live` and `stop` rules; when the `daemon` entry is `two-used`, each of them and `personas` gets the outcome `blocked` with the reason `two-used` and the text of the `daemon` entry, not `skip`: add the `two-used` fact of `daemon` to the snapshot, and let the four entries read it
- [x] The compiled spec in pkg/skills-cli builds the bundle from a tree that slice 2 edits at the same time; a build failure in a file of that slice is a retry, not a finding; the compiled spec makes its own temp folder for the bundle output and uses no shared build folder
- [x] The verify step of PR 1 runs the compiled spec again
- [x] The compiled spec makes its home in a temp folder with `DG_HOME` and `DG_PATH_FENCE` set; it never reads `.env`
- [x] `blockedText` for `two-used` is `dg: two daemon folders hold data: <from> and <to>. dg does not choose one and does not merge them. Move the folder that you do not want to a different name, then run the command again`
- [x] A `two-used` block moves, copies, merges and deletes nothing; it does not read a `config.json`
- [x] The layout step never copies a key of a `config.json` from a set-aside folder or a blocked folder into the live `config.json`
- [x] A `two-used` block prints as a `live-writer` block does on master: the layout step prints the text one time for each run, and a command that also calls `assertNotBlocked` prints its own error line
- [x] `assertNotBlocked(paths, "daemon")` throws that text through the existing `blocked` branch; add no second check
- [x] Add `EXIT_LAYOUT_BLOCKED = 78` to pkg/common/src/errors.ts; `assertNotBlocked` throws `new DgCliError(fix, EXIT_LAYOUT_BLOCKED)` for a block with the reason `two-used`, and each other block keeps the exit code 1
- [x] Do not edit pkg/dg-daemon/src/main.ts: it returns the exit code of the error
- [x] `layoutCheck` in pkg/skills-cli/src/install/doctor.ts: for a `two-used` block the `fix` is the rename sentence of `blockedText`, not `dg-skills install`; export the rename sentence as one constant in layout.ts, and `blockedText` and the doctor `fix` build from it
- [x] On Windows, when `layoutCheck` finds a `two-used` block and a `live-writer` block, it reports the `two-used` fix (the same order as the Edge with two used folders and a live daemon in the legacy folder)
- [x] Reuse pkg/skills-cli/__tests__/layout-fixtures.ts for the new specs of pkg/skills-cli; add no second fixture file
- [x] When the set-aside folder holds a file, the output line is `dg: set aside <dest> as <aside>; dg copied no file from it, and dg-skills clean keeps it`; for an empty target the line of master stays; `setAside` in layout-work.ts reads the folder with `readdirSync` before the rename to select the line, and the set-aside name stays `<dest>.empty-<now>`
- [x] Give the remedy for a home with two used folders in the PR body: move `<state>/daemon` to a different name when the legacy folder holds the sessions, then start again; the PR body also says that `dg-daemon serve` now exits 78 for a home with two used folders, where master kept the target (`keepUsed`) and started
- [x] Search each spec for a fixture with a legacy `daemon.db` and a target file; list each spec whose result changes in the PR body
- [x] Type edits: `Action.block.reason` in layout-work.ts gets `"two-used"`, and `Facts` gets the facts legacy-used, target-used and two-used
- [x] Name the three target states that Rules 3 to 7 use: empty (`folderUnused(dest)` is `true`), holds files and is not used, and used

#### Testing Criteria
##### Contracts
- [x] Contract: with a used legacy `daemon.db` and a target that holds only `config.json`, the plan for `daemon` is `setAside`, not `keepUsed`
- [x] Contract: after the move, `<state>/daemon/daemon.db` is the legacy file, and the old target content is in the set-aside folder
- [x] Contract: with an empty target, the plan is `setAside` as before; with no target, the plan is `move` as before
- [x] Contract: a target that holds a `key` or a `credentials.db` is not unused
- [x] Contract: the plan of each other entry of `LAYOUT_TABLE` is the same as on master for the fixtures of pkg/common/__tests__/layout.spec.ts, except `sessions`, `assets`, `daemon-logs` and `personas` in a fixture whose `daemon` entry is `two-used`
- [x] Contract: with a used legacy `daemon.db` and a used target `daemon.db`, the plan for `daemon` is `block` with the reason `two-used`, and the outcome is `blocked` with `fix` equal to the text of `blockedText`
- [x] Contract: after that run, the file names and the bytes of the two folders, with each `config.json`, are equal to the state before
- [x] Contract: `assertNotBlocked(paths, "daemon")` then throws a `DgCliError` with that text and the exit code 78
- [x] Contract: a used target with a legacy folder that holds no `key`, no `credentials.db` and no used `daemon.db` gives `keepUsed`, as on master
- [x] Contract: after the owner renames the legacy folder, the next run plans `absent` for `daemon`; after the owner renames the target, the next run plans `move`
- [x] Contract: after a set-aside, the live `<state>/daemon/config.json` is the legacy file, byte for byte; no key of the old target file is in it
- [x] Contract: a legacy folder that holds only `logs` or a `daemon.db` with no row, and a target that holds only `config.json`, gives `keepUsed`, as on master
- [x] Contract: with two used folders and a live legacy daemon, the `daemon.stop` hook gets no call, and `<legacy>/daemon/logs` is in place
- [x] Contract: `folderUnused` gives `false` for a folder that holds only a `config.json`, as on master
- [x] Contract: a target that holds a `key`, a `daemon.db` that a daemon wrote, and a `config.json` is used
- [x] Contract: with no `key` file (keychain mode), a target that holds a `credentials.db`, or a `daemon.db` that a daemon opened one time (one `crypto_meta` row), is used
- [x] Contract: `dg-skills doctor` and `dg-skills clean` print the `two-used` text for a home with two used folders; the doctor fix is not `dg-skills install`, and it holds the exact text `Move the folder that you do not want to a different name, then run the command again`
- [x] Contract: with two used folders, `dg-daemon service rm` runs the layout step and exits 78 through `readConfigStrict`; `dg-daemon service status` reads no config and exits 1 with `no live dg-daemon` [DECIDED — orchestrator, slice 3 deferral]
- [x] Contract: `readConfigStrict` and `writeServiceEntry` call `assertNotBlocked(paths, "daemon")` first, as on master
- [x] Contract: after a set-aside of a target that holds a file, the output holds the line `dg: set aside <dest> as <aside>; dg copied no file from it, and dg-skills clean keeps it`
- [x] Happy path (compiled): a home with the stale layout, then one start of `dg-skills`, gives a `<state>/daemon` that holds the legacy `daemon.db`, `key` and `credentials.db`
- [x] Edge: a second start after the move plans `absent` for `daemon` and moves nothing
- [x] Edge: a live legacy daemon with no `daemon.stop` hook blocks the entry with the reason `live-writer`
- [x] Happy path (pkg/dg-daemon/__tests__/main-blocked.spec.ts): with two used folders, `dg-daemon serve` exits 78 with the text on stderr and writes no pid file; the text that `start` and `restart` print is a Contract of slice 4
- [x] Edge: with two used folders, `dg-daemon status` runs as on master; it skips the layout step
- [x] Edge: with two used folders and a live daemon in the legacy folder, the reason is `two-used`, and no stop hook runs
- [x] Edge: a pending record for `daemon` with two used folders gives the plan of master for a pending record; the `two-used` check runs after it
- [x] Edge: with a `two-used` block, the keychain step moves no secret
- [x] Edge: a legacy `daemon` path that is a file or a link gives the plan of master for that input and does not throw
- [x] Regression: `bun test` passes in pkg/common; the layout specs of pkg/skills-cli and pkg/dg-daemon pass; in pkg/common/__tests__/layout.spec.ts, the tests `keeps a used target and the source, and logs one line naming both paths` and `returns for a target-used kept entry because its target exists` now expect `blocked` with `two-used` (their fixtures write bytes that are not SQLite to `daemon.db`, and `sqliteUnused` gives `false` for such a file); each other spec whose result changes is in the list of the PR body
- [x] Contract: one case for each input of `daemonFolderUnused`: a missing path, a file, a link, an empty folder, a folder with only `config.json`, a folder with `key`, with `key.dpapi`, with `credentials.db`, with a used `daemon.db`, and a folder that cannot be read
- [x] Contract: with two used folders, `assertNotBlocked(paths, "assets")` throws the `two-used` text with the exit code 78
- [x] Contract: the set-aside folder of a target that holds a file matches `\.empty-\d+$`, and `dg-skills clean` keeps it
- [x] Edge: in keychain mode, after a `two-used` block and a rename of `<state>/daemon`, the next run plans `move`; state the result of the keychain step for that run (the code of today gives `keep("differs")`, and the daemon reads the old account), and test the remedy in the two key modes

#### Acceptance Criteria
- [x] Given a legacy daemon folder with session and credential data and a `<state>/daemon` folder in which no daemon started, when a dg program starts, then the daemon reads the legacy data from `<state>/daemon`
- [x] Given the same start, when the owner reads the output, then one line names the set-aside folder that holds the old `<state>/daemon` content
- [x] Given two daemon folders that both hold data, when a dg program starts, then nothing moves, one line names the two folders, and `dg-daemon serve` does not start
- [x] Given the same home, when the owner moves one folder to a different name and starts again, then the daemon uses the folder that stays
- [x] Given a stale `config.json` with a `services` table, when the layout step runs, then no entry of it is in the live `config.json`
- [x] Given a home in which a daemon started in the stale `<state>/daemon` folder, when a dg program starts, then the `two-used` text names the two folders, and after the owner renames `<state>/daemon` the next start moves the legacy folder in
- [x] Given a set-aside of a target that held a `services` table, when the layout step ends, then the set-aside folder is the only place that holds that table, and the output line names the folder

### Slice 4 — daemon-autostart

#### Engineering
- [x] Move pkg/dg-agent/src/phone/autostart.ts to pkg/common/src/node/autostart.ts and export it from pkg/common/src/node/index.ts with `export *`
- [x] That `export *` adds `RunResult`, `AutostartDeps`, `AutostartKind`, `AutostartState`, `AutostartOutcome` and `AutostartSpec` to `@dg/common/node`; no such name is in use there today
- [x] Add `name: "dg-phone" | "dg-daemon"` to `AutostartSpec`
- [x] Each exported function that has no spec today (`systemdUnitPath`, `launchdPlistPath`, `windowsTaskXmlPath`, `managedRestartCommands`, `removeAutostart`) gets the same name as a parameter
- [x] Derive from the name: the systemd unit `<name>.service`, the launchd label `com.detailedghost.<name>`, the task name `<name>`, and the task XML file `<name>.task.xml`
- [x] For `dg-phone`, each path, each unit text and each manager command is byte-identical to the result on master: `Description=dg phone listener`, the task XML in `paths.phoneRoot`, and `--dg-home <path>` after `listen`
- [x] For `dg-daemon`: `Description=dg daemon`, the task XML in `paths.daemonDir`, and the argv `launcherCommand(paths.dataDir, "dg-daemon", ["serve"])`
- [x] The `logPath` of the `dg-daemon` spec is `<paths.logDir>/dg-daemon-autostart.log`; launchd writes stdout and stderr there, and systemd writes to the journal
- [x] Add the optional field `restartPreventExitStatus?: number[]` to `AutostartSpec`; for `dg-daemon` it is `[EXIT_WSL_NAT_NETWORKING, EXIT_LAYOUT_BLOCKED]` (slice 3 adds the second constant), and the systemd unit gets the line `RestartPreventExitStatus=3 78` after `RestartSec=5`
- [x] The `dg-phone` unit gets no `RestartPreventExitStatus` line
- [x] For `dg-daemon`, pass a set `DG_HOME` in the systemd `Environment=` line and in the launchd `EnvironmentVariables` dictionary, as the phone unit does; on Linux the unit also gets one `Environment=` line for each of `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` that the caller has set; the `dg-phone` unit text stays byte-identical
- [x] autostart.ts holds these four `XDG_*_HOME` names itself: `ENV_KEYS` of dg-paths.ts is not exported, and this slice does not edit dg-paths.ts, because slice 2 changes that file at the same time; `autostartManages` compares the four recorded values with the values of the caller
- [x] On win32 with `DG_HOME` set, `autostart install` fails: a scheduled task has no environment block and `dg-daemon serve` has no `--dg-home` option
- [x] pkg/dg-agent/src/phone/commands.ts and store.ts import from `@dg/common/node` and pass `dg-phone`; delete pkg/dg-agent/src/phone/autostart.ts
- [x] Move pkg/dg-agent/__tests__/phone/autostart.spec.ts to pkg/common/__tests__/node-autostart.spec.ts; change the import path and add the name argument only
- [x] Before the move, add to that spec the full master output of `systemdUnitText`, `launchdPlistText`, `windowsTaskXml` and `managedRestartCommands` for fixed specs, as literal strings; the moved code must give those strings for `dg-phone`
- [x] Create pkg/dg-daemon/src/commands/autostart.ts with the actions `install`, `remove` and `status`; each action takes `AutostartDeps` as a seam
- [x] `autostart install` first checks that the two files of `launcherCommand(paths.dataDir, "dg-daemon", ["serve"])` exist: `argv[0]` and the `dg.js` path
- [x] `autostart install` with a live daemon that the service manager did not start prints `a daemon is already running outside the service manager; run dg-daemon restart to hand it over` after the `installed` line
- [x] `autostart remove` with a live daemon prints `hint: run dg-daemon stop first; the service manager has a shorter stop limit` before it removes the unit
- [x] Register `dg-daemon autostart install|remove|status` in pkg/dg-daemon/src/main.ts with lazy imports, as `start` does
- [x] `autostart install` on Linux and in WSL: after `enable --now`, run `loginctl enable-linger` (ADR 0020)
- [x] `autostart install` in WSL (`WSL_DISTRO_NAME` is set): after the linger command, register a Windows login task that runs `wsl.exe -d <distro> --exec true` (ADR 0020)
- [x] The WSL task has the name `dg-daemon-wsl-<distro>`, so it is not the native task `dg-daemon`
- [x] Build the XML of the WSL task with the existing `windowsTaskXmlBytes` and the argv `["wsl.exe", "-d", <distro>, "--exec", "true"]`; this argv gets no `--dg-home`
- [x] Write the XML to `<paths.daemonDir>/dg-daemon-wsl.task.xml`, get its Windows path with `wslpath -w`, and run `schtasks.exe /Create /TN <name> /XML <windows path> /F`
- [x] In WSL the argv[0] of the task commands is `schtasks.exe`; on win32 it is `schtasks`
- [x] When `loginctl enable-linger` or the task create fails, remove the unit as `removeAutostart` does and exit 1 with `autostart install: <command> failed: <first line of its stderr>`
- [x] `autostart remove` in WSL also runs `schtasks.exe /Delete /TN dg-daemon-wsl-<distro> /F` and removes the XML file of the task; `autostart remove` does not change the linger setting
- [x] Export `autostartInstalled(deps, paths, name): AutostartKind | undefined` from pkg/common/src/node/autostart.ts; it runs no manager command and reports from the unit file
- [x] Export `autostartManages(deps, paths, name): AutostartKind | undefined`: it gives the kind only when the unit file exists and the `DG_HOME` that the unit records is equal to the `DG_HOME` of the caller (two unset values are equal; a task unit records none); it parses the unit text (the systemd escapes `\\`, `\"`, `%%` and `$$`; the XML escapes of launchd) and compares the two values after the exported `normalizeDgHome` of dg-paths.ts made each one absolute (`dgHome()` is private), not as raw strings
- [x] Export `defaultAutostartDeps(): AutostartDeps` from pkg/common/src/node/autostart.ts (the real `run`, `writeFile`, `removeFile`, `fileExists`, `homeDir`, `env`, `platform` and `uid`); dg-agent phone/commands.ts, the dg-daemon `autostart` command, `cmdStart`, `cmdRestart` and `job enable` (slice 9) use it as the default of their seam
- [x] `autostart status` calls `autostartInstalled`; `cmdStart`, `cmdRestart` and the login unit question of `job enable` (slice 9) call `autostartManages`
- [x] No spec calls an `autostart` action, `cmdStart` or `cmdRestart` with the default deps: the unit path comes from `os.homedir()`, which the fence does not change; each spec gives a `homeDir` below `os.tmpdir()`
- [x] The subprocess specs of start.spec.ts and stop.spec.ts get the fenced `HOME` and no `XDG_CONFIG_HOME` from `subprocessEnv` (slice 1), so they find no unit of the machine
- [x] Run `bun test pkg/launcher/__tests__/size-budget.spec.ts` one time after the move; it builds each package, so a build failure in a file of slice 2 is a retry, not a finding
- [x] Do not edit pkg/dg-daemon/src/commands/service.ts or pkg/common/src/node/dg-paths.ts
- [x] `cmdStart` and `cmdRestart` call `assertNotBlocked(paths, "daemon")` before a manager command and before a spawn
- [x] In `cmdStart` of pkg/dg-daemon/src/commands/start.ts: when no daemon is live and `autostartManages(deps, paths, "dg-daemon")` gives a kind, run each command of `managedRestartCommands(kind, uid, "dg-daemon")` in order, and spawn no daemon
- [x] Run the manager commands as the phone listener does (pkg/dg-agent/src/phone/commands.ts): the exit code of one command does not stop the next; `schtasks /End` of a stopped task fails with no harm
- [x] After the manager commands, wait for a live daemon with `waitForFreshDaemon` of pkg/common/src/node/daemon-start.ts (100 ms poll, 15000 ms limit); give that function the `export` keyword (index.ts already exports the module), and write no second poll loop
- [x] The WSL NAT check of `ensureDaemonRunning` (`checkWslNetworking`) also runs before a manager command
- [x] With a live daemon, `cmdStart` prints the `already running` line of master and runs no manager command
- [x] In `cmdRestart` of pkg/dg-daemon/src/commands/stop.ts: with a login unit that `autostartManages` reports, stop the daemon in the way of master (SIGTERM and the wait, or `--force`), then run the manager commands and wait; do not call the detached spawn
- [x] On POSIX, for a regular stop, the CLI stops the daemon itself and sends no manager stop command: the stop limit of a service manager is shorter than the 255 s wait of `dg-daemon stop`
- [x] With no login unit, `start` and `restart` behave as on master
- [x] On POSIX a regular `cmdStop` does not change and runs no manager command; it makes the daemon exit with 0, so a unit with `Restart=on-failure` does not start it again
- [x] On win32 each stop is a kill (`taskkill /F`), so with a login unit a regular `cmdStop` also runs `schtasks /End /TN dg-daemon` before the kill: an ended task is not a failure, so Task Scheduler queues no restart
- [x] An idle exit of the daemon is also exit code 0, so the unit does not start the daemon again; the next `dg-daemon start` uses the service manager, and `dg-agent start` spawns a detached daemon that the unit does not own
- [x] `cmdStop --force` with a login unit: a kill is a failure for the service manager (`Restart=on-failure`, launchd `KeepAlive`), so the CLI tells the manager not to start the daemon again: after the kill for systemd and launchd, and with `schtasks /End /TN dg-daemon` before the `taskkill` on the task kind; the unit stays installed and starts the daemon at the next login
- [x] launchd, `cmdStop --force` with a login unit: after the kill, run `launchctl bootout gui/<uid>/com.detailedghost.dg-daemon`
- [x] launchd, the managed start of `dg-daemon`: run `launchctl bootstrap gui/<uid> <plist path>` (a failure is ignored: the service is loaded), then `launchctl kickstart -k gui/<uid>/com.detailedghost.dg-daemon`; the command list of `dg-phone` does not change
- [x] After that forced stop, `dg-daemon start` starts the daemon through the service manager
- [x] `dg-agent start` does not change: it calls `ensureDaemonRunning` with no manager step
- [x] `cmdStart` and `cmdRestart` take `AutostartDeps` as a seam, and no spec runs a real manager command; the signature is `cmdStart(options, seams?: DaemonStartSeams)`, and `DaemonStartSeams` and `StopSeams` get `autostart?: AutostartDeps` and `timeoutMs?: number`; `waitForFreshDaemon` keeps its signature; the new type is not the `StartSeams` of `dg-agent start`
- [x] With a login unit, the daemon that the manager starts has the environment of the unit, not of the caller; the rule of spec 014 (the environment of the caller of `restart`) stays for the case with no login unit
- [x] The unit records `DG_HOME` and each set `XDG_*_HOME` of the caller; it records no `PATH`, and slice 7 documents that a service gets more `PATH` from its `envFile`
- [x] Export the install action from pkg/dg-daemon/src/commands/autostart.ts as `installDaemonAutostart(deps, paths): Promise<{ kind: AutostartKind }>`: it prints nothing and throws `DgCliError` with the exit code 1; the `autostart install` command and `job enable` (slice 9, after its login unit question) print the `installed` line and the `hand it over` line
- [x] The command tree of dg-daemon is a generated file: after the command change, run `bun scripts/completion-trees.ts dg-daemon` and commit pkg/dg-daemon/src/completion-tree.json; do not edit the JSON by hand
- [x] `defaultAutostartDeps().run` is `runArgv`: move `runArgv` from pkg/dg-agent/src/phone/migrate.ts to pkg/common/src/node/process.ts with no change of behavior (a spawn failure gives `{ code: 1, stdout: "", stderr }`), and migrate.ts imports it
- [x] The real `writeFile`, `removeFile` and `fileExists` of `defaultAutostartDeps()` come from `defaultOpenCloseDeps` of pkg/dg-agent/src/phone/commands.ts; no second copy stays in dg-agent
- [x] systemd, `cmdStop --force` with a login unit: run `systemctl --user stop dg-daemon.service` after the kill signal and before `waitUntilGone`, because `FORCE_WAIT_MS` is 5000 ms and `RestartSec` is 5
- [x] Add the path `autostart status` to the `SKIP` set of pkg/dg-daemon/src/main.ts, so a read-only command moves no folder
- [x] `autostart install` calls `assertNotBlocked(paths, "daemon")` before it writes a unit
- [x] pkg/dg-agent/__tests__/phone/listener-stale.spec.ts imports `systemdUnitPath` from `@dg/common/node` and passes `"dg-phone"`
- [x] Refuse a `WSL_DISTRO_NAME` that is empty, starts with `-` or holds a character outside `[A-Za-z0-9._-]`, with `autostart install: WSL_DISTRO_NAME "<value>" is not valid`
- [x] The command maps the two failure forms of `installAutostart` (`{ ok: false, reason }` and a thrown `DgCliError`) to the exit code 1 with the prefix `autostart install:`

#### Testing Criteria
##### Contracts
- [x] Contract: `systemdUnitPath(home, env, "dg-phone")`, `launchdPlistPath(home, "dg-phone")`, `windowsTaskXmlPath(paths, "dg-phone")`, `systemdUnitText`, `launchdPlistText`, `windowsTaskXml` and `managedRestartCommands` give the same strings as on master, and the spec holds those strings as literals
- [x] Contract: for `dg-daemon`, the systemd unit path ends with `systemd/user/dg-daemon.service`, and `ExecStart=` holds the quoted argv `<dataDir>/runtime/current/bun`, `<dataDir>/lib/current/dg.js`, `dg-daemon`, `serve`
- [x] Contract: `removeAutostart(deps, paths, "dg-daemon")` does not read, stop or remove the `dg-phone` unit, and the reverse
- [x] Contract: `autostart install` exit 0 prints `autostart installed (<systemd|launchd|task>): dg-daemon starts at login`
- [x] Contract: when the service manager is not available, `autostart install` exits 1 with `autostart install: <reason>` and leaves no unit file
- [x] Contract: `autostart remove` exit 0 prints `autostart removed`, or `autostart: not installed` when no unit file exists
- [x] Contract: `autostart status` exit 0 prints `autostart: installed (<kind>)` or `autostart: not installed`; `--json` prints `{"installed":<boolean>,"kind":"<kind>"|null}`
- [x] Contract: win32 with `DG_HOME` set exits 1 with `autostart install: a scheduled task cannot pass DG_HOME; unset DG_HOME, then run the command again`
- [x] Contract: the output, the exit codes and the stored `autostart` state of `dg-agent phone open` and `phone close` do not change
- [x] Contract: with a login unit (recording deps, systemd) and no live daemon, `cmdStart` runs `systemctl --user restart dg-daemon.service` one time and calls no spawn; stdout is the `started` line of master, and `--json` gives `"started":true`
- [x] Contract: with a login unit and a live daemon, `cmdStart` runs no manager command and prints the `already running` line
- [x] Contract: `cmdRestart` with a login unit records this order: SIGTERM to the daemon pid, the wait until the pid is gone, the manager command; stdout holds the two lines of master
- [x] Contract: `cmdRestart --force` with a login unit does the force stop of master, then the manager command
- [x] Contract: `cmdStop --force` with a login unit (recording deps, systemd) records this order: the kill signal as on master, then `systemctl --user stop dg-daemon.service`, then the wait; the unit file stays
- [x] Contract: after `cmdStop --force` with a login unit, the service manager does not start the daemon before the next login or the next `dg-daemon start`; this holds for systemd and launchd with recording deps; the task kind is in the manual acceptance Check of this slice, because no spec proves it
- [x] Contract: on POSIX a regular `cmdStop` with a login unit runs no manager command
- [x] Contract: on win32 a regular `cmdStop` with a login unit runs `schtasks /End /TN dg-daemon` one time, then the kill, in that order (recording deps)
- [x] Contract: the managed start of `dg-daemon` on launchd runs `launchctl bootstrap gui/<uid> <plist path>`, then `launchctl kickstart -k gui/<uid>/com.detailedghost.dg-daemon`; the task kind runs `schtasks /End /TN dg-daemon`, then `schtasks /Run /TN dg-daemon`
- [x] Contract: when no daemon is live at the startup limit after the manager commands (15000 ms; the spec gives a short `timeoutMs` seam), the command exits 1 with `dg-daemon did not become healthy within the startup timeout`; when a manager command had an exit code other than 0, the text ends with ` (<command line> failed: <first line of its stderr>)`
- [x] Contract: with `WSL_DISTRO_NAME` set and `DG_WSL_NETWORKING_MODE=nat`, `cmdStart` with a login unit exits 3 and runs no manager command
- [x] Contract: with no login unit, `cmdStart` and `cmdRestart` run no manager command; pkg/dg-daemon/__tests__/commands/start.spec.ts and stop.spec.ts pass with no change to an existing assertion
- [x] Contract: the output, the exit codes and `StartSeams` of `dg-agent start` do not change
- [x] Contract: the `dg-daemon` systemd unit holds `RestartPreventExitStatus=3 78`; the `dg-phone` unit text is equal to master
- [x] Contract: when `argv[0]` or the `dg.js` path of the unit is absent, `autostart install` exits 1 with `autostart install: <path> is missing; install dg first` and writes no unit file
- [x] Contract: with a unit that records `DG_HOME=/a` and a caller with `DG_HOME=/b`, `cmdStart` runs no manager command and spawns the daemon as on master
- [x] Contract: with a unit that records the `DG_HOME` of the caller, `cmdStart` runs the manager command
- [x] Contract: `cmdStop --force` with a login unit (recording deps, launchd) kills the daemon as on master, then runs `launchctl bootout gui/<uid>/com.detailedghost.dg-daemon`; the plist file stays
- [x] Contract: for the launchd and the task kinds (recording deps), `cmdStart` after `cmdStop --force` runs the managed start commands and no spawn
- [x] Contract: when `loginctl enable-linger` has an exit code other than 0, `autostart install` exits 1 with `autostart install: loginctl enable-linger failed: <first line of its stderr>` and leaves no unit file
- [x] Contract: the `dg-daemon` plist holds `<paths.logDir>/dg-daemon-autostart.log` two times
- [x] Contract: with a blocked `daemon` entry, `start` prints the block text, exits with the code of the block error, and runs no manager command and no spawn; it does not wait for the startup timeout
- [x] Contract: `autostart install` with a live detached daemon prints the `hand it over` line; `autostart remove` with a live daemon prints the `stop first` hint
- [x] Contract: a `spawnServe` daemon that gets SIGTERM exits with code 0
- [x] Contract: `autostart install` on a platform that is not linux, darwin or win32 exits 1 with `autostart install: unsupported platform "<platform>"`
- [x] Contract: in WSL, `autostart status` also prints `wsl task: installed` or `wsl task: not installed`, and `--json` holds `"wslTask": <boolean>`; it reads the XML file of the task and runs no command
- [x] Contract: `start --json` on the manager path holds the keys `started`, `pid`, `port` and `version`, as on master
- [x] Contract: `cmdRestart` with a login unit and no live daemon sends no signal and runs the managed start commands one time
- [x] Happy path (recording deps, linux): `install` writes the unit with mode 0600, then runs `systemctl --user daemon-reload`, `systemctl --user enable --now dg-daemon.service` and `loginctl enable-linger`, in that order
- [x] Happy path (recording deps, WSL): `install` also runs one `schtasks.exe /Create` call for the task `dg-daemon-wsl-<distro>`, whose XML action is `wsl.exe -d <distro> --exec true`
- [x] Happy path (recording deps, darwin): `install` writes `com.detailedghost.dg-daemon.plist` and runs `launchctl bootstrap gui/<uid> <path>`
- [x] Edge: `install` two times gives one unit file and exit 0 both times
- [x] Edge: `dg-daemon serve` in a home with a live daemon exits 0 (the `deferred` result of `cmdServe`), so a unit with `Restart=on-failure` does not start it again; the spec uses two `spawnServe` calls in one `freshDgHome()` folder
- [x] Edge: `status` with a `dg-phone` unit and no `dg-daemon` unit prints `autostart: not installed`
- [x] Error: a failed `systemctl --user daemon-reload` removes the unit file and exits 1 with the first line of its stderr
- [x] Check (manual acceptance, one time for each kind: systemd, launchd, task): `stop --force` leaves the daemon stopped, and `start` starts it through the manager; no spec runs a real manager
- [x] Check: the systemd order of a forced stop has a short race with the `RestartSec` timer; `stop` cancels the timer, and the recording deps test fixes the order: the kill signal, the manager stop, the wait
- [x] Check (manual acceptance on a WSL host): after `autostart install`, a Windows sign-out and sign-in starts the daemon; the WSL values of this slice come from reuse of the existing task writer and are not verified on a WSL host
- [x] Regression: pkg/dg-agent/__tests__/phone passes with no change to an assertion; pkg/common/__tests__/node-autostart.spec.ts holds each case of the moved spec
- [x] Regression: `bun test` passes in pkg/common, pkg/dg-agent and pkg/dg-daemon; `bun run lint` passes in the three packages; pkg/launcher/__tests__/size-budget.spec.ts passes
- [x] Contract: pkg/dg-daemon/__tests__/completion-tree.spec.ts passes, and pkg/dg-daemon/src/completion-tree.json holds the `autostart` group with `install`, `remove` and `status`
- [x] Contract: a caller with `XDG_DATA_HOME=/x` gets a unit with `Environment=XDG_DATA_HOME=/x`; with a unit that records a different value, `cmdStart` runs no manager command
- [x] Contract: a `DG_HOME` that holds `%`, `"` and `&` gives a unit for which `autostartManages` reports the kind for the same caller
- [x] Contract: with a blocked `daemon` entry, `autostart install` prints the block text, exits with the code of the block error and writes no unit file
- [x] Contract: a `WSL_DISTRO_NAME` that is empty, starts with `-` or holds a character outside `[A-Za-z0-9._-]` makes `autostart install` fail with `autostart install: WSL_DISTRO_NAME "<value>" is not valid`
- [x] Contract: when `wslpath -w` fails or `schtasks.exe` is absent, `autostart install` removes the unit and exits 1 with `autostart install: <command> failed: <first line of its stderr>`; each failure of the WSL step is fatal, also on a distribution with no interop
- [x] Contract: `autostart remove` in WSL removes the unit and the XML file and exits 0 also when `schtasks.exe /Delete` fails
- [x] Contract: a failed `systemctl --user enable --now dg-daemon.service` exits 1 with `autostart install: systemctl --user enable --now dg-daemon.service failed: <first line of its stderr>` and leaves no unit file

#### Acceptance Criteria
- [x] Given Linux with a systemd user session, when the owner runs `dg-daemon autostart install`, then `~/.config/systemd/user/dg-daemon.service` exists, is enabled, and starts `dg-daemon serve` through the stable `current` links
- [x] Given Linux or WSL, when the owner runs `dg-daemon autostart install`, then linger is on; in WSL a Windows login task also starts the distribution
- [x] Given an installed unit, when the owner runs `dg-daemon autostart remove`, then the unit is disabled and its file is gone
- [x] Given a machine with the phone listener unit, when `dg-daemon autostart install` and `remove` run, then the `dg-phone` unit does not change
- [x] Given pkg/dg-agent/src, when a search for `systemctl`, `launchctl` or `schtasks` runs, then it finds nothing
- [x] Given `dg-agent phone open`, when it installs its login unit, then the unit file is byte-identical to the file that master writes
- [x] Given an installed login unit and no live daemon, when the owner runs `dg-daemon start`, then the service manager starts the daemon and no detached daemon exists
- [x] Given an installed login unit, when the owner runs `dg-daemon restart`, then the old daemon stops with its normal wait and the service manager starts the new one
- [x] Given no login unit, when the owner runs `dg-daemon start` or `dg-daemon restart`, then the result is the same as before this change
- [x] Given an installed login unit, when the owner runs `dg-daemon stop --force`, then the daemon is gone and stays gone until the next login or the next `dg-daemon start`

### Slice 5 — dg-program

#### Engineering
- [x] In pkg/common/src/node/program.ts, make `ProgramName` the union of the members of `PROGRAM_NAMES` and `"dg"`, and add `dg: "dg"` to `SOURCE_PACKAGES`
- [x] Create the package pkg/dg (`@dg/dg`, private, `"version": "1.0.0"`, `exports: { "./main": "./src/main.ts" }`) with package.json, tsconfig.json, bunfig.toml (the fence preload), src/index.ts and src/main.ts
- [x] package.json of pkg/dg also has `scripts` (`lint`: `tsc --noEmit`, `test`: `bun test`), the workspace dependencies `@dg/common`, `@dg/dg-daemon`, `@dg/skills-cli` and `@dg/dg-agent` (`workspace:*`), and `bun-types` `^1.4.4` and `typescript` `^7.0.2`, as in pkg/launcher
- [x] Copy tsconfig.json of pkg/dg from pkg/launcher; the copy drops `build.ts` from `include`
- [x] pkg/dg/bunfig.toml holds `[test] preload = ["../skills-cli/__tests__/test-home-fence.ts"]`
- [x] The specs of pkg/dg are pkg/dg/__tests__/routing.spec.ts (fake mounts; it asserts the argv that each mount gets) and pkg/dg/__tests__/usage.spec.ts
- [x] pkg/dg/src/index.ts has the form of pkg/dg-daemon/src/index.ts and calls `normalizeDgHome` only (the bundle gets it from `dispatch`); pkg/dg/src/main.ts exports `main(argv: readonly string[], mounts: Mounts): Promise<number>`
- [x] `mounts` gives one loader for each of `dg-daemon`, `dg-skills` and `dg-agent`; pkg/dg/src/main.ts imports no program, not statically and not dynamically
- [x] Write the size-budget assertions first and see them fail; then write the code
- [x] Create pkg/launcher/src/programs/dg.ts: it exports `main(argv)` and gives the loaders `() => import("./daemon")`, `() => import("./skills")` and `() => import("./agent")`, so the bundle uses the three entry chunks that exist
- [x] pkg/dg/src/index.ts gives loaders that import `@dg/dg-daemon/main`, `@dg/skills-cli/main` and `@dg/dg-agent/main` for a checkout
- [x] Add `dg` to `PROGRAMS` in pkg/launcher/src/dg.ts, and add `@dg/dg` to the devDependencies of pkg/launcher/package.json
- [x] Run `bun install` at the repository root, which writes bun.lock; do not edit bun.lock by hand; after it, the diff of bun.lock holds only the workspace entry `@dg/dg` and the devDependency of the launcher; revert a wider diff
- [x] Routing in pkg/dg/src/main.ts: `job` and `autostart` call the dg-daemon `main` with the group name and the remaining arguments
- [x] Routing: `daemon` calls the dg-daemon `main`, `skills` calls the dg-skills `main`, and `agent` calls the dg-agent `main`, each with the remaining arguments
- [x] Routing: `install` and `extension` call the dg-skills `main` with `install`, `upgrade` calls it with `update`, and `doctor` calls it with `doctor`, each plus the remaining arguments
- [x] Load each mounted `main` with its loader of `mounts`, in the branch that uses it
- [x] Add `mountProgram(name: Exclude<ProgramName, "dg">): void` to pkg/common/src/node/program.ts: in a bundle (a name is recorded) it records `name`; in a checkout it stores `name` as the mounted program and does not turn on the bundle branch of `programCommand`; `setProgramName(undefined)` also clears the mounted program
- [x] `selfCommand` in pkg/common/src/node/self-command.ts returns `programCommand(<mounted>, args)` when a mounted program is set
- [x] pkg/dg calls `mountProgram` before the mounted `main` runs, so that `selfCommand` and `programCommand` build the argv of that program and not of `dg`
- [x] pkg/dg/src/main.ts has no static import of a value, as pkg/dg-daemon/src/main.ts: it loads `@dg/common/node/program` with a dynamic import, as pkg/launcher/src/dg.ts does; a static import puts program.ts in a shared chunk that the `dg` entry chunk then imports statically
- [x] `dg`, `dg --help` and `dg help` print one usage text that lists each name of the routing table with its target, and exit 0
- [x] Export `ROUTES` from pkg/dg/src/main.ts: a readonly record, declared with `as const`, keyed by the nine names in the order of the usage text; each value is `{ program: Exclude<ProgramName, "dg">, command: readonly string[], description: string }`; the usage text and the routing read it, and slice 7 imports it; the name lookup with `Object.hasOwn` stays
- [x] The usage line of `extension` is `extension   stage the browser extension (runs dg-skills install)`; `dg extension` and `dg install` are the same command and take the same options
- [x] `dg --version` in a checkout prints `process.env.DG_BUILD_VERSION ?? "dev"`; `dg -h` is `dg --help`
- [x] `dg help <name>` is `dg <name> --help`
- [x] The name lookup uses `Object.hasOwn`
- [x] Add no `dg start`, `dg stop` or `dg status`; the table has nine names: `job`, `autostart`, `daemon`, `skills`, `agent`, `extension`, `install`, `upgrade` and `doctor`
- [x] A mounted program keeps its own usage lines, error prefix and exit codes; `dg` changes no command tree
- [x] `dg` resolves no DG path and runs no layout step: `resolveDgPaths` and `ensureLayout` stay in the mounted program
- [x] The old names `dg-skills`, `dg-agent` and `dg-daemon` keep each behavior
- [x] Update the program lists of pkg/launcher/__tests__/dispatch.spec.ts and startup-budget.spec.ts, and the entry-chunk test of size-budget.spec.ts (four entries), in the same change as program.ts: `Record<ProgramName, …>` does not compile in between
- [x] size-budget.spec.ts: the entry filter keeps `/\/(skills|agent|daemon)-/` and adds `/\/dg-[a-z0-9]{8}\.js$/i` for the `dg` entry, so a chunk such as `dg-paths-<hash>` does not match; check the filter against a real build before the test is fixed, and assert that exactly one chunk matches it; the count becomes 4
- [x] dispatch.spec.ts and startup-budget.spec.ts: add `dg` to the program lists and rename the tests that say three programs
- [x] Assert the text `expected dg-skills, dg-agent, dg-daemon, dg` as one string: `dg` is a part of each other name
- [x] Do not edit pkg/dg-daemon/src/main.ts, pkg/skills-cli/src/main.ts or pkg/dg-agent/src/main.ts
- [x] Do not edit pkg/skills-cli/src/install/shims.ts (slice 6) or pkg/skills-cli/__tests__/layout-fixtures.ts
- [x] pkg/dg stays at version `1.0.0` and is not in scripts/release-version.ts, as pkg/launcher; `dg --version` gives the stamp of the launcher
- [x] The `lint` of pkg/dg reads the dg-daemon source: run `bun run lint` in pkg/dg on a clean checkout; add no `prelint` unless that run fails, and in that case name the file that needs the pages build
- [x] pkg/dg has no workflow path until slice 6; slices 5 and 6 ship in one PR
- [x] Add no stryker entry and no mise task for pkg/dg
- [x] Slice 4 is before this slice, so `dg autostart` has its target; `dg job` routes to the `job` group that exists on master
- [x] Slice 2 can run at the same time as this slice: a bundle build failure in a file of slice 2 is a retry, and a failure in each other file is a finding
- [x] `dg completion <shell>` prints `completionScript(shell, "dg")` of `@dg/common/completion` for `bash`, `zsh` and `fish`; load that module with a dynamic import
- [x] `dg __complete <words…>` prints the candidates: with one word, each name of `ROUTES`, `completion` and `help` that starts with that word, one for each line; build that answer from `ROUTES` with `completeWords` and `printCompletions` of `@dg/common/completion`, on a `CompletionNode` that is made at run time (no tree file), in which `completion` and `help` are nodes with a description; with two words or more, it calls the mounted `main` of the route of the first word with `__complete`, the target command of that route and the remaining words
- [x] The words map as the routing does: `dg __complete job add --na` gives the dg-daemon `main` the arguments `["__complete", "job", "add", "--na"]`; `dg __complete daemon st` gives it `["__complete", "st"]`; `dg __complete upgrade --x` gives the dg-skills `main` `["__complete", "update", "--x"]`
- [x] `dg __complete` with two words or more and a first word that is not a route prints nothing and exits 0
- [x] `completion` and `__complete` are not rows of `ROUTES`; the usage text lists `completion` on its own line; pkg/dg has no generated tree file, so no tree becomes stale when a mounted program changes
- [x] `PROGRAM_NAMES` keeps its three names in this slice: pkg/skills-cli/src/install/shims.ts and pkg/skills-cli/src/completion/files.ts read that list, so the launcher list and the completion files do not change before slice 6
- [x] Add no `service` route: `dg service` gives the unknown-command error, and `dg daemon service …` reaches the `service` group through the mount
- [x] One rule for other input: a first word that `ROUTES`, `completion`, `help`, `-h`, `--help` and `--version` do not name, and a second word of `dg help` that is not a route name, give `dg: unknown command "<word>"; run dg --help` and exit 1
- [x] `dg --version <more words>` prints the version; `dg completion` with no shell is the error of `dg completion nope`

#### Testing Criteria
##### Contracts
- [x] Contract: `ProgramName` is `"dg-skills" | "dg-agent" | "dg-daemon" | "dg"`; `programCommand("dg", ["x"])` in a checkout is `[process.execPath, <repo>/pkg/dg/src/index.ts, "x"]`
- [x] Contract: `dg.js dg --version` prints the same line as `dg.js dg-skills --version`
- [x] Contract: `dg.js nope` exits 64 and its error text holds `expected dg-skills, dg-agent, dg-daemon, dg`
- [x] Contract: for each row (`job`, `autostart`, `daemon`, `skills`, `agent`, `extension`, `install`, `upgrade`, `doctor`), `dg <name> --help` gives the same stdout and exit code as the `--help` of its target; the comparison runs the two commands with the same temp `DG_HOME` and `HOME` inside the fence, one time in a checkout and one time in the bundle
- [x] Contract: with no daemon, `dg job list` gives the same stdout, stderr and exit code as `dg-daemon job list`, and `dg daemon service status` gives the same stderr and exit code as `dg-daemon service status`; each comparison runs the two commands with the same temp `DG_HOME` and `HOME` inside the fence, one time in a checkout and one time in the bundle
- [x] Contract: `dg nope` exits 1 with `dg: unknown command "nope"; run dg --help` on stderr and empty stdout; the exit code 1 here and the exit code 64 of `dg.js nope` are different on purpose
- [x] Contract: `dg --help` exits 0 and its stdout holds each name of the routing table
- [x] Contract: in a bundle, `programName()` is `dg-skills` after `dg skills <args>` starts, and `dg-daemon` after `dg job <args>` starts; in a checkout it stays `undefined`
- [x] Contract: a command that calls `selfCommand` starts the same child argv below `dg skills` as below `dg-skills`, in the bundle and in a checkout
- [x] Contract (size): dg.js is 16 KB at most and has no static import; the bundle has four program entry chunks, and each imports no other chunk statically
- [x] Contract (startup): `dg --version` is in the budget of pkg/launcher/__tests__/startup-budget.spec.ts
- [x] Contract: `dg extension --help` gives the same stdout and exit code as `dg-skills install --help`; `dg extension firefox` gives the dg-skills `main` the arguments `["install", "firefox"]`
- [x] Contract: the routing table has nine names, and `dg --help` lists each one and does not list `service`
- [x] Contract (pkg/common/__tests__/program-command.spec.ts): in a checkout, after `mountProgram("dg-skills")`, `selfCommand(["x"])` is `[process.execPath, <repo>/pkg/skills-cli/src/index.ts, "x"]`; in a bundle it is `[process.execPath, Bun.main, "dg-skills", "x"]`
- [x] Contract: `dg toString`, `dg constructor`, `dg __proto__` and `dg Job` give the unknown-command error
- [x] Contract: `dg -h` gives the output of `dg --help`, and `dg help job` gives the output of `dg job --help`
- [x] Contract: `dg --version` in a checkout prints `dev` when `DG_BUILD_VERSION` is not set
- [x] Contract: `dg daemon --version`, `dg skills --version` and `dg agent --version` give the output of the mounted program
- [x] Contract: with `DG_PATH_FENCE` set and `DG_HOME` outside it, `dg --help` exits 0
- [x] Contract: `dg job` with no more arguments gives the output and the exit code of `dg-daemon job`; the comparison runs the two commands with the same temp `DG_HOME` and `HOME` inside the fence, one time in a checkout and one time in the bundle
- [x] Contract: `dg skills stash -- --x ""` gives the mounted `main` the arguments `["stash", "--", "--x", ""]`
- [x] Contract: the exit code of `dg` is the value that the mounted `main` returns; a 3 stays 3
- [x] Edge: `dg skills stash --help` reads neither the inbox chunk nor the playwright chunk
- [x] Edge: `dg daemon status` and `dg-daemon status` skip the layout step in the same way
- [x] Edge: a relative `DG_HOME` reaches a mounted program as an absolute path
- [x] Regression: `bun test` passes in pkg/common, pkg/dg and pkg/launcher; `bun run lint` passes in the three packages; pkg/skills-test/__tests__/home-fence-reach.spec.ts passes with the new package; pkg/common/__tests__/node-autostart.spec.ts passes: the unit argv `launcherCommand(<dataDir>, "dg-daemon", ["serve"])` does not change
- [x] Contract: `dg completion zsh` prints `completionScript("zsh", "dg")`; `dg completion nope` exits 1 and names `bash`, `zsh` and `fish`
- [x] Contract: `dg __complete ""` prints the nine names of `ROUTES`, `completion` and `help`, each line in the form `<name><TAB><description>`; `dg __complete jo` prints `job`
- [x] Contract: `dg __complete job ""` gives the same stdout as `dg-daemon __complete job ""`; `dg __complete upgrade ""` gives the same stdout as `dg-skills __complete update ""`; `dg __complete skills ""` gives the same stdout as `dg-skills __complete ""`
- [x] Contract: `dg __complete nope x` prints nothing and exits 0
- [x] Contract: `dg service` exits 1 with `dg: unknown command "service"; run dg --help` on stderr and empty stdout
- [x] Contract: `PROGRAM_NAMES` is `["dg-skills", "dg-agent", "dg-daemon"]`; pkg/skills-cli/__tests__/install-shims.spec.ts and pkg/skills-cli/__tests__/completion.spec.ts pass with no change
- [x] Contract: after `mountProgram("dg-skills")` and `setProgramName(undefined)`, `selfCommand(["x"])` in a checkout gives the source argv of before the mount
- [x] Contract: one case each for `dg help nope`, `dg help help`, `dg help completion`, `dg --nope`, `dg ""`, `dg --version extra` and `dg completion`
- [x] Contract: `dg __complete autostart ""` gives the same stdout as `dg-daemon __complete autostart ""`
- [x] Contract: `ROUTES.upgrade` is `{ program: "dg-skills", command: ["update"], … }`, `ROUTES.daemon.command` is `[]`, and an import of `ROUTES` from pkg/dg/src/main.ts loads no program module

#### Acceptance Criteria
- [x] Given the bundle, when the owner runs `dg job list`, then the result is the same as `dg-daemon job list`
- [x] Given the bundle, when the owner runs `dg skills doctor` or `dg doctor`, then the result is the same as `dg-skills doctor`
- [x] Given the bundle, when the owner runs `dg agent start`, then the result is the same as `dg-agent start`
- [x] Given `dg` with no argument, when it runs, then it prints the nine names `job`, `autostart`, `skills`, `agent`, `daemon`, `extension`, `install`, `upgrade` and `doctor`
- [x] Given a script that calls `dg-skills`, `dg-agent` or `dg-daemon`, when it runs after this change, then its result does not change
- [x] Given the bundle, when the owner runs `dg extension <target>`, then the command runs `dg-skills install <target>`
- [x] Given a shell that loaded the `dg` completion script, when the owner types `dg job ` and presses TAB, then the shell shows each name that `dg-daemon __complete job ""` prints

### Slice 6 — dg-launcher-install

#### Engineering
- [x] In pkg/skills-cli/src/install/shims.ts, `PROGRAMS` has four names (`dg` first, then the three names of `PROGRAM_NAMES`), and a new `LEGACY_PROGRAMS` is `PROGRAM_NAMES`
- [x] `writeShims` uses `PROGRAMS`; `syncCompatLaunchers` and `launcherFiles` of pkg/skills-cli/src/install/clean.ts use `LEGACY_PROGRAMS`
- [x] `dg-skills clean` does not touch the launcher folder `paths.binDir`; this slice does not change that
- [x] `syncCompatLaunchers` writes no `dg` launcher into the legacy `~/.dg/bin` folder and does not change a `dg` file there: no released skill calls `dg` there
- [x] Add `dg` to the program loop of pkg/skills-cli/bootstrap.sh and of pkg/skills-cli/bootstrap.ps1, after `dg-daemon`
- [x] Change the launcher list in each text to `the dg, dg-skills, dg-agent and dg-daemon launchers`: the `install` description in pkg/skills-cli/src/commands/install.ts, the sentence of pkg/skills-cli/src/install/skills-only.ts, the same sentence of bootstrap.sh, the header comments of the two bootstrap scripts, and the header comment of pkg/skills-cli/src/install/cli.ts
- [x] The skills-only sentence is in skills-only.ts, in bootstrap.sh and in two specs: skills-only.spec.ts and skills-only-install.spec.ts; retired-binaries.spec.ts and bootstrap-asset-selection.spec.ts hold the three names only in titles
- [x] Do not edit docs/install.md, README.md or docs/AGENT-INSTALL.md; slice 7 owns them
- [x] Add one doctor check `dg-launcher` next to `launcher-on-path` in pkg/skills-cli/src/doctor/shared.ts: when the `dg-skills` launcher exists in `binDir` and the `dg` launcher does not, it warns
- [x] The fix of that warning is `dg-skills install --cli-only` when `isCliOnly(ctx)` is true, and `dg-skills install` in each other case
- [x] The check takes the platform as a parameter, so the `dg.cmd` branch has a test on Linux
- [x] Before the workflow edit, run `dg.js dg --version` on the bundle of slice 5; it must print the version
- [x] In .github/workflows/release.yml, rename the step `Run --version for all three programs` to four programs, add `dg="$("$bun" lib/dg.js dg --version)"`, make the comparison loop `for out in "$dg" "$skills" "$agent" "$daemon"`, and add `$dg` to the echo line
- [x] binary-distribution.spec.ts checks the comparison loop, not only the command text
- [x] Change release.yml, skills-blt.yml, cli-smoke.spec.ts and binary-distribution.spec.ts in one commit
- [x] Slice 21 edits skills-blt.yml after this slice
- [x] In .github/workflows/skills-blt.yml, add `pkg/dg/**` to `paths:` and the steps `Lint (dg)` and `Test (dg)`
- [x] cli-smoke.spec.ts adds `dg` to its `runs dg.js <program> --version` tests
- [x] Check that scripts/blt-gate.ts, blt-gate.spec.ts and release-triggers.spec.ts pass with no job name change
- [x] Update each spec list of program names. Four names: install-shims.spec.ts, bootstrap-fixtures.ts (`PROGRAMS`), agent-only-install.spec.ts, skills-only-install.spec.ts, skills-only.spec.ts, install-version-pin.spec.ts, and in pkg/skills-test binary-distribution.spec.ts and cli-smoke.spec.ts. Three names from `LEGACY_PROGRAMS`: compat-launchers.spec.ts, the retired-binaries specs and the clean specs
- [x] compat-launchers.spec.ts keeps three names and reads `LEGACY_PROGRAMS`
- [x] The fixture bundle of bootstrap-fixtures.ts answers `dg --version`; no production code changes for that
- [x] `RETIRED_BINARIES` stays `["dg-server"]`
- [x] Do not edit scripts/skill-bootstrap-block.ts or a SKILL.md file
- [x] A dg launcher is a regular file whose first 4096 bytes hold no NUL byte and hold the text `lib/current/dg.js` (`lib\current\dg.js` on win32); read the file type with `lstat`; only a regular file is read (`isFile()` from `lstat` first), so a FIFO or a device is kept and not read
- [x] A copy of a `dg-skills`, `dg-agent` or `dg-daemon` launcher with the name `dg` counts as a dg launcher (accepted)
- [x] Not a dg launcher, so kept with the warning: a link to a file that is not a dg launcher, a directory, an empty file, a file that cannot be read, a script such as `exec dg-skills "$@"`
- [x] A link with no target is replaced
- [x] A dg launcher with an added line is a dg launcher
- [x] bootstrap.sh uses `[ -L ]`, `[ -d ]` and `grep -qF`; bootstrap.ps1 uses `Select-String -SimpleMatch`
- [x] The three implementations (`writeShims`, bootstrap.sh, bootstrap.ps1) run the same fixture names
- [x] `writeShims`: when `<bin>/dg` (`dg.cmd` on win32) exists and is not a dg launcher, keep the file, write the three other launchers, and print one warning; this rule is for the name `dg` only
- [x] `writeShims(bin, root, platform, warn)`: `warn` is a function for one line; its default writes to stderr
- [x] Do not edit pkg/skills-cli/src/install/layout.ts
- [x] One bootstrap run can print the warning two times (the script, then `dg-skills install`)
- [x] `writeShims` and bootstrap.ps1 remove `<name>.exe` only for the three legacy names; they never remove `dg.exe`
- [x] The doctor check `dg-launcher` also warns when the launcher exists and the first `dg` on `ctx.env.PATH` is a different file: detail `dg on PATH is <path>, not <launcher>`, with a fix that is text only; the lookup is `Bun.which("dg", { PATH: ctx.env.PATH })` (`dg.cmd` on win32), and the compare uses `realpathSync`
- [x] checks.ts gives `isCliOnly(ctx)` to the check as an argument, so shared.ts imports nothing from checks.ts
- [x] The program loops of bootstrap.sh and bootstrap.ps1 apply the same rule to `dg`, before `dg-skills install` runs
- [x] In bootstrap.sh the test runs before `mktemp` and `mv -f`; in bootstrap.ps1 it runs before `WriteAllText`
- [x] The launcher text of bootstrap.sh is not byte-equal to the template of `writeShims`; the two hold `lib/current/dg.js`
- [x] The doctor check `dg-launcher` gives `warn` for a file that is not a dg launcher, with a fix that is text only and that doctor does not run
- [x] When `<binDir>/dg` is a symbolic link whose target is a dg launcher, install replaces it like a regular dg launcher of another root; only a `dg` file that is not a dg launcher is kept with a warning; a link is judged by its last target in the three implementations, and a replace of a link changes the link and not its target
- [x] The `install` description is in the generated command tree of dg-skills: after the text change, run `bun scripts/completion-trees.ts dg-skills` and commit pkg/skills-cli/src/completion/tree.json; do not edit the JSON by hand
- [x] In pkg/skills-cli/src/completion/files.ts, `completionFiles()` gives the files of four programs: `dg`, then the three names of `PROGRAM_NAMES`; `writeCompletions` and the completion check of doctor then cover `dg` with no other change
- [x] Export one predicate `isDgLauncher(path, platform)` from shims.ts; `completionFiles` gets a `binDir` seam (default `resolveDgPaths().binDir`) and leaves `dg` out when `<bin>/dg` exists and is not a dg launcher, so `writeCompletions` writes no completion file for such a name and removes none: a TAB must not start `__complete` of a different tool; `writeShims` returns nothing new
- [x] The completion check of doctor uses the same launcher rule: when `<bin>/dg` is a file of a different tool, it leaves `dg` out of the expected completion files, and the check `dg-launcher` is the one warning for that file
- [x] In pkg/skills-cli/src/commands/completion.ts, the description also names `dg`; run `bun scripts/completion-trees.ts dg-skills` one time for the two description changes (`install` and `completion`)
- [x] `removeRetiredBinaries` in cli.ts loops over `[...RETIRED_BINARIES, ...LEGACY_PROGRAMS]`: a compiled `dg` binary never existed
- [x] clean-command.spec.ts asserts that clean.ts imports `LEGACY_PROGRAMS` from `./shims`, and clean.spec.ts uses `LEGACY_PROGRAMS`
- [x] The position of `finishLauncherLayout(` in cli.ts does not change (retired-binaries.spec.ts checks it)
- [x] The doctor `files` check takes its program count from `completionFiles()`, not from the number 3
- [x] The removal of `.<program>.version` stamps stays on the three legacy names in the loop of bootstrap.sh and of bootstrap.ps1

#### Testing Criteria
##### Contracts
- [x] Contract: with `<binDir>/dg` a symbolic link to a dg launcher, install replaces it and prints no keep warning
- [x] Contract: `writeShims(bin, root)` writes `dg`, `dg-skills`, `dg-agent` and `dg-daemon` (`.cmd` on win32); the `dg` launcher runs `<root>/runtime/current/bun <root>/lib/current/dg.js dg "$@"`
- [x] Contract: after bootstrap.sh, `ls <bin>` gives `dg`, `dg-agent`, `dg-daemon`, `dg-skills`, and `<bin>/dg --version` prints the release version
- [x] Contract: bootstrap.ps1 writes `dg.cmd` with the form of the three other `.cmd` launchers
- [x] Contract: an install that has three launchers gets the `dg` launcher when `dg-skills install` runs again
- [x] Contract: `clean` of a legacy bin folder that holds the three notice launchers and a `dg` file of a different tool keeps the folder and names `dg` in its `kept` line
- [x] Contract: `syncCompatLaunchers` writes no `dg` file into the legacy `~/.dg/bin` folder: a folder that held none holds none after it
- [x] Contract: the skills-only sentence is equal in skills-only.ts, in bootstrap.sh and in the two specs that lock it: skills-only.spec.ts and skills-only-install.spec.ts
- [x] Contract: doctor reports `dg-launcher` as `warn` when only the `dg` launcher is absent, with the fix `dg-skills install --cli-only` for a CLI-only install and `dg-skills install` in each other case, and as `ok` when the launcher exists
- [x] Contract: with the platform parameter `win32`, the check reads `dg.cmd`; that test runs on Linux
- [x] Contract: the smoke step of release.yml runs `dg.js dg --version` and holds `$dg` in its comparison loop; skills-blt.yml lists `pkg/dg/**` and runs `bun run lint` and `bun test` in pkg/dg
- [x] Contract: with a file `<bin>/dg` that is not a dg launcher, `writeShims` leaves its bytes and its mode unchanged, writes `dg-skills`, `dg-agent` and `dg-daemon`, and prints `dg: kept <path>; it is not a dg launcher. Remove it or rename it, then run dg-skills install again` on stderr one time or more; the install exits 0
- [x] Contract: bootstrap.sh and bootstrap.ps1 leave that file unchanged and print the same sentence with the path of the kept file (`dg` or `dg.cmd`); each script has the text as its own literal, and a test for each script checks it; for bootstrap.ps1 the method is a static test of the literal sentence, of `Select-String -SimpleMatch` and of the order (the test before `WriteAllText`)
- [x] Contract: an existing dg launcher of a different root is replaced
- [x] Contract: doctor reports `dg-launcher` as `warn` with the detail `<path> is not a dg launcher` and the fix `remove or rename <path>, then run dg-skills install`; `runnableFix` gives `null` for that fix
- [x] Contract: a file `~/.dg/bin/dg` that is not from dg is byte-identical after `syncCompatLaunchers`
- [x] Contract: with an injected `PATH` whose first `dg` is a different file, doctor reports `dg-launcher` as `warn` with the detail `dg on PATH is <path>, not <launcher>`; `runnableFix` gives `null` for that fix
- [x] Contract: `writeShims(bin, root, "win32")` with a `dg.cmd` that is not a dg launcher keeps it and writes the three other `.cmd` files
- [x] Contract: on win32, a file `dg` with no extension is ignored: no warning
- [x] Contract: pkg/skills-cli/src/install/skills-only.ts writes no launcher itself; the rule for a kept `dg` file is only in `writeShims` and in the two bootstrap scripts
- [x] Contract: with a kept `dg` file, the `dg-daemon` launcher is written and the exit code is 0, so a login unit is not affected
- [x] Contract: the fixtures of the launcher rule give the same result in `writeShims`, bootstrap.sh and bootstrap.ps1: a link to a file that is not a dg launcher, a directory, an empty file, a file that cannot be read and a script `exec dg-skills "$@"` are kept; a link with no target and a dg launcher with an added line are replaced; a fixture run of bootstrap.ps1 is behind a guard that skips, with its reason, when `pwsh` is absent
- [x] Edge: `--skills-only`, `--cli-only` and `--agent-only` installs write the same four launchers
- [x] Edge: on win32, a `dg.exe` in the launcher folder has the same bytes after `writeShims` and after bootstrap.ps1
- [x] Check: the checksum step of release.yml for bootstrap.sh needs no change
- [x] Regression: `bun test` passes in pkg/skills-cli and pkg/skills-test; `bun run lint` passes in pkg/skills-cli
- [x] Contract: `bun scripts/completion-trees.ts --check` exits 0
- [x] Contract: on Linux, `completionFiles()` gives 12 files (four programs, three shells), and each `dg` file holds `completionScript(<shell>, "dg")`; pkg/skills-cli/__tests__/completion.spec.ts changes only its program lists and its counts
- [x] Contract: with a kept `dg` file that is not a dg launcher, the install writes the completion files of the three other programs and no `dg` completion file
- [x] Contract: when `<bin>/dg` is a dg launcher, doctor reports a `dg` completion file that is absent or stale in the same way as one of `dg-skills`; with a kept `dg` file of a different tool, doctor expects no `dg` completion file and reports nothing for it
- [x] Contract: with a kept `dg` file of a different tool, `dg-skills completion --install` writes no `dg` completion file and removes none
- [x] Check: `rg "Fetching the dg bundle"` finds no copy with the old list
- [x] Contract: after the replace of a link to a dg launcher, the target file is byte-equal; a link to a link to a dg launcher is replaced; a FIFO named `dg` is kept with the warning
- [x] Check: `rg "\.dg/bin/dg\b" plugins` finds nothing; this is the evidence that no released skill calls `dg` in the legacy `~/.dg/bin` folder

#### Acceptance Criteria
- [x] Given a new machine, when the bootstrap script ends, then `dg --version`, `dg-skills --version`, `dg-agent --version` and `dg-daemon --version` print the same version
- [x] Given an install of the release before this one, when the first `dg-skills install` or bootstrap of the new release ends, then the `dg` launcher exists; until then `dg-skills doctor` warns
- [x] Given an install with no `dg` launcher, when `dg-skills doctor` runs, then one warning names the install command as the fix: `dg-skills install`, or `dg-skills install --cli-only` for a CLI-only install
- [x] Given a release build, when the smoke step runs, then it starts `dg` from the bundle
- [x] Given a file `dg` of a different tool in the launcher folder, when install or bootstrap runs, then the file is unchanged, the three other launchers exist, and one warning names the file
- [x] Given a new install, when it ends, then the completion files of `dg` exist for bash, zsh and fish
- [x] Given an install of the release before, when `dg-skills doctor` runs before the first `dg-skills install`, then it reports two warnings (`dg-launcher`, and the `dg` completion files that are absent), and one install command repairs the two

### Slice 7 — dg-front-door-docs

#### Engineering
- [x] In docs/adr/0020-one-dg-command.md, add a dated H2 section `## Amendment (<date>)` near the end of the file, as in ADR 0001 and ADR 0046; do not rewrite the accepted text
- [x] The amendment states: channel review leaves dg in a later major release (no date), so there is no `dg review` group; the review bot runs as a job from its own repository, which replaces the step that registers `review-<env>`; `dg` is a fourth program name over the three command trees; the single binary and the `dg-v<x>` tag are not built
- [x] The amendment also corrects, by statement, the accepted text that is now not true: `dg review start` and the review group; `dg-daemon has no command tree of its own`; `every command lives in pkg/skills-cli`; the count of packages; the Mermaid diagram; the single binary; the `dg-v<x>` tag; the `review-<env>` step; the `dg service` group; `dg daemon run`; and "a service or job is a stored `dg <command>`"
- [x] The amendment states that `dg autostart` is the mount of `dg-daemon autostart`
- [x] In the amendment, do not write `supersedes` near 0020, do not write `Deprecated`, and do not change the `Status:` line
- [x] In docs/adr/toc.md, move the 0020 row out of `Proposed changes` to `## Platform`, before the 0043 row, in the Accepted form of the other rows and in 160 columns at most, so the index agrees with `Status: Accepted` in the file
- [x] The count in the first paragraph of toc.md (`sixteen historical records`) does not change: records 0008 to 0023 are sixteen and already hold 0020
- [x] The title of the new 0020 row is the H1 of the file, and the text after `— Accepted:` says what the amendment changed
- [x] In docs/jobs-and-services.md, each `dg-daemon job <verb>` becomes `dg job <verb>`, and the `autostart` group uses the form `dg autostart …`; keep the literals `job exec`, `service add`, `service rm`, `dg-daemon service start` and `service status --json`; the `service` group keeps the form `dg-daemon service …` in this slice, and slice 11 rewrites the document for the one noun
- [x] The link at the top of the file and the new section `Start at login` hold none of the four literals of the test `gives run steps in order` before their first positions of today
- [x] The commands of the daemon itself keep the form `dg-daemon start`, `dg-daemon stop`, `dg-daemon restart` and `dg-daemon status`
- [x] Change the count of launchers only, in each sentence that the search of the launcher-list Contract finds on the base commit; find each site by a quoted anchor, not by a line number. The list holds at least: docs/install.md ("write the `dg-skills`, `dg-agent` and `dg-daemon` launchers into the", "The three programs share it and one runtime", and the completion list, which also gets `dg completion <shell>`); docs/AGENT-INSTALL.md ("because one bundle holds all three programs", "the runtime, the bundle and the three launchers", "bash, zsh and fish completion files for the three", a sentence that continues on the next line, and "dg-skills, dg-agent, dg-daemon, and the extension together"); docs/DEVELOPER.md ("runs `--version` for all three programs from the bundle" and "the bundle that holds `dg-skills`, `dg-daemon` and `dg-agent`"); README.md ("one bundle with `dg-skills`, `dg-agent` and")
- [x] Do not change the text on the legacy `~/.dg/bin` folder (docs/install.md near lines 139, 247 and 317): it keeps three names
- [x] Do not change the command forms of the upgrade steps in docs/AGENT-INSTALL.md
- [x] In docs/AGENT-INSTALL.md, write each program name in its own code span, so that no text `dg-agent <word>` appears that is not a command (pairing-docs.spec.ts runs `dg-agent <word> --help`)
- [x] In docs/install.md, document the result of slice 6: a `dg` file that is not a dg launcher is kept, with the message `dg: kept <path>; it is not a dg launcher. …`; the doctor check `dg-launcher`; dg writes no `dg` file into the legacy folder
- [x] In docs/install.md, state that the `dg` launcher appears with the first `dg-skills install` or bootstrap of the new release
- [x] Document no `clean` rule for the launcher folder
- [x] Check each documented literal of slice 6 against its source
- [x] In docs/DEVELOPER.md, add pkg/dg to the package list and to the `skills-blt` row, state that `dg` mounts the three command trees, and add a `### pkg/dg` entry to `Per-Package Commands`
- [x] In docs/DEVELOPER.md, state that `dg` reports the stamp of the launcher and that pkg/dg stays at `1.0.0`, next to the sentence on `@dg/common` below the version table, not in a table row
- [x] In docs/DEVELOPER.md, add one sentence on `DG_PATH_FENCE` below the heading `Meaningful tests`
- [x] Do not edit the CI paragraph of docs/DEVELOPER.md that names pkg/channel-review; slice 21 owns it
- [x] In README.md, add one table of the nine `dg` names: `job`, `autostart`, `skills`, `agent`, `daemon`, `extension`, `install`, `upgrade`, `doctor`
- [x] The README.md table has two columns: the `dg` name, and the target program and command (`dg upgrade` is `dg-skills update`)
- [x] Put the table after the install paragraph and before the skills table, not between the jobs-and-services bullet and the `Service API v1 (provisional)` bullet
- [x] Add pkg/skills-test/__tests__/dg-front-door-docs.spec.ts: each `dg <name>` group in the changed documents is a name of `ROUTES`, which the spec imports from pkg/dg/src/main.ts by a relative path, so pkg/skills-test/package.json does not change; the check does not read the accepted text of docs/adr/0020-one-dg-command.md, only the amendment that this slice writes
- [x] Write no private organization name and no private repository name in a document
- [x] Change no SKILL.md file: the skills keep the names `dg-skills`, `dg-agent` and `dg-daemon`
- [x] pkg/skills-test/__tests__/dg-front-door-docs.spec.ts also permits `completion` as the first word after `dg `
- [x] Where a sentence of README.md, docs/install.md or docs/AGENT-INSTALL.md lists the programs that have shell completion, add `dg`
- [x] The amendment names no record for the job model: slice 11 writes that record and adds the link
- [x] In docs/jobs-and-services.md, add a section `Start at login`: `dg autostart install|remove|status`, the unit kind for each OS, the WSL steps, and the statement that the `dg-phone` unit is a different unit
- [x] Put the section `Start at login` after `Run, stop and restart`, and link it from the top of the file
- [x] The test `gives run steps in order` of pkg/skills-test/__tests__/outside-services-docs.spec.ts reads the first position of four literals; the new section does not come before those positions
- [x] In `Start at login`, state that a login unit has a minimal `PATH`, and that a service that needs more puts `PATH` in its `envFile`
- [x] In `Start at login`, state that a service under a login unit gets `envFile` values and grants, not `passEnv` values, because a login unit has a minimal environment
- [x] In `Start at login`, state that with a login unit `dg-daemon start` and `dg-daemon restart` start the daemon through the service manager, and that this daemon has the environment of the login unit
- [x] In `Start at login`, state that `dg-daemon stop` and `dg-daemon stop --force` leave the daemon stopped until the next login or the next `dg-daemon start`
- [x] In `Start at login`, state that `autostart install` fails on win32 with `DG_HOME` set
- [x] Three existing sentences of docs/jobs-and-services.md are in the path of this slice: (a) `Nothing starts the daemon at login` becomes `Without a login unit, nothing starts the daemon at login`; (b) the sentence that starts with `The new daemon has the environment of the` gets the limit `with no login unit`; (c) the sentence on the restart of only the `autostart` services stays
- [x] The assertion `/nothing starts the daemon at login/i` of pkg/skills-test/__tests__/outside-services-docs.spec.ts passes with the new text of sentence (a); the only planned edit of that spec is the key list; edit an assertion on sentence (a) or (b) only when the run fails
- [x] In docs/service-api.md, add the row `DG_SERVICE_STATE_DIR` to the key table: the absolute path of `<state>/jobs/<label>/`; the daemon makes the folder (mode 0700 on POSIX) before the service starts, and `service rm` does not remove it; add also a conditional `DG_HOME` row: the daemon injects that key only when it has one
- [x] Add `DG_HOME` and `DG_SERVICE_STATE_DIR` to the key sentence of docs/jobs-and-services.md (the sentence that starts with "The daemon injects") and to the key list of the test `names the injected DG keys from supervisor source` in pkg/skills-test/__tests__/outside-services-docs.spec.ts
- [x] Give no count of injected keys in a sentence of a document
- [x] In docs/service-api.md, state that the daemon gives its own `DG_HOME` to each service when it has one, so a `dg-skills` or `dg-agent` call of the service uses the same dg home
- [x] In docs/install.md, the layout table has one row for each role: add `job sources` to the Data cell and `job state` to the State cell, and give `<data>/jobs` and `<state>/jobs` in one sentence below the table
- [x] In docs/install.md, put the `daemon` rule of slice 3 and the text of `blockedText` for `two-used` in the legacy-folder map and the message table
- [x] In docs/install.md, state that two daemon folders with data stop the daemon start, that the message names the two folders, and that dg merges nothing
- [x] In docs/install.md, give the remedy for two used daemon folders: move `<state>/daemon` to a different name when the legacy folder holds the sessions, then start again
- [x] In docs/install.md, state that `dg-daemon serve` exits 78 for this block, and that the systemd unit does not start it again
- [x] Check each documented literal of slices 2, 3 and 4 against its source file
- [x] dg-front-door-docs.spec.ts also owns these Contracts, one test each: the 160-column rule of toc.md; the README table against `ROUTES`; no launcher list without `dg`; the relative links of each changed file, with docs/install.md; the unit kind for each OS; the three login-unit rules; the injected keys; the literal `two daemon folders hold data` in its source
- [x] Document only the `dg job` verbs that exist at the end of PR 1 (`add --label --every|--cron`, `list`, `run`, `exec`, `enable`, `disable`, `rm`); show no `dg job setup`, no `dg job add <git-url>` and no `dg job enable` with credentials
- [x] In the message table of docs/install.md, add a row for `dg: set aside <dest> as <aside>; dg copied no file from it, and dg-skills clean keeps it`, and correct the paragraph that says that `clean` removes each set-aside copy
- [x] Write no code span that is exactly `review` or `viz` in README.md or docs/install.md (skill-index-docs.spec.ts reads them); keep the nine names in spans such as `dg job`
- [x] In docs/adr/0043-outside-services.md, add one dated line after the `Date:` line: `Amended <date>: the daemon also injects DG_SERVICE_STATE_DIR and, when it has one, DG_HOME; see docs/service-api.md.`; change no other line; the line does not start with `Status:`
- [x] In `Start at login`, state that the unit records each `XDG_*_HOME` that the installer had set, and that a job still gets `DG_HOME` only
- [x] In `Start at login`, state that systemd stops a unit after 90 s by default, so a logout or a shutdown can end a job before its stop limit (accepted)
- [x] In `Start at login`, state that the WSL step needs `wslpath` and `schtasks.exe`
- [x] In `Start at login`, state that launchd and the Windows task start the daemon again after exit 78, because they cannot filter an exit code [DECIDED — gaps pass O2 (a)]
- [x] Create pkg/skills-test/__tests__/docs-help-kit.ts: it exports the function that takes the `dg …` command forms from a document and the function that runs `bun pkg/dg/src/index.ts <words> --help` in the fence; the `--help` Contract of this slice uses it, and slices 11 and 20 import it

#### Testing Criteria
##### Contracts
- [x] Check (manual): `git diff <base of PR 1> -- docs/adr/0020-one-dg-command.md` shows no removed line
- [x] Contract: docs/adr/toc.md lists 0020 one time, outside `Proposed changes`
- [x] Contract: pkg/skills-test/__tests__/outside-services-docs.spec.ts passes; its test `does not deprecate ADR 0020 or ADRs 0008 to 0019` is unchanged
- [x] Contract: each `dg <name>` in a code span or a fenced block of the changed documents is a name of `ROUTES`; the match rule is `dg` that no word character, `.`, `/`, `~` or `-` comes before, then one space and one word; the check takes that word, permits `--help`, `--version` and `help`, and ignores prose and the texts `dg: kept` and `dg-v<x>`
- [x] Contract: a search of README.md and docs/ with a pattern that permits code spans and commas finds no sentence that lists `dg-skills`, `dg-agent` and `dg-daemon` as the launchers and leaves out `dg`, except the paragraphs on the legacy `~/.dg/bin` folder
- [x] Check (manual): `git diff <base of PR 1> --stat -- plugins/ scripts/skill-bootstrap-block.ts SECURITY.md` is empty
- [x] Contract: the target column of the README.md table is equal to `ROUTES`: the target cell of each row is `[program, ...command].join(" ")` (`dg-skills update` for `upgrade`, `dg-daemon` for `daemon`)
- [x] Contract: each line of `## Platform` in docs/adr/toc.md has 160 columns at most
- [x] Contract: for each `dg <group> --help` form in a fenced block of the changed documents, `bun pkg/dg/src/index.ts <group> --help` exits 0; the spec runs in the test home fence and starts no daemon
- [x] Check (manual): `bun scripts/skill-bootstrap-block.ts --check` exits 0
- [x] Check: each relative link in the changed documents opens an existing file
- [x] Check (manual, before the commit; no spec): the orchestrator gives the private-name list at run time from the local decision log, which is outside the repository; run a case-insensitive search of the changed files and report only `found` or `not found`; no spec, fixture, commit message or findings file holds a private name or a part of one
- [x] Regression: `bun test` passes in pkg/skills-test, with outside-services-docs.spec.ts, pairing-docs.spec.ts and skill-index-docs.spec.ts; `bun test pkg/skills-cli/__tests__/skills-only-install.spec.ts` passes; `bun run lint` passes in pkg/skills-test, and if it fails because the spec type-checks pkg/dg source, import `ROUTES` with a dynamic `import()` and a local type, and change no package.json
- [x] Check (manual, for PR 1; not in the spec): the amendment of ADR 0020 holds no link to a record with a number above 0048; slice 11 adds a link to the jobs record to the same amendment
- [x] Contract: the `Start at login` section names the unit kind for each OS, the WSL steps, and that the `dg-phone` unit is a different unit
- [x] Contract: the `Start at login` section states the three login-unit rules: `start` and `restart` use the service manager; that daemon has the environment of the login unit; `stop` and `stop --force` leave the daemon stopped until the next login or the next `dg-daemon start`
- [x] Contract: docs/service-api.md names each injected key of pkg/dg-daemon/src/services/supervisor.ts, and no sentence gives a count of keys; the spec finds the keys as the `DG_` names that `serviceEnv` assigns
- [x] Contract: the documented text `two daemon folders hold data` is in its source file
- [x] Check: pkg/skills-test/__tests__/outside-services-docs.spec.ts passes; its only change is the key list, plus an assertion on the sentences `Nothing starts the daemon at login` and `The new daemon has the environment of the` only when the run failed without that edit
- [x] Check (manual): `markdownlint <files>` and `vale <files>` pass on the changed files (no mise task and no workflow runs them); a wide table keeps the `markdownlint-disable MD013` fence that docs/install.md uses

#### Acceptance Criteria
- [x] Given ADR 0020, when a reader opens it, then the amendment says that channel review leaves dg and that a job from the bot repository replaces the `review-<env>` step
- [x] Given docs/adr/toc.md, when a reader looks for 0020, then it is not in `Proposed changes`
- [x] Given README.md, when a reader looks for the entry command, then one table lists the `dg` groups
- [x] Given docs/jobs-and-services.md, when a reader copies a `dg autostart` or a `dg job` command, then the command runs on a build of this branch; the spec proves it with the `--help` form of each group that a document shows
- [x] Given docs/jobs-and-services.md, when a reader wants dg to start at login, then the section `Start at login` gives `dg autostart install`
- [x] Given docs/service-api.md, when the author of a service looks for its state folder, then the document gives `DG_SERVICE_STATE_DIR`
- [x] Given docs/install.md, when a reader has two daemon folders with data, then the document gives the message and the remedy

### Slice 8 — job-config-merge

#### Engineering
- [x] Create `pkg/dg-daemon/src/jobs/config.ts` with `JOBS_CONFIG_KEY = "jobs"`, the type `JobDecl`, `parseJobEntry(name, raw)` and `parseJobs(config)`; move each rule of `parseServiceEntry` there
- [x] The mode keys are `continuous` (only the value `true`), `schedule` (a cron text, checked with jobs/cron.ts) and `every` (a duration text such as `15m`, checked with `parseEvery`); an entry has exactly one of them
- [x] The other entry keys are `argv`, `cwd`, `enabled`, `feed`, `notify`, `timeoutMs`, `credentials`, and the keys of today `envFile`, `passEnv`, `stopTimeoutMs` and `grant`; each other key is an `unknown key(s)` error; `cwd` is necessary and absolute
- [x] `enabled` replaces `autostart`: a continuous job with `enabled: true` starts when the daemon boots; `enabled` is a boolean and is valid with each mode
- [x] `feed`, `notify` and `timeoutMs` are valid only with `schedule` or `every`; `notify` is valid only with `feed: true`; `stopTimeoutMs` is valid only with `continuous`; `feed` is a boolean, `notify` is a string that is not empty, and `timeoutMs` is a whole number of 1 or more
- [x] `credentials` is an array of names; `<grant>/<name>` must pass `validateCredentialName`; `credentials` with no `grant` fails with `"credentials" needs "grant"`; the list holds no name two times and 16 names at most
- [x] The name rule is `isJobName` of `@dg/common/node` (slice 2); jobs/config.ts holds no copy of the pattern
- [x] Delete `pkg/dg-daemon/src/services/config.ts`; each importer uses `jobs/config.ts`
- [x] Create pkg/dg-daemon/src/jobs/launcher.ts: move the environment build, the log open and the spawn of supervisor.ts there with no change of behavior; it exports `buildBaseEnv(decl, deps)` (the allowlist, `passEnv`, `envFile`), `buildJobEnv(decl, deps)` (the base, then the injected `DG_*` keys), `launchJob(decl, deps)` (opens the log and spawns) and `jobLogFile(logDir, name)`, and `deps` is `{ paths, daemonUrl, logger, maxLogBytes }`; the supervisor uses each of them, and slice 10 calls the launcher from the runner, so the two modes have one launcher; later slices rename none of the four exports
- [x] Keep the warning text `service <label>: passEnv name <NAME> is not set in the daemon environment` and the names `DG_SERVICE_*` in the text of launcher.ts
- [x] Create `pkg/dg-daemon/src/jobs/migrate.ts` with `migrateServicesKey(paths): { moved: string[] }`; the caller holds the config lock
- [x] `migrateServicesKey` reads with `readConfigStrict`; it is a no-op with no write only when the config has no `services` key and the mark is current; a write of the mark alone makes no backup, creates the file with mode 0600 and makes a private parent directory
- [x] Before the first write, copy the config bytes to `<daemonDir>/config.json.pre-jobs` with the flag `wx` and mode 0600; do not replace that file when it exists; the backup copies the target of a config that is a link (`writeTarget`); a failed backup stops the move, and nothing is written
- [x] The move calls `assertNotBlocked(paths, "daemon")` before its first write
- [x] Copy each `services` entry to `jobs` with the same name; add `continuous: true`; `autostart: true` becomes `enabled: true`; delete the `autostart` key only when its value is a boolean, and leave each other value in place, so the entry stays `invalid` with `unknown key(s): autostart`; change no other key
- [x] Copy an entry that the old parser refused with no change other than those two; it stays `invalid` in the status
- [x] When one name is in `services` and in `jobs`, throw `Error` with `<file>: "<name>" is in "services" and in "jobs" — remove one of them`; write nothing
- [x] Remove the `services` key and write the `jobs` table in one `writeFilePreserving(file, data, 0o600)` call; `writeFilePreserving` keeps the mode of a file that exists, so the move calls `chmod 0600` after the write
- [x] `migrate.ts` exports `JOBS_VERSION = 1`, `SERVICES_MARK = 1` and `isMigrated(config)`, which is `typeof jobsVersion === "number" && jobsVersion >= JOBS_VERSION`; `migrateServicesKey` writes the top-level config key `jobsVersion` with the literal mark 1 (`SERVICES_MARK`), not `JOBS_VERSION`, in the write of the move, or alone when the config has no `services` key; the daemon never lowers a mark
- [x] `migrateServicesKey` runs again when a `services` key comes back after the mark
- [x] `cmdServe` calls `migrateServicesKey` under the config lock before `createSupervisor`, so the move runs at each daemon start; a config that is not valid JSON logs one warning, and the daemon boots as it does today
- [x] The CLI does not migrate: a CLI verb that writes the table and finds `isMigrated(config)` false starts the daemon one time with the code of `dg-daemon start`, waits for the mark, then continues; this step runs before the CLI takes the config lock; inside the lock, the verb reads the config again and tests `isMigrated` a second time
- [x] `isMigrated` is the one guard for the two migrations: slice 10 changes `JOBS_VERSION` to 2 and edits no caller; only the row move of slice 10 writes the mark 2
- [x] The supervisor reads `parseJobs`, keeps the `continuous` entries and uses `enabled` in `autostart()`
- [x] `writeJobEntry` replaces `writeServiceEntry` in `config-store.ts`
- [x] Create `pkg/dg-daemon/src/jobs/control.ts` with the type `JobControl` (`start(name)`, `stop(name)`, `status()`); in this slice it calls the supervisor; the routes call only `JobControl`, so slice 10 adds scheduled jobs there and does not edit `http.ts`
- [x] Add `CHAT_JOBS_PATH = "/jobs"` to `pkg/common/src/chat-format.ts`; serve `GET /jobs`, `POST /jobs/<name>/start` and `POST /jobs/<name>/stop` with the handler and the guards of the service route
- [x] `GET /jobs` answers `{ instanceId, jobs: [...] }`; keep `/services` on the same handler with the key `services` until slice 21
- [x] `dg-daemon service add|rm|status|start|stop` keep their arguments, stdout and exit codes; they write to `jobs`; each prints one stderr line: `note: "dg-daemon service" is now "dg job"; this form goes away in the next major release`
- [x] `dg-daemon stop --force` lists with `/jobs` and reads `body.jobs`; only a 404 on `/jobs` starts the fallback to `/services` (a daemon from before this change), which reads `body.services`; a 403 or a network error does not start the fallback
- [x] Do not move a pid file or a log file: `<state>/daemon/services/<name>.pid` and `<log>/service-<name>.log` keep their paths
- [x] When that daemon start fails, or the config has no current mark after it, the verb exits 1 with `the daemon config is not migrated — run dg daemon start, then run this command again` and writes nothing
- [x] The key `passEnv` keeps its name in the table; slice 9 gives it the flag `--env`
- [x] `dg-daemon service add --autostart` writes `enabled: true`; the option keeps its name in the `service` group
- [x] Change no command name, option or description of the `service` group in this slice, so pkg/dg-daemon/src/completion-tree.json stays current
- [x] pkg/skills-test/__tests__/outside-services-docs.spec.ts reads source files of this package by path: change only the two `source(...)` reads that this slice moved (pkg/dg-daemon/src/services/config.ts to pkg/dg-daemon/src/jobs/config.ts, and the injected keys to pkg/dg-daemon/src/jobs/launcher.ts); change no assertion on the document text, and leave the assertion that ADR 0043 lists `pkg/dg-daemon/src/services/config.ts` in its References: the accepted record keeps that path
- [x] The specs below pkg/dg-daemon/__tests__/server and pkg/dg-daemon/__tests__/services that write a `services` table in a fixture config change only the table name, `continuous: true` and `enabled`; keep each assertion
- [x] When a live daemon exists and the config has no current mark, the verb starts no daemon, waits 10 s at most for the mark, then exits 1 with `the daemon config is not migrated — a dg-daemon from before this release runs (pid <pid>); run dg daemon restart, then run this command again`; the verb never restarts the daemon [DECIDED — gaps pass O3 (a)]
- [x] A `services` value that is not an object stays in the file; the daemon logs one warning that names the file, and it writes the mark; `dg-daemon service add` on that file writes `jobs.x` [DECIDED — gaps pass O4 (a)]
- [x] service-add-rm.spec.ts changes one assertion for that rule: the case `{"services":[1]}` no longer gives `"services" must be an object`
- [x] A `services` entry that is not an object moves as it is, by the rule for an entry that the old parser refused
- [x] Run pkg/dg-daemon/__tests__/server/scheduler-routes-removed.spec.ts, and remove each `/jobs` row that fails now that `/jobs` is a route (`GET /jobs` at least)
- [x] An unknown name on `POST /jobs/<name>/start` or `/stop` answers 404 with the body `no job named "<name>"`; `/services` keeps `no service labelled "<name>"`; slice 9 reads the body, not only the status
- [x] `isDeclared` and `service rm`, `service start`, `service stop` and `service status` act only on `continuous` entries
- [x] Name the types: `JobDecl.name`, and the parse result `ParsedJob`; the status objects of `/jobs` and `/services` keep the key `label`, and this bundle does not rename it
- [x] `DEFAULT_STOP_TIMEOUT_MS`, `MAX_STOP_TIMEOUT_MS` and the literals `5_000` and `240_000` move to jobs/config.ts with no change
- [x] Export `ensureMigrated(paths, seams)` from service.ts, next to `withConfigLock`: it holds the step that starts the daemon and waits for the mark, and the `not migrated` failure; each `service` verb that writes calls it
- [x] Export a quiet `startDaemon(paths, seams)` from pkg/dg-daemon/src/commands/start.ts: it returns the daemon handle and prints nothing; `cmdStart` calls it and prints its line, and `ensureMigrated` calls it; this is the stated edit of start.ts in this slice
- [x] In pkg/dg-daemon/__tests__/utils/service-daemon.ts, `writeServiceConfig` and `bootWithServices` write the `jobs` table; add one case for `CHAT_JOBS_PATH` to pkg/common/__tests__/chat-format.spec.ts
- [x] After a move, the daemon logs one info line `moved <N> service(s) to "jobs"; backup <path>`
- [x] `HttpServerDeps.supervisor` becomes `jobs: JobControl`; bootstrap.ts keeps the supervisor object for `stopAll`, `autostart` and `runningCount`, which are outside `JobControl`

#### Testing Criteria
##### Contracts
- [x] Contract: `{ "pinnedOrigin": "x", "services": { "a": { "argv": ["/b"], "cwd": "/c", "autostart": true } } }` becomes `{ "pinnedOrigin": "x", "jobs": { "a": { "argv": ["/b"], "cwd": "/c", "continuous": true, "enabled": true } } }`; the backup file holds the bytes from before
- [x] Contract: a second daemon start writes no file; the bytes and the mtime do not change
- [x] Contract: an entry with `autostart: false` or no `autostart` has no `enabled` key after the move
- [x] Contract: a name in the two tables throws, names the file and the name, and changes no byte
- [x] Contract: a config that is not valid JSON is not written; the daemon boots; the log holds one warning that names the file
- [x] Contract: the config file mode is 0600 after the move (POSIX), also for a config that starts with mode 0644; an existing `config.json.pre-jobs` is not replaced
- [x] Contract: an entry with two mode keys fails with `give exactly one of "continuous", "schedule" or "every"`; an entry with none fails with the same text
- [x] Contract: `"continuous": false` fails with `"continuous" must be true`
- [x] Contract: an entry with `autostart` fails with `unknown key(s): autostart`
- [x] Contract: `timeoutMs` on a continuous entry fails with `"timeoutMs" needs "schedule" or "every"`
- [x] Contract: `GET /jobs` and `GET /services` give the same status objects under their two keys
- [x] Contract: `dg-daemon service add x --cwd <dir> -- <cmd>` on a migrated config writes `jobs.x` with `continuous: true`, prints the stdout of today, and prints the note on stderr one time
- [x] Contract: after a daemon start on a machine with no config file, the config holds `jobsVersion: 1` and no `jobs` key
- [x] Contract: `dg-daemon service add` on a config with no `jobsVersion` starts the daemon one time, then writes `jobs.x`; the `services` entries of that config are in `jobs` after it
- [x] Contract: `launcher.spec.ts`: the environment order of `supervisor-env.spec.ts` holds for a call of the launcher with no supervisor
- [x] Happy path: a daemon boots on a config with `services` and `autostart: true`; the job runs; the config holds `jobs` and no `services`
- [x] Edge: with the pid file of an instance that still runs, the first start after the upgrade gives the `earlier instance` conflict of today
- [x] Error: a daemon that answers 404 on `/jobs` still stops with `dg-daemon stop --force`, and each service process tree ends
- [x] Regression: `bun test` and `bun run lint` pass in pkg/dg-daemon and pkg/common; the specs in `__tests__/services` and `service-add-rm.spec.ts` pass with only the table name and the mode key changed
- [x] Contract: `dg-daemon service add x --autostart --cwd <dir> -- <cmd>` writes `jobs.x` with `continuous: true` and `enabled: true`, and no `autostart` key
- [x] Contract: when the daemon cannot start, `dg-daemon service add` on a config with no `jobsVersion` exits 1 with the `not migrated` text and writes nothing
- [x] Contract: pkg/skills-test/__tests__/outside-services-docs.spec.ts passes, and its diff holds only changed source paths
- [x] Contract: pkg/dg-daemon/__tests__/completion-tree.spec.ts passes with no change of the tree file
- [x] Contract: the CLI does not hold the config lock while it waits for the daemon: a daemon that starts during the wait gets the lock and writes the mark
- [x] Contract: with a live daemon of the release before and a config with no current mark, a verb that writes starts no daemon, waits 10 s at most, exits 1 with the `a dg-daemon from before this release runs (pid <pid>)` text, and does not restart that daemon [DECIDED — gaps pass O3 (a)]
- [x] Contract: a config with `jobsVersion: 5` keeps the value 5 after a daemon start
- [x] Contract: a `services` key that an old CLI wrote after the mark moves at the next daemon start
- [x] Contract: an entry with `autostart: "yes"` keeps that key after the move and is `invalid` with `unknown key(s): autostart`
- [x] Contract: the `/feed` rows of scheduler-routes-removed.spec.ts still answer 404
- [x] Contract: `POST /jobs/nope/start` answers 404 with the body `no job named "nope"`, and `POST /services/nope/start` answers 404 with `no service labelled "nope"`
- [x] Contract: `dg-daemon service rm <name of a scheduled entry>` exits 1 with `no service labelled "<name>"` and deletes nothing
- [x] Contract: one case for each added rule of `parseJobEntry`: a `schedule` that jobs/cron.ts refuses; an `every` that `parseEvery` refuses; a `timeoutMs` that is not a whole number of 1 or more; a `feed` or an `enabled` that is not a boolean; an empty `notify`; a `cwd` that is absent or relative; `enabled` with each mode; `credentials` with no `grant` (`"credentials" needs "grant"`); one name two times in `credentials`; 17 names
- [x] Contract: a job with the name `__proto__` is in `jobs` after the move and after `writeJobEntry` (build the table with `Object.fromEntries`)
- [x] Contract: `stop --force` reads the key `jobs` from the answer of `/jobs`
- [x] Contract: after a 404 on `/jobs`, `stop --force` reads the key `services` from the answer of `/services`
- [x] Contract: this slice changes no byte of docs/adr/0043-outside-services.md
- [x] Contract: the `moved <N> service(s)` log line holds the count and the backup path and no argv

#### Acceptance Criteria
- [x] Given a machine with services in the old config, when the new daemon boots, then each service is a job with the same name, the same command and the same start-at-boot state
- [x] Given the old `dg-daemon service` commands, when a script runs them, then the result is the same and one note goes to stderr

### Slice 9 — job-verbs

#### Engineering
- [x] Create pkg/dg-daemon/src/commands/job-support.ts; move these from service.ts with no change of behavior, and export them: `withConfigLock`, `ensureMigrated`, `findLiveDaemon`, `callDaemon`, `isDeclared`, `guardConfig`, `readInstancePid`, and `resolveExecutable(command, prefix, which = Bun.which)`, where the prefix replaces the fixed text `service add:`
- [x] `add`, `enable`, `disable`, `update` and `remove` call `ensureMigrated` before their lock
- [x] `callDaemon` gets a noun argument for its no-daemon text: the `service` group keeps `no live dg-daemon — services run inside it, so start it with dg-daemon start`, and the `job` group gets `no live dg-daemon — jobs run inside it, so start it with dg daemon start`
- [x] `job add --name <name> --cwd <path> <mode flag> [flags] -- <command…>` adds a command job: the text after `--` is the command
- [x] The mode flags are `--continuous`, `--schedule "<cron>"` and `--every <duration>`; exactly one is necessary
- [x] The other flags are `--timeout <duration>`, `--feed`, `--notify <identity>`, `--env-file <path>`, `--env <NAME>` (repeatable) and `--stop-timeout <duration>`
- [x] This slice adds no `--credential` flag: the flag has no effect before the grant rule and the wizard exist, so slice 15 adds it
- [x] `--label` is an alias of `--name`, `--cron` is an alias of `--schedule`, and `--pass-env` is an alias of `--env`; the three aliases stay until the major release
- [x] `add --continuous` writes a `jobs` entry with the rules of `service add`
- [x] Move the scheduled code of `jobs.ts` (the row insert, the row lookup by label, `run`) to `job-schedule.ts` with no change of behavior; it exports `addScheduled`, `findScheduled`, `setScheduledEnabled`, `removeScheduled`, `runScheduledNow` and `listScheduled`
- [x] In this slice, an `add` with `--schedule` or `--every` calls `addScheduled`, which writes the SQLite row of today; `jobs.ts` calls only those six exports for a scheduled job; slice 10 changes their bodies and does not edit `jobs.ts`
- [x] `job enable <name>`: with the config lock held, read the entry with `readConfigStrict`, set `enabled: true`, and write it with `writeJobEntry`; keep each other key of the entry
- [x] `job enable` with no live daemon starts the daemon with the code of `dg-daemon start`, then continues; when that start fails, `enable` keeps `enabled: true`, exits 1 and prints the text of the start failure
- [x] Login unit: on an `enable` at a terminal, when `autostartManages` of slice 4 gives no kind and the daemon config has no `loginUnitAsked` mark, ask `Start dg at login, so this job runs after a restart of the machine? [Y/n]`; `y` runs the install action of slice 4; each answer writes the mark `loginUnitAsked: true`, so the question appears one time for each dg home
- [x] Write the mark with the `writeConfig(paths, { loginUnitAsked: true })` that exists, after `withConfigLock` returns and after the entry write passed: `writeConfig` takes the same install lock itself; a failed write of the mark prints one warning and does not fail `enable`
- [x] With no terminal and no login unit, `enable` prints `hint: dg does not start at login — run dg autostart install` and asks nothing
- [x] `job disable <name>`: delete the `enabled` key of the entry; when a live daemon reports the job as `running` or `backoff`, send `POST /jobs/<name>/stop` and print its status line; `disable` starts no daemon
- [x] `job start|stop|restart <name>` act now only and do not change `enabled`; `restart` sends `POST /jobs/<name>/stop`, then `POST /jobs/<name>/start`, and prints the status line of the start; a stopped job starts; `restart` adds no daemon route
- [x] `job start` on a scheduled job runs it one time through `runScheduledNow`; `run` and `exec` are aliases of `start` until the major release
- [x] `job update <name> [mode flag] [--timeout] [--feed] [--notify]` on a command job writes the keys that the flags give and keeps each other key, so `update` can change the mode; with no flag it exits 1 with `job update: give a flag to change`; no flag clears `feed`, `notify` or `timeout` (intended)
- [x] `update x --continuous` on an entry with `feed`, `notify` or `timeoutMs`, and `update x --notify y` on an entry with no `feed: true`, fail with the text of `parseJobEntry` in the `job update:` form and write nothing
- [x] The changed entry of a job that runs applies at its next start: print `next: dg job restart x` when the state is `running` or `backoff`
- [x] `job remove <name>` uses the guards of `service rm`: `assertDaemonAnswers`, the refusal of a `running` or `backoff` job on a live daemon, and `assertNoLiveInstance`; `rm` is an alias until the major release
- [x] `job logs <name>` prints the last lines of `<logDir>/service-<name>.log` with the options `-n, --lines <n>` (default 40) and `-f, --follow`, the option names of `dg-skills channel-review logs`; the file name keeps the word `service`; job-logs.ts builds the path with `jobLogFile` of launcher.ts (slice 8) and not by hand
- [x] `job list [--json]` and `job status [name] [--json]`: one row for each entry of the `jobs` table, then each row of `listScheduled`; with a live daemon the row has the run state; with no daemon the state is `daemon not running`
- [x] The `--json` row of a continuous job holds `name`, `mode`, `enabled`, `state`, `pid`, `restarts`, `logFile`, `stateDir`, `cwd`, `daemonUrl` and `grantFile`, so a program that runs as a job can find its folders with no fixed path; the sources are: `name` from the `label` of the daemon row; `mode`, `enabled` and `cwd` from the table entry; `stateDir` from `jobStateDir(paths, name)`; `daemonUrl` from the live handle, else `null`; `grantFile` from `credentialGrantTokenPath(paths, entry.grant)`, else `null`; `state`, `pid`, `restarts` and `logFile` from the daemon row; with no daemon, `pid` is `null` and `restarts` is 0
- [x] `liveJobStates` reads the key `label` of the daemon row
- [x] `enable`, `disable`, `remove` and `start` look in the table first, then call `findScheduled`; `update` reads the table only, because slice 10 moves each scheduled row to the table in the same PR
- [x] Each verb that needs a route of slice 8 and gets a 404 whose body does not hold `no job named` exits 1 with `this dg-daemon is older than the CLI — run dg daemon restart`; a 404 with that body prints the body
- [x] Each verb of the `job` group prints one line on stderr one time before its other output, also for `logs -f` and `--json`: `dg home: <the value of DG_HOME as set, or default>; daemon: <the URL of the live daemon, or not running>`; a health call that fails prints `daemon: not running` and does not stop the verb
- [x] Each `next:` line uses the form `dg job …`
- [x] Move the tail and follow code of pkg/channel-review/src/daemon/logs.ts to pkg/common/src/node/log-tail.ts, export it from pkg/common/src/node/index.ts, and call it from the channel-review `logs` command; `job logs` is its second caller
- [x] After the command change, run `bun scripts/completion-trees.ts dg-daemon` and commit pkg/dg-daemon/src/completion-tree.json; do not edit the JSON by hand
- [x] Add to job-support.ts and export: `assertDaemonAnswers(paths, name)` (the `does not answer` guard of `service rm`), `liveJobStates(paths)` (the `state` of each name from `GET /jobs`, or `undefined` with no live daemon) and `assertNoLiveInstance(paths, name)` (the instance pid file guard of `service rm`)
- [x] service.ts imports the helpers from job-support.ts; the specs of the `service` group pass with no change
- [x] In this slice `addScheduled` stores the fields that the SQLite row of today has (`argv`, `cwd`, the interval or the cron text, and `notify`); it takes `feed` and `timeoutMs` in its options and does not store them, and slice 10 stores them in the table in the same PR
- [x] In this slice a scheduled `add` with `--feed` or `--timeout` prints `note: --feed and --timeout take effect after the jobs move` on stderr, from `addScheduled`; slices 9 to 11 ship in one PR, and slice 10 removes the note
- [x] The new form `add --name x --every 15m` writes a row that is not enabled and prints `next: dg job enable x`; the alias forms `add --label x --every 15m` and `add --name x --cron …` write the enabled row of today [DECIDED — gaps pass X2 part 1 (a)]
- [x] Each alias form of the `job` group (`--label`, `--cron`, `--pass-env`, `rm`, `run` and `exec`) prints one stderr line: `note: "<old form>" is now "<new form>"; this form goes away in the next major release`; stdout does not change; each alias form is a separate hidden command or a hidden option (`new Option("--label <name>").hideHelp()`), so the action knows which form the user typed
- [x] The `job` group has no `--grant` option: dg sets the `grant` key from the credential list (slice 15), and `dg-daemon service add` keeps `--grant` until the major release
- [x] `--env <NAME>` passes the value of that variable from the environment of the daemon to the job, and writes the name to the `passEnv` key of the entry; `dg-daemon service add` keeps the option `--pass-env`
- [x] A value of `--env` that holds `=` exits 1 with `job add: --env takes a variable name — put a value in the file of --env-file`
- [x] `enable` sends `POST /jobs/<name>/start` only when the state is `stopped`, and then prints the status line of `job start`; in each other state it prints the status line of the job and sends no start request
- [x] `enable` takes `AutostartDeps` as a seam; the default is `defaultAutostartDeps()` of slice 4
- [x] `enable` and `disable` call `assertDaemonAnswers` before the write
- [x] `enable` and `disable` write nothing when `enabled` is already in the target state
- [x] `enable` and `disable` change the `enabled` key only; they do not check the other keys, and they refuse an entry that is not an object
- [x] One `preAction` hook on the `job` command prints the `dg home:` line; it writes nothing to stdout, and the sibling `service` group prints nothing
- [x] log-tail.ts exports `readTail(path, count)`, which returns `{ lines, size, ino }` from one open file descriptor (`fstat`, then a read up to that size), and `follow(path, { out, signal, pollMs, start })`; `start` can be `{ size: 0, ino: -1 }` for a file that does not exist; the tail and the start offset of `follow` stop at the last newline, and `follow` holds the text after it as `pending` and prints it when its newline arrives
- [x] The message for an absent file and the exit code stay in each caller: channel-review `logs` prints `<path>: no log yet` and exits 0, as on master
- [x] `logs` needs no daemon: it reads the file, and it checks the name against the daemon config before it builds the path
- [x] The `logs` action gives `follow` an `AbortSignal` that SIGINT aborts; the spec aborts the signal and sends no real signal
- [x] Put the `logs` action in pkg/dg-daemon/src/commands/job-logs.ts and load it with a lazy import
- [x] The two daemon-boot tests and the test of the new pid after `restart` are in pkg/dg-daemon/__tests__/commands/job-verbs.spec.ts; they use pkg/dg-daemon/__tests__/commands/job-cli-helpers.ts, a temp `DG_HOME` in the fence, and a fixture job that runs until it is stopped; job-cli-helpers.ts takes `runCli`, `readConfigFile` and `lines` from service-cli-helpers.ts and uses daemon-harness, and adds only helpers that those two do not have
- [x] Build the `--json` row with `credentialGrantTokenPath`, `jobStateDir` and the live handle, with no new local path helper
- [x] pkg/dg-daemon/__tests__/commands/jobs.spec.ts and job-exec.spec.ts change only where they read stderr: the `dg home:` line is new; job-exec.spec.ts also changes its case on the stderr of `run` against `exec`: the two notes are different
- [x] Do not edit pkg/dg-daemon/src/services/supervisor.ts or pkg/dg-daemon/src/server/http.ts
- [x] The row type that `listScheduled` returns has the optional text `renamedFrom`; `job list` prints `was "<old>"` after the name of a row that has it, and the `--json` row holds the key `renamedFrom`; slice 10 fills it
- [x] `enable` starts the daemon with the quiet `startDaemon` of slice 8, so no `dg-daemon started on …` line goes to stdout; with a login unit it uses the manager path of slice 4 and its `waitForFreshDaemon` wait; this slice does not edit pkg/dg-daemon/src/commands/start.ts
- [x] In this slice a scheduled row is still in SQLite: `enable`, `disable` and `remove` of such a row follow the path of master (no daemon start, no login question, the stdout of today)
- [x] In this slice `logs <scheduled name>` exits 1 with `no log for job "<name>" yet: <path>`
- [x] In this slice `update <scheduled name>` exits 1 with `job update: <name> is a scheduled job and is not in the jobs table yet`
- [x] These three rules are interim: slice 10 removes them with their Contracts, so put those Contracts in pkg/dg-daemon/__tests__/commands/job-verbs.spec.ts
- [x] `job add` refuses a name that the `jobs` table holds and a label that SQLite holds, in the two directions (`addScheduled` checks the table), with `a job named "<name>" already exists`
- [x] `enable` reads a `conflict` answer of the start route for a job that already runs as success: exit 0 and the status line
- [x] `enable` of an entry that is already `enabled: true`, with no live daemon, still starts the daemon; only the file write is skipped
- [x] The scheduled row of `list` and `status` has the `--json` keys `name`, `mode` (`schedule` or `every`), `enabled`, `schedule` (the cron or duration text), `lastRunAt`, `nextRunAt` and `renamedFrom`
- [x] With no job, `list` exits 0 with a hint, as `job list` on master; `status <unknown>` exits 1 with `no job named "<name>"`; `status <name> --json` prints `{"jobs":[<one row>]}`
- [x] Define `JobVerbDeps` in job-support.ts: `{ confirm(question), isTerminal(), which(name, env?), autostart: AutostartDeps }`; the default `confirm` reads one line with `readLine`
- [x] Create pkg/common/src/node/prompt.ts with `readLine(question)`, and its spec pkg/common/__tests__/node-prompt.spec.ts (`linePrompt` of pkg/skills-cli/src/channel-review/setup.ts is the only line prompt today, and slice 21 deletes that file)
- [x] pkg/channel-review/src/daemon/logs.ts keeps its exported functions and their signatures as thin calls of log-tail.ts, so pkg/channel-review/__tests__/daemon-logs.spec.ts changes no assertion
- [x] Before the build, one search confirms that service-add-rm.spec.ts and service-live-daemon.spec.ts import no moved helper by path
- [x] In pkg/skills-test/__tests__/outside-services-docs.spec.ts, change only its two `source("dg-daemon", "src", "commands", "service.ts")` reads to job-support.ts where the literal moved; change no assertion on the document text
- [x] `job add` applies `isJobName` to each new name, for the two modes and for the alias `--label`; a name that fails exits 1 with `job add: "<flag>" must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit` and writes nothing; `<flag>` is `--name` or `--label` as the owner gave it, and the rule text is that of `parseServiceEntry`; name the change in the PR body, because master accepts each label [DECIDED — gaps pass X2 part 2 (refuse)]

#### Testing Criteria
##### Contracts
- [x] Contract: `job add --name x --cwd <dir> --continuous -- <cmd>` exits 0 with `added job "x"`, then `next: dg job enable x`
- [x] Contract: `job add` with no mode flag, with two mode flags, or with `--continuous` and `--every` exits 1 with `job add: give one of --continuous, --schedule or --every`
- [x] Contract: `job add --label x --every 15m --cwd <dir> -- <cmd>` and `job add --name x --cron "<cron>" --cwd <dir> -- <cmd>` write the enabled row of the command of today; `job add --name x --every 15m --cwd <dir> -- <cmd>` writes a row that is not enabled and prints `next: dg job enable x` [DECIDED — gaps pass X2 part 1 (a)]
- [x] Contract: `job update x --every 30m` on a command job with `every: "15m"` writes `every: "30m"`, keeps `enabled`, and prints `updated job "x"` and `changed every`
- [x] Contract: `job update x --continuous` on a scheduled command job replaces the mode key; the entry has exactly one mode key after it
- [x] Contract: `job list --json` prints one line `{"jobs":[…]}`; a continuous row holds the eleven keys of the Engineering list
- [x] Contract: with a scheduled row `nightly` in SQLite and no table entry, `job disable nightly` prints the stdout of today
- [x] Contract: with no live daemon, `job enable x` starts the daemon one time, exits 0, and prints `enabled job "x"`, then the status line with the state `running`
- [x] Contract: the login question appears one time on the first `enable` at a terminal with no unit; `n` writes no unit; a second `enable` does not ask; with no terminal, the hint line prints and the `confirm` seam gets no call; with a unit that records the `DG_HOME` of the caller, no question and no hint appear
- [x] Contract: with an old daemon, `job start x` exits 1 with the `older than the CLI` text
- [x] Contract: `command-names-contract.spec.ts` and `completion-tree.spec.ts` pass with the new verbs
- [x] Regression: `bun test` and `bun run lint` pass in pkg/dg-daemon, pkg/common and pkg/channel-review
- [x] Contract: `job rm x` prints `note: "job rm" is now "job remove"; this form goes away in the next major release` on stderr one time, and `job remove x` prints no note; the same holds for `--label`, `--cron`, `--pass-env`, `run` and `exec` with their new forms
- [x] Contract: `enable` of an unknown name exits 1 with `no job named "<name>"` and writes nothing; the same for `disable`, `restart` and `logs`
- [x] Contract: `enable` with a live daemon exits 0 and prints `enabled job "<name>"`, then the status line with the state `running`
- [x] Contract: after `enable`, the entry is deep-equal to the entry before plus `"enabled": true`; after `disable`, the entry has no `enabled` key and each other key is deep-equal
- [x] Contract: `disable` with no live daemon exits 0, prints `disabled job "<name>"`, makes no HTTP call and starts no daemon
- [x] Contract: `disable` of a `running` job prints `disabled job "<name>"`, then the status line with the state `stopped`
- [x] Contract: `enable` two times: the second run writes no file, and the file bytes are equal to the bytes after the first run
- [x] Contract: `restart` with no live daemon exits 1 with `no live dg-daemon — jobs run inside it, so start it with dg daemon start`
- [x] Contract: after `restart` of a `running` job, the status line shows `running` with a pid that is different from the pid before; the spec waits until the stop route answered and the pid file is gone before it reads the new pid
- [x] Contract: `restart` and `stop` do not change the `enabled` key
- [x] Contract: `logs <name>` prints the last 40 lines; `-n 5` prints the last 5; a file with 3 lines prints 3
- [x] Contract: `logs` with no log file exits 1 with `no log for job "<name>" yet: <path>`; `logs -f` with no log file prints `waiting for <path>` on stderr one time, then the first lines when the file appears
- [x] Contract: `logs -f` prints each new line until the abort signal, then exits 0
- [x] Contract: `logs -f` continues after a copy-truncate rotation (`rotateLogIfLarge`: the file size becomes 0); the spec uses `truncateSync`, not a rename
- [x] Contract: `dg-skills channel-review logs` gives the same output as on master for the cases of its spec; pkg/channel-review/__tests__/daemon-logs.spec.ts passes with no change
- [x] Contract: `enable` of a `running` job exits 0 and prints the `enabled` line and the status line; no start request is sent
- [x] Contract: when the write is done and the start request fails, the entry keeps `enabled: true`, the command exits 1, and stderr holds the text of the daemon
- [x] Contract: with a daemon pid that is alive and does not answer, `disable` exits 1 with the `does not answer` text and writes nothing
- [x] Contract: `logs -n 0` and `logs -n x` exit 1 with `--lines must be a whole number of 1 or more`
- [x] Contract: a last line with no newline is not in the tail; `logs -f` prints it one time when its newline arrives; a file with fewer lines than `count` prints each line
- [x] Contract: `restart` of an unknown name with no live daemon exits 1 with `no job named "<name>"`
- [x] Contract: when the stop request of `restart` fails, no start request is sent, and the command exits 1 with the text of the daemon
- [x] Contract: `enable` of an entry that is not an object exits 1 with `job "<name>" in <file> is not an object`; the file does not change
- [x] Contract: `job add --name x --cwd <dir> --continuous --env PATH -- <cmd>` writes `passEnv: ["PATH"]`; the same command with `--pass-env PATH` writes the same entry; `--env A=b` exits 1 with the `--env takes a variable name` text and writes nothing
- [x] Contract: with `DG_HOME=/d` and no live daemon, each verb prints `dg home: /d; daemon: not running` on stderr one time; with no `DG_HOME` the line starts with `dg home: default`; the stdout of each verb holds no `dg home:` text
- [x] Contract: `dg-daemon service status`, `service start` and `service stop` print no `dg home:` line, and `dg-daemon job list` prints it
- [x] Happy path: a boot of the daemon after `enable` starts the job with no `job start` call
- [x] Happy path: a boot of the daemon after `disable` leaves the job `stopped`
- [x] Edge: `enable` keeps `pinnedOrigin`, the other entries and the mode of the config file
- [x] Error: `enable` on a config that is not valid JSON exits 1, names the file, and does not change it
- [x] Contract: one case for each of `add`, `enable`, `disable`, `update` and `remove` on a config with no `jobsVersion`: the verb starts the daemon one time, waits for the mark, then continues
- [x] Contract (interim, until slice 10): `enable`, `disable` and `remove` of a scheduled row in SQLite start no daemon, ask no login question and print the stdout of today
- [x] Contract (interim, until slice 10): `logs <scheduled name>` exits 1 with `no log for job "<name>" yet: <path>`
- [x] Contract (interim, until slice 10): `update <scheduled name>` exits 1 with `job update: <name> is a scheduled job and is not in the jobs table yet`
- [x] Contract: the tree file has no `rm`, `run`, `exec`, `--label`, `--cron` or `--pass-env` entry
- [x] Contract: `update x --continuous` on an entry with `feed`, `notify` or `timeoutMs` exits 1 with the `parseJobEntry` text in the `job update:` form and writes nothing
- [x] Contract: `update x --notify y` on an entry with no `feed: true` exits 1 with the `parseJobEntry` text in the `job update:` form and writes nothing
- [x] Contract: `update` of a job whose state is `running` or `backoff` prints `next: dg job restart x`
- [x] Contract: `enable` right after the daemon start, while the daemon starts the job itself, exits 0
- [x] Contract: `status <unknown>` exits 1 with `no job named "<name>"`, and `status <name> --json` prints `{"jobs":[<one row>]}`
- [x] Contract: the text form of `list` with no job exits 0 with a hint, and a scheduled row of `list --json` holds the seven keys of the Engineering list
- [x] Contract: `job add` with no `--` command exits 1 with `job add: no command given — put it after a bare --`; with a `--cwd` that is not a directory, and with an executable that does not resolve, the error has the `job add:` prefix
- [x] Contract: one case each for `--stop-timeout` with `--every`, `--timeout` with `--continuous`, and `--feed` and `--notify` with `--continuous`: `job add` refuses the pair
- [x] Contract: `job update x` with no flag exits 1 with `job update: give a flag to change`
- [x] Contract: one case for each of the three guards of `job remove` (`assertDaemonAnswers`, a `running` or `backoff` job on a live daemon, `assertNoLiveInstance`), and one for its success
- [x] Contract: one case for `job stop` of a stopped job, and one for `job start` of a scheduled row, which calls `runScheduledNow` one time
- [x] Contract: the exact old and new text of each of the six alias notes (`--label`, `--cron`, `--pass-env`, `rm`, `run` and `exec`)
- [x] Contract: `job list` prints `was "<old>"` after the name of a renamed row, and the `--json` row holds the key `renamedFrom`
- [x] Contract (interim, until slice 10): a scheduled `add` with `--feed` or `--timeout` prints `note: --feed and --timeout take effect after the jobs move` on stderr
- [x] Contract: `job add --label "Bad Label" --every 15m --cwd <dir> -- <cmd>` and `job add --name Bad_Name --continuous --cwd <dir> -- <cmd>` exit 1 with the `must be 1-64 lowercase letters, digits or hyphens` text, name `--label` or `--name`, and write nothing [DECIDED — gaps pass X2 part 2 (refuse)]

#### Acceptance Criteria
- [x] Given a continuous job and a live daemon, when the owner runs `dg job enable <name>`, then the job runs now and at each daemon boot
- [x] Given a running job, when the owner runs `dg job logs <name> -f`, then the command prints the last lines and each new line
- [x] Given the first `enable` at a terminal on a machine with no login unit, when the owner answers `y`, then dg starts at the next login
- [x] Given an enabled job, when the owner runs `dg job disable <name>`, then the job stops now and does not start at the next daemon boot
- [x] Given a running job, when the owner runs `dg job restart <name>`, then the job runs with a new pid and its `enabled` state is unchanged
- [x] Given each `dg job` verb, when it runs, then one stderr line names the dg home and the daemon that it talks to

### Slice 10 — job-schedule-merge

#### Engineering
- [x] `migrateScheduledRows(store, paths)`: for each `scheduled_jobs` row that is not moved, write a `jobs` entry with `argv`, `cwd`, `every` (from `interval_ms`) or `schedule` (from `cron_expr`), `enabled`, `notify` and `feed: true`
- [x] Mapping rules of the move: a row with `cron_expr` gives `schedule`, also when `interval_ms` is set; `enabled` 0 gives no `enabled` key; no `notify_identity` gives no `notify`; the `every` text comes from `formatIntervalMs` of pkg/common/src/chat-format.ts; each new entry passes `parseJobEntry` before the write; rows are read by `created_at`, then `label`; a valid label that no other entry has stays as it is
- [x] Add one schema step, step 14: the columns `moved_at` and `renamed_from TEXT` on `scheduled_jobs`
- [x] The move has three steps: a first database transaction saves the chosen name in each row, with the argv in place; then the one config write of the `jobs` entries; then a second transaction sets `moved_at` on each moved row and replaces its argv columns with the encrypted text `[]`, so the argv leaves the encrypted database; after that, the `jobs` table is the only copy of that argv: `config.json.pre-jobs` never held it, and the release before refuses a database at schema version 14
- [x] A restart after a stop between the steps reads the saved name and does only the steps that remain: a row with no `moved_at` whose saved name is in the table gets the last step only, and no entry is written again
- [x] The columns `cwd`, `interval_ms`, `cron_expr`, `enabled` and `notify_identity` of a moved row are not read again; they stay in the table, and no slice removes them
- [x] The move runs in `cmdServe` after `migrateServicesKey`, under the config lock, at each daemon start; only the row move writes `jobsVersion: 2`, and this slice changes `JOBS_VERSION` to 2, so each CLI write waits for the row move through the guard of slice 8
- [x] A row label that fails the name rule, or that is the name of another entry, gets a new name by one fixed rule: make the text lower case; replace each character that is not `a-z`, `0-9` or `-` with `-`; remove each `-` at the start; cut the text at 64 characters; use `job` when no character is left; when the result is the name of another entry, add `-2`, then `-3`, and so on, and cut the base so that the full name has 64 characters at most
- [x] The runner reads the `schedule` and `every` entries of the table at each tick and makes a state row for an entry that has none; that state row gets `moved_at` at once, the label, the argv `[]`, a `cwd` and `interval_ms` or `cron_expr`, and its first run time is the value that `job add` sets on master
- [x] The runner starts a run with `launcher.ts`: the allowlist, `passEnv`, `envFile`, the injected keys, the state folder and the grant keys
- [x] With `feed: true`, the launcher gives stdout to `parseFeedLines` as today and writes stderr to `<log>/service-<name>.log`; with no `feed`, stdout and stderr go to that log file and the exit code is the result
- [x] `timeoutMs` ends the process group of a run at the limit and records the error `timed out after <duration>`; an explicit `timeoutMs` is not clamped; with no `timeoutMs`, a `feed: true` run keeps the 30 s limit and the 256 KB output limit of today (`resolveLimits`), and a run with no `feed` has no default limit [DECIDED — gaps pass O5 (b)]
- [x] A failed run records its result and is not started again before the next scheduled time
- [x] When a run of a job is in progress at its next scheduled time, skip that time and write one log line `job <name>: skipped a run, the run before it is not complete`
- [x] At daemon start, a job whose next run time is in the past runs one time, and its next run time is then calculated from now: one catch-up run after downtime, not one for each missed time
- [x] `addScheduled` writes a table entry with no `enabled` key for the new form; an add with the alias `--label` or `--cron` sets `enabled: true` and `feed: true`, so a script of today gets the result of today [DECIDED — gaps pass X2 part 1 (a)]
- [x] `setScheduledEnabled` sets `enabled` in the table; `enable` of a scheduled job prints the next run time
- [x] `JobControl.start` of `control.ts` runs a scheduled entry one time and returns at once with the state `running`, `JobControl.stop` ends a run in progress, and `JobControl.status` gives a row for each scheduled entry with its next run time and last result; do not edit `http.ts`
- [x] `runScheduledNow` asks the daemon for one run (`POST /jobs/<name>/start`), and `job start` prints one status line; a second start during the run exits 1 with `job "<name>" already runs`; with no live daemon it exits 1 with `no live dg-daemon`
- [x] `job run` worked with no daemon on master and now needs one: slice 11 documents it, and job-exec.spec.ts tests the new result
- [x] `findScheduled`, `listScheduled` and `removeScheduled` read and write the table; `removeScheduled` also deletes the state row and its feed items, as `job rm` does today
- [x] `isDaemonIdle` counts the enabled scheduled entries of the table
- [x] Do not edit `commands/jobs.ts` or the completion tree, with one exception: this slice deletes the interim rules of slice 9 from jobs.ts and job-logs.ts, and that delete changes no command name, option or description [DECIDED — post-apply item 8 (a)]
- [x] For each renamed row, write one log line `scheduled job "<old>" is now "<new>"`; at the move, `label` becomes the entry name and `renamed_from` holds the old label; `listScheduled` gives `renamedFrom` from that column, and `job list` of slice 9 prints it; `label` is then the one key of the runner, `findScheduled` and `removeScheduled`
- [x] Do not change a command name, an option or a description: this slice does not own pkg/dg-daemon/src/completion-tree.json
- [x] A row that cannot move (its argv does not decrypt, its cron text is not valid, its `cwd` is gone, or its entry fails `parseJobEntry`) stays in place with no `moved_at`; the daemon logs one warning with the label and the reason and writes the mark 2; `job add` refuses its label with the `already exists` text, and `job list` shows the row as `invalid` [DECIDED — gaps pass O4 (a)]
- [x] Rewrite the run loop: a tick starts each due run and does not wait for it; a set of the names in progress gives the skip and its log line
- [x] Scheduled runs do not use the limit for each session or the limit for each minute of `DispatchScheduler`, and keep the one daemon-wide limit
- [x] `JobControl.stop` and the daemon shutdown end the process group of each run in progress (`killProcessGroup`)
- [x] A daemon that ends with SIGKILL leaves a run alive, and a scheduled run has no pid file guard: slice 11 documents it
- [x] New launcher options for a run: stdout through a pipe for a `feed` run, with the output limit on that pipe; stderr to the log file; a result `{ exitCode, timedOut }`
- [x] The runner keeps one function that a spec can inject, with the `ExecResult` shape of today (runner.spec.ts, tick.spec.ts and job-exec.spec.ts use it)
- [x] List in the PR body what changes for a moved job: the environment gets the `DG_SERVICE_*` keys, `envFile` and `passEnv`; the timeout text becomes `timed out after <duration>`; stderr goes to the log file and not to the `last_stderr` column
- [x] Store changes in store/index.ts: `recordJobRun` takes the next run time from the caller, not from the row columns; a manual run (`job start`) records its result and does not move `next_run_at`
- [x] Add to the store the methods of the three-step move, and the insert and the lookup of a state row by label
- [x] bootstrap.ts and idle.ts count the enabled entries of the table, not `countEnabledJobs`
- [x] When the `every` or `schedule` text of an entry is not the text of the last run, the next tick calculates `next_run_at` again
- [x] `addScheduled`, `setScheduledEnabled` and `removeScheduled` now write the config file: they call `ensureMigrated`, then `withConfigLock` and `guardConfig` of job-support.ts
- [x] They use the name rule, the `already exists` text for a name in the table and for a label of a row that is not moved, and `resolveExecutable` for the `cwd` and executable checks; they store `feed` and `timeoutMs`
- [x] `removeScheduled` deletes the state row first, then the entry
- [x] Update pkg/dg-daemon/__tests__/commands/jobs.spec.ts: it asserts SQLite rows after `job add` and runs `job run` with no daemon
- [x] `migrateScheduledRows` reads with `readConfigStrict`, adds each entry, and writes with one `writeFilePreserving(file, data, 0o600)` call inside migrate.ts; it does not edit config-store.ts
- [x] `enable` of a scheduled entry follows the path of a continuous entry (daemon start, login question), then prints the next run time
- [x] Remove the three interim rules of slice 9 for a scheduled row in SQLite (`enable`, `disable` and `remove` by the path of master; the `logs` text; the `update` text) and the `take effect after the jobs move` note, with their Contracts in pkg/dg-daemon/__tests__/commands/job-verbs.spec.ts

#### Testing Criteria
##### Contracts
- [x] Contract: a row `{ label: "jira-sprint", interval_ms: 900000, enabled: 1, notify_identity: "reviewer" }` becomes the entry `{ argv, cwd, "every": "15m", "enabled": true, "feed": true, "notify": "reviewer" }`; the row keeps its `id`, its `next_run_at` and its feed items, has a `moved_at` value, and its argv columns decrypt to `[]`
- [x] Contract: with an injected stop after the config write, the next daemon start sets `moved_at`, clears the argv and writes no second entry
- [x] Contract: with `jobsVersion: 1` and one row that is not moved, `job add --name <that label> …` does not write before the daemon made the move; after it, the command exits 1 with the `already exists` text
- [x] Contract: a second daemon start moves nothing and writes no file
- [x] Contract: a row label `Jira Sprint` becomes `jira-sprint`; the label `-Nightly!` becomes `nightly-`; a label of 80 characters becomes its first 64 characters; the log line names the old and the new name; `job list` shows the new name
- [x] Contract: a row label `bot` on a machine with a continuous job `bot` becomes `bot-2`, and with `bot-2` also in the table it becomes `bot-3`; the continuous entry does not change
- [x] Contract: after the move, the next run time of each job is the `next_run_at` from before
- [x] Contract: a scheduled job with no `feed` that prints text that is not JSON has the result `ok`, and the log file holds the text
- [x] Contract: a scheduled job with `feed: true` that prints text that is not JSON has the error `line 1: not valid JSON`, as today
- [x] Contract: a scheduled run gets `DG_SERVICE_LABEL`, `DG_SERVICE_STATE_DIR` and, with a `grant`, the two grant keys
- [x] Contract: a run that exits 1 at 10:00 with `every: "1h"` has its next run at 11:00 and no run between
- [x] Contract: with `every: "1s"` and a command that runs for 3 s, the log holds the `skipped a run` line and no two runs overlap
- [x] Contract: a daemon that was down for five intervals runs the job one time at start, not five times
- [x] Contract: a run that exceeds `timeoutMs` ends, and the result holds `timed out after`
- [x] Contract: `job start x` on a scheduled job with a live daemon runs it one time and does not change its next scheduled time
- [x] Happy path: a daemon boots on a store with two rows; the two jobs run at their times; the feed has no duplicate item
- [x] Regression: `bun test` passes in pkg/dg-daemon and pkg/common; `tick.spec.ts`, `runner.spec.ts` and `job-exec.spec.ts` pass with only their setup changed; the run also holds pkg/dg-agent/__tests__/job-notify.spec.ts and, with `PW_E2E`, pkg/skills-cli/__tests__/dashboard-browser.spec.ts, which pass only through the move at daemon start
- [x] Contract: `job list --json` gives a renamed job the key `renamedFrom` with the old label
- [x] Contract: pkg/dg-daemon/__tests__/completion-tree.spec.ts passes with no change of the tree file
- [x] Contract: after the services move, with one row that is not moved, the mark is 1 and `isMigrated` is `false`
- [x] Contract: a config with no `services` key and a store with no row gets the mark 2
- [x] Contract: a stop after the config write, on a row that got a new name, gives no second entry
- [x] Contract: a daemon restart after `job add --every` moves nothing and writes no entry
- [x] Contract: one case each for the move of a cron row, of a disabled row and of a row with no `notify_identity`
- [x] Contract: one case for each cause of a row that cannot move (an argv that does not decrypt, a cron text that is not valid, a `cwd` that is gone, an entry that fails `parseJobEntry`): the row stays, one warning names the label and the reason, the mark is 2, and `job list` shows `invalid` [DECIDED — gaps pass O4 (a)]
- [x] Contract: a run with `timeoutMs: 60000` that takes 45 s ends with the result `ok` [DECIDED — gaps pass O5 (b)]
- [x] Contract: two calls of `migrateScheduledRows` at the same time give one move

#### Acceptance Criteria
- [x] Given scheduled jobs from before the upgrade, when the new daemon boots, then each job runs at its old time with its old feed
- [x] Given `dg job list`, when the owner reads it, then continuous and scheduled jobs are in one list
- [x] Given a scheduled job, when it runs, then its output is in a log file that `dg job logs <name>` shows

### Slice 11 — job-model-docs

#### Engineering
- [x] Run `git fetch origin` first, then take the record number from `git ls-tree origin/master docs/adr` before you write the file: the number is the highest number in docs/adr plus one (two files have 0046, so do not count files); use it in the file name, the toc row and each link
- [x] Rebase on origin/master before the first edit of this slice
- [x] Write the jobs record docs/adr/<number>-jobs.md with the headings of docs/adr/template.md, a `Date:` header, `Status: Accepted` and exactly one fenced `mermaid` block: one noun, the three mode keys, the one table, the one launcher, the run rules of the two modes, the two migrations at daemon start, the backup file, the alias forms and their end in the major release, the pid and log paths that do not move, and the service API names that keep the word `SERVICE`
- [x] The jobs record states one cost: the argv of a scheduled job is now plain text in a config file with mode 0600, and no longer encrypted text in the database
- [x] Add one sentence to the amendment of ADR 0020 that slice 7 wrote: the job model is in the jobs record, with a link
- [x] Rewrite `docs/jobs-and-services.md` with `job` for each concept; the file path stays, so each link stays valid
- [x] The document has one table: old command → new command
- [x] plugins/dg/skills/jobs/SKILL.md gives the new verbs and flags in the form `dg-daemon job …` in the new section `## Job verbs`: the skills keep the program names `dg-skills`, `dg-agent` and `dg-daemon`; SKILL.md keeps each line that holds `channel-review` or an old form, and slice 21 removes the old forms [DECIDED — gaps pass O6 (a)]
- [x] The docs spec proves each documented command with its `--help` form
- [x] In docs/adr/0043-outside-services.md, add one dated line after the `Date:` line and after the line of slice 7: `Amended <date>: the noun is now job; see <link to the jobs record>.`; the line does not start with `Status:`; change no other line of that record
- [x] The jobs record also holds the login unit rules: `dg-daemon autostart`, and the one question of the first `job enable` at a terminal
- [x] Add the row of the jobs record to docs/adr/toc.md after the 0043 row of `## Platform`, in 160 columns at most
- [x] In pkg/skills-test/__tests__/outside-services-docs.spec.ts, change the one assertion of the test `toc entry is last in Platform` so that it finds the 0043 row by its pattern
- [x] In docs/jobs-and-services.md, add one table of the verbs: `enable` and `disable` change the stored `enabled` state and act now; `start`, `stop` and `restart` act now only; `add`, `update` and `remove` change the definition of a job
- [x] That table has a column `needs a live daemon` with a value for each of the twelve verbs of PR 2: `enable` starts the daemon when none runs; `disable` starts none; `disable` and `remove` need an answer from a daemon that runs; `restart`, and `start` of a scheduled job, need a live daemon; `logs` needs none; `list` and `status` print `daemon not running`
- [x] One sentence gives the difference between `dg daemon restart` (the daemon) and `dg job restart <name>` (one job)
- [x] The document states the run rules: a continuous job that exits with 0 stops, and each other exit starts it again with a backoff of 1 s to 60 s; a scheduled job gets no second try after a failure, a run that overlaps is skipped, and one catch-up run follows downtime
- [x] The document states the migration: the first start of the new daemon moves each service and each scheduled job to the `jobs` table, keeps the copy `config.json.pre-jobs`, and gives a new name to a scheduled label that is not a valid name; it gives the rename rule in short form (lower case, `-` for each other character, 64 characters at most, `-2` for a clash, `job` when empty), the log line `scheduled job "<old>" is now "<new>"`, and that `dg job list` shows `was "<old>"`
- [x] The document states that `feed` is explicit for a new job and is valid only for a scheduled job: a job with `--feed` prints one JSON object for each item, and a job with no `--feed` writes its output to its log; a moved scheduled job and an `add` with the alias `--label` or `--cron` get `feed: true`
- [x] The document states that each `dg job` verb prints the dg home and the daemon on stderr
- [x] The document updates the section `Start at login` of slice 7: the first `dg job enable` at a terminal asks one time to install the login unit
- [x] Verify that README.md and docs/install.md hold no command of the `dg-daemon service` group; do not change the message literal `dg: kept <from>; stop the dg-daemon service, then run dg-skills install again` in docs/install.md; in README.md, change the link text `Scheduled jobs, services, and dashboard` to use the noun `job`, and keep the path and the blank lines around the next bullet
- [x] In SKILL.md, put the new commands in the new section, and keep each channel-review section, the bootstrap fence, the SessionStart hook fence and the frontmatter `description` byte-identical, with two exceptions: the sentence on no autostart for `dg-daemon` itself now points to `dg-daemon autostart install`, and one new line above the action table points to `## Job verbs` [DECIDED — gaps pass O6 (a)]
- [x] In SKILL.md, state that `remove`, `disable` and `autostart install|remove` need a request from the human that names the job or the login unit
- [x] pkg/skills-test/__tests__/outside-services-docs.spec.ts: change the assertions that read `dg-daemon service` commands or the word `autostart` in docs/jobs-and-services.md to the new text; keep the tests on ADR 0043, SECURITY.md and docs/service-api.md
- [x] These tests of that spec change with the rewrite: `gives run steps in order`, `shows service add with a positional label`, `states the four corrected statements`, the `restart … only … autostart` pattern, and the path literals `<log>/service-<label>.log` and `<state>/daemon/services/<label>.pid`; these tests stay, because SKILL.md keeps its old lines: `covers the new actions and the gating rules` and `carries the final no-daemon message`
- [x] Write no private organization name and no private repository name in a document; name the consumer `the review bot repository` and use `bot` and `bot-dev` in each example
- [x] Create pkg/skills-test/__tests__/job-model-docs.spec.ts; it asserts: the fixed headings of this slice; the rows of the old → new table; the `needs a live daemon` column; the `--help` form of each command; the jobs record (the `Date:` header, one `mermaid` block, the fixed rule phrases that the document also holds); the toc row; the fixed text of SKILL.md
- [x] In pkg/skills-test/__tests__/dg-front-door-docs.spec.ts, add the jobs record to the document list; change nothing else in that spec
- [x] Fix the headings: `## Job verbs` (the verb table) and `## Old and new commands` (the old → new table) in docs/jobs-and-services.md, and `## Job verbs` in SKILL.md; slices 20 and 21 find their places by these headings
- [x] In SKILL.md and in the jobs record, state that the skill does not answer the login unit question of `job enable`, and that `enable` with no terminal only prints the hint; keep the sentence like the consent sentence of slice 20
- [x] In the hunk of SKILL.md that adds the new section, change the example label `teams-bot` to `bot` [DECIDED — gaps pass O7 (b)]
- [x] The document and the jobs record state the rollback: copy `config.json.pre-jobs` back; the release before refuses the database after the row move
- [x] The document and the jobs record state that a run that stays alive after a SIGKILL of the daemon can overlap the next run
- [x] The document and the jobs record state that `dg job start` of a scheduled job, and the alias `run`, need a live daemon
- [x] The document and the jobs record state what the owner does when a daemon of the release before still runs: a `dg job` verb that writes waits 10 s at most, then stops with the `not migrated` text and the pid of that daemon; the owner runs `dg daemon restart`, then the command again; dg never restarts that daemon itself [DECIDED — gaps pass O3 (a)]
- [x] The document and the jobs record state the limits of a scheduled run: an explicit `--timeout` is not clamped; with no `--timeout`, a run with `--feed` has the 30 s limit and the 256 KB output limit, and a run with no `--feed` has no default limit [DECIDED — gaps pass O5 (b)]

#### Testing Criteria
##### Contracts
- [x] Contract: `docs/jobs-and-services.md` holds no `dg-daemon service` outside the old → new table
- [x] Contract: each command in a code block of the document passes its `--help` form on a build of this branch; the command is the words up to the first flag or placeholder; the spec runs it with the kit of slice 7 (pkg/skills-test/__tests__/docs-help-kit.ts: `bun pkg/dg/src/index.ts <words> --help` in the fence), runs the old forms of the table as `dg-daemon … --help`, and sets a test timeout
- [x] Contract: no code block of the document shows a verb of PR 3 (`setup`, `add <url>`, `add <path>`, `--credential`)
- [x] Contract: docs/adr/toc.md holds one link to the jobs record, the file exists, and ADR 0043 links it
- [x] Regression: `bun test` passes in pkg/skills-test
- [x] Contract: the old → new table holds one row for each of: `dg-daemon service add|rm|status|start|stop`, `dg-daemon job add --label`, `--cron`, `--pass-env`, `job rm`, `job run` and `job exec`, `--autostart` (now `enabled`, set by `dg job enable`), `--env-file`, `--grant` (dg sets `grant`; the old option stays on `dg-daemon service add`), and `service add <label>` with its positional label (now `--name`)
- [x] Contract: each `dg <name>` in a code span or a fenced block of the changed documents is a name of `ROUTES`; pkg/skills-test/__tests__/dg-front-door-docs.spec.ts passes
- [x] Check (manual): `git diff <base of PR 2> -- docs/adr/0043-outside-services.md` shows one added line and no removed line; the spec proves the same rule with fixed text: ADR 0043 has an unchanged `Status:` line and one dated line of this slice
- [x] Check (manual): `git diff <base of PR 2> -- plugins/dg/skills/jobs/SKILL.md` shows no hunk in a line that holds `channel-review`, in the bootstrap fence or in the SessionStart JSON fence, with three permitted changes: the sentence `There is no autostart for dg-daemon itself` in `## Autostart` (the line before it, which holds `channel-review start`, can be diff context only); the one new line above the action table that points to `## Job verbs`; and the line that changes the example label to `bot`
- [x] Contract: job-model-docs.spec.ts proves the SKILL.md rules with fixed text: the bootstrap fence, the SessionStart fence and each line of SKILL.md that holds `channel-review` are equal to literals or hashes in the spec
- [x] Contract: the jobs record has a `Date:` header and holds the same rules as the document
- [x] Check: `bun scripts/skill-bootstrap-block.ts --check` exits 0; do not run it with `--write`
- [x] Check: each relative link in the changed documents opens an existing file
- [ ] Check: markdownlint and vale pass on the changed files; the record has exactly one fenced `mermaid` block, below the heading `## Diagrams` of docs/adr/template.md
- [ ] Check (manual, before the commit; no spec): the private-name Check of slice 7: the orchestrator gives the private-name list at run time from the local decision log, which is outside the repository; run a case-insensitive search of the changed files and report only `found` or `not found`; job-model-docs.spec.ts holds no private name
- [x] Contract: docs/jobs-and-services.md holds the headings `## Job verbs` and `## Old and new commands`, and SKILL.md holds `## Job verbs`
- [x] Contract: the amendment of ADR 0020 gets one added sentence and no removed line, and the `Status:` line is unchanged

#### Acceptance Criteria
- [x] Given docs/jobs-and-services.md, when a reader looks for a command of the release before, then one table gives the new command
- [x] Given docs/jobs-and-services.md, when a reader looks for the difference between `enable` and `start`, then one table gives it
- [x] Given the jobs skill, when an agent reads it, then it finds each new verb and the rule that `remove` and `disable` need a request from the human
- [x] Given docs/adr/toc.md, when a reader opens the link of the jobs record, then the record describes the job model with the status Accepted

### Slice 12 — job-credential-route

#### Engineering
- [x] Serve `POST /jobs/<name>/credentials` with the guards of the job route: loopback `Host` (`requireLoopbackHost`), the owner token, and its own check that refuses each `Origin` header; it does not use `refuseForeignOrigin`, which permits the pinned extension origin; the check order is Host, Origin, owner token, job lookup, content type, body
- [x] The prefix of a request is the `grant` of the entry `<name>` in the `jobs` table; the body cannot give a prefix
- [x] The body is JSON with `Content-Type: application/json` and 128 KiB at most
- [x] Operation `status`: `{ prefix, grant: "ok" | "missing" | "stale", credentials: [{ name, meta, updatedAt }] }`, only names below `<prefix>/`
- [x] Operation `set` with `name`, `value`, `meta`: the name must be below `<prefix>/`; use `validateCredentialName`, `validateCredentialValue` and `validateCredentialMeta`
- [x] Operation `delete` with `name`: the same name rule
- [x] Operation `ensure-grant`: make the grant and write the token file only when the grant row is absent, the token file is absent, or the token of the file fails `verifyCredentialGrant`; answer `{ created, path }`; `createCredentialGrant` makes a new token at each call, so a call for each `enable` would break a job that runs with the same prefix
- [x] Operation `rotate-grant`: always make a new token and write the file
- [x] No answer and no log line holds a value or a token; call `noteSecret` for each value
- [x] Add `RESERVED_CREDENTIAL_PREFIXES = ["pw", "extension", "phone-friend", "phone-vault", "db"]` to `pkg/common/src/credentials-format.ts` (`db` is `CREDENTIAL_PREFIX = "db/"` of pkg/skills-cli/src/db/credentials.ts); the route refuses a job whose prefix is in the list
- [x] `reserved-credential-prefixes.spec.ts` reads the source text by path, not by import: pkg/common/src/credentials-format.ts, pkg/dg-daemon/src/server/credentials.ts, pkg/dg-agent/src/phone/keys.ts and vault.ts, and pkg/skills-cli/src/db/credentials.ts; it fails when a source constant (`CREDENTIAL_SEALED_PREFIX`, `EXTENSION_CREDENTIAL_PREFIX`, `GRANT_PREFIX`, `VAULT_GRANT_PREFIX`, `CREDENTIAL_PREFIX`) is not in the list; match the `GRANT_PREFIX` line of keys.ts, and list `PW_EXT_CREDENTIAL_PREFIX` of pw-ext-credential-format.ts as the same value as `pw`
- [x] `createJobCredentialClient({ paths, job })` in `pkg/common/src/node/job-credentials-client.ts` has `status`, `set`, `delete`, `ensureGrant` and `rotateGrant`; it sends the owner token with `requireOwnerToken`
- [x] Each refusal of the route is JSON `{ ok: false, error }`, and an unknown job answers 404 with the error `no job named "<name>"`; the client turns a 404 whose body is not that JSON shape into `DgCliError("this dg-daemon is older than the CLI — run dg daemon restart")`
- [x] Do not change the `/cli` socket, `dg-skills credentials` or the service API route
- [x] The route is write-only for one prefix: it has no operation that returns a value, and the owner token already lists each session token (`/sessions/local`), so the route adds no authority
- [x] The route file is pkg/dg-daemon/src/server/job-credentials.ts; pkg/dg-daemon/src/server/http.ts gets only the route match and the call
- [x] The route reads the `jobs` table at each request through one dep `readJobs()` (`parseJobs` of the result of `readConfigStrict`), not from the memory of the supervisor; `HttpServerDeps` gets `readJobs`, and pkg/dg-daemon/src/server/bootstrap.ts gives it in one line
- [x] Move `isJsonContentType`, `readJsonObject` and `STORAGE_FAILED` from service-api.ts to pkg/dg-daemon/src/server/capped-body.ts; service-api.ts and the new route import them; write no copy
- [x] An unknown operation, a body with no `operation`, an extra body key and a `name` that is not a string answer 400; a method other than POST answers 404; only `"get"` answers 403
- [x] Define `grant` of `status`: `missing` is no grant row and no token file; `stale` is a row or a file that exists while the token of the file fails the check, or a row with no file; `ok` is a row whose file token verifies
- [x] `status` and `ensure-grant` use a new store method that verifies and does not write `last_used_at`
- [x] In `ensure-grant`, the check, `createCredentialGrant` and the file write run with no `await` between them
- [x] `rotate-grant` ends the token of each job that shares the prefix

#### Testing Criteria
##### Contracts
- [x] Contract: 401 with no owner token or an incorrect one; 400 with an `Origin` header; 400 with a `Host` that is not the loopback authority; 404 with the error `no job named "<name>"` for an unknown job; 409 with `job "<name>" has no credential prefix`; 403 for a name outside the prefix and for a reserved prefix; 413 above 128 KiB; 415 for another content type; 200 for success; each refusal is JSON `{ ok: false, error }`
- [x] Contract: no operation has a `get`; a body with `"operation": "get"` gives 403
- [x] Contract: `ensure-grant` two times: the second answer has `created: false`, and the token file bytes are equal
- [x] Contract: `ensure-grant` after a delete of the token file has `created: true`
- [x] Contract: after `set` and `ensure-grant`, a `get` on `/service-api/v1/credentials` with the token of the file gives the value
- [x] Contract: no response body and no daemon log line of the spec run holds the value text
- [x] Contract: `set` for the job `a` with the name `b/x` gives 403 and stores nothing
- [x] Error: with the credential store closed or broken, each operation gives 500 with the text of the service API
- [x] Regression: `bun test` and `bun run lint` pass in pkg/dg-daemon, pkg/common and pkg/skills-test
- [x] Contract: after `job add` on a live daemon, the route finds the new job with no daemon restart
- [x] Contract: a plain value of 65536 bytes passes `set`; a value that JSON escapes push above 128 KiB gets 413 (accepted)
- [x] Contract: a request with an `Origin` and no token answers 400
- [x] Contract: an unknown job on a new daemon does not give the `older than the CLI` text in the client
- [x] Contract: one case each: an unknown operation, a body with no `operation`, an extra body key and a `name` that is not a string answer 400; a method other than POST answers 404
- [x] Contract: one case for each `grant` state of `status`: `missing`, `stale` and `ok`
- [x] Contract: two `ensure-grant` calls at the same time give exactly one `created: true`, and the file token verifies
- [x] Contract: a row with a new token and an old file is `stale`, and the next `ensure-grant` repairs it
- [x] Contract: `rotate-grant` gives a new token, the old token fails, and the file has mode 0600
- [x] Contract: one case for `delete` of a name that exists, and one for a name that does not
- [x] Contract: the shape of `status`: only names below the prefix, with `meta` and `updatedAt`, and no value
- [x] Contract: `set` with a name, a value or a meta that is not valid answers 400 with no echo of the value; `set` with no `meta` passes, because `meta` is optional in the route and in the client
- [x] Contract: the names `a` and `ab/x` for the prefix `a` answer 403; `A/x` is folded as `validateCredentialName` does
- [x] Contract (client spec): each method sends the owner token header and the right body, and no error text holds a token or a value
- [x] Check (manual, before the commit; no spec): the private-name Check of slice 7 on the changed files; the fixtures use `bot`, `a` and `b`

#### Acceptance Criteria
- [x] Given a daemon with no agent session, when the CLI stores a credential for a job, then the store holds it and the job can read it with its grant
- [x] Given two jobs with one prefix, when the second job gets its grant, then the token of the first job stays valid

### Slice 13 — job-add-git

#### Engineering
- [x] `classifySource(argument)` in pkg/dg-daemon/src/commands/job-source.ts gives `git`, `path` or an error: refuse a leading `-`; refuse `ext::` and `fd::`; a value with `<scheme>://` is git; a value that matches `^[^/\\]+@[^/\\:]+:` is git; a value that starts with `./`, `../`, `/`, `~` or a drive letter with `:\` or `:/` is a path; each other value exits 1 with `job add: "<value>" is not a path or a URL — for a local file write ./<value>`
- [x] In this slice a path exits 1 with `job add: a local path is not supported yet`; slice 16 replaces that branch
- [x] pkg/dg-daemon/src/commands/jobs.ts sends each `add` with one positional argument to job-source.ts, with or without text after `--`, by the result of `classifySource`, and asks job-source.ts for the record of a job in `remove` and `update`; load job-source.ts with a lazy import
- [x] A local git repository is a clone source only as `file://<path>`; a path with no scheme is a local job of slice 16
- [x] A mode flag, `--timeout`, `--feed`, `--notify`, `--cwd`, `--env`, `--env-file`, `--stop-timeout`, `--cron` or `--pass-env` with a URL exits 1 with `job add: the repository declares this in its "dg" block`; `--label` is `--name` and is permitted; the code reads the option value source of commander to know that the user gave a flag
- [x] A URL with a command after `--` exits 1 with `job add: a URL takes no command after --` and starts no git process
- [x] Create pkg/dg-daemon/src/jobs/sources.ts: a strict reader and a writer for `paths.jobSourcesPath`; the file is one JSON object keyed by source name; a record of a repository is `{ kind: "git", url: string, ref: string | null, sha: string, jobs: string[], declarationHash: string, credentials: object }`
- [x] The registry reader returns `{}` when the file is absent, and throws an `Error` that names the file when the content is not a JSON object
- [x] The registry writer uses `writeFilePreserving(file, data, 0o600)` and keeps the records of the other sources
- [x] Create pkg/dg-daemon/src/jobs/declaration.ts: `parseJobDeclaration(packageJson: unknown, { source, sourceDir, stateDir }: { source: string; sourceDir: string; stateDir: (name: string) => string })` reads the `dg` key and returns `{ ok: true, jobs, credentials, requires, build } | { ok: false, error }`; it does not throw; `jobs` holds one entry for each name of `dg.jobs`, with `cwd` set to `sourceDir` and `grant` set to `source` by the `grant` rule of this slice, and `credentials` holds the credential details
- [x] `parseJobDeclaration` is pure: it checks the shape, fills `cwd` and resolves `envFile`; it reads no file and no PATH
- [x] `parseJobDeclaration` returns errors with no command prefix; the caller adds `job add:` or `job update:`, and the caller builds the text `<url> has no "dg" key in package.json`
- [x] `parseJobDeclaration` accepts the `dg` keys `jobs`, `credentials`, `requires` and `build`; it names each other key in the error
- [x] A job of the block accepts `argv`, one mode key (`continuous`, `schedule` or `every`), `feed`, `notify`, `credentials`, `timeoutMs`, `envFile` and `stopTimeoutMs`; the keys `grant`, `cwd`, `enabled` and `passEnv` are refused by name; each other key is in the `unknown key(s)` error
- [x] Each job entry passes `parseJobEntry` of slice 8 after dg adds `cwd` and `grant`, so a block and a command job follow one rule set
- [x] This slice writes a scheduled entry as the block gives it; slice 10 owns the run of a scheduled entry, and no spec of this slice runs one
- [x] The `credentials` list of a job is an array of names; the block key `credentials` is an object that gives details for a name of such a list: `prompt` (string, 200 characters at most), `required` (boolean, default `true`), `meta` (object: key → `{ prompt, default? }`) and `source`
- [x] A name in a job list with no details is required, and its prompt is the name; a details key that no job lists is an error
- [x] `<source>/<name>` must pass `validateCredentialName`, so the length of a name is the limit of that check; a block has 16 credential names at most, counted as the different names of all job lists; a name is in one job list one time at most
- [x] A `meta` key that matches `/value|secret|token|password/i`, or that is `provider` or `createdBy`, is refused: `validateCredentialMeta` refuses such a key at the store; also refuse the block `meta` keys `scopes` and `expiresAt`: the store gives them a structure that a text answer cannot have
- [x] `source` accepts one shape and no other: `{ "type": "aws-secretsmanager", "secretId", "region", "key"?, "profile"? }`; the `type` key is necessary, so a later bundle can add a type
- [x] Each value of a `source` is a string that does not start with `-`; `region` matches `^[a-z0-9-]+$`; each other key of a `source` is an error that names the key
- [x] A `source` is data only: the block cannot give a command, and this slice starts no `aws` process
- [x] `declarationHash` is the SHA-256 hex of the JSON text of the `dg` value with object keys sorted at each level; it covers `credentials`, so a change of a credential asks again at `update`
- [x] Export from job-source.ts the deps type of the source commands, `JobSourceDeps extends JobVerbDeps` (slice 9): it adds only `runGit(args, options): Promise<{ code, stdout, stderr }>` and `runBuild(argv, cwd): Promise<number>`; `confirm`, `isTerminal` and `which` come from the base type; each action takes it as a seam
- [x] Export `declarationHash` from declaration.ts, and `formatRequest` and `resolveRef` from job-source.ts; `sanitize` is in the new file pkg/dg-daemon/src/jobs/sanitize.ts with its spec pkg/dg-daemon/__tests__/jobs/sanitize.spec.ts, not in job-source.ts, and `formatRequest` imports it; slice 14 calls these exports, and slices 14, 15 and 18 import `sanitize` from that file
- [x] `job add <git-url>[@ref]`: remove a leading `<scheme>://`, then find the last `@` of the remaining text; it separates the ref only when the text before it holds a `/` or a `:`; with no ref, the value is `null` and the default branch of the remote is used
- [x] `add` refuses a URL or a ref that starts with `-`
- [x] The source name is the text after the last `/` or `:` of the URL, without `.git`, in lower case; `--name <source name>` replaces it; it is a folder name and a credential prefix, so it must match the job name rule of pkg/dg-daemon/src/jobs/config.ts (64 characters at most); a source name is not a job name
- [x] `add` refuses a source name of `RESERVED_CREDENTIAL_PREFIXES` (slice 12) with `job add: "<name>" is a reserved name — give another one with --name`
- [x] `add` refuses a source name that the registry holds
- [x] Before the clone, `add` refuses when the clone folder `jobSourceDir(paths, source)` exists
- [x] `add` runs `git -c protocol.ext.allow=never clone --no-recurse-submodules -- <url> <jobSourceDir(paths, source)>` in the CLI process with the environment of the caller; the daemon runs no git command
- [x] With a terminal, git gets the stdin of the caller; with no terminal, the git child gets `GIT_TERMINAL_PROMPT=0`
- [x] `resolveRef(deps, cloneDir, ref, url)` gives a full commit id; a value that matches `^[0-9a-f]{40}$` is checked only with `git cat-file -e <sha>^{commit}` and never as a tag or branch name [orchestrator, slice 14 security review]; another value runs, in this order: `git rev-parse --verify --end-of-options refs/tags/<ref>^{commit}`; `refs/remotes/origin/<ref>^{commit}`; for a value that matches `^[0-9a-f]{40}$`, `git cat-file -e <sha>^{commit}`; a ref that is a tag and a branch is the tag; `null` gives `origin/HEAD`; a ref that resolves to nothing, and a short commit id, exit 1 with `job add: ref "<ref>" does not resolve in <url>`
- [x] `add` checks out the commit id, not the ref text: `git checkout --detach <40 hexadecimal characters> --`
- [x] `add` reads the full 40-character commit id with `git rev-parse HEAD` after the checkout and stores it as `sha`
- [x] The clone runs before the question, so it must run no code of the repository: no `--recurse-submodules`, and no command of the `dg` block before the answer `y`
- [x] `add` refuses when a job name of the block is already in the `jobs` table of the daemon config
- [x] dg sets `grant` to the source name on each written entry whose `credentials` list is not empty; an entry with an empty list gets no `grant`; the block cannot change this
- [x] `add` prints the request before it asks: the source, the URL, the ref, the full sha, and for each job the `argv`, the mode key with its value, `feed`, `notify`, `timeoutMs`, `envFile` (the absolute path that the entry will store) and `stopTimeoutMs`
- [x] The request then shows the line `credential prefix: <source>/`, then one line for each credential with its name, `required` or `optional`, its `prompt`, its source type with each key of the `source`, and the jobs that list it; then `requires` and `build` as written in the block
- [x] Each text of the request that comes from the repository goes through `sanitize`, which replaces each control character (U+0000 to U+001F, U+007F to U+009F) and each of U+202A to U+202E, U+2066 to U+2069, U+200B to U+200F, U+FEFF, U+2028 and U+2029 with a visible escape of the form `\u{…}`; the first stderr line of git in `git clone failed: …` also goes through `sanitize`
- [x] On a terminal, `add` asks `Add these jobs? [y/N]`; only `y` or `yes` in any letter case continues
- [x] An empty line, an end of input and an interrupted read are the answer `no`
- [x] `add` accepts `--yes` for a URL: it prints the request, asks no question and continues as after the answer `y`, with a terminal or with none
- [x] When stdin or stdout is not a terminal and `--yes` is not given, `add` prints the request, then fails; it asks no question
- [x] `--yes` is the one option that gives consent; add no `--accept` option
- [x] The terminal check is the `isTerminal` seam of the deps type
- [x] Each `add` failure and a `no` answer remove the clone with `removeInside(paths.jobsDir, cloneDir)`, only when this run made the clone, and write nothing to the daemon config or the registry
- [x] An interrupt (Ctrl-C) between the clone and the write removes the clone
- [x] `add` takes the config lock of `withConfigLock` one time, after `build`; inside the lock it reads the registry and the config again and checks again that the source name and each job name are free
- [x] Inside the lock, `add` writes the registry record first, then each job entry through `writeJobEntry`; a process that stops between the two leaves a record with no entry, and `job remove <name>` removes it
- [x] When a step inside the lock throws, `add` removes the record and each entry that this run wrote (`writeJobEntry(paths, name, undefined)` removes an entry) and removes the clone; when the rollback also fails, the command prints the two errors and names what stays
- [x] `writeJobEntry` puts a written entry last in the `jobs` table; the order of the table is not a contract
- [x] `add` writes no `enabled` key; `job enable` sets it
- [x] `add` creates `jobStateDir(paths, name)` for each job with `ensurePrivateDir`
- [x] The record stores the `credentials` details that the owner saw; `enable` and `setup` of slice 15 read the record, not the file in the clone
- [x] Exit 0 prints `added jobs from "<source>" at <first 12 characters of sha>: <names joined with a comma and a space>`, then one line `next: dg job enable <name>` for each job
- [x] `job remove <job>` on a repository job uses the guards of the command-job `remove` of slice 9: `assertDaemonAnswers`, the refusal of a `running` or `backoff` job on a live daemon, and `assertNoLiveInstance`
- [x] `job remove <job>` on a repository job removes that entry and takes the name out of the record; when the record has no job left, it removes the record, then the clone with `removeInside(paths.jobsDir, cloneDir)`
- [x] `job remove` keeps each state folder, each stored credential and the grant; it prints `kept state: <path>`, and `kept credentials below <source>/` when the job lists a credential
- [x] `remove` is safe to run again: an entry, a registry record or a clone that is absent is not a failure
- [x] `job list` and `job status` show `<source>@<first 12 characters of sha>` on the row of a repository job; the `--json` row gets the keys `source`, `ref` and `sha`
- [x] New failures throw `DgCliError(message, EXIT_GENERAL_FAILURE)`
- [x] Build the fixture repository in a temp directory at test time (`git init`, one commit with a package.json that has a `dg` block), and clone it with a `file://` URL; do not add a git repository to the tree
- [x] pkg/dg-daemon/__tests__/commands/job-source-kit.ts exports `makeRepo({ dg, files }): { dir, sha }` and `commit(repo, { dg, files, tag, branch }): string`; slice 14 adds commits with `commit` and does not write the kit again
- [x] Test the consent step in process with the `confirm` seam of the deps type; a subprocess has no terminal
- [x] The specs that need a live daemon or a subprocess (the Happy path, Edge and Error lines of this slice) are in job-add-git.spec.ts and use daemon-harness.ts as it is; each other spec runs in process with the seams
- [x] No spec starts `git` with a network URL; the clone failure Contract uses a `file://` path that does not exist
- [x] The Contracts that say `start no git process` count the calls of the `runGit` seam
- [x] The specs make each executable in a temp folder and give it through the `which` seam; they do not use the PATH of the machine
- [x] Do not edit pkg/dg-daemon/src/main.ts, pkg/common/src/node/index.ts, pkg/dg-daemon/src/commands/job-support.ts or pkg/dg-daemon/__tests__/utils/daemon-harness.ts
- [x] Order of `add` for a URL: classify the argument; refuse `ext::`, `fd::`, a leading `-` and a password in the URL; refuse a flag that the block owns; make the source name and refuse a reserved name and a name that is already a credential prefix; check the registry; check that the clone folder is absent; clone; resolve the ref; check out the commit; read the commit id; read the block with `git show <sha>:package.json` (as `update` does, not from the working tree) and parse it; check the job names; check `requires`, each bare `argv[0]` name and `build[0]`; print the request; check `--yes` or the terminal; ask; run `build`; resolve each `argv[0]` path in the clone; take the lock; check the registry, the names and the prefix again; write the registry record; write the entries; print the result
- [x] The clone and its network traffic occur before the terminal check on purpose: with no terminal the command still prints the request
- [x] A relative `envFile` of the block resolves below `jobStateDir(paths, name)`; the stored entry holds the absolute path
- [x] `parseJobDeclaration` refuses an absolute `envFile`, and a relative `envFile` that leaves the state folder of its job (use `insideRoot`)
- [x] `add` does not create the env file; for each job with an `envFile` that does not exist, it prints the path after the result
- [x] job-source.ts resolves `argv[0]` of a block entry in two steps; before the question, a bare name must resolve with `resolveExecutable(name, "job add:", deps.which)` of job-support.ts (the third parameter of slice 9), and the result is the stored value; a name with a path separator uses only the clone step, not the path branch of `resolveExecutable`
- [x] After `build` and before the first write, a name with a path separator resolves from the clone folder; its real path (`realpathSync`) must be inside the real path of the clone, must exist and must be executable; the stored value is the absolute path inside the clone
- [x] `requires` is an array of executable names with no path separator; `add` checks each name with the `which` seam of the deps type before the question; the default of that seam is `Bun.which`
- [x] `build` is one argv: a non-empty array of non-empty strings; `add` runs it one time, after the answer `y` or `--yes` and before the first write, in the clone folder, with no shell, with the environment and the terminal of the caller
- [x] A `build` that does not start, or that exits with a code other than 0, fails the `add`: the clone is removed and nothing is written
- [x] A block with no `build` runs no command
- [x] After the option change, run `bun scripts/completion-trees.ts dg-daemon` and commit pkg/dg-daemon/src/completion-tree.json; do not edit the JSON by hand
- [x] Refuse a URL whose user part holds `:` with `job add: put no password in the URL — use a git credential helper or an ssh key`, before a git process starts; remove the user part from each URL that dg prints
- [x] Limits of a block: a package.json of 256 KiB at most; 16 jobs; 64 `argv` items for a job; 1024 characters for a string; 200 characters for a `meta` `prompt` and `default` [DECIDED — post-apply item 4]
- [x] Export `assertPrefixFree(name, config, registry, errorPrefix)` from job-source.ts: it refuses a name that is a reserved name, a job name of the `jobs` table, the `grant` of an entry or a key of the registry, with `<errorPrefix> "<name>" is already used as a credential prefix by <job or source name>` (for example `job add: "poll" is already used …`); it is the one clash check, and slices 15 and 16 call it
- [x] `add` of a URL calls `assertPrefixFree` for the source name before the clone, and again inside the lock with the other checks; `add` of a command job (jobs.ts) calls it for the job name
- [x] The record of this slice has no `prefixAccepted` key
- [x] A `git` program that is absent gives `job add: git is not installed` (check with the `which` seam, or catch the synchronous `ENOENT` of `Bun.spawn`)
- [x] A `build[0]` that does not start gives `job add: build did not start: <build[0]>`
- [x] `build[0]` follows the rule of `argv[0]`: a bare name resolves with the `which` seam; a name with a separator resolves from the clone folder, and its real path must be inside the clone; the check runs before the question, so the request shows the resolved path
- [x] The clone and the checkout run with `GIT_LFS_SKIP_SMUDGE=1` and `-c protocol.fd.allow=never` next to `protocol.ext.allow=never`
- [x] With no terminal, and when the caller has no `GIT_SSH_COMMAND`, set `GIT_SSH_COMMAND` to `ssh -o BatchMode=yes`
- [x] declaration.ts imports no git code and no `node:child_process`, because slice 17 imports it from the launcher
- [x] Until slice 14, `job update <job>` on a repository job exits 1 with `job update: a repository job is not supported yet`
- [x] sources.ts exports `findRecordByJob(registry, job)`; `remove`, `update` and the refresh operation of slice 18 use it

#### Testing Criteria
##### Contracts
- [x] Contract: the registry file is `{ "<source>": { "kind": "git", "url", "ref", "sha", "jobs", "declarationHash", "credentials" } }`; `sha` has 40 hexadecimal characters; `ref` is a string or `null`
- [x] Contract: `classifySource` gives `git` for `https://host/org/bot`, `git@host:org/bot.git`, `ssh://git@host/org/bot.git` and `file:///tmp/bot`; it gives `path` for `./bot.ts`, `../bot`, `/tmp/bot`, `~/bot.ts` and `C:\bots\bot.ts`; `bot.ts` exits 1 with the `is not a path or a URL` text
- [x] Contract: `parseJobDeclaration` on `{ "dg": { "jobs": { "bot-dev": { "argv": ["bun", "run", "bot.ts"], "continuous": true } } } }` gives one valid entry with `cwd` equal to the clone directory
- [x] Contract: a package.json with no `dg` key fails with `job add: <url> has no "dg" key in package.json`
- [x] Contract: a job key or a `dg` key that is not in the accepted lists fails with `job add: unknown key(s): <names>`
- [x] Contract: an entry that `parseJobEntry` refuses fails with `job add: job "<name>": <validator error>`
- [x] Contract: a block job with `"grant": "x"` fails with `job add: job "<name>": the key "grant" is set by dg`; the same form names `cwd`, `enabled` and `passEnv`
- [x] Contract: a block job with no mode key fails with the `give exactly one of` text of slice 8
- [x] Contract: a job with `"credentials": ["a"]` gets `grant` equal to the source name; a job with no `credentials` gets no `grant`
- [x] Contract: a `source` with `"type": "command"` fails with `job add: credential "<name>": unknown source type "command"`
- [x] Contract: a `source` with `"type": "azure-keyvault"` fails with `job add: credential "<name>": unknown source type "azure-keyvault"`; a `secretId` value `-x` fails with `job add: credential "<name>": "secretId" is not valid`
- [x] Contract: a `meta` key `apiToken` fails with `job add: credential "<name>": the meta key "apiToken" looks like a secret`
- [x] Contract: a details key that no job lists fails with `job add: credential "<name>" is not in the "credentials" list of a job`
- [x] Contract: a block with 17 credential names fails with `job add: a "dg" block can declare 16 credentials at most`
- [x] Contract: `git@host:org/bot.git@v1.2.0` gives the URL `git@host:org/bot.git`, the ref `v1.2.0` and the source `bot`; `git@host:org/bot.git` gives the ref `null`; `https://host/org/Bot` gives the source `bot`
- [x] Contract: `git@host:bot.git` gives the ref `null` and the source `bot`; `ssh://git@host/org/bot.git` gives the ref `null`; `https://host/org/bot@release/1.0` gives the ref `release/1.0`; `file:///tmp/bot@v1` gives the URL `file:///tmp/bot` and the ref `v1`
- [x] Contract: `job add https://host/org/bot@-x` exits 1 with `job add: a URL or a ref cannot start with "-"`, and starts no git process
- [x] Contract: a URL whose last segment does not match the name rule fails with `job add: cannot use "<segment>" as a source name — give one with --name`
- [x] Contract: `job add <url> --name tools` uses the clone folder `<data>/jobs/tools` and the credential prefix `tools/`
- [x] Contract: a source named `pw` exits 1 with the `reserved name` text and starts no git process
- [x] Contract: `job add <url> --every 15m` exits 1 with the `declares this in its "dg" block` text and starts no git process
- [x] Contract: `add` exit 0 prints `added jobs from "<source>" at <first 12 characters of sha>: <names joined with a comma and a space>`, then one line `next: dg job enable <name>` for each job
- [x] Contract: a second `add` of the same source name exits 1 with `source "<source>" is already added from <url> — run dg job update <job>`
- [x] Contract: a job name that the `jobs` table holds exits 1 with `job add: a job named "<name>" already exists`
- [x] Contract: a `no` answer exits 1 with `job add: declined; nothing was added`
- [x] Contract: a failed `git clone` exits 1 with `job add: git clone failed: <first line of the git stderr>`
- [x] Contract: after each failure, a clone directory that this run made is absent, and the bytes of the daemon config and of sources.json do not change
- [x] Contract: each written entry passes `parseJobs`, has an absolute `cwd` equal to `jobSourceDir(paths, source)`, and has no `enabled` key and no key outside the keys of `parseJobEntry`
- [x] Contract: the request text holds the credential prefix line and one line for each credential; a `prompt` with an ESC byte shows the visible escape
- [x] Contract: the request line of a credential with a source shows the type `aws-secretsmanager` and the values of `secretId`, `region`, `key` and `profile`
- [x] Contract: the record holds `credentials` deep-equal to the block value
- [x] Contract: with two jobs of one repository, `job remove <first>` keeps the clone and the record with one job; `job remove <second>` removes the record and the clone; the two state folders exist after it
- [x] Contract: `remove` exit 0 prints `removed job "<name>"`, then `kept state: <path>`
- [x] Contract: `remove` of a `running` or `backoff` repository job on a live daemon exits 1 with `job "<name>" is <state> — stop it first with dg job stop <name>`, and changes no file
- [x] Contract: with a daemon pid that is alive and does not answer, `remove` exits 1 with the `does not answer` text of `service rm` and changes no file
- [x] Contract: with an instance pid file that names a live process, `remove` exits 1 with the `still runs as pid` text of `service rm` and changes no file
- [x] Contract: with no registry record and an existing clone folder (a `remove` that stopped before its last step), `add` exits 1 with `job add: <path> already exists — remove it, then run the command again`, starts no git process, and leaves the folder
- [x] Contract: `job list --json` gives a repository job the keys `source`, `ref` and `sha` with 40 characters; the text row shows `<source>@<first 12 characters of sha>`
- [x] Contract: a block entry with `"envFile": "bot.env"` gives the stored `envFile` `<state>/jobs/<name>/bot.env`
- [x] Contract: `"envFile": "/abs/bot.env"` and `"envFile": "../bot.env"` fail with `job add: job "<name>": "envFile" must be a relative path inside the state folder of the job`
- [x] Contract: for each job whose `envFile` does not exist, exit 0 also prints `next: create <absolute envFile path> with mode 600 before you start <name>`
- [x] Contract: each stored `argv[0]` is an absolute path: `["tool", "run"]` stores the path that the `which` seam gives for `tool`, and `["./bin/run"]` stores `<clone>/bin/run`
- [x] Contract: `["../x"]` fails with `job add: job "<name>": "argv" must stay inside the repository`; a bare name that does not resolve fails with `job add: executable "<name>" does not resolve on PATH`
- [x] Contract: `"requires": ["nope-tool"]` exits 1 with `job add: required executable(s) do not resolve on PATH: nope-tool` before the question; the `confirm` seam gets no call
- [x] Contract: a `requires` value that is not an array of names with no path separator fails with `job add: "requires" must be an array of executable names`
- [x] Contract: a `build` value that is not a non-empty array of non-empty strings fails with `job add: "build" must be a non-empty array of non-empty strings`
- [x] Contract: `build` runs one time, with the clone folder as its working directory, after the `confirm` seam returns true and before sources.json exists
- [x] Contract: a `build` that exits with 3 makes `add` exit 1 with `job add: build failed (exit 3): <argv joined with spaces>`; the clone is absent and no file changed
- [x] Contract: a `no` answer runs no `build`
- [x] Contract: with stdin that is not a terminal and no `--yes`, `add` prints the request text on stdout, exits 1 with `job add: consent needs a terminal — run this command in a terminal yourself, or give --yes` on stderr, leaves no clone, and writes nothing
- [x] Contract: with stdin that is not a terminal, `job add <url> --yes` prints the request text, calls the `confirm` seam zero times, runs `build`, writes the entries and the record, and exits 0
- [x] Contract: with a terminal, `job add <url> --yes` calls the `confirm` seam zero times
- [x] Contract: `job add --accept x <url>` exits 1 with the unknown-option error of commander, and starts no git process
- [x] Contract: `add file://<path>@<branch>` pins the head of that branch when the default branch is a different branch
- [x] Contract: `job add 'ext::sh -c "touch <marker>"'` exits 1 with `job add: the URL scheme "ext::" is not allowed`, starts no git process, and the marker does not exist
- [x] Contract: with no terminal, the environment of the clone process holds `GIT_TERMINAL_PROMPT=0`
- [x] Contract: a `build` that creates `./dist/bot` and an `argv` of `["./dist/bot"]` adds the job
- [x] Contract: an `argv[0]` that is a link to a file outside the clone fails with `job add: job "<name>": "argv" must stay inside the repository`; the clone is absent and no file changed
- [x] Contract: with an injected failure of the second entry write, the bytes of the daemon config and of sources.json are equal to the bytes before, and the clone is absent
- [x] Contract: when the `confirm` seam rejects with an abort, the clone is absent and no file changed
- [x] Contract: an `argv` value that holds `ESC[2K` shows the text `\u{1b}[2K` in the request, and stdout holds no ESC byte
- [x] Contract: an empty answer exits 1 with the `declined` text
- [x] Contract: `job add <url>` with a sources.json that is not a JSON object exits 1, names the file, and starts no git process
- [x] Contract: a record with a `sha` that is not 40 hexadecimal characters, or with `jobs` that is not an array of names, makes the registry reader throw an `Error` that names the file and the source
- [x] Contract: a `dg` block with no job exits 1 with `job add: <url> declares no jobs`; the clone is absent
- [x] Contract: `add https://host/org/Bot` after `add https://host/org/bot` exits 1 with the `already added` text
- [x] Contract: the registry stores the full `sha`; only the printed form has 12 characters
- [x] Happy path: `add` from a `file://` fixture repository with two jobs and three credentials writes two entries with one `grant` and one registry record whose `sha` is equal to `git rev-parse HEAD` of the fixture
- [x] Happy path: `add file://<path>@<tag>` pins the commit of the tag when the default branch has a newer commit
- [x] Happy path: `add`, then `remove` of each job, leaves no clone and no record, and a `jobs` table that is deep-equal to the table before
- [x] Edge: `add` keeps `pinnedOrigin` and each entry of a command job
- [x] Edge: `remove` of a repository job keeps each command job
- [x] Edge: `remove` with no live daemon removes the job and makes no HTTP call
- [x] Edge: an entry that a repository wrote can be started: with a live daemon, `job start <name>` gives the state `running` and the child has the clone directory as its working directory
- [x] Error: `add` on a daemon config that is not valid JSON exits 1, names the file, and removes the clone
- [x] Happy path: a fixture repository with `envFile` and `build` adds its job; its `build` writes a marker file in the clone; with the env file in place, the job starts and prints the value of `DG_SERVICE_STATE_DIR`
- [x] Regression: `bun test` and `bun run lint` pass in pkg/dg-daemon; pkg/launcher/__tests__/size-budget.spec.ts passes; a spec asserts that jobs.ts has no static import of job-source.ts, sources.ts or declaration.ts, and that `src/server/`, `jobs/launcher.ts` and `services/supervisor.ts` hold no git command
- [x] Contract: `parseJobDeclaration` returns the shape `{ ok: true, jobs, credentials, requires, build }` for a valid block and `{ ok: false, error }` for a block that is not valid, and does not throw
- [x] Contract: `https://user:pw@host/org/bot` is refused with the `put no password in the URL` text and starts no git process; `https://user@host/org/bot` is valid with the ref `null`
- [x] Contract: `sanitize` shows a visible escape for one character of each added range: U+202E, U+2066, U+200B, U+FEFF and U+2028
- [x] Contract: a git stderr line with an ESC byte shows the visible escape in the `git clone failed` text
- [x] Contract: one refusal case for each limit of a block: a package.json above 256 KiB, 17 jobs, 65 `argv` items, a string of 1025 characters, and a `meta` `prompt` or `default` of 201 characters
- [x] Contract: a `package.json` that is a link to a file outside the clone fails and shows no content of that file
- [x] Contract: a source whose name is a job name of the `jobs` table or the `grant` of an entry is refused with the `is already used as a credential prefix by` text and starts no git process
- [x] Contract: a command job whose name is a key of the registry is refused with the same text
- [x] Contract: `resolveRef` cases: an annotated tag gives its commit; a tag and a branch with one name give the tag; a full commit id passes; an unknown ref exits 1 with the `does not resolve in` text
- [x] Contract (with the seams): an absent `git` exits 1 with `job add: git is not installed`
- [x] Contract (with the seams): a `build[0]` that does not start exits 1 with `job add: build did not start: <build[0]>`
- [x] Contract: a `build[0]` that is a link to a file outside the clone is refused
- [x] Contract: a process that stops between the record write and the entry writes leaves a record with no entry, and `job remove <name>` removes that record
- [x] Contract: the environment and the argv of the `runGit` seam hold `GIT_LFS_SKIP_SMUDGE=1`, `-c protocol.fd.allow=never` and, with no terminal and no `GIT_SSH_COMMAND` of the caller, `GIT_SSH_COMMAND=ssh -o BatchMode=yes`
- [x] Contract: SIGINT and SIGTERM during `build` stop the build child, remove the clone and change no file; SIGHUP also removes the clone of this run; the lock is taken after `build`, so a signal during `build` holds no lock
- [x] Contract (in job-add-git.spec.ts, until slice 14): `job update <job>` on a repository job exits 1 with `job update: a repository job is not supported yet`

#### Acceptance Criteria
- [x] Given a repository with two jobs and three credentials, when the owner runs `dg job add <url>` and answers `y`, then the config holds two entries with one credential prefix and `cwd` in `<data>/jobs/<source>`, and the registry holds the URL, the ref, the full commit id and the credential details
- [x] Given the request text of `add`, when the owner reads it, then it shows the full commit id, each `argv`, `envFile` and `build` value, and each credential with its secret source, before the question
- [x] Given the answer `n`, when `add` ends, then no clone, no job entry and no registry record remain
- [x] Given a repository with two stopped jobs, when the owner removes the two jobs with `dg job remove`, then the entries, the registry record and the clone are gone, and the state folders and the stored credentials remain
- [x] Given pkg/dg-daemon/src, when a search for `git` runs in `server/`, `jobs/launcher.ts` and `services/supervisor.ts`, then it finds no git command
- [x] Given a block with `"envFile": "bot.env"`, when the job is added, then the entry points at `<state>/jobs/<name>/bot.env`, outside the clone
- [x] Given a block whose `requires` names a program that is not installed, when `add` runs, then it stops before the question and names the program
- [x] Given a `build` that fails, when `add` ends, then no clone, no job entry and no registry record remain
- [x] Given an agent session with no terminal, when it runs `dg job add <url>` with no `--yes`, then the command prints the request and exits 1
- [x] Given an agent session with no terminal, when it runs `dg job add <url> --yes`, then the command prints the request and adds the jobs with no question

### Slice 14 — job-update

#### Engineering
- [x] Put the `update` action for a repository job in the new file pkg/dg-daemon/src/commands/job-update.ts, loaded with a lazy import from jobs.ts; it imports the exports of slice 13; pkg/dg-daemon/src/commands/jobs.ts sends `job update <job>` to it when the job has a record of kind `git`, and to the command-job `update` of slice 9 in each other case
- [x] job-update.ts exports the function that writes the entries of a block (the repository keys replaced, `enabled` and `passEnv` kept), and slice 16 calls that function
- [x] The order of `update` is: find the record; check the record; check the `origin` URL; fetch; resolve the ref; compare with the stored `sha`; read the new block with `git show <commit>:package.json`; parse it; check the job names; check the state of each job of the source; check `requires` and each bare `argv[0]` name; print; check the terminal; ask; read the registry and the config again; put a clone with local changes back to the stored `sha`; check out the commit; run `build`; resolve each `argv[0]` path in the clone; take the lock; check again; write the entries; write the registry; print
- [x] Until the answer `y`, only the fetch changed the clone
- [x] `update` checks the record before a git process starts: `url` and `ref` do not start with `-`, `sha` has 40 hexadecimal characters, and each job name matches the name rule
- [x] Each ref goes to git after `--end-of-options`; a checkout gets only a value that matches `^[0-9a-f]{40}$`
- [x] After the answer `y` and the second read of the registry and the config, and before the checkout of the new commit, when `git status --porcelain --untracked-files=no` in the clone is not empty, or the `HEAD` of the clone is not the stored `sha`, `update` runs `git checkout --force --detach <sha>` and prints `discarded local changes in the clone of "<source>"`; `update` then continues, because dg owns the clone; this restore comes after the refusal for a job that runs and occurs only on a new commit, so an `update` with no new commit, a refusal and the answer `n` change no file of the clone [DECIDED — gaps pass O8 (b)] [DECIDED — post-apply item 1 (c)]
- [x] Each git command of `update` follows the rules of `add`: no submodule step, no repository code before the answer, `--` or `--end-of-options` before a value, stderr piped for the error text, the environment of the caller
- [x] `job update <job>` finds the record that holds the job and runs `git fetch --tags --force origin` in the clone of that source, in the CLI process, with the environment of the caller; each job of that repository gets the new commit, and the request names each of them
- [x] For `ref: null`, `update` also runs `git remote set-head origin --auto` after the fetch
- [x] Resolve the stored `ref` to a commit after the fetch with `resolveRef` of slice 13, which peels an annotated tag: a tag first, then `origin/<ref>`; `ref: null` resolves `origin/HEAD`; a ref that is a tag and a branch resolves as the tag
- [x] A stored `ref` that is a full commit id is checked with `git cat-file -e <sha>^{commit}` and always gives `up to date`
- [x] When the resolved commit is the stored `sha`, change nothing
- [x] When the commit is new, read the `dg` block of the new commit with `git show <commit>:package.json`, parse it with `parseJobDeclaration`, and calculate `declarationHash`; no checkout occurs before the answer `y`
- [x] When `declarationHash` is equal to the stored hash, print `<source>: <old 12> -> <new 12>` and ask `Update to this commit? [y/N]` on a terminal; on `y`, after the checkout and `build`, write only the new `sha` to the registry and do not write the daemon config
- [x] When `declarationHash` is different, print the new request in the form of `add`, then one line for each job and key whose value changed, then ask `Apply these changes? [y/N]` on a terminal
- [x] When only `requires` or `build` changed, the request shows the old and the new value of that key, and the question is `Apply these changes? [y/N]`
- [x] On a `no` answer the clone is at the old commit, because no checkout occurred; write nothing
- [x] `update` refuses before the question when a live daemon reports a job of the source as `running` or `backoff`, with `job "<name>" is <state> — stop it first with dg job stop <name>`; this holds for each job of the source, not only for a job that the new block removes [DECIDED — gaps pass O9 (b)]
- [x] The state of a job comes from `liveJobStates` and `assertDaemonAnswers` of pkg/dg-daemon/src/commands/job-support.ts
- [x] With no daemon pid, `update` makes no state check and no HTTP call
- [x] The states `stopped` and `invalid` are not running
- [x] `update` never changes the `enabled` key of an entry
- [x] `update` does not stop, start or restart a job
- [x] Call `liveJobStates` one time before the question, for each job of the source, in each path with a new commit; the refusal uses that result, so `update` of a repository job prints no `next: dg job restart <name>` line [DECIDED — post-apply item 7 (a)]
- [x] Known gap (accepted): a scheduled run can start between the checkout and the write and meet a clone that is not built; this bundle adds no guard for it [DECIDED — gaps pass O9 (b)]
- [x] `update` does not hold the config lock during the question
- [x] Right after the answer `y` and before the checkout, `update` reads the registry and the config again and stops when they changed; after `build`, it takes the lock one time, reads the registry and the config again, checks that the record still holds the old `sha` and that each new job is free, reads the live state of the removed jobs again, and writes the entries and then the registry in that one section; the check inside the lock is the last one
- [x] Inside the lock, keep a copy of each entry before the first write; when a write fails, put each changed entry back and go back to the old commit
- [x] Extend the fixture helper in pkg/dg-daemon/__tests__/commands/job-source-kit.ts with a second commit and a changed `dg` block; do not add a second helper file
- [x] The specs assert the text of the `next:` lines; they do not run the commands of slice 9
- [x] The Edge with a live daemon and a `running` job uses pkg/dg-daemon/__tests__/utils/daemon-harness.ts with no change
- [x] Do not rename an export of slice 13 (`declarationHash`, `formatRequest`, `resolveRef`, `sanitize`, the deps type, the kit functions)
- [x] After each commit change, check `requires` of the new block before the question, as `add` does
- [x] With a changed block and the answer `y`: for each job of the new block, write the repository keys (`argv`, `cwd`, the mode key, `feed`, `notify`, `timeoutMs`, `credentials`, `grant`, `envFile`, `stopTimeoutMs`) from the new block; a repository key that the new block does not have is removed from the entry
- [x] Keep each key that the block cannot set: `enabled` and `passEnv` stay as they are in the entry
- [x] Print one line `replaced <name>.<key>` for each repository key whose stored value was different from the new value; the comparison is between the stored entry and the new entry, so the line also names a key that the new block removed
- [x] A new job of the block gets a new entry with no `enabled` key, and a state folder; `update` refuses, before a write, a new job that the `jobs` table already holds
- [x] With a changed block, each job of the new block gets its entry
- [x] With a changed block, a job whose entry is absent gets a new entry with no `enabled` key and one `next: dg job enable <name>` line; the two cases are an entry that is absent after a hand edit of the daemon config, and a job that the owner removed with `job remove` and that the new block still lists
- [x] With an equal `declarationHash`, `update` writes no entry, so an absent entry stays absent
- [x] A job that the new block removes loses its entry; its state folder stays
- [x] Write the new `sha`, `declarationHash`, `jobs` and `credentials` to the registry after the entries; `update` changes only these four keys of its record, and keeps each other key and each other record
- [x] After each commit change, run `build` of the new block one time after the checkout that follows the answer `y`, and before the first write, with the rules of `add`
- [x] After the checkout, each failure path goes back to the old commit in one `finally` step: `git checkout --force --detach <old sha>`; `--force` is necessary because `build` can change tracked files; when that checkout fails, exit 1 with the two errors, name the clone folder, and state that the clone is not at the old commit
- [x] When `build` fails, that step runs, and `update` writes nothing
- [x] `update` does not run the `build` of the old commit again after a failed build; build output of the new commit can stay in the clone, and the failure text says so
- [x] When stdin or stdout is not a terminal, `--yes` is not given and a new commit exists, `update` prints the commit change (and the request and changed keys when the block changed) and fails, also when `declarationHash` is equal; it runs no checkout and no build
- [x] When stdin or stdout is not a terminal and no new commit exists, `update` exits 0 with the `up to date` line
- [x] `update` declares the option `--yes` in jobs.ts and accepts it for a repository job: it prints the commit change and the request, asks no question and continues as after the answer `y`, with a terminal or with none; add no `--accept` option; `--yes` on `update` of a command job or a file job is accepted and changes nothing
- [x] After `build`, `update` resolves each `argv[0]` path in the clone with the rule of `add`; a path that leaves the clone is refused
- [x] A mode flag, `--timeout`, `--feed` or `--notify` on `update` of a repository job exits 1 with the `declares this in its "dg" block` text of slice 13; slice 15 adds the same refusal for `--credential`, the option that it adds
- [x] A change of `credentials` is a change of the declaration: the request shows the old and the new line of each credential that changed
- [x] After the answer `y`, the record gets the new `credentials`; `update` stores no value, deletes no stored credential and starts no wizard
- [x] When the new declaration has a credential that the old one did not have, required or optional, print `next: dg job setup <name>` for each job that lists it; `update` changes no `setupDone` mark [DECIDED — gaps pass X1 (c)]
- [x] After the option change (the `--yes` option of `update`), run `bun scripts/completion-trees.ts dg-daemon`, always with the program name, and commit pkg/dg-daemon/src/completion-tree.json; do not edit the JSON by hand
- [x] Before the fetch, `git remote get-url origin` must be equal to the `url` of the record; if not, fail with the `is not valid` text and start no fetch
- [x] Each git command of `update` gets `-c protocol.ext.allow=never` and the environment rules of `add`: `GIT_LFS_SKIP_SMUDGE=1`, `-c protocol.fd.allow=never`, and `GIT_SSH_COMMAND` with no terminal
- [x] This slice replaces the `a repository job is not supported yet` stub of slice 13 and its Contract in pkg/dg-daemon/__tests__/commands/job-add-git.spec.ts
- [x] Do not edit pkg/dg-daemon/src/main.ts, pkg/dg-daemon/src/commands/job-support.ts or pkg/dg-daemon/__tests__/utils/daemon-harness.ts

#### Testing Criteria
##### Contracts
- [x] Contract: `job update nope` exits 1 with `no job named "nope"`
- [x] Contract: with no new commit, `update` exits 0 and prints `source "<source>" is up to date at <first 12 characters of sha>`; the bytes of sources.json and of the daemon config do not change
- [x] Contract: with a new commit and an equal `declarationHash`, `update` prints `<source>: <old 12> -> <new 12>`, asks one question through the `confirm` seam, and on `y` exits 0 with `updated source "<source>" <old 12> -> <new 12>`; the registry holds the new `sha`; each job entry is byte-equal
- [x] Contract: with a different `declarationHash`, the question appears after the request text; the `confirm` seam gets one call
- [x] Contract: a `no` answer exits 1 with `job update: declined; source "<source>" stays at <old 12>`; `git rev-parse HEAD` in the clone is the old commit; no file changes
- [x] Contract: a removed job that is `running` exits 1 with `job "<name>" is running — stop it first with dg job stop <name>` before a checkout
- [x] Contract: a failed `git fetch` exits 1 with `job update: git fetch failed: <first line of the git stderr>` and changes no file
- [x] Contract: an entry with `enabled: true` before `update` has `enabled: true` after it, in each path
- [x] Contract: after a changed block and the answer `y`, each entry holds the new `argv`, mode key, `credentials`, `envFile` and `stopTimeoutMs`; `enabled` and `passEnv` are deep-equal to their values before
- [x] Contract: a job whose new `credentials` list is empty has no `grant` key after the update
- [x] Contract: an `argv` that the human edited in the daemon config is replaced after the answer `y`, and stdout holds `replaced <name>.argv`
- [x] Contract: exit 0 after a changed block prints `updated source "<source>" <old 12> -> <new 12>`, then the `replaced` lines, then one `next: dg job enable <name>` line for each new job
- [x] Contract: a new job that the `jobs` table already holds exits 1 with `job update: a job named "<name>" already exists`; the clone is at the old commit and no file changed
- [x] Contract: a removed job that does not run loses its entry; its state folder exists after the update
- [x] Contract: after a changed block, the registry holds the new `sha`, the new `declarationHash`, the new `jobs` and the new `credentials`
- [x] Contract: `build` runs one time for each accepted commit change, also when `declarationHash` is equal, after the `y` and before a write; on `N` it does not run
- [x] Contract: a `build` that exits with 3 makes `update` exit 1 with `job update: build failed (exit 3); source "<source>" stays at <old 12> — the clone can hold build output of <new 12>`; `git rev-parse HEAD` is the old commit; sources.json and the daemon config are byte-equal
- [x] Contract: a `requires` name of the new block that does not resolve exits 1 with `job update: required executable(s) do not resolve on PATH: <names>` before the question; the clone is at the old commit
- [x] Contract: with no terminal, no `--yes` and a changed block, `update` exits 1 with `job update: consent needs a terminal — run this command in a terminal yourself, or give --yes`; the clone is at the old commit and no file changed
- [x] Contract: with no terminal, no `--yes`, a new commit and an equal `declarationHash`, `update` exits 1 with the `consent needs a terminal` text; the clone is at the old commit and no file changed
- [x] Contract: with no terminal and no new commit, `update` exits 0 and prints the `up to date` line
- [x] Contract: on a new commit and after the answer `y`, a clone with local changes, or with a `HEAD` that is not the stored `sha`, gets `git checkout --force --detach <sha>` before the checkout of the new commit; `update` prints `discarded local changes in the clone of "<source>"` and continues [DECIDED — gaps pass O8 (b)] [DECIDED — post-apply item 1 (c)]
- [x] Contract: with no new commit, a clone with local changes keeps them, and `update` prints no `discarded local changes` line [DECIDED — post-apply item 1 (c)]
- [x] Contract: a tag that the remote moved gives the new commit
- [x] Contract: after the remote changes its default branch, a source with `ref: null` follows the new default branch
- [x] Contract: a record with `ref: "--upload-pack=x"` exits 1 with `job update: the record of "<source>" in <file> is not valid` and starts no git process
- [x] Contract: a new commit whose `argv[0]` is a link to a file outside the clone exits 1 with the `must stay inside the repository` text in the `job update:` form; the clone is at the old commit and no file changed
- [x] Contract: when the config or the record changes during the question, `update` exits 1 with `job update: the source or the daemon config changed during the question — nothing was changed`; the clone is at the old commit
- [x] Contract: with an injected failure of the registry write, the daemon config and sources.json are byte-equal to the bytes before, and the clone is at the old commit
- [x] Contract: with a changed block and the answer `y`, a job of the record whose entry is absent gets a new entry with no `enabled` key, and stdout holds `next: dg job enable <name>`
- [x] Contract: with an equal `declarationHash`, an absent entry stays absent
- [x] Contract: when only `requires` or `build` changed, the request shows the old and the new value of that key, and the question is `Apply these changes? [y/N]`
- [x] Contract: a repository key that the new block removed gives a `replaced <name>.<key>` line
- [x] Contract: with a daemon pid that is alive and does not answer, `update` exits 1 with the `does not answer` text and changes nothing
- [x] Contract: a job of the source in `backoff` makes `update` on a new commit exit 1 with `job "<name>" is backoff — stop it first with dg job stop <name>`; no `next:` line and no `note:` line prints [DECIDED — gaps pass O9 (b)]
- [x] Contract: a new commit with no `dg` key, with an unknown key, or with an entry that the validator refuses exits 1 with the text of slice 13 in the `job update:` form; the clone is at the old commit and no file changed
- [x] Contract: a stored ref that does not resolve after the fetch exits 1 with `job update: cannot resolve "<ref>" in <source>`
- [x] Contract: a `git checkout` that fails exits 1 with `job update: git checkout failed: <first line of the git stderr>`; no file changed
- [x] Contract: a daemon config that is not valid JSON exits 1, names the file, and leaves the clone at the old commit
- [x] Contract: a new job gets a state folder with mode 0700 (POSIX), no `enabled` key, and one `next: dg job enable <name>` line
- [x] Contract: a key whose stored value is equal to the new value prints no `replaced` line
- [x] Contract: with no terminal and a new commit, stdout holds the `<old 12> -> <new 12>` line; the `confirm` seam gets no call and `runBuild` gets no call
- [x] Contract: for one block, the request text of `update` is equal to the request text of `add`; the two commands call `formatRequest`
- [x] Happy path: a source added with the ref of a branch moves to the new head of that branch
- [x] Happy path: a source added with a tag reports `up to date` when only the default branch moved
- [x] Edge: a key that the human changed in the daemon config stays byte-equal when `declarationHash` is equal
- [x] Edge: with a live daemon and a `running` job of the source, `update` on a new commit exits 1 with the `stop it first` text before the question; no checkout and no build runs, and the registry and the daemon config do not change [DECIDED — gaps pass O9 (b)]
- [x] Regression: `bun test` and `bun run lint` pass in pkg/dg-daemon
- [x] Contract: with two jobs of one repository, `job update <first>` shows the two names in the request and writes the two entries
- [x] Contract: a commit that adds a required credential prints the `next: dg job setup` line; the `confirm` seam gets one call
- [x] Contract: a commit that changes only a `source.secretId` gives the question `Apply these changes? [y/N]`, and the request shows the old and the new id
- [x] Contract: `job update <job> --every 30m` on a repository job exits 1 with the `declares this in its "dg" block` text and starts no git process
- [x] Contract: with no terminal and `--yes`, `update` on a new commit prints the commit change, calls the `confirm` seam zero times, checks out the commit, runs `build`, and writes the registry
- [x] Contract: a clone whose `origin` URL is not the `url` of the record exits 1 with the `is not valid` text and starts no fetch
- [x] Contract: each call of the `runGit` seam in `update` holds `-c protocol.ext.allow=never` and the environment rules of `add`
- [x] Contract: an annotated tag that the remote moved gives the new commit
- [x] Contract: a key that this slice does not know is in the record after `update`
- [x] Contract: a job that the owner removed with `job remove` and that the new block still lists gets a new entry with no `enabled` key and the `next: dg job enable <name>` line
- [x] Contract: `job update x --yes` on a command job, and on a file job after slice 16, is accepted and changes nothing
- [x] Contract: with a `runGit` seam that fails on the second checkout, `update` exits 1 with the two errors, names the clone folder, and states that the clone is not at the old commit

#### Acceptance Criteria
- [x] Given a repository job whose repository has a new commit and an unchanged `dg` block, when the owner runs `dg job update <job>` in a terminal and answers `y`, then the registry holds the new commit id
- [x] Given a new commit that changes an `argv` or a credential, when the owner runs `update`, then the command shows the change and asks before it writes
- [x] Given the answer `n`, when `update` ends, then the clone, the registry and the daemon config are as before the command
- [x] Given a running job of the source and a new commit, when the owner runs `update`, then the command refuses before the question, names the job and `dg job stop <name>`, and changes no entry and no record [DECIDED — gaps pass O9 (b)]
- [x] Given a changed block and the answer `y`, when `update` ends, then each entry has the new repository values, and each job that was enabled is still enabled
- [x] Given a `build` that fails after a new commit, when `update` ends, then the source is at the old commit, and the registry and the daemon config are unchanged
- [x] Given an agent session with no terminal and no `--yes`, when `update` finds a new commit, then `update` writes nothing and runs no build, whether or not the block changed
- [x] Given a `requires` name of the new commit that does not resolve, when `update` runs, then it stops before the question
- [x] Given no new commit, when `update` runs, then it exits 0 and changes nothing
- [x] Given a removed job that runs, when `update` runs, then it refuses and changes nothing
- [x] Given a new job, when `update` ends, then its entry has no `enabled` key
- [x] Given two jobs of one repository, when the owner runs `dg job update` with the name of one of them, then the two jobs move to the new commit
- [x] Given an agent session with no terminal, when it runs `dg job update <job> --yes` and a new commit exists, then the command prints the change and applies it with no question
- [x] Given a clone with local changes and a new commit, when the owner answers `y` in `update`, then it puts the tracked files back to the stored commit, prints one `discarded local changes` line, and continues [DECIDED — gaps pass O8 (b)] [DECIDED — post-apply item 1 (c)]
- [x] Given a record that fails the check, when `update` runs, then it starts no git process
- [x] Given a registry write that fails, when `update` ends, then the clone, the registry and the daemon config are as before
- [x] Given a new commit that adds a required credential, when `update` ends, then the output holds `next: dg job setup <name>`
- [x] Given no terminal and `--yes`, when `update` finds a new commit, then `build` runs one time before the write

### Slice 15 — job-setup-wizard

#### Engineering
- [x] Move `promptHidden`, `HiddenInput` and `readCredentialValue` from pkg/skills-cli/src/credentials/cli.ts to pkg/common/src/node/prompt.ts, the file that slice 9 made with `readLine`, and export them from pkg/common/src/node/index.ts; credentials/cli.ts and channel-review/connect.ts import them; change no behavior: the wizard is their third caller, in another package
- [x] `credentials/cli.ts` keeps a re-export of `promptHidden`: `pkg/skills-cli/__tests__/channel-review-connect.spec.ts` imports it from there, and this slice does not own that spec; slice 21 removes the re-export with the spec
- [x] Add `--credential <name>` (repeatable) to `add` and `update` of a command job: it fills the `credentials` list of the entry, and dg sets `grant` to the job name when the list is not empty; the reserved name rule of slice 13 applies to that job name
- [x] `--credential` with a URL exits 1 with the `declares this in its "dg" block` text of slice 13
- [x] Add the record kind `command` and the two marks `prefixAccepted` and `setupDone` to the reader and the writer of `sources.ts`; `prefixAccepted` is one boolean for the source, and `setupDone` is a list of job names
- [x] Load `job-setup.ts` with a lazy import from `jobs.ts`
- [x] The deps type of the wizard is `JobSetupDeps extends JobVerbDeps` (slice 9): the base type gives `isTerminal()`, `confirm(question)` and `which(name, env?)`, and this type adds `readHidden(prompt)`, `readLine(prompt)`, `runSource(argv, { env, cwd, timeoutMs }): Promise<{ code, stdout, stderr }>` and `client` (the client of slice 12); `readLine` is the export of prompt.ts from slice 9; the wizard gives the environment of the caller to `runSource` and `which`
- [x] `job enable <name> [--setup <file or ->]`: the credentials of the job are the names of its `credentials` list; the details come from the record of its source, or are the defaults for a job with no record
- [x] A job with an empty `credentials` list gets no wizard; `enable` is the verb of slice 9
- [x] `setup` with no live daemon starts the daemon as `enable` of slice 9 does, then continues
- [x] Read `status` of slice 12; a credential is `stored`, `expired` (meta `expiresAt` in the past) or `missing`
- [x] Adoption: when the source of the job has no `prefixAccepted` mark and `status` shows that the `grant` is not `missing` or that one credential or more is stored below its prefix, print the stored names and ask `This job can read these credentials. Continue? [y/N]` at a terminal; with no terminal exit 1 with `job enable: the prefix <prefix>/ holds credentials — run this command in a terminal one time`; after `y`, write the mark; `--setup` does not answer this question, and `enable` has no `--yes` option
- [x] dg also writes `prefixAccepted` when it stores the first credential of a prefix itself, not only after the answer `y`
- [x] `enable` asks only for a required credential that is `missing` or `expired`, and the first time (the job has no `setupDone` mark) also for each optional one that is `missing`
- [x] `setup` asks for each credential of the job: it shows the state and the date, never the value, and asks `Replace <name>? [y/N]` for a stored one
- [x] A credential with no `source` reads the value with `readHidden("<prompt text>: ")`; an empty answer skips an optional credential and asks again for a required one
- [x] Each `meta` key of the details reads one visible line; an empty line uses its `default`
- [x] `aws-secretsmanager` in pkg/dg-daemon/src/jobs/secret-sources.ts: resolve `aws` with the `which` seam; run `[aws, "secretsmanager", "get-secret-value", "--secret-id", <secretId>, "--region", <region>, "--profile", <profile>, "--query", "SecretString", "--output", "text"]` through the `runSource` seam with no shell, the environment that the caller gives in `env` and a limit of 30 s in `timeoutMs`; leave out `--profile` when none is given
- [x] secret-sources.ts exports the one real default `runSource`: no shell, stdin closed, stderr piped, `killSignal: "SIGKILL"`, a limit of 30 s, and a limit of 128 KiB while it reads stdout; above that limit it stops the process and gives the error kind `failed` [DECIDED — post-apply item 3]
- [x] A spec runs the default `runSource` with a fixture program that sleeps past a short limit; it uses the `which` seam and no real `aws`
- [x] With a `key`, parse stdout as JSON and take the own string property `key`; with no `key`, the value is stdout with no last newline
- [x] A failed fetch gives one line `job setup: aws failed for <name>: <first line of stderr>` and the hint `hint: aws sso login --profile <profile>` (`hint: aws sso login` with no profile); the stderr line goes through `sanitize`; when the `which` seam does not find `aws`, the line is `job setup: aws is not installed — it is necessary for <name>`
- [x] Validate each value with `validateCredentialValue` before the first write; collect each value before the first `set`
- [x] Store with `set`; the meta is the meta answers plus `createdBy: "dg job setup"`, and `provider: "<source type>"` for a fetched value; no source parameter goes into meta, because `validateCredentialMeta` refuses a key such as `secretId`
- [x] After the last `set`, call `ensureGrant`; `enable` never rotates a token, so a job that runs with the same prefix keeps its token
- [x] Then add the job name to the `setupDone` list, set `enabled`, and start the job (continuous) or print its next run (scheduled) with the function that `enable` of slices 9 and 10 uses
- [x] The two marks are keys of the `sources.json` record for a job with a record: `prefixAccepted` is one boolean for the source, and `setupDone` is the list of the job names whose first setup is done; a job with no record keeps them in a record `{ kind: "command" }` that this slice makes
- [x] When a `set` fails, stop, print each name that was stored, do not enable, and exit 1
- [x] With no terminal, a required credential that is missing or expired, has no `source` and has no `--setup` answer makes `enable` exit 1 with `job enable: credentials missing or expired: <names> — run dg job setup <name> in a terminal, or give --setup`; store nothing and start nothing
- [x] `--setup -` reads JSON from stdin; each other value is a file path; a value that starts with `{` exits 1 with `--setup takes a file path or -`: a command line is visible to other processes, so `--setup` never takes JSON text
- [x] Export from pkg/dg-daemon/src/services/env-file.ts the one check of an open file: `fstat` on the descriptor, a regular file, and no `0o077` bit; the check takes the noun of its message, so `loadEnvFile` keeps `env file <path> is readable by other users; run chmod 600 on it`
- [x] A `--setup` file that other users can read (POSIX mode bits `0o077`) is refused through that check with `--setup file <path> is readable by other users; run chmod 600 on it`
- [x] The shape of the `--setup` JSON is `{ "version": 1, "credentials": { "<name>": <answer> } }`; an answer has one of `"value": "<text>"`, `"source": true | { "profile": "<name>" }`, `"keep": true`, `"skip": true`, plus `"meta"?: { key: text }` and `"expiresAt"?: "<ISO 8601>"`
- [x] An unknown top-level key, an unknown credential name, an unknown answer key, two answer kinds in one answer, `skip` on a required credential that is missing, and `keep` on a missing credential are errors that name the key; nothing is stored
- [x] A credential with an answer gets no question; a credential with no answer follows the terminal rule
- [x] With no terminal, `enable --setup <file or ->` runs for each kind of job, also for a repository job: the consent of `add` is the consent; each required credential that is missing needs an answer, and the adoption rule still applies
- [x] `job setup <name> --rotate-token`: call `rotateGrant` and change no credential
- [x] After `setup` changed a value or the token, print `next: dg job restart <job>` for each job with that prefix that runs
- [x] No value goes to stdout, stderr, a log, a process argument or a file other than the store
- [x] A credential with a `source` is fetched from that source first, with no question: print `fetching <name> from AWS Secrets Manager` on stderr, run the fetch, and use the value; the value then stays in the dg credential store, so a later `enable` does not fetch it again
- [x] When a fetch fails at a terminal, print the failure line and the hint, then ask `Enter <name> by hand? [y/N]`: `y` gives the hidden prompt, and `n` stops with exit 1 and nothing stored; with no terminal a failed fetch exits 1 with nothing stored
- [x] secret-sources.ts exports `fetchSecret(source, deps): Promise<string>` with the seams `which` and `runSource`; it prints nothing, so slice 18 can call it from the daemon; it throws one typed `SecretFetchError` with `kind` (`not-installed`, `failed`, `timeout`, `no-text`, `invalid-json` or `no-key`) and the first stderr line after `sanitize`
- [x] Each caller of `fetchSecret` builds its own text: the CLI builds the `job setup:` line and the `aws sso login` hint (CLI only), and slice 18 builds its 502 texts
- [x] A `--setup` answer `"source": true` fetches from the declared source; `"source": { "profile": "<name>" }` replaces the profile for this run; on a credential with no `source`, each of the two is an error that names the credential
- [x] A `--setup` answer `"value"` for a credential that has a `source` stores that value and starts no fetch
- [x] `job setup <name> --refresh` fetches again each credential of the job whose details have a `source`, with no question and with no terminal necessary; it stores each fetched value with `set`, changes no credential that has no `source`, and prints `refreshed <names joined with a comma and a space>`
- [x] `--refresh` collects each value before the first `set`; when one fetch fails it stores nothing, prints the failure line and the hint, and exits 1
- [x] `--refresh` on a job that has no credential with a `source` exits 1 with `job setup: no credential of job "<name>" has a source — run dg job setup <name> to enter a value`
- [x] `--refresh` with `--rotate-token` exits 1 with `job setup: give --refresh alone`; `setup` has no `--setup` option: `enable --setup` is the way to give answers with no question
- [x] `--refresh` is the command of the owner, or of an agent with no terminal, for a credential that does not work; a job that runs asks through the service API operation of slice 18; the two call `fetchSecret`
- [x] The `--setup` parser is in pkg/dg-daemon/src/jobs/setup-answers.ts and is pure: it takes the JSON text and the credential list of the job, and returns the answers or one error
- [x] After the option change, run `bun scripts/completion-trees.ts dg-daemon` and commit pkg/dg-daemon/src/completion-tree.json; do not edit the JSON by hand
- [x] The registry writer keeps `prefixAccepted` and `setupDone` when `update` writes its four keys [DECIDED — gaps pass X1 (c)]
- [x] The key of a `{ kind: "command" }` record is the job name; `--credential` on a command job calls `assertPrefixFree` of slice 13 for the job name
- [x] `job remove` of a command job deletes its `command` record
- [x] `enable` of an entry that already has `enabled: true`, with a required credential that is `missing`, still runs the wizard (the repair path)
- [x] The login unit question of slice 9 comes after the wizard, so a wizard that fails writes no `loginUnitAsked`
- [x] Register in jobs.ts the verb `setup` with the options `--refresh` and `--rotate-token`, and the option `--setup` on `enable`
- [x] `setup` stores values and writes its `setupDone` entry; it never sets `enabled` and never starts a job; the adoption question applies to it
- [x] `setup` on a job with no credential exits 1 with `job setup: job "<name>" lists no credential`
- [x] The 409 answer `has no credential prefix` of the route becomes one line for `--rotate-token`
- [x] The wizard holds no config lock during a prompt, a fetch or a `set`; it takes `withConfigLock` one time at the end, reads again, checks that the entry exists and that its `credentials` list did not change, then writes the marks and `enabled`
- [x] job-setup.ts imports `withConfigLock`, `callDaemon` and `assertDaemonAnswers` from job-support.ts
- [x] The `--setup` reader opens the file, checks the descriptor with the check of env-file.ts, and reads 128 KiB at most; stdin has the same limit; win32 skips the mode check, as `loadEnvFile` does
- [x] setup-answers.ts uses `Object.hasOwn`, refuses the names `__proto__`, `constructor` and `prototype`, and builds objects with no prototype
- [x] Check the `profile` of a `--setup` answer before it goes to the argv: a string that does not start with `-` and that passes the `profile` rule of the block (slice 13)
- [x] Three more results of the fetch: stdout `None` or empty is the error `job setup: the secret of <name> has no text value`; with a `key`, stdout that is not JSON gives the fixed line `job setup: the secret of <name> is not JSON` and no part of the parser message; a `key` whose property is not a string is the `no-key` error; no error of `fetchSecret` holds stdout [DECIDED — post-apply item 9]
- [x] The `expiresAt` of a `--setup` answer is stored as `meta.expiresAt`; call `validateCredentialMeta` in the collect phase, with the value check, so no `set` fails after an earlier `set` passed
- [x] Export `credentialListFor(flagValues, jobName)` from job-source.ts: it parses the `--credential` values and gives `credentials` and `grant`
- [x] A `--credential` value with `=` exits 1 with `--credential takes a name` until slice 17
- [x] `update` can add a credential, and no flag removes one; `--credential` on `update` of a repository job exits 1 with the `declares this in its "dg" block` text of slice 13
- [x] When `ensureGrant` fails after each `set` passed: print the stored names, write no mark, do not enable, and exit 1; a second run stores nothing again and calls `ensureGrant` again
- [x] If the barrel export of prompt.ts breaks the size budget, add the export path `@dg/common/node/prompt` in pkg/common/package.json and import the prompt code from that path
- [x] Slice 19 builds in pkg/skills-cli at the same time: a lint or build failure in a file of slice 19 is a retry, not a finding
- [x] Never run `bun scripts/completion-trees.ts` with no program name; credentials/cli.ts gets only the move
- [x] The order of `enable` for a job with credentials: `assertDaemonAnswers`; `ensureMigrated`; the daemon start; the adoption question; the wizard; each `set`; `ensureGrant`; the marks and `enabled` in one lock; the login unit question; the start request or the next run line; a daemon start that fails writes nothing; a job with no credential keeps the order of slice 9 [DECIDED — gaps pass O10 (a)]

#### Testing Criteria
##### Contracts
- [x] Contract: `--setup` accepts `{ "version": 1, "credentials": { "api/dev": { "source": { "profile": "p" } }, "metrics": { "value": "v", "meta": { "site": "s" } }, "errors": { "skip": true } } }` from a file with mode 0600 and from stdin
- [x] Contract: `--setup '{"version":1}'` exits 1 with `--setup takes a file path or -`; nothing is stored
- [x] Contract: a `--setup` file with mode 0644 exits 1 and stores nothing (POSIX)
- [x] Contract: with complete answers and no terminal, `enable` calls `readHidden`, `readLine` and `confirm` zero times, stores each value, calls `ensureGrant` one time and starts the job
- [x] Contract: with no terminal, no `--setup` and one required credential with no `source` missing, `enable` exits 1 with the `credentials missing` text; `set` gets no call; the job does not start; `enabled` does not change
- [x] Contract: a second `enable` with each credential stored asks nothing and calls `set` zero times
- [x] Contract: stdout `{"K":"v1"}` with `key: "K"` stores `v1`; with no `key` it stores the full text; a JSON text with no `K` exits 1 with `job setup: the secret has no key "K"` and prints no part of the secret
- [x] Contract: with no terminal, an `aws` exit code that is not 0 exits 1 with the `aws failed for <name>` line and the hint; nothing is stored
- [x] Contract: no stdout, stderr or log line of each spec holds a value text or a token text
- [x] Contract: `enable` of the second job of a repository with a live first job: the token file bytes do not change
- [x] Contract: adoption with no terminal exits 1 with the `holds credentials` text; after one `y`, a later `enable` with no terminal passes
- [x] Contract: `setup` with the answer `n` for each stored credential changes nothing and prints no `next:` line
- [x] Contract: `setup --rotate-token` changes the token file and no credential, and prints `next: dg job restart <job>` for a running job
- [x] Contract: an answer for a name that the job does not list exits 1 with `--setup: "<name>" is not a credential of job "<job>"`
- [x] Contract: a stored meta has `createdBy: "dg job setup"` and no key that matches the secret key rule
- [x] Contract: `dg-skills credentials set` and `channel-review connect` pass their specs with the moved prompt code; `channel-review-connect.spec.ts`, `channel-review-connect-compiled.spec.ts`, `credentials-cli.spec.ts` and `credentials-exec.spec.ts` pass with no edit; pkg/common/__tests__/node-prompt.spec.ts tests `promptHidden` with the `HiddenInput` seam
- [x] Contract: `job add --name x --cwd <dir> --continuous --credential api-key -- <cmd>` writes `credentials: ["api-key"]` and `grant: "x"`; `job update x --credential other` gives `credentials: ["api-key", "other"]`
- [x] Contract: `job add <url> --credential k` exits 1 with the `declares this in its "dg" block` text and starts no git process
- [x] Contract: a `sources.json` record of kind `command` with the two marks passes the reader; a record of kind `git` with no mark passes as before
- [x] Happy path: daemon harness, a job from a `file://` fixture repository with one listed credential, `enable --setup <file>` with no terminal: the job starts and reads the credential through service API v1
- [x] Regression: `bun test` and `bun run lint` pass in pkg/dg-daemon, pkg/common and pkg/skills-cli; `bun test` passes in pkg/launcher, which holds the size budget spec pkg/launcher/__tests__/size-budget.spec.ts; this slice edits no docs spec of pkg/skills-test
- [x] Contract: for a credential with an AWS source, the `runSource` seam gets the exact AWS argv of the Engineering list; with no `profile`, the argv holds no `--profile`
- [x] Contract: `enable` at a terminal fetches a missing credential that has a `source` and calls `readHidden` and `confirm` zero times for it; the stored meta has `provider` equal to the source type
- [x] Contract: a second `enable` calls `runSource` zero times: the value comes from the dg credential store
- [x] Contract: a failed fetch at a terminal with the answer `y` reads the value with `readHidden` and stores it with no `provider` meta; with the answer `n`, `enable` exits 1 and `set` gets no call
- [x] Contract: a tool that the `which` seam does not find exits 1 with the `is not installed` text and starts no process
- [x] Contract: `"source": true` on a credential with no `source` exits 1 with `--setup: "<name>" has no source`; nothing is stored
- [x] Contract: `job setup <name> --refresh` with no terminal calls `runSource` one time for each credential with a `source`, calls `set` for each, calls `readHidden`, `readLine` and `confirm` zero times, prints the `refreshed` line, and prints `next: dg job restart <job>` for a running job
- [x] Contract: `--refresh` with one failed fetch of two calls `set` zero times and exits 1
- [x] Contract: `--refresh` on a job with no `source` exits 1 with the `has a source` text; `--refresh --rotate-token` exits 1 with `job setup: give --refresh alone`
- [x] Contract: with no terminal and a complete `--setup` file, `enable` of a repository job that was added with consent stores each value, calls `ensureGrant` one time and starts the job
- [x] Contract: `--setup` does not answer the adoption question: with stored credentials below the prefix, no mark and no terminal, `enable --setup <file>` exits 1 with the `holds credentials` text; `enable` has no `--yes` option
- [x] Contract: two jobs of one source: the first `enable` runs at a terminal on an empty prefix, and the second `enable` passes with no terminal
- [x] Contract: after `update` of a repository job, the record still holds `prefixAccepted` and `setupDone` [DECIDED — gaps pass X1 (c)]
- [x] Contract: a command job `x` with `--credential` and a git source `x` are refused in the two orders
- [x] Contract: after `job remove x` and a new `job add` of `x`, no old mark stays
- [x] Contract: `enable` of an entry with `enabled: true` and a required credential that is `missing` runs the wizard
- [x] Contract: a `--setup` path that is a link to a file with mode 0644 exits 1 and stores nothing (POSIX)
- [x] Contract: a `--setup` input above 128 KiB, from a file and from stdin, exits 1 and stores nothing
- [x] Contract: `"source": { "profile": "-x" }` exits 1 and starts no process
- [x] Contract: stdout `None`, and empty stdout, exit 1 with `job setup: the secret of <name> has no text value`
- [x] Contract: with a `key`, stdout that is not JSON exits 1 with the fixed line and shows no part of the parser message and no part of stdout
- [x] Contract: a `key` whose property is not a string gives the `no-key` error
- [x] Contract: the `expiresAt` of an answer is in the stored meta as `expiresAt`; a meta that `validateCredentialMeta` refuses for the second credential of two makes `set` get zero calls
- [x] Contract: `job update <repository job> --credential k` exits 1 with the `declares this in its "dg" block` text and starts no git process
- [x] Contract: `enable --setup <file>` on a scheduled job with one credential stores the value, sets `enabled` and prints the next run
- [x] Contract: with an `ensureGrant` that fails after each `set` passed, `enable` prints the stored names, writes no mark, does not enable, and exits 1; a second run calls `set` zero times and calls `ensureGrant` again
- [x] Contract: a `git` record with an unknown key still fails the strict reader, and a `git` record with no mark passes
- [x] Contract: a failed daemon start in `enable` of a job with credentials leaves the entry with no `enabled` key [DECIDED — gaps pass O10 (a)]

#### Acceptance Criteria
- [x] Given a job with three listed credentials and a terminal, when the owner runs `dg job enable <name>` the first time, then the command asks for each missing one, stores them, grants them and starts the job, with no other command
- [x] Given a stored credential that must change, when the owner runs `dg job setup <name>`, then the new value is in the store and the output tells the owner to restart the job
- [x] Given a `--setup` value that is JSON text, when `enable` runs, then it refuses and stores nothing
- [x] Given a credential with an AWS Secrets Manager source, when the owner enables the job the first time, then dg fetches the value from that source and keeps it in the dg credential store
- [x] Given a stored credential that does not work, when the owner runs `dg job setup <name> --refresh` and then `dg job restart <name>`, then the job runs with the value that the source holds now
- [x] Given a repository job that was added with consent, when an agent with no terminal runs `dg job enable <name> --setup <file>` with each answer, then the job starts with no question

### Slice 16 — job-add-local

#### Engineering
- [x] Replace the `not supported yet` branch of slice 13: a path goes to `job-local.ts`
- [x] Expand a leading `~` or `~/` to the home folder; the path must exist; resolve it with `realpathSync`; a path that does not exist exits 1 with `job add: no file or folder at <path>`
- [x] A folder must hold a package.json with a `dg` block; parse it with `parseJobDeclaration` of slice 13; `cwd` of each entry is the folder
- [x] A folder refuses the full flag list of a URL: a mode flag, `--credential`, `--timeout`, `--feed`, `--notify`, `--cwd`, `--env`, `--env-file` or `--stop-timeout` (and the alias forms `--cron` and `--pass-env`) with a folder exits 1 with `job add: the folder declares this in its "dg" block`
- [x] A file permits `--name`, one mode flag, `--credential`, `--timeout`, `--feed`, `--notify`, `--env-file`, `--env` and `--stop-timeout`, and refuses `--cwd` with `job add: the folder of the file is its working directory`
- [x] In a folder, an `argv[0]` with a path separator resolves inside the real path of the folder, as in a clone
- [x] A folder with a `build` runs it one time after the parse and before the first write
- [x] The record of a folder is `{ kind: "path", path, jobs, declarationHash, credentials }`; it has no `url`, no `ref` and no `sha`; the source name is the folder name in lower case, or `--name`
- [x] A file gives one job; the name is `--name` or the file name with no extension in lower case; a name that fails the name rule exits 1 and names the rule
- [x] A file needs exactly one mode flag; with none, exit 1 with `job add: give one of --continuous, --schedule or --every`
- [x] The `argv` of a file: a file with the execute bit is `[<real path>, …args]`; a file with the extension `.ts`, `.js`, `.mjs` or `.cjs` and no execute bit is `[<bun>, <real path>, …args]`, where `<bun>` is the result of the `which` seam for `bun` (default `Bun.which("bun")`), stored as an absolute path, because `process.execPath` is not bun in a compiled binary; each other file exits 1 with `job add: <path> is not executable — run chmod +x, or use dg job add --name <name> --cwd <dir> <mode> -- <command>`
- [x] With no bun, a file that needs bun exits 1 with `job add: bun is not installed — it is necessary to run <file>`; a bun that moved leaves the job `invalid`, and `update` repairs it
- [x] The arguments after a bare `--` go to the script; `cwd` of a file job is the folder of the file
- [x] `--credential <name>` (repeatable) fills the `credentials` list of a file job; each name is required and its prompt is the name; `grant` is the job name when the list is not empty
- [x] `add` of a file writes the record `{ kind: "path", path, jobs: [<name>], credentials: {} }` at once, with the job name as its key; the wizard of slice 15 adds its marks to that record; the entry holds the full definition; `job status` reads `path` from the record for `source missing: <path>`; `job remove` of a file job follows the rule of slice 13, so this record goes with the job [DECIDED — gaps pass O11 (a)]
- [x] The reserved name rule of slice 13 applies to the source name and to the name of a file job
- [x] A local `add` asks no question and works with no terminal; `--yes` with a path is accepted and changes nothing
- [x] An `add` whose name exists exits 1 with `a job named "<name>" already exists — to change it, run dg job update <name>`
- [x] `job update <name> [flags]` on a file job is the command-job `update` of slice 9, so it can change the mode
- [x] `job update <name>` on a folder job reads the block again, prints one `replaced <job>.<key>` line for each key that changed (the word of slice 14; `changed <key>` is for a flag update), writes the entries of each job of the folder with the entry function of job-update.ts (slice 14), and asks nothing: a job that the block no longer lists loses its entry, a new job gets one with no `enabled` key, and `enabled` and `passEnv` stay
- [x] `update` of a folder does not run `build`, and says so in one line when the block has one; it prints `next: dg job restart <name>` for a job that runs, and one line for each changed credential with each key of a changed `source`
- [x] jobs.ts sends `update` to this action for a record of kind `path` that has a `declarationHash` (a folder); the record of a file job has no `declarationHash`, and a file job keeps the command-job `update` of slice 9 [DECIDED — post-apply item 6 (a)]
- [x] `job remove <name>` of a folder job follows the rule of slice 13: the record goes with the last job; it never deletes or changes the path
- [x] `job list` and `job status` show `source changed — run dg job update <name>` when the block hash of a folder is not the recorded hash, and `source missing: <path>` when the path does not exist; the text row of a path job is `<source> (<path>)`
- [x] The `--json` keys of a path job are `source`, `path` and `sourceState`: `ok`, `changed`, `missing` or `invalid` (the package.json cannot be read or has no valid `dg` block); `list` reads the folder at each call, and a read error never fails the command
- [x] A change of the script text needs no dg command and no new consent: a scheduled job uses the new text at its next run, and a continuous job at its next start; the output of `add` says so in one line
- [x] Add no file watcher and no content hash of a script
- [x] Exit 0 of a file prints `added job "<name>" from <path>`, then `next: dg job enable <name>`; a folder prints `added jobs from "<source>" at <path>: <names joined with a comma and a space>`, then one `next:` line for each job
- [x] Block text of a folder goes through `sanitize` of pkg/dg-daemon/src/jobs/sanitize.ts; the command shows the job lines of the request of slice 13 and asks nothing
- [x] A local `add` starts no git process and no build of a repository; the daemon reads the script at each run
- [x] After the command change, run `bun scripts/completion-trees.ts dg-daemon` and commit pkg/dg-daemon/src/completion-tree.json when it changed; do not edit the JSON by hand
- [x] The spec of slice 13 that expects `a local path is not supported yet` changes to the new result
- [x] In jobs.ts: one positional argument with text after `--` is a file job with arguments; no positional argument is a command job
- [x] `add` of a folder calls `assertPrefixFree` of slice 13 for the source name, and `add` of a file calls it for the job name; write no second check
- [x] A folder `add` follows the steps of slice 13 with no clone step: the `requires` check with the `which` seam; a bare `argv[0]` becomes an absolute path; the text `job add: build failed (exit N): <argv>`; `ensurePrivateDir(jobStateDir(paths, name))` for each job; the `next: create <envFile> with mode 600 …` line; the check that no job name of the block is in the table; the lock; the removal of the entries of this run after a failed write
- [x] A file job also gets its state folder and passes `parseJobEntry`
- [x] A folder name that fails the name rule exits 1 with `job add: cannot use "<name>" as a source name — give one with --name`; a file name that fails it exits 1 with `job add: cannot use "<name>" as a job name — give one with --name`
- [x] `~user/…` exits 1 with `job add: only ~ and ~/ are supported`
- [x] The execute-bit rule is POSIX only: on win32, only the four extensions run, through bun, and each other file is refused with the `is not executable` text; the Contract list runs on POSIX [DECIDED — post-apply item 5]
- [x] The strict reader of sources.ts accepts kind `path`: `path` is an absolute string, `jobs` is an array of names, `credentials` is an object, and `declarationHash` (64 hexadecimal characters) is necessary for a folder; the two marks are permitted
- [x] Spec files: job-add-local.spec.ts holds the in-process Contracts with seams; job-local-change.spec.ts holds `update`, `remove`, `status` and `list`; job-local-headless.spec.ts holds the cases with no terminal and the Happy paths with a live daemon
- [x] Do not edit main.ts, job-support.ts, launcher.ts or daemon-harness.ts
- [x] The helper that makes a temp folder with a `dg` block goes into pkg/dg-daemon/__tests__/commands/job-source-kit.ts
- [x] jobs.ts loads job-local.ts with a lazy import; `classifySource` stays the one router, and job-local.ts holds only the two local actions
- [x] When the given path was a link, `add` prints one line `stored real path <path>`: a later change of the link does not change the job

#### Testing Criteria
##### Contracts
- [x] Contract: `job add ./poll.ts --every 15m` writes `jobs.poll` with `argv` `[<bun>, <real path>]`, `cwd` the folder of the file, `every: "15m"` and no `grant`; it starts no git process
- [x] Contract: `job add ./poll.ts --every 15m --credential api-key` writes `credentials: ["api-key"]` and `grant: "poll"`
- [x] Contract: `job add ./run.sh --continuous` with the execute bit writes `argv` `[<real path>]` and `continuous: true`
- [x] Contract: `job add ./notes.txt --continuous` exits 1 with the `is not executable` text and writes nothing
- [x] Contract: `job add ./poll.ts` with no mode flag exits 1 with the mode text
- [x] Contract: `job add ./Poll_Job.ts --every 15m` exits 1 and names the name rule; with `--name poll-job` it exits 0
- [x] Contract: `job add ./pw.ts --every 15m --credential x` exits 1 with the `reserved name` text
- [x] Contract: `job add ~/jobs/poll.ts --every 15m` given as quoted text stores the real path below the home folder
- [x] Contract: `job add <folder>` with two jobs in the block writes two entries with `cwd` equal to the real path of the folder
- [x] Contract: `job add <folder>` with no package.json exits 1 with `job add: <path> has no package.json with a "dg" key`
- [x] Contract: `job add <folder> --every 15m` exits 1 with the `folder declares this` text
- [x] Contract: a second `job add ./poll.ts --every 30m` exits 1 with the `already exists` text; `job update poll --every 30m` exits 0 with `changed every`, and `enabled` is as before
- [x] Contract: a link `./poll.ts` to a file in another folder stores the real path
- [x] Contract: after the delete of the script, `job status poll` and `job list` show `source missing: <path>`, a text of `list` and `status` only; a start of a job whose script is absent does not give the state `running`; this slice does not edit launcher.ts or supervisor.ts
- [x] Contract: `job remove poll` leaves the script file byte-equal
- [x] Contract: with stdin that is not a terminal and an empty prefix `poll/`, `job add ./poll.ts --every 15m --credential api-key` exits 0, and `job enable poll --setup <file>` stores the value, makes the grant and enables the job with zero questions
- [x] Contract: with credentials below `poll/`, `job enable poll --setup <file>` with no terminal exits 1 with the `holds credentials` text
- [x] Contract: an edit of a folder block shows `source changed` in `job status`; `job update <name>` writes the new keys and calls the `confirm` seam zero times
- [x] Happy path: a file job with `--continuous`, then `job enable`, then a daemon restart: the job runs again with a new pid
- [x] Happy path: a file job with `--every 1s` runs two times, and an edit of the file between the two runs changes the output of the second run; start the second run with `job start` (`runScheduledNow`), not with a wait for a tick, and give the test an upper time limit with the helper of test-timeout.spec.ts
- [x] Happy path: a file job with `--credential api-key` and `enable --setup <file>` reads `api-key` through service API v1
- [x] Regression: `bun test` and `bun run lint` pass in pkg/dg-daemon; pkg/launcher/__tests__/size-budget.spec.ts passes with job-local.ts behind a lazy import
- [x] Contract: `job add ./poll.ts --every 15m --yes` gives the same entry as the command with no `--yes`
- [x] Contract (with the `which` seam): a `.ts` file with no execute bit stores the absolute bun path of the seam as `argv[0]`; with a seam that finds no bun, `add` exits 1 with `job add: bun is not installed — it is necessary to run <file>` and writes nothing
- [x] Contract: `job add ./run.sh --continuous -- --verbose` stores `argv` `[<real path>, "--verbose"]`
- [x] Contract: a file job `poll` and a folder with the source name `poll` are refused in the two orders
- [x] Contract: `job add ./poll.ts --every 15m` with one permitted flag (`--feed`) exits 0, and the key of the flag is in the entry
- [x] Contract: `job add ./poll.ts --every 15m --cwd <dir>` exits 1 with `job add: the folder of the file is its working directory` and writes nothing
- [x] Contract: a `path` record that is not valid fails the reader with a text that names the file and the source
- [x] Contract: a `path` record with the two marks passes the reader
- [x] Contract: `job update poll --credential api-key` on a file job with no credential writes `credentials: ["api-key"]` and `grant: "poll"` and keeps `enabled`; a value with `=` is refused until slice 17
- [x] Contract: a link inside a folder that points outside the folder is refused as `argv[0]`, as in a clone

#### Acceptance Criteria
- [x] Given a script on this machine, when the owner runs `dg job add ./script.ts --every 15m` and `dg job enable script`, then the daemon runs it each 15 minutes, also after a daemon restart
- [x] Given a local folder with a `dg` block, when the owner adds it, then its jobs behave as the jobs of a repository, with no clone and no question
- [x] Given a script that the owner edits, when the next run starts, then it runs the new text with no dg command
- [x] Given an agent session with no terminal, when it adds a local script and enables it with `--setup`, then the job runs

### Slice 17 — job-credential-env

#### Engineering
- [x] `--credential <name>=<NAME>` on a command job or a file job, and the details key `"env": "<NAME>"` in a `dg` block, bind a credential to an environment variable; `--credential <name>` with no `=` only lists the credential
- [x] `add` and `update` write the entry key `credentialEnv`: an object `<NAME>` → `<credential name>`
- [x] Refuse a `<NAME>` that starts with `DG_` in each letter case, and a `<NAME>` that the injection check matches; move the `INJECTION_ENV` pattern of `server/credentials.ts` to pkg/common/src/credentials-format.ts as the export `isInjectionEnvName(name)`, and server/credentials.ts imports it
- [x] The three name rules (the pattern, the `DG_` prefix in each letter case, the injection check) are in `parseJobEntry`, so a hand edit of the config and a block get them; the commands call the same code
- [x] The launcher reads each bound value from the credential store at each launch and puts it after the `envFile` values and before the injected `DG_*` keys; one launcher serves the two modes, so a scheduled run gets the variable too
- [x] Each bound credential is required at launch: one that is absent makes the start `invalid` with `credential <name> is missing — run dg job setup <job>` [DECIDED — gaps pass O12 (c)]
- [x] `parseJobDeclaration` refuses `env` on a credential with `required: false`, and the request text says that a bound credential is required [DECIDED — gaps pass O12 (c)]
- [x] The request text of slice 13 shows `→ env <NAME>` on the credential line
- [x] No log line holds a value
- [x] `<NAME>` must match `^[A-Za-z_][A-Za-z0-9_]*$`; two credentials of one job cannot bind one `<NAME>`, and this rule is checked where the flag list and the block are parsed, because an object key is unique
- [x] The job can still read each listed credential through service API v1; the variable is a second way, for a script with no HTTP code
- [x] The launcher reads the store inside the daemon process: it starts no `aws` process, and a value that the store does not hold is not fetched
- [x] After the option change, run `bun scripts/completion-trees.ts dg-daemon` and commit pkg/dg-daemon/src/completion-tree.json when it changed; do not edit the JSON by hand
- [x] The store name of a bound credential is `<grant>/<credential name>`
- [x] `parseJobEntry` refuses a `credentialEnv` value that is not in the `credentials` list of the entry, and refuses `credentialEnv` on an entry with no `grant`
- [x] The launcher deps get `readCredential(name): string | undefined`; bootstrap.ts passes `credentials.getCredential(name)?.value`; the runner of slice 10 gets it through the same deps; the seam tests are in launcher-credential-env.spec.ts
- [x] The check for a missing credential runs in `preflight`, also for a scheduled run
- [x] A credential that goes away before a relaunch makes `launch` throw, and `runOnce` records `failed to start` with no value in the text
- [x] A scheduled run with a missing credential records a failed run with the `is missing` text and starts no process
- [x] A store that throws gives `invalid` with the storage text
- [x] A bound value that holds a NUL byte makes the start `invalid` with `credential <name> cannot be an environment variable`; the text names the credential and not the value
- [x] Add the bound credentials inside `buildJobEnv`, after the result of `buildBaseEnv` and before the injected `DG_*` keys; `buildBaseEnv` does not change
- [x] declaration.ts accepts the details key `env` and checks it with the three name rules of this slice; the spec of slice 13 that lists the details keys changes
- [x] The strict reader of sources.ts accepts `env`
- [x] Add `credentialEnv` to the repository key list of pkg/dg-daemon/src/commands/job-update.ts, so a block update prints `replaced <job>.credentialEnv`; `--credential k=NAME` with a URL or a folder keeps the exit 1 text of slices 13 and 16
- [x] A child and its children see a bound value in their environment; this is accepted, and slice 20 documents it
- [x] Edit control.ts: `JobControl.start` of a scheduled entry returns the `invalid` result of the preflight; the edit of bootstrap.ts is the `readCredential` seam line

#### Testing Criteria
##### Contracts
- [x] Contract: a job with `credentialEnv: { "API_KEY": "api-key" }`, the prefix `poll` and the stored value `v` starts with `API_KEY=v`
- [x] Contract: a line `API_KEY=x` in `envFile` does not win
- [x] Contract: `--credential k=DG_X` and `--credential k=LD_PRELOAD` exit 1 and name the variable
- [x] Contract: a missing required credential gives HTTP 400 on the start route with the `is missing` text; no process starts
- [x] Contract: after `setup` replaces the value and `job restart`, the child has the new value
- [x] Contract: a scheduled run gets the bound variable
- [x] Regression: `launcher.spec.ts` passes; the order of the other sources does not change; pkg/launcher/__tests__/size-budget.spec.ts passes
- [x] Contract: `job add ./poll.ts --every 15m --credential api-key=API_KEY` writes `credentials: ["api-key"]`, `grant: "poll"` and `credentialEnv: { "API_KEY": "api-key" }`
- [x] Contract: a block with `"credentials": { "api-key": { "env": "API_KEY" } }` gives each job that lists `api-key` the same `credentialEnv`; the request text shows `→ env API_KEY` on that credential line
- [x] Contract: `--credential k=1BAD` and two credentials bound to one name exit 1 and name the variable
- [x] Contract: no daemon log line and no job status row of the spec run holds the value text
- [x] Contract: the launcher reads the bound credential `api-key` of a job with the grant `poll` from the store name `poll/api-key`
- [x] Contract: `parseJobEntry` refuses a `credentialEnv` value that is not in the `credentials` list of the entry, and refuses `credentialEnv` on an entry with no `grant`
- [x] Contract: `preflight` gives `invalid` with the `is missing` text for a continuous entry and for a scheduled entry with a missing bound credential
- [x] Contract: a credential that goes away before a relaunch makes `launch` throw, and `runOnce` records `failed to start` with no value in the text
- [x] Contract: a scheduled run with a missing credential records a failed run with the `is missing` text and starts no process
- [x] Contract: a store that throws gives `invalid` with the storage text
- [x] Contract: a bound value with a NUL byte gives `invalid` with `credential <name> cannot be an environment variable`, and the text holds no part of the value
- [x] Contract: the result of `buildBaseEnv` holds no bound value; a bound `<NAME>` wins over `envFile`, over `passEnv` and over the allowlist
- [x] Contract: `job add <url> --credential k=NAME` and `job add <folder> --credential k=NAME` exit 1 with the texts of slices 13 and 16
- [x] Contract: `noteSecret` gets each bound value at launch
- [x] Contract: `job status --json`, `job list` and the request text show the variable name and never the value
- [x] Contract: after `job remove`, the stored credential stays and no process gets it
- [x] Contract: a `get` on service API v1 still returns the bound credential

#### Acceptance Criteria
- [x] Given a one-file script that reads `process.env.API_KEY`, when the owner adds it with `--credential api-key=API_KEY` and enables it, then the script gets the value with no HTTP code
- [x] Given a credential that the owner replaced with `dg job setup`, when the job starts again, then its variable has the new value

### Slice 18 — credential-refresh-api

#### Engineering
- [ ] Add the operation `refresh` to `POST /service-api/v1/credentials`: the body is `{ "operation": "refresh", "name": "<prefix>/<rest>", "job": "<job name>" }`; the three keys are necessary, and each other key gets the `is not supported` answer of the route [DECIDED — gaps pass: the refresh contract of this slice stays as planned]
- [ ] The operation is an addition to service API v1: it changes no key and no operation of v1 in place; the job sources record of slice 20 states the addition, and slice 20 adds one dated line to ADR 0043; `get` and `list` do not change
- [ ] `refresh` has the guards of `get`: the grant headers, the refusal of a browser `Origin`, `Content-Type: application/json`, a body of 64 KiB at most, a `name` below the grant prefix that passes `validateCredentialName`
- [ ] `job` must be the name of an entry of the `jobs` table whose `grant` is equal to the grant prefix of the request; in each other case answer 403 with the `NOT_ALLOWED` text; a job reads its name from `DG_SERVICE_LABEL`
- [ ] Create pkg/dg-daemon/src/jobs/credential-refresh.ts with `refreshCredential({ paths, store, job, name, deps })`: it reads the record that holds the job from `paths.jobSourcesPath` with the reader of sources.ts, finds the details of the credential, and fetches from their `source` with `fetchSecret` of secret-sources.ts
- [ ] The source is only the one in the record, as recorded at `add` or `update` (a local folder gets no question): the request cannot give a secret id, a region, a key, a profile or an argv
- [ ] A `--setup` answer with a `profile` changes the profile for that run only, so a refresh uses the recorded profile; the refresh uses the environment of the job, not the shell of the owner
- [ ] Each 502 text of `refresh` ends with `— run dg job setup <job> --refresh`, and docs/service-api.md names that command as the next step; the 502 texts in the other items of this slice give the part before this end [DECIDED — post-apply item 2 (a)]
- [ ] A job with no record, a credential with no details and a credential with no `source` answer 409 with `credential "<name>" has no source — run dg job setup <job>`; no process starts
- [ ] The fetch process gets the environment that `buildBaseEnv(decl, deps)` of slice 8 builds for that job (the allowlist, the `envFile` values and the `passEnv` values), with no injected `DG_*` key and no bound credential; this slice does not edit launcher.ts
- [ ] An `envFile` that is absent or not valid answers 502 with `the env file of job "<job>" cannot be read` and no path
- [ ] Resolve `aws` on the `PATH` of that environment and run the AWS argv of slice 15 with the seams of slice 15 as they are: `which("aws", <base env>)` and `runSource(argv, { env: <base env>, cwd: jobStateDir(paths, job), timeoutMs: 30000 })`, with the default `runSource` of secret-sources.ts; this slice changes no seam and no spec of slice 15
- [ ] `job setup --refresh` of slice 15 and this operation call the one function `fetchSecret`; write no second argv
- [ ] After a fetch that passed: validate the value with `validateCredentialValue`, call `noteSecret` for it, and store it with `setCredential` under the same name; keep the meta of the stored credential, and set `provider: "aws-secretsmanager"` and `createdBy: "service api refresh"`
- [ ] Answer 200 with `{ "ok": true, "value": { "name", "updatedAt" } }`; the answer holds no credential value, and the job reads the value with `get`
- [ ] Rate limit: the daemon starts one fetch at most for one credential name in 60 s; a request inside that time, or during a fetch of that name, answers 429 with `{ "ok": false, "error": "refresh of <name> is limited — try again in <n> s", "retryAfter": <n> }` and starts no process; the limit is in the memory of the daemon
- [ ] A failed fetch answers 502 with `{ "ok": false, "error": "aws failed for <name>: <first line of stderr>" }`; the line goes through `sanitize` and is cut at 200 characters; nothing is stored, and the stored value does not change
- [ ] When `aws` does not resolve, answer 502 with `aws is not on the PATH of job "<job>"`; when the secret has no `key` that the source names, answer 502 with `the secret has no key "<key>"`
- [ ] A refresh does not change the grant token and does not restart a job; a job with the credential as an environment variable (slice 17) gets the new value at its next start
- [ ] Write one daemon log line for each refresh request with the job, the credential name and the result; the line holds no value
- [ ] `ServiceApiStore` gets `setCredential` in its `Pick`; `handleServiceApiCredentials` gets a fourth parameter, one object `refresh: { paths, readJobs, which, runSource, now, limiter }`; `readJobs` is the dep of slice 12, and bootstrap.ts builds the limiter (no module global); pkg/dg-daemon/src/server/http.ts and bootstrap.ts give the parameter; the handler reads the `jobs` table and not `JobControl`, which covers only `start`, `stop` and `status`
- [ ] Add `job` to the known body keys of the route, so a stray-key answer can name it
- [ ] The daemon starts an `aws` process only for this operation, and only with the fixed argv of a declared source
- [ ] In docs/service-api.md, add the request body and the answer of `refresh`, the rows 409, 429 and 502 of the status table, the change of the 403 row (an operation other than `get`, `list` and `refresh`), the 60 s limit, and one example that sends `refresh` and then `get` after the upstream answers 401
- [ ] In docs/service-api.md, state that the job gives its own name from `DG_SERVICE_LABEL`, and that the name is not a proof of identity: each holder of the grant can ask for a refresh of a credential below the prefix
- [ ] In pkg/skills-test/__tests__/outside-services-docs.spec.ts, add the new literals to the test `service API literals match the route source`
- [ ] Use `bot` and placeholders in each example; write no name of a real secret
- [ ] credential-refresh.ts imports `sanitize` from pkg/dg-daemon/src/jobs/sanitize.ts (slice 13) and imports nothing from `src/commands/`
- [ ] Map each `SecretFetchError.kind` to a 502 text: `not-installed` is `aws is not on the PATH of job "<job>"`; `failed` is `aws failed for <name>: <line>`; `timeout` is `aws timed out for <name>`; `no-text` is `the secret of <name> has no text value`; `invalid-json` is `the secret of <name> is not JSON`; `no-key` is `the secret has no key "<key>"`
- [ ] Map the request `name` to the details: remove `<prefix>/` and require the remainder to be in the `credentials` list of the job `job`; a name below the prefix that the job does not list answers 409 with the `has no source` text
- [ ] An entry that fails `parseJobs` answers 403 with the `NOT_ALLOWED` text
- [ ] Check order: method, Origin, grant (401), content type (415), body (413, 400), key list (400), the types of `name` and `job` (400), `name` in the prefix and valid (403, 400), `job` in the table with an equal `grant` (403), the record, the list and the `source` (409), the limit (429), the fetch
- [ ] A 400, 403 or 409 does not start the 60 s window; the window starts when the process starts and counts a failed fetch; a request during a fetch answers 429 with `retryAfter` of 1 or more; remove the entry of a name when its window ends
- [ ] A `sources.json` that is not valid answers 500 with the storage text and no path
- [ ] A fetched value that fails `validateCredentialValue` answers 502 with `the secret of <name> is not a valid credential value` and stores nothing
- [ ] A credential that was not stored before the refresh gets the meta `{ provider, createdBy }` only
- [ ] The result of `which` must be an absolute path; the fetch process runs in `jobStateDir(paths, job)`, never in the `cwd` of the job
- [ ] docs/service-api.md states that the fetch uses the environment of the job that the request names, not of the caller
- [ ] This slice adds no command, option or description and runs no `bun scripts/completion-trees.ts`
- [ ] Put new test helpers in service-api-refresh.spec.ts and credential-refresh.spec.ts; do not edit the kits of slices 13 and 15 or the daemon harness

#### Testing Criteria
##### Contracts
- [ ] Contract: `refresh` for `bot/api/dev` with a declared source answers 200 with `{ "ok": true, "value": { "name": "bot/api/dev", "updatedAt": "<ISO 8601>" } }`; a `get` after it gives the new value; the body of the `refresh` answer holds no value text
- [ ] Contract: the `runSource` seam gets the exact AWS argv of slice 15; its environment holds a key of the `envFile` of the job and holds no `DG_CREDENTIAL_GRANT_FILE`
- [ ] Contract: `refresh` gives 401 with no grant or an incorrect token, 400 with an `Origin` header, 415 for another content type, 413 above 64 KiB, and 400 when `name` or `job` is absent or is not a string
- [ ] Contract: a body with `"secretId": "x"` gives 400 with `request body key "other" is not supported`, and no process starts
- [ ] Contract: `refresh` gives 403 for a name outside the prefix, for a `job` that is not in the `jobs` table, and for a job whose `grant` is a different prefix
- [ ] Contract: a credential with no `source`, and a credential of a command job, give 409 with the `has no source` text; the `runSource` seam gets no call
- [ ] Contract: two requests for one name in 60 s: the second gives 429 with a `retryAfter` from 1 to 60, and the `runSource` seam has one call; with the `now` seam 61 s later, the next request starts a fetch
- [ ] Contract: two requests for two names in 60 s start two fetches
- [ ] Contract: an `aws` exit code that is not 0 gives 502 with the `aws failed for` text; the stored value and its `updatedAt` are equal to the values before
- [ ] Contract: an environment of the job in which `aws` does not resolve gives 502 with the `is not on the PATH of job` text
- [ ] Contract: a secret with no key `K` for a source with `key: "K"` gives 502 with `the secret has no key "K"`; no part of the secret is in the body or in the log
- [ ] Contract: no response body and no daemon log line of the spec run holds the value text
- [ ] Contract: the bytes of the grant token file are equal before and after a refresh
- [ ] Contract: the stored meta after a refresh holds each meta key from before, `provider: "aws-secretsmanager"` and `createdBy: "service api refresh"`
- [ ] Contract: `get` and `list` answer as before; pkg/dg-daemon/__tests__/server/service-api.spec.ts changes only in each call, for the new parameter, and where it names the refused operations
- [ ] Contract: docs/service-api.md names the operation, its three body keys, the status codes 409, 429 and 502, and the 60 s limit; pkg/skills-test/__tests__/outside-services-docs.spec.ts passes
- [ ] Happy path: daemon harness, a job from a `file://` fixture repository whose `envFile` puts a fixture `aws` program on `PATH` and keeps the system folders on `PATH`, for the `env` line of the fixture program: the job sends `refresh`, then `get`, and reads the value that the fixture program prints
- [ ] Error: with the credential store closed or broken, `refresh` gives 500 with the storage text of the route
- [ ] Regression: `bun test` and `bun run lint` pass in pkg/dg-daemon and pkg/skills-test; pkg/launcher/__tests__/size-budget.spec.ts passes
- [ ] Contract: a `sources.json` that is not valid gives 500 with the storage text, and the body holds no path
- [ ] Contract: a fetched value that fails `validateCredentialValue` gives 502 with `the secret of <name> is not a valid credential value`, and nothing is stored
- [ ] Contract: a credential that was not stored before the refresh has only the meta keys `provider` and `createdBy` after it
- [ ] Contract: a relative `PATH` entry does not resolve `aws`
- [ ] Contract: a job `a` that names a job `b` of the same prefix gets the environment of `b`
- [ ] Contract: a `name` that fails `validateCredentialName` gives 400
- [ ] Contract: each 502 answer of `refresh` (the six fetch errors, the env file error and the value error) ends with `— run dg job setup <job> --refresh` [DECIDED — post-apply item 2 (a)]
- [ ] Contract: a 403 and a 409 do not use the 60 s window, and a failed fetch does
- [ ] Contract: a request during a fetch (a deferred promise in the `runSource` seam) gives 429
- [ ] Contract: the 30 s limit gives 502 with the `aws timed out for` text and ends the process
- [ ] Contract: with a `key`, stdout that is not JSON gives 502 with the `is not JSON` text
- [ ] Contract: the log line of a refresh holds the job, the name and the result, and no value

#### Acceptance Criteria
- [ ] Given a running job whose upstream refuses a stored credential (for example with HTTP 401), when the job sends `refresh` for that credential and then `get`, then it has the value that the source holds now, with no command of the owner
- [ ] Given a job that sends `refresh` in a loop, when a second request for the same credential arrives in 60 s, then dg starts no second fetch
- [ ] Given a request that names a secret id or a profile, when the daemon reads it, then it refuses the request: the source is only the one that the owner saw

### Slice 19 — channel-review-export

#### Engineering
- [x] Add `export` to pkg/skills-cli/src/channel-review/cli.ts: `dg-skills channel-review export --env <env> --label <label>`; the two options are required
- [x] `--env` uses `envOption()` with `makeOptionMandatory()`; it has no default in this command
- [x] Put the action in pkg/skills-cli/src/channel-review/export.ts; cli.ts imports export.ts statically, because `registerLazyRaw` already loads the full `channel-review/cli` subtree lazily
- [x] Read the state with `readStateSnapshot(channelReviewPaths(env))` of `@dg/channel-review`; it opens daemon.db with `readonly: true`, takes no lock and starts no migration
- [x] The order of `export` is: the label rule; `assertNotBlocked` for the layout keys `channel-review-config` and `daemon`; the liveness check; the config and the chat id; `readStateSnapshot`; the write
- [x] A daemon that starts between the check and the read is not prevented; commands.md says to keep the daemon stopped
- [x] Write `<jobStateDir(paths, label)>/import.json` with the keys `version`, `cursor`, `handled`, `current` and `automation`, in that order
- [x] Use one `DgPaths` object for the read and for the write: `channelReviewPaths(env).dg`
- [x] `version` is the number 1
- [x] `cursor` is the `lastEventIds` object of the state: one event id for each chat id
- [x] `handled` is an array with one object for each key of the `handled` object of the state: `{ messageId, status, at }`, plus `chatId` when the state has it; sort by `at`, then by `messageId`
- [x] `current` is the `current` value of the state: the job object or `null`
- [x] Validate `--label` with `isJobName` of `@dg/common/node` (slice 2) before a path is built; export.ts holds no copy of the pattern and keeps its own error text
- [x] Create the directory with `ensurePrivateDir` and write the file with `writeFileAtomic(path, data, 0o600)`; an existing import.json is replaced
- [x] `export` writes nothing to daemon.db and does not stop a process
- [x] Add `export` to plugins/dg/skills/channel-review/references/commands.md with its two options, the output path, and the rule that the daemon of that env must be stopped
- [x] commands.md states that the export has no `running` key and no `fixStarts` key: the bot starts with an empty fix quota, so the fix limit of one hour starts again one time, at the import
- [x] commands.md states that a `handled` entry with the status `pending` or `running` is work that stopped
- [x] commands.md states that `current.pid` and `current.pidStart` are values of the old host and have no meaning for the bot
- [x] commands.md says: "`handled` can hold entries older than 24 hours until the next prune; for older requests use `cursor`."
- [x] commands.md states that the format has `version: 1`, and that a change of shape increases `version`
- [x] commands.md states that the owner exports one time, after the last stop of the old daemon
- [x] commands.md states that the bot records that it did the import
- [x] Write no private organization name and no private repository name in a source file, a spec or a document; name the consumer `the review bot repository`
- [x] `automation` is an object with the keys `blocked`, `issues`, `sinks`, `prWatch` and `deps`, in that order; each value is the value of the same key of the state, and `deps` holds `lastRun`
- [x] Do not export the keys `running` and `fixStarts` of the state
- [x] After the `assertNotBlocked` check and before the config read, refuse when the channel-review daemon of that env runs: use `readPidRecord` and `isOurDaemon` of `@dg/channel-review`, the check of `channel-review status`; write no second liveness check
- [x] A legacy state with one `lastEventId` has no chat id; `export` gives `readStateSnapshot` a `legacyChatId`: no constant `defaultChatId` exists, so read the config with `loadConfig(channelReviewPaths(env).configPath)` and use `chats[0].id`; `export` does not connect to the relay
- [x] A config that is absent, cannot be read, or has a first chat with a `topic` and no `id` means that no chat id is configured
- [x] commands.md says that the export does not see a `--chat-id` of the old daemon
- [x] After the label rule and before the liveness check, call `assertNotBlocked` for the layout keys `channel-review-config` and `daemon`
- [x] export.ts builds the output as a typed `ImportFile` value with `satisfies`
- [x] The only optional key of the format is `chatId` of a `handled` entry: it is left out when the state has none; `current` can be `null`
- [x] Add no fixture helper: the spec writes the `channel_review_state` row with `createStateStore` of `@dg/channel-review`
- [x] `--label` is the name of the job that reads the file: the state folder is `jobStateDir(paths, label)` of slice 2, the folder that the daemon gives that job as `DG_SERVICE_STATE_DIR`
- [x] The option names `--env` and `--label` stay as they are: slice 21 removes this command
- [x] The `export` command is in the generated command tree of dg-skills: after the command change, and after a rebase on the head of the PR 3 branch, run `bun scripts/completion-trees.ts dg-skills` and commit pkg/skills-cli/src/completion/tree.json with only the `export` change plus a change that comes from a slice that is already merged; do not edit the JSON by hand
- [x] commands.md gives the order of work: the export creates `jobStateDir(paths, label)` with mode 0700, also before `dg job add`, and the daemon accepts that folder (the `preflight` Contract of slice 2)
- [x] commands.md states that the file holds the old `current.url` and `sinks.*.lastError` text, so it keeps mode 0600 and must not be committed

#### Testing Criteria
##### Contracts
- [x] Contract: import.json parses as `{ "version": 1, "cursor": { "<chatId>": "<eventId>" }, "handled": [{ "messageId", "status", "at", "chatId"? }], "current": <object|null>, "automation": { "blocked", "issues", "sinks", "prWatch", "deps": { "lastRun" } } }` and has no other top-level key
- [x] Contract: `handled` holds each message id of the state one time, in ascending `at` order
- [x] Contract: `status` is one of `pending`, `running`, `done`, `failed`
- [x] Contract: exit 0 prints one line: `exported channel-review <env> state to <path>: <n> handled, <m> chat cursors, current <message id or none>`
- [x] Contract: the file mode is 0600 and the directory mode is 0700 (POSIX)
- [x] Contract: `--label Bad/Label` exits 1 with `channel-review export: "--label" must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit`, and creates no directory
- [x] Contract: an `--env` value other than `dev` or `prod` exits 1 with the commander text for a choice that is not valid, as in the other channel-review commands
- [x] Contract: a missing `--env` exits 1 with the commander text for a required option
- [x] Contract: the bytes of daemon.db, of its `-wal` file and of the `channel_review_state` row do not change; `export` opens daemon.db with `readonly: true` and takes no lock
- [x] Contract: `automation.blocked`, `automation.issues`, `automation.sinks` and `automation.prWatch` are deep-equal to the same keys of `readStateSnapshot`; `automation.deps` is `{ "lastRun": <the deps.lastRun object of the state> }`; `automation.blocked` holds each full blocked entry (`options`, `messageId`, `chatId`, `at`), keyed as in the state
- [x] Contract: import.json has no `running` key and no `fixStarts` key at any level
- [x] Contract: with a live channel-review daemon for the env, `export` exits 1 with `channel-review export: the <env> daemon is running (pid <pid>) — stop it first with dg-skills channel-review stop --env <env>`, and creates no file and no directory
- [x] Contract: a pid file that names a dead process, or a process that is not the channel-review daemon, does not stop the export
- [x] Contract: a live `prod` daemon does not stop `export --env dev`
- [x] Contract: plugins/dg/skills/channel-review/references/commands.md holds one literal phrase for each of the six rules for the reader of import.json and for the statement on `running` and `fixStarts`, and the spec matches these phrases: `work that stopped`, `values of the old host`, `older than 24 hours`, `a change of shape`, `one time, after the last stop`, `records that it did the import` and `empty fix quota`
- [x] Contract: a legacy state file with `lastEventId: "e1"` and a configured chat id `c1` gives `cursor: { "c1": "e1" }`
- [x] Contract: the same state with no default chat id exits 1 with `channel-review export: the <env> state has a legacy cursor and no chat id is configured`, and writes no file
- [x] Contract: with a blocked `daemon` entry, `export` prints the block text, exits with the code of the block error (78 for `two-used`, 1 for each other reason), and opens no database; the exit code 78 comes from the `two-used` code of slice 3, so run this Contract on a build that holds slice 3
- [x] Contract: with `DG_HOME=/d`, the file is `/d/state/jobs/<label>/import.json`; no spec uses the default roots
- [x] Contract: the key list of each object level of import.json is equal to the list of the first Contract of this slice; a `handled` entry with no chat id has no `chatId` key
- [x] Happy path: a daemon.db with a `dev` row that has 3 handled messages, 2 chat cursors and a `current` job gives a file with those values
- [x] Happy path: `--env prod --label bot-prod` and `--env dev --label bot-dev` write two files in two directories, each with the state of its env
- [x] Edge: a state with `current: null` writes `"current": null`
- [x] Edge: an env with no row and no legacy state file writes `{ "version": 1, "cursor": {}, "handled": [], "current": null, "automation": { "blocked": {}, "issues": {}, "sinks": {}, "prWatch": {}, "deps": { "lastRun": {} } } }` and the count line shows 0
- [x] Edge: a second `export` replaces the file
- [x] Edge: `export` before the schema has the channel-review table reads the legacy state file, as `channel-review status` does
- [x] Happy path: a state with one blocked URL, one issue, one sink cursor, one watched PR and one dependency run gives an import.json with those five values below `automation`
- [x] Error: a daemon.db of a newer build (`ForwardOnlyVersionError`) exits 1 with one line that starts with `channel-review export:`, with no stack trace and no import.json
- [x] Error: a state that `parseState` refuses exits 1 with one line that starts with `channel-review export:`, with no stack trace and no import.json
- [x] Error: a daemon.db that cannot be read exits 1 with one line that starts with `channel-review export:`, with no stack trace and no import.json
- [x] Error: a write that fails exits 1 with one line that starts with `channel-review export:`, with no stack trace and no import.json
- [x] Check: pkg/skills-test/__tests__/channel-review-skill.spec.ts passes; its test `every subcommand and flag the CLI registers is documented` passes because commands.md documents `export`, `--env` and `--label`
- [x] Regression: `bun test pkg/skills-cli/__tests__/channel-review-cli.spec.ts` passes; `bun run lint` passes in pkg/skills-cli
- [x] Contract: `bun scripts/completion-trees.ts --check dg-skills` exits 0, and the tree holds `export` below `channel-review`
- [x] Contract: a legacy state with a config whose first chat has a `topic` and no `id` exits 1 with the `no chat id is configured` text and writes no file
- [x] Contract: a legacy state with no config file exits 1 with the `no chat id is configured` text and writes no file
- [x] Edge: a state with a `handled` entry of 30 hours ago exports that entry

#### Acceptance Criteria
- [x] Given a daemon.db with channel-review state for `dev` and a stopped `dev` daemon, when the owner runs `dg-skills channel-review export --env dev --label <label>`, then `<state>/jobs/<label>/import.json` holds version 1, the chat cursors, the handled list, the current job and the `automation` object
- [x] Given the export, when the owner compares it with `dg-skills channel-review status --env dev`, then the handled count and the current job are equal
- [x] Given the export, when it ends, then daemon.db is unchanged and the old channel-review commands work as before
- [x] Given a running channel-review daemon for `dev`, when the owner runs the export for `dev`, then the command writes nothing and names the stop command
- [x] Given a state with a sink poll cursor, a seen issue and a dependency run, when the export ends, then import.json holds them below `automation`

### Slice 20 — job-source-docs

#### Engineering
- [ ] Take the record number after `git fetch origin`, before you write the file: the number is the highest number of `git ls-tree origin/master docs/adr` plus one; use it in the file name, the toc row and each link
- [ ] Rebase on origin/master before the first edit of this slice
- [ ] Write the job sources record docs/adr/<number>-job-sources-and-credentials.md with the headings of docs/adr/template.md, a `Date:` header, `Status: Accepted` and exactly one fenced `mermaid` block
- [ ] The record holds: the two source kinds (a repository with a pinned commit and consent at a terminal or with `--yes`; a local path with no pin and no question), the `dg` block, the credential details, the credential prefix that dg makes from the source name, the reserved names, the adoption question, the owner-token route and the reason that it adds no authority (the owner token already lists each session token), `ensure-grant`, the wizard, `--setup` as a file or stdin, the typed secret source `aws-secretsmanager`, `setup --refresh`, the service API operation `refresh`, and a credential as an environment variable
- [ ] In the record, state that the daemon runs no `git` command, starts an `aws` process only for the operation `refresh` with the fixed argv of a declared source, and reads `<data>/jobs/sources.json` only for that operation
- [ ] In the record, link the jobs record of slice 11 and ADR 0043, and state that the record adds the operation `refresh` to service API v1
- [ ] In ADR 0043 (docs/adr/0043-outside-services.md), add one dated line after the line of slice 11: `Amended <date>: service API v1 has the operation refresh; see <link to the job sources record>.`; change no other line
- [ ] Add the row of the record to docs/adr/toc.md after the row of the jobs record in `## Platform`, in 160 columns at most; stop if the row of the jobs record is absent
- [ ] In docs/jobs-and-services.md, add the sections `Add a job from a repository`, `Add a local script or folder`, `Credentials: enable and setup`, `Answers with --setup` and `Refresh a credential` as `##` headings, after `## Job verbs` and before `Start at login`, and link them from the top of the file; `Add a local script or folder` links forward to `Credentials: enable and setup`
- [ ] In `Add a job from a repository`, give `dg job add <git-url>[@ref]`, `dg job update <job>` and `dg job remove <job>`, one example `dg` block with two jobs and the details of two credentials, and the paths `<data>/jobs/sources.json`, `<data>/jobs/<source>/` and `<state>/jobs/<name>/`
- [ ] In that section, state that each verb takes a job name, and that `update` of a repository job moves each job of that repository
- [ ] In that section, give the rules of the `dg` block: a relative `envFile` resolves below the state folder of the job and an absolute path is refused; `requires` is a list of executable names that `add` checks; `build` is one argv that runs after the consent; a failed build of `add` leaves nothing; a failed build of `update` leaves the source at the old commit, and the clone can hold build output of the new commit
- [ ] In that section, state the consent rule: `add` and `update` of a repository print the request and ask at a terminal; `--yes` gives the consent with no terminal; a local path asks nothing
- [ ] In that section, state that `update` asks on each new commit: an unchanged block gets `Update to this commit? [y/N]`; a changed block gets the full request and `Apply these changes? [y/N]`; with no terminal and no `--yes`, `update` refuses; only `update` with no new commit asks nothing
- [ ] In that section, state the `update` rule: the repository keys are replaced after the consent; `enabled` and `passEnv` stay; the output names each replaced key (`replaced <name>.<key>`), also a key that the owner edited; `update` to a new commit refuses while a job of the source is `running` or in `backoff`, and names `dg job stop <name>` [DECIDED — gaps pass O9 (b)]
- [ ] In `Add a local script or folder`, give `dg job add ./script.ts --every 15m` and `dg job enable script`, the rule for the `argv` of a file, and the rule for a folder with a `dg` block
- [ ] In `Add a local script or folder`, state that a change of the script text applies at the next run or start, and that a change of the block or of the mode needs `dg job update <name>`
- [ ] In `Credentials: enable and setup`, state the order of the first `enable`: fetch from the declared source, or ask with a hidden prompt; store in the dg credential store; make the grant; start the job; `dg job setup <name>` changes a credential later, and `--rotate-token` makes a new grant token
- [ ] In `Credentials: enable and setup`, state the adoption question for a prefix that already holds credentials, and that only an answer at a terminal passes it
- [ ] In `Credentials: enable and setup`, give the two ways that a job reads a credential: service API v1 with its grant, and an environment variable from `--credential <name>=<NAME>` or the details key `env`
- [ ] In `Answers with --setup`, give the JSON shape with one example, the rule that `--setup` takes a file path or `-` and never JSON text, and the rule that a file that other users can read is refused
- [ ] In `Refresh a credential`, give the two ways for a credential that does not work: the owner runs `dg job setup <name> --refresh` and then `dg job restart <name>`; a job that runs sends the operation `refresh` of service API v1 and then `get`; state the limit of one fetch for one credential in 60 s, and that dg starts no refresh on its own
- [ ] In `Set up a grant` of docs/service-api.md, replace the steps that use `dg-agent start` and `dg-skills credentials grant` with `dg job enable <name>`, and add one sentence that the key names keep the word `SERVICE`
- [ ] In SECURITY.md, add one paragraph after the paragraph on supervised services, with no word `passEnv` in it: a job from a repository runs with the rights of the user; `add` pins a full commit id and shows the request before it writes; each `update` to a new commit shows the change and asks again
- [ ] In that paragraph, state the cost of `--yes`: a process that can run `dg job add <url> --yes` can run the code of that repository with no question
- [ ] In that paragraph, state: the owner token can write the credentials of a job; `--setup` takes no JSON text, because a command line is visible to other processes; a repository can name an AWS secret, and the request text shows it; a local job needs no consent; a grant is not a sandbox, and one job of a source can read the credentials of the other jobs of that source
- [ ] In that paragraph, state: a job can ask the daemon for a new fetch from its own declared source, cannot change the argv of that fetch, and gets one fetch for one credential in 60 s
- [ ] In docs/jobs-and-services.md, state that AWS Secrets Manager is the one source type of this release
- [ ] In plugins/dg/skills/jobs/SKILL.md, add `job add <url>`, `job add <path>`, `job setup`, `job setup --refresh` and `job enable --setup` to the section of slice 11; the commands keep the name `dg-daemon`
- [ ] In SKILL.md, state that the skill does not answer the consent question and does not add `--yes` on its own: it gives the command, and the human runs it or names the repository for which the agent can use `--yes`
- [ ] In SKILL.md, keep each channel-review section, the bootstrap fence, the SessionStart hook fence and the frontmatter `description` byte-identical
- [ ] In docs/channel-review.md, add one paragraph `Move to a job`: the command `dg-skills channel-review export --env <env> --label <label>`, the path `<state>/jobs/<label>/import.json`, and the rule that the export refuses when the old daemon of that env runs
- [ ] Write each command of the documents in the form `dg job …`; SKILL.md keeps the form `dg-daemon job …`
- [ ] Add pkg/skills-test/__tests__/job-source-docs.spec.ts: it checks each documented command, option, path and message against its source file
- [ ] Use `bot`, `bot-dev` and placeholders in each example; write no private organization name, no private repository name and no name of a real secret in a document or a spec
- [ ] Check by hand before the commit, with the private-name Check of slice 7: the orchestrator gives the private-name list at run time from the local decision log; a case-insensitive search of the changed files, the findings file and the commit message reports only `found` or `not found`
- [ ] The commit message says that slice 21 replaces docs/channel-review.md
- [ ] The documents state that a credential as an environment variable is visible to the child and its children
- [ ] The documents state that a prefix that already holds credentials needs one `y` at a terminal, also for an agent
- [ ] The documents state that a refresh uses the recorded profile and the environment of the named job
- [ ] The documents state that after a 502 the next step is `dg job setup <job> --refresh`
- [ ] In `Add a job from a repository`, state the rule for a clone with local changes: on a new commit and after the consent, `update` puts the clone back to the stored commit, prints `discarded local changes in the clone of "<source>"`, and continues, because dg owns the clone; an `update` with no new commit changes no file of the clone [DECIDED — gaps pass O8 (b)] [DECIDED — post-apply item 1 (c)]
- [ ] In `Add a local script or folder`, state that a file job has a record of kind `path` in `<data>/jobs/sources.json` from `add`, and that `dg job remove <name>` removes it [DECIDED — gaps pass O11 (a)]
- [ ] In `Credentials: enable and setup`, state that each credential that is bound to an environment variable is required at launch, and that a `dg` block with `env` on a credential with `required: false` is refused [DECIDED — gaps pass O12 (c)]
- [ ] In `Credentials: enable and setup`, state that `update` asks no question for a new credential: it prints `next: dg job setup <name>` for each job that lists a new credential, required or optional [DECIDED — gaps pass X1 (c)]

#### Testing Criteria
##### Contracts
- [ ] Contract: docs/jobs-and-services.md gives `dg job add`, `dg job enable` and `dg job setup` in that order; the spec reads the first code span of each command in the file
- [ ] Contract: each documented command passes its `--help` form on a build of this branch; the spec uses pkg/skills-test/__tests__/docs-help-kit.ts of slice 7: it removes placeholders such as `<git-url>[@ref]` and `<name>`, runs the `--help` form, and checks each flag of an example (`--every 15m`, `--setup -`, `--credential <name>=<NAME>`) against the `--help` text; write no second helper
- [ ] Contract: the `--setup` example of the document parses with the parser of pkg/dg-daemon/src/jobs/setup-answers.ts
- [ ] Contract: the example `dg` block passes `parseJobDeclaration`; the example is the one fenced `json` block below the heading `Add a job from a repository`, and the spec reads it by that heading, puts it in `{ "dg": … }`, and calls `parseJobDeclaration` with fixed `dirs`
- [ ] Contract: that spec fails when the example block gets an unknown key
- [ ] Contract: docs/adr/toc.md holds one link to the job sources record, and the file exists with the headings of docs/adr/template.md, a `Date:` header and exactly one fenced `mermaid` block
- [ ] Contract: each command, option, path, key name and message in the changed documents is equal to the value in the source of slices 12 to 19
- [ ] Contract: the documented texts `consent needs a terminal`, `holds credentials`, `is a reserved name`, `Update to this commit? [y/N]`, `Apply these changes? [y/N]` and `replaced <name>.<key>` are in their source files
- [ ] Method: for that contract, run `rg -F` for each documented literal against pkg/dg-daemon/src/commands/jobs.ts, job-source.ts, job-update.ts, job-local.ts, job-setup.ts and job-support.ts, pkg/dg-daemon/src/jobs/declaration.ts, sources.ts, sanitize.ts, setup-answers.ts, secret-sources.ts, credential-refresh.ts and launcher.ts, pkg/dg-daemon/src/server/job-credentials.ts and service-api.ts, and pkg/common/src/credentials-format.ts and pkg/common/src/node/job-credentials-client.ts
- [ ] Check (manual): `git diff <base of PR 3> -- plugins/dg/skills/jobs/SKILL.md` shows no hunk in a line that holds `channel-review`, in the bootstrap fence, in the SessionStart JSON fence or in the lines between the first two `---` markers (the frontmatter `description`); `<base of PR 3>` is the merge commit of PR 2 on master
- [ ] Contract: the record holds the same rules as the document: the spec checks that each phrase of a fixed list is in the record and in the document: the 60 s limit, the cost of `--yes`, `holds credentials`, the rule that the daemon runs no `git`, and the fixed `aws` argv
- [ ] Contract: each `dg <name>` in a code span or a fenced block of the changed documents is a name of `ROUTES`; pkg/skills-test/__tests__/dg-front-door-docs.spec.ts passes
- [ ] Check: `bun scripts/skill-bootstrap-block.ts --check` exits 0; do not run it with `--write`
- [ ] Check: pkg/skills-test/__tests__/outside-services-docs.spec.ts passes; change it only for an assertion that reads a sentence that this slice moved; when the test `toc entry is last in Platform` asserts the row after 0043, update it for the sources row after the jobs row; do the same for an assertion that reads the headings or the top links of docs/jobs-and-services.md
- [ ] Check: each relative link in the changed documents opens an existing file
- [ ] Check (manual, before the commit; no spec): use the private-name Check of slice 7 on the changed files, the findings file and the commit message, and report only `found` or `not found`; no spec holds a private name or a part of one
- [ ] Check: markdownlint and vale pass on the changed files; the Mermaid block of the record renders
- [ ] Regression: `bun test` passes in pkg/skills-test; `bun test pkg/skills-cli/__tests__/skills-only-install.spec.ts` passes

#### Acceptance Criteria
- [ ] Given docs/jobs-and-services.md, when a reader wants to run a repository as a job, then the document gives `dg job add` and `dg job enable` in that order, with the paths of the clone, the registry and the state folder
- [ ] Given docs/jobs-and-services.md, when a reader wants to run a local script, then one section gives `dg job add ./script.ts --every 15m` and `dg job enable script`
- [ ] Given docs/jobs-and-services.md, when a credential of a job does not work, then one section gives `dg job setup <name> --refresh` and the operation `refresh` of the service API
- [ ] Given the jobs skill, when an agent reads it, then it finds each new command and the rule on `--yes`
- [ ] Given docs/adr/toc.md, when a reader opens the link of the job sources record, then the record describes job sources and credentials with the status Accepted
- [ ] Given SECURITY.md, when a reader looks for the cost of `--yes`, then one paragraph gives it
- [ ] Given docs/channel-review.md, when a reader looks for the move to a job, then the paragraph gives the command, the path `<state>/jobs/<label>/import.json` and the refusal rule; the spec checks them against export.ts and its `channel-review export:` prefix

### Slice 21 — remove-channel-review

#### Engineering
- [ ] Start this slice only after the operator gate of the PR plan
- [ ] Delete the package pkg/channel-review, and remove `@dg/channel-review` from pkg/skills-cli/package.json; `bun install` writes bun.lock
- [ ] Delete pkg/skills-cli/src/channel-review/ and pkg/skills-cli/src/commands/channel-review.ts; remove `registerChannelReview` from pkg/skills-cli/src/register-all.ts and `channel-review` from pkg/skills-cli/src/doctor/registry.ts
- [ ] In pkg/skills-cli/src/credentials/cli.ts, replace the example prefix `channel-review` in the `grant` help text with `my-service`
- [ ] In pkg/common/src/node/daemon-schema.ts, keep `createV12ChannelReview` and step 12, and add step 15: `DROP VIEW channel_review_requests`, `DROP VIEW channel_review_current`, `DROP TABLE channel_review_state`; step 14 is the `moved_at` step of slice 10
- [ ] Keep the constant `CHANNEL_REVIEW_SCHEMA_VERSION` in pkg/common/src/node/daemon-schema.ts for step 12, remove its `export` keyword, and remove `CHANNEL_REVIEW_SCHEMA_VERSION` from the re-export list of pkg/common/src/node/daemon-db.ts
- [ ] The change deletes no credential and no grant: the entries below `channel-review/` in the credential store and the file `<state>/grants/channel-review.token` stay
- [ ] Add `channel-review` to `RETIRED_SKILLS` in pkg/common/src/node/install-skills.ts with the hashes of its released SKILL.md files in `RETIRED_SKILL_HASHES`, and add the fixture copy to pkg/skills-test/__tests__/fixtures/retired-skills/channel-review/
- [ ] Get the hashes from release tags, not from `git log --all`: for each tag of `git tag --list` that holds the file, run `git show <tag>:plugins/dg/skills/channel-review/SKILL.md | sha256sum`; add the hash of the PR 3 release; the files in `references/` need no hash; a name with no entry in `RETIRED_SKILL_HASHES` is removed with no hash check, so the entry is what keeps a changed copy
- [ ] Correct the doc comment of `RETIRED_SKILL_HASHES`: no other plugin provides this skill
- [ ] Delete plugins/dg/skills/channel-review/
- [ ] In plugins/dg/skills/jobs/SKILL.md, remove each channel-review section, the channel-review column of the action table, and the SessionStart hook block that starts `channel-review`; update the frontmatter `description`
- [ ] Remove the channel-review text from plugins/dg/skills/doctor/SKILL.md, plugins/dg/skills/thrash/SKILL.md and plugins/dg/skills/README.md
- [ ] Replace the content of docs/channel-review.md with the migration note; keep the path, so existing links open it
- [ ] The migration note gives this order: on the last release before the major, run `dg job add <bot repository URL>`; stop the old daemon with `dg-skills channel-review stop --env <env>`; run `dg-skills channel-review export --env <env> --label <name>`; run `dg job enable <name>`; make sure that a review runs; remove the SessionStart hook that starts `dg-skills channel-review` from the settings file; remove each `review-<env>` job with `dg job remove review-<env>`; then upgrade to the major
- [ ] The migration note states: `export` exists only before the major; the major drops the state tables and no downgrade is possible after it; the stored credentials and the grant stay
- [ ] The migration note states: the copy `channel-review-state.<env>.json` is an archive; it is not an import file, and the bot cannot read it; dg gives no conversion
- [ ] The migration note states: the `pre-migration-v<version>-….db` files that dg writes before the schema change are a second source for a restore, and dg does not remove them; `takeSnapshot` names a file after the step that is about to run and makes one file for each step, so a database at version 14 gets `pre-migration-v15-…`, and one at version 12 gets the v13, v14 and v15 files; the note tells the owner to restore from the file of the lowest step
- [ ] In docs/adr/toc.md, remove `pkg/channel-review` from the diagram
- [ ] Remove the channel-review text from README.md, SECURITY.md, .env.example, docs/AGENT-INSTALL.md, docs/DEVELOPER.md, docs/contributing.md and pkg/skills-cli/README.md
- [ ] In docs/install.md, remove the channel-review stop step and keep the two layout rows of the legacy move
- [ ] Do not edit pkg/common/src/node/layout.ts: its two `channel-review` entries are not in the removal list
- [ ] After the deletes, no source file of dg names a credential below `channel-review/` or a `CHANNEL_REVIEW_` variable
- [ ] In .github/workflows/skills-blt.yml, remove the path `pkg/channel-review/**` and the lint and test steps of pkg/channel-review
- [ ] In .gitleaks.toml, remove the allow rule of the deleted `channel-review-connect.spec.ts`
- [ ] In .mise/config.toml, remove: each task that runs `channel-review` or has `dir = "pkg/channel-review"`, the `CHANNEL_REVIEW_RELAY_SECRET_*` entry of `redactions`, and the words on channel-review in the `description` of the build task
- [ ] Delete the specs of the removed code (pkg/skills-cli/__tests__/channel-review-*.spec.ts, pkg/skills-test/__tests__/channel-review-skill.spec.ts, pkg/dg-daemon/__tests__/store/channel-review-state.spec.ts) and update each spec that names channel-review in a list
- [ ] Update each spec that uses channel-review outside a list: pkg/skills-cli/__tests__/layout-write-guard.spec.ts (it imports `launchChrome` from the deleted connect module: give the guard test a different subject, or remove it), cli-only.spec.ts, lazy-commands.spec.ts and completion.spec.ts; pkg/skills-test/__tests__/no-local-zone.spec.ts (it scans `pkg/channel-review/src`), skill-cli-invocation.spec.ts (the SessionStart hook command), agent-namespacing.spec.ts, google-sms-cleanup-skill.spec.ts (the README order test) and cli-smoke.spec.ts; keep pkg/skills-cli/__tests__/clean.spec.ts, because its `channel-review` is a layout entry that stays
- [ ] Rename the credential fixtures that use the prefix `channel-review/` to `my-service/` and keep each assertion: pkg/common/__tests__/credentials-format.spec.ts, pkg/common/__tests__/installed-skill-files.ts, pkg/dg-daemon/__tests__/store/credentials-store.spec.ts, pkg/dg-daemon/__tests__/server/credentials-frame.spec.ts, pkg/skills-cli/__tests__/credentials-cli.spec.ts and pkg/skills-cli/__tests__/doctor-fixtures.ts
- [ ] Update the table lists of pkg/dg-daemon/__tests__/store/overwatch-board.spec.ts and pkg/dg-daemon/__tests__/store/scheduled-jobs.spec.ts
- [ ] Keep pkg/skills-cli/__tests__/test-home-fence.ts, test-run-end.ts and home-fence.spec.ts: each package bunfig preloads the fence
- [ ] In pkg/skills-test/__tests__/outside-services-docs.spec.ts, change the test `does not deprecate ADR 0020 or ADRs 0008 to 0019`: the assertion on 0020 stays; the toc assertion now expects `Deprecated` for each record from 0008 to 0019
- [ ] Name the new spec of the state copy pkg/common/__tests__/channel-review-state-copy.spec.ts
- [ ] pkg/common/src/node/fs.ts keeps `removeInside`, and pkg/common/src/node/log-tail.ts and pkg/common/src/node/prompt.ts stay: the `job` verbs use them
- [ ] Use the commit subject `feat(skills-cli)!: remove channel-review` with a `BREAKING CHANGE:` footer that links docs/channel-review.md, so the release is a major
- [ ] Write no private organization name and no private repository name in a file; the migration note uses `<bot repository URL>`
- [ ] In `openDaemonDatabase` of pkg/common/src/node/daemon-db.ts, read the schema version first; make the copy only when the version is 12, 13 or 14 and `sqlite_master` holds `channel_review_state`
- [ ] Before the migration to version 15 runs on such a database, write one file for each row of `channel_review_state`: `<daemonDir>/channel-review-state.<env>.json`, with `writeFileAtomic(path, data, 0o600)`
- [ ] Put the copy code in one named function in daemon-db.ts; add no new source file
- [ ] Each copy is one JSON object `{ "env", "revision", "updatedAt", "state" }`; `state` is the parsed `state_json` of the row
- [ ] `openDaemonDatabase` is the one caller of `runMigrations` with `SCHEMA_STEPS`; pkg/dg-daemon/src/store/index.ts opens daemon.db through it, so the copy is on each path to step 15
- [ ] When a copy cannot be written, the open fails with an error that names the path, and step 15 does not run
- [ ] The `pre-migration-v<version>-….db` copy of pkg/common/src/node/sqlite.ts stays as it is
- [ ] The migration note names the copy files `channel-review-state.<env>.json` and `pre-migration-v<version>-….db`, and their folder, and says that dg makes one `pre-migration` file for each step
- [ ] Set `Status: Deprecated` in each record from docs/adr/0008 to docs/adr/0019 (twelve files; 0018 and 0019 go from `Proposed` to `Deprecated`), and add one line below it that says that channel review left dg and links the job sources record of slice 20; change no other line of those records
- [ ] In docs/adr/toc.md, show the twelve records as deprecated with the line form `- [<number> — <title>](<file>) — Deprecated: channel review left dg`, on one line (the spec matches `/00(0[89]|1\d)[^\n]*Deprecated/`); move 0018 and 0019 out of `Proposed changes` to the section of the other channel-review records
- [ ] Change the toc legend so that `Deprecated` agrees with a record that links a replacement
- [ ] Do not change the text of ADRs 0002, 0003, 0007 and 0042, and do not edit CHANGELOG.md; the release workflow writes it
- [ ] In docs/DEVELOPER.md, remove the section of the `CR-` error codes
- [ ] Give in the commit message the reason that step 12 stays: a database at version 11 needs it to get to version 15
- [ ] Start from .github/workflows/skills-blt.yml as slice 6 left it
- [ ] Remove the `dg-daemon service` group, pkg/dg-daemon/src/commands/service.ts and the `/services` route; `dg-daemon stop --force` lists with `/jobs` only; a search of pkg/dg, pkg/launcher and plugins for `dg-daemon service` finds nothing outside the migration note and the `BREAKING CHANGE:` text
- [ ] Remove the alias forms of the `job` group: `--label`, `--cron`, `--pass-env`, `rm`, `run` and `exec`; also remove the stderr note text of the alias forms and its specs; a search of pkg/dg, pkg/launcher and plugins for `--pass-env` finds nothing outside the migration note and the `BREAKING CHANGE:` text
- [ ] Keep `migrateServicesKey` and `migrateScheduledRows` and their calls at daemon start, so a machine that jumps a release still migrates; remove no column of `scheduled_jobs`
- [ ] Remove the re-export of `promptHidden` from pkg/skills-cli/src/credentials/cli.ts with the spec that used it
- [ ] The `BREAKING CHANGE:` footer names each removal: channel review, the `dg-daemon service` group, the `/services` route and the alias forms
- [ ] docs/jobs-and-services.md and plugins/dg/skills/jobs/SKILL.md lose the old → new table rows that name a removed form, and say that the old forms are gone
- [ ] After the removals, run `bun scripts/completion-trees.ts` and commit the tree files that changed; do not edit the JSON by hand
- [ ] In pkg/skills-cli/src/completion/describe.ts, remove the import of `../channel-review/cli` and the `"channel-review"` entry; the tree step and `bun run lint:all` fail without this
- [ ] Remove `CHAT_SERVICES_PATH` from pkg/common/src/chat-format.ts, its two uses in pkg/dg-daemon/src/server/http.ts, and the `/services` fallback of pkg/dg-daemon/src/commands/stop.ts; chat-format.spec.ts loses the case of the constant
- [ ] services-http.spec.ts, outside-service.spec.ts and stop.spec.ts move their requests to `/jobs` and the key `jobs`
- [ ] service-add-rm.spec.ts and service-live-daemon.spec.ts test the removed command group: delete each case that job-verbs.spec.ts already has, and move each other case to the `job` verbs; a spec that tests the supervisor through a fixture config (for example service-autostart.spec.ts and service-shutdown.spec.ts) stays
- [ ] The state copy runs before `runMigrations`, outside the transaction of step 15; `MigrationStep` does not change
- [ ] The migration note says that the old channel-review daemon must be stopped before the upgrade, so no process writes the state between the copy and the drop
- [ ] pkg/common/__tests__/channel-review-state-copy.spec.ts builds its database in a temp folder below the fence and reads no DG path of the real home
- [ ] In pkg/skills-test/__tests__/outside-services-docs.spec.ts, also change the tests `covers the new actions and the gating rules` and `carries the final no-daemon message`: SKILL.md no longer holds `dg-daemon service add`, `dg-daemon service rm` or `dg-daemon job exec`, and the `services` no-daemon text goes with service.ts

#### Testing Criteria
##### Contracts
- [ ] Contract: `dg-skills channel-review status` exits 1 with the unknown-command error of commander; `dg-skills --help` does not list `channel-review`
- [ ] Contract: a new daemon.db has the schema version 15 and no object whose name starts with `channel_review`
- [ ] Contract: a daemon.db at version 14 with one `channel_review_state` row moves to version 15, and one at version 13 moves through 14 to 15; the three objects are gone; the row counts of each other table are equal before and after
- [ ] Contract: a daemon.db at version 11 moves through steps 12 to 15 with no error
- [ ] Contract: a build of the release before the major refuses a version 15 database with `ForwardOnlyVersionError`; method: `runMigrations(db, SCHEMA_STEPS.slice(0, -1))` on a database at schema version 15 throws `ForwardOnlyVersionError`; specs use `CURRENT_SCHEMA_VERSION` where they can, not the number 15
- [ ] Contract: after the upgrade, `dg-skills credentials list` still shows each `channel-review/` name, and the grant token file exists
- [ ] Contract: a skills-only install removes an installed dg copy of the `channel-review` skill (hash match) and keeps a copy with other content
- [ ] Contract: `rg --hidden -il "channel-review|channel_review" pkg plugins .github .gitleaks.toml .mise .claude-plugin README.md SECURITY.md .env.example docs scripts` finds only: pkg/common/src/node/daemon-schema.ts, daemon-db.ts, install-skills.ts and layout.ts; pkg/common/__tests__/layout.spec.ts, pkg/skills-cli/__tests__/clean.spec.ts, pkg/skills-cli/__tests__/layout-write-guard-e2e.spec.ts, pkg/common/__tests__/node-daemon-db.spec.ts and pkg/common/__tests__/node-sqlite.spec.ts; pkg/common/__tests__/channel-review-state-copy.spec.ts (the new spec of the copy); the retired-skill fixture; and in docs/ only docs/channel-review.md, the ADR files and docs/adr/toc.md; pkg/common/src/chat-format.ts is not in the result
- [ ] Contract: docs/channel-review.md holds the seven ordered steps that come before the upgrade step, and the words `no downgrade`
- [ ] Contract: skills-blt.yml has no step with `pkg/channel-review`
- [ ] Contract: plugins/dg/skills/jobs/SKILL.md holds no `channel-review` text and no `"hooks": {` fence; `bun scripts/skill-bootstrap-block.ts --check` exits 0
- [ ] Contract: a database at version 14 with a `dev` row and a `prod` row gives `channel-review-state.dev.json` and `channel-review-state.prod.json` beside daemon.db, each with mode 0600 (POSIX), and then has no object whose name starts with `channel_review`
- [ ] Contract: `state` of each copy is deep-equal to the `state_json` of its row; `revision` and `updatedAt` are the values of the row
- [ ] Contract: a database with no `channel_review_state` row, and a new database, give no copy file
- [ ] Contract: when a copy path is not writable, the open throws an `Error` that holds the path; the schema version does not become 15 and the row is present
- [ ] Contract: a second open at version 15 writes no file and changes no copy
- [ ] Contract: a search for `SCHEMA_STEPS` in pkg/*/src finds one `runMigrations` call, in pkg/common/src/node/daemon-db.ts
- [ ] Contract: each record from docs/adr/0008 to 0019 has the line `Status: Deprecated` and one link to the job sources record; `git diff` shows no other changed line in those files
- [ ] Contract: docs/adr/toc.md lists 0018 and 0019 outside `Proposed changes`
- [ ] Contract: the two `channel-review` entries of `LAYOUT_TABLE` are equal to master
- [ ] Contract: a database at version 11 makes no copy file, gives no error, and moves to version 15
- [ ] Contract: the `RETIRED_SKILL_HASHES` list holds the hash of the SKILL.md of the last release before the major; the spec proves it with the fixture file: the hash of the fixture copy is in the list
- [ ] Contract: in pkg/skills-test/__tests__/outside-services-docs.spec.ts, the test on ADR 0020 keeps its assertion on 0020, and its toc assertion expects `Deprecated` for each record from 0008 to 0019
- [ ] Edge: the first start of the major does not read and does not change the pid file of the old channel-review daemon
- [ ] Check: each relative link in docs/, README.md and SECURITY.md opens an existing file
- [ ] Check (manual; no spec): use the private-name Check of slice 7 on the files of `git diff origin/master --name-only`, and report only `found` or `not found`
- [ ] Check: pkg/launcher/__tests__/size-budget.spec.ts passes
- [ ] Check: `skillFilesCheck` and `allowRuleCheck` stay in pkg/skills-cli/src/doctor/checks.ts, because the doctor groups `file`, `ssms` and `inbox` call them; the delete of pkg/skills-cli/src/channel-review/doctor.ts removes one caller only
- [ ] Regression: `bun test` passes at the root and in each package directory; `bun run lint:all` passes; `bun install --frozen-lockfile` passes
- [ ] Contract: `dg-daemon service status` exits 1 with the unknown-command error of commander; `GET /services` gives 404
- [ ] Contract: `dg-daemon job add --label x --every 15m --cwd <dir> -- <cmd>` and `dg-daemon job rm x` exit 1 with the unknown-option and unknown-command errors of commander
- [ ] Contract: a config with `services` and a store with scheduled rows that are not moved, from two releases before, still migrate at the first boot of the major
- [ ] Contract: `bun scripts/completion-trees.ts --check` exits 0, and no tree holds `channel-review`, `service` below `dg-daemon`, or an alias form
- [ ] Contract: `rg CHAT_SERVICES_PATH pkg` finds nothing
- [ ] Contract: two opens of one database at version 14 at the same time give one correct set of copy files and one migration; the second process gets no error, reads version 15 and writes nothing (`writeFileAtomic` makes each file write safe)
- [ ] Check: no link in the repository points at an anchor of the old docs/channel-review.md or of a removed toc section (for example `toc.md#channel-review`)

#### Acceptance Criteria
- [ ] Given the major release, when the owner runs `dg-skills channel-review`, then the command does not exist
- [ ] Given a machine that ran channel review, when the daemon of the major starts, then daemon.db has no channel-review object and each other table keeps its rows
- [ ] Given the same machine, when the owner lists the credentials, then the `channel-review/` entries are present
- [ ] Given docs/channel-review.md, when the owner reads it, then it gives the order add, stop, export, enable, verify, remove the hook, remove the `review-<env>` jobs, upgrade
- [ ] Given the repository, when `ls pkg` and `ls plugins/dg/skills` run, then no `channel-review` folder exists
- [ ] Given the PR, when the release workflow reads its commits, then the next version is a major
- [ ] Given a machine that ran channel review, when the daemon of the major starts the first time, then one JSON copy of the state of each env is beside daemon.db, and the tables are gone
- [ ] Given docs/adr, when a reader opens a record from 0008 to 0019, then its status is Deprecated and it links the job sources record
- [ ] Given the major release, when `dg-skills doctor` runs, then it reports no `channel-review` group and no unknown-group error
- [ ] Given a script that calls `dg-daemon service start <name>`, when it runs on the major release, then the command does not exist, and docs/jobs-and-services.md gives `dg job start <name>`

## Slice Summaries

- Slice 17: A job binds a stored credential to an environment variable with --credential <name>=<NAME> (add and update of a file or command job) or the block key env on a credential; the entry key credentialEnv holds the binding; buildJobEnv reads each value at every launch and places it after the envFile, passEnv and allowlist values and before the DG_* keys; a missing, NUL-holding, unreadable or reserved-prefix value makes the start invalid.
- Slice 16: dg job add <path> adds a script file as one job (record kind path, no question, no clone) or a folder with a dg block as block jobs (record keeps the declaration hash); update re-reads a folder block with no question; list and status show source changed, source missing and source invalid; remove never touches the path.
- Slice 15: dg job enable [--setup <file|->] and dg job setup [--refresh|--rotate-token] run a wizard that takes each credential from a hidden prompt, a --setup file or AWS Secrets Manager, stores it through the job credential route and makes the grant; --credential works on add and update of a command job; sources.json takes command records and the prefixAccepted and setupDone marks; the hidden prompt lives in @dg/common.
- Slice 14: dg job update <job> on a repository job fetches the recorded origin with hardened git, resolves the stored ref (a full sha stays pinned), shows the changed keys, asks or takes --yes, checks out the new commit, runs build, and rewrites the entries and the record under the lock with byte-exact rollback and an old-commit restore.
- Slice 13: dg job add <git-url>[@ref] clones with hardened git, pins the full commit id, reads the dg block from the committed package.json, prints a sanitized and quoted request, asks consent or takes --yes, runs build, then writes the registry record and the entries under the config lock with byte-exact rollback; job remove, list and status handle repository jobs.
- Slice 12: POST /jobs/<name>/credentials is write-only for the credential prefix of one job (status, set, delete, ensure-grant, rotate-grant); the prefix is the grant of the job entry, read per request; createJobCredentialClient in @dg/common/node; RESERVED_CREDENTIAL_PREFIXES with a source-reading spec.
- Slice 19: dg-skills channel-review export --env --label writes import.json (version 1) into the job state folder with mode 0600; it refuses a live daemon and reads state read-only; commands.md and the dg-skills completion tree list it.
- Slice 11 (c4ba56e9): docs/jobs-and-services.md uses the noun job, with the verb table, the old and new table, the run rules, the move, the rollback and the limits; ADR 0049 records the job model; ADR 0043 and the ADR 0020 amendment link it; the jobs skill gets ## Job verbs. job-model-docs.spec.ts is new. Vale did not run (not installed); markdownlint is clean on the new files.
- Slice 10 (a79f1eba, 24ef07fb): scheduled rows move to the jobs table at daemon start in three steps, and the runner runs them through the one launcher. The argv rewrite runs with PRAGMA secure_delete=ON, then PRAGMA wal_checkpoint(TRUNCATE); a spec proves that no 32-byte part of the old ciphertext stays in daemon.db or daemon.db-wal.
- Slice 9 (eb04798d): dg job verbs (add, enable, disable, update, remove, start, stop, restart, list, status, logs, run); service group and old job forms stay as aliases with a note; helpers in job-support.ts; log tail and prompt in @dg/common. New-form scheduled add refuses --notify without --feed and empty argv parts. 12 table-row specs stay red until slice 10.
- Slice 8 (2a97c1b9): services entries move to the jobs table at daemon start with config.json.pre-jobs; continuous jobs carry continuous: true; supervisor, HTTP routes and service verbs read jobs; service write verbs wait for the migration mark. stop --force falls back to /services unless /jobs names this instanceId; entries with unknown keys move unchanged.
- Slice 7 (3e05d897): docs name dg as the front door (ADR 0020 amendment, Start at login, dg launcher in install docs, two-used-folders block); dg-front-door-docs.spec.ts checks every dg command form against ROUTES.
- Slice 6 (db195b91): install, bootstrap.sh and bootstrap.ps1 write a dg launcher and keep a foreign dg file with a warning; the marker check reads the first 4096 bytes; doctor and completion know dg; release smoke runs four names.
- Slice 5 (fe7975d8): new pkg/dg routes job, autostart, upgrade and the other commands to the dg-daemon, dg-skills and dg-agent mounts; the launcher mounts dg.
- Slice 4 (4f8ce290): autostart moved to @dg/common/node for dg-phone and dg-daemon; dg-daemon autostart install, remove and status; a managed daemon starts and stops through its manager. e91cf8a5 adds exit 78 to the chat skill table.
- Slice 3: serve, service add and service rm exit 78 with two used daemon folders; one rename remedy; stale target set aside only for a real directory. Specs changed: layout.spec.ts.
- Slice 2 (64453ee7): job source and state paths, isJobName, removeInside with a real-path check; the supervisor injects DG_SERVICE_STATE_DIR and DG_HOME. Residuals are in Issues Remediation.
- Slice 1 (cc825ca1): each package preloads the test home fence; resolveDgPaths throws outside DG_PATH_FENCE; test spawns with their own env pass fenceEnv(). 12 MEDIUM/LOW residuals are in Issues Remediation.

## Agent Notes

- (orchestrator) PR 1 opened as draft: https://github.com/detailedghost/dg-ai/pull/227 (slices 1-7 plus review fixes 35f3e2fd and 6a605d37). PR 2 starts in a new worktree after it merges.
- (slice 7, dg:lore) docs/install.md has the new anchor #two-daemon-folders-hold-data and move rule 13; jobs-and-services.md keeps the line '`dg job` runs `dg-daemon job`' for pairing-docs.spec.ts.
- (orchestrator) Slice 7: the phrases the slice 7 specs match are the wording contract; the doc agent writes them as given.
- (orchestrator) Slice 6: bootstrap.ps1 now tests the marker in the first 4096 bytes only, as writeShims and bootstrap.sh do; the ps1 spec pins that check.
- (slice 4, dg:js) Slice 9's job enable must call assertNotBlocked before installDaemonAutostart, which does not call it.
- (slice 4, dg:js) PR body: manual checks on real systemd, launchd and Windows task, and the WSL sign-out check; the tolerated /End and bootstrap failures; the win32 restart on exit 3 and 78.
- (orchestrator) Slice 4: commands cmdAutostartInstall/Remove/Status; the command adds the 'autostart install:' prefix; managedRestartCommands(kind, uid, name, unitPath); XDG lines use the quoted Environment="KEY=value" form; spawn joins DaemonStartSeams.
- (orchestrator) Slice 3 contract reworded: `service status` reads no config, so the exit-78 contract names `service rm`.
- (slice 3, dg:js) PR 1 body: remedy text (move <state>/daemon to another name, then start again), dg-daemon serve now exits 78 for a home with two used folders, and layout.spec.ts is the only spec whose result changed.
- (orchestrator) Slice 3: master had no assertNotBlocked in readConfigStrict. Accepted the agent reading: readConfigStrict calls assertNotBlocked(paths, "daemon"), and guardConfig passes a DgCliError through so exit 78 survives; `service add` and `service rm` exit 78 with two used folders, and `service status` prints the two-used text and exits 1 with 'no live dg-daemon'. config-store.ts, service.ts and keychain-step.spec.ts join the files of slice 3.
- (slice 2, dg:js) PR body limits: the daemon gives a child its DG_HOME only (not XDG_*_HOME, LOCALAPPDATA or APPDATA); preflight makes the state folder only at start.
- (orchestrator) Slice 2: the permission-cause 400 test may skip as root and on win32; the regular-file cause covers the contract.
- (orchestrator) Slice 3: an absent legacy source stays `absent`; the rename-sentence constant is `TWO_USED_RENAME`; the missing compiled, keychain and Windows-order tests are written in green.

- (slice 1, dg:js) The fence preload sets DG_PATH_FENCE to os.tmpdir(); the fence guards resolveDgPaths only, and code that calls os.homedir() directly is outside it.
- (slice 1, dg:js) Bun's os.homedir() keeps the real home after HOME changes, so a spec for the default roots must pass seams.homeDir and seams.env.
- (slice 1, dg:js) A spawn with no env option inherits the fenced process.env; a spawn that passes its own env must carry DG_PATH_FENCE (fenceEnv()) and a HOME below os.tmpdir().
- PR 1 merged: #227 squash 41447a28 on 2026-11-19, tested head 49bf373e. Codex reviewed round 1 only (usage limit); CI fixes after it: pwsh dangling-link keep check, skills-blt pages build. Open: issues 7, 21, 22, 30.
- (orchestrator) Slice 8: argument checks with no config run before ensureMigrated; lookup checks after it; a write verb on a home with no config file is refused, starts no daemon and writes nothing. JobDecl shape is the engineer's; enabled defaults to false. Only the five plan error texts are exact; others contain the key name. A services/jobs conflict at serve boots, writes nothing and logs, as for invalid JSON. A non-object jobs value: <file>: "jobs" must be an object.
- (orchestrator) Slice 8: stop --force uses the GET /jobs answer only when body.instanceId equals the daemon instanceId; each other answer (404, 403, 200 with no or another instanceId) falls back to GET /services. This extends the plan rule "only a 404 falls back" so an old daemon (v1.10 to v2.0) cannot leave service trees running.
- (orchestrator) Slice 8: the services move copies an entry that holds a key outside argv, cwd, envFile, autostart, passEnv, stopTimeoutMs and grant with no change, so it stays invalid and never autostarts.
- (orchestrator) Slice 9: ensureMigrated keeps the old failure text after the move (no behavior change). A new-form scheduled add (--name with --schedule/--every) refuses --notify without --feed, as update does; the legacy --label/--cron forms keep master behavior. passEnv names are de-duplicated. After a failed login-unit install the question is asked again (no mark). The interim scheduled-add refusal of --env/--env-file/--pass-env stays until slice 10.
- (orchestrator) Slice 10: a table entry equal to the entry built from an unrenamed row counts as already written (no -2); a renamed row resumes by name. migrateScheduledRows may take a logger and return a result; in-process tests may replace the boot log assertions. --notify without --feed is refused on the new form. Unit tests against new runner/launcher names are welcome once the names exist.
- (orchestrator, 2026-11-19) Handoff to Susie. Branch feature/job_install is pushed: slice 8 2a97c1b9, slice 9 eb04798d, slice 10 aa3c41d7 (work in progress). Slice 10 waits on one SPEC decision: after markJobsMoved rewrites a moved row argv as [], old ciphertext can stay in the SQLite WAL or free pages; choose PRAGMA secure_delete, a WAL checkpoint after the move, or accept it. Slice 11 has not started. The slice 10 wave result lists more CONFIRM notes (service status now lists scheduled entries; parseJobEntry accepts empty argv parts after the first for scheduled entries; JOBS_VERSION is 2; schema version 14).
- (owner, 2026-11-19) Slice 10: after markJobsMoved rewrites the argv of a moved row as [], run the rewrite with PRAGMA secure_delete=ON, then PRAGMA wal_checkpoint(TRUNCATE), so the old ciphertext leaves the free pages and the WAL. A spec proves that the old ciphertext bytes are absent from the db and -wal files after the move.
- (orchestrator, 2026-11-19) Slice 10: the connection gets its old secure_delete value back after the move. wal_checkpoint(TRUNCATE) returns busy with no error when another connection holds a read; at daemon start the daemon holds the only connection. The pre-migration-v14 snapshot that runMigrations writes to the daemon folder still holds the old encrypted argv: RATIFY sent to the owner (keep, delete after a good move, or scrub).
- (owner, 2026-11-19) RATIFY on the pre-migration-v14 snapshot: option (b). After a good row move (markJobsMoved succeeded and the scrub ran), the daemon deletes the pre-migration-v14-*.db snapshot and its -wal, -shm and -journal files. The database rollback is given up; docs, ADR 0049 and the PR body say so.
- (orchestrator, 2026-11-19) Slice 11: the ADR number is 0049. dg-front-door-docs.spec.ts gets one more change than the plan names: the amendment link limit moves from 0048 to 0049, because the ADR 0020 amendment now links ADR 0049. outside-services-docs.spec.ts also changes 'does not kill a job' to 'does not kill a dispatch command', because stop --force now kills the process tree of each job that runs, scheduled runs included.
- (orchestrator, 2026-11-19) Branch feature/job_install rebased on origin/master 45a380b7 (5.15.0); one conflict in supervisor.ts (master's ensureRealPrivateDir kept, decl.name used).

- (slice 19, dg:js) runExport(flags, io, platform?) is in pkg/skills-cli/src/channel-review/export.ts; slice 21 removes it with the command.
- (slice 19, dg:js) Legacy state is detected by "lastEventId" in state; readPidRecord and isOurDaemon use ps, so live-daemon specs keep ps on PATH.
- (slice 19, dg:js) Export failures print channel-review export: lines to stderr with exit 1 (not DgCliError, to avoid the dg-skills prefix); a blocked layout keeps its own text and exit code.

- (slice 12, dg:js) isReservedCredentialPrefix(prefix) is in @dg/common credentials-format.ts; slices 13, 15 and 16 use it in assertPrefixFree.
- (slice 12, dg:js) The loopback Host refusal comes from the global check in http.ts and answers 400 as plain text: the one exception to 'each refusal is JSON'. Put it in the PR body.
- (slice 12, dg:js) OLDER_DAEMON_TEXT is exported from job-credentials-client.ts; job-support.ts has its own copy with the same text.
- (slice 12, dg:js) HttpServerDeps requires readJobs; a hand-built deps object in a later spec must pass it. CredentialStore.inspectCredentialGrant verifies with no last_used_at write.
- (slice 12, dg:js) Two jobs can share a prefix and one token file: slice 15 must not revoke a shared grant when it removes one job.
- (slice 12, dg:js) writeNewGrant checks the layout and makes the token folder before it changes the grant row; a failed file write after that can still leave a stale row, which the next ensure-grant repairs (PR body).

- (slice 13, dg:js) resolveRef(deps, cloneDir, ref, url) takes the URL for its error text; slice 14 needs a prefix argument or its own wrapper because the prefix is job add:.
- (slice 13, dg:js) git(deps, args, cwd) in job-source.ts is not exported; clone argv is -c protocol.ext.allow=never -c protocol.fd.allow=never clone --quiet --no-recurse-submodules -- <url> <dir>; the git env drops each local-repo variable.
- (slice 13, dg:js) parseJobDeclaration returns jobs as { name, entry }[] and credentials verbatim; describeCredentials(jobs, credentials) gives the normalized list; formatRequest takes an optional existingState map.
- (slice 13, dg:js) sources.ts reader accepts only kind git; slice 16 must widen it. job-source.ts exports removeJobFromSource, addSource, defaultJobSourceDeps, splitGitArgument and displayUrl. registerJobCommands takes Partial<JobSourceDeps>.
- (slice 13, dg:js) job-source-kit.ts exports makeRepo, commit, gitIn, fileUrl, jobDeclaration, makeTools, sandbox and runJob; sandbox sets DG_HOME and DG_KEY_SOURCE=file.
- (slice 13, dg:js) A started repository job that lists credentials cannot start until slice 17.
- (slice 13, dg:js) PR body behavior changes: --cwd is checked by addVerb (job add: --cwd is required), not by commander; --yes is new; the request quotes repository values.
- (slice 13, dg:js) (orchestrator) Slice 13: a block job whose state folder already exists gets the request line 'state folder exists: <path> (kept from an earlier job)' (security review RATIFY, taken as option a: a two-way door). Signal handling exits 130/143/129 and a signal inside the lock leaves a record that job remove clears. Known gap: a token in the user part of an https URL is stored in sources.json and the clone config.

- (slice 14, dg:js) job-source.ts exports the shared add/update helpers (git, gitEnv, SAFE_GIT, onInterrupt, snapshotOf, rollBack, RollbackFailure, readBlock, resolveJobs, resolveBuild, insideClone, findRef, credentialLines, quote, show, stop); several take an optional error prefix.
- (slice 14, dg:js) job-update.ts exports updateSource(name, {yes}, deps) and writeBlockEntries(paths, config, jobs) returning {replaced, created}; slice 16 reuses writeBlockEntries.
- (slice 14, dg:js) Slice 15 adds --credential to UPDATE_FLAG_KEYS in jobs.ts and refuses it on a repository job with the declares-this-in-its-dg-block text.
- (slice 14, dg:js) checkRecord in sources.ts now owns every record rule; its text is 'the record of "<source>" in <file> is not valid: it <why>' with no command prefix.
- (slice 14, dg:js) (orchestrator) Slice 14 security review: a 40-hex ref is checked only with cat-file and never as a tag or branch name (add and update); the origin check reads the raw remote.origin.url; update git calls carry core.hooksPath=devNull and core.fsmonitor=false; fetch uses --prune --prune-tags --no-recurse-submodules. PR body: with --yes a changed credential source applies with no person present (plan X1 c); ignored build output can block a tracked path at the next checkout.

- (slice 15, dg:js) job-setup.ts exports JobSetupDeps (client(paths, job), stdin seam), defaultJobSetupDeps, runEnableWizard and runSetup; registerJobCommands takes Partial<JobSourceDeps & JobSetupDeps>.
- (slice 15, dg:js) secret-sources.ts exports fetchSecret, SecretFetchError(kind, detail), defaultRunSource (detached, process-group SIGKILL, 30 s, 128 KiB), FETCH_TIMEOUT_MS, RunSource and SecretSource; fetchSecret prints nothing; slice 18 builds its own 502 texts.
- (slice 15, dg:js) setup-answers.ts exports parseSetupAnswers and checkAnswers; env-file.ts exports assertPrivateOpenFile(fd, path, noun).
- (slice 15, dg:js) sources.ts: readSources gives git records only; readSourceRecords gives git and command records; findMarkRecord and updateMarks handle the marks; records refuse unknown keys. AddScheduledInput takes credentials and grant.
- (slice 15, dg:js) Value fixtures in wizard specs look like tok-alpha-91f3c2d8: a bare v1 collides with 'service API v1'.
- (orchestrator) Slice 15 security review RATIFY taken as option (a), under the plan rule that adoption applies to setup: setup --rotate-token and --refresh also need the adoption answer for a non-empty prefix with no prefixAccepted mark (no terminal: exit 1), and --rotate-token refuses a missing grant. enable writes prefixAccepted after the sets even when ensureGrant then fails, but not setupDone or enabled. onInterrupt now calls exitAfterDrain (pkg/common exit rule). Known gap for slice 21: promptHidden leaves raw mode on SIGTERM/SIGHUP.

- (slice 16, dg:js) PathSourceRecord is { kind: path, path, jobs, declarationHash?, credentials } plus marks; a file job record is keyed by the job name and has no declarationHash; jobs.ts routes update to updateLocal only when declarationHash is present.
- (slice 16, dg:js) readSources and SourceRegistry are gone; readNamedSources (git and path) and readSourceRecords (all kinds) are the registry readers; findRecordByJob and findMarkRecord return path records.
- (slice 16, dg:js) job-entry.ts is the one module that turns add flags into a job entry (aliasNote, announceAliases, duration, assertOneMode, checkEntryFlags, entryFromFlags); slice 17 adds entry flags there, not in addVerb.
- (slice 16, dg:js) job-local.ts exports addLocal and updateLocal; job-update.ts exports refuseLiveJobs; rollBack takes a fifth argument (pass an empty string for a path source).
- (orchestrator) Slice 16: the Engineering item 'a bun that moved leaves the job invalid, and update repairs it' is not built (Issues Remediation row 31). Folder add keeps the slice 13 'already exists' text; a file add has the 'to change it, run dg job update' suffix. next: dg job restart prints for a running or backoff job with a replaced line. The job add description in the completion tree now names a local file or folder.

- (slice 17, dg:js) LauncherDeps and SupervisorDeps require readCredential(name); bootstrap.ts gives one readCredential to both. JobDecl.credentialEnv is always set by parseJobEntry. readBoundCredentials(decl, readCredential) in launcher.ts is the one read path; envNameProblem(name) in config.ts is the one name rule (pattern, DG_ prefix, injection names, 64 characters, __proto__).
- (slice 17, dg:js) credentialEnv inside a block job is refused; a block binds only through env on a credential. job update merges credentialEnv and refuses a variable that another credential binds; there is no unbind flag.
- (slice 17, dg:js) Slice 20 documents that the child and its children see a bound value in their environment.
- (orchestrator) Slice 17 security review: the high finding (a hand-edited pw grant could read a sealed value into the environment) is fixed in checkCredentialEnv and readBoundCredentials. RATIFY taken as option b, a two-way door: the text after = of --credential is never echoed when it fails the name rule, and a variable name is 64 characters at most, so a pasted secret does not reach config.json or stderr. The old guard that refused = in a credential name is replaced by the binding syntax; say so in the PR body. A scheduled tick has no separate preflight: a missing credential records failed to start with the credential name; runNow and the continuous preflight return invalid.

## Issues Remediation

| id | slice | from | severity | status | description |
|----|-------|------|----------|--------|-------------|
| 1 | 1 | review | med | resolved | pkg/skills-cli/__tests__/bootstrap-fixtures.ts:327: Bun.spawnSync env literal (PATH, HOME, TMPDIR, DG_SKILLS_DEST, DG_SKILLS_NO_CLI) has no process.env spread and no fenceEnv(), so the child runs without DG_PATH_FENCE. Add ...fenceEnv() (owner: engineering). |
| 2 | 1 | review | low | open | pkg/channel-review/__tests__/runners-spawn.spec.ts:558: CONFIRM: request([process.execPath, child], { env: { THRASH_EXECUTION_CONTEXT: ... } }) passes an env literal with no fenced HOME and no DG_PATH_FENCE. Whether request() merges process.env was not verified. If it does not, the spawn is unfenced and should spread fenceEnv(). |
| 3 | 1 | review | low | open | pkg/dg-daemon/__tests__/server/pw-ext-credential.spec.ts:406: CONFIRM: the expected value changed from homedir() to process.env.HOME ?? homedir(). This is an assertion-side change that the brief says not to make. The orchestrator should confirm it. |
| 4 | 1 | review | low | open | pkg/common/src/node/dg-paths.ts:218: CONFIRM: the fence check runs after the memo lookup, not before it as the brief states. The result is equivalent because the check runs on every call, and a throwing call caches nothing, but the order differs from the spec wording. |
| 5 | 1 | review | med | resolved | pkg/skills-test/__tests__/thrash-pipeline-skill.spec.ts:235,255: Spawns build a literal env ({ PATH, HOME }) with no DG_PATH_FENCE, so the child resolves DG paths with the fence off (HOME is under tmpdir, so no leak today, but the guard is gone). Brief: each such spawn gets HOME below os.tmpdir() and the parent DG_PATH_FENCE. Same gap at pkg/skills-test/__tests__/skill-bootstrap-block.spec.ts:118, |
| 6 | 1 | review | low | open | pkg/skills-cli/__tests__ + pkg/dg-agent/__tests__ + pkg/channel-review/__tests__ (spawn audit result): Audit done. Every spawn in skills-cli, dg-agent and channel-review now passes process.env (mergeEnv, installEnv, subprocessEnv spread it) or fenceEnv(). Spawns changed in this slice: dg-agent layout-lazy-load.spec.ts (env literal + fenceEnv), skills-cli cli-fixtures.ts isolatedGitEnv (feeds fixtu |
| 7 | 1 | review | med | resolved | pkg/common/__tests__/dg-paths-fence.spec.ts (test 'throws again on a repeat call because a throwing call caches nothing'): Test cannot fail: the fence check runs after the memo lookup on every call, so a repeat call throws even if the first call had cached its result. It does not prove the Contract 'a call that throws adds nothing to the path cache'. Fix: after the throwing call, assert the cache  |
| 8 | 1 | review | med | resolved | pkg/skills-cli/__tests__/cli-binary-lib.spec.ts:142-153; pkg/skills-test/__tests__/install-logic.spec.ts:124-137: Both specs turn the fence off (delete process.env.DG_PATH_FENCE) around cliDest with DG_HOME=/opt/dg instead of passing seams, which the brief names as the pattern for default-root specs. Window is synchronous and restored in finally, so no leak, but the spec now tests with the guard r |
| 9 | 1 | review | med | open | pkg/dg-daemon/__tests__/server/pw-ext-credential.spec.ts:406: Assertion changed from realpathSync(homedir()) to realpathSync(process.env.HOME ?? homedir()). The brief says change only setup, not assertions. Needed because bun homedir() keeps the real home after HOME changes, but the '?? homedir()' fallback silently re-admits the real home when HOME is unset. Report as CONFIRM. Prefer an explicit e |
| 10 | 1 | review | low | open | pkg/common/src/node/dg-paths.ts:assertInsideFence: When a fence is set, realpathSync(fence) runs on every resolveDgPaths call, including memo hits, which adds a filesystem syscall to a hot, previously pure path. Only active with DG_PATH_FENCE set (tests, hostile env), so low impact. Also the fence is not validated before the memo hit when seams.env lacks it, which is intended. No fix needed beyond |
| 11 | 1 | review | low | open | pkg/skills-test/__tests__/home-fence-reach.spec.ts: Only packages whose test script matches /\bbun test\b/ are checked, as the brief says. A package whose script wraps bun test (for example 'bun run test:unit') passes unchecked. The reach spec also has a test that re-implements nothing from production but its 'preloadsFence' helper is exercised only against fixtures; the failing-package-name Contr |
| 12 | 1 | review | low | open | pkg/skills-cli/__tests__/doctor-fixtures.ts:23: New import of ./fence-env sits below a const block mid-file (the file already placed an import after CHANNEL_REVIEW_CONFIG). Pre-existing pattern, now extended; move imports to the top for consistency. |
| 13 | 2 | review | low | resolved | pkg/dg-daemon/src/services/supervisor.ts: SPEC: supervisor.ts:277-283 (preflight) with pkg/common/src/node/fs.ts:47-50 (ensurePrivateDir). CWE-59 (link following). preflight follows a link at <jobStateRoot>/<label>. mkdirSync accepts a link to a folder, and chmodSync sets mode 0700 on the folder that the link points to. The child then gets a DG_SERVICE_STATE_DIR that resolves outside jobStateRoot. |
| 14 | 2 | review | low | open | pkg/dg-daemon/src/services/supervisor.ts: CONFIRM: supervisor.ts:155. The daemon now gives each child its DG_HOME. A dg-skills, dg-agent or dg-daemon call from a child therefore resolves <DG_HOME>/state/daemon/owner.token. These call sites read it: common/src/node/cli-client.ts:42, common/src/node/page-code.ts:21, dg-daemon/src/commands/service.ts:63, commands/stop.ts:78 and dg-agent/src/start.ts: |
| 15 | 2 | review | low | open | pkg/dg-daemon/src/services/supervisor.ts: CONFIRM: supervisor.ts:146-155. When the daemon has no DG_HOME (or an empty one), a DG_HOME line in envFile, or a passEnv DG_HOME, still gets to the child. The code deletes the grant keys at lines 163-164 but does not delete DG_HOME. The child can then use a different dg home and owner token than the daemon. This agrees with the spec text ('a daemon with n |
| 16 | 2 | review | low | open | pkg/common/__tests__/node-fs.spec.ts: node-fs.spec.ts:206 and :223. The link contract '[DECIDED — gaps pass O1 (b)]' test, and the 'links are removed, never followed' block, skip on win32. The orchestrator allows a win32 skip only for the 0700 mode assertion and for the permission cause of the 400 contract. On Windows, a process with no privilege can make a directory junction with symlinkSync(targ |
| 17 | 2 | review | low | resolved | pkg/common/src/node/dg-paths.ts: SPEC: dg-paths.ts:245 (JOB_NAME / isJobName). The rule accepts the Windows reserved device names con, nul, aux, prn, com1-com9 and lpt1-lpt9 (Microsoft 'Naming Files, Paths, and Namespaces'). On win32, jobStateDir and jobSourceDir can then return a path whose last part is a device name. The service label regex in services/config.ts:7 already accepted these names on |
| 18 | 4 | review | med | resolved | pkg/dg-daemon/src/commands/start.ts: isTolerated leaves a failed schtasks /End or launchctl bootstrap out of the startup-timeout suffix; the contract says any nonzero manager command. State it in the PR body. |
| 19 | 4 | review | low | open | pkg/common/src/node/autostart.ts: the win32 task restarts dg-daemon up to 10 times after exit 3 or 78; systemd stops through RestartPreventExitStatus. A task has no such field. |
| 20 | 4 | review | low | resolved | pkg/dg-daemon/src/commands/autostart.ts: launchd logs to <logDir>/dg-daemon-autostart.log, but install does not make logDir first; a fresh home can fail the job at load. |
| 21 | 4 | review | low | resolved | pkg/dg-daemon/src/commands/autostart.ts: a failed reinstall removes the earlier good unit (matches the contract, loses the old unit); the hand-over line prints only on the first install. |
| 22 | 4 | review | low | resolved | pkg/common/src/node/autostart.ts: systemd enable and schtasks /Run errors now show firstLine(stdout); the dg-phone error text differs from master for multi-line output. |
| 23 | 5 | review | low | open | pkg/dg/src/main.ts: the autostart ROUTES row is 137 characters; the usage text repeats the completion description that EXTRAS holds; parity.spec.ts HELP_ROWS repeats routing.spec.ts EXPECTED_ROUTES. |
| 24 | 6 | review | low | open | pkg/skills-cli/src/doctor/registry.ts: the dg-launcher check is wired in the registry, not next to launcher-on-path in shared.ts. bootstrap.ps1 fixtures run only under pwsh, which is absent here. |
| 25 | 6 | review | low | open | pkg/skills-cli: 'thrash review checkout > stack --diff makes one clone for two open PRs' failed 1 run in 3; not in a slice file. Flaky. |
| 26 | 7 | review | low | open | pkg/skills-test/__tests__/dg-front-door-docs.spec.ts: the launcher-list check skips whole paragraphs that name ~/.dg/bin and the docs/contributing.md package-set sentence (release parts, not launchers). |
| 27 | 7 | review | low | open | docs/jobs-and-services.md: 'Start at login' sits after the closing Service API paragraph; slice 11 rewrites the file and may move it. Vale reports 56 errors in existing text only. |
| 28 | 4 | review | low | resolved | pkg/dg-daemon/src/commands/start.ts:46: managed start awaits each manager command with no timeout (runArgv); the 15 s STARTUP_TIMEOUT_MS starts after the loop, so a hung systemctl restart or schtasks delays the failure message (bounded by the manager's own timeout). |
| 29 | 5 | review | low | open | pkg/dg/src/main.ts:93: --version repeats process.env.DG_BUILD_VERSION ?? 'dev' (fourth copy, with launcher, dg-agent and skills-cli). Not hoisted, to keep the launcher bundle free of a new shared import. |
| 30 | 5 | review | low | resolved | .github/workflows/skills-blt.yml: no workflow runs pkg/launcher tests and pkg/launcher/** triggers none, so dg-mount, dispatch and size-budget never run in CI (as on master). |
| 31 | 16 | review | low | open | Engineering item "a bun that moved leaves the job invalid, and update repairs it" is not built: no check marks such a job invalid, and the command-job update cannot rewrite argv. Repair today: job remove, then job add. No Contract covers it. |
| 32 | 13 | review | low | open | A token in the user part of an https URL (https://TOKEN@host/...) is accepted and stored in sources.json and the clone .git/config. The slice text permits a user part. |
| 33 | 15 | review | low | open | promptHidden (moved to pkg/common, no behavior change) leaves the TTY in raw mode on SIGTERM or SIGHUP and accepts control characters in the value. Fix with slice 21 or later. |
| 34 | 12 | review | low | open | noteSecret adds each value of 8+ characters to a Set that never shrinks; each owner-token set adds up to 128 KiB. Owner-only, not an attack path. |
## PR Plan

Four PRs and one operator gate, in this order. Each PR starts in a new worktree from master after the PR before it merges. The `depends_on` edges 7 → 8, 11 → 12 and 11 → 19 hold this order.

- PR 1 (minor), slices 1 to 7: `feat(dg): add the dg entry command`. It holds the two fixes (test home fence, layout), the job paths, `dg-daemon autostart` and the `dg` program with its launcher and documents. `dg` must exist before an output says `dg job …`. Slice 1 starts from the work that is in the worktree of the branch `feature/service_install`.
- PR 2 (minor), slices 8 to 11: `feat(dg-daemon): merge services and scheduled jobs into jobs`. It changes live data: each `services` entry and each scheduled row moves to the `jobs` table at daemon start, with the backup `config.json.pre-jobs`. It ships alone, so a defect has one cause.
- PR 3 (minor), slices 12 to 20: `feat(dg-daemon): add jobs from a repository or a local path, with credential setup`. It also adds the operation `refresh` to service API v1 (slice 18). The review bot repository needs this release.
- OPERATOR GATE: stop here. The owner confirms each item on a PR 3 release:
  1. `dg job status --json` shows each bot job as `running`.
  1. Each bot job came from `dg job add` and `dg job enable`, with no `dg-skills credentials` command.
  1. The bot imported import.json.
  1. Each env posted one review after the import.
  1. `dg job list` shows each scheduled job from before PR 2, with a next run time.
  1. No script of the owner calls `dg-daemon service` or an old `dg-daemon job` form; the stderr note of the alias forms finds them.
- PR 4 (major), slice 21: `feat(skills-cli)!: remove channel-review`, with a `BREAKING CHANGE:` footer. It also removes the `dg-daemon service` group, the `/services` route and the alias forms. It starts only after the gate.
- `pr_strategy: single` means one repository, not one PR. The executor builds each PR in its own worktree with `assign resolve --slices <its ids>`, stops at the OPERATOR GATE, and starts slice 21 only after the owner confirms the six items.
- Each PR body lists its behavior changes. PR 1: `dg-daemon serve` exits 78 for a home with two used daemon folders. PR 2: a moved scheduled job gets a larger environment and its stderr in the log file; `job run` needs a live daemon; a scheduled `add` with `--name` writes a job that is not enabled and prints `next: dg job enable <name>`, and the alias forms `--label` and `--cron` keep the enabled job of today; `job add` refuses a new name that fails the job name rule. [DECIDED — gaps pass X2 part 1 (a), part 2 refuse]
- Present the four PR drafts (title and full body) for one approval before PR 1 opens (batch PR rule).
- Review each PR with three local Codex rounds (`/dg:review-loop -p codex`). Request no Copilot review.
- Commits are Conventional Commits with a scope and no AI co-author trailer.

After PR 2 merges, add the term `job` to the local vocabulary file `.agents/monolith.md` by hand: git does not track that file, so no slice owns it.

Before PR 2 merges, the owner searches the argv of the scheduled jobs of the machine for a secret: the move writes that argv as plain text into a config file with mode 0600.

## Code Structure

### Test home fence

- **Decision:** Each package preloads one fence file, and `resolveDgPaths` throws when a DG path is outside `DG_PATH_FENCE`.
- **Home:** `pkg/skills-cli/__tests__/test-home-fence.ts`, `pkg/common/src/node/dg-paths.ts`
- **Rationale:** One preload protects each `bun test` run in each package directory, and the error finds a spec that leaves the fence.
- **Alternatives:** A fence only in the root bunfig.toml — CI runs `bun test` in each package directory; temp homes below the fence home — about 170 spec files make sibling homes below `os.tmpdir()`.
- **Applies to:** slices 1, 4, 9, 19, 21

### Job paths

- **Decision:** `DgPaths` holds `jobsDir`, `jobSourcesPath` and `jobStateRoot`; `jobSourceDir(paths, source)` and `jobStateDir(paths, name)` are the only builders; `isJobName` is the one name rule, and the two builders throw for a name that fails it; the pid and log paths of a job keep the word `service`.
- **Home:** `pkg/common/src/node/dg-paths.ts`
- **Rationale:** One place gives each folder of a job, and a pid path that does not move cannot start a second instance after an upgrade.
- **Alternatives:** A path built in each command — two commands can disagree; a rename of the pid and log files — the supervisor finds a live instance by the pid file.
- **Applies to:** slices 2, 8, 13, 16, 19

### Delete guard

- **Decision:** Each recursive delete of a clone goes through `removeInside(root, dir)`, which refuses a directory that is not inside the root, and it compares real paths when they exist. [DECIDED — gaps pass O1 (b)]
- **Home:** `pkg/common/src/node/fs.ts`
- **Rationale:** A wrong record or a link cannot make dg delete a folder outside `<data>/jobs`.
- **Alternatives:** `rmSync` at each call site — no guard; a guard in pkg/channel-review — slice 21 deletes that package.
- **Applies to:** slices 2, 13

### Layout block exit code

- **Decision:** A daemon that finds two daemon folders with data exits with `EXIT_LAYOUT_BLOCKED` (78), and the systemd unit does not start it again for that code; launchd and the Windows task cannot filter an exit code. [DECIDED — gaps pass O2 (a)]
- **Home:** `pkg/common/src/errors.ts`, `pkg/common/src/node/layout.ts`
- **Rationale:** One code separates a block that needs the owner from a crash that a restart can repair.
- **Alternatives:** Exit 1 — the service manager starts the daemon again in a loop; a merge of the two folders — dg cannot know which data is current.
- **Applies to:** slices 3, 4, 7

### Shared autostart module

- **Decision:** The login unit code is in pkg/common with `AutostartDeps`, `defaultAutostartDeps()` and `autostartManages`; the dg-daemon install action is the function `installDaemonAutostart(deps, paths)`, which `job enable` calls after its one question.
- **Home:** `pkg/common/src/node/autostart.ts`, `pkg/dg-daemon/src/commands/autostart.ts`
- **Rationale:** The phone listener and the daemon write the same unit kinds, and `enable` needs the install with no second copy.
- **Alternatives:** A copy of the phone module in dg-daemon — two unit writers; a login unit that `enable` writes with no question — the owner did not agree to it.
- **Applies to:** slices 4, 9

### Program name list

- **Decision:** `PROGRAM_NAMES` keeps the three programs that have a command tree; `ProgramName` adds `"dg"`; shims.ts has `PROGRAMS` with four names and `LEGACY_PROGRAMS` with three, and files.ts lists four programs for the completion files; `isDgLauncher` in shims.ts is the one test for a `dg` file of a different tool.
- **Home:** `pkg/common/src/node/program.ts`, `pkg/skills-cli/src/install/shims.ts`, `pkg/skills-cli/src/completion/files.ts`, `pkg/skills-cli/src/install/cli.ts`, `pkg/skills-cli/src/commands/completion.ts`
- **Rationale:** Slice 5 adds the program with no change of an install, and slice 6 turns on the launcher and the completion files in one step.
- **Alternatives:** `dg` as a fourth member of `PROGRAM_NAMES` — install and completion change in the slice that only adds the program; a second list in each caller — the lists drift.
- **Applies to:** slices 5, 6

### dg route table

- **Decision:** `ROUTES` is the one readonly record of the nine `dg` names; each value holds `program`, `command` and `description`; the usage text, the routing and the document specs read it.
- **Home:** `pkg/dg/src/main.ts`
- **Rationale:** A document cannot show a `dg` group that the program does not route.
- **Alternatives:** A name list in each docs spec — it drifts from the program; a `service` route — users see only the noun `job`.
- **Applies to:** slices 5, 7, 11, 20

### dg completion by delegation

- **Decision:** `dg __complete` gives the first word from `ROUTES` and gives each later word to `__complete` of the mounted program; pkg/dg has no tree file.
- **Home:** `pkg/dg/src/main.ts`
- **Rationale:** No file of pkg/dg becomes stale when a command of a mounted program changes.
- **Alternatives:** A generated tree for `dg` — each slice that changes a command of a mounted program would also own that file; no completion for `dg` — the entry command would have less than the three old names.
- **Applies to:** slices 5, 6

### Generated command trees

- **Decision:** A slice that changes a command, an option or a description runs `bun scripts/completion-trees.ts` and commits the tree file; no slice edits the JSON by hand.
- **Home:** `pkg/dg-daemon/src/completion-tree.json`, `pkg/skills-cli/src/completion/tree.json`
- **Rationale:** A spec in each package fails when the tree is stale, so the tree file is in the `files` list of each slice that changes a command.
- **Alternatives:** One slice at the end that writes each tree — each earlier slice ends with a failed spec; a `serializing` entry for the trees — it gives the tree to each slice that touches a command file, also to a slice that changes no command.
- **Applies to:** slices 4, 6, 9, 13, 14, 15, 16, 17, 19, 21

### Jobs table and entry parser

- **Decision:** `<state>/daemon/config.json` has one `jobs` table; `parseJobEntry` is the one validator for a command job, a block job and a moved entry; an entry has exactly one of `continuous`, `schedule` and `every`.
- **Home:** `pkg/dg-daemon/src/jobs/config.ts`
- **Rationale:** One rule set gives the same errors for each way to make a job.
- **Alternatives:** Two tables with one CLI noun — two parsers and two launch paths stay; a `mode` key with a value — the flags and the block keys would have different names.
- **Applies to:** slices 8, 9, 10, 13, 16, 17

### Migration mark

- **Decision:** Only the daemon migrates, at each start and under the config lock; the services move writes the mark 1, and the row move writes `JOBS_VERSION`; `isMigrated(config)` with `JOBS_VERSION` is the one guard of each CLI write, and `ensureMigrated` is the one CLI step that waits for the mark.
- **Home:** `pkg/dg-daemon/src/jobs/migrate.ts`
- **Rationale:** A CLI write cannot land between the two moves, and the second move changes one constant and no caller.
- **Alternatives:** A migration in each CLI verb — two processes can move the same data; a guard for each migration — each caller changes two times.
- **Applies to:** slices 8, 10, 21

### One launcher

- **Decision:** `launcher.ts` exports `buildBaseEnv`, `buildJobEnv`, `launchJob` and `jobLogFile`; it builds the environment, opens the log and starts the process for a continuous job and for a scheduled run; the refresh operation uses `buildBaseEnv` for its fetch.
- **Home:** `pkg/dg-daemon/src/jobs/launcher.ts`
- **Rationale:** A scheduled run gets the log file, the grant keys, the state folder and a bound credential with no second code path.
- **Alternatives:** The runner keeps its own spawn — a scheduled job has no log and no grant; the launcher inside supervisor.ts — the runner must import the supervisor.
- **Applies to:** slices 8, 10, 17, 18

### Job control seam

- **Decision:** The HTTP routes call only `JobControl` (`start`, `stop`, `status`); the supervisor and the runner are behind it.
- **Home:** `pkg/dg-daemon/src/jobs/control.ts`
- **Rationale:** Slice 10 adds scheduled jobs to the routes with no edit of http.ts.
- **Alternatives:** Routes that call the supervisor — a scheduled job needs a second route set; an edit of http.ts in slice 10 — the slice that moves data would also change the HTTP surface.
- **Applies to:** slices 8, 10

### Job CLI support module

- **Decision:** The lock, the daemon call, the three guards of `remove`, `ensureMigrated`, `JobVerbDeps` and `resolveExecutable` with its `which` parameter are exports of one module that the `job` verbs and the `service` alias group import.
- **Home:** `pkg/dg-daemon/src/commands/job-support.ts`
- **Rationale:** The later slices need the same exports and must not edit the file that holds the verbs.
- **Alternatives:** Helpers that stay in service.ts — slice 21 deletes that file; a copy in each command file — the guards drift.
- **Applies to:** slices 9, 10, 13, 14, 15, 16

### Scheduled seam of the CLI

- **Decision:** jobs.ts reaches a scheduled job only through six exports of job-schedule.ts: `addScheduled`, `findScheduled`, `setScheduledEnabled`, `removeScheduled`, `runScheduledNow` and `listScheduled`.
- **Home:** `pkg/dg-daemon/src/commands/job-schedule.ts`
- **Rationale:** Slice 10 moves the scheduled rows to the table and does not own the command tree; its one edit of jobs.ts is the delete of the interim rules of slice 9.
- **Alternatives:** Scheduled code inside jobs.ts — the slice that moves data would own the file of the full command surface and its tree; the move in slice 9 — the command surface and a data migration ship as one slice.
- **Applies to:** slices 9, 10

### Log tail module

- **Decision:** `readTail` and `follow` are in pkg/common; `job logs` and the channel-review `logs` command call them, and each caller keeps its own message for an absent file.
- **Home:** `pkg/common/src/node/log-tail.ts`
- **Rationale:** The second caller is in another package, and the module stays when slice 21 deletes pkg/channel-review.
- **Alternatives:** An import of pkg/channel-review from dg-daemon — the removal breaks it; a second copy — two follow loops.
- **Applies to:** slices 9, 21

### Source registry

- **Decision:** `<data>/jobs/sources.json` holds one record for each source, of kind `git`, `path` or `command`, with the job names, the credential details that the owner saw, and the marks `prefixAccepted` (one mark for the source) and `setupDone` (a list of job names); a file job has a record of kind `path` from `add`. [DECIDED — gaps pass O11 (a)]
- **Home:** `pkg/dg-daemon/src/jobs/sources.ts`
- **Rationale:** `enable`, `setup`, `update`, `remove` and the refresh operation read what the owner agreed to, not the file in the clone.
- **Alternatives:** The details in the `jobs` table — each job of a source would hold a copy of the credential details; a read of the clone at each `enable` — a change in the clone would pass with no consent.
- **Applies to:** slices 13, 14, 15, 16, 17, 18

### dg block declaration

- **Decision:** `parseJobDeclaration` is the one reader of the `dg` key of a package.json, for a clone and for a local folder; `declarationHash` covers the full `dg` value.
- **Home:** `pkg/dg-daemon/src/jobs/declaration.ts`
- **Rationale:** A repository and a folder follow one key list, and each change of the block is visible at `update`.
- **Alternatives:** A reader for each source kind — the key lists drift; a hash of the jobs only — a new credential source would pass with no question.
- **Applies to:** slices 13, 14, 16, 17, 20

### Source by syntax

- **Decision:** `classifySource` decides from the text of the argument: a scheme or `user@host:` is git, a path prefix is a local path, and with no positional argument the text after `--` is a command; `classifySource` stays the one router.
- **Home:** `pkg/dg-daemon/src/commands/job-source.ts`, `pkg/dg-daemon/src/commands/job-local.ts` (the two local actions)
- **Rationale:** The result does not depend on what exists on the disk, so one argument always means one thing.
- **Alternatives:** A check that the path exists — a typing error becomes a clone attempt; a `--git` or `--path` flag — one more thing to type for the common case.
- **Applies to:** slices 13, 15, 16

### Consent step

- **Decision:** `formatRequest` and `sanitize` make the request text of `add` and `update`; the `confirm` and `isTerminal` seams, which come from `JobVerbDeps`, or `--yes` give the answer, and no repository code runs before it.
- **Home:** `pkg/dg-daemon/src/jobs/sanitize.ts`, `pkg/dg-daemon/src/commands/job-source.ts`, `pkg/dg-daemon/src/commands/job-update.ts`
- **Rationale:** The owner sees the same text for an add and for an update, and a spec can answer with no terminal.
- **Alternatives:** A text for each command — the two can show different keys; consent at `enable` — the build of the repository already ran at `add`.
- **Applies to:** slices 13, 14, 15, 18

### Credential prefix and reserved names

- **Decision:** dg sets the credential prefix: the source name for a repository or a folder, the job name for a file job or a command job; a name of `RESERVED_CREDENTIAL_PREFIXES` is refused, and that list also holds `db`; `assertPrefixFree` in job-source.ts is the one clash check.
- **Home:** `pkg/common/src/credentials-format.ts`
- **Rationale:** With an automatic grant, a repository must not choose which stored secrets it can read.
- **Alternatives:** A `grant` key in the block — a repository could name the prefix of another tool; one prefix for each job — a credential that two jobs share is stored two times.
- **Applies to:** slices 12, 13, 15, 16

### Job credential route and client

- **Decision:** The CLI writes credentials and makes the grant only through `POST /jobs/<name>/credentials` with the owner token; the route has no operation that returns a value, and `ensure-grant` makes a token only when none is valid.
- **Home:** `pkg/dg-daemon/src/server/job-credentials.ts`, `pkg/common/src/node/job-credentials-client.ts`
- **Rationale:** No agent session is necessary, and a second `enable` cannot break the token of a job that runs.
- **Alternatives:** A temporary session on the `/cli` socket — other commands see that session; the CLI opens the store file — key handling moves into a second process.
- **Applies to:** slices 12, 15

### Typed secret sources

- **Decision:** A credential source is data of the one type `aws-secretsmanager`; `fetchSecret` runs one fixed argv through the `runSource` seam for the wizard, for `setup --refresh` and for the service API operation `refresh`; secret-sources.ts holds the one default `runSource` and the typed `SecretFetchError`.
- **Home:** `pkg/dg-daemon/src/jobs/declaration.ts`, `pkg/dg-daemon/src/jobs/secret-sources.ts`
- **Rationale:** The request text can show each parameter, and one function holds the argv for the CLI and for the daemon.
- **Alternatives:** A command source in the block — repository argv runs with the cloud login of the owner; an argv in each caller — the wizard and the refresh operation can drift; Azure Key Vault in this bundle — the owner moved it to a later bundle.
- **Applies to:** slices 13, 15, 18, 20

### Credential refresh operation

- **Decision:** `refresh` of `/service-api/v1/credentials` takes a credential name and a job name, fetches only from the source in the record of that job, stores the value, returns no value, and starts one fetch at most for one credential in 60 s.
- **Home:** `pkg/dg-daemon/src/server/service-api.ts`, `pkg/dg-daemon/src/jobs/credential-refresh.ts`
- **Rationale:** A job that gets a refusal from its upstream can repair its credential with no command of the owner, and it cannot make the daemon read a secret that the owner did not see.
- **Alternatives:** A source in the request — a job could read each secret that the cloud login can reach; a fetch in the job itself — the value does not get to the dg credential store; no limit — a job in a failure loop starts an `aws` process for each try.
- **Applies to:** slices 18, 20

### Hidden prompt module

- **Decision:** `readLine` (slice 9), `promptHidden`, `HiddenInput` and `readCredentialValue` (slice 15) are in pkg/common; skills-cli keeps one re-export until slice 21.
- **Home:** `pkg/common/src/node/prompt.ts`
- **Rationale:** The wizard is the third caller and is in another package.
- **Alternatives:** An import of pkg/skills-cli from dg-daemon — a dependency in the wrong direction; a second prompt in dg-daemon — two hidden-input paths to keep safe.
- **Applies to:** slices 9, 13, 15, 21

### channel-review export file

- **Decision:** The export writes `import.json` with `version: 1` into the state folder of the job that reads it, `jobStateDir(paths, label)`.
- **Home:** `pkg/skills-cli/src/channel-review/export.ts`
- **Rationale:** The bot finds the file in the folder that the daemon gives it as `DG_SERVICE_STATE_DIR`, with no path in a document.
- **Alternatives:** A path option — the owner must copy a path by hand; a read of daemon.db by the bot — slice 21 drops those tables.
- **Applies to:** slices 19, 20, 21

### Record numbers in docs/adr

- **Decision:** A slice that writes a record takes the next free number from origin/master when it starts; the `files` lists name the records by glob, and other slices link them by title.
- **Home:** `docs/adr/*-jobs.md`, `docs/adr/*-job-sources-and-credentials.md`
- **Rationale:** Another branch can take a number before this work merges.
- **Alternatives:** Fixed numbers in the plan — a taken number makes each link wrong; one record for the two subjects — PR 2 would ship a record for code of PR 3.
- **Applies to:** slices 11, 20, 21
