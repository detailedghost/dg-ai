---
name: pickup
description: Resume a parked spec bundle under .agents/spec/. Takes an optional NNN prefix or slug substring — otherwise prompts to select among status:deferred bundles (numbered dirs and .agents/spec/todo/). Renumbers todo/ bundles, flips status to in-progress, then implements the plan from plan.md and context.md.
---

# /pickup — Resume a Parked Spec Bundle

Select a parked bundle, mark it in progress, and implement it in this session from `plan.md` and `context.md`.

Implement the bundle in this session from `plan.md` and `context.md`.

## Workflow

1. **Select.** Scan `.agents/spec/` for candidates (`todo/` always qualifies — it only ever holds parked work) and match the argument, or prompt via `AskUserQuestion` with no arg. Discovery and matching rules are in `references/args.md`.
2. **Staleness check.** Follow `references/loading.md`. Compare the bundle's `plan.md` `date` against `git log` activity on its slices' `files` globs. Warn and confirm before proceeding if stale.
3. **Renumber (`todo/` bundles only).** If the selected bundle is `.agents/spec/todo/<slug>/`, choose `<NNN>` as one more than the highest numbered prefix already under `.agents/spec/`, zero-padded to 3 digits, then `git mv .agents/spec/todo/<slug> .agents/spec/<NNN>_<slug>`. A bundle already under `.agents/spec/<NNN>_<slug>/` stays where it is.
4. **Flip status and commit.** Edit `<bundle>/plan.md` frontmatter so `status` is `in-progress`, then commit — unconditionally, not only when step 3 moved something:
   `git add .agents/spec/ && git commit -m "chore(spec): pick up <slug>"`.
   If this is a re-pickup of an already `in-progress` bundle and nothing changed, skip both the edit and the commit.
5. **Implement.** Read `context.md` and `plan.md` only. Work the slices in order. For each slice, edit the named files, run the checks in its "done when" line, and stop on the first failure. When every slice is done, open a pull request and print its URL. `/pickup` does its own work in the current checkout. Do not create a second worktree unless the user asks.

## Routing

| Task | Read |
|---|---|
| Matching an `NNN`-or-substring argument against candidates; no-arg selection prompt | `references/args.md` |
| Staleness-check mechanics | `references/loading.md` |

## General Rules

- Each agent reads only its relevant `.agents/school/` topic file.
- Use TaskCreate/TaskUpdate throughout to track progress.
- Do not skip the staleness confirmation.

## After Exit

Print the pull request URL when the slices land. If a slice check fails, stop and name the slice. Do not claim the bundle is done.
