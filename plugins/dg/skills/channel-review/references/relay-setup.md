# Relay setup

Use this guide to help a new person set up channel review from zero. Do the
steps in order. Steps marked **Human** need a person with the right access; an
agent prepares the commands and checks the result.

Channel review needs a Teams bot relay that streams each chat's messages over
Server-Sent Events (SSE). The relay contract in `pkg/channel-review/README.md`
of the dg repository (under `CLAUDE_PLUGIN_ROOT` in a plugin install) lists
every call the daemon makes. Without that SSE stream, nothing works.

## 1. Register the bot and add it to each chat

1. **Human:** register a Teams bot (an Azure Bot with a Teams app manifest) and
   publish it to the org catalog. Use one bot per environment, such as
   `Review Bot (Dev)` and `Review Bot`.
1. **Human:** add the bot to each review chat.
1. A bot receives a chat message only when the message @mentions it. This is
   enough; the bot needs no resource-specific consent (RSC) permission. Every
   request, including a readiness reply such as `ptal`, must mention the bot.
1. **Human:** to find chats by topic, add the relay's service mailbox (the
   account the relay uses to list chats) to each chat too. Without it, set the
   chat `id` in config instead: the `19:...@thread.v2` part of the Teams
   **Copy link** URL.

## 2. Run or reuse a relay

Run a relay that meets every row of the relay contract, or reuse one that
already does. Check at least:

- `GET /chat/{chatId}/events` streams `message` and `reaction` events, honors
  `Last-Event-ID`, and sends a ping more often than every 45 s.
- `POST /message/teams` answers `201` with `messageIds`.
- Reaction add and remove, the reaction catalog, and the chat list exist.
- Every call checks the `X-Api-Code` header: Base64 of `<appName>:<secret>`.

Record the base URL for each environment, the application name (`appName`)
that the relay registered for this client, and the secret.

## 3. Store the relay secret

1. **Human:** store the secret in AWS Secrets Manager as a JSON secret string,
   such as `{ "RELAY__CHAT__SECRET": "<value>" }`. Use one secret per
   environment account.
1. **Human:** give each environment an AWS SSO profile that can read that
   secret, such as `example-dev` and `example-prod`.
1. Config names only where the secret lives: `relay.secret.id`,
   `relay.secret.key`, `relay.secret.region`, and `envs.<name>.awsProfile`.
   Never put the secret value in config or a chat. The daemon reads it into
   memory at start and never writes it to disk.
1. Optional: to start without an AWS SSO session, put the value in the
   git-ignored `.env` as `CHANNEL_REVIEW_RELAY_SECRET_<ENV>`, such as
   `CHANNEL_REVIEW_RELAY_SECRET_DEV`. The daemon then uses it and skips AWS.
   Keep `.env` at mode 600, and never commit it.

## 4. Local setup

1. Install `dg-skills`: run `mise run remote:install` in the dg repository, or
   use the bootstrap in SKILL.md.
1. Copy `.env.example` to `.env` in the dg repository and set `DG_HOME`,
   `DG_SKILLS`, and `CR_ENV` for this machine.
1. Copy [config.example.json](config.example.json) to
   `DG_HOME/channel-review/config.json` and replace every placeholder:
   `envs.<name>` (`baseUrl`, `awsProfile`, `botName`), `chats`, `owner.token`,
   `owner.email`, `relay.appName`, and `relay.secret`. Keep the file private
   (mode `0600`).
1. Set `owner.senderIds` for `$address` and `$emoji`. You do not know the id
   yet: leave the list empty, start the daemon (step 5), and send
   `@<bot> <owner.token> $address <PR link>`. The bot refuses with CR-106, and
   the daemon log shows
   `message <id> $address refused: sender <name> (<sender id>) is not in owner.senderIds`.
   Copy the sender id into `owner.senderIds`, then stop and start the daemon.
1. Keep the `address.cloneRoot` default (`<home>/code/bot`) unless the person
   wants another absolute path. Each `$address` job clones fresh into it and
   deletes its clone when done.
1. Install the prerequisites in [setup](setup.md#prerequisites): `aws`, `gh`
   (and `glab` for GitLab), a signed-in runner CLI, and the thrash skill.

## 5. Check and start

1. **Human:** `aws sso login --profile <envs.<name>.awsProfile>`.
1. Run `mise run remote:status`. It prints JSON. Require `secret` and
   `reactions` to be `ok`, an id for every chat, and the selected runner probe
   to be `ok`. Fix each error before you go on.
1. Run `mise run remote:up`. It starts the daemon and follows its log. Stop
   following with Ctrl+C; the daemon keeps running.
1. In a test chat, send `@<bot> <owner.token> $help`. The bot replies with the
   command list.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `The relay rejected the secret` or `rejected the API code (HTTP 401)` | Wrong secret, `relay.secret.key`, `relay.appName`, or env. Check the secret and run `aws sso login --profile <profile>`. |
| `AWS SSO session expired` | Run `aws sso login --profile <profile>`. |
| `<bot> is not a member of this chat, or the chat id is wrong` | Add the bot to the chat, or fix the chat `id`. |
| `Chat "<topic>" not found` | The relay's service mailbox is not in the chat. Add it, or set the chat `id`. |
| `reaction id "<id>" is not in the Teams reaction catalog` | The configured id is not a Teams reaction. Use a catalog id or capture a custom one. |
| `<id> is not a valid custom reaction id` | Fix the id format; see Custom emojis. |
| CR-201, CR-202 | The runner CLI is missing or not signed in. Install it and sign in. |
| CR-303 | `gh` or `glab` is missing or not signed in. Install it and sign in. |
| A message gets no reaction and no log line | The message did not @mention the bot, so the relay never received it. Mention the bot and send it again. |
| `event gap` in the log after downtime | The relay buffer lost events while the daemon or the relay was down. Post the missed requests again. |
| Capture times out or reports no message id | The relay does not send `reaction` events or does not return `messageIds`. Fix the relay, or save a known id with `emojis set`. |

## Custom emojis

Two slots can use a tenant's custom emoji: `progress` (`reactions.inProgress`)
and `approved` (`reactions.approved`). The other slots use built-in reactions
unless you set them.

- `dg-skills channel-review emojis capture --slot progress` (or `--slot approved`) posts a prompt through the bot. A **human** reacts to that prompt
  with the custom emoji; the CLI saves the id. Restart the daemon to apply.
- In the chat, the owner can send `@<bot> <owner.token> $emoji <slot>` and
  react to the bot's reply. The daemon saves and applies the id at once.
- `dg-skills channel-review emojis set approved '<id>'` saves a known id.

A custom id looks like `name;0-<region>-d<n>-<32hex>`, such as
`party;0-wus-d4-0123456789abcdef0123456789abcdef`. Quote it in the shell. The
`$help` reply shows a custom reaction as `:name:`, because Teams strips emoji
elements from bot messages.
