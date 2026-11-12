---
feature: "dg-daemon outside services"
feature_snake_case: dg_daemon_outside_services
date: "2026-11-11"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "service-decl-and-cli"
    depends_on: []
    files: ["pkg/dg-daemon/src/services/config.ts", "pkg/dg-daemon/src/services/env-file.ts", "pkg/dg-daemon/src/server/config-store.ts", "pkg/dg-daemon/src/commands/service.ts", "pkg/dg-daemon/src/commands/jobs.ts", "pkg/common/src/chat-format.ts", "pkg/dg-daemon/__tests__/services/config.spec.ts", "pkg/dg-daemon/__tests__/server/config-store.spec.ts", "pkg/dg-daemon/__tests__/commands/service.spec.ts", "pkg/dg-daemon/__tests__/commands/jobs.spec.ts", "pkg/common/__tests__/chat-format.spec.ts"]
    agents:
      primary: dg:js
      qa: [dg:qa-code]
      confidence: high
      complexity: medium
  - id: 2
    name: "supervisor-env-and-stop"
    depends_on: [1]
    files: ["pkg/dg-daemon/src/services/supervisor.ts", "pkg/dg-daemon/src/dispatch/exec.ts", "pkg/dg-daemon/src/server/bootstrap.ts", "pkg/dg-daemon/__tests__/services/supervisor.spec.ts", "pkg/dg-daemon/__tests__/dispatch/exec.spec.ts", "pkg/dg-daemon/__tests__/server/service-autostart.spec.ts", "pkg/dg-daemon/__tests__/server/service-shutdown.spec.ts"]
    agents:
      primary: dg:js
      qa: [dg:qa-code]
      confidence: high
      complexity: high
  - id: 3
    name: "daemon-start-stop"
    depends_on: []
    files: ["pkg/common/src/node/daemon-start.ts", "pkg/common/src/node/index.ts", "pkg/common/__tests__/node-daemon-start.spec.ts", "pkg/dg-agent/src/start.ts", "pkg/dg-agent/__tests__/start.spec.ts", "pkg/dg-agent/__tests__/start-open.spec.ts", "pkg/dg-agent/__tests__/start-program-command.spec.ts", "pkg/dg-daemon/src/main.ts", "pkg/dg-daemon/src/commands/start.ts", "pkg/dg-daemon/src/commands/stop.ts", "pkg/dg-daemon/__tests__/commands/start.spec.ts", "pkg/dg-daemon/__tests__/commands/stop.spec.ts", "pkg/dg-daemon/__tests__/main.spec.ts"]
    agents:
      primary: dg:js
      qa: [dg:qa-code]
      confidence: high
      complexity: high
  - id: 4
    name: "service-api-v1"
    depends_on: [2]
    files: ["pkg/common/src/chat-format.ts", "pkg/dg-daemon/src/server/service-api.ts", "pkg/dg-daemon/src/server/http.ts", "pkg/dg-daemon/src/server/credentials.ts", "pkg/dg-daemon/src/server/bootstrap.ts", "pkg/dg-daemon/src/services/supervisor.ts", "pkg/dg-daemon/__tests__/server/service-api.spec.ts", "pkg/dg-daemon/__tests__/server/credentials-frame.spec.ts", "pkg/dg-daemon/__tests__/services/supervisor.spec.ts", "pkg/dg-daemon/__tests__/services/outside-service.spec.ts", "pkg/dg-daemon/__tests__/fixtures/outside-service.ts", "pkg/dg-daemon/__tests__/utils/daemon-harness.ts", "docs/service-api.md"]
    agents:
      primary: dg:js
      qa: [dg:security, dg:qa-code]
      confidence: high
      complexity: high
  - id: 5
    name: "docs-and-adr"
    depends_on: [1, 2, 3, 4]
    files: ["docs/adr/0043-outside-services.md", "docs/adr/toc.md", "docs/jobs-and-services.md", "docs/DEVELOPER.md", "SECURITY.md", "README.md", "docs/AGENT-INSTALL.md", "plugins/dg/skills/jobs/SKILL.md"]
    agents:
      primary: dg:lore
      confidence: high
      complexity: low
execution:
  profile: balance
---

# dg-daemon outside services

## Purpose
Let a program that lives outside this repository run as a dg-daemon service with no hand edit of the daemon config and no import of dg code. The owner declares the service with `dg-daemon service add` and controls the daemon with `dg-daemon start`, `dg-daemon stop` and `dg-daemon restart`. The service reads its credentials through one loopback HTTP route with a prefix-scoped grant. The change is additive and ships as a minor release.

## Scope
### Included
- `dg-daemon service add`, `service rm`, `service status --json`, and `job exec` (alias of `job run`)
- The service declaration keys `passEnv`, `stopTimeoutMs` and `grant`
- Supervisor: `passEnv` environment, a stop timeout for each service, the SIGKILL timer fix, the win32 hard kill, and autostart after the pid file
- `dg-daemon start` (idempotent, `--json`) on a shared start helper in `@dg/common/node` that `dg-agent start` also calls
- `dg-daemon stop` and `dg-daemon restart`, each with `--force`: the daemon and each service process tree stop immediately, with no grace period (decisions E1, E2)
- Service API v1 (provisional): the injected `DG_*` keys and `POST /service-api/v1/credentials` (get, list) with the ADR 0006 grant headers
- ADR 0043, `docs/service-api.md`, and corrections to `docs/jobs-and-services.md`, `SECURITY.md`, `docs/DEVELOPER.md`, `docs/AGENT-INSTALL.md`, `README.md` and the jobs skill
### Excluded
- Removal of channel-review, its skill sections, its credential names and its daemon.db tables (PR 2, major release)
- Supersession of ADR 0020 and Deprecated marks on ADR 0008 to 0019 (PR 2)
- Login autostart of dg-daemon
- A socket transport and a client library for services
- A grant mint at service spawn; `dg-skills credentials grant` stays the only mint
- `CHANGELOG.md` and the version stamps; `.github/workflows/release.yml` writes them from the commit subjects
- The edit of `.agents/spec/013_review_pipeline/plan.md` (decision D9); it is a separate commit, not a slice
- Stale `~/.dg` and `<DG_HOME>` text outside `docs/jobs-and-services.md` and outside the supervised-service paragraph of `SECURITY.md` (decision E3)
- A daemon shutdown route and a force signal inside the daemon; the CLI process does the stop
- A restart that starts again a service that has no `autostart` (decision E4)
- A kill of a running job command or dispatch command by `--force` (decision E6)
- Changes to `CHAT_PROTOCOL_VERSION`, `readConfig` and `writeConfig`

### Slice 1 — service-decl-and-cli

