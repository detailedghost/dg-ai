---
feature: dg skills consolidation
feature_snake_case: dg_skills_consolidation
date: '2026-10-16'
version: '1.1'
status: draft
current_slice: 0
pr_strategy: single
bundle: .agents/spec/005_dg_skills_consolidation
plan_path: .agents/spec/005_dg_skills_consolidation/plan.md
slices:
  - id: 1
    name: w2a-foundation-stash
    depends_on: []
    files:
      - pkg/common/src/node/scratch-paths.ts
      - pkg/common/src/node/index.ts
      - pkg/common/__tests__/scratch-paths.spec.ts
      - pkg/skills-cli/src/utils/legacy-command.ts
      - pkg/skills-cli/__tests__/legacy-command.spec.ts
      - pkg/skills-cli/src/commands/stash.ts
      - pkg/skills-cli/src/stash/**
      - pkg/skills-cli/__tests__/stash*.spec.ts
      - pkg/skills-test/__tests__/no-local-zone.spec.ts
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - plugins/dg/skills/what-changed/**
      - plugins/dg/skills/clipboard-img/**
      - plugins/dg/skills/hook-comment-disable/**
      - plugins/dg/skills/wayfinder/**
      - plugins/dg/skills/refactor/**
      - plugins/dg/skills/stash/**
      - pkg/common/package.json
      - bun.lock
      - pkg/skills-cli/__tests__/git-repo-fixtures.ts
    agents:
      primary: js
      qa:
        - qa-code
        - reviewer
  - id: 2
    name: w2a-vcs-provider
    depends_on:
      - 1
    files:
      - pkg/skills-cli/src/provider/**
      - pkg/skills-cli/src/utils/git.ts
      - pkg/skills-cli/src/utils/shell-args.ts
      - pkg/skills-cli/src/utils/json.ts
      - pkg/skills-cli/src/commands/vcs-provider.ts
      - pkg/skills-cli/src/vcs-provider/**
      - pkg/skills-cli/__tests__/vcs-provider*.spec.ts
      - pkg/skills-cli/__tests__/fake-cli.ts
      - pkg/skills-cli/__tests__/provider-*.spec.ts
      - pkg/skills-cli/__tests__/{git,shell-args,json}.spec.ts
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/skills-cli/__tests__/cli-fixtures.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 3
    name: w2a-proxy
    depends_on:
      - 2
    files:
      - pkg/skills-cli/src/commands/proxy.ts
      - pkg/skills-cli/src/proxy/**
      - pkg/skills-cli/__tests__/proxy*.spec.ts
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - plugins/dg/skills/proxy/**
      - pkg/skills-cli/src/utils/skill-assets.ts
      - pkg/skills-cli/src/utils/self-command.ts
      - pkg/skills-cli/__tests__/skill-assets.spec.ts
      - pkg/skills-cli/__tests__/self-command.spec.ts
      - pkg/skills-cli/package.json
      - bun.lock
    agents:
      primary: js
      qa:
        - qa-code
  - id: 4
    name: w2a-release
    depends_on:
      - 3
    files:
      - pkg/*/package.json
      - .claude-plugin/plugin.json
      - plugins/dg/.codex-plugin/plugin.json
      - pkg/dg-daemon/src/server/status.ts
      - pkg/skills-test/__tests__/channel-review-skill.spec.ts
      - docs/DEVELOPER.md
      - README.md
      - plugins/dg/skills/README.md
      - pkg/skills-test/__tests__/release-versions.spec.ts
      - bun.lock
    agents:
      primary: lore
      qa:
        - qa-devops
  - id: 5
    name: w2b-address-review-loop
    depends_on:
      - 4
    files:
      - pkg/skills-cli/src/commands/address.ts
      - pkg/skills-cli/src/address/**
      - pkg/skills-cli/__tests__/address*.spec.ts
      - plugins/dg/skills/address/**
      - plugins/dg/skills/review-loop/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 6
    name: w2b-thrash
    depends_on:
      - 5
    files:
      - pkg/skills-cli/src/commands/thrash.ts
      - pkg/skills-cli/src/thrash/**
      - pkg/skills-cli/__tests__/thrash*.spec.ts
      - plugins/dg/skills/thrash/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 7
    name: w2b-chain-file
    depends_on:
      - 6
    files:
      - pkg/skills-cli/src/commands/chain.ts
      - pkg/skills-cli/src/chain/**
      - pkg/skills-cli/__tests__/chain*.spec.ts
      - pkg/skills-cli/src/commands/file.ts
      - pkg/skills-cli/src/file/**
      - pkg/skills-cli/__tests__/file*.spec.ts
      - plugins/dg/skills/chain/**
      - plugins/dg/skills/file/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 8
    name: w2b-meaningful-deps-upgrade
    depends_on:
      - 7
    files:
      - pkg/skills-cli/src/commands/meaningful.ts
      - pkg/skills-cli/src/meaningful/**
      - pkg/skills-cli/__tests__/meaningful*.spec.ts
      - pkg/skills-cli/src/commands/deps-upgrade.ts
      - pkg/skills-cli/src/deps-upgrade/**
      - pkg/skills-cli/__tests__/deps-upgrade*.spec.ts
      - plugins/dg/skills/meaningful/**
      - plugins/dg/skills/deps-upgrade/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 9
    name: w2b-catchup
    depends_on:
      - 8
    files:
      - pkg/skills-cli/src/commands/catchup.ts
      - pkg/skills-cli/src/catchup/**
      - pkg/skills-cli/__tests__/catchup*.spec.ts
      - plugins/dg/skills/catchup/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 10
    name: w2b-channel-review-defaults-release
    depends_on:
      - 9
    files:
      - pkg/channel-review/src/config.ts
      - pkg/channel-review/__tests__/core-config.spec.ts
      - pkg/channel-review/__tests__/runners-index.spec.ts
      - pkg/channel-review/__tests__/automation-config.spec.ts
      - plugins/dg/skills/channel-review/references/setup.md
      - pkg/*/package.json
      - .claude-plugin/plugin.json
      - plugins/dg/.codex-plugin/plugin.json
      - pkg/dg-daemon/src/server/status.ts
      - pkg/skills-test/__tests__/channel-review-skill.spec.ts
      - docs/DEVELOPER.md
      - README.md
      - plugins/dg/skills/README.md
      - pkg/skills-test/__tests__/no-local-zone.spec.ts
      - pkg/channel-review/src/runners/index.ts
      - pkg/channel-review/src/runners/probe.ts
      - pkg/channel-review/__tests__/runners-probe.spec.ts
      - plugins/dg/skills/grill-me/references/protocol.md
      - pkg/skills-test/__tests__/release-versions.spec.ts
      - bun.lock
    agents:
      primary: js
      qa:
        - qa-code
        - qa-devops
  - id: 11
    name: w3-worktree
    depends_on:
      - 10
    files:
      - pkg/skills-cli/src/commands/worktree.ts
      - pkg/skills-cli/src/worktree/**
      - pkg/skills-cli/__tests__/worktree*.spec.ts
      - plugins/dg/skills/worktree/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/skills-cli/src/deps-upgrade/worktree-compat.ts
      - pkg/skills-cli/__tests__/deps-upgrade-worktree.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 12
    name: w3-spec-sdlc-assign
    depends_on:
      - 11
    files:
      - pkg/skills-cli/src/commands/spec.ts
      - pkg/skills-cli/src/spec/**
      - pkg/skills-cli/__tests__/spec*.spec.ts
      - plugins/dg/skills/spec/**
      - plugins/dg/skills/sdlc/**
      - plugins/dg/skills/assign/**
      - plugins/dg/skills/grill-me/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/skills-cli/package.json
      - bun.lock
      - plugins/dg/skills/prd/**
      - plugins/dg/skills/kick/**
      - plugins/dg/skills/pickup/**
    agents:
      primary: js
      effort: xhigh
      qa:
        - qa-code
        - reviewer
  - id: 13
    name: w3-monolith-spring-break
    depends_on:
      - 12
    files:
      - pkg/skills-cli/src/commands/monolith.ts
      - pkg/skills-cli/src/monolith/**
      - pkg/skills-cli/__tests__/monolith*.spec.ts
      - plugins/dg/skills/monolith/**
      - plugins/dg/skills/spring-break/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 15
    name: w3-release
    depends_on:
      - 13
    files:
      - pkg/*/package.json
      - .claude-plugin/plugin.json
      - plugins/dg/.codex-plugin/plugin.json
      - pkg/dg-daemon/src/server/status.ts
      - pkg/skills-test/__tests__/channel-review-skill.spec.ts
      - docs/DEVELOPER.md
      - README.md
      - plugins/dg/skills/README.md
      - plugins/dg/skills/review-loop/**
      - plugins/dg/skills/polish/**
      - pkg/skills-test/__tests__/release-versions.spec.ts
      - bun.lock
    agents:
      primary: lore
      qa:
        - qa-devops
  - id: 16
    name: w4-jot
    depends_on:
      - 15
    files:
      - pkg/skills-cli/src/commands/jot.ts
      - pkg/skills-cli/src/jot/**
      - pkg/skills-cli/__tests__/jot*.spec.ts
      - plugins/dg/skills/jot/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 17
    name: w4-bg-cls-stat
    depends_on:
      - 16
    files:
      - pkg/skills-cli/src/commands/bg.ts
      - pkg/skills-cli/src/bg/**
      - pkg/skills-cli/__tests__/bg*.spec.ts
      - plugins/dg/skills/bg/**
      - plugins/dg/skills/cls/**
      - plugins/dg/skills/stat/**
      - plugins/dg/skills/proxy/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/skills-cli/src/proxy/background.ts
      - pkg/skills-cli/__tests__/proxy-background.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 18
    name: w4-sniff-nope-find-work
    depends_on:
      - 17
    files:
      - pkg/skills-cli/src/commands/sniff.ts
      - pkg/skills-cli/src/sniff/**
      - pkg/skills-cli/__tests__/sniff*.spec.ts
      - plugins/dg/skills/sniff/**
      - plugins/dg/skills/nope/**
      - plugins/dg/skills/find-work/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 31
    name: w4-doctor
    depends_on:
      - 18
    files:
      - pkg/skills-cli/src/commands/doctor.ts
      - pkg/skills-cli/src/doctor/**
      - pkg/skills-cli/src/commands/*.ts
      - pkg/skills-cli/__tests__/doctor*.spec.ts
      - plugins/dg/skills/doctor/**
      - plugins/dg/skills/*/SKILL.md
      - plugins/dg/skills/thrash/references/agent-prompt.md
      - plugins/dg/skills/review-loop/references/proxy-review-prompt.md
      - pkg/skills-cli/README.md
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/skills-test/__tests__/doctor-coverage.spec.ts
      - pkg/common/__tests__/installed-skill-files.ts
    agents:
      primary: js
      qa:
        - qa-code
  - id: 19
    name: w4-release
    depends_on:
      - 31
    files:
      - pkg/*/package.json
      - .claude-plugin/plugin.json
      - plugins/dg/.codex-plugin/plugin.json
      - pkg/dg-daemon/src/server/status.ts
      - pkg/skills-test/__tests__/channel-review-skill.spec.ts
      - docs/DEVELOPER.md
      - README.md
      - plugins/dg/skills/README.md
      - pkg/skills-test/__tests__/release-versions.spec.ts
      - bun.lock
    agents:
      primary: lore
      qa:
        - qa-devops
  - id: 20
    name: w5-db
    depends_on:
      - 19
    files:
      - pkg/skills-cli/src/commands/db.ts
      - pkg/skills-cli/src/db/**
      - pkg/skills-cli/__tests__/db*.spec.ts
      - plugins/dg/skills/db/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/skills-cli/package.json
      - bun.lock
    agents:
      primary: js
      qa:
        - qa-code
        - security
        - qa-devops
  - id: 21
    name: w5-erd-eli5
    depends_on:
      - 20
    files:
      - pkg/skills-cli/src/commands/erd.ts
      - pkg/skills-cli/src/erd/**
      - pkg/skills-cli/__tests__/erd*.spec.ts
      - plugins/dg/skills/erd/**
      - plugins/dg/skills/eli5/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/skills-cli/__tests__/fixtures/erd/**
    agents:
      primary: js
      qa:
        - qa-code
  - id: 23
    name: w5-ticket
    depends_on:
      - 21
    files:
      - plugins/dg/skills/ticket/**
      - pkg/skills-cli/src/commands/credentials.ts
      - pkg/skills-cli/__tests__/credentials*.spec.ts
      - pkg/skills-test/__tests__/ticket-skill.spec.ts
    agents:
      primary: js
      qa:
        - qa-code
        - security
  - id: 24
    name: w5-test-live-release
    depends_on:
      - 23
    files:
      - pkg/skills-cli/src/commands/test-live.ts
      - pkg/skills-cli/src/test-live/**
      - pkg/skills-cli/__tests__/test-live*.spec.ts
      - plugins/dg/skills/test-live/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/*/package.json
      - .claude-plugin/plugin.json
      - plugins/dg/.codex-plugin/plugin.json
      - pkg/dg-daemon/src/server/status.ts
      - pkg/skills-test/__tests__/channel-review-skill.spec.ts
      - docs/DEVELOPER.md
      - README.md
      - plugins/dg/skills/README.md
      - pkg/skills-test/__tests__/release-versions.spec.ts
      - bun.lock
    agents:
      primary: js
      qa:
        - qa-code
        - qa-devops
  - id: 25
    name: w6-pw
    depends_on:
      - 24
    files:
      - pkg/skills-cli/src/commands/pw.ts
      - pkg/skills-cli/src/pw/**
      - pkg/skills-cli/__tests__/pw*.spec.ts
      - plugins/dg/skills/pw/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/skills-cli/package.json
      - bun.lock
      - pkg/skills-cli/__tests__/pw/**
    agents:
      primary: js
      qa:
        - qa-code
        - qa-devops
  - id: 26
    name: w6-prototype
    depends_on:
      - 25
    files:
      - pkg/skills-cli/src/commands/prototype.ts
      - pkg/skills-cli/src/prototype/**
      - pkg/skills-cli/__tests__/prototype*.spec.ts
      - plugins/dg/skills/proto/**
      - pkg/skills-cli/src/commands/proto.ts
      - pkg/skills-test/__tests__/proto-skill.spec.ts
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/skills-cli/__tests__/prototype/**
    agents:
      primary: js
      qa:
        - qa-code
  - id: 27
    name: w6-demo-merge-release
    depends_on:
      - 25
      - 26
    files:
      - plugins/dg/skills/demo/**
      - pkg/skills-cli/src/commands/demo.ts
      - pkg/skills-cli/src/demo/**
      - pkg/skills-cli/__tests__/demo*.spec.ts
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/*/package.json
      - .claude-plugin/plugin.json
      - plugins/dg/.codex-plugin/plugin.json
      - pkg/dg-daemon/src/server/status.ts
      - pkg/skills-test/__tests__/channel-review-skill.spec.ts
      - docs/DEVELOPER.md
      - README.md
      - plugins/dg/skills/README.md
      - pkg/skills-test/__tests__/skill-manifests.spec.ts
      - pkg/skills-test/__tests__/release-versions.spec.ts
      - bun.lock
      - pkg/common/src/types.ts
      - pkg/common/src/plan-format.ts
      - pkg/common/src/demo-attachment-format.ts
      - pkg/common/src/index.ts
      - pkg/common/__tests__/demo-attachment-format.spec.ts
      - pkg/skills-cli/src/utils/plan-parse.ts
      - pkg/skills-cli/__tests__/plan-parse.spec.ts
      - pkg/extension/entrypoints/review/**
      - pkg/extension/lib/features/demo-attachment.ts
      - pkg/extension/lib/background/recording.ts
      - pkg/extension/lib/demo-messages.ts
      - pkg/extension/utils/recording-db.ts
      - pkg/extension/lib/features/demo-tour.ts
      - pkg/extension/__tests__/demo-attachment.spec.ts
      - pkg/extension/__tests__/recording-db.spec.ts
      - pkg/extension/__tests__/background-recording.spec.ts
      - pkg/extension/__tests__/demo-tour-review.spec.ts
      - pkg/common/src/tour-overlay.ts
      - pkg/common/__tests__/tour-overlay.spec.ts
      - pkg/skills-cli/src/pw/**
    agents:
      primary: js
      qa:
        - qa-code
  - id: 28
    name: w7-sync
    depends_on:
      - 27
    files:
      - pkg/skills-cli/src/commands/sync.ts
      - pkg/skills-cli/src/sync/**
      - pkg/skills-cli/__tests__/sync*.spec.ts
      - plugins/dg/skills/sync/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - plugins/dg/skills/claude-sync/**
      - plugins/dg/skills/copilot-sync/**
      - plugins/dg/skills/opencode-sync/**
      - plugins/dg/skills/codex-sync/**
      - pkg/skills-cli/__tests__/sync/**
    agents:
      primary: js
      effort: xhigh
      qa:
        - qa-code
        - reviewer
  - id: 29
    name: w7-skill-tools
    depends_on:
      - 28
    files:
      - pkg/skills-cli/src/commands/skill-audit.ts
      - pkg/skills-cli/src/skill-audit/**
      - pkg/skills-cli/__tests__/skill-audit*.spec.ts
      - pkg/skills-cli/src/commands/skill-split.ts
      - pkg/skills-cli/src/skill-split/**
      - pkg/skills-cli/__tests__/skill-split*.spec.ts
      - pkg/skills-cli/src/commands/skill-publish.ts
      - pkg/skills-cli/src/skill-publish/**
      - pkg/skills-cli/__tests__/skill-publish*.spec.ts
      - plugins/dg/skills/skill-cleanup/**
      - plugins/dg/skills/skill-publish/**
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/skills-cli/package.json
      - bun.lock
    agents:
      primary: js
      qa:
        - qa-code
  - id: 30
    name: w7-cleanup-ls-polish-release
    depends_on:
      - 29
    files:
      - plugins/dg/skills/cleanup/**
      - plugins/dg/skills/ls-skills/**
      - plugins/dg/skills/polish/**
      - pkg/*/package.json
      - .claude-plugin/plugin.json
      - plugins/dg/.codex-plugin/plugin.json
      - pkg/dg-daemon/src/server/status.ts
      - pkg/skills-test/__tests__/channel-review-skill.spec.ts
      - docs/DEVELOPER.md
      - README.md
      - plugins/dg/skills/README.md
      - pkg/skills-test/__tests__/release-versions.spec.ts
      - bun.lock
    agents:
      primary: lore
      qa:
        - qa-devops
---

## Slice Summaries
