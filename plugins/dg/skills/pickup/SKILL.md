---
name: pickup
description: Resume a parked spec bundle under .agents/spec/. Takes an optional NNN prefix or slug substring — otherwise prompts to select among status:deferred and status:in-progress bundles (numbered dirs and .agents/spec/todo/). Renumbers todo/ bundles, flips status to in-progress, then hands off to /spec -s to drive engineering.
---

# /pickup — Resume a Parked Spec Bundle

Thin wrapper over `/spec` execute mode. Owns selection and staleness itself (its own logic,
scanning `.agents/spec/`) and, for unnumbered `todo/` bundles, renumbering — then hands off to
`/spec -s <NNN>_<slug>`, which resolves the bundle, sets up its own worktree, and drives `/sdlc`'s
slice-wave.

Resolve the CLI before using the commands below:

```bash
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.15.0/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

Usage: `/pickup [NNN-or-substring]`.

## Workflow

1. **Select.** Scan `.agents/spec/` for candidates (`todo/` always qualifies — it only ever holds
   parked work) and match the argument, or prompt via `AskUserQuestion` with no arg — exact
   discovery/matching rules in `references/args.md`.
2. **Staleness check.** `references/loading.md` — compare the bundle's `plan.md` `date` against
   `git log` activity on its slices' `files[]` globs; warn and confirm before proceeding if stale.
3. **Renumber (todo/ bundles only).** If the selected bundle is `.agents/spec/todo/<slug>/`:
   `nnn=$("$DG" spec next-nnn --home .agents/spec)`, then
   `git mv .agents/spec/todo/<slug> .agents/spec/<nnn>_<slug>`. A bundle already under a numbered
   `.agents/spec/<NNN>_<slug>/` dir needs no move.
4. **Flip status + commit.** `"$DG" spec set <bundle>/plan.md status in-progress`, then commit —
   unconditionally, not only when step 3 moved something, and only that bundle, with any `git mv`
   rename already staged:
   `git add -f .agents/spec/<NNN>_<slug>/ && git commit -m "chore(spec): pick up <slug>"`.
   Use `-f` because `/agent-seed` ignores `.agents/`. Do not add other bundles.
   If this is a re-pickup of an already `in-progress` bundle and nothing changed, skip both the
   `set` and the commit (idempotent no-op).
5. **Hand off.** Invoke `/spec -s <NNN>_<slug>`. It reads only `context.md` + `plan.md`, creates its
   own worktree, and drives `/sdlc`'s slice-wave through PR — see
   [`spec/references/execute.md`](../spec/references/execute.md). `/pickup` does no worktree setup
   of its own; that is entirely `/spec -s`'s job.

## Routing

| Task | Read |
|---|---|
| Matching an `NNN`-or-substring argument against candidates; no-arg selection prompt | `references/args.md` |
| Staleness-check mechanics | `references/loading.md` |

## General Rules

- Each agent reads only its relevant `.agents/school/` topic file.
- Use TaskCreate/TaskUpdate throughout to track progress.
- NEVER skip a gate condition — the staleness confirmation here, and every gate `/spec -s` owns
  once handed off.

## After Exit

Handled by `/spec -s` — a PR URL on success, or a stop at whichever `/sdlc` gate wasn't cleared.
