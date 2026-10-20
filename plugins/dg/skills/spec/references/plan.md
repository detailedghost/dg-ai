# Plan Mode — Orchestration

Follow these steps strictly in order. Do NOT skip a gate condition. `<slug>` is the
`feature_snake_case` established at step 1; `<bundle>` is `.agents/spec/<NNN>_<slug>/` once step 3
creates it.

## Context management

The bundle is the source of truth once it exists (step 3 onward) — write findings/edits into it,
compact aggressively. Before step 3, working state is the in-context grill-me decision log (see
[grill.md](grill.md)); there is no file to compact against yet.

## Step 1 — arch grill-me `[fable, xhigh]`

Run grill-me pass 1 (protocol inlined per [grill.md](grill.md)) against the user's request — scoped
to architecture placement, integration points, risk areas. Follow `protocol.md`'s Session Startup +
Interview Rounds.

**Interview in the main loop; delegate only the research.** `arch` (`fable`, `xhigh`) is the
research persona for this pass, not the interviewer — a subagent has no `AskUserQuestion` and
cannot meet this step's gate. See [grill.md](grill.md) § *Interview passes run in the MAIN LOOP*
for the relay contract that applies if you do delegate a leg.

Derive the working `feature` name and `<slug>` (via `~/.dg/bin/dg-skills spec slugify`) from this pass if not
already given.

> **GATE:** pass 1's design-tree branches (architecture scope) resolved, zero `[OPEN]`, all
> `[ASSUMED]` confirmed.

## Step 1.5 — Structure grill `[dominant language agent, sonnet/medium]`

The code-building pass: grill-me pass 1.5, scoped to **code-surface contracts** — shared
types/interfaces, module and file homes, cross-boundary data shapes, error/result conventions,
reuse-vs-new. Every question carries a recommendation *and* the alternatives it beat.

It sits **before** step 2 deliberately: `slices[].files` is structurally immutable after step 3's
scaffold, and slice boundaries are drawn over the module layout — so a structure decision that
moves a file must land before slicing, not after.

Full contract — admission test, research persona, self-collapse rule, output shape — in
[templates/structure-grill.md](templates/structure-grill.md). Read it before running this step.

**Default-on and self-collapsing:** run the research legs first, apply the admission test, and if
no contested surface survives, print the one-paragraph *"no contested code surfaces"* summary and
move on with zero questions asked. **Single-slice bundles skip this step entirely** — fold any
surviving branch into step 1.

> **GATE:** either the collapse summary is printed, or every admitted branch is `[DECIDED]` with
> its alternatives recorded and every `[ASSUMED]` confirmed.

## Step 2 — foreman grill-me `[fable, xhigh]`

Grill-me pass 2 — scoped to work ordering: vertical slice boundaries, the dependency graph, and any
scope/acceptance-criteria gaps the earlier passes didn't cover. **foreman** (`fable`,
`xhigh`) is the research persona; the interview stays in the main loop as in step 1.

Reads passes 1 and 1.5's decision logs as settled context; does not re-litigate `[DECIDED]` items.
Slice `files` globs must respect the module homes pass 1.5 settled — where they can't, that's a
pass-1.5 decision to reopen *here*, before scaffold freezes `files`, not a glob that quietly
contradicts it.

**Rule:** same-layer slices touch disjoint files; any slice that runs a code generator or edits a
shared fixture/test harness serializes against every other slice that does the same. Add a
`depends_on` edge between them. List generator outputs in the blob's optional `serializing` key
(see [decision-blob.md](decision-blob.md)).

> **GATE:** pass 2's design-tree branches (slice ordering) resolved, zero `[OPEN]`, all `[ASSUMED]`
> confirmed, and `~/.dg/bin/dg-skills spec lint-waves <blob>` exits 0 (run it on the drafted blob; fix every
> reported overlap with a `depends_on` edge before step 3).

## Step 3 — Decision blob → scaffold → assign

