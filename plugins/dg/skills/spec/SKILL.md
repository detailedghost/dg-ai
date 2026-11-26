---
name: spec
description: 'Plan or execute a durable spec bundle: /dg:spec "<request>", --fast to plan and build, -s <NNN>_<slug> to execute.'
---

# /dg:spec — Plan or Execute a Durable Feature Bundle

Plan mode turns a request into a durable bundle under `.agents/spec/`; execute mode drives `/dg:sdlc`'s slice-wave from it; fast mode does both in one chat. Planning sprawl (`initial.md`, `roundtable/*.md`) stays quarantined: execution boots off `context.md` + `plan.md` only.
`.agents/` is tracked agent memory; scratch subfolders are ignored. Bundle adds always pass `':(exclude)<bundle>/roundtable/'`.
If `git add` refuses an ignored `.agents` path, ask to run `/dg:spring-break`; on no, stop and report the uncommitted bundle. Never `-f`.

First run: the block installs the CLI when it is missing. It prints an upgrade hint when the CLI is too old. Each Bash call works alone:

```bash
dg assign resolve --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg" assign resolve --help >/dev/null 2>&1 ||
  { { dg --version >/dev/null 2>&1 || "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg` in every later step. If `dg` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg` instead. If the block prints "run dg upgrade", run `dg upgrade`, then run the step again.

If a step fails, run dg doctor assign batch-open pw chain proxy spec stash vcs-provider worktree.

**Usage:** `/dg:spec [--fast [-T]] [-s <NNN>_<slug>] [--profile <profile> | --cheap | --expensive] [--proxy <backend>] [--bg] [--no-land | --auto] "<request>"`.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `"<request>"` | none | Feature request in prose. Required unless `-s`. | none |
| `(no flag)` | none | Plan mode: 10-step pipeline, durable bundle, stop. Resume with `-s`. | plan mode |
| `--fast` | `-f` | Plan and build in one chat: one grill pass, no fan-out, built-in plan mode as the single gate, sequential slices. All end gates kept. | off |
| none | `-s <NNN>_<slug>` | Build an existing bundle in a new worktree. | off |
| `--no-worktree` | `-T` | Fast mode only: build in the current checkout (makes `feature/<slug>` off the default branch). Invalid with `-s` and bare plan mode. | off (worktree) |
| `--profile <profile>` | `-p` | Cost profile (`balance`, `cheap`, `expensive`); persists as `execution.profile`. Two profile flags with different values are an error that names both. | balance |
| `--cheap` | none | Alias: `--profile cheap`. | off |
| `--expensive` | none | Alias: `--profile expensive`. | off |
| `--proxy <backend>` | `-x` | Delegate slices to a `/dg:proxy` backend: asks per slice in plan mode, and with `-s` for slices lacking `agents.proxy`. | off |
| `--bg` | `-b` | Execute mode only (`-s`): run unattended here; `/dg:bg` detaches it. Questions become `## Issues Remediation` rows. Invalid with bare plan mode (stop). | off |
| `--no-land` | none | Execute/fast modes: stop at the draft PR/MR, skip `/dg:land`. For other review rounds or CI-fix ceilings, pass it, then run `gh pr ready` and `/dg:land -r N -c N`. Invalid with bare plan mode. | off (land) |
| `--auto` | none | Execute/fast modes: end with `/dg:land --auto`, which merges after green CI, no review stop. Only from the person's command line, never bundle or config. Invalid with `--no-land`, `--bg`, and bare plan mode. | off (review first) |

Request too big or foggy? Run `/dg:wayfinder` first, pass its map here.

## Mode dispatch

Parse args first. `--fast` is mutually exclusive with `-s` and with `--proxy`; either pair stops with an error that names both flags. So is `--auto` with `--no-land` and with `--bg`.

- `--fast "<request>"` runs FAST MODE ([fast.md](references/fast.md)). Bare `"<request>"` runs PLAN MODE ([plan.md](references/plan.md)). `-s <NNN>_<slug>` (a bundle dir name under `.agents/spec/`, no request needed) runs EXECUTE MODE ([execute.md](references/execute.md)).
- With neither a request nor `-s`, ask for the request first (one question).
- Profile: unset reads as balance in plan and fast mode; execute mode reads the persisted `execution.profile`. A missing or invalid `--profile`/`-p` value stops with `--profile must be one of balance, cheap, expensive`. Two profile flags with equal values are allowed.
- `--proxy <backend>` (plan mode and `-s`): when present, validate it against `dg proxy --list-backends` before any phase, in one Bash call. An unknown name stops and lists the valid backends.