#### Engineering
- [ ] Export the `ENV_KEY` pattern from pkg/dg-daemon/src/services/env-file.ts
- [ ] In pkg/dg-daemon/src/services/config.ts, add `passEnv`, `stopTimeoutMs` and `grant` to `SERVICE_KEYS`
- [ ] Parse `passEnv`: an optional array of strings that each match `ENV_KEY`; the default is `[]`; the error text is `"passEnv" must be an array of environment variable names`
- [ ] The `passEnv` parser removes a repeated name and keeps the first position
- [ ] Parse `stopTimeoutMs`: an optional integer from 1 to 240000; the default is 5000; the error text is `"stopTimeoutMs" must be an integer from 1 to 240000`
- [ ] Export `DEFAULT_STOP_TIMEOUT_MS = 5_000` and `MAX_STOP_TIMEOUT_MS = 240_000` from services/config.ts
- [ ] Parse `grant`: an optional string that matches `CREDENTIAL_GRANT_PREFIX_PATTERN` from `@dg/common`; the error text is `"grant" must be a credential grant prefix`
- [ ] Extend `ServiceDecl` with `passEnv: string[]`, `stopTimeoutMs: number` and `grant?: string`
- [ ] Export the single-entry validator of services/config.ts (the private `parseOne` today) as `parseServiceEntry(label, raw): ParsedService`, so that `service add` applies the same rules as the daemon
- [ ] In pkg/dg-daemon/src/server/config-store.ts, add a strict reader: it returns `{}` when the file is absent, and it throws an `Error` that names the file path when the file is not valid JSON or its top level is not an object
- [ ] In config-store.ts, add a writer that sets or deletes one entry of the `services` table: it uses the strict reader, throws `<config path>: "services" must be an object` when `services` is present and is not an object, keeps all other top-level keys and all other entries, and writes with `writeFilePreserving(file, data, 0o600)` from `@dg/common/node`
- [ ] Do not change `readConfig` or `writeConfig`
- [ ] Add an optional flag-name parameter (default `--every`) to `parseEvery` in pkg/common/src/chat-format.ts; the parameter replaces `--every` in its two error texts
- [ ] Add `service add <label> [command...]` to pkg/dg-daemon/src/commands/service.ts with the options `--cwd <path>` (required), `--autostart`, `--env-file <path>`, `--pass-env <NAME>` (repeatable), `--stop-timeout <duration>` and `--grant <prefix>`
- [ ] `service add`: resolve `--cwd` and `--env-file` to absolute paths from the working directory of the caller; require that `--cwd` is an existing directory
- [ ] `service add`: convert `--stop-timeout` to milliseconds with `parseEvery(value, "--stop-timeout")`
- [ ] `service add`: store an absolute `argv[0]`; do not resolve symbolic links
- [ ] `service add`: when `argv[0]` contains a path separator, resolve it from the working directory of the caller; a path that is not an existing file fails with `service add: executable not found: <absolute path>`
- [ ] `service add`: when that file exists and `checkExecutableResolves(<absolute path>)` reports a problem, fail with `service add: file is not executable: <absolute path>`; do not print the helper text for a path
- [ ] `service add`: for a bare name, call `checkExecutableResolves(<name>)`; a problem fails with `service add:`, a space and the helper text (`service add: executable "<name>" does not resolve on PATH`), as `job add` does
- [ ] `service add`: for a bare name that resolves, store `Bun.which(<name>)`
- [ ] `service add`: write only `argv`, `cwd` and the optional keys that the caller gave; write `autostart` only when it is `true`
- [ ] `service add`: validate the new entry with `parseServiceEntry` before the write
- [ ] `service add`: refuse a label that the `services` table already holds
- [ ] `service add`: after the write, print `added service "<label>"` and one `next:` line (see the contracts)
- [ ] In commands/service.ts, add a helper that returns the live `DaemonHandle` or `undefined` (`readPidFile`, then `isDaemonLive`); `callDaemon`, the `next:` line of `service add` and `service rm` use it
- [ ] A pid file of a dead daemon counts as no daemon
- [ ] Add `service rm <label>`: when a live daemon reports the label in the state `running` or `backoff`, refuse; otherwise delete the entry. With no live daemon, make no HTTP call
- [ ] Add `--json` to `service status`
- [ ] Change the no-daemon error of `callDaemon` to `no live dg-daemon — services run inside it, so start it with dg-daemon start`
- [ ] Add the alias `exec` to the `job run` command in pkg/dg-daemon/src/commands/jobs.ts
- [ ] Do not edit pkg/dg-daemon/__tests__/utils/daemon-harness.ts

#### Testing Criteria
##### Contracts
- [ ] Contract: for a valid entry, `parseServices` returns `passEnv: string[]` (default `[]`), `stopTimeoutMs: number` (default 5000), and `grant` only when it is declared
- [ ] Contract: `parseServices` gives each `passEnv` name one time, in the order of the first positions
- [ ] Contract: an invalid `passEnv`, `stopTimeoutMs` or `grant` gives `{ ok: false, label, error }` with the exact error text of the engineering list; the other entries stay valid
- [ ] Contract: the same invalid entry gives the same error text from `parseServices` and from `parseServiceEntry`
- [ ] Contract: the `stopTimeoutMs` values 0, 240001, 1.5 and `"5000"` are invalid; 1 and 240000 are valid
- [ ] Contract: strict reader: an absent file gives `{}`; the contents `{"a":` and `[]` throw an `Error` whose message holds the config path
- [ ] Contract: `services` writer: a set keeps `pinnedOrigin` and the other entries deep-equal; a delete of the last entry leaves `"services": {}`; a `services` value that is not an object throws `<config path>: "services" must be an object`, and the file bytes do not change
- [ ] Contract: `service add` exit 0 prints exactly two stdout lines: `added service "<label>"`, then one of `next: dg-daemon service start <label>` (a daemon is live), `next: dg-daemon start` (no live daemon, with `--autostart`), `next: dg-daemon start, then dg-daemon service start <label>` (no live daemon, no `--autostart`)
- [ ] Contract: each `service add` failure exits 1, writes nothing, and prints one of: `service add: no command given — put it after a bare --`; `a service labelled "<label>" already exists`; `--cwd: no such directory: <path>`; `service add: executable "<name>" does not resolve on PATH`; `service add: executable not found: <absolute path>`; `service add: file is not executable: <absolute path>`; `service add: <validator error>`; the strict-reader error
- [ ] Contract: a `--pass-env` value that is not an environment variable name fails with `service add: "passEnv" must be an array of environment variable names`
- [ ] Contract: `service add --pass-env A --pass-env A` stores `["A","A"]` as given
- [ ] Contract: `--stop-timeout` accepts `<count><s|m|h>`. `30s` stores `stopTimeoutMs: 30000`. `5m` fails with the validator error. `30` fails with `--stop-timeout: expected a count and a unit of s, m or h (for example 15m), got "30"`
- [ ] Contract: `--stop-timeout 0s` fails with `--stop-timeout: interval must be greater than zero, got "0s"`
- [ ] Contract: `service rm` exit 0 prints `removed service "<label>"`. An unknown label exits 1 with `no service labelled "<label>"`. A `running` or `backoff` label on a live daemon exits 1 with `service "<label>" is <state> — stop it first with dg-daemon service stop <label>`, and the file bytes do not change
- [ ] Contract: `service rm` with no config file exits 1 with `no service labelled "<label>"` and creates no file
- [ ] Contract: `service status --json` prints one line `{"services":[<ServiceStatus>...]}`. With a label, the list holds only that entry. With no declared service and no label, it prints `{"services":[]}` and exits 0. An unknown label exits 1 with empty stdout and `no service labelled "<label>"` on stderr
- [ ] Contract: `service status` without `--json` prints the same lines as before this change. With no declared service it still exits 1 with `no services declared`; only `--json` exits 0 with `{"services":[]}`. Keep the two branches apart
- [ ] Contract: with no live daemon, `service status`, `service start` and `service stop` exit 1 with `no live dg-daemon — services run inside it, so start it with dg-daemon start` on stderr and empty stdout
- [ ] Contract: `job exec <label>` gives the same stdout, stderr and exit code as `job run <label>`
- [ ] Happy path: with no daemon, `service add bot --cwd <dir> --autostart --env-file <file> --pass-env A --pass-env B --stop-timeout 30s --grant bot -- bun run bot.ts` writes an entry that `parseServices` accepts, and `argv[0]` is equal to `Bun.which("bun")`
- [ ] Happy path: with no daemon, `service add` then `service rm` leaves a config that is deep-equal to the first config plus `"services": {}`
- [ ] Edge: `service add` with a relative `--cwd` and a relative `--env-file` stores absolute paths
- [ ] Edge: `service add` with `./run.sh` stores the absolute path of that file; a symbolic link stays a link
- [ ] Edge: `service add` with `./run.sh` that has no execute bit exits 1 with `service add: file is not executable: <absolute path>` and writes nothing
- [ ] Edge: `service add` on a config that holds `pinnedOrigin` keeps `pinnedOrigin`
- [ ] Edge: `service add` on a config file that is a symbolic link keeps the link, and the target of the link gets the new content
- [ ] Edge (POSIX): `service add` keeps the mode of an existing config file; a new config file has the mode 0600
- [ ] Edge: `service add` with a pid file of a dead daemon prints the `next:` line for no live daemon
- [ ] Edge: `service rm` removes an entry whose declaration is invalid
- [ ] Edge: `service rm` with a pid file of a dead daemon removes the entry
- [ ] Edge: `--pass-env A --pass-env B` stores `["A","B"]` in that order
- [ ] Error: `service add` on a config file with invalid JSON exits 1, and the file bytes do not change
- [ ] Error: `service add` with an invalid label exits 1 with the label rule text of services/config.ts
- [ ] Error: `service add --pass-env 1BAD` and `service add --grant UPPER` exit 1 and write nothing
- [ ] Method: a spec that needs a live daemon with a `running` service uses harness exports that exist on master: `bootServe`, a write of `services` to the daemon config path, then `POST /services/<label>/start` (the method of services-http.spec.ts)
- [ ] Method: the test service is a `bun -e` script with a long timer; start the service before the CLI call
- [ ] Method: run `service add` as a subprocess with its own `env`; do not change `process.env.PATH` in the test process, because `Bun.which` reads `PATH` at process start
- [ ] Method: no slice 1 spec runs `dg-daemon start`; that command arrives in slice 3
- [ ] Regression: `bun test` passes in pkg/dg-daemon and pkg/common; `bun run lint` passes in pkg/dg-daemon

