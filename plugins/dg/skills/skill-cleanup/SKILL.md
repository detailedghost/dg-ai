---
name: skill-cleanup
description: Audit the dg plugin's skills for token weight and hygiene, apply mechanical fixes, optionally restructure oversized skills into router + references, and optionally sweep for content duplicated between a SKILL.md and its own references/. Use when skills feel bloated, after adding skills, or when asked to slim/audit the skill estate.
---

# Skill: skill-cleanup

Owns skill quality QA (not `/dg:cleanup` — that handles orphan dirs and roster checks). Helper CLI: `~/.dg/bin/dg-skills skill-audit` (detect + mechanical fix) and `~/.dg/bin/dg-skills skill-split` (verbatim section mover).

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills skill-audit --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor skill-audit skill-split stash.

## Usage

**Usage:** `/dg:skill-cleanup [skill-dir ...] [--threshold N] [--dry-run] [--duplicates]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--threshold <N>` | none | Approximate token count an entry point may reach before it is flagged a restructure candidate. | `1500` |
| `--dry-run` | none | Stop after the report; apply no mechanical fixes and run no restructure. | off |
| `--duplicates` | none | Run the opt-in duplicate sweep (step 7) after steps 1-6. | off |

## Steps

| # | Step | Action |
|---|------|--------|
| 1 | Audit | `~/.dg/bin/dg-skills skill-audit <dirs> [--threshold N] --json`. No dirs named → the invocation must name every skill directory to audit (`plugins/dg/skills/*` for the canonical estate). |
| 2 | Report | Summarize per skill: token weight, issues, `[vendor]` labels. `--dry-run` → stop here. |
| 3 | Fix | `~/.dg/bin/dg-skills skill-audit <dirs> --fix` handles mechanical repairs: rename lowercase `skill.md` → `SKILL.md`, delete junk files. Broken links are **not automated** — triage each: ignore if false positive, Edit if a real stale path, note in report if upstream file was removed. |
| 4 | Pick | List restructure candidates (entry points over threshold). Exclude `[vendor]` skills unless explicitly named in the invocation. Ask which to restructure (AskUserQuestion, multiSelect). None → done. |
| 5 | Restructure | Per selected skill, follow `references/protocol.md`. |
| 6 | Verify | Re-run audit on touched skills; report before/after token deltas and backup paths. |
| 7 | Duplicate sweep — **opt-in, `--duplicates`** | Not run by default (costs one subagent call per batch of skills — expensive relative to steps 1-6, which are near-free script calls). When requested — for the touched skills after step 6, for explicitly named skills, or for the whole estate if none are named — follow `references/duplicate-sweep.md`. Same Pick/apply/Verify discipline as steps 4-6: present findings, ask which to fix, apply, re-audit. |

## Rules

- Content moves are **verbatim** (script-enforced) — never paraphrase or drop facts.
- Backups land in `$(~/.dg/bin/dg-skills stash -s -G skill-cleanup backups)/` (auto, per apply). Durable root on purpose: a backup a reboot deleted is not a backup.
- Never touch `.agents/school/` or agent memories — other skills' domains.
- Step 7's fixes are hand-edits, not script-enforced — verify every fact in the trimmed inline text still exists in the reference file before cutting it (fact-by-fact, not "looks similar").
