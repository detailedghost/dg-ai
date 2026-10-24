# 0020 — Keep Proton filters in one declared file

ADR: [docs/adr/0020-proton-filter-policy.md](../../docs/adr/0020-proton-filter-policy.md)

- Declared filters file is user config under `DG_HOME/inbox/workspaces/protonmail/<workspace>/declared-filters.json`. Never commit it.
- Never commit real filter names, folder names, addresses, or a `~/.dg` snapshot. Fixtures stay synthetic.
- `filters import` captures live Proton. `filters sync` is the only Proton filter and folder write path.
- `filters apply`, `filters extend`, `filters consolidate`, `filters group`, and route confirm edit the declared file only.
- Default `filters sync` is a dry run. `--apply` requires the plan hash from that reviewed plan.
- Deletes need per-item `--approve-delete`. `--apply` does not approve deletes.
- Drift needs `--pull` or `--revert` per item. Rename proposals are printed and not applied.
- `policy.safety.protectedPlusAlias` comes from the declared file. Do not hard-code a personal alias.
- Do not run inbox tests or sync against live Proton.