#### Acceptance Criteria
- [ ] Given no daemon and no config file, when the owner runs `dg-daemon service add bot --cwd <dir> --autostart -- bun run bot.ts`, then the daemon config holds `services.bot` with an absolute `argv[0]` and `autostart: true`, and the command prints `next: dg-daemon start`
- [ ] Given a config file with `pinnedOrigin` and one service, when `service add` adds a second service, then `pinnedOrigin` and the first service do not change
- [ ] Given a config file that is not valid JSON, when `service add` or `service rm` runs, then the command exits 1, names the file, and does not change the file
- [ ] Given a label that is already declared, when `service add` runs with that label, then the command exits 1 and the entry does not change
- [ ] Given a live daemon that reports `bot` as `running`, when `service rm bot` runs, then the command exits 1 and the entry stays
- [ ] Given a stopped `bot` or no daemon, when `service rm bot` runs, then the entry is gone and all other config keys are unchanged
- [ ] Given a live daemon with two declared services, when `service status --json` runs, then stdout is one JSON line with the two entries
- [ ] Given a declaration with `passEnv`, `stopTimeoutMs` and `grant`, when the daemon reads the config, then the service state is not `invalid`
- [ ] Given a scheduled job `x`, when `dg-daemon job exec x` runs, then the result is the same as `dg-daemon job run x`

### Slice 2 — supervisor-env-and-stop

#### Engineering
- [ ] In `launch` of pkg/dg-daemon/src/services/supervisor.ts, build the child environment in this order, where a later source wins: `buildAllowedEnv()`, the `passEnv` names read from the daemon `process.env`, the `envFile` lines
- [ ] Build the child environment as one expression in that order, so that slice 4 adds its keys at the end
- [ ] For each `passEnv` name that the daemon environment does not hold, call `logger.warn` with `service <label>: passEnv name <NAME> is not set in the daemon environment` on each launch, and start the service
- [ ] A `passEnv` name with an empty value counts as set: copy it and do not warn; only an absent name warns
- [ ] The `passEnv` warning holds the name and never a value
- [ ] Use `decl.stopTimeoutMs` as the grace period of that service in `stop` and in the cleanup after the lead process exits
- [ ] Remove `STOP_GRACE_MS` and the `stopGraceMs` dependency from the supervisor; the default comes from the parser of slice 1
- [ ] `killProcessGroup(pid, graceMs, seams?)` in pkg/dg-daemon/src/dispatch/exec.ts returns `Promise<void>` and sends SIGTERM to `-pid` one time
- [ ] After SIGTERM, `killProcessGroup` probes the group with signal 0 each 50 ms on a timer that has `unref`, so the timer does not keep the process alive
- [ ] `killProcessGroup` resolves when the probe finds no group; it sends no SIGKILL in that case
- [ ] `killProcessGroup` sends SIGKILL one time when the group is still alive at `graceMs`, then resolves
- [ ] `killProcessGroup` clears its timer when it resolves
- [ ] `executeCommand` ignores the promise of `killProcessGroup` with `void`
- [ ] Add optional seams (`platform`, `kill`, `exec`) to `killProcessGroup`, in the form that `killProcessTree` in pkg/common/src/node/process.ts uses
- [ ] Define the seam type in exec.ts; its `kill` accepts `NodeJS.Signals | 0`. Do not edit pkg/common/src/node/process.ts
- [ ] On `win32`, `killProcessGroup` calls `killProcessTree(pid)` from `@dg/common/node` immediately and sets no timer
- [ ] Call `killProcessTree` on win32 only; on POSIX it sends SIGKILL immediately
- [ ] In the supervisor, start one termination sequence for each run: keep its promise on the entry (`entry.termination ??= killProcessGroup(pid, decl.stopTimeoutMs)`); `stop` and `runOnce` use that one promise
- [ ] Clear `entry.termination` when each run starts: one entry lives through each restart, and a promise of an earlier run must not answer for the new group
- [ ] Remove the `entry.proc?.kill()` call from `stop`
- [ ] When the lead process exits without a stop, `runOnce` terminates the remaining group one time. This step is for POSIX only: `taskkill /T` needs a live lead process
- [ ] After the lead process exits, `runOnce` sets `entry.lastExit`, then waits for the termination promise when one exists, then clears `entry.pid` and removes the service pid file, then returns (decision E5)
- [ ] On POSIX, keep the behavior of `executeCommand`: a timeout or an output cap still kills a grandchild that holds the pipe open
- [ ] In pkg/dg-daemon/src/server/bootstrap.ts, call `supervisor.autostart()` after `writePidFileAtomic` and after the `dg-daemon listening on` log line; it is the last statement before `return "serving"`
- [ ] In supervisor.spec.ts, remove the `stopGraceMs` dependency of the fixture; each fixture declaration that needs a fast kill sets `stopTimeoutMs: 500` (the shared `botRunning` helper adds it). Edit no other spec
- [ ] Do not change `idleTimeout: 255` in pkg/dg-daemon/src/server/http.ts: `POST /services/<label>/stop` stays open for `stopTimeoutMs`, and 255 s is above the 240 s cap
- [ ] Do not edit pkg/dg-daemon/__tests__/utils/daemon-harness.ts

#### Testing Criteria
##### Contracts
- [ ] Contract: the child environment order is allowlist, then `passEnv`, then `envFile`; a name in `passEnv` and in `envFile` has the `envFile` value
- [ ] Contract: a `passEnv` value comes from the environment of the daemon process, not from the caller of `service start`
- [ ] Contract: a missing `passEnv` name gives one `logger.warn` call with the exact text for each launch, and the service state is `running`
- [ ] Contract: an empty `passEnv` value reaches the child and gives no warning
- [ ] Contract: `killProcessGroup(pid, graceMs, seams?)` sends SIGTERM to `-pid` one time. It sends SIGKILL to `-pid` at most one time, and only when the group is still alive at `graceMs`
- [ ] Contract: the signal-0 probe of `killProcessGroup` is not a signal for the criteria `no SIGKILL` and `sends no signal`; the recording seam counts SIGTERM and SIGKILL
- [ ] Contract: on `win32`, `killProcessGroup` makes one `taskkill /T /F /PID <pid>` call through `killProcessTree`, makes no `kill` call, and sets no timer
- [ ] Contract: on `win32`, a timeout or an output cap of `executeCommand` kills the process tree immediately (decision D5)
- [ ] Contract: `ServiceStatus`, `ServiceAction` and the `/services` HTTP responses do not change shape
- [ ] Contract: while the group of a run is alive after its lead process exited, `status` reports the state `running` and the pid of that group (decision E5)
- [ ] Contract: a crash that leaves a child that ignores SIGTERM delays the restart of that service by `stopTimeoutMs` at most
- [ ] Contract: the daemon log at boot holds `dg-daemon listening on` before `service <label> started`
- [ ] Contract (shutdown): on SIGTERM or SIGINT the daemon waits for `stopAll`; each running service gets its own `stopTimeoutMs` (decision E1)
- [ ] Contract (shutdown): the services stop at the same time, so the daemon waits for the largest `stopTimeoutMs`, not for the sum
- [ ] Contract (shutdown): the daemon sends SIGKILL to a service group only at the end of the `stopTimeoutMs` of that service
- [ ] Happy path: a service with `passEnv: ["DG_TEST_PASS"]` prints the value that the supervisor process holds; a daemon variable that is not in `passEnv` and not in the allowlist is absent in the child
- [ ] Happy path: a child that ignores SIGTERM, with `stopTimeoutMs: 300`, stops with `lastExit` equal to `killed by SIGKILL` after 300 ms or more and before 3000 ms
- [ ] Happy path: a child that exits on SIGTERM, with `stopTimeoutMs: 240000`, makes `stop` resolve in less than 3000 ms
- [ ] Happy path (service-shutdown.spec.ts): a daemon with one autostart service that ignores SIGTERM and has `stopTimeoutMs: 500` exits 500 ms or more after SIGTERM, and the service process is gone at that time
- [ ] Edge: with a recording `kill` seam and a group that is gone 50 ms after SIGTERM, no SIGKILL call occurs at `graceMs`, also when the seam reports a live group again after that time (a reused number)
- [ ] Edge: for one `stop`, the recording seam shows one SIGTERM for the group
- [ ] Edge: after one crash and restart, `stop` sends SIGTERM to the group of the second run and resolves
- [ ] Edge: a lead process that crashes and leaves a child that ignores SIGTERM, with `stopTimeoutMs: 300`: the child is gone before the next `service <label> started` log line
- [ ] Edge: the spec `stop kills the child's whole process group` passes with no change to its assertions
- [ ] Edge: the exec.spec.ts case for a detached grandchild passes with no change to its assertions
- [ ] Error: `stop` of a declared service that is not running returns its `stopped` status
- [ ] Regression (autostart): with a config that declares an autostart service before the daemon boots, the pid file exists, and the daemon log holds the two lines in the contract order
- [ ] Regression (autostart): the autostart service writes into a marker file whether the daemon pid file exists when it starts; the spec expects `true`
- [ ] Method (autostart): the spec writes the config into a `freshDgHome()` directory, then boots with `spawnServe` and `waitForHealth`; `bootServe` makes its own home and cannot hold a config before the boot
- [ ] Method: test win32 only through the `platform` and `exec` seams
- [ ] Regression: `bun test` and `bun run lint` pass in pkg/dg-daemon