- a. foreman emits the compact JSON decision blob per [decision-blob.md](decision-blob.md),
  derived from passes 1 and 2's decision logs. Write it to
  `$(~/.dg/bin/dg-skills stash -s spec <slug>-blob.json)`. Pass 1.5's structure decisions do
  **not** go in the blob — its shape is LOCKED and must not grow a `code_structure` key; they land
  in sub-step d below.
  Run `~/.dg/bin/dg-skills spec lint-waves <blob-path>` on it before sub-step b and fix every overlap.

- b. Run `~/.dg/bin/dg-skills spec scaffold --home .agents/spec --slug <slug> --from-json <blob-path>`. It runs
  `lint-waves` first and refuses on overlap (`--allow-overlap` overrides; do not use it). Prints the
  created bundle's absolute path — this is `<bundle>` for every step below. Computes `<NNN>` by
  scanning `.agents/spec/` for `NNN_`-prefixed directories (pre-existing non-numbered dirs coexist
  untouched).

- c. Run `/dg:assign <bundle>/plan.md` — fills `slices[].agents.primary` (+ optional `qa`) per slice
  against the live roster. Idempotent; does not touch `agents.proxy`/`proxy_skills` (step 7's job).

- d. **Write pass 1.5's structure decisions into `plan.md`.** Skip entirely if step 1.5 collapsed
  (no contested surfaces) or was folded into step 1 (single-slice bundle). Otherwise render each
  `[DECIDED]` structure item in the entry format from
  [templates/structure-grill.md](templates/structure-grill.md) — now fillable with real slice ids
  in `Applies to` — and append it:

  ```sh
  ~/.dg/bin/dg-skills spec append-section <bundle>/plan.md --section "Code Structure" "<body>"
  ```

  The heading is created at end-of-file if absent; multi-line text is fine (quote at the call
  site). Any decision that turns out to apply to exactly one slice failed the admission test in
  hindsight — drop it rather than writing it.

> **GATE:** bundle exists at `.agents/spec/<NNN>_<slug>/` with `plan.md` + `initial.md` +
> `roundtable/slice-<N>.md` (one per slice); every slice has `agents.primary`; `## Code Structure`
> written, or step 1.5 collapsed/folded.

## Step 4 — Checkpoint

No action — a bundle-state note, not a phase. After step 3, `<bundle>/roundtable/` holds one
findings-shell file per slice (`slice-1.md`, `slice-2.md`, …), each pointing back at its slice in
`plan.md`. Step 5 fills them in.

## Step 5 — Per-slice review fan-out

Ask, per-slice, whether to escalate that slice's review, then launch the fan-out. Full contract —
model/effort default + escalation ceiling, launch prompt, output shape — in
[templates/slice-review.md](templates/slice-review.md). Each launch is that slice's assigned
`agents.primary` reviewing its own slice, writing findings directly into its
`roundtable/slice-<N>.md`.

> **GATE:** every slice's `roundtable/slice-<N>.md` populated (findings or `"no recommendations"`).

## Step 6 — Synthesis `[fable, xhigh]` + grill-me gaps pass

- a. Launch **foreman**, `fable`, effort `xhigh`, per
  [templates/synthesis.md](templates/synthesis.md) — folds all slice findings into a proposed
  `plan.md` edit list, surfaces cross-slice conflicts, collects `[OPEN — escalate]` items.
- b. If synthesis surfaced any `[OPEN — escalate]` items, run grill-me pass 3 (see
  [grill.md](grill.md)) scoped to exactly that list.

> **GATE:** synthesis edit list produced; every `[OPEN — escalate]` item resolved to `[DECIDED]`
> via pass 3 (or explicitly deferred by the user as an `[OPEN — roundtable]` annotation).

## Step 7 — Write `plan.md`; assign `/dg:proxy`; warn token cost

- a. Apply step 6's edit list + pass-3 decisions directly to `<bundle>/plan.md` (frontmatter
  `slices[]` adjustments + body section edits) via `Edit`. Annotate any deferred item inline as
  `[OPEN — roundtable] <text>`.
