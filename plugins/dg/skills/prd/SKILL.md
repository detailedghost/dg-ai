---
name: prd
description: Produce a handoff-ready PRD. Run /kick to park a spec bundle, relocate it to .agents/spec/todo/, and record what the next agent may do, so another agent can /pickup it and run with zero setup.
---

# /prd — Plan → Handoff-Ready PRD

`/prd` is the handoff point:

- `/kick` parks a deferred bundle at `.agents/spec/<NNN>_<slug>/` for the same session (or its author) to `/pickup` later.
- `/prd` moves that bundle to `.agents/spec/todo/<prd-slug>/`, the hand-off location, and records what the next agent may do.

`/prd` does not run a second planner. It runs `/kick`, then relocates the bundle and writes the permission note.

## Arguments

`/prd` passes its argument through verbatim to `/kick`. See `/kick`'s `references/args.md`.

## Workflow

1. **Kick.** Invoke `/kick` with the same argument. It interviews the request and parks `.agents/spec/<NNN>_<slug>/` with `status: deferred`, committed. `<prd-slug>` is that bundle's slug.
2. **Relocate.** `mkdir -p .agents/spec/todo/<prd-slug>/`, then
   `git mv .agents/spec/<NNN>_<slug>/* .agents/spec/todo/<prd-slug>/`
   (moves `plan.md`, `context.md`, and any other files the bundle has). `rmdir` the emptied numbered directory.
3. **Owner.** If a slice does not name an owner, write "implementing agent" on that slice in `plan.md`. Do not call out to another skill to assign owners.
4. **Permissions.** Ask once: "May the next agent edit the repo, run tests, and open a pull request?" Record the answer under `## Permissions` in `plan.md`. `/pickup` reads that section at its permissions step and does not ask again.
5. **Fold the commit.** Run `git log -1 --format=%s` and `git status -sb`. If the subject is `chore(spec): park <slug> (deferred)` and the commit is not pushed, run `git add -f .agents/spec/todo/<prd-slug>/ && git commit --amend --no-edit` so the PRD is one commit. Otherwise make a normal follow-up commit: `git add -f .agents/spec/todo/<prd-slug>/ && git commit -m "chore(spec): hand off <prd-slug>"`.

## After Exit

`PRD parked at .agents/spec/todo/<prd-slug>/plan.md. Resume with /pickup.`

## Notes

- `/pickup` already scans `.agents/spec/todo/`, renumbers on selection, and implements `plan.md`.
- Slug derivation and prerequisites stay with `/kick`.
