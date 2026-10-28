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
1. Inline the five template bodies (`templates/qa-writer-red.md`, `slice-engineering.md`, `qa-writer-green.md`, `wave.md`, `correction.md`) into `templates: { red, yellow, green, wave, correction }`. Tokens the script substitutes per slice: `{SLICE_ID} {SLICE_BRIEF} {TESTING_CRITERIA} {CHANGED_FILES} {FINDINGS} {SPEC_PATH} {SCRATCH_PATH}`. If any slice in this layer has `proxyBackend` set, additionally inline `templates/slice-engineering-proxy.md` into `templates.proxy` — otherwise omit that key. The proxy template additionally uses `{PROXY_BACKEND}` (← `slice.proxyBackend`) and `{PRIMARY_AGENT}` (← `slice.primaryAgent`), substituted on every template regardless (no-op when the token isn't present).
1. Copy the script to a path Workflow can read. Workflow refuses a `scriptPath` outside the
   working directory and the directories added to the session, and the installed plugin cache is
   outside both. Copy `<sdlc-skill-dir>/references/templates/slice-wave.workflow.js` into the host's
   session scratchpad (or another added directory) once per run, and pass that copy as
   `<script-copy>`. When the host has no readable directory, pass the file's text through
   Workflow's `script` input instead.
1. Call:

```
Workflow({
  scriptPath: "<script-copy>",
  args: {
    slices: [{ id, name, primaryAgent, primaryEffort, proxyBackend, qaAgents, brief, testingCriteria }, ...],  // this layer only
    specPath, scratchPath,
    templates: { red, yellow, green, wave, correction, proxy },  // proxy undefined when no slice delegates
    maxCorrectionRounds: 2,
    model, effort  // optional tier override (haiku|sonnet|opus / low|medium|xhigh) from the spec's ## Execution pin; omit for the in-script defaults
  }
})
```

`<sdlc-skill-dir>` is this skill's base directory — the installed folder that holds `SKILL.md`; pass it as an absolute path. Arg mapping from spec frontmatter (`~/.dg/bin/dg-skills spec get <spec> 'slices[i].<key>'` or a direct Read): `name` ← `slices[].name` (per-slice progress label `<name> (S<id>)`; falls back to `slice <id>`). `primaryAgent` ← `slices[].agents.primary` (script falls back to `general-purpose` if unset — `/dg:assign` is responsible for a real pick before this runs). `primaryEffort` ← `slices[].agents.effort`, present only when `/dg:assign` overrode the tier default. `proxyBackend` ← `slices[].agents.proxy` (absent for the common case). `qaAgents` ← `slices[].agents.qa[]`. `model`/`effort` ← the spec's `## Execution` section (`model:` / `effort:` lines) when present; omit otherwise.

The script runs each slice through Red (qa-writer) → Yellow (engineering) → Green (qa-writer) → MiniQA (`dg:wave` + any `qaAgents` + `dg:security` when the slice flags `securitySensitive`) → up to 2 correction rounds. **Model tiering is pinned in-script** (`modelFor`): `dg:wave` → haiku, `dg:arch`/`dg:design`/`dg:dba`/`dg:security` → opus, everything else → sonnet — mirroring each agent's own frontmatter pin. `args.model` overrides every stage's model and `args.effort` every stage's effort; the spec's `## Execution` pin is the source when present. **Effort** (`effortFor`) derives from `EFFORT_BY_MODEL` in the script — the single source of truth for the tier→effort default — unless `primaryEffort` overrides it. Each stage returns its own changed-file list; the script unions them per slice.

It returns `{ slices: [{ sliceId, status, changedFiles, deferrals, residualFindings, notes, summary }] }`, where `status` is `clean` | `needs-attention` | `blocked`.

> **Workflow return contract (overrides the templates' inline-marker prose).** The slice agents run unattended under a forced schema, so they must **map their intent into the return object, never act on it**: a `[SPEC]`/`[TEST]` ambiguity → a `deferrals[]` entry (do **not** call `AskUserQuestion` — it can't pause); `[NOTE-DURABLE]`/`[NOTE-SCRATCH]` → `notes.durable[]`/`notes.scratch[]` (do **not** write the spec/scratchpad directly — the orchestrator routes them in 4.3); every file touched → that stage's changed-file list. When you inline a template into `templates:{}`, prepend this one-line reminder so the agent honors the contract.

## 4.3 Per-slice orchestrator post-processing

For each returned slice, in deterministic order (so commits never race):

1. **Deferrals first.** Any `deferrals` (or `status: blocked`) → pause and resolve with the user (`AskUserQuestion`): `SPEC` → clarify + update spec; `TEST` → reconcile against the spec's Contracts block; `CRITICAL`/HIGH-security → user decision. Then re-run that single slice via another slice-wave call with a one-slice `slices` array. Do not commit a blocked slice.
1. **Commit the slice** (only if `permissions.slice_commits`). `git -C "$cwd" add <changedFiles>` then commit (Conventional Commits, e.g. `feat(<scope>): <slice name>`). Scoped to the slice's own files, so parallel-built slices commit cleanly one after another.
1. **Append** the slice `summary` to `## Slice Summaries` in the spec.
1. **Route notes** (already structured in the return): `notes.durable[]` → append under `## Agent Notes` as `- (slice N, <agent>) <text>`; `notes.scratch[]` → append to `SCRATCH_PATH`. Append-only.

After the whole layer is committed: `/compact`. Carry forward: spec path, scratch path, completed slice IDs, remaining layers + dependency map, permissions, cwd.

> **GATE (per layer):** all slices committed OR deferrals resolved + re-run + committed.
> **GATE (step 4):** all layers complete, all slices committed.
