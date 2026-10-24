# Cleanup workflow

Use `dg-skills inbox` for every command. Select the account with
`--account-profile <name>` and optionally an explicit `--dir <workspace>`.
Default workspaces live below `${DG_HOME:-~/.dg}/inbox`; switching project
directories does not switch mailboxes. `--data-path <fixture.json>` runs offline.

Set `S` to the session id from `dg-agent start` (`--print-session-id` or
`--json` prints it without decoding the bootstrap URL). Pass `--session "$S"`
on each command. That is required when the working directory differs from the
registered session or several sessions exist, which is the usual case for an
agent.

## Inspect and prepare

```sh
~/.dg/bin/dg-skills inbox load folders --account-profile work --session "$S"
~/.dg/bin/dg-skills inbox load filters --account-profile work --session "$S"
~/.dg/bin/dg-skills inbox probe --folder Inbox --limit 3000 --account-profile work --session "$S"
~/.dg/bin/dg-skills inbox batch --folder Inbox --limit 3000 --account-profile work --session "$S"
~/.dg/bin/dg-skills inbox analyze --by domain --account-profile work --session "$S"
~/.dg/bin/dg-skills inbox sample --limit 10 --account-profile work --session "$S"
```

The collector consumes async generators one page at a time and writes bounded
batches. --workers selects bounded asynchronous writer concurrency (the legacy
name does not mean worker threads); --concurrency is its alias. `probe` refreshes
folder totals from the provider when it can. `total` and `unread` are those live
counts. `snapshotTotal` and `snapshotUnread` are the previous `load folders`
counts, with `snapshotAt`. `snapshotStale` is true when they differ or the
refresh failed. `readState` counts only the messages this probe fetched
(`--limit`), so it can disagree with the folder total. Message packets redact addresses, phone numbers, and long identifiers;
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

`suggest` does not mark messages read. It considers `--limit` matching work
items (default 100) starting at `--offset` (default 0) and reports `matched`,
`returned` (`total`), and `remaining`. Raise `--limit` or advance `--offset` to
cover the rest. `--proposal-limit` only caps how many proposals are printed.
Use `decide --mark-read true` when a route should mark messages read. `review`
reports `omitted` decisions it did not count as ready, and `replacedDecisions`
when a later `decide` overwrote an earlier one, so a sum of `written` can be
higher than `readyToMove`.

```sh
~/.dg/bin/dg-skills inbox decide --domain example.test --action move \
  --target-folder "Finance/Receipts" --mark-read true \
  --reason "Reviewed receipt route" --account-profile work --session "$S"
~/.dg/bin/dg-skills inbox review --account-profile work --session "$S"
~/.dg/bin/dg-skills inbox apply --dry-run --account-profile work --session "$S"
~/.dg/bin/dg-skills inbox apply --confirm --account-profile work --session "$S"
```

Inspect the review and dry-run result, and confirm mutations under the user's
authorization. A confirmed apply requires its matching successful dry run.
Refresh changed decisions or mailbox plans before retrying a stale plan. A
previously applied message should not be mutated again on a repeat run.

## Filters and reports

`recommend filters` reads local move decisions, including ones not yet applied,
and writes `plans/filter-recommendations.json`. It does not require `apply`
first. `review` counts every move target; `recommend filters` lists one row per
domain and folder, keeps Archive informational, and marks folders outside the
automatic set as preview-only. `filters apply` reads that recommendations file.

`filters plan` dry-runs by default. It reads `plans/cleanup-policy.json`, or
`--plan-path`. `folders plan-tree`, `labels plan`, `inbox route-plan`,
`cleanup validate`, and `cleanup visualize` read that same policy file. They do
not read `filter-recommendations.json`.

`load filters` stores redacted snippets in `filters.json` (the provider snippet
length, 160 by default), so `conditions` and `actions` can end mid-rule. Each
filter also has `destinations`, the `fileinto` folder paths parsed from the full
rule before that cutoff. That snapshot is not the Proton source of truth.
`filters import` copies live filters and folders into `declared-filters.json`
under the workspace. `filters sync` is the only command that writes filters or
folders back to Proton. See [the filter policy guide](../../../../../docs/inbox-filter-policy.md).

`filters extend --filter-id ID --add-domains domain.example --dry-run` reads the
live Proton Sieve and prints the before/after diff. It refuses any other provider
and any script that is not a full Sieve (`require` and `fileinto`) with an
`address :domain :is "From"` test. `--confirm` records that full script in the
declared filters file and writes an audit file with the filter id, added
domains, and before/after hashes. It does not call Proton.

`filters apply`, `filters consolidate`, `filters group`, and `filters route` also
edit only the declared file on `--confirm`. `filters consolidate` and
`filters group` read the live filter list and only merge filters whose names
were generated by this CLI. Consolidation must use the full fresh policy
internally; redacted or truncated policy text is insufficient to rewrite a rule
safely. Reuse a compatible existing rule and preserve unrelated conditions.
Subject-aware rules can narrow broad sender domains; review mailbox-specific
suggestions before applying them. Run `filters sync --dry-run` before any Proton
write.

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
