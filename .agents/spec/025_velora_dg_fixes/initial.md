# Velora dg fixes — Initial Notes

## Purpose
Fix the dg 6.1.0 rough edges found during the Velora release. Verify and prototype capture cannot reach a page behind a sign-in, prototype wait timeouts read as crashes, thrash and address degrade in nested subagents, the stat checklist grows without bound, the ~/.dg/bin notice launchers come back after their removal release, and update hides which doctor checks failed. None of these blocks Velora; each is a small, separately testable fix.

## Scope
### Included
- verify role `state`: load a saved pw state into the capture browser (issue 1)
- prototype: carry --sign-in and a new --state through ui/session waits, and a loud, actionable skipped-fingerprint exit (issue 2)
- prototype wait/await-decision: a 'timeout, still pending' line and a distinct exit code (issue 5)
- thrash and address: a written nested-run rule (no agent tool, or persona not registered) that never skips verify, consolidate, compile or local cleanup (issues 3 and 4 residue)
- stat archive: move done checklist items to an archive file (issue 6)
- bg list --cwd filter, and the stat skill uses it in place of its jq select (issue 9)
- ~/.dg/bin compat launchers: never recreated after removal; stale <name>.version leftovers swept (issue 7)
- update prints each failed doctor check after its summary line (issue 8)
- proto in-app bar: require More versions in hand-rolled bars and document a non-JS endpoint port (item 10)
### Excluded
- pw not finding Brave or Firefox (separate PR in flight)
- db setup and the dg launcher missing after update (bundle 024)
- issue 4 cleanup work: .agents/code-review/ is gitignored since #237 and /dg:address phase 7 already deletes accomplished files
- form fill from a stored credential in verify or prototype (a saved pw state covers it)
- stat archive --before <date> (checklist items carry no timestamp)
- rewriting stale skill copies under ~/.agents/skills or ~/.codex/skills (no dg installer writes them)
- a new one-shot thrash CLI command
