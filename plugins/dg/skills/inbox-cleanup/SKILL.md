---
name: inbox-cleanup
description: Review and clean Proton Mail, Gmail, or Outlook through dg-skills, with redacted message batches, existing-folder routing, and reviewed mailbox changes.
---

# Inbox cleanup

The default executable is ~/.dg/bin/dg-skills; DG_HOME overrides its home.
Bootstrap the installed compiled CLI once; it needs no Bun at runtime:

```sh
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
"$DG" inbox --help
```

For PowerShell, use the bundled bootstrap.ps1 through CLAUDE_PLUGIN_ROOT or
the repository's raw bootstrap.ps1. Read [provider setup](references/providers.md)
and [the cleanup workflow](references/workflow.md) before planning changes.

Profiles and OAuth caches use dg-ai's encrypted database. Explicit fixture
datasets work without a daemon, extension, or credentials. Default state lives
under DG_HOME/inbox and remains stable when the working directory changes.

For Proton, use the extension in a signed-in mail tab. Its fixed JavaScript
operations return metadata through the daemon as CLI JSON for the current model.
Reload the tab when asked to observe session headers. Tab/account hints resolve
multiple tabs; cookies and headers stay in page memory.

Inspect existing folders and filters before suggesting routes. Use full paths
or IDs for ambiguous names. Classify redacted groups with the current model;
prefer an adequate inexpensive model for optional classification. Keep unresolved
actionable messages unread and record handled messages' read intent in decisions.

Inspect review and dry-run output before confirming changes under the user's
authorization. Refresh stale plans, reuse compatible filters, preserve unrelated
conditions, and keep account-specific results in a workspace-root results.md.
Local cleanup preserves login metadata; it removes disposable reports and audit
artifacts, so summarize results before cleanup.
