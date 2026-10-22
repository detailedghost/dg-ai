---
name: cleanup
description: Infrastructure hygiene for ~/.claude/ — prune orphan agent-memory dirs, stale skill artifacts, broken references, and migrate merged-agent memories. Proposes new check patterns when run from an installed plugin; saves them only from a source checkout.
---

# Skill: cleanup

User-scoped infrastructure hygiene for `~/.claude/`. Prunes orphan dirs, stale artifacts,
broken references, and migrates merged-agent memories. From a source checkout of this
repo it can also save newly-discovered check patterns back into its own reference files;
from an installed plugin it only proposes them (see "Source checkout vs. installed").

First run: install or refresh the CLI when it is missing or too old. Every later call
uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills stash --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.1/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor stash.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `-m <source:target>` | none | Explicit memory migration (source agent → target agent) | none |
| `--dry-run` | none | Report only, zero writes | off |

**Usage:** `/dg:cleanup [-m source:target] [--dry-run]`

Before starting, read these reference files:
- [references/targets.md](references/targets.md) — directories to scan, stale artifact patterns, cross-reference checks
- [references/checks.md](references/checks.md) — accumulated check-pattern registry (seed content; see "Source checkout vs. installed")
- [references/migrations.md](references/migrations.md) — memory migration protocol

## Source checkout vs. installed

Decide this once per run, then use it in steps 4b and 7:

1. Find this skill's own `SKILL.md` on disk (wherever the bootstrap step above resolved it from).
2. Run `git -C <that dir> rev-parse --show-toplevel`, then `git -C <toplevel> ls-files --error-unmatch plugins/dg/skills/cleanup/SKILL.md`.
3. Both succeed → **source checkout**: `references/checks.md` and `references/migrations.md` are writable; edit them directly.
4. Either fails (no git, or the file is untracked — the normal case for an installed plugin cache, e.g. `~/.claude/plugins/cache/*/dg/*/plugins/dg/skills/cleanup/`) → **installed**: never edit those files. Print proposals instead, and append this run's own findings to `$(~/.dg/bin/dg-skills stash -s -G cleanup history.md)` (append, don't overwrite — this is the user's own running history, outside the plugin).

## Steps

| # | Step | Action | Gate |
|---|------|--------|------|
| 1 | **Load** | Read targets.md + checks.md. Read [../address/references/agents.md](../address/references/agents.md) as canonical roster; strip the `dg:` prefix from each name before comparing. Build expected agent set. | Roster parsed |
| 2 | **Scan memory** | List `~/.claude/agent-memory/`. Flag: empty dirs, dirs not in roster, dirs missing MEMORY.md. | Scan complete |
| 3 | **Scan skills** | List the skill tree (`plugins/dg/skills/*/` from a source checkout, else the installed root resolved above). Flag missing SKILL.md only; for anything deeper (token weight, junk, links, restructure) suggest `/dg:skill-cleanup`. | Scan complete |
| 4 | **Scan references** | Each skill's reference files: detect duplicate entries and stale agent names (roster-based checks only). | Scan complete |
| 4b | **Scan AI stash roots** | Set `DG_DAILY_PRUNE_CMD` to the daily-prune executable that does TTL pruning (add `--dry-run` under `--dry-run`); it also removes merged, clean worktrees and git-ignored `.agents/` files past 30 days. Unset → stop this step and tell the user to set `DG_DAILY_PRUNE_CMD` to their daily-prune executable; never guess a path. Set but not found or not executable → stop with the configured path and a fix line. Otherwise run it, then do only what it skips, per targets.md "AI stash pruning": sweep legacy flat-named files and report the skip-list sizes (`adhoc/`, `skill-cleanup/backups/`) for opt-in. | Scan complete |
| 5 | **Migrate** | If `-m` flag or orphan has viable target: show plan, require user approval, merge MEMORY.md. Follow migrations.md protocol. | Approved or skipped |
| 6 | **Apply** | Delete empty dirs (silent). Remove stale artifacts (silent). Fix duplicates (show diff, confirm). | Changes applied |
| 7 | **Record** | Source checkout: compare actions taken against checks.md and append genuinely new patterns (prune oldest if the file would exceed 60 pattern lines). Installed: print the same proposed patterns instead of writing them, and append this run's findings to the stash history file from "Source checkout vs. installed". | checks.md updated, or proposals printed |
| 8 | **Report** | Summary of all changes. Suggest `/dg:spring-break` if `.agents/school/` detected messy. | Done |

## Ownership

- **Reads** [../address/references/agents.md](../address/references/agents.md) as roster source of truth — never modifies it.
- **Never touches** `.agents/school/` — that is spring-break's domain.
- **Never owns skill quality/token QA** (weight audits, junk files, broken links, restructuring) — that is `/dg:skill-cleanup`'s domain. Step 7 must not re-add such checks.
- **Never modifies** auto-memory content — only validates structure (dir exists, MEMORY.md non-empty).
- **Writes** `references/checks.md` and the non-roster whitelist in `references/targets.md` only from a source checkout; everywhere else it only proposes.
