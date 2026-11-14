---
feature: "service install"
feature_snake_case: service_install
date: "2026-11-14"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "test-home-fence"
    depends_on: []
    files: ["bunfig.toml", "pkg/*/bunfig.toml", "pkg/skills-cli/__tests__/test-home-fence.ts", "pkg/skills-cli/__tests__/home-fence.spec.ts", "pkg/skills-test/__tests__/test-support.ts", "pkg/skills-test/__tests__/home-fence-reach.spec.ts", "pkg/common/src/node/dg-paths.ts", "pkg/common/__tests__/dg-paths.spec.ts", "pkg/*/__tests__/**/*.ts", "pkg/inbox/test/**/*.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
  - id: 2
    name: "service-install-core"
    depends_on: [13]
    files: ["pkg/dg-daemon/src/services/packages.ts", "pkg/dg-daemon/src/services/defaults.ts", "pkg/dg-daemon/src/commands/service.ts", "pkg/dg-daemon/src/commands/service-package.ts", "pkg/dg-daemon/src/commands/service-support.ts", "pkg/dg-daemon/__tests__/services/packages.spec.ts", "pkg/dg-daemon/__tests__/services/defaults.spec.ts", "pkg/dg-daemon/__tests__/commands/service-install.spec.ts", "pkg/dg-daemon/__tests__/commands/service-package-kit.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      effort: xhigh
      qa: [dg:security, dg:qa-code]
  - id: 3
    name: "daemon-autostart"
    depends_on: [1, 4]
    files: ["pkg/common/src/node/autostart.ts", "pkg/common/src/node/index.ts", "pkg/common/__tests__/node-autostart.spec.ts", "pkg/dg-agent/src/phone/autostart.ts", "pkg/dg-agent/src/phone/commands.ts", "pkg/dg-agent/src/phone/store.ts", "pkg/dg-agent/__tests__/phone/autostart.spec.ts", "pkg/dg-agent/__tests__/phone/listener-stale.spec.ts", "pkg/dg-daemon/src/commands/autostart.ts", "pkg/dg-daemon/src/main.ts", "pkg/dg-daemon/__tests__/commands/autostart.spec.ts", "pkg/dg-daemon/__tests__/main.spec.ts", "pkg/dg-daemon/src/commands/start.ts", "pkg/dg-daemon/src/commands/stop.ts", "pkg/dg-daemon/__tests__/commands/start.spec.ts", "pkg/dg-daemon/__tests__/commands/stop.spec.ts", "pkg/common/src/node/daemon-start.ts", "pkg/common/__tests__/node-daemon-start.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:qa-devops]
  - id: 4
    name: "layout-stale-daemon"
    depends_on: [1]
    files: ["pkg/common/src/node/layout.ts", "pkg/common/src/node/layout-work.ts", "pkg/common/src/node/sqlite-unused.ts", "pkg/common/__tests__/tree-copy.spec.ts", "pkg/common/__tests__/layout.spec.ts", "pkg/common/__tests__/layout-stale-daemon.spec.ts", "pkg/skills-cli/__tests__/layout-stale-daemon-compiled.spec.ts", "pkg/dg-daemon/__tests__/main-blocked.spec.ts", "pkg/common/src/errors.ts", "pkg/skills-cli/src/install/doctor.ts", "pkg/skills-cli/__tests__/install-doctor-layout.spec.ts", "pkg/skills-cli/__tests__/layout-fixtures.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:qa-code]
  - id: 5
    name: "service-update"
    depends_on: [2]
    files: ["pkg/dg-daemon/src/commands/service-package.ts", "pkg/dg-daemon/src/services/packages.ts", "pkg/dg-daemon/src/services/defaults.ts", "pkg/dg-daemon/__tests__/commands/service-update.spec.ts", "pkg/dg-daemon/__tests__/commands/service-package-kit.ts", "pkg/dg-daemon/__tests__/services/packages.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:security]
  - id: 6
    name: "service-label-verbs"
    depends_on: [2, 3]
    files: ["pkg/dg-daemon/src/commands/service.ts", "pkg/dg-daemon/src/commands/service-logs.ts", "pkg/dg-daemon/__tests__/commands/service-verbs.spec.ts", "pkg/dg-daemon/__tests__/commands/service-logs.spec.ts", "pkg/common/src/node/log-tail.ts", "pkg/common/src/node/index.ts", "pkg/common/__tests__/node-log-tail.spec.ts", "pkg/channel-review/src/daemon/logs.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
  - id: 7
    name: "channel-review-export"
    depends_on: [13]
    files: ["pkg/skills-cli/src/channel-review/cli.ts", "pkg/skills-cli/src/channel-review/export.ts", "pkg/skills-cli/__tests__/channel-review-export.spec.ts", "pkg/skills-cli/__tests__/channel-review-cli.spec.ts", "plugins/dg/skills/channel-review/references/commands.md", "pkg/skills-test/__tests__/channel-review-skill.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
  - id: 8
    name: "service-docs"
    depends_on: [4, 5, 6, 7]
    files: ["docs/adr/*-service-packages.md", "docs/adr/toc.md", "docs/jobs-and-services.md", "docs/service-api.md", "docs/install.md", "docs/channel-review.md", "SECURITY.md", "plugins/dg/skills/jobs/SKILL.md", "pkg/skills-test/__tests__/outside-services-docs.spec.ts", "pkg/skills-test/__tests__/service-install-docs.spec.ts"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: low
      qa: [dg:reviewer]
  - id: 9
    name: "dg-program"
    depends_on: [4, 5, 6, 7]
    files: ["pkg/common/src/node/program.ts", "pkg/common/src/node/self-command.ts", "pkg/common/__tests__/program-command.spec.ts", "pkg/dg/**", "pkg/launcher/src/dg.ts", "pkg/launcher/src/programs/dg.ts", "pkg/launcher/package.json", "pkg/launcher/__tests__/*.ts", "bun.lock"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:qa-code]
  - id: 10
    name: "dg-launcher-install"
    depends_on: [9]
    files: ["pkg/skills-cli/src/install/shims.ts", "pkg/skills-cli/src/install/cli.ts", "pkg/skills-cli/src/install/skills-only.ts", "pkg/skills-cli/src/commands/install.ts", "pkg/skills-cli/src/install/compat-launchers.ts", "pkg/skills-cli/src/doctor/*.ts", "pkg/skills-cli/bootstrap.sh", "pkg/skills-cli/bootstrap.ps1", "pkg/skills-cli/__tests__/install*.spec.ts", "pkg/skills-cli/__tests__/compat-launchers.spec.ts", "pkg/skills-cli/__tests__/clean*.spec.ts", "pkg/skills-cli/__tests__/bootstrap-fixtures.ts", "pkg/skills-cli/__tests__/agent-only-install.spec.ts", "pkg/skills-cli/__tests__/skills-only*.spec.ts", "pkg/skills-cli/__tests__/doctor-*.spec.ts", "pkg/skills-cli/__tests__/doctor-fixtures.ts", "pkg/skills-test/__tests__/binary-distribution.spec.ts", "pkg/skills-test/__tests__/cli-smoke.spec.ts", "pkg/skills-test/__tests__/retired-binaries.spec.ts", "pkg/skills-test/__tests__/bootstrap-asset-selection.spec.ts", ".github/workflows/release.yml", ".github/workflows/skills-blt.yml", "pkg/skills-cli/src/install/clean.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:qa-devops]
  - id: 11
    name: "dg-front-door-docs"
    depends_on: [8, 10]
    files: ["docs/adr/0020-one-dg-command.md", "docs/adr/toc.md", "docs/jobs-and-services.md", "docs/install.md", "docs/AGENT-INSTALL.md", "docs/DEVELOPER.md", "README.md", "pkg/skills-test/__tests__/outside-services-docs.spec.ts", "pkg/skills-test/__tests__/service-install-docs.spec.ts", "pkg/skills-test/__tests__/dg-front-door-docs.spec.ts"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: low
  - id: 12
    name: "remove-channel-review"
    depends_on: [11]
    files: ["pkg/channel-review/**", "pkg/skills-cli/src/channel-review/**", "pkg/skills-cli/src/commands/channel-review.ts", "pkg/skills-cli/src/register-all.ts", "pkg/skills-cli/src/doctor/registry.ts", "pkg/skills-cli/src/credentials/cli.ts", "pkg/skills-cli/package.json", "pkg/skills-cli/README.md", "pkg/skills-cli/__tests__/**", "bun.lock", "pkg/common/src/node/daemon-schema.ts", "pkg/common/src/node/daemon-db.ts", "pkg/common/src/node/install-skills.ts", "pkg/common/__tests__/**", "pkg/dg-daemon/__tests__/store/**", "pkg/dg-daemon/__tests__/server/credentials-frame.spec.ts", "plugins/dg/skills/channel-review/**", "plugins/dg/skills/jobs/SKILL.md", "plugins/dg/skills/doctor/SKILL.md", "plugins/dg/skills/thrash/SKILL.md", "plugins/dg/skills/README.md", "pkg/skills-test/__tests__/**", "docs/**", "README.md", "SECURITY.md", ".env.example", ".gitleaks.toml", ".mise/config.toml", ".github/workflows/skills-blt.yml"]
    agents:
      primary: dg:js
      confidence: high
      complexity: high
      qa: [dg:dba, dg:qa-devops, dg:reviewer]
  - id: 13
    name: "service-paths-and-guard"
    depends_on: [1]
    files: ["pkg/common/src/node/dg-paths.ts", "pkg/common/__tests__/dg-paths.spec.ts", "pkg/common/src/node/fs.ts", "pkg/common/__tests__/node-fs.spec.ts", "pkg/channel-review/src/address.ts", "pkg/channel-review/__tests__/core-address.spec.ts", "pkg/dg-daemon/src/services/supervisor.ts", "pkg/dg-daemon/__tests__/services/supervisor-state-dir.spec.ts", "pkg/dg-daemon/__tests__/services/supervisor-kit.ts", "pkg/dg-daemon/__tests__/services/supervisor.spec.ts", "pkg/dg-daemon/__tests__/services/supervisor-service-api.spec.ts"]
    agents:
      primary: dg:js
      confidence: high
      complexity: medium
      qa: [dg:qa-code]
execution:
  profile: balance
---

# service install

## Purpose
Let the owner run a program from a git repository as a dg-daemon service: `dg-daemon service install <git-url>` pins a commit, shows what the repository asks for, and writes ordinary service entries after the owner agrees. Add service control by label, a login unit for the daemon, and `dg` as one entry command over the three command trees. Fix two defects: tests that write into the real dg home, and a layout migration that leaves a stale daemon folder in use. Then remove channel review from dg in a separate major release, after the review bot runs from its own repository under `service install`.

## Scope
### Included
- `dg-daemon service install <git-url>[@ref]`, `update <package>`, `uninstall <package>` and `list`, with `<data>/services/packages.json`, the `dg` key of the repository package.json, a pinned full commit id and a consent step
- `dg-daemon service enable|disable|restart|logs` by label, on top of `service add|rm|status|start|stop`
- `dg-daemon autostart install|remove|status`, with the autostart module moved to pkg/common; the phone listener keeps its unit
- `removeInside` and `insideRoot` in pkg/common/src/node/fs.ts
- The injected key `DG_SERVICE_STATE_DIR`, an addition to service API v1
- `dg-daemon start` and `dg-daemon restart` through the service manager when a login unit is installed
- The test home fence in each package, with an error when a DG path leaves it
- The layout fix for the `daemon` entry, and a block when two daemon folders hold data
- `dg-skills channel-review export --env <env> --label <label>`, which writes `<state>/services/<label>/import.json`
- The `dg` program: `ProgramName`, the package pkg/dg, the launcher entry, a fourth launcher, the bootstrap scripts and one doctor check
- The groups `dg service`, `dg job` and `dg autostart`; the mounts `dg skills`, `dg agent` and `dg daemon`; the aliases `dg extension`, `dg install`, `dg upgrade` and `dg doctor`
- ADR 0047, the amendment of ADR 0020, docs/jobs-and-services.md and the jobs skill
- The removal of channel review from dg (slice 12, its own PR, a major release, behind an operator gate)
### Excluded
- The review bot repository; it has its own spec bundle
- One merged binary and the `dg-v<x>` release tag of ADR 0020
- A `dg review` group
- Services in `<config>/config.json`; `<state>/daemon/config.json` stays the one file that the daemon reads
- A git command in the daemon process
- A login unit that `service enable` writes
- `passEnv` as the way to give an installed service its environment
- A change of the usage lines or error prefixes of the mounted programs
- `dg` names in SKILL.md files; the skills keep `dg-skills`, `dg-agent` and `dg-daemon`
- A `--yes` option or an `--accept` option for the consent step
- A merge of two daemon folders or of a stale `config.json`
- A change of `dg-agent start`; it starts a detached daemon as before
- A second run of the old `build` after a failed `update`
- The delete of stored credentials, grants or service state folders
- `CHANGELOG.md` and the version stamps; .github/workflows/release.yml writes them

### Slice 1 — test-home-fence

#### Engineering
- [ ] Reproduce the leak first: on master, `bun test` in pkg/dg-daemon, pkg/common and pkg/skills-test runs with the `DG_HOME` and `HOME` of the shell, because only the root bunfig.toml and pkg/skills-cli/bunfig.toml preload the fence, and CI and `bun run test:all` run `bun test` in each package directory
- [ ] In pkg/skills-cli/__tests__/test-home-fence.ts, set `process.env.DG_PATH_FENCE` to `os.tmpdir()`, not to the fence home: 312 `mkdtempSync(join(tmpdir(), …))` calls in 170 spec files make their homes as siblings of the fence home, and pkg/skills-cli/__tests__/home-fence.spec.ts already uses `os.tmpdir()` as the limit
- [ ] Do not move the temp homes of the specs below the fence home
- [ ] In `resolveDgPaths` of pkg/common/src/node/dg-paths.ts, read `DG_PATH_FENCE` from the same `env` object that gives the roots (`seams.env ?? process.env`)
- [ ] When `DG_PATH_FENCE` is not empty and one of the six roots or `legacyHome` is not below that directory, throw an `Error` with the text `dg path fence: <role> <path> is outside <fence>`
- [ ] Compare paths by segment with the path module of the call (`win32` or `posix`, as `resolveDgPaths` selects it), so the fence `/f` does not accept `/f2`
- [ ] On win32, compare with no letter case
- [ ] Resolve the two sides with that path module before the compare
- [ ] A path that is equal to the fence is inside the fence
- [ ] Accept a path below the fence or below `realpathSync(<fence>)`: on macOS `os.tmpdir()` is below `/var`, which is a link to `/private/var`
- [ ] When the fence folder does not exist, use the fence as given
- [ ] Run the fence check before the memo lookup, so a cached result of a call with no fence cannot pass a later call with a fence
- [ ] A call that throws adds nothing to the path cache
- [ ] Add `pkg/<name>/bunfig.toml` with `[test] preload = ["../skills-cli/__tests__/test-home-fence.ts"]` for each package that has a `test` script and no bunfig.toml: channel-review, common, dg-agent, extension, inbox, launcher, pages, skills-test, ssms, tour-ui
- [ ] In pkg/dg-daemon/bunfig.toml, put the fence first in `preload`; keep the two other entries and `timeout = 15000`
- [ ] Do not change the preload lists of the root bunfig.toml and pkg/skills-cli/bunfig.toml
- [ ] `runInHarness` in pkg/skills-test/__tests__/test-support.ts spreads `process.env`, so its child has the fenced `HOME` and `DG_PATH_FENCE`; it needs no change, only the spec of the `runInHarness` Happy path line
- [ ] Find each spawn in a spec or a test helper that does not spread `process.env`: search for `env:` next to `Bun.spawn` or `spawn(` in each `__tests__` folder
- [ ] Make each such spawn give the child a `HOME` below `os.tmpdir()` and the `DG_PATH_FENCE` of the parent
- [ ] For each spec that the fence stops, change only its environment setup or its `seams`; do not change its assertions
- [ ] Search the specs for `delete process.env.DG_HOME` and for `resolveDgPaths()` calls that pass the real `homedir()`
- [ ] List each spec that the fence stopped, and each changed spawn, in the PR body
- [ ] A spec that tests the default roots passes `seams.homeDir` and `seams.env`; it does not delete `process.env.DG_HOME` and then call `resolveDgPaths()` with no seams, because `os.homedir()` of bun keeps the real home after `HOME` changes
- [ ] Add pkg/skills-test/__tests__/home-fence-reach.spec.ts: it reads each pkg/*/package.json and fails when a package with a `test` script has no bunfig.toml that preloads the fence
- [ ] The reach spec parses the `[test] preload` list of each bunfig.toml, resolves each entry from the package folder, and compares the real path with pkg/skills-cli/__tests__/test-home-fence.ts
- [ ] The reach spec checks only packages whose `test` script runs `bun test`; it also checks the root bunfig.toml
- [ ] Write no file below the repository root and no file below the real home in a test
- [ ] The fence guards `resolveDgPaths` only; code that calls `os.homedir()` directly is not in the fence (install-skills.ts, scratch-paths.ts, hooks/cli.ts, db/credentials.ts, the unit writers of slice 3)
- [ ] Do not make this slice wider for that code; state the limit in the PR body
- [ ] State in the PR body that the fence is as tight as `TMPDIR`
- [ ] State in the PR body that a product process with `DG_PATH_FENCE` set and a root outside it stops with the fence error

#### Testing Criteria
##### Contracts
- [ ] Contract: `resolveDgPaths({ env: { DG_PATH_FENCE: "/f", DG_HOME: "/f/x" } })` returns the paths below `/f/x`
- [ ] Contract: `resolveDgPaths({ env: { DG_PATH_FENCE: "/f", DG_HOME: "/g" } })` throws an `Error` whose message starts with `dg path fence:` and holds `is outside /f`
- [ ] Contract: `resolveDgPaths({ env: { DG_PATH_FENCE: "/f", DG_HOME: "/f2/x" } })` throws
- [ ] Contract: with no `DG_PATH_FENCE` in `env`, `resolveDgPaths` returns the same object as before this change for each platform in pkg/common/__tests__/dg-paths.spec.ts
- [ ] Contract: a call with an explicit `seams.env` that has no `DG_PATH_FENCE` does not throw when `process.env.DG_PATH_FENCE` is set
- [ ] Contract: `resolveDgPaths({ env: { DG_HOME: "/g" } })` returns; the same call with `DG_PATH_FENCE: "/f"` added then throws
- [ ] Contract: a root that is equal to `DG_PATH_FENCE` does not throw
- [ ] Contract: `resolveDgPaths({ platform: "win32", env: { DG_PATH_FENCE: "C:\\f", DG_HOME: "C:\\f2\\x" } })` throws
- [ ] Contract: the same win32 call with `DG_HOME: "c:\\F\\x"` returns
- [ ] Contract: in pkg/dg-daemon, the env object of `subprocessEnv` has no `XDG_CONFIG_HOME`, and its `HOME` is below `os.tmpdir()`
- [ ] Contract (red step, by hand): before the bunfig edits, home-fence-reach.spec.ts fails and names dg-daemon, common, skills-test and dg-agent; record the failing names in the PR body; after the change it passes
- [ ] Happy path: in each package directory, a spec sees `process.env.DG_HOME`, `process.env.HOME` and `process.env.USERPROFILE` below `os.tmpdir()`
- [ ] Happy path: a child of `runInHarness` with no `env` override resolves each DG root below `os.tmpdir()`
- [ ] Happy path: a daemon that `spawnServe` starts in a `freshDgHome()` folder boots with the inherited `DG_PATH_FENCE`
- [ ] Error: a child that `runInHarness` starts with a script that calls `resolveDgPaths()`, with `DG_HOME=<a directory outside the fence>` and the `DG_PATH_FENCE` of the parent, exits with a code that is not 0, and stderr holds `dg path fence:`; do not use the `dg-daemon` entry for this test
- [ ] Error: in a fenced spec, `delete process.env.DG_HOME` and then `resolveDgPaths()` throws the fence error
- [ ] Check: set `HOME` and `DG_HOME` of the shell to two empty sentinel directories, run `bun test` in each package directory, and list the sentinels; they hold no file
- [ ] Regression: `bun test` passes at the root and in each package directory; `bun run lint` passes in pkg/common and pkg/skills-test

#### Acceptance Criteria
- [ ] Given a shell that exports `DG_HOME` and `HOME`, when `bun test` runs in pkg/dg-daemon, pkg/common, pkg/dg-agent or pkg/skills-test, then no file below those two directories is created or changed through a DG path
- [ ] Given a spec that resolves a DG path outside the fence, when the spec runs, then it fails with `dg path fence:` and names the path
- [ ] Given a new package with a `test` script and no fence preload, when pkg/skills-test runs, then home-fence-reach.spec.ts fails and names the package
- [ ] Given a process with no `DG_PATH_FENCE`, when it resolves the DG paths, then the result is the same as before this change

### Slice 2 — service-install-core

#### Engineering
- [ ] Create pkg/dg-daemon/src/commands/service-support.ts; move these from service.ts with no change of behavior, and export them: `withConfigLock`, `findLiveDaemon`, `callDaemon`, `isDeclared`, `guardConfig`, `readInstancePid`, and `resolveExecutable(command, prefix)`, where the prefix replaces the fixed text `service add:`
- [ ] Add to service-support.ts and export: `assertDaemonAnswers(paths, label)` (the `does not answer` guard of `service rm`), `liveServiceStates(paths)` (the `state` of each label from `GET /services`, or `undefined` with no live daemon) and `assertNoLiveInstance(paths, label)` (the instance pid file guard of `service rm`)
- [ ] service.ts imports the helpers from service-support.ts; `service rm` calls the three guards; the existing service specs pass with no change
- [ ] Slices 5 and 6 import service-support.ts and do not edit it
- [ ] Create pkg/dg-daemon/src/services/packages.ts: a strict reader and a writer for `paths.servicePackagesPath`; the file is one JSON object keyed by package name; each value is `{ url: string, ref: string | null, sha: string, labels: string[], defaultsHash: string }`
- [ ] The registry reader returns `{}` when the file is absent, and throws an `Error` that names the file when the content is not a JSON object
- [ ] The registry writer uses `writeFilePreserving(file, data, 0o600)` and keeps the records of the other packages
- [ ] Create pkg/dg-daemon/src/services/defaults.ts: `parseServiceDefaults(packageJson: unknown, dirs: { cloneDir: string; stateDir: (label: string) => string })` reads the `dg` key and returns one entry for each label of `dg.services`, with `cwd` set to `cloneDir`
- [ ] `parseServiceDefaults` is pure: it checks the shape, fills `cwd` and resolves `envFile`; it reads no file and no PATH
- [ ] `parseServiceDefaults` returns errors with no command prefix; the caller adds `service install:` or `service update:`, and the caller builds the text `<url> has no "dg" key in package.json`
- [ ] `parseServiceDefaults` accepts the keys `services`, `requires` and `build` in `dg`, and the keys `argv`, `envFile`, `grant` and `stopTimeoutMs` in each service; it names each other key in the error
- [ ] `parseServiceDefaults` validates each entry with `parseServiceEntry`, so a repository block and `service add` follow one rule set
- [ ] `defaultsHash` is the SHA-256 hex of the JSON text of the `dg` value with object keys sorted at each level
- [ ] Create pkg/dg-daemon/src/commands/service-package.ts with the actions of `install`, `uninstall` and `list` and the export `registerServicePackageCommands(service: Command)`; pkg/dg-daemon/src/commands/service.ts calls it one time, so slice 5 adds `update` with no edit of service.ts
- [ ] The edit of service.ts in this slice is the import of service-support.ts and one `registerServicePackageCommands(service)` line; slice 6 adds its verbs and does not touch that line
- [ ] Export from service-package.ts the deps type of the package commands: `confirm(question): Promise<boolean>`, `isTerminal(): boolean`, `runGit(args, options): Promise<{ code, stdout, stderr }>`, `runBuild(argv, cwd): Promise<number>` and `which(name): string | undefined`; each action takes it as a seam
- [ ] Export `defaultsHash` from defaults.ts, and `formatRequest`, `resolveRef` and `sanitize` from service-package.ts; slice 5 calls them
- [ ] `service install <git-url>[@ref]`: remove a leading `<scheme>://`, then find the last `@` of the remaining text; it separates the ref only when the text before it holds a `/` or a `:`; with no ref, the value is `null` and the default branch of the remote is used
- [ ] `install` refuses an argument, a URL or a ref that starts with `-`
- [ ] The package name is the text after the last `/` or `:` of the URL, without `.git`, in lower case; it is a folder name, so it must match the label pattern of pkg/dg-daemon/src/services/config.ts (64 characters at most); a package name is not a label
- [ ] `install` refuses a package name that the registry holds
- [ ] Before the clone, `install` refuses when the clone folder `serviceCloneDir(paths, package)` exists
- [ ] `install` runs `git -c protocol.ext.allow=never clone --no-recurse-submodules -- <url> <serviceCloneDir(paths, package)>` in the CLI process with the environment of the caller; the daemon runs no git command
- [ ] A local path and a `file://` URL are permitted
- [ ] `install` refuses a URL that starts with `ext::` or `fd::` before a git process starts
- [ ] With a terminal, git gets the stdin of the caller; with no terminal, the git child gets `GIT_TERMINAL_PROMPT=0`
- [ ] `resolveRef(deps, cloneDir, ref)` gives a full commit id: a tag first, then `origin/<ref>`, then a full commit id; `null` gives `origin/HEAD`
- [ ] `install` checks out the commit id, not the ref text: `git checkout --detach <40 hexadecimal characters> --`
- [ ] `install` reads the full 40-character commit id with `git rev-parse HEAD` after the checkout and stores it as `sha`
- [ ] The clone runs before the question, so it must run no code of the repository: no `--recurse-submodules`, and no command of the `dg` block before the answer `y`
- [ ] `install` refuses when a label of the block is already in the `services` table of the daemon config
- [ ] `install` prints the request before it asks: the package, the URL, the ref, the full sha, and for each label the `argv`, `grant`, `envFile` (the absolute path that the entry will store) and `stopTimeoutMs`; then `requires` and `build` as written in the block
- [ ] Each text of the request that comes from the repository goes through `sanitize`, which replaces each control character (U+0000 to U+001F, U+007F to U+009F) with a visible escape of the form `\u{…}`
- [ ] On a terminal, `install` asks `Install these services? [y/N]`; only `y` or `yes` in any letter case continues
- [ ] An empty line, an end of input and an interrupted read are the answer `no`
- [ ] Each `install` failure and a `no` answer remove the clone with `removeInside(paths.servicesDir, cloneDir)`, only when this run made the clone, and write nothing to the daemon config or the registry
- [ ] An interrupt (Ctrl-C) between the clone and the write removes the clone
- [ ] `install` takes the config lock that `service add` uses one time, after `build`; inside the lock it reads the registry and the config again and checks again that the package name and each label are free
- [ ] Inside the lock, `install` writes each service entry through `writeServiceEntry`, then the registry record
- [ ] When a step inside the lock throws, `install` removes each entry that this run wrote and removes the clone
- [ ] `writeServiceEntry` puts a written entry last in the `services` table; the order of the table is not a contract
- [ ] `install` writes no `autostart` key; `service enable` sets it
- [ ] `install` creates `serviceStateDir(paths, label)` for each label with `ensurePrivateDir`
- [ ] `service uninstall <package>` uses the guards of `service rm` for each label of the package: `assertDaemonAnswers`, the refusal of a `running` or `backoff` label on a live daemon, and `assertNoLiveInstance`
- [ ] `uninstall` deletes each service entry of the package, then the registry record, then the clone with `removeInside(paths.servicesDir, cloneDir)`
- [ ] `uninstall` keeps each `serviceStateDir(paths, label)` and prints its path
- [ ] `uninstall` is safe to run again: an entry, a registry record or a clone that is absent is not a failure
- [ ] `service list [--json]` reads the registry only; it needs no daemon
- [ ] New failures throw `DgCliError(message, EXIT_GENERAL_FAILURE)`
- [ ] Build the fixture repository in a temp directory at test time (`git init`, one commit with a package.json that has a `dg` block); do not add a git repository to the tree
- [ ] service-package-kit.ts exports `makeRepo({ dg, files }): { dir, sha }` and `commit(repo, { dg, files, tag, branch }): string`; slice 5 adds commits with `commit` and does not write the kit again
- [ ] Test the consent step in process with the `confirm` seam of the deps type; a subprocess has no terminal
- [ ] The specs that need a live daemon or a subprocess (the Happy path, Edge and Error lines of this slice) are in service-install.spec.ts and use daemon-harness.ts as it is; each other spec runs in process with the seams
- [ ] No spec starts `git` with a network URL; the clone failure Contract uses a path that does not exist
- [ ] The Contracts that say `start no git process` count the calls of the `runGit` seam
- [ ] The specs make each executable in a temp folder and give it through the `which` seam; they do not use the PATH of the machine
- [ ] Do not edit pkg/dg-daemon/src/main.ts, pkg/common/src/node/index.ts or pkg/dg-daemon/__tests__/utils/daemon-harness.ts
- [ ] Order of `install`: parse the argument; refuse `ext::`, `fd::` and a leading `-`; check the registry; check that the clone folder is absent; clone; resolve the ref; check out the commit; read the commit id; read and parse the block; check the labels; check `requires` and each bare `argv[0]` name; print the request; check the terminal; ask; run `build`; resolve each `argv[0]` path in the clone; take the lock; check the registry and the labels again; write the entries; write the registry; print the result
- [ ] The clone and its network traffic occur before the terminal check on purpose: with no terminal the command still prints the request
- [ ] A relative `envFile` of the block resolves below `serviceStateDir(paths, label)`; the stored entry holds the absolute path
- [ ] `parseServiceDefaults` refuses an absolute `envFile`, and a relative `envFile` that leaves the state folder of its label (use `insideRoot`)
- [ ] `install` does not create the env file; for each label with an `envFile` that does not exist, it prints the path after the result
- [ ] service-package.ts resolves `argv[0]` of a block entry in two steps, with the rule of `service add`; before the question, a bare name must resolve with the `which` seam, and the result is the stored value
- [ ] After `build` and before the first write, a name with a path separator resolves from the clone folder; its real path (`realpathSync`) must be inside the real path of the clone, must exist and must be executable; the stored value is the absolute path inside the clone
- [ ] `requires` is an array of executable names with no path separator; `install` checks each name with the `which` seam of the deps type before the question; the default of that seam is `Bun.which`, as in `checkExecutableResolves`
- [ ] `build` is one argv: a non-empty array of non-empty strings; `install` runs it one time, after the answer `y` and before the first write, in the clone folder, with no shell, with the environment and the terminal of the caller
- [ ] A `build` that does not start, or that exits with a code other than 0, fails the install: the clone is removed and nothing is written
- [ ] A block with no `build` runs no command
- [ ] When stdin or stdout is not a terminal, `install` prints the request, then fails; it asks no question
- [ ] `install` has no `--yes` option and no `--accept` option
- [ ] The terminal check is the `isTerminal` seam of the deps type

#### Testing Criteria
##### Contracts
- [ ] Contract: the registry file is `{ "<package>": { "url", "ref", "sha", "labels", "defaultsHash" } }`; `sha` has 40 hexadecimal characters; `ref` is a string or `null`
- [ ] Contract: `parseServiceDefaults` on `{ "dg": { "services": { "bot-dev": { "argv": ["bun", "run", "bot.ts"] } } } }` gives one valid entry with `cwd` equal to the clone directory
- [ ] Contract: a package.json with no `dg` key fails with `service install: <url> has no "dg" key in package.json`
- [ ] Contract: a service key or a `dg` key that is not in the accepted lists fails with `service install: unknown key(s): <names>`
- [ ] Contract: an entry that `parseServiceEntry` refuses fails with `service install: service "<label>": <validator error>`
- [ ] Contract: `git@host:org/bot.git@v1.2.0` gives the URL `git@host:org/bot.git`, the ref `v1.2.0` and the package `bot`; `git@host:org/bot.git` gives the ref `null`; `https://host/org/Bot` gives the package `bot`
- [ ] Contract: `git@host:bot.git` gives the ref `null` and the package `bot`; `ssh://git@host/org/bot.git` gives the ref `null`; `https://host/org/bot@release/1.0` gives the ref `release/1.0`; `/tmp/bot@v1` gives the URL `/tmp/bot` and the ref `v1`
- [ ] Contract: `service install -- --upload-pack=x` and `service install https://host/org/bot@-x` exit 1 with `service install: a URL or a ref cannot start with "-"`, and start no git process
- [ ] Contract: a URL whose last segment does not match the label rule fails with `service install: cannot use "<segment>" as a package name`
- [ ] Contract: `install` exit 0 prints `installed package "<package>" at <first 12 characters of sha> with services: <labels joined with a comma and a space>`, then one line `next: dg-daemon service enable <label>` for each label
- [ ] Contract: a second `install` of the same package name exits 1 with `package "<package>" is already installed from <url> — run dg-daemon service update <package>`
- [ ] Contract: a label that the `services` table holds exits 1 with `service install: a service labelled "<label>" already exists`
- [ ] Contract: a `no` answer exits 1 with `service install: declined; nothing was installed`
- [ ] Contract: a failed `git clone` exits 1 with `service install: git clone failed: <first line of the git stderr>`
- [ ] Contract: after each failure, a clone directory that this run made is absent, and the bytes of the daemon config and of packages.json do not change
- [ ] Contract: each written service entry passes `parseServices`, has an absolute `cwd` equal to `serviceCloneDir(paths, package)`, and has no `autostart` key and no key outside the keys of `parseServiceEntry`
- [ ] Contract: `uninstall` exit 0 prints `uninstalled package "<package>"`, then one line `kept state: <path>` for each label
- [ ] Contract: `uninstall` of a package with no registry record and no clone folder exits 1 with `no package named "<package>"`
- [ ] Edge: with no registry record and an existing clone folder (an `uninstall` that stopped before its last step), `uninstall <package>` removes the clone and exits 0
- [ ] Contract: `uninstall` with a `running` or `backoff` label on a live daemon exits 1 with `service "<label>" is <state> — stop it first with dg-daemon service stop <label>`, and changes no file
- [ ] Contract: `list` prints one line for each package: `<package>  <first 12 characters of sha>  <ref or ->  <url>  services: <labels>`; with no package it prints `no packages installed` and exits 0
- [ ] Contract: `list --json` prints one line `{"packages":[{"package","url","ref","sha","labels"}]}`; with no package it prints `{"packages":[]}`
- [ ] Contract: a block entry with `"envFile": "bot.env"` gives the stored `envFile` `<state>/services/<label>/bot.env`
- [ ] Contract: `"envFile": "/abs/bot.env"` and `"envFile": "../bot.env"` fail with `service install: service "<label>": "envFile" must be a relative path inside the state folder of the service`
- [ ] Contract: for each label whose `envFile` does not exist, exit 0 also prints `next: create <absolute envFile path> with mode 600 before you start <label>`
- [ ] Contract: each stored `argv[0]` is an absolute path: `["tool", "run"]` stores the path that the `which` seam gives for `tool`, and `["./bin/run"]` stores `<clone>/bin/run`
- [ ] Contract: `["../x"]` fails with `service install: service "<label>": "argv" must stay inside the repository`; a bare name that does not resolve fails with `service install: executable "<name>" does not resolve on PATH`
- [ ] Contract: `"requires": ["nope-tool"]` exits 1 with `service install: required executable(s) do not resolve on PATH: nope-tool` before the question; the `confirm` seam gets no call
- [ ] Contract: a `requires` value that is not an array of names with no path separator fails with `service install: "requires" must be an array of executable names`
- [ ] Contract: a `build` value that is not a non-empty array of non-empty strings fails with `service install: "build" must be a non-empty array of non-empty strings`
- [ ] Contract: `build` runs one time, with the clone folder as its working directory, after the `confirm` seam returns true and before packages.json exists
- [ ] Contract: a `build` that exits with 3 makes `install` exit 1 with `service install: build failed (exit 3): <argv joined with spaces>`; the clone is absent and no file changed
- [ ] Contract: a `no` answer runs no `build`
- [ ] Contract: with stdin that is not a terminal, `install` prints the request text on stdout, exits 1 with `service install: consent needs a terminal — run this command in a terminal yourself` on stderr, leaves no clone, and writes nothing
- [ ] Contract: `service install --yes <url>` and `service install --accept x <url>` exit 1 with the unknown-option error of commander, and start no git process
- [ ] Contract: `service uninstall` does not delete a state folder
- [ ] Contract: `install <path>@<branch>` pins the head of that branch when the default branch is a different branch
- [ ] Contract: `service install 'ext::sh -c "touch <marker>"'` exits 1 with `service install: the URL scheme "ext::" is not allowed`, starts no git process, and the marker does not exist
- [ ] Contract: with no terminal, the environment of the clone process holds `GIT_TERMINAL_PROMPT=0`
- [ ] Contract: a `build` that creates `./dist/bot` and an `argv` of `["./dist/bot"]` installs
- [ ] Contract: an `argv[0]` that is a link to a file outside the clone fails with `service install: service "<label>": "argv" must stay inside the repository`; the clone is absent and no file changed
- [ ] Contract: with an injected failure of the second entry write, the bytes of the daemon config and of packages.json are equal to the bytes before, and the clone is absent
- [ ] Contract: with an existing `<data>/services/<package>` folder and no registry record, `install` exits 1 with `service install: <path> already exists — remove it, then run the command again`, starts no git process, and leaves the folder
- [ ] Contract: when the `confirm` seam rejects with an abort, the clone is absent and no file changed
- [ ] Contract: with a daemon pid that is alive and does not answer, `uninstall` exits 1 with the `does not answer` text of `service rm` and changes no file
- [ ] Contract: with an instance pid file that names a live process, `uninstall` exits 1 with the `still runs as pid` text of `service rm` and changes no file
- [ ] Contract: an `argv` value that holds `ESC[2K` shows the text `\u{1b}[2K` in the request, and stdout holds no ESC byte
- [ ] Contract: an empty answer exits 1 with the `declined` text
- [ ] Contract: `list` with a packages.json that is not a JSON object exits 1 and names the file
- [ ] Contract: a record with a `sha` that is not 40 hexadecimal characters, or with `labels` that is not an array of labels, makes the registry reader throw an `Error` that names the file and the package
- [ ] Contract: a `dg` block with no service exits 1 with `service install: <url> declares no services`; the clone is absent
- [ ] Contract: `install https://host/org/Bot` after `install https://host/org/bot` exits 1 with the `already installed` text
- [ ] Contract: the registry stores the full `sha`; only the printed form has 12 characters
- [ ] Happy path: `install` from a local fixture repository with two labels writes two entries and one registry record whose `sha` is equal to `git rev-parse HEAD` of the fixture
- [ ] Happy path: `install <path>@<tag>` pins the commit of the tag when the default branch has a newer commit
- [ ] Happy path: `install`, then `uninstall`, leaves a daemon config that is deep-equal to the first config plus `"services": {}`
- [ ] Edge: `install` keeps `pinnedOrigin` and each entry that `service add` wrote
- [ ] Edge: `uninstall` keeps a service that `service add` wrote
- [ ] Edge: `uninstall` with no live daemon removes the package and makes no HTTP call
- [ ] Edge: an entry that a package wrote can be started: with a live daemon, `service start <label>` gives the state `running` and the child has the clone directory as its working directory
- [ ] Edge: after `service rm <label>` of one label of the package, `uninstall <package>` exits 0 and removes the remaining entries, the record and the clone
- [ ] Error: `install` on a daemon config that is not valid JSON exits 1, names the file, and removes the clone
- [ ] Happy path: a fixture package with `envFile` and `build` installs; its `build` writes a marker file in the clone; with the env file in place, the service starts and prints the value of `DG_SERVICE_STATE_DIR`
- [ ] Regression: `bun test` and `bun run lint` pass in pkg/dg-daemon; pkg/launcher/__tests__/size-budget.spec.ts passes, and packages.ts, defaults.ts and service-support.ts are not in the static closure of dg.js

#### Acceptance Criteria
- [ ] Given a git repository with a `dg` block that declares two services, when the owner runs `dg-daemon service install <url>` and answers `y`, then the daemon config holds the two entries with `cwd` in `<data>/services/<package>`, and packages.json holds the URL, the ref and the full commit id
- [ ] Given the request text of `install`, when the owner reads it, then it shows the full commit id and each `argv`, `grant`, `envFile` and `build` value before the question
- [ ] Given the answer `n`, when `install` ends, then no clone, no service entry and no registry record remain
- [ ] Given an installed package with stopped services, when the owner runs `dg-daemon service uninstall <package>`, then its entries, its registry record and its clone are gone, and its state directories remain
- [ ] Given pkg/dg-daemon/src, when a search for `git` runs in `server/` and `services/supervisor.ts`, then it finds no git command
- [ ] Given a block with `"envFile": "bot.env"`, when the package is installed, then the entry points at `<state>/services/<label>/bot.env`, outside the clone
- [ ] Given a block whose `requires` names a program that is not installed, when `install` runs, then it stops before the question and names the program
- [ ] Given a `build` that fails, when `install` ends, then no clone, no service entry and no registry record remain
- [ ] Given an agent session with no terminal, when it runs `dg-daemon service install <url>`, then the command prints the request and exits 1, and no option gives consent

### Slice 3 — daemon-autostart

#### Engineering
- [ ] Move pkg/dg-agent/src/phone/autostart.ts to pkg/common/src/node/autostart.ts and export it from pkg/common/src/node/index.ts with `export *`
- [ ] That `export *` adds `RunResult`, `AutostartDeps`, `AutostartKind`, `AutostartState`, `AutostartOutcome` and `AutostartSpec` to `@dg/common/node`; no such name is in use there today
- [ ] Add `name: "dg-phone" | "dg-daemon"` to `AutostartSpec`
- [ ] Each exported function that has no spec today (`systemdUnitPath`, `launchdPlistPath`, `windowsTaskXmlPath`, `managedRestartCommands`, `removeAutostart`) gets the same name as a parameter
- [ ] Derive from the name: the systemd unit `<name>.service`, the launchd label `com.detailedghost.<name>`, the task name `<name>`, and the task XML file `<name>.task.xml`
- [ ] For `dg-phone`, each path, each unit text and each manager command is byte-identical to the result on master: `Description=dg phone listener`, the task XML in `paths.phoneRoot`, and `--dg-home <path>` after `listen`
- [ ] For `dg-daemon`: `Description=dg daemon`, the task XML in `paths.daemonDir`, and the argv `launcherCommand(paths.dataDir, "dg-daemon", ["serve"])`
- [ ] The `logPath` of the `dg-daemon` spec is `<paths.logDir>/dg-daemon-autostart.log`; launchd writes stdout and stderr there, and systemd writes to the journal
- [ ] Add the optional field `restartPreventExitStatus?: number[]` to `AutostartSpec`; for `dg-daemon` it is `[EXIT_WSL_NAT_NETWORKING, EXIT_LAYOUT_BLOCKED]` (slice 4 adds the second constant), and the systemd unit gets the line `RestartPreventExitStatus=3 78` after `RestartSec=5`
- [ ] The `dg-phone` unit gets no `RestartPreventExitStatus` line
- [ ] For `dg-daemon`, pass a set `DG_HOME` in the systemd `Environment=` line and in the launchd `EnvironmentVariables` dictionary, as the phone unit does
- [ ] On win32 with `DG_HOME` set, `autostart install` fails: a scheduled task has no environment block and `dg-daemon serve` has no `--dg-home` option
- [ ] pkg/dg-agent/src/phone/commands.ts and store.ts import from `@dg/common/node` and pass `dg-phone`; delete pkg/dg-agent/src/phone/autostart.ts
- [ ] Move pkg/dg-agent/__tests__/phone/autostart.spec.ts to pkg/common/__tests__/node-autostart.spec.ts; change the import path and add the name argument only
- [ ] Before the move, add to that spec the full master output of `systemdUnitText`, `launchdPlistText`, `windowsTaskXml` and `managedRestartCommands` for fixed specs, as literal strings; the moved code must give those strings for `dg-phone`
- [ ] Create pkg/dg-daemon/src/commands/autostart.ts with the actions `install`, `remove` and `status`; each action takes `AutostartDeps` as a seam
- [ ] `autostart install` first checks that the two files of `launcherCommand(paths.dataDir, "dg-daemon", ["serve"])` exist: `argv[0]` and the `dg.js` path
- [ ] `autostart install` with a live daemon that the service manager did not start prints `a daemon is already running outside the service manager; run dg-daemon restart to hand it over` after the `installed` line
- [ ] `autostart remove` with a live daemon prints `hint: run dg-daemon stop first; the service manager has a shorter stop limit` before it removes the unit
- [ ] Register `dg-daemon autostart install|remove|status` in pkg/dg-daemon/src/main.ts with lazy imports, as `start` does
- [ ] `autostart install` on Linux and in WSL: after `enable --now`, run `loginctl enable-linger` (ADR 0020)
- [ ] `autostart install` in WSL (`WSL_DISTRO_NAME` is set): after the linger command, register a Windows login task that runs `wsl.exe -d <distro> --exec true` (ADR 0020)
- [ ] The WSL task has the name `dg-daemon-wsl-<distro>`, so it is not the native task `dg-daemon`
- [ ] Build the XML of the WSL task with the existing `windowsTaskXmlBytes` and the argv `["wsl.exe", "-d", <distro>, "--exec", "true"]`; this argv gets no `--dg-home`
- [ ] Write the XML to `<paths.daemonDir>/dg-daemon-wsl.task.xml`, get its Windows path with `wslpath -w`, and run `schtasks.exe /Create /TN <name> /XML <windows path> /F`
- [ ] In WSL the argv[0] of the task commands is `schtasks.exe`; on win32 it is `schtasks`
- [ ] When `loginctl enable-linger` or the task create fails, remove the unit as `removeAutostart` does and exit 1 with `autostart install: <command> failed: <first line of its stderr>`
- [ ] `autostart remove` in WSL also runs `schtasks.exe /Delete /TN dg-daemon-wsl-<distro> /F` and removes the XML file of the task; `autostart remove` does not change the linger setting
- [ ] Export `autostartInstalled(deps, paths, name): AutostartKind | undefined` from pkg/common/src/node/autostart.ts; it runs no manager command and reports from the unit file
- [ ] Export `autostartManages(deps, paths, name): AutostartKind | undefined`: it gives the kind only when the unit file exists and the `DG_HOME` that the unit records is equal to the `DG_HOME` of the caller (two unset values are equal; a task unit records none)
- [ ] Export `defaultAutostartDeps(): AutostartDeps` from pkg/common/src/node/autostart.ts (the real `run`, `writeFile`, `removeFile`, `fileExists`, `homeDir`, `env`, `platform` and `uid`); dg-agent phone/commands.ts, the dg-daemon `autostart` command, `cmdStart`, `cmdRestart` and `service enable` (slice 6) use it as the default of their seam
- [ ] `autostart status` calls `autostartInstalled`; `cmdStart`, `cmdRestart` and the hint of `service enable` (slice 6) call `autostartManages`
- [ ] No spec calls an `autostart` action, `cmdStart` or `cmdRestart` with the default deps: the unit path comes from `os.homedir()`, which the fence does not change; each spec gives a `homeDir` below `os.tmpdir()`
- [ ] The subprocess specs of start.spec.ts and stop.spec.ts get the fenced `HOME` and no `XDG_CONFIG_HOME` from `subprocessEnv` (slice 1), so they find no unit of the machine
- [ ] Run `bun test pkg/launcher/__tests__/size-budget.spec.ts` one time after the move; it builds each package, so a build failure in a file of slice 2, 7 or 13 is a retry, not a finding
- [ ] Do not edit pkg/dg-daemon/src/commands/service.ts or pkg/common/src/node/dg-paths.ts
- [ ] `cmdStart` and `cmdRestart` call `assertNotBlocked(paths, "daemon")` before a manager command and before a spawn
- [ ] In `cmdStart` of pkg/dg-daemon/src/commands/start.ts: when no daemon is live and `autostartManages(deps, paths, "dg-daemon")` gives a kind, run each command of `managedRestartCommands(kind, uid, "dg-daemon")` in order, and spawn no daemon
- [ ] Run the manager commands as the phone listener does (pkg/dg-agent/src/phone/commands.ts): the exit code of one command does not stop the next; `schtasks /End` of a stopped task fails with no harm
- [ ] After the manager commands, wait for a live daemon with `waitForFreshDaemon` of pkg/common/src/node/daemon-start.ts (100 ms poll, 15000 ms limit); give that function the `export` keyword (index.ts already exports the module), and write no second poll loop
- [ ] The WSL NAT check of `ensureDaemonRunning` (`checkWslNetworking`) also runs before a manager command
- [ ] With a live daemon, `cmdStart` prints the `already running` line of master and runs no manager command
- [ ] In `cmdRestart` of pkg/dg-daemon/src/commands/stop.ts: with a login unit that `autostartManages` reports, stop the daemon in the way of master (SIGTERM and the wait, or `--force`), then run the manager commands and wait; do not call the detached spawn
- [ ] On POSIX, for a regular stop, the CLI stops the daemon itself and sends no manager stop command: the stop limit of a service manager is shorter than the 255 s wait of `dg-daemon stop`
- [ ] With no login unit, `start` and `restart` behave as on master
- [ ] On POSIX a regular `cmdStop` does not change and runs no manager command; it makes the daemon exit with 0, so a unit with `Restart=on-failure` does not start it again
- [ ] On win32 each stop is a kill (`taskkill /F`), so with a login unit a regular `cmdStop` also runs `schtasks /End /TN dg-daemon` after the kill
- [ ] An idle exit of the daemon is also exit code 0, so the unit does not start the daemon again; the next `dg-daemon start` uses the service manager, and `dg-agent start` spawns a detached daemon that the unit does not own
- [ ] `cmdStop --force` with a login unit: a kill is a failure for the service manager (`Restart=on-failure`, launchd `KeepAlive`), so after the kill the CLI tells the manager not to start the daemon again; the unit stays installed and starts the daemon at the next login
- [ ] launchd, `cmdStop --force` with a login unit: after the kill, run `launchctl bootout gui/<uid>/com.detailedghost.dg-daemon`
- [ ] launchd, the managed start of `dg-daemon`: run `launchctl bootstrap gui/<uid> <plist path>` (a failure is ignored: the service is loaded), then `launchctl kickstart -k gui/<uid>/com.detailedghost.dg-daemon`; the command list of `dg-phone` does not change
- [ ] After that forced stop, `dg-daemon start` starts the daemon through the service manager
- [ ] `dg-agent start` does not change: it calls `ensureDaemonRunning` with no manager step
- [ ] `cmdStart` and `cmdRestart` take `AutostartDeps` as a seam; no spec runs a real manager command
- [ ] With a login unit, the daemon that the manager starts has the environment of the unit, not of the caller; the rule of spec 014 (the environment of the caller of `restart`) stays for the case with no login unit
- [ ] The unit records `DG_HOME` only; it records no `PATH`, and slice 8 documents that a service gets more `PATH` from its `envFile`

#### Testing Criteria
##### Contracts
- [ ] Contract: `systemdUnitPath(home, env, "dg-phone")`, `launchdPlistPath(home, "dg-phone")`, `windowsTaskXmlPath(paths, "dg-phone")`, `systemdUnitText`, `launchdPlistText`, `windowsTaskXml` and `managedRestartCommands` give the same strings as on master, and the spec holds those strings as literals
- [ ] Contract: for `dg-daemon`, the systemd unit path ends with `systemd/user/dg-daemon.service`, and `ExecStart=` holds the quoted argv `<dataDir>/runtime/current/bun`, `<dataDir>/lib/current/dg.js`, `dg-daemon`, `serve`
- [ ] Contract: `removeAutostart(deps, paths, "dg-daemon")` does not read, stop or remove the `dg-phone` unit, and the reverse
- [ ] Contract: `autostart install` exit 0 prints `autostart installed (<systemd|launchd|task>): dg-daemon starts at login`
- [ ] Contract: when the service manager is not available, `autostart install` exits 1 with `autostart install: <reason>` and leaves no unit file
- [ ] Contract: `autostart remove` exit 0 prints `autostart removed`, or `autostart: not installed` when no unit file exists
- [ ] Contract: `autostart status` exit 0 prints `autostart: installed (<kind>)` or `autostart: not installed`; `--json` prints `{"installed":<boolean>,"kind":"<kind>"|null}`
- [ ] Contract: win32 with `DG_HOME` set exits 1 with `autostart install: a scheduled task cannot pass DG_HOME; unset DG_HOME, then run the command again`
- [ ] Contract: the output, the exit codes and the stored `autostart` state of `dg-agent phone open` and `phone close` do not change
- [ ] Contract: with a login unit (recording deps, systemd) and no live daemon, `cmdStart` runs `systemctl --user restart dg-daemon.service` one time and calls no spawn; stdout is the `started` line of master, and `--json` gives `"started":true`
- [ ] Contract: with a login unit and a live daemon, `cmdStart` runs no manager command and prints the `already running` line
- [ ] Contract: `cmdRestart` with a login unit records this order: SIGTERM to the daemon pid, the wait until the pid is gone, the manager command; stdout holds the two lines of master
- [ ] Contract: `cmdRestart --force` with a login unit does the force stop of master, then the manager command
- [ ] Contract: `cmdStop --force` with a login unit (recording deps, systemd) kills the daemon as on master, then runs `systemctl --user stop dg-daemon.service`; the unit file stays
- [ ] Contract: after `cmdStop --force` with a login unit, the service manager does not start the daemon before the next login or the next `dg-daemon start`; this holds for systemd, launchd and the task kind
- [ ] Contract: on POSIX a regular `cmdStop` with a login unit runs no manager command
- [ ] Contract: on win32 a regular `cmdStop` with a login unit runs `schtasks /End /TN dg-daemon` one time (recording deps)
- [ ] Contract: the managed start of `dg-daemon` on launchd runs `launchctl bootstrap gui/<uid> <plist path>`, then `launchctl kickstart -k gui/<uid>/com.detailedghost.dg-daemon`; the task kind runs `schtasks /End /TN dg-daemon`, then `schtasks /Run /TN dg-daemon`
- [ ] Contract: when no daemon is live 15000 ms after the manager commands, the command exits 1 with `dg-daemon did not become healthy within the startup timeout`; when a manager command had an exit code other than 0, the text ends with ` (<command line> failed: <first line of its stderr>)`
- [ ] Contract: with `WSL_DISTRO_NAME` set and `DG_WSL_NETWORKING_MODE=nat`, `cmdStart` with a login unit exits 3 and runs no manager command
- [ ] Contract: with no login unit, `cmdStart` and `cmdRestart` run no manager command; pkg/dg-daemon/__tests__/commands/start.spec.ts and stop.spec.ts pass with no change to an existing assertion
- [ ] Contract: the output, the exit codes and `StartSeams` of `dg-agent start` do not change
- [ ] Contract: the `dg-daemon` systemd unit holds `RestartPreventExitStatus=3 78`; the `dg-phone` unit text is equal to master
- [ ] Contract: when `argv[0]` or the `dg.js` path of the unit is absent, `autostart install` exits 1 with `autostart install: <path> is missing; install dg first` and writes no unit file
- [ ] Contract: with a unit that records `DG_HOME=/a` and a caller with `DG_HOME=/b`, `cmdStart` runs no manager command and spawns the daemon as on master
- [ ] Contract: with a unit that records the `DG_HOME` of the caller, `cmdStart` runs the manager command
- [ ] Contract: `cmdStop --force` with a login unit (recording deps, launchd) kills the daemon as on master, then runs `launchctl bootout gui/<uid>/com.detailedghost.dg-daemon`; the plist file stays
- [ ] Contract: for the launchd and the task kinds (recording deps), `cmdStart` after `cmdStop --force` runs the managed start commands and no spawn
- [ ] Contract: when `loginctl enable-linger` has an exit code other than 0, `autostart install` exits 1 with `autostart install: loginctl enable-linger failed: <first line of its stderr>` and leaves no unit file
- [ ] Contract: the `dg-daemon` plist holds `<paths.logDir>/dg-daemon-autostart.log` two times
- [ ] Contract: with a blocked `daemon` entry, `start` prints the block text, exits with the code of the block error, and runs no manager command and no spawn; it does not wait for the startup timeout
- [ ] Contract: `autostart install` with a live detached daemon prints the `hand it over` line; `autostart remove` with a live daemon prints the `stop first` hint
- [ ] Contract: a `spawnServe` daemon that gets SIGTERM exits with code 0
- [ ] Contract: `autostart install` on a platform that is not linux, darwin or win32 exits 1 with `autostart install: unsupported platform "<platform>"`
- [ ] Contract: in WSL, `autostart status` also prints `wsl task: installed` or `wsl task: not installed`, and `--json` holds `"wslTask": <boolean>`; it reads the XML file of the task and runs no command
- [ ] Contract: `start --json` on the manager path holds the keys `started`, `pid`, `port` and `version`, as on master
- [ ] Contract: `cmdRestart` with a login unit and no live daemon sends no signal and runs the managed start commands one time
- [ ] Happy path (recording deps, linux): `install` writes the unit with mode 0600, then runs `systemctl --user daemon-reload`, `systemctl --user enable --now dg-daemon.service` and `loginctl enable-linger`, in that order
- [ ] Happy path (recording deps, WSL): `install` also runs one `schtasks.exe /Create` call for the task `dg-daemon-wsl-<distro>`, whose XML action is `wsl.exe -d <distro> --exec true`
- [ ] Happy path (recording deps, darwin): `install` writes `com.detailedghost.dg-daemon.plist` and runs `launchctl bootstrap gui/<uid> <path>`
- [ ] Edge: `install` two times gives one unit file and exit 0 both times
- [ ] Edge: `dg-daemon serve` in a home with a live daemon exits 0 (the `deferred` result of `cmdServe`), so a unit with `Restart=on-failure` does not start it again; the spec uses two `spawnServe` calls in one `freshDgHome()` folder
- [ ] Edge: `status` with a `dg-phone` unit and no `dg-daemon` unit prints `autostart: not installed`
- [ ] Error: a failed `systemctl --user daemon-reload` removes the unit file and exits 1 with the first line of its stderr
- [ ] Check (manual acceptance, one time for each kind: systemd, launchd, task): `stop --force` leaves the daemon stopped, and `start` starts it through the manager; no spec runs a real manager
- [ ] Check: the systemd order of a forced stop (the kill, then `systemctl --user stop`) has a short race with the `RestartSec` timer; `stop` cancels the timer, and the recording deps test fixes the order
- [ ] Check (manual acceptance on a WSL host): after `autostart install`, a Windows sign-out and sign-in starts the daemon; the WSL values of this slice come from reuse of the existing task writer and are not verified on a WSL host
- [ ] Regression: pkg/dg-agent/__tests__/phone passes with no change to an assertion; pkg/common/__tests__/node-autostart.spec.ts holds each case of the moved spec
- [ ] Regression: `bun test` passes in pkg/common, pkg/dg-agent and pkg/dg-daemon; `bun run lint` passes in the three packages; pkg/launcher/__tests__/size-budget.spec.ts passes

#### Acceptance Criteria
- [ ] Given Linux with a systemd user session, when the owner runs `dg-daemon autostart install`, then `~/.config/systemd/user/dg-daemon.service` exists, is enabled, and starts `dg-daemon serve` through the stable `current` links
- [ ] Given Linux or WSL, when the owner runs `dg-daemon autostart install`, then linger is on; in WSL a Windows login task also starts the distribution
- [ ] Given an installed unit, when the owner runs `dg-daemon autostart remove`, then the unit is disabled and its file is gone
- [ ] Given a machine with the phone listener unit, when `dg-daemon autostart install` and `remove` run, then the `dg-phone` unit does not change
- [ ] Given pkg/dg-agent/src, when a search for `systemctl`, `launchctl` or `schtasks` runs, then it finds nothing
- [ ] Given `dg-agent phone open`, when it installs its login unit, then the unit file is byte-identical to the file that master writes
- [ ] Given an installed login unit and no live daemon, when the owner runs `dg-daemon start`, then the service manager starts the daemon and no detached daemon exists
- [ ] Given an installed login unit, when the owner runs `dg-daemon restart`, then the old daemon stops with its normal wait and the service manager starts the new one
- [ ] Given no login unit, when the owner runs `dg-daemon start` or `dg-daemon restart`, then the result is the same as before this change
- [ ] Given an installed login unit, when the owner runs `dg-daemon stop --force`, then the daemon is gone and stays gone until the next login or the next `dg-daemon start`

### Slice 4 — layout-stale-daemon

#### Engineering
- [ ] Reproduce first in pkg/common/__tests__/layout-stale-daemon.spec.ts: the legacy folder `<legacy>/daemon` holds a used `daemon.db`, and `<state>/daemon` holds only a `config.json`; on master the plan gives `keepUsed` for the entry `daemon`, because `unused: "folder"` accepts only an empty target, so the legacy data never moves, and the next daemon start makes a new empty `daemon.db` in the kept target
- [ ] Change the `daemon` entry of `LAYOUT_TABLE` in pkg/common/src/node/layout.ts, and the decision in pkg/common/src/node/layout-work.ts when the entry needs it, so that the plan of the `daemon` entry follows the seven rules below
- [ ] A `daemon` folder is used when it holds a `key`, a `credentials.db` or a used `daemon.db`; other files, such as `config.json`, do not make it used; the rule is the same for the legacy folder and for the target `<state>/daemon`
- [ ] A `daemon.db` that a daemon opened one time holds one `crypto_meta` row, so it is used; dg does not decide that a `key` or that row has no value
- [ ] Rule 1: no legacy folder gives `absent`
- [ ] Rule 2: a legacy folder and no target gives `move`, as on master
- [ ] Rule 3: a legacy folder and an empty target gives `setAside`, as on master
- [ ] Rule 4: a used legacy folder and a target that holds files and is not used gives `setAside`; this is the stale case of the Reproduce step
- [ ] Rule 5: a used legacy folder and a used target gives `{ kind: "block", reason: "two-used" }`, not `keepUsed`; add `"two-used"` to `BlockReason` in pkg/common/src/node/layout.ts
- [ ] Rule 6: a legacy folder that is not used and a target that holds files and is not used gives `keepUsed`, as on master
- [ ] Rule 7: a legacy folder that is not used and a used target gives `keepUsed`, as on master
- [ ] A pending record of `.pending-removal.json` is read first, as on master
- [ ] Add `daemonFolderUnused(dir): boolean` to pkg/common/src/node/sqlite-unused.ts for the new rule; do not change `folderUnused`, because `dg-skills clean` uses it to delete set-aside folders
- [ ] Keep the existing set-aside path: the old target goes to a set-aside folder, the output names it, and `DAEMON_ASIDE_MARK` is written
- [ ] Keep the `live` and `stop` rules of the entry: a live daemon in the legacy folder is stopped through `daemon.stop` before the move, or the entry blocks
- [ ] No other entry of `LAYOUT_TABLE` changes its plan, except `sessions`, `assets` and `daemon-logs` when the `daemon` entry is `two-used`
- [ ] The entries `sessions`, `assets` and `daemon-logs` are before `daemon` in `LAYOUT_TABLE` and share its `live` and `stop` rules; when the `daemon` entry is `two-used`, each of them is `skip`: add the `two-used` fact of `daemon` to the snapshot, and let the three entries read it
- [ ] The compiled spec in pkg/skills-cli builds the bundle from a tree that slices 2, 7 and 13 edit at the same time; a build failure in a file of those slices is a retry, not a finding
- [ ] The verify step of PR 1 runs the compiled spec again
- [ ] The compiled spec makes its home in a temp folder with `DG_HOME` and `DG_PATH_FENCE` set; it never reads `.env`
- [ ] `blockedText` for `two-used` is `dg: two daemon folders hold data: <from> and <to>. dg does not choose one and does not merge them. Move the folder that you do not want to a different name, then run the command again`
- [ ] A `two-used` block moves, copies, merges and deletes nothing; it does not read a `config.json`
- [ ] The layout step never copies a key of a `config.json` from a set-aside folder or a blocked folder into the live `config.json`
- [ ] A `two-used` block prints as a `live-writer` block does on master: the layout step prints the text one time for each run, and a command that also calls `assertNotBlocked` prints its own error line
- [ ] `assertNotBlocked(paths, "daemon")` throws that text through the existing `blocked` branch; add no second check
- [ ] Add `EXIT_LAYOUT_BLOCKED = 78` to pkg/common/src/errors.ts; `assertNotBlocked` throws `new DgCliError(fix, EXIT_LAYOUT_BLOCKED)` for a block with the reason `two-used`, and each other block keeps the exit code 1
- [ ] Do not edit pkg/dg-daemon/src/main.ts: it returns the exit code of the error
- [ ] `layoutCheck` in pkg/skills-cli/src/install/doctor.ts: for a `two-used` block the `fix` is the rename sentence of `blockedText`, not `dg-skills install`
- [ ] Reuse pkg/skills-cli/__tests__/layout-fixtures.ts for the new specs of pkg/skills-cli; add no second fixture file
- [ ] When the set-aside folder holds a file, the output line is `dg: set aside <dest> as <aside>; dg copied no file from it, and dg-skills clean keeps it`; for an empty target the line of master stays
- [ ] Give the remedy for a home with two used folders in the PR body: move `<state>/daemon` to a different name when the legacy folder holds the sessions, then start again

#### Testing Criteria
##### Contracts
- [ ] Contract: with a used legacy `daemon.db` and a target that holds only `config.json`, the plan for `daemon` is `setAside`, not `keepUsed`
- [ ] Contract: after the move, `<state>/daemon/daemon.db` is the legacy file, and the old target content is in the set-aside folder
- [ ] Contract: with an empty target, the plan is `setAside` as before; with no target, the plan is `move` as before
- [ ] Contract: a target that holds a `key` or a `credentials.db` is not unused
- [ ] Contract: the plan of each other entry of `LAYOUT_TABLE` is the same as on master for the fixtures of pkg/common/__tests__/layout.spec.ts, except `sessions`, `assets` and `daemon-logs` in a fixture whose `daemon` entry is `two-used`
- [ ] Contract: with a used legacy `daemon.db` and a used target `daemon.db`, the plan for `daemon` is `block` with the reason `two-used`, and the outcome is `blocked` with `fix` equal to the text of `blockedText`
- [ ] Contract: after that run, the file names and the bytes of the two folders, with each `config.json`, are equal to the state before
- [ ] Contract: `assertNotBlocked(paths, "daemon")` then throws a `DgCliError` with that text and the exit code 78
- [ ] Contract: a used target with a legacy folder that holds no `key`, no `credentials.db` and no used `daemon.db` gives `keepUsed`, as on master
- [ ] Contract: after the owner renames the legacy folder, the next run plans `absent` for `daemon`; after the owner renames the target, the next run plans `move`
- [ ] Contract: after a set-aside, the live `<state>/daemon/config.json` is the legacy file, byte for byte; no key of the old target file is in it
- [ ] Contract: a legacy folder that holds only `logs` or a `daemon.db` with no row, and a target that holds only `config.json`, gives `keepUsed`, as on master
- [ ] Contract: with two used folders and a live legacy daemon, the `daemon.stop` hook gets no call, and `<legacy>/daemon/logs` is in place
- [ ] Contract: `folderUnused` gives `false` for a folder that holds only a `config.json`, as on master
- [ ] Contract: a target that holds a `key`, a `daemon.db` that a daemon wrote, and a `config.json` is used
- [ ] Contract: with no `key` file (keychain mode), a target that holds a `credentials.db`, or a `daemon.db` that a daemon opened one time (one `crypto_meta` row), is used
- [ ] Contract: `dg-skills doctor` and `dg-skills clean` print the `two-used` text for a home with two used folders; the doctor fix is not `dg-skills install`
- [ ] Contract: `service` is not in the `SKIP` set of pkg/dg-daemon/src/main.ts
- [ ] Contract: `readConfigStrict` and `writeServiceEntry` call `assertNotBlocked(paths, "daemon")` first, as on master
- [ ] Contract: after a set-aside of a target that holds a file, the output holds the line `dg: set aside <dest> as <aside>; dg copied no file from it, and dg-skills clean keeps it`
- [ ] Happy path (compiled): a home with the stale layout, then one start of `dg-skills`, gives a `<state>/daemon` that holds the legacy `daemon.db`, `key` and `credentials.db`
- [ ] Edge: a second start after the move plans `absent` for `daemon` and moves nothing
- [ ] Edge: a live legacy daemon with no `daemon.stop` hook blocks the entry with the reason `live-writer`
- [ ] Happy path (pkg/dg-daemon/__tests__/main-blocked.spec.ts): with two used folders, `dg-daemon serve` exits 78 with the text on stderr and writes no pid file; the text that `start` and `restart` print is a Contract of slice 3
- [ ] Edge: with two used folders, `dg-daemon status` runs as on master; it skips the layout step
- [ ] Edge: with two used folders and a live daemon in the legacy folder, the reason is `two-used`, and no stop hook runs
- [ ] Edge: a pending record for `daemon` with two used folders gives the plan of master for a pending record; the `two-used` check runs after it
- [ ] Edge: with a `two-used` block, the keychain step moves no secret
- [ ] Edge: a legacy `daemon` path that is a file or a link gives the plan of master for that input and does not throw
- [ ] Regression: `bun test` passes in pkg/common; the layout specs of pkg/skills-cli and pkg/dg-daemon pass with no change to an assertion

#### Acceptance Criteria
- [ ] Given a legacy daemon folder with session and credential data and a `<state>/daemon` folder in which no daemon started, when a dg program starts, then the daemon reads the legacy data from `<state>/daemon`
- [ ] Given the same start, when the owner reads the output, then one line names the set-aside folder that holds the old `<state>/daemon` content
- [ ] Given two daemon folders that both hold data, when a dg program starts, then nothing moves, one line names the two folders, and `dg-daemon serve` does not start
- [ ] Given the same home, when the owner moves one folder to a different name and starts again, then the daemon uses the folder that stays
- [ ] Given a stale `config.json` with a `services` table, when the layout step runs, then no entry of it is in the live `config.json`
- [ ] Given a home in which a daemon started in the stale `<state>/daemon` folder, when a dg program starts, then the `two-used` text names the two folders, and after the owner renames `<state>/daemon` the next start moves the legacy folder in
- [ ] Given a set-aside of a target that held a `services` table, when the layout step ends, then the set-aside folder is the only place that holds that table, and the output line names the folder

### Slice 5 — service-update

#### Engineering
- [ ] Add the `update` action to pkg/dg-daemon/src/commands/service-package.ts and register it in `registerServicePackageCommands`; do not edit pkg/dg-daemon/src/commands/service.ts
- [ ] The order of `update` is: find the record; check the record; refuse a clone with local changes; fetch; resolve the ref; compare with the stored `sha`; read the new block with `git show <commit>:package.json`; parse it; check the labels; check the state of the removed labels; check `requires` and each bare `argv[0]` name; print; check the terminal; ask; check out the commit; run `build`; resolve each `argv[0]` path in the clone; take the lock; check again; write the entries; write the registry; print
- [ ] Until the answer `y`, only the fetch changed the clone
- [ ] `update` checks the record before a git process starts: `url` and `ref` do not start with `-`, `sha` has 40 hexadecimal characters, and each label matches the label rule
- [ ] Each ref goes to git after `--end-of-options`; a checkout gets only a value that matches `^[0-9a-f]{40}$`
- [ ] Before the fetch, `update` refuses when `git status --porcelain --untracked-files=no` in the clone is not empty
- [ ] Each git command of `update` follows the rules of `install`: no submodule step, no repository code before the answer, `--` or `--end-of-options` before a value, stderr piped for the error text, the environment of the caller
- [ ] `service update <package>` runs `git fetch --tags --force origin` in the clone, in the CLI process, with the environment of the caller
- [ ] For `ref: null`, `update` also runs `git remote set-head origin --auto` after the fetch
- [ ] Resolve the stored `ref` to a commit after the fetch: a tag first, then `origin/<ref>`; `ref: null` resolves `origin/HEAD`; a ref that is a tag and a branch resolves as the tag
- [ ] A stored `ref` that is a full commit id is checked with `git cat-file -e <sha>^{commit}` and always gives `up to date`
- [ ] When the resolved commit is the stored `sha`, change nothing
- [ ] When the commit is new, read the `dg` block of the new commit with `git show <commit>:package.json`, parse it with `parseServiceDefaults`, and calculate `defaultsHash`; no checkout occurs before the answer `y`
- [ ] When `defaultsHash` is equal to the stored hash, print `<package>: <old 12> -> <new 12>` and ask `Update to this commit? [y/N]` on a terminal; on `y`, after the checkout and `build`, write only the new `sha` to the registry and do not write the daemon config
- [ ] When `defaultsHash` is different, print the new request in the form of `install`, then one line for each label and key whose value changed, then ask `Apply these changes? [y/N]` on a terminal
- [ ] When only `requires` or `build` changed, the request shows the old and the new value of that key, and the question is `Apply these changes? [y/N]`
- [ ] On a `no` answer the clone is at the old commit, because no checkout occurred; write nothing
- [ ] `update` refuses before the question when the new block removes a label that a live daemon reports as `running` or `backoff`
- [ ] The state of a label comes from `liveServiceStates` and `assertDaemonAnswers` of pkg/dg-daemon/src/commands/service-support.ts
- [ ] With no daemon pid, `update` makes no state check and no HTTP call
- [ ] The states `stopped` and `invalid` are not running
- [ ] `update` never changes the `autostart` key of an entry
- [ ] `update` does not stop, start or restart a service
- [ ] After a commit change, print one `next: dg-daemon service restart <label>` line for each label that a live daemon reports as `running` or `backoff`
- [ ] When `update` prints one such line or more, it prints after them `note: a service that runs uses the new commit after its next start`
- [ ] `update` does not hold the config lock during the question
- [ ] After the answer and `build`, `update` takes the lock one time, reads the registry and the config again, checks that the record still holds the old `sha` and that each new label is free, and writes the entries and then the registry in that one section
- [ ] Inside the lock, keep a copy of each entry before the first write; when a write fails, put each changed entry back and go back to the old commit
- [ ] Extend the fixture helper in pkg/dg-daemon/__tests__/commands/service-package-kit.ts with a second commit and a changed `dg` block; do not add a second helper file
- [ ] The specs assert the text of the `next:` lines; they do not run the commands of slice 6
- [ ] The Edge with a live daemon and a `running` label uses pkg/dg-daemon/__tests__/utils/daemon-harness.ts with no change
- [ ] Do not rename an export of slice 2 (`defaultsHash`, `formatRequest`, `resolveRef`, `sanitize`, the deps type, the kit functions)
- [ ] After each commit change, check `requires` of the new block before the question, as `install` does
- [ ] With a changed block and the answer `y`: for each label of the new block, write the repository keys (`argv`, `cwd`, `envFile`, `grant`, `stopTimeoutMs`) from the new block; a repository key that the new block does not have is removed from the entry
- [ ] Keep each key that the block cannot set: `autostart` and `passEnv` stay as they are in the entry
- [ ] Print one line `replaced <label>.<key>` for each repository key whose stored value was different from the new value; the comparison is between the stored entry and the new entry, so the line also names a key that the new block removed
- [ ] A new label of the block gets a new entry with no `autostart` key, and a state folder; `update` refuses, before a write, a new label that the `services` table already holds
- [ ] With a changed block, each label of the new block gets its entry
- [ ] A label of the record whose entry is absent (the owner ran `service rm`) gets a new entry with no `autostart` key and one `next: dg-daemon service enable <label>` line
- [ ] With an equal `defaultsHash`, `update` writes no entry, so an absent entry stays absent
- [ ] A label that the new block removes loses its entry; its state folder stays
- [ ] Write the new `sha`, `defaultsHash` and `labels` to the registry after the entries
- [ ] After each commit change, run `build` of the new block one time after the checkout that follows the answer `y`, and before the first write, with the rules of `install`
- [ ] After the checkout, each failure path goes back to the old commit in one `finally` step: `git checkout --force --detach <old sha>`; `--force` is necessary because `build` can change tracked files
- [ ] When `build` fails, that step runs, and `update` writes nothing
- [ ] `update` does not run the `build` of the old commit again after a failed build; build output of the new commit can stay in the clone, and the failure text says so
- [ ] When stdin or stdout is not a terminal and a new commit exists, `update` prints the commit change (and the request and changed keys when the block changed) and fails, also when `defaultsHash` is equal; it runs no checkout and no build
- [ ] When stdin or stdout is not a terminal and no new commit exists, `update` exits 0 with the `up to date` line
- [ ] `update` has no `--yes` option and no `--accept` option
- [ ] After `build`, `update` resolves each `argv[0]` path in the clone with the rule of `install`; a path that leaves the clone is refused

#### Testing Criteria
##### Contracts
- [ ] Contract: an unknown package exits 1 with `no package named "<package>"`
- [ ] Contract: with no new commit, `update` exits 0 and prints `package "<package>" is up to date at <first 12 characters of sha>`; the bytes of packages.json and of the daemon config do not change
- [ ] Contract: with a new commit and an equal `defaultsHash`, `update` prints `<package>: <old 12> -> <new 12>`, asks one question through the `confirm` seam, and on `y` exits 0 with `updated package "<package>" <old 12> -> <new 12>`; the registry holds the new `sha`; each service entry is byte-equal
- [ ] Contract: with a different `defaultsHash`, the question appears after the request text; the `confirm` seam gets one call
- [ ] Contract: a `no` answer exits 1 with `service update: declined; package "<package>" stays at <old 12>`; `git rev-parse HEAD` in the clone is the old commit; no file changes
- [ ] Contract: a removed label that is `running` exits 1 with `service "<label>" is running — stop it first with dg-daemon service stop <label>` before a checkout
- [ ] Contract: a failed `git fetch` exits 1 with `service update: git fetch failed: <first line of the git stderr>` and changes no file
- [ ] Contract: an entry with `autostart: true` before `update` has `autostart: true` after it, in each path
- [ ] Contract: after a changed block and the answer `y`, each entry holds the new `argv`, `envFile`, `grant` and `stopTimeoutMs`; `autostart` and `passEnv` are deep-equal to their values before
- [ ] Contract: a `grant` that the new block removed is absent from the entry
- [ ] Contract: an `argv` that the human edited in the daemon config is replaced after the answer `y`, and stdout holds `replaced <label>.argv`
- [ ] Contract: exit 0 after a changed block prints `updated package "<package>" <old 12> -> <new 12>`, then the `replaced` lines, then one `next: dg-daemon service enable <label>` line for each new label
- [ ] Contract: a new label that the `services` table already holds exits 1 with `service update: a service labelled "<label>" already exists`; the clone is at the old commit and no file changed
- [ ] Contract: a removed label that does not run loses its entry; its state folder exists after the update
- [ ] Contract: after a changed block, the registry holds the new `sha`, the new `defaultsHash` and the new `labels`
- [ ] Contract: `build` runs one time for each accepted commit change, also when `defaultsHash` is equal, after the `y` and before a write; on `N` it does not run
- [ ] Contract: a `build` that exits with 3 makes `update` exit 1 with `service update: build failed (exit 3); package "<package>" stays at <old 12> — the clone can hold build output of <new 12>`; `git rev-parse HEAD` is the old commit; packages.json and the daemon config are byte-equal
- [ ] Contract: a `requires` name of the new block that does not resolve exits 1 with `service update: required executable(s) do not resolve on PATH: <names>` before the question; the clone is at the old commit
- [ ] Contract: with no terminal and a changed block, `update` exits 1 with `service update: consent needs a terminal — run this command in a terminal yourself`; the clone is at the old commit and no file changed
- [ ] Contract: with no terminal and an equal `defaultsHash`, `update` exits 1 with `service update: consent needs a terminal — run this command in a terminal yourself`; the clone is at the old commit and no file changed
- [ ] Contract: with no terminal and no new commit, `update` exits 0 and prints the `up to date` line
- [ ] Contract: a clone with local changes exits 1 with `service update: the clone of "<package>" has local changes — nothing was changed`; no fetch runs
- [ ] Contract: a tag that the remote moved gives the new commit
- [ ] Contract: after the remote changes its default branch, a package with `ref: null` follows the new default branch
- [ ] Contract: a record with `ref: "--upload-pack=x"` exits 1 with `service update: the record of "<package>" in <file> is not valid` and starts no git process
- [ ] Contract: a new commit whose `argv[0]` is a link to a file outside the clone exits 1 with the `must stay inside the repository` text in the `service update:` form; the clone is at the old commit and no file changed
- [ ] Contract: when the config or the record changes during the question, `update` exits 1 with `service update: the package or the daemon config changed during the question — nothing was changed`; the clone is at the old commit
- [ ] Contract: with an injected failure of the registry write, the daemon config and packages.json are byte-equal to the bytes before, and the clone is at the old commit
- [ ] Contract: with a changed block and the answer `y`, a label of the record whose entry is absent gets a new entry with no `autostart` key, and stdout holds `next: dg-daemon service enable <label>`
- [ ] Contract: with an equal `defaultsHash`, an absent entry stays absent
- [ ] Contract: when only `requires` or `build` changed, the request shows the old and the new value of that key, and the question is `Apply these changes? [y/N]`
- [ ] Contract: a repository key that the new block removed gives a `replaced <label>.<key>` line
- [ ] Contract: with a daemon pid that is alive and does not answer, `update` exits 1 with the `does not answer` text and changes nothing
- [ ] Contract: a label in `backoff` gets the `next: dg-daemon service restart <label>` line, and the `note:` line follows the `next:` lines
- [ ] Contract: a new commit with no `dg` key, with an unknown key, or with an entry that the validator refuses exits 1 with the slice 2 text in the `service update:` form; the clone is at the old commit and no file changed
- [ ] Contract: a stored ref that does not resolve after the fetch exits 1 with `service update: cannot resolve "<ref>" in <package>`
- [ ] Contract: a `git checkout` that fails exits 1 with `service update: git checkout failed: <first line of the git stderr>`; no file changed
- [ ] Contract: a daemon config that is not valid JSON exits 1, names the file, and leaves the clone at the old commit
- [ ] Contract: a new label gets a state folder with mode 0700 (POSIX), no `autostart` key, and one `next: dg-daemon service enable <label>` line
- [ ] Contract: a key whose stored value is equal to the new value prints no `replaced` line
- [ ] Contract: with no terminal and a new commit, stdout holds the `<old 12> -> <new 12>` line; the `confirm` seam gets no call and `runBuild` gets no call
- [ ] Contract: for one block, the request text of `update` is equal to the request text of `install`; the two commands call `formatRequest`
- [ ] Happy path: a package installed with the ref of a branch moves to the new head of that branch
- [ ] Happy path: a package installed with a tag reports `up to date` when only the default branch moved
- [ ] Edge: a key that the human changed in the daemon config stays byte-equal when `defaultsHash` is equal
- [ ] Edge: with a live daemon and a `running` label, the output ends with `next: dg-daemon service restart <label>` and the `note:` line, and the service process has the same pid after `update`
- [ ] Regression: `bun test` and `bun run lint` pass in pkg/dg-daemon

#### Acceptance Criteria
- [ ] Given a package whose repository has a new commit and an unchanged `dg` block, when the owner runs `dg-daemon service update <package>` in a terminal and answers `y`, then the registry holds the new commit id
- [ ] Given a new commit that changes an `argv` or a `grant`, when the owner runs `update`, then the command shows the change and asks before it writes
- [ ] Given the answer `n`, when `update` ends, then the clone, the registry and the daemon config are as before the command
- [ ] Given a running service of the package, when `update` ends, then the service still runs with the same pid and the output tells the owner to restart it
- [ ] Given a changed block and the answer `y`, when `update` ends, then each entry has the new repository values, and each service that was enabled is still enabled
- [ ] Given a `build` that fails after a new commit, when `update` ends, then the package is at the old commit, and the registry and the daemon config are unchanged
- [ ] Given an agent session with no terminal, when `update` finds a new commit, then `update` writes nothing and runs no build, whether or not the block changed
- [ ] Given a `requires` name of the new commit that does not resolve, when `update` runs, then it stops before the question
- [ ] Given no new commit, when `update` runs, then it exits 0 and changes nothing
- [ ] Given a removed label that runs, when `update` runs, then it refuses and changes nothing
- [ ] Given a new label, when `update` ends, then its entry has no `autostart` key

### Slice 6 — service-label-verbs

#### Engineering
- [ ] Add `enable`, `disable`, `restart` and `logs` below `service` in pkg/dg-daemon/src/commands/service.ts; they take a label, not a package
- [ ] `enable <label>`: with the config lock held, read the entry with `readConfigStrict`, set `autostart: true`, and write it with `writeServiceEntry`; keep each other key of the entry
- [ ] `enable`: after the write, when a daemon is live, read `GET /services`
- [ ] `enable` sends `POST /services/<label>/start` only when the state is `stopped`, and then prints the status line of `service start`; in each other state it prints the status line of the label and sends no start request
- [ ] `enable` takes `AutostartDeps` as a seam; the default is `defaultAutostartDeps()` of slice 3
- [ ] `enable`: when `autostartManages(deps, paths, "dg-daemon")` of pkg/common/src/node/autostart.ts gives no kind, print one hint line; `enable` writes no login unit
- [ ] The hint text is the same on each platform
- [ ] `disable <label>`: delete the `autostart` key of the entry; when a live daemon reports the label as `running` or `backoff`, send `POST /services/<label>/stop` and print its status line
- [ ] `enable` and `disable` work on an entry of `service add` and on an entry of `service install` in the same way
- [ ] `enable` and `disable` call `assertDaemonAnswers` of pkg/dg-daemon/src/commands/service-support.ts before the write
- [ ] `enable` and `disable` write nothing when `autostart` is already in the target state
- [ ] `writeServiceEntry` puts a written entry last in the `services` table; the order of the table is not a contract, and this slice does not edit pkg/dg-daemon/src/server/config-store.ts
- [ ] `enable` and `disable` change the `autostart` key only; they do not check the other keys
- [ ] `enable` and `disable` refuse an entry that is not an object
- [ ] `restart <label>`: send `POST /services/<label>/stop`, then `POST /services/<label>/start`, and print the status line of the start; a stopped service starts
- [ ] `restart` adds no daemon route, so it works with a daemon of the release before this one
- [ ] Move the tail and follow code of pkg/channel-review/src/daemon/logs.ts to pkg/common/src/node/log-tail.ts, export it from pkg/common/src/node/index.ts, and call it from the channel-review `logs` command; this is its second caller
- [ ] log-tail.ts exports `readTail(path, count): string[]` and `follow(path, { out, signal, pollMs, start })`; `start` can be `{ size: 0, ino: -1 }` for a file that does not exist
- [ ] The message for an absent file and the exit code stay in each caller: channel-review `logs` prints `<path>: no log yet` and exits 0, as on master
- [ ] `logs <label>`: print the last lines of `<logDir>/service-<label>.log` with the options `-n, --lines <n>` (default 40) and `-f, --follow`, the option names of `dg-skills channel-review logs`
- [ ] `logs` needs no daemon; it reads the file
- [ ] `logs` checks the label against the daemon config before it builds the path `service-<label>.log`
- [ ] The `logs` action gives `follow` an `AbortSignal` that SIGINT aborts; the spec aborts the signal and sends no real signal
- [ ] Put the `logs` action in pkg/dg-daemon/src/commands/service-logs.ts and load it with a lazy import
- [ ] Do not edit pkg/dg-daemon/src/commands/service-package.ts, pkg/dg-daemon/src/commands/service-support.ts or pkg/dg-daemon/src/services/supervisor.ts
- [ ] Import `withConfigLock`, `callDaemon` and the guards from service-support.ts
- [ ] Do not touch the `registerServicePackageCommands` line of service.ts
- [ ] The two daemon-boot tests and the test of the new pid after `restart` are in pkg/dg-daemon/__tests__/commands/service-verbs.spec.ts
- [ ] Those three tests reuse pkg/dg-daemon/__tests__/commands/service-cli-helpers.ts with no change, a temp `DG_HOME` in the fence, and a fixture service that runs until it is stopped

#### Testing Criteria
##### Contracts
- [ ] Contract: `enable` of an unknown label exits 1 with `no service labelled "<label>"` and writes nothing; the same for `disable`, `restart` and `logs`
- [ ] Contract: `enable` with no live daemon exits 0 and prints `enabled service "<label>"`, then `next: dg-daemon start`
- [ ] Contract: `enable` with a live daemon exits 0 and prints `enabled service "<label>"`, then the status line with the state `running`
- [ ] Contract: with no login unit, `enable` also prints `hint: dg-daemon does not start at login — run dg-daemon autostart install`; with a unit that records the `DG_HOME` of the caller, it prints no hint; with a unit that records a different `DG_HOME`, it prints the hint
- [ ] Contract: after `enable`, the entry is deep-equal to the entry before plus `"autostart": true`; after `disable`, the entry has no `autostart` key and each other key is deep-equal
- [ ] Contract: `disable` with no live daemon exits 0, prints `disabled service "<label>"`, and makes no HTTP call
- [ ] Contract: `disable` of a `running` service prints `disabled service "<label>"`, then the status line with the state `stopped`
- [ ] Contract: `enable` two times: the second run writes no file, and the file bytes are equal to the bytes after the first run
- [ ] Contract: `restart` with no live daemon exits 1 with `no live dg-daemon — services run inside it, so start it with dg-daemon start`
- [ ] Contract: after `restart` of a `running` service, the status line shows `running` with a pid that is different from the pid before
- [ ] Contract: `restart` and `stop` do not change the `autostart` key
- [ ] Contract: `logs <label>` prints the last 40 lines; `-n 5` prints the last 5; a file with 3 lines prints 3
- [ ] Contract: `logs` with no log file exits 1 with `no log for service "<label>" yet: <path>`; `logs -f` with no log file waits and prints the first lines when the file appears
- [ ] Contract: `logs -f` prints each new line until the abort signal, then exits 0
- [ ] Contract: `logs -f` continues after a copy-truncate rotation (`rotateLogIfLarge`: the file size becomes 0); the spec uses `truncateSync`, not a rename
- [ ] Contract: `dg-skills channel-review logs` gives the same output as on master for the cases of its spec; pkg/channel-review/__tests__/daemon-logs.spec.ts passes with no change
- [ ] Contract: `enable` of a `running` service exits 0 and prints the `enabled` line and the status line; no start request is sent
- [ ] Contract: when the write is done and the start fails, the entry keeps `autostart: true`, the command exits 1, and stderr holds the text of the daemon
- [ ] Contract: with a daemon pid that is alive and does not answer, `disable` exits 1 with the `does not answer` text and writes nothing
- [ ] Contract: `logs -n 0` and `logs -n x` exit 1 with `--lines must be a whole number of 1 or more`
- [ ] Contract: a last line with no newline prints one time
- [ ] Contract: `logs -f` with no log file prints `waiting for <path>` on stderr one time, then the first lines when the file appears
- [ ] Contract: `restart` of an unknown label with no live daemon exits 1 with `no service labelled "<label>"`
- [ ] Contract: when the stop request of `restart` fails, no start request is sent, and the command exits 1 with the text of the daemon
- [ ] Contract: `enable` of an entry that is not an object exits 1 with `service "<label>" in <file> is not an object`; the file does not change
- [ ] Happy path: a boot of the daemon after `enable` starts the service with no `service start` call
- [ ] Happy path: a boot of the daemon after `disable` leaves the service `stopped`
- [ ] Edge: `enable` keeps `pinnedOrigin`, the other entries and the mode of the config file
- [ ] Error: `enable` on a config that is not valid JSON exits 1, names the file, and does not change it
- [ ] Regression: `bun test` passes in pkg/common, pkg/channel-review and pkg/dg-daemon; `bun run lint` passes in the three packages; pkg/channel-review/__tests__/daemon-logs.spec.ts passes with no change

#### Acceptance Criteria
- [ ] Given a declared service and a live daemon, when the owner runs `dg-daemon service enable <label>`, then the service runs now and starts again at each daemon boot
- [ ] Given an enabled service, when the owner runs `dg-daemon service disable <label>`, then the service stops now and does not start at the next daemon boot
- [ ] Given no login unit, when the owner runs `enable`, then the command prints the hint and creates no file outside the daemon config
- [ ] Given a running service, when the owner runs `dg-daemon service restart <label>`, then the service runs with a new pid and its `autostart` state is unchanged
- [ ] Given a service that wrote output, when the owner runs `dg-daemon service logs <label> -f`, then the command prints the last lines and each new line
- [ ] Given `start`, `stop` and `restart`, when one of them runs, then the stored `autostart` state does not change

### Slice 7 — channel-review-export

#### Engineering
- [ ] Add `export` to pkg/skills-cli/src/channel-review/cli.ts: `dg-skills channel-review export --env <env> --label <label>`; the two options are required
- [ ] `--env` uses `envOption()` with `makeOptionMandatory()`; it has no default in this command
- [ ] Put the action in pkg/skills-cli/src/channel-review/export.ts and load it with a lazy import
- [ ] Read the state with `readStateSnapshot(channelReviewPaths(env))` of `@dg/channel-review`; it opens daemon.db with `readonly: true`, takes no lock and starts no migration
- [ ] The order of `export` is: the liveness check, the read, the write
- [ ] A daemon that starts between the check and the read is not prevented; commands.md says to keep the daemon stopped
- [ ] Write `<serviceStateDir(paths, label)>/import.json` with the keys `version`, `cursor`, `handled`, `current` and `automation`, in that order
- [ ] Use one `DgPaths` object for the read and for the write: `channelReviewPaths(env).dg`
- [ ] `version` is the number 1
- [ ] `cursor` is the `lastEventIds` object of the state: one event id for each chat id
- [ ] `handled` is an array with one object for each key of the `handled` object of the state: `{ messageId, status, at }`, plus `chatId` when the state has it; sort by `at`, then by `messageId`
- [ ] `current` is the `current` value of the state: the job object or `null`
- [ ] Validate `--label` with the service label rule (`^[a-z0-9][a-z0-9-]{0,63}$`) before a path is built
- [ ] Create the directory with `ensurePrivateDir` and write the file with `writeFileAtomic(path, data, 0o600)`; an existing import.json is replaced
- [ ] `export` writes nothing to daemon.db and does not stop a process
- [ ] Add `export` to plugins/dg/skills/channel-review/references/commands.md with its two options, the output path, and the rule that the daemon of that env must be stopped
- [ ] commands.md states that the export has no `running` key and no `fixStarts` key: the bot starts with an empty fix quota, so the fix limit of one hour starts again one time, at the import
- [ ] commands.md states that a `handled` entry with the status `pending` or `running` is work that stopped
- [ ] commands.md states that `current.pid` and `current.pidStart` are values of the old host and have no meaning for the bot
- [ ] commands.md states that `handled` holds only the last 24 hours, so the bot must use `cursor` for older requests
- [ ] commands.md states that the format has `version: 1`, and that a change of shape increases `version`
- [ ] commands.md states that the owner exports one time, after the last stop of the old daemon
- [ ] commands.md states that the bot records that it did the import
- [ ] Write no private organization name and no private repository name in a source file, a spec or a document; name the consumer `the review bot repository`
- [ ] `automation` is an object with the keys `blocked`, `issues`, `sinks`, `prWatch` and `deps`, in that order; each value is the value of the same key of the state, and `deps` holds `lastRun`
- [ ] Do not export the keys `running` and `fixStarts` of the state
- [ ] Before the read, refuse when the channel-review daemon of that env runs: use `readPidRecord` and `isOurDaemon` of `@dg/channel-review`, the check of `channel-review status`; write no second liveness check
- [ ] A legacy state with one `lastEventId` has no chat id; `export` gives `readStateSnapshot` the `legacyChatId` that the daemon gives `createStateStore`: the `defaultChatId` of pkg/channel-review/src/daemon/serve.ts
- [ ] Before the read, call `assertNotBlocked` for the layout keys that the other actions of cli.ts use, and for `daemon`
- [ ] export.ts builds the output as a typed `ImportFile` value with `satisfies`
- [ ] A key with no value is left out of import.json; it is never `null`, except `current`
- [ ] Add no new fixture home helper; use the helpers that slice 1 left in pkg/skills-cli/__tests__

#### Testing Criteria
##### Contracts
- [ ] Contract: import.json parses as `{ "version": 1, "cursor": { "<chatId>": "<eventId>" }, "handled": [{ "messageId", "status", "at", "chatId"? }], "current": <object|null>, "automation": { "blocked", "issues", "sinks", "prWatch", "deps": { "lastRun" } } }` and has no other top-level key
- [ ] Contract: `handled` holds each message id of the state one time, in ascending `at` order
- [ ] Contract: `status` is one of `pending`, `running`, `done`, `failed`
- [ ] Contract: exit 0 prints one line: `exported channel-review <env> state to <path>: <n> handled, <m> chat cursors, current <message id or none>`
- [ ] Contract: the file mode is 0600 and the directory mode is 0700 (POSIX)
- [ ] Contract: `--label Bad/Label` exits 1 with `channel-review export: "--label" must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit`, and creates no directory
- [ ] Contract: an `--env` value other than `dev` or `prod` exits 1 with the commander text for a choice that is not valid, as in the other channel-review commands
- [ ] Contract: a missing `--env` exits 1 with the commander text for a required option
- [ ] Contract: the bytes of daemon.db, of its `-wal` file and of the `channel_review_state` row do not change; `export` opens daemon.db with `readonly: true` and takes no lock
- [ ] Contract: `automation.blocked`, `automation.issues`, `automation.sinks` and `automation.prWatch` are deep-equal to the same keys of `readStateSnapshot`; `automation.deps` is `{ "lastRun": <the deps.lastRun object of the state> }`; `automation.blocked` holds each full blocked entry (`options`, `messageId`, `chatId`, `at`), keyed as in the state
- [ ] Contract: import.json has no `running` key and no `fixStarts` key at any level
- [ ] Contract: with a live channel-review daemon for the env, `export` exits 1 with `channel-review export: the <env> daemon is running (pid <pid>) — stop it first with dg-skills channel-review stop --env <env>`, and creates no file and no directory
- [ ] Contract: a pid file that names a dead process, or a process that is not the channel-review daemon, does not stop the export
- [ ] Contract: a live `prod` daemon does not stop `export --env dev`
- [ ] Contract: plugins/dg/skills/channel-review/references/commands.md holds the six rules for the reader of import.json and the sentence on the empty fix quota
- [ ] Contract: a legacy state file with `lastEventId: "e1"` and a configured chat id `c1` gives `cursor: { "c1": "e1" }`
- [ ] Contract: the same state with no default chat id exits 1 with `channel-review export: the <env> state has a legacy cursor and no chat id is configured`, and writes no file
- [ ] Contract: with a blocked `daemon` entry, `export` prints the block text, exits with the code of the block error (78 for `two-used`, 1 for each other reason), and opens no database
- [ ] Contract: with `DG_HOME=/d`, the file is `/d/state/services/<label>/import.json`; no spec uses the default roots
- [ ] Contract: the key list of each object level of import.json is equal to the list of the first Contract of this slice; a `handled` entry with no chat id has no `chatId` key
- [ ] Happy path: a daemon.db with a `dev` row that has 3 handled messages, 2 chat cursors and a `current` job gives a file with those values
- [ ] Happy path: `--env prod --label bot-prod` and `--env dev --label bot-dev` write two files in two directories, each with the state of its env
- [ ] Edge: a state with `current: null` writes `"current": null`
- [ ] Edge: an env with no row and no legacy state file writes `{ "version": 1, "cursor": {}, "handled": [], "current": null, "automation": { "blocked": {}, "issues": {}, "sinks": {}, "prWatch": {}, "deps": { "lastRun": {} } } }` and the count line shows 0
- [ ] Edge: a second `export` replaces the file
- [ ] Edge: `export` before the schema has the channel-review table reads the legacy state file, as `channel-review status` does
- [ ] Happy path: a state with one blocked URL, one issue, one sink cursor, one watched PR and one dependency run gives an import.json with those five values below `automation`
- [ ] Error: a daemon.db of a newer build (`ForwardOnlyVersionError`) exits 1 with one line that starts with `channel-review export:`, with no stack trace and no import.json
- [ ] Error: a state that `parseState` refuses exits 1 with one line that starts with `channel-review export:`, with no stack trace and no import.json
- [ ] Error: a daemon.db that cannot be read exits 1 with one line that starts with `channel-review export:`, with no stack trace and no import.json
- [ ] Error: a write that fails exits 1 with one line that starts with `channel-review export:`, with no stack trace and no import.json
- [ ] Check: pkg/skills-test/__tests__/channel-review-skill.spec.ts passes; change it only when it has a list of the documented commands
- [ ] Regression: `bun test pkg/skills-cli/__tests__/channel-review-cli.spec.ts` passes; `bun run lint` passes in pkg/skills-cli

#### Acceptance Criteria
- [ ] Given a daemon.db with channel-review state for `dev` and a stopped `dev` daemon, when the owner runs `dg-skills channel-review export --env dev --label <label>`, then `<state>/services/<label>/import.json` holds version 1, the chat cursors, the handled list, the current job and the `automation` object
- [ ] Given the export, when the owner compares it with `dg-skills channel-review status --env dev`, then the handled count and the current job are equal
- [ ] Given the export, when it ends, then daemon.db is unchanged and the old channel-review commands work as before
- [ ] Given a running channel-review daemon for `dev`, when the owner runs the export for `dev`, then the command writes nothing and names the stop command
- [ ] Given a state with a sink poll cursor, a seen issue and a dependency run, when the export ends, then import.json holds them below `automation`

### Slice 8 — service-docs

#### Engineering
- [ ] Write docs/adr/0047-service-packages.md with the headings of docs/adr/template.md and `Status: Accepted`: the `service install` model, the `dg` block of package.json, the pinned commit and the consent step, packages.json, the clone and state folders, `enable` and `disable`, and `dg-daemon autostart`
- [ ] Take the ADR number again from `git ls-tree origin/master docs/adr` before you write the file; use the next free number in the file name, the toc row and each link of slices 11 and 12
- [ ] Rebase on origin/master before the first edit of this slice: origin/master changed docs/install.md and docs/adr/toc.md
- [ ] In 0047, state that the daemon runs no git command and reads only `<state>/daemon/config.json`
- [ ] In 0047, link ADR 0020 and ADR 0043; do not change the text of ADR 0043
- [ ] Add the 0047 row to docs/adr/toc.md after the 0043 row of `## Platform`, in 160 columns at most
- [ ] In pkg/skills-test/__tests__/outside-services-docs.spec.ts, change the one assertion of the test `toc entry is last in Platform` so that it finds the 0043 row by its pattern
- [ ] In docs/jobs-and-services.md, add a section `Install a service from a repository`: `service install <git-url>[@ref]`, `update`, `uninstall`, `list`, one example `dg` block, and the paths `<data>/services/packages.json`, `<data>/services/<package>/` and `<state>/services/<label>/`
- [ ] In that section, state the difference: `install`, `update` and `uninstall` take a package; `enable`, `disable`, `start`, `stop`, `restart` and `logs` take a label
- [ ] In docs/jobs-and-services.md, add a section `Start at login`: `dg-daemon autostart install|remove|status`, the unit kind for each OS, and the rule that `service enable` never writes a login unit
- [ ] Put the two new sections after `Run, stop and restart`, and link them from the top of the file
- [ ] The test `gives run steps in order` reads the first position of four literals; the new sections do not come before those positions
- [ ] In `Start at login`, state that a login unit has a minimal `PATH`, and that a service that needs more puts `PATH` in its `envFile`
- [ ] In docs/jobs-and-services.md, add one table: `enable` and `disable` change the stored `autostart` state and act now; `start`, `stop` and `restart` act now only; `add` and `rm` are for local commands; `install` and `uninstall` are for repository packages
- [ ] That table has a column `needs a live daemon`: `restart` needs one; `enable` starts the service now only with one
- [ ] One sentence gives the difference between `dg-daemon restart` (the daemon) and `dg-daemon service restart <label>` (one service)
- [ ] In docs/jobs-and-services.md, state that a service under a login unit gets `envFile` values and grants, not `passEnv` values, because a login unit has a minimal environment
- [ ] In docs/install.md, the layout table has one row for each role: add `service packages` to the Data cell and `service state` to the State cell, and give `<data>/services` and `<state>/services` in one sentence below the table
- [ ] In docs/install.md, put the `daemon` rule of slice 4 and the text of `blockedText` for `two-used` in the legacy-folder map and the message table
- [ ] In SECURITY.md, add one paragraph: a service package runs with the rights of the user; `install` pins a full commit id and shows the request before it writes; each `update` to a new commit shows the commit change and asks again on a terminal
- [ ] Put that paragraph after the paragraph on supervised services; do not use the word `passEnv` in it
- [ ] In plugins/dg/skills/jobs/SKILL.md, add `service install`, `update`, `uninstall`, `list`, `enable`, `disable`, `restart`, `logs` and `dg-daemon autostart install|remove|status`
- [ ] In SKILL.md, state that the skill does not answer the consent question of `install` or `update`: it gives the command, and the human runs it in a terminal
- [ ] In SKILL.md, state that `uninstall`, `disable` and `autostart install|remove` need a request from the human that names the package, the label or the login unit
- [ ] In SKILL.md, keep each channel-review section, the bootstrap fence, the SessionStart hook fence and the frontmatter `description` byte-identical, with one exception: the sentence on no autostart for `dg-daemon` itself now points to `dg-daemon autostart install`
- [ ] In SKILL.md, put the new commands in a new section; the commands keep the name `dg-daemon`
- [ ] Add pkg/skills-test/__tests__/service-install-docs.spec.ts: it checks each documented command, option, path and message against its source file
- [ ] Write no private organization name and no private repository name in a document
- [ ] Check by hand before the commit: a search of the changed files for the private names of the local decision log finds nothing
- [ ] The spec holds no private name and no part of one
- [ ] In docs/service-api.md, add the row `DG_SERVICE_STATE_DIR` to the key table: the absolute path of `<state>/services/<label>/`; the daemon makes the folder (mode 0700 on POSIX) before the service starts; an update or an uninstall of the package does not remove it
- [ ] Add `DG_SERVICE_STATE_DIR` to the key list of docs/jobs-and-services.md: the test `names the injected DG keys from supervisor source` reads that document
- [ ] Give no count of injected keys in a sentence of a document
- [ ] Add `DG_SERVICE_STATE_DIR` to the key list of pkg/skills-test/__tests__/outside-services-docs.spec.ts
- [ ] In docs/jobs-and-services.md, give the rules of the `dg` block: a relative `envFile` resolves below the state folder of the label and an absolute path is refused; `requires` is a list of executable names that `install` checks; `build` is one argv that runs after the answer `y`; a failed build of `install` leaves nothing; a failed build of `update` leaves the package at the old commit, and the clone can hold build output of the new commit
- [ ] In docs/jobs-and-services.md, state that `install` and `update` ask on a terminal only and have no option that gives consent
- [ ] In docs/jobs-and-services.md, state that `update` asks on each new commit: an unchanged block gets `Update to this commit? [y/N]`; a changed block gets the full request and `Apply these changes? [y/N]`; with no terminal `update` refuses
- [ ] In docs/jobs-and-services.md, state that only `update` with no new commit asks nothing
- [ ] In docs/jobs-and-services.md, state the `update` rule: the repository keys are replaced after the answer `y`; `autostart` and `passEnv` stay; the output names each replaced key (`replaced <label>.<key>`), also a key that the owner edited
- [ ] In the `update` text, state that a service that runs keeps its process, and uses the new commit after its next start
- [ ] In the section `Start at login`, state that with a login unit `dg-daemon start` and `dg-daemon restart` start the daemon through the service manager, and that this daemon has the environment of the login unit
- [ ] In the section `Start at login`, state that `dg-daemon stop` and `dg-daemon stop --force` leave the daemon stopped until the next login or the next `dg-daemon start`
- [ ] In docs/install.md, state that two daemon folders with data stop the daemon start, that the message names the two folders, and that dg merges nothing
- [ ] In ADR 0047, record the same rules: the `DG_SERVICE_STATE_DIR` key, no consent option, the `dg` block rules, and the service manager path of `start` and `restart`
- [ ] Three existing sentences of docs/jobs-and-services.md are in the path of this slice: (a) `Nothing starts the daemon at login` becomes `Without a login unit, nothing starts the daemon at login`; (b) the sentence that starts with `The new daemon has the environment of the` gets the limit `with no login unit`; (c) the sentence on the restart of only the `autostart` services stays
- [ ] Edit pkg/skills-test/__tests__/outside-services-docs.spec.ts for sentences (a) and (b) only when an assertion reads them
- [ ] In docs/channel-review.md, add one paragraph `Move to a service package`: the command `dg-skills channel-review export --env <env> --label <label>`, the path `<state>/services/<label>/import.json`, and the rule that the export refuses when the old daemon of that env runs
- [ ] Write each command in a code span with the `dg-daemon` prefix; slice 11 changes the first form to `dg …`
- [ ] In docs/install.md, give the remedy for two used daemon folders: move `<state>/daemon` to a different name when the legacy folder holds the sessions, then start again
- [ ] In docs/install.md, state that `dg-daemon serve` exits 78 for this block, and that the systemd unit does not start it again

#### Testing Criteria
##### Contracts
- [ ] Contract: docs/adr/toc.md holds one link to `0047-service-packages.md`, and the file exists with the headings of docs/adr/template.md and exactly one fenced `mermaid` block
- [ ] Contract: each command, option, path, key name and message in the changed documents is equal to the value in the source of slices 2 to 7 and 13
- [ ] Contract: docs/service-api.md names each injected key of pkg/dg-daemon/src/services/supervisor.ts, and no sentence gives a count of keys
- [ ] Contract: the documented texts `consent needs a terminal` and `two daemon folders hold data` are in their source files
- [ ] Method: for that contract, run `rg -F` for each documented literal against pkg/dg-daemon/src/commands/service.ts, service-package.ts, service-support.ts, service-logs.ts, autostart.ts, start.ts and stop.ts, pkg/dg-daemon/src/services/defaults.ts, packages.ts and supervisor.ts, pkg/common/src/node/dg-paths.ts, autostart.ts and layout.ts
- [ ] Contract: the example `dg` block of docs/jobs-and-services.md passes `parseServiceDefaults`; the example is the one fenced `json` block below the heading `Install a service from a repository`, and the spec reads it by that heading, puts it in `{ "dg": … }`, and calls `parseServiceDefaults` with fixed `dirs`
- [ ] Contract: that spec fails when the example block gets an unknown key
- [ ] Contract: `git diff master -- plugins/dg/skills/jobs/SKILL.md` shows no hunk in a line that holds `channel-review`, in the bootstrap fence or in the SessionStart JSON fence
- [ ] Contract: the `Start at login` section names the unit kind for each OS, the WSL steps, and that the `dg-phone` unit is a different unit
- [ ] Contract: the `Start at login` section states that `autostart install` fails on win32 with `DG_HOME` set
- [ ] Contract: the `Start at login` section states the three login-unit rules: `start` and `restart` use the service manager; that daemon has the environment of the login unit; `stop` and `stop --force` leave the daemon stopped until the next login or the next `dg-daemon start`
- [ ] Contract: the ADR has a `Date:` header and holds the same rules as the document
- [ ] Contract: the spec reads the documented messages from a list in the spec and finds each one in a source file
- [ ] Check: `bun scripts/skill-bootstrap-block.ts --check` exits 0; do not run it with `--write`
- [ ] Check: pkg/skills-test/__tests__/outside-services-docs.spec.ts passes; its only changes are the key list, the toc assertion, and an assertion on the sentences `Nothing starts the daemon at login` and `The new daemon has the environment of the`
- [ ] Check: each relative link in the changed documents opens an existing file
- [ ] Check (by hand, before the commit): a case-insensitive search of the changed files for the private names of the local decision log finds nothing; no spec holds a private name or a part of one
- [ ] Check: markdownlint and vale pass on the changed files; a wide table keeps the `markdownlint-disable MD013` fence that docs/install.md uses; the Mermaid block of the ADR renders
- [ ] Regression: `bun test` passes in pkg/skills-test; `bun test pkg/skills-cli/__tests__/skills-only-install.spec.ts` passes

#### Acceptance Criteria
- [ ] Given docs/jobs-and-services.md, when a reader wants to run a repository as a service, then the document gives `service install`, `service enable` and `dg-daemon autostart install` in that order, with the paths of the clone, the registry and the state folder
- [ ] Given docs/jobs-and-services.md, when a reader looks for the difference between `enable` and `start`, then one table gives it
- [ ] Given the jobs skill, when an agent reads it, then it finds each new command and the rule that the human answers the consent question
- [ ] Given docs/adr/toc.md, when a reader opens the 0047 link, then the record describes the service package model with the status Accepted
- [ ] Given docs/service-api.md, when the author of a service looks for its state folder, then the document gives `DG_SERVICE_STATE_DIR`
- [ ] Given docs/jobs-and-services.md, when a reader looks for the injected keys, then `DG_SERVICE_STATE_DIR` is in the list

### Slice 9 — dg-program

#### Engineering
- [ ] Add `"dg"` to `ProgramName` in pkg/common/src/node/program.ts and `dg: "dg"` to `SOURCE_PACKAGES`
- [ ] Create the package pkg/dg (`@dg/dg`, private, `"version": "1.0.0"`, `exports: { "./main": "./src/main.ts" }`) with package.json, tsconfig.json, bunfig.toml (the fence preload), src/index.ts and src/main.ts
- [ ] package.json of pkg/dg also has `scripts` (`lint`: `tsc --noEmit`, `test`: `bun test`), the workspace dependencies `@dg/common`, `@dg/dg-daemon`, `@dg/skills-cli` and `@dg/dg-agent` (`workspace:*`), and `bun-types` and `typescript`
- [ ] Copy tsconfig.json of pkg/dg from pkg/launcher
- [ ] The specs of pkg/dg are pkg/dg/__tests__/routing.spec.ts (fake mounts; it asserts the argv that each mount gets) and pkg/dg/__tests__/usage.spec.ts
- [ ] pkg/dg/src/index.ts has the form of pkg/dg-daemon/src/index.ts; pkg/dg/src/main.ts exports `main(argv: readonly string[], mounts: Mounts): Promise<number>`
- [ ] `mounts` gives one loader for each of `dg-daemon`, `dg-skills` and `dg-agent`; pkg/dg/src/main.ts imports no program, not statically and not dynamically
- [ ] Write the size-budget assertions first and see them fail; then write the code
- [ ] Create pkg/launcher/src/programs/dg.ts: it exports `main(argv)` and gives the loaders `() => import("./daemon")`, `() => import("./skills")` and `() => import("./agent")`, so the bundle uses the three entry chunks that exist
- [ ] pkg/dg/src/index.ts gives loaders that import `@dg/dg-daemon/main`, `@dg/skills-cli/main` and `@dg/dg-agent/main` for a checkout
- [ ] Add `dg` to `PROGRAMS` in pkg/launcher/src/dg.ts, and add `@dg/dg` to the devDependencies of pkg/launcher/package.json
- [ ] Run `bun install` at the repository root, which writes bun.lock; do not edit bun.lock by hand
- [ ] Routing in pkg/dg/src/main.ts: `service`, `job` and `autostart` call the dg-daemon `main` with the group name and the remaining arguments
- [ ] Routing: `daemon` calls the dg-daemon `main`, `skills` calls the dg-skills `main`, and `agent` calls the dg-agent `main`, each with the remaining arguments
- [ ] Routing: `install` and `extension` call the dg-skills `main` with `install`, `upgrade` calls it with `update`, and `doctor` calls it with `doctor`, each plus the remaining arguments
- [ ] Load each mounted `main` with its loader of `mounts`, in the branch that uses it
- [ ] Add `mountProgram(name: ProgramName): void` to pkg/common/src/node/program.ts: in a bundle (a name is recorded) it records `name`; in a checkout it stores `name` as the mounted program and does not turn on the bundle branch of `programCommand`
- [ ] `selfCommand` in pkg/common/src/node/self-command.ts returns `programCommand(<mounted>, args)` when a mounted program is set
- [ ] pkg/dg calls `mountProgram` before the mounted `main` runs, so that `selfCommand` and `programCommand` build the argv of that program and not of `dg`
- [ ] pkg/dg/src/main.ts has no static import of a value, as pkg/dg-daemon/src/main.ts: it loads `@dg/common/node/program` with a dynamic import, as pkg/launcher/src/dg.ts does; a static import puts program.ts in a shared chunk that the `dg` entry chunk then imports statically
- [ ] `dg`, `dg --help` and `dg help` print one usage text that lists each name of the routing table with its target, and exit 0
- [ ] Export `ROUTES` from pkg/dg/src/main.ts: one row for each of the ten names, with the target program and the target command; the usage text and the routing read it, and slice 11 imports it
- [ ] The usage line of `extension` is `extension   stage the browser extension (runs dg-skills install)`; `dg extension` and `dg install` are the same command and take the same options
- [ ] `dg --version` in a checkout prints `process.env.DG_BUILD_VERSION ?? "dev"`; `dg -h` is `dg --help`
- [ ] `dg help <name>` is `dg <name> --help`
- [ ] The name lookup uses `Object.hasOwn`
- [ ] Add no `dg start`, `dg stop` or `dg status`; the table has ten names
- [ ] A mounted program keeps its own usage lines, error prefix and exit codes; `dg` changes no command tree
- [ ] `dg` resolves no DG path and runs no layout step; the mounted program does
- [ ] The old names `dg-skills`, `dg-agent` and `dg-daemon` keep each behavior
- [ ] Update the program lists of pkg/launcher/__tests__/dispatch.spec.ts and startup-budget.spec.ts, and the entry-chunk test of size-budget.spec.ts (four entries), in the same change as program.ts: `Record<ProgramName, …>` does not compile in between
- [ ] size-budget.spec.ts: the entry filter keeps `/\/(skills|agent|daemon)-/` and adds `/\/dg-[a-z0-9]{8}\.js$/` for the `dg` entry, so a chunk such as `dg-paths-<hash>` does not match; the count becomes 4
- [ ] dispatch.spec.ts and startup-budget.spec.ts: add `dg` to the program lists and rename the tests that say three programs
- [ ] Assert the text `expected dg-skills, dg-agent, dg-daemon, dg` as one string: `dg` is a part of each other name
- [ ] Do not edit pkg/dg-daemon/src/main.ts, pkg/skills-cli/src/main.ts or pkg/dg-agent/src/main.ts
- [ ] Do not edit pkg/skills-cli/src/install/shims.ts (slice 10) or pkg/skills-cli/__tests__/layout-fixtures.ts
- [ ] pkg/dg stays at version `1.0.0` and is not in scripts/release-version.ts, as pkg/launcher; `dg --version` gives the stamp of the launcher
- [ ] The `lint` of pkg/dg reads the dg-daemon source; when `tsc` needs the pages build, add the `prelint` of pkg/dg-daemon
- [ ] pkg/dg has no workflow path until slice 10; slices 9 and 10 ship in one PR
- [ ] Add no stryker entry and no mise task for pkg/dg
- [ ] `depends_on: [4,5,6,7]` is a build order, not a code dependency: the launcher specs build the bundle from the sources of those slices
- [ ] Slice 3 is in the chain through slice 6, so `dg autostart` has its target
- [ ] All earlier slices are committed when this slice runs, so a bundle build failure in one of their files is a finding

#### Testing Criteria
##### Contracts
- [ ] Contract: `ProgramName` is `"dg-skills" | "dg-agent" | "dg-daemon" | "dg"`; `programCommand("dg", ["x"])` in a checkout is `[process.execPath, <repo>/pkg/dg/src/index.ts, "x"]`
- [ ] Contract: `dg.js dg --version` prints the same line as `dg.js dg-skills --version`
- [ ] Contract: `dg.js nope` exits 64 and its error text holds `expected dg-skills, dg-agent, dg-daemon, dg`
- [ ] Contract: for each row (`service`, `job`, `autostart`, `daemon`, `skills`, `agent`, `extension`, `install`, `upgrade`, `doctor`), `dg <name> --help` gives the same stdout and exit code as the `--help` of its target
- [ ] Contract: with no daemon, `dg service status` gives the same stderr and exit code as `dg-daemon service status`; `dg job list` gives the same result as `dg-daemon job list`
- [ ] Contract: `dg nope` exits 1 with `dg: unknown command "nope"; run dg --help` on stderr and empty stdout; the exit code 1 here and the exit code 64 of `dg.js nope` are different on purpose
- [ ] Contract: `dg --help` exits 0 and its stdout holds each name of the routing table
- [ ] Contract: in a bundle, `programName()` is `dg-skills` after `dg skills <args>` starts, and `dg-daemon` after `dg service <args>` starts; in a checkout it stays `undefined`
- [ ] Contract: a command that calls `selfCommand` starts the same child argv below `dg skills` as below `dg-skills`, in the bundle and in a checkout
- [ ] Contract (size): dg.js is 16 KB at most and has no static import; the bundle has four program entry chunks, and each imports no other chunk statically
- [ ] Contract (startup): `dg --version` is in the budget of pkg/launcher/__tests__/startup-budget.spec.ts
- [ ] Contract: `dg extension --help` gives the same stdout and exit code as `dg-skills install --help`; `dg extension firefox` gives the dg-skills `main` the arguments `["install", "firefox"]`
- [ ] Contract: the routing table has ten names, and `dg --help` lists each one
- [ ] Contract (pkg/common/__tests__/program-command.spec.ts): in a checkout, after `mountProgram("dg-skills")`, `selfCommand(["x"])` is `[process.execPath, <repo>/pkg/skills-cli/src/index.ts, "x"]`; in a bundle it is `[process.execPath, Bun.main, "dg-skills", "x"]`
- [ ] Contract: `dg toString`, `dg constructor`, `dg __proto__` and `dg Service` give the unknown-command error
- [ ] Contract: `dg -h` gives the output of `dg --help`, and `dg help service` gives the output of `dg service --help`
- [ ] Contract: `dg --version` in a checkout prints `dev` when `DG_BUILD_VERSION` is not set
- [ ] Contract: `dg daemon --version`, `dg skills --version` and `dg agent --version` give the output of the mounted program
- [ ] Contract: with `DG_PATH_FENCE` set and `DG_HOME` outside it, `dg --help` exits 0
- [ ] Contract: `dg service` and `dg job` with no more arguments give the output and the exit code of `dg-daemon service` and `dg-daemon job`
- [ ] Contract: `dg skills stash -- --x ""` gives the mounted `main` the arguments `["stash", "--", "--x", ""]`
- [ ] Contract: the exit code of `dg` is the value that the mounted `main` returns; a 3 stays 3
- [ ] Edge: `dg skills stash --help` reads neither the inbox chunk nor the playwright chunk
- [ ] Edge: `dg daemon status` and `dg-daemon status` skip the layout step in the same way
- [ ] Edge: a relative `DG_HOME` reaches a mounted program as an absolute path
- [ ] Regression: `bun test` passes in pkg/common, pkg/dg and pkg/launcher; `bun run lint` passes in the three packages; pkg/skills-test/__tests__/home-fence-reach.spec.ts passes with the new package; pkg/common/__tests__/node-autostart.spec.ts passes: the unit argv `launcherCommand(<dataDir>, "dg-daemon", ["serve"])` does not change

#### Acceptance Criteria
- [ ] Given the bundle, when the owner runs `dg service status --json`, then the result is the same as `dg-daemon service status --json`
- [ ] Given the bundle, when the owner runs `dg skills doctor` or `dg doctor`, then the result is the same as `dg-skills doctor`
- [ ] Given the bundle, when the owner runs `dg agent start`, then the result is the same as `dg-agent start`
- [ ] Given `dg` with no argument, when it runs, then it prints the ten names `service`, `job`, `autostart`, `skills`, `agent`, `daemon`, `extension`, `install`, `upgrade` and `doctor`
- [ ] Given a script that calls `dg-skills`, `dg-agent` or `dg-daemon`, when it runs after this change, then its result does not change
- [ ] Given the bundle, when the owner runs `dg extension <target>`, then the command runs `dg-skills install <target>`

### Slice 10 — dg-launcher-install

#### Engineering
- [ ] In pkg/skills-cli/src/install/shims.ts, `PROGRAMS` has four names (`dg` first) and a new `LEGACY_PROGRAMS` has the three old names
- [ ] `writeShims` uses `PROGRAMS`; `syncCompatLaunchers` and `launcherFiles` of pkg/skills-cli/src/install/clean.ts use `LEGACY_PROGRAMS`
- [ ] `dg-skills clean` does not touch the launcher folder `paths.binDir`; this slice does not change that
- [ ] `syncCompatLaunchers` writes no `dg` launcher into the legacy `~/.dg/bin` folder and does not change a `dg` file there: no released skill calls `dg` there
- [ ] Add `dg` to the program loop of pkg/skills-cli/bootstrap.sh and of pkg/skills-cli/bootstrap.ps1, after `dg-daemon`
- [ ] Change the launcher list in each text to `the dg, dg-skills, dg-agent and dg-daemon launchers`: the `install` description in pkg/skills-cli/src/commands/install.ts, the sentence of pkg/skills-cli/src/install/skills-only.ts, the same sentence of bootstrap.sh, the header comments of the two bootstrap scripts, and the header comment of pkg/skills-cli/src/install/cli.ts
- [ ] The skills-only sentence is in skills-only.ts, in bootstrap.sh and in four specs: skills-only.spec.ts, skills-only-install.spec.ts, retired-binaries.spec.ts and bootstrap-asset-selection.spec.ts
- [ ] Do not edit docs/install.md, README.md or docs/AGENT-INSTALL.md; slice 11 owns them
- [ ] Add one doctor check `dg-launcher` next to `launcher-on-path` in pkg/skills-cli/src/doctor/shared.ts: when the `dg-skills` launcher exists in `binDir` and the `dg` launcher does not, it warns
- [ ] The fix of that warning is `dg-skills install --cli-only` when `isCliOnly(ctx)` is true, and `dg-skills install` in each other case
- [ ] The check takes the platform as a parameter, so the `dg.cmd` branch has a test on Linux
- [ ] Before the workflow edit, run `dg.js dg --version` on the bundle of slice 9; it must print the version
- [ ] In .github/workflows/release.yml, rename the step `Run --version for all three programs` to four programs, add `dg="$("$bun" lib/dg.js dg --version)"`, and add `$dg` to the comparison loop and to the echo line
- [ ] binary-distribution.spec.ts checks the comparison loop, not only the command text
- [ ] Change release.yml, skills-blt.yml, cli-smoke.spec.ts and binary-distribution.spec.ts in one commit
- [ ] Slice 12 edits skills-blt.yml after this slice
- [ ] Add the path `pkg/dg/**` and the lint and test steps of pkg/dg to .github/workflows/skills-blt.yml
- [ ] Update each spec list of program names to four names: install-shims.spec.ts, compat-launchers.spec.ts (three names in the legacy folder), install-retired-binaries.spec.ts, bootstrap-fixtures.ts, agent-only-install.spec.ts, skills-only-install.spec.ts, skills-only.spec.ts, install-version-pin.spec.ts, and in pkg/skills-test: binary-distribution.spec.ts, cli-smoke.spec.ts, retired-binaries.spec.ts, bootstrap-asset-selection.spec.ts
- [ ] compat-launchers.spec.ts keeps three names and reads `LEGACY_PROGRAMS`
- [ ] The fixture bundle of bootstrap-fixtures.ts answers `dg --version`; no production code changes for that
- [ ] `RETIRED_BINARIES` stays `["dg-server"]`
- [ ] Do not edit scripts/skill-bootstrap-block.ts or a SKILL.md file
- [ ] A dg launcher is a regular file whose first 4096 bytes hold no NUL byte and hold the text `lib/current/dg.js` (`lib\current\dg.js` on win32); read the file type with `lstat`
- [ ] Not a dg launcher, so kept with the warning: a link to a file that is not a dg launcher, a directory, an empty file, a file that cannot be read, a script such as `exec dg-skills "$@"`
- [ ] A link with no target is replaced
- [ ] A dg launcher with an added line is a dg launcher
- [ ] bootstrap.sh uses `[ -L ]`, `[ -d ]` and `grep -qF`; bootstrap.ps1 uses `Select-String -SimpleMatch`
- [ ] The three implementations (`writeShims`, bootstrap.sh, bootstrap.ps1) run the same fixture names
- [ ] `writeShims`: when `<bin>/dg` (`dg.cmd` on win32) exists and is not a dg launcher, keep the file, write the three other launchers, and print one warning; this rule is for the name `dg` only
- [ ] `writeShims(bin, root, platform, warn)`: `warn` is a function for one line; its default writes to stderr
- [ ] Do not edit pkg/skills-cli/src/install/layout.ts
- [ ] One bootstrap run can print the warning two times (the script, then `dg-skills install`)
- [ ] `writeShims` and bootstrap.ps1 remove `<name>.exe` only for the three legacy names; they never remove `dg.exe`
- [ ] The doctor check `dg-launcher` also warns when the launcher exists and the first `dg` on `ctx.env.PATH` is a different file: detail `dg on PATH is <path>, not <launcher>`, with a fix that is text only
- [ ] The program loops of bootstrap.sh and bootstrap.ps1 apply the same rule to `dg`, before `dg-skills install` runs
- [ ] In bootstrap.sh the test runs before `mktemp` and `mv -f`; in bootstrap.ps1 it runs before `WriteAllText`
- [ ] The launcher text of bootstrap.sh is not byte-equal to the template of `writeShims`; the two hold `lib/current/dg.js`
- [ ] The doctor check `dg-launcher` gives `warn` for a file that is not a dg launcher, with a fix that is text only and that doctor does not run
- [ ] When `<binDir>/dg` is a symbolic link whose target is a dg launcher, install replaces it like a regular dg launcher of another root; only a `dg` file that is not a dg launcher is kept with a warning

#### Testing Criteria
##### Contracts
- [ ] Contract: with `<binDir>/dg` a symbolic link to a dg launcher, install replaces it and prints no keep warning
- [ ] Contract: `writeShims(bin, root)` writes `dg`, `dg-skills`, `dg-agent` and `dg-daemon` (`.cmd` on win32); the `dg` launcher runs `<root>/runtime/current/bun <root>/lib/current/dg.js dg "$@"`
- [ ] Contract: after bootstrap.sh, `ls <bin>` gives `dg`, `dg-agent`, `dg-daemon`, `dg-skills`, and `<bin>/dg --version` prints the release version
- [ ] Contract: bootstrap.ps1 writes `dg.cmd` with the form of the three other `.cmd` launchers
- [ ] Contract: an install that has three launchers gets the `dg` launcher when `dg-skills install` runs again
- [ ] Contract: `clean` of a legacy bin folder that holds the three notice launchers and a `dg` file of a different tool keeps the folder and names `dg` in its `kept` line
- [ ] Contract: `syncCompatLaunchers` writes no `dg` file into the legacy `~/.dg/bin` folder: a folder that held none holds none after it
- [ ] Contract: the skills-only sentence is equal in skills-only.ts, in bootstrap.sh and in the four specs that lock it: skills-only.spec.ts, skills-only-install.spec.ts, retired-binaries.spec.ts and bootstrap-asset-selection.spec.ts
- [ ] Contract: doctor reports `dg-launcher` as `warn` when only the `dg` launcher is absent, with the fix `dg-skills install --cli-only` for a CLI-only install and `dg-skills install` in each other case, and as `ok` when the launcher exists
- [ ] Contract: with the platform parameter `win32`, the check reads `dg.cmd`; that test runs on Linux
- [ ] Contract: the smoke step of release.yml runs `dg.js dg --version` and holds `$dg` in its comparison loop; skills-blt.yml lists `pkg/dg/**` and runs `bun run lint` and `bun test` in pkg/dg
- [ ] Contract: with a file `<bin>/dg` that is not a dg launcher, `writeShims` leaves its bytes and its mode unchanged, writes `dg-skills`, `dg-agent` and `dg-daemon`, and prints `dg: kept <path>; it is not a dg launcher. Remove it or rename it, then run dg-skills install again` on stderr one time or more; the install exits 0
- [ ] Contract: bootstrap.sh and bootstrap.ps1 leave that file unchanged and print the same sentence with the path of the kept file (`dg` or `dg.cmd`); each script has the text as its own literal, and a test for each script checks it
- [ ] Contract: an existing dg launcher of a different root is replaced
- [ ] Contract: doctor reports `dg-launcher` as `warn` with the detail `<path> is not a dg launcher` and the fix `remove or rename <path>, then run dg-skills install`; `runnableFix` gives `null` for that fix
- [ ] Contract: a file `~/.dg/bin/dg` that is not from dg is byte-identical after `syncCompatLaunchers`
- [ ] Contract: with an injected `PATH` whose first `dg` is a different file, doctor reports `dg-launcher` as `warn` with the detail `dg on PATH is <path>, not <launcher>`; `runnableFix` gives `null` for that fix
- [ ] Contract: `writeShims(bin, root, "win32")` with a `dg.cmd` that is not a dg launcher keeps it and writes the three other `.cmd` files
- [ ] Contract: on win32, a file `dg` with no extension is ignored: no warning
- [ ] Contract: pkg/skills-cli/src/install/skills-only.ts writes no launcher itself; the rule for a kept `dg` file is only in `writeShims` and in the two bootstrap scripts
- [ ] Contract: with a kept `dg` file, the `dg-daemon` launcher is written and the exit code is 0, so a login unit is not affected
- [ ] Contract: the fixtures of the launcher rule give the same result in `writeShims`, bootstrap.sh and bootstrap.ps1: a link to a file that is not a dg launcher, a directory, an empty file, a file that cannot be read and a script `exec dg-skills "$@"` are kept; a link with no target and a dg launcher with an added line are replaced
- [ ] Edge: `--skills-only`, `--cli-only` and `--agent-only` installs write the same four launchers
- [ ] Edge: on win32, a `dg.exe` in the launcher folder has the same bytes after `writeShims` and after bootstrap.ps1
- [ ] Check: the checksum step of release.yml for bootstrap.sh needs no change
- [ ] Regression: `bun test` passes in pkg/skills-cli and pkg/skills-test; `bun run lint` passes in pkg/skills-cli

#### Acceptance Criteria
- [ ] Given a new machine, when the bootstrap script ends, then `dg --version`, `dg-skills --version`, `dg-agent --version` and `dg-daemon --version` print the same version
- [ ] Given an install of the release before this one, when the first `dg-skills install` or bootstrap of the new release ends, then the `dg` launcher exists; until then `dg-skills doctor` warns
- [ ] Given an install with no `dg` launcher, when `dg-skills doctor` runs, then one warning names the install command as the fix: `dg-skills install`, or `dg-skills install --cli-only` for a CLI-only install
- [ ] Given a release build, when the smoke step runs, then it starts `dg` from the bundle
- [ ] Given a file `dg` of a different tool in the launcher folder, when install or bootstrap runs, then the file is unchanged, the three other launchers exist, and one warning names the file

### Slice 11 — dg-front-door-docs

#### Engineering
- [ ] In docs/adr/0020-one-dg-command.md, add a dated section `Amendment` at the end of `Decision`; do not rewrite the accepted text
- [ ] The amendment states: channel review leaves dg in a later major release (no date), so there is no `dg review` group; `service install` (ADR 0047) replaces the step that registers `review-<env>`; `dg` is a fourth program name over the three command trees; the single binary and the `dg-v<x>` tag are not built
- [ ] The amendment also corrects, by statement, the accepted text that is now not true: `dg review start` and the review group; `dg-daemon has no command tree of its own`; `every command lives in pkg/skills-cli`; the count of packages; the Mermaid diagram; the single binary; the `dg-v<x>` tag; the `review-<env>` step
- [ ] The amendment states that `dg autostart` is the mount of `dg-daemon autostart`
- [ ] In the amendment, do not write `supersedes` near 0020, do not write `Deprecated`, and do not change the `Status:` line
- [ ] In docs/adr/toc.md, move the 0020 row out of `Proposed changes` to `## Platform`, before the 0043 row, in the Accepted form of the other rows and in 160 columns at most, so the index agrees with `Status: Accepted` in the file
- [ ] Correct the count in the first paragraph of toc.md (`sixteen historical records`) when it changes
- [ ] In docs/jobs-and-services.md, the groups `service`, `job` and `autostart` use the form `dg service …`, `dg job …` and `dg autostart …`
- [ ] The commands of the daemon itself keep the form `dg-daemon start`, `dg-daemon stop`, `dg-daemon restart` and `dg-daemon status`
- [ ] State one time that `dg-daemon service …` is the same command as `dg service …`
- [ ] In pkg/skills-test/__tests__/outside-services-docs.spec.ts, change the one literal `dg-daemon service start` of the test `gives run steps in order` to `service start`; keep each other literal of that spec and their order
- [ ] Change the count of launchers only, in these sentences: docs/install.md near lines 36 and 275, docs/AGENT-INSTALL.md near lines 78, 247 and 376, docs/DEVELOPER.md near line 462 (`smoke-bundle`), README.md line 22
- [ ] Do not change the text on the legacy `~/.dg/bin` folder (docs/install.md near lines 139, 247 and 317): it keeps three names
- [ ] Do not change the command forms of the upgrade steps in docs/AGENT-INSTALL.md
- [ ] In docs/AGENT-INSTALL.md, write each program name in its own code span, so that no text `dg-agent <word>` appears that is not a command (pairing-docs.spec.ts runs `dg-agent <word> --help`)
- [ ] In docs/install.md, document the result of slice 10: a `dg` file that is not a dg launcher is kept, with the message `dg: kept <path>; it is not a dg launcher. …`; the doctor check `dg-launcher`; dg writes no `dg` file into the legacy folder
- [ ] In docs/install.md, state that the `dg` launcher appears with the first `dg-skills install` or bootstrap of the new release
- [ ] Document no `clean` rule for the launcher folder
- [ ] Check each documented literal of slice 10 against its source
- [ ] In docs/DEVELOPER.md, add pkg/dg to the package list and to the `skills-blt` row, and state that `dg` mounts the three command trees
- [ ] In docs/DEVELOPER.md, add to the version table that `dg` reports the stamp of the launcher and that pkg/dg stays at `1.0.0`
- [ ] In docs/DEVELOPER.md, add one sentence on `DG_PATH_FENCE` to the test section
- [ ] Do not edit the CI paragraph of docs/DEVELOPER.md that names pkg/channel-review; slice 12 owns it
- [ ] In README.md, add one table of the ten `dg` names: `service`, `job`, `autostart`, `skills`, `agent`, `daemon`, `extension`, `install`, `upgrade`, `doctor`
- [ ] The README.md table has two columns: the `dg` name, and the target program and command (`dg upgrade` is `dg-skills update`)
- [ ] Put the table after the install paragraph and before the skills table, not between the jobs-and-services bullet and the `Service API v1 (provisional)` bullet
- [ ] Add pkg/skills-test/__tests__/dg-front-door-docs.spec.ts: each `dg <name>` group in the changed documents is a name of `ROUTES`, which the spec imports from pkg/dg/src/main.ts by a relative path, so pkg/skills-test/package.json does not change
- [ ] Edit pkg/skills-test/__tests__/service-install-docs.spec.ts only for a sentence that this slice moved
- [ ] Write no private organization name and no private repository name in a document
- [ ] Change no SKILL.md file: the skills keep the names `dg-skills`, `dg-agent` and `dg-daemon`

#### Testing Criteria
##### Contracts
- [ ] Contract: `git diff <base of PR 2> -- docs/adr/0020-one-dg-command.md` shows no removed line
- [ ] Contract: docs/adr/toc.md lists 0020 one time, outside `Proposed changes`
- [ ] Contract: the amendment links `0047-service-packages.md`, and the file exists
- [ ] Contract: pkg/skills-test/__tests__/outside-services-docs.spec.ts passes; its test `does not deprecate ADR 0020 or ADRs 0008 to 0019` is unchanged
- [ ] Contract: each `dg <name>` in a code span or a fenced block of the changed documents is a name of `ROUTES`; the check takes the first word after `dg `, permits `--help`, `--version` and `help`, and ignores prose and the texts `dg: kept` and `dg-v<x>`
- [ ] Contract: a search of README.md and docs/ with a pattern that permits code spans and commas finds no sentence that lists `dg-skills`, `dg-agent` and `dg-daemon` as the launchers and leaves out `dg`, except the paragraphs on the legacy `~/.dg/bin` folder
- [ ] Contract: `git diff <base of PR 2> --stat -- plugins/ scripts/skill-bootstrap-block.ts docs/service-api.md SECURITY.md` is empty
- [ ] Contract: the target column of the README.md table is equal to `ROUTES`
- [ ] Contract: each line of `## Platform` in docs/adr/toc.md has 160 columns at most
- [ ] Contract: for each `dg <group> --help` form in a fenced block of the changed documents, `bun pkg/dg/src/index.ts <group> --help` exits 0; the spec runs in the test home fence and starts no daemon
- [ ] Check: `bun scripts/skill-bootstrap-block.ts --check` exits 0
- [ ] Check: each relative link in the changed documents opens an existing file
- [ ] Check: a case-insensitive search of the changed files for the private names of the decision log finds nothing
- [ ] Regression: `bun test` passes in pkg/skills-test, with service-install-docs.spec.ts, pairing-docs.spec.ts and skill-index-docs.spec.ts; `bun test pkg/skills-cli/__tests__/skills-only-install.spec.ts` passes

#### Acceptance Criteria
- [ ] Given ADR 0020, when a reader opens it, then the amendment says that channel review leaves dg and that `service install` replaces the `review-<env>` step
- [ ] Given docs/adr/toc.md, when a reader looks for 0020, then it is not in `Proposed changes`
- [ ] Given README.md, when a reader looks for the entry command, then one table lists the `dg` groups
- [ ] Given docs/jobs-and-services.md, when a reader copies a `dg service` command, then the command runs on a build of this branch; the spec proves it with the `--help` form of each group that a document shows

### Slice 12 — remove-channel-review

#### Engineering
- [ ] Start this slice only after the operator gate of the PR plan
- [ ] Delete the package pkg/channel-review, and remove `@dg/channel-review` from pkg/skills-cli/package.json; `bun install` writes bun.lock
- [ ] Delete pkg/skills-cli/src/channel-review/ and pkg/skills-cli/src/commands/channel-review.ts; remove `registerChannelReview` from pkg/skills-cli/src/register-all.ts and `channel-review` from pkg/skills-cli/src/doctor/registry.ts
- [ ] In pkg/skills-cli/src/credentials/cli.ts, replace the example prefix `channel-review` in the `grant` help text with `my-service`
- [ ] In pkg/common/src/node/daemon-schema.ts, keep `createV12ChannelReview` and step 12, and add step 14: `DROP VIEW channel_review_requests`, `DROP VIEW channel_review_current`, `DROP TABLE channel_review_state`
- [ ] Keep the constant `CHANNEL_REVIEW_SCHEMA_VERSION` in pkg/common/src/node/daemon-schema.ts for step 12, remove its `export` keyword, and remove its import in pkg/common/src/node/daemon-db.ts
- [ ] The change deletes no credential and no grant: the entries below `channel-review/` in the credential store and the file `<state>/grants/channel-review.token` stay
- [ ] Add `channel-review` to `RETIRED_SKILLS` in pkg/common/src/node/install-skills.ts with the hashes of its released SKILL.md files in `RETIRED_SKILL_HASHES`, and add the fixture copy to pkg/skills-test/__tests__/fixtures/retired-skills/channel-review/
- [ ] Get the hashes with `git log --all --format=%H -- plugins/dg/skills/channel-review/SKILL.md`, then `git show <commit>:<path> | sha256sum` for each different blob; the files in `references/` need no hash
- [ ] Correct the doc comment of `RETIRED_SKILL_HASHES`: no other plugin provides this skill
- [ ] Delete plugins/dg/skills/channel-review/
- [ ] In plugins/dg/skills/jobs/SKILL.md, remove each channel-review section, the channel-review column of the action table, and the SessionStart hook block that starts `channel-review`; update the frontmatter `description`
- [ ] Remove the channel-review text from plugins/dg/skills/doctor/SKILL.md, plugins/dg/skills/thrash/SKILL.md and plugins/dg/skills/README.md
- [ ] Replace the content of docs/channel-review.md with the migration note; keep the path, so existing links open it
- [ ] The migration note gives this order: on the last release before the major, run `dg-daemon service install <bot repository URL>`; stop the old daemon with `dg-skills channel-review stop --env <env>`; run `dg-skills channel-review export --env <env> --label <label>`; run `dg-daemon service enable <label>`; make sure that a review runs; remove the SessionStart hook that starts `dg-skills channel-review` from the settings file; remove each `review-<env>` entry with `dg-daemon service rm review-<env>`; then upgrade to the major
- [ ] The migration note states: `export` exists only before the major; the major drops the state tables and no downgrade is possible after it; the stored credentials and the grant stay
- [ ] The migration note states: the copy `channel-review-state.<env>.json` is an archive; it is not an import file, and the bot cannot read it; dg gives no conversion
- [ ] The migration note states: the file `pre-migration-v14-….db` is a second source for a restore, and dg does not remove it
- [ ] In docs/adr/toc.md, remove `pkg/channel-review` from the diagram
- [ ] Remove the channel-review text from README.md, SECURITY.md, .env.example, docs/AGENT-INSTALL.md, docs/DEVELOPER.md, docs/contributing.md and pkg/skills-cli/README.md
- [ ] In docs/install.md, remove the channel-review stop step and keep the two layout rows of the legacy move
- [ ] Do not edit pkg/common/src/node/layout.ts: its two `channel-review` entries are not in the removal list
- [ ] After the deletes, no source file of dg names a credential below `channel-review/` or a `CHANNEL_REVIEW_` variable
- [ ] In .github/workflows/skills-blt.yml, remove the path `pkg/channel-review/**` and the lint and test steps of pkg/channel-review
- [ ] In .gitleaks.toml, remove the allow rule of the deleted `channel-review-connect.spec.ts`
- [ ] In .mise/config.toml, remove: each task that runs `channel-review` or has `dir = "pkg/channel-review"`, the `CHANNEL_REVIEW_RELAY_SECRET_*` entry of `redactions`, and the words on channel-review in the `description` of the build task
- [ ] Delete the specs of the removed code (pkg/skills-cli/__tests__/channel-review-*.spec.ts, pkg/skills-test/__tests__/channel-review-skill.spec.ts, pkg/dg-daemon/__tests__/store/channel-review-state.spec.ts) and update each spec that names channel-review in a list
- [ ] Rename the credential fixtures that use the prefix `channel-review/` to `my-service/` and keep each assertion: pkg/common/__tests__/credentials-format.spec.ts, pkg/common/__tests__/installed-skill-files.ts, pkg/dg-daemon/__tests__/store/credentials-store.spec.ts, pkg/dg-daemon/__tests__/server/credentials-frame.spec.ts, pkg/skills-cli/__tests__/credentials-cli.spec.ts and pkg/skills-cli/__tests__/doctor-fixtures.ts
- [ ] Update the table lists of pkg/dg-daemon/__tests__/store/overwatch-board.spec.ts and pkg/dg-daemon/__tests__/store/scheduled-jobs.spec.ts
- [ ] Keep pkg/skills-cli/__tests__/test-home-fence.ts, test-run-end.ts and home-fence.spec.ts: each package bunfig preloads the fence
- [ ] In pkg/skills-test/__tests__/outside-services-docs.spec.ts, change the test `does not deprecate ADR 0020 or ADRs 0008 to 0019`: the assertion on 0020 stays; the toc assertion now expects `Deprecated` for each record from 0008 to 0019
- [ ] Name the new spec of the state copy pkg/common/__tests__/channel-review-state-copy.spec.ts
- [ ] pkg/common/src/node/fs.ts keeps `removeInside`, and pkg/common/src/node/log-tail.ts stays: `service uninstall` and `service logs` use them
- [ ] Use the commit subject `feat(skills-cli)!: remove channel-review` with a `BREAKING CHANGE:` footer that links docs/channel-review.md, so the release is a major
- [ ] Write no private organization name and no private repository name in a file; the migration note uses `<bot repository URL>`
- [ ] In `openDaemonDatabase` of pkg/common/src/node/daemon-db.ts, read the schema version first; make the copy only when the version is 12 or 13 and `sqlite_master` holds `channel_review_state`
- [ ] Before the migration to version 14 runs on such a database, write one file for each row of `channel_review_state`: `<daemonDir>/channel-review-state.<env>.json`, with `writeFileAtomic(path, data, 0o600)`
- [ ] Put the copy code in one named function in daemon-db.ts; add no new source file
- [ ] Each copy is one JSON object `{ "env", "revision", "updatedAt", "state" }`; `state` is the parsed `state_json` of the row
- [ ] `openDaemonDatabase` is the one caller of `runMigrations` with `SCHEMA_STEPS`; pkg/dg-daemon/src/store/index.ts opens daemon.db through it, so the copy is on each path to step 14
- [ ] When a copy cannot be written, the open fails with an error that names the path, and step 14 does not run
- [ ] The `pre-migration-v<version>-….db` copy of pkg/common/src/node/sqlite.ts stays as it is
- [ ] The migration note names the two copy files and their folder
- [ ] Set `Status: Deprecated` in each record from docs/adr/0008 to docs/adr/0019 (twelve files), and add one line below it that says that channel review left dg and links ADR 0047; change no other line of those records
- [ ] In docs/adr/toc.md, show the twelve records as deprecated, and move 0018 and 0019 out of `Proposed changes`
- [ ] Do not change the text of ADRs 0002, 0003, 0007 and 0042, and do not edit CHANGELOG.md; the release workflow writes it
- [ ] In docs/DEVELOPER.md, remove the section of the `CR-` error codes
- [ ] Give in the commit message the reason that step 12 stays: a database at version 11 needs it to get to version 14
- [ ] Start from .github/workflows/skills-blt.yml as slice 10 left it

#### Testing Criteria
##### Contracts
- [ ] Contract: `dg-skills channel-review status` exits 1 with the unknown-command error of commander; `dg-skills --help` does not list `channel-review`
- [ ] Contract: a new daemon.db has the schema version 14 and no object whose name starts with `channel_review`
- [ ] Contract: a daemon.db at version 13 with one `channel_review_state` row moves to version 14; the three objects are gone; the row counts of each other table are equal before and after
- [ ] Contract: a daemon.db at version 11 moves through steps 12, 13 and 14 with no error
- [ ] Contract: a binary of the release before the major refuses a version 14 database with `ForwardOnlyVersionError`
- [ ] Contract: after the upgrade, `dg-skills credentials list` still shows each `channel-review/` name, and the grant token file exists
- [ ] Contract: a skills-only install removes an installed dg copy of the `channel-review` skill (hash match) and keeps a copy with other content
- [ ] Contract: `rg --hidden -il "channel-review|channel_review" pkg plugins .github .gitleaks.toml .mise .claude-plugin` finds only: pkg/common/src/node/daemon-schema.ts, daemon-db.ts, install-skills.ts and layout.ts; pkg/common/__tests__/node-daemon-db.spec.ts; the layout specs; the schema specs; pkg/common/__tests__/channel-review-state-copy.spec.ts (the new spec of the copy); and the retired-skill fixture; the search does not read docs/, because an Accepted ADR keeps its history
- [ ] Contract: docs/channel-review.md holds the seven ordered steps that come before the upgrade step, and the words `no downgrade`
- [ ] Contract: skills-blt.yml has no step with `pkg/channel-review`
- [ ] Contract: plugins/dg/skills/jobs/SKILL.md holds no `channel-review` text and no `"hooks": {` fence; `bun scripts/skill-bootstrap-block.ts --check` exits 0
- [ ] Contract: a database at version 13 with a `dev` row and a `prod` row gives `channel-review-state.dev.json` and `channel-review-state.prod.json` beside daemon.db, each with mode 0600 (POSIX), and then has no object whose name starts with `channel_review`
- [ ] Contract: `state` of each copy is deep-equal to the `state_json` of its row; `revision` and `updatedAt` are the values of the row
- [ ] Contract: a database with no `channel_review_state` row, and a new database, give no copy file
- [ ] Contract: when a copy path is not writable, the open throws an `Error` that holds the path; the schema version stays 13 and the row is present
- [ ] Contract: a second open at version 14 writes no file and changes no copy
- [ ] Contract: a search for `SCHEMA_STEPS` in pkg/*/src finds one `runMigrations` call, in pkg/common/src/node/daemon-db.ts
- [ ] Contract: each record from docs/adr/0008 to 0019 has the line `Status: Deprecated` and one link to `0047-service-packages.md`; `git diff` shows no other changed line in those files
- [ ] Contract: docs/adr/toc.md lists 0018 and 0019 outside `Proposed changes`
- [ ] Contract: the two `channel-review` entries of `LAYOUT_TABLE` are equal to master
- [ ] Contract: a database at version 11 makes no copy file, gives no error, and moves to version 14
- [ ] Contract: the `RETIRED_SKILL_HASHES` list holds the hash of the SKILL.md of the last release before the major
- [ ] Contract: in pkg/skills-test/__tests__/outside-services-docs.spec.ts, the test on ADR 0020 keeps its assertion on 0020, and its toc assertion expects `Deprecated` for each record from 0008 to 0019
- [ ] Edge: the first start of the major does not read and does not change the pid file of the old channel-review daemon
- [ ] Check: each relative link in docs/, README.md and SECURITY.md opens an existing file
- [ ] Check: a case-insensitive search of the changed files for the private names of the decision log finds nothing
- [ ] Check: pkg/launcher/__tests__/size-budget.spec.ts passes
- [ ] Check: `skillFilesCheck` and `allowRuleCheck` stay in pkg/skills-cli/src/doctor/checks.ts, because the doctor groups `file`, `ssms` and `inbox` call them; the delete of pkg/skills-cli/src/channel-review/doctor.ts removes one caller only
- [ ] Regression: `bun test` passes at the root and in each package directory; `bun run lint:all` passes; `bun install --frozen-lockfile` passes

#### Acceptance Criteria
- [ ] Given the major release, when the owner runs `dg-skills channel-review`, then the command does not exist
- [ ] Given a machine that ran channel review, when the daemon of the major starts, then daemon.db has no channel-review object and each other table keeps its rows
- [ ] Given the same machine, when the owner lists the credentials, then the `channel-review/` entries are present
- [ ] Given docs/channel-review.md, when the owner reads it, then it gives the order install, stop, export, enable, verify, remove the hook, remove the `review-<env>` entries, upgrade
- [ ] Given the repository, when `ls pkg` and `ls plugins/dg/skills` run, then no `channel-review` folder exists
- [ ] Given the PR, when the release workflow reads its commits, then the next version is a major
- [ ] Given a machine that ran channel review, when the daemon of the major starts the first time, then one JSON copy of the state of each env is beside daemon.db, and the tables are gone
- [ ] Given docs/adr, when a reader opens a record from 0008 to 0019, then its status is Deprecated and it links ADR 0047
- [ ] Given the major release, when `dg-skills doctor` runs, then it reports no `channel-review` group and no unknown-group error

### Slice 13 — service-paths-and-guard

#### Engineering
- [ ] Add to `DgPaths` in pkg/common/src/node/dg-paths.ts the strings `servicesDir` = `<dataDir>/services`, `servicePackagesPath` = `<dataDir>/services/packages.json` and `serviceStateRoot` = `<stateDir>/services`
- [ ] Export from dg-paths.ts the helpers `serviceCloneDir(paths, package)` = `<paths.servicesDir>/<package>` and `serviceStateDir(paths, label)` = `<paths.serviceStateRoot>/<label>`
- [ ] `DgPaths` holds strings only; add no function member
- [ ] Move `insideRoot(root, dir)` from pkg/channel-review/src/address.ts to pkg/common/src/node/fs.ts and export it
- [ ] Add `removeInside(root: string, dir: string): void` to fs.ts: it throws `Error` with `refused to delete <dir>: it is not inside <root>` when `insideRoot` is false; otherwise it calls `rmSync(dir, { recursive: true, force: true })`
- [ ] In address.ts, `removeCloneDir` calls the two shared functions and keeps its two warning texts; delete the local `insideRoot`
- [ ] Move the `insideRoot` cases of pkg/channel-review/__tests__/core-address.spec.ts to pkg/common/__tests__/node-fs.spec.ts
- [ ] In `launch` of pkg/dg-daemon/src/services/supervisor.ts, add `DG_SERVICE_STATE_DIR=<serviceStateDir(paths, label)>` to the injected keys, for each service of `service add` and of `service install`
- [ ] Put `DG_SERVICE_STATE_DIR` after the `envFile` and `passEnv` values in the environment of the child, where `DG_SERVICE_LABEL` is
- [ ] Add `serviceStateRoot` to the `paths` pick of `SupervisorDeps`; edit the two builders that exist: the fixture builder in pkg/dg-daemon/__tests__/services/supervisor-kit.ts and the `createSupervisor` literal in pkg/dg-daemon/__tests__/services/supervisor.spec.ts; add no third builder
- [ ] In the supervisor `preflight`, create the state folder with `ensurePrivateDir`; when that fails, `start` returns the kind `invalid` and no process starts
- [ ] `preflight` returns the text `cannot create the state folder <path>: <reason>`; the HTTP 400 comes from the existing `invalid` kind; add no route and change no route
- [ ] The five keys of service API v1 do not change; the new key is an addition, which ADR 0043 permits
- [ ] In pkg/dg-daemon/__tests__/services/supervisor-service-api.spec.ts, change the test names that say `the three keys` and `the five keys`, so that they give no count that is now wrong; change no assertion
- [ ] Extend the existing test that the injected keys win for the order Contract; add no new rig
- [ ] Do not edit pkg/dg-daemon/src/server/bootstrap.ts: it gives `createSupervisor` the full paths object
- [ ] Do not edit pkg/dg-daemon/src/commands/service.ts, pkg/dg-daemon/src/main.ts, pkg/common/src/node/index.ts or pkg/dg-daemon/__tests__/utils/daemon-harness.ts
- [ ] This slice lands before slice 12 deletes pkg/channel-review/src/address.ts

#### Testing Criteria
##### Contracts
- [ ] Contract: with `DG_HOME=/d`, `paths.servicesDir` is `/d/data/services`, `paths.servicePackagesPath` is `/d/data/services/packages.json`, `paths.serviceStateRoot` is `/d/state/services`, `serviceCloneDir(paths, "bot")` is `/d/data/services/bot`, and `serviceStateDir(paths, "bot-dev")` is `/d/state/services/bot-dev`
- [ ] Contract: each value of the `DgPaths` object is a string
- [ ] Contract: `removeInside("/a/root", "/a/root")`, `removeInside("/a/root", "/a/root/../other")` and `removeInside("/a/root", "/a/rootless/x")` throw and delete nothing
- [ ] Contract: `removeInside(root, <a directory inside root>)` deletes that directory and keeps its siblings
- [ ] Contract (environment): each service gets `DG_SERVICE_STATE_DIR` equal to `<state>/services/<label>`; the folder exists with mode 0700 when the child starts (POSIX; skip the mode assertion on win32); the mode of the parent folder is not a contract
- [ ] Contract (order): the `DG_SERVICE_STATE_DIR` of the daemon wins over a line with the same name in `envFile` and over `passEnv`
- [ ] Contract: `service stop` and `service rm` do not delete the state folder
- [ ] Contract: when the state folder cannot be created, `POST /services/<label>/start` gives HTTP 400 with `cannot create the state folder <path>: <reason>`, and no process starts
- [ ] Contract: with `DG_PATH_FENCE` set, `servicesDir` and the state folder of a label resolve below the fence; a `DG_HOME` outside the fence throws the fence error
- [ ] Edge: a service of `service add` also gets `DG_SERVICE_STATE_DIR`
- [ ] Regression: `bun test` passes in pkg/common, pkg/channel-review and pkg/dg-daemon; `bun run lint` passes in the three packages

#### Acceptance Criteria
- [ ] Given a service directory outside `<data>/services`, when a removal runs, then `removeInside` refuses and deletes nothing
- [ ] Given a running service, when it reads `DG_SERVICE_STATE_DIR`, then the value is its own state folder and the folder exists

## Slice Summaries

## Agent Notes

- (plan, dg:foreman) Decision log, passes 1 to 3 with E1 to E7 and the slice split: `~/.local/state/ai/spec/50d2b267/service_install-decisions.md`
- (plan, dg:foreman) Synthesis of step 6, with the 203 edits, the cross-slice conflicts and each dropped recommendation: `~/.local/state/ai/spec/50d2b267/service_install-synthesis.md`
- (plan, dg:foreman) Slice 13 is the paths half of the first slice 2; its review is in `roundtable/slice-2.md`, findings 2, 11, 12 and 15
- (plan, dg:foreman) ⚑ RATIFY (slice 10, open): when `<bin>/dg` is a link whose target is a dg launcher, does install replace the link or keep it with the warning? — replace / keep — recommendation: replace, because the rule already reads the target for a link to a file that is not a dg launcher. No checkbox holds this case until the owner decides.

## Issues Remediation

## PR Plan

Three PRs, in this order:

- PR 1 (minor), slices 1 to 8 and 13, one worktree: `feat(dg-daemon): install services from a git repository`. It holds the two fixes (test home fence, layout). The bot repository needs only this release. Slice 13 is the paths half of the first slice 2; it builds after slice 1 and before slice 2.
- PR 2 (minor), slices 9 to 11, a new worktree after PR 1 merges: `feat(dg): add the dg entry command`.
- OPERATOR GATE: stop here. The owner confirms three items: `dg-daemon service status --json` shows each bot label as `running` on a PR 1 release; the bot imported import.json; each env posted one review after the import.
- PR 3 (major), slice 12: `feat(skills-cli)!: remove channel-review`, with a `BREAKING CHANGE:` footer. It starts from the master commit that holds the release tag of PR 1 and the merge of PR 2.
- Present the three PR drafts for one approval before the first one opens (batch PR rule).

## Code Structure

### Service config file

- **Decision:** installed service entries live in the daemon's own `<state>/daemon/config.json` (`paths.daemonConfigPath`), the only file the daemon reads; services do not move to `<config>/config.json`.
- **Home:** `pkg/common/src/node/dg-paths.ts`, `pkg/dg-daemon/src/server/config-store.ts`
- **Rationale:** no daemon read-path change and no migration; reading two files is how the stale-copy bug happened.
- **Alternatives:** move services to `<config>/config.json`, which needs a read-path change and a migration.
- **Applies to:** slices 2, 4, 5, 6

### Package registry and service dirs

- **Decision:** `<data>/services/packages.json` keyed by package: url, sha, ref, labels[], defaultsHash. `DgPaths` stays a type of strings; it gets `servicesDir`, `servicePackagesPath` and `serviceStateRoot` (`<state>/services`). dg-paths.ts exports the helpers `serviceCloneDir(paths, package)` = `<data>/services/<package>/` and `serviceStateDir(paths, label)` = `<state>/services/<label>/`. State is per label; dg injects it as `DG_SERVICE_STATE_DIR`.
- **Home:** `pkg/common/src/node/dg-paths.ts`, `pkg/dg-daemon/src/services/packages.ts`
- **Rationale:** pin data stays out of service entries (`parseServiceEntry` rejects unknown keys); one repo can declare several labels that must not share state; services never import dg code.
- **Alternatives:** a `package` field on entries; per-package state; function members on `DgPaths`.
- **Applies to:** slices 2, 5, 6, 7, 8, 13

### Repository defaults block

- **Decision:** the `"dg"` key in the repository package.json: `services {<label>: {argv, envFile, grant, stopTimeoutMs}}`, `requires`, `build`, with the key names `parseServiceEntry` validates. `parseServiceDefaults` in `pkg/dg-daemon/src/services/defaults.ts` fills `cwd` and calls `parseServiceEntry`. Install and every update to a new commit ask for consent at a terminal and refuse without one.
- **Home:** `pkg/dg-daemon/src/services/defaults.ts`
- **Rationale:** no extra file for repo authors; one validator for both entry paths.
- **Alternatives:** a separate `dg-service.json`.
- **Applies to:** slices 2, 5, 8

### Shared autostart module

- **Decision:** move `pkg/dg-agent/src/phone/autostart.ts` to `pkg/common/src/node/autostart.ts` and add a `name` to `AutostartSpec` (`dg-daemon`, `dg-phone`); the phone unit stays byte-identical.
- **Home:** `pkg/common/src/node/autostart.ts`
- **Rationale:** one copy of the systemd, launchd and Windows task writers; no dg-daemon import of dg-agent.
- **Alternatives:** duplicate in dg-daemon; import from dg-agent.
- **Applies to:** slices 3, 10

### removeInside guard

- **Decision:** move channel-review's `insideRoot` and rm guard to `pkg/common/src/node/fs.ts` as `removeInside(root, dir)` before channel-review is deleted.
- **Home:** `pkg/common/src/node/fs.ts`
- **Rationale:** one safety check for clone removal.
- **Alternatives:** reimplement it in the daemon.
- **Applies to:** slices 2, 12, 13

### dg program

- **Decision:** `dg` is a full program: a `ProgramName` member, package `pkg/dg`, a launcher `PROGRAMS` entry and a fourth shim. It routes `service|job|autostart|daemon` to dg-daemon, `agent` to dg-agent, and `skills|install|upgrade|doctor|extension` to dg-skills. It calls `mountProgram(<name>)` before it delegates, so `selfCommand` builds the argv of the mounted program in a bundle and in a checkout. The launcher gives `dg` the loaders of the three programs; pkg/dg imports no program. Login units keep calling `dg-daemon`.
- **Home:** `pkg/common/src/node/program.ts`, `pkg/common/src/node/self-command.ts`, `pkg/dg/`, `pkg/launcher/src/dg.ts`, `pkg/launcher/src/programs/dg.ts`
- **Rationale:** the human chose a full program; dg is the front door for everything (ADR 0020).
- **Alternatives:** a router that is not a ProgramName.
- **Applies to:** slices 9, 10, 11

### Test home fence

- **Decision:** `resolveDgPaths` throws when `DG_PATH_FENCE` is set and a resolved root leaves the fence; every package bunfig preloads the fence.
- **Home:** `pkg/common/src/node/dg-paths.ts`, `bunfig.toml`, `pkg/*/bunfig.toml`
- **Rationale:** only an inherited variable reaches spawned daemons; today only the root and pkg/skills-cli preload the fence.
- **Alternatives:** a preload-only mock.
- **Applies to:** slice 1 and the tests of every later slice

### channel-review export

- **Decision:** `<serviceStateDir>/import.json` = `{version: 1, cursor, handled[], current, automation: {blocked, issues, sinks, prWatch, deps.lastRun}}`; export refuses while that env's old daemon runs; daemon.db is read only.
- **Home:** `pkg/skills-cli/src/channel-review/export.ts`
- **Rationale:** the bot owns its state and must not replay requests or resend notices; this is a cross-repo contract with the review bot repository.
- **Alternatives:** keep the tables in daemon.db behind a service API route.
- **Applies to:** slices 7, 12

### Service CLI support module

- **Decision:** the helpers that `service add|rm`, the package commands and the label verbs share live in one module, which slice 2 makes; slices 5 and 6 import it and do not edit it.
- **Home:** `pkg/dg-daemon/src/commands/service-support.ts`
- **Rationale:** `service.ts` imports `service-package.ts`, so it cannot be the home; one copy of the daemon guards of `service rm`.
- **Alternatives:** keep them private in `service.ts`; put them in `config-store.ts`.
- **Applies to:** slices 2, 5, 6

### Log tail module

- **Decision:** the tail and follow code moves from `pkg/channel-review/src/daemon/logs.ts` to `pkg/common/src/node/log-tail.ts`; slice 12 deletes the channel-review file, and `log-tail.ts` stays.
- **Home:** `pkg/common/src/node/log-tail.ts`
- **Rationale:** `service logs` is the second caller.
- **Alternatives:** a copy in pkg/dg-daemon.
- **Applies to:** slices 6, 12

### Layout block exit code

- **Decision:** `EXIT_LAYOUT_BLOCKED = 78` for a `two-used` block of the `daemon` entry; each other block keeps exit code 1. The `dg-daemon` systemd unit holds `RestartPreventExitStatus=3 78`, so the service manager does not start `serve` again for a failure that needs the owner.
- **Home:** `pkg/common/src/errors.ts`, `pkg/common/src/node/autostart.ts`
- **Rationale:** with `Restart=on-failure` and `RestartSec=5`, exit code 1 gives a restart each 5 seconds with no end.
- **Alternatives:** systemd start limits with exit code 1; exit code 0; accept the loop.
- **Applies to:** slices 3, 4, 8
