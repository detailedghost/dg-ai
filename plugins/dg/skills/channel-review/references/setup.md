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
- At least one runner CLI, signed in: `claude`, `codex`, or `copilot`.
- The thrash skill where that runner finds it. dg does not ship thrash.
- For `$address`: the address skill at `~/.claude/skills/address` with its
  `address-helper`, and `gh` or `glab` signed in with push access.

`status` reports probes for all three runners. A missing CLI reports CR-201;
a failed login probe reports CR-202. Once those checks pass, missing thrash
reports CR-206 for that runner. Unused runners may fail their probes.

| Runner | Thrash locations relative to the user's home |
| --- | --- |
| claude | `.claude/skills/thrash/SKILL.md` or a nested `skills/thrash/SKILL.md` under `.claude/plugins` |
| codex | `.codex/skills/thrash/SKILL.md` or `.agents/skills/thrash/SKILL.md` |
| copilot | `.copilot/skills/thrash/SKILL.md` or `.claude/skills/thrash/SKILL.md` |

The default `runner.claude.allowedTools` is narrow on purpose. A PR author
writes the text the runner reads, so a prompt injection must not reach a shell
or your secrets. Each rule has one job. `<scratch>` is `AI_SCRATCH_DIR` or
`/tmp/ai`. An absolute path in a rule needs the leading `//`.

- `Bash(<home>/scripts/bin/thrash-helper:*)` lets thrash call its helper and
  nothing else in the scripts folder.
- `Agent` lets thrash start its reviewer subagents.
- `Read(//<scratch>/thrash/**)` lets thrash read its own working files.
- `Read(~/.claude/skills/thrash/**)` lets thrash read its skill files.
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

- `Agent` lets /address start its fix agents.
- `Edit(//<clones>/**)`, `Read(//<clones>/**)`, `Grep(//<clones>/**)`, and
  `Glob(//<clones>/**)` limit file access to the job's clones.
- `Read(~/.claude/skills/address/**)` lets /address read its skill files.
- `Bash(git:*)`, `Bash(gh:*)`, and `Bash(glab:*)` let it commit, push, and
  reply to review threads.
- `Bash(<home>/scripts/bin/address-helper:*)` lets it call its helper.
- `Bash(bun:*)`, `Bash(npm:*)`, `Bash(npx:*)`, `Bash(dotnet:*)`,
  `Bash(python:*)`, and `Bash(pytest:*)` let it build and test.

Build and test tools run code from the PR, so a prompt injection or a hostile
PR can run commands as you. For that reason only allowed senders can run
`$address` (see `owner.senderIds`). Turn on `address.allowAnySender` only in
a chat where you trust every member.

Each `$address` job clones the PR head branch fresh into
`<clones>/<host>-<owner>-<repo>-<message id>` with `gh repo clone` or
`glab repo clone`, runs /address there, and deletes that one folder when the
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
runner runs with `--dangerously-bypass-approvals-and-sandbox`, and copilot runs
with `--allow-all-tools`. Both run on content that PR authors write, so a prompt
injection in a PR can run any command as you. Use them only on PRs you trust.

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
| `owner.senderIds` | string array | `[]` | Chat sender IDs (Teams Azure AD object IDs) that may run `$address`. Entries are trimmed and must not be empty. Reviews and help do not check it. |
| `runner.default` | string | `claude` | Default runner: claude, codex, or copilot. |
| `runner.timeoutMinutes` | number | `30` | Positive review time limit in minutes. |
| `runner.addressTimeoutMinutes` | number | `60` | Positive `$address` time limit in minutes. |
| `runner.claude.allowedTools` | string array | `Bash(<home>/scripts/bin/thrash-helper:*)`, `Agent`, and `Read`, `Grep`, `Glob`, `Edit` limited to `//<scratch>/thrash/**` (`Read` also `~/.claude/skills/thrash/**`) | Tools Claude may use. Keep it narrow; see Runner safety. |
| `runner.claude.addressAllowedTools` | string array | `Agent`; `Edit`, `Read`, `Grep`, `Glob` limited to `//<clones>/**`; `Read(~/.claude/skills/address/**)`; `Bash` for `git`, `gh`, `glab`, `<home>/scripts/bin/address-helper`, `bun`, `npm`, `npx`, `dotnet`, `python`, `pytest` | Tools Claude may use for `$address`. Separate from the review list; see Address allowlist and clone safety. |
| `runner.<name>.path` | string | Unset | Optional executable path for claude, codex, or copilot; otherwise uses PATH. |
| `reactions.*` | strings | See [reaction defaults](commands.md#reactions) | Override `pending`, `inProgress`, `changesRequested`, `approved`, `comment`, or `failure`. |
| `relay.*` | `appName` string; `secret` object | Required: `appName`, `secret.id`, `secret.key`, `secret.region` | Application name registered with the relay, and where the relay secret lives: the AWS Secrets Manager secret `id`, the JSON `key` inside it, and its `region`. Config never holds the secret value. |
| `fun.pool` | entry array | Shipped pool | Optional pool override with at least eight entries; see [pool rules](commands.md~fun). |
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

## State and recovery

All paths below live under `DG_HOME/channel-review`. Dev and prod share config
but keep separate state, pidfiles, daemon logs, and job logs.

| File or directory | Contents |
| --- | --- |
| `config.json` | Configuration and saved environment/reaction choices. |
| `state.<env>.json` | Event cursor per chat, handled messages, blocked PRs, and current job. |
| `daemon.<env>.pid` | Daemon process record, including the watched chats. |
| `daemon.<env>.log` | Background daemon output. |
| `jobs/<env>/*.log` | Runner output for each job. |
| `work/` | Runner working directory for reviews. `$address` clones live under `address.cloneRoot` instead. |

The daemon fetches the secret into memory. The secret is never written to disk.
The daemon runs on Linux, macOS, WSL, and Windows. In WSL, it lives only while
the VM runs. Start it again after the VM restarts. Recovery marks interrupted
reviews failed and posts CR-205; a human must verify this behavior in WSL.
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
