# /dg:spec cost profiles and greedy parallel build — Initial Notes

## Purpose
Replace the per-slice model and effort prompts in /dg:spec with one cost profile (balance, cheap, expensive) that is persisted in plan.md frontmatter, reused by execute mode, and applied by the CLI when it resolves slice-wave stages. Make the build step start each slice as soon as its dependencies finish instead of waiting for a whole dependency layer. Add an opt-in --proxy flag so no slice is delegated to an external backend unless asked, and a --bg flag that runs execute mode unattended and exits resumable on any open question.

## Scope
### Included
- --profile <balance|cheap|expensive> (-p) on /dg:spec plan, fast and execute modes, with --cheap and --expensive as long-form-only aliases; no flag means balance and asks nothing
- Token and context efficiency: SKILL.md files stay short routers and gain only flag rows and reference-table rows; new detail lives in lazy references read only when the flag is used; no text is duplicated between SKILL.md and references or across spec, sdlc and assign
- execution.profile persisted in plan.md frontmatter (schema enum, mutable) and projected into context.md; -s reuses it, -s --profile X rewrites it
- slices[].agents.complexity (low|medium|high) rated by /dg:assign at plan time; slices[].agents.model (haiku|sonnet|opus|fable) as an optional human override that replaces the ## Execution pin
- A profiles table in model-tiers.json applied by dg-skills assign resolve: cheap lowers effort one step and caps slice-wave corrections at 1; expensive raises medium slices one effort step and moves high slices to the opus tier
- Under cheap, finish.md step 5 also caps at 1 correction round and runs its four final reviewers one effort step lower
- dg-skills spec estimate <plan.md> printing one cost line per profile for the plan view's Cost section
- Plan approval gate with Approve (balance) / Approve as cheap / Approve as expensive / Rework, collapsing to Approve / Rework when --profile was given; the step-5 per-slice escalate prompt is removed
- Greedy readiness: one slice-wave Workflow call covers every pending slice; a slice starts as soon as each slice it depends on has finished inside the run; the orchestrator commits finished slices in dependency order after the call
- lint-waves and scaffold fail when any two slices with no dependency path between them share files, not only same-layer pairs
- Commit subject marker <type>(<scope>): slice-<N>: <name> so dg-skills spec ready can see a slice's commit; ready and resolve read the log from --cwd
- --proxy <backend> (-x): plan mode runs the per-slice delegation prompt only with the flag; -s honors agents.proxy already in the bundle; -s --proxy <backend> offers delegation to slices that have none
- -s <bundle> --bg (-b): unattended execute; every SPEC/TEST/CRITICAL deferral is written to plan.md as an open issue, dependents stay blocked, and the run exits with a resume line instead of asking
### Excluded
- A --profile flag on bare /dg:sdlc runs (they keep balance, which is today's behavior)
- Flag pass-through from /dg:kick, /dg:prd and /dg:pickup to /dg:spec
- execution.proxy or any other persisted record of the --proxy flag beyond slices[].agents.proxy
- Enum enforcement in dg-skills spec set for existing fields such as status
- Real token counts; the estimate reports agent calls by tier
- Running the slice-wave Workflow from inside a background subagent or a detached claude -p session
- Changes to the roundtable (plan-mode step 5 fan-out) prompt text beyond the model and effort tier lines
- Cross-repo bundles (pr_strategy: cross-repo)
