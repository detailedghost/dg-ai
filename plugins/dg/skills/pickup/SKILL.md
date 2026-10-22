---
name: pickup
description: Resume a parked spec bundle under .agents/spec/. Takes an optional NNN prefix or slug substring — otherwise prompts to select among status:deferred and status:in-progress bundles (numbered dirs and .agents/spec/todo/). Renumbers todo/ bundles, flips status to in-progress, then hands off to /dg:spec -s to drive engineering.
---

# /dg:pickup — Resume a Parked Spec Bundle

Thin wrapper over `/dg:spec` execute mode. Owns selection and staleness itself (its own logic,
scanning `.agents/spec/`) and, for unnumbered `todo/` bundles, renumbering — then hands off to
`/dg:spec -s <NNN>_<slug>`, which resolves the bundle, sets up its own worktree, and drives `/dg:sdlc`'s
slice-wave.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills spec --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.1/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor spec.

Usage: `/dg:pickup [NNN-or-substring]`.

## Workflow

1. **Select.** Scan `.agents/spec/` for candidates (`todo/` always qualifies — it only ever holds
   parked work) and match the argument, or prompt via `AskUserQuestion` with no arg — exact
   discovery/matching rules in `references/args.md`.
2. **Staleness check.** `references/loading.md` — compare the bundle's `plan.md` `date` against
   `git log` activity on its slices' `files[]` globs; warn and confirm before proceeding if stale.
3. **Renumber (todo/ bundles only).** If the selected bundle is `.agents/spec/todo/<slug>/`:
   `nnn=$(~/.dg/bin/dg-skills spec next-nnn --home .agents/spec)`, then
   `git mv .agents/spec/todo/<slug> .agents/spec/<nnn>_<slug>`. A bundle already under a numbered
   `.agents/spec/<NNN>_<slug>/` dir needs no move.
4. **Flip status + commit.** `~/.dg/bin/dg-skills spec set <bundle>/plan.md status in-progress`, then commit —
   unconditionally, not only when step 3 moved something, and only that bundle, with any `git mv`
   rename already staged:
   `git add -f .agents/spec/<NNN>_<slug>/ && git commit -m "chore(spec): pick up <slug>"`.
   Use `-f` because `/dg:agent-seed` ignores `.agents/`. Do not add other bundles.
   If this is a re-pickup of an already `in-progress` bundle and nothing changed, skip both the
   `set` and the commit (idempotent no-op).
5. **Hand off.** Invoke `/dg:spec -s <NNN>_<slug>`. It reads only `context.md` + `plan.md`, creates its
   own worktree, and drives `/dg:sdlc`'s slice-wave through PR — see
   [`spec/references/execute.md`](../spec/references/execute.md). `/dg:pickup` does no worktree setup
   of its own; that is entirely `/dg:spec -s`'s job.

## Routing

| Task | Read |
|---|---|
| Matching an `NNN`-or-substring argument against candidates; no-arg selection prompt | `references/args.md` |
| Staleness-check mechanics | `references/loading.md` |

## General Rules

- Each agent reads only its relevant `.agents/school/` topic file.
- Use TaskCreate/TaskUpdate throughout to track progress.
- NEVER skip a gate condition — the staleness confirmation here, and every gate `/dg:spec -s` owns
  once handed off.

## After Exit

Handled by `/dg:spec -s` — a PR URL on success, or a stop at whichever `/dg:sdlc` gate wasn't cleared.
