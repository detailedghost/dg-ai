---
name: sdlc
description: Standalone execution lifecycle for a bare feature brief — worktree, slice derivation, /dg:assign, TDD slice waves (red→green→QA), final review, docs, then a draft PR/MR the human reviews on the provider. Single source of truth for the execution pipeline; /dg:spec and /dg:pickup delegate their execution phases here. No spec prerequisite.
---

# /dg:sdlc — Execution Lifecycle

Run a feature brief through the full build pipeline with no spec prerequisite. `/dg:sdlc` synthesizes a minimal ephemeral spec in scratch, then drives the same slice-wave machinery `/dg:spec` uses for its execution phases.

**This skill owns the execution lifecycle.** The slice-wave workflow, execution templates, and stage references live here; `/dg:spec` and `/dg:pickup` reference them instead of carrying copies. For planning-heavy work (discovery interview, roundtable, durable spec in `.agents/spec/`), route to `/dg:spec`.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills worktree --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor batch-open chain proxy spec stash vcs-provider worktree.

**Usage:** `/dg:sdlc "<feature brief>" [-T|--no-worktree]`.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `"<feature brief>"` | none | Required. The feature to build, plain prose. If missing, ask for it (one question) before anything else. | none |
| `--no-worktree` | `-T` | Opt out of worktree mode: run in the current repo. If on the default branch, create `feature/<slug>` first, never build on main. | off (worktree) |

`WORKTREE_MODE = NOT(NO_WORKTREE)`. Worktree is the default, matching `/dg:spec`.

Steps 5–6 gate the code, step 8 opens a **draft** PR/MR, and the human reviews it on the provider after the run ends — `/dg:address` collects the comments in a later session. Step 8 creates the PR/MR through `~/.dg/bin/dg-skills vcs-provider`, so a GitLab remote gets an MR without a second code path.

## Pipeline

| # | Step | Reference |
|---|---|---|
| 1 | Worktree off latest `origin/(main\|master)` | references/setup.md |
| 2 | Derive slices → ephemeral spec in scratch | references/setup.md |
| 3 | `/dg:assign` agents per slice + launch gate (permissions + token estimate) | references/setup.md |
| 4 | Slice waves — per dependency layer: Red → Yellow → Green → MiniQA; commit per slice | references/engineering.md |
| 5 | Final review + bounded correction; commit fixes | references/finish.md |
| 6 | Test-name gate, then docs (lore); commit docs | references/finish.md |
| 7 | Human review moves to the PR/MR — no blocking gate | references/finish.md |
| 8 | Push + `~/.dg/bin/dg-skills vcs-provider create-pr` (always draft) | references/finish.md |

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

`/dg:sdlc` takes a bare brief, but the slice-wave workflow reads each slice's agents out of `slices[]` frontmatter, so the picks have to land on disk — which is why step 3 needs `/dg:assign`'s spec-annotation mode, not a bare recommendation. Step 2 synthesizes a throwaway spec at `$(~/.dg/bin/dg-skills stash -s sdlc <slug>.md)` carrying just enough structure for those tools to bite on. It is scratch, never a deliverable:

- NEVER write it into `.agents/spec/` (durable specs stay `/dg:spec`'s job) or anywhere inside an installed skills directory.
- No cleanup step needed — `/cleanup`'s 30-day state TTL walker prunes it when stale.

## General rules

- Use TaskCreate/TaskUpdate to track pipeline steps.
- **Commit per slice, not per feature** (Conventional Commits, scope required).
- Agents read their `.agents/school/` topic file when it exists — `/dg:sdlc` has no `.agents/` prerequisite; missing files are skipped.
- Any agent deferral (`SPEC`/`TEST`/`CRITICAL`) pauses the pipeline for user resolution — see engineering.md post-processing.
