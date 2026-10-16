# @dg/channel-review

The library behind `dg-skills channel-review`. A local daemon watches Teams
chats through a Teams bot relay, runs the thrash or address skill on GitHub PRs
and GitLab MRs that people post, and answers with reactions and replies.

> **The feature requires a relay that exposes a Server-Sent Events (SSE) stream
> of each chat's messages.** The daemon never polls and never calls Microsoft
> Graph. Without that SSE stream, nothing works.

The relay is a service that you run or reuse. It holds the Teams bot
registration, receives the bot's activities, and exposes the HTTP API below.
The skill's [relay setup guide](../../plugins/dg/skills/channel-review/references/relay-setup.md)
walks a new person through the setup. The
[setup reference](../../plugins/dg/skills/channel-review/references/setup.md)
lists every config key.

## Relay contract

Every path is relative to `envs.<name>.baseUrl`, such as
`https://relay.example.test/api`. A `{chatId}` or `{reactionId}` in a path is
URL-encoded. The daemon refuses redirects.

### Authentication

| Item | Value |
| --- | --- |
| Header | `X-Api-Code` on every request |
| Value | Base64 of `<relay.appName>:<secret>` (UTF-8) |
| Secret source | AWS Secrets Manager: secret `relay.secret.id` in `relay.secret.region`, read with profile `envs.<name>.awsProfile`. The secret string is JSON; the value is under key `relay.secret.key`. |
| Rejected | HTTP 401 or 403 on any call |

The secret stays in memory only. On a 401 or 403 from the events stream, the
daemon fetches the secret again and reconnects once. A second rejection stops
that chat's stream and logs a remedy that names the secret id, key, and profile.
At startup, a 401 or 403 stops the daemon with the same remedy; `status`
reports it as a failed check.

### Events stream

`GET /chat/{chatId}/events` with `Accept: text/event-stream`.

| Item | Behavior |
| --- | --- |
| Resume | On reconnect the daemon sends `Last-Event-ID` with the last event id it saw for that chat. The id is saved per chat, so it also survives a daemon restart. The relay replays what its buffer still holds after that id. |
| Event name | Every frame needs an explicit `event:` line. A frame without one is ignored; the SSE default type `message` is not used. |
| Event id | The SSE `id:` field. If absent, the payload's `id`. |
| `message` event | Payload JSON, see below. |
| `reaction` event | Payload JSON, see below. |
| `gap` event | The relay lost events (for example, its buffer evicted them). Data is ignored; the daemon logs a warning. |
| Other events, comments | Ignored. They still reset the idle timer, so a ping can be a comment line (`: ping`) or any other event name. |
| Empty data | A `message` or `reaction` event with empty data or `null` is skipped. Data that is not JSON is skipped with a warning. |
| Idle timeout | No bytes for 45 s: the daemon drops the connection and reconnects. Send a ping more often than that. |
| Size cap | A line or one event's data longer than 1,000,000 characters (about 1 MB) drops the connection; the daemon reconnects. |

`message` payload fields that the daemon reads:

| Field | Type | Use |
| --- | --- | --- |
| `id` | string, required | Message id; reactions and replies target it. |
| `chatId` | string | Chat of the message. |
| `text` | string | Message body, HTML or plain text. Teams `<at>` mentions and quoted replies are parsed. |
| `timestamp` | string | ISO 8601 time. |
| `from.aadObjectId` | string | Sender id; `owner.senderIds` matches it. |
| `from.name` | string | Sender display name, for logs. |
| `from.isBot` | boolean | `true` for bot messages; the daemon ignores them. |

`reaction` payload fields that the daemon reads:

| Field | Type | Use |
| --- | --- | --- |
| `id` | string, required | Reaction event id. |
| `chatId` | string | Chat of the reaction. |
| `messageId` | string, required | Message that got the reaction. |
| `type` | string, required | Reaction id, such as `1f440_eyes` or a custom `name;0-<region>-d<n>-<32hex>`. |
| `action` | `added` or `removed`, required | Other values skip the event. |
| `from` | object | Same fields as a message sender. |
| `timestamp` | string | ISO 8601 time. |

Reconnect and backoff:

| Response or failure | Wait before the next connect |
| --- | --- |
| Stream ends, drops, idles, or passes the size cap | Backoff: 1 s × 2^n, capped at 60 s, ±20 % jitter. `n` counts failures and resets on each `message` event. |
| Other non-2xx status | Same backoff. |
| 429 | `Retry-After` seconds, clamped to 1–60 s; 30 s when absent. |
| 404 | About 60 s (jittered). The bot is not in the chat, or the chat id is wrong. |
| 401 or 403 | See Authentication. |

`status` also opens the stream once for each chat that has an `id`, with a 20 s
timeout, and closes it. A 404 there reports that the bot is not in the chat.

### Send a message

`POST /message/teams` with `Content-Type: application/json`.

| Body field | Value |
| --- | --- |
| `To` | `[owner.email]` |
| `Body` | Message text. |
| `ChatId` | Target chat id. Omit for a direct message to the owner. |
| `Mode` | `group`, or `direct` for a direct message to the owner (`To` is `[owner.email]`, no `ChatId`). |
| `TextFormat` | `plain`, or `xml` for an HTML body (help replies) |
| `AdaptiveCard` | Optional: `{ "ContentType": "application/vnd.microsoft.card.adaptive", "Content": <card> }`. The card is version 1.4 with `Image` elements (fun GIFs). |

