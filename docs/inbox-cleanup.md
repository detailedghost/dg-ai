# Inbox cleanup

Review Proton Mail, Gmail, or Outlook with /dg:inbox-cleanup in Claude Code or
$dg:inbox-cleanup in Codex. The compiled dg-skills inbox CLI prepares redacted
samples, supports bounded generator paging, and requires review/dry-run before
confirmed mailbox changes. Proton uses extension JavaScript in a signed-in mail
tab; Gmail/Outlook use OAuth and profiles in dg-ai's encrypted database.

Read [provider setup](../plugins/dg/skills/inbox-cleanup/references/providers.md) and
[the workflow](../plugins/dg/skills/inbox-cleanup/references/workflow.md). Proton
filter and folder writes go through [the filter policy](inbox-filter-policy.md).
Live-account authentication and mutations need validation in your provider/browser setup.

For a fixture-only install, see [CLI-only installation](install.md#cli-only-install).
Live provider profiles need the daemon; [the credential ADR](adr/0006-credential-store.md)
describes the separate service credential store.
