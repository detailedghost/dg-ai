---
feature: "One dg binary and one config file"
feature_snake_case: one_dg_binary
date: "2026-11-21"
version: "1.0"
status: in-progress
current_slice: 8
pr_strategy: single
execution:
  profile: balance
slices:
  - id: 1
    name: "decision-records"
    depends_on: []
    files: ["docs/adr/**", ".agents/decisions/**"]
    agents:
      primary: dg:lore
      confidence: high
  - id: 2
    name: "flat-routes"
    depends_on: []
    files: ["pkg/dg/src/**", "pkg/dg/__tests__/**", "pkg/dg/package.json"]
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
    files: ["pkg/skills-cli/src/install/**", "pkg/skills-cli/bootstrap.sh", "pkg/skills-cli/bootstrap.ps1", "pkg/common/src/node/program.ts", "pkg/common/__tests__/program-command.spec.ts", "pkg/skills-cli/__tests__/bootstrap-*.spec.ts", "pkg/skills-cli/__tests__/install-*.spec.ts", "pkg/skills-cli/__tests__/bootstrap-fixtures.ts", "pkg/skills-cli/__tests__/bundle-build.ts", "pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts", "pkg/skills-test/__tests__/remote-install-*.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      effort: xhigh
      qa: [dg:qa-devops, dg:security]
  - id: 5
    name: "stored-argv-migration"
    depends_on: [4]
    files: ["pkg/dg-daemon/src/jobs/migrate.ts", "pkg/dg-daemon/src/commands/autostart.ts", "pkg/dg-agent/src/phone/listener.ts", "pkg/dg-daemon/__tests__/jobs/migrate.spec.ts", "pkg/dg-daemon/__tests__/commands/autostart.spec.ts", "pkg/dg-agent/__tests__/phone/listener-argv.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 6
    name: "release-compiled"
    depends_on: [3]
    files: [".github/workflows/release.yml", "pkg/skills-test/__tests__/release-*.spec.ts"]
    agents:
      primary: dg:devops
      confidence: high
      qa: [dg:qa-devops]
  - id: 7
    name: "dg-docs"
    depends_on: [2, 4, 6]
    files: ["docs/install.md", "docs/DEVELOPER.md", "docs/AGENT-INSTALL.md", "docs/jobs-and-services.md", "docs/phone.md", "docs/pw.md", "README.md", "CHANGELOG.md"]
    agents:
      primary: dg:lore
      confidence: high
  - id: 8
    name: "skill-texts"
    depends_on: [2]
    files: ["plugins/**", "pkg/skills-test/__tests__/skill-cli-invocation.spec.ts", "pkg/skills-test/__tests__/skill-bootstrap-block.spec.ts", "pkg/skills-test/__tests__/skill-flat-names.spec.ts"]
    agents:
      primary: dg:lore
      confidence: high
      qa: [dg:qa-code]
  - id: 9
    name: "config-core"
    depends_on: []
    files: ["pkg/common/src/node/dg-toml.ts", "pkg/common/src/node/dg-paths.ts", "pkg/common/src/node/index.ts", "pkg/common/package.json", "bun.lock", "pkg/common/__tests__/dg-toml*.spec.ts", "pkg/common/__tests__/dg-paths.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code, dg:security]
  - id: 10
    name: "config-migrate"
    depends_on: [9]
    files: ["pkg/common/src/node/dg-toml-migrate.ts", "pkg/common/src/node/dg-toml.ts", "pkg/common/__tests__/dg-toml-migrate*.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      effort: xhigh
      qa: [dg:qa-code, dg:security]
  - id: 11
    name: "config-command"
    depends_on: [9]
    files: ["pkg/skills-cli/src/commands/config.ts", "pkg/skills-cli/src/register-all.ts", "pkg/skills-cli/src/completion/tree.json", "pkg/skills-cli/__tests__/config-command*.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 12
    name: "config-consumers"
    depends_on: [10]
    files: ["pkg/common/src/node/dg-config.ts", "pkg/common/__tests__/dg-config.spec.ts", "pkg/skills-cli/src/hooks/config.ts", "pkg/skills-cli/src/hooks/cli.ts", "pkg/skills-cli/src/utils/cli-only.ts", "pkg/skills-cli/src/utils/refs.ts", "pkg/skills-cli/src/doctor/checks.ts", "pkg/inbox/src/config/**", "pkg/ssms/src/cli/run.ts", "pkg/skills-cli/__tests__/hooks/**", "pkg/skills-cli/__tests__/hooks-settings/**", "pkg/skills-cli/__tests__/doctor-command.spec.ts", "pkg/skills-cli/__tests__/doctor-fixtures.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 13
    name: "config-docs"
    depends_on: [11, 12]
    files: ["docs/config.md", "docs/hooks.md", "docs/inbox-cleanup.md", "docs/ssms.md"]
    agents:
      primary: dg:lore
      confidence: high
execution:
  profile: balance
permissions:
  run_commands: true
  git_push: true
  gh_pr_create: true
  auto_cleanup_worktree: true
  slice_commits: true
  housekeeping_commit: true
---

# One dg binary and one config file

## Purpose
Put every dg command under one flat `dg <command>` surface and ship it as one compiled program, which revives the single-binary decision of ADR 0020 and reverses that part of its 2026-11-18 amendment. Today dg already ships one minified bundle and one pinned Bun runtime (ADR 0032) behind four launchers, and the release already uses one `v<x>` tag, so the work is the flat command surface, a `bun build --compile` program, the stored-argv bridge, and skill texts. A second, separable slice set moves every dg config item into one `config.toml` in the dg config folder, with a `[plugins]` section, secrets kept in the credential store, and `dg config get/set/edit/path`.

## Scope
### Included
- Flat `dg <command>` for every dg-skills top-level command, plus agent `phone`, `overwatch`, `memory`, `mcp` and daemon `job`, `autostart`, `service`, derived from the three generated completion trees
- A collision rule: daemon lifecycle verbs (`serve`, `status`, `start`, `stop`, `restart`, `sessions`, `origin`) stay under `dg daemon`; agent session verbs (`start`, `send`, `recv`, `progress`, `spawn`, `stage`, `close`, `manifest`) stay under `dg agent`; a test fails on any new unowned collision
- `dg skills`, `dg agent` and `dg daemon` stay as group mounts, so every command keeps one full path
- One compiled `dg` program per platform with `bun build --compile --splitting --minify`; install writes no `dg-skills`, `dg-agent` or `dg-daemon` file and removes the old launchers on upgrade
- Install, bootstrap.sh, bootstrap.ps1 and self-update install the compiled program under `<data>/bin/<version>/` with a `current` link and keep the previous version folder for rollback; a 6.3 install updates through the bundle tarball bridge (see Release, Bridge and Rollback)
- Rewrite of stored argv that names `runtime/current/bun lib/current/dg.js` or an old program name (autostart unit, phone listener unit, jobs) to the compiled form, with a 0600 backup
- Rewrite of `dg-skills hooks run` lines in agent settings and git hooks to the `dg` program
- Every old-name reference inside dg-ai (skill texts, docs, tests, hooks, launchers, bootstrap, doctor, messages) moves to `dg`
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
- The browser extension and its `ext` artifact

### Slice 1 — decision-records

#### Engineering
- [x] Run `dg-skills adr new "One dg program with flat commands" --topic Platform` and write it: flat surface, collision rule, compiled program, removal of the old names, stored-argv rewrite, `v<x>` tag stays, the bundle tarball bridge for a 6.3 self-update, rollback
- [x] State that it supersedes ADR 0020 and its amendment where they disagree; add one link line to ADR 0020, and `Superseded in part by` lines to ADRs 0025 (skills call dg-skills), 0032 (runtime plus bundle shims) and 0049 (`dg job` runs `dg-daemon job`)
- [x] Run `dg-skills adr new "One config.toml for dg" --topic Platform`: path from resolveDgPaths().configDir, sections, precedence, migration and backup, secret references, `[plugins]`, what stays out (jobs table, exec-allowlist, channel review) as ratified
- [x] Run `dg-skills adr index` and `dg-skills adr lint`

#### Testing Criteria
##### Contracts
- [x] Contract: each new ADR has Status, Date, Topic, Context, Decision, Consequences, Other options and References, and `dg-skills adr lint` exits 0
- [x] Contract: ADR 0020 keeps its accepted text and amendment unchanged except one added link line

#### Acceptance Criteria
- [ ] Given the repo is opted in to adr lint, when the slice lands, then `dg-skills adr lint` exits 0 and both indexes list the two new records

### Slice 2 — flat-routes

#### Engineering
- [x] Replace the hand-written ROUTES with routes derived at dispatch time from the three generated trees (`pkg/skills-cli/src/completion/tree.json`, `pkg/dg-agent/src/completion-tree.json`, `pkg/dg-daemon/src/completion-tree.json`), imported lazily so `dg --version` and `dg --help` stay inside the startup budget
- [x] Add `pkg/dg/src/flat.ts` with `OWNERS` (a collision table: name to owning program), `GROUPED` (names that stay only under `dg agent` or `dg daemon`) and `ALIASES` (`upgrade` to `dg-skills update`, `extension` to `dg-skills install`)
- [x] Keep `skills`, `agent` and `daemon` as group mounts and keep `completion` and `help` as dg's own
- [x] Group `dg --help` output by area, and make `dg __complete` list the flat names

#### Testing Criteria
##### Contracts
- [x] Contract: `resolveRoute(word: string): { program: MountName; command: readonly string[] } | undefined` in pkg/dg/src/flat.ts
- [x] Contract: every top-level name of the three trees is reachable through `dg <name>` or `dg <group> <name>`, and no flat name resolves to two programs
- [x] Contract: a name that two trees share and that is not in `OWNERS` or `GROUPED` fails the collision test with the name and both programs
- [x] `dg pw --help` prints the same text as `dg-skills pw --help`; `dg phone --help` matches `dg-agent phone --help`; `dg job --help` matches `dg-daemon job --help` (extend parity.spec.ts)
- [x] `dg start` exits 1 with a hint that names `dg daemon start` and `dg agent start`
- [x] `dg --version` stays inside the existing startup budget
- [x] `dg help pw` prints the same text as `dg pw --help`, and `dg __complete pw` completes the skills subcommands

#### Acceptance Criteria
- [ ] Given a 6.x install, when the user runs `dg pw`, `dg db`, `dg stat`, `dg spec`, `dg adr`, `dg phone` or `dg job`, then each runs the same command as its old program form
- [x] Given a new dg-skills command, when the trees are regenerated, then it is reachable as `dg <name>` with no edit in pkg/dg

### Slice 3 — compiled-build

#### Engineering
- [x] Add `buildCompiled({ target, outfile })` in pkg/launcher/build.ts that runs `Bun.build` with `compile`, `splitting`, `minify`, the named chunks plugin and the `chromium-bidi` external, for the eight targets in runtime.json
- [x] Keep `buildLauncher` (bundle tarball) for the two-minor bridge
- [x] Keep the `<program> ...args` first-argument form in `dispatch` only for the bundle bridge (6.3 shims and stored argv that is not yet rewritten); it prints a one-line notice that names the `dg` form when the program is an old name. argv0 is read only to print the removed-name notice; it never selects a command tree. A compiled program started under an old name prints the same notice and exits 1
- [x] Update the size budget test for one compiled program

#### Testing Criteria
##### Contracts
- [x] Contract: `dispatch(argv: readonly string[], argv0?: string): Promise<number>`; argv `["dg-daemon", "serve"]` runs the daemon tree with a notice on stderr; argv `["pw", "--help"]` runs `dg pw --help`; argv0 `dg-skills` exits 1 with a notice
- [x] Contract: `buildCompiled` writes one executable per target; the linux-x64 output runs `--version` and prints the stamped version
- [x] A symlink named `dg-skills` to the compiled linux-x64 program exits 1 with the removed-name notice
- [x] Size budget: the compiled program stays under 100 MB

#### Acceptance Criteria
- [x] Given the compiled program, when it is started as `dg`, then `dg skills`, `dg agent`, `dg daemon` and every flat name run the matching tree

### Slice 4 — compiled-install

#### Engineering
- [x] Install the compiled program at `<data>/bin/<version>/dg` (`dg.exe` on Windows) and point a `<data>/bin/current` link at it, replaced by create-then-rename as in ADR 0032
- [x] Write `bin/dg` as a symlink to `<data>/bin/current/dg` on Linux and macOS and as a hard link `bin\dg.exe` on Windows (the running image is renamed aside first); write no old-name file; remove the old `dg`, `dg-skills`, `dg-agent`, `dg-daemon` shims and `.cmd` files and the `~/.dg/bin` notice launchers (on Windows the `.cmd` files are removed on the next install or daemon start, not in the 6.3 bridge step, because they are running batch files)
- [x] Keep `runtime/current` and `lib/current` in place during the bridge so stored argv that is not yet rewritten keeps working
- [x] The hidden `install launchers` step is the 6.3 bridge: a 6.3 self-update installs the new bundle, then runs it; it installs the compiled program of its own build version, rewrites units and hook lines, and removes the old launchers
- [x] Rewrite `dg-skills hooks run` lines in Claude, Codex and OpenCode settings and in git hooks to the `dg` program on install
- [x] Move every old-name message, help text and doctor check in pkg/ to `dg`
- [x] Select the compiled asset per platform in bootstrap.sh, bootstrap.ps1 and `dg install`, verify it against SHA256SUMS, run its `--version` before a link changes
- [x] `dg install --version <v>` relinks `bin/current` with no download while `<data>/bin/<v>` exists
- [x] Add `compiledProgramPath(root)` and `rewriteLauncherArgv(argv)` to program.ts; `launcherCommand` returns `[<data>/bin/current/dg, <group word>, ...args]`; `programCommand` uses `process.execPath` when compiled

#### Testing Criteria
##### Contracts
- [x] Contract: `launcherCommand(root, name, args)` returns `[join(root, "bin", "current", exe), <group word>, ...args]`, with the group word in the `name` position
- [x] Contract: `rewriteLauncherArgv(argv: readonly string[]): string[] | undefined` maps `[<root>/runtime/current/bun, <root>/lib/current/dg.js, ...rest]` to the compiled form and returns undefined for any other argv
- [x] An upgrade from a 6.3 layout keeps runtime/current and lib/current, adds bin/current and bin/dg, and leaves no dg-skills, dg-agent or dg-daemon file
- [x] bootstrap.sh and bootstrap.ps1 pick the right asset for each of the eight platform keys
- [x] A failed `--version` of the staged program leaves the old links in place

#### Acceptance Criteria
- [ ] Given a 6.3 install, when the user runs `dg upgrade`, then `dg` runs the compiled program, no old-name launcher is left, and old jobs still run
- [x] Given two installed versions, when the user runs `dg install --version <older>`, then `bin/current` points at the older program with no download

### Slice 5 — stored-argv-migration

#### Engineering
- [x] Add a third daemon-start migration under the config lock: rewrite each job argv that `rewriteLauncherArgv` maps, keep `config.json.pre-compiled` (0600), and log each rewrite
- [x] On daemon start and on `dg autostart install`, rewrite a login unit whose command names `lib/current/dg.js`
- [x] Rewrite the phone listener unit the same way on its next refresh

#### Testing Criteria
##### Contracts
- [x] Contract: the migration is idempotent; a second run changes nothing and writes no second backup
- [x] A job argv `[dg-skills, inbox, ...]` that names an old program by PATH is rewritten to `[dg, skills, inbox, ...]`; an argv that names another program is not touched
- [x] A systemd unit, a LaunchAgent and a scheduled task that name `lib/current/dg.js` are rewritten to `bin/current/dg daemon serve`

#### Acceptance Criteria
- [ ] Given jobs and units written by 6.3, when the upgraded daemon starts, then each one runs through the compiled program and the backup holds the old config

### Slice 6 — release-compiled

#### Engineering
- [x] Build the eight compiled assets in the bundle job (cross-compile with `--target`), name them `dg-<os>-<arch>[-baseline][.exe]`, and list them in SHA256SUMS
- [x] Smoke test: run `dg --version`, `dg pw --help` and `dg skills --version` on linux-x64, macOS and Windows runners
- [x] Keep the `v<x>` tag, keep `dg-lib-<v>.tar.gz` and `runtime.json` as assets for two minor releases
- [x] Do not edit the `Package the chat skills` step; rebase on master after fix/release_chat_zip merges

#### Testing Criteria
##### Contracts
- [x] Contract: release-workflow.spec.ts asserts the eight compiled asset names, the bridge assets, and one `v<x>` tag
- [x] release-triggers.spec.ts still passes with no new trigger

#### Acceptance Criteria
- [ ] Given a release run, when it publishes, then the release has eight compiled assets, the bundle tarball, runtime.json, bootstrap scripts and SHA256SUMS

### Slice 7 — dg-docs

#### Engineering
- [x] Document the flat surface, the collision rule, the compiled program, the links, the bridge and rollback
- [x] Use `dg <command>` in every example

#### Testing Criteria
##### Contracts
- [x] Contract: no doc in this slice tells a user to run `dg-skills <cmd>` where `dg <cmd>` exists, except in the bridge section

#### Acceptance Criteria
- [x] Given a new user, when they read docs/install.md, then every command they copy runs on a fresh install

### Slice 8 — skill-texts

#### Engineering
- [x] Rewrite `dg-skills <cmd>` to `dg <cmd>`, `dg-agent phone|overwatch|memory|mcp` to `dg <cmd>`, and `dg-daemon job|autostart|service` to `dg <cmd>` in skill texts; keep grouped verbs as `dg agent <verb>` and `dg daemon <verb>`
- [x] Change the generated first-run block to call `dg` and fall back to `${DG_HOME:-$HOME/.local}/bin/dg`
- [x] When the installed `dg` does not know a flat name (a plugin install newer than the CLI), the first-run block prints `run dg upgrade` as the next step

#### Testing Criteria
##### Contracts
- [x] Contract: skill-flat-names.spec.ts fails on any `dg-skills <name>` in plugins/** where `<name>` resolves flat
- [x] Every `dg <word>` in plugins/** resolves through `resolveRoute`

#### Acceptance Criteria
- [ ] Given the skills of this release, when an agent runs any command a skill prints, then it runs on the compiled program of the same release

### Slice 9 — config-core

#### Engineering
- [x] Add `configTomlPath: join(configDir, "config.toml")` to DgPaths; it follows XDG_CONFIG_HOME, APPDATA, macOS support and `<DG_HOME>/config`, and DG_PATH_FENCE checks it through the configDir role
- [x] Parse with `Bun.TOML.parse`; write with a pinned `smol-toml` stringify, atomically through `writeFilePreserving` with mode 0600
- [x] Schema with sections `[hooks]`, `[install]` (`cli_only`), `[refs.aliases]`, `[inbox]`, `[ssms]`, `[plugins.<name>]` (`enabled`, `source`, `settings`)
- [x] Precedence helper: CLI flag, then env, then TOML, then default
- [x] Secret fields take only `{ credential = "<name>" }`; a plain string in a secret field, or a value that looks like a token, fails validation
- [x] Validation errors throw DgCliError: `dg config: <file>:<line>: <key> must be <type>, got <value>. Next: run dg config edit, or dg config set <key> <value>.`

#### Testing Criteria
##### Contracts
- [x] Contract: `readDgToml(env?): DgToml` returns defaults for a missing file and throws DgCliError with file, line, key and a next step for a bad one
- [x] Contract: `setting<T>(key, { flag?, envVar? }): T` follows flag, env, TOML, default
- [x] Contract: `writeDgToml(key: string, value: unknown, env?)` validates before it writes and never writes a secret value
- [x] Contract: `resolveDgPaths({ env: { DG_HOME: d } }).configTomlPath` is `d/config/config.toml`; with DG_PATH_FENCE set outside it, resolveDgPaths throws
- [x] `[plugins.foo.settings]` with a `token = "abc..."` string fails; with `token = { credential = "foo-token" }` passes

#### Acceptance Criteria
- [x] Given a test that sets DG_HOME to a temp folder, when it reads config, then it never reads ~/.config/dg

### Slice 10 — config-migrate

#### Engineering
- [x] On the first read with no config.toml, fold `config.json` (hooks), the `cli-only` marker, `~/.config/browser-batch/config.json` aliases, the inbox organizer config and `ssms/config.yaml` into one config.toml, under the install lock
- [x] Copy each source to `<file>.pre-toml` (0600) and check the copy before writing the TOML; leave the source in place during the bridge
- [x] Move a secret value found in a source into the credential store and write a reference; on a failed store write, stop and write nothing
- [x] Record migrated sources and their sha256 in `[meta.migrated]`

#### Testing Criteria
##### Contracts
- [x] Contract: `migrateToToml(paths): { wrote: boolean; sources: string[]; backups: string[] }` is idempotent
- [x] Each source key appears in the TOML with the same value (round-trip test per source)
- [x] A broken JSON source leaves every file as it was and throws a DgCliError with a next step

#### Acceptance Criteria
- [x] Given a 6.3 config folder, when any dg command first reads config, then config.toml holds every value, each source has a backup, and no secret is in the TOML

### Slice 11 — config-command

#### Engineering
- [x] Register `config` with `get <key>`, `set <key> <value>` (plus `--credential <name>` for secret fields), `edit` (opens $EDITOR, validates on save, keeps the old file on failure) and `path`
- [x] Regenerate the completion trees with scripts/completion-trees.ts

#### Testing Criteria
##### Contracts
- [x] Contract: `dg config path` prints `resolveDgPaths().configTomlPath`
- [x] Contract: `config set` of a secret field with a plain value exits 1 and names `dg credentials` as the next step
- [x] `config get` of an unset key prints the default and exits 0; of an unknown key exits 1

#### Acceptance Criteria
- [x] Given slice 2 has landed, when the user runs `dg config path`, then it prints `resolveDgPaths().configTomlPath`, the same path as `dg skills config path`

### Slice 12 — config-consumers

#### Engineering
- [x] Make readDgConfig and writeDgConfig read and write the `[hooks]` table of config.toml
- [x] Read `cli_only`, ref aliases, inbox and ssms settings from config.toml
- [x] Add a doctor check that warns when a migrated source changed after migration and names `dg config edit`

#### Testing Criteria
##### Contracts
- [x] Contract: every reader goes through readDgToml; no reader opens config.json, cli-only or browser-batch config after migration
- [x] Hooks toggles round-trip through `dg hooks` with config.toml
- [x] Doctor warns when a source sha256 differs from `[meta.migrated]`

#### Acceptance Criteria
- [x] Given a migrated install, when the user changes a hook toggle, then only config.toml changes

### Slice 13 — config-docs

#### Engineering
- [x] Write docs/config.md: path per OS, DG_HOME and DG_PATH_FENCE isolation, sections, precedence, secret references, `[plugins]`, migration and backups, `dg config`
- [x] Point hooks, inbox and ssms docs at config.toml

#### Testing Criteria
##### Contracts
- [x] Contract: every key in the schema appears in docs/config.md

#### Acceptance Criteria
- [x] Given a user with an old config folder, when they read docs/config.md, then they know where each old value went and where its backup is

## Slice Summaries
- Slice 1: ADR 0055 "One dg program with flat commands" supersedes ADR 0020 where they disagree; link lines on ADRs 0020, 0025, 0032 and 0049; their agent rules updated; indexes regenerated; adr lint exits 0. The config ADR (0054) belongs to the config PR.
- Slice 2: pkg/dg/src/flat.ts derives flat routes from the three completion trees, with GROUPED (daemon lifecycle and agent session verbs), an empty OWNERS table and ALIASES (upgrade, extension). dg --help groups by area, dg __complete lists the flat names, a grouped verb such as dg start exits 1 naming dg agent start and dg daemon start, and collisions() fails on any unowned shared name. ROUTES is gone; three docs specs now resolve names through resolveRoute.
- Slice 3: buildCompiled in pkg/launcher/build.ts compiles dg for the eight runtime.json keys (assets dg-<key>[.exe]); the bundle build stays for the 6.3 bridge. dispatch(argv, argv0) runs dg words directly, keeps the <program> first-word form with a removed-name notice for 6.3 shims and stored argv, and exits 1 with the notice when the compiled program runs under an old name. The host build runs --version, pw --help, phone --help and job --help, and stays under 100 MB (about 93 MB). The bundle test fixture now runs dg group words.
- Slice 4: install, bootstrap.sh, bootstrap.ps1 and self-update install the compiled dg at <data>/bin/<version>/dg with a bin/current link and keep the replaced version; <bin>/dg is a symlink (a hard link dg.exe on Windows, the running image renamed aside). No old-name file is written; old 6.3 shims, links and ~/.dg/bin notice launchers are removed (Windows .cmd files wait for the next install in the bridge step). The hidden install launchers step is the 6.3 bridge. Hook commands that run dg-skills move to dg in Claude, Codex and OpenCode settings. launcherCommand and programCommand build the dg group form; rewriteLauncherArgv maps 6.3 argv. Every old-name message, commander name and completion tree in pkg/ now names dg. The runtime, bundle and shim writers and their tests are gone.
- Slice 5: At daemon start, under the config lock, migrateLauncherArgv rewrites job argv that runs the 6.3 bundle or names an old program (bare or by path) to the dg form, with one 0600 config.json.pre-compiled backup; a second run changes nothing. rewriteDaemonAutostart rewrites a systemd unit or LaunchAgent of this dg home that still runs lib/current/dg.js, with a 0600 <unit>.pre-compiled backup, and restarts nothing (systemd only reloads; a Windows task waits for dg autostart install). dg autostart install writes the new argv and checks only the compiled program. The phone listener unit moves on its next refresh through launcherCommand.
- Slice 6: The bundle job also cross-compiles the eight dg assets (bun run build.ts --compiled all) and uploads them with the bridge tarball and runtime.json. The smoke matrix runs each platform's compiled dg: --version, skills --version, pw --help, phone --help, job --help, dg start exits 1, and on Linux and macOS a dg-skills link gets the removed-name notice. The 6.3 bundle check stays. The v<x> tag and the chat skill step are unchanged.
- Slice 7: README, install, DEVELOPER, AGENT-INSTALL, jobs-and-services, phone, pw and every other doc now use dg <command>, describe the flat surface, the collision rule, the compiled program and its layout, the removal of the old names, the 6.3 upgrade bridge and rollback. Only the Upgrade from 6.3 section of docs/install.md names the old programs. SECURITY.md lists the compiled assets, CHANGELOG has a breaking entry, and ADR 0032 References point at compiled.ts. The docs specs follow.
- Slice 8: Every skill text calls dg <command> (dg agent <verb> and dg daemon <verb> for the grouped verbs); the generated first-run block calls dg, falls back to ${DG_HOME:-$HOME/.local}/bin/dg, and prints run dg upgrade when an installed dg does not know the word. skill-flat-names.spec.ts fails on any old-name call in plugins/ and on any dg word that does not resolve. Chat skill sources are re-pinned.

- (slice 1, config half) ADR 0054 "One config.toml for dg" and its decision rules; `adr lint --all` exits 0.
- (slice 9) `configTomlPath` in DgPaths; `dg-toml.ts` with readDgToml, setting, writeDgToml, validation with file:line and a next step, secret references; smol-toml 1.9.1 pinned exactly.
- (slice 10) `migrateToToml` and `migrateToTomlSync`: backups as `.pre-toml` (0600), secrets to the credential store, `[meta.migrated]` sha256, idempotent, write nothing on any failure.
- (slice 11) `dg-skills config path|get|set|edit`, a config doctor item, the completion tree.
- (slice 12) hooks, cli-only, refs, doctor, inbox and ssms read config.toml; migration runs after the layout preAction; doctor warns on a changed migrated source.
- (slice 13) docs/config.md plus hooks, inbox and ssms docs; config-docs.spec.ts.

## Agent Notes

- (owner, 2026-11-21) RATIFY 1: a compiled `dg` executable per platform (`bun build --compile`), eight release assets.
- (owner, 2026-11-21) RATIFY 3 replaced: remove the old names now. Install writes no `dg-skills`, `dg-agent` or `dg-daemon` links or launchers and removes the old launchers on upgrade. Dispatch by argv0 is not needed; the `dg dg-daemon serve` first-argument form stays only where the bundle bridge needs it.
- (owner, 2026-11-21) Fix every old-name regression inside dg-ai: skill texts, docs, tests, hooks, launchers, bootstrap, doctor, and self-update from 6.3.x. Running an old name gives a clear message if a stale file remains.
- (owner, 2026-11-21) A 6.3 install must update into the compiled `dg`; keep the tarball bridge for self-update only if needed (it is needed: 6.3 self-update reads `dg-lib-<v>.tar.gz` and `runtime.json`).
- (owner, 2026-11-21) RATIFY 2: flat `dg <command>` for every dg-skills command plus agent phone, overwatch, memory and mcp and daemon job, autostart and service. Daemon lifecycle verbs stay under `dg daemon`; agent session verbs stay under `dg agent`. A bare `dg start` exits 1 with a hint. A test fails on any new unowned collision.
- (owner, 2026-11-21) The long-running daemon is `dg daemon serve`. Stored job argv and login units that name lib/current/dg.js or an old program name are rewritten once, at daemon start and on `dg autostart install`; the rewrite is idempotent and keeps a 0600 backup.
- (owner, 2026-11-21) RATIFY 4: skill texts move to `dg <cmd>` in this bundle, with a guard test so no `dg-skills`, `dg-agent` or `dg-daemon` call remains in plugins/.
- (owner, 2026-11-21) Outside callers: dg-ai only, plus Dante's ~/scripts skills and hooks, edited by hand after the release ships.
- (owner, 2026-11-21) PR split: the binary PR carries slices 1 to 8 with the ADR that replaces 0020 (ADR 0055); the config PR carries slices 9 to 13 with the config ADR (ADR 0054).
- (owner, 2026-11-21) execution.profile is balance.

Self-review of the slices (one pass, in place of the per-slice fan-out): file sets pass `spec lint-waves`; the ADR index generator and the completion-tree generator each have one owning slice; slice 4 is the largest and carries `effort: xhigh`; slice 8 got a version-skew step; slice 2 got `dg help` and completion checks. If RATIFY 1 picks the bundle, drop slices 3 to 6, and slice 7 loses its compiled sections. If RATIFY 9 or 10 moves jobs or the exec-allowlist into the TOML, add one slice for each after slice 10, with a daemon write-lock contract and `dg:security` QA.
- (owner, 2026-11-21) The config file is `<configDir>/config.toml`: `~/.config/dg/config.toml`, following XDG_CONFIG_HOME. With DG_HOME set it is `<DG_HOME>/config/config.toml`, inside DG_PATH_FENCE.
- (owner, 2026-11-21) RATIFY 5: precedence is flag > env > TOML > default.
- (owner, 2026-11-21) RATIFY 8: secrets and credentials stay in the encrypted credential DB. The TOML holds only `{ credential = "<name>" }` references, never values and never `{{resolve:...}}`. Migration moves any secret value it finds into the credential store.
- (owner, 2026-11-21) RATIFY 6: plugins use `[plugins.<name>]` tables with `enabled`, `source` and `settings`.
- (owner, 2026-11-21) RATIFY 7: old config files are kept but not read, with `.pre-toml` backups and a doctor warning if they change.
- (owner, 2026-11-21) RATIFY 9 and 10: the daemon jobs table and the exec-allowlist stay separate files.
- (owner, 2026-11-21) RATIFY 11: browser-batch aliases and ssms config.yaml migrate into the TOML.
- (owner, 2026-11-21) The binary half (slices 1 to 8) and the config half (slices 9 to 13 plus the config ADR of slice 1) ship as two PRs. The config ADR takes 0054; the binary ADR takes 0055.

## Issues Remediation

## Code Structure

### Route source for the flat surface
- **Decision:** `pkg/dg/src/flat.ts` derives flat routes from the three generated completion trees; `OWNERS`, `GROUPED` and `ALIASES` are the only hand-written entries. Skills code (slice 8) imports `resolveRoute` for its guard test.
- **Home:** `pkg/dg/src/flat.ts`
- **Rationale:** about 60 names stay in step with commands at zero cost, and a new collision fails a test.
- **Alternatives:** hand-written ROUTES — drifts on every new command; mounting the three commander programs into one — loads every tree at startup and breaks the startup budget.
- **Applies to:** slices 2, 8, 11

### Launcher argv contract
- **Decision:** the program takes `dg` arguments directly; the `<program> ...args` first-argument form stays only as the bundle bridge for 6.3 shims and stored argv, with a notice. argv0 is read only to print the removed-name notice; it never selects a command tree. `launcherCommand` and `rewriteLauncherArgv` live in `pkg/common/src/node/program.ts` and are the only code that builds or rewrites stored argv.
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
- **Why the tarball bridge works:** a 6.3 self-update downloads the new tarball, checks `bun dg.js dg-skills --version`, links `lib/current`, then runs `<bin>/dg-skills install launchers` through its own shim. That hidden step is new code: it installs the compiled program of its build version and removes the old launchers. After the bridge, an older install re-runs `bootstrap.sh` once.
- **Names:** `dg-skills`, `dg-agent` and `dg-daemon` are removed in this release. Install writes none of them and removes the old launchers. A stale 6.3 shim runs the bridge bundle, which prints a notice that names the `dg` form.
- **Stored argv:** slice 5 rewrites argv that names `lib/current/dg.js`, with a `config.json.pre-compiled` backup. `runtime/current` and `lib/current` stay on disk for the bridge, so a missed argv still runs.
- **Rollback inside the new scheme:** `dg install --version <v>` relinks `<data>/bin/current` with no download while `<data>/bin/<v>` exists.
- **Rollback to 6.3:** run `bootstrap.sh --version 6.3.0`. It rewrites the four launchers as shims over the bundle. Rewritten job argv still points at `<data>/bin/current/dg`, which 6.3 does not delete, so jobs run on the newer program until `dg-daemon autostart install` and a job update are run; docs (slice 7) give the two commands. Skills of 6.4 that call `dg pw` fail on the 6.3 `dg`; rollback must also reinstall 6.3 skills (bootstrap does).
- **Config rollback:** sources stay in place with `.pre-toml` copies, so 6.3 reads its old files unchanged.
- **PR split:** slices 1 to 8 (binary) and 9 to 13 (config) share no files except the ADR indexes in slice 1. Execution may cut two PRs; slice 1 goes with whichever PR lands first. Slice 11 does not need slice 2; `dg config` works as `dg skills config` until slice 2 lands.
- **In-flight fix:** no slice edits the `Package the chat skills` step or scripts/package-chat-skills.ts. Slice 6 rebases on master after fix/release_chat_zip merges.

## Open Decisions

Each item is a RATIFY for the plan approval gate. Each line gives the recommendation that the slices build on.

- [RATIFIED (owner, 2026-11-21): compiled program] RATIFY 1: single binary means a `bun build --compile` program per platform (planned, slices 3 to 6) or keep the ADR 0032 bundle and runtime with `dg` as the one launcher (drops slices 3 to 6).
- [RATIFIED (owner, 2026-11-21)] RATIFY 2: agent session verbs and daemon lifecycle verbs stay grouped (`dg agent start`, `dg daemon status`).
- [REPLACED (owner, 2026-11-21): old names are removed now] RATIFY 3: old names stay as links until the next major release, with no notice in 6.x.
- [RATIFIED (owner, 2026-11-21)] RATIFY 4: skill texts move to `dg ...` in this bundle (slice 8).
- [OPEN — roundtable] RATIFY 5: precedence is flag, env, TOML, default.
- [OPEN — roundtable] RATIFY 6: plugin entries are `[plugins.<name>]` with `enabled`, `source`, `settings`.
- [OPEN — roundtable] RATIFY 7: old config files stay in place and unread after migration until the next major release.
- [OPEN — roundtable] RATIFY 8: secrets as `{ credential = "<name>" }` references only.
- [OPEN — roundtable] RATIFY 9: jobs table and job sources stay daemon state, out of the TOML.
- [OPEN — roundtable] RATIFY 10: exec-allowlist stays a separate 0600 file.
- [OPEN — roundtable] RATIFY 11: browser-batch aliases and ssms config.yaml migrate into the TOML.
