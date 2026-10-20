---
name: kick
description: Defer a feature build — run /spec's full plan-mode pipeline (grill-me, roundtable, spec-write, /viz verify, context pack), flip the resulting bundle's status to deferred, and exit without executing. Use when you want to do the thinking now and the engineering later. Resume with /pickup.
---

# /kick — Plan Now, Build Later

Thin wrapper over `/spec` plan mode. Runs `/spec`'s full plan-mode pipeline
([references/plan.md](../spec/references/plan.md), steps 1–10 — [/grill-me](../grill-me/SKILL.md), scaffold + `/assign`,
per-slice review, synthesis, `/viz` verify, context pack) unmodified, then applies /kick's one
addition: flip the resulting bundle's `status` to `deferred` and commit it, instead of continuing
into execute mode.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills spec --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.16.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

Usage: `/kick [feature-name] [--from <path>]`.

## Routing

| Task | Read |
|---|---|
| How `<feature-name>` folds into the request text passed to `/spec` | `references/args.md` |

## Prerequisite

Verify `.agents/` structure exists (AGENTS.md, `.agents/school/`, `.agents/references/`,
`.agents/paths.md`). If missing, run `/agent-seed` first, then return here.

## Workflow

1. Invoke `/spec "<request>"` (plan mode). See `references/args.md` for how `<feature-name>` (if
   given) folds into `<request>`; if neither is available, `/spec`'s own dispatch rule asks the one
   clarifying question — `/kick` does not duplicate that ask. This runs the full pipeline and ends
   with a bundle at `.agents/spec/<NNN>_<slug>/` (`plan.md` + `context.md`).
2. Capture `<NNN>_<slug>` from the bundle path `/spec` prints at plan.md step 10.
3. `~/.dg/bin/dg-skills spec set .agents/spec/<NNN>_<slug>/plan.md status deferred` — /kick's only deviation from a
   plain `/spec` plan-mode run.
4. Commit the bundle (`/spec` plan mode already committed it at step 10; this second commit is for
   /kick's own `status: deferred` edit, so it can't be lost to a stash/clean):
   `git add -f .agents/spec/<NNN>_<slug>/ && git commit -m "chore(spec): park <slug> (deferred)"`.
   Use `-f` because `/agent-seed` ignores `.agents/`, and a parked bundle must still be committed.
5. Do NOT invoke execute mode. Exit.

## General Rules

- Each agent reads only its relevant `.agents/school/` topic file.
- Use TaskCreate/TaskUpdate throughout to track progress.
- NEVER skip a gate condition — all of `/spec` plan mode's gates apply unchanged.
- Do NOT create commits for anything other than the parked bundle itself (step 4).

## After Exit

`Spec bundle parked at .agents/spec/<NNN>_<slug>/ (status: deferred). Resume with /pickup, or directly via /spec -s <NNN>_<slug>.`
