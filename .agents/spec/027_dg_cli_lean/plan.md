---
feature: "Lean dg CLI: latency, binary and download size, skill token weight, and the C# front door"
feature_snake_case: dg_cli_lean
date: "2026-11-24"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "baseline-latency"
    depends_on: []
    files: ["scripts/ram-budget.ts","scripts/ram-budget/**","scripts/ram-budgets.json"]
    agents:
      primary: dg:devops
      confidence: high
      qa: [dg:qa-perf]
  - id: 2
    name: "baseline-size"
    depends_on: []
    files: ["scripts/lean-size.ts","scripts/lean-budgets.json","pkg/skills-test/__tests__/lean-size.spec.ts"]
    agents:
      primary: dg:devops
      confidence: high
      qa: [dg:qa-perf]
  - id: 3
    name: "baseline-skill-tokens"
    depends_on: []
    files: ["scripts/skill-tokens.ts","scripts/skill-token-budgets.json","pkg/skills-test/__tests__/lean-skill-tokens.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 4
    name: "budget-ratchet"
    depends_on: []
    files: ["scripts/budget-ratchet.ts","pkg/skills-test/__tests__/budget-ratchet.spec.ts",".github/workflows/budgets.yml"]
    agents:
      primary: dg:devops
      confidence: high
      qa: [dg:qa-perf]
  - id: 5
    name: "build-split"
    depends_on: []
    files: ["pkg/launcher/build.ts","pkg/launcher/build/**","pkg/launcher/__tests__/build.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 6
    name: "version-path"
    depends_on: []
    files: ["pkg/launcher/src/**","pkg/launcher/__tests__/dispatch.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-perf]
  - id: 7
    name: "hooks-fast-route"
    depends_on: []
    files: ["pkg/dg/src/fast-route.ts","pkg/dg/__tests__/fast-route.spec.ts","pkg/skills-cli/src/hooks/cli.ts","pkg/skills-cli/src/hooks/run.ts","pkg/skills-cli/src/hooks/io.ts","pkg/skills-cli/__tests__/hooks-fast-path.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-perf]
  - id: 8
    name: "completion-fast-path"
    depends_on: []
    files: ["pkg/skills-cli/src/completion/**","pkg/skills-cli/__tests__/completion-fast-path.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-perf]
  - id: 9
    name: "release-compress"
    depends_on: []
    files: [".github/workflows/release.yml","pkg/skills-cli/src/utils/lib.ts","pkg/skills-cli/src/install/compiled.ts","pkg/skills-cli/__tests__/install-compressed.spec.ts","pkg/skills-test/__tests__/release-compressed.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-devops, dg:security]
  - id: 10
    name: "bootstrap-gz"
    depends_on: []
    files: ["pkg/skills-cli/bootstrap.sh","pkg/skills-cli/bootstrap.ps1","pkg/skills-cli/__tests__/bootstrap-*.spec.ts","pkg/skills-cli/__tests__/bootstrap-fixtures.ts","pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts"]
    agents:
      primary: dg:shell
      confidence: high
      qa: [dg:qa-devops]
  - id: 11
    name: "skill-diet-phone"
    depends_on: []
    files: ["plugins/dg/skills/phone/**"]
    agents:
      primary: dg:lore
      confidence: high
  - id: 12
    name: "skill-diet-status"
    depends_on: []
    files: ["plugins/dg/skills/stat/**","plugins/dg/skills/jobs/**","plugins/dg/skills/bg/**","plugins/dg/skills/jot/**","plugins/dg/skills/overwatch/**"]
    agents:
      primary: dg:lore
      confidence: high
  - id: 13
    name: "skill-diet-review"
    depends_on: []
    files: ["plugins/dg/skills/thrash/**","plugins/dg/skills/review-loop/**","plugins/dg/skills/address/**","plugins/dg/skills/polish/**","plugins/dg/skills/sniff/**","plugins/dg/skills/land/**"]
    agents:
      primary: dg:lore
      confidence: high
  - id: 14
    name: "skill-diet-planning"
    depends_on: []
    files: ["plugins/dg/skills/spec/**","plugins/dg/skills/sdlc/**","plugins/dg/skills/kick/**","plugins/dg/skills/pickup/**","plugins/dg/skills/assign/**","plugins/dg/skills/grill-me/**","plugins/dg/skills/prd/**","plugins/dg/skills/wayfinder/**","plugins/dg/skills/walk/**","plugins/dg/skills/refactor/**","plugins/dg/skills/chain/**"]
    agents:
      primary: dg:lore
      confidence: high
  - id: 15
    name: "skill-diet-rest"
    depends_on: []
    files: ["plugins/dg/skills/adr/**","plugins/dg/skills/agent-seed/**","plugins/dg/skills/bot-commit-email/**","plugins/dg/skills/catchup/**","plugins/dg/skills/chat/**","plugins/dg/skills/channel-review/**","plugins/dg/skills/clipboard-img/**","plugins/dg/skills/cls/**","plugins/dg/skills/db/**","plugins/dg/skills/deps-upgrade/**","plugins/dg/skills/doctor/**","plugins/dg/skills/eli5/**","plugins/dg/skills/erd/**","plugins/dg/skills/file/**","plugins/dg/skills/find-work/**","plugins/dg/skills/google-sms-cleanup/**","plugins/dg/skills/hook-comment-disable/**","plugins/dg/skills/hooks/**","plugins/dg/skills/hunt/**","plugins/dg/skills/inbox-cleanup/**","plugins/dg/skills/meaningful/**","plugins/dg/skills/monolith/**","plugins/dg/skills/nope/**","plugins/dg/skills/proxy/**","plugins/dg/skills/pushup/**","plugins/dg/skills/rename-session/**","plugins/dg/skills/spring-break/**","plugins/dg/skills/standard-test/**","plugins/dg/skills/stash/**","plugins/dg/skills/teach/**","plugins/dg/skills/ticket/**","plugins/dg/skills/update/**","plugins/dg/skills/what-changed/**","plugins/dg/skills/worktree/**"]
    agents:
      primary: dg:lore
      confidence: high
  - id: 16
    name: "browser-mode-flag"
    depends_on: []
    files: ["pkg/skills-cli/src/pw/cli.ts","pkg/skills-cli/src/pw/core/dispatch.ts","pkg/skills-cli/src/pw/core/spec.ts","pkg/skills-cli/src/pw/browser-mode.ts","pkg/skills-cli/__tests__/pw-browser-mode.spec.ts","pkg/common/src/node/dg-toml.ts","pkg/common/__tests__/dg-toml.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 17
    name: "ext-verbs-navigation"
    depends_on: []
    files: ["pkg/extension/lib/background/pw-verbs/navigation.ts","pkg/extension/__tests__/pw-verbs-navigation.spec.ts","pkg/common/src/pw-ext-verbs/navigation.ts","pkg/common/__tests__/pw-ext-verbs-navigation.spec.ts","pkg/skills-cli/src/pw/ext-verbs/navigation.ts","pkg/skills-cli/__tests__/pw-ext-verbs-navigation.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 18
    name: "ext-verbs-pointer"
    depends_on: []
    files: ["pkg/extension/lib/background/pw-verbs/pointer.ts","pkg/extension/__tests__/pw-verbs-pointer.spec.ts","pkg/common/src/pw-ext-verbs/pointer.ts","pkg/common/__tests__/pw-ext-verbs-pointer.spec.ts","pkg/skills-cli/src/pw/ext-verbs/pointer.ts","pkg/skills-cli/__tests__/pw-ext-verbs-pointer.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 19
    name: "ext-verbs-input"
    depends_on: []
    files: ["pkg/extension/lib/background/pw-verbs/input.ts","pkg/extension/__tests__/pw-verbs-input.spec.ts","pkg/common/src/pw-ext-verbs/input.ts","pkg/common/__tests__/pw-ext-verbs-input.spec.ts","pkg/skills-cli/src/pw/ext-verbs/input.ts","pkg/skills-cli/__tests__/pw-ext-verbs-input.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 20
    name: "ext-verbs-page"
    depends_on: []
    files: ["pkg/extension/lib/background/pw-verbs/page.ts","pkg/extension/__tests__/pw-verbs-page.spec.ts","pkg/common/src/pw-ext-verbs/page.ts","pkg/common/__tests__/pw-ext-verbs-page.spec.ts","pkg/skills-cli/src/pw/ext-verbs/page.ts","pkg/skills-cli/__tests__/pw-ext-verbs-page.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 21
    name: "ext-verbs-storage"
    depends_on: []
    files: ["pkg/extension/lib/background/pw-verbs/storage.ts","pkg/extension/__tests__/pw-verbs-storage.spec.ts","pkg/common/src/pw-ext-verbs/storage.ts","pkg/common/__tests__/pw-ext-verbs-storage.spec.ts","pkg/skills-cli/src/pw/ext-verbs/storage.ts","pkg/skills-cli/__tests__/pw-ext-verbs-storage.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:security]
  - id: 22
    name: "ext-agent-window"
    depends_on: []
    files: ["pkg/extension/lib/background/agent-window.ts","pkg/extension/lib/background/site-allow-prompt.ts","pkg/extension/entrypoints/site-allow/**","pkg/extension/__tests__/agent-window.spec.ts","pkg/extension/__tests__/site-allow-prompt.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:security]
  - id: 23
    name: "relay-contract"
    depends_on: []
    files: ["docs/relay-protocol.md","pkg/common/fixtures/relay/**","pkg/common/__tests__/relay-fixtures.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 24
    name: "plugin-contract"
    depends_on: []
    files: ["docs/plugin-protocol.md","pkg/common/src/plugins/manifest.ts","pkg/common/src/plugins/contract.ts","pkg/common/src/plugins/config.ts","pkg/common/fixtures/plugins/**","pkg/common/__tests__/plugins-manifest.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 25
    name: "cs-scaffold"
    depends_on: []
    files: ["native/Dg.slnx","native/global.json","native/Directory.Build.props","native/Directory.Packages.props","native/.editorconfig","native/src/**/*.csproj","native/tests/**/*.csproj","native/bench/**/*.csproj","native/tools/**/*.csproj","native/tests/Directory.Build.props","native/src/Dg.Core/Abstractions/**","native/src/Dg.Core/Errors/**","native/src/Dg.Core/Output/**","native/src/Dg.Cli/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 26
    name: "ci-lean-gates"
    depends_on: [1,2,3,4]
    files: [".github/workflows/compiled-dg.yml","docs/lean-baseline.md"]
    agents:
      primary: dg:devops
      confidence: high
      qa: [dg:qa-perf]
  - id: 27
    name: "build-report"
    depends_on: [5]
    files: ["pkg/launcher/build/report.ts","pkg/launcher/__tests__/build-report.spec.ts","scripts/size-diff.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 28
    name: "build-bytecode"
    depends_on: [5]
    files: ["pkg/launcher/build/compile.ts","pkg/launcher/__tests__/build-compile.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-perf]
  - id: 29
    name: "build-companions"
    depends_on: [5]
    files: ["pkg/launcher/build/companions.ts","pkg/launcher/__tests__/build-companions.spec.ts","pkg/common/src/node/companion.ts","pkg/common/__tests__/companion.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 30
    name: "dispatch-wire"
    depends_on: [6,7,8]
    files: ["pkg/launcher/src/dispatch.ts","pkg/launcher/__tests__/dispatch-fast.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-perf]
  - id: 31
    name: "delta-patches"
    depends_on: [9]
    files: [".github/workflows/release-patches.yml","pkg/skills-cli/src/install/patch.ts","pkg/skills-cli/src/install/compiled.ts","pkg/skills-cli/__tests__/install-patch.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-devops, dg:security]
  - id: 32
    name: "cs-core-config"
    depends_on: [25]
    files: ["native/src/Dg.Core/Paths/**","native/src/Dg.Core/Config/**","native/src/Dg.Core/Credentials/**","native/tests/Dg.Core.Tests/Paths/**","native/tests/Dg.Core.Tests/Config/**","native/tests/Dg.Core.Tests/Credentials/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 33
    name: "cs-hooks-engine"
    depends_on: [25]
    files: ["native/src/Dg.Hooks/Engine/**","native/src/Dg.Hooks/HooksServiceCollectionExtensions.cs","native/src/Dg.Hooks/Defs/*/Registration.cs","native/tests/Dg.Hooks.Tests/Engine/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 34
    name: "cs-routing-version"
    depends_on: [25]
    files: ["native/src/Dg.Routing/**","native/tests/Dg.Routing.Tests/**","scripts/native-routes.ts"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 35
    name: "cs-completion"
    depends_on: [25]
    files: ["native/src/Dg.Completion/**","native/tests/Dg.Completion.Tests/**","scripts/native-completion.ts"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 36
    name: "cs-ci"
    depends_on: [25]
    files: [".github/workflows/native.yml"]
    agents:
      primary: dg:devops
      confidence: high
      qa: [dg:qa-devops]
  - id: 37
    name: "plugin-cli-bun"
    depends_on: [24,8]
    files: ["pkg/skills-cli/src/plugin/**","pkg/skills-cli/src/commands/plugin.ts","pkg/skills-cli/src/register-all.ts","pkg/skills-cli/src/completion/tree.json","pkg/skills-cli/__tests__/plugin-*.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:security]
  - id: 38
    name: "bun-transport-http"
    depends_on: [24]
    files: ["pkg/common/src/plugins/transport/http.ts","pkg/common/__tests__/plugins-transport-http.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 39
    name: "bun-transport-ipc"
    depends_on: [24]
    files: ["pkg/common/src/plugins/transport/ipc.ts","pkg/common/src/plugins/transport/framing.ts","pkg/common/__tests__/plugins-transport-ipc.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 40
    name: "hook-plugins-bun"
    depends_on: [24,7,38,39]
    files: ["pkg/skills-cli/src/hooks/plugins.ts","pkg/skills-cli/src/hooks/external.ts","pkg/skills-cli/src/hooks/run.ts","pkg/skills-cli/__tests__/hooks-plugins.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:security]
  - id: 41
    name: "job-plugins-bun"
    depends_on: [24]
    files: ["pkg/dg-daemon/src/jobs/plugin-manifest.ts","pkg/dg-daemon/src/jobs/sources.ts","pkg/dg-daemon/__tests__/jobs/plugin-manifest.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 42
    name: "cs-plugin-contract"
    depends_on: [25,24]
    files: ["native/src/Dg.Core/Plugins/Contract/**","native/src/Dg.Core/Plugins/Manifest/**","native/tests/Dg.Core.Tests/Plugins/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 43
    name: "ext-verbs-wire"
    depends_on: [16,17,18,19,20,21,22]
    files: ["pkg/common/src/pw-ext-format.ts","pkg/common/__tests__/pw-ext-format.spec.ts","pkg/skills-cli/src/pw/ext.ts","pkg/skills-cli/__tests__/pw-ext.spec.ts","pkg/extension/lib/background/pw-ext.ts","pkg/extension/lib/background/relay-dispatch.ts","pkg/extension/__tests__/pw-ext.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 44
    name: "cs-hooks-pr"
    depends_on: [33,32]
    files: ["native/src/Dg.Hooks/Defs/Pr/**","native/tests/Dg.Hooks.Tests/Pr/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 45
    name: "cs-hooks-text"
    depends_on: [33,32]
    files: ["native/src/Dg.Hooks/Defs/Text/**","native/tests/Dg.Hooks.Tests/Text/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 46
    name: "cs-hooks-repo"
    depends_on: [33,32]
    files: ["native/src/Dg.Hooks/Defs/Repo/**","native/tests/Dg.Hooks.Tests/Repo/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 47
    name: "cs-config-group"
    depends_on: [32]
    files: ["native/src/Dg.Config/**","native/tests/Dg.Config.Tests/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 48
    name: "cs-transport-http"
    depends_on: [42]
    files: ["native/src/Dg.Core/Transport/Http/**","native/tests/Dg.Core.Tests/Transport/Http/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 49
    name: "cs-transport-ipc"
    depends_on: [42]
    files: ["native/src/Dg.Core/Transport/Ipc/**","native/src/Dg.Core/Transport/Framing/**","native/src/Dg.Core/Transport/Pool/**","native/tests/Dg.Core.Tests/Transport/Ipc/**","native/tests/Dg.Core.Tests/Transport/Framing/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 50
    name: "cs-transport-tcp"
    depends_on: [49]
    files: ["native/src/Dg.Core/Transport/Tcp/**","native/tests/Dg.Core.Tests/Transport/Tcp/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 51
    name: "cs-transport-udp"
    depends_on: [42]
    files: ["native/src/Dg.Core/Transport/Udp/**","native/tests/Dg.Core.Tests/Transport/Udp/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 52
    name: "cs-transport-msgpack"
    depends_on: [49]
    files: ["native/src/Dg.Core/Transport/Encoding/MessagePack/**","native/tests/Dg.Core.Tests/Transport/Encoding/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 53
    name: "cs-native-gates"
    depends_on: [36]
    files: [".github/workflows/native.yml","native/tools/Dg.SizeReport/**","native/budgets/**","scripts/native-ram-budget.ts"]
    agents:
      primary: dg:devops
      confidence: high
      qa: [dg:qa-devops]
  - id: 54
    name: "cs-plugin-bench"
    depends_on: [48,49]
    files: ["native/bench/Dg.Bench/**",".github/workflows/native-bench.yml"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 55
    name: "cs-plugins-runtime"
    depends_on: [48,49,50,51,32]
    files: ["native/src/Dg.Core/Plugins/Runtime/**","native/tests/Dg.Core.Tests/Plugins/Runtime/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:qa-code]
  - id: 56
    name: "cs-plugins-group"
    depends_on: [55,32]
    files: ["native/src/Dg.Plugins/**","native/tests/Dg.Plugins.Tests/**"]
    agents:
      primary: dg:csharp
      confidence: high
      qa: [dg:security, dg:qa-code]
  - id: 57
    name: "companion-release"
    depends_on: [29,31]
    files: [".github/workflows/release.yml","pkg/skills-cli/src/install/companion.ts","pkg/skills-cli/src/install/compiled.ts","pkg/skills-cli/__tests__/install-companion.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-devops, dg:security]
  - id: 58
    name: "browser-docs-skills"
    depends_on: [43]
    files: ["docs/pw.md","docs/browser.md","docs/config.md","docs/demo-and-proto.md","docs/verify.md","plugins/dg/skills/pw/**","plugins/dg/skills/verify/**","plugins/dg/skills/demo/**","plugins/dg/skills/proto/**","plugins/dg/skills/test-live/**"]
    agents:
      primary: dg:lore
      confidence: high
  - id: 59
    name: "cs-cli-compose"
    depends_on: [34,35,36,44,45,46,47,56,23]
    files: ["native/src/Dg.Cli/**","native/tests/Dg.Parity.Tests/**"]
    agents:
      primary: dg:csharp
      confidence: high
      effort: xhigh
      qa: [dg:qa-perf, dg:qa-code]
  - id: 60
    name: "skill-size-cap"
    depends_on: [3,11,12,13,14,15,58]
    files: ["pkg/skills-test/__tests__/skill-size-cap.spec.ts","scripts/skill-token-budgets.json"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 61
    name: "two-binary-install"
    depends_on: [59,57,10]
    files: [".github/workflows/release.yml","pkg/skills-cli/src/install/front-door.ts","pkg/skills-cli/src/install/compiled.ts","pkg/skills-cli/bootstrap.sh","pkg/skills-cli/bootstrap.ps1","pkg/skills-cli/__tests__/install-front-door.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      effort: xhigh
      qa: [dg:qa-devops, dg:security]
  - id: 62
    name: "lean-docs"
    depends_on: [61,26]
    files: ["docs/install.md","docs/DEVELOPER.md","docs/AGENT-INSTALL.md","README.md","CHANGELOG.md"]
    agents:
      primary: dg:lore
      confidence: high
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# Lean dg CLI: latency, binary and download size, skill token weight, and the C# front door

## Purpose
Make the dg CLI fast and lean: hot-path latency, binary and download size, and skill token weight, each held by CI gates. Start the staged C# NativeAOT port (Dante's R1 choice) with stage 1: a C# front door that runs hooks, --version, completion, config and routing natively and execs the Bun dg for the rest. Slices are small and file-disjoint so each wave builds in parallel worktrees and all land in one PR.

## Scope
### Included
- Baseline harness and CI gates
- Bundle split, bytecode, companions
- Hook, --version and completion fast paths
- Compressed release assets, delta patches, gzip bootstrap
- Skill diet by group and a size cap
- Browser auto mode, ext gap verbs (TypeScript and Bun), agent window
- Relay protocol contract with shared fixtures
- C# stage 1 front door (on by default, DG_FRONT=0 or front.enabled = false opts out, Bun fallback) with parity tests, 6-runner NativeAOT CI, two-binary install
### Excluded
- C# stages 2+ (phone listener, daemon, command groups): later bundles
- Any change to the extension toolchain; it stays TypeScript and Bun
- UPX, the 6.x shared runtime
- Snowflake and Playwright off Bun

### Slice 1 — baseline-latency

#### Engineering
- [ ] Move every RSS and latency budget out of ram-budget.ts into scripts/ram-budgets.json
- [ ] Add idle RSS after N minutes and a growth check (leak) for the daemon, phone listener and plugin host; gate on Linux (/proc), report on Windows (GetProcessMemoryInfo) and macOS (rusage)
- [ ] Add latency cases with p50, p90 and msBudget to scripts/ram-budget.ts for dg --version, dg completion, dg agent phone status and dg stat

#### Testing Criteria
##### Contracts
- [ ] Contract: every new case reports { peak, ms, p95 } like the existing hook cases
- [ ] Unit test: a case over msBudget is marked SLOW and fails --gate

#### Acceptance Criteria
- [ ] Given a compiled dg, when ram-budget.ts --gate runs, then the new cases pass at the 2026-11-24 baseline plus 5 percent

### Slice 2 — baseline-size

#### Engineering
- [ ] scripts/lean-size.ts: raw, gzip -9, zstd -19 --long=27 size per compiled target, and the zstd --patch-from delta against the previous release

#### Testing Criteria
##### Contracts
- [ ] Contract: lean-budgets.json is { size: { [target]: { rawBytes, zstdBytes, patchBytes } } }; --gate exits 1 on any overrun

#### Acceptance Criteria
- [ ] Given a 2 MB larger binary, when lean-size.ts --gate runs, then it fails with the target and both numbers

### Slice 3 — baseline-skill-tokens

#### Engineering
- [ ] scripts/skill-tokens.ts: bytes/4 tokens per SKILL.md, per flow (spec-plan, spec-exec, phone, stat, thrash, verify, review-loop, jot) and for all descriptions

#### Testing Criteria
##### Contracts
- [ ] Contract: skill-token-budgets.json is { perFlow: { [flow]: number }, descriptions: number }; --gate exits 1 on overrun
- [ ] Unit test: every flow lists only files that exist

#### Acceptance Criteria
- [ ] Given the current skills, when skill-tokens.ts --gate runs, then it passes at baseline

### Slice 4 — budget-ratchet

#### Engineering
- [ ] A ratchet over every versioned budget JSON (ram-budgets.json, lean-budgets.json, skill-token-budgets.json, native budgets, bench budgets): a measurement above budget fails unless the PR body has a reviewed Budget-Increase: <budget> <old> -> <new> because <reason> line; slack above the threshold (R18) fails until the PR lowers the budget
- [ ] budgets.yml runs on every PR and posts one diff table comment (budgets, measurements, module growth from the size reports)

#### Testing Criteria
##### Contracts
- [ ] Contract: ratchet({ budgets, measured, prBody, slackPct }) returns { failures, warnings, lowered } and is pure
- [ ] Unit test: a lower measurement with slack over the threshold fails; a raise with a valid Budget-Increase line passes

#### Acceptance Criteria
- [ ] Given a PR that saves 3 MB, when budgets.yml runs, then it fails until the size budget is lowered in the same PR

### Slice 5 — build-split

#### Engineering
- [ ] Split pkg/launcher/build.ts into build/options.ts, build/compile.ts, build/report.ts and build/companions.ts with no behavior change, so later slices own one module each

#### Testing Criteria
##### Contracts
- [ ] Contract: buildCompiled and buildLauncher keep their signatures and outputs
- [ ] Regression: build.spec.ts and a compiled linux-x64 build stay green

#### Acceptance Criteria
- [ ] Given the split, when the compiled dg is built, then its size is within 1 KB of the build before

### Slice 6 — version-path

#### Engineering
- [ ] Answer --version before the dg-paths import (4.5 ms)
- [ ] Skip the JIT re-exec (5 ms) for hooks run when its RSS stays in budget

#### Testing Criteria
##### Contracts
- [ ] Contract: dispatch(['--version']) imports no chunk beyond the entry

#### Acceptance Criteria
- [ ] Given compiled dg, when --version runs 50 times, then p50 is at most 9 ms (baseline 19.3)

### Slice 7 — hooks-fast-route

#### Engineering
- [ ] fastRoute(argv) for hooks run imports only hooks/cli and skips the flat route tree (about 11 ms)
- [ ] Read hook stdin with Bun.stdin.text() (node:stream init about 5 ms)

#### Testing Criteria
##### Contracts
- [ ] Contract: fastRoute(argv) returns 'hooks' | 'completion' | 'version' | undefined and is pure
- [ ] Parity test: every hook id gives the same output and exit code through the fast route and the full tree

#### Acceptance Criteria
- [ ] Given compiled dg after dispatch-wire, when hooks run pr-confirm runs 50 times, then p50 is at most 20 ms (at most 13 with bytecode)

### Slice 8 — completion-fast-path

#### Engineering
- [ ] Answer completion requests from tree.json without building the command tree

#### Testing Criteria
##### Contracts
- [ ] Contract: completeFast(words) returns the same candidates as the full completion for every fixture

#### Acceptance Criteria
- [ ] Given compiled dg after dispatch-wire, when a completion runs 50 times, then p50 is at most 9 ms (baseline 17.8)

### Slice 9 — release-compress

#### Engineering
- [ ] Publish dg-<key>.zst and dg-<key>.gz next to the raw asset for all 8 targets (Linux, Windows, macOS); SHA256SUMS covers all
- [ ] dg update downloads .zst and decompresses with Bun.zstdDecompressSync; raw stays as fallback

#### Testing Criteria
##### Contracts
- [ ] Contract: pickProgram(releases, version, key, { compressed }) returns { url, assetName, encoding: 'zstd' | 'gzip' | 'raw', sumsUrl }
- [ ] Unit test: a missing .zst falls back to raw

#### Acceptance Criteria
- [ ] Given a release, when dg update runs, then it downloads about 31.8 MB instead of 92.9 MB on linux-x64

### Slice 10 — bootstrap-gz

#### Engineering
- [ ] bootstrap.sh reads dg-<key>.gz with gzip; bootstrap.ps1 reads it with System.IO.Compression.GZipStream; both fall back to raw

#### Testing Criteria
##### Contracts
- [ ] Contract: asset selection picks .gz, else raw, on every platform key including darwin

#### Acceptance Criteria
- [ ] Given a new machine, when bootstrap runs, then it downloads about 39.6 MB on linux-x64 and installs a working dg

### Slice 11 — skill-diet-phone

#### Engineering
- [ ] Diet for phone: move rare detail into references/, cut repeated text, each SKILL.md at most 8 KB, each description at most 400 characters

#### Testing Criteria
##### Contracts
- [ ] Regression: every pkg/skills-test skill guard for these skills stays green

#### Acceptance Criteria
- [ ] Given skill-tokens.ts, when it runs, then every SKILL.md in this group is at most 8 KB

### Slice 12 — skill-diet-status

#### Engineering
- [ ] Diet for stat, jobs, bg, jot, overwatch: move rare detail into references/, cut repeated text, each SKILL.md at most 8 KB, each description at most 400 characters

#### Testing Criteria
##### Contracts
- [ ] Regression: every pkg/skills-test skill guard for these skills stays green

#### Acceptance Criteria
- [ ] Given skill-tokens.ts, when it runs, then every SKILL.md in this group is at most 8 KB

### Slice 13 — skill-diet-review

#### Engineering
- [ ] Diet for thrash, review-loop, address, polish, sniff, land: move rare detail into references/, cut repeated text, each SKILL.md at most 8 KB, each description at most 400 characters

#### Testing Criteria
##### Contracts
- [ ] Regression: every pkg/skills-test skill guard for these skills stays green

#### Acceptance Criteria
- [ ] Given skill-tokens.ts, when it runs, then every SKILL.md in this group is at most 8 KB

### Slice 14 — skill-diet-planning

#### Engineering
- [ ] Diet for spec, sdlc, kick, pickup, assign, grill-me, prd, wayfinder, walk, refactor, chain: move rare detail into references/, cut repeated text, each SKILL.md at most 8 KB, each description at most 400 characters

#### Testing Criteria
##### Contracts
- [ ] Regression: every pkg/skills-test skill guard for these skills stays green

#### Acceptance Criteria
- [ ] Given skill-tokens.ts, when it runs, then every SKILL.md in this group is at most 8 KB

### Slice 15 — skill-diet-rest

#### Engineering
- [ ] Diet for adr, agent-seed, bot-commit-email, catchup, chat, channel-review, clipboard-img, cls, db, deps-upgrade, doctor, eli5, erd, file, find-work, google-sms-cleanup, hook-comment-disable, hooks, hunt, inbox-cleanup, meaningful, monolith, nope, proxy, pushup, rename-session, spring-break, standard-test, stash, teach, ticket, update, what-changed, worktree: move rare detail into references/, cut repeated text, each SKILL.md at most 8 KB, each description at most 400 characters

#### Testing Criteria
##### Contracts
- [ ] Regression: every pkg/skills-test skill guard for these skills stays green

#### Acceptance Criteria
- [ ] Given skill-tokens.ts, when it runs, then every SKILL.md in this group is at most 8 KB

### Slice 16 — browser-mode-flag

#### Engineering
- [ ] resolveBrowserMode: --local or --ext, else DG_BROWSER, else browser.mode in config.toml (ext, local, auto), else auto: ext when the extension is paired and running and the verb is ext-capable, else local
- [ ] Add browser.mode to DG_TOML_DEFAULTS with the same validation and error text as other keys
- [ ] Add front.enabled (boolean, default true) to DG_TOML_DEFAULTS for the R13 front-door opt-out, with the same validation and error text

#### Testing Criteria
##### Contracts
- [ ] Contract: resolveBrowserMode({ flags, env, config, extConnected, verb }) returns { mode: 'ext' | 'local', reason } and is pure
- [ ] Unit test: --local always wins; a local-only verb never resolves to ext

#### Acceptance Criteria
- [ ] Given DG_BROWSER=local, when dg pw click runs, then Playwright handles it

### Slice 17 — ext-verbs-navigation

#### Engineering
- [ ] TypeScript and Bun only. Add the go-back, go-forward, reload verbs as a self-contained module on each side (extension handler, shared request shape and validator, CLI client); slice ext-verbs-wire registers them

#### Testing Criteria
##### Contracts
- [ ] Contract: the shared module exports VERBS, validate(request) and the request and result types for go-back, go-forward, reload
- [ ] Unit test: each verb refuses a tab outside the agent tab group

#### Acceptance Criteria
- [ ] Given auto mode and a paired extension, when a go-back, go-forward, reload verb runs after ext-verbs-wire, then Playwright does not start

### Slice 18 — ext-verbs-pointer

#### Engineering
- [ ] TypeScript and Bun only. Add the hover, dblclick, drag, mousedown, mouseup, mousemove, mousewheel verbs as a self-contained module on each side (extension handler, shared request shape and validator, CLI client); slice ext-verbs-wire registers them

#### Testing Criteria
##### Contracts
- [ ] Contract: the shared module exports VERBS, validate(request) and the request and result types for hover, dblclick, drag, mousedown, mouseup, mousemove, mousewheel
- [ ] Unit test: each verb refuses a tab outside the agent tab group

#### Acceptance Criteria
- [ ] Given auto mode and a paired extension, when a hover, dblclick, drag, mousedown, mouseup, mousemove, mousewheel verb runs after ext-verbs-wire, then Playwright does not start

### Slice 19 — ext-verbs-input

#### Engineering
- [ ] TypeScript and Bun only. Add the check, uncheck, type, keydown, keyup verbs as a self-contained module on each side (extension handler, shared request shape and validator, CLI client); slice ext-verbs-wire registers them

#### Testing Criteria
##### Contracts
- [ ] Contract: the shared module exports VERBS, validate(request) and the request and result types for check, uncheck, type, keydown, keyup
- [ ] Unit test: each verb refuses a tab outside the agent tab group

#### Acceptance Criteria
- [ ] Given auto mode and a paired extension, when a check, uncheck, type, keydown, keyup verb runs after ext-verbs-wire, then Playwright does not start

### Slice 20 — ext-verbs-page

#### Engineering
- [ ] TypeScript and Bun only. Add the eval, tab-select, resize verbs as a self-contained module on each side (extension handler, shared request shape and validator, CLI client); slice ext-verbs-wire registers them

#### Testing Criteria
##### Contracts
- [ ] Contract: the shared module exports VERBS, validate(request) and the request and result types for eval, tab-select, resize
- [ ] Unit test: each verb refuses a tab outside the agent tab group

#### Acceptance Criteria
- [ ] Given auto mode and a paired extension, when a eval, tab-select, resize verb runs after ext-verbs-wire, then Playwright does not start

### Slice 21 — ext-verbs-storage

#### Engineering
- [ ] TypeScript and Bun only. Add the localstorage and sessionstorage set, delete, clear on allowlisted origins verbs as a self-contained module on each side (extension handler, shared request shape and validator, CLI client); slice ext-verbs-wire registers them

#### Testing Criteria
##### Contracts
- [ ] Contract: the shared module exports VERBS, validate(request) and the request and result types for localstorage and sessionstorage set, delete, clear on allowlisted origins
- [ ] Unit test: each verb refuses a tab outside the agent tab group

#### Acceptance Criteria
- [ ] Given auto mode and a paired extension, when a localstorage and sessionstorage set, delete, clear on allowlisted origins verb runs after ext-verbs-wire, then Playwright does not start

### Slice 22 — ext-agent-window

#### Engineering
- [ ] TypeScript and Bun only. A dedicated agent window for ext sessions, and a prompt to allow each new site before the agent navigates there; PHI-flagged sites refuse snapshot and screenshot

#### Testing Criteria
##### Contracts
- [ ] Contract: openAgentWindow(sessionId) returns the window id and reuses it per session
- [ ] Contract: requestSiteAllow(siteKey) resolves 'allow' | 'deny' and stores allow per session

#### Acceptance Criteria
- [ ] Given an ext session, when the agent opens a new site, then the user sees an allow prompt and the page does not load until allowed

### Slice 23 — relay-contract

#### Engineering
- [ ] Write the daemon relay protocol as a contract: message shapes, protocol version field, version negotiation and error frames, from the existing TS validators
- [ ] Add a shared fixture set (valid and invalid frames per message type) that the Bun side tests now and the C# side tests in stage 2

#### Testing Criteria
##### Contracts
- [ ] Contract: every fixture under pkg/common/fixtures/relay/valid passes the TS validator and every one under invalid fails with the documented error

#### Acceptance Criteria
- [ ] Given a frame shape change in TS, when tests run, then the fixture test fails until docs and fixtures change

### Slice 24 — plugin-contract

#### Engineering
- [ ] Define plugin.toml (name, version, kind hook | job | skill, entry builtin id or command and args, capabilities, permissions, sha256 or commit pin, source) transport (ipc default, http, tcp, udp) and endpoint
- [ ] Write the message contract v1 shared by all transports: a protocol version field, hello with capability and encoding negotiation, request ids, /v1/hook/decide, /v1/job/run, /v1/job/status, /v1/skill/describe, /v1/health; frames are a length-prefixed binary header (version, encoding, flags, request id, length) plus a UTF-8 JSON payload, MessagePack optional; size limits, timeouts, latency budgets, per-plugin token auth from the credential store for http and tcp, remote URLs only with remote = true
- [ ] Read [plugins.<name>] (enabled, source, settings) through the existing dg-toml reader; secrets only as credential references
- [ ] Shared fixtures (valid and invalid manifests, JSON messages and binary frames) used by Bun now and C# in cs-plugins-core

#### Testing Criteria
##### Contracts
- [ ] Contract: parseManifest(text, file) returns a PluginManifest or a DgCliError with file:line, key and next step
- [ ] Contract: every fixture under valid parses and every one under invalid fails with the documented error

#### Acceptance Criteria
- [ ] Given a plugin.toml with an unknown kind, when it is parsed, then the error names the line and the allowed kinds

### Slice 25 — cs-scaffold

#### Engineering
- [ ] global.json pins SDK 11.0.100 with rollForward latestFeature; net11.0; default C# version; Nullable, TreatWarningsAsErrors, AOT and trim analyzers on
- [ ] Central package management; every project file for stage 1 created now (Core, Hooks, Config, Completion, Routing, Plugins, Cli and their xUnit v3 tests, Parity tests), so no later slice edits a .csproj or the .slnx
- [ ] Core: ICommand, IPlugin and PluginKind (hook, job, skill), DgError with file:line, key and next step, output helpers; Cli: an empty composition root

#### Testing Criteria
##### Contracts
- [ ] Contract: ICommand { string Name { get; } ValueTask<int> RunAsync(ReadOnlyMemory<string> args, CancellationToken ct); }
- [ ] Gate: dotnet publish -r linux-x64 with PublishAot gives zero IL2xxx or IL3xxx warnings

#### Acceptance Criteria
- [ ] Given a clean clone, when dotnet test native/Dg.slnx runs, then it builds and passes

### Slice 26 — ci-lean-gates

#### Engineering
- [ ] Run the RSS, idle, leak, size, download, latency and skill-token gates on every PR in compiled-dg.yml: gate on linux-x64, report on Windows and macOS; feed budget-ratchet
- [ ] docs/lean-baseline.md: the baseline tables and how to re-run

#### Testing Criteria
##### Contracts
- [ ] Regression: compiled-dg.yml passes at baseline

#### Acceptance Criteria
- [ ] Given a PR that breaks a budget, when CI runs, then compiled-dg fails and names the budget

### Slice 27 — build-report

#### Engineering
- [ ] build --report <file> writes bytes per module and package from the Bun metafile
- [ ] scripts/size-diff.ts compares two reports and prints the modules that grew, for the budgets.yml comment

#### Testing Criteria
##### Contracts
- [ ] Contract: report JSON is { totalBytes, packages: { [name]: bytes } }; @aws-sdk, @smithy and @aws-crypto are one row

#### Acceptance Criteria
- [ ] Given a build, when --report runs, then playwright-core is the top row

### Slice 28 — build-bytecode

#### Engineering
- [ ] Turn on bytecode for compiled targets (R2 accepted); keep splitting on

#### Testing Criteria
##### Contracts
- [ ] Unit test: compile options include bytecode and splitting for every target

#### Acceptance Criteria
- [ ] Given the bytecode build, when hooks run pr-confirm runs 50 times, then p50 is at most 13 ms

### Slice 29 — build-companions

#### Engineering
- [ ] Emit the pw chunk and the db chunk as companion bundles dg-pw-<ver>.tar.zst and dg-db-<ver>.tar.zst outside the compiled binary (R3 accepted); loadCompanion(name) imports them from the dg data dir

#### Testing Criteria
##### Contracts
- [ ] Contract: loadCompanion('pw' | 'db') returns the module or throws CompanionMissing with the download command

#### Acceptance Criteria
- [ ] Given the build, when the compiled dg is measured, then it is about 7.5 MB smaller raw

### Slice 30 — dispatch-wire

#### Engineering
- [ ] Call fastRoute and completeFast from dispatch before the full program loads

#### Testing Criteria
##### Contracts
- [ ] Unit test: hooks, completion and --version never import the flat route tree

#### Acceptance Criteria
- [ ] Given compiled dg, when the ram-budget latency cases run, then they meet the new budgets

### Slice 31 — delta-patches

#### Engineering
- [ ] release-patches.yml builds dg-<key>-from-<prev>.zpatch (zstd --patch-from, previous release only) for all 8 targets and a PATCHSUMS file
- [ ] dg update applies the patch, checks the raw sha256, else falls back to .zst

#### Testing Criteria
##### Contracts
- [ ] Contract: applyPatch(oldBytes, patchBytes, expectedSha256) returns new bytes or throws PatchMismatch
- [ ] Unit test: a corrupt patch falls back to the full .zst

#### Acceptance Criteria
- [ ] Given the previous release installed, when dg update runs, then it downloads about 5 MB

### Slice 32 — cs-core-config

#### Engineering
- [ ] Paths per ADR 0054: XDG_CONFIG_HOME/dg/config.toml, <DG_HOME>/config/config.toml when DG_HOME is set
- [ ] An AOT-safe TOML configuration provider over Tomlyn source-generated models feeding IOptions through the binding source generator; precedence flag > documented DG_* env > TOML > default; no JSON, appsettings, launchSettings or .env sources
- [ ] Secrets only through {credential = "..."} references resolved from the credential store

#### Testing Criteria
##### Contracts
- [ ] Contract: DgConfig.Load(env) returns a readonly record or a DgError with file:line, key and next step, matching the Bun text
- [ ] Parity test: the shared config fixtures give the same values and error text in Bun and C#

#### Acceptance Criteria
- [ ] Given a config.toml with a bad key, when C# and Bun load it, then both print the same error

### Slice 33 — cs-hooks-engine

#### Engineering
- [ ] Hook stdin parsed with Utf8JsonReader into a readonly record struct; FrozenDictionary of hook id to IHook; AddHooks() calls AddPrHooks, AddTextHooks and AddRepoHooks (stub Registration.cs per group)

#### Testing Criteria
##### Contracts
- [ ] Contract: IHook { string Id { get; } ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct); }
- [ ] Contract: HookEvent.Parse(ReadOnlySpan<byte>) handles every ram-budget hook fixture

#### Acceptance Criteria
- [ ] Given an unknown hook id, when the engine runs, then it exits 0 and prints nothing, like Bun

### Slice 34 — cs-routing-version

#### Engineering
- [ ] --version and the route table (FrozenDictionary from the flat routes, generated at build time by scripts/native-routes.ts, not committed); exec the Bun dg-core with argv, env, stdin and exit code unchanged

#### Testing Criteria
##### Contracts
- [ ] Contract: Route.Resolve(ReadOnlySpan<string> argv) returns Native(ICommand) | Core(string[] argv)
- [ ] Parity test: every Bun flat route resolves to the same target

#### Acceptance Criteria
- [ ] Given dg spec validate, when the front door runs, then dg-core handles it with the same output

### Slice 35 — cs-completion

#### Engineering
- [ ] Completion from the Bun completion trees (copied at build time by scripts/native-completion.ts)

#### Testing Criteria
##### Contracts
- [ ] Parity test: every completion fixture gives the same candidates as Bun

#### Acceptance Criteria
- [ ] Given a partial word, when completion runs, then p50 is at most 3 ms

### Slice 36 — cs-ci

#### Engineering
- [ ] NativeAOT build and test on 6 runners: ubuntu x64 and arm64, windows x64 and arm64, macos-15-intel and macos-15; AOT and trim warnings as errors; size, RSS and latency gates for the front door

#### Testing Criteria
##### Contracts
- [ ] Regression: native.yml green on all 6 runners

#### Acceptance Criteria
- [ ] Given an AOT warning, when native.yml runs, then the build fails

### Slice 37 — plugin-cli-bun

#### Engineering
- [ ] dg plugin list, add, remove, enable, disable, update, verify; add takes a git url or path, pins by commit or sha256, installs into the plugin folder, registers skill bundles with the Claude and Codex hosts as today, and marks imported skill text untrusted until approved; any change asks for approval again
- [ ] Regenerate the completion tree

#### Testing Criteria
##### Contracts
- [ ] Contract: addPlugin({ source, pin }) returns { name, kind, pin, approved: false } and writes nothing outside the plugin folder and [plugins.<name>]
- [ ] Unit test: a changed sha256 sets approved false and disables the plugin until verify --approve

#### Acceptance Criteria
- [ ] Given dg plugin add <git url>, when the repo ships a skill plugin, then the skill is installed, pinned and not loaded until approved

### Slice 38 — bun-transport-http

#### Engineering
- [ ] HTTP transport for the Bun dg: keep-alive client, /v1 routes, bearer token from the credential store, loopback only unless remote = true, size limit and timeout

#### Testing Criteria
##### Contracts
- [ ] Contract: httpTransport(manifest).request(message, { timeoutMs }) returns a contract Response or a typed timeout or auth error
- [ ] Unit test: a remote URL without remote = true is refused; the token never appears in logs or errors

#### Acceptance Criteria
- [ ] Given a local HTTP plugin, when dg sends a hook decide, then the fixtures round-trip

### Slice 39 — bun-transport-ipc

#### Engineering
- [ ] IPC transport for the Bun dg (default for local plugins): Unix domain socket with 0600 permissions on Linux and macOS, named pipe with a user-only ACL on Windows, length-prefixed frames, one warm connection per plugin with request ids

#### Testing Criteria
##### Contracts
- [ ] Contract: frame encode and decode match every binary frame fixture byte for byte
- [ ] Unit test: a socket file with wider permissions than 0600 is refused

#### Acceptance Criteria
- [ ] Given a local IPC plugin, when dg sends a hook decide, then the fixtures round-trip

### Slice 40 — hook-plugins-bun

#### Engineering
- [ ] Today hook ids become built-in hook plugins; external hook plugins get a /v1/hook/decide request over IPC (default) or HTTP under a timeout (default 2 s) and a latency budget; an already-running plugin is never spawned per call; built-ins stay in process

#### Testing Criteria
##### Contracts
- [ ] Contract: runExternalHook(manifest, event, { timeoutMs }) returns { decision, latencyMs } or a timeout result that never blocks the tool call
- [ ] Unit test: a disabled or unapproved external hook never spawns

#### Acceptance Criteria
- [ ] Given an external hook plugin, when it times out, then dg prints one line and the tool call goes on

### Slice 41 — job-plugins-bun

#### Engineering
- [ ] dg job add <git url|path> reads a plugin.toml of kind job when present (ADR 0049 argv model unchanged); a repo without one keeps working

#### Testing Criteria
##### Contracts
- [ ] Contract: jobFromManifest(manifest) returns the same JobDeclaration shape as today

#### Acceptance Criteria
- [ ] Given a repo with a job plugin.toml, when dg job add runs, then the job stores the manifest argv and pin

### Slice 42 — cs-plugin-contract

#### Engineering
- [ ] Contract messages as records with a source-generated JsonSerializerContext; manifest parse; the frame header as a readonly record struct parsed from ReadOnlySpan<byte>

#### Testing Criteria
##### Contracts
- [ ] Parity test: every shared plugin fixture (manifest, message, frame) parses and serializes the same as Bun

#### Acceptance Criteria
- [ ] Given the fixtures, when C# serializes a response, then the bytes equal the fixture

### Slice 43 — ext-verbs-wire

#### Engineering
- [ ] Register the verb modules in the verb lists, the CLI and the extension dispatcher; turn on the agent window and allow prompt for ext sessions

#### Testing Criteria
##### Contracts
- [ ] Contract: PW_EXT_READ_VERBS and PW_EXT_WRITE_VERBS grow only by the new verbs

#### Acceptance Criteria
- [ ] Given auto mode, when open, click, fill, back, reload, hover and eval run, then none starts Playwright

### Slice 44 — cs-hooks-pr

#### Engineering
- [ ] pr-confirm, pr-prose and strip-ai-coauthors in C# with [GeneratedRegex] and SearchValues

#### Testing Criteria
##### Contracts
- [ ] Parity test: same output and exit code as Bun for every fixture

#### Acceptance Criteria
- [ ] Given gh pr create, when pr-confirm runs, then p50 is at most 3 ms

### Slice 45 — cs-hooks-text

#### Engineering
- [ ] spelling and format in C#; format execs the same formatter as Bun

#### Testing Criteria
##### Contracts
- [ ] Parity test: same output and exit code as Bun for every fixture

#### Acceptance Criteria
- [ ] Given an Edit event, when spelling runs, then p50 is at most 4 ms

### Slice 46 — cs-hooks-repo

#### Engineering
- [ ] spec-plan-lint and daily-prune in C#; git through Process (no LibGit2Sharp)

#### Testing Criteria
##### Contracts
- [ ] Parity test: same output and exit code as Bun for every fixture

#### Acceptance Criteria
- [ ] Given a SessionStart event, when daily-prune runs, then it prunes the same paths as Bun

### Slice 47 — cs-config-group

#### Engineering
- [ ] dg config get, set, list and doctor in C# over Core config, writing TOML with the same layout as Bun

#### Testing Criteria
##### Contracts
- [ ] Parity test: same output for every config fixture

#### Acceptance Criteria
- [ ] Given dg config get browser.mode, when C# runs it, then the output equals Bun

### Slice 48 — cs-transport-http

#### Engineering
- [ ] HttpTransport: one SocketsHttpHandler per plugin with keep-alive, source-generated JSON, bearer token from the credential store, loopback only unless remote = true, size limit, timeout; AddHttpTransport()

#### Testing Criteria
##### Contracts
- [ ] Contract: IPluginTransport.SendAsync(ReadOnlyMemory<byte> frame, CancellationToken ct) returns ValueTask<PluginResponse>
- [ ] Unit test: no secret in URLs or logs

#### Acceptance Criteria
- [ ] Given a keep-alive HTTP plugin, when 300 calls run, then p50 is at most 0.1 ms (measured 0.047)

### Slice 49 — cs-transport-ipc

#### Engineering
- [ ] Default transport. UnixDomainSocketEndPoint (0600) on Linux and macOS, NamedPipeClientStream with a user-only ACL on Windows; System.IO.Pipelines framing with PipeReader and PipeWriter, header and payload in one write, ArrayPool buffers, Utf8JsonReader over ReadOnlySequence; a connection pool with request ids so one warm connection serves many calls; AddIpcTransport()

#### Testing Criteria
##### Contracts
- [ ] Contract: FrameReader.TryRead(ref ReadOnlySequence<byte>, out Frame) is allocation-free on the hot path (checked with GC.GetAllocatedBytesForCurrentThread)
- [ ] Unit test: oversize frames are refused before the payload is read

#### Acceptance Criteria
- [ ] Given a warm IPC plugin, when 300 calls run, then p50 is at most 0.03 ms (measured 0.010)

### Slice 50 — cs-transport-tcp

#### Engineering
- [ ] TcpTransport over the IPC framing: NoDelay on both ends (a two-write frame without it measured 41 ms from Nagle and delayed ACK), loopback only unless remote = true, token auth in hello; AddTcpTransport()

#### Testing Criteria
##### Contracts
- [ ] Unit test: the hello without a valid token closes the connection

#### Acceptance Criteria
- [ ] Given a warm TCP plugin, when 300 calls run, then p50 is at most 0.05 ms (measured 0.022)

### Slice 51 — cs-transport-udp

#### Engineering
- [ ] UdpTransport for fire-and-forget events only (job progress, notifications, telemetry): batched, datagrams at most 1200 bytes, loss accepted, never used for hook decisions or any request and response; AddUdpTransport()

#### Testing Criteria
##### Contracts
- [ ] Contract: IEventSink.Post(in PluginEvent) never blocks and drops when the batch is full
- [ ] Unit test: a manifest with transport = udp and kind hook is refused

#### Acceptance Criteria
- [ ] Given 10k events, when they post, then the caller never waits on the network

### Slice 52 — cs-transport-msgpack

#### Engineering
- [ ] Optional MessagePack encoding (MessagePack-CSharp 3.1.12 source-generated resolver, AOT-safe) negotiated in hello for hot plugins; JSON stays the default

#### Testing Criteria
##### Contracts
- [ ] Parity test: every message fixture round-trips JSON to MessagePack to JSON unchanged

#### Acceptance Criteria
- [ ] Given a plugin that offers msgpack, when hello runs, then both sides agree on msgpack

### Slice 53 — cs-native-gates

#### Engineering
- [ ] Size attribution: IlcGenerateMstatFile plus Dg.SizeReport (System.Reflection.Metadata, sizoscope-style) per assembly and namespace; budgets per RID for raw and zstd size
- [ ] scripts/native-ram-budget.ts: peak RSS and p50 for every front-door case, idle and growth for the plugin host; gate on Linux, report on Windows and macOS
- [ ] Keep the size levers on and checked: InvariantGlobalization, UseSystemResourceKeys, OptimizationPreference=Size, StackTraceSupport=false, EventSourceSupport=false, DebuggerSupport=false, stripped symbols shipped as a separate asset

#### Testing Criteria
##### Contracts
- [ ] Contract: Dg.SizeReport --mstat <file> --json prints { totalBytes, assemblies: { [name]: bytes }, namespaces: { [name]: bytes } }
- [ ] Gate: native budgets in native/budgets/*.json through budget-ratchet

#### Acceptance Criteria
- [ ] Given a new package that adds 500 KB, when native.yml runs, then the PR comment names the package and the ratchet fails without a Budget-Increase line

### Slice 54 — cs-plugin-bench

#### Engineering
- [ ] A NativeAOT bench harness (BenchmarkDotNet does not run under NativeAOT) for round-trip p50 and p99: built-in, IPC direct, IPC through a broker, TCP, HTTP keep-alive, HTTP and IPC from a fresh process, JSON and MessagePack; gates in native-bench.yml

#### Testing Criteria
##### Contracts
- [ ] Gate: warm IPC p50 at most 0.03 ms, warm HTTP p50 at most 0.1 ms, fresh-process IPC hook at most 3 ms, fresh-process HTTP hook at most 4 ms on the CI runner, set from the first CI run plus 20 percent

#### Acceptance Criteria
- [ ] Given a regression in framing, when native-bench runs, then the gate fails with the transport and both numbers

### Slice 55 — cs-plugins-runtime

#### Engineering
- [ ] Select the transport from the manifest through DI keyed registrations; health check, timeouts, latency budget; built-in plugins resolve in process with no transport

#### Testing Criteria
##### Contracts
- [ ] Contract: IPluginHost.InvokeAsync(name, message, ct) returns ValueTask<PluginResponse> and never spawns a process for a running plugin

#### Acceptance Criteria
- [ ] Given a disabled or unapproved plugin, when it is invoked, then nothing connects

### Slice 56 — cs-plugins-group

#### Engineering
- [ ] dg plugin list, enable, disable and verify in C# (AddPlugins()); add, remove and update route to dg-core until a later stage

#### Testing Criteria
##### Contracts
- [ ] Parity test: list and verify output equal Bun for every fixture

#### Acceptance Criteria
- [ ] Given an unapproved plugin, when dg plugin verify runs in C#, then it reports the same state as Bun

### Slice 57 — companion-release

#### Engineering
- [ ] Upload companion bundles in release.yml; dg downloads, checks sha256 and unpacks a companion on first pw --local or db snowflake use

#### Testing Criteria
##### Contracts
- [ ] Contract: ensureCompanion(name, version) returns the unpacked path or throws with the download error and the manual command

#### Acceptance Criteria
- [ ] Given a fresh install, when dg pw --local open runs, then it downloads the pw companion once and runs

### Slice 58 — browser-docs-skills

#### Engineering
- [ ] Document auto mode, --ext, --local, DG_BROWSER and browser.mode, the local-only list, the agent window and allow prompt; apply the 8 KB diet to these skills

#### Testing Criteria
##### Contracts
- [ ] Regression: all skill guards pass
- [ ] Unit test: docs/config.md lists browser.mode with ext, local and auto

#### Acceptance Criteria
- [ ] Given docs/pw.md, when a reader looks up a local-only verb, then the table gives the reason

### Slice 59 — cs-cli-compose

#### Engineering
- [ ] Composition root: ServiceCollection with AddHooks, AddConfig, AddCompletion, AddRouting, AddPlugins; ValidateOnBuild off, no open generics, no scanning (container build measured 0.1 ms)
- [ ] Parity suite runs every fixture through the Bun dg and the C# front door
- [ ] Opt-out at run time: DG_FRONT=0 or front.enabled = false in config.toml makes the front door exec dg-core for every command; a missing dg-core prints one error line with the reinstall command

#### Testing Criteria
##### Contracts
- [ ] Parity test: hooks, --version, completion, config and routing fixtures match Bun byte for byte

#### Acceptance Criteria
- [ ] Given the front door, when hooks run pr-confirm runs 50 times, then p50 is at most 3 ms and peak RSS at most 8 MB

### Slice 60 — skill-size-cap

#### Engineering
- [ ] Add the cap test (SKILL.md 8 KB, description 400 characters) and lower the skill-token budgets to the new values

#### Testing Criteria
##### Contracts
- [ ] Contract: the test reads the caps from one constant and lists each file over a cap with its size

#### Acceptance Criteria
- [ ] Given the merged diets, when bun test runs, then the cap test passes and descriptions are at most 2.5k tokens

### Slice 61 — two-binary-install

#### Engineering
- [ ] Release the C# front door dg-front-<rid> (6 RIDs) next to the Bun dg; install puts the Bun binary at dg-core and the front door at dg by default (R13, owner 2026-11-24); DG_FRONT=0 or front.enabled = false in config.toml keeps the Bun-only layout; update and delta patches cover both; uninstall and rollback restore the Bun-only layout
- [ ] Safe fallback: install runs the downloaded front door with --version before it places it; a missing asset, a failed download or a front door that fails to start keeps the Bun binary at dg and prints one line

#### Testing Criteria
##### Contracts
- [ ] Contract: installLayout({ front }) returns { dg, dgCore } paths; front defaults to on; with front off dg is the Bun binary
- [ ] Unit test: the default install (no DG_FRONT, no config key) places the front door at dg and the Bun binary at dg-core
- [ ] Unit test: a front door that fails its --version check falls back to the Bun-only layout
- [ ] Unit test: a failed front-door download leaves the Bun-only layout working

#### Acceptance Criteria
- [ ] Given a default install, when dg update runs, then both binaries update and hooks run through the front door; given DG_FRONT=0, the layout stays Bun-only

### Slice 62 — lean-docs

#### Engineering
- [ ] Document compressed assets, delta updates, companions, the default-on C# front door (opt-out with DG_FRONT=0 or front.enabled = false), the native/ build (dotnet SDK 11) and that Bun stays the dev toolchain for the extension and the sidecar

#### Testing Criteria
##### Contracts
- [ ] Regression: skill-index-docs and doc guards pass

#### Acceptance Criteria
- [ ] Given docs/DEVELOPER.md, when a contributor builds native/, then the steps work on Linux, Windows and macOS

## Measured Baseline (2026-11-24, this machine, linux-x64, warm cache, p50 of 40 runs)

Method and scripts: `$CLAUDE_JOB_DIR/tmp/lean/scripts/` (meta.ts, group.ts, lat.ts, lat2.ts, prof.ts). Slice 1 turns them into committed gates.

### Release assets (v7.0.5, raw, uncompressed today)

| Target | Raw MB | gzip -9 | zstd -19 --long | xz -6 |
| --- | --- | --- | --- | --- |
| linux-x64 / linux-x64-baseline | 92.9 | 39.6 | 31.8 | 30.8 |
| linux-arm64 | 92.8 | - | - | - |
| darwin-arm64 / darwin-x64 | 73.9 / 80.9 | - | - | - |
| windows-x64 / baseline / arm64 | 97.7 / 97.7 / 89.2 | - | - | - |
| compiled Bun hello (floor) | 81.3 | 36.5 | - | 28.5 |
| zstd --patch-from v7.0.5 to a master build | 4.7 | - | - | - |
| dg-lib-7.0.5.tar.gz (6.x-style bundle, still shipped) | 3.0 | - | - | 2.2 |

### Bundle composition (11.33 MB minified JS; 8.86 MB node_modules, 2.47 MB own code; no embedded file assets)

| Rows | KB |
| --- | --- |
| playwright-core (chromium-bidi already external) | 4065 |
| @azure/* (MSAL, identity) | 942 |
| moment-timezone + moment | 801 |
| AWS SDK (@aws-sdk, @smithy, @aws-crypto) | 621 |
| snowflake-sdk | 326 |
| yaml 235, mime-db 137, google-auth-library 111, ajv 105, zod 102 | 690 |
| toml 41 + smol-toml 30 (duplicate parsers) | 71 |
| own: phone 175, pw 125, inbox 117, common 114, embedded agent personas 105, thrash 85, pages chat.js 77 + board.js 38, completion tree 35 | ~870 of 2470 |

Chunks: the pw chunk is 4.06 MB (1.0 MB gz); the db chunk (snowflake, msal, moment-timezone, winston) is 3.5 MB. Import of the pw chunk alone costs 59 ms.

### Startup breakdown

| Step | ms |
| --- | --- |
| /bin/true | 0.3 |
| compiled Bun hello | 2.8-3.8 |
| JSC JIT re-exec (19.3 to 14.2) | 5.1 |
| dg-paths import before the --version check | 4.5 |
| rest of --version (entry, program, loader) | ~6 |
| dg --version total | 19.3 |
| hooks: flat route tree + cli registrations (CPU profile: cli*.js 6.9, flat.js 3.9) | ~11 |
| hooks: node:stream init for stdin | ~5 |
| dg hooks run pr-confirm total | 33.8 (28.2 without re-exec) |
| dg completion --help | 17.8 |
| dg agent phone status / dg stat | 50.6 / 51.3 |
| bytecode build: --version / hooks (no re-exec) | 6.7 / 11.7 |
| bytecode cost | +35.1 MB raw (128.0 MB), zstd 44.4 MB (+12.6) |
| no-split build: --version | 241.7 (splitting is load-bearing) |

Not available: Bun has no flag to drop unused runtime parts; the 81 MB floor is fixed. UPX was not on this machine (not measured).

### Skill tokens per flow (bytes / 4)

| Flow | Files | KB | ~tokens |
| --- | --- | --- | --- |
| every session: skill descriptions | 61 frontmatters | 19.1 | 4.8k |
| spec plan | spec SKILL + plan, grill, decision-blob, 4 templates, assign, grill-me | 57.1 | 14.3k |
| spec execute | spec SKILL + execute + sdlc | 30.8 | 7.7k |
| phone | phone SKILL | 38.0 | 9.5k |
| stat | stat SKILL | 20.8 | 5.2k |
| thrash | thrash SKILL (34.7 KB refs lazy) | 19.2 | 4.8k |
| review-loop + address | 2 SKILL | 16.0 | 4.0k |
| verify | verify SKILL | 15.0 | 3.7k |
| jot | jot SKILL | 5.8 | 1.5k |
| all SKILL.md / all skill .md | 61 / all | 401.9 / 1135.9 | 100k / 284k |

Median SKILL.md is 5.3 KB; 16 skills are over 8 KB.


## Language Decision: staged C# NativeAOT port (option D in C#)

Dante picked option D in C# (R1, 2026-11-24). This bundle builds the Bun trims and stage 1, the C# front door, which ships on by default with an opt-out and a Bun fallback (R13, owner 2026-11-24). Stages 2 and later are separate bundles. Bun stays in the repo as a permanent dev toolchain: the extension, its tests and packaging, and the Bun sidecar until the port finishes.

### Options compared (linux-x64, measured floors)

| Option | dg binary | Download, full / update | Hooks p50 | RAM | Cost | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| today | 92.9 MB | 92.9 raw / 92.9 raw | 33.8 ms | short 20-36, daemon 32-40, listener 43-55 MB | - | - |
| A: Bun + trim | ~120 MB with bytecode, ~-7.5 MB with companions | zstd ~40 / patch ~5 | 12-20 ms | unchanged | 2-3 eng-months | low |
| B: A + native front door | + 2-4 MB | + 1.5 MB | 2-3 ms | hooks ~5 MB | + 1-1.5 eng-months | medium |
| C: B + native daemon and listener | + 3-8 MB | + 3 MB | 2-3 ms | daemon 13-17, listener 12-19 MB (C#) | + 2-3 eng-months | medium-high |
| **D in C# (chosen)** | end state 8-20 MB C# dg; Bun sidecar only on first use | end state 4-8 MB zstd; sidecar about 31 MB zstd + companions, once | 2-3 ms | 4-19 MB per process | 9-13 eng-months over all stages | high, staged |
| E: full port | 8-20 MB | 4-8 MB | 2-3 ms | 4-19 MB | 12-18 eng-months | very high (Snowflake and Playwright have no AOT path) |

Download shrinks only at the final switch, when no common command needs the Bun core. The earlier stages cut latency and RAM.

### C# prototype, measured on this machine (.NET SDK 11.0.100, net11.0, NativeAOT, linux-x64)

Lean settings: InvariantGlobalization, UseSystemResourceKeys, OptimizationPreference=Size, IlcTrimMetadata, workstation non-concurrent GC, no EventSource, no stack-trace data. Sources: `$CLAUDE_JOB_DIR/tmp/lean/cs/`.

| Program | Binary | zstd | p50 / p90 | Peak RSS |
| --- | --- | --- | --- | --- |
| C# hello | 1.05 MB | - | 1.17 / 1.28 ms | 3.7 MB |
| C# hook: Utf8JsonReader, [GeneratedRegex], FrozenDictionary, DI container | 2.30 MB | 0.98 MB | 1.82 / 1.99 ms | 5.0 MB |
| same, no DI | 2.30 MB | - | 1.76 / 2.01 ms | 4.8 MB |
| DI container build (ServiceCollection, ValidateOnBuild off) | - | - | 0.10-0.12 ms | - |
| Bun dg hooks run pr-confirm (today) | 92.9 MB | 31.8 MB | 34.2 / 35.1 ms | 29.5 MB |

DI choice: the full container, with explicit registrations, ValidateOnBuild off, no open generics and no scanning. It costs 0.1 ms, well under the 1-2 ms limit, so hooks need no special container. ILCompiler runtime packs 11.0.0 exist on NuGet for all 6 RIDs (linux-x64, linux-arm64, win-x64, win-arm64, osx-x64, osx-arm64). One build with all candidate libraries is 25 MB, most of it Snowflake.

### .NET library verdicts (AOT probe: one NativeAOT publish that references every library, warnings counted per assembly)

| Library | Version | AOT warnings | Verdict |
| --- | --- | --- | --- |
| Npgsql | 11.0.0 | 0 | use (db Postgres, stage 3) |
| Snowflake.Data | 6.5.0 | 74, plus 34 Google.Apis and 10 Newtonsoft.Json from its dependencies | not AOT-safe; Snowflake stays in the Bun sidecar |
| Microsoft.Identity.Client (MSAL.NET) | 4.92.0 | 0 | use (inbox Outlook, stage 3) |
| Octokit | 14.0.0 (2025-01) | 13 (reflection JSON) | do not use; HttpClient + System.Text.Json source generation |
| LibGit2Sharp | 0.32.0 | 0, but ships native libgit2 per RID | do not use; run git through Process, like the Bun dg |
| YamlDotNet | 18.1.0 | 33 with the reflection builder | use only with Vecc.YamlDotNet.Analyzers.StaticGenerator 18.1.0 |
| Tomlyn (Tomlyn.Signed) | 2.11.1 | 3 with reflection Deserialize | use with its source-generated TomlSerializerContext |
| Markdig | 1.6.0 | 0 | use |
| Microsoft.Data.Sqlite | 11.0.0 | 0 | use (native e_sqlite3 per RID) |
| Microsoft.Extensions.DependencyInjection | 11.0.0 | 0 with TreatWarningsAsErrors | use |
| NBitcoin.Secp256k1 | 4.0.4 (2026-10) | 0 | use for NIP-44 ECDH and Schnorr (stage 2) |
| NNostr.Client | 0.0.55 (pre-1.0) | 0 in the probe | do not depend on it; hand-roll NIP-17, 44 and 59 on NBitcoin.Secp256k1 |
| ChaCha20 for NIP-44 | - | - | .NET has only ChaCha20Poly1305, not raw ChaCha20; hand-roll RFC 8439 ChaCha20 with its test vectors (R14) |
| Microsoft.Playwright | 1.65.1 | - | runs a Node driver; local pw stays in the Bun sidecar |
| System.CommandLine | - | - | not used; a source-built FrozenDictionary router is smaller and faster |

### Stage table (optional later bundles after this one)

| Stage | Contents | Binary / download | Hooks p50 | RAM | Cost |
| --- | --- | --- | --- | --- | --- |
| 0 (this bundle, Bun) | slices for baseline, bundle, fast paths, release, diet, browser, plugins | 92.9 to ~120 MB raw with bytecode, ~-7.5 MB with companions; update ~5 MB patch | 33.8 to 12-13 ms | unchanged | ~6-8 eng-weeks, ~20-28M tokens |
| 1 (this bundle, C#, on by default) | front door: hooks (every id), --version, completion, config, routing, plugins list/enable/disable/verify, plugin transports; execs dg-core for the rest | + 2-4 MB C# (about 1-1.5 MB zstd) | 2-3 ms | hooks 29.5 to ~5 MB | ~4-6 eng-weeks, ~8-12M tokens |
| 2 | phone listener (NIP-17, 44, 59) and daemon on HttpListener, relay contract from relay-contract | + 3-8 MB | - | listener 43-55 to 12-19 MB; daemon 32-40 to 13-17 MB | ~8-12 eng-weeks, ~15-20M tokens |
| 3a | stat, jot, jobs client, worktree, chain, bg, stash (frequent, small) | + 1-2 MB | - | 20-36 to 4-8 MB per command | ~3-4 eng-weeks |
| 3b | spec, adr, assign, monolith, skill | + 1-2 MB | - | same | ~4-6 eng-weeks |
| 3c | thrash, address, provider, deps-upgrade (HttpClient + STJ) | + 2-3 MB | - | same | ~6-8 eng-weeks |
| 3d | install, update, doctor (self-update in C#) | + 1 MB | - | same | ~4-6 eng-weeks |
| 3e | db Postgres (Npgsql), inbox Outlook (MSAL.NET + Graph REST) | + 3-5 MB | - | same | ~8-12 eng-weeks |
| 3f | erd, prototype, verify server, demo server, channel-review | + 2-4 MB | - | same | ~6-10 eng-weeks |
| Switch | Bun core becomes an on-demand sidecar | C# dg 8-20 MB; download 4-8 MB zstd; sidecar about 31 MB zstd once | - | - | ~2 eng-weeks |

Bun sidecar until the end: pw --local (Playwright), Snowflake (Snowflake.Data is not AOT-safe), verify capture and demo recording (Playwright). The extension relay moves to C# in stage 2 through the written relay contract, and the extension itself stays TypeScript and Bun.

### CI build cost (runner minutes per release)

Bun builds all 8 targets on one Linux runner; release.yml already runs smoke tests on ubuntu x64 and arm64, macos-15-intel and macos-15, windows x64 and arm64. macOS stays supported (owner, 2026-11-24).

| Item | Runners | Extra minutes per release |
| --- | --- | --- |
| Bun dg (today) | 1 build + 6 smoke | 0 |
| Compressed assets and patches | ubuntu | +3-5 |
| C# front door NativeAOT (no cross-OS AOT: Microsoft Learn says "Native AOT does not support cross-OS compilation") | ubuntu x64, ubuntu arm64, windows x64, windows arm64, macos-15-intel, macos-15 | +30-50 (6 jobs at 5-8 min; macOS minutes cost 10x on private repos) |
| native.yml on PRs that touch native/ | the same 6 | +30-50 per run |

### Two binaries during the transition

- Assets: the Bun `dg-<key>` (8 targets) plus `dg-front-<rid>` (6 RIDs), each with .zst, .gz and a patch from the previous release, all in SHA256SUMS.
- Install by default (R13, owner 2026-11-24): the front door at `dg`, the Bun binary at `dg-core`. DG_FRONT=0 or front.enabled = false keeps the Bun-only layout, and a front door that is missing or fails its --version check falls back to Bun. Update and patches cover both; a failed front-door download keeps the Bun layout.
- Gates for both: the ram-budget RSS and latency cases run against the Bun dg and the front door. native.yml gates the front door's size, RSS and hook p50.

## C# Coding Standard (native/)

- net11.0, the default C# language version, SDK pinned in global.json (11.0.100, rollForward latestFeature).
- Nullable on, TreatWarningsAsErrors, IsAotCompatible, the AOT, trim and single-file analyzers on; any IL2xxx or IL3xxx warning fails the build.
- File-scoped namespaces, primary constructors, collection expressions, required members, the `field` keyword, extension members where the compiler has them.
- Data: records and readonly record structs. Routing and parsing: list patterns, property patterns, switch expressions.
- Hot paths: Span<T>, ReadOnlySpan<char>, Memory<T>, stackalloc, ArrayPool, SearchValues, UTF-8 literals ("..."u8), Utf8JsonReader for hook stdin, FrozenDictionary and FrozenSet for route tables, static lambdas, no LINQ.
- Sealed classes by default; ValueTask for async results; IAsyncEnumerable for streams.
- No reflection: System.Text.Json source generation, [GeneratedRegex], [LoggerMessage], the configuration-binding source generator.
- Config: config.toml is the only user config (ADR 0054 paths). Precedence flag > documented DG_* env > TOML > default. No appsettings.json, launchSettings, .env files or JSON configuration providers. GC and globalization settings live in the .csproj and Directory.Build.props as build config.
- DI: Microsoft.Extensions.DependencyInjection with explicit registrations; each group exposes `AddX(this IServiceCollection)`; ValidateOnBuild off; no open generics; no assembly scanning.
- Tests: xUnit v3, one test project per source project, plus Dg.Parity.Tests that run every fixture through the Bun dg and the front door.

## Plugin Model (hook, job, skill)

NativeAOT cannot load assemblies at runtime, so a plugin is either:
- **built-in**: compiled in, behind IPlugin, registered through DI (`AddHooks()`), or
- **external**: an executable or service plus a manifest, spoken to over the versioned plugin contract on IPC (default), TCP or HTTP; UDP for events only (see Plugin Transports and Speed).

Manifest `plugin.toml`: name, version, kind (hook, job, skill), entry (built-in id, or command and args), transport and endpoint, capabilities, permissions, a sha256 or commit pin, and the source. Enablement and settings go in config.toml under `[plugins.<name>]` (enabled, source, settings), the section #247 created; secrets only as credential references.

- Hooks: today's hook ids become built-in hook plugins and stay in process. External hook plugins run as long-lived processes that get a /v1/hook/decide request over IPC, with a 2 s timeout and a latency budget; dg never spawns a plugin per call. `dg plugin add` prints the measured round trip.
- Jobs: the ADR 0049 job model (one program's argv, `dg job add <git url|path>`) reads a job plugin.toml when the repo ships one.
- Skills: `dg plugin add <git url|path>` imports SKILL.md bundles with references and optional helper commands. They are pinned by commit or sha256, installed in the plugin folder, and registered with the Claude and Codex hosts as today. Any change needs approval again. Imported skill text is untrusted until approved, like the existing third-party script pinning (SHA-256, re-approval on change).
- Security: the manifest declares capabilities (network, file read and write roots, exec) and permissions. dg enforces what it can: the exec allowlist, the working directory, the environment, timeouts, and no credential access unless declared. It names what it cannot enforce (network and file access of an external process) in `dg plugin verify`. Peer and third-party text is never instructions.
- Bun and C# read the same manifest and TOML section; the shared fixtures in pkg/common/fixtures/plugins run through both. The Bun side has the IPC and HTTP transports only; C# has all four.
- Commands: `dg plugin list|add|remove|enable|disable|update|verify`. The Plugins group in C#, with the Core plugin abstraction other groups use.

## Relay Contract

The C# side talks to the extension only through the daemon relay. Slice relay-contract writes docs/relay-protocol.md (message shapes, a protocol version field, negotiation, error frames) and the shared fixture set in pkg/common/fixtures/relay. The Bun side tests the fixtures now, and the C# daemon (stage 2) tests the same fixtures.


### Browser automation (dg pw) per option

dg pw has 68 verbs (8.0k lines) and uses locators, auto-wait, 12 storageState sites, route mocking, tracing, video, ariaSnapshot, pdf, cookies, and names firefox and webkit in browser.ts. The `--ext` path today has read verbs current, snapshot, screenshot, selection, console, tools, tabs, count, network, storage and write verbs open, click, fill, press, upload, call, new, select, close, unmask, dialog, fetch, credential.

| Option | pw engine | pw download | pw first start |
| --- | --- | --- | --- |
| A, B, C | Playwright in the Bun core (in binary) or a 1 MB companion (R3) | 0, or 1.0 MB | ~4 ms + 59 ms chunk import + browser launch |
| D (Rust) | Bun sidecar + playwright-core companion | ~31 MB zstd once (Bun is smaller than Node: Node v26 is 148 MB here) | one-time download + 4 ms + 59 ms + browser launch |
| D (C# NativeAOT) | Microsoft.Playwright 1.65.1 (verified on NuGet; full parity) bundles a Node driver process | Node driver, tens of MB (not measured) | Node start + driver + browser launch |
| E (Rust native) | chromiumoxide 0.9.1 (2026-02), headless_chrome 1.0.22 (2026-06) for CDP; fantoccini 0.22.2 and thirtyfour 0.38.3 (2026-11) for WebDriver; the `playwright` crate is dead (0.0.20, 2022-08). No locators, auto-wait, storage states, tracing, video, Firefox or WebKit | 0 | browser launch only |
| E (BiDi-native) | own WebDriver BiDi client for the 68 verbs | 0 | browser launch only; 2-4 eng-months; loses tracing and video (no BiDi equivalent), keeps Chromium + Firefox |
| Zig, C3 | hand-rolled CDP or BiDi, nothing mature | 0 | not estimated |

With `--ext` as the default (R8), the native dg needs only the websocket client it already needs for the daemon relay, and the sidecar downloads only for `--local`, db and CI. Skills that still need it: verify, demo recording, db, inbox Proton, test-live, pw --local (6 of 61 skills). Without telemetry the share of users is unknown; for Dante it is 100 percent, for a CLI-only user it is near 0.


## Browser Default: auto (decided)

Auto mode: --ext when the extension is paired and running, else local; DG_BROWSER and browser.mode force it. The dedicated agent window and the prompt for each new site land first (ext-agent-window). The extension and its ext gap verbs stay TypeScript and Bun.

### Coverage map

| Area | Ext today | Needs ext work (estimate) | Local only |
| --- | --- | --- | --- |
| pw navigation and input | open/goto, click, fill, press, select, upload, close, dialog-accept/dismiss | go-back, go-forward, reload, hover, dblclick, check, uncheck, type (2-3 days); keydown/up, mouse*, drag (3-4 days) | - |
| pw tabs | tab-list, tab-new, tab-close (tabs, new, close) | tab-select, resize of the agent window (1 day) | - |
| pw read | snapshot, screenshot, console, network (read), count, localstorage/sessionstorage list/get (storage) | eval via chrome.scripting (1-2 days); storage set/delete/clear on allowlisted origins (2 days) | - |
| pw state and network | - | - | route, unroute, route-list, network-state-set, state-save, state-load, delete-data, cookie-set/delete/clear in the real profile |
| pw recording and engine | - | - | video-start/stop/chapter, tracing-start/stop, pdf, install-browser, kill-all, attach (CDP), Firefox, WebKit, headless, CI |
| verify | - | single-viewport capture (part of slice 7) | multi-viewport, light and dark, per role, parallel captures |
| demo | review and walkthrough already play in a local browser without Playwright | --ext playback exists | video recording (demo/recorder) |
| proto | --ext variations exist | - | local fingerprint capture uses Playwright |
| db setup, inbox Proton, test-live, channel-review, doctor, rerun | - | inbox Outlook: not a browser flow | saved logins and storage states, headless runs |

### Safety in the real profile

Exists: the "Agent is driving" banner with Stop (pw-ext-banner), per-agent tab groups (extension 1.44+), the per-session site allowlist (site-key, webmcp-approval), secret masking and unmask grants, the PHI rules (phone references/safety.md) and the Outlook rules of inbox-cleanup.
Must add before ext is the default (slice 7): a dedicated agent window, an allowlist prompt on the first visit to each new site, a refusal of storage and cookie writes outside the allowlist, and PHI-flagged sites refused for snapshot and screenshot.

### CI

All CI and recorded fixtures stay `--local`: compiled-dg ram-budget, pw e2e, verify captures, demo recordings, proto fingerprints and the extension's own Playwright tests.


## Plugin Transports and Speed

Speed order: built-in (in process) > IPC > TCP loopback > HTTP; UDP for events only. IPC is the default for local external plugins. HTTP is for remote or interoperable plugins and simple authoring; a remote URL needs `remote = true`. One contract for all transports: a length-prefixed binary header (version, encoding, flags, request id, length) plus a payload. The payload is UTF-8 JSON (source-generated System.Text.Json) by default, with MessagePack (MessagePack-CSharp 3.1.12, source-generated, AOT-safe) negotiated in hello for hot plugins. Pipelines, spans and ArrayPool: no per-message allocations on the hot path. dg keeps one warm connection per plugin, with request ids; it never spawns a process per call for a running plugin.

Security per transport: loopback-only defaults; Unix socket files 0600; named pipes with a user-only ACL; token auth on HTTP and TCP from the credential store (TOML holds only the reference); message size limits; timeouts; no secrets in URLs or logs.

Measured round trips (C# NativeAOT, net11.0, this machine, 300 calls each, ~120-byte hook message):

| Path | p50 | p99 |
| --- | --- | --- |
| built-in (in process) | <0.001 ms | <0.001 ms |
| IPC (Unix socket), warm connection | 0.010 ms | 0.017 ms |
| TCP loopback, warm, NoDelay | 0.022 ms | 0.034 ms |
| HTTP keep-alive | 0.047 ms | 0.107 ms |
| IPC, new connection per call | 0.027 ms | 0.037 ms |
| TCP, new connection per call | 0.067 ms | 0.127 ms |
| HTTP, new client per call | 0.122 ms | 0.242 ms |
| IPC through a daemon broker (new hop + warm hop) | 0.039 ms | 0.053 ms |
| fresh hook process + HTTP (process start included, 80 runs) | 2.40 ms | 93.4 ms (one cold outlier) |
| fresh hook process + IPC direct | 1.99 ms | 2.65 ms |
| fresh hook process + IPC through the broker | 1.89 ms | 2.08 ms |
| TCP warm without NoDelay, header and payload in two writes | 41.0 ms | 42.1 ms (Nagle plus delayed ACK: always write one buffer and set NoDelay) |

Result: for a short-lived hook process, IPC direct and IPC through the daemon cost the same (about 0.03 ms over process start). The broker pays off only if the plugin handshake (hello, auth) costs more than about 0.2 ms, so hooks connect directly for now (R16). HTTP from a fresh process adds about 0.4 ms at p50 and has a cold-start tail; IPC is the default for hook plugins.

## Budgets, Ratchet and Size Levers

- Gates on every PR for the Bun dg and the C# front door: peak RSS per command and per long-running process, idle RSS after N minutes and growth (leak) for the daemon, listener and plugin host, binary size per RID (raw and zstd), download size (full and patch), hook latency, plugin round trips, skill tokens. Linux gates; Windows and macOS report.
- The ratchet (budget-ratchet): budgets live in versioned JSON. A PR that improves a number must lower its budget in the same PR (fails when slack exceeds R18's threshold). A PR that raises a number fails unless its body has a reviewed `Budget-Increase: <budget> <old> -> <new> because <reason>` line (R19).
- Size attribution posted on each PR: Bun metafile per module (build-report, size-diff.ts) and NativeAOT mstat per assembly and namespace (Dg.SizeReport).
- Quality guard: no size or RAM cut may drop a feature, test coverage or error-message quality. Gates run beside the full test suites. A cut that needs a behavior change goes to Dante as a RATIFY item.

NativeAOT size levers, measured on the hook prototype (lean build 2,295,328 bytes):

| Lever (changed from the lean build) | Size | Effect of the lean setting |
| --- | --- | --- |
| EventSourceSupport=true | 3,740,936 | false saves 1.45 MB (39%) |
| StripSymbols=false | 6,825,704 | true saves 4.5 MB; ship symbols as a separate asset |
| StackTraceSupport=true | 2,541,168 | false saves 246 KB; keep exception messages, lose frame names (accepted only for release builds) |
| OptimizationPreference=Speed | 2,491,424 | Size saves 196 KB; hook p50 within noise |
| InvariantGlobalization=false | 2,394,208 | true saves 99 KB |
| UseSystemResourceKeys=false | 2,315,808 | true saves 20 KB; dg's own error text is unaffected |
| IlcGenerateStackTraceData=false | 2,295,328 | 0 once StackTraceSupport=false |
| DebuggerSupport=false | 2,295,296 | 32 bytes |

Heavy packages are judged by their size cost first; the BCL is preferred.

## Integration: one PR, parallel worktrees

- One integration branch `feat/dg-cli-lean` from master. Each slice builds in its own worktree on `slice/<id>-<name>` from the integration branch at the start of its wave.
- File ownership is the conflict guard: lint-waves proves that no two slices in a wave share a file, and every later owner of a file depends on the earlier one. A slice that needs a file it does not own stops and reports; it never edits it.
- Merge order: the gate slices first (baseline-latency, baseline-size, baseline-skill-tokens, budget-ratchet, then ci-lean-gates), then the rest of each wave in id order. Each slice rebases on the integration branch, runs its own tests, the full suites and every gate, then merges with `--no-ff`. Wave N+1 starts from the integration branch after every wave N slice merged.
- Generated files are not committed (the C# route table and completion copies build from the TS sources), so no generator can conflict.
- One PR from the integration branch to master after wave 9, reviewed with three Claude /dg:thrash -s 4 rounds (owner, 2026-11-24).

## Owner Decisions (2026-11-24)

R1 D in C#; R2 bytecode yes; R3 companions yes; R4 patch from the previous release only; R5 no shared runtime; R6 no UPX; R7 8 KB cap and 400-character descriptions; R8 auto browser mode; R9 dedicated agent window with a prompt for each new site; R10 local-only list as proposed; R11 moot (dg:csharp); keep macOS; extension stays TypeScript and Bun; config.toml is the only config; plugins built-in plus external; external transports IPC default, then TCP and HTTP, UDP for events only.

## RATIFY Items (all decided 2026-11-24)

- (decided) R12: Concurrency per wave — all 25 at once / 8 / 4 — Recommend 8: wave 1 has 25 slices and the merge queue is serial.
- (decided) R13: The C# front door in this PR — opt-in / default on — Decided: default on, with DG_FRONT=0 or front.enabled = false to opt out and a Bun fallback.
- (decided) R14: ChaCha20 for NIP-44 (stage 2) — hand-rolled RFC 8439 with test vectors / BouncyCastle — Recommend hand-rolled; .NET has no raw ChaCha20 and BouncyCastle adds size.
- (decided) R15: The plugin contract shape — the binary frame header plus JSON v1 with /v1/hook/decide, /v1/job/run, /v1/job/status, /v1/skill/describe, /v1/health / JSON-RPC 2.0 framing — Recommend the custom frame: smaller, request ids, encoding negotiation.
- (decided) R16: Daemon-brokered hook connections — direct IPC now / always through the daemon — Recommend direct; measured 1.99 vs 1.89 ms, within noise; revisit when a plugin handshake costs more than 0.2 ms.
- (decided) R17: MessagePack — optional per plugin / required for hot plugins / not at all — Recommend optional, negotiated in hello; JSON stays the default for third parties.
- (decided) R18: Ratchet slack threshold — 2% / 5% / 10% — Recommend 5%; latency gets 10% because CI timing is noisy.
- (decided) R19: Budget-increase process — a `Budget-Increase:` line in the PR body plus approval by Dante / a label / a CODEOWNERS file on the budget JSON — Recommend the PR-body line plus CODEOWNERS on budgets/**, so Dante reviews every raise.
- (decided) R20: Plugin auth — a per-plugin token in the credential store for HTTP and TCP, socket permissions for IPC / mTLS for remote — Recommend the token for local and remote over HTTPS; mTLS deferred.
- (decided) R21: Remote plugin opt-in — `remote = true` in the manifest plus `[plugins.<name>].allow_remote = true` in config.toml / one of them — Recommend both, so a downloaded manifest cannot opt itself in.
- (decided) R22: Plugin permission model — declared capabilities enforced where dg can (exec allowlist, cwd, env, credentials, timeouts) and reported where it cannot (network and file access of an external process) / OS sandboxing (bubblewrap, AppContainer, sandbox-exec) — Recommend declared and reported now; sandboxing in a later bundle.
- (decided) R23: Skill import trust — pinned and untrusted until approved, approval again on any change, helper commands run only after approval / auto-approve signed sources — Recommend pinned and untrusted until approved; no auto-approve.
- (decided) R24: StackTraceSupport=false in release builds — saves 246 KB, but crash reports lose frame names — yes / no — Recommend yes, with the symbols asset for local decoding.

## Risks

- 62 slices in one PR: a long review and a serial merge queue. Mitigation: gate slices first, waves merge in id order, and three Claude /dg:thrash review rounds on the integration branch.
- Waves 5-9 are a serial tail (plugins runtime, group, compose, install, docs) that sets the wall time.
- Parity drift between Bun and C#: shared fixtures (config, plugins, relay, hooks, routes) run through both in CI.
- NativeAOT needs 6 runners and does not cross-compile across OSes; macOS minutes are the most expensive.
- Bytecode ties the binary to one Bun version and adds about 35 MB raw; compressed assets and patches hide most of it.
- External plugin speed depends on the author; built-ins stay in process, and dg prints the measured cost at `dg plugin add`.
- Third-party skill text and plugin output are untrusted data; approval gates them, and they are never instructions.
- Measurements come from one warm Linux box; Windows and macOS numbers are report-only until runners give baselines.

## Cost

`dg spec estimate`: 62 slices, 371 agent calls (124 haiku, 238 sonnet, 9 opus), up to 2 correction rounds (balance). That is about 30-45M tokens (about 40k per haiku call, 120k per sonnet call, 250k per opus call). Per-wave concurrency: W1 25, W2 17, W3 11, W4 4, W5-W9 1 each. Wall time with R12's cap of 8 is about 20-24 h (waves 1-4 in 10 batches of 1.5-2 h, then 5 serial waves); without a cap it is about 14-18 h. Engineer-time equivalent: stage 0 about 6-8 weeks, stage 1 about 4-6 weeks, plugins and transports about 4-5 weeks.


## Waves

| Wave | Id | Slice | Agent | depends_on | Owned files |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | baseline-latency | dg:devops | - | `scripts/ram-budget.ts`, `scripts/ram-budget/**`, `scripts/ram-budgets.json` |
| 1 | 2 | baseline-size | dg:devops | - | `scripts/lean-size.ts`, `scripts/lean-budgets.json`, `pkg/skills-test/__tests__/lean-size.spec.ts` |
| 1 | 3 | baseline-skill-tokens | dg:js | - | `scripts/skill-tokens.ts`, `scripts/skill-token-budgets.json`, `pkg/skills-test/__tests__/lean-skill-tokens.spec.ts` |
| 1 | 4 | budget-ratchet | dg:devops | - | `scripts/budget-ratchet.ts`, `pkg/skills-test/__tests__/budget-ratchet.spec.ts`, `.github/workflows/budgets.yml` |
| 1 | 5 | build-split | dg:js | - | `pkg/launcher/build.ts`, `pkg/launcher/build/**`, `pkg/launcher/__tests__/build.spec.ts` |
| 1 | 6 | version-path | dg:js | - | `pkg/launcher/src/**`, `pkg/launcher/__tests__/dispatch.spec.ts` |
| 1 | 7 | hooks-fast-route | dg:js | - | `pkg/dg/src/fast-route.ts`, `pkg/dg/__tests__/fast-route.spec.ts`, `pkg/skills-cli/src/hooks/cli.ts`, `pkg/skills-cli/src/hooks/run.ts`, `pkg/skills-cli/src/hooks/io.ts`, `pkg/skills-cli/__tests__/hooks-fast-path.spec.ts` |
| 1 | 8 | completion-fast-path | dg:js | - | `pkg/skills-cli/src/completion/**`, `pkg/skills-cli/__tests__/completion-fast-path.spec.ts` |
| 1 | 9 | release-compress | dg:js | - | `.github/workflows/release.yml`, `pkg/skills-cli/src/utils/lib.ts`, `pkg/skills-cli/src/install/compiled.ts`, `pkg/skills-cli/__tests__/install-compressed.spec.ts`, `pkg/skills-test/__tests__/release-compressed.spec.ts` |
| 1 | 10 | bootstrap-gz | dg:shell | - | `pkg/skills-cli/bootstrap.sh`, `pkg/skills-cli/bootstrap.ps1`, `pkg/skills-cli/__tests__/bootstrap-*.spec.ts`, `pkg/skills-cli/__tests__/bootstrap-fixtures.ts`, `pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts` |
| 1 | 11 | skill-diet-phone | dg:lore | - | `plugins/dg/skills/phone/**` |
| 1 | 12 | skill-diet-status | dg:lore | - | `plugins/dg/skills/stat/**`, `plugins/dg/skills/jobs/**`, `plugins/dg/skills/bg/**`, `plugins/dg/skills/jot/**`, `plugins/dg/skills/overwatch/**` |
| 1 | 13 | skill-diet-review | dg:lore | - | `plugins/dg/skills/thrash/**`, `plugins/dg/skills/review-loop/**`, `plugins/dg/skills/address/**`, `plugins/dg/skills/polish/**`, `plugins/dg/skills/sniff/**`, `plugins/dg/skills/land/**` |
| 1 | 14 | skill-diet-planning | dg:lore | - | `plugins/dg/skills/spec/**`, `plugins/dg/skills/sdlc/**`, `plugins/dg/skills/kick/**`, `plugins/dg/skills/pickup/**`, `plugins/dg/skills/assign/**`, `plugins/dg/skills/grill-me/**`, `plugins/dg/skills/prd/**`, `plugins/dg/skills/wayfinder/**`, `plugins/dg/skills/walk/**`, `plugins/dg/skills/refactor/**`, `plugins/dg/skills/chain/**` |
| 1 | 15 | skill-diet-rest | dg:lore | - | `plugins/dg/skills/adr/**`, `plugins/dg/skills/agent-seed/**`, `plugins/dg/skills/bot-commit-email/**`, `plugins/dg/skills/catchup/**`, `plugins/dg/skills/chat/**`, `plugins/dg/skills/channel-review/**`, `plugins/dg/skills/clipboard-img/**`, `plugins/dg/skills/cls/**`, `plugins/dg/skills/db/**`, `plugins/dg/skills/deps-upgrade/**`, `plugins/dg/skills/doctor/**`, `plugins/dg/skills/eli5/**`, `plugins/dg/skills/erd/**`, `plugins/dg/skills/file/**`, `plugins/dg/skills/find-work/**`, `plugins/dg/skills/google-sms-cleanup/**`, `plugins/dg/skills/hook-comment-disable/**`, `plugins/dg/skills/hooks/**`, `plugins/dg/skills/hunt/**`, `plugins/dg/skills/inbox-cleanup/**`, `plugins/dg/skills/meaningful/**`, `plugins/dg/skills/monolith/**`, `plugins/dg/skills/nope/**`, `plugins/dg/skills/proxy/**`, `plugins/dg/skills/pushup/**`, `plugins/dg/skills/rename-session/**`, `plugins/dg/skills/spring-break/**`, `plugins/dg/skills/standard-test/**`, `plugins/dg/skills/stash/**`, `plugins/dg/skills/teach/**`, `plugins/dg/skills/ticket/**`, `plugins/dg/skills/update/**`, `plugins/dg/skills/what-changed/**`, `plugins/dg/skills/worktree/**` |
| 1 | 16 | browser-mode-flag | dg:js | - | `pkg/skills-cli/src/pw/cli.ts`, `pkg/skills-cli/src/pw/core/dispatch.ts`, `pkg/skills-cli/src/pw/core/spec.ts`, `pkg/skills-cli/src/pw/browser-mode.ts`, `pkg/skills-cli/__tests__/pw-browser-mode.spec.ts`, `pkg/common/src/node/dg-toml.ts`, `pkg/common/__tests__/dg-toml.spec.ts` |
| 1 | 17 | ext-verbs-navigation | dg:js | - | `pkg/extension/lib/background/pw-verbs/navigation.ts`, `pkg/extension/__tests__/pw-verbs-navigation.spec.ts`, `pkg/common/src/pw-ext-verbs/navigation.ts`, `pkg/common/__tests__/pw-ext-verbs-navigation.spec.ts`, `pkg/skills-cli/src/pw/ext-verbs/navigation.ts`, `pkg/skills-cli/__tests__/pw-ext-verbs-navigation.spec.ts` |
| 1 | 18 | ext-verbs-pointer | dg:js | - | `pkg/extension/lib/background/pw-verbs/pointer.ts`, `pkg/extension/__tests__/pw-verbs-pointer.spec.ts`, `pkg/common/src/pw-ext-verbs/pointer.ts`, `pkg/common/__tests__/pw-ext-verbs-pointer.spec.ts`, `pkg/skills-cli/src/pw/ext-verbs/pointer.ts`, `pkg/skills-cli/__tests__/pw-ext-verbs-pointer.spec.ts` |
| 1 | 19 | ext-verbs-input | dg:js | - | `pkg/extension/lib/background/pw-verbs/input.ts`, `pkg/extension/__tests__/pw-verbs-input.spec.ts`, `pkg/common/src/pw-ext-verbs/input.ts`, `pkg/common/__tests__/pw-ext-verbs-input.spec.ts`, `pkg/skills-cli/src/pw/ext-verbs/input.ts`, `pkg/skills-cli/__tests__/pw-ext-verbs-input.spec.ts` |
| 1 | 20 | ext-verbs-page | dg:js | - | `pkg/extension/lib/background/pw-verbs/page.ts`, `pkg/extension/__tests__/pw-verbs-page.spec.ts`, `pkg/common/src/pw-ext-verbs/page.ts`, `pkg/common/__tests__/pw-ext-verbs-page.spec.ts`, `pkg/skills-cli/src/pw/ext-verbs/page.ts`, `pkg/skills-cli/__tests__/pw-ext-verbs-page.spec.ts` |
| 1 | 21 | ext-verbs-storage | dg:js | - | `pkg/extension/lib/background/pw-verbs/storage.ts`, `pkg/extension/__tests__/pw-verbs-storage.spec.ts`, `pkg/common/src/pw-ext-verbs/storage.ts`, `pkg/common/__tests__/pw-ext-verbs-storage.spec.ts`, `pkg/skills-cli/src/pw/ext-verbs/storage.ts`, `pkg/skills-cli/__tests__/pw-ext-verbs-storage.spec.ts` |
| 1 | 22 | ext-agent-window | dg:js | - | `pkg/extension/lib/background/agent-window.ts`, `pkg/extension/lib/background/site-allow-prompt.ts`, `pkg/extension/entrypoints/site-allow/**`, `pkg/extension/__tests__/agent-window.spec.ts`, `pkg/extension/__tests__/site-allow-prompt.spec.ts` |
| 1 | 23 | relay-contract | dg:js | - | `docs/relay-protocol.md`, `pkg/common/fixtures/relay/**`, `pkg/common/__tests__/relay-fixtures.spec.ts` |
| 1 | 24 | plugin-contract | dg:js | - | `docs/plugin-protocol.md`, `pkg/common/src/plugins/manifest.ts`, `pkg/common/src/plugins/contract.ts`, `pkg/common/src/plugins/config.ts`, `pkg/common/fixtures/plugins/**`, `pkg/common/__tests__/plugins-manifest.spec.ts` |
| 1 | 25 | cs-scaffold | dg:csharp | - | `native/Dg.slnx`, `native/global.json`, `native/Directory.Build.props`, `native/Directory.Packages.props`, `native/.editorconfig`, `native/src/**/*.csproj`, `native/tests/**/*.csproj`, `native/bench/**/*.csproj`, `native/tools/**/*.csproj`, `native/tests/Directory.Build.props`, `native/src/Dg.Core/Abstractions/**`, `native/src/Dg.Core/Errors/**`, `native/src/Dg.Core/Output/**`, `native/src/Dg.Cli/**` |
| 2 | 26 | ci-lean-gates | dg:devops | 1, 2, 3, 4 | `.github/workflows/compiled-dg.yml`, `docs/lean-baseline.md` |
| 2 | 27 | build-report | dg:js | 5 | `pkg/launcher/build/report.ts`, `pkg/launcher/__tests__/build-report.spec.ts`, `scripts/size-diff.ts` |
| 2 | 28 | build-bytecode | dg:js | 5 | `pkg/launcher/build/compile.ts`, `pkg/launcher/__tests__/build-compile.spec.ts` |
| 2 | 29 | build-companions | dg:js | 5 | `pkg/launcher/build/companions.ts`, `pkg/launcher/__tests__/build-companions.spec.ts`, `pkg/common/src/node/companion.ts`, `pkg/common/__tests__/companion.spec.ts` |
| 2 | 30 | dispatch-wire | dg:js | 6, 7, 8 | `pkg/launcher/src/dispatch.ts`, `pkg/launcher/__tests__/dispatch-fast.spec.ts` |
| 2 | 31 | delta-patches | dg:js | 9 | `.github/workflows/release-patches.yml`, `pkg/skills-cli/src/install/patch.ts`, `pkg/skills-cli/src/install/compiled.ts`, `pkg/skills-cli/__tests__/install-patch.spec.ts` |
| 2 | 32 | cs-core-config | dg:csharp | 25 | `native/src/Dg.Core/Paths/**`, `native/src/Dg.Core/Config/**`, `native/src/Dg.Core/Credentials/**`, `native/tests/Dg.Core.Tests/Paths/**`, `native/tests/Dg.Core.Tests/Config/**`, `native/tests/Dg.Core.Tests/Credentials/**` |
| 2 | 33 | cs-hooks-engine | dg:csharp | 25 | `native/src/Dg.Hooks/Engine/**`, `native/src/Dg.Hooks/HooksServiceCollectionExtensions.cs`, `native/src/Dg.Hooks/Defs/*/Registration.cs`, `native/tests/Dg.Hooks.Tests/Engine/**` |
| 2 | 34 | cs-routing-version | dg:csharp | 25 | `native/src/Dg.Routing/**`, `native/tests/Dg.Routing.Tests/**`, `scripts/native-routes.ts` |
| 2 | 35 | cs-completion | dg:csharp | 25 | `native/src/Dg.Completion/**`, `native/tests/Dg.Completion.Tests/**`, `scripts/native-completion.ts` |
| 2 | 36 | cs-ci | dg:devops | 25 | `.github/workflows/native.yml` |
| 2 | 37 | plugin-cli-bun | dg:js | 24, 8 | `pkg/skills-cli/src/plugin/**`, `pkg/skills-cli/src/commands/plugin.ts`, `pkg/skills-cli/src/register-all.ts`, `pkg/skills-cli/src/completion/tree.json`, `pkg/skills-cli/__tests__/plugin-*.spec.ts` |
| 2 | 38 | bun-transport-http | dg:js | 24 | `pkg/common/src/plugins/transport/http.ts`, `pkg/common/__tests__/plugins-transport-http.spec.ts` |
| 2 | 39 | bun-transport-ipc | dg:js | 24 | `pkg/common/src/plugins/transport/ipc.ts`, `pkg/common/src/plugins/transport/framing.ts`, `pkg/common/__tests__/plugins-transport-ipc.spec.ts` |
| 2 | 41 | job-plugins-bun | dg:js | 24 | `pkg/dg-daemon/src/jobs/plugin-manifest.ts`, `pkg/dg-daemon/src/jobs/sources.ts`, `pkg/dg-daemon/__tests__/jobs/plugin-manifest.spec.ts` |
| 2 | 42 | cs-plugin-contract | dg:csharp | 25, 24 | `native/src/Dg.Core/Plugins/Contract/**`, `native/src/Dg.Core/Plugins/Manifest/**`, `native/tests/Dg.Core.Tests/Plugins/**` |
| 2 | 43 | ext-verbs-wire | dg:js | 16, 17, 18, 19, 20, 21, 22 | `pkg/common/src/pw-ext-format.ts`, `pkg/common/__tests__/pw-ext-format.spec.ts`, `pkg/skills-cli/src/pw/ext.ts`, `pkg/skills-cli/__tests__/pw-ext.spec.ts`, `pkg/extension/lib/background/pw-ext.ts`, `pkg/extension/lib/background/relay-dispatch.ts`, `pkg/extension/__tests__/pw-ext.spec.ts` |
| 3 | 40 | hook-plugins-bun | dg:js | 24, 7, 38, 39 | `pkg/skills-cli/src/hooks/plugins.ts`, `pkg/skills-cli/src/hooks/external.ts`, `pkg/skills-cli/src/hooks/run.ts`, `pkg/skills-cli/__tests__/hooks-plugins.spec.ts` |
| 3 | 44 | cs-hooks-pr | dg:csharp | 33, 32 | `native/src/Dg.Hooks/Defs/Pr/**`, `native/tests/Dg.Hooks.Tests/Pr/**` |
| 3 | 45 | cs-hooks-text | dg:csharp | 33, 32 | `native/src/Dg.Hooks/Defs/Text/**`, `native/tests/Dg.Hooks.Tests/Text/**` |
| 3 | 46 | cs-hooks-repo | dg:csharp | 33, 32 | `native/src/Dg.Hooks/Defs/Repo/**`, `native/tests/Dg.Hooks.Tests/Repo/**` |
| 3 | 47 | cs-config-group | dg:csharp | 32 | `native/src/Dg.Config/**`, `native/tests/Dg.Config.Tests/**` |
| 3 | 48 | cs-transport-http | dg:csharp | 42 | `native/src/Dg.Core/Transport/Http/**`, `native/tests/Dg.Core.Tests/Transport/Http/**` |
| 3 | 49 | cs-transport-ipc | dg:csharp | 42 | `native/src/Dg.Core/Transport/Ipc/**`, `native/src/Dg.Core/Transport/Framing/**`, `native/src/Dg.Core/Transport/Pool/**`, `native/tests/Dg.Core.Tests/Transport/Ipc/**`, `native/tests/Dg.Core.Tests/Transport/Framing/**` |
| 3 | 51 | cs-transport-udp | dg:csharp | 42 | `native/src/Dg.Core/Transport/Udp/**`, `native/tests/Dg.Core.Tests/Transport/Udp/**` |
| 3 | 53 | cs-native-gates | dg:devops | 36 | `.github/workflows/native.yml`, `native/tools/Dg.SizeReport/**`, `native/budgets/**`, `scripts/native-ram-budget.ts` |
| 3 | 57 | companion-release | dg:js | 29, 31 | `.github/workflows/release.yml`, `pkg/skills-cli/src/install/companion.ts`, `pkg/skills-cli/src/install/compiled.ts`, `pkg/skills-cli/__tests__/install-companion.spec.ts` |
| 3 | 58 | browser-docs-skills | dg:lore | 43 | `docs/pw.md`, `docs/browser.md`, `docs/config.md`, `docs/demo-and-proto.md`, `docs/verify.md`, `plugins/dg/skills/pw/**`, `plugins/dg/skills/verify/**`, `plugins/dg/skills/demo/**`, `plugins/dg/skills/proto/**`, `plugins/dg/skills/test-live/**` |
| 4 | 50 | cs-transport-tcp | dg:csharp | 49 | `native/src/Dg.Core/Transport/Tcp/**`, `native/tests/Dg.Core.Tests/Transport/Tcp/**` |
| 4 | 52 | cs-transport-msgpack | dg:csharp | 49 | `native/src/Dg.Core/Transport/Encoding/MessagePack/**`, `native/tests/Dg.Core.Tests/Transport/Encoding/**` |
| 4 | 54 | cs-plugin-bench | dg:csharp | 48, 49 | `native/bench/Dg.Bench/**`, `.github/workflows/native-bench.yml` |
| 4 | 60 | skill-size-cap | dg:js | 3, 11, 12, 13, 14, 15, 58 | `pkg/skills-test/__tests__/skill-size-cap.spec.ts`, `scripts/skill-token-budgets.json` |
| 5 | 55 | cs-plugins-runtime | dg:csharp | 48, 49, 50, 51, 32 | `native/src/Dg.Core/Plugins/Runtime/**`, `native/tests/Dg.Core.Tests/Plugins/Runtime/**` |
| 6 | 56 | cs-plugins-group | dg:csharp | 55, 32 | `native/src/Dg.Plugins/**`, `native/tests/Dg.Plugins.Tests/**` |
| 7 | 59 | cs-cli-compose | dg:csharp | 34, 35, 36, 44, 45, 46, 47, 56, 23 | `native/src/Dg.Cli/**`, `native/tests/Dg.Parity.Tests/**` |
| 8 | 61 | two-binary-install | dg:js | 59, 57, 10 | `.github/workflows/release.yml`, `pkg/skills-cli/src/install/front-door.ts`, `pkg/skills-cli/src/install/compiled.ts`, `pkg/skills-cli/bootstrap.sh`, `pkg/skills-cli/bootstrap.ps1`, `pkg/skills-cli/__tests__/install-front-door.spec.ts` |
| 9 | 62 | lean-docs | dg:lore | 61, 26 | `docs/install.md`, `docs/DEVELOPER.md`, `docs/AGENT-INSTALL.md`, `README.md`, `CHANGELOG.md` |

Slices per wave: W1 25, W2 17, W3 11, W4 4, W5 1, W6 1, W7 1, W8 1, W9 1

## Slice Summaries

## Agent Notes
(owner, 2026-11-24): R1 language path is D in C#, a staged NativeAOT port; slices for the Bun trims stay.
(owner, 2026-11-24): R2 bytecode build yes; R4 delta patches from the previous release only.
(owner, 2026-11-24): R3 pw and db companions allowed now that a port is picked.
(owner, 2026-11-24): R5 no 6.x shared runtime; R6 no UPX.
(owner, 2026-11-24): R7 SKILL.md cap 8 KB, descriptions 400 characters.
(owner, 2026-11-24): R8 browser default auto; DG_BROWSER and browser.mode force it.
(owner, 2026-11-24): R9 dedicated agent window with a prompt to allow each new site.
(owner, 2026-11-24): R10 local-only features as proposed.
(owner, 2026-11-24): R11 moot; C# slices use dg:csharp.
(owner, 2026-11-24): keep macOS; releases stay Linux, Windows and macOS, x64 and arm64.
(owner, 2026-11-24): slices are small and file-disjoint, built in parallel worktrees, all in one PR.
(owner, 2026-11-24): target net11.0 with SDK 11.0.100 pinned; the C# coding standard in this plan applies.
(owner, 2026-11-24): config.toml is the only user config for both runtimes; no JSON or env-file providers.
(owner, 2026-11-24): the extension stays TypeScript and Bun; C# talks to it only through the written relay contract.
(owner, 2026-11-24): plugins are built-in (DI) or external (manifest plus transport); kinds hook, job, skill.
(owner, 2026-11-24): external transports: IPC default, HTTP for remote and simple authoring, TCP, UDP for events only; speed is a first-class goal.
(owner, 2026-11-24): RAM and binary size are gated on every PR with a ratchet; cuts never drop features, tests or error quality.
Planned by a subagent with no human questions; open questions are R12-R24 in RATIFY Items. Roundtable shells are not filled; the main loop runs the approval gate.
(owner, 2026-11-24): R12 no concurrency cap; every slice of a wave runs at once, each in its own git worktree.
(owner, 2026-11-24): R13 changed: the C# front door is on by default in this PR, with an opt-out (DG_FRONT=0 or front.enabled = false in config.toml) and a fallback to the Bun dg when the native binary is missing or fails to start; tests cover the default path and the fallback.
(owner, 2026-11-24): R14 hand-rolled RFC 8439 ChaCha20; R15 custom binary frame with a JSON payload; R16 hooks reach plugins directly over IPC; R17 MessagePack optional per plugin.
(owner, 2026-11-24): R18 ratchet slack 5 percent (10 percent for latency); R19 a Budget-Increase: line plus CODEOWNERS on the budget files.
(owner, 2026-11-24): R20 token auth for HTTP and TCP, file permissions for IPC, mTLS later; R21 remote needs both the manifest flag and allow_remote; R22 permissions declared and reported now, sandboxing later; R23 imported skills pinned and untrusted until approved.
(owner, 2026-11-24): R24 StackTraceSupport off in release builds, symbols shipped as a separate asset.
(owner, 2026-11-24): earlier decisions hold: macOS on all 6 RIDs; .NET 11 (SDK 11.0.100) with the newest C# idioms; DI with an AddX() per group; config.toml only; the extension stays TypeScript and Bun; plugin kinds hook, job, skill; continuous RAM, size and latency gates with the ratchet; no feature or quality loss for size.
(owner, 2026-11-24): code reviews run on Claude for now, not Codex: 3 /dg:thrash -s 4 local rounds with /dg:address -l between them, early stop on a dry round.
(orchestrator, 2026-11-24): execution deviations from the skill texts: integration branch feature/dg_cli_lean (not feat/dg-cli-lean); plan.md lives and commits on the integration branch; one worktree per slice under /home/detailedghost/code/worktrees/dg-ai-027-<slice>, merged with --no-ff; slice agents commit each test-first step; no Workflow tool, so the orchestrator drives each slice with one persona agent.
Decision records: docs/adr/0058-dg-moves-to-c-nativeaot-in-stages.md and docs/adr/0059-dg-plugins-are-built-in-or-external-with-one-transport-contract.md.

## Issues Remediation

## Code Structure

**C# solution layout (native/), stage 1.** Applies to: cs-scaffold, cs-core-config, cs-plugin-contract, cs-transport-http, cs-transport-ipc, cs-transport-tcp, cs-transport-udp, cs-transport-msgpack, cs-plugins-runtime, cs-plugins-group, cs-hooks-engine, cs-hooks-pr, cs-hooks-text, cs-hooks-repo, cs-config-group, cs-routing-version, cs-completion, cs-cli-compose, cs-native-gates, cs-plugin-bench.

```
native/
  Dg.slnx                     global.json (11.0.100, latestFeature)
  Directory.Build.props       net11.0, Nullable, TreatWarningsAsErrors, PublishAot, IsAotCompatible, size levers
  Directory.Packages.props    central versions
  src/
    Dg.Core/                  shared library; the only reference other groups take
      Abstractions/           ICommand, IPlugin, PluginKind, IPluginTransport, IEventSink
      Errors/                 DgError (file:line, key, next step)
      Output/                 stdout and stderr writers over UTF-8 spans
      Paths/                  ADR 0054 paths (XDG_CONFIG_HOME, DG_HOME)
      Config/                 TOML provider (Tomlyn source-gen) -> IOptions, binding source generator
      Credentials/            credential references, no secrets in TOML
      Plugins/Contract/       message records, JsonSerializerContext, FrameHeader
      Plugins/Manifest/       plugin.toml model and parse
      Plugins/Runtime/        IPluginHost, keyed transport selection, health, timeouts
      Transport/Framing/      System.IO.Pipelines frame reader and writer
      Transport/Pool/         one warm connection per plugin, request ids
      Transport/Ipc/          Unix socket (0600), named pipe (user ACL)
      Transport/Tcp/          NoDelay, token hello
      Transport/Http/         SocketsHttpHandler keep-alive, bearer token
      Transport/Udp/          batched events only
      Transport/Encoding/MessagePack/   optional encoder
    Dg.Hooks/                 Engine/, Defs/Pr/, Defs/Text/, Defs/Repo/, HooksServiceCollectionExtensions.cs (AddHooks)
    Dg.Config/                dg config get|set|list|doctor (AddConfig)
    Dg.Completion/            completion from the Bun trees (AddCompletion)
    Dg.Routing/               --version, FrozenDictionary route table, exec dg-core (AddRouting)
    Dg.Plugins/               dg plugin list|enable|disable|verify (AddPlugins)
    Dg.Cli/                   Program.cs: the DI composition root
  tests/                      xUnit v3: Dg.Core.Tests, Dg.Hooks.Tests, Dg.Config.Tests, Dg.Completion.Tests,
                              Dg.Routing.Tests, Dg.Plugins.Tests, Dg.Parity.Tests (Bun vs C# fixtures)
  bench/Dg.Bench/             NativeAOT round-trip harness (transports, encodings)
  tools/Dg.SizeReport/        mstat size attribution
```

Rules: a group references only Dg.Core, never another group. Each group exposes one `AddX(this IServiceCollection)` with explicit registrations. Dg.Cli composes `AddCore().AddHooks().AddConfig().AddCompletion().AddRouting().AddPlugins().AddIpcTransport().AddTcpTransport().AddHttpTransport().AddUdpTransport()`, builds the provider with ValidateOnBuild off, and routes argv with list patterns over a FrozenDictionary. cs-scaffold creates every .csproj and the .slnx, so no later slice edits them. Later stages add Dg.Phone, Dg.Daemon, Dg.Stat and more groups in the same shape.

Alternatives rejected: one project with folders (no compile-time boundary between groups); System.CommandLine (larger, slower startup than a FrozenDictionary router); assembly plugins (NativeAOT cannot load them).

**Bun side (transition).** Applies to: plugin-contract, bun-transport-http, bun-transport-ipc, plugin-cli-bun, hook-plugins-bun, job-plugins-bun, relay-contract. The shared contracts live in pkg/common (src/plugins/, fixtures/plugins/, fixtures/relay/); the Bun CLI code in pkg/skills-cli/src/plugin and hooks; both runtimes test the same fixtures.
