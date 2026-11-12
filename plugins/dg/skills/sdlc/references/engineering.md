# Step 4 — Slice Waves (Red → Yellow → Green → MiniQA → Correction)

The per-slice TDD pipeline runs as a background **Workflow** (`references/templates/slice-wave.workflow.js`), **one call for the whole run**, each slice gated on its dependencies. The workflow does the parallel build/test/review fan-out; the orchestrator keeps the two things a background run cannot do — **git commits** (race-free because serialized here) and **interactive resolution** of `SPEC`/`TEST`/`CRITICAL` deferrals.

**Caller inputs.** This file is caller-agnostic; the invoking skill supplies:

- `SPEC_PATH` + `SCRATCH_PATH` — `/dg:sdlc` sets them in setup.md (`$(dg-skills stash -s sdlc)/`); /dg:spec and /dg:pickup pass their durable spec + scratchpad, with their own deltas (cross-repo setup, QUICK_MODE) layered on top.
- Commit gate — `permissions.slice_commits` from the spec frontmatter.
- `cwd` — the working tree every agent prompt carries.

**Spec ambiguity / test disputes:** agents return `[SPEC]`/`[TEST]` items as `deferrals` (they cannot pause a workflow). The orchestrator resolves them with the user in post-processing below.

## 4.1 Compute the pending set and dependency graph

From `slices[]` + `depends_on`, compute the pending set (slices with no completion marker) and the dependency graph. The topological order is the `layer N:` order that `spec lint-waves` prints; the runner starts each slice the moment its dependencies finish, so no layer barrier exists.

> **Disjoint-files invariant:** any two slices with no dependency path between them MUST touch disjoint files. They share one working tree with no commits until post-processing, so two such slices editing the same file would clobber each other. The globs cannot show every overlap: shared lockfiles, fixed `/tmp` paths and build output directories also collide. When unsure, chain the slices with `depends_on`.

## 4.2 One Workflow call

1. Record `slice_base_sha=$(git -C "$cwd" rev-parse HEAD)` before each Workflow call, including each re-run, so every call starts from a fresh base.
1. Resolve the pending slices and write the runner in one call. Workflow refuses a `scriptPath` outside the working directory and the directories added to the session, and the installed plugin cache is outside both, so the helper writes into the session scratchpad (`<scratchpad>`):

```
dg-skills assign resolve "$SPEC_PATH" --scratch "$SCRATCH_PATH" --wave <scratchpad> --cwd "$cwd"
```

   The helper picks every pending slice and each slice's stages from `plugins/dg/skills/assign/references/model-tiers.json`: the primary agent (honoring `agents.effort` and `agents.model` as the per-slice tier override), each `agents.qa[]` reviewer, and the shared `dg:qa-writer`, `dg:wave` and `dg:security` roles. It reads the profile from `execution.profile`; `WAVE_ARGS.profile` is informational and only feeds the start-of-run log line. It inlines the five templates (`qa-writer-red.md`, `slice-engineering.md`, `qa-writer-green.md`, `wave.md`, `correction.md`), plus `slice-engineering-proxy.md` when a slice sets `agents.proxy`, each behind the return-contract reminder below. It bakes the result into the runner as `const WAVE_ARGS` and prints the file path. Exit 1 means a slice has no `agents.primary` (run `/dg:assign`), an explicit layer selection is empty, or `agents.model` asks for `fable` on a primary that is not `dg:arch`, `dg:design` or `dg:foreman`. Add `--runtime codex|grok` to resolve for another runtime. Without `--wave` it prints the `WAVE_ARGS` JSON instead. When the default selection has nothing pending, the helper prints `no pending slices`, exits 0 and writes no runner; make no Workflow call then.

1. Call `Workflow({ scriptPath: "<printed path>" })` with no `args`. The runner reads `WAVE_ARGS`; an explicit `args` object still wins when given, but take `args` from `assign resolve`. A dependency cycle marks its slices `blocked-upstream`. Slices that share an id return `blocked` with summary `duplicate slice id <id>`.

The script runs each slice through Red (qa-writer) → Yellow (engineering) → Green (qa-writer) → MiniQA (`dg:wave` + any `agents.qa` + `dg:security` when the slice flags `securitySensitive`) → correction rounds up to the profile cap. Every slice first waits until each `dependsOn` id has a final result of `clean`, or `needs-attention` with no live `CRITICAL` deferral; this holds for a re-run slice with `redDone` too. A slice behind a dependency that ended `blocked`, `unverified`, dropped, or `needs-attention` with a live `CRITICAL` deferral returns `blocked-upstream` without running any stage. **Model and effort come from `model-tiers.json`**, resolved by the helper and never hard-coded in the script: `dg:wave` and `dg:checkpoint` run on haiku, `dg:arch`/`dg:design`/`dg:foreman` on fable, `dg:dba`/`dg:security` on opus, everything else on sonnet. Effort precedence is the slice's `agents.effort`, then the tier default. `agents.model` overrides the primary and `dg:qa-writer` stages, never the wave audit. A `fable` override moves only a fable-eligible primary; `dg:qa-writer` then takes only the override's effort. Each stage returns its own changed-file list; the script unions them per slice.

