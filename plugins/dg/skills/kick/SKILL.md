---
name: kick
description: Defer a feature build. Interview the request with grill-me, write a parked spec bundle under .agents/spec/, and exit without implementing. Use when you want to do the thinking now and the engineering later. Resume with /pickup.
---

# /kick — Plan Now, Build Later

Plan a feature and park the bundle. Do not implement it.

The planning steps below are the whole workflow. Interview with `/grill-me`, write the bundle, and stop.

## Routing

| Task | Read |
|---|---|
| How `<feature-name>` folds into the request | `references/args.md` |

## Prerequisite

Verify `.agents/` exists (`AGENTS.md`, `.agents/school/`, `.agents/references/`, `.agents/paths.md`). If it is missing, run `/agent-seed` first, then return here.

## Workflow

1. Resolve the request. See `references/args.md`. If no feature name and no request text were given, ask one clarifying question, then continue.
2. Interview the request with `/grill-me`. Keep its decision log. Do not start a separate planning pipeline.
3. Derive `<slug>` from the feature name the interview settled on: lowercase, replace each run of characters outside `a-z` and `0-9` with `_`, then trim leading and trailing underscores.
4. Choose `<NNN>`. List `.agents/spec/` and take one more than the highest `NNN` prefix already there, zero-padded to 3 digits. Start at `001` when none exist. Skip `todo/`.
5. Write `.agents/spec/<NNN>_<slug>/plan.md` and `context.md`.
   - `plan.md` frontmatter: `status: deferred`, `date` (today, `YYYY-MM-DD`), `feature: <slug>`.
   - Body: the decision summary, then `## Slices`. Each slice has a name, the files it touches, and a "done when" check. Name the owning area in the slice text when the repo makes it obvious. Otherwise the implementing agent owns it.
   - `context.md`: one page. Decisions, non-goals, and the slice list. Enough for a later session to implement without this chat.
6. Commit only that bundle:
   `git add .agents/spec/<NNN>_<slug>/ && git commit -m "chore(spec): park <slug> (deferred)"`.
7. Stop. Do not implement the slices.

## General Rules

- Each agent reads only its relevant `.agents/school/` topic file.
- Use TaskCreate/TaskUpdate throughout to track progress.
- Do not skip the interview or the parked commit.
- Do not create commits for anything other than the parked bundle.

## After Exit

`Spec bundle parked at .agents/spec/<NNN>_<slug>/ (status: deferred). Resume with /pickup.`
