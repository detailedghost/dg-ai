# 0022 — Keep Proton filters in one declared file

ADR: [docs/adr/0022-proton-filter-policy.md](../../docs/adr/0022-proton-filter-policy.md)

- Declared filters file is user config under `DG_HOME/inbox/workspaces/protonmail/<workspace>/declared-filters.json`. Never commit it.
- Never commit real filter names, folder names, addresses, or a `~/.dg` snapshot. Fixtures stay synthetic.
- `filters import` captures live Proton. `filters sync` is the only Proton filter and folder write path.
- `filters apply`, `filters extend`, `filters consolidate`, `filters group`, and route confirm edit the declared file only.
- Default `filters sync` is a dry run. `--apply` requires the plan hash from that reviewed plan.
- Deletes need per-item `--approve-delete`. `--apply` does not approve deletes.
- Drift needs `--pull` or `--revert` per item. Rename proposals are printed and not applied.
- `policy.safety.protectedPlusAlias` comes from the declared file. Do not hard-code a personal alias.
- Live Proton calls share one serial gate: import, sync reads (including the apply hash re-check), paging, and writes.
- Gaps are mixed and heavy-tailed. Burst budget is 2–5, then an idle break. Never overlap calls.
- Reads retry HTTP 429 twice and a transient error once, then stop. Writes are not retried.
- A failed apply re-reads live Proton, merges only completed steps into the declared file, and persists before rethrow.
- Do not replace the whole observed snapshot on that partial path.
- Recovery also verifies a lost reply for folder create, rename, and delete, filter delete, and reorder.
- Apply filter updates and deletes in descending live chain position, so a guard changes after the rules it covers.
- Filters, consolidate, and group commands resolve every `declared:N` target before they remove any entry.
- A folder rename sends `ParentID` when the parent path is in `foldersByPath`, and `moveToRoot` (Proton `ParentID: null`) for a top-level path. Refuse a create or rename whose parent cannot be resolved, before any write.
- Match filters by Proton id first. Fall back to the name only for a declared entry with no id.
- Do not run inbox tests or sync against live Proton.
