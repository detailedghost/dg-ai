# job install — Initial Notes

## Purpose
Make `job` the one noun for each program that dg-daemon runs: a continuous job or a scheduled job, from a command, a local script or folder, or a git repository. `dg job add` registers a job, `dg job enable` collects its credentials one time, stores them, grants them and starts the job, and `dg job setup` changes them later. Add `dg` as the entry command and a login unit for the daemon, fix two defects (tests that write into the real dg home, and a layout migration that leaves a stale daemon folder in use), then remove channel review from dg in a major release. The work ships as four PRs: PR 1 is slices 1 to 7 (the fixes and the `dg` program), PR 2 is slices 8 to 11 (the jobs merge and its migration), PR 3 is slices 12 to 20 (repository jobs, local jobs, the setup wizard, the credential refresh and the export), then an operator gate, then PR 4 is slice 21 (the major removal).

## Scope
### Included
- PR 1 (minor), slices 1 to 7: the test home fence, the job paths and the delete guard, the layout fix, `dg-daemon autostart`, the `dg` program, its launcher, and their documents
- PR 2 (minor), slices 8 to 11: one `jobs` table, the two migrations at daemon start, the `job` verbs, scheduled jobs on the same launcher, and the job model documents
- PR 3 (minor), slices 12 to 20: the credential route, `dg job add` for a git repository and for a local path, `update`, the setup wizard, credentials as environment variables, the service API operation `refresh`, the channel-review export, and their documents
- OPERATOR GATE after PR 3: the owner confirms that each bot job runs from `dg job add` and `dg job enable` before PR 4 starts
- PR 4 (major), slice 21: the removal of channel review, of the `dg-daemon service` group and of the alias forms
- The test home fence in each package, with an error when a DG path leaves it
- The paths `<data>/jobs/<source>`, `<data>/jobs/sources.json` and `<state>/jobs/<name>`; `removeInside` and `insideRoot` in pkg/common/src/node/fs.ts
- The injected key `DG_SERVICE_STATE_DIR`, an addition to service API v1, and `DG_HOME` of the daemon in the environment of each job
- The layout fix for the `daemon` entry, and a block when two daemon folders hold data
- `dg-daemon autostart install|remove|status`, with the autostart module moved to pkg/common; the phone listener keeps its unit
- `dg-daemon start` and `dg-daemon restart` through the service manager when a login unit is installed
- The `dg` program: `ProgramName`, the package pkg/dg, the launcher entry, a fourth launcher, the bootstrap scripts, one doctor check, and shell completion with `dg completion <shell>`
- The groups `dg job` and `dg autostart`; the mounts `dg skills`, `dg agent` and `dg daemon`; the aliases `dg extension`, `dg install`, `dg upgrade` and `dg doctor`
- One `jobs` table in `<state>/daemon/config.json` with one mode key for each entry: `continuous`, `schedule` or `every`; `enabled` replaces `autostart`
- The move of each `services` entry and of each scheduled row to the `jobs` table at daemon start, with the backup `config.json.pre-jobs`
- The verbs `dg job add|enable|disable|start|stop|restart|setup|update|remove|logs|status|list`
- The alias forms `dg-daemon service …`, `--label`, `--cron`, `--pass-env`, `rm`, `run` and `exec` until the major release
- One question at the first `enable` in a terminal: install the dg-daemon login unit
- `dg job add <git-url>[@ref]` with a pinned commit, a request text, a consent step and `--yes`; `dg job add <path>` for a script file or a folder, with no clone and no question
- The `dg` block of a package.json: `jobs`, `credentials`, `requires` and `build`
- The owner-token route `POST /jobs/<name>/credentials`: write-only for the credential prefix of one job
- The setup wizard of `enable` and `setup`: a hidden prompt and AWS Secrets Manager as sources, `--setup <file or ->`, and `setup --refresh`
- The operation `refresh` of service API v1: a job that runs asks the daemon to fetch one of its credentials again from its declared source
- `--credential <name>=<NAME>`: a credential as an environment variable of the job
- `dg-skills channel-review export --env <env> --label <label>`, which writes `<state>/jobs/<label>/import.json`
- The job model record and the job sources record in docs/adr, the amendment of ADR 0020, docs/jobs-and-services.md and the jobs skill
- The removal of channel review from dg (slice 21, its own PR, a major release, behind the operator gate)
### Excluded
- The review bot repository; it has its own spec bundle
- One merged binary and the `dg-v<x>` release tag of ADR 0020
- A `dg review` group and a `dg service` group
- Jobs in `<config>/config.json`; the `jobs` table stays in `<state>/daemon/config.json`
- A git command in the daemon process
- `passEnv`, `cwd`, `grant` and `enabled` as keys of a repository block
- A secret source that is a command of the repository
- Azure Key Vault as a secret source; a later bundle adds it
- A source in a `refresh` request; the daemon fetches only from the source that the owner saw
- The answer of `--yes` to the question for a credential prefix that already holds credentials; that question needs one `y` at a terminal
- A file watcher, a content hash of a local script, and a `--watch` flag
- A wizard for the plain lines of an env file; the env file stays a manual step
- Two repositories that share one credential prefix
- The delete of stored credentials, grants or job state folders by `job remove`
- A `pattern` key or a live check of a credential value
- A move of the folder pkg/dg-daemon/src/services, of the pid files or of the log files
- A `--credential` flag or a login unit key in the `--setup` file
- A change of the usage lines or error prefixes of the mounted programs
- `dg` names in SKILL.md files; the skills keep `dg-skills`, `dg-agent` and `dg-daemon`
- An `--accept` option
- A merge of two daemon folders or of a stale `config.json`
- A change of `dg-agent start`; it starts a detached daemon as before
- A second run of the old `build` after a failed `update`
- `CHANGELOG.md` and the version stamps; .github/workflows/release.yml writes them
