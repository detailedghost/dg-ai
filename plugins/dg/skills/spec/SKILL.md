---
name: spec
description: Plan or execute a durable feature spec bundle. Plan mode (`/dg:spec "<request>"`) runs interview → roundtable → synthesize → durable bundle under .agents/spec/ → plan approval gate → tidy context pack. Fast mode (`/dg:spec --fast "<request>"`) plans and builds in one chat — built-in plan mode as the single gate, then sequential slices. Execute mode (`/dg:spec -s <NNN>_<slug>`) reads only the tidy pack + plan.md and drives /dg:sdlc's slice-wave.
---

# /dg:spec — Plan or Execute a Durable Feature Bundle

Three modes, one skill. Plan mode turns a request into a durable bundle under `.agents/spec/`;
execute mode reads that bundle's tidy pack and drives `/dg:sdlc`'s slice-wave; fast mode does both in
one chat. The durable read-boundary is the point: planning sprawl (`initial.md`,
`roundtable/*.md`) is quarantined so an execution session boots off `context.md` + `plan.md`, never
the whole planning history.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills spec --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor batch-open chain proxy spec stash vcs-provider worktree.

**Usage:** `/dg:spec [--fast [-T]] [-s <NNN>_<slug>] "<request>"`.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `"<request>"` | none | The feature request, plain prose. Required unless `-s` is given. Plan and fast modes. | none |
| `(no flag)` | none | Plan mode: full 10-step pipeline, then a durable bundle, then stop. Resume separately with `-s`. | plan mode |
| `--fast` | `-f` | Fast mode: plan and build in one chat. One grill pass, no fan-out, built-in Claude plan mode is the single approval gate. Slices build sequentially in the main loop with a compaction between each. All end gates kept. | off |
| none | `-s <NNN>_<slug>` | Execute mode: build an existing bundle. Always creates a worktree. | off |
| `--no-worktree` | `-T` | Fast mode only: build in the current checkout instead of a worktree. Creates `feature/<slug>` first if on the default branch. Invalid with `-s` and with bare plan mode. | off (worktree) |

`--fast` and `-s` are mutually exclusive — both present → ask which was meant.

Request too big or foggy for one bundle? Run `/dg:wayfinder` first, then pass its map to `/dg:spec`.

## Mode dispatch

`FAST_MODE = HAS(--fast|-f)`, `EXECUTE_MODE = HAS(-s)`. Parse args before any phase.

- **`--fast "<request>"` → FAST MODE.** Follow [references/fast.md](references/fast.md).
- **Bare `"<request>"` (no `-s`, no `--fast`) → PLAN MODE.** The positional prose is the feature
  request. Follow [references/plan.md](references/plan.md).
- **`-s <NNN>_<slug>` → EXECUTE MODE.** The argument is a bundle identifier — the `<NNN>_<slug>`
  dir name under `.agents/spec/`. Resolve the bundle, follow [references/execute.md](references/execute.md).
  No positional request is required in this mode.
- If neither a request nor `-s` is present, ask for the request (one question) before proceeding.

## Plan-mode pipeline

| # | Step | Reference |
|---|---|---|
| 1 | arch `/dg:grill-me` the request `[fable, xhigh]` | references/plan.md, references/grill.md |
| 1.5 | Structure `/dg:grill-me` — code-surface contracts `[lang agent, sonnet]` | references/templates/structure-grill.md |
| 2 | `dg:foreman` `/dg:grill-me` on ordering/gaps `[fable, xhigh]` | references/plan.md, references/grill.md |
| 3 | `dg:foreman` emits decision blob → `~/.dg/bin/dg-skills spec scaffold` → `/dg:assign` → write `## Code Structure` | references/plan.md, references/decision-blob.md |
| 4 | Checkpoint — bundle now has one `roundtable/slice-<N>.md` per slice | references/plan.md |
| 5 | Per-slice review fan-out (`sonnet` default, per-slice opt-in escalate) | references/plan.md, references/templates/slice-review.md |
| 6 | `dg:foreman` synthesis `[fable, xhigh]` + `/dg:grill-me` gaps pass | references/plan.md, references/templates/synthesis.md |
| 7 | Write `plan.md`; assign `/dg:proxy` slices; WARN token/context cost | references/plan.md |
| 8 | Plan approval gate (readable plan view in the terminal, then `AskUserQuestion` Approve or Rework, blocks on Approve); register accepted prototype assets (built with `/dg:proto`) | references/plan.md |
| 9 | `~/.dg/bin/dg-skills spec context <bundle>` assembles `context.md` | references/plan.md |
| 10 | Commit bundle; print resume command `/dg:spec -s <NNN>_<slug>` | references/plan.md |

## Fast-mode pipeline

