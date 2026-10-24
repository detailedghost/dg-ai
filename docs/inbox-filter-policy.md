# Proton filter policy

Proton filters and folders have one source of truth: `declared-filters.json` in the workspace directory.

```text
~/.dg/inbox/workspaces/protonmail/<workspace>/declared-filters.json
```

`<workspace>` is the account profile slug. With no profile, the file sits directly under `protonmail/`.
The repository does not contain this file. It ships the schema, the loader, and a synthetic example at
`pkg/inbox/examples/declared-filters.example.json`.

`filters.json` in the same directory is still a redacted inventory. Its Sieve text can stop mid-rule.
Do not treat it as the filter you want Proton to run.

## Import

Import reads the live Proton mailbox and writes the declared file. It keeps the full Sieve script, the
folder paths, and an observed copy of what Proton returned. A later sync uses that copy to tell a local
edit from a change made in the Proton UI.

```sh
~/.dg/bin/dg-skills inbox filters import --account-profile NAME --session "$S"
```

Import refuses to replace an existing file. Pass `--replace` to capture Proton again. `--replace` keeps
the policy block already in the file. Set `policy.safety.protectedPlusAlias` before the first apply.
The pattern is a plus-alias glob from that file, such as `owner+*@example.test`.

## Review

Sync reads the declared file and the live mailbox, then prints a plan. Dry run is the default.

```sh
~/.dg/bin/dg-skills inbox filters sync --dry-run --account-profile NAME --session "$S"
```

Stdout is a redacted summary. The `review` field lists each line. The full plan, including Sieve text,
is written under the workspace at `plans/filter-sync-plan.json`. Copy `planHash` from the summary.

The plan can include these lines:

- `CREATE`, `UPDATE`, `RENAME`, and `REORDER` for filters and folders
- `PULL` and `REVERT` for drift you already chose
- `DRIFT` when Proton and the file disagree and you have not chosen
- `DELETE WITHHELD` when a filter or folder would be removed and you have not approved that item
- `RENAME PROPOSAL` when a name breaks the naming rules
- `BLOCKED` when a safety check refuses the apply

File order is Proton order, top down. `policy.keepFirst` must be the leading names. A reorder shows up
as its own line. A rename proposal is not applied.

## Drift

A filter or folder changed in the Proton UI, and not in the file, is drift. Pass a comma-separated list
of ids or names.

- `--pull` copies the live item into the declared file.
- `--revert` writes the declared version back to Proton.
- An item that exists only in Proton can be pulled, or reverted and deleted. The delete still needs
  `--approve-delete`.

Pull, revert, and delete each change the plan. Run the dry run again and use the new hash.

## Apply

Apply only after you have read the dry run. `--apply` checks that the hash still matches this command,
including the same pull, revert, and delete flags.

```sh
~/.dg/bin/dg-skills inbox filters sync --apply PLAN_HASH --account-profile NAME --session "$S"
```

On a terminal you can use `--confirm` and type `apply`. A non-interactive shell must use `--apply` and
the hash. `--apply` without a hash is refused. `--apply` does not delete anything. Add
`--approve-delete id,name` for each filter or folder you intend to remove, and include those flags in
the dry run that produced the hash.

Sync refuses to apply when any safety check fails:

- `protectedPlusAlias` is missing
- a planned write would file protected plus-alias mail into Spam or Trash
- a planned write would file GitHub, GitLab, or another listed verification sender into Spam or Trash
- a Sieve script looks truncated or redacted
- drift is still unresolved
- `keepFirst` is not the start of the file

GitHub, GitLab, Spam, and Trash stay in force even when the extra lists in the file are empty.
Proton writes are paced with an irregular pause between calls.

## Naming

Plus-address filters use `+Tag`. When a dot-address covers the same tag, the name gains ` & .tag`,
as in `+Family & .family`. Topic filters use `Category - Sub`, as in `Fin - Banking`. Folder paths
are short lowercase slugs, nested as `parent/child`. A capitalized parent such as `Notification`
is allowed only when `policy.naming.folderExceptions` lists it. The slug shape is
`policy.naming.folderSlugPattern`, not a single pattern baked into the command.

The linter suggests renames for names such as `Bot - Archive`, `Notif`, a singular where the folder
is plural, a cut-off subname, and a lowercase plus-tag. Those suggestions stay in the plan until you
edit the declared file yourself.

## Other filter commands

`filters apply`, `filters extend`, `filters consolidate`, `filters group`, and `filters route` edit
the declared file only. They do not call Proton. After one of them changes the file, review it with
`filters sync --dry-run`, then apply with the hash from that review.

## What to check on the first live dry run

Run import, then `filters sync --dry-run`, and read the review before any `--apply`.

- The filter count and the folder count match the mailbox you expect, on the order of sixty filters.
- `keepFirst` filters are still first, and any reorder is one you meant.
- Rename proposals match the naming rules: `+Tag`, `Category - Sub`, and lowercase folder slugs.
- No unexpected `DELETE` or `DELETE WITHHELD` line. A withheld delete stays withheld unless that dry
  run also passed `--approve-delete` for that item.
- Drift is empty, or each drifted item is one you recognize from the Proton UI.
- Safety lists no blocked line. Protected plus-alias mail and verification mail are not aimed at Spam
  or Trash.
- Destinations in the plan are complete folder paths. A redacted or cut-off Sieve script is a blocked
  line, not a quiet update.
- The plan hash you copy into `--apply` is the hash printed for that same command, including any
  `--pull`, `--revert`, or `--approve-delete` flags.