## Plan-mode pipeline

| # | Step |
|---|---|
| 1 | arch `/dg:grill-me` `[fable, xhigh]` |
| 1.5 | Structure `/dg:grill-me`: code-surface contracts `[lang agent, sonnet]` |
| 2 | `dg:foreman` `/dg:grill-me` ordering `[fable, xhigh]` |
| 3 | `dg:foreman` decision blob → `dg spec scaffold` → `/dg:assign` → `## Code Structure` |
| 4 | Checkpoint: one `roundtable/slice-<N>.md` per slice |
| 5 | Per-slice review fan-out (`sonnet` default) |
| 6 | `dg:foreman` synthesis `[fable, xhigh]` + `/dg:grill-me` gaps |
| 7 | Write `plan.md`; --proxy slices; WARN token/context cost |
| 8 | Plan approval gate (plan view; Approve as a profile, or Rework); register accepted prototype assets (built with `/dg:proto`) |
| 9 | `dg spec context <bundle>` writes `context.md` |
| 10 | Commit bundle; print resume cmd `/dg:spec -s <NNN>_<slug>` |

## Fast mode

Fast mode (F1–F8 in fast.md) drops the roundtable, synthesis, the plan approval gate, `/dg:proxy` delegation and parallel waves; it keeps every end gate. Prefer plan mode beyond 3–4 slices.

## Execute-mode contract

Read ONLY `context.md` + `plan.md`, never `initial.md` or `roundtable/*`. Reuse `/dg:sdlc`'s worktree setup, SKIP its slice-derivation (`slices[]` and `/dg:assign` already ran), then drive [sdlc engineering.md](../sdlc/references/engineering.md) 4.1–4.3 and [sdlc finish.md](../sdlc/references/finish.md) steps 5–8: draft PR/MR always, then a best-effort `dg pw batch-open <url>` (on failure, print the URL and continue). [references/execute.md](references/execute.md) §6 owns the bookkeeping, §7 marks the PR ready and runs `/dg:land` in the main loop. It stops at "ready for your review" (`--auto` merges). `--no-land`, `--bg`, and GitLab stop at the draft.

## Reference files (lazy-load)

Read the mode file at mode entry (fast mode never reads plan.md). Also:

| File | Read |
|---|---|
| [references/decision-blob.md](references/decision-blob.md) | Before step 3: the `scaffold --from-json` contract. |
| [references/grill.md](references/grill.md) | At plan.md steps 1/1.5/2/6: inlined [grill-me protocol](../grill-me/references/protocol.md). |
| [references/templates/structure-grill.md](references/templates/structure-grill.md) | At step 1.5: admission test, `## Code Structure` shape. |
| [references/templates/slice-review.md](references/templates/slice-review.md) | At step 5: per-slice review prompt. |
| [references/templates/synthesis.md](references/templates/synthesis.md) | At step 6: synthesis prompt. |
| [references/profiles.md](references/profiles.md) | Only with a profile flag. |
| [references/proxy.md](references/proxy.md) | Only with `--proxy`. |
| [references/bg.md](references/bg.md) | Only with `--bg`. |

## General rules

- Track steps with TaskCreate/TaskUpdate. Each agent reads only its `.agents/school/` topic file.
- NEVER skip a gate (plan approval in plan mode, per-slice triage, `ExitPlanMode` approval in fast mode, the `/dg:land` merge gate). No subagent or slice wave ever merges a PR/MR.
- **Bundle dirs are ALWAYS named `{NNN}_<slug>`** (zero-padded 3-digit prefix, e.g. `001_vela_dashboard_favorites`). `dg spec scaffold` derives `<NNN>` from the max `NNN_` dir under `.agents/spec/` (none → `001`), ignoring non-numbered dirs. Never use a bundle without its prefix; `/dg:spec -s` takes the full `{NNN}_<slug>` name.
