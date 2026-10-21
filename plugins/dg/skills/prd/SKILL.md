---
name: prd
description: Produce a handoff-ready PRD — run /dg:kick to park a fully agent-assigned spec bundle, relocate it to .agents/spec/todo/ (the designated hand-off location), and pre-grant execution permissions, so another agent can /dg:pickup it and run with zero setup.
---

# /dg:prd — Plan → Handoff-Ready PRD

A thin composition of two existing skills. `/dg:prd` is the **handoff** point on the spectrum:

- `/dg:kick` — parks a deferred bundle at `.agents/spec/<NNN>_<slug>/`. Its bundle already has
  `slices[].agents` filled (`/dg:spec` plan mode's own step 3c runs `/dg:assign` unconditionally, before
  the bundle is ever parked) — but it stays at the numbered location and has no execution
  permissions pre-granted, since plain `/dg:kick` assumes the same session (or its author) will
  `/dg:pickup` it later.
- `/dg:prd` — takes that same bundle and relocates it to `.agents/spec/todo/<prd-slug>/` — the
  designated hand-off location — with execution permissions pre-granted, for a *different* agent
  or session to `/dg:pickup` cold.
- `/dg:spec "<request>"` (full run through `/dg:spec -s`) — keeps going into engineering, review, and PR
  in the same session.

`/dg:prd` does not duplicate any pipeline logic — it runs `/dg:kick`, then relocates + grants permissions.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills spec --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.17.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

Usage: `/dg:prd [feature-name]`.

## Arguments

`/dg:prd` passes its argument through verbatim to `/dg:kick` — see `/dg:kick`'s
[references/args.md](../kick/references/args.md) for the authoritative `<feature-name>` semantics.
Don't restate kick's semantics here.

## Workflow

1. **Kick.** Invoke the `/dg:kick` skill with the same argument. It runs `/dg:spec` plan mode (grill-me →
   roundtable → `/dg:assign` → synthesis → plan approval gate → context pack) and parks the resulting bundle
   at `.agents/spec/<NNN>_<slug>/` with `status: deferred`, committed. Capture `<NNN>_<slug>` — that
   is `<prd-slug>` below (the bundle's own `feature_snake_case`, not necessarily the raw
   `<feature-name>` argument verbatim).
2. **Relocate to the hand-off location.**
   `mkdir -p .agents/spec/todo/<prd-slug>/`, then move the bundle's contents in:
   `git mv .agents/spec/<NNN>_<slug>/* .agents/spec/todo/<prd-slug>/` (moves `plan.md`, `initial.md`,
   `roundtable/`, `context.md`, and `prototype/` if present). The now-empty
   `.agents/spec/<NNN>_<slug>/` is left behind — `rmdir` it for cleanliness (git doesn't track empty
   dirs, so this has no effect on history either way).
3. **Assign (defensive re-check).** Invoke `/dg:assign .agents/spec/todo/<prd-slug>/plan.md`. `/dg:kick`'s
   underlying `/dg:spec` plan-mode step 3c already ran `/dg:assign` once before parking, so this is
   normally an idempotent no-op (it skips any slice that already has `agents.primary`) — kept as a
   safety net, not required duplicate work.
4. **Grant permissions (handoff-readiness).** A PRD exists to be `/dg:pickup`'d and run hands-off, so
   settle execution permissions now: list all six keys, ask one yes/no ("Grant all?"); on "No, let
   me choose", fall through to the granular `multiSelect`. Write the resulting six-key
   `permissions:` block via
   `~/.dg/bin/dg-skills spec perms-batch .agents/spec/todo/<prd-slug>/plan.md --grant-all` (or `--from-scratch`
   after writing the granular answers). `/dg:pickup`/`/dg:spec -s` see the block and skip their own
   permission ask, so the handoff runs with zero setup.
5. **Fold the commit.** The relocate + assign + permissions steps edited the just-committed bundle.
   Run `git log -1 --format=%s` and `git status -sb`. If the subject is
   `chore(spec): park <slug> (deferred)` and the commit is not pushed, run
   `git add -f .agents/spec/todo/<prd-slug>/ && git commit --amend --no-edit` so the PRD lands as one
   clean commit. Otherwise make a normal follow-up commit:
   `git add -f .agents/spec/todo/<prd-slug>/ && git commit -m "chore(spec): hand off <prd-slug>"`.
   Use `-f` because `/dg:agent-seed` ignores `.agents/`.

## After Exit

`PRD parked at .agents/spec/todo/<prd-slug>/plan.md — agents assigned, permissions granted. Resume with /dg:pickup.`

## Notes

- `/dg:pickup` needs no special handling for a `/dg:prd` bundle: it scans `.agents/spec/todo/` as one of
  its two candidate sources, renumbers on selection, and hands off to `/dg:spec -s` — which sees a
  fully populated `permissions:` block and skips its own confirmation ask.
- Everything else (slug derivation, prerequisites) is `/dg:kick`'s behavior, unchanged.