#### Acceptance Criteria
- [ ] Given a service with `passEnv: ["AWS_PROFILE"]` and a daemon whose environment holds `AWS_PROFILE=dev`, when the service starts, then the child holds `AWS_PROFILE=dev` and holds no other daemon variable outside the allowlist
- [ ] Given the same name in `passEnv` and in `envFile`, when the service starts, then the child holds the `envFile` value
- [ ] Given a `passEnv` name that the daemon does not hold, when the service starts, then the service runs and the daemon log holds the warning
- [ ] Given a service with `stopTimeoutMs: 30000` that ignores SIGTERM, when the owner stops it, then SIGKILL reaches its process group after 30 seconds, not after 5 seconds
- [ ] Given a service that exits on SIGTERM, when the grace period ends later, then the daemon sends no signal to that pid or group
- [ ] Given Windows, when the owner stops a service, then the daemon kills the process tree immediately
- [ ] Given an autostart service, when the daemon boots, then the pid file is on disk before the service starts
- [ ] Given a daemon with a service that ignores SIGTERM and has `stopTimeoutMs: 30000`, when the daemon gets SIGTERM, then the daemon exits after 30 seconds, not before
- [ ] Given a service whose lead process is dead and whose child is alive, when the owner asks for the status, then the service is `running` with the pid of its group

### Slice 3 — daemon-start-stop

#### Engineering
- [ ] Create pkg/common/src/node/daemon-start.ts with `ensureDaemonRunning(paths: DgPaths, seams?): Promise<{ handle: DaemonHandle; started: boolean }>`
- [ ] Move the spawn and the wait from pkg/dg-agent/src/start.ts (`siblingDaemonArgv`, `spawnDaemonProcess`, `waitForFreshDaemon`) into that module. Keep the spawn options (`detached: true`, `stdio: "ignore"`, `windowsHide` on win32, `env: process.env`, `unref()`), the 100 ms poll, the 15000 ms timeout and the error text
- [ ] `ensureDaemonRunning`: when the pid file names a live daemon, return it with `started: false` and spawn nothing
- [ ] `ensureDaemonRunning`: otherwise call `checkWslNetworking()`, spawn `programCommand("dg-daemon", ["__serve"])`, wait for a live daemon, and return it with `started: true`
- [ ] The seams of `ensureDaemonRunning` are `daemonArgv?: () => string[]`, `spawn?: typeof spawn` and `timeoutMs?: number`
- [ ] Read the seams as `seams.daemonArgv?.() ?? <default>` and `seams.spawn ?? spawn`, so that an `undefined` seam value works
- [ ] In daemon-start.ts, import `programCommand` with the relative path `./program`; do not add `./program` to pkg/common/src/node/index.ts
- [ ] Export the module from pkg/common/src/node/index.ts
- [ ] Run `bun test pkg/launcher/__tests__/size-budget.spec.ts` one time immediately after the module move, and one time at the end
- [ ] In pkg/dg-agent/src/start.ts, call `ensureDaemonRunning` with the `daemonArgv` and `spawn` seams of `StartSeams`. Keep `attachToRunningDaemon` for `started: false` and `requireMatchingProtocol` for `started: true`. Delete the moved functions
- [ ] Remove the imports that the move leaves unused in pkg/dg-agent/src/start.ts
- [ ] Keep the `StartSeams` type and the stdout and stderr of `dg-agent start` unchanged
- [ ] Create pkg/dg-daemon/src/commands/start.ts with the action of the `start` command
- [ ] Register `dg-daemon start [--json]` in pkg/dg-daemon/src/main.ts with a lazy import, as `status` does
- [ ] The `start` command has `.description("start the daemon in the background, or report the live one")`
- [ ] `dg-daemon start` prints the result (see the contracts) and exits 0 when a daemon is live at the end
- [ ] `dg-daemon start` makes no protocol check
- [ ] Create pkg/dg-daemon/src/commands/stop.ts with the actions of the `stop` and `restart` commands (decisions E1, E2)
- [ ] Register `dg-daemon stop [--force]` with `.description("stop the daemon and its services")` in main.ts with a lazy import, as `status` does
- [ ] Register `dg-daemon restart [--force]` with `.description("stop the daemon, then start it again")` in main.ts with a lazy import
- [ ] `stop` and `restart` find the daemon with `readPidFile`, then `isDaemonLive`; they send a signal to a pid only after `isDaemonLive` is true for its handle
- [ ] `stop` and `restart` make no protocol check
- [ ] With no live daemon, `stop` removes a pid file that names no live daemon and prints the text of `status`
- [ ] Regular stop on POSIX: send SIGTERM to the daemon pid one time, then poll `isAlive(pid)` each 100 ms until the process is gone
- [ ] Regular stop: wait 255000 ms at most (the 240000 ms cap of decision D5 plus 15000 ms, the size of the startup timeout); do not send SIGKILL
- [ ] `--force`, step 1: get the pid of each service from `GET /services` of the live daemon, with the owner token
- [ ] `--force`, step 2: kill the daemon with SIGKILL on POSIX and with `killProcessTree(pid)` on win32. Do this before step 3: the supervisor restarts a killed service after 1 s
- [ ] `--force`, step 3: call `killProcessTree(pid)` for each service pid of step 1
- [ ] `--force`, step 4: wait until the daemon pid and each service pid are gone, 5000 ms at most
- [ ] `--force`, step 5: call `removePidFile(paths)`
- [ ] `--force` does not read or delete `<daemonDir>/services/<label>.pid`; the supervisor removes a service pid file with a dead pid at the next start of that label (`staleInstance`)
- [ ] On win32, a regular stop takes the `--force` path: win32 has no signal that the daemon can handle (decision D5 has the same rule for a service)
- [ ] `restart`: do the stop, wait until the daemon process is gone, then call `ensureDaemonRunning(paths)` and print the `started` line of `dg-daemon start`
- [ ] The seams of the stop action are `platform`, `kill` and `exec` in the form that `killProcessTree` uses, and `waitMs`
- [ ] Do not edit pkg/dg-daemon/src/commands/service.ts, pkg/dg-daemon/src/services/supervisor.ts, pkg/dg-daemon/src/server/bootstrap.ts, pkg/dg-daemon/src/server/http.ts or pkg/dg-daemon/__tests__/utils/daemon-harness.ts

