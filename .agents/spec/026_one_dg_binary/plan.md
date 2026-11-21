---
feature: "One dg binary and one config file"
feature_snake_case: one_dg_binary
date: "2026-11-21"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "decision-records"
    depends_on: []
    files: ["docs/adr/**",".agents/decisions/**"]
    agents:
      primary: dg:lore
      confidence: high
  - id: 2
    name: "flat-routes"
    depends_on: []
    files: ["pkg/dg/src/**","pkg/dg/__tests__/**","pkg/dg/package.json"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 3
    name: "compiled-build"
    depends_on: [2]
    files: ["pkg/launcher/**"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-devops, dg:qa-perf]
  - id: 4
    name: "compiled-install"
    depends_on: [3]
    files: ["pkg/skills-cli/src/install/**","pkg/skills-cli/bootstrap.sh","pkg/skills-cli/bootstrap.ps1","pkg/common/src/node/program.ts","pkg/common/__tests__/program-command.spec.ts","pkg/skills-cli/__tests__/bootstrap-*.spec.ts","pkg/skills-cli/__tests__/install-*.spec.ts","pkg/skills-cli/__tests__/bootstrap-fixtures.ts","pkg/skills-cli/__tests__/bundle-build.ts","pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts","pkg/skills-test/__tests__/remote-install-*.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      effort: xhigh
      qa: [dg:qa-devops, dg:security]
  - id: 5
    name: "stored-argv-migration"
    depends_on: [4]
    files: ["pkg/dg-daemon/src/jobs/migrate.ts","pkg/dg-daemon/src/commands/autostart.ts","pkg/dg-agent/src/phone/listener.ts","pkg/dg-daemon/__tests__/jobs/migrate.spec.ts","pkg/dg-daemon/__tests__/commands/autostart.spec.ts","pkg/dg-agent/__tests__/phone/listener-argv.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 6
    name: "release-compiled"
    depends_on: [3]
    files: [".github/workflows/release.yml","pkg/skills-test/__tests__/release-*.spec.ts"]
    agents:
      primary: dg:devops
      confidence: high
      qa: [dg:qa-devops]
  - id: 7
    name: "dg-docs"
    depends_on: [2,4,6]
    files: ["docs/install.md","docs/DEVELOPER.md","docs/AGENT-INSTALL.md","docs/jobs-and-services.md","docs/phone.md","docs/pw.md","README.md","CHANGELOG.md"]
    agents:
      primary: dg:lore
      confidence: high
  - id: 8
    name: "skill-texts"
    depends_on: [2]
    files: ["plugins/**","pkg/skills-test/__tests__/skill-cli-invocation.spec.ts","pkg/skills-test/__tests__/skill-bootstrap-block.spec.ts","pkg/skills-test/__tests__/skill-flat-names.spec.ts"]
    agents:
      primary: dg:lore
      confidence: high
      qa: [dg:qa-code]
  - id: 9
    name: "config-core"
    depends_on: []
    files: ["pkg/common/src/node/dg-toml.ts","pkg/common/src/node/dg-paths.ts","pkg/common/src/node/index.ts","pkg/common/package.json","bun.lock","pkg/common/__tests__/dg-toml*.spec.ts","pkg/common/__tests__/dg-paths.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code, dg:security]
  - id: 10
    name: "config-migrate"
    depends_on: [9]
    files: ["pkg/common/src/node/dg-toml-migrate.ts","pkg/common/src/node/dg-toml.ts","pkg/common/__tests__/dg-toml-migrate*.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      effort: xhigh
      qa: [dg:qa-code, dg:security]
  - id: 11
    name: "config-command"
    depends_on: [9]
    files: ["pkg/skills-cli/src/commands/config.ts","pkg/skills-cli/src/register-all.ts","pkg/skills-cli/src/completion/tree.json","pkg/skills-cli/__tests__/config-command*.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 12
    name: "config-consumers"
    depends_on: [10]
    files: ["pkg/common/src/node/dg-config.ts","pkg/common/__tests__/dg-config.spec.ts","pkg/skills-cli/src/hooks/config.ts","pkg/skills-cli/src/hooks/cli.ts","pkg/skills-cli/src/utils/cli-only.ts","pkg/skills-cli/src/utils/refs.ts","pkg/skills-cli/src/doctor/checks.ts","pkg/inbox/src/config/**","pkg/ssms/src/cli/run.ts","pkg/skills-cli/__tests__/hooks/**","pkg/skills-cli/__tests__/hooks-settings/**","pkg/skills-cli/__tests__/doctor-command.spec.ts","pkg/skills-cli/__tests__/doctor-fixtures.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 13
    name: "config-docs"
    depends_on: [11,12]
    files: ["docs/config.md","docs/hooks.md","docs/inbox-cleanup.md","docs/ssms.md"]
    agents:
      primary: dg:lore
      confidence: high
---

# One dg binary and one config file

## Purpose
Put every dg command under one flat `dg <command>` surface and ship it as one compiled program, which revives the single-binary decision of ADR 0020 and reverses that part of its 2026-11-18 amendment. Today dg already ships one minified bundle and one pinned Bun runtime (ADR 0032) behind four launchers, and the release already uses one `v<x>` tag, so the work is the flat command surface, a `bun build --compile` program, the stored-argv bridge, and skill texts. A second, separable slice set moves every dg config item into one `config.toml` in the dg config folder, with a `[plugins]` section, secrets kept in the credential store, and `dg config get/set/edit/path`.

## Scope
### Included
- Flat `dg <command>` for every dg-skills top-level command, plus agent `phone`, `overwatch`, `memory`, `mcp` and daemon `job`, `autostart`, `service`, derived from the three generated completion trees
- A collision rule: daemon lifecycle verbs (`serve`, `status`, `start`, `stop`, `restart`, `sessions`, `origin`) stay under `dg daemon`; agent session verbs (`start`, `send`, `recv`, `progress`, `spawn`, `stage`, `close`, `manifest`) stay under `dg agent`; a test fails on any new unowned collision
- `dg skills`, `dg agent` and `dg daemon` stay as group mounts, so every command keeps one full path
- One compiled `dg` program per platform with `bun build --compile --splitting --minify`; `dg-skills`, `dg-agent` and `dg-daemon` stay as links to it and dispatch on the invoked name
- Install, bootstrap.sh, bootstrap.ps1 and self-update install the compiled program under `<data>/bin/<version>/` with a `current` link, keep old version folders for rollback, and keep the runtime and bundle for the two-minor bridge
- Rewrite of stored argv that names `runtime/current/bun lib/current/dg.js` (autostart unit, phone listener unit, jobs) to the compiled form, with a backup
- Release builds eight compiled assets, keeps the `v<x>` tag, and keeps publishing `dg-lib-<v>.tar.gz` and `runtime.json` for two minor releases
- One new ADR that supersedes ADR 0020 and one new ADR for the config file, both written with `dg-skills adr new`, plus link lines on ADRs 0020, 0025, 0032 and 0049
- Skill texts move from `dg-skills <cmd>`, `dg-agent phone` and `dg-daemon job` to `dg <cmd>`, with a guard test
- One `config.toml` at `resolveDgPaths().configDir` (default `~/.config/dg/config.toml`, XDG_CONFIG_HOME respected, `<DG_HOME>/config/config.toml` when DG_HOME is set), a loader in pkg/common, migration with backup, precedence, validation messages with a next step, secret references, and a `[plugins]` section
- `dg config get/set/edit/path` registered in pkg/skills-cli, so the flat surface exposes it
### Excluded
- The chat-skills zip fix in release.yml (branch fix/release_chat_zip); no slice edits the `Package the chat skills` step or scripts/package-chat-skills.ts
- Channel review config: channel review leaves dg in a later major release
- The daemon jobs table and job sources (`state/daemon/config.json`, `data/jobs/sources.json`) stay daemon-owned state (pending RATIFY)
- The exec-allowlist file stays a separate 0600 security file (pending RATIFY)
- Removal of the old program names; that waits for a later major release
- Rewriting `dg-skills hooks run` lines already written into Claude settings files; the old names stay as links
- The browser extension and its `ext` artifact

### Slice 1 — decision-records

#### Engineering
- [ ] Run `dg-skills adr new "One dg program with flat commands" --topic Platform` and write it: flat surface, collision rule, compiled program, links for old names, stored-argv rewrite, `v<x>` tag stays, two-minor bridge for the bundle tarball and runtime, rollback
- [ ] State that it supersedes ADR 0020 and its amendment where they disagree; add one link line to ADR 0020, and `Superseded in part by` lines to ADRs 0025 (skills call dg-skills), 0032 (runtime plus bundle shims) and 0049 (`dg job` runs `dg-daemon job`)
- [ ] Run `dg-skills adr new "One config.toml for dg" --topic Platform`: path from resolveDgPaths().configDir, sections, precedence, migration and backup, secret references, `[plugins]`, what stays out (jobs table, exec-allowlist, channel review) as ratified
- [ ] Run `dg-skills adr index` and `dg-skills adr lint`

#### Testing Criteria
##### Contracts
- [ ] Contract: each new ADR has Status, Date, Topic, Context, Decision, Consequences, Other options and References, and `dg-skills adr lint` exits 0
- [ ] Contract: ADR 0020 keeps its accepted text and amendment unchanged except one added link line

#### Acceptance Criteria
- [ ] Given the repo is opted in to adr lint, when the slice lands, then `dg-skills adr lint` exits 0 and both indexes list the two new records

### Slice 2 — flat-routes

#### Engineering
- [ ] Replace the hand-written ROUTES with routes derived at dispatch time from the three generated trees (`pkg/skills-cli/src/completion/tree.json`, `pkg/dg-agent/src/completion-tree.json`, `pkg/dg-daemon/src/completion-tree.json`), imported lazily so `dg --version` and `dg --help` stay inside the startup budget
- [ ] Add `pkg/dg/src/flat.ts` with `OWNERS` (a collision table: name to owning program), `GROUPED` (names that stay only under `dg agent` or `dg daemon`) and `ALIASES` (`upgrade` to `dg-skills update`, `extension` to `dg-skills install`)
- [ ] Keep `skills`, `agent` and `daemon` as group mounts and keep `completion` and `help` as dg's own
- [ ] Group `dg --help` output by area, and make `dg __complete` list the flat names

#### Testing Criteria
##### Contracts
- [ ] Contract: `resolveRoute(word: string): { program: MountName; command: readonly string[] } | undefined` in pkg/dg/src/flat.ts
- [ ] Contract: every top-level name of the three trees is reachable through `dg <name>` or `dg <group> <name>`, and no flat name resolves to two programs
- [ ] Contract: a name that two trees share and that is not in `OWNERS` or `GROUPED` fails the collision test with the name and both programs
- [ ] `dg pw --help` prints the same text as `dg-skills pw --help`; `dg phone --help` matches `dg-agent phone --help`; `dg job --help` matches `dg-daemon job --help` (extend parity.spec.ts)
- [ ] `dg start` exits 1 with a hint that names `dg daemon start` and `dg agent start`
- [ ] `dg --version` stays inside the existing startup budget
- [ ] `dg help pw` prints the same text as `dg pw --help`, and `dg __complete pw` completes the skills subcommands

#### Acceptance Criteria
- [ ] Given a 6.x install, when the user runs `dg pw`, `dg db`, `dg stat`, `dg spec`, `dg adr`, `dg phone` or `dg job`, then each runs the same command as its old program form
- [ ] Given a new dg-skills command, when the trees are regenerated, then it is reachable as `dg <name>` with no edit in pkg/dg

### Slice 3 — compiled-build

#### Engineering
- [ ] Add `buildCompiled({ target, outfile })` in pkg/launcher/build.ts that runs `Bun.build` with `compile`, `splitting`, `minify`, the named chunks plugin and the `chromium-bidi` external, for the eight targets in runtime.json
- [ ] Keep `buildLauncher` (bundle tarball) for the two-minor bridge
- [ ] Make `dispatch` in pkg/launcher/src/dg.ts pick the program from `basename(process.argv0)` without `.exe` when it is one of the three old names, else from the first argument as today, so `dg dg-daemon serve` keeps working
- [ ] Update the size budget test for one compiled program

#### Testing Criteria
##### Contracts
- [ ] Contract: `dispatch(argv0: string, argv: readonly string[]): Promise<number>`; argv0 `dg-skills` with argv `["pw"]` runs the skills tree; argv0 `dg` with argv `["dg-daemon", "serve"]` runs the daemon tree
- [ ] Contract: `buildCompiled` writes one executable per target; the linux-x64 output runs `--version` and prints the stamped version
- [ ] A symlink and a hard link named `dg-skills` to the compiled linux-x64 program run the skills tree (proves argv0 survives links)
- [ ] Size budget: the compiled program stays under 100 MB

#### Acceptance Criteria
- [ ] Given the compiled program, when it is started as `dg`, `dg-skills`, `dg-agent` or `dg-daemon`, then it runs the matching tree

### Slice 4 — compiled-install

#### Engineering
- [ ] Install the compiled program at `<data>/bin/<version>/dg` (`dg.exe` on Windows) and point a `<data>/bin/current` link at it, replaced by create-then-rename as in ADR 0032
- [ ] Write `bin/dg` and the old names `dg-skills`, `dg-agent`, `dg-daemon` as symlinks on Linux and macOS and as hard links (`.exe`) on Windows; remove the old `.cmd` and shell shims
- [ ] Keep `runtime/current` and `lib/current` in place during the bridge so stored argv that is not yet rewritten keeps working
- [ ] Select the compiled asset per platform in bootstrap.sh, bootstrap.ps1 and `dg install`, verify it against SHA256SUMS, run its `--version` before a link changes
- [ ] `dg install --version <v>` relinks `bin/current` with no download while `<data>/bin/<v>` exists
- [ ] Add `compiledProgramPath(root)` and `rewriteLauncherArgv(argv)` to program.ts; `launcherCommand` returns `[<data>/bin/current/dg, <program>, ...args]`; `programCommand` uses `process.execPath` when compiled

#### Testing Criteria
##### Contracts
- [ ] Contract: `launcherCommand(root, name, args)` returns `[join(root, "bin", "current", exe), name, ...args]`
- [ ] Contract: `rewriteLauncherArgv(argv: readonly string[]): string[] | undefined` maps `[<root>/runtime/current/bun, <root>/lib/current/dg.js, ...rest]` to the compiled form and returns undefined for any other argv
- [ ] An upgrade from a 6.3 layout keeps runtime/current and lib/current and adds bin/current and four links
- [ ] bootstrap.sh and bootstrap.ps1 pick the right asset for each of the eight platform keys
- [ ] A failed `--version` of the staged program leaves the old links in place

#### Acceptance Criteria
- [ ] Given a 6.3 install, when the user runs `dg upgrade`, then `dg`, `dg-skills`, `dg-agent` and `dg-daemon` all run the compiled program and old jobs still run
- [ ] Given two installed versions, when the user runs `dg install --version <older>`, then `bin/current` points at the older program with no download

### Slice 5 — stored-argv-migration

#### Engineering
- [ ] Add a third daemon-start migration under the config lock: rewrite each job argv that `rewriteLauncherArgv` maps, keep `config.json.pre-compiled` (0600), and log each rewrite
- [ ] On daemon start and on `dg autostart install`, rewrite a login unit whose command names `lib/current/dg.js`
- [ ] Rewrite the phone listener unit the same way on its next refresh

#### Testing Criteria
##### Contracts
- [ ] Contract: the migration is idempotent; a second run changes nothing and writes no second backup
- [ ] A job argv `[dg-skills, inbox, ...]` that names a program by PATH is not touched
- [ ] A systemd unit, a LaunchAgent and a scheduled task that name `lib/current/dg.js` are rewritten to `bin/current/dg dg-daemon serve`

#### Acceptance Criteria
- [ ] Given jobs and units written by 6.3, when the upgraded daemon starts, then each one runs through the compiled program and the backup holds the old config

### Slice 6 — release-compiled

#### Engineering
- [ ] Build the eight compiled assets in the bundle job (cross-compile with `--target`), name them `dg-<os>-<arch>[-baseline][.exe]`, and list them in SHA256SUMS
- [ ] Smoke test: run `--version`, `dg pw --help` and `dg-skills --version` through a link on linux-x64, macOS and Windows runners
- [ ] Keep the `v<x>` tag, keep `dg-lib-<v>.tar.gz` and `runtime.json` as assets for two minor releases
- [ ] Do not edit the `Package the chat skills` step; rebase on master after fix/release_chat_zip merges

#### Testing Criteria
##### Contracts
- [ ] Contract: release-workflow.spec.ts asserts the eight compiled asset names, the bridge assets, and one `v<x>` tag
- [ ] release-triggers.spec.ts still passes with no new trigger

#### Acceptance Criteria
- [ ] Given a release run, when it publishes, then the release has eight compiled assets, the bundle tarball, runtime.json, bootstrap scripts and SHA256SUMS

### Slice 7 — dg-docs

#### Engineering
- [ ] Document the flat surface, the collision rule, the compiled program, the links, the bridge and rollback
- [ ] Use `dg <command>` in every example

#### Testing Criteria
##### Contracts
- [ ] Contract: no doc in this slice tells a user to run `dg-skills <cmd>` where `dg <cmd>` exists, except in the bridge section

#### Acceptance Criteria
- [ ] Given a new user, when they read docs/install.md, then every command they copy runs on a fresh install

### Slice 8 — skill-texts

#### Engineering
- [ ] Rewrite `dg-skills <cmd>` to `dg <cmd>`, `dg-agent phone|overwatch|memory|mcp` to `dg <cmd>`, and `dg-daemon job|autostart|service` to `dg <cmd>` in skill texts; keep grouped verbs as `dg agent <verb>` and `dg daemon <verb>`
- [ ] Change the generated first-run block to call `dg` and fall back to `${DG_HOME:-$HOME/.local}/bin/dg`
- [ ] When the installed `dg` does not know a flat name (a plugin install newer than the CLI), the first-run block prints `run dg-skills update` as the next step

#### Testing Criteria
##### Contracts
- [ ] Contract: skill-flat-names.spec.ts fails on any `dg-skills <name>` in plugins/** where `<name>` resolves flat
- [ ] Every `dg <word>` in plugins/** resolves through `resolveRoute`

#### Acceptance Criteria
- [ ] Given the skills of this release, when an agent runs any command a skill prints, then it runs on the compiled program of the same release

### Slice 9 — config-core

#### Engineering
- [ ] Add `configTomlPath: join(configDir, "config.toml")` to DgPaths; it follows XDG_CONFIG_HOME, APPDATA, macOS support and `<DG_HOME>/config`, and DG_PATH_FENCE checks it through the configDir role
- [ ] Parse with `Bun.TOML.parse`; write with a pinned `smol-toml` stringify, atomically through `writeFilePreserving` with mode 0600
- [ ] Schema with sections `[hooks]`, `[install]` (`cli_only`), `[refs.aliases]`, `[inbox]`, `[ssms]`, `[plugins.<name>]` (`enabled`, `source`, `settings`)
- [ ] Precedence helper: CLI flag, then env, then TOML, then default (pending RATIFY)
- [ ] Secret fields take only `{ credential = "<name>" }`; a plain string in a secret field, or a value that looks like a token, fails validation
- [ ] Validation errors throw DgCliError: `dg config: <file>:<line>: <key> must be <type>, got <value>. Next: run dg config edit, or dg config set <key> <value>.`

#### Testing Criteria
##### Contracts
- [ ] Contract: `readDgToml(env?): DgToml` returns defaults for a missing file and throws DgCliError with file, line, key and a next step for a bad one
- [ ] Contract: `setting<T>(key, { flag?, envVar? }): T` follows flag, env, TOML, default
- [ ] Contract: `writeDgToml(key: string, value: unknown, env?)` validates before it writes and never writes a secret value
- [ ] Contract: `resolveDgPaths({ env: { DG_HOME: d } }).configTomlPath` is `d/config/config.toml`; with DG_PATH_FENCE set outside it, resolveDgPaths throws
- [ ] `[plugins.foo.settings]` with a `token = "abc..."` string fails; with `token = { credential = "foo-token" }` passes

#### Acceptance Criteria
- [ ] Given a test that sets DG_HOME to a temp folder, when it reads config, then it never reads ~/.config/dg

### Slice 10 — config-migrate

#### Engineering
- [ ] On the first read with no config.toml, fold `config.json` (hooks), the `cli-only` marker, `~/.config/browser-batch/config.json` aliases, the inbox organizer config and `ssms/config.yaml` into one config.toml, under the install lock
- [ ] Copy each source to `<file>.pre-toml` (0600) and check the copy before writing the TOML; leave the source in place during the bridge
- [ ] Move a secret value found in a source into the credential store and write a reference; on a failed store write, stop and write nothing
- [ ] Record migrated sources and their sha256 in `[meta.migrated]`

#### Testing Criteria
##### Contracts
- [ ] Contract: `migrateToToml(paths): { wrote: boolean; sources: string[]; backups: string[] }` is idempotent
- [ ] Each source key appears in the TOML with the same value (round-trip test per source)
- [ ] A broken JSON source leaves every file as it was and throws a DgCliError with a next step

#### Acceptance Criteria
- [ ] Given a 6.3 config folder, when any dg command first reads config, then config.toml holds every value, each source has a backup, and no secret is in the TOML

### Slice 11 — config-command

#### Engineering
- [ ] Register `config` with `get <key>`, `set <key> <value>` (plus `--credential <name>` for secret fields), `edit` (opens $EDITOR, validates on save, keeps the old file on failure) and `path`
- [ ] Regenerate the completion trees with scripts/completion-trees.ts

#### Testing Criteria
##### Contracts
- [ ] Contract: `dg-skills config path` prints `resolveDgPaths().configTomlPath`
- [ ] Contract: `config set` of a secret field with a plain value exits 1 and names `dg credentials` as the next step
- [ ] `config get` of an unset key prints the default and exits 0; of an unknown key exits 1

#### Acceptance Criteria
- [ ] Given slice 2 has landed, when the user runs `dg config path`, then it prints the same path as `dg-skills config path`

### Slice 12 — config-consumers

#### Engineering
- [ ] Make readDgConfig and writeDgConfig read and write the `[hooks]` table of config.toml
- [ ] Read `cli_only`, ref aliases, inbox and ssms settings from config.toml
- [ ] Add a doctor check that warns when a migrated source changed after migration and names `dg config edit`

#### Testing Criteria
##### Contracts
- [ ] Contract: every reader goes through readDgToml; no reader opens config.json, cli-only or browser-batch config after migration
- [ ] Hooks toggles round-trip through `dg-skills hooks` with config.toml
- [ ] Doctor warns when a source sha256 differs from `[meta.migrated]`

#### Acceptance Criteria
- [ ] Given a migrated install, when the user changes a hook toggle, then only config.toml changes

### Slice 13 — config-docs

#### Engineering
- [ ] Write docs/config.md: path per OS, DG_HOME and DG_PATH_FENCE isolation, sections, precedence, secret references, `[plugins]`, migration and backups, `dg config`
- [ ] Point hooks, inbox and ssms docs at config.toml

#### Testing Criteria
##### Contracts
- [ ] Contract: every key in the schema appears in docs/config.md

#### Acceptance Criteria
- [ ] Given a user with an old config folder, when they read docs/config.md, then they know where each old value went and where its backup is

## Slice Summaries

## Agent Notes

Self-review of the slices (one pass, in place of the per-slice fan-out): file sets pass `spec lint-waves`; the ADR index generator and the completion-tree generator each have one owning slice; slice 4 is the largest and carries `effort: xhigh`; slice 8 got a version-skew step; slice 2 got `dg help` and completion checks. If RATIFY 1 picks the bundle, drop slices 3 to 6, and slice 7 loses its compiled sections. If RATIFY 9 or 10 moves jobs or the exec-allowlist into the TOML, add one slice for each after slice 10, with a daemon write-lock contract and `dg:security` QA.

## Issues Remediation

## Code Structure

### Route source for the flat surface
- **Decision:** `pkg/dg/src/flat.ts` derives flat routes from the three generated completion trees; `OWNERS`, `GROUPED` and `ALIASES` are the only hand-written entries. Skills code (slice 8) imports `resolveRoute` for its guard test.
- **Home:** `pkg/dg/src/flat.ts`
- **Rationale:** about 60 names stay in step with commands at zero cost, and a new collision fails a test.
- **Alternatives:** hand-written ROUTES — drifts on every new command; mounting the three commander programs into one — loads every tree at startup and breaks the startup budget.
- **Applies to:** slices 2, 8, 11

### Launcher argv contract
- **Decision:** the program accepts `<program> ...args` as its first argument (today's `dg.js` form) and also dispatches on `basename(process.argv0)`. `launcherCommand` and `rewriteLauncherArgv` live in `pkg/common/src/node/program.ts` and are the only code that builds or rewrites stored argv.
- **Home:** `pkg/launcher/src/dg.ts`, `pkg/common/src/node/program.ts`
- **Rationale:** stored argv from 6.3 keeps its meaning, and one helper owns the old-to-new mapping.
- **Alternatives:** a new `--program` flag — every stored argv would need a rewrite with no fallback; each consumer rewrites its own argv — three copies of one mapping.
- **Applies to:** slices 3, 4, 5, 6

### Compiled program location
- **Decision:** `<data>/bin/<version>/dg[.exe]` with a `<data>/bin/current` link, computed in `program.ts` from `resolveDgPaths().dataDir`; no new DgPaths field in the binary track.
- **Home:** `pkg/common/src/node/program.ts`
- **Rationale:** mirrors `lib/<version>` and `lib/current` from ADR 0032, keeps link rollback, and leaves `dg-paths.ts` to the config track.
- **Alternatives:** overwrite one `bin/dg` — no instant rollback; a DgPaths field — overlaps slice 9.
- **Applies to:** slices 4, 5

### Config file and loader
- **Decision:** `resolveDgPaths().configTomlPath` = `<configDir>/config.toml` (Linux `~/.config/dg/config.toml` or `$XDG_CONFIG_HOME/dg/config.toml`; macOS `~/Library/Application Support/dg/config.toml`; Windows `%APPDATA%\dg\config.toml`; `<DG_HOME>/config/config.toml` when DG_HOME is set). `readDgToml`, `writeDgToml` and `setting` in `pkg/common/src/node/dg-toml.ts` are the only readers and writers. Tests isolate config with DG_HOME, and DG_PATH_FENCE fails any path outside the fence through the configDir role.
- **Home:** `pkg/common/src/node/dg-toml.ts`, `pkg/common/src/node/dg-paths.ts`
- **Rationale:** the location is decided by Dante; one loader keeps precedence, validation and secret checks in one place.
- **Alternatives:** per-package readers of the TOML — repeats validation; keep `readDgConfig` as JSON beside the TOML — two sources of truth.
- **Applies to:** slices 9, 10, 11, 12, 13

### TOML parse and write
- **Decision:** parse with `Bun.TOML.parse`; write with an exact-pinned `smol-toml` `stringify`. `dg config set` rewrites the file and does not keep comments; `dg config edit` keeps the user's text.
- **Home:** `pkg/common/src/node/dg-toml.ts`
- **Rationale:** no TOML writer exists in the repo or in Bun; smol-toml is small and has no dependencies.
- **Alternatives:** a hand-written TOML writer — new code for a solved problem; JSON with a `.toml` name — not what was asked.
- **Applies to:** slices 9, 10, 11

### Secret references
- **Decision:** a secret field holds only `{ credential = "<name>" }`, resolved through the existing credential store; the schema marks secret fields, and a heuristic also refuses token-like strings in `[plugins.*.settings]`.
- **Home:** `pkg/common/src/node/dg-toml.ts`
- **Rationale:** the TOML can be read, copied and shared with no secret in it.
- **Alternatives:** `{{resolve:...}}` strings — a second syntax to parse; env-var names only — does not reach the credential store.
- **Applies to:** slices 9, 10, 11

## Today Versus Goal

Facts from origin/master at 6.3.0 that set the shape of this bundle:

- ADR 0032 already replaced three compiled binaries with one minified bundle (`lib/<v>/dg.js`, about 12 MB) and one pinned Bun runtime (about 76 MB). `dg`, `dg-skills`, `dg-agent` and `dg-daemon` are four shell or `.cmd` launchers that run `bun dg.js <program>`.
- The release already uses one tag, `v<x>` (v6.3.0). `skills-v`, `daemon-v`, `agent-v` and `ext-v` stopped at 1.2x and `dg-v` never existed. No tag bridge is left to plan; only the names and the stored argv need a bridge.
- `pkg/dg/src/main.ts` has 9 hand-written routes plus `completion` and `help`.
- Top-level commands: dg-skills 44, dg-agent 12 (`overwatch recv send progress spawn mcp stage close manifest memory phone start`), dg-daemon 10 (`serve status start stop restart autostart job origin sessions service`). Cross-tree collisions: `start` (agent and daemon), `completion`, `help`. Inside `dg`: `install`, `doctor`, `upgrade`/`update`, `extension`.
- Callers: `dg-skills` appears 1476 times in 163 files under plugins/ (548 repo files); `dg-agent` 129 times in 11 plugin files (59 of them `phone`); `dg-daemon` 76 times in 10 plugin files (22 of them `job`).
- Stored argv: `launcherCommand()` writes `[<root>/runtime/current/bun, <root>/lib/current/dg.js, <program>, ...]` into the autostart unit and the phone listener. Jobs store raw argv (`Bun.spawn(decl.argv)`).
- `bun build --compile --splitting --minify` works on Bun 1.4.2 (tested); an empty program is 81 MB, so a dg program is about 93 MB per platform and eight platforms add about 740 MB per release.
- Config today: `<configDir>/config.json` (only `hooks`), `<configDir>/exec-allowlist` (line grammar, sha256 pins), `<configDir>/cli-only` (marker), `<configDir>/channel-review/config.json`, `<configDir>/ssms/config.yaml`, inbox `organizer.config.json` and route profiles, `~/.config/browser-batch/config.json` (ref aliases), `<state>/daemon/config.json` (jobs table, daemon lock, ADR 0049), `<data>/jobs/sources.json`. Phone and pw keep state, not config. No spec or assign user settings exist.

## Release, Bridge and Rollback

The plan for release, bridge and rollback:

- **Tag:** stays `v<x>`. No new prefix.
- **Assets:** eight compiled programs `dg-<os>-<arch>[-baseline][.exe]`, bootstrap scripts, SHA256SUMS. For two minor releases after the switch, also `dg-lib-<v>.tar.gz` and `runtime.json`.
- **Why the tarball bridge works:** a 6.3 self-update downloads the new tarball and runs its `install` with the old runtime; that new install code then moves the machine to the compiled program. After the bridge, an older install re-runs `bootstrap.sh` once.
- **Names:** `dg-skills`, `dg-agent` and `dg-daemon` stay as links (hard links `.exe` on Windows, no `.cmd`) until the next major release (pending RATIFY 3).
- **Stored argv:** slice 5 rewrites argv that names `lib/current/dg.js`, with a `config.json.pre-compiled` backup. `runtime/current` and `lib/current` stay on disk for the bridge, so a missed argv still runs.
- **Rollback inside the new scheme:** `dg install --version <v>` relinks `<data>/bin/current` with no download while `<data>/bin/<v>` exists.
- **Rollback to 6.3:** run `bootstrap.sh --version 6.3.0`. It rewrites the four launchers as shims over the bundle. Rewritten job argv still points at `<data>/bin/current/dg`, which 6.3 does not delete, so jobs run on the newer program until `dg-daemon autostart install` and a job update are run; docs (slice 7) give the two commands. Skills of 6.4 that call `dg pw` fail on the 6.3 `dg`; rollback must also reinstall 6.3 skills (bootstrap does).
- **Config rollback:** sources stay in place with `.pre-toml` copies, so 6.3 reads its old files unchanged.
- **PR split:** slices 1 to 8 (binary) and 9 to 13 (config) share no files except the ADR indexes in slice 1. Execution may cut two PRs; slice 1 goes with whichever PR lands first. Slice 11 does not need slice 2; `dg config` works as `dg-skills config` until slice 2 lands.
- **In-flight fix:** no slice edits the `Package the chat skills` step or scripts/package-chat-skills.ts. Slice 6 rebases on master after fix/release_chat_zip merges.

## Open Decisions

Each item is a RATIFY for the plan approval gate. Each line gives the recommendation that the slices build on.

- [OPEN — roundtable] RATIFY 1: single binary means a `bun build --compile` program per platform (planned, slices 3 to 6) or keep the ADR 0032 bundle and runtime with `dg` as the one launcher (drops slices 3 to 6).
- [OPEN — roundtable] RATIFY 2: agent session verbs and daemon lifecycle verbs stay grouped (`dg agent start`, `dg daemon status`).
- [OPEN — roundtable] RATIFY 3: old names stay as links until the next major release, with no notice in 6.x.
- [OPEN — roundtable] RATIFY 4: skill texts move to `dg ...` in this bundle (slice 8).
- [OPEN — roundtable] RATIFY 5: precedence is flag, env, TOML, default.
- [OPEN — roundtable] RATIFY 6: plugin entries are `[plugins.<name>]` with `enabled`, `source`, `settings`.
- [OPEN — roundtable] RATIFY 7: old config files stay in place and unread after migration until the next major release.
- [OPEN — roundtable] RATIFY 8: secrets as `{ credential = "<name>" }` references only.
- [OPEN — roundtable] RATIFY 9: jobs table and job sources stay daemon state, out of the TOML.
- [OPEN — roundtable] RATIFY 10: exec-allowlist stays a separate 0600 file.
- [OPEN — roundtable] RATIFY 11: browser-batch aliases and ssms config.yaml migrate into the TOML.
