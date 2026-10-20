# Steps 1–3 — Worktree, Ephemeral Spec, Assignment & Launch Gate

## Step 1 — Worktree (default ON)

Derive `slug` from the brief: a 2–5 word snake_case working title. The helper re-normalizes (`[^a-z0-9]+ → _`, lowercase) — passing pre-slugified is harmless.

**If `-T`/`--no-worktree`:** skip the worktree. If the current branch is the repo default, `git switch -c feature/<slug>` — never build on main. Otherwise stay on the current branch.

```sh
eval "$(~/.dg/bin/dg-skills worktree create "$slug")"
# binds WORKTREE_PATH, WORKTREE_BRANCH, WORKTREE_ORIGIN — branch feature/<slug> off latest origin/(main|master)
```

The session does not relocate into the worktree — `EnterWorktree({path: <WORKTREE_PATH>})` looks
like the tool for that, but it refuses this path: its `path` form only accepts a worktree registered
under `<repo>/.claude/worktrees/`, and `~/.dg/bin/dg-skills worktree create` places its worktrees at
`$HOME/code/worktrees/<repo>-<slug>` (or a sibling of origin) instead. Being a real linked worktree
(`git worktree list` shows it) is not what `EnterWorktree` checks — the location is, and this fails
it. Full detail, including the verbatim refusal, is in the [worktree skill](../../worktree/SKILL.md)'s
"Working in the worktree" section.

The session stays at the launch directory for the rest of this run. Every command from here on that
needs to touch the worktree — git commands, file edits, test/build commands — carries its own
`cd "$WORKTREE_PATH" && …` prefix, in the same call. The shell's cwd does not persist between tool
calls, so there is no "cd once and stay." `ExitWorktree` has no role here either: it only undoes an
`EnterWorktree` *this session* performed, and this session never does, so calling it is a documented
no-op (see `finish.md` step 8d).

The helper owns all mechanics — path layout, branch naming, env-file seeding, permissive resume (re-running `/dg:sdlc` with the same slug resumes the worktree silently), dirty-state warnings. Full surface: [worktree skill](../../worktree/SKILL.md).

> **GATE:** worktree exists, branch checked out, `WORKTREE_PATH` bound (or `-T`: on a non-default branch).

## Step 2 — Derive slices → ephemeral spec

Compute paths from the launch directory — `git worktree list` returns the same result regardless of
which of the repo's worktrees it runs from, so this needs no `cd`. These go to the **durable** root
keyed by the main worktree: for a
bare `/dg:sdlc` run this ephemeral spec is the only record of `worktree.path`, so losing it to a
reboot orphans the worktree, and the origin repo must resolve the same path to clean it up.

```sh
SPEC_PATH="$(~/.dg/bin/dg-skills stash -s sdlc <slug>.md)"; SCRATCH_PATH="$(~/.dg/bin/dg-skills stash -s sdlc <slug>-scratch.md)"; touch "$SCRATCH_PATH"
```

If `SPEC_PATH` already exists with `status: in-progress` (a resumed run), skip derivation — read it, report which slices are already committed, and continue from step 3 or 4 as appropriate.

**Slice derivation — one foreman pass.** Launch `foreman` (`fable`, xhigh effort) in **Slice plan** mode, briefed with the brief plus instructions to scan the repo for the modules/conventions the feature touches. It returns a slice plan; it does NOT write files. Relay any `⚑ RATIFY` items before you write the spec. Rules for the plan:

- **Default to ONE slice.** Split only when the work has clearly separable vertical slices; when unsure, don't split.
- Per slice: `id` (1-based), `name` (kebab), a 2–4 sentence brief, `files` (globs the slice owns), `depends_on` (slice ids), an Engineering checklist, and Testing Criteria opening with `### Contracts` (inputs, outputs, error shapes).
- Slices in the same dependency layer MUST touch disjoint files — they build in parallel in one working tree. If two dependency-ready slices may overlap, chain them via `depends_on`.

**Write the ephemeral spec** (the orchestrator writes it, from the returned plan):

```markdown
---
feature: <slug>
date: <YYYY-MM-DD>
version: "1.0"
status: in-progress
current_slice: 0
pr_strategy: single
worktree:                  # WORKTREE_MODE only — omit with -T
  path: <WORKTREE_PATH>
  branch: <WORKTREE_BRANCH>
  origin_repo: <WORKTREE_ORIGIN>
  pr_url: ""
origin_repo: <PWD>         # -T mode only
permissions: {}            # filled at step 3
slices:
  - id: 1
    name: <name>
    depends_on: []
    files: ["<glob>"]
    agents: {}
---
# <feature> — /dg:sdlc run

## Purpose
<the brief verbatim, plus a one-paragraph derived scope>

### Slice 1 — <name>
<slice brief>

#### Engineering
- [ ] <implementation checklist>

#### Testing Criteria
##### Contracts
<inputs, outputs, error shapes>
- [ ] <test criteria checkboxes>

## Slice Summaries

## Agent Notes

## Issues Remediation
```

Frontmatter keys follow the shared schema ([`spec-schema/frontmatter-schema.yaml`](../../spec/spec-schema/frontmatter-schema.yaml)) so `/dg:assign` and `~/.dg/bin/dg-skills spec get` work unchanged on the scratch file.

> **GATE:** spec written to scratch; frontmatter parses; `slices[]` non-empty.

## Step 3 — /dg:assign + launch gate

Invoke the **`/dg:assign` skill** on `$SPEC_PATH` — it reads the live roster and fills `slices[].agents` (primary, optional qa/effort/proxy) in the frontmatter. Do not reimplement its pick logic. Pass the path, not a prose brief: an existing file is what selects `/dg:assign`'s spec-annotation mode, and only that mode writes the picks back for the slice-wave workflow to read.

Then present ONE `AskUserQuestion` — the only human gate before step 7's review:

- Show the slice plan: names, dependency layers, assigned agents.
- Show a rough token estimate: each slice runs Red + Yellow + Green + wave (+ per-slice `qa[]`) ≈ 5–8 agent calls, mostly sonnet-tier; correction rounds add more. Flag anything token-heavy per the global token-cost gate.
- Ask to grant the run-unattended permission set (same keys as `/dg:spec`, all-or-choose): `run_commands`, `git_push`, `gh_pr_create`, `auto_cleanup_worktree`, `slice_commits`, `housekeeping_commit`. Write the granted booleans into the spec's `permissions:` block.

The waves run unattended — a permission not granted here means a mid-run prompt.

Decline → stop cleanly: worktree + ephemeral spec are retained; re-running `/dg:sdlc` with the same slug resumes.

> **GATE:** every slice has `agents.primary`, permissions explicit, user approved launch.
