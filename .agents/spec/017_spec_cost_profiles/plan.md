---
feature: "/dg:spec cost profiles and greedy parallel build"
feature_snake_case: spec_cost_profiles
date: "2026-11-04"
version: "1.0"
status: draft
current_slice: 0
pr_strategy: single
slices:
  - id: 1
    name: "profile-schema-and-cli"
    depends_on: []
    files: ["plugins/dg/skills/spec/spec-schema/frontmatter-schema.yaml", "plugins/dg/skills/assign/references/model-tiers.json", "pkg/skills-cli/src/tiers.ts", "pkg/skills-cli/src/assign/**", "pkg/skills-cli/src/spec/fields.ts", "pkg/skills-cli/src/spec/context.ts", "pkg/skills-cli/src/spec/lint-waves.ts", "pkg/skills-cli/src/spec/estimate.ts", "pkg/skills-cli/src/spec/index.ts", "pkg/skills-cli/__tests__/assign-resolve.spec.ts", "pkg/skills-cli/__tests__/tiers.spec.ts", "pkg/skills-cli/__tests__/spec-contracts.spec.ts", "pkg/skills-cli/__tests__/spec-skill-tree.spec.ts", "pkg/skills-cli/__tests__/spec-estimate.spec.ts", "pkg/skills-cli/__tests__/hooks/spec-plan-lint.spec.ts", "pkg/skills-cli/__tests__/fixtures/assign/**", "pkg/skills-cli/__tests__/fixtures/spec/goldens.json", "pkg/skills-cli/src/spec/scaffold.ts"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 2
    name: "greedy-slice-wave-runtime"
    depends_on: [1]
    files: ["plugins/dg/skills/sdlc/references/templates/slice-wave.workflow.js", "plugins/dg/skills/sdlc/references/engineering.md", "plugins/dg/skills/sdlc/references/setup.md", "plugins/dg/skills/sdlc/SKILL.md", "pkg/skills-cli/__tests__/assign-resolve.spec.ts", "pkg/skills-cli/__tests__/slice-wave-runner.spec.ts", "plugins/dg/skills/sdlc/references/finish.md", "plugins/dg/agents/foreman.md"]
    agents:
      primary: dg:js
      confidence: high
      qa: [dg:qa-code]
  - id: 3
    name: "spec-profile-and-proxy-flags"
    depends_on: [1, 4]
    files: ["plugins/dg/skills/spec/SKILL.md", "plugins/dg/skills/spec/references/plan.md", "plugins/dg/skills/spec/references/fast.md", "plugins/dg/skills/spec/references/execute.md", "plugins/dg/skills/spec/references/templates/plan-view.md", "plugins/dg/skills/spec/references/templates/slice-review.md", "pkg/skills-test/__tests__/plan-approval-gate.spec.ts", "pkg/skills-test/__tests__/spec-cost-profiles.spec.ts", "plugins/dg/skills/spec/references/profiles.md", "plugins/dg/skills/spec/references/decision-blob.md", "plugins/dg/skills/spec/references/proxy.md"]
    agents:
      primary: dg:lore
      confidence: high
      qa: [dg:reviewer]
  - id: 4
    name: "assign-complexity-rating"
    depends_on: []
    files: ["plugins/dg/skills/assign/SKILL.md", "plugins/dg/skills/assign/references/spec-mode.md", "plugins/dg/skills/assign/references/edge-cases.md", "pkg/skills-test/__tests__/assign-complexity-docs.spec.ts"]
    agents:
      primary: dg:lore
      confidence: high
  - id: 5
    name: "background-execute"
    depends_on: [2, 3]
    files: ["plugins/dg/skills/spec/SKILL.md", "plugins/dg/skills/spec/references/execute.md", "pkg/skills-test/__tests__/spec-bg-execute.spec.ts", "plugins/dg/skills/spec/references/bg.md", "pkg/skills-test/__tests__/spec-cost-profiles.spec.ts"]
    agents:
      primary: dg:lore
      confidence: high
      qa: [dg:reviewer]
---

# /dg:spec cost profiles and greedy parallel build

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
- Under --bg, a CRITICAL or HIGH-security residual after finish.md step 5's last round becomes a deferral row and pauses the run; every other residual goes to Issues Remediation and the draft PR opens
- Lazy references read only with their flag: references/profiles.md (--profile, --cheap, --expensive), references/proxy.md (--proxy), references/bg.md (--bg)
### Excluded
- A --profile flag on bare /dg:sdlc runs (they keep balance, which is today's behavior)
- Flag pass-through from /dg:kick, /dg:prd and /dg:pickup to /dg:spec
- execution.proxy or any other persisted record of the --proxy flag beyond slices[].agents.proxy
- Enum enforcement in dg-skills spec set for existing fields such as status
- Real token counts; the estimate reports agent calls by tier
- Running the slice-wave Workflow from inside a background subagent or a detached claude -p session
- Changes to the roundtable (plan-mode step 5 fan-out) prompt text beyond the model and effort tier lines
- Cross-repo bundles (pr_strategy: cross-repo)

### Slice 1 — profile-schema-and-cli

#### Engineering
- [ ] Add top-level `execution` (type object, mutability mutable) with field `profile` (type string, enum [balance, cheap, expensive]) to frontmatter-schema.yaml
- [ ] Add `complexity` (type string, enum [low, medium, high], mutable) and `model` (type string, enum [haiku, sonnet, opus, fable], mutable) under `slices.item_schema.agents.fields` in frontmatter-schema.yaml
- [ ] Extend `validateCommand` in fields.ts so an object field's `fields.*.enum` is checked one level down and reported as `enum_violation` with the dotted path (for example `execution.profile`)
- [ ] Add `execution` to the top-level projection in context.ts `bundleContext` when present, and `complexity` and `model` to `projectSlice` under `agents` when set
- [ ] Add a `profiles` key to model-tiers.json: balance {effortStep 0, correctionRounds 2}, cheap {effortStep -1, correctionRounds 1}, expensive {effortStep 0, correctionRounds 2, complexity {medium {effortStep 1}, high {tier opus}}}
- [ ] Add `applyProfile(stage, profile, complexity, role)` to tiers.ts: shift effort one rung along the ladder and clamp at both ends; the ladder is the ordered set of distinct effort values in the selected runtime's tier rows (`low, medium, xhigh` for claude and codex; `low, medium, high` for grok); apply the profile-wide effortStep to primary, qa-writer and qa[] stages only; apply complexity rules to the primary stage only; never lower a tier through a profile rule
- [ ] Precedence rules: (a) a set `agents.effort` is never shifted; (b) `agents.model` fixes the tier only, so expensive's medium rule still shifts effort; (c) never-lower binds profile rules only, a human `agents.model: haiku` is honored; (d) `agents.model: opus` under cheap resolves to `opus`/`medium`
- [ ] `security`, matched by bare persona name, keeps its tier default wherever it appears, including inside `agents.qa`
- [ ] `assign resolve` and `spec estimate` exit 1 with `slice <N> agents.model "<x>" is not a tier` for a value outside the tier table; the schema descriptions for `complexity` and `model` say the enum is enforced by `assign resolve`, not by `validate`
- [ ] In assign/index.ts read `execution.profile` from the plan frontmatter (absent means balance), apply it through `applyProfile`, and bake `profile` and `maxCorrectionRounds` into WAVE_ARGS
- [ ] Resolve the primary tier as `agents.model` when set, else the profile's complexity rule, else the model-tiers.json agents entry; a `fable` request on a non-fable primary still exits 1 with the existing message
- [ ] Delete `executionPin`, the `Pin` interface, `PIN_KEY` and `PIN_LINE` from assign/index.ts; `## Execution` text in a plan is ignored
- [ ] Set `proxyFlags` from the resolved primary stage: `--tier <tier>` when the resolved tier differs from the persona's table tier, and `--effort <effort>` when the resolved effort differs from the default effort of the resolved tier's runtime row (the only form `proxy/tier.ts applyTier` round-trips)
- [ ] Add `--slices <id,id>` to `assign resolve` and make the default selection (no `--layer`, no `--slices`) every slice whose `slice-<id>:` marker is absent from `git log --pretty=%s <merge-base>..HEAD` run in `--cwd`, where `<merge-base>` is `git merge-base HEAD <default>` and `<default>` is resolved as `dg-skills worktree create` resolves it (origin/HEAD, main or master); a run on the default branch sees every slice as pending; keep `--layer N` as an explicit filter
- [ ] Selector edge cases: `--layer` with `--slices` exits 2 (usage); a default selection with nothing pending prints `no pending slices`, writes no runner and exits 0; `--cwd` outside a repo or a failing `git log` exits 1 and never selects every slice
- [ ] Bake `dependsOn: [<id>]` into each WAVE_ARGS slice, listing only dependency ids that are also in the selection
- [ ] Name the runner file `slice-wave.<selection>.workflow.js` where selection is `layer<N>`, `s<id>-<id>` for `--slices`, or `pending` for the default
- [ ] Add `--cwd <dir>` to `spec ready` so the commit log is read from that directory's `merge-base..HEAD` range (same `<default>` resolution as resolve) instead of the spec file's repo root; without `--cwd` today's whole-log behavior stays
- [ ] Change lint-waves to report `OVERLAP: slice <p> <-> slice <q> (independent)` for every pair with no dependency path in either direction, keep the `layer N:` lines, and end with `FAIL: independent slices share files; serialize them with depends_on` or `ok: no overlap between independent slices`
- [ ] Add `pkg/skills-cli/src/spec/estimate.ts` with `estimateCommand`, register `estimate` in spec/index.ts USAGE and HANDLERS, and add it to SUBCOMMANDS in spec-contracts.spec.ts
- [ ] Make `spec estimate <plan.md> [--profile <p>] [--runtime <r>]` print one line per profile (all three in the order balance, cheap, expensive when `--profile` is absent) in the exact form `<profile>: <n> slices · <calls> agent calls (<h> haiku, <s> sonnet, <o> opus, <f> fable) · up to <r> correction rounds` where calls counts red, yellow, green, files and wave once per slice plus each qa[] reviewer once per slice
- [ ] Share the stage-resolution code between `assign resolve` and `spec estimate` through one exported function in a new `pkg/skills-cli/src/assign/stages.ts` (covered by the `src/assign/**` glob); it reads no sdlc templates and no proxy skill files; `spec/estimate.ts` imports it and `assign/index.ts` keeps the template inlining
- [ ] `spec estimate` rules: a slice without `agents.primary` exits 1 with resolve's `run /dg:assign` message; a proxied slice's yellow call counts at the primary's resolved tier; the conditional `security` reviewer and correction rounds are not counted (the line is a lower bound); `-h`/`--help` exits 0; a `--runtime` outside claude, codex, grok exits 2 like `--profile`
- [ ] scaffold.ts refusal text becomes `refusing to scaffold: independent slices overlap (fix depends_on, or pass --allow-overlap)`; the spec/index.ts USAGE row for lint-waves becomes `fail when independent slices share files`; keep the per-pair glob lines and the `fix: add p to slice q depends_on` line under each `OVERLAP:` header; update the two scaffold goldens
- [ ] Add `execution` to SCHEMA_FIELDS in spec-skill-tree.spec.ts
- [ ] Delete fixtures plan-fable-pinned-js.md and plan-pin-opus-js.md and the `## Execution` tests; rewrite `plan-fable.md` from its `## Execution` section to `agents.model: fable` with `agents.effort: xhigh`; rewrite the inline `## Execution` proxy test (assign-resolve.spec.ts:848) as an `agents.model: opus` case; add fixtures plan-profile-expensive.md (complexity low, medium, high on sonnet primaries plus one dba primary) and plan-profile-cheap.md
- [ ] Regenerate the three layer0.<runtime>.golden.json fixtures so they carry `profile`, `maxCorrectionRounds` and `dependsOn`

#### Testing Criteria
##### Contracts
- [ ] Contract: `dg-skills spec validate` on a plan with `execution: {profile: turbo}` exits 1 with one diagnostic `{field: "execution.profile", kind: "enum_violation"}`; with `profile: cheap` it exits 0
- [ ] Contract: `dg-skills spec set plan.md execution.profile expensive` on a plan without an `execution` block exits 0 and the plan then has `execution:\n  profile: expensive` with every other byte unchanged
- [ ] Contract: `dg-skills spec context <bundle>` writes `execution.profile` and `agents.complexity` into context.md when present and omits both keys when absent
- [ ] Contract: `assign resolve` on a plan with `execution.profile: cheap` gives a sonnet primary effort `low`, the qa-writer role effort `low`, wave `low`, security `xhigh`, and `maxCorrectionRounds: 1`
- [ ] Contract: `assign resolve` with `execution.profile: expensive` gives a `complexity: medium` sonnet primary effort `xhigh` and model `sonnet`, a `complexity: high` sonnet primary model `opus` effort `xhigh`, a `complexity: low` primary unchanged, and a `complexity: high` dba primary still `opus`
- [ ] Contract: `assign resolve` with `execution.profile: expensive` leaves qa[] reviewer stages at their tier defaults
- [ ] Contract: `agents.model: opus` on a sonnet primary under balance resolves to model `opus` effort `xhigh`; `agents.effort: low` on the same slice resolves to `opus` `low`
- [ ] Contract: a plan whose body has `## Execution\nmodel: opus` resolves exactly as a plan without that section
- [ ] Contract: `assign resolve <plan> --cwd <repo>` with no selector flag selects only slices lacking a `slice-<id>:` commit subject in that repo's log; `--slices 1,3` selects exactly those ids; `--layer 1` still selects the layer
- [ ] Contract: each baked slice carries `dependsOn` limited to ids inside the selection
- [ ] Contract: a proxied slice resolved to tier opus under expensive carries `proxyFlags: "--tier opus"` (effort omitted because it equals the opus row default)
- [ ] Contract: lint-waves on slices 1 (files a/**, no deps), 2 (files b/**, depends on 1) and 3 (files a/**, no deps) exits 1 naming `slice 1 <-> slice 3 (independent)`; the same blob with 3 depending on 1 exits 0
- [ ] Contract: lint-waves on slices 1 (a/**) and 2 (a/**, depends on 1) exits 0 and prints `layer 0: 1\nlayer 1: 2\nok: no overlap between independent slices\n`
- [ ] Contract: `spec ready spec.md 2 --cwd <dir>` reads `merge-base..HEAD` of <dir>; without `--cwd` it keeps today's whole-log behavior
- [ ] Contract: a `slice-1:` subject below the merge-base is ignored by the default selection and by `spec ready --cwd`
- [ ] Contract: `spec estimate` on the three-slice fixture prints three lines in the order balance, cheap, expensive matching the documented format, and `--profile cheap` prints only the cheap line
- [ ] Contract: `spec estimate --profile turbo` exits 2 with `--profile must be one of balance, cheap, expensive` on stderr
- [ ] Happy path: the layer0 goldens match for claude, codex and grok runtimes
- [ ] Edge: effort shifts clamp (`low` minus one stays `low`; `xhigh` plus one stays `xhigh`)
- [ ] Edge: a slice with no `complexity` under expensive resolves exactly as under balance
- [ ] Edge: `--slices` naming an unknown id exits 1 naming the id
- [ ] Error: `agents.model: fable` on a `dg:js` primary exits 1 with the existing fable message
- [ ] Error: the spec-plan-lint hook still exits 2 with the lint-waves output when independent slices overlap
- [ ] Contract: `spec estimate` stdout is exactly three lines without `--profile` and exactly one line with it; no header, footer or blank line
- [ ] Contract: under cheap with `--runtime grok`, a `dg:dba` primary resolves to `medium` and an opus `qa[]` stage to `medium`; the grok golden carries these values
- [ ] Contract: `agents.effort: medium` under cheap stays `medium`; `agents.model: sonnet` with `complexity: medium` under expensive resolves to `xhigh`; `agents.model: haiku` on `dg:js` resolves to `haiku`
- [ ] Contract: `qa: [dg:security]` under cheap keeps `opus`/`xhigh`
- [ ] Error: `agents.model: gpt` exits 1 naming the slice and the value, from both `assign resolve` and `spec estimate`
- [ ] Edge: `--layer 0 --slices 1` exits 2; a plan whose every slice carries a marker in the merge-base range prints `no pending slices` and exits 0 with no runner file; `--cwd /tmp` exits 1
- [ ] Contract: `spec estimate` on a plan with one unassigned slice exits 1 with the `run /dg:assign` message; `spec estimate -h` exits 0; `--runtime gemini` exits 2
- [ ] Contract: `spec scaffold` on an independent-pair overlap prints `refusing to scaffold: independent slices overlap`; the two scaffold goldens match

#### Acceptance Criteria
- [ ] Given a plan.md with no `execution` block, when `assign resolve` runs, then every stage resolves exactly as on origin/master (balance is the baseline)
- [ ] Given `execution.profile: cheap`, when `assign resolve` runs, then primary, qa-writer and qa[] efforts are one ladder step lower and `maxCorrectionRounds` is 1
- [ ] Given `execution.profile: expensive` and `agents.complexity: high` on a sonnet primary, when `assign resolve` runs, then that primary is `opus` at `xhigh` and no other slice changes
- [ ] Given a bundle with no `execution` block, when `spec validate` runs, then it exits 0 (existing bundles stay valid)
- [ ] Given two slices with no dependency path that share a glob, when `spec scaffold` runs without `--allow-overlap`, then it refuses
- [ ] Given `bun test` in pkg/skills-cli, when the slice is done, then every test passes

### Slice 2 — greedy-slice-wave-runtime

#### Engineering
- [ ] Read `profile` and `dependsOn` from WAVE_ARGS in slice-wave.workflow.js with `profile = "balance"` in the args destructure (not a tier or effort literal); emit `log("profile <p> · correction rounds <n> · slices <ids>")` once at start
- [ ] Gate each slice on a per-slice completion promise placed before the `redDone` short-circuit: every slice, re-run or not, waits until each `dependsOn` id (compared as `String(id)` on both sides) has a final result with status `clean`, or `needs-attention` with no live `CRITICAL` deferral
- [ ] Every slice's gate promise settles in all cases: wrap each slice's stage chain so a throw settles the gate as dropped and then rethrows; a dependent never awaits a promise that cannot settle
- [ ] When a dependency ends `blocked`, `unverified`, dropped, or `needs-attention` with a live `CRITICAL` deferral, return `{sliceId, status: "blocked-upstream", blockedBy: [<id>], changedFiles: [], deferrals: [], unverifiedStages: [], notes: {durable: [], scratch: []}, summary: "blocked upstream by slice <id>"}` without running any stage; carry the upstream block as its own flag (`st.upstream`), never as `st.blocked`, so stage 4 does not map it to `blocked`
- [ ] Keep every existing result field and the `clean | needs-attention | unverified | blocked` statuses unchanged; add `blocked-upstream` to the status list in the header comment only; meta.description becomes one pure-literal line that describes the greedy run; the header comment documents `profile` and `dependsOn` in the args block, rewrites the `ONE dependency layer` line, and says `args` must come from `assign resolve` because a cycle in hand-passed `args` hangs the run
- [ ] Keep the runner free of tier names and effort values as string literals (the existing runner test enforces this)
- [ ] Rewrite engineering.md 4.1 as: compute the pending set and dependency graph; keep one order sentence (the topological order is the `layer N:` order printed by `spec lint-waves`, which fast.md F7 relies on); the invariant becomes `any two slices with no dependency path between them MUST touch disjoint files`; list shared lockfiles, fixed /tmp paths and build output directories as overlap the globs cannot show
- [ ] Rewrite engineering.md 4.2 as one call: `dg-skills assign resolve "$SPEC_PATH" --scratch "$SCRATCH_PATH" --wave <scratchpad> --cwd "$cwd"` with no `--layer`, then one `Workflow({ scriptPath })`; keep the 4.1, 4.2 and 4.3 heading numbers
- [ ] Rewrite engineering.md 4.3 so post-processing walks results in dependency order, commits each `clean`/`needs-attention` slice with subject `<type>(<scope>): slice-<N>: <slice name>`, commits a path that two slices both changed with the later slice and names it in that commit body, does not commit `blocked`, `blocked-upstream` or `unverified` slices, sets `current_slice` per slice here, and records `slice_base_sha` once before the call; keep the pinned sentence `1. **Deferrals first.** Any \`SPEC\`, \`TEST\` or \`CRITICAL\` deferral (or \`status: blocked\`)` verbatim
- [ ] engineering.md 4.3 re-run rule after resolving deferrals: when `permissions.slice_commits` is granted, call `assign resolve` with the default selection (committed slices now carry markers, so the pending set is exactly the blocked, unverified and blocked-upstream slices); when commits are off, pass `--slices` with the blocked, unverified and blocked-upstream ids together so `dependsOn` edges survive; order is resolve first, then edit `resolved`/`redDone`/`notes` in the baked literal, then `Workflow`
- [ ] State in engineering.md 4.2 that the profile is read from `execution.profile` by the helper and that `WAVE_ARGS.profile` is informational
- [ ] Replace the `## Execution` pin paragraphs in engineering.md 4.2 with `agents.model` as the per-slice tier override
- [ ] Change engineering.md's `/compact` note to once after the whole call
- [ ] Change setup.md step 3's token estimate bullet to print the output of `dg-skills spec estimate "$SPEC_PATH" --profile balance` (bare /dg:sdlc has no profile choice), setup.md step 3's `dependency layers` to `dependency order`, and setup.md step 2's disjoint-files rule to the no-dependency-path wording
- [ ] Stale layer wording in owned files: finish.md step 8g `dependency-layer data` becomes `depends_on data`; finish.md step 5's heading `max 2 rounds total` becomes `max rounds per profile: 2, cheap 1` and sub-step c `After round 2` becomes `After the last round`
- [ ] foreman.md line 26 becomes `Slices with no dependency path between them touch disjoint files`
- [ ] Change sdlc/SKILL.md pipeline row 4 in place, with no net new line, from `per dependency layer` to `all pending slices in one call, each gated on its dependencies`
- [ ] Move these describe blocks out of assign-resolve.spec.ts into slice-wave-runner.spec.ts and extend them there: `slice-wave runner`, `slice-wave runner correction deferrals`, `slice-wave runner deferral handling`, `engineering deferral gate`; `slice ownership globs` and `slice context isolation` test `assign resolve` and stay
- [ ] The fake harness matches `pipeline()`: a throwing stage drops that item to `null` instead of rejecting; the fake `agent` holds slice 1's calls on a manual deferral for the ordering tests
- [ ] Both doc assertions (finish.md step 5 wording, sdlc/SKILL.md line budget) live in slice-wave-runner.spec.ts
- [ ] Add a case-sensitive effort-literal assertion `/(["'`])(low|medium|high|xhigh|max)\1/` beside the tier-literal regex; the gate code adds no `agentType:` keys and no role-name literals (agent-namespacing.spec.ts)
- [ ] finish.md step 5: read the profile once with `dg-skills spec get "$SPEC_PATH" execution.profile` (any non-zero exit or absent value means balance); under cheap the correction cap is 1 round and dg:reviewer, dg:qa-perf and dg:qa-devops run at `low` and dg:security at `medium`; balance and expensive leave step 5 unchanged
- [ ] Keep every sdlc text change to the sentences that change; no paragraph from engineering.md, setup.md or finish.md is repeated in spec/references or assign/references (checked at finish.md step 5 final review, because slices 3 and 4 edit the other side concurrently); sdlc/SKILL.md stays at or under 74 lines

#### Testing Criteria
##### Contracts
- [ ] Contract: WAVE_ARGS `{slices: [{id: 1, dependsOn: []}, {id: 2, dependsOn: [1]}]}` runs slice 2's red stage only after slice 1's final result resolves (assert call order in the fake harness)
- [ ] Contract: when slice 1 returns `blocked`, slice 2 returns `{status: "blocked-upstream", blockedBy: [1]}` and no agent call carries a label ending in `:2`
- [ ] Contract: when slice 1 returns `needs-attention` with no `CRITICAL` deferral, slice 2 still runs; with a live `CRITICAL` deferral slice 2 is `blocked-upstream`
- [ ] Contract: a re-run slice with `redDone` set still waits for its dependencies
- [ ] Contract: string ids (`A`, `A2`) gate correctly; a numeric `1` and a string `"1"` refer to the same slice
- [ ] Contract: the ordering test asserts `red:3` was called and `red:2` was not before slice 1's manual release
- [ ] Contract: independent slices 1 and 3 start without waiting on each other
- [ ] Contract: the runner logs the profile line once with the baked profile and correction rounds
- [ ] Contract: with `maxCorrectionRounds: 1` the correction loop runs at most one fix round
- [ ] Happy path: every existing runner test (deferrals, resolved prefixes, redDone, path safety, ownership globs) still passes from its new file
- [ ] Edge: a slice whose `dependsOn` names an id outside the run is treated as already done
- [ ] Edge: the runner contains no tier name or effort level string literal
- [ ] Error: a dependency whose pipeline threw (dropped slice) makes its dependents `blocked-upstream`
- [ ] Contract: finish.md step 5 names `execution.profile`, a cap of `1` round under cheap, and the four reviewer efforts under cheap (in slice-wave-runner.spec.ts)
- [ ] Contract: sdlc/SKILL.md has at most 74 lines (line-budget assertion in slice-wave-runner.spec.ts, in the pattern of hooks-skill.spec.ts `stays within the line budget`)
- [ ] Contract: the runner contains no lowercase effort literal (`low|medium|high|xhigh|max` in quotes)
- [ ] Contract: engineering.md 4.3 names the default selection for re-runs with commits on, `--slices` with commits off, and the shared-file commit rule

#### Acceptance Criteria
- [ ] Given slices 1 and 2 where 2 depends on 1 and slice 3 is independent, when the Workflow runs, then slice 3 starts at once and slice 2 starts the moment slice 1 finishes
- [ ] Given slice 1 blocks on a SPEC deferral, when the run ends, then slice 2 is `blocked-upstream`, slice 3 is complete, and the orchestrator commits slice 3 only
- [ ] Given engineering.md after the change, when read, then headings 4.1, 4.2 and 4.3 still exist and no `--layer` argument appears in the resolve command
- [ ] Given engineering.md 4.3, when read, then the commit subject format names `slice-<N>:`
- [ ] Given `execution.profile: cheap` in the spec, when finish.md step 5 runs, then at most one correction round runs and the four final reviewers run one effort step lower
- [ ] Given the sdlc text after the change, when compared with spec/references and assign/references at finish.md step 5 final review, then no paragraph appears in two places
- [ ] Given a dependency whose pipeline throws, when the run ends, then its dependents are `blocked-upstream` and the Workflow returns

### Slice 3 — spec-profile-and-proxy-flags

#### Engineering
- [ ] Add `--profile <balance|cheap|expensive>` (short `-p`), `--cheap` (Short column `none`), `--expensive` (Short column `none`) and `--proxy <backend>` (short `-x`) to the SKILL.md Usage line and the four-column Flags table; `--cheap` and `--expensive` are aliases of `--profile cheap|expensive`; two profile flags at once is an error that names both
- [ ] Add a Mode dispatch rule on the existing `FAST_MODE = …` line: `PROFILE` is unset unless a profile flag is given; plan and fast mode read unset as balance; execute mode reads the persisted `execution.profile`; a missing or invalid value after `--profile`/`-p` stops with `--profile must be one of balance, cheap, expensive`; two profile flags with the same value are allowed, with different values an error that names both; edit the existing line-40 sentence in place to `--fast` is mutually exclusive with `-s` and with `--proxy`
- [ ] Validate `--proxy <backend>` against `dg-skills proxy --list-backends` at dispatch, before any phase, for plan mode and `-s`; one Bash call only when the flag is present
- [ ] plan.md step 3c: note that `/dg:assign` now writes `agents.complexity` per slice
- [ ] plan.md step 5 and slice-review.md: delete the per-slice escalate `AskUserQuestion`; slice-review.md keeps one balance line (`sonnet`/`medium`); the `--cheap` and `--expensive` deltas live only in profiles.md
- [ ] Create `references/profiles.md` (lazy, read only when a profile flag is present) holding: plan-mode effort under `--cheap` (steps 1, 2 and 6 personas at `fable`/`medium`; steps 1.5 and 5 at `sonnet`/`low`) and under `--expensive` (step-5 review of `complexity: high` slices at `opus`/`medium`); the `-s --profile X` sequence (`spec set execution.profile X` on the origin checkout's plan.md, the same file as `SPEC_PATH`, then `spec context <bundle>`, then `/dg:assign <plan>` when `expensive` and any slice lacks `complexity`, naming slice 4's backfill behavior without restating its rubric or Gate rule), which runs before execute.md §1 reads context.md; plan mode never skips steps 5 and 6
- [ ] Create `references/proxy.md` (lazy, read only with `--proxy`) holding the per-slice delegation question with the backend fixed to `<backend>`, `spec set agents.proxy`, and the `proxy_skills` question; plan.md step 7c becomes one conditional sentence pointing at it and, without the flag, skips 7c and sets no `agents.proxy`
- [ ] plan.md step 7d: replace only the hand-estimate sentence with `dg-skills spec estimate <bundle>/plan.md` (default runtime; add `--profile <p>` when a profile flag was given); keep the WARN, the optimize offer and `do not persist`; re-run the estimate inside step 8's Rework loop
- [ ] plan.md step 8 and plan-view.md: the Cost section lists the estimate lines, one per profile; the `AskUserQuestion` options are `Approve (balance)`, `Approve as cheap`, `Approve as expensive`, `Rework`, or `Approve` and `Rework` when a profile flag was given (four options is the `AskUserQuestion` cap); on any Approve run `dg-skills spec set <bundle>/plan.md execution.profile <chosen>` before step 9; keep `loop until Approve`, `AskUserQuestion`, `Approve`, `Rework` and no `ExitPlanMode`/`EnterPlanMode`; plan-view.md's closing list becomes `ask per plan.md step 8: Approve (with the profile choice) or Rework`
- [ ] plan.md step 9: state that `spec context` projects `execution.profile` into context.md
- [ ] fast.md F3/F4: the plan file names the profile; `ExitPlanMode` approval is the profile approval; F5 sets `execution.profile` right after scaffold and before `spec context`; one sentence at F5 states the fast-mode effects: the profile is persisted for a later `-s`, and under `cheap` finish.md step 5 at F8 runs with the lower cap; F7 is unchanged except step 4's subject, which becomes `<type>(<scope>): slice-<N>: <slice name>`; fast.md names `references/profiles.md` nowhere
- [ ] execute.md §1: one sentence: read `execution.profile` from plan.md (absent means balance); with `-s --profile`, read `references/profiles.md` first. No other profile prose in execute.md
- [ ] plan.md Context management: one sentence: with `--profile`, `--cheap` or `--expensive`, read `references/profiles.md` before step 1. No other profile prose in plan.md outside steps 7d and 8
- [ ] execute.md §4: one conditional sentence: with `-s --proxy <backend>`, read `references/proxy.md` and ask its per-slice question for slices without `agents.proxy`; without the flag, `agents.proxy` in the bundle is honored as written
- [ ] execute.md §5 becomes a pointer to engineering.md 4.2-4.3 plus deltas: delete the `assign resolve` command block and the `for each layer` sentence; keep one sentence for `dg-skills spec ready <plan> <N> --cwd "$WORKTREE_PATH"` as the resume check; do not restate the commit subject or the post-processing order; reword `One PR per slice` so each PR runs `assign resolve --slices <its ids>`; note that bundles whose commits predate the marker re-select every slice, so use `--slices` by hand there
- [ ] SKILL.md edits are in place except the four Flags rows and two reference-table rows (`references/profiles.md`, `references/proxy.md`): pipeline row 5 loses `per-slice opt-in escalate`; row 7 `assign /dg:proxy slices` becomes `--proxy slices`; row 8 reads `Plan approval gate (plan view; Approve as a profile, or Rework)`; the slice-review.md reference row drops `opus-medium-escalation note`; the two-profile-flag error sits inside the `--profile` Effect cell
- [ ] Add spec-cost-profiles.spec.ts in pkg/skills-test pinning: the Flags table rows for `--profile`, `--cheap`, `--expensive`, `--proxy`; step 8's four options; the absence of `Escalate slice` in slice-review.md; `spec estimate` in plan.md step 7d; `execution.profile` in execute.md; the `--fast`/`--proxy` stop rule; execute.md §4's `-s --proxy`; the two-profile-flag error; `only when` wording at each profiles.md and proxy.md pointer; no `same-layer` or `one layer` string in the spec skill text; the `spec set execution.profile` then `spec context` sequence in profiles.md; link matching through `](profiles.md)` and `](proxy.md)`; the SKILL.md line budget as one exported constant, 129 after this slice
- [ ] Net deletions: plan.md step 5 loses the escalate `AskUserQuestion` paragraph and slice-review.md loses its `Model/effort` escalate section; step 7c's default-on ask becomes a one-line condition; steps 5 and 7c end up shorter than on origin/master
- [ ] spec/SKILL.md ends at or under 129 lines
- [ ] Replace every same-layer sentence slice 3 owns with the no-dependency-path wording: plan.md step 2 Rule, fast.md F5 a2, slice-review.md's launch prompt, decision-blob.md line 65

#### Testing Criteria
##### Contracts
- [ ] Contract: SKILL.md Usage line contains `--profile`, `--cheap`, `--expensive` and `--proxy`; the Flags table shows `-p` for `--profile`, `-x` for `--proxy`, and `none` in the Short column for `--cheap` and `--expensive` (skill-flags.spec.ts passes)
- [ ] Contract: plan.md step 8 contains `Approve as cheap`, `Approve as expensive`, `Approve (balance)` and `Rework`, and contains `execution.profile`
- [ ] Contract: plan-view.md's Cost section says one line per profile and references `spec estimate`
- [ ] Contract: slice-review.md no longer contains `Escalate slice`
- [ ] Contract: plan.md step 7c contains `--proxy` and says the question is skipped without it
- [ ] Contract: execute.md contains `-s --profile`, `spec ready` with `--cwd`, no `--layer`, and no `assign resolve` command block; profiles.md contains `spec set execution.profile` followed by `spec context`
- [ ] Contract: fast.md contains `--fast --cheap` and `execution.profile`
- [ ] Contract: spec-skill-tree.spec.ts still passes (every `dg-skills spec` verb named in the skill text is registered, `estimate` included)
- [ ] Happy path: plan-approval-gate.spec.ts updated for the new option names passes
- [ ] Edge: standalone-planning-skills.spec.ts passes (no unshipped command is referenced)
- [ ] Contract: spec-cost-profiles.spec.ts asserts spec/SKILL.md has at most 129 lines from one exported constant (pattern of hooks-skill.spec.ts `stays within the line budget`)
- [ ] Contract: `references/profiles.md` and `references/proxy.md` exist and are linked from SKILL.md's reference-files table; `](profiles.md)` appears once in plan.md and once in execute.md and never in fast.md; `](proxy.md)` appears once in plan.md and once in execute.md
- [ ] Contract: SKILL.md contains neither `Approve as cheap` nor `spec estimate` (gate and estimate detail stay in plan.md and plan-view.md)
- [ ] Contract: no sentence of `references/profiles.md` or `references/proxy.md` appears in SKILL.md, plan.md, execute.md or fast.md
- [ ] Contract: fast.md F7 contains `slice-<N>:` and F5 names `execution.profile` and finish.md step 5
- [ ] Contract: no file under plugins/dg/skills/spec contains `same-layer` or `one layer`
- [ ] Contract: SKILL.md pipeline row 7 reads `--proxy slices` and the slice-review.md reference row has no `escalation` text
- [ ] Contract: SKILL.md's dispatch section says `--proxy` is validated against `dg-skills proxy --list-backends` before any phase

#### Acceptance Criteria
- [ ] Given `/dg:spec "<request>"` with no profile flag, when step 8 runs, then the user sees four options and the chosen one is written to `execution.profile`
- [ ] Given `/dg:spec --profile cheap "<request>"`, when step 8 runs, then the options are Approve and Rework and `execution.profile` becomes `cheap` on Approve
- [ ] Given `/dg:spec "<request>"` without `--proxy`, when step 7 runs, then no per-slice proxy question is asked and no slice has `agents.proxy`
- [ ] Given `/dg:spec -s <bundle> --profile expensive` on a bundle planned as balance, when execute mode starts, then plan.md and context.md both carry `expensive` before `assign resolve` runs
- [ ] Given a bundle whose slices carry `agents.proxy`, when `/dg:spec -s <bundle>` runs without `--proxy`, then those slices are still delegated
- [ ] Given `bun test` in pkg/skills-test, when the slice is done, then every test passes
- [ ] Given a `/dg:spec` run without any profile or proxy flag, when the skill text is loaded, then `references/profiles.md` is never read
- [ ] Given the spec skill text after the change, when `wc -l plugins/dg/skills/spec/SKILL.md` runs, then it prints at most 129
- [ ] Given `/dg:spec --proxy nope "<request>"`, when dispatch runs, then it stops before step 1 and lists the valid backends
- [ ] Given a `/dg:spec` run without `--proxy`, when the skill text is loaded, then `references/proxy.md` is never read

### Slice 4 — assign-complexity-rating

#### Engineering
- [ ] SKILL.md § Common step 2: one new bullet after `effort`, no separate paragraph: `complexity` — `low|medium|high`, spec mode only, always written; rubric in `references/spec-mode.md`; `/dg:assign` never writes `agents.model`, which is a human override; the `may get xhigh with no question` sentence stays; assign/SKILL.md ends at or under 121 lines
- [ ] spec-mode.md: the rubric, one line per level: low = one module and a pattern that already exists in the repo; medium = several files or new behavior with a tested pattern nearby; high = cross-cutting, security-sensitive, ambiguous trade-offs, or no precedent in the repo; the highest level whose condition holds wins and any `high` trigger decides; the rating is judged from the slice text and its `files` globs, not a repo scan; plus one sentence that the `expensive` profile reads it at resolve time, balance and cheap ignore it, and `agents.effort` still wins over the profile's effort shift
- [ ] spec-mode.md Gate: a backfill slice (`primary` set, `complexity` missing) skips steps 3 and 4, never gets an `AskUserQuestion`, and writes exactly one new key; a slice with both is skipped unless `--force`; scope the existing lines 11-13 sentence to `effort`; `--force` keeps today's meaning (re-pick everything) but carries `agents.model` over untouched; backfill on a `status: complete` bundle is out of scope because `-s` runs on non-complete bundles
- [ ] spec-mode.md Write block and Output block: add `complexity: <low|medium|high>` (always written); list `complexity` and `model` in the allowed keys sentence, with `model` marked as human-set, preserved, never written by `/dg:assign`; `--dry-run` prints `complexity` in the proposed YAML
- [ ] spec-mode.md Report: tag order is `s1 → dba [complexity: high] [effort: xhigh override] (qa: security)`; a backfill slice prints `s2 → js [complexity: medium backfilled]` and claims no other change
- [ ] edge-cases.md: three facts in the Escalation section after line 6, under four lines, no rubric: a `high` rating raises nothing by itself; `expensive` moves it to the opus tier at build time; `balance` and `cheap` ignore it; `agents.effort` still wins
- [ ] Add assign-complexity-docs.spec.ts in pkg/skills-test pinning: the three levels in spec-mode.md one line each and the rubric text absent from SKILL.md; `complexity:` in spec-mode.md's write block; the backfill sentence; the allowed-keys sentence naming `complexity` and `model`; the tie-break sentence; the 121-line budget; assert exact phrases from the final text

#### Testing Criteria
##### Contracts
- [ ] Contract: spec-mode.md names `low`, `medium` and `high` with one rubric line each, and the rubric text does not appear in assign/SKILL.md
- [ ] Contract: spec-mode.md's YAML write block contains `complexity:` and its allowed-keys sentence names `complexity` and `model`
- [ ] Contract: spec-mode.md says a slice with `primary` and no `complexity` is backfilled on a plain re-run
- [ ] Contract: assign/SKILL.md says `/dg:assign` never writes `agents.model`
- [ ] Happy path: skill-flags.spec.ts and spec-skill-tree.spec.ts pass unchanged for assign
- [ ] Contract: assign-complexity-docs.spec.ts asserts assign/SKILL.md has at most 121 lines (pattern of hooks-skill.spec.ts `stays within the line budget`)
- [ ] Contract: spec-mode.md says a backfill slice skips the pick and the low-confidence question and writes one key
- [ ] Contract: spec-mode.md names the tie-break (`highest level wins`) and says `agents.effort` wins over the profile shift
- [ ] Contract: spec-mode.md says `--force` preserves `agents.model`

#### Acceptance Criteria
- [ ] Given a scaffolded bundle, when `/dg:assign <bundle>/plan.md` runs, then every slice carries `agents.complexity` with one of the three values
- [ ] Given a bundle assigned before this change, when `/dg:assign <bundle>/plan.md` runs again without `--force`, then only `complexity` is added and `primary`, `qa`, `effort` and `proxy` are untouched
- [ ] Given the written frontmatter, when `dg-skills spec validate` runs after slice 1 has landed (checked at the combined PR), then it exits 0
- [ ] Given a backfill run, when it ends, then no `AskUserQuestion` was asked
- [ ] Given the assign skill text after the change, when `wc -l plugins/dg/skills/assign/SKILL.md` runs, then it prints at most 121

### Slice 5 — background-execute

#### Engineering
- [ ] Add `--bg` (`-b`) to the SKILL.md Usage line (edited in place) and Flags table: execute mode only (`-s`); unattended, stays in this session; use `/dg:bg` to detach; invalid with bare plan mode (stop and say so)
- [ ] Create `references/bg.md` (lazy, read only with `--bg`) holding the unattended contract as deltas only (it replaces engineering.md 4.3 step 1 and finish.md 5.c and copies neither): launch is the first `assign resolve` call; before it, in order: execute.md §1 open-row check (stops first, no side effects), the `-s --profile` sequence (which may ask through `/dg:assign` backfill), permissions, the `-s --proxy` per-slice prompt; all six permission keys (`run_commands`, `git_push`, `gh_pr_create`, `auto_cleanup_worktree`, `slice_commits`, `housekeeping_commit`) must be granted before launch, else ask once for `perms-batch --grant-all` or stop; after launch no `AskUserQuestion` is called; `agents.proxy` slices run unprompted
- [ ] bg.md: each `SPEC`, `TEST` or `CRITICAL` deferral is recorded with `dg-skills spec issues add "$SPEC_PATH" --slice <N> --from deferral --severity high --desc '<TYPE>: <text>'`; `unverified`, dropped and `blocked`-without-deferral results are recorded the same way with `--desc 'UNVERIFIED: <summary>'`; `CONFIRM` is never recorded; the `--desc` text has `|` replaced by `/`, newlines collapsed, and is single-quoted with `'` escaped as `'\''`; a slice with a recorded row and every transitive dependent from `depends_on` is skipped at commit; independent slices finish and commit as usual; the worktree is never removed on pause
- [ ] bg.md: when any row was recorded, skip finish.md 5-8 and print last, literally, `Run paused with <n> open question(s) in ## Issues Remediation. Resume with /dg:spec -s <NNN>_<slug>` where `<n>` is the count of open `from: deferral` rows after the run; the resume line carries no flags because `execution.profile` and `agents.proxy` are persisted; when none was recorded, continue into finish.md 5-8 as a normal run
- [ ] bg.md, finish.md 5.c under `--bg`: a CRITICAL or HIGH-security residual after the last round is recorded as a `--from deferral` row and the run pauses before step 8 with the same resume line; every other residual goes to `## Issues Remediation` as today with no ack and the draft PR opens with them under `## Known Issues (Deferred)`
- [ ] execute.md §1, one sentence: on any `-s` run, list open rows with `dg-skills spec issues list "$SPEC_PATH" --open`, keep rows whose `from` column is `deferral`; without `--bg` ask each one first, `issues resolve --id <n>` it and append the answer under `## Agent Notes`; with `--bg` and open rows present, stop and print them; resume uses the default `assign resolve` selection (never `--slices`) so the blocked slice and its dependents both run; the `resolved` prefix (the text after `<TYPE>: `) is added after the `assign resolve` call in §5, is best effort (SPEC and TEST only), and a resumed slice re-runs red because `redDone` cannot be rebuilt from a row
- [ ] Add spec-bg-execute.spec.ts in pkg/skills-test pinning: the `--bg` Flags row with short `-b` and the words `unattended` and `/dg:bg`; `issues add` with `--from deferral` and `--severity high` in bg.md; the `from` filter in execute.md §1; the six-key rule; the transitive-dependents rule; the `UNVERIFIED:` pause; the `|` sanitizing sentence; `default selection` on resume and no `--slices` in the resume path; `--bg` valid only with `-s`; the `Run paused with` line; the finish.md 5.c hybrid sentence; that bg.md says `AskUserQuestion` is never called after launch; that execute.md names bg.md exactly once; the line budget lives in spec-cost-profiles.spec.ts only
- [ ] execute.md: one sentence in §1: with `--bg`, read `references/bg.md`; the open-deferral check in §1 stays in execute.md because every `-s` run needs it; execute.md §2 states that a resume derives the same slug from `<NNN>_<slug>` so `dg-skills worktree create` takes its permissive-resume path and the paused slice's uncommitted files are still there (verify the slug derivation is deterministic before relying on it)
- [ ] SKILL.md: the `--bg` flag row and one reference-files row for `references/bg.md`; no other SKILL.md prose changes; spec/SKILL.md ends at or under 131 lines; raise the exported budget constant in spec-cost-profiles.spec.ts to 131; re-read the post-slice-3 text, not origin/master

#### Testing Criteria
##### Contracts
- [ ] Contract: SKILL.md Flags table has a `--bg` row with short `-b` and says execute mode only
- [ ] Contract: bg.md contains `issues add`, `--from deferral`, `--severity high` and `Run paused with`
- [ ] Contract: execute.md §1 contains `issues list` with `--open`, `issues resolve`, the word `deferral` as the `from` filter, and no `--slices`
- [ ] Contract: bg.md states that no `AskUserQuestion` runs after launch, and execute.md names `references/bg.md` exactly once
- [ ] Happy path: skill-flags.spec.ts and standalone-planning-skills.spec.ts pass
- [ ] Contract: spec-cost-profiles.spec.ts's budget constant reads 131 after this slice
- [ ] Contract: bg.md names all six permission keys and `perms-batch --grant-all`
- [ ] Contract: bg.md contains `UNVERIFIED:`, the transitive-dependents sentence, the `|` sanitizing sentence, and the finish.md 5.c hybrid sentence
- [ ] Contract: bg.md says the worktree is reused on resume and never removed on pause

#### Acceptance Criteria
- [ ] Given `/dg:spec -s <bundle> --bg` and a SPEC deferral on slice 2, when the run ends, then plan.md's Issues Remediation has one open `deferral` row for slice 2, slices with no `depends_on` path from 2 are committed, every transitive dependent of 2 is not, and the output ends with the resume line
- [ ] Given that paused bundle, when `/dg:spec -s <bundle>` runs without `--bg`, then the open row is asked first and only the blocked slices re-run
- [ ] Given `/dg:spec -s <bundle> --bg` with no deferral, when the run ends, then a draft PR/MR exists as in a normal run
- [ ] Given a `/dg:spec -s` run without `--bg`, when the skill text is loaded, then `references/bg.md` is never read
- [ ] Given a `--bg` run whose slice 3 ends `unverified`, when the run ends, then an `UNVERIFIED:` deferral row exists and no PR is opened
- [ ] Given a `--bg` run whose final review leaves one CRITICAL residual after the last round, when the run ends, then a deferral row exists, no PR is opened, and the resume line is printed
- [ ] Given a paused bundle, when `/dg:spec -s <bundle>` resumes, then it runs in the same worktree and the uncommitted files are still there

## Slice Summaries

## Agent Notes

## Issues Remediation

## Code Structure

### execution.profile

- **Decision:** top-level `execution` object with `profile` enum `balance|cheap|expensive`, mutable; absent means balance; `validate` checks the enum one level down.
- **Home:** `plugins/dg/skills/spec/spec-schema/frontmatter-schema.yaml`
- **Rationale:** the seed fixes the namespace, and `validate` checks enums only on top-level strings today, so the nested check is what makes the enum real.
- **Alternatives:** top-level `profile` — enforced today but breaks the `execution.*` namespace; enforce in `set` — changes `status` behavior, out of scope.
- **Applies to:** slices 1, 3, 5

### Complexity and model fields

- **Decision:** `slices[].agents.complexity` enum `low|medium|high`, written by `/dg:assign`; `slices[].agents.model` enum `haiku|sonnet|opus|fable`, a human override that `/dg:assign` never writes and that replaces the `## Execution` pin.
- **Home:** schema in `frontmatter-schema.yaml`; written by `assign/references/spec-mode.md`; read by `pkg/skills-cli/src/assign/index.ts`
- **Rationale:** slice items are immutable except `agents.*`; `confidence` is the precedent for an assign-time judgment under `agents`; tier-name values match the old pin and `/dg:proxy --tier`.
- **Alternatives:** `slices[].complexity` — splits assign's writes across two parents; `agents.tier` as the key — truer name, but the human and the old pin say `model`.
- **Applies to:** slices 1, 3, 4

### Profile derivation and reach

- **Decision:** effort = `agents.effort` else the profile-shifted tier default on the ladder `[low, medium, xhigh]` clamped; tier = `agents.model` else expensive's complexity rule else the agents table; the profile-wide step touches primary, qa-writer and `qa[]` stages, never `wave` or `security`; complexity rules touch the primary only; a tier move never lowers a tier; cheap also caps finish.md step 5 at 1 round with its four reviewers one step lower; an unrated slice under expensive resolves as balance; the ladder is the ordered set of distinct effort values in the runtime's tier rows; `security` keeps its default wherever it appears; a set `agents.effort` is never shifted.
- **Home:** `pkg/skills-cli/src/tiers.ts` with the `profiles` key in `plugins/dg/skills/assign/references/model-tiers.json`; `sdlc/references/finish.md` step 5
- **Rationale:** `OVERRIDE_EFFORTS` is `[low, medium, xhigh]`; the old pin reached primary and qa-writer and never the wave audit; the seed keeps the non-security QA reviewers; the human ratified the finish.md cap and the unrated rule.
- **Alternatives:** plan mode writes `agents.model: opus` on Approve-as-expensive — mutates the bundle per profile; shift every stage including security — contradicts the seed.
- **Applies to:** slices 1, 2, 3, 4

### PROFILES table home and WAVE_ARGS contract

- **Decision:** the table lives in `model-tiers.json` under `profiles` and `assign resolve` applies it; the runner receives resolved stages plus `profile` (informational), `maxCorrectionRounds` (2, cheap 1) and per-slice `dependsOn` limited to the selection.
- **Home:** `plugins/dg/skills/assign/references/model-tiers.json`, `pkg/skills-cli/src/assign/index.ts`, `sdlc/references/templates/slice-wave.workflow.js` header
- **Rationale:** `assign-resolve.spec.ts` forbids tier-name literals in the runner; engineering.md says model and effort are never hard-coded in the script; `tiers.ts` already imports model-tiers.json so `spec estimate` reuses it.
- **Alternatives:** PROFILES inline in the runner — breaks the pinned test and duplicates the table; a separate `profiles.json` — a second import with no gain.
- **Applies to:** slices 1, 2, 3

### Greedy readiness trigger and resolve selection

- **Decision:** one `assign resolve <plan>` call with no `--layer` selects every slice lacking a `slice-<id>:` commit in `--cwd`'s log and bakes `dependsOn`; one Workflow runs them all, each Red gated on its deps ending `clean` or `needs-attention` inside the run; dependents of a `blocked`, `unverified` or dropped dep, or of a `needs-attention` dep with a live `CRITICAL` deferral, return `blocked-upstream`; the orchestrator commits in dependency order after the call; re-runs and resumes use the default selection when `slice_commits` is granted and `--slices` with the full blocked set when it is not.
- **Home:** `pkg/skills-cli/src/assign/index.ts`, `slice-wave.workflow.js`, `sdlc/references/engineering.md` 4.1-4.3, `spec/references/execute.md` §5
- **Rationale:** a Workflow call blocks and the runner has no filesystem, so "committed" cannot be the in-run trigger; `pipeline()` is barrier-free by design; the human chose the in-run gate.
- **Alternatives:** orchestrator rounds over `spec ready` — no parallelism gain; an in-run commit stage — races with other slices' agents and breaks "the orchestrator owns commits".
- **Applies to:** slices 1, 2, 3, 5

### Overlap rule and commit marker

- **Decision:** `lint-waves` and `scaffold` fail when any two slices with no dependency path share files (`OVERLAP: slice p <-> slice q (independent)`, `ok: no overlap between independent slices`, `layer N:` lines kept); slice commits use `<type>(<scope>): slice-<N>: <name>`; `spec ready` takes `--cwd`; the marker is searched in `merge-base..HEAD` of `--cwd`, never the whole log.
- **Home:** `pkg/skills-cli/src/spec/lint-waves.ts`, `pkg/skills-cli/src/spec/context.ts` (`ready`), `engineering.md` 4.3, `execute.md` §5
- **Rationale:** under in-run gating any incomparable pair can be in flight together; the subject marker is what `ready` already greps; `assign-resolve.spec.ts` parses the `layer N:` lines; today `ready` never sees `-s` commits (no marker, wrong repo).
- **Alternatives:** keep same-layer — unsound under greedy start; a `Slice: N` trailer — more churn in `ready`.
- **Applies to:** slices 1, 2, 3

### dg-skills spec estimate

- **Decision:** `spec estimate <plan.md> [--profile p] [--runtime r]` prints one line per profile, exactly `<profile>: <n> slices · <calls> agent calls (<h> haiku, <s> sonnet, <o> opus, <f> fable) · up to <r> correction rounds`, nothing else; calls count red, yellow, green, files and wave once per slice plus each `qa[]` reviewer.
- **Home:** `pkg/skills-cli/src/spec/estimate.ts`, registered in `pkg/skills-cli/src/spec/index.ts`
- **Rationale:** the gate needs three Cost lines and the table lives in the CLI; `SUBCOMMANDS` and the skill-tree verb check pin registration; the human chose calls by tier.
- **Alternatives:** hand estimate in plan.md 7d — three times the error surface; a token figure — no basis.
- **Applies to:** slices 1, 2, 3

### --proxy flag

- **Decision:** `--proxy <backend>` with a required value validated against `dg-skills proxy --list-backends`; plan mode runs the step-7c per-slice prompt only with the flag; no `execution.proxy`; `-s` honors `agents.proxy` as written; `-s --proxy <backend>` offers delegation to slices without one; `--fast --proxy` stops and asks.
- **Home:** `spec/SKILL.md`, `spec/references/plan.md` 7c, `spec/references/execute.md` §4
- **Rationale:** `agents.proxy` is already the durable per-slice record; a required value mirrors `/dg:review-loop --proxy <backend>` and cannot swallow the positional request; bundles 001, 003 and 004 need no migration.
- **Alternatives:** bare `--proxy` — asks the backend per slice; `execution.proxy` gating `-s` — one more field and a migration prompt.
- **Applies to:** slices 3, 5

### Short flags

- **Decision:** `--profile` `-p`, `--proxy` `-x`, `--bg` `-b`; `--cheap` and `--expensive` have no short form.
- **Home:** `spec/SKILL.md` Usage line and Flags table
- **Rationale:** ratified by the human; `skill-flags.spec.ts` requires every Usage flag in the four-column table, so `none` fills the Short column for the two aliases.
- **Alternatives:** `-P` profile with `-p` proxy as in review-loop — rejected by the human.
- **Applies to:** slices 3, 5

### Lazy reference homes for flag detail

- **Decision:** profile mechanics live in `spec/references/profiles.md` (read only with a profile flag), proxy delegation in `spec/references/proxy.md` (read only with `--proxy`), the unattended contract in `spec/references/bg.md` (read only with `--bg`), the complexity rubric in `assign/references/spec-mode.md`; SKILL.md files gain only flag rows and reference-table rows; plan.md and execute.md carry one pointer sentence per reference, fast.md none.
- **Home:** `plugins/dg/skills/spec/references/profiles.md`, `plugins/dg/skills/spec/references/bg.md`, `plugins/dg/skills/assign/references/spec-mode.md`
- **Rationale:** the token-efficiency rule; no size spec exists for these skills, so each slice adds a line budget (spec 129 then 131, assign 121, sdlc 74) in the pattern of `hooks-skill.spec.ts`.
- **Alternatives:** inline in plan.md and execute.md — loaded on every run; one combined `flags.md` — profile and bg are read at different moments.
- **Applies to:** slices 3, 4, 5