- b. **Docs + human `/dg:review` fire ONCE at the end of the whole run** — that is already
  `/dg:sdlc`'s default (see [execute.md](execute.md)). Do NOT embed a review/docs lifecycle per slice
  here; plan mode does not invoke `/dg:review` at all.
- c. Ask (batched `AskUserQuestion`, up to 4 slices per call) which slices — if any — to delegate
  externally via `/dg:proxy`. For each selected slice:
  - Validate the backend name against `~/.dg/bin/dg-skills proxy --list-backends`
    (same validation `/dg:assign` uses for `agents.proxy`). Mismatch → refuse, list valid names.
  - Set `slices[N].agents.proxy: <backend>` via `~/.dg/bin/dg-skills spec set`.
  - Ask which skill-behaviors (e.g. `db`, `polish`) that slice's engineering will need, and set
    `slices[N].agents.proxy_skills: [...]` — see [decision-blob.md](decision-blob.md) for why `-s`
    must inline these (the `/dg:proxy`-injection limitation).
- d. **WARN (don't document)** the execution run's token/context cost: estimate per-slice agent-call
  count (Red + Yellow + Green + wave + any `qa[]`, roughly 5–8 calls per slice, mostly sonnet-tier)
  times the number of slices/layers, flag anything token-heavy per the global token-cost gate, and
  offer to optimize (split an oversized slice, drop an unnecessary `qa` agent, downgrade an
  `effort` override). This is a printed warning to the user, not a `plan.md` field — do not persist
  a cost estimate into the bundle.

> **GATE:** `plan.md` reflects synthesis + pass-3 decisions; every delegated slice has
> `agents.proxy` + `agents.proxy_skills` set; user has seen the token-cost warning.

## Step 8 — `/dg:viz` verify

Render `plan.md` as a `template:spec` board and block on approval. Full payload shape + the
`~/.dg/bin/dg-skills viz wait --merge` / `all_clear` gate: [viz.md](viz.md).

If the plan-approval board (or an earlier step) surfaced a hands-on validation need, build it with the
prototype skill (it ships later; skip this step until then) — keep the asset durable (`.agents/prototype/<name>/`, never `--light`/`/tmp`). On
acceptance, register it onto the slice:

```sh
~/.dg/bin/dg-skills spec prototype-ref <bundle> --slice <N> --path <accepted-asset-path> --variant <k>
```

> **GATE:** `/dg:viz` board `all_clear: true` (or terminal-mode `AskUserQuestion` approval on probe
> failure). Every accepted prototype registered onto its slice.

## Step 9 — Context pack

Run `~/.dg/bin/dg-skills spec context <bundle>`. Writes `<bundle>/context.md` — a frontmatter-first tidy pack
projecting `plan.md`'s frontmatter (see the schema's bundle-only `bundle`/`plan_path` fields) plus
`paths.md` + inferred `school/*.md` in the body. This is the file execute mode reads instead of the
full planning history.

> **GATE:** `<bundle>/context.md` exists.

## Step 10 — Commit the bundle; print resume command

- a. Commit unconditionally, the same way `/dg:kick` commits a parked bundle:
  `git add -f .agents/spec/<NNN>_<slug>/ && git commit -m "chore(spec): plan <slug>"` (`-f` because `/dg:agent-seed` ignores `.agents/`). This is what
  lets a bare `/dg:spec "<request>"` run be resolved cross-session — `/dg:spec -s`'s worktree-mode bundle
  lookup reads `$WORKTREE_ORIGIN`, which only sees committed `.agents/` state (see
  [execute.md](execute.md)'s worktree gotcha).
- b. Print: `"Spec bundle ready at .agents/spec/<NNN>_<slug>/. Resume engineering with: /dg:spec -s <NNN>_<slug>"`

Do not proceed into execute mode automatically — resuming is a separate, explicit invocation (a
new session may run it, per the read-boundary this bundle exists to create).
