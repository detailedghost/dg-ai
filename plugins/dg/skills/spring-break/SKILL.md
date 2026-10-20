---
name: spring-break
description: Clean up and consolidate .agents/school/ into the standard topic-cluster format. Run once per project to migrate, or periodically to prune stale entries. Janitor skill — call when school files get messy, overgrown, or after long spec runs.
---

# Skill: Spring Break

Janitor skill for `.agents/school/`. Migrates scattered files into the standard topic-cluster format, deduplicates entries, prunes to line limits. Safe to run multiple times — idempotent.

**When to suggest running:** If a spec implementation or long-running job is burning through tokens or the context window is getting heavy, ask the user if they want to run spring-break first, clear context, and start fresh.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills spec --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.16.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

Before starting, read [references/structure.md](references/structure.md) for the target layout, file format, and old-to-new mapping.

## Ownership Model

- **spring-break** owns the *structure*: which files exist, naming, format rules, line limits, dedup, pruning.
- **Any agent** may *write learnings* to school files, as long as they follow the format in each file's header comment.
- spring-break never *modifies* `.agents/monolith.md` — that belongs to `/dg:monolith`. It only *reports* on staleness (see Step 7).
- Protected files it never touches, and `.agents/spec/`'s migration-only scope: `references/structure.md`'s "Protected Files" table and Migration Rules.

## Steps

| # | Step | Action |
|---|------|--------|
| 1 | **Scan** | List `.agents/school/` files and legacy spec artifacts under `.agents/create-specs/`/`.agents/todo/`. If none found and already clean, stop. |
| 2 | **Migrate Spec Artifacts** | For each `.agents/create-specs/<NNN>_<slug>.md`, create `.agents/spec/<NNN>_<slug>/` and move the file to `plan.md` (preserve `NNN`). Normalize legacy quirks so it validates (see structure.md), run `~/.dg/bin/dg-skills spec validate <bundle>/plan.md` and carry any remaining violations to Step 6, then run `~/.dg/bin/dg-skills spec context <bundle>` to synthesize `context.md`. Migrate `.agents/todo/<NNN>_<slug>.md` → `.agents/spec/todo/<slug>/`. Skip any bundle that already exists at the target path — idempotent. |
| 3 | **Merge Learnings** | Route entries from old files to topic files using mapping table. Dedup, prune to 100 lines max. Drop entries referencing the retired `/create-spec` workflow. |
| 4 | **Merge Deps** | Combine deps files into DEPS.md (recurring issues + last 3 runs, 80 lines max). Skip if none. |
| 5 | **Write & Clean** | Write topic files, delete old files and empty subdirs. |
| 6 | **Report** | Summarize: files migrated, entries merged/pruned, files deleted, spec bundles migrated, any unresolved `plan.md` validation violations from Step 2. |
| 7 | **Monolith health check** | If `.agents/monolith.md` exists, run `~/.dg/bin/dg-skills monolith prune .agents/monolith.md --dry-run` to list entries whose `_src:_` path no longer exists. If `.agents/school/monolith-conflicts.md` exists, count its entries. Surface both in the report and suggest the user run `/dg:monolith --prune` and review the conflicts log. Do NOT auto-modify monolith.md. |
