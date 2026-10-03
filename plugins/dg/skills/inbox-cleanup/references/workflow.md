# Cleanup workflow

Use `dg-skills inbox` for every command. Select the account with
`--account-profile <name>` and optionally an explicit `--dir <workspace>`.
Default workspaces live below `${DG_HOME:-~/.dg}/inbox`; switching project
directories does not switch mailboxes. `--data-path <fixture.json>` runs offline.

## Inspect and prepare

```sh
"$DG" inbox load folders --account-profile work
"$DG" inbox load filters --account-profile work
"$DG" inbox probe --folder Inbox --limit 3000 --account-profile work
"$DG" inbox batch --folder Inbox --limit 3000 --account-profile work
"$DG" inbox analyze --by domain --account-profile work
"$DG" inbox sample --limit 10 --account-profile work
```

The collector consumes async generators one page at a time and writes bounded
batches. --workers selects bounded asynchronous writer concurrency (the legacy
name does not mean worker threads); --concurrency is its alias. Message packets redact addresses, phone numbers, and long identifiers;
message IDs are hashed for model-facing decisions. Provider IDs stay private for
the subsequent reviewed operation. Use CLI output and classification.json as model context;
login.json, folder snapshots, and private work-item selector fields can contain
exact account or folder identifiers. Prefer compact output and small samples to
dumping an entire mailbox.

Inspect the saved folder inventory before choosing destinations. Reuse existing
folders and filter names. If names collide, choose the full folder path or ID.
Do not include child folders unless the requested source scope includes them.
Choose routes from the user's categories and the observed mailbox, and keep
unresolved actionable messages unread. Avoid a blanket Archive route or rules
mixing unrelated sender domains without the user's review.

## Decisions and apply

Use the current model to classify redacted groups, then write decisions with
`decide` or the appropriate route-plan commands. Use `suggest` as local decision
support. Optional API classification must be explicitly configured.

```sh
"$DG" inbox decide --domain example.test --action move \
  --target-folder "Finance/Receipts" --mark-read true \
  --reason "Reviewed receipt route" --account-profile work
"$DG" inbox review --account-profile work
"$DG" inbox apply --dry-run --account-profile work
"$DG" inbox apply --confirm --account-profile work
```

Inspect the review and dry-run result, and confirm mutations under the user's
authorization. A confirmed apply requires its matching successful dry run.
Refresh changed decisions or mailbox plans before retrying a stale plan. A
previously applied message should not be mutated again on a repeat run.

## Filters and reports

Run `recommend filters`, inspect suggested names, destinations, and conditions,
then use the provider-supported filter plan/apply workflow. Consolidation must
use the full fresh policy internally; redacted or truncated policy text is
insufficient to rewrite a rule safely. Reuse a compatible existing rule and
preserve unrelated conditions. Subject-aware rules can narrow broad sender
domains; review mailbox-specific suggestions before applying them.

Re-probe the affected folders after changes. Summarize before/after counts,
handled messages, unresolved items, and filter changes in a workspace-local
`results.md`. Keep personal results out of repository README files. `cleanup`
removes snapshots, message files, plans, reports/, and audit/, while preserving
login.json and a workspace-root results.md. Write the summary before cleanup
and inspect its warning before confirming.

## Extension feedback

For Proton, the provider requests fixed JavaScript operations from the extension
in an authenticated mail tab. The daemon matches the request, session, and
selected extension connection, then returns the result to CLI stdout. Treat the
redacted JSON as the tool result for the current model turn. It does not enqueue
a synthetic user chat message.

Missing-tab/header errors give setup or reload guidance. Multiple mail tabs need
an explicit tab/account hint; multiple extension peers need one peer connected
to the selected session. Browser cookies and Proton session headers stay in page
memory. The bridge accepts named operations with bounded arguments.
