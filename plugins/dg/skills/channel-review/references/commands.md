# Channel review commands

Run the installed `dg-skills` binary. Claude is the supported default runner.
Codex, Copilot, and Grok Build are experimental. Codex runs with
`--dangerously-bypass-approvals-and-sandbox`; Copilot runs with `--allow-all-tools`;
Grok runs with `--always-approve`. They run on content that PR authors write, so a prompt injection in a PR can run
any command as you. Claude with the default allowlist is the safe choice.
All report CR-203 for execution failures without a more specific error code.
`$address` always runs on Claude and reports runner failures with the same
codes: CR-203 for a failed run and CR-204 after `runner.addressTimeoutMinutes`.
Runner availability, login, missing thrash, and timeouts have separate codes.

## Daemon operations

| Command | Flags or arguments | Result |
| --- | --- | --- |
| `dg-skills channel-review start` | `--env dev\|prod`, `--runner claude\|codex\|copilot\|grok`, `--chat-id <id>` | Start the background daemon. |
| `dg-skills channel-review stop` | `--env dev\|prod` | Stop the selected environment's daemon. |
| `dg-skills channel-review status` | `--env dev\|prod` | Print daemon state, watched chats, last event IDs per chat, runner probes, and preflight as JSON; preflight checks each chat when stopped and exits 1 if any check errors. |
| `dg-skills channel-review run` | `--env dev\|prod`, `--runner claude\|codex\|copilot\|grok`, `--chat-id <id>` | Run the foreground daemon. |
| `dg-skills channel-review logs` | `--env dev\|prod`, `-n, --lines <n>` (default 40), `-f, --follow` | Print the last lines of the daemon log; with `--follow`, keep printing until Ctrl+C. With no log file, print its path and `no log yet`. |
| `dg-skills channel-review env` | Optional `dev` or `prod` | Print default env, base URL, and AWS profile; a name saves that default. |
| `dg-skills channel-review connect` | `datadog\|sentry\|relay`; `--env dev\|prod`, `--site <site>`, `--org <slug>`, `--paste`, `--session <id>` | Store a secret in the dg credential store; see [setup](setup.md#credentials). Never prints the value. |
| `dg-skills channel-review migrate-env` | `--file <path>`, `--dry-run`, `--session <id>` | Move known secrets from `.env` into the credential store and delete only their lines. Prints variable names only. |

Flags are optional. Commands use the saved environment unless `--env` overrides
it. Start and run accept runner and chat overrides for that invocation.
`--chat-id` replaces the configured `chats` list with that one chat.
Read [setup](setup.md) before changing config.

```sh
dg-skills channel-review status --env dev
dg-skills channel-review start --env dev --runner claude --chat-id '<id>'
dg-skills channel-review stop --env dev
dg-skills channel-review run --env dev
dg-skills channel-review logs --env dev -n 100 -f
dg-skills channel-review env
dg-skills channel-review connect datadog
dg-skills channel-review migrate-env --dry-run
```

## Teams requests

Mention the bot in every request: the bot named by `envs.<name>.botName`. The
examples use **Review Bot** and show mentions as text; select the matching Teams
mention when sending. A Teams bot without resource-specific consent (RSC) chat
read permission receives only messages that @mention it, so readiness messages
must mention the bot too.

Tokens accept any order and any case. Keep each token's value next to it.
Anyone who writes the owner gate can request a review or help. Only allowed
senders can run `$address` and `$emoji`; see `owner.senderIds` and `address.allowAnySender`
in [setup](setup.md#configuration).

### Commands

`$help` alone lists these commands, one line each. Send `$help $review`,
`$help $address`, or `$help $emoji` for that command's details.

| Token | Meaning | Missing or invalid input |
| --- | --- | --- |
| `!owner` | Owner gate set by `owner.token`; the examples use `!owner`. | Without the gate, ignore the message. |
| `$review` | Request a review. | Without a command, ignore the message. |
| `$thrash` | Same as `$review`. | Without a command, ignore the message. |
| `$address` | Run `/address` on the PR, then react approved on your message. | With `$review` or `$thrash` in the same message: CR-105. Sender not allowed: CR-106. |
| `$emoji <slot>` | Set the custom emoji for a reaction slot from a reaction in the chat. | No slot or an unknown slot: reply with the slot list. Sender not allowed: CR-107. |
| `$help` | Reply with usage text and run nothing; needs the owner gate and no link. | Without the gate, ignore the message. |

### Review flags

`$help $review` (or `$help $thrash`) lists these flags, the re-review rules, and
the review reactions.

| Token | Meaning | Missing or invalid input |
| --- | --- | --- |
| `$review` or `$thrash` | Request a review; include at least one. | Without either, ignore the message. |
| PR or MR URL | HTTPS GitHub PR or GitLab MR link on an allowed host. | No PR link: CR-101. Host outside the allowlist: CR-104. |
| `~spice 1-5` | Pass a whole-number review level to thrash. | Missing value or a value outside 1–5: CR-102. |
| `~comment` | Pass thrash's comment option. | Optional. |
| `~agent claude\|codex\|copilot\|grok` | Choose a runner for this review. | Missing or unknown runner: CR-103. |
| `~model <name>` | Pass a model name to the selected runner. | Missing or malformed name: CR-108. |
| `~stacked` | Review the target and its descendants. | Unreadable stack: CR-304. |
| `~fun` | Add a verdict-matched GIF card or emoji text to the reply. | Optional. |

If Claude runs out of tokens, the bot retries the review once with Codex by
default when Codex passes its readiness check. It replies to the original request:
“Claude is out of tokens, so I'm using Codex for this review.” The retry uses
Codex's default model and the time remaining for that PR. The rest of a stacked
review stays on Codex. Set `runner.fallback` to null to disable this behavior.
Set `runner.fallback` to `"grok"` to use Grok Build instead. Explicit
`~agent grok` reviews use Grok directly and do not switch backends on a limit.
Use `~model <id>` to select a Grok model, or omit it to use Grok’s configured
default. For example: `$review https://github.com/example/project/pull/42 ~agent grok ~model grok-build`.

### Address flags

`$help $address` lists these flags and the address reactions. `$address` runs
the Claude `/address` skill on a fresh clone of the PR head branch. The skill
fixes review comments and failing CI, commits, pushes, and replies to the
review threads. Any PR on an allowed host works, except a PR from a fork.
Claude always runs it; review-only flags such as `~spice` are ignored. On
success the bot sends no reply; your message ends with the approved reaction.
A failure replies with the error text and puts the failure reaction on your
message. Post a ready word to request a re-review.

| Token | Meaning | Missing or invalid input |
| --- | --- | --- |
| `$address` | Fix review comments and failing CI on the PR, then push. | Sender not allowed: CR-106. |
| PR or MR URL | HTTPS GitHub PR or GitLab MR link on an allowed host. | No PR link: CR-101. Host outside the allowlist: CR-104. Fork: CR-305. |
| `~no-ci` | Pass `--no-ci` to `/address`: fix review comments only. | Optional. |
| `$review` or `$thrash` | Not allowed in an `$address` message. | CR-105, and nothing runs. |

GitHub defaults to github.com; GitLab defaults to gitlab.com. `hosts.github` and
`hosts.gitlab` add other hosts, including ports. GitLab MR reviews require
`glab`; a missing or unsigned-in GitHub/GitLab tool reports CR-303.

Single review in dev:

```text
@Review Bot !owner $review https://github.com/example/project/pull/42 ~spice 3 ~comment ~agent claude
```

Address review comments without CI in dev:

```text
@Review Bot !owner $address https://github.com/example/project/pull/42 ~no-ci
```

Stack with a fun reply:

```text
@Review Bot !owner $thrash https://github.com/example/project/pull/42 ~stacked ~fun
```

`~stacked` reviews the target plus descendants. It posts one summary reply and
puts the worst verdict on the trigger message.

### Re-review

Anyone may post a PR URL with a phrase from `rereview.phrases`, such as
`ptal`. The PR does not need to be blocked: a ready word re-runs the review for
any PR. Omit the owner and review tokens if desired. A blocked PR reuses the
blocked review's options. Any other PR reuses the options of the quoted request
when there is one, and the defaults otherwise. Re-review reactions land on the
readiness message; the original message keeps its construction sign. Mention
the bot, because it sees only messages that mention it.

```text
@Review Bot https://github.com/example/project/pull/42 fixed, ptal
```

A quoted reply also works. Quote a review request and add a phrase. No PR link
is needed. The message must still mention the bot, because the bot sees only
messages that mention it. A link outside the quote wins over the quote. A phrase
inside the quoted text does not count.

```text
(quoting the original review request) @Review Bot ready
```

### Emoji command

`$emoji <slot>` lets an allowed sender set up a custom reaction from the chat,
without the CLI. The bot replies `React to this message with the emoji for <slot>.`
React to that reply with a custom emoji within 5 minutes. The daemon saves the
id to `reactions.<slot>` in config.json, uses it at once (no restart), and
replies `Saved :<name>: for <slot>.` with the new reaction on that reply. Only
a human's custom reaction on that reply counts; bot reactions, built-in emojis,
and reactions on other messages do not. On timeout the bot replies that nothing
was saved. A new `$emoji` replaces one that still waits.

```text
@Review Bot !owner $emoji approved
```

| Slot | Reaction meaning |
| --- | --- |
| `pending` | The request was seen. |
| `inProgress` (or `progress`) | Work is running. |
| `approved` | Approved, or addressed. |
| `changesRequested` | Changes requested. |
| `comment` | Comments only. |
| `failure` | It failed. |

### Fun

The shipped fun pool is reviewed by the maintainer before each release.
A human must approve the GIF list before release. `fun.pool` overrides the
pool with an array of these entry shapes:

```json
[
  { "verdict": "approved", "kind": "gif", "url": "https://example.com/approved.gif", "alt": "Approved" },
  { "verdict": "approved", "kind": "emoji", "reactionId": "2705_whiteheavycheckmark", "text": "Approved" }
]
```

This illustrates the format only. A valid pool includes both a GIF and an emoji
for each verdict: `approved`, `changes`, `comment`, and `failed` (at least eight
entries). GIF URLs must use HTTPS and be unique; alt text must be nonempty.
Emoji entries require a nonempty reaction ID and text. Reaction IDs must also
pass preflight against the service's reaction list.

## Reactions

| Emoji | Meaning | Config key | Default ID |
| --- | --- | --- | --- |
| Eyes | Message seen | `reactions.pending` | `1f440_eyes` |
| Stopwatch | Review running | `reactions.inProgress` | `23f1_stopwatch` |
| Construction sign | Changes requested | `reactions.changesRequested` | `1f6a7_constructionsign` |
| Check mark | Approved | `reactions.approved` | `2705_whiteheavycheckmark` |
| Speech bubble | Comment | `reactions.comment` | `speechbubble` |
| Warning sign | Failure | `reactions.failure` | `26a0_warningsign` |

An `$address` job uses the same flow: eyes when seen, stopwatch while
`/address` runs, check mark when it is addressed, and
the warning sign on failure. The help reply shows a captured custom reaction
as its name in colons, such as `:loading:` for `loading;0-cus-d20-<32hex>`,
because Teams strips emoji elements from bot messages.

Reactions go only on the message that triggered the bot. Replies, such as a
`~fun` reply, a stack summary, an error, or a `$help` reply, get no reaction.

The emojis commands replace two slots: `progress` changes
`reactions.inProgress`; `approved` changes `reactions.approved`.

## Custom emojis

`emojis capture` counts only a reaction on its own prompt message, matching that
prompt's message ID. It saves the first valid custom-id reaction added by a human
after capture starts. Built-in reactions, bot reactions, and reactions on other
messages do not count.

| Command | Flags or arguments | Result |
| --- | --- | --- |
| `dg-skills channel-review emojis capture` | Required `--slot progress\|approved`; optional `--env dev\|prod`, `--chat-id <id>`, `--timeout <seconds>` | Prompt through the bot in the first configured chat (or `--chat-id`) and save the human's custom reaction. Timeout defaults to 120 seconds. |
| `dg-skills channel-review emojis set` | `<progress\|approved> <id>` | Save a known custom ID. |
| `dg-skills channel-review emojis show` | None | Print both slots; mark default IDs with `(built-in fallback)`. |

```sh
dg-skills channel-review emojis capture --slot progress --env dev --timeout 120
dg-skills channel-review emojis set approved '<id>'
dg-skills channel-review emojis show
```

A human reacts to the capture prompt in Teams. IDs use
`name;0-<region>-d<digits>-<32hex>`, where `<region>` is a short code such as `cus` or `wus`. Quote the ID when passing it to the shell.
A saved ID applies after stop and start. If the daemon runs, set and successful
capture print `restart the daemon to apply`. On timeout, capture keeps the
existing ID. Capture needs the relay to send reaction events and to return the
prompt's message ID; see [relay setup](relay-setup.md#troubleshooting).

## Reconnects and gaps

After a connection gap, the relay replays what its buffer still holds. The
daemon skips messages it already handled. Commands evicted from that buffer
cannot replay. A relay deploy can drop all SSE streams and the replay buffer. The daemon reconnects and may see a gap; commands posted
during that deploy window cannot replay. Post those requests again.

## Error catalog

The service fills `{agent}`, `{minutes}`, and `{owner}` at runtime. It derives
the owner name from `owner.token`: `!owner` gives Owner. These templates match
the shipped catalog exactly.

| Code | Template | Remedy |
| --- | --- | --- |
| `CR-101` | `I couldn't find a pull request link in your message, so I didn't review anything. Add the PR link and try again.` | Add a PR or MR URL. |
| `CR-102` | `The ~spice level must be a whole number from 1 to 5, so I didn't review this. Fix the number and try again.` | Use a whole number from 1 to 5. |
| `CR-103` | `I don't know that ~agent. Pick claude, codex, copilot, or grok and try again.` | Choose a supported runner name. |
| `CR-104` | `That link is not on a GitHub or GitLab server I review, so I didn't review it.` | Check the link and configured host allowlists. |
| `CR-105` | `Send $address and $review in separate messages, so I didn't run anything. Pick one and try again.` | Send one command per message. |
| `CR-106` | `Only {owner} can run $address, so I didn't run anything.` | Add the sender ID to `owner.senderIds`, or set `address.allowAnySender`. |
| `CR-107` | `Only {owner} can run $emoji, so I didn't change anything.` | Add the sender ID to `owner.senderIds`, or set `address.allowAnySender`. |
| `CR-108` | `The ~model flag needs a model name made of letters, numbers, dots, underscores, colons, slashes, or hyphens. Fix the name and try again.` | Provide a valid model name. |
| `CR-201` | `I couldn't start {agent} on {owner}'s computer, so I didn't review this. Try ~agent claude.` | Install the runner or correct its executable path. |
| `CR-202` | `{agent} is not signed in on {owner}'s computer, so I didn't review this. Ask {owner} to sign in, or try ~agent claude.` | Sign in to the runner. |
| `CR-203` | `{agent} stopped with an error before it finished, so the review is not complete. Try again, or try a different ~agent.` | Inspect the job log; retry or switch runners. |
| `CR-204` | `The review took longer than {minutes} minutes, so I stopped it. Try again with a lower ~spice.` | Lower the spice or inspect the timeout. |
| `CR-205` | `The service stopped before the job finished. If you sent a request, post it again to restart it.` | Post the request again after the daemon starts. |
| `CR-206` | `The thrash skill is not installed for {agent} on {owner}'s computer, so I didn't review this. Ask {owner} to install it, or try a different ~agent.` | Install thrash in that runner's skill roots. |
| `CR-207` | `{agent} reached its usage or token limit, so the task is not complete. Try a different ~model or ~agent, or wait for the limit to reset.` | Reviews retry once with Codex by default after a Claude limit, if Codex passes its probe. |
| `CR-301` | `The review finished, but I found no review on the pull request. Check the PR, or post the request again.` | Check the PR and runner output. |
| `CR-302` | `I couldn't open that pull request. Check that the link is right and that {owner} can see it.` | Verify the URL and repository access. |
| `CR-303` | `The GitHub or GitLab tool for this link is missing or not signed in on {owner}'s computer. Ask {owner} to sign in, then try again.` | Install and sign in to `gh` or `glab`. |
| `CR-304` | `I couldn't read which pull requests are stacked on this one, so I didn't review anything. Try again without ~stacked.` | Retry without ~stacked or repair stack metadata. |
| `CR-305` | `That pull request comes from a fork, and I can't push to a fork, so I didn't address it.` | Run `/address` by hand, or move the branch into the main repository. |
| `CR-306` | `I couldn't clone the pull request branch on {owner}'s computer, so I didn't address it. Check that the branch still exists, then try again.` | Check the branch, the clone root, and the daemon log. |
| `CR-401` | `I found no allowed repository for this error, so I didn't try a fix. Ask {owner} to add the service under errorWatch.repos.` | Add the service under `errorWatch.repos`. |
| `CR-402` | `The hourly limit for automatic fixes is reached, so this fix waits. I try again on the next poll.` | Wait for the next poll, or raise `errorWatch.autoFix.maxPerHour`. |
| `CR-403` | `A fix pull request for this error is already open, so I didn't start another.` | Review the open bot PR. |
| `CR-404` | `The fix agent changed nothing, so I opened no pull request. Check this error by hand.` | Inspect the job log and fix the error by hand. |
| `CR-405` | `A git or GitHub step failed on {owner}'s computer, so I opened no pull request. Check that git and gh are signed in there.` | Check `git` and `gh` sign-in, then inspect the daemon log. |

## Direct messages

Error watch and scheduled upgrades message the owner directly (or the chat in
`automation.notify.target`). Each message has no reply thread. A link, when
present, follows on its own line. The daemon strips URL queries, email
addresses, and long tokens from the text and caps it at 400 characters.
`CR-401` to `CR-405` above reach the owner this way, with the issue link.

| Message | When |
| --- | --- |
| `New <level> error in <service> (<env>): <title>` | A new or regressed issue. Sent once per issue; a retry after a deferral does not repeat it. |
| `Draft fix pull request opened for <title>.` | The fix job opened a draft PR. The link follows. |
| `Deps upgrade PR opened as draft for <repo>, waiting for CI:` | The upgrade job opened a draft PR. The link follows. |
| `Deps upgrade ready for <repo>:` | The PR was already ready when the job ended. The link follows. |
| `Deps upgrade ready:` | CI passed and the daemon marked the draft PR ready. The link follows. |
| `No dependency upgrades for <repo>.` | The job ran and opened no PR. |
| `CI failed on <url>: <check names>` | A check failed on a watched upgrade PR. |
| `CI did not finish within <n> minutes on <url>.` | `deps.ciTimeoutMinutes` passed. |
| `Deps upgrade failed for <repo>. <CR text> Job log: <path>` | The upgrade job failed, timed out (CR-204), or stopped (CR-205). |
| `Deps upgrade for <repo> was interrupted. <CR-205 text>` | The daemon restarted during an upgrade job. |

Review attribution is recorded in the compiled and published review. Jobs run by this
daemon, including explicit Teams requests and readiness events, say `Automatic (daemon)`.
A direct user CLI `/thrash` defaults to `Manual (CLI)`. Both show the reviewing backend
and model evidence for each distinct worker model. The daemon's `~model` selects the
orchestrator; native thrash workers can use a different configured model. CLI defaults
and unresolved aliases are labeled as such. Current-job status carries `execution` with
origin and orchestration evidence; compiled review artifacts carry actual worker evidence.
