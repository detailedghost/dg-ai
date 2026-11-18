---
feature: "Shared runtime and bundle"
feature_snake_case: shared_runtime_bundle
date: "2026-10-29"
version: "1.0"
status: complete
current_slice: 3
pr_strategy: single
slices:
  - id: 1
    name: "program-entries-lazy"
    agents:
      primary: dg:js
      effort: xhigh
      qa: [dg:qa-code, dg:qa-perf, dg:reviewer]
    depends_on: []
    files: ["pkg/skills-cli/src/index.ts", "pkg/skills-cli/src/main.ts", "pkg/skills-cli/src/commands/**", "pkg/skills-cli/src/utils/legacy-command.ts", "pkg/skills-cli/src/utils/lazy-command.ts", "pkg/skills-cli/__tests__/lazy-commands.spec.ts", "pkg/skills-cli/__tests__/self-command.spec.ts", "pkg/dg-agent/src/index.ts", "pkg/dg-agent/src/main.ts", "pkg/dg-agent/src/start.ts", "pkg/dg-agent/src/phone/migrate.ts", "pkg/dg-agent/src/phone/commands.ts", "pkg/dg-agent/__tests__/**", "pkg/dg-daemon/src/index.ts", "pkg/dg-daemon/src/main.ts", "pkg/common/src/node/self-command.ts", "pkg/common/src/node/program.ts", "pkg/common/src/node/index.ts", "pkg/common/__tests__/program.spec.ts"]
  - id: 2
    name: "launcher-bundle-build"
    agents:
      primary: dg:js
      qa: [dg:qa-perf, dg:qa-devops]
    depends_on: [1]
    files: ["pkg/launcher/**", "pkg/skills-cli/build.ts", "pkg/skills-cli/package.json", "pkg/dg-agent/package.json", "pkg/dg-daemon/package.json", "pkg/skills-cli/__tests__/compiled-binary.ts", "pkg/skills-cli/__tests__/*-compiled.spec.ts", "pkg/skills-cli/__tests__/build.spec.ts", "package.json"]
  - id: 3
    name: "install-runtime-bundle"
    agents:
      primary: dg:js
      qa: [dg:qa-code, dg:security]
    depends_on: [2]
    files: ["pkg/skills-cli/src/install/**", "pkg/skills-cli/src/commands/install.ts", "pkg/skills-cli/src/commands/phone-listener.ts", "pkg/skills-cli/src/utils/lib.ts", "pkg/skills-cli/src/utils/cli-only.ts", "pkg/skills-cli/src/doctor/shared.ts", "pkg/skills-cli/src/doctor/checks.ts", "pkg/skills-cli/__tests__/install*.spec.ts", "pkg/skills-cli/__tests__/cli-binary-lib.spec.ts", "pkg/skills-cli/__tests__/agent-only-install.spec.ts", "pkg/skills-cli/__tests__/phone-refresh.spec.ts", "pkg/skills-cli/__tests__/fake-cli.ts", "pkg/skills-cli/__tests__/fake-cli.spec.ts"]
  - id: 4
    name: "bootstrap-release-smoke"
    agents:
      primary: dg:devops
      qa: [dg:qa-devops, dg:security]
    depends_on: [2]
    files: ["pkg/skills-cli/bootstrap.sh", "pkg/skills-cli/bootstrap.ps1", ".github/workflows/release.yml", ".github/workflows/skills-blt.yml", ".github/workflows/dg-agent-blt.yml", ".github/workflows/dg-daemon-blt.yml", "scripts/bump-runtime.ts", "scripts/release-version.ts", "pkg/skills-test/__tests__/binary-distribution.spec.ts", "pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts", "pkg/skills-test/__tests__/release-workflow.spec.ts", "pkg/skills-test/__tests__/release-listing.spec.ts", "pkg/skills-test/__tests__/retired-binaries.spec.ts", "pkg/skills-test/__tests__/fetch-cli-binary-busy.spec.ts", "pkg/skills-test/__tests__/install-logic.spec.ts", "pkg/skills-test/__tests__/supported-platforms.ts", "pkg/skills-test/__tests__/cli-smoke.spec.ts", "pkg/skills-test/__tests__/dependency-pinning.spec.ts"]
  - id: 5
    name: "docs-adr-e"
    agents:
      primary: dg:lore
    depends_on: [3, 4]
    files: ["docs/install.md", "docs/AGENT-INSTALL.md", "docs/DEVELOPER.md", "docs/adr/0024-shared-runtime-bundle.md", "docs/adr/toc.md", "README.md", ".mise/config.toml"]
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# Shared runtime and bundle

## Purpose
Replace the three compiled 78-93 MB binaries with one pinned Bun runtime installed once and one minified, code-split JS bundle per release, reached through three launcher names (dg-skills, dg-agent, dg-daemon) that dispatch on the invoked name. Every command loads only its own code, so `dg-skills --version` runs under 50 ms. The install footprint drops from about 250 MB to about 90 MB and the release asset list drops from 18 platform binaries to one platform-independent tarball plus a runtime pin.

## Scope
### Included
- pkg/launcher: dispatcher entry dg.js, bundle build with splitting and minify, runtime pin (runtime.json), shim templates
- Lazy command registration in pkg/skills-cli (wrappers import their feature inside the action) and a static test that enforces it
- main(argv) exports for dg-skills, dg-agent, dg-daemon; program name recorded for selfCommand
- dg-skills install: fetch runtime (verified) and bundle (verified), link current, write shims, retire the compiled binaries
- bootstrap.sh and bootstrap.ps1 install the runtime, the bundle and the shims
- release.yml: one bundle asset, runtime.json asset, per-OS smoke matrix running the bundle on the pinned runtime
- Startup budget test and size budget test on the built bundle
- ADR 0024 and docs
### Excluded
- Per-OS directory layout (PR F); PR E keeps ${DG_HOME:-~/.dg} so the diff stays small
- New commands or skills (PR A, C, D)
- Changing hook or unit command shapes beyond what the shims require

### Slice 1 — program-entries-lazy

