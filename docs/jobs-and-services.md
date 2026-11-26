# Jobs

To start the daemon when you log in, see [Start at login](#start-at-login).

To run a repository, a script or a folder as a job, see
[Add a job from a repository](#add-a-job-from-a-repository) and
[Add a local script or folder](#add-a-local-script-or-folder). For credentials, see
[Credentials: enable and setup](#credentials-enable-and-setup),
[Answers with --setup](#answers-with---setup) and
[Refresh a credential](#refresh-a-credential).

A job is a command that the daemon runs for you. A job has one of three modes:

- `continuous`: the daemon keeps it running, such as a bot or a watcher.
- `schedule`: the daemon runs it at the times of a `cron` expression.
- `every`: the daemon runs it at a fixed interval, such as `15m`.

`job` is a flat command: `dg job`, `dg autostart` and `dg service` need no group
name. Each `dg job`
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

Phone (`dg phone`) does not deliver through a job: `phone open` keeps its
own always-on listener running through the service manager of the OS. See
[Phone](phone.md).

One daemon runs for each user, whatever `DG_HOME` says. A daemon that starts
for another `DG_HOME` stops the old one first and prints a line that starts
with `stopped the daemon of <home> (pid N, port P)` and ends with `so only one runs`. The same home keeps
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
until `dg daemon restart` runs.

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

### Jobs from 6.3

A job that a 6.3 install stored can name `lib/current/dg.js` or an old program
name in `argv`. The daemon rewrites that argv to `dg` once, at its start. It
keeps the old file as `<state>/daemon/config.json.pre-compiled`, with mode 0600.
The rewrite is safe to run again. Run `dg daemon restart` after an upgrade, so
a running daemon picks up the new program. See
[Upgrade from 6.3](install.md#upgrade-from-63).

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

## Add a job from a repository

A repository can ship its own jobs. Add the repository, read the request that dg prints, then turn each job on:

```sh
dg job add <git-url>[@ref]
dg job enable <name>
dg job update <job>
dg job remove <job>
```

`add` clones the repository, pins the full commit id of `@ref` (a tag, a branch or a full commit id; the default branch when you
give none), and reads the `dg` block of `package.json` at that commit. The source name is the last part of the URL in lower
case, with `.git` removed. Give another name with `--name <source>`. The source name is also the credential prefix of its
jobs. `add` writes jobs that are not enabled, and prints `next: dg job enable <name>` for each one.

A job plugin pin is a full commit id and nothing else. `add` and `update` record the pin as the full commit id that is checked
out, and the git tree id of that commit. A `plugin.toml` of a job plugin may carry `commit = "<40 or 64 lowercase hex>"`; dg
refuses a `sha256` pin, a tag, a branch name or a short commit id, and refuses a `commit` that is not the checked-out commit.
Each time the daemon starts a git job, it reads `git rev-parse HEAD` and the tree id of the clone. If either one differs from
the record, the job does not start and the error gives a `Next:` step. A record that holds a `sha256` pin from an older dg
needs `dg job remove <job>`, then `dg job add` again.

dg keeps three places for a repository job:

| What | Path |
| --- | --- |
| The registry of each source | `<data>/jobs/sources.json` |
| The clone of a repository | `<data>/jobs/<source>/` |
| The state folder of a job | `<state>/jobs/<name>/` |

`<data>` and `<state>` are the roots of the [layout table](install.md#where-dg-keeps-its-files). `update` and `remove` each
take a job name, not a source name. `update` of a repository job moves each job of that repository to the new commit.
`remove` refuses a job that is `running` or in `backoff`, removes the job, and removes the record and the clone with the last
job of a source. It keeps the state folder and the credentials, and says so.

### The dg block

The repository names its jobs in the `dg` key of `package.json`. This is an example value of that key, with two jobs and the
details of two credentials:

```json
{
  "jobs": {
    "bot": {
      "argv": ["bun", "run", "bot.ts"],
      "continuous": true,
      "envFile": "bot.env",
      "credentials": ["api-key", "tenant"]
    },
    "bot-dev": {
      "argv": ["bun", "run", "bot.ts", "--dev"],
      "continuous": true,
      "credentials": ["api-key"]
    }
  },
  "credentials": {
    "api-key": {
      "prompt": "Bot API key",
      "env": "BOT_API_KEY",
      "source": {
        "type": "aws-secretsmanager",
        "secretId": "placeholder/bot-api-key",
        "region": "us-east-1"
      }
    },
    "tenant": {
      "prompt": "Tenant name",
      "required": false,
      "meta": { "site": { "prompt": "Tenant host", "default": "example.com" } }
    }
  },
  "requires": ["bun"],
  "build": ["bun", "install"]
}
```

The rules of the block:

- Each job takes the keys of a job entry: `argv`, one mode key, `feed`, `notify`, `timeoutMs`, `stopTimeoutMs`, `envFile` and
  `credentials`. dg sets `cwd`, `grant`, `enabled`, `passEnv` and `credentialEnv` itself, and a block that sets one is refused.
- A relative `envFile` resolves below the state folder of the job. An absolute path is refused.
- `credentials` of a job is a list of names. The `credentials` object of the block gives the details of a name:
  `prompt`, `required` (default `true`), `meta`, `source` and `env`.
- `requires` is a list of executable names, with no path separator, that `add` checks on `PATH`.
- `build` is one argv. It runs in the clone after the consent. A failed build of `add` leaves nothing: no record, no
  entry and no clone. A failed build of `update` leaves the source at the old commit, and the clone can hold build output
  of the new commit.

### Consent

`add` and `update` of a repository print the request and ask at a terminal. The request shows each job with its argv and
mode, the credential prefix, each credential with its source, `requires` and `build`. The question of `add` is
`Add these jobs? [y/N]`. `--yes` gives the consent with no terminal. With no terminal and no `--yes`, the command refuses with
`consent needs a terminal`. A local path asks nothing.

`--yes` has a cost: a process that can run `dg job add <url> --yes` can run the code of that repository with no question.
Give `--yes` only for a repository that you have read.

### Update

`update` fetches the recorded origin, resolves the stored ref again (a full commit id stays pinned) and compares the commit.

- With no new commit, `update` prints `source "<source>" is up to date at <commit>`, asks nothing and changes no file of the
  clone.
- With a new commit and an unchanged block, `update` prints the two commits and asks `Update to this commit? [y/N]`.
- With a new commit and a changed block, `update` prints the full request and each change, and asks
  `Apply these changes? [y/N]`.
- With no terminal and no `--yes`, `update` refuses. `--yes` gives the consent.
- `update` to a new commit refuses while a job of the source is `running` or in `backoff`, and names
  `dg job stop <name>`.

After the consent, `update` replaces the repository keys of each job: `argv`, `cwd`, the mode keys, `feed`, `notify`,
`timeoutMs`, `credentials`, `credentialEnv`, `grant`, `envFile` and `stopTimeoutMs`. `enabled` and `passEnv` stay. The output
names each replaced key as `replaced <name>.<key>`, also a key that you edited by hand. For each new job it prints
`next: dg job enable <name>`.

dg owns the clone. On a new commit and after the consent, `update` puts the clone back to the stored commit, prints
`discarded local changes in the clone of "<source>"`, and continues. An `update` with no new commit changes no file of the
clone.

`update` asks no question for a new credential. It prints `next: dg job setup <name>` for each job that lists a new
credential, required or optional. With `--yes`, a changed credential source applies with no person present. With or without `--yes`, a changed credential source makes
`update` remove the job from the "setup done" mark and print `next: dg job setup <name>`; see [Refresh a credential](#refresh-a-credential).

## Add a local script or folder

Add a script, then turn it on:

```sh
dg job add ./script.ts --every 15m
dg job enable script
```

The job name is the file name with no extension, in lower case. Give another name with `--name`. The argument must start
with `./`, `../`, `/` or `~/`, so dg can tell a path from a URL. A local path has no pin and asks no question.

- A file becomes one job. If the file is executable, its `argv` is the file; otherwise a `.ts`, `.js`, `.mjs` or `.cjs` file
  runs with `bun`, and any other file is refused. Words after `--` follow the file in `argv`. The working directory is the
  folder of the file, and `--cwd` is refused. The mode flags and the other flags of `add` work as for a command job.
- A folder with a `dg` block in its `package.json` becomes the jobs of that block, with the rules of
  [the dg block](#the-dg-block) and the folder as its working directory. The flags of `add` are refused, because the block
  declares them. The `build` of the block runs after the request, with no question.
- `add` stores the real path of a symbolic link and says so.
- A file job has a record of kind `path` in `<data>/jobs/sources.json` from `add`, and `dg job remove <name>` removes it.
  `remove` never touches the file or the folder.

A change of the script text applies at the next run of a scheduled job, or at the next start of a continuous job. A change
of the block or of the mode needs `dg job update <name>`. For a folder, `update` reads the block again, asks no question,
does not run `build` and says so. `dg job list` and `dg job status` show `source changed` when the block is not the one that
`add` read, `source missing` for a path that is gone, and `source invalid` for a block that no longer parses.

If a job lists credentials, `dg job enable` runs the steps of [Credentials: enable and setup](#credentials-enable-and-setup).

## Credentials: enable and setup

A job can list credentials in its `dg` block, or with `--credential <name>` on `add` and `update` of a script or a command. AWS
Secrets Manager is the one source type of this release. dg stores a credential under the credential prefix of the job, as
`<prefix>/<name>`, in the dg credential store; for a repository the prefix is the source name, and for a file or a command the
prefix is the job name. dg refuses a prefix that another job or source uses, and the names `pw`, `extension`, `phone-friend`,
`phone-vault` and `db`, with `"<name>" is a reserved name`.

The first `dg job enable <name>` runs these steps in order:

1. Fetch each credential from its declared source, or ask for it with a hidden prompt.
2. Store the values in the dg credential store.
3. Make the grant: dg writes the token file for the prefix.
4. Enable the job and start it.

A source that fails at a terminal offers `Enter <name> by hand? [y/N]`. `dg job setup <name>` changes a credential later: it
shows whether each credential is stored, expired or missing, and asks before it replaces one. It needs a terminal.
`dg job setup <name> --rotate-token` makes a new grant token for the prefix, and prints `next: dg job restart <name>` for each
job of that prefix that runs. `dg job setup <name> --refresh` is in [Refresh a credential](#refresh-a-credential).

A prefix that already holds credentials needs one adoption question first. dg prints `credentials below <prefix>/: <names>`
and asks `This job can read these credentials. Continue? [y/N]`. A prefix that already holds credentials needs one `y` at a
terminal, also for an agent: with no terminal, the command stops with `the prefix <prefix>/ holds credentials` and asks you to
run it in a terminal one time. `setup --rotate-token` and `setup --refresh` follow the same rule. The first store on an empty
prefix needs no question.

`update` asks no question for a new credential. It prints `next: dg job setup <name>` for each job that lists a new credential,
required or optional.

A job reads a credential in one of two ways:

- Through [Service API v1](service-api.md) with its grant. The job reads `DG_CREDENTIAL_GRANT_FILE`, and asks for a name
  below its prefix.
- As an environment variable. Bind it with `--credential <name>=<NAME>` on `add` or `update`, or with the key `env` on a
  credential of a `dg` block. The launcher reads the value at each start and puts it after `envFile` and `passEnv` and before
  the `DG_*` keys. The child and its children see the value in their environment.

Each credential that is bound to an environment variable is required at launch: a missing value stops the start with
`credential <name> is missing — run dg job setup <job>`. A `dg` block with `env` on a credential with `required: false` is
refused. A variable name is 64 characters at most, has letters, digits and `_`, does not start with `DG_`, and is not a name
that changes how a program loads code, such as `PATH` or `LD_PRELOAD`. A name that fails the rule is never printed back to
you, because a pasted secret must not reach `config.json` or your terminal.

## Answers with --setup

`dg job enable <name> --setup <file>` answers the questions of the wizard with no terminal. `--setup` takes a file path or `-`
for standard input, and never JSON text, because a command line is visible to other processes. dg refuses a file that other
users can read and tells you to run `chmod 600` on it. The input is 128 KiB at most.

```json
{
  "version": 1,
  "credentials": {
    "api-key": { "source": { "profile": "bot-dev" } },
    "tenant": { "value": "tenant-placeholder", "meta": { "site": "example.com" } }
  }
}
```

```sh
dg job enable bot --setup answers.json
dg job enable bot --setup -
```

Each credential gets one answer with exactly one of these keys:

- `value`: the text to store.
- `source`: `true`, or an object with `profile`, to fetch from the declared source with that AWS profile.
- `keep`: `true`, to keep the stored value.
- `skip`: `true`, to store nothing. A required credential that is missing cannot be skipped.

`meta` (text values) and `expiresAt` (text) go with `value` and `source`. A name that the job does not list is refused. A
credential with a declared source and no answer is fetched. A required credential with no source and no answer needs a
terminal, or the command stops and names it. `--setup` works only for a job that lists credentials.

## Refresh a credential

A credential stops working when its upstream rotates it. There are two ways to fetch it again from its declared source.

The owner runs these two commands:

```sh
dg job setup <name> --refresh
dg job restart <name>
```

`setup --refresh` fetches each credential that has a source, with your shell and your AWS login, and stores the values. If it
fails, it shows the cause and the hint `aws sso login`. It needs no terminal unless the adoption question is open. A job that
binds a credential to an environment variable reads the new value at its next start, so restart the job.

A job that runs can ask for itself. It sends the operation `refresh` of [Service API v1](service-api.md#refresh-a-credential)
with its grant, and then sends `get` to read the new value.

- The daemon fetches only from the source that the record holds. The request cannot give a secret id, a region, a key, a
  profile or an argv. For a repository job the owner read that source at the consent of `dg job add` or `dg job update`. Two
  cases have no such review: a local folder with a `dg` block asks nothing, and `--yes` gives the consent with no person
  present.
- A refresh needs a source and one earlier `dg job setup <name>` by a person; the answer is 409 when either is missing, or when
  the record key is not the grant of the job.
- The fetch uses the recorded profile and the environment of the named job (`envFile`, `passEnv` and the allowlist), not
  the environment of the caller.
- The daemon allows one fetch for one credential in 60 s. dg starts no refresh on its own. A second request in that time gets
  429 with `retryAfter` in seconds.
- When `dg job update` changes the source of a credential that a job lists, it removes the job from the "setup done" mark, so
  `refresh` answers 409 until `dg job setup <name>` runs again.
- After a 502 the next step is `dg job setup <job> --refresh`, which shows the cause.

Note that the daemon runs no `git` command, starts `aws` only for the operation `refresh` with the fixed argv of the declared
source, and reads `<data>/jobs/sources.json` only for that operation.

Two limits follow. The grant proves the prefix and not the job, so a holder of the grant can name any job of that prefix in a
`refresh` request, and jobs that share a prefix trust each other. And `refresh` is not a sandbox against a running job: the
`envFile` of the job can set `PATH` or `AWS_*` for the `aws` process.

## Old and new commands

| Old command | New command |
| --- | --- |
| `dg service add <label> --cwd <path> -- <command>` | `dg job add --name <name> --cwd <path> --continuous -- <command>` |
| `dg service rm <label>` | `dg job remove <name>` |
| `dg service status` | `dg job status` |
| `dg service status --json` | `dg job status --json` |
| `dg service start <label>` | `dg job start <name>` |
| `dg service stop <label>` | `dg job stop <name>` |
| `dg service add --autostart` | the `enabled` key, set by `dg job enable <name>` |
| `dg service add --env-file <path>` | `dg job add --env-file <path>` |
| `dg service add --pass-env <NAME>` | `dg job add --env <NAME>` |
| `dg service add --stop-timeout <duration>` | `dg job add --stop-timeout <duration>` |
| `dg service add --grant <prefix>` | the `grant` key; the old option stays on `dg service add` |
| `dg job add --label <name>` | `dg job add --name <name>` |
| `dg job add --cron "<cron>"` | `dg job add --schedule "<cron>"` |
| `dg job add --pass-env <NAME>` | `dg job add --env <NAME>` |
| `dg job rm <name>` | `dg job remove <name>` |
| `dg job run <name>` and `dg job exec <name>` | `dg job start <name>` |

The old forms still work, and the alias forms of `dg job` print a note on
stderr that names the new form. They end in the next major release. The
`dg service` group keeps working until then.

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
[Start at login](#start-at-login), or run `dg daemon start`, or `dg agent start`
in an agent session. `dg daemon start` is idempotent: it starts the daemon in
the background, or reports the one that runs. `dg daemon status` reports the
daemon without starting it.
The daemon exits at its idle timeout only with no active session, no open
connection and no enabled job.

`dg daemon stop` sends SIGTERM and waits for the daemon. A regular stop waits
for the `stopTimeoutMs` of each job, 240 s at most. `dg daemon stop --force`
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
stopped daemon), `dg daemon stop` keeps the pid file and exits 1 with
`does not answer`. `dg daemon stop --force` then kills that pid only if it is the
`dg daemon serve` process that wrote the pid file: its command line names
`dg daemon serve` and it started no later than the pid file. This check works
on Linux and macOS; on Windows, and for a process it cannot identify, it kills
nothing. It cannot list the jobs, so it exits 1 and says that a job process can
still run.

`dg daemon restart` stops the daemon, which ends each session, then starts it
again. The restart starts only the enabled jobs (the `autostart` services of
the release before), and it prints `started on` or `already running on` with
the port. The new daemon has the environment of the caller, with no login unit;
that environment is the source of the `passEnv` values. Run `dg daemon restart`
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
unit that `dg phone open` installs is a different unit. The two units have
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
- With a login unit, `dg daemon start` and `dg daemon restart` start the daemon
  through the service manager. This daemon has the environment of the login
  unit, not the environment of the shell that ran the command.
- With a login unit, `dg daemon stop` and `dg daemon stop --force` leave the
  daemon stopped until the next login or the next `dg daemon start`.
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

Before the database change, the daemon writes the snapshot
`pre-migration-v14-*.db` to the daemon folder. After a good row move, the daemon
removes that snapshot and its `-wal`, `-shm` and `-journal` files, because the
snapshot holds the old encrypted argv. The log gets one line that says so.

There is no database rollback: the release before refuses the database after
the row move, and the daemon removes the snapshot from before. You can still
copy `config.json.pre-jobs` back to restore the config file from before, but the
release before does not start on the moved database.

For example, the review bot repository runs its `bot` and `bot-dev` processes
as jobs.