It returns `{ slices: [{ sliceId, status, changedFiles, deferrals, residualFindings, notes, summary }], droppedSlices: [<id>] }`, where `status` is `clean` | `needs-attention` | `unverified` | `blocked` | `blocked-upstream`. A `blocked-upstream` slice also carries `blockedBy: [<id>]`. A slice in `droppedSlices` had its pipeline throw and has no entry in `slices`.

> **Workflow return contract (overrides the templates' inline-marker prose).** The slice agents run unattended under a forced schema, so they must **map their intent into the return object, never act on it**: a `[SPEC]`/`[TEST]` ambiguity → a `deferrals[]` entry (do **not** call `AskUserQuestion` — it can't pause); `[NOTE-DURABLE]`/`[NOTE-SCRATCH]` → `notes.durable[]`/`notes.scratch[]` (do **not** write the spec/scratchpad directly — the orchestrator routes them in 4.3); every file touched → that stage's changed-file list. **Deferral types:** `SPEC` and `TEST` block the slice (a decision is needed). `CONFIRM` is informational: a change the orchestrator should see, such as an assertion the agent changed, with no decision needed. It never blocks and stays in the wave result. Agents never edit the spec or report unticked checkboxes; the orchestrator ticks them in 4.3.
>
> **Review list.** `WAVE_ARGS.cwd` is the worktree. After Green, a `dg:wave` stage runs `git diff --name-only HEAD` and `git ls-files --others --exclude-standard` there (the workflow sandbox runs no shell itself). The MiniQA and correction review list is the union of that output and the reported `changedFiles`, and, when the slice declares `files` globs, the owned recovered paths also join the returned `changedFiles` (the commit list); a slice with no globs commits only its reported files; paths outside the worktree, and recovered or Yellow-reported paths outside the slice's `files` globs, are dropped, so parallel slices never review or correct each other's files. A slice with no `files` globs keeps every path. A failed stage marks the slice `unverified`.
>
> The helper prepends a one-line reminder of this contract to every template it inlines.

## 4.3 Per-slice orchestrator post-processing

Walk the returned slices in the `layer N:` order that `dg-skills spec lint-waves` prints, because the runner returns them in input order, so commits never race. Set `current_slice` per slice here:

1. **Deferrals first.** Any `SPEC`, `TEST` or `CRITICAL` deferral (or `status: blocked`) → pause and resolve with the user (`AskUserQuestion`): `SPEC` → clarify + update spec; `TEST` → reconcile against the spec's Contracts block; `CONFIRM` never blocks and needs no user answer (see below); `CRITICAL`/HIGH-security → user decision. Do not commit a `blocked`, `blocked-upstream` or `unverified` slice, or a slice in `droppedSlices`. Re-run those slices after resolving (see **Re-run** below).
   - **Resume after settling.** Write each answer as a line under `## Agent Notes` (and, for one slice only, in that slice's `notes` string in `WAVE_ARGS`, which the runner puts in that slice's prompts only). Add the deferral text prefixes you settled to `WAVE_ARGS.resolved`; the runner then drops matching `SPEC`/`TEST` deferrals from the result, so they neither block nor reappear. If red already finished, add `WAVE_ARGS.redDone` as `{ "<sliceId>": ["<test file>", ...] }`; that slice skips red and yellow receives those files.
   - **Re-run.** When `permissions.slice_commits` is granted, call `assign resolve` with the default selection: committed slices now carry markers, so the pending set is exactly the blocked, unverified, blocked-upstream and dropped slices. When commits are off, pass `--slices` with the blocked, unverified, blocked-upstream and dropped ids together so `dependsOn` edges survive; also add each blocked-upstream dependent of a `needs-attention` slice whose live `CRITICAL` deferral you resolved. Order: resolve first, then edit `resolved`, `redDone` and `notes` in the baked `const WAVE_ARGS` literal (`assign resolve` has no flags for these keys; re-running it overwrites the edits), then call `Workflow`.
1. **Commit the slice** (only if `permissions.slice_commits`; only `clean` and `needs-attention` slices). `git -C "$cwd" add <changedFiles>` then commit with subject `<type>(<scope>): slice-<N>: <slice name>`. A path that two slices both changed goes in the commit of the later slice, and that commit body names the path.
1. **Tick checkboxes.** The agents never edit the spec. After the commit, tick the slice's Engineering and Testing Criteria checkboxes in the spec for the work the commit delivers.
1. **Append** the slice `summary` to `## Slice Summaries` in the spec.
1. **Route notes** (already structured in the return): `notes.durable[]` → append under `## Agent Notes` as `- (slice N, <agent>) <text>`; `notes.scratch[]` → append to `SCRATCH_PATH`. Append-only.

Once after the whole call: `/compact`. Carry forward: spec path, scratch path, completed slice IDs, remaining slices + dependency map, permissions, cwd.

> **GATE (step 4):** all slices committed OR deferrals resolved + re-run + committed.