| # | Step | Reference |
|---|---|---|
| F1 | `EnterPlanMode` — file writes blocked until approval | references/fast.md |
| F2 | ONE grill pass, main loop — placement + code surface + slice ordering | references/fast.md, references/grill.md |
| F3 | Write the plan file, permission set spelled out in it | references/fast.md |
| F4 | `ExitPlanMode` — the single gate | references/fast.md |
| F5 | Blob → `~/.dg/bin/dg-skills spec scaffold` → `/dg:assign` → `perms-batch` → `context` → commit | references/fast.md, references/decision-blob.md |
| F6 | Worktree (or `-T` branch); bind `SPEC_PATH`/`SCRATCH_PATH` | references/fast.md |
| F7 | Slices sequentially in this chat — red → green → commit → compact | references/fast.md |
| F8 | `finish.md` 5–8 — final review, docs, draft PR/MR | [sdlc finish.md](../sdlc/references/finish.md) |

Fast mode drops the roundtable fan-out, the synthesis pass, the plan approval gate, `/dg:proxy` delegation,
and the parallel slice waves. It keeps every end gate. Reach for full plan mode when the feature
spans more than three or four slices or touches unfamiliar architecture.

## Execute-mode contract

Read ONLY `context.md` + `plan.md` — never `initial.md`/`roundtable/*`. Set `SPEC_PATH`/`SCRATCH_PATH`,
reuse `/dg:sdlc`'s worktree setup, SKIP its slice-derivation (this bundle's `slices[]` + `/dg:assign` already
ran), then drive [sdlc engineering.md](../sdlc/references/engineering.md) 4.1–4.3 and
[sdlc finish.md](../sdlc/references/finish.md) steps 5–8 (through the
direct PR/MR launch — draft always, then a best-effort `~/.dg/bin/dg-skills batch-open` (on failure, print the URL and continue), per `finish.md` step 8's `/dg:spec` deltas). The run ends at a draft PR/MR and the human reviews it on the provider.
[references/execute.md](references/execute.md) §6 owns the bookkeeping on top of that (persisting
the PR/MR URL into `plan.md`, restoring cwd).

## Reference files (lazy-load)

| File | When to read |
|---|---|
| [references/fast.md](references/fast.md) | The `--fast` contract — F1–F8: built-in plan mode → one grill pass → `ExitPlanMode` gate → scaffold + commit → worktree/`-T` → sequential main-loop slices with compaction between → `finish.md` 5–8. Read at fast-mode entry; do NOT read plan.md in this mode. |
| [references/plan.md](references/plan.md) | Plan-mode orchestration — the 10-step pipeline (grill → roundtable → scaffold → per-slice review → synthesize → write plan.md → plan approval gate → context pack → commit + print resume cmd). Read at plan-mode entry. |
| [references/decision-blob.md](references/decision-blob.md) | The compact-JSON contract the foreman emits for `scaffold --from-json`. Read before step 3 of plan.md. |
| [references/execute.md](references/execute.md) | The `-s` contract — read ONLY `context.md` + `plan.md`; set `SPEC_PATH`/`SCRATCH_PATH`; reuse `/dg:sdlc` worktree setup, SKIP its slice-derivation/ephemeral-spec, drive engineering.md 4.1–4.3 → finish.md 5–8, where §6 adds the `/dg:spec` bookkeeping. Read at execute-mode entry. |
| [references/grill.md](references/grill.md) | Thin pointer: grill-me protocol is INLINED from the [grill-me protocol](../grill-me/references/protocol.md), followed in-context; each of the four passes scoped to its narrow topic; decision log carries as context (no JSON hand-back). Read at plan.md steps 1/1.5/2/6. |
| [references/templates/structure-grill.md](references/templates/structure-grill.md) | The code-building pass — admission test (`ratify contracts, never implementations`), research persona, self-collapse/skip rules, `## Code Structure` output shape. Read at plan.md step 1.5. |
| [references/templates/slice-review.md](references/templates/slice-review.md) | `/dg:spec`'s own per-slice review fan-out prompt. Carries the sonnet-default / opus-medium-escalation note. Read at plan.md step 5. |
| [references/templates/synthesis.md](references/templates/synthesis.md) | `/dg:spec`'s own synthesis fan-out prompt (foreman folds slice findings). Read at plan.md step 6. |

## General rules

- Use TaskCreate/TaskUpdate to track pipeline steps in every mode.
- Each agent reads only its relevant `.agents/school/` topic file.
- NEVER skip a gate condition (the plan approval gate in plan mode, per-slice triage, `ExitPlanMode` approval in
  fast mode). There is no in-run human code-review gate — the review moves onto the PR/MR — but
  every gate above still holds.
- **Bundle dirs are ALWAYS named `{NNN}_<slug>`** — zero-padded 3-digit prefix + slugified
  description (e.g. `001_vela_dashboard_favorites`). `~/.dg/bin/dg-skills spec scaffold` enforces this
  unconditionally, deriving `<NNN>` from the max `NNN_`-prefixed **dir** under `.agents/spec/`
  (none → `001`); pre-existing non-numbered dirs are ignored and left untouched. Never create or
  reference a bundle without its prefix — `/dg:spec -s` takes the full `{NNN}_<slug>` dir name.
