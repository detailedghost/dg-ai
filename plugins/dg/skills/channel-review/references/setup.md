# Channel review setup

The local daemon watches Teams chats through a Teams bot relay and runs the
thrash skill on the owner's computer. The relay must expose a Server-Sent
Events stream of each chat's messages. The relay contract in
`pkg/channel-review/README.md` of the dg repository (under
`CLAUDE_PLUGIN_ROOT` in a plugin install) lists every call the daemon makes.
For a first-time setup, follow [relay setup](relay-setup.md).

## Environments

Each environment (dev or prod) takes its settings from `envs.<name>` in
config.json. Nothing is built in.

| Key | Meaning |
| --- | --- |
| `baseUrl` | Relay API root, such as `https://relay.example.test/api`. Required. |
| `awsProfile` | AWS SSO profile that can read the relay secret. Required. |
| `botName` | Bot display name that people mention, such as `Review Bot (Dev)`. Required. |

A missing key fails with a config error that names it, such as
`envs.prod.baseUrl is required`. Only the env in use needs settings.

`dg-skills channel-review env` prints the default environment, base URL, and AWS
profile. `dg-skills channel-review env dev` saves dev as the default.
`--env dev` or `--env prod` selects an environment for one command.

## Prerequisites

Install these on every machine that runs the daemon:

- The dg plugin and its compiled `dg-skills` binary.
- The AWS CLI with SSO access to the environment's profile and permission to read
  the configured Secrets Manager secret.
- `gh`, signed in for GitHub. Install and sign in to `glab` for GitLab MRs.
- At least one runner CLI, signed in: `claude`, `codex`, `copilot`, or Grok Build (`grok`).
- The thrash skill where that runner finds it. The dg plugin ships `/dg:thrash` and its persona; a skills-only install copies both.
- For `$address`: the address skill available to the selected runner,
  `dg-skills address`, and `gh` or `glab` signed in with push access.

`status` reports probes for all four runners. A missing CLI reports CR-201;
a failed login probe reports CR-202. Claude's print mode writes
`Not logged in · Please run /login` to stdout when it is signed out, and a fast
nonzero exit with that text is CR-202 too. Once those checks pass, missing thrash
reports CR-206 for that runner. Unused runners may fail their probes.

| Runner | Thrash locations relative to the user's home |
| --- | --- |
| claude | `.claude/plugins/cache/<marketplace>/dg/<version>/plugins/dg/skills/thrash/SKILL.md` |
| codex | `.codex/skills/thrash/SKILL.md` or `.agents/skills/thrash/SKILL.md` |
| copilot | `.copilot/skills/thrash/SKILL.md` |
| grok | An enabled, user-invocable, unambiguous `thrash` reported by `grok inspect --json` |

