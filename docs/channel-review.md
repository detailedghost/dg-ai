# Channel review has left dg

The major release removes channel review from dg. The review bot now runs as a
[job](jobs-and-services.md) from the review bot repository. This page tells you
how to move your state before you upgrade.

Do these steps in this order. Do them on the last release before the major
(7.0.x), because `dg channel-review export` exists only there.

1. Add the review bot as a job: `dg job add <bot repository URL>`. The command
   prints `next: dg job enable <name>` for each job that the repository
   declares. Use that name as `<name>` in the steps below.
1. Remove the SessionStart hook that starts `dg channel-review` from your
   settings file, so that a new session cannot start the old daemon again.
1. Stop the old daemon of the env: `dg channel-review stop --env <env>`. No process
   may write the state between the copy and the drop.
1. Copy the state: `dg channel-review export --env <env> --label <name>`. The
   command writes `<state>/jobs/<name>/import.json` with mode 0600.
1. Enable the job: `dg job enable <name>`.
1. Make sure that a review runs.
1. If a `review-<env>` job exists, remove it: `dg job remove review-<env>`.
1. Upgrade to the major.

The major drops the channel review state tables from `daemon.db`. There is
no downgrade after it, except a restore of a `pre-migration` snapshot (see
below) with the older release. The stored credentials under `channel-review/` and the
grant file `<state>/grants/channel-review.token` stay, so the job can read them.

## If you upgraded before step 3

The major cannot export, but it keeps your state. Before it drops the tables,
the daemon writes `channel-review-state.<env>.json` beside `daemon.db`, one
file for each env, with mode 0600. The file has the import format of `export`.

1. If `<state>/jobs/<name>/` does not exist, create it with mode 0700.
1. Copy `<state>/daemon/channel-review-state.<env>.json` to
   `<state>/jobs/<name>/import.json`. Set mode 0600 on the copy.
   `<state>/jobs/<name>/` is the folder that the daemon gives the job as
   `DG_SERVICE_STATE_DIR`.
1. Run `dg job enable <name>`.

`<state>/daemon/` is the daemon folder; see
[where dg keeps its files](install.md#where-dg-keeps-its-files).

The copy holds the old `current.url` and the `sinks.*.lastError` text. Keep its
mode 0600. Do not commit it.

dg also writes a `pre-migration-v<version>-….db` snapshot into `<state>/daemon/`
before each schema step, and never removes it. A database at version 14 gets
`pre-migration-v15-….db`. A database at version 12 gets the files for v13, v14
and v15. To restore the database, use the file of the lowest step.

## Removed in the major

| Removed | Use instead |
| --- | --- |
| `dg channel-review` and its skill | a job from the review bot repository |
| `dg service add <name>` (`dg-daemon service` before 7.0) | `dg job add --name <name> --continuous -- <command>` |
| `dg service rm <name>` | `dg job remove <name>` |
| `dg service start <name>`, `stop`, `status` | `dg job start <name>`, `stop`, `status` |
| `dg service status --json` | `dg job status --json` |
| `dg service add --autostart` | the `enabled` key, set by `dg job enable <name>` |
| `dg service add --env-file <path>` | `dg job add --env-file <path>` |
| `dg service add --stop-timeout <duration>` | `dg job add --stop-timeout <duration>` |
| `dg service add --grant <prefix>` | the `grant` key of the job entry |
| the `/services` route | the `dg job` verbs |
| `--label`, `--cron`, `--pass-env` | `--name`, `--schedule`, `--env` |
| `dg job rm <name>` | `dg job remove <name>` |
| `dg job run <name>`, `dg job exec <name>` | `dg job start <name>` |
