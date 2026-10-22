# Restructure Protocol (per skill)

Goal: entry point becomes a lean router (<1500 tok, ideally <800); detail lives in `references/`, loaded on demand. The model only decides routing — the script moves all content bytes. (Total tokens will increase slightly post-split — routing rows are additive. That's expected.)

## Steps

1. **Inventory**: `~/.dg/bin/dg-skills skill-split --list <skill-dir>` → JSON of H2 sections with token weights.
2. **Plan keeps**: keep inline only what every invocation needs — usage/args, step table, hard behavioral rules, routing. Everything situational (deep syntax, examples, edge-case catalogs, per-domain guidance) moves.
3. **Plan moves**: group related sections into one reference file each (`references/<topic>.md`); don't create one file per tiny section. Org-specific content goes under `references/<org>/` so generic loads stay clean.
4. **Write manifest** to `$(~/.dg/bin/dg-skills stash -G skill-cleanup <name>-manifest.json)`:
   ```json
   { "skillDir": "/home/user/.claude/skills/foo",
     "moves": [ { "slug": "section-slug", "dest": "references/topic.md" } ] }
   ```
5. **Apply**: `~/.dg/bin/dg-skills skill-split --apply <manifest>`. The command backs up the dir, moves sections verbatim, inserts a placeholder routing table.
6. **Rewrite the router**: replace the placeholder table's Task column with task-oriented triggers ("Debugging X", "Writing Y") — not section titles. Trim any now-redundant intro prose. Do not re-add moved content.
7. **Description check**: if frontmatter description >500 chars, tighten it (it loads every session).
8. **Verify**: `~/.dg/bin/dg-skills skill-audit <skill-dir>` — entry under threshold, no broken links (the router's new paths must resolve). Diff total tokens before/after; total should be ~unchanged (moves, not deletions).

## Cautions

- Multi-entry skills (nested `skill.md` sub-docs): restructure each entry separately; sub-docs are already on-demand, so only split them if they exceed ~4K tok.
- If a section is referenced by path from other files (`grep -r 'SKILL.md#' `), update those references.
- Vendor skills (`[vendor]` label): only when explicitly named; note in the report that upstream updates will need re-merging.
