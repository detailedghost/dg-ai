# Inbox cleanup

Review Proton Mail, Gmail, or Outlook with /dg:inbox-cleanup in Claude Code or
$dg:inbox-cleanup in Codex. The compiled dg inbox CLI prepares redacted
samples, supports bounded generator paging, and requires review/dry-run before
confirmed mailbox changes. Proton runs locally through a pw-managed profile: run
`dg inbox proton sign-in` once, then inbox commands use the profile
headless. Pass `--ext` to use extension JavaScript in a signed-in mail tab
instead. Gmail/Outlook use OAuth and profiles in dg-ai's encrypted database.

Read [provider setup](../plugins/dg/skills/inbox-cleanup/references/providers.md) and
[the workflow](../plugins/dg/skills/inbox-cleanup/references/workflow.md). Proton
filter and folder writes go through [the filter policy](inbox-filter-policy.md).
Live-account authentication and mutations need validation in your provider/browser setup.

For a fixture-only install, see [CLI-only installation](install.md#cli-only-install).
Live provider profiles need the daemon; [the credential ADR](adr/0006-credential-store.md)
describes the separate service credential store.

## Settings

Inbox settings live in the `[inbox]` table of `config.toml`, with the same names
the old `organizer.config.json` used, for example:

```toml
[inbox.classifier]
mode = "rules-only"

[inbox.gmail]
pageSize = 50
clientSecret = { credential = "dg-config/inbox-gmail-client-secret" }
```

An env var such as `CLASSIFIER_MODE` wins over the file, and `--config <file>`
wins over both. A client secret is a credential reference, never a value. The
first `dg-skills` command after the upgrade moves `organizer.config.json` into
`config.toml` and its client secrets into the credential store, and keeps a
`organizer.config.json.pre-toml` backup. Route profiles, mappings and security
files stay in the inbox config folder. See [configuration](config.md).