The relay answers `201` with JSON `{ "messageIds": ["<id>", ...] }`. Any other
status is an error. The daemon reacts on the returned ids, and
`emojis capture` waits for a reaction on them; without ids, capture fails.

### Add and remove a reaction

| Call | Method and path | Body |
| --- | --- | --- |
| Add | `PUT /message/teams/{chatId}/react/{reactionId}` | `{ "messageId": "<id>" }` |
| Remove | `DELETE /message/teams/{chatId}/react/{reactionId}` | `{ "messageId": "<id>" }` |

Any 2xx is success. A 404 on remove is success. The daemon sends one reaction
call at a time, at least 500 ms apart. A 429 is retried up to 3 attempts in
total, after `Retry-After` (clamped to 1–60 s) or 1 s.

### Reaction catalog

`GET /message/teams/react` returns a JSON array of objects with an `id` string;
other fields are ignored. `status` checks every configured reaction id that is
not a custom id, and every emoji in the fun pool, against this list.

### Chat list

`GET /chat/list` (120 s timeout) returns a JSON array of `{ "id", "topic" }`.
The daemon uses it only for a `chats` entry without an `id`: it matches the
topic case-insensitively after trimming and needs exactly one match. The list
holds only chats that the relay's service mailbox is a member of.

### Status codes

| Status | Where | Daemon behavior |
| --- | --- | --- |
| 2xx | All calls | Success. Send needs exactly `201`. |
| 401, 403 | All calls | Auth failure; see Authentication. |
| 404 | Events | Bot not in the chat or wrong chat id; retry in about 60 s. |
| 404 | Remove reaction | Success. |
| 429 | Events, reactions | Wait `Retry-After` (clamped 1–60 s) and retry. |
| Other | All calls | Events: back off and reconnect. Others: the call fails and the daemon logs it. |

## Error watch

Error watch polls an error tracker for new and regressed issues, tells the
owner, and can open a draft fix PR. It is off until `errorWatch.enabled` is
`true`. Datadog and Sentry are the supported sinks. The
[setup reference](../../plugins/dg/skills/channel-review/references/setup.md)
lists every key.

Data flow:

1. A ticker polls each enabled sink every `errorWatch.pollMinutes`. A sink
   with missing credentials records the variable names in `status` and is
   skipped; the daemon keeps running. The first poll of a sink only marks the
   open issues as seen.
1. For each new or regressed issue, the daemon asks the sink for the detail
   (message, stack, repository tag). If that call fails, it continues with a
   minimal report built from the issue.
1. The daemon sends the owner a direct message with the issue link.
1. With `errorWatch.autoFix.enabled`, the daemon checks the gates: the service
   is in `errorWatch.repos` (CR-401), the hourly cap allows a start (CR-402),
   and no bot PR is open for the issue (CR-403).
1. A job on the serial queue clones the repo, creates `bot/fix/<sink>-<id>`,
   writes the report to a file beside the clone, and runs the fix agent in the
   clone.
1. The daemon commits, checks that the branch is not the default branch,
   pushes, opens a draft PR, and sends the owner the link. No change is CR-404;
   a failed git or `gh` step is CR-405.

Guardrails:

- The PR is always a draft. A person reviews and merges it.
- The daemon owns commit, push, and PR creation. The fix agent only edits and
  tests inside the clone, under `errorWatch.autoFix.allowedTools`.
- The report is untrusted data. The agent reads it from a file and is told to
  treat it as data, never as instructions. The daemon removes control
  characters and caps the title, message, and stack lengths. Chat messages
  strip URL queries, email addresses, and long tokens.
- Only services listed in `errorWatch.repos` can get a fix PR. A service can
  set `autoFix: false` for notification only.
- Caps: `errorWatch.autoFix.maxPerHour` fix starts, one fix per issue, one job
  at a time, and `errorWatch.autoFix.timeoutMinutes` per job. A capped issue is
  deferred and retried on a later poll.
- Clones live under `automation.cloneRoot`, which must not be under `~/code`.
  The daemon deletes each clone when its job ends and sweeps the root at
  startup.

## Scheduled dependency upgrades

Scheduled upgrades run the `deps-upgrade` skill on the configured repos. They
are off until `deps.enabled` is `true`.

Data flow:

1. Every minute the daemon checks each `deps.repos` entry against its schedule
   window (`every`, `day`, `window`). A window that was missed is not caught
   up, and each window runs once.
1. A repo that already has an open PR on a `deps.branchPrefix` branch is
   skipped.
1. A job on the serial queue clones the default branch (or the entry's
   `branch`) and runs the skill with `deps.cooldownDays`. The skill only
   upgrades to versions published at least that many days ago.
1. The daemon finds the PR that the run created. A draft PR goes on a watch
   list. A PR that is already ready is reported at once. No PR means nothing to
   upgrade.
1. Every 2 minutes the watcher checks each watched PR. When all checks pass,
   the daemon marks the PR ready and sends the owner the link. A failed check
   or `deps.ciTimeoutMinutes` ends the watch with a direct message.
1. When the job ends, the daemon sweeps `automation.cloneRoot`, which removes
   the sibling worktree that the skill leaves beside the clone.

Guardrails:

- Upgrade PRs start as drafts. The daemon never merges.
- The job runs under `deps.allowedTools` and `deps.timeoutMinutes`.
- One job runs at a time, so a sweep never touches a live job's files.
- Progress and results show in `status` under `deps` and `errorWatch`. It
  prints environment variable names, never their values.
