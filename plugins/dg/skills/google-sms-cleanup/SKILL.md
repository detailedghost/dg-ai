---
name: google-sms-cleanup
description: Sort, archive, and spam-block a Google Messages inbox through Messages for Web. Never delete, never send without per-message approval, and flag ambiguous threads instead of acting.
---

# Google SMS cleanup

Clean up a Google Messages inbox through Messages for Web. Every behavior below
is a configurable default. Override any value from the user's instructions, or
from notes they asked to keep, before starting, and state the effective config
back to the user.

This skill does not run a `dg-skills` command. Open Messages for Web in the
browser and follow the steps below.

## Prerequisites

- Messages for Web is paired at
  https://messages.google.com/web/u/0/conversations. Google sign-in may be
  required first; the user completes it.
- If a `Trying to reach your phone` banner appears, ask the user to open
  Messages on the phone.

## Config (defaults)

```yaml
allow_delete: false            # never delete conversations or messages
allow_send: false              # never send; any outgoing text needs explicit per-message user approval
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

## Steps

1. Load the config. Confirm overrides with the user when anything is destructive
   or unclear.
2. Open the conversation list. Click `Load more conversations` until the end,
   or until the scope limit.
3. For each thread, read the preview and open the thread when the preview is
   unclear. Classify it as keep, group, archive, spam, or ambiguous. Keep rules
   always win over archive or spam rules.
4. Unless `dry_run` is true, act on clear-cut cases only. Archive through the
   thread's Options menu. Report spam through Details, then Block & report spam.
   Never touch compose. With `allow_delete` false, never delete a conversation
   or a message. With `allow_send` false, never send; any outgoing text needs
   explicit per-message approval from the user.
5. Leave ambiguous items untouched and list them with the sender, the date, and
   a one-line preview. `flag_ambiguous` stays true unless the user overrides it.
6. Report the totals, the archived threads, the blocked and reported threads,
   what was kept by category and group, and the ambiguous items. Include
   screenshots of the final list.

## Web-client limits (as of Oct 2026)

- No starring, renaming groups, labels, or folders on the web; those are
  phone-only. Give the user the phone steps instead.
- Archive and spam are reversible (Archived and Spam & blocked views). Deletion
  is not, hence `allow_delete` defaults to false.
- Built-in categories were removed in 2023. Search filters (Unread, Known,
  Unknown, Starred) are the only built-in grouping.
