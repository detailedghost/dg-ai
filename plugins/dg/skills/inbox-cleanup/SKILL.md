---
name: inbox-cleanup
description: Safely scan a supported mailbox, prepare a sanitized cleanup plan, and open it for explicit review in the DeeGee browser extension. Use when the user asks to clean, organize, archive, mark read, label, move, or review inbox mail in bulk.
---

# Inbox cleanup

1. Require an installed, connected `dg-ai-extension` mailbox host. This skill and the CLI do not provide that host. If it is unavailable, stop with the host error; never encode mailbox data in a URL or file.
2. Confirm the user wants to scan the active mailbox account.
3. Run the freshly built `dg-skills mailbox-cleanup` command.
4. Wait for the extension to finish capture and open `mailbox-plan.html`.
5. Tell the user to review coverage, temporary-data expiry, cleanup level, targets, exceptions, exclusions, and filter changes in the plan page.
6. If chat disconnects, use Reconnect and continue the same proposal.
7. Wait for the typed proposal, cancellation, or error result.
8. Require the user to choose **Accept Revision** in the plan page before execution. Never treat Save Draft or Submit to Chat as approval.

Keep raw message text, provider locators, account identifiers, and temporary bindings out of chat, files, URLs, logs, and command arguments. If the page reports expiry, restart required, partial capture, wrong account, or a provider prompt, stop and follow the page’s recovery instruction.