#### Testing Criteria
##### Contracts
- [ ] Contract: `ensureDaemonRunning(paths, seams?)` resolves to `{ handle, started }`; `started` is `true` only when the call found no live daemon and spawned one
- [ ] Contract: `started: true` means that this call spawned a daemon process. With two starts at the same time, the handle can be that of the rival daemon. Add no code for this case
- [ ] Contract: a startup timeout rejects with a `DgCliError` that has the text `dg-daemon did not become healthy within the startup timeout` and exit code 1
- [ ] Contract: in bundle mode the spawned argv is `[process.execPath, Bun.main, "dg-daemon", "__serve"]`
- [ ] Contract: `dg-daemon start` prints one stdout line: `dg-daemon started on 127.0.0.1:<port> (pid <pid>, version <version>)` or `dg-daemon already running on 127.0.0.1:<port> (pid <pid>, version <version>)`; `<version>` is `versions.package` of the pid file
- [ ] Contract: `dg-daemon start --json` prints one stdout line `{"started":<boolean>,"pid":<number>,"port":<number>,"version":"<string>"}`
- [ ] Contract: exit codes: 0 for `started` and for `already running`; 1 for the startup timeout; `EXIT_WSL_NAT_NETWORKING` (3) for WSL NAT mode
- [ ] Contract: on a failure (startup timeout, WSL NAT mode), `dg-daemon start` and `dg-daemon start --json` print nothing on stdout; the message goes to stderr through the error handler of `main`
- [ ] Contract: the output, the exit codes and `StartSeams` of `dg-agent start` do not change
- [ ] Contract (stop): `dg-daemon stop` exits 0 and prints one stdout line: `dg-daemon stopped (pid <pid>)`
- [ ] Contract (stop): with `--force`, and for each stop on win32, the line is `dg-daemon stopped (pid <pid>, forced)`
- [ ] Contract (stop): with no live daemon, the command exits 0, sends no signal, and prints `dg-daemon: no live daemon` or `dg-daemon: no live daemon (stale pid file removed)` (the two texts of `cmdStatus`)
- [ ] Contract (stop): a regular stop sends one SIGTERM to the daemon pid and no signal to a service
- [ ] Contract (stop): a regular stop that reaches the wait limit exits 1 with `dg-daemon (pid <pid>) did not stop within 255 s — run dg-daemon stop --force` on stderr; it sends no SIGKILL and removes no pid file
- [ ] Contract (force): the kill of the daemon comes before the first kill of a service
- [ ] Contract (force): when `GET /services` fails, the command still kills the daemon, prints `could not list the services (<reason>); a service process can still run` on stderr, and exits 1
- [ ] Contract (force): `--force` kills each service that the daemon reports with a pid; it does not kill a job command or a dispatch command (decision E6)
- [ ] Contract (restart): `dg-daemon restart` exits 0 and prints two stdout lines: the stop line (or the no-live-daemon line), then `dg-daemon started on 127.0.0.1:<port> (pid <pid>, version <version>)`
- [ ] Contract (restart): the old daemon process is gone before the spawn of the new one
- [ ] Contract (restart): when the stop fails, the command starts nothing and exits 1
- [ ] Contract (restart): after a restart, only a service with `autostart: true` runs (decision E4)
- [ ] Contract (restart): the new daemon has the environment of the caller of `restart`
- [ ] Happy path: on a new DG_HOME, `dg-daemon start --json` gives `started: true`, and `/healthz` answers on the reported port
- [ ] Happy path: a second `dg-daemon start --json` gives `started: false` with the same `pid` and `port`, and one daemon process exists
- [ ] Edge: with a pid file of a dead process, `dg-daemon start` starts a new daemon and reports `started: true`
- [ ] Edge: with a live daemon whose pid file has a different protocol number, `dg-daemon start` reports `already running` and exits 0. The spec builds the fake daemon inline: a `Bun.serve` on loopback that answers `/healthz` with the `instanceId`, and a pid file with `versions.protocol` + 1
- [ ] Happy path (stop): a real daemon, then `dg-daemon stop`: the pid is gone, the pid file is gone, and `/healthz` does not answer
- [ ] Happy path (force): a real daemon with one running service, then `dg-daemon stop --force`: the daemon pid and the service pid are gone in less than 5000 ms
- [ ] Happy path (restart): `dg-daemon restart` on a live daemon gives a `started` line with a different pid, and one daemon process exists
- [ ] Edge (stop): `dg-daemon stop` with a pid file of a dead process prints `dg-daemon: no live daemon (stale pid file removed)` and exits 0
- [ ] Edge (restart): `dg-daemon restart` with no daemon starts one and exits 0
- [ ] Edge (stop, seams): a process that ignores SIGTERM, with `waitMs: 300`: the exit code is 1, the recorded signals are `[SIGTERM]`, and the process is alive
- [ ] Edge (force, seams): the recording seam shows the kill of the daemon before the first kill of a service
- [ ] Edge (stop, seams): with `platform: "win32"`, there is one `taskkill /T /F /PID` call for the daemon and one for each service, and no `kill` call
- [ ] Error (force): against an inline fake daemon whose `/services` answers 500, the daemon is killed, the exit code is 1, and stderr holds the `could not list the services` text
- [ ] Check: stop.ts calls no daemon route other than `/healthz` and `GET /services`; a daemon of an older release has the two
- [ ] Error: with `WSL_DISTRO_NAME` set and `DG_WSL_NETWORKING_MODE=nat`, `dg-daemon start` exits 3, prints the `.wslconfig` remedy, creates no pid file and spawns no daemon
- [ ] Error: with a `daemonArgv` seam that names a program that exits immediately and `timeoutMs: 300`, `ensureDaemonRunning` rejects with the timeout error
- [ ] Method: a spec that spawns a real daemon sets `DG_HOME`, `DG_PORT` (from `allocatePort`) and `DG_KEY_SOURCE=file`, and kills the daemon in `finally` with `killDaemonByPidFile` and `cleanupDgHome`
- [ ] Method: use only harness exports that exist on master; slice 4 owns the harness
- [ ] Regression: start.spec.ts, start-open.spec.ts and start-program-command.spec.ts in pkg/dg-agent pass with no change to their assertions
- [ ] Regression: `bun test` passes in pkg/common, pkg/dg-agent and pkg/dg-daemon; `bun run lint` passes in pkg/dg-daemon and pkg/dg-agent
- [ ] Regression: pkg/launcher/__tests__/size-budget.spec.ts passes; pkg/dg-daemon/src/main.ts has no new static import

#### Acceptance Criteria
- [ ] Given no daemon, when `dg-daemon start` runs, then a daemon is live in the background, and the command exits 0 and prints the port and the pid
- [ ] Given a live daemon, when `dg-daemon start` runs, then no second daemon starts and the command exits 0
- [ ] Given `--json`, when `dg-daemon start` runs, then stdout is one JSON line with `started`, `pid`, `port` and `version`
- [ ] Given no daemon, when `dg-agent start` runs, then its behavior and its output are the same as before this change
- [ ] Given pkg/dg-agent/src, when a search for `spawnDaemonProcess`, `waitForFreshDaemon` or `siblingDaemonArgv` runs, then it finds nothing
- [ ] Given a live daemon, when `dg-daemon stop` runs, then the daemon is gone and the command exits 0
- [ ] Given a daemon with running services, when `dg-daemon stop --force` runs, then the daemon and each service process tree are gone immediately, with no wait for `stopTimeoutMs`
- [ ] Given a live daemon, when `dg-daemon restart` runs, then the old daemon is gone and a new daemon is live
- [ ] Given no daemon, when `dg-daemon stop` runs, then the command exits 0 and reports no live daemon
- [ ] Given a live daemon that an older release started, when `dg-daemon restart` runs, then the command uses only SIGTERM and `/healthz`, which that daemon has

### Slice 4 — service-api-v1

#### Engineering
- [ ] Add `SERVICE_API_CREDENTIALS_PATH = "/service-api/v1/credentials"` to pkg/common/src/chat-format.ts, next to `CHAT_SERVICES_PATH`
- [ ] In pkg/dg-daemon/src/server/credentials.ts, export `scopedRead(input: { operation: string; name?: string }, prefix: string, store: Pick<CredentialStore, "listCredentials" | "getCredential">): Result`; it needs no WebSocket frame
- [ ] Export the `Result` type and `NOT_ALLOWED` from credentials.ts; the handler maps `NOT_ALLOWED` to 403 from that shared constant
- [ ] Keep the WebSocket path on the same function: the call is `scopedRead(frame, access.prefix, deps.credentials)`
- [ ] Move `hasCredentialGrant` from http.ts to server/credentials.ts and export it; `handleCliUpgrade` and the new handler import it from there
- [ ] Create pkg/dg-daemon/src/server/service-api.ts with the handler of `POST /service-api/v1/credentials`; service-api.ts imports nothing from http.ts
- [ ] The handler order is: (1) a method other than POST gives 404; (2) a browser `Origin` (`isBrowserOrigin`) gives the 400 text; (3) `hasCredentialGrant` from credentials.ts, else 401; (4) `Content-Type: application/json`, else 415; (5) the body is a JSON object, else 400; (6) `operation` is a string, else 400; (7) an operation other than `get` and `list` gives 403; (8) a body key other than `operation`, and other than `name` for `get`, gives 400; (9) for `get`: `name` is a string, else 400; the name is below `<prefix>/`, else 403; `validateCredentialName` accepts it, else 400; (10) `scopedRead`
- [ ] Call `scopedRead` only with inputs that passed these checks; it throws on a `name` that is not a string
- [ ] The handler reads the request body only after the grant check passes
- [ ] Set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on each response that the handler makes
- [ ] Route the path in pkg/dg-daemon/src/server/http.ts before the `/services` branch; send each method on the exact path `SERVICE_API_CREDENTIALS_PATH` to the handler
- [ ] Write no token and no credential value to the daemon log
- [ ] service-api.ts makes no `logger` call that holds a header or a body
- [ ] Add `grantsDir` to the `paths` pick of `SupervisorDeps`, and add the getter `daemonUrl: () => string`; `launch` calls it at each launch
- [ ] In pkg/dg-daemon/src/server/bootstrap.ts, give the supervisor a closure over the bound port that returns `http://127.0.0.1:<bound port>` and throws when no port is bound
- [ ] In supervisor.spec.ts, edit the fixture builder that slice 2 changed; do not add a second one
- [ ] In the supervisor `preflight`, when the declaration has `grant`, require the regular file `<grantsDir>/<prefix>.token` (`credentialGrantTokenPath`). Do not read the file and do not verify the token
- [ ] In `preflight`, get the path from `credentialGrantTokenPath(paths, prefix)` inside the existing try/catch and use `statSync(<path>).isFile()`; a path that is not a regular file gives the same `grant token file not found` text
- [ ] In `launch`, add after the `envFile` lines: `DG_SERVICE_API=1`, `DG_SERVICE_LABEL=<label>` and `DG_DAEMON_URL=<url>`
- [ ] In `launch`, when the declaration has `grant`, add `DG_CREDENTIAL_GRANT_PREFIX=<prefix>` and `DG_CREDENTIAL_GRANT_FILE=<absolute token path>`
- [ ] For a service without `grant`, remove `DG_CREDENTIAL_GRANT_PREFIX` and `DG_CREDENTIAL_GRANT_FILE` from the merged environment
- [ ] Put no token value in the child environment
- [ ] Move the credential request helpers `request` and `result` from credentials-frame.spec.ts into pkg/dg-daemon/__tests__/utils/daemon-harness.ts as `credentialRequest` and `credentialResult`, with the `CredentialsResult` type, and use them from credentials-frame.spec.ts and the new specs
- [ ] In daemon-harness.ts, add exports only; change no export that exists
- [ ] Keep the helper for the HTTP call of the route in service-api.spec.ts; it has one caller
- [ ] Create the fixture pkg/dg-daemon/__tests__/fixtures/outside-service.ts with no `@dg/*` import and no relative import. It uses `process.env`, one read of the file that `DG_CREDENTIAL_GRANT_FILE` names, and `fetch`. It prints one JSON line with the listed names and the SHA-256 of the fetched value, then exits 0. It prints no token and no value
- [ ] Write docs/service-api.md with the title `Service API v1 (provisional)`: the five environment keys, the route, the request and response shapes, the status table, one `fetch` example, and the rule that a later transport arrives as a new environment key
- [ ] In docs/service-api.md, give the credential setup order: `dg-agent start` (the credential commands use the `/cli` socket, which needs a dg session), then `dg-skills credentials set <prefix>/<name>`, then `dg-skills credentials grant <prefix>`. State that `dg-daemon start` gives no session
- [ ] In docs/service-api.md, mark in the status table the bodies that are plain text (400 for a browser `Origin`, and 415), so that a client does not call `res.json()` on them
- [ ] In docs/service-api.md, the `fetch` example sets `Content-Type: application/json` and reads the token file with `.trim()`
- [ ] In docs/service-api.md, state that `DG_SERVICE_LABEL` is information and not a proof of identity
- [ ] In docs/service-api.md, state that a grant limits the route to one prefix and is not a sandbox: a process of the same OS user can read each token file
- [ ] In docs/service-api.md, state that a new `dg-skills credentials grant <prefix>` replaces the token: the old token gives 401, so restart the service or read the file again

