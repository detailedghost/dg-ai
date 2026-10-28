# Slice Engineering Template — Proxy Delegation (Yellow stage)

> Read **[Slice Section]** — skip other slices. Also read `## Code Structure` (if present) — already-ratified cross-slice contracts (type shapes, module homes, error conventions). This slice delegates its engineering work to an external CLI agent via `/dg:proxy`; you stay in the loop to drive `/dg:proxy`, verify its output, and report back. You keep your assigned persona/agentType for this — `/dg:proxy` only changes who writes the code, not who's accountable for it.
>
> 1. Build a task prompt from `{SLICE_BRIEF}` + `{TESTING_CRITERIA}`, **inlining the `## Code Structure` entries that apply to this slice** — the external backend cannot read the spec, so a convention you leave out is a convention it will violate. If `{FINDINGS}` below is non-empty, address those specifically instead of re-implementing from scratch — append them to the prompt as the concrete issues to fix.
> 2. Run: `~/.dg/bin/dg-skills proxy {PROXY_BACKEND} --prompt "<task prompt>" --subagent {PRIMARY_AGENT} --cwd <repo working directory>`
> 3. Handle the result per `/dg:proxy`'s own contract (its SKILL.md): missing backend → stop and report to the orchestrator; a clarifying question → answer directly if you can from `{SLICE_BRIEF}`/`{TESTING_CRITERIA}`/dg:spec context and re-invoke with `--resume <sessionId>`, else add a `deferrals[]` entry carrying the question and stop; a model/effort rejection → add a `deferrals[]` entry and stop. Cap at 5 round-trips total — if still unresolved, stop and hand off as-is.
> 4. Once `/dg:proxy` reports the delegated work complete, verify it yourself: run this project's actual test command against `{CHANGED_FILES}`-relevant scope (whole suite if scope is unclear) and confirm it passes. Don't trust a green claim from the backend — check it.
> 5. Run `git status` / `git diff --name-only` in the working directory to determine what actually changed — the external backend's own report of touched files may be incomplete or wrong.
>
> Findings: {FINDINGS}
> Spec: {SPEC_PATH}
> Scratchpad: {SCRATCH_PATH}
>
> **Exit gate — do ALL of this before you return; returning the schema IS the completion signal, never stop short of it:**
> 1. Set `testsPass` honestly from your own verification run in step 4, not from `/dg:proxy`'s claim.
> 2. Populate `changedFiles` from the `git status`/`git diff --name-only` result in step 5 — the orchestrator commits exactly that list, so an omitted file is silently dropped.
> 3. Return: `{ changedFiles: string[], testsPass: boolean, attempts?: number, securitySensitive?: boolean, deferrals: [], notes: {} }`. Leave `deferrals`/`notes` empty unless something genuinely needs orchestrator attention — do not resolve deferrals yourself, do not write the spec/scratchpad directly. Never call `AskUserQuestion` — it can't pause a workflow; route every unresolved question through `deferrals[]`.
