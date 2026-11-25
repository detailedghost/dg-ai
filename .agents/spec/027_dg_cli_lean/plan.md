---
feature: "Lean dg CLI: latency, binary and download size, skill token weight"
feature_snake_case: dg_cli_lean
date: "2026-11-24"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "lean-baseline"
    depends_on: []
    files: ["scripts/ram-budget.ts","scripts/ram-budget/**","scripts/lean-size.ts","scripts/skill-tokens.ts","scripts/lean-budgets.json",".github/workflows/compiled-dg.yml","pkg/skills-test/__tests__/lean-*.spec.ts","docs/lean-baseline.md"]
    agents:
      primary: dg:devops
      confidence: high
      qa: [dg:qa-devops, dg:qa-perf]
  - id: 2
    name: "bundle-cuts"
    depends_on: []
    files: ["pkg/launcher/build.ts","pkg/launcher/__tests__/build*.spec.ts","package.json","bun.lock","pkg/skills-cli/package.json","pkg/common/package.json","pkg/dg-agent/package.json","pkg/dg-daemon/package.json","pkg/inbox/package.json"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-perf]
  - id: 3
    name: "hot-path-latency"
    depends_on: [2]
    files: ["pkg/launcher/src/**","pkg/launcher/__tests__/dispatch*.spec.ts","pkg/dg/src/**","pkg/dg/__tests__/**","pkg/skills-cli/src/hooks/cli.ts","pkg/skills-cli/src/hooks/run.ts","pkg/skills-cli/src/hooks/io.ts","pkg/skills-cli/__tests__/hooks-fast-path*.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-perf, dg:qa-code]
  - id: 4
    name: "release-download"
    depends_on: [1,3]
    files: [".github/workflows/release.yml","pkg/skills-cli/src/utils/lib.ts","pkg/skills-cli/src/install/compiled.ts","pkg/skills-cli/src/install/companion*.ts","pkg/skills-cli/bootstrap.sh","pkg/skills-cli/bootstrap.ps1","pkg/skills-cli/__tests__/install-*.spec.ts","pkg/skills-cli/__tests__/bootstrap-*.spec.ts","pkg/skills-test/__tests__/release-*.spec.ts","pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts","pkg/launcher/build.ts"]
    agents:
      primary: dg:js
      confidence: high
      effort: xhigh
      qa: [dg:qa-devops, dg:security]
  - id: 5
    name: "skill-diet"
    depends_on: []
    files: ["plugins/dg/skills/**","pkg/skills-test/__tests__/skill-size-cap.spec.ts"]
    agents:
      primary: dg:lore
      confidence: high
      qa: [dg:qa-code]
  - id: 6
    name: "browser-ext-default-flag"
    depends_on: []
    files: ["pkg/skills-cli/src/pw/cli.ts","pkg/skills-cli/src/pw/core/dispatch.ts","pkg/skills-cli/src/pw/core/spec.ts","pkg/skills-cli/src/pw/browser-mode.ts","pkg/skills-cli/__tests__/pw-browser-mode*.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 7
    name: "ext-gap-verbs"
    depends_on: [6]
    files: ["pkg/extension/lib/**","pkg/extension/entrypoints/**","pkg/extension/__tests__/**","pkg/common/src/pw-ext-format.ts","pkg/common/__tests__/pw-ext-format*.spec.ts","pkg/skills-cli/src/pw/ext.ts","pkg/skills-cli/__tests__/pw-ext*.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      effort: xhigh
      qa: [dg:security, dg:qa-code]
  - id: 8
    name: "browser-docs-skills"
    depends_on: [5,6,7]
    files: ["docs/pw.md","docs/browser.md","docs/config.md","docs/demo-and-proto.md","docs/verify.md","plugins/dg/skills/pw/**","plugins/dg/skills/browser/**","plugins/dg/skills/verify/**","plugins/dg/skills/demo/**","plugins/dg/skills/proto/**","CHANGELOG.md"]
    agents:
      primary: dg:lore
      confidence: high
  - id: 9
    name: "native-front-door"
    depends_on: [3,4]
    files: ["pkg/front/**",".github/workflows/front.yml"]
    agents:
      primary: dg:shell
      confidence: low
      effort: xhigh
      qa: [dg:qa-perf, dg:qa-devops]
  - id: 10
    name: "native-long-running"
    depends_on: [9]
    files: ["pkg/front-daemon/**",".github/workflows/front-daemon.yml"]
    agents:
      primary: dg:shell
      confidence: low
      effort: xhigh
      qa: [dg:qa-perf, dg:security]
---

# Lean dg CLI: latency, binary and download size, skill token weight

## Purpose
Make the dg CLI fast and lean. Cut hot-path latency (hooks run on every agent tool call), shrink the compiled binary and the per-update download, and cut the token weight of the skill texts that drive the CLI. Every change is measured against a committed baseline and held by CI gates. Slices 1-8 stay on Bun and help whatever language decision Dante makes later; slices 9-10 are optional native stages gated by RATIFY.

## Scope
### Included
- A baseline harness and CI gates: binary size per target, compressed download size, hot-path latency, RSS, skill tokens per flow
- Bundle cuts: duplicate and dead dependencies, lazy chunks, embedded assets
- Hot-path latency: dispatch order, JIT re-exec, lazy route for hooks and completion, Bun bytecode (RATIFY)
- Release and download size: compressed assets, zstd delta updates, optional companion bundles for pw and db (RATIFY)
- Skill text diet: lazy references/, less duplication, per-SKILL.md size cap test
- Browser default: --ext as the default with a --local Playwright fallback (RATIFY), the extension gap work and the docs
- An explicit language decision (options A-E) with measured floors
- Optional native front door and native long-running processes (RATIFY-gated, slices 9-10)
### Excluded
- A full port to Rust, Zig or C# (option E); later port stages after slice 10 are sketched only
- UPX or other self-extracting executable packers
- Changes to the browser extension's own bundle size
- Moving Snowflake, MSAL or Playwright off Bun or Node

### Slice 1 — lean-baseline

#### Engineering
- [ ] Extend scripts/ram-budget.ts (do not add a sibling harness) with latency cases for dg --version, dg completion, dg agent phone status and dg stat, each with p50 and p90 and an msBudget
- [ ] Add scripts/lean-size.ts: size of each compiled target, plus gzip -9 and zstd -19 --long=27 size, plus zstd --patch-from delta against the previous release asset
- [ ] Add scripts/skill-tokens.ts: bytes/4 token estimate per SKILL.md, per reference file, per named flow (spec-plan, spec-exec, phone, stat, thrash, verify, review-loop, jot) and for the always-loaded frontmatter descriptions
- [ ] Store every budget in scripts/lean-budgets.json; budgets start at the measured 2026-11-24 baseline plus 5 percent
- [ ] Wire size and latency gates into .github/workflows/compiled-dg.yml on linux-x64; report-only on other targets
- [ ] Write docs/lean-baseline.md with the baseline tables and how to re-run

#### Testing Criteria
##### Contracts
- [ ] Contract: scripts/lean-budgets.json shape is { size: { [target]: { rawBytes, zstdBytes } }, latencyMs: { [case]: { p50, p90 } }, skillTokens: { perFlow: { [flow]: number }, descriptions: number } }
- [ ] Contract: scripts/lean-size.ts --json prints the same keys as lean-budgets.json size; --gate exits 1 when a value exceeds its budget
- [ ] Contract: scripts/skill-tokens.ts --json prints the skillTokens keys; --gate exits 1 on any overrun
- [ ] Unit test: the gate logic flags an overrun and passes an equal value
- [ ] Unit test: flow definitions list only files that exist

#### Acceptance Criteria
- [ ] Given a fresh compiled linux-x64 dg, when compiled-dg.yml runs, then size, latency and skill-token gates run and pass at baseline
- [ ] Given a change that adds 2 MB to the binary, when the size gate runs, then it fails with the target name and both numbers

### Slice 2 — bundle-cuts

#### Engineering
- [ ] Add a metafile report to build.ts (Bun.build metafile: true) that writes bytes per package for the compiled bundle
- [ ] Remove duplicate parsers: toml and smol-toml (71 KB together), moment plus moment-timezone where only Intl is needed outside snowflake-sdk
- [ ] Check mime-db (137 KB), yaml (235 KB), ajv (105 KB) and google-auth-library (111 KB) for a smaller import path or removal
- [ ] Keep splitting on: a no-split build measured 241 ms for --version, against 13 ms with splitting
- [ ] Do not move pw (4.06 MB) or the db cluster (snowflake, @azure, moment-timezone, AWS SDK: about 3.5 MB chunk) out of the binary here; that is slice 4 behind RATIFY

#### Testing Criteria
##### Contracts
- [ ] Contract: build.ts --report <file> writes JSON { totalBytes, packages: { [name]: bytes } } sorted by bytes
- [ ] Unit test: the report groups @aws-sdk, @smithy and @aws-crypto as one AWS SDK row
- [ ] Regression: the full bun test suite and ram-budget gate stay green

#### Acceptance Criteria
- [ ] Given the slice is merged, when the compiled linux-x64 dg is built, then the JS bundle is at least 0.5 MB smaller than 11.33 MB and no command changes behavior

### Slice 3 — hot-path-latency

#### Engineering
- [ ] Answer dg --version before the dg-paths import in dispatch.ts (dg-paths import costs 4.5 ms)
- [ ] Add a fast route: when argv[0] is hooks, completion or --version, import only that handler and skip building the flat route tree (flat.ts plus the cli*.js registrations cost about 11 ms in the CPU profile)
- [ ] Read hook stdin with Bun.stdin.text() instead of node streams where the hook path still uses them (node:stream init about 5 ms)
- [ ] Cut the JIT re-exec cost (5 ms) for hooks: run the hook path without the re-exec when RSS stays inside its ram-budget, else keep it
- [ ] Behind RATIFY R2: turn on bytecode: true in the compiled build in build.ts via a flag owned here (build.ts edit lands after slice 2)

#### Testing Criteria
##### Contracts
- [ ] Contract: dispatch(['--version']) writes the version and imports no module beyond the entry chunk
- [ ] Contract: fastRoute(argv) returns 'hooks' | 'completion' | 'version' | undefined and is pure
- [ ] Unit test: every hook def still runs through the fast route with the same exit code and output as the full tree
- [ ] Gate: ram-budget latency cases from slice 1 meet the new budgets in lean-budgets.json

#### Acceptance Criteria
- [ ] Given compiled linux-x64 dg, when dg hooks run pr-confirm runs 50 times, then p50 is at most 20 ms without bytecode, or at most 13 ms with bytecode (baseline 33.8 ms)
- [ ] Given compiled dg, when dg --version runs 50 times, then p50 is at most 9 ms (baseline 19.3 ms)

### Slice 4 — release-download

#### Engineering
- [ ] Publish dg-<key>.zst (zstd -19 --long=27) and dg-<key>.gz next to the raw asset; dg update reads .zst with Bun.zstdDecompressSync, bootstrap.sh and bootstrap.ps1 read .gz with gzip or GZipStream
- [ ] Keep the raw asset for one major as a fallback; SHA256SUMS covers raw and compressed
- [ ] Behind RATIFY R4: publish dg-<key>-from-<prev>.zpatch (zstd --patch-from) for the previous release; dg update applies it and checks the raw sha256, else falls back to .zst
- [ ] Behind RATIFY R3: move the pw chunk and the db chunk into companion assets dg-pw-<ver>.tar.zst and dg-db-<ver>.tar.zst that dg downloads and checks on first use and loads with the embedded runtime
- [ ] Drop dg-lib-<ver>.tar.gz from the release if nothing reads it (shared-runtime model of dg 6.x is RATIFY R5)

#### Testing Criteria
##### Contracts
- [ ] Contract: pickProgram(releases, version, key, { compressed }) returns { url, assetName, encoding: 'zstd' | 'gzip' | 'raw', sumsUrl }
- [ ] Contract: applyPatch(oldBytes, patchBytes) returns bytes whose sha256 matches SHA256SUMS or throws; the caller then fetches the full .zst
- [ ] Unit test: bootstrap asset selection picks .gz on every platform and falls back to raw when .gz is missing
- [ ] Unit test: a corrupt patch falls back to the full download
- [ ] Gate: lean-size.ts download budget per target

#### Acceptance Criteria
- [ ] Given v7.x installed, when dg update runs against a release with a patch asset, then it downloads about 5 MB instead of 93 MB and the new binary sha256 matches
- [ ] Given a new machine, when bootstrap.sh runs, then it downloads the .gz asset (about 40 MB on linux-x64) and installs a working dg

### Slice 5 — skill-diet

#### Engineering
- [ ] Cut every frontmatter description to one or two sentences: the 19.1 KB of descriptions (about 4.8k tokens) loads in every session
- [ ] Move rare detail of the largest SKILL.md files into lazy references/: phone 38 KB, stat 21 KB, thrash 19 KB, verify 15 KB, proto 14 KB, chat 14 KB, spec 13 KB, review-loop 11 KB, jobs 9.5 KB
- [ ] Remove text repeated across skills (bootstrap probes, scratch-path rules, review rules) in favor of one shared reference
- [ ] Add skill-size-cap.spec.ts: each SKILL.md at most the cap of RATIFY R7 (recommended 8 KB), each description at most 400 characters
- [ ] Keep skill-bootstrap-block, skill-cli-invocation, skill-flat-names, skill-flags, skill-manifests and every per-skill spec green

#### Testing Criteria
##### Contracts
- [ ] Contract: skill-size-cap.spec.ts reads the cap from one constant and reports each file over it with its size
- [ ] Regression: all pkg/skills-test skill guards pass
- [ ] Gate: slice 1 skill-token budgets lowered to the new values

#### Acceptance Criteria
- [ ] Given the slice is merged, when skill-tokens.ts runs, then descriptions are at most 2.5k tokens and the phone flow at most 4k tokens (baseline 9.5k)

### Slice 6 — browser-ext-default-flag

#### Engineering
- [ ] Add resolveBrowserMode: --local or --ext flag, else DG_BROWSER env, else [browser] mode in config.toml, else the default chosen by RATIFY R8 (recommended: ext when the extension is connected and the verb is ext-capable, else local)
- [ ] Route ext-capable verbs to ext.ts and every local-only verb to Playwright with a one-line reason
- [ ] Ship with the default still local until R8 is ratified; the switch is one constant

#### Testing Criteria
##### Contracts
- [ ] Contract: resolveBrowserMode({ flags, env, config, extConnected, verb }) returns { mode: 'ext' | 'local', reason } and is pure
- [ ] Unit test: --local always wins; a local-only verb never resolves to ext
- [ ] Unit test: config key browser.mode accepts ext, local, auto

#### Acceptance Criteria
- [ ] Given DG_BROWSER=local, when dg pw click runs, then Playwright handles it
- [ ] Given auto mode and a connected extension, when dg pw snapshot runs, then the extension handles it

### Slice 7 — ext-gap-verbs

#### Engineering
- [ ] Add ext verbs ranked by use: go-back, go-forward, reload, hover, dblclick, check, uncheck, type, eval (chrome.scripting), tab-select
- [ ] Then: localstorage and sessionstorage get/set/delete/clear for the agent tab group's origins only; drag, mouse and key verbs; resize of the agent window
- [ ] Do not add to ext: route/unroute/network mocking, state-save/state-load, cookie-set in the real profile, video, tracing, pdf, install-browser, attach
- [ ] Add the safety work RATIFY R9 picks before the default flips (recommended: a dedicated agent window, an allowlist prompt on first visit per site, the existing driving banner with Stop)

#### Testing Criteria
##### Contracts
- [ ] Contract: PW_EXT_WRITE_VERBS and PW_EXT_READ_VERBS grow only by the listed verbs; validatePwExtRequest accepts each with the same caps
- [ ] Unit test: each new verb refuses a tab outside the agent tab group
- [ ] Unit test: storage verbs refuse an origin that is not on the session allowlist

#### Acceptance Criteria
- [ ] Given auto mode, when the verify-free flows (open, click, fill, snapshot, back, reload, hover, eval) run, then none starts Playwright

### Slice 8 — browser-docs-skills

#### Engineering
- [ ] Document --ext default, --local, DG_BROWSER and browser.mode
- [ ] State in each browser skill which steps stay local (verify multi-viewport, demo video, mocking, saved states, CI)
- [ ] Keep the slice 5 size cap

#### Testing Criteria
##### Contracts
- [ ] Regression: skill-size-cap and all skill guards pass
- [ ] Unit test: docs/config.md lists browser.mode with its three values

#### Acceptance Criteria
- [ ] Given a reader of docs/pw.md, when they look for a local-only verb, then the table names it and the reason

### Slice 9 — native-front-door

#### Engineering
- [ ] OPTIONAL, gated by RATIFY R1 (option B or D). Rust binary dg (0.5-2.5 MB) that answers --version and completion, runs the hot hook defs natively (pr-confirm, pr-prose, spelling, format, spec-plan-lint, strip-ai-coauthors, daily-prune), and execs the Bun binary dg-core for everything else
- [ ] Only worth it if slice 3 misses its hook target: routing alone saves at most the 5 ms re-exec

#### Testing Criteria
##### Contracts
- [ ] Contract: the front door passes argv, env, stdin and exit code through to dg-core unchanged
- [ ] Parity test: every hook def gives the same output and exit code in Rust and in Bun for the ram-budget fixtures

#### Acceptance Criteria
- [ ] Given the front door, when dg hooks run pr-confirm runs 50 times, then p50 is at most 5 ms

### Slice 10 — native-long-running

#### Engineering
- [ ] OPTIONAL, gated by RATIFY R1 (option C or D stage 2). Native phone listener and daemon relay with the same wire protocol and store
- [ ] Target RSS: listener 43-55 MB to 6-10 MB, daemon idle 32-40 MB to 4-8 MB (Rust wss with 3 connections measured 5.8-6.8 MB)

#### Testing Criteria
##### Contracts
- [ ] Contract: the native daemon speaks the existing service API (docs/service-api.md) byte for byte
- [ ] Parity test: the phone listener e2e suite passes against the native listener

#### Acceptance Criteria
- [ ] Given the native listener, when ram-budget runs, then phone listener idle RSS is at most 12 MB

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

## Language Decision (options A-E) — ⚑ RATIFY R1

Floors from the study (`/home/detailedghost/.claude/jobs/778a7bca/tmp/lang/results-*.txt`): Rust hello 0.3-2.5 MB disk, 2.1-2.2 MB RSS, 2.9-4.4 ms; Zig 0.12-0.3 MB, 2.0-3.4 ms; C# NativeAOT 1-9.6 MB, 4.7-7.2 ms; Bun 81 MB, 8.6 ms cold. Rust wss with 3 connections 5.8-6.8 MB RSS against Bun 25-36 MB. Port size: 144k lines, 15.8k tests, 9-14 engineer-months in Rust. Largest groups: inbox 18.7k, common 14.7k, phone 11.2k, pw 8.0k, daemon server 5.8k, thrash 5.1k, daemon commands 5.0k, hooks 3.4k.

| Option | dg binary (linux-x64) | Download, full / update | Hooks p50 | RAM | Cost | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| today | 92.9 MB | 92.9 raw / 92.9 raw | 33.8 ms | short 20-36, daemon 32-40, listener 43-55 MB | - | - |
| A: Bun + trim (slices 1-8) | 92 MB; ~128 with bytecode (R2); ~85 if companions (R3) | zstd ~31 (~44 with bytecode) / delta ~5 | 12-20 ms | unchanged | ~2-3 eng-months | low |
| B: A + Rust front door with native hooks (slice 9) | front 1-2.5 MB + Bun core as A | +1 MB / delta ~5 | 3-5 ms (routing alone saves only the 5 ms re-exec) | hooks 2-4 MB | +1-1.5 eng-months | medium: 2nd toolchain, 8 targets, hook parity |
| C: B + native daemon and phone listener (slice 10) | + 3-8 MB native daemon | +3 MB / delta ~5 | 3-5 ms | daemon 4-8, listener 6-10 MB | +4-6 eng-months (~27k lines) | medium-high: wire and store parity |
| D: staged Rust port, Bun sidecar for pw-local, db, MSAL | end state Rust dg 5-15 MB + Bun sidecar only on first pw/db use | end state 2-6 MB zstd for users who never need the sidecar; sidecar +30 MB zstd (Bun) + 1 MB pw + 0.8 MB db | 3-5 ms | 2-15 MB per process | 7-11 eng-months (~110k lines, ~12k tests) | high: two runtimes during transition |
| E: full port incl. browser and db | 5-15 MB | 2-6 MB / <1 MB | 3-5 ms | 2-15 MB | 11-18 eng-months | very high: no official Rust MSAL or Snowflake driver; pw feature loss |

Download in option D shrinks only at the final flip: while any command still needs the Bun core, every user downloads it. Stages cut latency and RAM early; they cut download only at the end.

### Browser automation (dg pw) row per option

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

### Option D stage order (optional, after slices 1-8, each a later spec gated by R1)

1. Stage 0 = slice 9: front door + native hooks, version, completion (biggest latency gain per week; runs on every tool call).
2. Stage 1: jot, stat, config, worktree, chain (small, no heavy deps, ~3k lines).
3. Stage 2 = slice 10: daemon and phone listener (biggest RAM gain: 75-95 MB resident to ~10-18 MB).
4. Stage 3: spec, thrash, address, provider, deps-upgrade, adr, monolith (~15k lines, pure CLI).
5. Stage 4: install, update, doctor (self-update in Rust; bootstrap shrinks).
6. Stage 5: inbox Outlook through Graph REST and raw OAuth device code (18.7k lines; RATIFY when reached).
7. Flip: the Bun core becomes an on-demand sidecar with pw, db and MSAL only. Download drops from ~31 MB to 2-6 MB zstd.

Slices 1-8 do not depend on this choice: the baseline gates, skill diet, compressed assets, delta updates and ext default all carry over to B, C or D.

## Browser Default Decision (--ext default, --local fallback) — ⚑ RATIFY R8, R9, R10

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

## RATIFY Items

- ⚑ RATIFY R1: Which language path? — A trim only / B front door / C + native daemon / D staged port / E full port — Recommend A now (slices 1-8); start B (slice 9) only if slice 3 misses 13 ms hooks p50; re-decide D after the slice 1 gates show real numbers; reject E.
- ⚑ RATIFY R2: Turn on Bun bytecode? — yes (+35 MB raw, +12.6 MB zstd, hooks 28 to 12 ms, --version 14 to 7 ms) / no — Recommend yes, together with R4 so updates stay ~5 MB.
- ⚑ RATIFY R3: Move pw and db chunks into download-on-first-use companions? — yes (-7.6 MB raw, about -1.8 MB compressed, new offline failure mode) / no — Recommend no under A; yes if D is picked.
- ⚑ RATIFY R4: Ship zstd delta patches? — previous release only / last 3 releases / none — Recommend previous release only (measured 4.7 MB vs 92.9 MB).
- ⚑ RATIFY R5: Return to the 6.x shared runtime + small bundle? — yes / no — Recommend no: delta patches give the same update size without runtime and bundle version skew.
- ⚑ RATIFY R6: Use UPX or a similar packer? — yes / no — Recommend no: Bun reads its embedded bundle from its own file, packed binaries are often flagged by Windows Defender and break macOS signing, and startup gets slower.
- ⚑ RATIFY R7: SKILL.md size cap? — 6 KB / 8 KB / 10 KB; description cap 300 / 400 chars — Recommend 8 KB and 400 chars (16 skills over 8 KB today).
- ⚑ RATIFY R8: Browser default? — ext always / auto (ext when connected and the verb is ext-capable, else local) / local — Recommend auto, with DG_BROWSER and browser.mode as the opt-out.
- ⚑ RATIFY R9: Agent window policy? — dedicated agent window in the real profile + first-visit allowlist prompt / separate Chrome profile / tab group only (today) — Recommend a dedicated window + allowlist prompt.
- ⚑ RATIFY R10: Local-only features? — the local-only column above — Recommend as listed: video, tracing, mocking, storage states, cookie writes, pdf, multi-viewport verify, parallel sessions, Firefox, WebKit, headless and CI.
- ⚑ RATIFY R11: Who builds slices 9-10? — add a dg:rust persona / dg:shell (low confidence, current pick) / proxy to codex — Recommend adding a dg:rust persona before slice 9 starts.

## Risks

- Bytecode ties the binary to the exact Bun version; a Bun bump must rebuild every target, and it adds 35 MB raw.
- The fast route for hooks can drift from the commander tree; slice 3's parity test runs every hook def through both.
- Delta patches need the exact previous binary; any local change or a skipped release falls back to the full .zst.
- bootstrap.ps1 must decompress .gz with GZipStream; older PowerShell versions need a test on Windows.
- Ext default runs the agent next to real tabs and logins; slice 7 safety work must land before R8 flips the default.
- Hook latency measured on one warm Linux box; Windows and macOS have no fork-and-exec fast path and will be slower.
- Skill diet can break skill guards that match exact text; slice 5 keeps every guard green.

## Cost

`dg spec estimate`: 10 slices, 65 agent calls (20 haiku, 42 sonnet, 3 opus), up to 2 correction rounds (balance). Slices 9-10 are optional; without them about 52 calls. Token-heavy: slices 4 and 7 run at xhigh. Rough total 8-14M tokens for slices 1-8.

## Slice Summaries

## Agent Notes
Planned without the human (subagent run): one research pass, then slicing and one self-review. Step 1.5 collapsed: no contested code surfaces beyond the build.ts and plugins/** overlaps, which depends_on edges resolve (2 then 3 then 4; 5 then 8). Roundtable shells are unfilled; the main loop runs the approval gate.

## Issues Remediation
