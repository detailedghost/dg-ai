# Step 4 — Slice Waves (Red → Yellow → Green → MiniQA → Correction)

The per-slice TDD pipeline runs as a background **Workflow** (`references/templates/slice-wave.workflow.js`), **one call per dependency layer**. The workflow does the parallel build/test/review fan-out; the orchestrator keeps the two things a background run cannot do — **git commits** (race-free because serialized here) and **interactive resolution** of `SPEC`/`TEST`/`CRITICAL` deferrals.

**Caller inputs.** This file is caller-agnostic; the invoking skill supplies:

- `SPEC_PATH` + `SCRATCH_PATH` — `/dg:sdlc` sets them in setup.md (`$(~/.dg/bin/dg-skills stash -s sdlc)/`); /dg:spec and /dg:pickup pass their durable spec + scratchpad, with their own deltas (cross-repo setup, QUICK_MODE) layered on top.
- Commit gate — `permissions.slice_commits` from the spec frontmatter.
- `cwd` — the working tree every agent prompt carries.

**Spec ambiguity / test disputes:** agents return `[SPEC]`/`[TEST]` items as `deferrals` (they cannot pause a workflow). The orchestrator resolves them with the user in post-processing below.

## 4.1 Compute dependency layers

From `slices[]` + `depends_on`, topologically sort slices into **layers**: layer 0 = slices with no unmet dependencies, layer N = slices whose deps all completed in layers `< N`. Layers run sequentially; slices within a layer run in parallel.

> **Disjoint-files invariant:** slices in the *same* layer MUST touch disjoint files. Parallel slices share one working tree with no commits until post-processing, so two slices editing the same file would clobber each other. When unsure, serialize via separate layers.

## 4.2 Per-layer Workflow call

For each layer in order:

1. Record `slice_base_sha=$(git -C "$cwd" rev-parse HEAD)` and set spec frontmatter `current_slice` to the layer's lead slice.
1. Resolve the layer and write its runner in one call. Workflow refuses a `scriptPath` outside the working directory and the directories added to the session, and the installed plugin cache is outside both, so the helper writes into the session scratchpad (`<scratchpad>`):

```
~/.dg/bin/dg-skills assign resolve "$SPEC_PATH" --layer <N> --scratch "$SCRATCH_PATH" --wave <scratchpad> --cwd "$cwd"
```

   The helper layers `slices[]` the way `spec lint-waves` does and picks each slice's stages from `plugins/dg/skills/assign/references/model-tiers.json`: the primary agent (honoring `agents.effort` and the spec's `## Execution` `model:`/`effort:` pin), each `agents.qa[]` reviewer, and the shared `dg:qa-writer`, `dg:wave` and `dg:security` roles. It inlines the five templates (`qa-writer-red.md`, `slice-engineering.md`, `qa-writer-green.md`, `wave.md`, `correction.md`), plus `slice-engineering-proxy.md` when a slice sets `agents.proxy`, each behind the return-contract reminder below. It bakes the result into the runner as `const WAVE_ARGS` and prints the file path. Exit 1 means a slice has no `agents.primary` (run `/dg:assign`), the layer is empty, or the pin asks for `fable` on a primary that is not `dg:arch`, `dg:design` or `dg:foreman`. Add `--runtime codex|grok` to resolve for another runtime. Without `--wave` it prints the `WAVE_ARGS` JSON instead.

1. Call `Workflow({ scriptPath: "<printed path>" })` with no `args`. The runner reads `WAVE_ARGS`; an explicit `args` object still wins when given.

The script runs each slice through Red (qa-writer) → Yellow (engineering) → Green (qa-writer) → MiniQA (`dg:wave` + any `agents.qa` + `dg:security` when the slice flags `securitySensitive`) → up to 2 correction rounds. **Model and effort come from `model-tiers.json`**, resolved by the helper and never hard-coded in the script: `dg:wave` and `dg:checkpoint` run on haiku, `dg:arch`/`dg:design`/`dg:foreman` on fable, `dg:dba`/`dg:security` on opus, everything else on sonnet. Effort precedence is the slice's `agents.effort`, then the tier default. The `## Execution` pin overrides the primary and `dg:qa-writer` stages, never the wave audit. A `fable` pin moves only a fable-eligible primary; `dg:qa-writer` then takes only the pinned effort. Each stage returns its own changed-file list; the script unions them per slice.

