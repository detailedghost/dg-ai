# Slice Engineering Template (Yellow stage)

> [Common directives.] Read **[Slice Section]** — skip other slices. Also read `## Code Structure` (if present) — its type shapes, module homes, and error conventions are already-ratified contracts spanning slices; build to them rather than re-deciding, and if one genuinely can't work here, raise it as a `deferrals[]` entry instead of diverging silently. \[IF slice > 1: read `## Slice Summaries` and `## Agent Notes` (if present).\] Implement full vertical slice: data model, business logic, API, UI, wiring. **Run tests until all Red tests pass (max 3 attempts).** Report `[TEST]` for suspected misinterpretations. Escalate after 3 failures. Update checkboxes in your slice's Engineering section only.
> **Prototype fidelity:** If your slice references a prototype (see the spec's `## Prototypes` / frontmatter `prototypes`), open that asset and reproduce its design and feature set **completely** — it is the settled source of truth for look/flow/features, not a loose suggestion. Do not drop features or re-decide what it resolved. If the prototype **conflicts with the current code design** (data shape, existing components, framework constraints it couldn't see), do **not** silently diverge or force-fit it and do **not** call `AskUserQuestion` — surface the mismatch as a `deferrals[]` entry (`[NOTE-DURABLE]` for a cross-cutting one) so the orchestrator can relay the question to the user.
> Report cross-slice findings via `[NOTE-DURABLE] <text>` (lands in spec) or `[NOTE-SCRATCH] <text>` (lands in scratchpad). See `agents.md` "Agent Notes Protocol".
> Test files: [list from qa-writer Red]
> Scratchpad: `{SCRATCH_PATH}` (optional reading)
>
> **Exit gate — do ALL of this before you return; returning the schema IS the completion signal, never stop short of it:**
>
> 1. Run the slice's tests. Set `testsPass` honestly — `true` only if every Red test is green now. If still failing after 3 attempts, set `testsPass:false` and add a `[TEST]`/CRITICAL `deferrals[]` entry; do **not** exit silently.
> 1. Put **every** file you created or modified in `changedFiles` — the orchestrator commits exactly that list, so an omitted file is silently dropped (the recurring "subagent left work uncommitted" failure). Include test files you touched.
> 1. Surface anything you couldn't finish as a `deferrals[]` entry rather than terminating mid-task. Never call `AskUserQuestion` — it can't pause a workflow.
