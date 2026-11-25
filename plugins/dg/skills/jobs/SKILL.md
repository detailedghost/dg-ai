---
name: jobs
description: List and control the dg daemon and its jobs (scheduled jobs and long-running services). Read-only by default; starting, stopping, or restarting any of them needs a named target.
  Also adds and removes jobs, starts a job now, and starts, stops or restarts
  the dg daemon, each only on a request from the human that names the target.
---

# Jobs

This skill is a thin front end over the dg daemon. It adds no new
commands; it only calls what `dg job` and `dg daemon` already expose.

Commands use the compiled binary `dg`. Bootstrap once if
needed; the default installer (no `--cli-only`) pulls it with the extension:

```sh
{ dg daemon --help >/dev/null 2>&1 &&
  dg --version >/dev/null 2>&1; } ||
  { "${DG_HOME:-$HOME/.local}/bin/dg" daemon --help >/dev/null 2>&1 &&
  "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } ||
  { { dg --version >/dev/null 2>&1 || "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

Call `dg` in every later step. If `dg` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg` instead. If the block prints "run dg upgrade", run `dg upgrade`, then run the step again.

## Status (default, read-only)

When invoked with no action, report status only. Run this and show
its own JSON; do not reshape it or add fields it does not already print:

```sh
dg job list
dg job status
```

`job list` reads the daemon's store directly and works with no daemon running.
`job status` prints `daemon not running` as the state when none runs. Report
that, and do not start the daemon yourself to work around it: that is a
`start` action, not part of a status check.

## Start, stop, restart (each needs a named target)

None of these three run with no argument. The target is a job name from
`dg job list` (for example `bot`). There is no default target and no
"restart everything."

For each job verb, see [Job verbs](#job-verbs).

| Action | Job target |
| --- | --- |
| Start | `dg job start <name>` |
| Stop | `dg job stop <name>` |
| Restart | `dg job restart <name>` |

With no live daemon, these three fail cleanly with
`no live dg daemon — jobs run inside it, so start it with dg daemon start`
instead of starting one. Report that message, and do not start the daemon
yourself to work around it.

The old forms: the `service` command group, `job run`, `job exec`, `job rm`, `--label`,
`--cron` and `--pass-env` are gone. Use the job verbs.

### Start, stop or restart the dg daemon

Run these only on a request from the human that names the dg daemon:

```sh
dg daemon start
dg daemon stop
dg daemon restart
```

`dg daemon start` is idempotent and starts the daemon in the background, or
reports the one that runs. Before a stop or a restart, tell the human that each
service stops and each session ends, then wait for the go-ahead. A regular
stop waits for the `stopTimeoutMs` of each service. This skill uses `--force`
only when the human says so; it kills the daemon and each service process tree
at once. A `restart` starts only the `autostart` services.

### Restart

A job restart is stop then start. Run `dg job restart <name>` on a request from
the human that names the job.

## Job verbs

`dg job` manages each job, continuous or scheduled, with these verbs:

```sh
dg job list
dg job status [<name>] [--json]
dg job add --name <name> --cwd <absolute-path> --continuous -- <command> [args...]
dg job add --name <name> --cwd <absolute-path> --every <duration> [--feed] -- <command> [args...]
dg job add --name <name> --cwd <absolute-path> --schedule "<cron>" [--feed] -- <command> [args...]
dg job add <url>
dg job add <path>
dg job update <name> --every <duration>
dg job enable <name>
dg job enable <name> --setup <file|->
dg job setup <name>
dg job setup <name> --refresh
dg job disable <name>
dg job start <name>
dg job stop <name>
dg job restart <name>
dg job remove <name>
dg job logs <name> [-n <lines>] [-f]
```

`list`, `status` and `logs` are read-only. Run each other verb only on a
request from the human that names the job. An `add` request also needs the
argv and `--cwd` from the human; never invent them. `add` also takes
`--timeout <duration>`, `--notify <identity>`, `--env-file <path>`,
`--env <NAME>` and `--stop-timeout <duration>`; pass one only when the human
names it. `update` takes one mode flag (`--continuous`, `--schedule` or
`--every`) and `--timeout`, `--feed` and `--notify`.

`add` writes a job that is not enabled. `enable` turns it on and starts the
daemon when none runs. `start`, `stop` and `restart` act now only and need a
live daemon. `remove`, `disable` and `autostart install|remove` need a request
from the human that names the job or the login unit.

`job add <url>` takes a repository (`<git-url>[@ref]`) and `job add <path>` takes a script or a
folder. A repository job asks for consent: `add` and `update` print the request and ask at a
terminal. This skill does not answer the consent question and does not add `--yes` on its own.
It gives the command, and the human runs it. The agent never adds `--yes`, because with `--yes` a
process runs repository code with no question. A local path asks nothing, but run it only on a request that names the path.

`job setup <name>` asks questions at a terminal, so give the command to the human.
`job setup <name> --refresh` fetches each credential of the job again from its declared
source; run it only on a request that names the job, and then give the command
`job restart <name>` that it prints. A prefix that already holds credentials needs one `y` at a terminal, also for an agent,
so this skill does not answer that question either. `job enable <name> --setup <file|->` takes
a file path or `-` and never JSON text; never write a secret on a command line.

The first `job enable` at a terminal asks whether to start dg at login. This
skill does not answer the login unit question of `job enable`: the human
answers it. `enable` with no terminal only prints the hint
`hint: dg does not start at login — run dg autostart install`; report the hint
and do not run `autostart install` on your own.

## Autostart

There is no autostart for the dg daemon itself until the human runs `dg autostart install`: `dg agent start` and
`dg daemon start` start it, and no other `dg` command does.
