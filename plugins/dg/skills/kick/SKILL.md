---
name: kick
description: Defer a feature build — run /spec's full plan-mode pipeline (grill-me, roundtable, spec-write, /viz verify, context pack), flip the resulting bundle's status to deferred, and exit without executing. Use when you want to do the thinking now and the engineering later. Resume with /pickup.
---

# /kick — Plan Now, Build Later

Thin wrapper over `/spec` plan mode. Runs `/spec`'s full plan-mode pipeline
([references/plan.md](../spec/references/plan.md), steps 1–10 — grill-me, scaffold + `/assign`,
per-slice review, synthesis, `/viz` verify, context pack) unmodified, then applies /kick's one
addition: flip the resulting bundle's `status` to `deferred` and commit it, instead of continuing
into execute mode.

Equivalent to the retired `/create-spec --later`.

## Routing

| Task | Read |
|---|---|
| How `<feature-name>` folds into the request text passed to `/spec` | `references/args.md` |

## Prerequisite

Verify `.agents/` structure exists (AGENTS.md, `.agents/school/`, `.agents/references/`,
`.agents/paths.md`). If missing, run `/agent-seed` first, then `/compact` and return here.

## Workflow

1. Invoke `/spec "<request>"` (plan mode). See `references/args.md` for how `<feature-name>` (if
   given) folds into `<request>`; if neither is available, `/spec`'s own dispatch rule asks the one
   clarifying question — `/kick` does not duplicate that ask. This runs the full pipeline and ends
   with a bundle at `.agents/spec/<NNN>_<slug>/` (`plan.md` + `context.md`).
2. Capture `<NNN>_<slug>` from the bundle path `/spec` prints at plan.md step 10.
3. `spec-cli set .agents/spec/<NNN>_<slug>/plan.md status deferred` — /kick's only deviation from a
   plain `/spec` plan-mode run.
4. Commit the bundle (`/spec` plan mode already committed it at step 10; this second commit is for
   /kick's own `status: deferred` edit, so it can't be lost to a stash/clean):
   `git add .agents/spec/<NNN>_<slug>/ && git commit -m "chore(spec): park <slug> (deferred)"`.
5. Do NOT invoke execute mode. Exit.

## General Rules

- Each agent reads only its relevant `.agents/school/` topic file.
- Use TaskCreate/TaskUpdate throughout to track progress.
- NEVER skip a gate condition — all of `/spec` plan mode's gates apply unchanged.
- Do NOT create commits for anything other than the parked bundle itself (step 4).

## After Exit

`Spec bundle parked at .agents/spec/<NNN>_<slug>/ (status: deferred). Resume with /pickup, or directly via /spec -s <NNN>_<slug>.`