#### Testing Criteria
##### Contracts
- [ ] Contract (request): `POST /service-api/v1/credentials` with the headers `X-Dg-Grant-Prefix`, `X-Dg-Grant-Token` and `Content-Type: application/json`, and the body `{"operation":"list"}` or `{"operation":"get","name":"<prefix>/<rest>"}`
- [ ] Contract (200 list): `{"ok":true,"value":[{"name","meta","updatedAt"}]}` with only the names below `<prefix>/` and no `value` field in an entry
- [ ] Contract (200 list): `list` with no credential below the prefix gives `{"ok":true,"value":[]}`
- [ ] Contract (200 get): a `get` gives the same `meta` and `updatedAt` as the WebSocket path
- [ ] Contract (200 get): `{"ok":true,"value":{"value","meta","updatedAt"}}`; an absent name below the prefix gives `{"ok":true,"value":null}`
- [ ] Contract (401): an absent grant header, an unknown prefix, an incorrect token, or a request that also has `X-Dg-Session-Id` gives `{"ok":false,"error":"Credential request not allowed for this caller."}`
- [ ] Contract (403): a valid grant with a `get` name outside `<prefix>/`, or with an operation string other than `get` and `list`, gives the same body as 401
- [ ] Contract (400 JSON): a body that is not a JSON object, an `operation` that is not a string, or a `get` with an absent or invalid `name` gives `{"ok":false,"error":"<reason>"}`
- [ ] Contract (400 JSON): each `<reason>` is a fixed string: `request body must be a JSON object`; `"operation" must be a string`; `"name" must be a string`; `request body key "<key>" is not supported`; the text of `validateCredentialName`
- [ ] Contract (400 JSON): no response and no log line holds a part of the request body or of a header value
- [ ] Contract (prefix): the prefix for `scopedRead` is the `X-Dg-Grant-Prefix` header after the grant check passes, never a body value; a `get` or `list` body with `prefix` or `grant` gives 400
- [ ] Contract (order of the `get` checks): a `name` that is not a string gives 400; then a name outside `<prefix>/` gives 403; then a name that `validateCredentialName` refuses gives 400
- [ ] Contract (400 text): a browser `Origin` header gives the plain text `refused: the service API rejects a browser Origin`
- [ ] Contract (415): a different content type gives the plain text `Content-Type must be application/json`
- [ ] Contract (415): `Content-Type: application/json; charset=utf-8` is accepted, and `text/plain` gives 415
- [ ] Contract (500): a store failure gives `{"ok":false,"error":"Credential storage failed; check daemon health and encryption key access."}`
- [ ] Contract (404): GET, PUT, DELETE, HEAD and OPTIONS on the path give 404 with the two headers
- [ ] Contract (404): `/service-api/v1/credentials/` and `/service-api/v1/other` give the 404 of the server
- [ ] Contract (headers): each response that the route handler makes has `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; the 400 of the server-level loopback Host check is outside this contract
- [ ] Contract (environment): each service gets `DG_SERVICE_API=1`, `DG_SERVICE_LABEL=<label>` and `DG_DAEMON_URL=http://127.0.0.1:<port>`. A service with `grant` also gets `DG_CREDENTIAL_GRANT_PREFIX` and `DG_CREDENTIAL_GRANT_FILE`. For a service without `grant`, the daemon sets neither grant key
- [ ] Contract (order): the injected keys win over `envFile` and `passEnv`
- [ ] Contract (preflight): a declared `grant` with no token file makes `start` return the kind `invalid` (HTTP 400 on `/services/<label>/start`) with `grant token file not found: <path> — create it with dg-skills credentials grant <prefix>`, and no process starts
- [ ] Contract: the WebSocket credential frames behave as before; credentials-frame.spec.ts passes with no change to its assertions
- [ ] Happy path (fixture): the daemon runs the fixture as a service with `grant`; the service log holds one JSON line with the name of the stored credential and the SHA-256 of its value
- [ ] Happy path: a grant for the prefix `a` lists and gets `a/x`; `grant-list` then shows a `lastUsedAt` that is not null
- [ ] Edge: with a grant for `a`, a get of `ab/x` gives 403 and a get of `a/missing` gives 200 with `null`
- [ ] Edge: the token of the prefix `a` with the header prefix `b` gives 401
- [ ] Edge: after `revoke`, the same token gives 401
- [ ] Edge: after `revoke`, the next `start` of the service fails the preflight
- [ ] Edge: an `envFile` line `DG_SERVICE_LABEL=other` does not change the label that the child gets
- [ ] Edge: with `passEnv: ["DG_CREDENTIAL_GRANT_FILE"]`, the variable set in the daemon environment and no `grant`, the child has no such variable
- [ ] Edge (supervisor.spec.ts): two launches with two values of the `daemonUrl` getter give two `DG_DAEMON_URL` values
- [ ] Edge: an autostart service with a missing token file does not start, and the daemon log holds `service <label> not autostarted:` with the preflight text
- [ ] Error: the operations `set`, `delete`, `grant`, `revoke` and `grant-list` give 403 and change nothing in the store
- [ ] Error: a request with a `Host` header that is not the loopback authority gives 400
- [ ] Error: a valid grant plus an `X-Dg-Session-Id` header gives 401
- [ ] Error: the prefix header `A/../b` gives 401, not 500
- [ ] Method: the outside-service spec writes the config with `argv: [process.execPath, <fixture path>]` and polls the service log with `waitForValue`
- [ ] Method: a clean exit of the fixture gives the state `stopped` and no restart, so the service log holds one JSON line
- [ ] Security: after the route specs and the fixture run, a byte scan of the daemon log and the service log finds no token and no credential value
- [ ] Security: the child environment holds no variable whose value is equal to the token
- [ ] Regression: `bun test` and `bun run lint` pass in pkg/dg-daemon; `bun test` passes in pkg/common

#### Acceptance Criteria
- [ ] Given a service declared with `grant: "bot"` and a minted grant, when the daemon starts the service, then the child environment holds the five keys and no token value
- [ ] Given the fixture service, which imports no dg code, when the daemon runs it, then it lists and gets a credential below its prefix through `DG_DAEMON_URL`
- [ ] Given a valid grant for `bot`, when a request asks for a name outside `bot/` or for a write operation, then the answer is 403 with the not-allowed text and the store does not change
- [ ] Given no grant headers or an incorrect token, when a request reaches the route, then the answer is 401
- [ ] Given a browser `Origin` header, when a request reaches the route, then the answer is 400
- [ ] Given a declared `grant` with no token file, when the owner starts the service, then the start fails and the error gives the path of the missing file and the mint command
- [ ] Given docs/service-api.md, when a reader follows it with `fetch`, environment variables and one file read, then the reader can get a credential; the document marks v1 as provisional
- [ ] Given docs/service-api.md, when a reader sets up a grant, then the document tells the reader to run `dg-agent start` before `dg-skills credentials grant`

