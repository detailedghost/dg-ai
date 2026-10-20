---
name: sdlc
description: Standalone execution lifecycle for a bare feature brief — worktree, slice derivation, /assign, TDD slice waves (red→green→QA), final review, docs, then a draft PR/MR the human reviews on the provider. `-l`/`--local` falls back to a blocking local /review ahead of the push. Single source of truth for the execution pipeline; /spec and /pickup delegate their execution phases here. No spec prerequisite.
---

# /sdlc — Execution Lifecycle

Run a feature brief through the full build pipeline with no spec prerequisite. `/sdlc` synthesizes a minimal ephemeral spec in scratch, then drives the same slice-wave machinery `/spec` uses for its execution phases.

**This skill owns the execution lifecycle.** The slice-wave workflow, execution templates, and stage references live here; `/spec` and `/pickup` reference them instead of carrying copies. For planning-heavy work (discovery interview, roundtable, durable spec in `.agents/spec/`), route to `/spec`.

Resolve the CLI before using the commands below:

```bash
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.16.0/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

Usage: `/sdlc "<feature brief>" [-T|--no-worktree] [-l|--local]`.

## Arguments

| Flag | Effect |
|---|---|
| `"<feature brief>"` | Required. The feature to build, plain prose. If missing, ask for it (one question) before anything else. |
| `-T`, `--no-worktree` | Opt OUT of worktree mode: run in the current repo. If on the default branch, create `feature/<slug>` first — never build on main. |
| `-l`, `--local` | Review locally ahead of the push: run the blocking `/review` board at step 7, the old pre-PR behaviour. Without it the human reviews on the open PR/MR instead. |

`WORKTREE_MODE = NOT(NO_WORKTREE)`. Worktree is the default, matching `/spec`.

`REVIEW_MODE = local if (-l|--local) else pr`. `pr` is the default. Steps 5–6 gate the code, step 8 opens a **draft** PR/MR, and the human reviews it on the provider after the run ends — `/address` collects the comments in a later session. `-l` restores the old blocking gate, which runs before step 8 pushes anything. Either way step 8 creates the PR/MR through `"$DG" vcs-provider`, so a GitLab remote gets an MR without a second code path.

## Pipeline

| # | Step | Reference |
|---|---|---|
| 1 | Worktree off latest `origin/(main\|master)` | references/setup.md |
| 2 | Derive slices → ephemeral spec in scratch | references/setup.md |
| 3 | `/assign` agents per slice + launch gate (permissions + token estimate) | references/setup.md |
| 4 | Slice waves — per dependency layer: Red → Yellow → Green → MiniQA; commit per slice | references/engineering.md |
| 5 | Final review + bounded correction; commit fixes | references/finish.md |
| 6 | Test-name gate, then docs (lore); commit docs | references/finish.md |
| 7 | Human review gate — `pr` mode: skipped (the review moves to the PR/MR). `local` mode: BLOCKING `/review` | references/finish.md |
| 8 | Push + `"$DG" vcs-provider create-pr` (draft in `pr` mode) | references/finish.md |

Follow steps strictly in order. NEVER skip a gate condition.

## Reference files (lazy-load)

| File | When to read |
|---|---|
| [references/setup.md](references/setup.md) | Steps 1–3. Drop after the launch gate. |
| [references/engineering.md](references/engineering.md) | Step 4 only. |
| [references/finish.md](references/finish.md) | Steps 5–8. Load after the last wave. |
| [references/agents.md](references/agents.md) | Whenever launching agents — common directives, scoped reading, notes protocol, output formats. |
| [references/templates/](references/templates/) | One file per launch — load only what the current stage needs. |

## Ephemeral spec (the input bridge)

`/sdlc` takes a bare brief, but the slice-wave workflow reads each slice's agents out of `slices[]` frontmatter, so the picks have to land on disk — which is why step 3 needs `/assign`'s spec-annotation mode, not a bare recommendation. Step 2 synthesizes a throwaway spec at `$("$DG" stash -s sdlc <slug>.md)` carrying just enough structure for those tools to bite on. It is scratch, never a deliverable:

- NEVER write it into `.agents/spec/` (durable specs stay `/spec`'s job) or anywhere inside an installed skills directory.
- No cleanup step needed — `/cleanup`'s 30-day state TTL walker prunes it when stale.

## General rules

- Use TaskCreate/TaskUpdate to track pipeline steps.
- **Commit per slice, not per feature** (Conventional Commits, scope required).
- Agents read their `.agents/school/` topic file when it exists — `/sdlc` has no `.agents/` prerequisite; missing files are skipped.
- Any agent deferral (`SPEC`/`TEST`/`CRITICAL`) pauses the pipeline for user resolution — see engineering.md post-processing.