It returns `{ slices: [{ sliceId, status, changedFiles, deferrals, residualFindings, notes, summary }] }`, where `status` is `clean` | `needs-attention` | `unverified` | `blocked`.

> **Workflow return contract (overrides the templates' inline-marker prose).** The slice agents run unattended under a forced schema, so they must **map their intent into the return object, never act on it**: a `[SPEC]`/`[TEST]` ambiguity → a `deferrals[]` entry (do **not** call `AskUserQuestion` — it can't pause); `[NOTE-DURABLE]`/`[NOTE-SCRATCH]` → `notes.durable[]`/`notes.scratch[]` (do **not** write the spec/scratchpad directly — the orchestrator routes them in 4.3); every file touched → that stage's changed-file list. **Deferral types:** `SPEC` and `TEST` block the slice (a decision is needed). `CONFIRM` is informational: a change the orchestrator should see, such as an assertion the agent changed, with no decision needed. It never blocks and stays in the wave result. Agents never edit the spec or report unticked checkboxes; the orchestrator ticks them in 4.3.
>
> **Review list.** `WAVE_ARGS.cwd` is the worktree. After Green, a `dg:wave` stage runs `git diff --name-only HEAD` and `git ls-files --others --exclude-standard` there (the workflow sandbox runs no shell itself). The MiniQA and correction review list is the union of that output and the reported `changedFiles`, but the returned `changedFiles` (the commit list) stays the reported files only; paths outside the worktree, and paths outside the slice's `files` globs, are dropped, so parallel slices never review or correct each other's files. A slice with no `files` globs keeps every path. A failed stage marks the slice `unverified`.
>
> The helper prepends a one-line reminder of this contract to every template it inlines.

## 4.3 Per-slice orchestrator post-processing

For each returned slice, in deterministic order (so commits never race):

1. **Deferrals first.** Any `deferrals` (or `status: blocked`) → pause and resolve with the user (`AskUserQuestion`): `SPEC` → clarify + update spec; `TEST` → reconcile against the spec's Contracts block; `CONFIRM` never blocks (see below); `CRITICAL`/HIGH-security → user decision. Then re-run that single slice via another slice-wave call with a one-slice `slices` array. Do not commit a blocked slice.
   - **Resume after settling.** Write each answer as a line under `## Agent Notes` (and, for one slice only, in that slice's `notes` string in `WAVE_ARGS`, which the runner puts in that slice's prompts only). Add the deferral text prefixes you settled to `WAVE_ARGS.resolved`; the runner then drops matching `SPEC`/`TEST` deferrals from the result, so they neither block nor reappear. If red already finished, add `WAVE_ARGS.redDone` as `{ "<sliceId>": ["<test file>", ...] }`; that slice skips red and yellow receives those files. Edit the baked `const WAVE_ARGS` literal in the runner file (`assign resolve` has no flags for these keys; re-running it overwrites the edits), then call `Workflow` again with a one-slice `slices` array.
1. **Commit the slice** (only if `permissions.slice_commits`). `git -C "$cwd" add <changedFiles>` then commit (Conventional Commits, e.g. `feat(<scope>): <slice name>`). Scoped to the slice's own files, so parallel-built slices commit cleanly one after another.
1. **Tick checkboxes.** The agents never edit the spec. After the commit, tick the slice's Engineering and Testing Criteria checkboxes in the spec for the work the commit delivers.
1. **Append** the slice `summary` to `## Slice Summaries` in the spec.
1. **Route notes** (already structured in the return): `notes.durable[]` → append under `## Agent Notes` as `- (slice N, <agent>) <text>`; `notes.scratch[]` → append to `SCRATCH_PATH`. Append-only.

After the whole layer is committed: `/compact`. Carry forward: spec path, scratch path, completed slice IDs, remaining layers + dependency map, permissions, cwd.

> **GATE (per layer):** all slices committed OR deferrals resolved + re-run + committed.
> **GATE (step 4):** all layers complete, all slices committed.