### Slice 5 — docs-and-adr

#### Engineering
- [ ] Run `git fetch origin`. If the working tree or `git ls-tree --name-only origin/master docs/adr/` holds a file `0043-*`, stop and report; do not select a different number
- [ ] Write docs/adr/0043-outside-services.md from docs/adr/template.md with `Status: Accepted`: the service API v1 (environment keys and credential route), `passEnv`, `stopTimeoutMs`, `grant`, `dg-daemon start`, `dg-daemon stop` and `dg-daemon restart` with `--force`
- [ ] In the ADR, record that a regular shutdown waits for the `stopTimeoutMs` of each service, and that `--force` gives no grace period (decision E1)
- [ ] In the ADR Decision, state that the record accepts the design and that Service API v1 is provisional: a change arrives as a new environment key
- [ ] In the ADR Consequences, state that a grant limits the route to one prefix and is not a sandbox
- [ ] In the ADR, record the alternatives that the project did not choose: a socket transport now, a client library, a grant mint at spawn, a token value in the environment, an owner-gated shutdown route, and a force signal that the daemon handles
- [ ] In the ADR, link ADR 0002 and ADR 0006
- [ ] In the ADR, add one Mermaid diagram with these participants: the `dg-daemon` supervisor, the outside service, the `service-api` route, the credential store, and the grant file below `<state>/grants`
- [ ] In the ADR References, list `pkg/dg-daemon/src/services/config.ts`, `pkg/dg-daemon/src/services/supervisor.ts`, `pkg/dg-daemon/src/dispatch/exec.ts`, `pkg/dg-daemon/src/server/service-api.ts`, `pkg/dg-daemon/src/server/credentials.ts`, `pkg/dg-daemon/src/commands/stop.ts`, `pkg/common/src/node/daemon-start.ts`, `pkg/common/src/chat-format.ts` and `docs/service-api.md`
- [ ] In the ADR, name no private organization and no private repository; call the consumer `an outside service`
- [ ] In the ADR, do not supersede ADR 0020 and do not mark ADR 0008 to 0019 as Deprecated
- [ ] Add the 0043 entry to the `## Platform` list of docs/adr/toc.md in the form `- [0043 — <title>](0043-outside-services.md) — Accepted: <one line>`
- [ ] Put the 0043 entry last in `## Platform`; keep each line at 160 characters or less, with the indented second line that `## Skills` uses
- [ ] In docs/jobs-and-services.md, replace the three `~/.dg` paths with the locations from pkg/common/src/node/dg-paths.ts: config `<state>/daemon/config.json`, log `<log>/service-<label>.log`, pid file `<state>/daemon/services/<label>.pid`. Give the Linux defaults `~/.local/state/dg/daemon/config.json` and `~/.local/state/dg/log/service-<label>.log`, and link the layout table with the target `install.md#where-dg-keeps-its-files`; point at that table for the macOS and Windows roots
- [ ] In docs/jobs-and-services.md, document `service add` with each option, `service rm`, `service status --json`, `job exec` and `dg-daemon start`
- [ ] In docs/jobs-and-services.md, document the keys `passEnv`, `stopTimeoutMs` (default 5000, maximum 240000) and `grant`, and the environment order
- [ ] In docs/jobs-and-services.md, state that `passEnv` values come from the environment of the process that started the daemon
- [ ] In docs/jobs-and-services.md, state that a daemon that was running before the upgrade reports the new keys as `unknown key(s)` until `dg-daemon restart` runs (decision E2)
- [ ] Do not tell the reader to compare the version of the `start` line with `dg-daemon --version`: the first is `DG_DAEMON_PACKAGE_VERSION` and the second is `DG_BUILD_VERSION`
- [ ] In docs/jobs-and-services.md, state that `Stop signals the whole process group` is for POSIX, and that on Windows a service stop and a job timeout kill the process tree immediately
- [ ] In docs/jobs-and-services.md, correct the environment sentence: the child gets the allowlist, the `passEnv` names, the `envFile` lines and the injected `DG_*` keys, in that order, and the injected keys win
- [ ] In docs/jobs-and-services.md, state that nothing starts the daemon at login, with a pointer to `dg-daemon start`
- [ ] In docs/jobs-and-services.md, state that the daemon exits at its idle timeout only with no active session, no open connection, no enabled job and no running service
- [ ] In docs/jobs-and-services.md, state that `service add --autostart` does not start the daemon, and that an `--autostart` service starts only when the daemon boots
- [ ] In docs/jobs-and-services.md, document `dg-daemon stop`: a regular stop waits for the `stopTimeoutMs` of each service, 240 s at most
- [ ] In docs/jobs-and-services.md, document `--force`: it kills the daemon and each service process tree immediately; it does not kill a job command or a dispatch command that runs at that time (decision E6)
- [ ] In docs/jobs-and-services.md, state that on Windows each stop of the daemon is a forced stop
- [ ] In docs/jobs-and-services.md, document `dg-daemon restart`: it ends each session and starts only the `autostart` services (decision E4)
- [ ] In docs/jobs-and-services.md, state that the new daemon of a restart has the environment of the caller, which is the source of the `passEnv` values
- [ ] In docs/jobs-and-services.md, show the two output lines of `service add` in the example
- [ ] In docs/jobs-and-services.md, link docs/service-api.md
- [ ] In docs/AGENT-INSTALL.md, in the step of the upgrade list that says `dg-daemon` has no stop command, replace the pid-file instruction with `dg-daemon restart` (decision E7)
- [ ] In docs/AGENT-INSTALL.md, in the step of the rollback list that says `dg-daemon` has no stop command, replace the pid-file instruction with `dg-daemon stop`
- [ ] In docs/AGENT-INSTALL.md, keep the words `Restart the daemon` and the step order; pairing-docs.spec.ts checks them
- [ ] In plugins/dg/skills/jobs/SKILL.md, replace the quoted no-daemon message with the new text of pkg/dg-daemon/src/commands/service.ts; write the message on one line in one code span
- [ ] In SKILL.md, add the usage of `dg-daemon service add` and `dg-daemon service rm`; each needs a request from the human that names the label, and `service add` also needs the argv and `--cwd` from the human
- [ ] In SKILL.md, state that the skill does not stop a running service to make `service rm` pass
- [ ] In SKILL.md, add `dg-daemon job exec` to the sentence that sends `job enable|disable|run` outside this skill
- [ ] In SKILL.md, add `dg-daemon start`, `dg-daemon stop` and `dg-daemon restart` in a new short section after the action table; each needs a request from the human that names `dg-daemon`
- [ ] In SKILL.md, state that the skill uses `--force` only when the human says so, and that it tells the human before a stop or a restart that each service stops and each session ends
- [ ] In SKILL.md, do not add a column to the action table: its rows hold `channel-review` commands
- [ ] In SKILL.md, update the frontmatter `description` for the new actions; keep the intro sentence
- [ ] In SKILL.md, replace the sentence that says the `dg-agent` and `dg-skills` CLIs start the daemon on demand: `dg-agent start` and `dg-daemon start` start it; `dg-skills` does not
- [ ] In SKILL.md, keep each channel-review section, the bootstrap block and the SessionStart hook block byte-identical
- [ ] In SECURITY.md, update the supervised-service paragraph: the child gets the allowlist, the `passEnv` names, the `envFile` lines and the injected `DG_*` keys; the grant token goes to the child as a file path only
- [ ] In that SECURITY.md paragraph, replace `<DG_HOME>/daemon/config.json` with `<state>/daemon/config.json` and link the layout table of docs/install.md (decision E3)
- [ ] In that SECURITY.md paragraph, add one sentence: the loopback route `POST /service-api/v1/credentials` refuses a browser `Origin` and answers each denial with one text
- [ ] Edit no other paragraph of SECURITY.md; the `<DG_HOME>` text of the grant paragraph and of the paragraphs above it stays out of scope
- [ ] In docs/DEVELOPER.md, under `## Credential store`, in `### Using the credential store from another package`, add that a background service can also use the HTTP route, with a link to docs/service-api.md
- [ ] In docs/DEVELOPER.md, update the sentence before the caller table and the row `A background service` to name the frame and the route
- [ ] In README.md, add the line `- [Service API v1 (provisional)](docs/service-api.md)` after the jobs and services bullet, with one empty line before and after

