---
name: inbox-cleanup
description: Safely scan a supported mailbox, prepare a sanitized cleanup plan, and open it for explicit review in the DeeGee browser extension. Use when the user asks to clean, organize, archive, mark read, label, move, or review inbox mail in bulk.
---

# Inbox cleanup

1. Require an installed, connected `dg-ai-extension` mailbox host. This skill and the CLI do not provide that host. If it is unavailable, stop with the host error; never encode mailbox data in a URL or file.
2. Confirm the user wants to scan the active mailbox account.
3. Run the freshly built `dg-skills mailbox-cleanup` command. Keep its stdin
   open. Its stdout is a machine-readable JSONL authoring channel; human status
   is written to stderr.
4. Ask the user to approve the extension-owned **Local CLI connection** page.
   This grants one short-lived connection from the exact loopback tab; it does
   not approve any mailbox mutation. Denial, page close, or timeout must stop
   safely.
5. Wait for the extension to finish capture and open `mailbox-plan.html`.
6. Only after the user explicitly selects **Submit to Chat**, read the one
   `dg_mailbox_author_request` JSON line. Author one sanitized Draft revision,
   preserve its exact `runAlias`, `planAlias`, `requestAlias`, and `nonce`, and
   write one `dg_mailbox_author_proposal` JSON line to stdin. Do not write
   prose or a second response line.
7. Tell the user to review coverage, temporary-data expiry, cleanup level, targets, exceptions, exclusions, and filter changes in the plan page.
8. If chat disconnects, use Reconnect and continue the same proposal.
9. Wait for the typed proposal, cancellation, or error result.
10. Require the user to choose **Accept Revision** in the plan page before execution. Never treat Save Draft or Submit to Chat as approval. Connection approval is not mailbox-mutation approval either.

Keep raw message text, provider locators, account identifiers, and temporary bindings out of chat, files, URLs, logs, and command arguments. If the page reports expiry, restart required, partial capture, wrong account, or a provider prompt, stop and follow the page’s recovery instruction.
