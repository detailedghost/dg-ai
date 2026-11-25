---
feature: "Lean dg CLI: latency, binary and download size, skill token weight, and the C# front door"
feature_snake_case: "dg_cli_lean"
date: "2026-11-24"
version: "1.0"
status: "draft"
current_slice: 0
pr_strategy: "single"
bundle: "/home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/spec/027_dg_cli_lean"
plan_path: "/home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/spec/027_dg_cli_lean/plan.md"
slices:
  - id: 1
    name: "baseline-latency"
    depends_on: []
    files:
      - "scripts/ram-budget.ts"
      - "scripts/ram-budget/**"
      - "scripts/ram-budgets.json"
    agents:
      primary: "dg:devops"
      qa:
        - "dg:qa-perf"
  - id: 2
    name: "baseline-size"
    depends_on: []
    files:
      - "scripts/lean-size.ts"
      - "scripts/lean-budgets.json"
      - "pkg/skills-test/__tests__/lean-size.spec.ts"
    agents:
      primary: "dg:devops"
      qa:
        - "dg:qa-perf"
  - id: 3
    name: "baseline-skill-tokens"
    depends_on: []
    files:
      - "scripts/skill-tokens.ts"
      - "scripts/skill-token-budgets.json"
      - "pkg/skills-test/__tests__/lean-skill-tokens.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 4
    name: "budget-ratchet"
    depends_on: []
    files:
      - "scripts/budget-ratchet.ts"
      - "pkg/skills-test/__tests__/budget-ratchet.spec.ts"
      - ".github/workflows/budgets.yml"
    agents:
      primary: "dg:devops"
      qa:
        - "dg:qa-perf"
  - id: 5
    name: "build-split"
    depends_on: []
    files:
      - "pkg/launcher/build.ts"
      - "pkg/launcher/build/**"
      - "pkg/launcher/__tests__/build.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 6
    name: "version-path"
    depends_on: []
    files:
      - "pkg/launcher/src/**"
      - "pkg/launcher/__tests__/dispatch.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-perf"
  - id: 7
    name: "hooks-fast-route"
    depends_on: []
    files:
      - "pkg/dg/src/fast-route.ts"
      - "pkg/dg/__tests__/fast-route.spec.ts"
      - "pkg/skills-cli/src/hooks/cli.ts"
      - "pkg/skills-cli/src/hooks/run.ts"
      - "pkg/skills-cli/src/hooks/io.ts"
      - "pkg/skills-cli/__tests__/hooks-fast-path.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-perf"
  - id: 8
    name: "completion-fast-path"
    depends_on: []
    files:
      - "pkg/skills-cli/src/completion/**"
      - "pkg/skills-cli/__tests__/completion-fast-path.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-perf"
  - id: 9
    name: "release-compress"
    depends_on: []
    files:
      - ".github/workflows/release.yml"
      - "pkg/skills-cli/src/utils/lib.ts"
      - "pkg/skills-cli/src/install/compiled.ts"
      - "pkg/skills-cli/__tests__/install-compressed.spec.ts"
      - "pkg/skills-test/__tests__/release-compressed.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-devops"
        - "dg:security"
  - id: 10
    name: "bootstrap-gz"
    depends_on: []
    files:
      - "pkg/skills-cli/bootstrap.sh"
      - "pkg/skills-cli/bootstrap.ps1"
      - "pkg/skills-cli/__tests__/bootstrap-*.spec.ts"
      - "pkg/skills-cli/__tests__/bootstrap-fixtures.ts"
      - "pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts"
    agents:
      primary: "dg:shell"
      qa:
        - "dg:qa-devops"
  - id: 11
    name: "skill-diet-phone"
    depends_on: []
    files:
      - "plugins/dg/skills/phone/**"
    agents:
      primary: "dg:lore"
  - id: 12
    name: "skill-diet-status"
    depends_on: []
    files:
      - "plugins/dg/skills/stat/**"
      - "plugins/dg/skills/jobs/**"
      - "plugins/dg/skills/bg/**"
      - "plugins/dg/skills/jot/**"
      - "plugins/dg/skills/overwatch/**"
    agents:
      primary: "dg:lore"
  - id: 13
    name: "skill-diet-review"
    depends_on: []
    files:
      - "plugins/dg/skills/thrash/**"
      - "plugins/dg/skills/review-loop/**"
      - "plugins/dg/skills/address/**"
      - "plugins/dg/skills/polish/**"
      - "plugins/dg/skills/sniff/**"
      - "plugins/dg/skills/land/**"
    agents:
      primary: "dg:lore"
  - id: 14
    name: "skill-diet-planning"
    depends_on: []
    files:
      - "plugins/dg/skills/spec/**"
      - "plugins/dg/skills/sdlc/**"
      - "plugins/dg/skills/kick/**"
      - "plugins/dg/skills/pickup/**"
      - "plugins/dg/skills/assign/**"
      - "plugins/dg/skills/grill-me/**"
      - "plugins/dg/skills/prd/**"
      - "plugins/dg/skills/wayfinder/**"
      - "plugins/dg/skills/walk/**"
      - "plugins/dg/skills/refactor/**"
      - "plugins/dg/skills/chain/**"
    agents:
      primary: "dg:lore"
  - id: 15
    name: "skill-diet-rest"
    depends_on: []
    files:
      - "plugins/dg/skills/adr/**"
      - "plugins/dg/skills/agent-seed/**"
      - "plugins/dg/skills/bot-commit-email/**"
      - "plugins/dg/skills/catchup/**"
      - "plugins/dg/skills/chat/**"
      - "plugins/dg/skills/channel-review/**"
      - "plugins/dg/skills/clipboard-img/**"
      - "plugins/dg/skills/cls/**"
      - "plugins/dg/skills/db/**"
      - "plugins/dg/skills/deps-upgrade/**"
      - "plugins/dg/skills/doctor/**"
      - "plugins/dg/skills/eli5/**"
      - "plugins/dg/skills/erd/**"
      - "plugins/dg/skills/file/**"
      - "plugins/dg/skills/find-work/**"
      - "plugins/dg/skills/google-sms-cleanup/**"
      - "plugins/dg/skills/hook-comment-disable/**"
      - "plugins/dg/skills/hooks/**"
      - "plugins/dg/skills/hunt/**"
      - "plugins/dg/skills/inbox-cleanup/**"
      - "plugins/dg/skills/meaningful/**"
      - "plugins/dg/skills/monolith/**"
      - "plugins/dg/skills/nope/**"
      - "plugins/dg/skills/proxy/**"
      - "plugins/dg/skills/pushup/**"
      - "plugins/dg/skills/rename-session/**"
      - "plugins/dg/skills/spring-break/**"
      - "plugins/dg/skills/standard-test/**"
      - "plugins/dg/skills/stash/**"
      - "plugins/dg/skills/teach/**"
      - "plugins/dg/skills/ticket/**"
      - "plugins/dg/skills/update/**"
      - "plugins/dg/skills/what-changed/**"
      - "plugins/dg/skills/worktree/**"
    agents:
      primary: "dg:lore"
  - id: 16
    name: "browser-mode-flag"
    depends_on: []
    files:
      - "pkg/skills-cli/src/pw/cli.ts"
      - "pkg/skills-cli/src/pw/core/dispatch.ts"
      - "pkg/skills-cli/src/pw/core/spec.ts"
      - "pkg/skills-cli/src/pw/browser-mode.ts"
      - "pkg/skills-cli/__tests__/pw-browser-mode.spec.ts"
      - "pkg/common/src/node/dg-toml.ts"
      - "pkg/common/__tests__/dg-toml.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 17
    name: "ext-verbs-navigation"
    depends_on: []
    files:
      - "pkg/extension/lib/background/pw-verbs/navigation.ts"
      - "pkg/extension/__tests__/pw-verbs-navigation.spec.ts"
      - "pkg/common/src/pw-ext-verbs/navigation.ts"
      - "pkg/common/__tests__/pw-ext-verbs-navigation.spec.ts"
      - "pkg/skills-cli/src/pw/ext-verbs/navigation.ts"
      - "pkg/skills-cli/__tests__/pw-ext-verbs-navigation.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 18
    name: "ext-verbs-pointer"
    depends_on: []
    files:
      - "pkg/extension/lib/background/pw-verbs/pointer.ts"
      - "pkg/extension/__tests__/pw-verbs-pointer.spec.ts"
      - "pkg/common/src/pw-ext-verbs/pointer.ts"
      - "pkg/common/__tests__/pw-ext-verbs-pointer.spec.ts"
      - "pkg/skills-cli/src/pw/ext-verbs/pointer.ts"
      - "pkg/skills-cli/__tests__/pw-ext-verbs-pointer.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 19
    name: "ext-verbs-input"
    depends_on: []
    files:
      - "pkg/extension/lib/background/pw-verbs/input.ts"
      - "pkg/extension/__tests__/pw-verbs-input.spec.ts"
      - "pkg/common/src/pw-ext-verbs/input.ts"
      - "pkg/common/__tests__/pw-ext-verbs-input.spec.ts"
      - "pkg/skills-cli/src/pw/ext-verbs/input.ts"
      - "pkg/skills-cli/__tests__/pw-ext-verbs-input.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 20
    name: "ext-verbs-page"
    depends_on: []
    files:
      - "pkg/extension/lib/background/pw-verbs/page.ts"
      - "pkg/extension/__tests__/pw-verbs-page.spec.ts"
      - "pkg/common/src/pw-ext-verbs/page.ts"
      - "pkg/common/__tests__/pw-ext-verbs-page.spec.ts"
      - "pkg/skills-cli/src/pw/ext-verbs/page.ts"
      - "pkg/skills-cli/__tests__/pw-ext-verbs-page.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 21
    name: "ext-verbs-storage"
    depends_on: []
    files:
      - "pkg/extension/lib/background/pw-verbs/storage.ts"
      - "pkg/extension/__tests__/pw-verbs-storage.spec.ts"
      - "pkg/common/src/pw-ext-verbs/storage.ts"
      - "pkg/common/__tests__/pw-ext-verbs-storage.spec.ts"
      - "pkg/skills-cli/src/pw/ext-verbs/storage.ts"
      - "pkg/skills-cli/__tests__/pw-ext-verbs-storage.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:security"
  - id: 22
    name: "ext-agent-window"
    depends_on: []
    files:
      - "pkg/extension/lib/background/agent-window.ts"
      - "pkg/extension/lib/background/site-allow-prompt.ts"
      - "pkg/extension/entrypoints/site-allow/**"
      - "pkg/extension/__tests__/agent-window.spec.ts"
      - "pkg/extension/__tests__/site-allow-prompt.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:security"
  - id: 23
    name: "relay-contract"
    depends_on: []
    files:
      - "docs/relay-protocol.md"
      - "pkg/common/fixtures/relay/**"
      - "pkg/common/__tests__/relay-fixtures.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 24
    name: "plugin-contract"
    depends_on: []
    files:
      - "docs/plugin-protocol.md"
      - "pkg/common/src/plugins/manifest.ts"
      - "pkg/common/src/plugins/contract.ts"
      - "pkg/common/src/plugins/config.ts"
      - "pkg/common/fixtures/plugins/**"
      - "pkg/common/__tests__/plugins-manifest.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 25
    name: "cs-scaffold"
    depends_on: []
    files:
      - "native/Dg.slnx"
      - "native/global.json"
      - "native/Directory.Build.props"
      - "native/Directory.Packages.props"
      - "native/.editorconfig"
      - "native/src/**/*.csproj"
      - "native/tests/**/*.csproj"
      - "native/bench/**/*.csproj"
      - "native/tools/**/*.csproj"
      - "native/tests/Directory.Build.props"
      - "native/src/Dg.Core/Abstractions/**"
      - "native/src/Dg.Core/Errors/**"
      - "native/src/Dg.Core/Output/**"
      - "native/src/Dg.Cli/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 26
    name: "ci-lean-gates"
    depends_on:
      - 1
      - 2
      - 3
      - 4
    files:
      - ".github/workflows/compiled-dg.yml"
      - "docs/lean-baseline.md"
    agents:
      primary: "dg:devops"
      qa:
        - "dg:qa-perf"
  - id: 27
    name: "build-report"
    depends_on:
      - 5
    files:
      - "pkg/launcher/build/report.ts"
      - "pkg/launcher/__tests__/build-report.spec.ts"
      - "scripts/size-diff.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 28
    name: "build-bytecode"
    depends_on:
      - 5
    files:
      - "pkg/launcher/build/compile.ts"
      - "pkg/launcher/__tests__/build-compile.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-perf"
  - id: 29
    name: "build-companions"
    depends_on:
      - 5
    files:
      - "pkg/launcher/build/companions.ts"
      - "pkg/launcher/__tests__/build-companions.spec.ts"
      - "pkg/common/src/node/companion.ts"
      - "pkg/common/__tests__/companion.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 30
    name: "dispatch-wire"
    depends_on:
      - 6
      - 7
      - 8
    files:
      - "pkg/launcher/src/dispatch.ts"
      - "pkg/launcher/__tests__/dispatch-fast.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-perf"
  - id: 31
    name: "delta-patches"
    depends_on:
      - 9
    files:
      - ".github/workflows/release-patches.yml"
      - "pkg/skills-cli/src/install/patch.ts"
      - "pkg/skills-cli/src/install/compiled.ts"
      - "pkg/skills-cli/__tests__/install-patch.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-devops"
        - "dg:security"
  - id: 32
    name: "cs-core-config"
    depends_on:
      - 25
    files:
      - "native/src/Dg.Core/Paths/**"
      - "native/src/Dg.Core/Config/**"
      - "native/src/Dg.Core/Credentials/**"
      - "native/tests/Dg.Core.Tests/Paths/**"
      - "native/tests/Dg.Core.Tests/Config/**"
      - "native/tests/Dg.Core.Tests/Credentials/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 33
    name: "cs-hooks-engine"
    depends_on:
      - 25
    files:
      - "native/src/Dg.Hooks/Engine/**"
      - "native/src/Dg.Hooks/HooksServiceCollectionExtensions.cs"
      - "native/src/Dg.Hooks/Defs/*/Registration.cs"
      - "native/tests/Dg.Hooks.Tests/Engine/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 34
    name: "cs-routing-version"
    depends_on:
      - 25
    files:
      - "native/src/Dg.Routing/**"
      - "native/tests/Dg.Routing.Tests/**"
      - "scripts/native-routes.ts"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 35
    name: "cs-completion"
    depends_on:
      - 25
    files:
      - "native/src/Dg.Completion/**"
      - "native/tests/Dg.Completion.Tests/**"
      - "scripts/native-completion.ts"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 36
    name: "cs-ci"
    depends_on:
      - 25
    files:
      - ".github/workflows/native.yml"
    agents:
      primary: "dg:devops"
      qa:
        - "dg:qa-devops"
  - id: 37
    name: "plugin-cli-bun"
    depends_on:
      - 24
      - 8
    files:
      - "pkg/skills-cli/src/plugin/**"
      - "pkg/skills-cli/src/commands/plugin.ts"
      - "pkg/skills-cli/src/register-all.ts"
      - "pkg/skills-cli/src/completion/tree.json"
      - "pkg/skills-cli/__tests__/plugin-*.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:security"
  - id: 38
    name: "bun-transport-http"
    depends_on:
      - 24
    files:
      - "pkg/common/src/plugins/transport/http.ts"
      - "pkg/common/__tests__/plugins-transport-http.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 39
    name: "bun-transport-ipc"
    depends_on:
      - 24
    files:
      - "pkg/common/src/plugins/transport/ipc.ts"
      - "pkg/common/src/plugins/transport/framing.ts"
      - "pkg/common/__tests__/plugins-transport-ipc.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 40
    name: "hook-plugins-bun"
    depends_on:
      - 24
      - 7
      - 38
      - 39
    files:
      - "pkg/skills-cli/src/hooks/plugins.ts"
      - "pkg/skills-cli/src/hooks/external.ts"
      - "pkg/skills-cli/src/hooks/run.ts"
      - "pkg/skills-cli/__tests__/hooks-plugins.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:security"
  - id: 41
    name: "job-plugins-bun"
    depends_on:
      - 24
    files:
      - "pkg/dg-daemon/src/jobs/plugin-manifest.ts"
      - "pkg/dg-daemon/src/jobs/sources.ts"
      - "pkg/dg-daemon/__tests__/jobs/plugin-manifest.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 42
    name: "cs-plugin-contract"
    depends_on:
      - 25
      - 24
    files:
      - "native/src/Dg.Core/Plugins/Contract/**"
      - "native/src/Dg.Core/Plugins/Manifest/**"
      - "native/tests/Dg.Core.Tests/Plugins/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 43
    name: "ext-verbs-wire"
    depends_on:
      - 16
      - 17
      - 18
      - 19
      - 20
      - 21
      - 22
    files:
      - "pkg/common/src/pw-ext-format.ts"
      - "pkg/common/__tests__/pw-ext-format.spec.ts"
      - "pkg/skills-cli/src/pw/ext.ts"
      - "pkg/skills-cli/__tests__/pw-ext.spec.ts"
      - "pkg/extension/lib/background/pw-ext.ts"
      - "pkg/extension/lib/background/relay-dispatch.ts"
      - "pkg/extension/__tests__/pw-ext.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 44
    name: "cs-hooks-pr"
    depends_on:
      - 33
      - 32
    files:
      - "native/src/Dg.Hooks/Defs/Pr/**"
      - "native/tests/Dg.Hooks.Tests/Pr/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 45
    name: "cs-hooks-text"
    depends_on:
      - 33
      - 32
    files:
      - "native/src/Dg.Hooks/Defs/Text/**"
      - "native/tests/Dg.Hooks.Tests/Text/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 46
    name: "cs-hooks-repo"
    depends_on:
      - 33
      - 32
    files:
      - "native/src/Dg.Hooks/Defs/Repo/**"
      - "native/tests/Dg.Hooks.Tests/Repo/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 47
    name: "cs-config-group"
    depends_on:
      - 32
    files:
      - "native/src/Dg.Config/**"
      - "native/tests/Dg.Config.Tests/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 48
    name: "cs-transport-http"
    depends_on:
      - 42
    files:
      - "native/src/Dg.Core/Transport/Http/**"
      - "native/tests/Dg.Core.Tests/Transport/Http/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 49
    name: "cs-transport-ipc"
    depends_on:
      - 42
    files:
      - "native/src/Dg.Core/Transport/Ipc/**"
      - "native/src/Dg.Core/Transport/Framing/**"
      - "native/src/Dg.Core/Transport/Pool/**"
      - "native/tests/Dg.Core.Tests/Transport/Ipc/**"
      - "native/tests/Dg.Core.Tests/Transport/Framing/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 50
    name: "cs-transport-tcp"
    depends_on:
      - 49
    files:
      - "native/src/Dg.Core/Transport/Tcp/**"
      - "native/tests/Dg.Core.Tests/Transport/Tcp/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 51
    name: "cs-transport-udp"
    depends_on:
      - 42
    files:
      - "native/src/Dg.Core/Transport/Udp/**"
      - "native/tests/Dg.Core.Tests/Transport/Udp/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 52
    name: "cs-transport-msgpack"
    depends_on:
      - 49
    files:
      - "native/src/Dg.Core/Transport/Encoding/MessagePack/**"
      - "native/tests/Dg.Core.Tests/Transport/Encoding/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 53
    name: "cs-native-gates"
    depends_on:
      - 36
    files:
      - ".github/workflows/native.yml"
      - "native/tools/Dg.SizeReport/**"
      - "native/budgets/**"
      - "scripts/native-ram-budget.ts"
    agents:
      primary: "dg:devops"
      qa:
        - "dg:qa-devops"
  - id: 54
    name: "cs-plugin-bench"
    depends_on:
      - 48
      - 49
    files:
      - "native/bench/Dg.Bench/**"
      - ".github/workflows/native-bench.yml"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 55
    name: "cs-plugins-runtime"
    depends_on:
      - 48
      - 49
      - 50
      - 51
      - 32
    files:
      - "native/src/Dg.Core/Plugins/Runtime/**"
      - "native/tests/Dg.Core.Tests/Plugins/Runtime/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:qa-code"
  - id: 56
    name: "cs-plugins-group"
    depends_on:
      - 55
      - 32
    files:
      - "native/src/Dg.Plugins/**"
      - "native/tests/Dg.Plugins.Tests/**"
    agents:
      primary: "dg:csharp"
      qa:
        - "dg:security"
        - "dg:qa-code"
  - id: 57
    name: "companion-release"
    depends_on:
      - 29
      - 31
    files:
      - ".github/workflows/release.yml"
      - "pkg/skills-cli/src/install/companion.ts"
      - "pkg/skills-cli/src/install/compiled.ts"
      - "pkg/skills-cli/__tests__/install-companion.spec.ts"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-devops"
        - "dg:security"
  - id: 58
    name: "browser-docs-skills"
    depends_on:
      - 43
    files:
      - "docs/pw.md"
      - "docs/browser.md"
      - "docs/config.md"
      - "docs/demo-and-proto.md"
      - "docs/verify.md"
      - "plugins/dg/skills/pw/**"
      - "plugins/dg/skills/verify/**"
      - "plugins/dg/skills/demo/**"
      - "plugins/dg/skills/proto/**"
      - "plugins/dg/skills/test-live/**"
    agents:
      primary: "dg:lore"
  - id: 59
    name: "cs-cli-compose"
    depends_on:
      - 34
      - 35
      - 36
      - 44
      - 45
      - 46
      - 47
      - 56
      - 23
    files:
      - "native/src/Dg.Cli/**"
      - "native/tests/Dg.Parity.Tests/**"
    agents:
      primary: "dg:csharp"
      effort: "xhigh"
      qa:
        - "dg:qa-perf"
        - "dg:qa-code"
  - id: 60
    name: "skill-size-cap"
    depends_on:
      - 3
      - 11
      - 12
      - 13
      - 14
      - 15
      - 58
    files:
      - "pkg/skills-test/__tests__/skill-size-cap.spec.ts"
      - "scripts/skill-token-budgets.json"
    agents:
      primary: "dg:js"
      qa:
        - "dg:qa-code"
  - id: 61
    name: "two-binary-install"
    depends_on:
      - 59
      - 57
      - 10
    files:
      - ".github/workflows/release.yml"
      - "pkg/skills-cli/src/install/front-door.ts"
      - "pkg/skills-cli/src/install/compiled.ts"
      - "pkg/skills-cli/bootstrap.sh"
      - "pkg/skills-cli/bootstrap.ps1"
      - "pkg/skills-cli/__tests__/install-front-door.spec.ts"
    agents:
      primary: "dg:js"
      effort: "xhigh"
      qa:
        - "dg:qa-devops"
        - "dg:security"
  - id: 62
    name: "lean-docs"
    depends_on:
      - 61
      - 26
    files:
      - "docs/install.md"
      - "docs/DEVELOPER.md"
      - "docs/AGENT-INSTALL.md"
      - "README.md"
      - "CHANGELOG.md"
    agents:
      primary: "dg:lore"
---

## === school pointers ===

- /home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/school/security.md
- /home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/school/performance.md
- /home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/school/infrastructure.md
- /home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/school/engineering.md
- /home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/school/quality.md
- /home/detailedghost/code/worktrees/dg-ai-spec-027/.agents/school/tooling.md

## Slice Summaries