The exact command is in [Grok runner](#grok-runner). Install and authenticate using the
[official Grok Build instructions](https://docs.x.ai/build/overview).
`grok login` (or `grok login --device-auth`) signs in interactively;
headless API-key authentication uses the CLI's supported environment or model
configuration. Do not put credentials in channel-review config.

Grok has no `login status` command. Its probe runs `grok models` and requires a
recognized authenticated banner plus a successful catalog command, then runs
`grok inspect --json`. These utility commands submit no model prompt. The probe
checks the CLI's resolved credential source, not remote token validity or every
model's entitlement. Sign in again if a later job reports CR-202.
`status` inspects user-level skills from the home directory; each review rechecks
from its actual scratch working directory. Disabled, non-user-invocable, or
colliding `/dg:thrash` skills report CR-206. Failed utility commands or malformed
inspection output report CR-203. Use `grok inspect --json` to check compatibility
skills and plugin discovery; the probe does not assume another host's skill roots.
See [Grok's skill guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/08-skills.md).

The default `runner.claude.allowedTools` is narrow on purpose. A PR author
writes the text the runner reads, so a prompt injection must not reach a shell
or your secrets. Each rule has one job. `<scratch>` is `AI_SCRATCH_DIR` or
`/tmp/ai`. An absolute path in a rule needs the leading `//`.

- `Bash(<home>/.dg/bin/dg-skills thrash:*)` lets thrash call its `dg-skills`
  subcommand and nothing else in the `dg-skills` binary.
- `Agent` lets thrash start its reviewer subagents.
- `Read(//<scratch>/thrash/**)` lets thrash read its own working files.
- `Read(~/.claude/plugins/cache/*/dg/*/plugins/dg/skills/thrash/**)` lets thrash read its
  installed plugin skill files.
- `Grep(//<scratch>/thrash/**)` and `Glob(//<scratch>/thrash/**)` let thrash
  search those working files.
- `Edit(//<scratch>/thrash/**)` lets thrash write its findings file before it
  posts the review. Claude Code matches file writes only against `Edit` rules.
  Without this rule the review finishes but posts nothing (CR-301).

Do not add a bare `Read`, a whole-folder `Bash` rule, or a plain `Bash` rule. They let a
PR author's text read `~/.aws`, `~/.ssh`, or `~/.dg` and post them as a comment.

### Address allowlist and clone safety

`$address` runs Claude with `runner.claude.addressAllowedTools`, a separate
list. It must edit code, run tests, commit, and push, so it is wider than the
review list. `<clones>` is `address.cloneRoot`. The default rules:

- `Agent` lets /dg:address start its fix agents.
- `Edit(//<clones>/**)`, `Read(//<clones>/**)`, `Grep(//<clones>/**)`, and
  `Glob(//<clones>/**)` limit file access to the job's clones.
- `Read(~/.claude/plugins/cache/*/dg/*/plugins/dg/skills/address/**)` lets /dg:address read
  its installed plugin skill files.
- `Bash(git:*)`, `Bash(gh:*)`, and `Bash(glab:*)` let it commit, push, and
  reply to review threads.
- `Bash(<home>/.dg/bin/dg-skills address:*)` lets it call its `dg-skills`
  subcommand.
- `Bash(bun:*)`, `Bash(npm:*)`, `Bash(npx:*)`, `Bash(dotnet:*)`,
  `Bash(python:*)`, and `Bash(pytest:*)` let it build and test.

Build and test tools run code from the PR, so a prompt injection or a hostile
PR can run commands as you. For that reason only allowed senders can run
`$address` (see `owner.senderIds`). Turn on `address.allowAnySender` only in
a chat where you trust every member.

Each `$address` job clones the PR head branch fresh into
`<clones>/<host>-<owner>-<repo>-<message id>` with `gh repo clone` or
`glab repo clone`, runs /dg:address there, and deletes that one folder when the
job ends, also on failure. The daemon deletes only a folder inside
`address.cloneRoot`, never the root itself, and never your own checkouts. When
the daemon starts after a crash, it deletes the leftover clone of each
interrupted job. A PR from a fork reports CR-305, because the daemon cannot
push to it.

### Find your sender id

`$address` and `$emoji` need your chat sender ID in `owner.senderIds`. On Teams it is your
Azure AD object ID. Send `$address` with a PR link once. The bot refuses it
with CR-106, and the daemon log shows
`message <id> $address refused: sender <name> (<sender id>) is not in owner.senderIds`.
Copy the sender ID into `owner.senderIds`, then stop and start the daemon.
`dg-skills channel-review status` prints the gate and the number of IDs, never
the IDs.

### Runner safety

Claude with the default allowlist is the safe choice. The experimental codex
runner runs with `--dangerously-bypass-approvals-and-sandbox`, copilot runs
with `--allow-all-tools`, and grok runs with `--always-approve`. They run on
content that PR authors write, so a prompt injection in a PR can run any
command as you. Use them only on PRs you trust.

### Grok runner

`grok` is the xAI Grok Build CLI (`https://x.ai/cli`), not a third-party npm
package. The daemon drives it headless. These choices follow that CLI's
headless flags; a few of them are not spelled out as a stable contract, so
they are config when the CLI allows it.

- The command is `grok --no-auto-update -p <prompt> --output-format <format> --always-approve --cwd <job dir>`. `--no-auto-update` skips the background updater. `--cwd` is the job directory, and the process working directory is that same path.
- The prompt is `/dg:thrash ...`. These flags were checked against Grok Build 1.0.60.
- `runner.grok.outputFormat` is `streaming-json` (the default), `json`, or `plain`. `streaming-json` is one JSON object per line: `text` (answer chunk, field `data`), `thought` (ignored), `error` (field `message`), and `end` (field `stopReason`). The daemon appends the stream to the job log. A fast nonzero exit whose stderr, or whose `error` event, says the CLI is not signed in is CR-202. The review text itself is not parsed; thrash posts the review.
- `runner.grok.tools` is an optional list of Grok tool ids such as `read_file` and `grep`. They are joined with commas into one `--tools` value, which replaces Grok's default tool set. Leave it unset, or set an empty list, to keep that default. A tool id must not contain a comma. This is not Claude's `Bash(git:*)` syntax.
- `runner.grok.model` is optional and becomes `--model`.
- The readiness probe is described under [Prerequisites](#prerequisites). A runtime sign-in failure reports CR-202.
- `$address`, automatic fixes, and dependency upgrades stay on Claude.

Opt-in tests in `pkg/channel-review` spawn the real CLIs. They stay skipped unless the variable is `1` and the binary is on `PATH`. From `pkg/channel-review`:

```sh
DG_TEST_CLAUDE_CLI=1 bun test runners-cli-live
DG_TEST_GROK_CLI=1 bun test runners-cli-live
```

From the repository root, `mise run test:runners:live` runs both.

Each one checks sign-in (`claude auth status`, or `grok models`) and then sends a one-line prompt through the same flags and spawn path the runner uses. It does not post a pull-request review. Claude needs an existing login. Grok needs `grok login` or `XAI_API_KEY`. The fixture tests in `runners-cli-fixture.spec.ts` always run and do not need credentials.

Add the bot for the env (`envs.<name>.botName`) to every review chat. The
`topic` lookup needs the relay's service mailbox in the chat too. If the mailbox
is absent, set the chat's `id` to the `19:...@thread.v2` part of the Teams
**Copy link** URL. Set `relay.appName` to the application name that the relay
registered for this client.

Before starting, a human signs in with `aws sso login --profile <profile>`.
Stop the daemon, then run `dg-skills channel-review status --env dev`.
Require secret and reactions checks to report `ok`, every entry in `chats` to
resolve to an ID, and the selected runner probe to report `ok`. Status exits 1
when any chat check errors. Status prints JSON with named
errors when a check fails. A running daemon omits preflight, so stop it before
checking connectivity again.

## Configuration

Read this reference and [commands](commands.md) before changing
`DG_HOME/channel-review/config.json`. `DG_HOME` defaults to the user's `.dg`
directory. Start from [config.example.json](config.example.json), which sets
every required key with placeholder values.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `provider` | string | `teams-relay` | The only supported provider. |
| `env.default` | string | `dev` | Default environment: dev or prod. |
| `envs.<name>` | object | Required for the env in use | `baseUrl`, `awsProfile`, and `botName` for dev or prod; see Environments. `botName` is the bot the help reply and error remedies name. |
| `chats` | object array | Required | Chats to watch. Each entry needs a `topic` (lookup) or an `id` (explicit chat ID; bypasses lookup). Empty lists and duplicate IDs are errors. |
| `chat` | object | Unset | Old single-chat form with `topic` and `id`; it still works as a one-entry `chats` list. Setting both `chat` and `chats` is an error. |
| `owner.token` | string | Required | Gate for new reviews; also supplies the owner name in errors (`!owner` gives Owner). |
| `owner.email` | string | Required | Owner email that the relay uses when sending chat replies. |
| `owner.senderIds` | string array | `[]` | Chat sender IDs (Teams Azure AD object IDs) that may run `$address` and `$emoji`. Entries are trimmed and must not be empty. Reviews and help do not check it. |
| `runner.default` | string | `claude` | Default runner: claude, codex, copilot, or grok. |
| `runner.fallback` | string or null | `null` | Retry a Claude review once after a usage limit. Off by default. Set `"fallback": "codex"` to turn it on, or choose copilot or grok. The fallback must pass its runner probe. |
| `runner.timeoutMinutes` | number | `30` | Positive review time limit in minutes. |
| `runner.addressTimeoutMinutes` | number | `60` | Positive `$address` time limit in minutes. |
| `runner.claude.allowedTools` | string array | `Bash(<home>/.dg/bin/dg-skills thrash:*)`, `Agent`, and `Read`, `Grep`, `Glob`, `Edit` limited to `//<scratch>/thrash/**` (`Read` also `~/.claude/plugins/cache/*/dg/*/plugins/dg/skills/thrash/**`) | Tools Claude may use. Keep it narrow; see Runner safety. |
| `runner.claude.addressAllowedTools` | string array | `Agent`; `Edit`, `Read`, `Grep`, `Glob` limited to `//<clones>/**`; `Read(~/.claude/plugins/cache/*/dg/*/plugins/dg/skills/address/**)`; `Bash` for `git`, `gh`, `glab`, `<home>/.dg/bin/dg-skills address`, `bun`, `npm`, `npx`, `dotnet`, `python`, `pytest` | Tools Claude may use for `$address`. Separate from the review list; see Address allowlist and clone safety. |
| `runner.grok.model` | string | Unset | Optional `--model` for the Grok CLI. |
| `runner.grok.tools` | string array | Unset | Optional Grok tool ids, comma-joined into `--tools`. Empty leaves the CLI default. See Grok runner. |
| `runner.grok.outputFormat` | string | `streaming-json` | `plain`, `json`, or `streaming-json`. |
| `runner.<name>.path` | string | Unset | Optional executable path for claude, codex, copilot, or grok; otherwise uses PATH. |
| `reactions.*` | strings | See [reaction defaults](commands.md#reactions) | Override `pending`, `inProgress`, `changesRequested`, `approved`, `comment`, or `failure`. |
| `relay.*` | `appName` string; `secret` object | Required: `appName`, `secret.id`, `secret.key`, `secret.region` | Application name registered with the relay, and where the relay secret lives: the AWS Secrets Manager secret `id`, the JSON `key` inside it, and its `region`. Config never holds the secret value. |
| `fun.pool` | entry array | Shipped pool | Optional pool override with at least eight entries; see [pool rules](commands.md#fun). |
| `rereview.phrases` | string array | `ready`, `fixed`, `addressed`, `updated`, `ptal`, `re-review`, `good to go` | Readiness phrases for blocked PRs. |
| `hosts.github` | string array | `[]` | Add GitHub Enterprise hosts to the built-in github.com allowlist. |
| `hosts.gitlab` | string array | `[]` | Add self-hosted GitLab hosts to the built-in gitlab.com allowlist. |
| `address.cloneRoot` | absolute path | `<home>/code/bot` | Folder for the fresh clone of each `$address` job. |
| `address.allowAnySender` | boolean | `false` | Let anyone with the owner gate run `$address`. With `false` and no `owner.senderIds`, nobody can. |

One daemon watches every chat in `chats`. All chats share one review queue:
reviews run one at a time, a PR already in flight is skipped even when another
chat posts it, and each reaction and reply goes to the chat of the message that
started the review. The daemon keeps one event cursor per chat and reconnects
each chat stream on its own. When one chat stream fails, the daemon logs the
chat ID and keeps the other chats running. `--chat-id` replaces the list with
that one chat.

Status prints `chats` (ID and topic of each watched chat while the daemon runs)
and `lastEventIds` (the saved event cursor for each chat ID):

```json
{
  "running": true,
  "chats": [
    { "id": "19:aaa@thread.v2", "topic": "Team Reviews" },
    { "id": "19:bbb@thread.v2", "topic": "Platform Reviews" }
  ],
  "lastEventIds": { "19:aaa@thread.v2": "<event id>", "19:bbb@thread.v2": "<event id>" }
}
```

Host entries contain a host only, including its port when present. The loader
trims entries and converts them to lowercase. URLs must use HTTPS without embedded
credentials. A review link outside the allowlist reports CR-104.

## Error watch and dependency upgrades

Both workflows are off by default. Enable each with its own `enabled` key. The
shipped defaults are safe: fix PRs are drafts, and the daemon owns every push
to a `bot/fix/*` branch.

### Automation keys

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `automation.cloneRoot` | absolute path | `DG_HOME/channel-review/clones` | Folder for the fresh clone of each error-fix or deps job. It must not be under `~/code`, because the worktree tooling relocates folders there. The daemon sweeps it at startup and after each deps job. |
| `automation.notify.target` | string | `owner` | Where notifications go: `owner` sends a direct message to `owner.email`, or a chat ID posts there. |

### Error watch keys

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `errorWatch.enabled` | boolean | `false` | Poll the enabled sinks. |
| `errorWatch.pollMinutes` | number | `5` | Minutes between polls. |
| `errorWatch.lookbackMinutes` | number | `60` | Longest look-back window for a poll. |
| `errorWatch.minLevel` | string | `error` | Lowest level to report: `warning`, `error`, or `fatal`. |
| `errorWatch.providers.datadog.enabled` | boolean | `false` | Poll Datadog error tracking. |
| `errorWatch.providers.datadog.tracks` | string array | `["trace"]` | Datadog error tracking tracks to search. |
| `errorWatch.providers.datadog.services` | object | no filter | `include` and `exclude` lists of service names. |
| `errorWatch.providers.datadog.envs` | object | no filter | `include` and `exclude` lists of environment names. |
| `errorWatch.providers.sentry.enabled` | boolean | `false` | Poll Sentry. |
| `errorWatch.providers.sentry.projects` | object | no filter | `include` and `exclude` lists of project slugs. |
| `errorWatch.providers.sentry.envs` | object | no filter | `include` and `exclude` lists of environment names. |
| `errorWatch.repos.<service>` | object | none | The fix allowlist. A service without an entry gets a notification only (CR-401). Fields: `repo` (`host/owner/repo`, required), `branch` (base branch; default is the repo's default branch), and `autoFix` (boolean; `false` turns fixes off for this service). |
| `errorWatch.autoFix.enabled` | boolean | `true` | Open draft fix PRs. With `false`, the daemon sends direct messages only. |
| `errorWatch.autoFix.maxPerHour` | number | `2` | Fix jobs started per hour. Extra issues wait (CR-402). |
| `errorWatch.autoFix.timeoutMinutes` | number | `45` | Time limit for one fix job. |
| `errorWatch.autoFix.allowedTools` | string array | Edit, Read, Grep, and Glob inside the clone root; read-only `git`; build and test tools | Tools the fix agent may use. Keep it narrow: the error report is untrusted data. |

### Dependency upgrade keys

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `deps.enabled` | boolean | `false` | Run scheduled upgrades. |
| `deps.timeoutMinutes` | number | `90` | Time limit for one upgrade job. |
| `deps.ciTimeoutMinutes` | number | `60` | How long the daemon waits for CI on a draft PR before it reports a timeout. |
| `deps.cooldownDays` | whole number | `7` | The skill only upgrades to versions published at least this many days ago. |
| `deps.branchPrefix` | string | `chore/deps-update-` | Branch prefix of upgrade PRs. A repo with an open PR on this prefix is skipped. |
| `deps.allowedTools` | string array | Clone-root file tools, build and test tools, `git`, `gh`, `Bash(<home>/.dg/bin/dg-skills deps-upgrade:*)`, and `Read(~/.claude/plugins/cache/*/dg/*/plugins/dg/skills/deps-upgrade/**)` | Tools the upgrade agent may use. |
| `deps.schedule.every` | string | `week` | Default cadence: `day` or `week`. |
| `deps.schedule.day` | string | `mon` | Default weekday for `week`: `mon` to `sun`. |
| `deps.schedule.window` | string | `02:00-05:00` | Default local-time window, `HH:MM-HH:MM`. It may cross midnight. |
| `deps.repos` | object array | `[]` | Repos to upgrade. Each entry has `repo` (`host/owner/repo`), and optional `branch` and `schedule` (the same three fields as `deps.schedule`). Duplicate repos are an error. |

Only GitHub repos are supported. Clone roots must not be under `~/code`.

### Credentials

The daemon reads its secrets from the dg credential store when it starts. It
reads them through the `channel-review` grant, a read-only service token for
names under `channel-review/`. Environment variables are fallbacks.

| Store name | Holds | Meta | Env fallback |
| --- | --- | --- | --- |
| `channel-review/relay/<env>` | Relay secret for dev or prod | `provider` | `CHANNEL_REVIEW_RELAY_SECRET_<ENV>`, then AWS Secrets Manager |
| `channel-review/datadog` | Datadog personal access token | `site` (such as `us5.datadoghq.com`), `scopes`, `expiresAt` | `DATADOG_ACCESS_TOKEN`, or `DATADOG_API_KEY` and `DATADOG_APP_KEY`; `DATADOG_SITE` |
| `channel-review/sentry` | Sentry user auth token | `site` (base URL), `org`, `scopes` | `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_BASE_URL` |

A stored entry wins over its environment variables. When dg-daemon is not
running, or the grant is missing, the daemon logs a warning that names the fix
(start dg-daemon, then run `dg-skills credentials grant channel-review`) and
uses the environment. A missing secret never stops the daemon. `status` lists the
missing names under `errorWatch.missingEnv`, and the sink is skipped until you
add the secret and restart.

Store each secret with `connect`. It never prints a value:

```sh
dg-skills channel-review connect datadog
dg-skills channel-review connect sentry --org example-org
dg-skills channel-review connect relay --env dev
```

- `connect datadog` opens Chrome with a dg profile under
  `DG_HOME/browser-profiles/connect`, so a login persists. Sign in when asked;
  it waits up to 10 minutes. It revokes an older `channel-review-daemon` token
  when it can, creates a new one that expires in 1 year with the scopes
  `error_tracking_read`, `apm_read` and `logs_read_data`, copies it, and
  clears the clipboard. Without `--site`, it reads the site from the address
  after login. It then calls error tracking once and prints
  `verified (HTTP 200)` or the status.
- `connect sentry` does the same on the user auth tokens page, with the scopes
  `event:read`, `project:read` and `org:read`. Pass `--site` for a self-hosted
  Sentry and `--org` when the address does not show the organization. It
  verifies with one organization request.
- `connect relay` fetches the relay secret once through AWS (the env's AWS
  profile) and stores it.
- `--paste` skips the automated browser: it opens the token page in your
  default browser and reads the token from a hidden prompt. The browser flows
  fall back to this mode when a page step fails.

After it stores a secret, `connect` creates the `channel-review` grant when it
is missing and says so. Restart the daemon to use a new secret.

To move secrets that are already in `.env`, run
`dg-skills channel-review migrate-env --dry-run` to list them, then run it
without `--dry-run`. It stores `CHANNEL_REVIEW_RELAY_SECRET_DEV` and `_PROD`,
`DATADOG_ACCESS_TOKEN` (with `DATADOG_SITE`), and `SENTRY_AUTH_TOKEN` (with
`SENTRY_ORG` and `SENTRY_BASE_URL`). Then it deletes only those lines. It
keeps the file mode and prints variable names only. It writes no
backup by default; `--keep-backup` writes a plain-text
`.env.bak-<timestamp>` copy (mode 0600) with the original values so you can
undo. If the rewrite fails, it restores the original content. `DATADOG_API_KEY` and `DATADOG_APP_KEY` stay
in `.env`; replace them with `connect datadog`. The default file is the `.env`
next to the mise config in the current folder; `--file` picks another.
Quoted values and inline comments are supported. When a moved variable is
assigned more than once, the last assignment wins and all its assignments are
removed. A final empty secret stays in `.env`. If a store or grant request fails,
or the file changes during migration, its lines stay intact.

Renew a token before its `expiresAt`: run `connect` again, then restart the
daemon. `dg-skills credentials list` flags entries that expired or expire
within 14 days.

Status adds a `credentials` block. It has `relay`, `datadog` and `sentry`,
each with the store `name`, its `source` (`store`, `env`, `aws` or `missing`),
and `expiresAt` for a stored entry. It has `warning` when the store is not
available. It never prints a value.

Status adds two blocks. `errorWatch` has `enabled`, `providers.<name>` (with
`enabled`, `lastPollAt`, `lastError`, and `counts`), and `missingEnv`. `deps`
has `enabled`, `repos` (the count), `lastRun` (per repo: `at` and `result`), and
`watchingPrs` (the count).

## State and recovery

The service saves state in the existing `DG_HOME/daemon/daemon.db`, in
`channel_review_state`, keyed separately by `dev` and `prod`. Dev and prod share
config but keep separate state, pidfiles, daemon logs, and job logs. All paths
in the table below are relative to `DG_HOME/channel-review`.

| File or directory | Contents |
| --- | --- |
| `config.json` | Configuration and saved environment/reaction choices. |
| `state.<env>.json` | Legacy state source; imported automatically once per environment and retained unchanged for recovery. New state is written to daemon.db. |
| `daemon.<env>.pid` | Daemon process record, including the watched chats. |
| `daemon.<env>.log` | Background daemon output. |
| `jobs/<env>/*.log` | Runner output for each job. |
| `work/` | Runner working directory for reviews. `$address` clones live under `address.cloneRoot` instead. |

The database snapshot includes event cursors per chat, handled message statuses,
blocked PR options, current process details, error-watch issues and sink cursors,
fix timestamps, deps runs, and watched PRs. SQL views `channel_review_requests`
and `channel_review_current` support local inspection. `status` reads this state
without creating a database or consuming an import. Malformed state fails
visibly; repair the retained source and retry if import has not succeeded.
After import, database state takes precedence over the retained JSON.

Upgrade `dg-daemon` and `dg-skills` together to builds supporting schema 12,
stopping the old processes before first import. Older daemon binaries refuse
schema 12 on restart. The review service can initialize the shared schema before
the main daemon starts; no GUI or browser extension attachment is required.
This does not change secret handling or the daemon's encrypted data.

The daemon reads the relay secret into memory. The plaintext secret is never written
to disk. It uses `channel-review/relay/<env>` from the credential store first, then
`CHANNEL_REVIEW_RELAY_SECRET_<ENV>` (such as `CHANNEL_REVIEW_RELAY_SECRET_DEV`),
and fetches it from AWS only when neither is set.
The daemon runs on Linux, macOS, WSL, and Windows. In WSL, it lives only while
the VM runs. Start it again after the VM restarts. Recovery marks interrupted
reviews failed and posts CR-205; pending work is not rerun automatically.
Per-chat replay cursors survive restart. Cursor-only writes coalesce for up to
one second and flush on job writes or orderly shutdown. A human must verify
this behavior in WSL.
On Windows, stop kills the process tree and posts CR-205 for an interrupted
review. If it cannot reach the service, the next start retries that report.

A relay deploy or restart can drop every SSE stream and clear the relay's replay
buffer. The daemon reconnects and may see a gap. Commands posted
during the deploy window cannot reach the daemon; post them again afterward.

## Local tasks

The repository's mise config has `remote:*` tasks for local runs:
`remote:install` builds and installs `dg-skills`, `remote:start`,
`remote:stop`, `remote:run`, and `remote:status` wrap those commands,
`remote:logs` prints the log, `remote:follow` follows it, and `remote:up`
starts the daemon and follows the log. Set `CR_ENV=prod` to read the prod log.

`test:*` tasks run one component. `test:extension`, `test:agent`, and
`test:daemon` run that component's unit tests. `test:runners` runs the
channel-review runner tests, and also the live Claude or Grok check when
that binary is already on `PATH`. `test:runners:live` always runs both
opt-in CLI checks. `test:runners:mutate` mutation-tests the runners.
