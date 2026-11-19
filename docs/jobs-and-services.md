# Jobs

To start the daemon when you log in, see [Start at login](#start-at-login).

A job is a command that the daemon runs for you. A job has one of three modes:

- `continuous`: the daemon keeps it running, such as a bot or a watcher.
- `schedule`: the daemon runs it at the times of a `cron` expression.
- `every`: the daemon runs it at a fixed interval, such as `15m`.

`dg job` runs `dg-daemon job`, and the longer form still works. Each `dg job`
verb prints the dg home and the daemon on stderr, so you can see which home and
which daemon it uses.

## Add a job

Add a continuous job, then turn it on:

```sh
dg job add --name bot --cwd ~/bots/bot --continuous \
  --env-file ~/.config/bot.env --env BOT_TENANT --stop-timeout 30s -- bun run bot.ts
dg job enable bot
```

```text
added job "bot"
next: dg job enable bot
```

Add a job that polls something on a schedule, such as a Jira board, and
collects what comes back:

```sh
dg job add --name jira-sprint --every 15m --cwd ~/work --feed \
  --notify reviewer -- jira issue list --plain --jsonlines
dg job add --name weekday-standup --schedule "0 9 * * 1-5" --cwd ~/work \
  -- bun run ./check-standup.ts
```

Give one mode flag: `--continuous`, `--schedule "<cron>"` or `--every
<duration>` (`30s`, `15m`, `2h`). `add` writes a job that is not enabled. Run
`dg job enable <name>` to turn it on. `add` resolves the executable to an
absolute path and refuses a name that is not valid: a name has lower case
letters, digits and `-`, and 64 characters at most.

`feed` is explicit for a new job and is valid only for a scheduled job. A job
with `--feed` prints one JSON object for each item: `id` and `title` are
required, and `meta` and `url` are optional. Each line becomes a feed item, and
the daemon dedupes on `id`, so a second run of the same query adds nothing.
`--notify <identity>` queues one agent message when a run brings in a new item,
and it needs `--feed`. A job with no `--feed` writes its output to its log. A
moved scheduled job and an `add` with the alias `--label` or `--cron` get
`feed: true`, so a script from before keeps its result. The alias forms also
write an enabled job.

`add` writes this entry to the config file:

```json
{
  "jobs": {
    "bot": {
      "argv": ["/home/me/.bun/bin/bun", "run", "bot.ts"],
      "cwd": "/home/me/bots/bot",
      "continuous": true,
      "envFile": "/home/me/.config/bot.env",
      "passEnv": ["BOT_TENANT"],
      "stopTimeoutMs": 30000
    }
  }
}
```

The verbs that write take a lock on the config file, so two runs at once do not
lose an entry. You can also edit the file by hand. Only a command declared
there can start, and `argv` runs with no shell.

Phone (`dg-agent phone`) does not deliver through a job: `phone open` keeps its
own always-on listener running through the service manager of the OS. See
[Phone](phone.md).

One daemon runs for each user, whatever `DG_HOME` says. A daemon that starts
for another `DG_HOME` stops the old one first and prints `dg-daemon: stopped
the daemon of <home> (pid N, port P) so only one runs`. The same home keeps
the "already running" answer. A daemon that a login unit manages stays running,
and the line says so, because its manager would restart it.

### Environment

The child gets, in this order: the allowlist (`PATH`, `HOME`, `LANG`, `TZ`),
the `passEnv` names, the `envFile` lines and the injected `DG_*` keys. Each
later source overrides an earlier one, so the injected keys win. The `passEnv`
values come from the environment of the process that started the daemon. A name
that is absent from that environment logs a warning at each launch. A job
inherits no other secret, so a command that needs one reads its own config
under `HOME` or its `envFile`.

The daemon injects `DG_SERVICE_API`, `DG_SERVICE_LABEL`, `DG_DAEMON_URL` and
`DG_SERVICE_STATE_DIR`, and `DG_HOME` when it has one.
With `grant` it also injects `DG_CREDENTIAL_GRANT_PREFIX` and
`DG_CREDENTIAL_GRANT_FILE`, the path of the token file. The environment never
holds the token. The names keep the word `SERVICE`, because
[Service API v1](service-api.md) uses them.

### Keys

- `argv` and `cwd` are as above. `cwd` and `envFile` must be absolute paths.
- `continuous`, `schedule` and `every` are the three mode keys. An entry has
  exactly one.
- `enabled: true` starts the job now and at each daemon start. `dg job enable`
  and `dg job disable` set it.
- `passEnv` is a list of environment variable names, from `--env`.
- `stopTimeoutMs` is the grace period on stop, in milliseconds. The default is
  5000 and the maximum is 240000.
- `grant` is a credential grant prefix.
- `feed`, `notify` and `timeoutMs` are valid only for a scheduled job.

A daemon that ran before the upgrade reports a new key as `unknown key(s)`
until `dg-daemon restart` runs.

### Where dg keeps the files

The paths follow the per-OS layout. `<state>` and `<log>` are the State and
Logs roots of the [layout table](install.md#where-dg-keeps-its-files), which
also gives the macOS and Windows roots. The log and pid paths did not move with
the noun.

| File | Path | Linux default |
| --- | --- | --- |
| Config | `<state>/daemon/config.json` | `~/.local/state/dg/daemon/config.json` |
| Log | `<log>/service-<name>.log` | `~/.local/state/dg/log/service-<name>.log` |
| Pid file | `<state>/daemon/services/<name>.pid` | `~/.local/state/dg/daemon/services/<name>.pid` |

## Job verbs

The first write verb on a home that the new daemon has not moved yet starts the
daemon one time; see below the table.

| Verb | What it changes | Needs a live daemon |
| --- | --- | --- |
| `dg job add` | the definition of a job | no |
| `dg job update <name>` | the definition of a job | no |
| `dg job remove <name>` | the definition of a job | no, but a daemon that runs must answer |
| `dg job enable <name>` | the stored `enabled` state, and acts now | no: it starts the daemon when none runs |
| `dg job disable <name>` | the stored `enabled` state, and acts now | no, and it starts none; a daemon that runs must answer |
| `dg job start <name>` | nothing stored: it acts now only | yes |
| `dg job run <name>` | nothing stored: an alias of `start` | yes |
| `dg job stop <name>` | nothing stored: it acts now only | yes |
| `dg job restart <name>` | nothing stored: it acts now only | yes |
| `dg job list` | nothing | no: it prints `daemon not running` as the state |
| `dg job status` | nothing | no: it prints `daemon not running` as the state |
| `dg job logs <name>` | nothing | no |

`dg daemon restart` restarts the daemon, which ends each session, and
`dg job restart <name>` restarts one job. `dg job update` changes a job that
runs at its next start, so it prints `next: dg job restart <name>`.
`dg job start` of a scheduled job, and the alias `run`, need a live daemon: the
run happens in the daemon and does not change the next scheduled time.

The first write verb on a home that the new daemon has not moved yet starts
the daemon one time, so that the daemon moves the jobs. When a daemon of the
release before still runs, a `dg job` verb that writes waits 10 s at most, then
stops with the `not migrated` text and the pid of that daemon. Run
`dg daemon restart`, then the command again: dg never restarts that daemon
itself.

The first `dg job enable` at a terminal asks one time to install the login
unit. `enable` with no terminal only prints the hint
`hint: dg does not start at login — run dg autostart install`.

## Old and new commands

| Old command | New command |
| --- | --- |
| `dg-daemon service add <label> --cwd <path> -- <command>` | `dg job add --name <name> --cwd <path> --continuous -- <command>` |
| `dg-daemon service rm <label>` | `dg job remove <name>` |
| `dg-daemon service status` | `dg job status` |
| `dg-daemon service status --json` | `dg job status --json` |
| `dg-daemon service start <label>` | `dg job start <name>` |
| `dg-daemon service stop <label>` | `dg job stop <name>` |
| `dg-daemon service add --autostart` | the `enabled` key, set by `dg job enable <name>` |
| `dg-daemon service add --env-file <path>` | `dg job add --env-file <path>` |
| `dg-daemon service add --pass-env <NAME>` | `dg job add --env <NAME>` |
| `dg-daemon service add --stop-timeout <duration>` | `dg job add --stop-timeout <duration>` |
| `dg-daemon service add --grant <prefix>` | the `grant` key; the old option stays on `dg-daemon service add` |
| `dg job add --label <name>` | `dg job add --name <name>` |
| `dg job add --cron "<cron>"` | `dg job add --schedule "<cron>"` |
| `dg job add --pass-env <NAME>` | `dg job add --env <NAME>` |
| `dg job rm <name>` | `dg job remove <name>` |
| `dg job run <name>` and `dg job exec <name>` | `dg job start <name>` |

The old forms still work, and the alias forms of `dg job` print a note on
stderr that names the new form. They end in the next major release. The
`dg-daemon service` group keeps working until then.

## Run rules

### Run, stop and restart

The rules for a continuous job: a continuous job that exits with 0 stops, and
each other exit starts it again with a backoff of 1 s to 60 s. Output streams
to the log file. One instance runs for each name, guarded by the pid file. On
POSIX, a stop signals the whole process group. On Windows, a stop and a run
timeout kill the process tree immediately.

The rules for a scheduled job: a scheduled job gets no second try after a
failure, so its next run is at the next scheduled time; a run that overlaps the
next scheduled time is skipped, and the log gets one line `job <name>: skipped
a run, the run before it is not complete`; and one catch-up run follows
downtime, so a job whose time passed while the daemon was down runs one time at
start, not one time for each missed time.

`dg job logs <name>` prints the log of a job. With `--feed`, stdout goes to the
feed and stderr goes to the log. With no `--feed`, stdout and stderr go to the
log, and the exit code is the result. The limits of a scheduled run: an
explicit `--timeout` is not clamped; with no `--timeout`, a run with `--feed`
has the 30 s limit and the 256 KB output limit, and a run with no `--feed` has
no default limit. A run that passes its limit ends with the error
`timed out after <duration>`.

A scheduled run has no pid file guard, so a run that stays alive after a
SIGKILL of the daemon can overlap the next run.

Without a login unit, nothing starts the daemon at login. See
[Start at login](#start-at-login), or run `dg-daemon start`, or `dg-agent start`
in an agent session. `dg-daemon start` is idempotent: it starts the daemon in
the background, or reports the one that runs. `dg-daemon status` reports the
daemon without starting it.
The daemon exits at its idle timeout only with no active session, no open
connection and no enabled job.

`dg-daemon stop` sends SIGTERM and waits for the daemon. A regular stop waits
for the `stopTimeoutMs` of each job, 240 s at most. `dg-daemon stop --force`
kills the daemon and the process tree of each job that runs immediately. It
does not kill a dispatch command that runs at that time. On Windows, each stop
of the daemon is a forced stop.

`--force` lists the jobs through the daemon. The answer carries the
`instanceId` of the daemon. The command compares it with the pid file and uses
no job pid from an answer of another instance. It also ignores a pid that is
not an integer above 1. On Windows, `--force` ends the daemon process alone and
then each job process tree, so a dispatch command keeps running. If the list
gives no answer within 3 s, `--force` still kills the daemon and reports the
list failure.

If the pid in the pid file still runs but `/healthz` does not answer (a hung or
stopped daemon), `dg-daemon stop` keeps the pid file and exits 1 with
`does not answer`. `dg-daemon stop --force` then kills that pid only if it is the
`dg-daemon serve` process that wrote the pid file: its command line names
`dg-daemon serve` and it started no later than the pid file. This check works
on Linux and macOS; on Windows, and for a process it cannot identify, it kills
nothing. It cannot list the jobs, so it exits 1 and says that a job process can
still run.

`dg-daemon restart` stops the daemon, which ends each session, then starts it
again. The restart starts only the enabled jobs (the `autostart` services of
the release before), and it prints `started on` or `already running on` with
the port. The new daemon has the environment of the caller, with no login unit;
that environment is the source of the `passEnv` values. Run `dg-daemon restart`
after an upgrade so that the running daemon reads the new keys. `restart` takes
`--force` too.

No page lists jobs or the feed. See [Service API v1](service-api.md) for how a
job reads its credentials, the [developer guide](DEVELOPER.md) for the
configuration of the daemon and [the architecture records](adr/toc.md) for
process and storage decisions. The [jobs record](adr/0049-jobs.md) gives the
job model.

### Start at login

`dg autostart install` starts the daemon each time you log in. `dg autostart
status` reports the unit and `dg autostart remove` takes it away. `status --json`
prints one JSON line. The first `dg job enable` at a terminal asks one time to
install the login unit. dg stores the answer, `y` or `n`, so the question does not
come back.

The unit depends on the OS:

| OS | Unit |
| --- | --- |
| Linux | A systemd user unit. The install also turns on linger, so the unit runs with no open session. |
| macOS | A launchd LaunchAgent. |
| Windows | A task in Task Scheduler. |
| WSL | The Linux systemd unit, plus a Windows login task that keeps the distro running. |

On WSL, the install writes the task file under the daemon folder, converts its
path with `wslpath`, and registers the task with `schtasks.exe`. The task runs
`wsl.exe -d <distro> --exec sleep infinity` at login. The task keeps the
distribution running, because a systemd service alone does not, so the unit
stays up. `dg autostart remove` deletes the task too. The `dg-phone`
unit that `dg-agent phone open` installs is a different unit. The two units have
different names.

`dg autostart install` fails on win32 with `DG_HOME` set, because a scheduled
task cannot pass it. Unset `DG_HOME`, then run the command again. On the other
systems the unit records `DG_HOME` and each `XDG_*_HOME` that the installer had
set. The daemon starts with them, and a job still gets `DG_HOME` only.

A login unit has a minimal environment, and these rules follow from it:

- A login unit has a minimal `PATH`. A job that needs more puts `PATH` in
  its `envFile`.
- A job under a login unit gets `envFile` values and grants, not `passEnv`
  values, because a login unit has a minimal environment.
- With a login unit, `dg-daemon start` and `dg-daemon restart` start the daemon
  through the service manager. This daemon has the environment of the login
  unit, not the environment of the shell that ran the command.
- With a login unit, `dg-daemon stop` and `dg-daemon stop --force` leave the
  daemon stopped until the next login or the next `dg-daemon start`.
- systemd stops a unit after 90 s by default, so a logout or a shutdown can end
  a job before its stop limit. This is accepted.
- The systemd unit does not start the daemon again after exit 3 or exit 78.
  launchd and the Windows task start the daemon again after exit 78, because
  they cannot filter an exit code.

## Move to the jobs table

The first start of the new daemon moves each service and each scheduled job to
the `jobs` table, and keeps the copy `config.json.pre-jobs` of the config file
from before, next to it, with mode 0600. A service keeps its keys, and `autostart` becomes
`enabled`. A scheduled job keeps its next run time and its feed items, and gets
`feed: true`.

A scheduled label that is not a valid name, or that another job has, gets a new
name: dg makes it lower case, puts `-` for each other character, removes a `-`
at the start, keeps 64 characters at most, adds `-2` (then `-3`) for a clash,
and uses `job` when nothing is left. The daemon log gets one line
`scheduled job "<old>" is now "<new>"`, and `dg job list` shows `was "<old>"`.
A row that cannot move stays where it is, the log names it with the reason,
and `dg job list` shows it as `invalid`.

The move has one cost: the argv of a scheduled job is now plain text in a
config file with mode 0600, and no longer encrypted text in the database.
Before you upgrade, look for a secret in the argv of your scheduled jobs and
move it to an `envFile`.

To roll back, stop the daemon, then copy `config.json.pre-jobs` back to
`config.json`. A rollback also needs the database from before, because the
release before refuses the database after the row move. Before the database
change, the daemon writes the snapshot `pre-migration-v14-*.db` to the daemon
folder.

For example, the review bot repository runs its `bot` and `bot-dev` processes
as jobs.
