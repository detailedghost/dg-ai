# service install — Initial Notes

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
- ADR 0044, the amendment of ADR 0020, docs/jobs-and-services.md and the jobs skill
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
