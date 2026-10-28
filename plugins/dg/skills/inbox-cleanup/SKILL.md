---
name: inbox-cleanup
description: Review and clean Proton Mail, Gmail, or Outlook through dg-skills, with redacted message batches, existing-folder routing, and reviewed mailbox changes.
---

# Inbox cleanup

The executable is `~/.dg/bin/dg-skills`.
On first use, install or refresh the compiled CLI; it needs no Bun at runtime:

```sh
~/.dg/bin/dg-skills inbox --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
~/.dg/bin/dg-skills inbox --help
```

If a step fails, run ~/.dg/bin/dg-skills doctor inbox install.

For PowerShell, use the repository's raw bootstrap.ps1. Read [provider setup](references/providers.md)
and [the cleanup workflow](references/workflow.md) before planning changes.

Profiles and OAuth caches use dg-ai's encrypted database. Explicit fixture
datasets work without a daemon, extension, or credentials. Default state lives
under DG_HOME/inbox and remains stable when the working directory changes.

For Proton, use the extension in a signed-in mail tab. Its fixed JavaScript
operations return metadata through the daemon as CLI JSON for the current model.
Reload the tab when asked to observe session headers. Tab/account hints resolve
multiple tabs; cookies and headers stay in page memory. Keep a
`mail.proton.me/u/N` tab open. Do filter and account settings in a separate tab:
if the only mail tab goes to `account.proton.me`, the extension drops the session
and the next inbox call reports that the mail tab navigated away. `inbox status`
names the failed check (no peer, no `/u/N` tab, or missing `x-pm-uid`) without
clearing local decisions.

Inspect existing folders and filters before suggesting routes. Use full paths
or IDs for ambiguous names. Classify redacted groups with the current model;
prefer an adequate inexpensive model for optional classification. Keep unresolved
actionable messages unread and record handled messages' read intent in decisions.

Inspect review and dry-run output before confirming changes under the user's
authorization. Refresh stale plans, reuse compatible filters, preserve unrelated
conditions, and keep account-specific results in a workspace-root results.md.
Local cleanup preserves login metadata; it removes disposable reports and audit
artifacts, so summarize results before cleanup.
