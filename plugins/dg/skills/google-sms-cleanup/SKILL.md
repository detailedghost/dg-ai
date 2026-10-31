---
name: google-sms-cleanup
description: Sort, archive, and spam-block a Google Messages inbox through Messages for Web. Never delete, never send without per-message approval, and flag ambiguous threads instead of acting.
---

# Google SMS cleanup

Clean up a Google Messages inbox through Messages for Web. The work runs as
`ssms` on `dg-skills`: `ssms google <verb>`. `ssms signal <verb>` is the other
provider and wraps `signal-cli` in daemon JSON-RPC mode. It does not touch
Signal Desktop. Every behavior below is a configurable default. Override any
value from the user's instructions, or from notes they asked to keep, before
starting, and state the effective config back to the user.

The executable is `~/.dg/bin/dg-skills`.
On first use, install or refresh the compiled CLI; it needs no Bun at runtime:

```sh
~/.dg/bin/dg-skills ssms --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
~/.dg/bin/dg-skills ssms --help
```

**Usage:** `~/.dg/bin/dg-skills ssms google <verb> [--config PATH] [--dry-run] [--limit N] [--draft ID] [--approve TOKEN]`

If a step fails, run ~/.dg/bin/dg-skills doctor ssms.

## Flags

| Flag | Short | Effect | Default |
| --- | --- | --- | --- |
| `--config` | | YAML or JSON cleanup config | skill defaults |
| `--dry-run` | | Report the action and do not change the account | false |
| `--limit` | | Maximum messages to read or receive | 20 |
| `--timeout-ms` | | How long receive or watch may wait | 0, or 60000 for watch |
| `--conversation` | | Conversation id for draft, read, or receive | |
| `--text` | | Draft body | |
| `--draft` | | Draft id to send | |
| `--approve` | | Token shown on the terminal for that draft. Not printed on stdout | required off a terminal |
| `--yes` | | Ignored. It does not approve a send | |
| `--name` | | Linked-device name for `signal link` | dg-cli |

## Prerequisites

- `~/.dg/bin/dg-skills ssms --help` runs. If it does not, install or refresh the CLI.
- Messages for Web is paired at
  https://messages.google.com/web/u/0/conversations. Google sign-in may be
  required first; the user completes it. The CLI opens that page with the same
  CDP browser harness demo uses, and keeps the profile under the dg home.
- If a `Trying to reach your phone` banner appears, ask the user to open
  Messages on the phone.
- `signal` needs `signal-cli` on PATH. The CLI will not install it. On Arch
  Linux the package is `signal-cli`.

## Config (defaults)

`allow_send` is not in this file. It is read only from `$DG_HOME/ssms/config.yaml`. `--config` cannot set it.

```yaml
allow_delete: false            # never delete conversations or messages
flag_ambiguous: true           # list unsure items for the user instead of acting
dry_run: false                 # true = report proposed actions only
scope: all                     # all | last_N_days
keep:                          # never archive/block
  - pinned
  - personal_and_family       # saved contacts, personal group chats
  - health                    # doctors, pharmacy, medical appointments, test results
  - user_keep_list: []        # specific senders/numbers the user wants kept
groups:                        # logical groups tracked in the report (Messages has no folders)
  dev: []                     # e.g. on-call / monitoring alerts
  personal_notifications: []  # alerts the user likes to follow
archive:                       # clear-cut only
  - business_promos
  - completed_delivery_notices
  - expired_codes_older_than_days: 3
  - past_nonmedical_reminders
  - user_archive_list: []
block_and_report_spam:         # clear-cut only
  - political_campaign_poll_fundraising
  - obvious_scams
  - user_spam_list: []
never_misclassify_as_spam: []  # senders the user confirmed legitimate
```

Pass the same map as `--config` when the user overrides a value.

## Steps

1. Load the config. Confirm overrides with the user when anything is destructive
   or unclear. Run `~/.dg/bin/dg-skills ssms google status`.
2. Run `~/.dg/bin/dg-skills ssms google list`. The command clicks
   `Load more conversations` until the end, or until the scope limit.
3. Run `~/.dg/bin/dg-skills ssms google classify`. It marks each thread keep,
   group, archive, spam, or ambiguous. Keep rules always win over archive or
   spam rules. Open a thread with `ssms google read <conversation> --limit 20`
   when the preview is unclear.
4. Unless `dry_run` is true, act on clear-cut cases only:
   `~/.dg/bin/dg-skills ssms google cleanup`. Archive through the thread's
   Options menu. Report spam through Details, then Block & report spam.
   Never touch compose. With `allow_delete` false, never delete a conversation
   or a message. With `allow_send` false, never send; any outgoing text needs
   explicit per-message approval from the user. `allow_send` is read only from
   `$DG_HOME/ssms/config.yaml`. `--config` cannot change it. `false` means never
   send. A hook cannot send.
5. Leave ambiguous items untouched and list them with the sender, the date, and
   a one-line preview. `flag_ambiguous` stays true unless the user overrides it.
6. To answer one thread, draft then send that draft only:
   `~/.dg/bin/dg-skills ssms google draft --conversation ID --text TEXT`. The
   approval token appears on the terminal device only, not in command output.
   On a terminal, `send --draft ID` asks for yes. Off a terminal, the user
   passes `--approve` with the token they saw. `--yes` does not send. Do not
   send from a hook. `--dry-run` does not send.
7. Report the totals, the archived threads, the blocked and reported threads,
   what was kept by category and group, and the ambiguous items.

## Signal

`ssms signal link` prints a QR and a linking URI for a device named `dg-cli`.
`list`, `read`, `receive`, `draft`, and `send --draft ID` are the same
shape. Reactions, images, and quotes are drafted, then sent after an
interactive yes or `--approve`. `--yes` does not send. The approval token
is shown on the terminal only.
Archive and spam-block are Google only. Logs carry ids and reasons, not phone
numbers, linking URIs, keys, or message bodies.

## Web-client limits (as of Oct 2026)

- No starring, renaming groups, labels, or folders on the web; those are
  phone-only. Give the user the phone steps instead.
- Archive and spam are reversible (Archived and Spam & blocked views). Deletion
  is not, hence `allow_delete` defaults to false.
- Built-in categories were removed in 2023. Search filters (Unread, Known,
  Unknown, Starred) are the only built-in grouping.
