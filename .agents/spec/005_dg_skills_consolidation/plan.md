---
feature: dg skills consolidation
feature_snake_case: dg_skills_consolidation
date: '2026-10-16'
version: '1.1'
status: in-progress
current_slice: 10
pr_strategy: single
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
      - pkg/skills-cli/src/commands/clipboard-image.ts
      - pkg/skills-cli/src/clipboard-image/**
      - pkg/skills-cli/__tests__/clipboard-image.spec.ts
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
      - pkg/common/src/node/process.ts
      - pkg/common/__tests__/node-paths.spec.ts
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
      - pkg/skills-test/__tests__/no-local-zone.spec.ts
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
      - pkg/skills-test/__tests__/no-local-zone.spec.ts
      - pkg/skills-cli/__tests__/proxy-fixtures.ts
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
      - pkg/common/__tests__/skill-files.spec.ts
      - pkg/extension/__tests__/chat-page.spec.ts
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
      - plugins/dg/skills/channel-review/references/setup.md
      - pkg/skills-cli/src/index.ts
      - pkg/skills-test/__tests__/cli-smoke.spec.ts
      - pkg/skills-test/__tests__/no-local-zone.spec.ts
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
      - pkg/skills-test/__tests__/no-local-zone.spec.ts
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
      - pkg/skills-test/__tests__/no-local-zone.spec.ts
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
      - pkg/skills-test/__tests__/no-local-zone.spec.ts
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
      - pkg/skills-test/__tests__/no-local-zone.spec.ts
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
  - id: 19
    name: w4-release
    depends_on:
      - 18
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
      - plugins/dg/skills/prototype/**
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
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
worktree:
  pr_url: null
  path: ~/code/dg/.worktrees/dg-skills-w2b
  branch: feature/dg_skills_w2b
  origin_repo: ~/code/dg
---

# dg skills consolidation

## Purpose
Move every remaining user-authored skill from ~/.claude/skills into the public dg plugin and port the ~/scripts/ai CLIs they call into dg-skills subcommands, so one repo is the single source of truth. Skills must keep working the way they do today. Work-specific values come from dg-skills credentials, never from the repo.

## Scope
### Included
- Waves 2a-7: git/PR, spec/planning, session, data, browser, and skill tooling skills plus their CLIs
- Shell CLIs (spec-cli, worktree-cli, prototype-cli, catchup.sh, test-live-*.sh) and the sync tools rewritten in TypeScript
- db and ticket read credentials from dg-skills credentials
- User demo features merged into dg:demo; dg-skills sync with targets copilot, opencode, codex, claude, pi, grok
- One draft PR per wave (2a, 2b, 3, 4, 5, 6, 7); each wave branches from the previous wave's branch
- Extension-assisted authenticated GitHub inline attachment upload after recording preview, with a receipt consumed by an explicit later demo action
- unslop (user decision 2026-10-20, replaces 2026-10-18): no vendoring and no Python port; it installs from the upstream repo through the `unslop` marketplace entry, and `/dg:polish` calls `/unslop:unslop` when installed
- Consolidation pass (user decision 2026-10-18): every port uses current Bun and Node APIs and reuses `pkg/common` helpers instead of carrying legacy copies; slice 30 removes duplicates left across waves
### Excluded
- Wave 1 (done in 9a0bb9a)
- powerbi; get-linked-context and manage-nodeterm-canvas (removed)
- Third-party skills: aws-*, amazon-bedrock, signing-in-to-aws, launch-with-aws, find-skills, caveman
- sigma-computing plugin skills (user decision 2026-10-18)
- Tools with no skill: pr-merge-sweep, code-clean, gh-time, sql-fmt, daily-prune and other hooks
- Editing ~/.claude/settings.json or any permission rule (manual cutover step for the user)
- Local cutover in ~/.claude and ~/scripts (manual, after each merge)
- viz and review (user decision 2026-10-20): dropped from dg; the viz and review skills, the `dg-skills viz` command and the vendored astro-viewer do not ship
- lineage and clockout (user decision 2026-10-20): retired fully, not ported; both are listed for deletion at the manual cutover
- unslop vendoring and a `dg-skills unslop` Python port (user decision 2026-10-20)

## Migration Contracts

These requirements apply to every port; each slice below adds its specific behavior and evidence.

- Inventory the actual legacy entrypoints, verbs, options, stdout/stderr, status codes and required support files before porting. Keep legacy behavior except the explicitly approved exceptions below; new `--help` support is additive. Use the defineCommand bridge only for matching parsers and the raw-argv bridge for custom parsers. Preserve exit 1, timeout 124 and semantic status 2 where the old command uses them; never normalize all failures to 2/3/4.
- A command registers once through `register<Name>(program)` in `src/commands/<name>.ts`, with domain implementation in `src/<name>/`. Imports do not execute a CLI or load external assets. Supporting commands without a source skill do not acquire an invented skill. Extend existing demo registration.
- Port and sanitize relevant source suites, preserving behavioral regressions. Tests use disposable repositories/remotes, fake gh/glab/build/HTTP/client boundaries and isolated scratch/state/HOME roots. Shared fixtures have one early owner. Include nested suites/assets where the flat command glob is insufficient. Add a meaningful missing behavior test rather than duplicating implementation.
- Register the command and update source smoke coverage. At wave publication, build the binary and exercise real operations from an external cwd with relocated installed plugin assets and no legacy scripts on PATH; `--help` alone is insufficient. Help must not start a daemon/browser, connect to a service or decrypt credentials.
- Migrate complete skill trees including lazy references, scripts, delegated prompts and generated resume commands. Strip host-specific `argument-hint`/`user-invocable` keys; use the browser skill's bootstrap and quoted `"$DG" <command>` calls. Cross-skill links are relative. Update the canonical skill index at the owning wave's release. Retain installed host approval semantics.
- Keep the no-local-zone scan green from slice 1 and extend its local-skill literal ban in slice 10. Scan migrated code/prose for bare removed commands and scriptsRoot dependencies too. This scan is separate from configured runtime reads of remaining local skills; portable paths derive from the configured source root/home. Vendor only reviewed generic source/assets/notices and synthetic fixtures; never screenshots, recordings, caches, user profiles, credentials or work identifiers from the legacy tool tree.
- Dependency manifests and `bun.lock` belong to the first consuming slice. Shared fixture/generator/manifest writes serialize through this bundle's dependency chain. Required static resources live under the owning skill; a compiled binary uses real installed paths, never `/$bunfs` or `import.meta.dir` as a filesystem locator. External runtimes remain documented where existing workflows require them (a browser for pw).
- Use current APIs, not legacy idioms: `Bun.$`, `Bun.file`/`Bun.write`, `Bun.spawn`, `node:util` `parseArgs`, `fetch`, `AbortSignal.timeout` and the current gh/glab REST and GraphQL endpoints. Before porting a helper, search `pkg/common` and earlier waves; call or extend the shared one instead of copying the legacy version. Behavior parity still wins over a newer API where they differ.

- Every packaged skill that takes flags documents them in a `## Flags` table (Flag | Short | Effect | Default) plus a **Usage:** line, matching what the skill and its dg-skills command accept; a skills-test guard enforces it.

- User verification requirement (2026-10-17): before notifying the user that migrated skills are ready to move to, obtain an actual independent Claude compatibility review of the packaged skills against selected legacy inputs. Verify namespaced discovery from a relocated plugin, lazy resources, native approvals, delegated/resume flows, command parity, and remaining cutover gates; preserve evidence and disclose unexecuted scenarios. Claude manifest validation alone is insufficient. No local settings/shim/cutover changes are authorized. External model review currently requires specific payload consent following automatic approval rejection; never claim that review ran.

Approved parity exceptions: configuration moves to the credential store with no legacy config fallback; sync reports trust/permission edits as manual work; generated resources/commands use installed dg paths; GitHub inline attachments gain extension support; new Pi/Grok targets have explicit capability coverage. None authorizes a permission-file or personal-settings write.

## Wave Execution Contract

This section governs `/spec -s 005_dg_skills_consolidation` before dispatching generic slice-wave machinery. `pr_strategy: single` means one repository; it does not turn the seven approved wave PRs into one delivery.

| Wave | Eligible slices | Proposed branch | PR base while predecessor is open | Draft version target |
| --- | --- | --- | --- | --- |
| 2a | 1–4 | feature/dg-skills-w2a | default branch containing Wave 1 | 1.15.0 |
| 2b | 5–10 | feature/dg-skills-w2b | feature/dg-skills-w2a | none (merged without a bump; slice 10 shipped in Wave 3) |
| 3 | 11–13, 15 | feature/dg-skills-w3 | feature/dg-skills-w2b | 1.16.0 (shipped) |
| 4 | 16–19 | feature/dg-skills-w4 | feature/dg-skills-w3 | 1.17.0 |
| 5 | 20, 21, 23, 24 | feature/dg-skills-w5 | feature/dg-skills-w4 | 1.18.0 |
| 6 | 25–27 | feature/dg-skills-w6 | feature/dg-skills-w5 | 1.19.0 |
| 7 | 28–30 | feature/dg-skills-w7 | feature/dg-skills-w6 | 1.20.0 |

1. Fetch/rebase against the current default branch and confirm Wave 1's required content is present before engineering. If Wave 1 is not merged, use its actual open branch as Wave 2a's base and chain it explicitly. Reconcile current versions rather than reverting a newer release to these draft targets; preserve one monotonic matched-set bump per wave.
2. Resolve the committed bundle from its origin and read only `context.md` + `plan.md`. Create the execution worktree from the required wave base/head, including predecessor changes; a fresh worktree from the default branch alone is insufficient for later waves. Resume uses the recorded actual branch/head and the first incomplete slice, never recreates a finished wave's PR or replays commits blindly.
3. Cap eligible slices at the current wave's final id even when later dependencies are satisfied. Keep same-layer file disjointness and the declared serial chain. At the endpoint run sdlc final agent review/correction, test-name gate, docs and all required wave tests once for that wave. The human review happens on the draft PR; there is no local review mode.
4. Open exactly one draft PR for that wave, capture its URL/base/head, batch-open it through dg:browser, and update the dependent stack with chain plan/apply when that command has shipped. Wave 2a records its dependency directly; Wave 2b supplies chain and registers the whole stack. Keep all worktrees for subsequent review. A PR-opening instruction in a release slice is this orchestrator checkpoint, never a command side effect.
5. Record the checkpoint under `## Wave Progress`: wave id, slice range/last committed slice, worktree path, actual branch/base, commit SHA, review/test outcome and draft URL. Commit slice work according to execution grants. The final wave closes the bundle; do not create an eighth aggregate PR. Finish/docs run once per independently delivered wave, never per slice.
6. Start the next wave from its predecessor's committed head while open; after a predecessor merges, reconcile the actual default branch and retarget through chain. Gate slice 10 on the required review-model-fallback content after fetching/rebasing; do not infer merge solely from a branch name that may be deleted or squash-merged.
7. Leave local settings, permission rules, legacy shims and local skill deletion for the user's post-merge cutover. No planning approval grants engineering execution permissions; the execution launch retains its normal permission gate.

User history override (2026-10-17): the current Wave 2b review PR must contain one commit. The completed slices 5–9 were consolidated locally into b79344e21522c139202eb3a231ea9421cfb70dce with an identical Git tree; backup `refs/heads/backup/dg-skills-w2b-before-squash-20261017` retains original slice commits. Historical per-slice SHAs below remain evidence references. Include slice 10, review corrections, and docs in the same final Wave 2b commit before publication. Earlier published wave branches remain untouched. Publishing still follows completion and the retained fallback prerequisite.
**User scope decisions (2026-10-20):**
- viz and review are dropped from dg. Slice 14 work is removed from Wave 3 (slice 14 leaves `slices[]`; slice 15 depends on slice 13). `/viz verify` in spec plan mode (step 8) is replaced by a built-in plan-mode approval (`EnterPlanMode`/`ExitPlanMode`), keeping the gate. `-l`/`--local` and `REVIEW_MODE` are removed from sdlc and spec because they needed the review board; the human review is always on the draft PR.
- lineage and clockout are retired fully: not ported, and listed for deletion at the manual cutover. Slice 22 (w5-lineage) is dropped entirely and slice 23 now depends on slice 21. Slice 19 is release-only (renamed w4-release, no clockout port).
- Matched versions: Wave 3 shipped 1.16.0, so Wave 4 = 1.17.0, Wave 5 = 1.18.0, Wave 6 = 1.19.0, Wave 7 = 1.20.0.
- erd (slice 21) ships Markdown output only, with no viz board. stat (slice 17) has no `--viz`.
- unslop is not vendored and has no Python port. It installs from the upstream repo through the `unslop` marketplace entry (`/plugin install unslop@detailedghost`). Slice 29 shrinks accordingly.
- dg:demo (slice 27): local is the default mode. `dg-skills pw` (slice 25) drives a Playwright Chromium to record video and take light/dark before/after screenshots, and also covers CLI/backend demos and the "commands to run locally" output. Local recordings match the extension's look: same TourScript plan format, same spotlight and explanatory text boxes, from one shared overlay module used by the extension and `dg-skills pw`, with a test that one plan yields the same overlay in both modes. `--ext` uses the extension (its review/walkthrough/video choices and the upload-and-receipt flow stay as planned). `--attach-pr` works in both modes: local mode uploads via pw with a saved GitHub login state, else hands over files plus the PR link with no PR change; GitLab stays unsupported with no change. Owned-artifact cleanup applies to both. Slice 27 depends on slice 25. Behavior change: plain `/dg:demo` becomes local; extension users add `--ext`.
- New Migration Contract line: every packaged skill that takes flags documents them in a `## Flags` table plus a **Usage:** line, enforced by a skills-test guard.
- `spec roster` falls back to the packaged `dg:<name>` personas on a plugin-only install; it shipped in Wave 3.

- Wave 3 IN PROGRESS (2026-10-19): worktree ~/code/worktrees/dg-dg_skills_w3, branch feature/dg_skills_w3, base origin/master 9c1d002 (after #38 and the history rewrite). Wave 2b merged without slice 10, so slice 10 ships in Wave 3. Slice 10 committed 5e78267. Next: slice 11.
- Slice 11 committed 8af1c80. Next: slice 12.
- Slice 12 committed 715efc1, with the plugin cache locator fix 6a85adc. Next: slice 13.
- Slice 13 committed 4b43f09. Next: slice 14.
- Slice 14 committed 28a247b. Next: slice 15 (Wave 3 release).
- Wave 3 DRAFT PR (2026-10-20): [#40](https://github.com/detailedghost/dg-ai/pull/40), branch feature/dg_skills_w3, base master. Slices 10-15 committed, plus all-wave skill invocation fixes (literal ~/.dg/bin/dg-skills calls, /dg:<name> names, plugin cache locator). This spec copy in the Wave 3 branch is now canonical; the old local feature/skills_import copy is superseded. Open before Wave 4: package arch, design and qa-code agents and use dg:<agent> names (user approved); channel-review runners/index.ts bare /thrash|/address|/deps-upgrade; docs/AGENT-INSTALL.md "$DG" calls.

## Wave Progress

- First stack prerequisite (user instruction 2026-10-17): [#26](https://github.com/detailedghost/dg-ai/pull/26), feature/review_daemon_integration, head e4e82e00faccba3e23aee73a781036949b0df9ab, base master, OPEN and ready for review. Contains committed runner.fallback/CR-207 behavior. Native GitHub stack #30 now orders #26 → #27 → #28; verified all positions/bases and unchanged heads. Original PR descriptions preserved outside one managed chain block each. All three browser tabs opened in group open. PRs #27/#28 explicitly marked ready at user request; future wave PRs retain the default draft-creation policy. Slice10 still waits for #26 merge and committed content verification on the default branch.
- Prerequisite Wave 1: reconciled onto fetched origin/master 537f8ba; import 3c2a9cf and installer inventory fixes 523f1b5/44aa3f0. Ready for review [#27](https://github.com/detailedghost/dg-ai/pull/27), branch feature/dg-skills-w1, base feature/review_daemon_integration (retargeted beneath #26), head 44aa3f073162db5fdcfa794ea010e35ee6019697. Installer suites 26 pass; common inventory test 5 pass. Browser grouped open completed. Worktree retained at ~/code/dg/.worktrees/dg-skills-w1.
- Wave 2a COMPLETE: slices 1–4, last committed slice4 plus review/docs/test follow-through; worktree ~/code/dg/.worktrees/dg-skills-w2a; actual branch feature/dg_skills_w2a; base feature/dg-skills-w1; head 0052265. Ready for review [#28](https://github.com/detailedghost/dg-ai/pull/28) (user requested promotion on 2026-10-17). All four final reviewers clean after one correction round. Final `bun run test:all`: 5,062 pass, 0 fail; all eight `lint:all` packages pass. Compiled external-cwd operations, private artifacts, six backends, provider parity, privacy/version/test-name/whitespace gates pass. Matched release1.15.0; native Windows runtime remains untested/documented. PR directly records dependency on #27; chain will register stack in Wave2b after slice7 ships. Browser grouped open completed.
- Wave2b IN PROGRESS: slices5–10, worktree ~/code/dg/.worktrees/dg-skills-w2b, actual branch feature/dg_skills_w2b, base feature/dg_skills_w2a, initial head0052265; Slices5–9 committed ff75474/f9b205a/2d7cadc/f55483c/6c6c302, current head b79344e21522c139202eb3a231ea9421cfb70dce (one consolidated commit above Wave2a; original five slice commits retained in local backup); next slice 10, waiting for required fallback content on origin/master (user confirmed prerequisite retained). Native stack #30: #26→#27→#28, bases and ready state verified after user-requested prerequisite insertion. Do not recreate finished PRs. Slice10 still gates on fetched review-model-fallback content.
- Wave 3 also ships (2026-10-20): 9ab4c7a (dg: agents), 6f225eb (channel-review invokes /dg:<skill>), f7b6f0c (install docs), fc16957 (viz and review dropped), f4c5673 (unslop from upstream), d13f67c (spec roster fallback) and the plan scope edits above.

## Roundtable Decisions

- [DECIDED] Keep all 30 assigned agents; no external proxy delegation. Reviews ran at normal depth, per the user.
- [DECIDED] Preserve observed status codes, including stash usage exit 1; the old parsers are the compatibility baseline.
- [DECIDED] Sync prefers the plugin skill on duplicate names, warns, preserves local sources and bounds target pruning to generated outputs.
- [DECIDED] `pw code` retains separate host approval. Manual cutover instructions use narrow permissions; broad binary allowlisting cannot preserve that separation. Do not write host permission rules.
- [DECIDED] Extend the extension for authenticated GitHub inline media upload. Keep recording preview and explicit upload action; GitLab attachment remains unsupported with no PR mutation.
- [DECIDED] Honor existing static-asset homes and manual-settings/cutover constraints. Personal hooks remain configurable external executables with actionable unavailable behavior.
- [DECIDED] Correct file ownership through a freshly scaffolded reviewed revision with the same bundle identifier, slice ids/names, wave boundaries and dependencies. Record the exact rebaseline in roundtable/synthesis.md before approval; execution must use the reviewed revision, never the stale ownership set.


## Code Structure

### CLI registration and compatibility
- **Decision:** Register command modules once; use defineCommand and raw-argv bridges according to the legacy parser, preserving per-command streams/statuses and import isolation.
- **Home:** `pkg/skills-cli/src/commands/*.ts`, `pkg/skills-cli/src/utils/legacy-command.ts`, domain helpers in `src/<command>/`.
- **Rationale:** The existing commander application remains the single binary without rewriting every parser's behavior.
- **Alternatives:** Separate binaries — rejected by the recorded single-binary choice; universal parser normalization — rejected by the user's exit-parity decision.
- **Applies to:** slices 1–3, 5–9, 11–13, 16–18, 20, 21, 24–29.

### Shared filesystem and process contracts
- **Decision:** Port the complete reusable filesystem surface except scriptsRoot to common; adapt legacy git over runCapture while retaining ShellError, streams, status and redaction.
- **Home:** `pkg/common/src/node/scratch-paths.ts`, `pkg/skills-cli/src/utils/git.ts`, `pkg/skills-cli/src/provider/**`.
- **Rationale:** Existing consumers rely on cwd/project scoping and untrimmed process results, not only root strings.
- **Alternatives:** Local copies in every port — drift in state paths; indiscriminate common run() — loses status/stream compatibility.
- **Applies to:** slices 1–3, 5–9, 11–13, 16–18, 20, 21, 24–29.

### Catchup verification seam
- **Decision:** Slice 9 exports `verifyBuild(cwd?: string): Promise<number>` from `src/catchup/verify.ts`, detects the repository root while preserving each legacy tool's caller/root cwd, routes merged build-tool output to stdout, and returns the aggregate verification status. Registration and help remain inert; the compiled command has no sibling-shell dependency.
- **Home:** `pkg/skills-cli/src/catchup/{index,verify}.ts`.
- **Applies to:** slice 9.

### Real resources and self invocation
- **Decision:** One shared installed-skill locator resolves real explicit/configured/source-install paths, and one self-command helper produces correct argv in source and compiled modes.
- **Home:** `pkg/skills-cli/src/utils/skill-assets.ts`, `pkg/skills-cli/src/utils/self-command.ts` (slice 3 owns initial implementation/tests).
- **Rationale:** A compiled virtual module path cannot locate external assets or reexecute a source entrypoint.
- **Alternatives:** Per-port import.meta fallbacks — fail after relocation; a new runtime package — unnecessary for these CLI-only seams.
- **Applies to:** slices 3, 11–13, 17, 21, 25–29.

### Early compatibility and sequential handoffs
- **Decision:** Package proxy persona/background and deps-upgrade worktree-create behavior with their first consumers; later public commands reuse those internals through declared sequential ownership.
- **Home:** `pkg/skills-cli/src/proxy/{spec-persona,background}.ts`, `pkg/skills-cli/src/deps-upgrade/worktree-compat.ts`.
- **Rationale:** Every approved wave works without commands that only ship in later waves.
- **Alternatives:** Retain local scripts — violates distribution; remove early features — violates compatibility; move whole waves — unnecessary.
- **Applies to:** slices 3, 8, 11–12, 17.

Slice 8's internal create handoff exports `CreateWorktreeOptions { slug: string; prefix?: string; base?: string; seed?: boolean; resume?: boolean; cwd?: string }`, `WorktreeResult { path: string; branch: string; origin: string }`, and `createWorktree(options, reportDiagnostic?): Promise<WorktreeResult>` from `src/deps-upgrade/worktree-compat.ts`. The optional reporter receives formatted diagnostic text; its default writes stderr, preserving one-argument callers. The API returns data without stdout and throws on failure. `prepare` captures those diagnostics, discards successful output, and maps creation failure through its legacy die wrapper, preserving the former captured-child stream contract. `deps-upgrade prepare` calls it directly; no premature public worktree command or sibling executable is introduced. Slice 11 reuses this create core when adding the complete lifecycle. This fills the planned internal seam without changing its module home or wave order.

### Static assets
- **Decision:** Non-code resources stay with their owning skill and load lazily via the shared real-path locator; executable server/domain code stays in compiled source modules.
- **Home:** `plugins/dg/skills/spec/spec-schema/**`, `plugins/dg/skills/{monolith,prototype,skill-publish}/**`.
- **Rationale:** Installed resources can move independently of the self-contained CLI and retain relative cross-skill links.
- **Alternatives:** Legacy home/scripts paths — absent after cutover; source-tree schema glob — contradicts the previously selected owning-skill home.
- **Applies to:** slices 12, 13, 26, 29.

### Credential consumers
- **Decision:** db uses internal credential get/list to read value and metadata without changing resolveCredential; ticket uses opt-in metadata-only `credentials list --meta` while default list output stays stable.
- **Home:** `pkg/skills-cli/src/db/**`, `pkg/skills-cli/src/commands/credentials.ts`, `plugins/dg/skills/ticket/**`.
- **Rationale:** Existing records already contain non-secret metadata; resolveCredential and default CLI list intentionally project it away.
- **Alternatives:** Expand secret-bearing CLI output — violates the credential contract; legacy config fallback — explicitly excluded; shared client API expansion — unnecessary.
- **Applies to:** slices 20, 23.

### Public skill and hook integration
- **Decision:** Use quoted compiled commands, relative cross-skill resources and portable configured runtime roots; excluded hooks remain externally configured executable paths.
- **Home:** `plugins/dg/skills/**`, `pkg/skills-test/__tests__/no-local-zone.spec.ts`.
- **Rationale:** Public skills cannot depend on this machine's private files or mutate installed plugin caches.
- **Alternatives:** Scanner exceptions for private literals — defeats the public-repo boundary; vendor personal hooks — outside scope.
- **Applies to:** slices 1, 3, 5–13, 15–19, 21, 23–30.


### Slice 1 — w2a-foundation-stash

#### Engineering
- [x] Move lib/fs.ts scratch and state roots to pkg/common/src/node/scratch-paths.ts; drop scriptsRoot
- [x] Write src/utils/legacy-command.ts: map a lib/cli.ts defineCommand spec onto commander with passThroughOptions and exitOverride, preserving each command’s observed exit codes
- [x] Port stash-cli.ts to `dg-skills stash` with every flag (-s -a -m -G -u -r -C)
- [x] Add no-local-zone.spec.ts: scan plugins/dg/skills/** and pkg/skills-cli/src/** for employer, ticket-key and username literals, home paths, clockify-sync|~/scripts/
- [x] Rewrite bare $(stash ...) calls in the five Wave 1 skills to "$("$DG" stash ...)" with the bootstrap block
- [x] Port the complete legacy fs public API except scriptsRoot into common (cwd/project hashes, agents paths/error, readable names, override roots), including unique-names-generator dependency; move stash skill too.
- [x] Provide both defineCommand adapter and raw-argv bridge; preserve import isolation, custom parsing and observed per-command statuses (stash usage errors currently 1). Replace blanket status-2 acceptance with measured parity.

#### Testing Criteria
##### Contracts
- [x] `dg-skills stash -G viz` prints the same absolute path as `~/scripts/bin/stash -G viz`; a legacy usage error exits 1
- [x] Port lib/__tests__/fs.test.ts and cli.test.ts and stash-cli.test.ts
- [x] Port fs/stash/cli behavioral suites with temporary roots, main/linked worktrees, stdin/options, exact streams and statuses; run compiled stash outside checkout.
- [x] Keep strict private-data scan and separate bare executable/removed-helper checks across complete skill reference trees.

#### Acceptance Criteria
- [x] no-local-zone.spec is green on the tree
- [x] No plugin skill calls bare stash from PATH
- [x] Stash skill and five Wave 1 consumers work without legacy PATH/scripts and preserve scratch/state scope.

### Slice 2 — w2a-vcs-provider

#### Engineering
- [x] Port lib/provider/* to src/provider/; lib/git.ts to src/utils/git.ts reusing run/runCapture from @dg/common/node and keeping redactTokens
- [x] Port vcs-provider-cli to `dg-skills vcs-provider` with the complete current subcommand inventory
- [x] Do not merge with pkg/channel-review verdict readers; note the overlap in the PR body
- [x] Adapt git process API preserving untrimmed separate streams/status, ShellError fields, stdin/startup identity and redaction; use runCapture when needed.
- [x] Own shared CLI fixtures once; remove generic skill-copy requirement because vcs-provider has no source user skill.

#### Testing Criteria
##### Contracts
- [x] detect, capabilities, auth, list-prs, list-issues, view-issue, view-pr, list-threads, create-pr, merged-pr-for-branch keep today's JSON output and exit codes
- [x] Ported provider and git suites pass with fake gh and glab
- [x] Retain provider injection/cache/error/capability/overrides/stdin contracts, including detect null degradation and quiet auth failure.

#### Acceptance Criteria
- [x] Compiled provider operations work in isolated external cwd with fake gh/glab and no local helpers.

### Slice 3 — w2a-proxy

#### Engineering
- [x] Port ~/scripts/ai/skills/proxy (cli.ts, spawn, preflight, persona, likely-cause, backends/*) to `dg-skills proxy`
- [x] Ship proxy skill in Wave 2a; package minimal bundle-persona lookup and detached-launch internals within src/proxy so spec/bg commands scheduled later are not runtime prerequisites.
- [x] Use raw-argv bridge and isolate main from import; preserve plan/prompt-file/spec/slice/resume/persona/backends behavior.
- [x] Own shared src/utils/skill-assets.ts real-resource locator and src/utils/self-command.ts compiled/source argv helper at the first consumer; all later ports reuse them without a new package.
- [x] Implement the shared real installed-skill locator and source/compiled self-command argv helper with explicit override precedence; all later ports reuse these seams.

#### Testing Criteria
##### Contracts
- [x] `dg-skills proxy --list-backends` lists codex, copilot, pi, opencode, cortex, grok; --resume <id> and --subagent <name> argv forms behave as today
- [x] Port proxy/*.test.ts
- [x] Run generated launch commands and compiled self-dispatch with fake backends, quoted cwd/prompt-file paths, queued/resume and JSON/status parity.
- [x] Test explicit/configured installed paths, relocated resources, missing assets, source/compiled self-dispatch and paths with spaces; no virtual source fallback.

#### Acceptance Criteria
- [x] All six backend identities and initial proxy skill work before public spec/bg ports.

### Slice 4 — w2a-release

#### Engineering
- [x] Bump the matched version set to 1.15.0 (release-versions.spec)
- [x] Document stash, vcs-provider and proxy in README and docs/DEVELOPER.md
- [x] Open the Wave 2a draft PR; Wave 2b branches from it
- [x] Rebase/reconcile baseline; bump only matched extension, skills-cli, dg-daemon, dg-agent plus manifests/status and pinned tests.
- [x] At wave boundary finish/docs/review/draft PR once for slices 1–4; record wave branch/base/head/URL/last slice and branch Wave 2b from that committed head.

#### Testing Criteria
##### Contracts
- [x] bun run test:all and bun run lint:all green
- [x] Run matched-version gates and compiled Wave 2a functional smoke under isolated HOME/external cwd without legacy helpers.

#### Acceptance Criteria
- [x] Wave 2a PR is open as draft
- [x] Wave 2a draft URL/base/head is persisted; stash/provider/proxy requirements and manual cutover are documented.

### Slice 5 — w2b-address-review-loop

#### Engineering
- [x] Port address-helper.ts (inventory every current subcommand) to `dg-skills address`
- [x] Move address and review-loop skills; review-loop calls "$DG" vcs-provider and "$DG" proxy
- [x] Inventory actual address dispatch including bot-review/Copilot gates; preserve polling timeout 124 and capability refusal order.
- [x] Rewrite complete address/review-loop lazy references and embedded delegated calls; retain provider/no-bot routing and shared fixtures.

#### Testing Criteria
##### Contracts
- [x] Retain reply-before-resolve, batch stdin/tallies, GitLab explicit PR, bot-prefix idempotence and capability degradation; test nested command invocation.

#### Acceptance Criteria
- [x] Review-loop and address consume migrated proxy/provider outputs without legacy binaries.

### Slice 6 — w2b-thrash

#### Engineering
- [x] Port thrash-helper.ts and thrash-core.ts to `dg-skills thrash` (src/thrash/core.ts)
- [x] --proxy calls "$DG" proxy
- [x] Keep thrash core free of registration; distinguish skill --proxy orchestration from helper diff/compile/post/stack/tally commands.
- [x] Preserve findings/verdict/address-file schemas, local/remote publishing and GitLab fallback while rewriting all references.

#### Testing Criteria
##### Contracts
- [x] Port core/helper suites and exercise generated ADDRESS_FILE through migrated address, plus fake-provider stack and proxy resume.

#### Acceptance Criteria
- [x] Local and remote findings remain consumable without legacy path/documentation dependencies.

### Slice 7 — w2b-chain-file

#### Engineering
- [x] Port chain-cli.ts and file-cli.ts
- [x] Scrub work data from file/SKILL.md
- [x] Use raw argv for chain and defineCommand adapter for file; preserve native-stack/ref grammar, measured no-args chain exit 1/stderr and file exit 2/stdout, and unsupported 4.
- [x] Replace private batch-approval/personal-rule claims with packaged instructions retaining existing operational approval semantics.

#### Testing Criteria
##### Contracts
- [x] Retain chain plan/apply, unsupported short-circuit, partial-update/idempotence cases and file create/list/view/bucket GitHub/GitLab contracts.

#### Acceptance Criteria
- [x] Plan/render causes no unintended mutations and both commands preserve their measured output/status contracts.

### Slice 8 — w2b-meaningful-deps-upgrade

#### Engineering
- [x] Port meaningful-helper.ts and deps-upgrade-helper.ts; scrub deps-upgrade-helper.ts:13 and meaningful/references/helper-api.md:132
- [x] Package minimal worktree-create compatibility under deps-upgrade before Wave 2b; expose a documented handoff to the full slice-11 implementation without future-command dependency.
- [x] Expand skill-base imports into settled modules; correct claim of no meaningful tests and preserve existing history/backup/rollback suite.

#### Testing Criteria
##### Contracts
- [x] Port meaningful integration tests and deps state/cooldown/Renovate/draft behavior under disposable repos and isolated durable-state roots.

#### Acceptance Criteria
- [x] Prepare creates/resumes a worktree without legacy scripts before public worktree command ships.

### Slice 9 — w2b-catchup

#### Engineering
- [x] Rewrite catchup.sh in TypeScript as `dg-skills catchup` (user decision: shell CLIs are rewritten, not vendored)
- [x] Rewrite required verify-build.sh behavior into src/catchup, preserving ecosystem detection and credential-aware dbt skip.
- [x] Preserve legacy step order/streams/exit-1 cases, up-to-date early return and push options; document added help as additive.

#### Testing Criteria
##### Contracts
- [x] same steps, output and exit codes as catchup.sh against a temp git repo with an origin remote
- [x] Use disposable repos/local origin and fake build tools for dirty/untracked preservation, rebase conflicts/stash restore, verification/push failures, protected/default branches and --no-push.

#### Acceptance Criteria
- [x] Compiled catchup has no sibling-shell dependency and matches controlled legacy scenarios.

### Slice 10 — w2b-channel-review-defaults-release

#### Engineering
- [x] Point config.ts defaults (lines ~261-281, 567) at `~/.dg/bin/dg-skills thrash|address|deps-upgrade` and the plugin skill dirs
- [x] Add ~/.claude/skills/ to the no-local-zone pattern
- [ ] Bump to 1.16.0; open the Wave 2b draft PR
- [x] Verify prerequisite merged behavior by fetched commit/content after rebase, independent of whether source branch survived squash/deletion.
- [x] Update channel-review command defaults, namespaced runner invocation and plugin probing with narrow subcommand grants and explicit overrides.
- [x] Introduce strict local-skill-path ban together with initial grill-me relative-pointer fix; hand the pointer to slice 12 for final migration.
- Orchestrator decisions (2026-10-19): Wave 2b merged to master without this slice, so it ships in the Wave 3 PR; "open the Wave 2b draft PR" is replaced by the Wave 3 PR at slice 15. Do not bump versions in this slice (master is 1.15.0); slice 15 makes the one matched bump for the wave, so drop the red 1.16.0 release-versions expectation. Read grants are `Read(~/.claude/plugins/cache/*/dg/*/skills/<name>/**)` for thrash, address and deps-upgrade. Bash grants are `Bash(<home>/.dg/bin/dg-skills <sub>:*)`, one per subcommand, no bare grant. Probe roots: claude uses only `.claude/plugins` (nested); copilot uses only `.copilot/skills`; codex keeps `.codex/skills` and `.agents/skills`; a leftover `~/.claude/skills/thrash` no longer counts as installed, and tests cover each runner. The no-local-zone `~/.claude/skills/` ban scans `plugins/dg/skills`, `pkg/skills-cli/src` and `pkg/channel-review/src`. Red tests for this slice already exist in the working tree; extend them, do not rewrite. The orchestrator runs test:all, lint:all and the compatibility review at the wave end; those are not slice deferrals.

#### Testing Criteria
##### Contracts
- [ ] bun run test:all and bun run lint:all green
- [x] Test all supported runners with installed plugin skills and no migrated local skills; retain config/probe/automation/doc parity and compiled smoke.
- [ ] Complete the user-requested independent Claude skill compatibility verification and retain a readiness report, with scoped payload approval if required; notify the user when the wave is complete for review.

#### Acceptance Criteria
- [x] channel-review specs green with the new defaults
- [ ] Matched Wave 2b version and runnable post-cutover defaults pass; draft base/head/URL for slices 5–10 is persisted.

### Slice 11 — w3-worktree

#### Engineering
- [x] Rewrite worktree-cli (POSIX sh) in TypeScript as `dg-skills worktree create|list|remove|prune` with the KEY=value stdout contract and the four remove guards
- [x] Reuse packaged worktree-create compatibility through an explicit sequential ownership handoff; provider merge fallback calls migrated provider API.
- [x] Enumerate dirty/untracked, unpushed/no-upstream, unmerged and ambiguous-slug safeguards plus aliases/overrides; never broaden non-force removal after a failed clean check.
- User decisions (2026-10-19): support paths with spaces in create, list and remove (approved fix over legacy). With no provider CLI, remove blocks with exit 2 and `not merged into origin/` and prints no `lookup failed` text (legacy parity). Drop the legacy `--force` retry after a failed plain `git worktree remove`: exit 2 and keep the worktree, directory and branch. `--help` on a subcommand exits 0 (additive); bare `worktree` keeps usage on stderr with exit 1. A draft test suite from an earlier run is at /tmp/claude-1000/-home-detailedghost-code-dg/309222d4-68f1-4668-8615-6360436c5515/scratchpad/w3/s11-worktree.spec.ts; the Red stage may reuse it.

#### Testing Criteria
##### Contracts
- [x] create prints exactly WORKTREE_PATH, WORKTREE_BRANCH, WORKTREE_ORIGIN; resume semantics table holds; remove guards block without --force
- [x] Cover real create/resume/list/prune/removal in disposable repos, env modes and spaces; preserve KEY=value-only stdout and fallback null-versus-error diagnostics.

#### Acceptance Criteria
- [x] Full public worktree port supersedes compatibility path without breaking earlier deps-upgrade callers.

### Slice 12 — w3-spec-sdlc-assign

#### Engineering
- [x] Rewrite spec-cli (77K POSIX sh) in TypeScript as `dg-skills spec` with every subcommand (slugify, scaffold, lint-waves, context, slice, set, append-section, perms-batch, prototype-ref, ...)
- [x] Vendor the spec schema and templates under plugins/dg/skills/spec/spec-schema
- [x] Move spec, sdlc, assign; vendor or drop sdlc's ~/scripts reference docs; spec references ../grill-me, ../sdlc
- [x] Keep schema under plugins/dg/skills/spec/spec-schema per settled owning-skill contract, including frontmatter YAML and both roundtable/spec-review templates; inventory all dispatch arms.
- [x] Add YAML parsing dependencies before use; define real installed skill-dir lookup/override and lazy resource loading, never compiled import.meta virtual-path fallback.
- [x] Write final grill-me relative pointer and vendor required sdlc PR-style guidance; remove obsolete private permission-rule explanation.
- [x] Rewrite remaining imported Wave 1 prd/kick/pickup orchestration calls to the migrated spec/worktree/provider commands and relative skill resources; do not leave executable bare spec-cli calls.

#### Testing Criteria
##### Contracts
- [x] scaffold from a fixture blob produces byte-identical plan.md/initial.md/roundtable shells to today's spec-cli
- [x] Write deterministic fixture goldens for every spec subcommand and port existing behavioral tests where available
- [x] Use fixed date/locale/root/number inventory for goldens; test immutable fields, permissions batches, glob/generator collisions, lean context and every subcommand's observed statuses.
- [x] Run compiled scaffold/validate/roundtable from relocated plugin outside checkout with no legacy files.

#### Acceptance Criteria
- [x] Slices 12–14 may carry documented pending same-wave links; Wave 3 publication requires all references and polish material resolved.

### Slice 13 — w3-monolith-spring-break

#### Engineering
- [x] Port monolith-helper.ts and monolith-worktree-gen.ts to `dg-skills monolith`
- [x] Validate grill-me’s relative monolith template pointer already written by slice 12
- [x] Map helper commands to monolith <subcommand> and generator to monolith worktree-gen; isolate existing import-time entrypoints.
- [x] Resolve workflow/template assets from installed monolith skill, run helper logic internally, and validate grill-me pointer written by slice 12.

#### Testing Criteria
##### Contracts
- [x] Port generator full/shallow/staging/terms/routing goldens and compiled external-cwd generation; retain conflict/append/cap-split and spring-break format contracts.

#### Acceptance Criteria
- [x] No monolith operation requires user-local workflow/template/helper files; actual generator status 1 remains preserved.

### Slice 14 — dropped

Removed by the 2026-10-20 scope decision: viz and review do not ship in dg. Nothing remains to port; see the commit fc16957 for the removal.

### Slice 15 — w3-release

#### Engineering
- [ ] review-loop no longer references the dropped review skill; the matched version is 1.16.0; open the Wave 3 draft PR
- [ ] Ship required polish workflow/PR-style material now (within declared ownership), leaving final inventory/hook cleanup to slice 30.
- [ ] Validate complete Wave 3 cross-skill references, matched version/docs and manual cutover/runtime prerequisite instructions.
- Orchestrator decisions (2026-10-19): Wave 2b never bumped, so master is 1.15.0; bump every package, plugin manifest and DG_DAEMON_PACKAGE_VERSION together to 1.16.0 (the next matched version), not 1.17.0, and extend release-versions.spec.ts so every package and manifest must match. Then run `bun scripts/pin-bootstrap-tag.ts` so every bootstrap URL points at skills-v1.16.0, and keep `--check` green. Add worktree, spec, sdlc, assign, monolith, spring-break and polish to the README skill index and docs/install.md where skills are listed. The orchestrator opens the draft PR; do not push or open it.
- [ ] When first publishing polish, already use configurable external prose-check execution and relative vendored pr-body guidance so the public-data scan passes; slice 30 owns final inventory/maintenance refinements.

#### Testing Criteria
##### Contracts
- [ ] bun run test:all and bun run lint:all green
- [ ] Run compiled relocated scaffold/validate/monolith functional smoke plus version gates.

#### Acceptance Criteria
- [ ] Wave 3 draft base/head/URL for slices 11–15 persisted; spec/sdlc flows do not require future-wave skills or local copies.

### Slice 16 — w4-jot

#### Engineering
- [ ] Port jot-cli.ts and jot-checkpoint.ts to `dg-skills jot`
- [ ] Consume complete shared fs API and preserve linked-worktree state-write precedence.
- [ ] Preserve kick/kick-list/kick-take checkpoint semantics and repair CheckpointSection's missing status property to satisfy TypeScript.

#### Testing Criteria
##### Contracts
- [ ] Port cap/split, linked-worktree, checkpoint --file/replace/ambiguity/last-section and lock/atomic-write behaviors.

#### Acceptance Criteria
- [ ] Durable saves do not mutate the main checkout from a linked worktree and existing markdown/stdout stays compatible.

### Slice 17 — w4-bg-cls-stat

#### Engineering
- [ ] Port bg-helper.ts to `dg-skills bg`; move bg, cls, stat, proxy skills; exclude the orphan legacy stat-cli.test.ts from the port (no stat-cli.ts); leave the legacy source untouched
- [ ] Use compiled-safe bg self-dispatch and migrated proxy recognition; reuse/replace slice-3 background compatibility internals through explicit handoff.
- [ ] Keep stat prose-only with provider/bg/worktree calls and terminal-only cleanup; make cls browser close optional before Wave 6 pw availability.
- [ ] Retain live jobs/main-checkout scratch; never signal caller process group or prune sibling-path jobs.

#### Testing Criteria
##### Contracts
- [ ] Run compiled queued-context/drain/resume and detachment/cancel/prune tests; assert /repo containment excludes /repo-other.

#### Acceptance Criteria
- [ ] Stat (no `--viz`; `--overwatch` only) and cls degrade safely without pw; no legacy files are deleted during port.

### Slice 18 — w4-sniff-nope-find-work

#### Engineering
- [ ] Port sniff-cli.ts; move nope and find-work with no home paths ($HOME/code is allowed as an env default)
- [ ] Rewrite find-work embedded prompts with bootstrap/provider routing and existing human selection/PR-opening gates.
- [ ] Sanitize tests/examples beyond narrow regex, including work registry fixture and nope private-home example; preserve actual sniff status 1.

#### Testing Criteria
##### Contracts
- [ ] Assert real stdout/stderr excludes fake env/Terraform/Docker/CI secret values; cover root errors and empty inventory.

#### Acceptance Criteria
- [ ] Names-only secret/config inventory and accepted portable HOME/code default survive migration.

### Slice 19 — w4-release

#### Engineering
- [ ] Bump every package and plugin manifest to the next matched version, 1.17.0; open the Wave 4 draft PR
- [ ] Update the canonical skill index and docs for the Wave 4 skills (jot, bg, cls, stat, sniff, nope, find-work); clockout is not ported and is listed for deletion at the manual cutover.

#### Testing Criteria
##### Contracts
- [ ] bun run test:all and bun run lint:all green; release-versions guard passes at 1.17.0.

#### Acceptance Criteria
- [ ] Matched Wave 4 draft base/head/URL for slices 16–19 persisted.

### Slice 20 — w5-db

#### Engineering
- [ ] Spike first: bun build --compile with pg and snowflake-sdk; if the binary cannot run `db connections`, stop and ask (separate binary needs a decision)
- [ ] Port db-query to `dg-skills db`; connections come from credentials db/<conn> (value = password/passphrase; meta engine, host, port, database, user, account, warehouse, role, authenticator); no connections.json fallback
- [ ] Assign pg/snowflake dependency/lock changes before compile spike; test compiled SDK initialization/auth beyond db connections and retain stop-and-ask failure gate.
- [ ] Map optional schema/JWT-key-path/SSO/cache/timeout/default metadata without connections.json, preserving auth modes and key-file permissions; use internal list/get with db-scoped access.
- [ ] Enforce advertised read-safe default rather than trusting shallow legacy classifier; test final WITH DML, write CTE, SELECT INTO and SET/write combinations.

#### Testing Criteria
##### Contracts
- [ ] Use fake credentials/engines to cover password/JWT/SSO, invalid/absent metadata, output/truncation, --write/query files and cleanup/redaction.
- [ ] Freeze schema JSON shape for ERD and compiled external-cwd behavior.

#### Acceptance Criteria
- [ ] No legacy config fallback or secret output; compiled database functionality meets recorded packaging gate before continuing.

### Slice 21 — w5-erd-eli5

#### Engineering
- [ ] Port erd-cli to `dg-skills erd`; move erd and eli5. ERD ships Markdown output only: no viz board and no Cytoscape board.
- [ ] Use compiled current-binary db dispatch for introspection and raw CLI wrapper preserving existing hard-failure exit 1.
- [ ] Port sanitized synthetic ERD code-graph/database/evidence fixtures without live connections.

#### Testing Criteria
##### Contracts
- [ ] Run compiled external-cwd live-schema handoff with fake child dependency and static fixture/orchestration suites.

#### Acceptance Criteria
- [ ] ERD consumes frozen slice-20 schema contract and never requires bare db or scripts checkout.

### Slice 23 — w5-ticket

#### Engineering
- [ ] Move ticket; read site, cloudId, project, assignee, sprintField, issueTypes from `"$DG" credentials list --meta` meta of ticket/jira; no ticket key or email text in the repo
- [ ] Add opt-in credentials list --meta (or equivalent explicit metadata-only command) exposing arbitrary nonsecret meta without values; preserve default list projection.
- [ ] Document complete ticket/jira registration, typed issueTypes encoding/default issue type, placeholder value and required-field validation; derive all identifiers/URLs from metadata.
- [ ] Use exact credentials list --meta opt-in. Define issueTypes metadata as a JSON-encoded string mapping names to IDs, validate decoding and required default issue type before calling Atlassian.

#### Testing Criteria
##### Contracts
- [ ] bun run test:all and bun run lint:all green
- [ ] Test metadata-only output cannot print values and synthetic ticket fixtures use configured fields/IDs; preserve duplicate/assignee/integer-sprint behavior.

#### Acceptance Criteria
- [ ] ticket/SKILL.md tells the user how to register ticket/jira when it is missing
- [ ] Missing metadata has actionable registration guidance and no original baked-in project/cloud/account/sprint identifiers remain.

### Slice 24 — w5-test-live-release

#### Engineering
- [ ] Rewrite test-live-setup.sh and test-live-cleanup.sh in TypeScript as `dg-skills test-live setup|cleanup`
- [ ] Bump to 1.18.0; open the Wave 5 draft PR
- [ ] Preserve actual positional environments/overrides and exit-1 shell parity; GitLab unsupported must precede patch/push.
- [ ] Scope recoverable setup/cleanup state by repository/worktree/branch and patch commit; parse state as data and remove only owned changes, preserving later/preexisting commits.

#### Testing Criteria
##### Contracts
- [ ] Use disposable repos/fake gh for concurrent names, dispatch/push/watch failures, resume/later commits and cleanup refusal without loss.

#### Acceptance Criteria
- [ ] Compiled data/deployment fake-runtime gates and matched Wave 5 draft base/head/URL for slices 20–24 persisted; no live deployment tests.

### Slice 25 — w6-pw

#### Engineering
- [ ] Spike first: compile playwright-core into the binary; if it fails, stop and ask
- [ ] Port pw (pw, pw-daemon, pw-code) to `dg-skills pw`
- [ ] Expand compile spike to local fixture open/snapshot/close, daemon self-reexec/browser discovery and owned registry identity; retain stop-and-ask packaging gate.
- [ ] `dg-skills pw` also serves local demos (slice 27): Chromium video recording, light/dark before/after screenshots, and the overlay from the shared tour-overlay module.
- [ ] Keep pw code an explicit separately approved action with documented manual narrow permission rules; normal CLI continues refusing run-code. Never change installed permission rules or silently include code in blanket grants.

#### Testing Criteria
##### Contracts
- [ ] Port nested core/command/code/e2e fixtures; explicitly execute compiled smoke, ensure close/kill-all cannot target unrelated dg-skills.

#### Acceptance Criteria
- [ ] Browser executable remains documented prerequisite; no live-user browser state or permission files changed during tests.

### Slice 26 — w6-prototype

#### Engineering
- [ ] Rewrite prototype-cli (sh) in TypeScript; port prototype-ui-cli.ts and prototype-serve to `dg-skills prototype`; vendor prototype-components/ in the skill
- [ ] Map old entrypoints to prototype <selection/decision>, prototype ui and prototype serve, disambiguating wait; preserve existing proto.
- [ ] Move executable server TS into src/prototype; keep copyable HTML/WebMCP/components assets under skill and return real installed paths.

#### Testing Criteria
##### Contracts
- [ ] Run compiled pinned-cwd regression, reject/timeout/consumed-sentinel cleanup, server teardown and UI/server self-dispatch with isolated roots.

#### Acceptance Criteria
- [ ] Legacy timeout status 1 remains; no executable vendored server requires old library/source runtime.

### Slice 27 — w6-demo-merge-release

#### Engineering
- [ ] Local is the default dg:demo mode (behavior change: plain /dg:demo becomes local; extension users add --ext). `dg-skills pw` (slice 25) drives a Playwright Chromium to record video and take light/dark before/after screenshots, and also covers CLI/backend demos and the "commands to run locally" output.
- [ ] Local recordings match the extension's look: same TourScript plan format, same spotlight and explanatory text boxes. Move the overlay styles/rendering into one shared module (`pkg/common/src/tour-overlay.ts`) used by both the extension and `dg-skills pw`.
- [ ] `--ext` uses the extension: its review/walkthrough/video choices and the upload-and-receipt flow below stay as planned.
- [ ] `--attach-pr <ref>` works in both modes. Local mode uploads via pw with a saved GitHub login state, else hands over the files plus the PR link with no PR change. In `--ext` mode use the extension-assisted upload/receipt contract below. GitLab attachment reports unsupported before any mutation. Owned-artifact cleanup applies to both modes.
- [ ] Drop the repo-specific recipes (no work data); keep prose that the demo workflow parity spec asserts
- [ ] Bump to 1.19.0; open the Wave 6 draft PR
- [ ] Extend existing registerDemo/TourScript with optional attachment {requestId,pullRequestUrl}; preserve readable Markdown/marker/editor/recorded planMarkdown roundtrip. Add explicit preview Upload to GitHub PR using existing IDB Blob and authenticated validated GitHub PR tab; do not upload on handoff/preview alone.
- [ ] Preserve start-screen stop contract, stage screenshots before handoff, and clean only per-run owned artifacts against a pre-run baseline; never delete all git-status paths.
- [ ] Start with a controlled real synthetic WebM upload spike proving current GitHub native-widget/signed-policy transport and final user-attachments URL; failed spike blocks feature with evidence. No giant runtime/base64 payloads, cookie export, new daemon/ChatFrame/SessionBootstrap or provider upload API.
- [ ] Persist/download receipt {version:1,requestId,pullRequestUrl,assetUrl,filename,mimeType,sizeBytes}; retry reuses completed receipt. Separate demo --attach-receipt <path> --plan <path> validates request/PR and idempotently appends URL via existing provider body update without playback; initial CLI still ends at handoff.
- [ ] First prove an authenticated synthetic WebM upload through the current GitHub page/widget and final inline asset URL. Treat undocumented prepare/finalize transport as a spike candidate; report a blocker with evidence if unavailable.
- [ ] Extend existing TourScript/plan/editor/recording roundtrip with optional attachment {requestId,pullRequestUrl}; add explicit Upload to GitHub PR after preview using the existing Blob and validated authenticated tab.
- [ ] Persist/download a version-1 nonsecret upload receipt; implement separate demo --attach-receipt <path> --plan <path> action to validate the receipt and idempotently append its URL through provider body update. Initial demo still exits at editor handoff.

#### Testing Criteria
##### Contracts
- [ ] Retain setup secrecy/verify/parity tests and add light/dark before/after, owned cleanup and GitLab unsupported-no-change coverage.
- [ ] Shared-module test: one TourScript plan yields the same overlay (styles and rendered spotlight and text boxes) in the extension and in `dg-skills pw`.
- [ ] Local mode: default selection without `--ext`, pw recording with fake browser boundary, saved-login upload, and no-login hand-off that leaves the PR unchanged.
- [ ] Cover metadata roundtrip, old plans, preview-no-upload, origin/PR/account/navigation validation, expiry/failure/retry, bounded messages/secret exclusion and repeated receipt consumption preserving unrelated PR text; add security QA.
- [ ] Roundtrip old/new plans, markers, editor drafts and stored recordings; prove preview has no upload, retries retain media/receipt, wrong origin/PR and expired policy fail actionably, and no giant message/base64 transfer or cookie export occurs.
- [ ] Run a real authenticated upload with synthetic media to establish transport; fake adapter tests cover failure/retry/receipt/body-update cases. Keep setup secrecy, bounded verify and playback approval parity.

#### Acceptance Criteria
- [ ] Real authenticated synthetic upload proves inline URL; recording/receipt remain recoverable on failures; explicit receipt action updates intended PR once. Matched Wave 6 draft base/head/URL for slices 25–27 persisted.
- [ ] Explicit upload publishes only the previewed artifact to the displayed GitHub target; a completed receipt prevents duplicate upload and repeated receipt consumption updates the intended PR once without overwriting unrelated body text.
- [ ] Wave 6 matched versions, test/lint and extension build gates pass; persist the draft base/head/URL for slices 25–27.

### Slice 28 — w7-sync

#### Engineering
- [ ] Rewrite copilot-sync, opencode claude-sync, codex-sync, codex-claude-sync and ai/sync/*.ts in TypeScript as `dg-skills sync <target>`; targets: copilot, opencode, codex, claude, pi, grok
- [ ] Source skills from the dg plugin tree and ~/.claude/skills
- [ ] Keep the verify subcommand
- [ ] Keep trust/permission writes manual as recorded; document intentional parity exception and assert source/permission/settings files untouched.
- [ ] Inventory probe/dry-run/apply/verify plus required transforms/wrappers/plugins; preserve existing sync names as thin routers and Codex-only shim routing.
- [ ] Plugin wins duplicate migrated names with an explicit warning; do not delete local source skills. Track generated outputs for bounded target pruning and native Pi/Grok fixtures with explicit unsupported capabilities.
- [ ] Pin native skill roots from installed primary docs: Pi ~/.pi/agent/skills and project .pi/skills; Grok ~/.grok/skills and project .grok/skills. Recheck target versions during implementation; unsupported non-skill capabilities must be reported explicitly.

#### Testing Criteria
##### Contracts
- [ ] `dg-skills sync <target> [--dry-run|verify]` preserves the non-permission output tree for existing targets, with plugin precedence and manual trust/permission exceptions documented
- [ ] Port the 4k lines of sync tests
- [ ] Port isolated-home nested suites; dry-run/verify zero-write and no permission apply; fake both sources and duplicated names.
- [ ] Recheck primary Pi/Grok versions/layouts at execution; no sync apply against live HOME.

#### Acceptance Criteria
- [ ] Source roots are portable/configured; strict private-data wall is retained without literal banned paths in public material.

### Slice 29 — w7-skill-tools

#### Engineering
- [ ] Port skill-audit.ts, skill-split.ts, skill-publish-cli.ts; plugin target writes into plugins/dg
- [ ] Audit/split canonical plugin skills; remove automatic local shim repair and avoid writes to installed caches; explicit local mode must remain bounded.
- [ ] Make plugin publish an additive update preserving existing dg manifests/other skills; refuse self-moves/destructive destination replacement.
- [ ] Load schema/registry assets from owning installed skill; add AJV/generation dependencies only if actual port requires them.
- [ ] unslop needs no work here: it installs from the upstream repo through the marketplace entry shipped in Wave 3, and `/dg:polish` calls `/unslop:unslop`. No vendoring and no Python port.

#### Testing Criteria
##### Contracts
- [ ] Use synthetic compiled analyze/validate/generate outside checkout; verify existing plugin survives, no unrelated HOME/bin writes and leak/injection/ship protections hold.

#### Acceptance Criteria
- [ ] Canonical plugin maintenance works without local skill paths and cannot replace the whole dg plugin.

### Slice 30 — w7-cleanup-ls-polish-release

#### Engineering
- [ ] Move cleanup (uses configured external daily-prune executable), ls-skills (table uses dg: names), polish (vendor pr-body-style.md into the skill; hook remains a configured external executable)
- [ ] Bump to 1.20.0; open the Wave 7 draft PR
- [ ] Use configurable daily-prune/prose-check executable paths with actionable unavailable behavior, preserving excluded hook scope and strict private-path wall.
- [ ] Require a source checkout for maintenance writes; installed cache reports proposals and runtime history stays outside plugin; reconcile ls-skills scope/categories/removed/merged aliases.
- [ ] Consolidation sweep over `pkg/skills-cli/src`: hoist helpers duplicated across waves into `pkg/common`, delete dead compatibility shims, and replace remaining legacy API calls with current ones; no behavior change.

#### Testing Criteria
##### Contracts
- [ ] bun run test:all and bun run lint:all green
- [ ] Verify canonical inventory, relative PR-style references, absent-hook errors and no permission/local-cutover writes; matched version gates.

#### Acceptance Criteria
- [ ] Every listed dg skill exists; matched Wave 7 draft base/head/URL for slices 28–30 and complete seven-PR stack persisted; manual cutover remains separate.

## Demo Attachment Contract

Wave 6 extends the existing demo command and extension recording review. This contract describes the `--ext` mode; local mode (the default) uploads through `dg-skills pw` as slice 27 describes. Add optional TourScript `attachment: {requestId: string, pullRequestUrl: string}` with a generated request id and canonical HTTPS GitHub PR URL. Preserve it through readable plan frontmatter, parse/format, marker validation, editor draft conversion and recorded planMarkdown. Existing plans and recordings without it remain valid. `demo --attach-pr <ref>` resolves the target through the provider and rejects unsupported GitLab before handoff.

The original CLI opens the extension editor and exits. Playback still uses the existing start screen; the agent stops at handoff. The existing post-recording review page displays the exact target and adds an explicit Upload to GitHub PR action after preview. Reuse its IndexedDB Blob and existing runtime/scripting validation patterns for the authenticated GitHub tab. Prove the actual browser upload flow first with synthetic media; signed prepare/finalize is a transport candidate, not a promised public endpoint. Failed proof is an engineering blocker to report, not authority to silently substitute a different artifact host.

On success persist and offer to download a JSON receipt with exactly `version: 1`, `requestId`, `pullRequestUrl`, `assetUrl`, `filename`, `mimeType`, `sizeBytes`; assetUrl is the final HTTPS GitHub user-attachments URL. Never include cookies, CSRF values or upload policies in receipts/logs. Preserve media and the completed receipt through retry/download failures; successful retries reuse the receipt instead of publishing twice. Keep existing download/discard choices and ordinary recording retention. Avoid one-message/base64 video transfer.

A later explicit `demo --attach-receipt <path> --plan <path>` validates receipt/request/PR identity and uses existing provider body operations to append the asset URL with an idempotent request-id marker, preserving unrelated current body text. It does not require a script positional argument or start playback. No new daemon channel, ChatFrame discriminator, SessionBootstrap field, provider upload API or cookie permission is required. Recording remains on the existing supported Chromium path.

## Slice Summaries

### Slice 1 — w2a-foundation-stash (fc534b3)

Ported the complete reusable filesystem API except scriptsRoot into common; added compatible define/raw Commander bridges, stash and the required clipboard-image support port. Migrated stash plus five Wave 1 consumer trees to compiled invocation/bootstrap; removed refactor's remaining slugify helper dependency and added strict public-path and bare-helper checks.

Evidence: original/Green filesystem-stash-bridge suites 114 pass, clipboard/scanner suites 43 pass, CLI smoke 7 pass, canonical skill manifest coverage 189 pass. Scoped common, skills-cli and skills-test type checks passed. Compiled stash worked outside checkout with empty PATH; compiled clipboard emitted exact 1,048,584 synthetic bytes with only fake native tools, preserved directory/symlink/mode semantics and left no owned temp files. MiniQA reviewer/qa-code plus orchestrator audit clean after one bounded correction round. No live clipboard or legacy source writes.

### Slice 2 — w2a-vcs-provider (3b41601)

Ported the full provider library and all ten CLI verbs, plus git/shell-args/json utilities. Shared process capture adds runCaptureBytes without changing the default runCapture function signature; exact byte streams and absent-versus-empty stdin are preserved. Removed the source machine-specific GitLab reviewer default while retaining explicit configured reviewers. Channel-review verdict readers remain separate.

Evidence: 386 provider/utility/CLI tests passed across ten suites (1,017 assertions), including inert imports and relocated compiled operations for both fake providers. Common capture tests 18 pass; existing process/clipboard regression 48 pass; smoke 8 pass; public scan 22 pass. Scoped common, skills-cli and skills-test type checks passed. Independent qa-code verification 55 pass and security 131 pass; both reviews clean. Sandbox IPC failures disappeared with identical isolated fake-only tests outside the sandbox. No live provider calls or configuration writes.

### Slice 3 — w2a-proxy (d076c49)

Migrated all six backend adapters and proxy CLI with raw argv, import isolation, exact result/status behavior, explicit-plan persona lookup via native Bun YAML and configured persona directories. Packaged detached run/list/status/update/drain/cancel/kill/prune compatibility before public bg/spec; generated source/compiled commands quote every argument. Shared real-resource locator supports configured/installed/source roots, both plugin layouts, relocation and symlink containment, rejecting Unix/Windows virtual Bun paths. Added proxy skill and retired-helper invocation checks.

Red ported eleven behavioral suites plus shared-helper contracts. Green and parent verification: 215 proxy/helper tests (193 non-background plus 22 compiled background), including all six fake backends, real shell-generated launches, persona plans, ordered queue/autodrain/resume, detached groups, prune/cancel, statuses 7/124, crash-lock ownership/recovery and five stale-PID identity cases. Smoke/privacy 37 pass; common/skills-cli/skills-test lints clean. Independent qa-code clean; security clean after correction 1 resolved missing-identity PID ownership (CWE-362). No live backend or local install mutation. Native Windows execution untested; Windows virtual-path guard tested.

### Slice 4 — w2a-release (9344d3a; delivered through 0052265)

Prepared matched release 1.15.0 across the four released packages, both plugin manifests, daemon status and workspace lock entries; common stays 1.0.0. Updated README/developer guidance and canonical index for all 27 current skill folders, runtime dependencies, complete provider inventory, proxy/background/persona/resource paths and manual post-merge cutover. Red target-version test failed against 1.14.0; focused release/manifest/privacy suites 277 pass. Green compiled operational selectors 24 pass/257 assertions and clipboard/release suites 60 pass/655 assertions. MiniQA qa-devops clean.

Required full-suite run exposed two preexisting fixture problems: common's fixed skill inventory (fixed independently on prerequisite 44aa3f0, pushed to PR27 and reconciled by merge ac611dc), and extension toolbar fixture's live localhost discovery race (8-line pairing-boundary isolation in this release, production files unchanged from 537f8ba). Forced delayed discovery reproduced the original UI failure and passes after correction; full chat-page suite 56 pass and focused repeat 3/3. All eight lints passed before the fixture change; extension lint rerun pending. Final wave gates completed: 5,062 tests pass, all eight lint packages pass, all four final reviewers clean after correction1, 148 public declarations documented, draft PR28 opened against prerequisite27. Follow-through commits71748e9/f0d3584/0052265 include private artifact protection, streaming clipboard capture, comment-only API docs and the aligned stash privacy test.

### Slice 5 — w2b-address-review-loop (ff75474)

Ported all 19 address operations through the shared raw/define-command bridge with inert imports and unchanged legacy handlers. Migrated complete address/review-loop trees (nine files), compiled bootstrap/calls, relative/configured lazy handoffs, explicit GitLab bot setup and existing narrow approvals. Corrected missing commentId in a reply example and stale host worktree API claims. Kept the existing native gh read for Wiz summary comments: neither address's 19 operations nor the provider CLI exposes issue-summary comments; no invented API was added. Updated one channel-review prerequisite sentence and extended retired-helper detection; slice10 retains full defaults/grants ownership.

Red138 failed against absent command/references; final Green139 pass,512assertions, including a relocated compiled binary in paths with spaces from external cwd, both fake providers, exact emoji/newline/metacharacter replies, stdin batches, reply-before-resolve, capability refusal4, degradedJSON0 and empty-stream polling timeout124. Source help/smoke/privacy41 pass; manifest/channel-review248 pass; skills-cli and skills-test type checks pass. Independent qa-code repeated139 tests and verified inert imports; MiniQA clean. Sandbox stdin EPERM resolved by identical fake-only tests outside sandbox. No live provider/workflow or local settings actions.

### Slice 6 — w2b-thrash (f9b205a)

Ported the complete thrash core and all five helper verbs with inert registration, preserving findings/verdict/address-file schemas, local publishing and provider fallback. Migrated all three skill files to compiled DG commands, installed relative skills and configured personas, native or packaged background execution, and same-session/cwd proxy retry. Corrected stale proxy missing-backend prose and distinguished skill orchestration from helper verbs.

Evidence: 75 core/helper/compiled tests passed with 335 assertions; relocated binary and three-skill tree ran outside the checkout with no legacy helpers on PATH. Covered local diff/compile/address handoff, fake GitHub stack/post/tally and address gather/resolve, GitLab context positions/degraded approval, actual proxy malformed-artifact resume and missing-backend no-fallback. Smoke/privacy 44 pass; skills-cli and skills-test lints pass. Independent qa-code MiniQA and guarded inert-import checks clean; root slice audit all complete. A literal unified-diff context space was encoded as \x20 for staged whitespace hygiene, preserving runtime bytes; 47 core tests reran clean. Native stdin passed unchanged outside sandbox after measured EPERM. No live provider calls or legacy writes.

### Slice 7 — w2b-chain-file (2d7cadc)

Ported all chain rendering/planning/base/apply/native behavior and file create/list/view/bucket operations, preserving raw argv, measured streams/statuses, failure sequencing and provider grammar. Full chain/file skill trees use quoted compiled commands, portable bootstrap and host approval semantics honoring existing session grants; private work data and host-specific frontmatter were removed. Extended the retired-helper scanner under serialized ownership.

Evidence: 127 tests passed, 430 assertions, including all 77 legacy cases and five compiled checks with a physically relocated binary, copied skills-only bootstrap and two installed skill trees after build-stage removal. Both fake providers exercised chain plan/apply/idempotent managed bodies and all four issue verbs with literal Unicode/newline/metachar argv/stdin; native GitLab apply refuses 4 before calls, while native plan explains unsupported status 0. Smoke/privacy 49 pass; both scoped lints and staged whitespace checks pass. Independent qa-code MiniQA and root slice audit clean. Ported compiled chain plan/apply then registered actual draft #27→#28→master using existing grants; provider readback confirmed one managed block per body and intended bases with original description headings intact. No live issue/test-provider calls or legacy/settings writes.

### Slice 8 — w2b-meaningful-deps-upgrade (f55483c)

Ported all four meaningful verbs and sixteen dependency-upgrade verbs with inert registration and settled imports. Added the required internal TypeScript worktree-create API before the later public lifecycle command; prepare calls it directly. Durable dependency state uses the validated common directory at the unchanged project-scoped path. Migrated all seven skill files, replaced complete private author/project examples with matching synthetic data, and retained narrow host approval/session-grant behavior without cache edits.

Evidence: final 344 tests passed, 987 assertions, including retained legacy suites, real local-origin history/backup/rollback/create/resume cases, and five compiled checks after binary/skill installation relocation and build-stage removal. Compiled operations cover all seven installed files, literal authored JSON history plus local push/abort, actual dependency preparation/shared audit state, both fake-provider draft/readiness operations, and no legacy helpers or downloads on PATH. Smoke/privacy 55 pass; skills-cli and skills-test lints plus staged whitespace pass. Independent qa-code MiniQA and root slice audit clean after two bounded corrections: seeding matches visible symlink/hidden-directory glob behavior, and preparation preserves captured success/error/native-Git streams. Exact fresh/resume/path-conflict/branch-elsewhere status/stdout/stderr were compared to unchanged legacy. No live provider/registry calls or legacy/settings writes; native Windows runtime remains untested.

### Slice 9 — w2b-catchup (6c6c302)

Rewrote catchup and required project verification in TypeScript with inert raw-argument registration, preserved Git statuses, tracked-work stashing/recovery, true merge-base rebase, verification ordering, and default force-with-lease push guards. Build-tool stdout/stderr stream together without buffering. Migrated the complete portable catchup skill and extended retired-shell invocation detection. Help is additive and safe outside a repository.

Evidence: final 67 tests passed, 379 assertions, 39.41 seconds; original 61 cases plus four rebuilt compiled relocation checks and two measured regressions. Legacy oracle passed 58 scenarios; only new help/import-isolation checks were excluded in temporary oracle copies. Compiled cases remove the build stage, relocate binary and installed skill, operate against disposable local origins, exercise default push/no-push/stash preservation/fake verification failure, and execute the installed bootstrap with Git-only PATH. Smoke/privacy 61 pass, 160 assertions; both scoped TypeScript checks and staged whitespace pass. Independent qa-code MiniQA and root audit clean after one correction: missing Git returns 127 while ordinary Git 128 remains intact, and root paths retain trailing spaces by removing LF only. No live providers/build tools or legacy/settings writes.
### Slice 10 — w2b-channel-review-defaults-release (5e78267)

channel-review defaults now use one `Bash(~/.dg/bin/dg-skills <sub>:*)` grant each for thrash, address and deps-upgrade and read skills from the dg plugin cache (`~/.claude/plugins/cache/*/dg/*/skills/<name>/**`). The claude probe accepts only that cache path; copilot uses only `.copilot/skills`; codex is unchanged. The no-local-zone scan bans `~/.claude/skills/` in plugins/dg/skills, pkg/skills-cli/src and pkg/channel-review/src. No version bump (slice 15 owns it). channel-review 1483 pass; slice specs 107 pass; lint:all green.
### Slice 11 — w3-worktree (8af1c80)

`dg-skills worktree create|list|remove|prune` replaces the legacy shell worktree-cli; the worktree skill is in plugins/dg/skills/worktree. create prints three KEY=value lines, raw for shell-safe values and single-quoted otherwise, so eval works with spaces. remove keeps the four guards; no provider CLI or unknown host blocks silently with `not merged into origin/`; no --force retry. Branch plus plain directory exits 2 (deliberate change). list adds STATUS no-upstream. deps-upgrade prepare reuses the create core. 382 skills-cli and 84 skills-test tests pass; lint:all green.
### Slice 12 — w3-spec-sdlc-assign (715efc1)

`dg-skills spec` replaces spec-cli (schema, scaffold, context, roundtable, perms, wave lint) and the spec, sdlc and assign skills ship with their references and templates; kick, pickup and prd are thin wrappers over spec. A shared @dg/common/node locator (`claudePluginSkillsDirs`) finds the installed dg plugin at `~/.claude/plugins/cache/*/dg/<newest semver>/plugins/dg/skills`; skill assets and the channel-review probe use it, and the Read grants were corrected in 6a85adc. /prototype is plain text until Wave 6. 710 skills-cli, 493 common, 1484 channel-review and 685 skills-test tests pass; lint:all green.
### Slice 13 — w3-monolith-spring-break (4b43f09)

`dg-skills monolith` replaces monolith-helper (eleven verbs) and monolith-worktree-gen; the monolith and spring-break skills ship. Generator assets resolve through resolveSkillAsset, so the plugin cache works without DG_SKILLS_DIR; legacy exit codes kept. grill-me's relative monolith pointer from slice 12 now resolves. 151 monolith tests, 707 skills-test tests pass; lint:all green.
### Slice 14 — w3-viz-review (28a247b, dropped 2026-10-20)

Superseded: viz and review no longer ship (commit fc16957). Original summary: `dg-skills viz` replaces viz-cli (sixteen verbs); the Astro viewer source and bun.lock are vendored in plugins/dg/skills/viz (1.2 MB, no node_modules, caches, images or video), and the review skill ships. First run installs with --frozen-lockfile; a dependency hash in the install marker triggers reinstall; Bun missing or a read-only viewer dir exits 1 with an actionable message. Viewer lookup uses VIZ_SKILL_DIR, then the installed skill locator. Real-viewer run (DG_VIZ_REAL_VIEWER=1) passed 33 tests; viz specs 66 pass; skills-test 733 pass; lint:all green.

## Agent Notes

Planning synthesis is complete. Use the reviewed 30-slice ownership and Wave Execution Contract above. The raw roundtable evidence is quarantined from execute mode.

- Source baseline is feature/skills_import (Wave 1 plus this bundle); fetch/reconcile the default branch before building and honor the slice-10 prerequisite by content/recorded commit rather than stale branch-name comparisons.
- Run SDK/browser compile spikes in slices 20/25; stop and report evidence if the single-binary requirement fails. The authenticated extension-upload spike is the first task in slice 27.
- Source tools/skills are migration inputs, not runtime dependencies. Leave legacy directories untouched during the port. Manual user cutover after each merge includes plugin refresh, command shims, reference rewrites and eventual local skill removal.
- Preserve existing approval semantics and the pw code separation. Permission/setup changes are manual; this planning approval grants no engineering execution permissions.


- (slice 1, orchestration) Inventory found clipboard-img still depended on the legacy clipboard-image shell helper. Complete the required support dependency as a small TypeScript clipboard-image subcommand with isolated fake-native tests; preserve observed backend/stream/status behavior and keep live clipboard access outside testing. Ownership extended to its command, domain, and test files so the five-consumer no-legacy-PATH acceptance is true.

- (slice 1, js) Shared test repositories and isolated roots live in pkg/skills-cli/__tests__/git-repo-fixtures.ts; reuse this owner. Raw Commander registration overrides public parseOptions to preserve literal --; source/compiled parity is tested. State buckets use main-project hash, scratch buckets use cwd hash. Clipboard file output stages an exclusive sibling before replacing target entries so file symlinks are not followed.

- (slice 2, orchestration) Exact legacy Buffer streams require a non-lossy shared capture seam. Ownership includes common/src/node/process.ts and common/__tests__/node-paths.spec.ts. Added an opt-in encoding: buffer overload, decode-after-collection for existing UTF-8 captures, and stdin EPIPE handling; default string API remains compatible. Red tests reproduced binary/split-UTF8 corruption; all 17 helper tests pass outside the sandbox IPC restriction.
- (slice 1, security) Explicit process/privacy/quoting/path-ownership audit of 523f1b5..fc534b3 is clean; no live clipboard tools invoked.

- (slice 2, js) Final shared seam is runCaptureBytes, not the provisional encoding overload. runCapture keeps its single text-returning signature for typeof-runCapture wrappers and decodes after full capture. opts.stdin:null selects ignore; undefined preserves the common closed-pipe default; empty string remains a pipe. runShell passes opts.input ?? null. Reuse cli-fixtures.ts/fake-cli.ts and git-repo-fixtures.ts. GitLab bot capability is false/[] unless explicitly configured; generic fixture names replace source-specific defaults.

- (slice 3, js) Reuse selfCommand(args) and shellCommand(argv) for compiled/source self-dispatch. resolveSkillAsset(skill, relativePath, opts) owns explicit/configured/source installed lookup; explicit missing roots fail without fallback, real source discovery covers both root/skills and root/plugins/dg/skills. Never use virtual import.meta paths to locate resources.
- (slice 3, js) Persona lookup accepts DG_PERSONAS_DIR then DG_AGENTS_DIR before the existing personal fallback. Explicit plans resolve numeric/string slice IDs with Bun.YAML; direct resume bypasses persona, while --plan always emits a fresh persona-resolved execution as observed legacy behavior.
- (slice 3, background) Public bg handoff: proxy background owns detached compatibility internals. Keep PID/identity ephemeral; Linux birth identity is mandatory for liveness/cancel, identity publishes before PID behind launch gate. Lock directories publish complete nonce owner atomically, recover confirmed dead/reused owners or empty abandoned dirs, preserve live/ambiguous nonempty dirs, release only owned nonce. Reuse these safeguards in slice17.

- (Wave 2a final correction1) Shared scratch/state directory creation now validates selected-root ownership, writable ancestor chains, containment and managed symlinks; owned managed directories are 0700. Explicit configured root symlinks require a safe resolved chain. Do not weaken this for fixtures: use owned isolated roots. Foreign/shared unsafe paths fail without modification; sticky public ancestors remain allowed. Concurrent first creation catches EEXIST and validates the resulting entry. Proxy creates an exclusive 0600 transcript before backend launch. Clipboard extraction streams native stdout to its owned temporary descriptor; file/scratch modes stat size without loading full image bytes. Final security/performance reviews clean; 96 focused tests pass.

- (slice 5, orchestration) Address handler streams/statuses remain legacy: no verb2/stdout usage; unknown verb2/stderr; handler argument failure1; unsupported Copilot capability4 before argument validation; polling timeout124 with empty streams. Synthetic GitLab reviewer fixtures must explicitly configure VCS_GITLAB_AI_REVIEW_BOT after Wave2a removed its private default.
- (slice 5, docs) One native gh read for Wiz issue-summary discovery remains a declared external dependency because the existing address/provider verbs do not expose those comments. All private helper calls are compiled DG calls. Complete reference trees keep phase/routing/approval semantics; no broad compiled-binary permission grant. S10 must finish channel-review runner defaults, plugin probing and narrow grants, including remaining setup reference literals.

- (slice 6, orchestration) Actual helper verbs are diff/compile/post/stack/tally; chunking and --proxy are skill orchestration. Local ADDRESS_FILE is consumed by the address skill, not a new address CLI API. Serial scanner ownership extended to thrash-helper. Proxy retry must use actual execution --resume with retained cwd, or background update and its returned newJobId/newJobLog; --plan always creates fresh execution.

- (slice 7, js) Chain no-args remains 1/stderr and help 0/stderr; file no-args is 2/stdout, unknown verb 2, handler error 1. GitLab native apply refuses 4 before mutation, native plan reports skip with 0. Retarget failures log and continue; body failures abort after earlier writes. Native extension linking is optional and a failed link still allows body updates. Managed body markers are <!-- /chain:start --> and <!-- /chain:end -->.

- (slice 8, js) Meaningful has info/apply/apply-json/abort and --base; apply always pushes, without invented --push/--no-push flags. Empty groups remain status 3. Dependency preparation keeps drb/chore prefix. Reuse createWorktree from deps-upgrade/worktree-compat in slice11, including its optional formatted diagnostic reporter and exact legacy info/warn/native operation mapping. One-argument callers report stderr; prepare captures/discards successful diagnostics and uses the legacy die wrapper on failure. The worktree-cli label in that error wrapper is diagnostic text, not an executable dependency; retirement scans must distinguish diagnostics from actual invocations. Placement reads process.env.HOME before homedir because Bun cached the initial home in the changed-environment fixture.

- (slice 9, orchestrator) User identified origin/master as the slice-10 prerequisite ref. Re-fetched after final slice-9 checks: still 537f8ba1c60999f222db8d449654c9255673a8b0, with no runner.fallback or CR-207 implementation. Asked whether to retain the explicit content prerequisite and wait, or remove it and proceed on current master. Resolved via /walk: user answered “keep the pre-req”. Retain the content gate and wait for fallback to land on origin/master; no clarification remains open. On resume, fetch and verify committed content before slice 10. Do not stage the launch checkout’s uncommitted fallback work.

- (execution, user) User reiterated: “once done, kick it up to a open pr for reviewing.” Push and open the completed wave as a draft review PR under the existing grants after the retained prerequisite and all wave checks pass; keep the approved one-PR-per-wave strategy. No renewed publication approval is needed.

- (execution, stack) Read user-selected note /tmp/ai/jot/50d2b267/jot-colossal-sole.md through jot-cli; kind note, retained. User instructed prerequisite PR26 first and all existing PRs opened for review. The old native stack29 rejected base edits and prepending; safely unstacked its membership and recreated native stack30 in required order after chain plan/apply. No branches, commits, PRs, or description prose were removed. Final API readback verifies all ready, positions1–3, exact bases and original heads; all descriptions outside managed blocks preserved. Wave2b stays local one-commit b79344e until its retained prerequisite/completion gates pass.

- (execution, Claude verification) User requested notification when complete and actual Claude verification before moving to the new skills. Installed Claude Code2.1.302 is available. Relocated plugin at /tmp/dg claude compat 4u35q1hi has 35 skill roots/93 skill files; strict manifest validation passed, but contents arrays were empty, so no runtime discovery/behavior success is claimed. Read-only external model review was rejected before execution by automatic approval review because private source and legacy skill contents would be sent to a third party without specific payload consent. Scope prepared at /tmp/dg claude compat 4u35q1hi/CLAUDE_REVIEW_SCOPE.md (25 legacy comparison files across eleven skill trees; packaged skills and relevant CLI/test sources). Ask for explicit scoped consent; no workaround or model fallback.
- (slice 10, js) grill-me has no local skill pointer; the no-local-zone ban covers it, so slice 12 has nothing to migrate there.
- (slice 10, js) core-config.spec.ts is not biome-formatted on master either; lint:all does not enforce biome format, so slice diffs keep master's formatting.
- (slice 10, qa-code) release-versions only compares manifests to skills-cli; slice 15 must bump every package and manifest together and extend that test.
- (slice 11, js) Create output is eval-safe; `list --porcelain` values stay raw and parsers split on the first `=`.
- (slice 11, orchestrator) A fix agent ran biome over all of pkg/skills-cli/src; the format-only changes were reverted. Agents must not format files they did not change.
- (slice 12, js) A marketplace install caches the whole repo; skills are at cache/<m>/dg/<v>/plugins/dg/skills, and Bash commands get no CLAUDE_PLUGIN_ROOT. Use claudePluginSkillsDirs from @dg/common/node for any installed-asset lookup.
- (slice 12, js) Links to skills shipped in a later wave must be plain text; standalone-planning-skills.spec.ts allows only same-wave pending links (monolith).
- (slice 12, js) spec front-matter edits use the yaml package Document API to keep comments and key order; Bun.YAML cannot.
- (slice 13, js) Bun.Glob brace patterns containing * match nothing; scan pattern and */pattern as separate globs.
- (slice 13, js) Slice 15 must add monolith and spring-break to the README skill index along with the version bump.

## Issues Remediation

## Planning Approval

Approved through the spec board at 2026-10-17T00:18:52+00:00; board all_clear was true. Board slug: 005-dg-skills-consolidation-817d1848. Revision 1.1 includes thirty normal-depth slice reviews, foreman synthesis, resolved product decisions, explicit ownership re-scaffold and the extension attachment contract. No engineering work was executed by this planning run.