#### Testing Criteria
##### Contracts
- [ ] Contract: docs/adr/toc.md holds one link to `0043-outside-services.md`, and the file exists
- [ ] Contract: the ADR has the headings of docs/adr/template.md (Context, Decision, Consequences, Alternatives considered, Diagrams, References), `Status: Accepted`, and a `Date:` line with the commit date as `YYYY-MM-DD`
- [ ] Contract: the ADR holds exactly one fenced `mermaid` block
- [ ] Contract: a search for `~/.dg` in docs/jobs-and-services.md finds nothing
- [ ] Contract: the supervised-service paragraph of SECURITY.md holds no `<DG_HOME>` text
- [ ] Contract: a search for `has no stop command` in docs/ finds nothing
- [ ] Contract: docs/jobs-and-services.md holds the four corrected statements: the POSIX scope of the process-group stop with the Windows tree kill; the environment order with `passEnv` and the injected keys; the pointer to `dg-daemon start`; the rule that `--autostart` applies only when the daemon boots
- [ ] Contract: each command, option, key, default, limit, path, status code and message in the changed documents is equal to the value in the source of slices 1 to 4
- [ ] Method: for that contract, run `rg -F` for each documented literal against its source file: the option names (commands/service.ts), 5000 and 240000 (services/config.ts), the five `DG_*` keys (services/supervisor.ts), the route path (chat-format.ts), `unknown key(s)` (services/config.ts), the status codes and texts (server/service-api.ts), and the output lines of `start`, `stop` and `restart` (commands/start.ts, commands/stop.ts)
- [ ] Contract: the documents show `service add <label>` with a positional label
- [ ] Contract: `git diff master -- plugins/dg/skills/jobs/SKILL.md` shows no hunk in the bootstrap fence, in its `Call … in every later step` line, or in the SessionStart JSON fence
- [ ] Contract: that diff shows no hunk in a line that holds `channel-review`
- [ ] Contract: no new fence of SKILL.md holds `"hooks": {`, and the file holds no `~/.dg/bin/` text
- [ ] Check: do not run `skill-bootstrap-block.ts --write` on SKILL.md; only `--check` is a gate
- [ ] Check: `rg -F` for the final no-daemon string of pkg/dg-daemon/src/commands/service.ts finds a hit in SKILL.md and in service.ts
- [ ] Check: each relative link in the changed documents opens an existing file
- [ ] Check: no changed document holds the name of a private organization or a private repository
- [ ] Method: for that check, run a case-insensitive `rg` over the changed files for the names in decision D10 and the organization of the owner; read the names from the decision log, and do not write them into this plan or into a file of the repository
- [ ] Check: the `service add` example of docs/jobs-and-services.md runs on a build of this branch and writes the documented config entry
- [ ] Method: for that check, use `DG_HOME=$(mktemp -d)` and a real temporary directory for `--cwd`, run `bun pkg/dg-daemon/src/main.ts service add …`, and compare the written entry with the documented JSON; do not run `dg-daemon start`
- [ ] Check: `bun scripts/skill-bootstrap-block.ts --check` exits 0
- [ ] Check: `bun test` passes in pkg/skills-test
- [ ] Check: `bun test pkg/skills-cli/__tests__/skills-only-install.spec.ts` passes; it reads docs/AGENT-INSTALL.md

#### Acceptance Criteria
- [ ] Given docs/adr/toc.md, when a reader opens the 0043 link, then the record describes the service API v1, `passEnv`, `stopTimeoutMs`, `grant`, `dg-daemon start`, `dg-daemon stop`, `dg-daemon restart` and `--force`, with the status Accepted
- [ ] Given docs/jobs-and-services.md, when a reader looks for the config, log and pid file locations, then each path is correct for the per-OS layout and no `~/.dg` path remains
- [ ] Given docs/jobs-and-services.md, when a reader wants to run an outside program, then the document gives `service add`, `dg-daemon start`, `dg-daemon service start <label>` (not necessary for an `--autostart` service when the daemon boots after the add) and `service status --json`, in that order
- [ ] Given docs/jobs-and-services.md, when a reader upgrades with a daemon that is running, then the document tells the reader to run `dg-daemon restart`
- [ ] Given docs/jobs-and-services.md, when a reader looks for `dg-daemon stop` and `dg-daemon restart`, then the document gives the wait of a regular stop, the result of `--force`, and the rule that a restart starts only the `autostart` services
- [ ] Given docs/AGENT-INSTALL.md, when a reader follows the upgrade steps or the rollback steps, then the steps give `dg-daemon restart` and `dg-daemon stop`, and no step says that `dg-daemon` has no stop command
- [ ] Given the jobs skill, when an agent reads it, then it finds `service add`, `service rm`, `job exec`, `dg-daemon start`, `dg-daemon stop` and `dg-daemon restart`, the correct no-daemon message, and no statement that `dg-skills` starts the daemon
- [ ] Given the jobs skill, when an agent reads it, then each daemon action and each `service add` or `service rm` needs a request from the human, and `--force` needs the word of the human
- [ ] Given the jobs skill, when a reviewer reads the diff, then no channel-review section changed
- [ ] Given SECURITY.md, when a reader looks for what a supervised service receives, then the text names `passEnv`, the injected keys and the grant file path
- [ ] Given SECURITY.md, when a reader looks for the config path of a supervised service, then the paragraph gives `<state>/daemon/config.json`
- [ ] Given the changed documents, when a case-insensitive search for the private names runs, then it finds nothing

## Slice Summaries

## Agent Notes

- Slices 1 and 3 are in layer 0 and share one working tree: `tsc`, the `prelint` build of pkg/pages, and the real daemons that the slice 3 specs boot (they load files that slice 1 edits). A failure in a file of the other slice is a retry, not a finding.
- Run the full-suite Regression items of slices 1 and 3 again when the two slices are green.
- A test with an internal wait gives bun a test timeout above that wait. A wait of 5000 ms is equal to the default test timeout of bun and is a race.

## Issues Remediation

## Code Structure

### Service declaration keys
- **Decision:** `ServiceDecl` gains `passEnv: string[]` and `stopTimeoutMs: number`. The two are not optional in the type: the parser sets the defaults `[]` and 5000 (cap 240000). `ServiceDecl` also gains the optional `grant?: string` (credential prefix). The three keys are optional in the config file. Slice 1 parses and validates them; slices 2 and 4 read them with no fallback value.
- **Home:** `pkg/dg-daemon/src/services/config.ts`
- **Rationale:** one parser for the config file and the `service add` flags, so the CLI and the supervisor cannot drift.
- **Alternatives:** an `env` map — literal values belong in `envFile` with its mode check; a per-slice parser — two sources of truth.
- **Applies to:** slices 1, 2, 4

### Daemon spawn helper
- **Decision:** the spawn-and-wait code moves from `pkg/dg-agent/src/start.ts` to `pkg/common/src/node/daemon-start.ts`; `dg-agent start` and `dg-daemon start` both call it. `dg-daemon restart` also calls it.
- **Home:** `pkg/common/src/node/daemon-start.ts`
- **Rationale:** two callers, so it is a shared helper; dg-daemon must not import dg-agent.
- **Alternatives:** a copy in dg-daemon — duplicate code; dg-daemon imports dg-agent — wrong dependency direction.
- **Applies to:** slices 3, 5

### Daemon stop
- **Decision:** `dg-daemon stop` and `dg-daemon restart` stop the daemon from the CLI process: SIGTERM for a regular stop; a kill of the daemon and of each service tree for `--force`. The daemon code does not change.
- **Home:** `pkg/dg-daemon/src/commands/stop.ts`
- **Rationale:** the command must stop a daemon that is older than this release (the restart after an upgrade); that daemon has the SIGTERM handler, `/healthz` and `/services` only.
- **Alternatives:** an owner-gated `POST /shutdown` route — absent in an older daemon; a force signal that the daemon handles — absent in an older daemon and not available on win32.
- **Applies to:** slices 3, 5

### Service API wire names
- **Decision:** the service route path constant `SERVICE_API_CREDENTIALS_PATH` lives beside the other path constants; the five injected env names (`DG_SERVICE_API`, `DG_SERVICE_LABEL`, `DG_DAEMON_URL`, `DG_CREDENTIAL_GRANT_PREFIX`, `DG_CREDENTIAL_GRANT_FILE`) are string literals in `services/supervisor.ts`, their one production use; the route lives in `server/service-api.ts`; `docs/service-api.md` is the outside contract (v1, provisional). Outside tools use fetch, process.env and one read of the grant file, never an `@dg/*` import.
- **Home:** `pkg/common/src/chat-format.ts`, `pkg/dg-daemon/src/services/supervisor.ts`, `pkg/dg-daemon/src/server/service-api.ts`, `docs/service-api.md`
- **Rationale:** the path constants already live in chat-format.ts; a document, not a client library, is the contract for outside repos.
- **Alternatives:** `cli-wire.ts` — holds no path constants; a published client package — couples outside repos to dg releases; five env-name constants in `chat-format.ts` — one production use, and the code base writes env names as literals.
- **Applies to:** slices 4, 5