#### Engineering
- [x] Export `main(argv: string[]): Promise<number>` from pkg/skills-cli/src/main.ts, pkg/dg-agent/src/main.ts, pkg/dg-daemon/src/main.ts; each index.ts keeps only `if (import.meta.main) process.exit(await main(process.argv.slice(2)))`
- [x] skills main: fast path returns the version when argv is exactly ["--version"] before importing commander
- [x] Rewrite every pkg/skills-cli/src/commands/*.ts wrapper so its only static imports are `commander` types, `../utils/lazy-command` and `../utils/legacy-command`; feature modules load with `await import()` inside the action
- [x] Add registerLazyRaw(program, {name, description, load}) and registerLazyLegacy(program, {name, description, load}) to pkg/skills-cli/src/utils/lazy-command.ts; both forward the handler exit code unchanged
- [x] registerDoctor loads ../doctor/registry inside the action so --help never evaluates feature doctor modules
- [x] dg-agent: phone command group registers its verbs eagerly but imports ./phone/* (nostr-tools) inside each action
- [x] pkg/common/src/node/program.ts: setProgramName(name) / programName(); selfCommand inserts the recorded name after the entry file when running from a bundle; programCommand(name, args) returns [runtimeBin, entry, name, ...args] for a sibling program
- [x] pkg/dg-agent/src/start.ts siblingDaemonArgv and pkg/dg-agent/src/phone/migrate.ts resolveDaemonExecutable/runDaemonJobCli use programCommand("dg-daemon", ...) instead of dirname(process.execPath)
- [x] Phone listener argv for units and detached listeners comes from launcherCommand(root, "dg-agent", args) = [<root>/runtime/current/bun, <root>/lib/current/dg.js, "dg-agent", ...args] (stable across upgrades)

#### Testing Criteria
##### Contracts
- [x] Contract: main(argv) of each program returns the exit code and never calls process.exit
- [x] Contract: selfCommand(["bg","drain","x"]) in bundle mode is [bun, dg.js, "dg-skills", "bg", "drain", "x"]; in source mode it is [bun, index.ts, "bg", "drain", "x"]
- [x] Contract: programCommand("dg-daemon", ["__serve"]) spawns the same-version sibling (Bun realpaths Bun.main); only launcherCommand(root, name, args) yields the stable current path
- [x] lazy-commands.spec.ts: every file in src/commands/ has no static value import outside commander, ../utils/lazy-command, ../utils/legacy-command, ../utils/cli-only
- [x] lazy-commands.spec.ts: `bun run src/index.ts --help` output lists the same command names as before (golden list)
- [x] self-command.spec.ts: bundle mode detection uses the recorded program name, not Bun.main suffix
- [x] grep gate: no `spawn(cliDest(` or `spawnSync(cliDest(` outside __tests__ (every in-tree spawn uses programCommand)
- [x] dg-agent tests: start spawns [bun, dg.js, dg-daemon, __serve] when programName is set; autostart unit argv starts with the runtime/current path

#### Acceptance Criteria
- [x] Given a source checkout, when `bun run pkg/skills-cli/src/index.ts --help` runs, then it prints every command and imports no feature module (verified by lazy-commands.spec.ts)
- [x] Given the three packages, when `bun run lint` and `bun test` run in each, then they pass
- [x] Given dg-agent start in bundle mode, when the daemon is not live, then it spawns programCommand("dg-daemon", ["__serve"])

### Slice 2 — launcher-bundle-build

#### Engineering
- [x] New workspace package pkg/launcher (@dg/launcher): src/dg.ts dispatcher, build.ts, runtime.json, shims/dg.sh and shims/dg.cmd templates, __tests__
- [x] src/dg.ts: PROGRAMS table of three lazy imports; unknown name exits 64 with the list of names; calls setProgramName before loading
- [x] build.ts: Bun.build({ entrypoints: [src/dg.ts], target: "bun", splitting: true, minify: true, outdir: dist/lib, naming: { chunk: "chunks/[name]-[hash].js" }, external: ["chromium-bidi", "chromium-bidi/*"], plugins: [playwrightMetadata], define: DG_BUILD_SHA }); then tar+gzip dist/lib into dist/dg-lib-<version>.tar.gz
- [x] pkg/skills-cli/build.ts exports playwrightMetadata and hashBundle only; the --compile path is removed; package.json build scripts of skills-cli, dg-agent, dg-daemon become `bun run --cwd ../launcher build`
- [x] runtime.json: { version: "1.4.1", assets: { "linux-x64": {file, sha256}, "linux-x64-baseline", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64", "windows-x64-baseline", "windows-arm64" } } with sha256 copied from Bun's SHASUMS256.txt
- [x] __tests__/compiled-binary.ts becomes bundle-build.ts: builds dist/lib once per test run and returns { bun: process.execPath, entry: dist/lib/dg.js }; every *-compiled.spec.ts runs [bun, entry, "dg-skills", ...args]
- [x] startup-budget.spec.ts: median of 7 warm runs of [bun, dg.js, <program>, "--version"] under 50 ms times DG_BUDGET_SCALE (default 1; CI sets 3)
- [x] size-budget.spec.ts: dg.js <= 16 KB and has no static import; dist/lib total <= 12 MB; tarball <= 4 MB; a chunk named pw/inbox/playwright is not loaded by `--help` (checked with BUN_JSC trace of loaded files or by instrumented import log)

#### Testing Criteria
##### Contracts
- [x] Contract: `bun dist/lib/dg.js dg-skills --version` prints the stamped version and exits 0
- [x] Contract: `bun dist/lib/dg.js nope` exits 64 and names the three programs
- [x] Contract: `bun dist/lib/dg.js dg-skills stash --help` exits 0 and the inbox and playwright chunks stay unread
- [x] startup-budget.spec.ts: dg-skills, dg-agent, dg-daemon --version medians under budget
- [x] size-budget.spec.ts: thresholds above
- [x] build.spec.ts: the bundle contains the playwright-core package.json and browsers.json replacement (plugin applied)
- [x] every existing *-compiled.spec.ts passes against the bundle

#### Acceptance Criteria
- [x] Given a clean checkout, when `bun run --cwd pkg/launcher build` runs, then dist/lib/dg.js, dist/lib/chunks/*.js and dist/dg-lib-<version>.tar.gz exist
- [x] Given the built bundle on the pinned runtime, when `dg.js dg-skills --version` runs 7 times, then the median is under 50 ms on the developer machine
- [x] Given the built bundle, when `dg.js dg-agent phone --help` runs, then nostr-tools chunk loads and the inbox chunk does not

### Slice 3 — install-runtime-bundle

#### Engineering
- [x] pkg/skills-cli/src/install/runtime.ts: ensureRuntime(pin) downloads bun-<platform>.zip from github.com/oven-sh/bun/releases/download/bun-v<version>/, verifies sha256 from runtime.json, extracts to <root>/runtime/bun-v<version>/, links <root>/runtime/current (symlink; junction on Windows); baseline variant when /proc/cpuinfo lacks avx2 on linux-x64 or the zip name says baseline
- [x] pkg/skills-cli/src/install/bundle.ts: fetchBundle(release) downloads dg-lib-<version>.tar.gz, verifies against SHA256SUMS, extracts to <root>/lib/<version>.staging, runs [bun, staging/dg.js, dg-skills, --version] as a self-check, renames to <root>/lib/<version>, relinks <root>/lib/current, keeps the previous version directory and removes older ones
- [x] pkg/skills-cli/src/install/shims.ts: writeShims(root) writes bin/dg-skills, bin/dg-agent, bin/dg-daemon (POSIX sh, mode 0755) or bin/*.cmd (Windows) with absolute paths to runtime/current and lib/current; replaces a compiled binary of the same name after the shim is staged
- [x] commands/install.ts: installCli/installPinnedAll/installCliOnly/installAgentOnly install the bundle and runtime instead of per-binary assets; `--version` of a release without dg-lib-* fails before any change with 'releases before <first E version> ship compiled binaries; run that release's bootstrap.sh'
- [x] lib.ts: cliDest(name) returns the shim path (.cmd on win32); cliVersionFile is replaced by readCurrentVersion(root) which reads the lib/current link target; RETIRED_BINARIES logic removes the three compiled binaries and .dg-*.version files
- [x] phone-listener.ts refreshPhoneListener spawns programCommand("dg-agent", ["phone", "__refresh"]) so Windows does not spawn a .cmd directly
- [x] doctor shared: version-match compares the lib/current version with the plugin version; new check runtime-present (runtime/current/bun exists and runs --version)

#### Testing Criteria
##### Contracts
- [x] Contract: ensureRuntime with a matching installed version downloads nothing and returns the existing path
- [x] Contract: ensureRuntime rejects a zip whose sha256 differs from runtime.json and leaves runtime/current untouched
- [x] Contract: fetchBundle leaves lib/current pointing at the old version when the self-check exits non-zero and removes the staging dir
- [x] Contract: writeShims output on linux equals the golden shim text with the root substituted
- [x] install.spec.ts: a full install on a fake release server ends with bin/dg-skills (shim), lib/current -> lib/<version>, runtime/current -> runtime/bun-v<pin>, and no compiled dg-skills file
- [x] install-version-pin.spec.ts: --version <pre-E> fails with the documented message and changes nothing
- [x] phone-refresh.spec.ts: refresh spawns programCommand argv
- [x] retired binaries: an existing compiled dg-daemon is removed after the shim exists

#### Acceptance Criteria
- [x] Given a machine with compiled 1.26.0 binaries, when `bootstrap.sh` runs for the first E release, then ~/.dg/bin/dg-skills is a shim, `dg-skills --version` prints the new version and the phone listener is refreshed
- [x] Given an E install, when `dg-skills install --version <previous E release>` runs, then lib/current relinks to that version with no download if the directory still exists
- [x] Given a WSL or Linux x64 host without avx2, when the runtime installs, then the baseline zip is chosen

### Slice 4 — bootstrap-release-smoke

#### Engineering
- [x] bootstrap.sh: resolve release; download runtime.json from it; pick bun asset by uname (linux/darwin x x64/aarch64, baseline when no avx2); download bun zip from oven-sh, verify sha256 against runtime.json, unzip to runtime/bun-v<v>, link current; download dg-lib-<v>.tar.gz, verify against SHA256SUMS, extract to lib/<v>, link current; write the three shims; then run `bin/dg-skills install <mode flags>`
- [x] bootstrap.ps1: same flow with Expand-Archive, Get-FileHash, New-Item -ItemType Junction, .cmd shims, and a one-time user PATH append of the bin dir
- [x] release.yml: replace build-skills/build-daemon/build-agent (18 artifacts) with build-bundle (one job, uploads dg-lib-<v>.tar.gz and runtime.json); smoke matrix of six OS runners installs the pinned runtime, extracts the tarball and runs `dg.js dg-skills --version`, `dg-agent --version`, `dg-daemon --version`; publish step uploads bundle, runtime.json, bootstrap scripts, extension zips, SHA256SUMS
- [x] scripts/bump-runtime.ts <version>: downloads Bun's SHASUMS256.txt for that tag, rewrites pkg/launcher/runtime.json, updates .mise bun pin and setup-bun versions in workflows; CI test fails when they disagree
- [x] skills-test: binary-distribution.spec.ts becomes bundle-distribution checks (one build job, smoke matrix covers every supported platform); bootstrap-asset-selection.spec.ts drives the new bootstrap against a stub curl that serves runtime.json, the bun zip, the tarball and SHA256SUMS; retired-binaries covers the three compiled names

#### Testing Criteria
##### Contracts
- [x] Contract: bootstrap.sh exits 1 with 'checksum mismatch' when the bun zip hash differs and leaves no runtime/current
- [x] Contract: bootstrap.sh exits 1 when dg-lib-<v>.tar.gz is absent from SHA256SUMS
- [x] Contract: bootstrap.sh picks bun-linux-x64-baseline.zip when the cpu flags lack avx2
- [x] bootstrap-asset-selection.spec.ts: default, --cli-only, --agent-only, --skills-only, --version paths each end by invoking the shim with the right install flags
- [x] release-workflow.spec.ts: release.yml has one build-bundle job, a six-OS smoke matrix, and publishes exactly the documented asset names
- [x] dependency-pinning.spec.ts: runtime.json version equals .mise bun pin and every setup-bun bun-version in workflows
- [x] cli-smoke.spec.ts: the smoke step runs --version for all three programs

#### Acceptance Criteria
- [ ] Given a release built by the new workflow, when `curl … bootstrap.sh | sh` runs on linux-x64, macos-arm64 and WSL, then `dg-skills --version` prints the release version
- [x] Given `bun scripts/bump-runtime.ts 1.4.2`, when it finishes, then runtime.json, .mise/config.toml and the workflows agree and the test suite passes
- [ ] Given the release page, when a user lists assets, then they see dg-lib-<v>.tar.gz, runtime.json, bootstrap.sh, bootstrap.ps1, two extension zips and SHA256SUMS only

### Slice 5 — docs-adr-e

#### Engineering
- [x] docs/install.md: new layout (runtime/, lib/, bin/ shims), upgrade note for compiled-binary users (re-run bootstrap once), rollback section (`install --version`, manual relink), runtime bump section
- [x] docs/DEVELOPER.md: pkg/launcher build, startup and size budgets, how to add a lazy command
- [x] docs/adr/0024-shared-runtime-bundle.md from the template; toc.md entry
- [x] .mise/config.toml remote:install task copies the bundle and relinks current instead of copying a binary

#### Testing Criteria
##### Contracts
- [x] Contract: markdownlint and vale pass on the changed docs
- [x] skill-index-docs.spec.ts and doc-drift tests still pass

#### Acceptance Criteria
- [x] Given docs/adr/toc.md, when a reader opens it, then 0024 is listed as Accepted with a one-line summary

## Slice Summaries

- Slice 1 (b7ca32b7): main(argv) per program, lazy command wrappers in src/commands with features under src/<feature>/cli.ts, program.ts via @dg/common/node/program, exitAfterDrain (5 s bound) at every entry point, die() throws DieError mapped to its exit code, scan test bans process.exit outside async.ts. Tests: common 568, dg-agent 549, dg-daemon 341, inbox 341, skills-cli about 1,450 across split runs, all green; typecheck clean.
- Slice 2 (1e6efd34): pkg/launcher builds dg.js + split chunks (pw, inbox, nostr named entries) into dg-lib-<v>.tar.gz; sh/cmd shims; exitAfterDrain in leaf @dg/common/exit; compiled tests moved to the bundle; DG_BUILD_SHA for all programs. dist/lib 9.6 MB, tarball 2.5 MB, dg.js 744 B. --version medians: dg-skills 34.9 ms, dg-agent 39.2 ms, dg-daemon 37.6 ms vs empty-file floor 21-22 ms. Tests: launcher 24, common 568, dg-agent 549, dg-daemon 689, touched skills-cli specs 251; tsc clean.

## Agent Notes

- (security, orchestrator) An EDR alert (T1068) fired on this machine during the build. Tests must not overwrite a running executable, must not launch a real Windows browser or open a remote-debugging port, and must not run PowerShell security queries. Swap files with an atomic rename. Prefer injected seams (DG_CURL, DG_UNAME, DG_CPUINFO_FILE style) over new stub programs on PATH; keep the existing bootstrap PATH stubs only where no seam exists.

- (slice 1, orchestrator) launcherCommand signature is launcherCommand(root, name, args), as in the Code Structure block.
- (slice 1, orchestrator) program.ts is reached through a package.json subpath export `@dg/common/node/program`, never re-exported from the `@dg/common/node` barrel (the barrel costs about 60 ms at startup). Tests import the subpath.
- (slice 1, orchestrator) setProgramName accepts `ProgramName | undefined`; tests reset with setProgramName(undefined). No separate reset helper.
- (slice 1, orchestrator) Once a program name is recorded, selfCommand in bundle mode returns programCommand(name, args) and ignores opts.entrypoint. Source mode with no recorded name keeps honoring opts.entrypoint.
- (slice 1, orchestrator) main(argv) returns an exit code and never calls process.exit; commander runs with exitOverride. An unknown command returns 1. dg-agent attach with no daemon returns 1 (EXIT_GENERAL_FAILURE).
- (slice 1, orchestrator) pkg/dg-agent/src/phone/commands.ts exports defaultListenerArgv(root, extra) as the test seam for the unit argv; a test asserts argv[0] is <root>/runtime/current/bun.
- (slice 1, orchestrator) The start-bundle test uses a spawn seam on StartSeams, not mock.module("node:child_process").
- (slice 1, orchestrator) The 36-name --help golden list is correct as captured.
- (slice 1, orchestrator) programCommand resolves to the versioned lib/<version>/dg.js because Bun realpaths Bun.main; that is intended (a running program spawns a sibling of the same version). Only launcherCommand(root, name, args) yields the stable current path, and every service unit and detached listener uses launcherCommand. The contract "programCommand uses the current links" is replaced by this rule.
- (slice 1, orchestrator) With no recorded program name, sibling spawn is broken until slice 2 dispatcher records it. Accepted: E merges as one PR and the compiled binaries are removed in the same PR.
- (slice 1, orchestrator) Every entry point and the slice 2 dispatcher exit through a shared @dg/common helper that waits for process.stdout and process.stderr to drain before process.exit(code). A test pipes over 1 MiB of a single stdout write through a slow reader and asserts every byte arrives. This fixes an existing truncation above 64 KiB.
- (slice 1, orchestrator) Slice 2 acceptance for the nostr-tools chunk uses `dg-agent phone status`, not `phone --help`: phone verbs register eagerly and import ./commands only inside an action.
- (slice 1, orchestrator) Long-lived commands keep main pending with forever() from @dg/common (dg-daemon __serve, prototype serve, verify serve --foreground); later PRs that add long-lived commands follow the same rule.
- (slice 1, dg:js) Bun.main and process.argv[1] are realpathed, so a current symlink never survives in argv; service units must use launcherCommand.
- (slice 1, dg:js) index.ts exits after main resolves, so a long-lived command keeps main pending with forever() from @dg/common (dg-daemon __serve, prototype serve, verify serve --foreground). Slice 2 dispatcher and PRs A-D follow the same rule.
- (slice 1, dg:js) Feature code moved from src/commands/ to src/<feature>/cli.ts; the aggregator is src/register-all.ts. credentials, channel-review and stat use registerLazyRaw plus runSubtree, so `dg-skills <name> --help` is complete but `dg-skills help <name>` shows only the shell help.
- (slice 1, dg:js) Startup for slice 2: source-mode `dg-skills --help` is about 83 ms. register-all -> utils/cli-only -> utils/lib still loads the 60 ms @dg/common/node barrel, and dg-agent/dg-daemon main load it through registerAgentCommands and registerMemoryCommands. Slice 2 must cut those paths to meet the 50 ms budget.
- (slice 2, orchestrator) Every test that built the --compile binary (bg, db, erd, monolith, prototype, spec, test-live, channel-review-connect *-compiled specs and proxy-fixtures.compileProxyCli) moves to bundleCommand("dg-skills") in this slice. Relocation cases copy the whole built lib dir into the quoted, spaced path and run it from there.
- (slice 2, orchestrator) One build define DG_BUILD_SHA replaces DG_SKILLS_BUILD_SHA; all three programs print it for --version, as today. The test asserts it equals `git rev-parse HEAD` at build time.
- (slice 2, orchestrator) The launcher build accepts --outdir; tests build into their own temp dir so parallel runs never share pkg/launcher/dist.
- (slice 2, orchestrator) pw, inbox and the phone (nostr) code are explicit build entry points, so their output files carry those names; the laziness test matches chunks by those names.
- (slice 2, orchestrator) The nostr laziness acceptance runs with a temp DG_HOME. If `dg-agent phone status` does not import the phone commands without an identity, use a verb that does and record which one in the test name.
- (slice 2, orchestrator) Startup budget is relative: the test measures an empty-file `bun <empty.js>` floor (`bun -e 0` skips module loading, about 4 ms) in the same run and asserts median(7 warm runs) of each program --version minus the floor median is under 20 ms (times DG_BUDGET_SCALE). Measured at slice 2: floor 28-33 ms, dg-skills --version 44-50 ms, dg-agent 45-53 ms. Never assert a lower quartile.
- (slice 2, orchestrator) dg-agent and dg-daemon main.ts import commander and their command modules only after the --version fast path, like dg-skills.
- (slice 2, orchestrator) exitAfterDrain lives in a leaf module with no other imports so dg.ts loads no shared chunk on --version or an unknown program name.
- (slice 2, orchestrator) skill-assets.spec runs its relocated-asset probe from the bundle, not from `bun build --compile`; the product has no compile path.
- (slice 2, dg:js) dg-agent and dg-daemon sit at about 17 ms over the floor against the 20 ms budget; keep their --version path free of new imports, and use DG_BUDGET_SCALE on a loaded CI runner.
- (slices 3-4, orchestrator) Confirmed signatures: ensureRuntime(root, pin): Promise<string> (bun path, realpath under runtime/bun-v<ver>), fetchBundle(root, release, runtimeBin) with release = PickedBundle {version, assetName, url, sumsUrl}, writeShims(root, platform = process.platform) synchronous (0755 sh shims; .cmd on win32, tested through the platform parameter), refreshPhoneListener(spawn = spawnSync) spawning programCommand("dg-agent", ["phone","__refresh"]) with timeout 8000. Old per-binary test cases are rewritten or removed.
- (slices 3-4, orchestrator) runtime.json is a release asset and is itself listed in SHA256SUMS; install and bootstrap verify runtime.json against SHA256SUMS before trusting the Bun zip sha256 inside it. dg-lib-<v>.tar.gz is verified against SHA256SUMS. A mismatch prints `checksum mismatch` and changes nothing.
- (slices 3-4, orchestrator) The Bun zip holds <file minus .zip>/bun and installs flat to runtime/bun-v<ver>/bun; the dg-lib tarball is flat (dg.js + chunks/) and extracts to lib/<v>. Bun comes from github.com/oven-sh/bun/releases/download/bun-v<ver>/<file>.
- (slices 3-4, orchestrator) CPU seam: both install and bootstrap.sh read the file named by DG_CPUINFO_FILE (default /proc/cpuinfo) and pick the -baseline Bun zip when no avx2 flag is present. Slice 3 adds tests for the baseline pick and for rollback (install --version <previous> relinks current with no download).
- (slices 3-4, orchestrator) bootstrap.sh modes: default -> dg-skills install; --cli-only -> install --cli-only; --agent-only -> install --agent-only; --skills-only -> install --skills-only; --version X -> install --version X. Both bootstrap and install replace old compiled bin/dg-skills|dg-agent|dg-daemon with shims and delete bin/.<name>.version stamps.
- (slices 3-4, orchestrator) .mise pins the full Bun x.y.z equal to runtime.json. bump-runtime.ts reads the SHASUMS URL from DG_BUN_SHASUMS_URL when set (tests serve a local file) and gets one test that runtime.json, .mise and the workflows agree after a bump.
- (slices 3-4, orchestrator) release.yml job names as the Red tests assume: build-bundle (no matrix), one smoke* job needing build-bundle with a six-entry os matrix, build-ext, release needing all three; published assets dg-lib-<v>.tar.gz, runtime.json, bootstrap.sh, bootstrap.ps1, SHA256SUMS, two extension zips.
- (slices 3-4, orchestrator) The skills-v bridge release is dropped (it ran once as skills-v1.22.0); remove its tests and the test blocks for removed install functions (cliAssetName, fetchCliBinary) once slice 3 removes that code. bootstrap.ps1 keeps static assertions; the Windows smoke runner covers behavior.
- (slices 3-4, orchestrator) Migration: a pre-E compiled dg-skills install cannot find E assets. Users upgrade once with `curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh`; slice 5 says so in docs/install.md and the release notes, and the pre-E install error (install-version-pin) names that command.
- (slices 3-4, orchestrator) A pre-E release is detected by the absence of a dg-lib-*.tar.gz asset, not by a hardcoded FIRST_BUNDLE_VERSION; remove that constant. The message still names the bootstrap.sh command.
- (slices 3-4, orchestrator) bootstrap.sh and bootstrap.ps1 keep the offline skills copy under DG_SKILLS_ONLY with DG_SKILLS_NO_CLI=1 (chain.spec.ts uses it). Slice 4 owns pkg/skills-cli/__tests__/skills-only-install.spec.ts and every bootstrap.sh test; they must pass at the end of this layer.
- (slices 3-4, orchestrator) Intermittent exit 137 kills of short child processes (mktemp) in bootstrap tests come from the sandbox (about 2 in 400 for a bare mktemp loop); rerun before treating one as a failure.

## Issues Remediation

## Decisions

- [DECIDED] Shape B: a pinned Bun runtime installed once under `<root>/runtime/`, never the user's own bun; one minified JS bundle per release under `<root>/lib/<version>/`. Not raw TS, not `--compile` binaries.
- [DECIDED] One program, three names. `<root>/bin/dg-skills|dg-agent|dg-daemon` stay the entry points. No SKILL.md, unit or hook path changes in this PR.
- [DECIDED] Lazy loading: each command imports only its own code; heavy deps (playwright-core, snowflake-sdk, @dg/inbox) load only for commands that use them.
- [DECIDED] `<root>` is `${DG_HOME:-~/.dg}` in this PR. PR F moves every path to the per-OS layout through one helper; keeping `~/.dg` here keeps E to the runtime change only, so `runtime/` and `lib/` are two more entries in F's helper instead of a second move.
- [DECIDED] `lib/current` and `runtime/current` are symlinks (directory junctions on Windows, which need no admin), replaced by create-then-rename. Rejected: pointer text files read by the shim, because units could not name a stable `dg.js` path.
- [DECIDED] Shims pass the program name as the first argument. Nothing derives it from `$0` (symlinks and Windows make `$0` unreliable).
- [DECIDED] Windows launchers are `.cmd` files. Programmatic callers never spawn a `.cmd`; they use `programCommand()` (bun + dg.js). A grep test fails on any `spawn(cliDest(` or `spawnSync(cliDest(` outside `__tests__`.
- [DECIDED] Startup target: `--version` median under 50 ms on the developer machine; CI multiplies the budget by `DG_BUDGET_SCALE` (3).
- [DECIDED] `chromium-bidi` stays external, as today.

## Measured baseline (Linux x64, v1.26.0) and targets

| Item | Today | After E |
| --- | --- | --- |
| dg-skills | 93.0 MB installed (97.6 MB asset) | shim, about 200 B |
| dg-agent, dg-daemon | 78.2 MB, 78.1 MB | shims |
| Bun runtime | embedded three times | 79.5 MB once, `runtime/bun-v1.4.1/` |
| JS code | 16.2 MB raw inside dg-skills | 9.3 MB minified, split into chunks |
| Install footprint | about 250 MB | about 90 MB (-64 %) |
| Release assets | 18 binaries + 2 zips + scripts + sums | 1 tarball (about 3 MB gz) + runtime.json + 2 zips + scripts + sums |
| `dg-skills --version` | 260-390 ms | under 50 ms |
| `dg-skills stash --help` | 294-348 ms | under 60 ms |
| `dg-agent --help` | 59-66 ms | under 50 ms |
| `dg-daemon --help` | 167 ms | under 60 ms |

Import costs from source (`bun -e "await import(x)"`): `commands/inbox.ts` 163 ms, `doctor/registry.ts` 94 ms, `@dg/common/node` barrel 59-62 ms, `playwright-core` 456 ms, `snowflake-sdk` 1946 ms, `commander` 18 ms, bun itself 7 ms. The 300 ms is module evaluation, not binary size: `dg-agent --help`, the same binary shape, takes 60 ms.

## Code Structure

```text
pkg/launcher/                                new workspace package @dg/launcher
  package.json                               build and test scripts; no runtime dependencies
  build.ts                                   Bun.build splitting+minify into dist/lib, then dist/dg-lib-<v>.tar.gz
  runtime.json                               pinned Bun version and per-platform zip sha256
  src/dg.ts                                  dispatcher: program name -> lazy import -> main(argv)
  src/programs/skills.ts                     re-exports main from @dg/skills-cli/main
  src/programs/agent.ts                      re-exports main from @dg/dg-agent/main
  src/programs/daemon.ts                     re-exports main from @dg/dg-daemon/main
  shims/dg.sh                                POSIX launcher template ({{ROOT}}, {{NAME}})
  shims/dg.cmd                               Windows launcher template
  __tests__/dispatch.spec.ts                 name routing, exit 64, program name recorded
  __tests__/startup-budget.spec.ts           median --version under budget for three programs
  __tests__/size-budget.spec.ts              dg.js size, chunk laziness, tarball size
  __tests__/build.spec.ts                    playwright metadata plugin applied to the bundle
pkg/common/src/node/program.ts               setProgramName, programName, programCommand, launcherCommand
pkg/common/src/node/self-command.ts          selfCommand inserts the recorded program name in bundle mode
pkg/skills-cli/src/main.ts                   export main(argv); --version fast path; builds the commander program
pkg/skills-cli/src/index.ts                  if (import.meta.main) process.exit(await main(argv))
pkg/skills-cli/src/utils/lazy-command.ts     registerLazyRaw, registerLazyLegacy
pkg/skills-cli/src/commands/*.ts             options declared eagerly, feature module imported in the action
pkg/skills-cli/src/install/runtime.ts        ensureRuntime(pin): download, sha256, extract, link current
pkg/skills-cli/src/install/bundle.ts         fetchBundle(release): download, verify, self-check, link current, keep previous
pkg/skills-cli/src/install/shims.ts          writeShims(root): three launchers with absolute paths
pkg/skills-cli/src/install/current.ts        readCurrent(root, kind), linkCurrent(root, kind, target)
pkg/skills-cli/build.ts                      exports playwrightMetadata and hashBundle; compile path removed
pkg/skills-cli/__tests__/bundle-build.ts     was compiled-binary.ts; builds dist/lib once per run
pkg/dg-agent/src/main.ts                     export main(argv); phone verbs import nostr-tools lazily
pkg/dg-daemon/src/main.ts                    export main(argv)
pkg/skills-cli/bootstrap.sh, bootstrap.ps1   install runtime, bundle and shims, then run install
.github/workflows/release.yml                build-bundle job, six-OS smoke matrix, new asset list
scripts/bump-runtime.ts                      refresh runtime.json from Bun's SHASUMS256.txt
docs/adr/0024-shared-runtime-bundle.md       ADR
```

Installed layout in this PR (PR F moves the roots):

```text
~/.dg/
  runtime/bun-v1.4.1/bun              pinned runtime (bun.exe on Windows)
  runtime/current -> bun-v1.4.1       symlink or junction
  lib/1.27.0/dg.js                    dispatcher, under 16 KB, no static imports
  lib/1.27.0/chunks/*.js              skills-*, agent-*, daemon-*, inbox-*, playwright-*, db-*, ...
  lib/current -> 1.27.0               symlink or junction; the previous version directory stays for rollback
  bin/dg-skills, dg-agent, dg-daemon  POSIX sh shims (dg-*.cmd on Windows)
```

## Code sample: launcher to dispatcher to command

`pkg/launcher/shims/dg.sh`, rendered per name at install time with an absolute `{{ROOT}}`:

```sh
#!/bin/sh
exec "{{ROOT}}/runtime/current/bun" "{{ROOT}}/lib/current/dg.js" {{NAME}} "$@"
```

`pkg/launcher/shims/dg.cmd`:

```bat
@echo off
"{{ROOT}}\runtime\current\bun.exe" "{{ROOT}}\lib\current\dg.js" {{NAME}} %*
```

`pkg/launcher/src/dg.ts`:

```ts
import { type ProgramName, setProgramName } from "@dg/common/node/program";

type Program = { main(argv: string[]): Promise<number> };

const PROGRAMS: Record<ProgramName, () => Promise<Program>> = {
	"dg-skills": () => import("./programs/skills"),
	"dg-agent": () => import("./programs/agent"),
	"dg-daemon": () => import("./programs/daemon"),
};

function isProgram(name: string | undefined): name is ProgramName {
	return name !== undefined && Object.hasOwn(PROGRAMS, name);
}

export async function dispatch(argv: readonly string[]): Promise<number> {
	const [name, ...rest] = argv;
	if (!isProgram(name)) {
		process.stderr.write(`dg: unknown program "${name ?? ""}"; expected ${Object.keys(PROGRAMS).join(", ")}\n`);
		return 64;
	}
	setProgramName(name);
	const { main } = await PROGRAMS[name]();
	return main(rest);
}

if (import.meta.main) process.exit(await dispatch(process.argv.slice(2)));
```

`pkg/skills-cli/src/main.ts`:

```ts
export const VERSION = process.env.DG_BUILD_VERSION ?? "dev";

export async function main(argv: readonly string[]): Promise<number> {
	if (argv.length === 1 && argv[0] === "--version") {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}
	const [{ Command }, { registerAll }] = await Promise.all([import("commander"), import("./commands")]);
	const program = new Command()
		.name("dg-skills")
		.description("Review inboxes, run channel reviews, group marked tabs, play guided tours, compare live-page prototypes, and review finished changes.")
		.showHelpAfterError()
		.version(VERSION);
	program.enablePositionalOptions();
	registerAll(program);
	try {
		await program.parseAsync([...argv], { from: "user" });
		return process.exitCode ?? 0;
	} catch (err) {
		console.error(`dg-skills: ${err instanceof Error ? err.message : err}`);
		return 1;
	}
}
```

`pkg/skills-cli/src/utils/lazy-command.ts`:

```ts
import type { Command } from "commander";
import { type CommandSpec, defineCommand, registerRawCommand } from "./legacy-command";

export interface LazyRaw {
	name: string;
	description: string;
	load(): Promise<{ main(argv: string[]): Promise<number | void> | number | void }>;
}

export interface LazyLegacy {
	name: string;
	description: string;
	load(): Promise<CommandSpec>;
}

/** Registers the name and help now; the feature module loads on first use. */
export function registerLazyRaw(program: Command, spec: LazyRaw): void {
	registerRawCommand(program, {
		name: spec.name,
		description: spec.description,
		run: async (argv) => (await spec.load()).main(argv),
	});
}

