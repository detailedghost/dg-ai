# Fast Mode — the `--fast` contract

One chat, one gate. Fast mode collapses plan mode's four grill passes into one, drops every
fan-out, uses **built-in Claude plan mode** as its one approval gate, and then builds the slices
**sequentially in the main loop** — compacting between them instead of spending a subagent wave per
slice. The bundle is still durable, so a fast run is resumable with `/dg:spec -s` if it is interrupted.

`FAST_MODE = HAS(--fast | -f)`. Mutually exclusive with `-s` — if both are present, stop and ask
which the user meant. `NO_WORKTREE = HAS(-T | --no-worktree)`, valid **only** alongside `--fast`.

## F1 — Enter built-in plan mode

Call `EnterPlanMode` before any research. Steps F2–F4 all happen inside it. This is not decoration:
plan mode blocks file writes, which is the guardrail that stops a fast run from scaffolding a
bundle the user has not seen yet.

> **GATE:** session is in plan mode.

## F2 — One grill pass, in the main loop

Run the grill-me protocol once (inlined per [grill.md](grill.md)), scoped to all three of full plan
mode's planning topics at once:

1. **Placement** — where the feature sits, integration points, risk areas (full mode's pass 1).
2. **Code surface** — shared types, module/file homes, error conventions, reuse-vs-new (pass 1.5).
   Apply that pass's self-collapse rule: nothing contested → say so in one line and move on.
3. **Ordering** — slice boundaries, `depends_on` graph, acceptance-criteria gaps (pass 2).

Interview in the main loop; delegate only research legs, and only when the request needs
reconnaissance a few `Read`/`grep` calls cannot cover. There is no `dg:arch`/`dg:foreman` persona hop
in fast mode — that tiering is what full plan mode buys and fast mode trades away.

Converge on one branch list covering all three topics. Fast mode has no pass 3, so a branch left
`[OPEN]` here is never revisited by a later pass.

> **GATE:** zero `[OPEN]`, every `[ASSUMED]` confirmed, across all three topics.

## F3 — Write the plan file

Write the plan into the plan file named in the plan-mode system message. It must carry everything
the bundle will, so that approving it is approving the real artifact:

- `feature` name + `<slug>` (via `~/.dg/bin/dg-skills spec slugify`).
- Purpose (2–4 sentences) and scope, in and out.
- Per slice: `id`, `name`, `depends_on`, `files` globs, the Engineering checklist, Testing Criteria
  opening with `### Contracts` (inputs, outputs, error shapes), and Acceptance items.
- Any surviving code-structure decisions from F2 topic 2.
- The token/context cost estimate, per the global token-cost gate.
- **The permission set, spelled out in plain words** — `run_commands`, `git_push`, `gh_pr_create`,
  `auto_cleanup_worktree`, `slice_commits`, `housekeeping_commit`. Fast mode folds `/dg:sdlc` setup.md
  Step 3's separate permission prompt into this one gate, so approval **is** the grant. If the plan
  file does not list them, that fold has not happened and you must ask separately at F6.

## F4 — `ExitPlanMode` — the only gate before code

`ExitPlanMode` is fast mode's approval gate. It **replaces** plan.md step 8 entirely.

Rejection or requested changes → stay in plan mode, revise the plan file, exit again. Never
scaffold against an unapproved plan.

> **GATE:** plan approved via `ExitPlanMode`.

## F5 — Scaffold the bundle (launch checkout, before any worktree)

- a. Author the decision blob yourself — shape LOCKED, per [decision-blob.md](decision-blob.md) —
  and write it to `$(~/.dg/bin/dg-skills stash -s spec <slug>-blob.json)`. Full mode routes
  this through foreman; fast mode does not, since F2's log is already yours.
- a2. `~/.dg/bin/dg-skills spec lint-waves <blob-path>` — same rule as plan.md step 2: same-layer slices touch
  disjoint files; slices that run a code generator or edit a shared fixture/test harness serialize
  against each other. Fix every overlap with a `depends_on` edge first. `scaffold` refuses on
  overlap.
- b. `~/.dg/bin/dg-skills spec scaffold --home .agents/spec --slug <slug> --from-json <blob-path>` → prints
  `<bundle>` (`.agents/spec/<NNN>_<slug>/`).
- c. `/dg:assign <bundle>/plan.md` — fills `slices[].agents`. Not optional: F7 reads `agents.primary`
  for its escape hatch, and a resumed `/dg:spec -s` needs it.
- d. Code-structure decisions, if F2 produced any that span more than one slice:
  `~/.dg/bin/dg-skills spec append-section <bundle>/plan.md --section "Code Structure" "<body>"`.
- e. `~/.dg/bin/dg-skills spec perms-batch <bundle>/plan.md --grant-all` — persists the set F3 listed and F4
  approved.
- f. `~/.dg/bin/dg-skills spec context <bundle>` → `context.md`. **Required**, not optional as it might look in a
  single-session run: it is what F7 re-orients from after each compaction.
- g. Commit: `git add -f .agents/spec/<NNN>_<slug>/ && git commit -m "chore(spec): plan <slug>"` (`-f` because `/dg:agent-seed` ignores `.agents/`).
  Mandatory in worktree mode — a worktree branches off freshly fetched `origin` and cannot see an
  uncommitted bundle (see [execute.md](execute.md) § *Bundle-visibility gotcha*).

`scaffold` also creates one empty `roundtable/slice-<N>.md` shell per slice. Fast mode never fills
them — no review fan-out, no synthesis. Empty shells are expected here, not a defect.

> **GATE:** bundle exists with `plan.md` + `context.md`; every slice has `agents.primary`;
> `permissions` written; bundle committed.

## F6 — Worktree or branch

**Worktree (default).** Follow [`sdlc/references/setup.md`](../../sdlc/references/setup.md) **Step
1** exactly — create the worktree and work in it exactly as that step describes. The session itself
stays at the launch directory; every command that touches the worktree carries its own
`cd "$WORKTREE_PATH" && …` prefix. Then, per execute.md's gotcha, resolve the bundle against the
origin checkout:

```sh
SPEC_PATH="$(~/.dg/bin/dg-skills stash -C "$WORKTREE_ORIGIN" -m spec)/<NNN>_<slug>/plan.md"
```

**`-T`/`--no-worktree`.** No worktree. If the current branch is the repo default,
`git switch -c feature/<slug>` — never build on main. Otherwise stay put. `SPEC_PATH` is the local
bundle path, since there is no origin/worktree split to bridge.

Scratchpad path either way, computed after the move (see execute.md §3 for why it is keyed by
the main worktree rather than the cwd):

```sh
SCRATCH_PATH="$(~/.dg/bin/dg-skills stash -s spec <NNN>_<slug>-scratch.md)"; touch "$SCRATCH_PATH"
```

Skip `/dg:sdlc` setup.md Step 2 (slice derivation) and Step 3 (assignment) — F2–F5 already did both.
Ask Step 3's permission question **only** if F3 failed to list the set.

> **GATE:** on a feature branch (worktree or `-T`); `SPEC_PATH`/`SCRATCH_PATH` bound.

## F7 — Sequential slice build, in this chat

Layer the slices exactly as [`sdlc/references/engineering.md`](../../sdlc/references/engineering.md)
§4.1 describes, then walk them **one at a time** in that order. Fast mode does not call the
slice-wave Workflow and does not build slices in parallel, so §4.1's disjoint-files invariant is
satisfied trivially.

Per slice:

1. **Re-orient from disk, not memory.** Read `context.md` and the slice's own blocks
   (`~/.dg/bin/dg-skills spec slice "$SPEC_PATH" <id>`). After a compaction the earlier slices are gone from
   context — that is the design, and F5f is why it is safe.
2. **Red.** Write the failing tests from the slice's `### Contracts` first, per `/dg:standard-test`.
3. **Green.** Implement until they pass; run the project's test and lint commands.
4. **Commit the slice** — Conventional Commits, scope required (e.g. `feat(<scope>): <slice name>`).
   Silent when `permissions.slice_commits`.
5. **Record.** Append the slice summary to `## Slice Summaries`, durable notes to `## Agent Notes`
   as `- (slice N) <text>`, ephemeral notes to `SCRATCH_PATH`; set `current_slice`.
6. **Compact before the next slice.** Carry forward only: `SPEC_PATH`, `SCRATCH_PATH`, completed
   slice ids, remaining slices + dependency map, permissions, cwd. Everything else is recoverable
   from `context.md` + `plan.md`.

**Ambiguity mid-slice → ask.** The main loop has `AskUserQuestion`, so a spec or test dispute is
resolved on the spot with the user and written back into `plan.md`. Fast mode has no `deferrals[]`
protocol — that exists only because the workflow's agents cannot pause.

**Escape hatch.** If a slice turns out far larger than planned, say so and offer to hand that one
slice to its assigned `agents.primary` as a single subagent call, rather than growing main-loop
context. One slice delegated does not turn the run back into a slice-wave.

> **GATE (per slice):** tests pass, slice committed, summary recorded, context compacted.
> **GATE (F7):** every slice committed.

## F8 — Finish — `finish.md` steps 5–8, all four kept

Run [`sdlc/references/finish.md`](../../sdlc/references/finish.md) **steps 5, 6, 7, and 8** exactly
as written. Fast mode trims planning, never the end gates:

| Step | Kept as |
|---|---|
| 5 | Final review + bounded correction (max 2 rounds), commit fixes |
| 6 | Test-name gate, then `dg:lore` docs pass, commit docs |
| 7 | Human review moves onto the PR/MR — no blocking gate |
| 8 | Push + `~/.dg/bin/dg-skills vcs-provider create-pr --draft` |

The `/dg:spec` deltas in [execute.md](execute.md) §6 apply unchanged: the PR/MR always opens
`--draft`, the browser-open in `finish.md` step 8f runs afterward, and step 8d persists the URL to
`worktree.pr_url` in `plan.md`. Step 8f owns the group name — [`/dg:pushup`](../../pushup/SKILL.md)
carries the same mechanics for an ad-hoc branch, but this path never forks to it.

- **Worktree mode:** print step 8d's line. There is no `ExitWorktree` call to
  make — the session never relocated out of the launch directory (see setup.md Step 1).
- **`-T` mode:** there is no worktree to leave — skip step 8d and print
  `"PR/MR opened (draft): <url>. Review it there — /dg:address picks up the comments."`

> **GATE:** draft PR/MR opened, URL captured, browser group opened.

## What fast mode trades away

| Dropped | Full-mode home |
|---|---|
| Separate `dg:arch` / structure / `dg:foreman` interview passes | plan.md steps 1, 1.5, 2 |
| Per-slice review fan-out | plan.md step 5 |
| foreman synthesis + gaps pass | plan.md step 6 |
| Plan approval gate after the bundle is written | plan.md step 8 |
| `/dg:proxy` slice delegation | plan.md step 7c |
| Parallel slice waves (Red→Yellow→Green→MiniQA) | engineering.md §4 |
| The plan/execute session boundary | plan.md step 10 |

**Use full `/dg:spec` instead when** the feature spans more than three or four slices, touches
architecture across module boundaries, lands in a codebase area you have not read, or is worth an
independent review of each slice before any code is written. Fast mode is for work you could
already describe accurately in one sitting.

An interrupted fast run is not lost: the bundle was committed at F5g, so `/dg:spec -s <NNN>_<slug>`
resumes it through the normal execute path (which then uses the slice-wave, not F7).