export function registerLazyLegacy(program: Command, spec: LazyLegacy): void {
	registerRawCommand(program, {
		name: spec.name,
		description: spec.description,
		run: async (argv) => defineCommand(await spec.load()).run(argv),
	});
}
```

A wrapper after the change, `pkg/skills-cli/src/commands/jot.ts`:

```ts
import type { Command } from "commander";
import { registerLazyLegacy } from "../utils/lazy-command";

export function registerJot(program: Command): void {
	registerLazyLegacy(program, {
		name: "jot",
		description: "Save a short note or a session handoff",
		load: async () => (await import("../jot")).jotSpec,
	});
}
```

`pkg/common/src/node/program.ts`:

```ts
import { join } from "node:path";

export type ProgramName = "dg-skills" | "dg-agent" | "dg-daemon";

let recorded: ProgramName | undefined;

export function setProgramName(name: ProgramName): void {
	recorded = name;
}

export function programName(): ProgramName | undefined {
	return recorded;
}

/** argv for a sibling program on this runtime and bundle: [bun, dg.js, name, ...args]. */
export function programCommand(name: ProgramName, args: readonly string[]): string[] {
	return recorded ? [process.execPath, Bun.main, name, ...args] : [process.execPath, Bun.main, ...args];
}

/** argv for service units: the stable current links, never a version directory. */
export function launcherCommand(root: string, name: ProgramName, args: readonly string[]): string[] {
	const bun = process.platform === "win32" ? "bun.exe" : "bun";
	return [join(root, "runtime", "current", bun), join(root, "lib", "current", "dg.js"), name, ...args];
}
```

`selfCommand(args)` keeps its compiled and source branches for tests and otherwise returns `programCommand(programName() ?? "dg-skills", args)`. `pkg/dg-agent/src/start.ts` `siblingDaemonArgv()` becomes `programCommand("dg-daemon", ["__serve"])`; `pkg/dg-agent/src/phone/migrate.ts` `runDaemonJobCli(args)` runs `programCommand("dg-daemon", args)`; phone units get `launcherCommand(root, "dg-agent", ["phone", "__run", ...])`.

`pkg/skills-cli/src/install/bundle.ts`, the upgrade step:

```ts
export async function fetchBundle(root: string, release: PickedBundle, runtimeBin: string): Promise<string> {
	const staging = join(root, "lib", `${release.version}.staging`);
	const buf = await fetchVerified(release.url, release.sumsUrl, release.assetName);
	rmSync(staging, { recursive: true, force: true });
	await extractTarGz(buf, staging);
	const check = Bun.spawnSync([runtimeBin, join(staging, "dg.js"), "dg-skills", "--version"], { stdout: "pipe", stderr: "pipe" });
	if (check.exitCode !== 0 || !check.stdout.toString().startsWith(release.version)) {
		rmSync(staging, { recursive: true, force: true });
		throw new Error(`bundle ${release.version} failed its self-check: ${check.stderr.toString().trim()}`);
	}
	const final = join(root, "lib", release.version);
	rmSync(final, { recursive: true, force: true });
	renameSync(staging, final);
	const previous = readCurrent(root, "lib");
	linkCurrent(root, "lib", release.version);
	pruneLibVersions(root, [release.version, previous].filter(Boolean));
	return final;
}
```

## Upgrade, rollback, bump

- First E release: the compiled 1.26.0 `dg-skills install` finds no binary asset and skips with its existing warning. `dg-skills doctor` version-match already prints the bootstrap command. docs/install.md: re-run `bootstrap.sh` once.
- Rollback: `dg-skills install --version <previous E release>` relinks `lib/current` with no download while the directory exists; the previous version directory is kept until the next successful install. Manual: `ln -sfn <ver> ~/.dg/lib/current`. Pre-E release: run that release's `bootstrap.sh`.
- Runtime bump: `bun scripts/bump-runtime.ts 1.4.2` rewrites `pkg/launcher/runtime.json` from Bun's `SHASUMS256.txt` plus the `.mise` and `setup-bun` pins; the next release's `runtime.json` asset carries it; `install` downloads the new runtime once, self-checks the bundle on it, relinks `runtime/current` and removes the old runtime directory.
- Failed upgrade: the self-check runs before any link changes; a failure removes staging and changes nothing else.

## Release assets after E

`dg-lib-<v>.tar.gz`, `runtime.json`, `bootstrap.sh`, `bootstrap.ps1`, `dg-ai-extension-<v>-chrome.zip`, `dg-ai-extension-<v>-firefox.zip`, `SHA256SUMS`. Bun zips come from `github.com/oven-sh/bun/releases/download/bun-v<version>/bun-<os>-<arch>[-baseline].zip` and are checked against the sha256 in `runtime.json` (copied from Bun's signed `SHASUMS256.txt` by the bump script).

## Size, speed and token impact

Size: about -160 MB installed per machine, about -1.4 GB of assets per release. Speed: `--version` 300 ms to under 50 ms; every `--help` under 60 ms; a hot path pays only its own chunk. Tokens: no skill text changes in E.

## Risks and early signals

- Bun `splitting: true` with `target: "bun"` plus the playwright metadata plugin: slice 2 proves it first; the signal is `build.spec.ts` and `size-budget.spec.ts` passing on the first green run.
- `.cmd` launchers cannot be spawned without a shell on Windows; a grep test fails on any `spawn(cliDest(` outside tests.
- Hosts without AVX2 need the baseline runtime; bootstrap and `ensureRuntime` read `/proc/cpuinfo`.
- About fifteen `*-compiled.spec.ts` files move to the bundle helper; budget a day of test plumbing.

## ADR draft: docs/adr/0024-shared-runtime-bundle.md

Status: Proposed. Context: three `--compile` binaries embed the 79.5 MB Bun runtime three times (about 250 MB installed, 18 release assets); `--version` takes 300 ms because every command module is evaluated at startup; release builds use no minify. Decision: dg ships one pinned Bun runtime under `runtime/` and one minified, code-split bundle per release under `lib/<version>/`; three launchers pass their program name to `dg.js`, which lazy-loads the program; `selfCommand` and units use `programCommand`/`launcherCommand`. Consequences: good — one 90 MB install, one platform-independent release asset, sub-50 ms startup (`pkg/launcher/__tests__/startup-budget.spec.ts`); bad — a second download (the runtime) on first install and on runtime bumps, `.cmd` launchers on Windows; neutral — `bun` on PATH is never used. Alternatives: keep `--compile` with minify (saves 7 MB per binary, keeps 3 runtimes); one compiled binary with three names (saves two runtimes, keeps 300 ms unless lazy); use the user's bun (version drift, not always present).

## Ratified decisions

- [DECIDED] Windows launcher form: `.cmd` shims on Windows; every in-tree spawn goes through `programCommand()` and a grep test enforces it.
- [DECIDED] `lib/current` and `runtime/current` are symlinks (directory junctions on Windows), which gives units a stable `dg.js` path.
- [DECIDED] `chromium-bidi` stays external.

## Chain position

Layer 1, base of the stack. Branch `feat/shared-runtime-bundle`. Every other bundle (008-012) builds on it: F moves the roots this PR creates, and A-D register lazy commands against `main.ts` and `lazy-command.ts`.

## Startup budget rules (amend slices 1 and 2)

- `pkg/common/package.json` gains the export `"./node/program": "./src/node/program.ts"`. `dg.ts` and `self-command.ts` import from it, never from the `@dg/common/node` barrel: the barrel costs 59-62 ms (unique-names-generator, sqlite, credentials client) and would spend the whole 50 ms budget before the skills chunk loads.
- `main.ts` has no top-level import of `commander` or `./commands`; both load after the `--version` and `hooks run` fast paths through `await import()`. A hoisted static import would make the fast paths cost the same as a full start.
- `size-budget.spec.ts` parses the `import` statements of `dg.js` and of the chunk it names and fails when the static closure contains anything other than `program.ts`. This is the test that stops a later change from re-adding the barrel.
- Baseline row for the executor: `@dg/common/node` barrel 59-62 ms, `program.ts` alone about 11 ms, bun 7 ms.

## Agent Notes

- Merged as #135 (ac4c0816). The ADR landed as 0032, not 0024.
- Left open: the two release checks above. They need the first real release that uses the bundle.
